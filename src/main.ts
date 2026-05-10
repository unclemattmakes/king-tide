import { addComponent, hasComponent, query, removeComponent } from 'bitecs'
import * as THREE from 'three'
import { installDebugApi, type PlayerSnapshot, type RaceSnapshot } from './debug'
import { createAudioEngine } from './engine/audio/audio'
import { loadDevSettings } from './engine/dev-settings'
import { installDevSettingsMenu } from './engine/dev-settings-menu'
import { installTrackEditor } from './engine/editor/track-editor'
import { formatLap, installGarageMenu } from './engine/garage'
import {
  emptyIntent,
  type Intent,
  inputSourceLabel,
  installInput,
  readPlayerIntent,
} from './engine/input'
import { installCameraLookInput, tickCameraLook } from './engine/input/camera-look'
import { createIslandMesh } from './engine/render/arena-mesh'
import { createChaseCamera } from './engine/render/camera'
import { createCliffsideMesh } from './engine/render/cliffside-mesh'
import { createCombatRenderSystem } from './engine/render/combat-render'
import { createDirectionArrow } from './engine/render/direction-arrow'
import { createFxSystem } from './engine/render/fx'
import { attachTrackColliders, loadGlbTrackVisuals } from './engine/render/glb-track'
import { createPhysicsDebugRenderer } from './engine/render/physics-debug'
import { createPickupRenderSystem } from './engine/render/pickup-render'
import { createPropsMesh } from './engine/render/props-mesh'
import { createRampMesh } from './engine/render/ramp-mesh'
import { createBikeRenderSystem } from './engine/render/render-systems'
import { createRenderer } from './engine/render/renderer'
import { createScene } from './engine/render/scene'
import { createTrackVisuals } from './engine/render/track-mesh'
import { type BikeImpact, createWaterMesh } from './engine/render/water'
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
import { installWaterDebugMenu } from './engine/water-debug-menu'
import { loadBike } from './game/assets/bike-loader'
import { loadManifest } from './game/assets/manifest'
import { type LoadedProp, loadProp } from './game/assets/prop-loader'
import { resolveBikeVariant } from './game/bikes/variants'
import { HoverStateStore, RBHandleStore, TransformStore } from './game/components'
import { AIController, AIControllerStore, AITag, defaultAIController } from './game/components/ai'
import { ExplosionTag, MineTag, MissileTag } from './game/components/combat'
import type { PickupType } from './game/components/pickup'
import { RacerStore } from './game/components/race'
import { createLagoonIsland, createSafetyFloor } from './game/entities/arena'
import { createBike } from './game/entities/bike'
import { createCliffsideTerrain } from './game/entities/cliffside-terrain'
import { createPickupSpawn } from './game/entities/pickup-spawn'
import { createPropColliders } from './game/entities/props'
import { createRamp } from './game/entities/ramp'
import { aiCombatSystem } from './game/systems/ai-combat'
import { aiControlSystem } from './game/systems/ai-control'
import {
  explosionTickSystem,
  mineSystem,
  missileSystem,
  shieldTickSystem,
  stunOverrideSystem,
  stunTickSystem,
} from './game/systems/combat'
import { hoverSystem } from './game/systems/hover'
import { applyPlayerIntent } from './game/systems/input-apply'
import {
  boostTickSystem,
  getHeldPickup,
  pickupSystem,
  pickupUseSystem,
} from './game/systems/pickup'
import { createRaceSystem } from './game/systems/race'
import { rubberBandSystem } from './game/systems/rubber-band'
import { computeStandings } from './game/systems/standings'
import { syncFromPhysics } from './game/systems/sync-from-physics'
import { wakeUpdateSystem } from './game/systems/wake-update'
import { createCliffside } from './game/tracks/cliffside'
import { loadTrackFromGlb } from './game/tracks/glb-loader'
import { buildTrackFromJson } from './game/tracks/json-loader'
import { createLagoonLoop } from './game/tracks/lagoon-loop'

const NUM_AI = 4

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

  const fpsEl = document.getElementById('hud-fps')
  const backendEl = document.getElementById('hud-backend')
  const inputEl = document.getElementById('hud-input')
  const raceEl = document.getElementById('hud-race')
  const audioEl = document.getElementById('hud-audio')
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
  const { scene, camera, sun } = createScene()
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

  // Asset manifest — generated by `pnpm gen:all`. Fed to the garage
  // menu so spec-driven tracks land in the picker without code changes.
  const manifest = await loadManifest()

  // Garage menu — DOM overlay opened from a HUD button.
  installGarageMenu({
    initialTrackId: trackId,
    initialBikeId: playerVariant.id,
    manifestTracks: manifest.tracks,
  })

  // Dev settings — live-tunable input/camera feel knobs.
  installDevSettingsMenu()

  // Water debug — live-tunable wave + shader knobs. Loads + applies any
  // persisted settings from a previous tuning session.
  installWaterDebugMenu(waterMesh)

  // Best-lap tracking. We compare each completed lap to the saved best
  // for (track, bike) and update on every personal-best.
  let lapStartRaceTime = 0
  let bestLapThisRace: number | null = null
  let bestLapAllTime: number | null = getBestLap({
    trackId,
    bikeId: playerVariant.id,
  })

  // Universal: backstop floor for any track.
  createSafetyFloor(phys)

  // Per-track terrain (physics + visuals). Procedural tracks build their
  // own terrain in code; .glb-backed tracks load mesh + collider geometry
  // straight from the asset.
  if (trackId === 'cliffside') {
    createCliffsideTerrain(phys)
    scene.add(createCliffsideMesh())
  } else if (trackId === 'lagoon') {
    createLagoonIsland(phys)
    scene.add(createIslandMesh())
    createRamp(phys)
    scene.add(createRampMesh())
  }

  const editMode = editModeFlag

  let track: import('./game/tracks/types').Track
  if (trackId === 'cliffside') {
    track = createCliffside()
  } else if (trackId === 'lagoon') {
    track = createLagoonLoop()
  } else {
    // Try a JSON-authored track first (gameplay data from the in-app
    // editor or hand-edited spec). On 404, fall back to a hand-authored
    // Blender export at the conventional GLB path so anything produced
    // by `tools/export_track.py` is playable via `?track=<id>` without
    // a per-track branch here.
    const jsonUrl = `/tracks/${trackId}.json`
    const jsonRes = await fetch(jsonUrl)
    // Vite's SPA fallback returns 200 + index.html for missing static
    // files, so a "real" JSON track has to be both 200 AND served as
    // application/json. Anything else falls through to the GLB / draft
    // path below as a missing track.
    const jsonContentType = jsonRes.headers.get('content-type') ?? ''
    const jsonExists = jsonRes.ok && jsonContentType.includes('json')
    if (jsonExists) {
      track = buildTrackFromJson(JSON.parse(await jsonRes.text()))
      if (track.environmentGlb && !editMode) {
        const env = await loadGlbTrackVisuals(track.environmentGlb)
        scene.add(env.scene)
        attachTrackColliders(env.scene, phys)
      }
    } else if (!jsonRes.ok && jsonRes.status !== 404) {
      throw new Error(`track: fetch ${jsonUrl} failed: ${jsonRes.status} ${jsonRes.statusText}`)
    } else {
      // No JSON. Two paths:
      //   - GLB exists: load it as the legacy all-in-glb track.
      //   - Edit mode + no GLB: stub an empty draft so the editor can
      //     open a fresh track for the user to author. Saving from the
      //     editor materialises `public/tracks/<id>.json`.
      const glbUrl = `/assets/tracks/${trackId}.glb`
      const glbHead = await fetch(glbUrl, { method: 'HEAD' })
      const glbContentType = glbHead.headers.get('content-type') ?? ''
      const glbExists =
        glbHead.ok &&
        (glbContentType.includes('octet-stream') ||
          glbContentType.includes('gltf') ||
          glbContentType.includes('binary'))
      if (glbExists) {
        track = await loadTrackFromGlb(glbUrl, {
          id: trackId,
          name: trackId,
          lapsToFinish: 3,
        })
        if (!editMode) {
          const env = await loadGlbTrackVisuals(glbUrl)
          scene.add(env.scene)
          attachTrackColliders(env.scene, phys)
        }
      } else if (editMode) {
        track = emptyDraftTrack(trackId)
      } else {
        throw new Error(`track: no JSON at ${jsonUrl} and no GLB at ${glbUrl}`)
      }
    }
  }

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
    function editFrame() {
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

  const startPos = track.start.position

  // In replay mode the bike roster comes straight from the recording: one
  // bike per slot, spawned with the recorded variant's stats/colors so the
  // visuals match the original race. They're not Racer-tagged (no race
  // tracking during playback) and not AI-tagged (no AI control during
  // playback) — they're just kinematic ghosts whose transforms are written
  // each frame from the interpolated replay data.
  const aiEids: number[] = []
  const replayBikeEids: number[] = []
  let playerEid: number
  if (activeReplay) {
    for (let i = 0; i < activeReplay.bikes.length; i++) {
      const b = activeReplay.bikes[i]!
      const variant = resolveBikeVariant(b.variantId)
      const eid = createBike(sim, phys, {
        position: startPos,
        yaw: track.start.yaw,
        isPlayer: i === 0,
        asRacer: false,
        stats: {
          ...variant.stats,
          bodyColor: variant.bodyColor,
          variantId: variant.id,
        },
      })
      replayBikeEids.push(eid)
    }
    playerEid = replayBikeEids[0]!
  } else {
    playerEid = createBike(sim, phys, {
      position: startPos,
      yaw: track.start.yaw,
      isPlayer: true,
      asRacer: true,
      stats: {
        ...playerVariant.stats,
        bodyColor: playerVariant.bodyColor,
        variantId: playerVariant.id,
      },
    })

    // Spread AI bikes across a 4-wide grid behind the player on the right
    // straight, each with a different perpendicular race-line offset. The
    // straight is 28m wide (gate halfWidth × 2), so we spread offsets across
    // ±6m. Bikes spawn at the same lateral offset so they hold their lane.
    const aiSlots = [
      { dx: -6, dz: -5, off: -6 },
      { dx: -2, dz: -10, off: -2 },
      { dx: 2, dz: -10, off: 2 },
      { dx: 6, dz: -5, off: 6 },
    ]
    for (let i = 0; i < Math.min(NUM_AI, aiSlots.length); i++) {
      const slot = aiSlots[i]!
      const aiEid = createBike(sim, phys, {
        position: { x: startPos.x + slot.dx, y: startPos.y, z: startPos.z + slot.dz },
        yaw: track.start.yaw,
        asRacer: true,
        ai: { splineId: 'main', lineOffset: slot.off },
      })
      aiEids.push(aiEid)
    }
  }

  // Mark the initial "next" gate (cp 0). After the first frame the race
  // callback takes over.
  trackVisuals.setCheckpointState(0, 'next')

  const raceTick = createRaceSystem(track, {
    onCheckpoint: (eid, justCrossed) => {
      if (eid !== playerEid) return
      const r = RacerStore.get(eid)
      if (!r) return
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

  // Keys: R to restart after finish; T (or F1) to toggle auto-play;
  // F2 to toggle collision debug overlay; Backspace to respawn.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && finishShown) {
      window.location.reload()
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

  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 1 / 15)
    last = now

    state.intent = state.intentOverride ?? readPlayerIntent(dt)

    physAccum += dt
    while (physAccum >= phys.fixedDt) {
      // Wave-field clock advances at `fixedDt × waterDebugTimeScale` so the
      // water debug menu can speed up / slow down / freeze the waves
      // independently of the physics step. At the default 1× this is the
      // original behavior.
      advanceWaveField(waveField, phys.fixedDt * waterMesh.debug.getTimeScale())
      // Refresh wake sources from the current bike rigid bodies BEFORE
      // hoverSystem reads the wave field for buoyancy. This is what makes
      // the lead bike's wake felt by trailing riders (and visible in the
      // GPU shader, which reads the same impact data via waterMesh.tick).
      wakeUpdateSystem(sim, phys, waveField)
      // Player intent first; AI runs after and overwrites for entities tagged
      // AITag (which now includes the player while auto-play is on). After
      // ai-control writes the racing-line intent, ai-combat decides whether
      // to flip fire=true based on the AI's held pickup. Stun runs LAST in
      // the intent chain so spun-out bikes can't drive through their own
      // hit reaction.
      if (!autoPlay) applyPlayerIntent(sim, state.intent)
      aiControlSystem(sim, phys, track)
      aiCombatSystem(sim, phys)
      stunOverrideSystem(sim)
      hoverSystem(sim, phys, waveField)
      phys.step()
      syncFromPhysics(sim, phys)
      raceTick(sim, phys, phys.fixedDt)
      pickupSystem(sim, phys, phys.fixedDt)
      pickupUseSystem(sim, phys)
      mineSystem(sim, phys, phys.fixedDt)
      missileSystem(sim, phys, phys.fixedDt)
      explosionTickSystem(sim, phys.fixedDt)
      boostTickSystem(sim, phys.fixedDt)
      shieldTickSystem(sim, phys.fixedDt)
      stunTickSystem(sim, phys.fixedDt)
      rubberBandSystem(sim, track)
      physAccum -= phys.fixedDt
    }

    // Replay capture. The recorder rate-limits internally (default 30Hz)
    // so calling every render frame is safe — we just feed it the current
    // elapsed time + flat transforms and it decides whether to push a
    // frame. Capture stops once the finish UI shows so the recording ends
    // cleanly at the moment of crossing the line.
    if (recorder && !finishShown) {
      const elapsed = (now - recorderStart) / 1000
      const slots = [playerEid, ...aiEids]
      const flat: number[] = []
      for (const eid of slots) {
        const handle = RBHandleStore.get(eid)
        const rb = handle ? phys.world.getRigidBody(handle.handle) : null
        if (!rb) {
          flat.push(0, 0, 0, 0, 0, 0, 1)
          continue
        }
        const t = rb.translation()
        const q = rb.rotation()
        flat.push(t.x, t.y, t.z, q.x, q.y, q.z, q.w)
      }
      recorder.sample(elapsed, flat)
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
    // Day-night cycle: animate the directional sun light around the scene
    // and keep the water shader's sun-direction uniform in sync. The sun
    // makes a full 360° azimuth rotation while bobbing in elevation
    // between ~30°..70° over SUN_CYCLE_SECONDS, so over a 1–3 lap race
    // the sun-glow on backlit waves visibly drifts across the scene.
    //
    // The sun light is positioned along the computed direction *from the
    // player*, with `sun.target` set to the player. This keeps the shadow
    // camera's orthographic frustum (configured in createScene) centered
    // on the bike so shadows stay crisp wherever the track wanders, while
    // still feeding the water shader the right directional vector.
    //
    // Driven by the deterministic wave-field clock (`waveField.time`) so
    // a replay or rollback would put the sun back where it was.
    {
      const SUN_CYCLE_SECONDS = 360 // 6 minutes per full rotation
      const SUN_DISTANCE = 220 // far enough to act directional; > shadow.camera.far/2 OK
      const t = waveField.time
      const phase = (t / SUN_CYCLE_SECONDS) * Math.PI * 2
      // Elevation: 30°..70°, full rise+fall once per cycle. Phase offset
      // 0.7×phase staggers it from the azimuth so sun doesn't trace a
      // simple circle — adds variety to the lighting arc.
      const elev = (50 + 20 * Math.sin(phase * 0.7)) * (Math.PI / 180)
      // Azimuth: starts at 45° (matching the original (50, 70, 70) sun
      // position) and rotates a full 360° per cycle.
      const azimuth = (45 * Math.PI) / 180 + phase
      const cosE = Math.cos(elev)
      const dirX = cosE * Math.cos(azimuth)
      const dirY = Math.sin(elev)
      const dirZ = cosE * Math.sin(azimuth)
      const followX = state.playerSnapshot?.position.x ?? 0
      const followZ = state.playerSnapshot?.position.z ?? 0
      sun.position.set(
        followX + dirX * SUN_DISTANCE,
        dirY * SUN_DISTANCE,
        followZ + dirZ * SUN_DISTANCE,
      )
      sun.target.position.set(followX, 0, followZ)
      sun.target.updateMatrixWorld()
      waterMesh.setSunDirection(dirX, dirY, dirZ)
    }
    bikeRender()
    pickupRender(dt)
    combatRender(dt)
    fxTick(dt)
    physicsDebug.tick()

    // Direction arrow points the player to the next checkpoint.
    const racerNow = RacerStore.get(playerEid)
    if (racerNow && !racerNow.finished) {
      const nextCp = track.checkpoints[racerNow.nextCheckpoint]
      if (nextCp) {
        const targetVec = new THREE.Vector3(nextCp.position.x, nextCp.position.y, nextCp.position.z)
        dirArrow.tick(tmpPos, targetVec, dt)
      } else {
        dirArrow.tick(tmpPos, null, dt)
      }
    } else {
      dirArrow.tick(tmpPos, null, dt)
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
        const standings = computeStandings(sim, track)
        const me = standings.find((s) => s.eid === playerEid)
        const status = rs.finished
          ? 'FINISHED'
          : `cp ${rs.nextCheckpoint + 1}/${rs.totalCheckpoints}`
        const auto = autoPlay ? ' [AUTO]' : ''
        raceEl.textContent = `lap ${rs.lap}/${rs.lapsToFinish} | pos ${me?.position ?? '?'}/${standings.length} | ${status} | ${rs.raceTime.toFixed(1)}s${auto}`

        if (rs.finished && !finishShown && finishEl) {
          finishShown = true
          finishEl.classList.add('show')
          if (finishPos && me) finishPos.textContent = ordinal(me.position)
          if (finishTime) finishTime.textContent = formatTime(rs.raceTime)
          if (finishTitle) finishTitle.textContent = me?.position === 1 ? 'WINNER' : 'FINISH'
          if (finishSub) finishSub.textContent = `${track.name} · ${playerVariant.name}`
          if (finishBest) {
            const parts: string[] = []
            if (bestLapThisRace !== null) {
              parts.push(`Best lap: <b>${formatLap(bestLapThisRace)}</b>`)
            }
            if (bestLapAllTime !== null) {
              parts.push(`All-time: <b>${formatLap(bestLapAllTime)}</b>`)
            }
            finishBest.innerHTML = parts.length ? `<br />${parts.join(' · ')}` : ''
          }
          // Wire the Save Replay button. The recorder has been capturing
          // throughout the race; finalize it now and offer a download.
          // Hidden if no recorder (e.g., this branch was reached via
          // replay-playback, which can't happen because we don't drive the
          // race finish event in that path — but guard anyway).
          const saveBtn = document.getElementById('finish-save-replay') as HTMLButtonElement | null
          if (saveBtn && recorder) {
            const replay = recorder.finalize({
              finishPosition: me?.position ?? null,
              finishTime: rs.raceTime,
              bestLap: bestLapThisRace,
            })
            saveBtn.style.display = 'inline-block'
            saveBtn.disabled = false
            saveBtn.textContent = 'SAVE REPLAY'
            saveBtn.onclick = () => {
              downloadReplay(replay)
              saveBtn.textContent = 'SAVED ✓'
              saveBtn.disabled = true
            }
          }
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
    // would just show stale zeros; the FPS row is fine to keep.
    if (raceEl) raceEl.style.display = 'none'
    if (inputEl) inputEl.style.display = 'none'
    if (audioEl) audioEl.style.display = 'none'
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

      // Day-night cycle, same as normal frame — sun follows the focal bike.
      {
        const SUN_CYCLE_SECONDS = 360
        const SUN_DISTANCE = 220
        const t = waveField.time
        const phase = (t / SUN_CYCLE_SECONDS) * Math.PI * 2
        const elev = (50 + 20 * Math.sin(phase * 0.7)) * (Math.PI / 180)
        const azimuth = (45 * Math.PI) / 180 + phase
        const cosE = Math.cos(elev)
        const dirX = cosE * Math.cos(azimuth)
        const dirY = Math.sin(elev)
        const dirZ = cosE * Math.sin(azimuth)
        sun.position.set(
          focalPos.x + dirX * SUN_DISTANCE,
          dirY * SUN_DISTANCE,
          focalPos.z + dirZ * SUN_DISTANCE,
        )
        sun.target.position.set(focalPos.x, 0, focalPos.z)
        sun.target.updateMatrixWorld()
        waterMesh.setSunDirection(dirX, dirY, dirZ)
      }
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

/**
 * Trigger a browser download of a serialized replay file. Filename
 * embeds the track id + a short timestamp so multiple saves from the
 * same browser don't overwrite each other.
 */
function downloadReplay(replay: ReplayFile): void {
  const text = serializeReplay(replay)
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const stamp = new Date(replay.meta.recordedAt).toISOString().replace(/[:.]/g, '-')
  const a = document.createElement('a')
  a.href = url
  a.download = `hoverbike-${replay.meta.trackId}-${stamp}.replay`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Empty starter track used when the editor is opened on an id that
 * has neither a JSON nor a GLB. The user authors the layout from
 * scratch and the first Save materialises `public/tracks/<id>.json`.
 *
 * Two seed checkpoints + two seed spline anchors so the editor's
 * loader (which validates non-empty arrays) and the
 * runtime-derived spline-bound gates have something to work with.
 */
function emptyDraftTrack(id: string): import('./game/tracks/types').Track {
  return {
    id,
    name: id,
    lapsToFinish: 3,
    start: { position: { x: 0, y: 0.5, z: 0 }, yaw: 0 },
    checkpoints: [
      {
        index: 0,
        position: { x: 0, y: 1.5, z: 20 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 8,
        height: 4,
      },
      {
        index: 1,
        position: { x: 0, y: 1.5, z: -20 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 8,
        height: 4,
      },
    ],
    aiSplines: [
      {
        id: 'main',
        points: [
          { x: 0, y: 0.5, z: 20 },
          { x: 20, y: 0.5, z: 0 },
          { x: 0, y: 0.5, z: -20 },
          { x: -20, y: 0.5, z: 0 },
        ],
        anchors: [
          { x: 0, y: 0.5, z: 20 },
          { x: 20, y: 0.5, z: 0 },
          { x: 0, y: 0.5, z: -20 },
          { x: -20, y: 0.5, z: 0 },
        ],
      },
    ],
    pickupSpawns: [],
    boostPads: [],
    props: [],
    surfaces: [],
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return m > 0 ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${s.toFixed(2)}s`
}

boot().catch((err) => {
  console.error('[boot] fatal', err)
  const el = document.getElementById('hud-backend')
  if (el) el.textContent = `boot failed: ${String(err)}`
})
