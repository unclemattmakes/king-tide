import { addComponent, hasComponent, removeComponent } from 'bitecs'
import { installControls } from './boot/controls'
import { startEditMode } from './boot/edit-mode'
import { startGameLoop } from './boot/game-loop'
import { hideLoadingScreen, setLoadingMessage } from './boot/loading-screen'
import { setupMultiplayer } from './boot/multiplayer'
import { startReplayMode } from './boot/replay-mode'
import { spawnBikes } from './boot/spawn-bikes'
import { loadTrackForBoot } from './boot/track-loader'
import { runEarlyModeDispatch } from './boot/url-modes'
import { installDebugApi, type PlayerSnapshot, type RaceSnapshot } from './debug'
import { createAudioEngine } from './engine/audio/audio'
import { loadDevSettings } from './engine/dev-settings'
import { emptyIntent, type Intent, installInput } from './engine/input'
import { installCameraLookInput } from './engine/input/camera-look'
import { bindLazyMenuButton } from './engine/lazy-menu'
import { isHostFor } from './engine/net/host-election'
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
import { createWaterMesh } from './engine/render/water'
import { parseReplay, type ReplayBike, type ReplayFile } from './engine/replay/format'
import { createReplayRecorder, type ReplayRecorder } from './engine/replay/recorder'
import { getBestLap, recordLapTime } from './engine/save-state'
import { createSimWorld } from './engine/sim/ecs/world'
import { createPhysicsWorld } from './engine/sim/physics/rapier'
import { createWaveField, defaultWaves } from './engine/sim/water/wave-field'
import { applyStoredWaterTuning } from './engine/water-debug-storage'
import { loadBike } from './game/assets/bike-loader'
import { loadManifest } from './game/assets/manifest'
import { type LoadedProp, loadProp } from './game/assets/prop-loader'
import { resolveBikeVariant } from './game/bikes/variants'
import { AIController, AIControllerStore, AITag, defaultAIController } from './game/components/ai'
import { RacerStore } from './game/components/race'
import { createPickupSpawn } from './game/entities/pickup-spawn'
import { createPropColliders } from './game/entities/props'
import { createRaceSystem } from './game/systems/race'

/**
 * Boot sequence — phases, in order:
 *
 *   1. Mode dispatch (`src/boot/url-modes.ts`). `?viewer=<id>` short-
 *      circuits into the stand-alone bike viewer; the cold-boot menu
 *      and multiplayer lobby surfaces also live there. Anything that
 *      isn't one of those falls through to the live-race boot below.
 *      `?replay=session` parses the pending replay from sessionStorage
 *      so the rest of boot can branch on `activeReplay`.
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
 *   5. Entity spawn (`src/boot/spawn-bikes.ts`). Player bike first
 *      (deterministic eid for the replay recorder's slot 0), then AI
 *      bikes, pickups, mines/missiles handled by the combat system.
 *   6. Render systems. Bike, pickup, combat, FX. The fx system needs
 *      `phys` for wake/dust ground sampling; combat/pickup just need the
 *      sim world.
 *   7. Multiplayer wiring (`src/boot/multiplayer.ts`). Connects to the
 *      relay, arms host-role flips and snapshot send/receive. No-op in
 *      single-player.
 *   8. Game loop. Either `startGameLoop` (live race), `startReplayMode`
 *      (`?replay=session`) or `startEditMode` (`?edit=1`).
 *
 * Pure helpers (downloadReplay, emptyDraftTrack, ordinal, formatTime)
 * live in `src/boot/utils.ts`.
 */
async function boot() {
  const appEl = document.getElementById('app')
  if (!appEl) throw new Error('#app not found')

  // Phase 1 — URL-param dispatch: viewer / cold-boot menu / mp lobby.
  // Each one navigates away on completion so the caller returns.
  const dispatch = await runEarlyModeDispatch(appEl)
  if (dispatch === 'handled') return

  // HUD element handles. May be missing in stripped-down test pages —
  // every consumer null-checks.
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

  // Phase 2 — core subsystems.
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

  // Phase 3 — URL params + persisted prefs.
  const params = new URLSearchParams(window.location.search)

  // M10.4 — optional multiplayer relay. `?room=<id>` opts the client into
  // a PartyKit room; otherwise the game runs single-player as before.
  // Host default flips on build mode: dev builds (vite dev) target
  // `localhost:1999` so `pnpm party:dev` works out of the box; production
  // builds target the deployed PartyKit endpoint. Pass `?host=<h>` to
  // override either way (e.g. point a prod build at localhost for testing).
  const PROD_PARTY_HOST = 'hoverbike.occ-matt.partykit.dev'
  const roomId = params.get('room')
  const netHost = params.get('host') ?? (import.meta.env.DEV ? 'localhost:1999' : PROD_PARTY_HOST)

  // M10.2 determinism harness. When ?determinism=1 is set, the fixed-step
  // sim loop is gated off so the Playwright probe can drive `simulateStep`
  // directly via __hover.determinism.run(). Render still runs so the page
  // is alive; only the sim is frozen.
  const determinismMode = params.get('determinism') === '1'

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
  const editMode = params.get('edit') === '1'
  const rawTrack = params.get('track')
  const trackId = activeReplay
    ? activeReplay.meta.trackId
    : rawTrack && rawTrack.length > 0
      ? rawTrack
      : editMode
        ? 'lagoon-edit'
        : 'lagoon'

  // Bike variant. URL `?bike=cruiser|racer|stunt` picks the player's
  // archetype; AI bikes always use the racer baseline for now. Variant
  // controls both stats and body color via BikeStats.bodyColor. Replay
  // mode pulls the player's variant from the recording's slot 0.
  const playerVariant = activeReplay
    ? resolveBikeVariant(activeReplay.bikes[0]?.variantId ?? null)
    : resolveBikeVariant(params.get('bike'))

  // Phase 4 — asset manifest fetch. Used downstream for prop GLB lookups
  // + (via the cold-boot menu) the track picker.
  setLoadingMessage('Loading manifest…')
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
  const lapState = {
    lapStartRaceTime: 0,
    bestLapThisRace: null as number | null,
    lastLapTime: null as number | null,
    bestLapAllTime: getBestLap({ trackId, bikeId: playerVariant.id }),
  }

  // Track terrain + data. See `src/boot/track-loader.ts` — handles
  // procedural tracks, JSON tracks, GLB tracks, and the empty-draft
  // fallback for editor on a fresh id.
  setLoadingMessage(`Loading track${trackId ? ` · ${trackId}` : '…'}`)
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
    startEditMode({
      scene,
      camera,
      renderer,
      appEl,
      track,
      propAssets: manifest.props,
      sky,
      waterMesh,
      waveField,
      backend,
      backendEl,
    })
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
    setLoadingMessage(`Loading props · ${assetIds.size}`)
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
    createPickupSpawn(sim, track.pickupSpawns[i] as (typeof track.pickupSpawns)[number], i)
  }

  // Load bike GLBs in parallel: the player's chosen variant plus the
  // racer baseline (used by AI bikes, and as the fallback if the
  // player's variant fetch fails). The cache in bike-loader dedupes
  // when the player's variant already is the racer.
  setLoadingMessage('Loading bikes…')
  const [playerBikeGlb, racerBikeGlb] = await Promise.all([
    loadBike(`/assets/bikes/${playerVariant.id}.glb`),
    loadBike('/assets/bikes/racer.glb'),
  ])

  // Phase 5 — entity spawn. See `src/boot/spawn-bikes.ts`. Order is
  // deterministic (player slot 0 then AI 1..N, or replay-recording
  // order) so the recorder / player downstream see consistent slot
  // numbering.
  const { playerEid, aiEids, replayBikeEids } = spawnBikes({
    sim,
    phys,
    track,
    playerVariant,
    activeReplay,
  })

  // Phase 7 — multiplayer wiring (no-op in single-player). Owns the
  // remote-peer bike spawn/despawn, host-role flips, snapshot
  // send/receive. Connected before the race HUD is built so the
  // initial chip render reflects the actual room state.
  const multiplayer = setupMultiplayer({
    sim,
    phys,
    track,
    playerEid,
    aiEids,
    roomId,
    netHost,
    roomEl,
  })

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
        lapState.lapStartRaceTime = r.raceTime
        audio.gateCleared()
      } else if (justCrossed === 0 && r.checkpointsCrossed > 1) {
        audio.lapCompleted()
        const lapTime = r.raceTime - lapState.lapStartRaceTime
        lapState.lastLapTime = lapTime
        lapState.lapStartRaceTime = r.raceTime
        if (lapState.bestLapThisRace === null || lapTime < lapState.bestLapThisRace) {
          lapState.bestLapThisRace = lapTime
        }
        if (recordLapTime({ trackId, bikeId: playerVariant.id }, lapTime)) {
          lapState.bestLapAllTime = lapTime
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

  // Phase 6 — render systems.
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

  /** Attach/detach AITag on the player. When attached, ai-control-system
   *  drives the player's ControlIntent (overwriting applyPlayerIntent's write
   *  because aiControlSystem runs after it). */
  function applyAutoPlayTag(on: boolean): void {
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

  // HUD pill showing the collision debug state. Hidden when off.
  const collisionPill = document.getElementById('hud-collision')
  function updateCollisionPill(): void {
    if (!collisionPill) return
    if (physicsDebug.isEnabled()) {
      collisionPill.textContent = 'collision: ON (F2)'
      collisionPill.style.display = 'inline-block'
    } else {
      collisionPill.style.display = 'none'
    }
  }
  updateCollisionPill()

  // Pause menu, finish-screen actions, and keyboard bindings. See
  // `src/boot/controls.ts` — returns a small handle the game loop polls
  // for pause state + mutates when the finish screen shows.
  const controls = installControls({
    phys,
    track,
    trackId,
    playerEid,
    playerVariantId: playerVariant.id,
    roomId,
    raceHud,
    audio,
    physicsDebug,
    onSetAutoPlay: applyAutoPlayTag,
    onCollisionDebugChanged: updateCollisionPill,
  })

  installDebugApi(state, {
    sim: () => sim,
    phys: () => phys,
    track: () => track,
    playerEid: () => playerEid,
    toggleAutoPlay: () => {
      controls.setAutoPlay(!controls.isAutoPlay())
      return controls.isAutoPlay()
    },
    isAutoPlay: () => controls.isAutoPlay(),
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
      const room = multiplayer.room
      if (!room) return null
      return {
        ready: () => room.ready,
        peerId: () => room.peerId,
        remotePeers: () => room.remotePeers,
        isHost: () => (room.ready ? isHostFor(room.peerId, room.remotePeers) : true),
        recentRemoteFrames: () =>
          // Shallow-copy so devtools probes can't mutate the live buffer.
          multiplayer.recentRemoteFrames.map((f) => ({
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

  // Phase 8 — game loop. Replay playback gets a separate frame that
  // interpolates recorded poses; the live race uses the fixed-step sim +
  // render pipeline in `startGameLoop`.
  if (activeReplay) {
    startReplayMode({
      activeReplay,
      replayBikeEids,
      appEl,
      scene,
      camera,
      renderer,
      sky,
      waveField,
      waterMesh,
      bikeRender,
      pickupRender,
      combatRender,
      fxTick,
      physicsDebug,
      state,
      hud: { fpsEl, backendEl, audioEl, inputEl, raceEl },
      backend,
      onReady: () => {
        hideLoadingScreen()
      },
    })
    return
  }

  state.ready = true
  hideLoadingScreen()
  startGameLoop({
    state,
    sim,
    phys,
    scene,
    camera,
    renderer,
    audio,
    chase,
    waveField,
    waterMesh,
    sky,
    trackVisuals,
    raceHud,
    raceTick,
    dirArrow,
    physicsDebug,
    bikeRender,
    pickupRender,
    combatRender,
    fxTick,
    track,
    trackId,
    manifest,
    playerEid,
    aiEids,
    playerVariant,
    multiplayer,
    roomId,
    recorder,
    recorderStart,
    lapState,
    control: {
      isAutoPlay: () => controls.isAutoPlay(),
      isPausedForMenu: () => controls.isPausedForMenu(),
      isDeterminismPaused: () => determinismMode,
    },
    hud: {
      fpsEl,
      backendEl,
      inputEl,
      raceEl,
      audioEl,
      finishEl,
      finishTitle,
      finishSub,
      finishPos,
      finishTime,
      finishBest,
    },
    onFinish: () => {
      controls.setFinishShown(true)
    },
  })
}

boot().catch((err) => {
  console.error('[boot] fatal', err)
  const el = document.getElementById('hud-backend')
  if (el) el.textContent = `boot failed: ${String(err)}`
  setLoadingMessage(`Boot failed · ${String(err)}`)
})
