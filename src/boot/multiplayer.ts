/**
 * Multiplayer / netcode wiring for the live-race boot path.
 *
 * `setupMultiplayer` owns:
 *
 *   - Remote-peer bike spawn / despawn (the `peerId → eid` map used by
 *     `applySnapshot` and input dispatch).
 *   - The host role flip — host bikes are Dynamic + AI-tagged, non-host
 *     mirrors are Kinematic and driven by inbound TransformSnapshots.
 *   - `renderRoomChip` HUD updates.
 *   - The PartyKit room itself, with all five lifecycle callbacks
 *     (onConnected / onPeerJoined / onPeerLeft / onSnapshot / onRoomFull).
 *   - `buildAndSendSnapshot` — the 20 Hz host-broadcast pump invoked from
 *     the sim loop, reusing a single `Uint8Array` to keep per-tick alloc
 *     to zero.
 *
 * Single-player (no `?room=`) shortcuts to a `null` room + `iAmHost()`
 * that always returns true so the rest of the boot path doesn't have to
 * branch on the multiplayer/solo distinction.
 *
 * See `docs/m10-11-state-sync.md` for the message format + ownership
 * rules.
 */

import { addComponent, hasComponent, removeComponent, removeEntity } from 'bitecs'
import { isHostFor } from '@/engine/net/host-election'
import type { InputFrame } from '@/engine/net/input-frame'
import { createNetRoom, type NetRoom } from '@/engine/net/room'
import {
  type BikeSnapshotRecord,
  encodeTransformSnapshotInto,
  snapshotByteLength,
  type TransformSnapshot,
} from '@/engine/net/transform-snapshot'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { resolveBikeVariant } from '@/game/bikes/variants'
import { PeerControlledStore, RBHandleStore } from '@/game/components'
import { AIController, AIControllerStore, AITag, defaultAIController } from '@/game/components/ai'
import { createBike } from '@/game/entities/bike'
import { applySnapshot } from '@/game/systems/apply-snapshot'
import type { Track } from '@/game/tracks/types'

/** Upper bound on the number of bike records the AI host can pack into a
 *  single snapshot: own player + four AI bikes. Used to pre-size the
 *  reusable send buffer. */
const MAX_SNAPSHOT_BIKES = 1 + 4

export interface MultiplayerHandle {
  /** Live PartyKit room accessor, or `null` in single-player. Function
   *  so a leaving host can hand the room off without invalidating the
   *  handle itself. */
  readonly room: NetRoom | null
  /** Last 64 remote input frames (devtools probe surface only). */
  recentRemoteFrames: InputFrame[]
  /** True when this client is currently authoritative for the AI bikes. */
  isHost(): boolean
  /** 20 Hz broadcast pump — call once per sim tick at the desired cadence;
   *  no-ops in single-player or when nobody else is in the room. */
  buildAndSendSnapshot(tick: number, iAmHost: boolean): void
  /** Refresh the room-id HUD pill (post-snapshot, post-join, etc.). */
  renderRoomChip(): void
}

export interface SetupMultiplayerOpts {
  sim: SimWorld
  phys: PhysicsWorld
  track: Track
  playerEid: number
  /** AI bike eids — mutated in place across host-flips when the host
   *  retags them with AITag / AIController. */
  aiEids: number[]
  /** `?room=<id>` value, or `null` in single-player. */
  roomId: string | null
  /** PartyKit host (`localhost:1999` in dev, prod URL otherwise). */
  netHost: string
  /** DOM element for the room HUD chip — may be missing if the HUD was
   *  removed (e.g. tests). */
  roomEl: HTMLElement | null
}

/**
 * Wire up the multiplayer subsystem. In single-player this is a thin
 * stub: `room` is null, `isHost()` returns true, the snapshot pump
 * is a no-op. In multiplayer it opens the relay connection and arms
 * the join/leave/snapshot callbacks against the shared sim + physics
 * worlds.
 */
export function setupMultiplayer(opts: SetupMultiplayerOpts): MultiplayerHandle {
  const { sim, phys, track, playerEid, aiEids, roomId, netHost, roomEl } = opts

  const remoteEids = new Map<number, number>()
  const recentRemoteFrames: InputFrame[] = []
  let net: NetRoom | null = null

  // M10.7 — remote-peer bike spawn. Each connected remote peer gets a
  // PeerControlled bike whose ControlIntent is driven by the relay's
  // last-known intent for that slot (drained in the sim loop). Variant
  // defaults to racer; variant negotiation over the room is a future slice.
  //
  // M10.8 — remote bikes are now Racer-tagged so the local race system
  // tracks their checkpoint crossings, lap progress, and finish state.
  // The position HUD updates as remote bikes pass gates. Mid-race joiners
  // start at lap 1 / cp 0 — they naturally land at the back of the field.
  function spawnRemoteBike(peerId: number): number {
    const racer = resolveBikeVariant('racer')
    // Spread peers 4m apart across the start line, 15m behind the local
    // grid, so they don't visually overlap the AI bikes on spawn.
    const dx = (peerId - 4) * 4
    const dz = -15
    // M10.11 — remote bikes do NOT get PeerControlled. Their pose is
    // driven by inbound TransformSnapshots via `applySnapshot`, not by
    // replaying inputs through the local sim. Skip `peerId:` here so
    // createBike leaves the entity untagged for input dispatch; the
    // `remoteEids` map below is the canonical peer → eid mapping.
    const eid = createBike(sim, phys, {
      position: {
        x: track.start.position.x + dx,
        y: track.start.position.y,
        z: track.start.position.z + dz,
      },
      yaw: track.start.yaw,
      asRacer: true,
      stats: {
        ...racer.stats,
        bodyColor: racer.bodyColor,
        variantId: racer.id,
      },
    })
    remoteEids.set(peerId, eid)
    // Flip the rigid body kinematic so the local hover spring / surface
    // alignment / physics integrator leave it alone — the next snapshot
    // dictates its pose.
    const handle = RBHandleStore.get(eid)
    if (handle) {
      const rb = phys.world.getRigidBody(handle.handle)
      if (rb) rb.setBodyType(phys.rapier.RigidBodyType.KinematicPositionBased, true)
    }
    return eid
  }

  function despawnRemoteBike(peerId: number): void {
    const eid = remoteEids.get(peerId)
    if (eid === undefined) return
    const handle = RBHandleStore.get(eid)
    if (handle) {
      const rb = phys.world.getRigidBody(handle.handle)
      if (rb) phys.world.removeRigidBody(rb)
    }
    removeEntity(sim, eid)
    remoteEids.delete(peerId)
  }

  function renderRoomChip(): void {
    if (!roomEl) return
    if (!net?.ready) {
      roomEl.style.display = roomId ? '' : 'none'
      roomEl.textContent = roomId ? `room: ${roomId} (connecting…)` : 'room: --'
      return
    }
    const remote = net.remotePeers
    const peers = remote.length === 0 ? 'alone' : `+ P${remote.join(', P')}`
    const hostMark = isHostFor(net.peerId, remote) ? ' [host]' : ''
    roomEl.style.display = ''
    roomEl.textContent = `room: ${roomId} | you: P${net.peerId}${hostMark} | ${peers}`
  }

  // M10.11 — host role toggles between dynamic + AI-tagged (host) and
  // kinematic + untagged (non-host) for AI bikes. The local player bike
  // stays Dynamic + PeerControlled. Remote-peer bikes stay Kinematic.
  // Called whenever the peer set changes (onConnected / onPeerJoined /
  // onPeerLeft) so a leaving host hands off cleanly to the next slot.
  let currentlyHost = true // pre-connect: single-player → always host
  function applyHostRole(iAmHost: boolean): void {
    if (iAmHost === currentlyHost) return
    currentlyHost = iAmHost
    for (const eid of aiEids) {
      const handle = RBHandleStore.get(eid)
      if (!handle) continue
      const rb = phys.world.getRigidBody(handle.handle)
      if (!rb) continue
      if (iAmHost) {
        rb.setBodyType(phys.rapier.RigidBodyType.Dynamic, true)
        if (!hasComponent(sim, eid, AITag)) {
          addComponent(sim, eid, AITag)
          addComponent(sim, eid, AIController)
          // Re-derive controller state — the host changed, so any stale
          // closest-point cache from a previous AI-host stint is invalid.
          // splineId 'main' is the only one in use today (see spawn-bikes.ts).
          AIControllerStore.set(eid, defaultAIController('main'))
        }
      } else {
        rb.setBodyType(phys.rapier.RigidBodyType.KinematicPositionBased, true)
        if (hasComponent(sim, eid, AITag)) {
          removeComponent(sim, eid, AITag)
          removeComponent(sim, eid, AIController)
        }
        // Kinematic bodies don't decay velocity, but the body type flip
        // doesn't zero linvel — clamp it so the bike isn't carrying its
        // last-dynamic-frame motion when the next snapshot arrives.
        rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
        rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
      }
    }
  }

  // M10.11 — snapshot resolution. Maps a record to a local eid. Returns
  // null for records we don't have a matching entity for (e.g. an AI
  // index out of range, or a remote-peer record whose spawn hasn't
  // happened on our side yet). `applySnapshot` then silently skips.
  function snapshotLookup(record: BikeSnapshotRecord): number | null {
    if (record.bikeKind === 1) {
      return aiEids[record.bikeIndex] ?? null
    }
    // bikeKind 0 (player). If the snapshot is from a peer we know,
    // route to that peer's remote bike. If it claims to be from
    // ourselves (shouldn't happen — relay doesn't echo and room.ts
    // double-filters), ignore.
    if (record.ownerPeerId === (net?.ready ? net.peerId : -1)) return null
    return remoteEids.get(record.ownerPeerId) ?? null
  }

  // Lobby phase has already concluded by the time we reach this code
  // path (see runMpLobby in src/engine/menus/mp-lobby.ts). A `?room=`
  // here means we're entering the race itself, so the countdown
  // auto-starts and the race HUD is built without `deferStart`.
  if (roomId) {
    renderRoomChip()
    net = createNetRoom({
      host: netHost,
      roomId,
      onRemoteFrame: (frame) => {
        recentRemoteFrames.push(frame)
        if (recentRemoteFrames.length > 64) recentRemoteFrames.shift()
      },
      onSnapshot: (snap) => {
        // M10.11 — pose-driven update for remote-peer bikes + AI bikes
        // (the latter only on non-host tabs; host snapshots ignored
        // there are no-ops since the lookup returns aiEids[...] which
        // is dynamic on the host and overwriting a dynamic body via
        // applySnapshot would clobber the host's authoritative sim).
        // Guarded: only apply AI records when we're NOT the host.
        if (currentlyHost) {
          // Apply only the player record(s); skip AI records.
          const playerRecords = snap.bikes.filter((b) => b.bikeKind === 0)
          if (playerRecords.length > 0) {
            applySnapshot(sim, phys, { ...snap, bikes: playerRecords }, snapshotLookup)
          }
          return
        }
        applySnapshot(sim, phys, snap, snapshotLookup)
      },
      onConnected: (peerId, others, _raceStarted) => {
        console.log(
          `[net] joined room "${roomId}" as peer ${peerId}, others: [${others.join(', ')}]`,
        )
        // The local player bike was spawned with the placeholder slot 0
        // (correct for single-player). Now that the relay has assigned our
        // real slot, re-tag PeerControlled so applyPeerInputs routes our
        // local input to our own bike — without this, every tab's bike
        // collides on slot 0 and the host's frames drive everyone.
        PeerControlledStore.set(playerEid, { peerId })
        // Existing peers in the room need their bikes spawned too —
        // peer-joined only fires for joins AFTER us.
        for (const p of others) spawnRemoteBike(p)
        applyHostRole(isHostFor(peerId, others))
        renderRoomChip()
      },
      onPeerJoined: (peerId) => {
        console.log(`[net] peer ${peerId} joined`)
        spawnRemoteBike(peerId)
        if (net) applyHostRole(isHostFor(net.peerId, net.remotePeers))
        renderRoomChip()
      },
      onPeerLeft: (peerId) => {
        console.log(`[net] peer ${peerId} left`)
        despawnRemoteBike(peerId)
        if (net) applyHostRole(isHostFor(net.peerId, net.remotePeers))
        renderRoomChip()
      },
      onRoomFull: () => {
        console.warn(`[net] room "${roomId}" is full`)
        if (roomEl) {
          roomEl.style.display = ''
          roomEl.style.color = '#ff7777'
          roomEl.textContent = `room: ${roomId} FULL`
        }
      },
    })
  }

  // M10.11 — TransformSnapshot broadcast. Reused buffer sized for 5
  // records (max we ever send) so we don't allocate per send.
  const snapshotSendBuf = new Uint8Array(snapshotByteLength(MAX_SNAPSHOT_BIKES))
  const snapshotSendView = new DataView(snapshotSendBuf.buffer)
  // Reused snapshot literal — bikes array is rebuilt per send to avoid
  // allocating a fresh TransformSnapshot wrapper.
  const snapshotScratch: TransformSnapshot = { senderPeerId: 0, tick: 0, bikes: [] }
  const snapshotRecords: BikeSnapshotRecord[] = []

  function buildAndSendSnapshot(tick: number, iAmHost: boolean): void {
    if (!net?.ready) return
    if (net.remotePeers.length === 0) return // nobody listening
    snapshotRecords.length = 0
    const myPeerId = net.peerId
    // Own player bike.
    const pHandle = RBHandleStore.get(playerEid)
    const pRb = pHandle ? phys.world.getRigidBody(pHandle.handle) : null
    if (pRb) {
      const t = pRb.translation()
      const q = pRb.rotation()
      const v = pRb.linvel()
      snapshotRecords.push({
        ownerPeerId: myPeerId,
        bikeKind: 0,
        bikeIndex: 0,
        flags: 0,
        position: { x: t.x, y: t.y, z: t.z },
        rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
        velocity: { x: v.x, y: v.y, z: v.z },
      })
    }
    // AI bikes — host only.
    if (iAmHost) {
      for (let i = 0; i < aiEids.length; i++) {
        const eid = aiEids[i] as number
        const h = RBHandleStore.get(eid)
        const rb = h ? phys.world.getRigidBody(h.handle) : null
        if (!rb) continue
        const t = rb.translation()
        const q = rb.rotation()
        const v = rb.linvel()
        snapshotRecords.push({
          ownerPeerId: myPeerId,
          bikeKind: 1,
          bikeIndex: i,
          flags: 0,
          position: { x: t.x, y: t.y, z: t.z },
          rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
          velocity: { x: v.x, y: v.y, z: v.z },
        })
      }
    }
    if (snapshotRecords.length === 0) return
    snapshotScratch.senderPeerId = myPeerId
    snapshotScratch.tick = tick
    snapshotScratch.bikes = snapshotRecords
    const byteLength = encodeTransformSnapshotInto(snapshotSendView, 0, snapshotScratch)
    net.sendBinary(snapshotSendBuf.subarray(0, byteLength))
  }

  return {
    get room() {
      return net
    },
    recentRemoteFrames,
    isHost: () => (net?.ready ? isHostFor(net.peerId, net.remotePeers) : true),
    buildAndSendSnapshot,
    renderRoomChip,
  }
}
