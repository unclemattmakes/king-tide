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
import { electHostSeat, isHostSeat } from '@/engine/net/host-election'
import { type InputFrame, LOCAL_PEER_ID } from '@/engine/net/input-frame'
import { onMpStatusChange } from '@/engine/net/mp-status'
import { createNetRoom, type NetRoom } from '@/engine/net/room'
import {
  type BikeSnapshotRecord,
  encodeTransformSnapshotInto,
  snapshotByteLength,
  type TransformSnapshot,
} from '@/engine/net/transform-snapshot'
import { playerSettings } from '@/engine/player-settings'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { resolveBikeVariant } from '@/game/bikes/variants'
import { PeerControlledStore, RBHandleStore } from '@/game/components'
import { AIController, AIControllerStore, AITag, defaultAIController } from '@/game/components/ai'
import { createBike } from '@/game/entities/bike'
import { applySnapshot } from '@/game/systems/apply-snapshot'
import { clearRemoteInterp, pushRemoteSnapshot } from '@/game/systems/remote-interp'
import type { Track } from '@/game/tracks/types'

/** Sim-truth bike positions, read straight from the Rapier bodies (NOT
 *  the render-interpolated transforms). Probe surface for the two-tab
 *  e2e (tests/e2e/m10-11-state-sync.spec.ts) and devtools. */
export type BikePosesProbe = {
  player: { x: number; y: number; z: number } | null
  /** Indexed like `aiEids` — the same index a snapshot's `bikeIndex`
   *  refers to, so cross-tab comparisons line up bike-for-bike. */
  ai: ({ x: number; y: number; z: number } | null)[]
  /** Per-AI body mode, aligned with `ai`: true = Dynamic (locally
   *  simulated — this tab is/was AI host), false = kinematic
   *  (snapshot-driven). The two-tab spec's triage breadcrumb: a
   *  non-host with dynamic AI bikes is running a divergent local race;
   *  a non-host with frozen kinematic bikes isn't applying snapshots. */
  aiDynamic: boolean[]
  /** Remote-peer bikes keyed by peer slot. */
  remote: Record<number, { x: number; y: number; z: number }>
}

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
  /** Read-only pose probe (see {@link BikePosesProbe}). */
  probeBikePoses(): BikePosesProbe
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

  /** Tenure-aware election (longest-tenured peer wins; slot order as
   *  tie-break / old-relay fallback). Outside a room, or before the
   *  hello lands: we're host — single-player semantics. */
  function computeIsHost(): boolean {
    return net?.ready ? isHostSeat(net.mySeat, net.remoteSeats) : true
  }

  /** Slot of the peer whose AI snapshots we accept, or -1 when that's
   *  us / we're not in a room. Recomputed per snapshot — cheap, and the
   *  peer set can change between any two messages. */
  function aiAuthorityPeer(): number {
    if (!net?.ready) return -1
    return electHostSeat(net.mySeat, net.remoteSeats).peerId
  }

  // M10.7 — remote-peer bike spawn. Each connected remote peer gets a
  // PeerControlled bike whose ControlIntent is driven by the relay's
  // last-known intent for that slot (drained in the sim loop). Variant
  // is resolved from `net.latestPeerPicks[peerId].selectedBikeId` (the
  // pick that peer broadcast via `sendReady` during the lobby); falls
  // back to the racer default when no pick is on file (mid-race join
  // without a lobby pass).
  //
  // M10.8 — remote bikes are now Racer-tagged so the local race system
  // tracks their checkpoint crossings, lap progress, and finish state.
  // The position HUD updates as remote bikes pass gates. Mid-race joiners
  // start at lap 1 / cp 0 — they naturally land at the back of the field.
  function spawnRemoteBike(peerId: number): number {
    // Idempotent: a reconnect's hello replays peers we may already have
    // spawned (and a buggy/raced server double-join must not leak a
    // duplicate kinematic Racer into the standings).
    const existing = remoteEids.get(peerId)
    if (existing !== undefined) return existing
    const picks = net?.latestPeerPicks.get(peerId)
    const variant = resolveBikeVariant(picks?.selectedBikeId)
    // Spread peers 4m apart across the start line, 15m behind the local
    // grid, so they don't visually overlap the AI bikes on spawn.
    // Offsets live in the start's local frame so they rotate with
    // track.start.yaw — the row behind the grid follows the gate facing.
    const dx = (peerId - 4) * 4
    const dz = -15
    const cosY = Math.cos(track.start.yaw)
    const sinY = Math.sin(track.start.yaw)
    // M10.11 — remote bikes do NOT get PeerControlled. Their pose is
    // driven by inbound TransformSnapshots via `applySnapshot`, not by
    // replaying inputs through the local sim. Skip `peerId:` here so
    // createBike leaves the entity untagged for input dispatch; the
    // `remoteEids` map below is the canonical peer → eid mapping.
    const eid = createBike(sim, phys, {
      position: {
        x: track.start.position.x + dx * cosY + dz * sinY,
        y: track.start.position.y,
        z: track.start.position.z + -dx * sinY + dz * cosY,
      },
      yaw: track.start.yaw,
      asRacer: true,
      stats: {
        ...variant.stats,
        bodyColor: variant.bodyColor,
        variantId: variant.id,
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
    clearRemoteInterp(eid)
    removeEntity(sim, eid)
    remoteEids.delete(peerId)
  }

  // Set when the relay rejects us because the room's race locked (no
  // mid-race joins — e.g. a reconnect attempt after the join grace).
  // The room has closed itself; we keep racing solo.
  let raceLocked = false

  function renderRoomChip(): void {
    if (!roomEl) return
    if (raceLocked) {
      roomEl.style.display = ''
      roomEl.textContent = `room: ${roomId} locked (race in progress) — riding solo`
      return
    }
    if (!net?.ready) {
      roomEl.style.display = roomId ? '' : 'none'
      // partysocket auto-reconnects; the chip distinguishes the two
      // states so a transient blip doesn't read as "still booting".
      const label = net?.everConnected ? 'reconnecting…' : 'connecting…'
      roomEl.textContent = roomId ? `room: ${roomId} (${label})` : 'room: --'
      return
    }
    const remote = net.remotePeers
    const peers = remote.length === 0 ? 'alone' : `+ P${remote.join(', P')}`
    const hostMark = computeIsHost() ? ' [host]' : ''
    const ping = net.latencyMs
    const pingLabel = Number.isFinite(ping) && ping >= 0 ? ` | ${Math.round(ping)}ms` : ''
    roomEl.style.display = ''
    roomEl.textContent = `room: ${roomId} | you: P${net.peerId}${hostMark} | ${peers}${pingLabel}`
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
        // We're now authoritative for this bike — drop any buffered
        // remote-interp samples from the previous non-host stint so they
        // don't reapply if/when we flip back to non-host later.
        clearRemoteInterp(eid)
        if (!hasComponent(sim, eid, AITag)) {
          addComponent(sim, eid, AITag)
          addComponent(sim, eid, AIController)
          // Re-derive controller state — the host changed, so any stale
          // closest-point cache from a previous AI-host stint is invalid.
          // splineId 'main' is the only one in use today (see spawn-bikes.ts).
          // Picks up the local host's chosen difficulty for the simulated AI.
          AIControllerStore.set(
            eid,
            defaultAIController('main', { difficulty: playerSettings.aiDifficulty }),
          )
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
    // Live HUD chip refresh on every mp-status change — that fires on
    // each pong (latency tick) and on every join/leave/host-flip, so
    // the room pill stays current without a per-frame poll.
    onMpStatusChange(renderRoomChip)
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
        //
        // Kinematic targets (remote-peer bikes everywhere, AI bikes on
        // non-host) are routed through the snapshot-interp buffer rather
        // than `applySnapshot` so the per-frame pose is a lerp between
        // the two most recent samples instead of a per-snapshot teleport.
        // Dynamic targets (only seen during a brief host changeover when
        // the body type hasn't flipped yet) still take the hard-set path
        // via `applySnapshot` — they're rare and need to lock immediately.
        const now = performance.now()
        // Only the elected AI host's bikeKind=1 records count. During a
        // handoff window two peers can both believe they're host and
        // broadcast divergent AI states — without this filter receivers
        // flicker between them (and any peer could spoof the AI field).
        const aiAuthority = aiAuthorityPeer()
        const dynamicRecords: BikeSnapshotRecord[] = []
        for (const record of snap.bikes) {
          if (record.bikeKind === 1) {
            if (currentlyHost) continue
            if (snap.senderPeerId !== aiAuthority) continue
          } else if (record.ownerPeerId !== snap.senderPeerId) {
            // Player records: a peer is only authoritative for its OWN
            // bike. Drop records claiming someone else's (spoof/bug).
            continue
          }
          const eid = snapshotLookup(record)
          if (eid === null) continue
          const handle = RBHandleStore.get(eid)
          if (!handle) continue
          const rb = phys.world.getRigidBody(handle.handle)
          if (!rb) continue
          if (rb.bodyType() === phys.rapier.RigidBodyType.Dynamic) {
            dynamicRecords.push(record)
          } else {
            pushRemoteSnapshot(eid, record, now)
          }
        }
        if (dynamicRecords.length > 0) {
          applySnapshot(sim, phys, { ...snap, bikes: dynamicRecords }, snapshotLookup)
        }
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
        applyHostRole(computeIsHost())
        renderRoomChip()
      },
      onPeerJoined: (peerId) => {
        console.log(`[net] peer ${peerId} joined`)
        spawnRemoteBike(peerId)
        applyHostRole(computeIsHost())
        renderRoomChip()
      },
      onPeerLeft: (peerId) => {
        console.log(`[net] peer ${peerId} left`)
        despawnRemoteBike(peerId)
        applyHostRole(computeIsHost())
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
      onRaceInProgress: () => {
        // The relay's no-mid-race-joins lock turned us away (a fresh
        // join via a shared race URL, or a reconnect after the join
        // grace). The room already closed itself; if we were racing,
        // onDisconnected has degraded us to solo — just label it.
        console.warn(`[net] room "${roomId}" race is locked — continuing solo`)
        raceLocked = true
        renderRoomChip()
      },
      onDisconnected: () => {
        // Established session dropped; partysocket retries in the
        // background. Degrade to solo so the race stays playable:
        console.warn(`[net] room "${roomId}" connection lost — running solo until reconnect`)
        // 1. Despawn every remote bike. Without inbound snapshots they
        //    freeze within 50 ms, and slots may be recycled to different
        //    players while we're gone — a clean slate lets the reconnect
        //    hello re-spawn exactly the live set (no duplicates, no
        //    zombie Racers polluting the standings).
        for (const peerId of [...remoteEids.keys()]) despawnRemoteBike(peerId)
        // 2. Re-stamp the local bike with the no-room slot. The loop
        //    stamps outgoing frames with LOCAL_PEER_ID while no slot is
        //    held; without this the bike keeps its old room slot and
        //    applyPeerInputs feeds it empty intents — dead controls for
        //    the whole reconnect window.
        PeerControlledStore.set(playerEid, { peerId: LOCAL_PEER_ID })
        // 3. We're alone now — take AI authority. The kinematic bodies
        //    hold their last snapshot pose, so flipping them dynamic
        //    resumes the field in place (no teleport). A reconnect's
        //    onConnected re-runs the election and hands authority back
        //    if someone else outranks us.
        applyHostRole(true)
        renderRoomChip()
      },
    })
  }

  // M10.11 — TransformSnapshot broadcast. Reused buffer sized from the
  // live roster (own player + every AI bike the host may broadcast) so we
  // don't allocate per send. Sized from `aiEids.length` — NOT a constant —
  // because the AI grid size has changed before (4 → 7) and a stale
  // constant here overflows the DataView on the host's first broadcast.
  // The aiEids array's membership is fixed for the session; host flips
  // only retag the same eids.
  const snapshotSendBuf = new Uint8Array(snapshotByteLength(1 + aiEids.length))
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

  function probeBikePoses(): BikePosesProbe {
    const body = (eid: number) => {
      const h = RBHandleStore.get(eid)
      return h ? phys.world.getRigidBody(h.handle) : null
    }
    const pose = (eid: number) => {
      const rb = body(eid)
      if (!rb) return null
      const t = rb.translation()
      return { x: t.x, y: t.y, z: t.z }
    }
    const remote: Record<number, { x: number; y: number; z: number }> = {}
    for (const [pid, eid] of remoteEids) {
      const p = pose(eid)
      if (p) remote[pid] = p
    }
    return {
      player: pose(playerEid),
      ai: aiEids.map(pose),
      aiDynamic: aiEids.map((eid) => body(eid)?.bodyType() === phys.rapier.RigidBodyType.Dynamic),
      remote,
    }
  }

  return {
    get room() {
      return net
    },
    recentRemoteFrames,
    isHost: computeIsHost,
    buildAndSendSnapshot,
    renderRoomChip,
    probeBikePoses,
  }
}
