import { addComponent, hasComponent, query, removeComponent, removeEntity } from 'bitecs'
import * as THREE from 'three'
import { spawnBikes } from './boot/spawn-bikes'
import { loadTrackForBoot } from './boot/track-loader'
import { downloadReplay, formatTime, ordinal } from './boot/utils'
import { installDebugApi, type PlayerSnapshot, type RaceSnapshot } from './debug'
import { createAudioEngine } from './engine/audio/audio'
import { loadDevSettings } from './engine/dev-settings'
import { installTrackEditor } from './engine/editor/track-editor'
import { formatLap } from './engine/garage'
import {
  emptyIntent,
  type Intent,
  inputSourceLabel,
  installInput,
  readPlayerIntent,
} from './engine/input'
import { installCameraLookInput, tickCameraLook } from './engine/input/camera-look'
import { bindLazyMenuButton } from './engine/lazy-menu'
import { buildTrackList, nextTrackId } from './engine/menus/catalog'
import { runMenuFlow } from './engine/menus/menu-flow'
import { runMpLobby } from './engine/menus/mp-lobby'
import { isHostFor } from './engine/net/host-election'
import {
  decodeInputFrameFrom,
  encodeInputFrameInto,
  INPUT_FRAME_WIRE_BYTES,
  type InputFrame,
} from './engine/net/input-frame'
import { createNetRoom, type NetRoom } from './engine/net/room'
import {
  type BikeSnapshotRecord,
  encodeTransformSnapshotInto,
  snapshotByteLength,
  type TransformSnapshot,
} from './engine/net/transform-snapshot'
import { createChaseCamera } from './engine/render/camera'
import { createCombatRenderSystem } from './engine/render/combat-render'
import { createDirectionArrow } from './engine/render/direction-arrow'
import { createFxSystem } from './engine/render/fx'
import { createPhysicsDebugRenderer } from './engine/render/physics-debug'
import { createPickupRenderSystem } from './engine/render/pickup-render'
import { createPropsMesh } from './engine/render/props-mesh'
import { createRaceHud } from './engine/render/race-hud'
import { createBikeRenderSystem } from './engine/render/render-systems'
import { createRenderer } from './engine/render/renderer'
import { createScene } from './engine/render/scene'
import { createSkySystem } from './engine/render/sky'
import { createTrackVisuals } from './engine/render/track-mesh'
import { type BikeImpact, createWaterMesh, updateUnderwaterFog } from './engine/render/water'
import {
  parseReplay,
  type ReplayBike,
  type ReplayFile,
  serializeReplay,
} from './engine/replay/format'
import { createReplayPlayer, makePoseBuffer } from './engine/replay/player'
import { createReplayRecorder, type ReplayRecorder } from './engine/replay/recorder'
import { createSpectatorCamera } from './engine/replay/spectator-camera'
import { installSpectatorHud } from './engine/replay/spectator-hud'
import { getBestLap, recordLapTime } from './engine/save-state'
import { createSimWorld } from './engine/sim/ecs/world'
import { createPhysicsWorld } from './engine/sim/physics/rapier'
import { vecHorizontalLength } from './engine/sim/physics/vec'
import { advanceWaveField, createWaveField, defaultWaves } from './engine/sim/water/wave-field'
import { applyStoredWaterTuning } from './engine/water-debug-storage'
import { loadBike } from './game/assets/bike-loader'
import { loadManifest } from './game/assets/manifest'
import { type LoadedProp, loadProp } from './game/assets/prop-loader'
import { resolveBikeVariant } from './game/bikes/variants'
import {
  HoverStateStore,
  PeerControlledStore,
  RBHandleStore,
  TransformStore,
} from './game/components'
import { AIController, AIControllerStore, AITag, defaultAIController } from './game/components/ai'
import { ExplosionTag, MineTag, MissileTag } from './game/components/combat'
import type { PickupType } from './game/components/pickup'
import { RacerStore } from './game/components/race'
import { createBike } from './game/entities/bike'
import { createPickupSpawn } from './game/entities/pickup-spawn'
import { createPropColliders } from './game/entities/props'
import { simulateStep } from './game/sim-step'
import { applySnapshot } from './game/systems/apply-snapshot'
import { getHeldPickup } from './game/systems/pickup'
import { createRaceSystem } from './game/systems/race'
import { computeStandings } from './game/systems/standings'

/**
 * Boot sequence — phases, in order:
 *
 *   1. Mode dispatch. `?viewer=<id>` short-circuits into the stand-alone
 *      bike viewer and returns; everything below is skipped.
 *      `?replay=session` parses the pending replay from sessionStorage so
 *      the rest of boot can branch on `activeReplay`.
 *      `?edit=1` switches the player track to `lagoon-edit` and arms
 *      the editor instead of the live game loop.
 *   2. Subsystem setup. Renderer, scene, physics world, sim world, chase
 *      camera, water mesh, wave field. Order matters: physics needs the
 *      Rapier WASM ready before any collider is attached.
 *   3. URL params + persisted prefs. Track id, bike variant, dev settings,
 *      water tuning. Heavy debug overlays bind lazy click handlers here
 *      (their UI modules dynamic-import on first toggle).
 *   4. Asset load. Manifest fetch → bike GLB(s) → track (procedural,
 *      JSON, or GLB → see `src/boot/track-loader.ts`) → props.
 *   5. Entity spawn. See `src/boot/spawn-bikes.ts`. Player bike first
 *      (deterministic eid for the replay recorder's slot 0), then AI
 *      bikes, pickups, mines/missiles handled by the combat system.
 *   6. Render systems. Bike, pickup, combat, FX. The fx system needs
 *      `phys` for wake/dust ground sampling; combat/pickup just need the
 *      sim world. See `docs/code-review-2026-05.md` §1.3 for the shared
 *      `syncEntityMeshes` lifecycle these systems use.
 *   7. Game loop. The live-race branch starts around the `requestFrame`
 *      callback below; replay-playback mode replaces the frame body
 *      further down (search for "Replay-playback mode").
 *   8. Edit mode (alternative to phase 7). `installTrackEditor` takes
 *      the canvas; sim/physics tick is skipped.
 *
 * Pure helpers (downloadReplay, emptyDraftTrack, ordinal, formatTime)
 * live in `src/boot/utils.ts`.
 */
async function boot() {
  const appEl = document.getElementById('app')
  if (!appEl) throw new Error('#app not found')

  // Stand-alone bike viewer: `?viewer=<bikeId>` (or `?viewer=1` for
  // the manifest's first bike). Skips the entire game boot — no
  // track, no physics, no AI, no audio. See src/viewer/bike-viewer.ts.
  const earlyParams = new URLSearchParams(window.location.search)
  const viewerParam = earlyParams.get('viewer')
  if (viewerParam !== null) {
    const { bootBikeViewer } = await import('./viewer/bike-viewer')
    const bikeId = viewerParam === '1' || viewerParam === '' ? null : viewerParam
    await bootBikeViewer(appEl, { bikeId })
    return
  }

  // Cold-boot menu flow — sports-broadcast styled title → mode → track
  // → bike (single-player) or → room (multiplayer). The menu only runs
  // when no game-mode URL param is present, so deep links + tests with
  // `?autostart=1` (or `?race=1`, `?track=`, `?room=`, etc.) skip
  // straight into boot. Hitting the title resolves with a fully-formed
  // race URL; we navigate and let the page reload pick it up.
  const GAME_SIGNALS = [
    'race',
    'autostart',
    'track',
    'bike',
    'room',
    'edit',
    'replay',
    'determinism',
  ]
  const hasGameSignal = GAME_SIGNALS.some((k) => earlyParams.has(k))
  if (!hasGameSignal) {
    const manifest = await loadManifest()
    const reason = earlyParams.get('back') === '1' ? 'exit-from-race' : 'cold'
    const result = await runMenuFlow({
      manifestTracks: manifest.tracks,
      reason,
    })
    window.location.assign(result.href)
    return
  }

  // Multiplayer lobby phase: `?room=<id>` without `race=1` shows the
  // lobby overlay (per-player bike + track picks + smash-bros vote)
  // and resolves with the race URL once everyone's ready. Late joiners
  // whose `hello` arrives with `raceStarted` skip the lobby and
  // navigate straight into the active race.
  if (earlyParams.has('room') && !earlyParams.has('race')) {
    const manifest = await loadManifest()
    const PROD_PARTY_HOST_LOBBY = 'hoverbike.occ-matt.partykit.dev'
    const netHost =
      earlyParams.get('host') ?? (import.meta.env.DEV ? 'localhost:1999' : PROD_PARTY_HOST_LOBBY)
    const bikeParam = earlyParams.get('bike')
    const trackParam = earlyParams.get('track')
    const result = await runMpLobby({
      roomId: earlyParams.get('room')!,
      netHost,
      manifestTracks: manifest.tracks,
      ...(bikeParam ? { initialBikeId: bikeParam as 'cruiser' | 'racer' | 'stunt' } : {}),
      ...(trackParam ? { initialTrackId: trackParam } : {}),
    })
    window.location.assign(result.href)
    return
  }

  const fpsEl = document.getElementById('hud-fps')
  const backendEl = document.getElementById('hud-backend')
  const inputEl = document.getElementById('hud-input')
  const raceEl = document.getElementById('hud-race')
  const audioEl = document.getElementById('hud-audio')
  const roomEl = document.getElementById('hud-room')
  const finishEl = document.getElementById('finish')
  const finishTitle = document.getElementById('finish-title')
  const finishSub = document.getElementById('finish-sub')
  const finishPos = document.getElementById('finish-pos')
  const finishTime = document.getElementById('finish-time')
  const finishBest = document.getElementById('finish-best')

  loadDevSettings()
  installInput()
  installCameraLookInput()

  const { renderer, backend } = await createRenderer(appEl)
  const { scene, camera, sun, hemi } = createScene()
  const phys = await createPhysicsWorld()
  const sim = createSimWorld()
  const chase = createChaseCamera(camera)

  const waveField = createWaveField(defaultWaves())
  // Camera-locked water: the mesh follows the camera XZ so its dense
  // vertex region always covers the visible patch. Size shrinks from the
  // legacy 800 m world plane to 240 m centered on the camera (= 120 m
  // out in any direction, plenty of horizon). Subdivisions stay at the
  // shader default (384), giving ≈ 0.625 m vertex spacing — the 4 m wake
  // wavelength resolves at ~6.4 verts per crest, so ridges read as real
  // geometry instead of single-vertex shimmer.
  const waterMesh = createWaterMesh(waveField)
  scene.add(waterMesh.mesh)

  const params = new URLSearchParams(window.location.search)

  // M10.4 — optional multiplayer relay. `?room=<id>` opts the client into
  // a PartyKit room; otherwise the game runs single-player as before.
  // Host default flips on build mode: dev builds (vite dev) target
  // `localhost:1999` so `pnpm party:dev` works out of the box; production
  // builds target the deployed PartyKit endpoint. Pass `?host=<h>` to
  // override either way (e.g. point a prod build at localhost for testing).
  // Connection is deferred until after the local bike + asset registry
  // are ready so the join/leave callbacks can spawn/despawn remote-peer
  // bikes safely (M10.7).
  const PROD_PARTY_HOST = 'hoverbike.occ-matt.partykit.dev'
  const roomId = params.get('room')
  const netHost = params.get('host') ?? (import.meta.env.DEV ? 'localhost:1999' : PROD_PARTY_HOST)
  const recentRemoteFrames: InputFrame[] = []
  let net: NetRoom | null = null

  // M10.2 determinism harness. When ?determinism=1 is set, the fixed-step
  // sim loop is gated off so the Playwright probe can drive `simulateStep`
  // directly via __hover.determinism.run(). Render still runs so the page
  // is alive; only the sim is frozen.
  const determinismMode = params.get('determinism') === '1'
  const determinismPaused = determinismMode

  // Replay playback mode. `?replay=session` reads a JSON replay payload
  // from sessionStorage (stashed there by the garage's Load Replay flow,
  // which then triggers a navigation to ?replay=session). When active, the
  // recorded race is played back on the original track with the original
  // bikes — no input, no AI, no physics for the bikes themselves; just
  // interpolated transforms feeding into the existing render systems.
  let activeReplay: ReplayFile | null = null
  if (params.get('replay') === 'session') {
    const stored = sessionStorage.getItem('hover-replay-pending')
    if (stored) {
      try {
        activeReplay = parseReplay(stored)
      } catch (err) {
        console.warn('[boot] failed to parse pending replay:', err)
      }
    }
    if (!activeReplay) {
      console.warn('[boot] ?replay=session set but no valid replay in sessionStorage')
    }
  }

  // Track selection. Two procedural tracks are baked in: `lagoon` (default)
  // and `cliffside`. Anything else is treated as a JSON track id and loaded
  // from `/tracks/<id>.json` — the new hybrid pipeline (gameplay data in
  // JSON authored via the in-app editor, optional environment .glb authored
  // in Blender).
  //
  // Edit mode (`?edit=1`) defaults to the `lagoon-edit` JSON snapshot of
  // the procedural Lagoon Loop, so the editor opens on something familiar
  // rather than the bare calibration scene.
  //
  // Replay mode forces the original track id from the recording so the
  // ?track= URL param can't desync the playback from what was captured.
  const editModeFlag = params.get('edit') === '1'
  const rawTrack = params.get('track')
  const trackId = activeReplay
    ? activeReplay.meta.trackId
    : rawTrack && rawTrack.length > 0
      ? rawTrack
      : editModeFlag
        ? 'lagoon-edit'
        : 'lagoon'

  // Bike variant. URL `?bike=cruiser|racer|stunt` picks the player's
  // archetype; AI bikes always use the racer baseline for now. Variant
  // controls both stats and body color via BikeStats.bodyColor. Replay
  // mode pulls the player's variant from the recording's slot 0.
  const playerVariant = activeReplay
    ? resolveBikeVariant(activeReplay.bikes[0]?.variantId ?? null)
    : resolveBikeVariant(params.get('bike'))

  // Asset manifest — generated by `pnpm gen:all`. Used downstream for
  // prop GLB lookups + (via the cold-boot menu) the track picker. The
  // legacy garage overlay was replaced by the menu flow; tracks come
  // from URL params now, with sensible defaults.
  const manifest = await loadManifest()

  // Apply any persisted water tuning eagerly, so the page opens in the
  // visual state the user last left. The tuning sliders themselves —
  // along with the dev-settings sliders — are dynamic-imported on first
  // toggle-button click so their UI code stays out of the main bundle.
  applyStoredWaterTuning(waterMesh)
  bindLazyMenuButton('devsettings-toggle', async () => {
    const { installDevSettingsMenu } = await import('./engine/dev-settings-menu')
    return installDevSettingsMenu()
  })
  bindLazyMenuButton('water-debug-toggle', async () => {
    const { installWaterDebugMenu } = await import('./engine/water-debug-menu')
    return installWaterDebugMenu(waterMesh)
  })

  // Best-lap tracking. We compare each completed lap to the saved best
  // for (track, bike) and update on every personal-best.
  let lapStartRaceTime = 0
  let bestLapThisRace: number | null = null
  let lastLapTime: number | null = null
  let bestLapAllTime: number | null = getBestLap({
    trackId,
    bikeId: playerVariant.id,
  })

  const editMode = editModeFlag

  // Track terrain + data. See `src/boot/track-loader.ts` — handles
  // procedural tracks, JSON tracks, GLB tracks, and the empty-draft
  // fallback for editor on a fresh id.
  const track = await loadTrackForBoot({ trackId, scene, phys, editMode })

  // Sky / atmosphere system. Owns the dome mesh, fog + hemi-light palette,
  // and the PMREM env-map. The sun position and env-map are picked once
  // here (driven by `track.sky.timeOfDay`) and frozen for the whole race —
  // previously we re-baked every 4 s and that bake was a noticeable hitch.
  // Per-frame `tick()`s below only keep the shadow camera on the player.
  const sky = createSkySystem({
    scene,
    renderer,
    sun,
    hemi,
    water: waterMesh,
    config: track.sky,
  })

  // Edit mode: the editor owns the canvas, sim/physics are skipped, no AI
  // bikes, no race system. The user authors the track and saves to disk;
  // hitting "Play" reloads without `?edit=1` to drive the changes.
  if (editMode) {
    if (backendEl) backendEl.textContent = `editor · backend ${backend}`
    const editor = installTrackEditor({
      scene,
      camera,
      renderer,
      domEl: appEl,
      track,
      propAssets: manifest.props,
    })
    let editLastT = performance.now()
    function editFrame() {
      const now = performance.now()
      const dt = Math.min(0.1, (now - editLastT) / 1000)
      editLastT = now
      // Editor: lighting is fixed at the track's `timeOfDay` (the dome
      // bakes a single env-map at load), so this tick is just shadow-
      // camera focus tracking off the editor camera.
      sky.tick(waveField.time, dt, { x: camera.position.x, z: camera.position.z })
      updateUnderwaterFog(scene, camera.position.y)
      waterMesh.tick()
      editor.tick()
      requestAnimationFrame(editFrame)
    }
    requestAnimationFrame(editFrame)
    return
  }
  const trackVisuals = createTrackVisuals(track)
  scene.add(trackVisuals.group)

  // Editor-authored props: render meshes + static colliders. Asset
  // props (those carrying `assetId`) need their GLBs pre-loaded so the
  // sync render/collider builders can query the registry.
  const assetIds = new Set<string>()
  for (const p of track.props) {
    if (p.type === 'asset' && p.assetId) assetIds.add(p.assetId)
  }
  const propAssets = new Map<string, LoadedProp>()
  if (assetIds.size > 0) {
    const loaded = await Promise.all(
      [...assetIds].map(async (id) => {
        try {
          return [id, await loadProp(`/assets/props/${id}.glb`)] as const
        } catch (err) {
          console.warn(`[boot] prop asset '${id}' failed to load:`, err)
          return null
        }
      }),
    )
    for (const entry of loaded) {
      if (entry) propAssets.set(entry[0], entry[1])
    }
  }
  if (track.props.length > 0) {
    scene.add(createPropsMesh(track.props, propAssets))
    createPropColliders(phys, track.props, propAssets)
  }

  // Pickup spawns from track.
  for (let i = 0; i < track.pickupSpawns.length; i++) {
    createPickupSpawn(sim, track.pickupSpawns[i]!, i)
  }

  // Load bike GLBs in parallel: the player's chosen variant plus the
  // racer baseline (used by AI bikes, and as the fallback if the
  // player's variant fetch fails). The cache in bike-loader dedupes
  // when the player's variant already is the racer.
  const [playerBikeGlb, racerBikeGlb] = await Promise.all([
    loadBike(`/assets/bikes/${playerVariant.id}.glb`),
    loadBike('/assets/bikes/racer.glb'),
  ])

  // Spawn bikes — see `src/boot/spawn-bikes.ts`. Order is deterministic
  // (player slot 0 then AI 1..N, or replay-recording order) so the
  // recorder / player downstream see consistent slot numbering.
  const { playerEid, aiEids, replayBikeEids } = spawnBikes({
    sim,
    phys,
    track,
    playerVariant,
    activeReplay,
  })

  // M10.7 — remote-peer bike spawn. Each connected remote peer gets a
  // PeerControlled bike whose ControlIntent is driven by the relay's
  // last-known intent for that slot (drained in the sim loop). Variant
  // defaults to racer; variant negotiation over the room is a future slice.
  //
  // M10.8 — remote bikes are now Racer-tagged so the local race system
  // tracks their checkpoint crossings, lap progress, and finish state.
  // The position HUD updates as remote bikes pass gates. Mid-race joiners
  // start at lap 1 / cp 0 — they naturally land at the back of the field.
  // Each peer computes standings against the local sim, so views may
  // diverge from one another by network latency; full reconciliation is
  // a later slice.
  const remoteEids = new Map<number, number>()
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
    if (!net || !net.ready) {
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

  // Mark the initial "next" gate (cp 0). After the first frame the race
  // callback takes over.
  trackVisuals.setCheckpointState(0, 'next')

  const raceHud = createRaceHud({
    track,
    onCountdownTick: (n) => {
      // Light audio cue: re-use the gate "ding" for each tick, lap fanfare for GO.
      if (n === 0) audio.lapCompleted()
      else audio.gateCleared()
    },
    // The lobby phase concludes before we reach this code, so the
    // countdown can auto-start for both single-player and multiplayer
    // race entry. Late joiners drop in mid-race; their countdown is
    // skipped further down via raceHud.skipCountdown() once a remote
    // race state is detected.
  })

  const raceTick = createRaceSystem(track, {
    onCheckpoint: (eid, justCrossed) => {
      const racerNow = RacerStore.get(eid)
      if (!racerNow) return

      // Record every racer's crossing for the gap-to-leader table. Indexed by
      // checkpointsCrossed (cumulative, lap-aware) — the first racer to reach
      // the Nth crossing seeds the leader time at that progress marker.
      raceHud.recordRacerCheckpoint(eid, racerNow.checkpointsCrossed, racerNow.raceTime)

      if (eid !== playerEid) return
      const r = racerNow
      // The race system has already advanced nextCheckpoint by the time this
      // fires (post-update), so r.nextCheckpoint is the *upcoming* gate.
      // Mark each gate by its relationship to that pointer.
      for (const cp of track.checkpoints) {
        if (cp.index === r.nextCheckpoint) {
          trackVisuals.setCheckpointState(cp.index, 'next')
        } else if (cp.index === justCrossed) {
          trackVisuals.setCheckpointState(cp.index, 'passed')
        } else {
          trackVisuals.setCheckpointState(cp.index, 'upcoming')
        }
      }
      // Audio cue + lap timing.
      // - First cp 0 crossing (`checkpointsCrossed === 1`) is the
      //   "engines on" moment: zero the lap timer so the spawn-to-line
      //   drive doesn't pad lap 1.
      // - Subsequent cp 0 crossings end a lap: emit the celebratory
      //   arpeggio, record the time, persist if it beats the all-time
      //   best for this (track, bike) combo.
      // - Any other gate is just a quick ding.
      if (justCrossed === 0 && r.checkpointsCrossed === 1) {
        lapStartRaceTime = r.raceTime
        audio.gateCleared()
      } else if (justCrossed === 0 && r.checkpointsCrossed > 1) {
        audio.lapCompleted()
        const lapTime = r.raceTime - lapStartRaceTime
        lastLapTime = lapTime
        lapStartRaceTime = r.raceTime
        if (bestLapThisRace === null || lapTime < bestLapThisRace) {
          bestLapThisRace = lapTime
        }
        if (recordLapTime({ trackId, bikeId: playerVariant.id }, lapTime)) {
          bestLapAllTime = lapTime
        }
      } else {
        audio.gateCleared()
      }

      // Gap-to-leader toast — fired only on non-start crossings (the very
      // first crossing of cp 0 is the race-start "engines on" moment, where
      // every racer is essentially tied).
      if (r.checkpointsCrossed > 0) {
        raceHud.reportPlayerCheckpoint(r.checkpointsCrossed, r.raceTime)
      }
    },
  })

  // Replay recorder. Always-on during a normal race so the finish screen
  // can offer a "Save Replay" download. Captures bike transforms at 30Hz —
  // a 90s race × 5 bikes × 7 floats per sample fits comfortably in
  // sessionStorage / a download blob (~250 KB). In replay-playback mode the
  // recorder is null (we play, we don't re-record).
  let recorder: ReplayRecorder | null = null
  let recorderStart = 0
  if (!activeReplay) {
    const recorderBikes: ReplayBike[] = []
    recorderBikes.push({
      slot: 0,
      isPlayer: true,
      variantId: playerVariant.id,
      displayName: playerVariant.name,
      bodyColor: playerVariant.bodyColor,
    })
    for (let i = 0; i < aiEids.length; i++) {
      // AI bikes always use the racer baseline today (see spawn block above).
      const racerVariant = resolveBikeVariant('racer')
      recorderBikes.push({
        slot: i + 1,
        isPlayer: false,
        variantId: racerVariant.id,
        displayName: `${racerVariant.name} ${i + 1}`,
        bodyColor: racerVariant.bodyColor,
      })
    }
    recorder = createReplayRecorder({
      trackId,
      trackName: track.name,
      bikes: recorderBikes,
    })
    recorderStart = performance.now()
  }

  const bikeRender = createBikeRenderSystem(scene, sim, {
    byVariantId: { [playerVariant.id]: playerBikeGlb, racer: racerBikeGlb },
    default: racerBikeGlb,
  })
  const pickupRender = createPickupRenderSystem(scene, sim)
  const combatRender = createCombatRenderSystem(scene, sim)
  const fxTick = createFxSystem(scene, sim, phys)
  const dirArrow = createDirectionArrow()
  scene.add(dirArrow.mesh)

  // Collision wireframe overlay — pulls `world.debugRender()` each frame
  // when enabled. Toggle: F2 key, `?debug=collision` URL param, or
  // `window.__hover.toggleCollisionDebug()`. Cheap when off (early-return
  // in tick), so it stays in the scene at all times.
  const physicsDebug = createPhysicsDebugRenderer(phys)
  scene.add(physicsDebug.mesh)
  if (params.get('debug') === 'collision') {
    physicsDebug.setEnabled(true)
  }

  // Audio: lazy-init AudioContext on first user gesture (browsers block
  // autoplay until then). The engine itself is safe to call before
  // `resume()` — every method early-returns without a context.
  const audio = createAudioEngine()
  const unlockAudio = () => {
    audio.resume()
    window.removeEventListener('keydown', unlockAudio)
    window.removeEventListener('pointerdown', unlockAudio)
  }
  window.addEventListener('keydown', unlockAudio, { once: false })
  window.addEventListener('pointerdown', unlockAudio, { once: false })

  // Per-frame audio dispatch needs to remember "what was true last tick" so
  // it can fire one-shots on transitions. Player slot for collect/fire
  // events; sim entity counts for any-bike weapon spawns.
  let prevPlayerHeld: PickupType | null = null
  let prevMineCount = 0
  let prevMissileCount = 0
  let prevExplosionCount = 0

  const state = {
    ready: false,
    backend,
    fps: 0,
    frame: 0,
    intent: emptyIntent() as Intent,
    intentOverride: null as Intent | null,
    playerSnapshot: null as PlayerSnapshot | null,
    raceSnapshot: null as RaceSnapshot | null,
  }

  installDebugApi(state, {
    sim: () => sim,
    phys: () => phys,
    track: () => track,
    playerEid: () => playerEid,
    toggleAutoPlay: () => {
      setAutoPlay(!autoPlay)
      return autoPlay
    },
    isAutoPlay: () => autoPlay,
    toggleCollisionDebug: () => {
      const on = physicsDebug.toggle()
      updateCollisionPill()
      return on
    },
    isCollisionDebugOn: () => physicsDebug.isEnabled(),
    skipCountdown: () => raceHud.skipCountdown(),
    determinismMode: () => determinismMode,
    waveField: () => waveField,
    raceTick: () => raceTick,
    netProbe: () => {
      if (!net) return null
      // Capture under a const so subsequent ts narrowing survives.
      const room = net
      return {
        ready: () => room.ready,
        peerId: () => room.peerId,
        remotePeers: () => room.remotePeers,
        isHost: () => (room.ready ? isHostFor(room.peerId, room.remotePeers) : true),
        recentRemoteFrames: () =>
          // Shallow-copy so devtools probes can't mutate the live buffer.
          recentRemoteFrames.map((f) => ({
            tick: f.tick,
            peerId: f.peerId,
            intent: { ...f.intent },
          })),
        latestPeerIntents: () => {
          // Snapshot the live Map into a plain object for devtools JSON
          // serialization; the underlying map is mutated each tick.
          const out: Record<number, Intent> = {}
          for (const [pid, intent] of room.latestPeerIntents) {
            out[pid] = { ...intent }
          }
          return out
        },
        snapshotsReceived: () => room.snapshotsReceived,
      }
    },
  })
  if (backendEl) backendEl.textContent = `backend: ${backend}`
  if (finishSub) finishSub.textContent = track.name

  let finishShown = false
  let autoPlay = false

  /** Attach/detach AITag on the player. When attached, ai-control-system
   *  drives the player's ControlIntent (overwriting applyPlayerIntent's write
   *  because aiControlSystem runs after it). */
  function setAutoPlay(on: boolean) {
    autoPlay = on
    if (on) {
      if (!hasComponent(sim, playerEid, AITag)) {
        addComponent(sim, playerEid, AITag)
        addComponent(sim, playerEid, AIController)
      }
      // Always reset AI state on toggle — fresh closest-point search, no carry
      // over from previous auto-play sessions on the same page.
      AIControllerStore.set(playerEid, defaultAIController('main'))
    } else if (hasComponent(sim, playerEid, AITag)) {
      removeComponent(sim, playerEid, AITag)
    }
  }

  // Pause menu state. Toggled by Esc during a live race (after the
  // countdown, before the finish screen). In single-player the sim is
  // frozen while paused (physAccum is held at 0 so unpause is instant
  // — no catch-up burst). In multiplayer the menu still appears but the
  // sim keeps advancing, since pausing one peer can't pause the relay.
  let pausedForMenu = false
  const pauseMenuEl = document.getElementById('pause-menu')
  const pauseSubtitleEl = document.getElementById('pause-subtitle')
  function openPauseMenu(): void {
    if (pausedForMenu) return
    if (raceHud.isLocked()) return // can't pause during countdown
    if (finishShown) return
    pausedForMenu = true
    pauseMenuEl?.classList.add('show')
    if (pauseSubtitleEl) {
      const racer = RacerStore.get(playerEid)
      const lap = racer ? Math.min(racer.lap, track.lapsToFinish) : 1
      pauseSubtitleEl.textContent = `${track.name.toUpperCase()} · LAP ${lap}/${track.lapsToFinish}`
    }
    // Focus RESUME so Enter resumes immediately if the player wants.
    ;(document.getElementById('pause-resume') as HTMLButtonElement | null)?.focus({
      preventScroll: true,
    })
  }
  function closePauseMenu(): void {
    if (!pausedForMenu) return
    pausedForMenu = false
    pauseMenuEl?.classList.remove('show')
  }

  // Finish-screen actions. NEXT advances to the next track in the
  // catalogue rotation (wrapping); RETRY reloads the same combo; EXIT
  // navigates to a bare URL so boot re-enters the menu flow. All three
  // do a full page reload — boot is cheap (< 500ms) and a reload keeps
  // the asset/physics teardown story trivial.
  function buildRaceUrl(args: { trackId: string; bikeId: string }): string {
    const url = new URL(window.location.href)
    url.search = ''
    if (roomId) url.searchParams.set('room', roomId)
    url.searchParams.set('race', '1')
    url.searchParams.set('track', args.trackId)
    url.searchParams.set('bike', args.bikeId)
    return url.toString()
  }
  function goToNextRace(): void {
    const tracksList = buildTrackList(manifest.tracks)
    const nextId = nextTrackId(tracksList, trackId)
    window.location.assign(buildRaceUrl({ trackId: nextId, bikeId: playerVariant.id }))
  }
  function retryRace(): void {
    window.location.assign(buildRaceUrl({ trackId, bikeId: playerVariant.id }))
  }
  function exitToMenu(): void {
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.set('back', '1')
    window.location.assign(url.toString())
  }
  // Wire pause-menu buttons exactly once (the DOM is shared across the
  // session, so re-binding on every open would leak click handlers).
  ;(document.getElementById('pause-resume') as HTMLButtonElement | null)?.addEventListener(
    'click',
    closePauseMenu,
  )
  ;(document.getElementById('pause-restart') as HTMLButtonElement | null)?.addEventListener(
    'click',
    retryRace,
  )
  ;(document.getElementById('pause-exit') as HTMLButtonElement | null)?.addEventListener(
    'click',
    exitToMenu,
  )
  ;(document.getElementById('pause-settings') as HTMLButtonElement | null)?.addEventListener(
    'click',
    () => {
      // Hide pause menu while settings are open so the user lands on
      // a single overlay. The existing dev-settings toggle handles the
      // lazy-import + open; we just click it.
      closePauseMenu()
      ;(document.getElementById('devsettings-toggle') as HTMLButtonElement | null)?.click()
    },
  )
  // Multiplayer can't restart a race solo — disable that button when
  // we're connected to a room. (The button is still visible so the
  // pause menu reads consistently across modes.)
  if (roomId) {
    const restartBtn = document.getElementById('pause-restart') as HTMLButtonElement | null
    if (restartBtn) {
      restartBtn.disabled = true
      restartBtn.title = 'Disabled in multiplayer'
    }
  }

  /** Snap the player back to the spawn pose with zero velocity. Useful after
   *  collisions leave the bike upside-down, off-track, or unrecoverable. */
  function respawnPlayer() {
    const handle = RBHandleStore.get(playerEid)
    if (!handle) return
    const rb = phys.world.getRigidBody(handle.handle)
    if (!rb) return
    const halfYaw = track.start.yaw / 2
    rb.setTranslation(
      { x: track.start.position.x, y: track.start.position.y, z: track.start.position.z },
      true,
    )
    rb.setRotation({ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) }, true)
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
  }

  // Keys:
  //   Esc — toggle pause menu (in-race only; finish-screen Esc exits)
  //   Enter/R — NEXT/RETRY on the finish screen; on pause menu, Enter
  //             resumes (the focused button's default action) and R
  //             restarts; Q exits to menu.
  //   T/F1 — auto-play; F2 — collision debug; M — mute; Backspace — respawn.
  window.addEventListener('keydown', (e) => {
    if (finishShown && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
      goToNextRace()
      e.preventDefault()
      return
    }
    if (finishShown && e.code === 'Escape') {
      exitToMenu()
      e.preventDefault()
      return
    }
    // Pause menu — Esc toggles open/closed during a live race. Once
    // open, R restarts and Q bails to the menu so you don't have to
    // mouse over the buttons.
    if (e.code === 'Escape' && !finishShown) {
      if (pausedForMenu) closePauseMenu()
      else openPauseMenu()
      e.preventDefault()
      return
    }
    if (pausedForMenu) {
      if (e.code === 'KeyR' && !roomId) {
        retryRace()
        e.preventDefault()
        return
      }
      if (e.code === 'KeyQ') {
        exitToMenu()
        e.preventDefault()
        return
      }
      // Eat other gameplay keys so they don't fire while paused.
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter') {
        return
      }
    }
    if (e.code === 'KeyR' && finishShown) {
      retryRace()
      e.preventDefault()
    } else if (e.code === 'KeyT' || e.code === 'F1') {
      setAutoPlay(!autoPlay)
    } else if (e.code === 'F2') {
      physicsDebug.toggle()
      updateCollisionPill()
      e.preventDefault()
    } else if (e.code === 'KeyM') {
      audio.setMuted(!audio.isMuted())
    } else if (e.code === 'Backspace') {
      respawnPlayer()
      e.preventDefault()
    }
  })

  // HUD pill showing the collision debug state. Hidden when off.
  const collisionPill = document.getElementById('hud-collision')
  function updateCollisionPill() {
    if (!collisionPill) return
    if (physicsDebug.isEnabled()) {
      collisionPill.textContent = 'collision: ON (F2)'
      collisionPill.style.display = 'inline-block'
    } else {
      collisionPill.style.display = 'none'
    }
  }
  updateCollisionPill()

  const tmpPos = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  const tmpTarget = new THREE.Vector3()

  // Reused per-frame minimap-dot buffer. raceHud copies the array each tick
  // (it sorts a shallow clone), so we can safely truncate and mutate in place.
  // The dot objects themselves live in `hudBikePool` and are mutated by index
  // so the population path is allocation-free once the pool is warm.
  type HudBike = { x: number; z: number; isPlayer: boolean; isLeader: boolean }
  const hudBikes: HudBike[] = []
  const hudBikePool: HudBike[] = []

  // Reused per-frame buffer for the GPU water shader's bike impact array.
  // Sourced from `waveField.wakes`, which `wakeUpdateSystem` populated in
  // the physics loop above. Single source of truth: the displacement the
  // shader draws is the same displacement buoyancy reads.
  const bikeImpacts: BikeImpact[] = []
  function gatherBikeImpacts(): readonly BikeImpact[] {
    bikeImpacts.length = 0
    for (const w of waveField.wakes) {
      bikeImpacts.push({ x: w.x, z: w.z, vx: w.vx, vz: w.vz, weight: w.weight })
    }
    return bikeImpacts
  }

  let last = performance.now()
  let physAccum = 0
  let framesThisSecond = 0
  let fpsAccumStart = last

  // M10.4 — wire-encoded input round-trip. simTick is the monotonic count
  // of fixed-step sim ticks driven by simulateStep; it lines up across
  // peers in lockstep multiplayer because both sides advance one tick per
  // delivered InputFrame batch. The DataView is reused per tick to avoid
  // a per-frame allocation. LOCAL_PEER_ID is the slot in a future room;
  // in single-player there is exactly one peer (slot 0).
  const LOCAL_PEER_ID = 0
  let simTick = 0
  const inputFrameBuffer = new ArrayBuffer(INPUT_FRAME_WIRE_BYTES)
  const inputFrameView = new DataView(inputFrameBuffer)
  // Reused per-tick to feed simulateStep without allocating a fresh Map
  // each frame. cleared at the top of each tick before population.
  const tickPeerInputs = new Map<number, Intent>()

  // M10.11 — TransformSnapshot broadcast. 20 Hz (every 3 sim ticks at
  // 60 Hz). Each peer broadcasts its own player bike; the AI host also
  // includes the NUM_AI=4 AI bikes in the same message. Reused buffer
  // sized for 5 records (max we ever send) so we don't allocate per send.
  const SNAPSHOT_TICKS = 3
  const MAX_SNAPSHOT_BIKES = 1 + 4
  const snapshotSendBuf = new Uint8Array(snapshotByteLength(MAX_SNAPSHOT_BIKES))

  // Reused scratch buffers for the replay recorder. The recorder copies into
  // its own storage when it accepts a sample (rate-limited), so feeding it the
  // same buffer each frame is safe. Slot list is fixed for the session.
  const replaySlots: number[] = [playerEid, ...aiEids]
  const replayFlat = new Float64Array(replaySlots.length * 7)
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

  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 1 / 15)
    last = now

    state.intent = state.intentOverride ?? readPlayerIntent(dt)

    physAccum += dt
    // Pause menu gates the sim in single-player. Reset the accumulator
    // so unpause doesn't trigger a burst of catch-up steps. Multiplayer
    // keeps stepping — pausing one peer can't pause the relay.
    if (pausedForMenu && !roomId) {
      physAccum = 0
    }
    // In determinism mode the sim is gated off — the harness drives ticks
    // manually via __hover.determinism.run(). physAccum keeps draining so
    // we don't spike on unpause.
    while (physAccum >= phys.fixedDt) {
      if (!determinismPaused) {
        // M10.4 — drive the sim from a wire-encoded InputFrame even in
        // single-player. The round-trip is cheap (~10 bytes / one alloc)
        // and ensures the same quantization is applied locally as remotely,
        // so any feel changes from the wire format are visible day one.
        // When connected to a room, stamp the frame with the assigned
        // peerId (falls back to LOCAL_PEER_ID otherwise) and ship it to
        // the relay BEFORE stepping locally — that ordering means a
        // future lockstep gate could pause here waiting on remote frames
        // without changing the encode/decode contract.
        const myPeerId = net?.ready ? net.peerId : LOCAL_PEER_ID
        const localFrame = {
          tick: simTick,
          peerId: myPeerId,
          intent: state.intent,
        }
        encodeInputFrameInto(inputFrameView, 0, localFrame)
        net?.sendFrame(localFrame)
        const decoded = decodeInputFrameFrom(inputFrameView, 0)
        // M10.5 — sim consumes a per-peer input map. Single-player passes
        // exactly one entry (slot 0). M10.6 — when a room is connected,
        // drain the last-known intent for each remote peer in too; any
        // PeerControlled bike whose peerId is in the map receives that
        // intent. Remote-peer bike spawning lands in a follow-up slice;
        // until then these remote entries match no entity and are no-ops.
        tickPeerInputs.clear()
        tickPeerInputs.set(decoded.peerId, decoded.intent)
        if (net) {
          for (const [pid, intent] of net.latestPeerIntents) {
            if (pid !== decoded.peerId) tickPeerInputs.set(pid, intent)
          }
        }
        const iAmHost = net?.ready ? isHostFor(net.peerId, net.remotePeers) : true
        simulateStep(sim, phys, waveField, track, raceTick, {
          peerInputs: tickPeerInputs,
          locked: raceHud.isLocked(),
          autoPlay,
          waveTimeScale: waterMesh.debug.getTimeScale(),
          runAI: iAmHost,
        })
        // M10.11 — broadcast at 20 Hz. The send is gated on `net.ready &&
        // remotePeers > 0` inside `buildAndSendSnapshot`, so this no-ops
        // outside a room.
        if (simTick % SNAPSHOT_TICKS === 0) buildAndSendSnapshot(simTick, iAmHost)
        simTick++
      }
      physAccum -= phys.fixedDt
    }

    // Replay capture. The recorder rate-limits internally (default 30Hz)
    // so calling every render frame is safe — we just feed it the current
    // elapsed time + flat transforms and it decides whether to push a
    // frame. Capture stops once the finish UI shows so the recording ends
    // cleanly at the moment of crossing the line.
    if (recorder && !finishShown) {
      const elapsed = (now - recorderStart) / 1000
      for (let i = 0; i < replaySlots.length; i++) {
        const eid = replaySlots[i] as number
        const handle = RBHandleStore.get(eid)
        const rb = handle ? phys.world.getRigidBody(handle.handle) : null
        const o = i * 7
        if (!rb) {
          replayFlat[o] = 0
          replayFlat[o + 1] = 0
          replayFlat[o + 2] = 0
          replayFlat[o + 3] = 0
          replayFlat[o + 4] = 0
          replayFlat[o + 5] = 0
          replayFlat[o + 6] = 1
          continue
        }
        const t = rb.translation()
        const q = rb.rotation()
        replayFlat[o] = t.x
        replayFlat[o + 1] = t.y
        replayFlat[o + 2] = t.z
        replayFlat[o + 3] = q.x
        replayFlat[o + 4] = q.y
        replayFlat[o + 5] = q.z
        replayFlat[o + 6] = q.w
      }
      recorder.sample(elapsed, replayFlat)
    }

    const rbHandle = RBHandleStore.get(playerEid)
    const hover = HoverStateStore.get(playerEid)
    if (rbHandle && hover) {
      const playerRb = phys.world.getRigidBody(rbHandle.handle)
      if (playerRb) {
        const t = playerRb.translation()
        const v = playerRb.linvel()
        const q = playerRb.rotation()
        tmpPos.set(t.x, t.y, t.z)
        tmpQuat.set(q.x, q.y, q.z, q.w)
        const look = tickCameraLook(dt)
        chase.setOrbit(look.yaw, look.pitch)
        chase.tick(tmpPos, tmpQuat, dt)
        state.playerSnapshot = {
          eid: playerEid,
          position: { x: t.x, y: t.y, z: t.z },
          velocity: { x: v.x, y: v.y, z: v.z },
          groundDistance: hover.groundDistance,
          isGrounded: hover.isGrounded,
          speed: vecHorizontalLength({ x: v.x, y: 0, z: v.z }),
        }
      }
    }

    // Audio dispatch — runs once per render frame, after physics.
    // Continuous engine + wind layers are driven by the player's speed.
    audio.tickEngine(state.playerSnapshot?.speed ?? 0)

    // Player slot transitions: collected (null → X), or fired with a
    // non-spawning effect (boost / shield). Mine and missile fires also
    // empty the slot, but those sounds come from the entity-spawn path
    // below — handling them here would double-fire on the player's
    // firing tick.
    const currentPlayerHeld = getHeldPickup(playerEid)
    if (prevPlayerHeld === null && currentPlayerHeld !== null) {
      audio.pickupCollect()
    } else if (
      prevPlayerHeld !== null &&
      currentPlayerHeld === null &&
      (prevPlayerHeld === 'boost' || prevPlayerHeld === 'shield')
    ) {
      audio.pickupFire(prevPlayerHeld)
    }
    prevPlayerHeld = currentPlayerHeld

    // Combat entity spawns: any new mine/missile/explosion in the world
    // gets a sound (so AI weapons are audible too, not just the player's).
    const mineCount = query(sim, [MineTag]).length
    if (mineCount > prevMineCount) audio.pickupFire('mine')
    prevMineCount = mineCount
    const missileCount = query(sim, [MissileTag]).length
    if (missileCount > prevMissileCount) audio.pickupFire('missile')
    prevMissileCount = missileCount
    const explosionCount = query(sim, [ExplosionTag]).length
    if (explosionCount > prevExplosionCount) audio.explosion()
    prevExplosionCount = explosionCount

    const racer = RacerStore.get(playerEid)
    if (racer) {
      state.raceSnapshot = {
        lap: racer.lap,
        lapsToFinish: track.lapsToFinish,
        nextCheckpoint: racer.nextCheckpoint,
        checkpointsCrossed: racer.checkpointsCrossed,
        totalCheckpoints: track.checkpoints.length,
        finished: racer.finished,
        raceTime: racer.raceTime,
      }
    }

    waterMesh.tick(gatherBikeImpacts(), { x: camera.position.x, z: camera.position.z })
    // Day-night cycle + fog/hemi palette + PMREM env-map bake. The sky
    // system owns the directional-sun follow (shadow-camera centred on the
    // bike) and the water shader's sun-direction uniform. Time is the
    // deterministic wave-field clock so replays and rollbacks line up.
    sky.tick(waveField.time, dt, {
      x: state.playerSnapshot?.position.x ?? 0,
      z: state.playerSnapshot?.position.z ?? 0,
    })
    updateUnderwaterFog(scene, camera.position.y)
    bikeRender()
    pickupRender(dt)
    combatRender(dt)
    fxTick(dt)
    physicsDebug.tick()

    // Race HUD — countdown banner, race/lap timers, gap toast, minimap.
    // Always ticked: while locked, the timers stay at zero and the
    // banner counts 3..2..1..GO.
    // `standings` is also reused by the FPS-sampled status line below so
    // we only call computeStandings once per render frame.
    const standings = computeStandings(sim, track)
    const meStanding = standings.find((s) => s.eid === playerEid)
    {
      const racerForHud = RacerStore.get(playerEid)

      hudBikes.length = 0
      for (const s of standings) {
        const handle = RBHandleStore.get(s.eid)
        if (!handle) continue
        const rb = phys.world.getRigidBody(handle.handle)
        if (!rb) continue
        const t = rb.translation()
        let dot = hudBikePool[hudBikes.length]
        if (!dot) {
          dot = { x: 0, z: 0, isPlayer: false, isLeader: false }
          hudBikePool.push(dot)
        }
        dot.x = t.x
        dot.z = t.z
        dot.isPlayer = s.eid === playerEid
        dot.isLeader = s.position === 1 && s.eid !== playerEid
        hudBikes.push(dot)
      }

      const raceTimeForHud = racerForHud?.raceTime ?? 0
      const currentLap =
        racerForHud && racerForHud.checkpointsCrossed >= 1 ? raceTimeForHud - lapStartRaceTime : 0

      raceHud.tick({
        dt,
        raceTime: raceTimeForHud,
        lap: racerForHud?.lap ?? 1,
        lapsToFinish: track.lapsToFinish,
        finished: racerForHud?.finished ?? false,
        currentLapTime: currentLap,
        lastLapTime,
        bestLapTime: bestLapThisRace ?? bestLapAllTime,
        bikes: hudBikes,
        playerNextCheckpoint: racerForHud?.nextCheckpoint ?? 0,
        playerPosition: meStanding?.position ?? 1,
        totalRacers: standings.length,
      })
    }

    // Direction arrow points the player to the next checkpoint.
    const racerNow = RacerStore.get(playerEid)
    if (racerNow && !racerNow.finished) {
      const nextCp = track.checkpoints[racerNow.nextCheckpoint]
      if (nextCp) {
        tmpTarget.set(nextCp.position.x, nextCp.position.y, nextCp.position.z)
        dirArrow.tick(camera, tmpPos, tmpTarget, dt)
      } else {
        dirArrow.tick(camera, tmpPos, null, dt)
      }
    } else {
      dirArrow.tick(camera, tmpPos, null, dt)
    }

    renderer.render(scene, camera)

    state.frame += 1
    framesThisSecond += 1
    if (now - fpsAccumStart >= 500) {
      state.fps = (framesThisSecond * 1000) / (now - fpsAccumStart)
      framesThisSecond = 0
      fpsAccumStart = now
      if (fpsEl) fpsEl.textContent = `fps: ${state.fps.toFixed(0)}`
      if (audioEl) audioEl.textContent = `audio: ${audio.isMuted() ? 'muted (M)' : 'on (M)'}`
      if (inputEl) {
        const i = state.intent
        const speed = state.playerSnapshot?.speed ?? 0
        const held = getHeldPickup(playerEid) ?? '—'
        inputEl.textContent = `${inputSourceLabel()} | thr ${i.throttle.toFixed(2)} steer ${i.steer.toFixed(2)} | ${speed.toFixed(1)} m/s | item: ${held}`
      }
      if (raceEl && state.raceSnapshot) {
        const rs = state.raceSnapshot
        const status = rs.finished
          ? 'FINISHED'
          : `cp ${rs.nextCheckpoint + 1}/${rs.totalCheckpoints}`
        const auto = autoPlay ? ' [AUTO]' : ''
        raceEl.textContent = `lap ${rs.lap}/${rs.lapsToFinish} | pos ${meStanding?.position ?? '?'}/${standings.length} | ${status} | ${rs.raceTime.toFixed(1)}s${auto}`

        if (rs.finished && !finishShown && finishEl) {
          finishShown = true
          finishEl.classList.add('show')
          const finishRibbon = document.getElementById('finish-ribbon')
          if (finishPos && meStanding) finishPos.textContent = ordinal(meStanding.position)
          if (finishTime) finishTime.textContent = formatTime(rs.raceTime)
          const wonRace = meStanding?.position === 1
          if (finishTitle) finishTitle.textContent = wonRace ? 'CHAMPION' : 'FINAL'
          if (finishRibbon) finishRibbon.textContent = wonRace ? 'WINNER' : 'FINAL'
          if (finishSub)
            finishSub.textContent = `${track.name.toUpperCase()} · ${playerVariant.name.toUpperCase()}`
          if (finishBest) {
            const parts: string[] = []
            if (bestLapThisRace !== null) {
              parts.push(`${formatLap(bestLapThisRace)} (race)`)
            }
            if (bestLapAllTime !== null) {
              parts.push(`<span class="best">${formatLap(bestLapAllTime)} (PB)</span>`)
            }
            finishBest.innerHTML = parts.length ? parts.join(' · ') : '—'
          }
          // Stash a last-race summary for the menu's title-screen
          // recap card. Stored in sessionStorage so it survives the
          // navigation to `?back=1` but doesn't outlive the tab.
          try {
            sessionStorage.setItem(
              'hover-last-race',
              JSON.stringify({
                trackId,
                trackName: track.name,
                bikeId: playerVariant.id,
                bikeName: playerVariant.name,
                position: meStanding?.position ?? null,
                totalRacers: standings.length,
                time: rs.raceTime,
                bestLap: bestLapThisRace,
                wonRace,
                finishedAt: Date.now(),
              }),
            )
          } catch {
            /* sessionStorage may be unavailable in privacy modes */
          }
          // Replay buttons. The recorder has been capturing throughout
          // the race; finalize it once, then offer both a one-click
          // WATCH (sessionStorage → ?replay=session navigation, reusing
          // the existing replay-playback boot path) and SAVE (download
          // the .replay file). Hidden if no recorder (replay-playback
          // branch can't reach this code, but guard anyway).
          const watchBtn = document.getElementById(
            'finish-watch-replay',
          ) as HTMLButtonElement | null
          const saveBtn = document.getElementById('finish-save-replay') as HTMLButtonElement | null
          if (recorder) {
            const replay = recorder.finalize({
              finishPosition: meStanding?.position ?? null,
              finishTime: rs.raceTime,
              bestLap: bestLapThisRace,
            })
            if (watchBtn) {
              watchBtn.style.display = 'inline-block'
              watchBtn.disabled = false
              watchBtn.onclick = () => {
                try {
                  sessionStorage.setItem('hover-replay-pending', serializeReplay(replay))
                } catch {
                  /* fall through — download instead */
                  downloadReplay(replay)
                  return
                }
                const url = new URL(window.location.href)
                url.search = ''
                url.searchParams.set('replay', 'session')
                window.location.assign(url.toString())
              }
            }
            if (saveBtn) {
              saveBtn.style.display = 'inline-block'
              saveBtn.disabled = false
              saveBtn.textContent = 'SAVE'
              saveBtn.onclick = () => {
                downloadReplay(replay)
                saveBtn.textContent = 'SAVED ✓'
                saveBtn.disabled = true
              }
            }
          }
          // Action buttons: NEXT (default), RETRY, EXIT.
          const nextBtn = document.getElementById('finish-next') as HTMLButtonElement | null
          const retryBtn = document.getElementById('finish-retry') as HTMLButtonElement | null
          const exitBtn = document.getElementById('finish-exit') as HTMLButtonElement | null
          if (nextBtn) {
            nextBtn.onclick = goToNextRace
            nextBtn.focus({ preventScroll: true })
          }
          if (retryBtn) retryBtn.onclick = retryRace
          if (exitBtn) exitBtn.onclick = exitToMenu
        }
      }
    }
    requestAnimationFrame(frame)
  }

  // Replay-playback mode: replace the normal physics-driven frame with one
  // that interpolates bike transforms from the recorded snapshots and
  // hands them straight to the render systems. No physics, no AI, no race
  // tracking — just a guided tour of what already happened.
  if (activeReplay) {
    const replayPlayer = createReplayPlayer(activeReplay)
    const poseBuffer = makePoseBuffer(replayPlayer.bikeCount)
    const spectator = createSpectatorCamera(camera)
    let followedSlot = 0

    const focalPos = new THREE.Vector3()
    const focalQuat = new THREE.Quaternion()

    const hud = installSpectatorHud({
      replay: activeReplay,
      player: replayPlayer,
      camera: spectator,
      getFollowedSlot: () => followedSlot,
      setFollowedSlot: (s) => {
        if (s < 0 || s >= replayBikeEids.length) return
        followedSlot = s
        // Snap the camera to avoid an awkward swing across the map when
        // jumping between bikes that are far apart.
        const p = poseBuffer[s]!
        focalPos.set(p.x, p.y, p.z)
        focalQuat.set(p.qx, p.qy, p.qz, p.qw)
        spectator.snap(focalPos, focalQuat)
      },
      exit: () => {
        // Drop the pending replay so a refresh doesn't re-enter spectator
        // mode, then return to the garage on a clean URL.
        sessionStorage.removeItem('hover-replay-pending')
        const url = new URL(window.location.href)
        url.searchParams.delete('replay')
        window.location.assign(url.toString())
      },
    })
    hud.show()

    // Hide HUD bits that don't apply to playback. The race + audio rows
    // would just show stale zeros; the FPS row is fine to keep. Same for
    // the arcade race HUD (countdown banner, timer card, gap toast,
    // minimap) — those are tied to a live race the spectator isn't in.
    if (raceEl) raceEl.style.display = 'none'
    if (inputEl) inputEl.style.display = 'none'
    if (audioEl) audioEl.style.display = 'none'
    for (const id of ['race-banner', 'race-timer', 'race-gap', 'race-minimap']) {
      const el = document.getElementById(id)
      if (el) el.style.display = 'none'
    }
    if (backendEl) backendEl.textContent = `replay · backend ${backend}`

    // Free-orbit input: left mouse drag on canvas rotates, wheel zooms.
    // Right-click is reserved for the existing chase-mode camera-look so
    // we leave it alone.
    let orbitDragging = false
    let lastOrbitX = 0
    let lastOrbitY = 0
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0 && spectator.mode === 'orbit') {
        orbitDragging = true
        lastOrbitX = e.clientX
        lastOrbitY = e.clientY
        e.preventDefault()
      }
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!orbitDragging) return
      spectator.rotate(e.clientX - lastOrbitX, e.clientY - lastOrbitY)
      lastOrbitX = e.clientX
      lastOrbitY = e.clientY
    }
    const onMouseUp = () => {
      orbitDragging = false
    }
    const onWheel = (e: WheelEvent) => {
      if (spectator.mode !== 'orbit') return
      spectator.zoom(e.deltaY)
      e.preventDefault()
    }
    appEl.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    appEl.addEventListener('wheel', onWheel, { passive: false })

    // Keyboard playback shortcuts. Numbered keys 1..9 follow that bike
    // slot (1 = recorded player). Space toggles play/pause; ←/→ scrub
    // ±5s; F toggles free-orbit camera.
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        replayPlayer.paused = !replayPlayer.paused
        e.preventDefault()
      } else if (e.code === 'ArrowLeft') {
        replayPlayer.seek(replayPlayer.time - 5)
      } else if (e.code === 'ArrowRight') {
        replayPlayer.seek(replayPlayer.time + 5)
      } else if (e.code === 'KeyF') {
        spectator.setMode(spectator.mode === 'chase' ? 'orbit' : 'chase')
        if (spectator.mode === 'orbit') spectator.resetOrbit()
      } else if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5))
        if (n >= 1 && n <= replayBikeEids.length) {
          followedSlot = n - 1
          const p = poseBuffer[followedSlot]!
          focalPos.set(p.x, p.y, p.z)
          focalQuat.set(p.qx, p.qy, p.qz, p.qw)
          spectator.snap(focalPos, focalQuat)
        }
      }
    })

    // Spawn-pose snap: feed the very first replay frame into TransformStore
    // before anything renders, so the first paint has bikes in the right
    // place rather than at the spawn cluster.
    replayPlayer.sample(poseBuffer)
    for (let i = 0; i < replayBikeEids.length; i++) {
      const eid = replayBikeEids[i]!
      const p = poseBuffer[i]!
      TransformStore.set(eid, {
        x: p.x,
        y: p.y,
        z: p.z,
        qx: p.qx,
        qy: p.qy,
        qz: p.qz,
        qw: p.qw,
      })
    }
    {
      const p0 = poseBuffer[followedSlot]!
      focalPos.set(p0.x, p0.y, p0.z)
      focalQuat.set(p0.qx, p0.qy, p0.qz, p0.qw)
      spectator.snap(focalPos, focalQuat)
    }

    let lastReplay = performance.now()
    function replayFrame(now: number) {
      const dt = Math.min((now - lastReplay) / 1000, 1 / 15)
      lastReplay = now

      // Wave field still ticks so the water shader animates and the sun
      // continues its day-night cycle. Speed-scaled so 2× playback also
      // doubles the wave time-step, keeping the visual coupling intact.
      advanceWaveField(
        waveField,
        dt * waterMesh.debug.getTimeScale() * (replayPlayer.paused ? 0 : replayPlayer.speed),
      )

      replayPlayer.tick(dt, poseBuffer)
      for (let i = 0; i < replayBikeEids.length; i++) {
        const eid = replayBikeEids[i]!
        const p = poseBuffer[i]!
        TransformStore.set(eid, {
          x: p.x,
          y: p.y,
          z: p.z,
          qx: p.qx,
          qy: p.qy,
          qz: p.qz,
          qw: p.qw,
        })
      }
      const fp = poseBuffer[followedSlot] ?? poseBuffer[0]!
      focalPos.set(fp.x, fp.y, fp.z)
      focalQuat.set(fp.qx, fp.qy, fp.qz, fp.qw)
      spectator.tick(focalPos, focalQuat, dt)

      waterMesh.tick([], { x: camera.position.x, z: camera.position.z })

      // Sky/atmosphere — same call as the live loop; sun follows the focal
      // bike so shadows stay framed during spectator pans.
      sky.tick(waveField.time, dt, { x: focalPos.x, z: focalPos.z })
      updateUnderwaterFog(scene, camera.position.y)
      bikeRender()
      pickupRender(dt)
      combatRender(dt)
      fxTick(dt)
      physicsDebug.tick()

      hud.refresh()
      renderer.render(scene, camera)

      state.frame += 1
      framesThisSecond += 1
      if (now - fpsAccumStart >= 500) {
        state.fps = (framesThisSecond * 1000) / (now - fpsAccumStart)
        framesThisSecond = 0
        fpsAccumStart = now
        if (fpsEl) fpsEl.textContent = `fps: ${state.fps.toFixed(0)}`
      }
      requestAnimationFrame(replayFrame)
    }
    state.ready = true
    requestAnimationFrame(replayFrame)
    return
  }

  state.ready = true
  requestAnimationFrame(frame)
}
boot().catch((err) => {
  console.error('[boot] fatal', err)
  const el = document.getElementById('hud-backend')
  if (el) el.textContent = `boot failed: ${String(err)}`
})
