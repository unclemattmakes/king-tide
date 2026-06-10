import { addComponent, hasComponent, query, removeComponent } from 'bitecs'
import { DEFAULT_BENCH_TRACK, installBenchmark } from './boot/benchmark-mode'
import { bootMark, bootReport, bootStat } from './boot/boot-trace'
import { installControls } from './boot/controls'
import { startEditMode } from './boot/edit-mode'
import { startGameLoop } from './boot/game-loop'
import { hideLoadingScreen, setLoadingMessage } from './boot/loading-screen'
import { setupMultiplayer } from './boot/multiplayer'
import {
  collectVinylScenery,
  deferSceneryWarm,
  type ProgressiveWarm,
} from './boot/progressive-warm'
import { startReplayMode } from './boot/replay-mode'
import { spawnBikes } from './boot/spawn-bikes'
import { loadTrackForBoot } from './boot/track-loader'
import { runEarlyModeDispatch } from './boot/url-modes'
import { installDebugApi, type PlayerSnapshot, type RaceSnapshot } from './debug'
import { assetUrl } from './engine/asset-url'
import { applyTrackAudio } from './engine/audio/audio-service'
import { installSoundtrackRadio } from './engine/audio/soundtrack-radio'
import { getCupProgressFor } from './engine/cup-progress'
import { setWindTrailsController } from './engine/dev/dev-runtime'
import { loadDevSettings } from './engine/dev-settings'
import { emptyIntent, type Intent, installInput } from './engine/input'
import { installCameraLookInput } from './engine/input/camera-look'
import { bindLazyMenuButton } from './engine/lazy-menu'
import { loadPlayerSettings, playerSettings, WAVE_SPRAY_SCALAR } from './engine/player-settings'
import { installConsoleTrap } from './engine/qa/console-trap'
import { createAnimatedPropsSystem } from './engine/render/animated-props'
import { createAntiGravDebugRenderer } from './engine/render/anti-grav-debug'
import { createBridgeSupports } from './engine/render/bridge-supports'
import { createChaseCamera } from './engine/render/camera'
import { applyCloudShadowsToScene, buildCloudShadowMultiplier } from './engine/render/cloud-shadows'
import { createCombatRenderSystem } from './engine/render/combat-render'
import { type ContactSplashDriver, createContactSplashDriver } from './engine/render/contact-splash'
import { createDirectionArrow } from './engine/render/direction-arrow'
import { createEngineTrailSystem } from './engine/render/engine-trail'
import { createFxSystem } from './engine/render/fx'
import { loadGateProp } from './engine/render/gate-prop'
import { createHorizonRing } from './engine/render/horizon-ring'
import { createHoverDebugRenderer } from './engine/render/hover-debug'
import { createLandmarkAnimation } from './engine/render/landmark-animation'
import { createLapWeatherSystem } from './engine/render/lap-weather'
import { vinylMaterialsBuilt } from './engine/render/painterly-vinyl-material'
import {
  createParticleSystem,
  loadParticleAtlas,
  type ParticleSystem,
} from './engine/render/particle-system'
import type { RenderInfoLite } from './engine/render/perf-hud'
import { createPhysicsDebugRenderer } from './engine/render/physics-debug'
import { createPickupRenderSystem } from './engine/render/pickup-render'
import { createPropsMesh } from './engine/render/props-mesh'
import { createRaceHud } from './engine/render/race-hud'
import { createRaceIntro, type RaceIntro } from './engine/render/race-intro'
import {
  createRaceIntroUi,
  type RaceIntroUi,
  type RaceIntroUiRacer,
} from './engine/render/race-intro-ui'
import { createBikeRenderSystem } from './engine/render/render-systems'
import { createRenderer } from './engine/render/renderer'
import {
  applyPixelRatio,
  getActivePostPipeline,
  setRenderer,
} from './engine/render/renderer-service'
import { createRiderMannequinSystem } from './engine/render/rider-mannequin'
import { createRiderRenderSystem } from './engine/render/rider-systems'
import { createScene } from './engine/render/scene'
import { beaufortToAmplitudeScale, createSkySystem } from './engine/render/sky'
import { setSkySystem } from './engine/render/sky-service'
import { createStartLights } from './engine/render/start-lights'
import { createSurgeSprayDriver, type SurgeSprayDriver } from './engine/render/surge-spray'
import { sampleTerrainHeightAtXZ } from './engine/render/terrain-heightmap'
import { createTrackVisuals } from './engine/render/track-mesh'
import { createWaterMesh, WAVE_BEARING_DEFAULT } from './engine/render/water'
import {
  type ContactScanNode,
  collectWaterContacts,
  gatePostWaterContacts,
  type WaterContact,
} from './engine/render/water-contacts'
import { logWaterCoverage, reportWaterCoverage } from './engine/render/water-coverage'
import { createWaterTransitionMarkers } from './engine/render/water-debug-markers'
import { applyWaveSprayIntensity, setWaterMesh } from './engine/render/water-service'
import { breakingFoam, createWaveCrestSprayDriver } from './engine/render/wave-crest-spray'
import { createWaveRiderRenderSystem } from './engine/render/wave-rider-render'
import { createWindTrailsSystem } from './engine/render/wind-trails'
import { sliceBestLap } from './engine/replay/best-lap-slice'
import { parseReplay, type ReplayBike, type ReplayFile } from './engine/replay/format'
import { getGhost, getGhostBestLap, setGhost } from './engine/replay/ghost-state'
import { createReplayRecorder, type ReplayRecorder } from './engine/replay/recorder'
import { getBestLap, recordLapTime } from './engine/save-state'
import { createSimWorld } from './engine/sim/ecs/world'
import { createPhysicsWorld } from './engine/sim/physics/rapier'
import {
  generateSpectrumWaves,
  parseSpectrumParam,
  type SpectrumSpec,
} from './engine/sim/water/spectrum'
import {
  createWaveField,
  defaultWaves,
  sampleSurface,
  setShoreField,
  setWaveStamps,
  setWaveZones,
} from './engine/sim/water/wave-field'
import { applyDeckProfile, detectSteamDeck } from './engine/steam-deck'
import { applyStoredWaterTuning } from './engine/water-debug-storage'
import { type LoadedBike, loadBike } from './game/assets/bike-loader'
import { loadManifest } from './game/assets/manifest'
import { type LoadedProp, loadProp } from './game/assets/prop-loader'
import { aiCallSign } from './game/bikes/callsigns'
import { BIKE_VARIANTS, resolveBikeVariant, variantForAiSlot } from './game/bikes/variants'
import { AIController, AIControllerStore, AITag, defaultAIController } from './game/components/ai'
import { RacerStore } from './game/components/race'
import { WaveRiderStore, WaveRiderTag } from './game/components/wave-rider'
import { createPickupSpawn } from './game/entities/pickup-spawn'
import { createPropColliders } from './game/entities/props'
import { createGhostRunner, type GhostRunner } from './game/systems/ghost-runner'
import { createRaceSystem } from './game/systems/race'
import { setWaveFeelFlags } from './game/systems/wave-feel-flags'
import { createWaveRiderSystem, type WaveRiderSystem } from './game/systems/wave-rider'
import { deriveFallbackTheme, getTrackTheme } from './game/tracks/theme-catalog'

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
/**
 * Gate the dev-only chrome (top-left HUD chips, DEV SETTINGS / WATER
 * toggles, debug overlays) behind a body class. The class is set when:
 *   - Vite is in dev mode (`import.meta.env.DEV` — i.e. `pnpm dev`,
 *     Playwright runs, hot reloads), so the chips show locally and in
 *     e2e, OR
 *   - The URL carries `?dev=1`, so deployed builds can be opened with
 *     dev chrome for live debugging without a rebuild.
 *
 * Runs at module load so the menu surface (which paints before
 * `boot()`'s await chain resolves) sees the class.
 */
function applyDevBuildClass(): void {
  try {
    const isDev =
      Boolean(import.meta.env?.DEV) || new URLSearchParams(window.location.search).has('dev')
    document.body.classList.toggle('dev-build', isDev)
  } catch {
    // Defensive — if URLSearchParams or body somehow isn't available,
    // err toward no dev chrome (the safer prod default).
  }
}
applyDevBuildClass()

async function boot() {
  // Install the QA console trap before anything else — viewer / edit /
  // menu shells all benefit from having errors captured into the ring.
  // Idempotent so HMR re-runs don't accumulate proxy layers.
  installConsoleTrap()
  bootMark('start')

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
  loadPlayerSettings()
  installInput()
  installCameraLookInput()

  // Phase 1b — Steam Deck detection. We probe early so the profile's
  // framerate / fullscreen defaults can land in `playerSettings` before
  // the game loop reads them. Detection is best-effort + false-positive-
  // prone (any 1280×800 window trips the viewport signal); the profile's
  // setter logic in `steam-deck.ts → applyDeckProfile()` is responsible
  // for respecting any user override the player already saved.
  const deck = detectSteamDeck()
  if (deck.isLikelyDeck) {
    applyDeckProfile()
    // eslint-disable-next-line no-console
    console.info(`[boot] Steam Deck detected via [${deck.signals.join(', ')}]`)
  }

  // Audio: stand up the soundtrack radio (engine + playlist + credit toast
  // + the user-gesture unlock / visibility-resume listeners) BEFORE the
  // heavy renderer + track load below. The race page is a fresh document
  // (the menu navigates here with a reload), so its AudioContext starts
  // suspended and needs a new gesture to unlock; attaching the listeners
  // now means the player's first click / movement key during the loading
  // screen unlocks audio — rather than being missed because boot() hadn't
  // reached the audio setup yet. `playerSettings` is loaded + the Deck
  // profile applied above, so onUnlock reads the right fullscreen pref.
  //
  // Step 8 — opportunistic fullscreen-on-first-gesture. The Steam Deck
  // profile flips `fullscreenPreferred` on so Gaming Mode launches don't
  // strand the player in a windowed view. We piggyback on the audio-unlock
  // gesture because both need a real user gesture by browser policy.
  // Failures (already fullscreen, blocked by sandboxing) are swallowed.
  const audio = installSoundtrackRadio({
    onUnlock: () => {
      if (playerSettings.fullscreenPreferred && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {
          /* user dismissed or browser blocked — non-fatal */
        })
      }
    },
  })

  // Phase 2 — core subsystems.
  const { renderer, backend, gpuTimestampsTracked } = await createRenderer(appEl)
  bootMark('renderer')
  setRenderer(renderer)
  // Apply the persisted pixel-ratio now that the renderer is alive.
  // `createRenderer` already calls `setPixelRatio(min(devicePixelRatio, 2))`,
  // so this is a no-op when the player kept the default; if they dropped
  // it for perf, the lower value takes effect on the first frame.
  applyPixelRatio(playerSettings.pixelRatio)
  const { scene, camera, sun, hemi } = createScene()
  // Dev-only scene handle for inspection (the draw-call census + ad-hoc debugging).
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    ;(window as unknown as { __scene?: typeof scene }).__scene = scene
  }
  const phys = await createPhysicsWorld()
  const sim = createSimWorld()
  const chase = createChaseCamera(camera)

  // Wave field — the analytic Gerstner sum CPU buoyancy and the GPU
  // vertex shader both evaluate, so bike float math tracks the rendered
  // surface to within float precision. Seeded with the hand-tuned 6-wave
  // default bank; a track that authors `water.spectrum` replaces the bank
  // after its JSON loads (below) — which is why the water MESH is built
  // after track load: the shader bakes wavelength/direction/phase/count
  // at construction and live-mirrors only amplitudes.
  const waveField = createWaveField(defaultWaves())
  bootMark('subsystems')

  // Phase 3 — URL params + persisted prefs.
  const params = new URLSearchParams(window.location.search)

  // Performance benchmark mode (`?bench=1`). Boots a normal race with the
  // full 8-bike field + auto-play forced on, runs a warmup→measure window,
  // and paints a screenshot-friendly results panel. PRODUCTION-SAFE: it must
  // run on any device by URL (iPhone Safari, Steam Deck via the Vercel
  // build), so it is NOT gated behind dev flags. Defaults: track `sandbar`,
  // bike `racer`. `?bench=1&track=the-maw` selects another dressed track.
  // The benchmark director is installed after the game loop starts (below).
  const benchMode = params.get('bench') === '1'

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

  // Cup mode — `?cup=<cupId>` signals the race is part of a championship.
  // The finish-screen branching in game-loop reads this back along with
  // the sessionStorage-backed cup-progress state. Null in single-race
  // mode; in multiplayer too (cup-mode + multiplayer is a future-work
  // bridge, not v1).
  const cupId = !roomId ? params.get('cup') : null

  // Time Trial mode (`?tt=1`). Solo race against the clock + a
  // translucent ghost of the player's previous best lap on this
  // (track, bike) combo. Sim layer skips AI bike spawn; ghost is a
  // render-only entity driven by a `ReplayPlayer` each render frame.
  // The recorder still runs so we can slice the new best lap on
  // finish.
  const timeTrialMode = params.get('tt') === '1'

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
        : benchMode
          ? DEFAULT_BENCH_TRACK
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
  bootMark('manifest')

  // Dev-settings sliders are dynamic-imported on first toggle-button
  // click so their UI code stays out of the main bundle. (The water
  // debug menu binds below, once the water mesh exists.)
  bindLazyMenuButton('devsettings-toggle', async () => {
    const { installDevSettingsMenu } = await import('./engine/dev-settings-menu')
    return installDevSettingsMenu()
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
  const { track, terrainHeightmap, horizonGeometry, environmentGlbRoot } = await loadTrackForBoot({
    trackId,
    scene,
    phys,
    editMode,
  })
  bootMark('track+env')
  bootStat('vinylAfterEnv', vinylMaterialsBuilt())

  // Per-track wave bank (P2.2 spectrum presets, water-next-research §7.1):
  // a track that authors `water.spectrum` swaps the default hand-tuned
  // 6-wave bank for a deterministic seeded JONSWAP-sampled one — per-track
  // water identity is content. This MUST land on the field before
  // `createWaterMesh` below (the shader bakes wavelength/direction/phase/
  // count at construction; only amplitudes are live-mirrored).
  // `?spectrum=<preset>[:seed[:components]]` overrides the JSON for A/B
  // tuning; `?spectrum=off` forces the default bank on a spectrum track.
  // P4.2 water-feel prototypes (dev-flagged, default OFF): `?wavepush=1`
  // adds the catch-the-wave forward push, `?draft=1` the wake-drafting
  // boost; fractional values scale the gains. Playtest-gated — see
  // wave-feel-flags.ts.
  setWaveFeelFlags({
    wavePush: params.get('wavepush') !== null ? Number(params.get('wavepush') || 1) : undefined,
    draft: params.get('draft') !== null ? Number(params.get('draft') || 1) : undefined,
  })

  const spectrumOverride = parseSpectrumParam(params.get('spectrum'))
  const activeSpectrum: SpectrumSpec | null =
    spectrumOverride === 'off' ? null : (spectrumOverride ?? track.water?.spectrum ?? null)
  if (activeSpectrum) {
    const generated = generateSpectrumWaves(activeSpectrum)
    waveField.waves = generated.waves
    // eslint-disable-next-line no-console
    console.info(
      `[water] spectrum '${activeSpectrum.preset}' seed=${activeSpectrum.seed ?? 1}: ` +
        `${generated.waves.length} components (${generated.swellCount} swell), ` +
        `λ ${generated.waves[generated.waves.length - 1]!.wavelength.toFixed(1)}–` +
        `${generated.waves[0]!.wavelength.toFixed(1)} m`,
    )
  }
  // Camera-locked water: the mesh follows the camera XZ so its dense
  // vertex region always covers the visible patch — built now, with the
  // per-track bank installed. Size 960 m (480 m half-extent, ~680 m at
  // the corners) so wave-displaced geometry reaches well into the
  // aerial-perspective haze ramp before the flat horizon skirt takes
  // over. Subdivisions default to 768 ≈ 1.25 m vertex spacing; the 4 m
  // chop resolves at ~3 verts per crest on the center plane.
  const waterMesh = createWaterMesh(waveField, { backend })
  scene.add(waterMesh.mesh)
  // Register the water mesh so the Settings overlay can live-tune the
  // crest-mist ribbon (the GPU half of the Wave-spray knob), and seed it
  // from the persisted setting now that the mesh exists.
  setWaterMesh(waterMesh)
  applyWaveSprayIntensity(playerSettings.waveSprayIntensity)
  // Apply any persisted water tuning eagerly, so the page opens in the
  // visual state the user last left; the tuning sliders themselves are
  // dynamic-imported on first click (same pattern as dev-settings above).
  applyStoredWaterTuning(waterMesh)
  bindLazyMenuButton('water-debug-toggle', async () => {
    const { installWaterDebugMenu } = await import('./engine/water-debug-menu')
    return installWaterDebugMenu(waterMesh)
  })
  // Camera-locked transition markers — tall pillars on rings at the
  // center→outer and outer→skirt boundaries. Hidden by default; the
  // water-test diagnostic track exists specifically to expose the
  // LOD-tile architecture, so they surface with it.
  const waterTransitionMarkers = createWaterTransitionMarkers()
  waterMesh.mesh.add(waterTransitionMarkers.group)
  if (trackId === 'water-test') waterTransitionMarkers.setVisible(true)
  bootMark('water')

  // Track-driven sea level: shift both the water mesh and the buoyancy
  // sampler so the surface reads as a custom Y for tracks that want
  // mountain lakes, sunken arenas, etc. `track.water.height` defaults
  // to 0 when absent, so legacy tracks behave exactly as before.
  const waterHeight = track.water?.height ?? 0
  waveField.baseY = waterHeight
  waterMesh.mesh.position.y = waterHeight
  // Track-authored swell bearing (water-next-research.md §4.5): the global
  // wave-train direction is per-track data — readability hangs on bearing
  // vs racing line vs sun, so it's graded per track, not dialed globally.
  // Absent key → WAVE_BEARING_DEFAULT, the look every shipped track was
  // graded against. This runs AFTER applyStoredWaterTuning (which no
  // longer carries a bearing), so the authored value is authoritative at
  // boot; the water debug menu's slider stays available as a live,
  // non-persisted session override.
  waterMesh.debug.setWaveBearing(track.water?.swellBearingDeg ?? WAVE_BEARING_DEFAULT)
  // Track-authored wave-set envelope (water-next-research §7.2): the sea
  // breathes between (1−depth)× and (1+depth)× of its static state every
  // periodS seconds — identically in buoyancy and the shader (the field
  // owns the params; the water mesh mirrors them per tick). Absent = off,
  // byte-identical to the pre-envelope surface.
  waveField.swellSetPeriodS = track.water?.swellSets?.periodS ?? 0
  waveField.swellSetDepth = track.water?.swellSets?.depth ?? 0
  waveField.swellSetPhase = track.water?.swellSets?.phase ?? 0
  // Per-track sea-state: Beaufort number drives a global amplitude
  // scalar on the wave field's base spectrum. Beaufort 4 ≈ 1.0× so the
  // historical (pre-knob) look is the default; calm tracks dial down
  // (South Beach lagoon ≈ 2), heavier seas dial up (Hatteras Atlantic
  // ≈ 6-7, hurricane finale ≈ 9+). Wave-zones layer on top via
  // `heightMult`, so authoring a tsunami zone in a Beaufort 2 sea works
  // as expected — the zone multiplies the (already-scaled-down) base.
  const beaufort = track.sky?.seaStateBeaufort
  if (beaufort !== undefined) {
    const scale = beaufortToAmplitudeScale(beaufort)
    for (const w of waveField.waves) w.amplitude *= scale
  }
  // Per-track wave-zone overrides — push the track's `waveZones` into
  // the wave field so `sampleHeight`/`sampleSurface` apply the per-zone
  // amplitude / frequency / surge / direction multipliers around set
  // pieces (The Maw's central swell, Aqualand's tsunami timer, etc.).
  // The water mesh mirrors this same list into its zone uniforms on its
  // next tick (it watches `field.zones` by reference), so the rendered
  // surface shows exactly the waves buoyancy feels — no separate GPU
  // install step. Empty list = pure global Gerstner, identical to
  // pre-wave-zone behaviour.
  setWaveZones(waveField, track.waveZones)
  // Authored wave stamps — the per-track signature jump waves (P3.2). The
  // water mesh mirrors `field.stamps` into its uniforms on its next tick
  // (reference watch, like zones), so the drawn pulse IS the felt one.
  setWaveStamps(waveField, track.waveStamps ?? [])
  // Terrain heightmap: when present, the water shader attenuates wave
  // displacement in shallow water (so crests stop clipping through
  // seabed/shoreline geometry) and drives depth-driven surf foam at the
  // waterline. Procedural tracks bake one from their code-generated
  // geometry; .glb tracks bake one from the loaded scene group. The
  // setter is a no-op for editor mode (terrainHeightmap === null).
  if (terrainHeightmap) waterMesh.setTerrainHeightmap(terrainHeightmap)
  // Install the baked shore field onto the CPU wave field too, so buoyancy
  // rides the same shore-aligned waves the shader renders. `setTerrainHeightmap`
  // above uploads the GPU copy; this is the sim-side half of the same data.
  setShoreField(waveField, terrainHeightmap?.shoreField ?? null)
  // Diagnose race-spline water coverage. Logs an info line when we
  // clear the v1 40 % wave-mastery target, a warning when we don't.
  // Skipped in edit mode (no heightmap, the track is mid-authoring)
  // and for tracks that haven't loaded an environment yet.
  if (!editMode) {
    const report = reportWaterCoverage(track, terrainHeightmap ?? null)
    if (report) logWaterCoverage(trackId, report)
  }

  // Optional `?tod=<seconds>` dev override of the track's frozen time-of-day,
  // so any track can be previewed (and screenshotted) at an arbitrary point in
  // the sky's 360 s cycle without editing its JSON — e.g. the water/foam art
  // pass capturing a sunset grade (~tod=285) on tracks authored at high noon.
  // Read-only at boot; no-op for an absent or non-numeric value.
  const todParam = new URLSearchParams(window.location.search).get('tod')
  const todOverride =
    todParam !== null && todParam !== '' && Number.isFinite(Number(todParam))
      ? Number(todParam)
      : null
  const skyConfig =
    todOverride !== null ? { ...(track.sky ?? {}), timeOfDay: todOverride } : track.sky

  // Sky / atmosphere system. Owns the dome mesh, fog + hemi-light palette,
  // and the PMREM env-map. The sun position and env-map are picked once
  // here (driven by `track.sky.timeOfDay`) and frozen for the whole race —
  // previously we re-baked every 4 s and that bake was a noticeable hitch.
  // Per-frame `tick()`s below only keep the shadow camera on the player
  // and re-tint scene fog toward the sun based on the camera's heading.
  const sky = createSkySystem({
    scene,
    renderer,
    camera,
    sun,
    hemi,
    water: waterMesh,
    config: skyConfig,
  })
  // Register the sky in its service singleton so the dev palette's live
  // "Time of day" control can re-bake the sky without a reload.
  setSkySystem(sky)

  // Per-lap weather progression. No-ops for tracks without `lapWeather`
  // (most of them); for Hatteras + The Maw it ramps cloudiness + Beaufort
  // wave scale + sun intensity between laps so "the storm rolls in"
  // reads visually. `lap === 1` fires its first ramp via the
  // race-system's lap-start hook below (lap 0 was applied at construction).
  const lapWeather = createLapWeatherSystem({
    schedule: track.lapWeather,
    initial: {
      cloudiness: track.sky?.cloudiness ?? 0.45,
      beaufort: track.sky?.seaStateBeaufort ?? 4,
      sunIntensity: track.sky?.sunIntensity ?? 1.0,
    },
    sky,
    waveField,
  })

  // Cloud-shadow injection. With sky's shared uniforms in hand we build a
  // sun-projected FBM multiplier and stamp it onto every terrain material
  // already in the scene (GLB-authored terrain only — procedural arena /
  // ramps / cliffside use stock MeshStandardMaterial and aren't picked up).
  // Done once after track + sky are both ready; the multiplier reads
  // sky.shared.time each frame so shadows scroll with the wind for free.
  if (!editMode) {
    const cloudShadow = buildCloudShadowMultiplier(sky.shared)
    const decorated = applyCloudShadowsToScene(scene, cloudShadow)
    if (decorated > 0) {
      // eslint-disable-next-line no-console
      console.info(`[boot] cloud shadows applied to ${decorated} terrain material(s)`)
    }
  }

  // Distant horizon silhouette ring. Three precedence tiers:
  //   1. GLB-authored mesh — when the track's environment.glb shipped a
  //      `kind=horizon` mesh, the loader extracted it and we feed it
  //      directly into the shader so authors keep full control over
  //      the silhouette (e.g. Skytree for Shibuya, Table Mountain for
  //      Cape Town). The track JSON's `horizon` block still contributes
  //      `silhouetteDark` / optional `peakHeight` normalisation.
  //   2. Procedural with per-track overrides — track JSON's `horizon`
  //      block carries `radius` / `peakHeight` / `seed` /
  //      `silhouetteDark`. Authors who don't need a bespoke mesh can
  //      shape the procedural fallback from the Blender addon panel.
  //   3. Default procedural — seed hashed from track id so every track
  //      gets a distinct silhouette without authoring. Matches the
  //      historical look.
  // Camera-locked XZ in either case; fades into sky-tinted fog.
  const horizonRing = createHorizonRing({
    scene,
    shared: sky.shared,
    config: {
      ...(horizonGeometry
        ? { geometry: horizonGeometry }
        : { seed: track.horizon?.seed ?? hashStringSeed(trackId) }),
      ...(track.horizon?.radius !== undefined ? { radius: track.horizon.radius } : {}),
      ...(track.horizon?.peakHeight !== undefined ? { peakHeight: track.horizon.peakHeight } : {}),
      ...(track.horizon?.silhouetteDark !== undefined
        ? { silhouetteDark: track.horizon.silhouetteDark }
        : {}),
    },
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
      horizonRing,
      waterMesh,
      waveField,
      backend,
      backendEl,
    })
    return
  }

  // Preload the canonical gate prop mesh from
  // `public/assets/props/gate.glb` (built by `pnpm gen:prop-gate` from
  // the same `prop_gate_mesh` the Blender addon shows in the
  // gate-preview gizmo). `createTrackVisuals` clones it per
  // checkpoint when present, falls back to procedural geometry when
  // the asset isn't available.
  const gatePropTemplate = await loadGateProp()
  const trackVisuals = createTrackVisuals(track, { gatePropTemplate })
  scene.add(trackVisuals.group)

  // Bridge supports — procedural stone pillars under elevated road
  // sections where the spline sits well above the terrain. The pillars
  // give a bridge identity to authored road shoulders that previously
  // just ramped terrain up to the road slab. No-op for tracks whose
  // road is on the ground (sandbar, low-elevation lagoons).
  const bridgeSupports = createBridgeSupports({
    track,
    heightmap: terrainHeightmap ?? null,
    waterY: track.water?.height ?? 0,
  })
  if (bridgeSupports) {
    scene.add(bridgeSupports.group)
    // eslint-disable-next-line no-console
    console.info(`[bridge-supports] ${trackId}: ${bridgeSupports.count / 2} pillar pair(s)`)
  }

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
          return [id, await loadProp(assetUrl(`/assets/props/${id}.glb`))] as const
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
  // Wave-rider sim system: drives any kinematic prop tagged as a
  // wave-rider in its GLB extras (buoys, logs, future floating
  // debris). Always constructed when a track has props — the asset
  // pipeline + createPropColliders below decide which placements
  // actually get a WaveRider entity. The sim step is hooked in via
  // simulateStep's `waveRiders` input below.
  let waveRiderSys: WaveRiderSystem | undefined
  let waveRiderRender: ReturnType<typeof createWaveRiderRenderSystem> | undefined
  let animatedProps: ReturnType<typeof createAnimatedPropsSystem> | undefined
  let propsGroup: ReturnType<typeof createPropsMesh> | undefined
  if (track.props.length > 0) {
    propsGroup = createPropsMesh(track.props, propAssets)
    scene.add(propsGroup)
    // Rigged props with `animated:true` (e.g. the swimming great white) are
    // hosted here, skeleton-cloned + mixer-driven, ticked from the game loop.
    animatedProps = createAnimatedPropsSystem(scene, track.props, propAssets, { camera })
    waveRiderSys = createWaveRiderSystem(sim, phys, waveField)
    const waveRiderAssetBindings = createPropColliders(phys, track.props, propAssets, sim, {
      baseY: waveField.baseY,
    })
    if (waveRiderAssetBindings.size > 0) {
      waveRiderRender = createWaveRiderRenderSystem(scene, sim, {
        assetResolver: (eid) => {
          const id = waveRiderAssetBindings.get(eid)
          return id ? propAssets.get(id) : undefined
        },
      })
    }
  }

  bootMark('props')
  bootStat('vinylAfterProps', vinylMaterialsBuilt())

  // Pickup spawns from track.
  for (let i = 0; i < track.pickupSpawns.length; i++) {
    createPickupSpawn(sim, track.pickupSpawns[i] as (typeof track.pickupSpawns)[number], i)
  }

  // Load bike GLBs in parallel. Solo Time Trial only ever renders the
  // player's variant (+ the racer baseline the ghost/fallback paths use);
  // a race grid or multiplayer room can field EVERY variant — each AI
  // spawns with its slot's variantId, so render + seat socket + rider
  // pose all resolve per-variant (the GLBs are ~100–180 KB each and the
  // bike-loader cache dedupes repeats).
  setLoadingMessage('Loading bikes…')
  const bikeIdsToLoad = [
    ...new Set([playerVariant.id, 'racer', ...(timeTrialMode ? [] : Object.keys(BIKE_VARIANTS))]),
  ]
  const loadedBikeGlbs = await Promise.all(
    bikeIdsToLoad.map((id) => loadBike(assetUrl(`/assets/bikes/${id}.glb`))),
  )
  const bikeGlbsById: Record<string, LoadedBike> = {}
  bikeIdsToLoad.forEach((id, i) => {
    bikeGlbsById[id] = loadedBikeGlbs[i] as LoadedBike
  })
  const racerBikeGlb = bikeGlbsById.racer as LoadedBike
  bootMark('bikes')

  // Time Trial — load the saved ghost for (track, bike) before spawn
  // so spawnBikes can attach a ghost entity. Ghost is null on first
  // run, or when the player switches bikes (per-variant feel + line).
  const ghostReplay = timeTrialMode ? getGhost({ trackId, bikeId: playerVariant.id }) : null

  // Phase 5 — entity spawn. See `src/boot/spawn-bikes.ts`. Order is
  // deterministic (player slot 0 then AI 1..N, or replay-recording
  // order) so the recorder / player downstream see consistent slot
  // numbering.
  const spawnArgs: Parameters<typeof spawnBikes>[0] = {
    sim,
    phys,
    track,
    playerVariant,
    activeReplay,
    ghostVariant: ghostReplay ? playerVariant : null,
  }
  if (timeTrialMode) spawnArgs.aiCount = 0
  const { playerEid, aiEids, replayBikeEids, ghostEid } = spawnBikes(spawnArgs)

  // Time Trial — install the ghost runner once both the ghost entity
  // and the saved replay are in hand. Null in race mode, or in TT
  // first-runs where no ghost has been saved yet.
  let ghostRunner: GhostRunner | null = null
  if (ghostEid !== null && ghostReplay) {
    ghostRunner = createGhostRunner({ ghostEid, ghostReplay })
  }

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

  // Pre-lap intro — cinematic camera shots + F1 start-lights.
  //
  // Mode resolution: `playerSettings.preLapIntro` controls the shot
  // chain. The cinematic flies in single-player only — multiplayer
  // pins the camera near the player bike during the lobby gate, so
  // adding a fly-by on top would fight the lobby UX. Replay-playback
  // gets no intro either (it boots into the saved race flow).
  // `?skipintro=1` URL param forces it off (handy for QA + e2e). Bench
  // mode implies skip-intro: the cinematic fly-in / start-lights are camera
  // cuts, not real race load, and would otherwise dominate the bench
  // warmup+measure window instead of 8 bikes actually racing.
  const skipIntroParam = params.get('skipintro') === '1' || benchMode
  const isMultiplayer = roomId !== null
  const introMode = isMultiplayer || skipIntroParam ? 'off' : playerSettings.preLapIntro
  const useStartLights = !isMultiplayer && playerSettings.preLapIntro !== 'off'

  // F1-style start-lights replace the 3/2/1 banner whenever the intro
  // is on (single-player). Construct first so the race-hud's
  // `onCountdownTick` callback below can drive it.
  const startLights = useStartLights ? createStartLights() : null

  const raceHud = createRaceHud({
    track,
    // Defer the countdown until the gate clears: single-player waits
    // for the cinematic shots to finish; multiplayer waits for the
    // relay's synchronized-start `race-go` (every cohort member loaded
    // — see the barrier driver in game-loop.ts), so all tabs run the
    // same 3-2-1 from one shared moment instead of each arming at its
    // own load time.
    deferStart: introMode !== 'off' || isMultiplayer,
    // Suppress the giant 3/2/1/GO text — the start-lights row is the
    // canonical visual when the intro is on. Multiplayer keeps the
    // banner (lobby gate already has its own UI; no intro shots fly).
    hideCountdownBanner: useStartLights,
    onCountdownTick: (n) => {
      // Light audio cue: re-use the gate "ding" for each tick, lap fanfare for GO.
      if (n === 0) audio.lapCompleted()
      else audio.gateCleared()
      // Drive the F1 lights from the same tick stream so the visual
      // tracks the audio exactly (no double timing source).
      startLights?.setCountdown(n)
    },
  })

  // Downward terrain-height lookup. Samples the same baked terrain
  // heightmap the water shader uses for shoaling — O(1) per query, vs the
  // O(env-triangles) Three.js Raycaster the intro previously paid every
  // frame (which CPU-locked the intro to ~10 fps on dense tracks). The
  // heightmap is null for procedural / editor tracks; in that case the
  // intro director falls back to the waterline clearance floor.
  function introRaycastDown(x: number, z: number): number | null {
    if (!terrainHeightmap) return null
    return sampleTerrainHeightAtXZ(terrainHeightmap, x, z)
  }

  // Build the cinematic director. The shots are derived from the
  // track + start pose, then ticked by the game loop. When done, the
  // game loop calls `raceHud.armCountdown()` so the 3/2/1/GO ticks
  // start playing through the start-lights overlay.
  const raceIntro: RaceIntro = createRaceIntro({
    camera,
    track,
    playerStart: {
      x: track.start.position.x,
      y: track.start.position.y,
      z: track.start.position.z,
      yaw: track.start.yaw,
    },
    mode: introMode,
    collision: {
      raycastDown: introRaycastDown,
      waterY: waterHeight,
      // 3.5 m clearance — tall enough that the camera never punches
      // through low rooftops or seabed, low enough that the descent
      // shot's authored 26 m above the chase pose still reads.
      minClearance: 3.5,
    },
  })

  // Tiny helper — convert a 0xRRGGBB number to the "#rrggbb" form the
  // intro UI's `bodyColorHex` field expects. Used in two places (intro
  // roster + recorder); kept local because there's no other caller and
  // the spectator HUD has its own inline formulation.
  function hexFromColor(c: number): string {
    return `#${c.toString(16).padStart(6, '0')}`
  }

  // Build the broadcast intro overlay. Suppressed when the cinematic is
  // off (multiplayer, ?skipintro=1, or the user's setting). The UI
  // shares its racer roster with the replay recorder below so names + colours
  // round-trip into saved replays.
  const introTheme = getTrackTheme(track.id) ?? deriveFallbackTheme(track.id, track.name, track.sky)
  // In cup mode the rival names come from the championship's stable roster
  // so the same opponents appear in every race — and match the post-race
  // results board + podium standings. Single races fall back to the
  // per-track call-sign.
  const cupRoster = cupId ? (getCupProgressFor(cupId)?.roster ?? null) : null
  const aiNameForSlot = (slot: number): string =>
    cupRoster?.find((r) => r.slot === slot)?.name ?? aiCallSign(track.id, slot)
  const introRoster: RaceIntroUiRacer[] = []
  introRoster.push({
    slot: 0,
    name: playerVariant.name,
    variantName: playerVariant.name,
    bodyColorHex: hexFromColor(playerVariant.bodyColor),
    isPlayer: true,
  })
  for (let i = 0; i < aiEids.length; i++) {
    const variant = variantForAiSlot(i + 1)
    introRoster.push({
      slot: i + 1,
      name: aiNameForSlot(i + 1),
      variantName: variant.name,
      bodyColorHex: hexFromColor(variant.bodyColor),
      isPlayer: false,
    })
  }

  let raceIntroUi: RaceIntroUi | null = null
  if (introMode !== 'off') {
    raceIntroUi = createRaceIntroUi({
      // Prefer the theme catalog's curated display name over the JSON
      // `track.name` (most JSONs ship with the slug-cased id, which
      // reads as "THE-MAW" instead of "The Maw" in the title card).
      trackName: introTheme.displayName ?? track.name,
      theme: introTheme,
      lapsToFinish: track.lapsToFinish,
      racers: introRoster,
      totalDurationSec: raceIntro.totalDuration(),
      variant: introMode === 'short' ? 'short' : 'full',
    })
  }

  // Replay recorder. Always-on during a normal race so the finish screen
  // can offer a "Save Replay" download AND so Time Trial can slice the
  // best lap on finish. Captures bike transforms at 30Hz — a 90s race
  // × N bikes × 7 floats per sample fits comfortably in sessionStorage
  // / a download blob. In replay-playback mode the recorder is null
  // (we play, we don't re-record). Hoisted above raceTick so the lap-
  // event callback can call `recorder.recordEvent()`.
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
      // Match the intro roster's variant + call-sign pick so the replay
      // shows the same broadcast as the live race. Same source as the
      // sim-side AI spawn (spawn-bikes.ts), so the recorded variant is
      // the one the AI is actually riding.
      const variant = variantForAiSlot(i + 1)
      recorderBikes.push({
        slot: i + 1,
        isPlayer: false,
        variantId: variant.id,
        displayName: aiNameForSlot(i + 1),
        bodyColor: variant.bodyColor,
      })
    }
    recorder = createReplayRecorder({
      trackId,
      trackName: track.name,
      bikes: recorderBikes,
    })
    recorderStart = performance.now()
  }

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
        // Per-lap weather kicks. `r.lap` is the lap *just started*
        // (incremented when cp 0 is crossed past the first time), so
        // entry `lapWeather[r.lap]` is the target for the next lap.
        lapWeather.onLapStart(r.lap)
        if (lapState.bestLapThisRace === null || lapTime < lapState.bestLapThisRace) {
          lapState.bestLapThisRace = lapTime
        }
        if (recordLapTime({ trackId, bikeId: playerVariant.id }, lapTime)) {
          lapState.bestLapAllTime = lapTime
        }
        // Record the lap boundary into the replay event stream so the
        // best-lap slicer (Time Trial ghost persistence) can find this
        // lap's window. `t` is recorder-relative (matches frame
        // timestamps); `lapTime` is the duration of the closed lap.
        if (recorder) {
          recorder.recordEvent({
            t: (performance.now() - recorderStart) / 1000,
            kind: 'lap',
            slot: 0,
            lap: r.lap - 1,
            lapTime,
          })
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

  // Phase 6 — render systems.
  const bikeRegistry = {
    byVariantId: bikeGlbsById,
    default: racerBikeGlb,
  }
  const bikeRender = createBikeRenderSystem(scene, sim, bikeRegistry, {
    instanced: params.get('instbikes') !== '0',
  })
  // Rider visual: the rigged Quaternius Universal mannequin by default,
  // driven from the same 12 sim bone poses (docs/rider-character-investigation.md).
  // Opt out with `?rider=capsule` for the lightweight capsule rig; the
  // mannequin also falls back to capsules if its rig asset fails to load.
  let riderRender: () => void
  const riderMode = params.get('rider')
  if (riderMode === 'capsule' || riderMode === 'capsules') {
    riderRender = createRiderRenderSystem(scene, sim)
  } else {
    let riderRig: LoadedProp | undefined
    try {
      riderRig = await loadProp(assetUrl('/assets/props/cc0/rider_mannequin.glb'))
    } catch (err) {
      console.warn('[rider] mannequin rig failed to load — using capsule rider:', err)
    }
    riderRender = riderRig
      ? createRiderMannequinSystem(scene, sim, riderRig, bikeRegistry)
      : createRiderRenderSystem(scene, sim)
  }
  const pickupRender = createPickupRenderSystem(scene, sim)
  const combatRender = createCombatRenderSystem(scene, sim)
  const fx = createFxSystem(scene, sim, phys, waveField)
  const engineTrail = createEngineTrailSystem(scene, sim, bikeRegistry)
  // Ambient wind gusts — illustrated white strokes curling downwind around
  // the player (engine/render/wind-trails.ts). Downwind = the dominant swell
  // travel (wave 0 rotated by the live field bearing) — the exact vector the
  // crest spray drifts on — so air and sea visibly move together, and the
  // Beaufort sea state scales how busy/fast the gust field is. `?wind=0`
  // disables; any other number scales intensity (`?wind=1.5` for capture).
  const windTrails = createWindTrailsSystem(scene, {
    getWind: () => {
      const w0 = waveField.waves[0]
      const cosB = Math.cos(waveField.waveBearing)
      const sinB = Math.sin(waveField.waveBearing)
      return {
        x: (w0?.dirX ?? 1) * cosB - (w0?.dirZ ?? 0) * sinB,
        z: (w0?.dirX ?? 1) * sinB + (w0?.dirZ ?? 0) * cosB,
        speed: 5 + 1.2 * (beaufort ?? 4),
      }
    },
    groundY: (x, z) =>
      Math.max(
        waveField.baseY,
        (terrainHeightmap ? sampleTerrainHeightAtXZ(terrainHeightmap, x, z) : null) ??
          waveField.baseY,
      ),
    baseY: waveField.baseY,
    // Anchors the speed-line regime ramp + the hard no-curls-at-40%-of-top-
    // speed rule to the bike actually being ridden.
    topSpeedMps: playerVariant.stats.topSpeed,
    ...(beaufort !== undefined ? { beaufort } : {}),
  })
  {
    const windParam = params.get('wind')
    if (windParam === '0') windTrails.setEnabled(false)
    else if (windParam !== null) {
      const f = Number(windParam)
      if (Number.isFinite(f)) windTrails.setIntensity(f)
    }
  }
  setWindTrailsController({
    isOn: () => windTrails.isEnabled(),
    toggle: () => {
      windTrails.setEnabled(!windTrails.isEnabled())
      return windTrails.isEnabled()
    },
  })
  bootMark('systems')
  bootStat('vinylAfterSystems', vinylMaterialsBuilt())

  // Tint airborne water spray (wake foam, plunge bubbles, crest spray) toward
  // the sunset, matching the surface-foam warm tint. The sky is frozen at the
  // track's time-of-day, so this is a one-time read of the baked horizon
  // colour: warmth = how orange the horizon is (red − blue), and the spray is
  // pulled from cool-white toward a warm coral by that much. At midday (cool
  // horizon) warmth ≈ 0 and the spray stays its baked cool-white.
  {
    // biome-ignore lint/suspicious/noExplicitAny: sky.shared exposes TSL uniforms; .value is the THREE.Vector3 set at construction
    const h = (sky.shared.horizonColor as any).value as { x: number; y: number; z: number }
    const warmth = Math.max(0, Math.min(1, (h.x - h.z) * 2.2))
    // Toward coral (blue-deficient, green slightly down) — same family as the
    // shader's foam warm tint, scaled so even full warmth stays luminous.
    fx.setSprayTint(1, 1 - 0.16 * warmth, 1 - 0.34 * warmth)
    // The wind strokes deliberately do NOT take this warmth: against warm
    // haze skies a warmed white disappears — they keep their cool-white HDR
    // default (see wind-trails.ts) so they stay legible at sunset.
  }

  // Ambient breaking-crest spray — sweeps a world-anchored lattice around the
  // camera each frame and poofs spray off the sea's own crests as they break,
  // independent of any bike (see engine/render/wave-crest-spray.ts). The
  // detector stays pure: we inject the surface probe (folding the wave field's
  // slope + crest height into the GPU-matched whitecap likelihood via
  // `breakingFoam`) and the emit callback (which adds the downwind drift). The
  // sim is never touched, so this is render-only.
  const waveCrestSpray = createWaveCrestSprayDriver({
    sample: (x, z) => {
      const s = sampleSurface(waveField, x, z)
      // slope = |∇y| = hypot(nx, nz) / ny  (n = (−dydx, 1, −dydz)/‖·‖).
      const slope = Math.hypot(s.nx, s.nz) / Math.max(1e-4, s.ny)
      return { y: s.y, foam: breakingFoam(slope, s.y - waveField.baseY) }
    },
    emit: (x, y, z, strength) => {
      // Drift the spray downwind = along the dominant swell direction (wave 0)
      // rotated by the live field bearing. Cheap; recomputed per burst.
      const w0 = waveField.waves[0]
      const cosB = Math.cos(waveField.waveBearing)
      const sinB = Math.sin(waveField.waveBearing)
      const wx = (w0?.dirX ?? 1) * cosB - (w0?.dirZ ?? 0) * sinB
      const wz = (w0?.dirX ?? 1) * sinB + (w0?.dirZ ?? 0) * cosB
      fx.emitWaveSpray(
        x,
        y,
        z,
        strength,
        wx,
        wz,
        WAVE_SPRAY_SCALAR[playerSettings.waveSprayIntensity],
      )
    },
  })

  // Waterline contact effects — the sea acknowledging the world. Discovery
  // walks the loaded environment GLB + static props root for compact meshes
  // that pierce the water band (bridge pillars, placed rocks, dock pylons —
  // see water-contacts.ts). The water shader draws a wave-modulated foam
  // collar + wash ripples around each (`setWaterContacts`); the splash
  // driver below bursts spray off each one the moment a crest slams it, so
  // obstacles read as standing IN the sea instead of pasted onto it.
  // Render-only on both halves — displacement/buoyancy never know.
  // `?contact=0` kills both for A/B comparison.
  let contactSplash: ContactSplashDriver | null = null
  let liveWaterContacts: readonly WaterContact[] = []
  if (params.get('contact') !== '0' && !editMode) {
    environmentGlbRoot?.updateMatrixWorld(true)
    propsGroup?.updateMatrixWorld(true)
    const contactRoots: ContactScanNode[] = []
    if (environmentGlbRoot) contactRoots.push(environmentGlbRoot)
    if (propsGroup) contactRoots.push(propsGroup)
    // Straddle band: how far the live swell can climb/drop an obstacle.
    // Generous (sum of all wave amplitudes) so storm seas still catch
    // contacts the calm waterline wouldn't.
    const reach = Math.min(
      4,
      Math.max(
        0.8,
        waveField.waves.reduce((a, w) => a + w.amplitude, 0),
      ),
    )
    const discovered = collectWaterContacts(contactRoots, { waterY: waveField.baseY, reach })
    // Gate posts — gates spawn in their own instanced renderer, so the scene
    // scan can't see them; their pose is pure checkpoint data. Only posts
    // standing over submerged seabed qualify (one post on the beach + one in
    // the surf is a common gate).
    const seabedY = (x: number, z: number) =>
      (terrainHeightmap ? sampleTerrainHeightAtXZ(terrainHeightmap, x, z) : null) ?? -10000
    const gatePosts = gatePostWaterContacts(track.checkpoints, {
      waterY: waveField.baseY,
      reach,
      groundY: seabedY,
    })
    // Floating props (buoys / logs) bob IN PLACE — the wave-rider sim pins
    // their XZ anchor at spawn — so each gets a static collar at its anchor:
    // the prop bobs above the disc and both breathe with the same wave
    // field. (If floats ever start drifting, `setWaterContacts` re-uploads
    // cheaply enough to call per frame.)
    const floatContacts: WaterContact[] = []
    for (const eid of query(sim, [WaveRiderTag])) {
      const wr = WaveRiderStore.get(eid)
      if (wr) floatContacts.push({ x: wr.anchorX, z: wr.anchorZ, radius: 0.6, strength: 0.85 })
    }
    liveWaterContacts = [...discovered, ...gatePosts, ...floatContacts]
    if (liveWaterContacts.length > 0) {
      // eslint-disable-next-line no-console
      console.info(
        `[boot] waterline contacts: ${discovered.length} scanned + ${gatePosts.length} gate post(s) + ${floatContacts.length} float(s)`,
      )
    }
    waterMesh.setWaterContacts(liveWaterContacts)
    contactSplash = createContactSplashDriver({
      contacts: liveWaterContacts,
      baseY: waveField.baseY,
      sample: (x, z) => {
        const s = sampleSurface(waveField, x, z)
        return { y: s.y, vy: s.vy }
      },
      emit: (c, surfaceY, strength) => {
        // Sheet faces BACK toward where the swell came from (reflected
        // slap) — the same live-bearing swell direction the crest spray
        // drifts along, negated.
        const w0 = waveField.waves[0]
        const cosB = Math.cos(waveField.waveBearing)
        const sinB = Math.sin(waveField.waveBearing)
        const wx = (w0?.dirX ?? 1) * cosB - (w0?.dirZ ?? 0) * sinB
        const wz = (w0?.dirX ?? 1) * sinB + (w0?.dirZ ?? 0) * cosB
        fx.emitContactSplash(
          c.x,
          surfaceY,
          c.z,
          strength,
          -wx,
          -wz,
          c.radius,
          WAVE_SPRAY_SCALAR[playerSettings.waveSprayIntensity],
        )
      },
    })
  }
  // Dev/e2e hook — same shape family as __windTrails/__particles: inject
  // synthetic contacts on open water, read burst counts, scrub the collar.
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __waterContacts?: unknown }).__waterContacts = {
      count: () => liveWaterContacts.length,
      list: () => liveWaterContacts.map((c) => ({ ...c })),
      fires: () => contactSplash?.firedCount() ?? 0,
      set: (list: WaterContact[]) => {
        liveWaterContacts = list
        waterMesh.setWaterContacts(list)
        contactSplash?.setContacts(list)
      },
      setCollarStrength: (s: number) => waterMesh.debug.setContactFoam(s),
    }
  }

  const fxTick = (dt: number) => {
    fx.tick(dt)
    engineTrail.tick(camera, dt)
    // Wind gusts run on the wave-field clock (not dt) so freeze-water stills
    // them for screenshots and replay scrubs reseed them cleanly.
    windTrails.tick(camera, waveField.time)
    // Skip the lattice sweep entirely when the player has the effect off — no
    // sampling cost for a disabled feature. The bike-driven bow spray inside
    // fx.tick honours the same setting on its own.
    if (playerSettings.waveSprayIntensity !== 'off') {
      waveCrestSpray.tick(camera.position.x, camera.position.z, waveField.time)
      // Obstacle slams ride the same setting + clock (freeze-water stills them).
      contactSplash?.tick(camera.position.x, camera.position.z, waveField.time)
    }
  }

  // Unified track-emitter particle system — every `kind=emitter` empty
  // in the loaded environment GLB feeds this. Tracks without emitters
  // (procedural + edit mode) get a no-op tick. The atlas is fetched
  // best-effort; if it 404s the system silently disables itself so a
  // missing asset never blocks boot. See
  // ``src/engine/render/particle-system.ts``.
  let particleSystem: ParticleSystem | null = null
  let particleTick: (dt: number) => void = () => {}
  let surgeSpray: SurgeSprayDriver | null = null
  if (!editMode && environmentGlbRoot) {
    try {
      const atlasTex = await loadParticleAtlas(assetUrl('/assets/fx/particle-atlas.png'))
      particleSystem = createParticleSystem({ scene, atlasTexture: atlasTex })
      const registered = particleSystem.registerEmittersFromScene(environmentGlbRoot)
      if (registered.length > 0) {
        // eslint-disable-next-line no-console
        console.info(`[boot] registered ${registered.length} particle emitter(s)`)
      }
      // Surge-triggered spray: wave zones carrying a periodic surge (the Maw's
      // timed launch wave) burst the water-spray emitters (atlas cell 9) sitting
      // inside them on each surge peak, so the crown/breaker spray fires harder
      // on the big swell. See engine/render/surge-spray.ts.
      const SPRAY_ATLAS_CELL = 9
      const surgeZones = (track.waveZones ?? [])
        .filter((z) => (z.surgePeriodS ?? 0) > 0 && (z.surgeAmplitude ?? 0) > 0)
        .map((z) => ({
          x: z.position.x,
          z: z.position.z,
          radius: Math.max(z.halfWidth, z.halfDepth) + (z.blendRadiusM ?? 0),
          periodS: z.surgePeriodS as number,
          amplitude: z.surgeAmplitude as number,
        }))
      if (surgeZones.length > 0) {
        const sprayEmitters = registered
          .filter((c) => c.atlasCell === SPRAY_ATLAS_CELL)
          .map((c) => {
            const o = particleSystem?.getEmitter(c.name)?.origin
            return o ? { name: c.name, x: o.x, z: o.z } : null
          })
          .filter((e): e is { name: string; x: number; z: number } => e !== null)
        if (sprayEmitters.length > 0) {
          surgeSpray = createSurgeSprayDriver({
            zones: surgeZones,
            emitters: sprayEmitters,
            triggerBurst: (name, count) => particleSystem?.triggerBurst(name, count),
          })
        }
      }
      particleTick = (dt: number) => {
        particleSystem?.tick(dt)
        surgeSpray?.tick(waveField.time)
      }
    } catch (err) {
      // Atlas missing or load failed — particle emitters stay dormant.
      // eslint-disable-next-line no-console
      console.warn('[boot] particle atlas unavailable; emitters disabled:', err)
    }
  }
  // Expose to gameplay so explosion / wave-pump events can fire a
  // ``triggerBurst`` on a named emitter without plumbing the system
  // through every consumer. Mirrors the ``__fx`` debug hook in fx/index.ts.
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __particles?: unknown }).__particles = {
      system: () => particleSystem,
      stats: () => particleSystem?.stats(),
      triggerBurst: (name: string, count: number) => particleSystem?.triggerBurst(name, count),
    }
  }

  // Landmark animation — walk the loaded environment GLB for every
  // ``landmark_mechanical_rig`` arm subtree and drive a per-instance
  // sin pendulum each frame (gantry cranes, Doge's bell, future
  // mechanical-rig landmarks). Visual mesh is render-only; the
  // kinematic-position rigid body carrying the arm's trimesh collider
  // is updated through the same ``setNextKinematic*`` path the MP
  // remote-bike system uses, so the bike physically collides with
  // the swinging gauntlet. Tracks without mechanical rigs get a
  // no-op tick. See ``src/engine/render/landmark-animation.ts``.
  const landmarkAnim = createLandmarkAnimation({ phys })
  let landmarkTick: (elapsedSeconds: number) => void = () => {}
  if (!editMode && environmentGlbRoot) {
    const armCount = landmarkAnim.registerFromScene(environmentGlbRoot)
    if (armCount > 0) {
      // eslint-disable-next-line no-console
      console.info(`[boot] registered ${armCount} animated landmark arm(s)`)
      landmarkTick = (elapsedSeconds: number) => {
        landmarkAnim.tick(elapsedSeconds, playerSettings.animatedLandmarks)
      }
    }
  }
  // Debug accessor — same dev/test shape as `__particles`. The
  // ``arms()`` view lets a debugger session inspect the resolved
  // configs (period / amplitude / axis / phase / restAngle) without
  // poking at module internals.
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __landmarks?: unknown }).__landmarks = {
      arms: () => landmarkAnim.arms(),
    }
  }

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

  // Anti-grav visualization — coloured spline polylines + "up" arrows at
  // arc-length intervals, plus volume-zone wireframes. Toggle: F3, or
  // `?debug=anti-grav` boot-time, or `window.__hover.toggleAntiGravDebug()`.
  // Static geometry (built once); cheap when off (group.visible = false).
  const antiGravDebug = createAntiGravDebugRenderer(track)
  scene.add(antiGravDebug.group)
  if (params.get('debug') === 'anti-grav') {
    antiGravDebug.setEnabled(true)
  }

  // Per-bike hover-spring visualizer — probe rays, hit markers, spring
  // force arrows, hover-height ring, isGrounded ring, effective-up
  // arrow. Toggle: F4, `?debug=hover` URL param, or
  // `window.__hover.toggleHoverDebug()`. Cheap when off (early-return in
  // tick AND in hoverSystem) so it stays in the scene at all times.
  const hoverDebug = createHoverDebugRenderer(phys)
  scene.add(hoverDebug.mesh)
  if (params.get('debug') === 'hover') {
    hoverDebug.setEnabled(true)
  }

  // Per-track audio palette — licensed music + ambient layers, applied
  // to the radio engine stood up early in boot() (see installSoundtrackRadio
  // above). The engine buffers the config when the AudioContext doesn't
  // exist yet (boot path before first user gesture) and applies it lazily
  // on resume(). Audio files are forward-looking; missing files (404) warn
  // and fall back to the soundtrack radio / procedural bed without crashing.
  applyTrackAudio(track.audio)

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
      // over from previous auto-play sessions on the same page. Player-driven
      // auto-play uses the same difficulty bake-in as the real opponents.
      AIControllerStore.set(
        playerEid,
        defaultAIController('main', { difficulty: playerSettings.aiDifficulty }),
      )
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

  // Reuses the collision-pill style — single HUD pill that shows whichever
  // debug overlay is on. Built lazily so tracks without anti-grav don't
  // create the element.
  let antiGravPill: HTMLElement | null = null
  function updateAntiGravPill(): void {
    if (antiGravDebug.isEnabled()) {
      if (!antiGravPill) {
        antiGravPill = document.createElement('span')
        antiGravPill.id = 'hud-anti-grav'
        antiGravPill.style.cssText =
          'display:inline-block;margin-left:6px;padding:2px 6px;border-radius:3px;background:rgba(160,100,255,0.85);color:#fff;font:11px ui-monospace,Menlo,Consolas,monospace'
        if (collisionPill?.parentElement) {
          collisionPill.parentElement.appendChild(antiGravPill)
        } else {
          document.body.appendChild(antiGravPill)
        }
      }
      antiGravPill.textContent = 'anti-grav debug: ON (F3)'
      antiGravPill.style.display = 'inline-block'
    } else if (antiGravPill) {
      antiGravPill.style.display = 'none'
    }
  }
  updateAntiGravPill()

  // Hover-debug HUD pill — same lazy-build pattern. Green tint so the
  // three debug pills are visually distinguishable at a glance.
  let hoverDebugPill: HTMLElement | null = null
  function updateHoverDebugPill(): void {
    if (hoverDebug.isEnabled()) {
      if (!hoverDebugPill) {
        hoverDebugPill = document.createElement('span')
        hoverDebugPill.id = 'hud-hover-debug'
        hoverDebugPill.style.cssText =
          'display:inline-block;margin-left:6px;padding:2px 6px;border-radius:3px;background:rgba(40,200,80,0.85);color:#fff;font:11px ui-monospace,Menlo,Consolas,monospace'
        if (collisionPill?.parentElement) {
          collisionPill.parentElement.appendChild(hoverDebugPill)
        } else {
          document.body.appendChild(hoverDebugPill)
        }
      }
      hoverDebugPill.textContent = 'hover debug: ON (F4)'
      hoverDebugPill.style.display = 'inline-block'
    } else if (hoverDebugPill) {
      hoverDebugPill.style.display = 'none'
    }
  }
  updateHoverDebugPill()

  // Pause menu, finish-screen actions, and keyboard bindings. See
  // `src/boot/controls.ts` — returns a small handle the game loop polls
  // for pause state + mutates when the finish screen shows.
  const controls = installControls({
    sim,
    phys,
    track,
    trackId,
    playerEid,
    playerVariantId: playerVariant.id,
    roomId,
    cupId,
    raceHud,
    audio,
    physicsDebug,
    antiGravDebug,
    hoverDebug,
    onSetAutoPlay: applyAutoPlayTag,
    onCollisionDebugChanged: updateCollisionPill,
    onAntiGravDebugChanged: updateAntiGravPill,
    onHoverDebugChanged: updateHoverDebugPill,
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
    toggleAntiGravDebug: () => {
      const on = antiGravDebug.toggle()
      updateAntiGravPill()
      return on
    },
    isAntiGravDebugOn: () => antiGravDebug.isEnabled(),
    toggleHoverDebug: () => {
      const on = hoverDebug.toggle()
      updateHoverDebugPill()
      return on
    },
    isHoverDebugOn: () => hoverDebug.isEnabled(),
    toggleDirectionArrow: () => {
      const on = !dirArrow.isEnabled()
      dirArrow.setEnabled(on)
      return on
    },
    isDirectionArrowOn: () => dirArrow.isEnabled(),
    skipCountdown: () => {
      // Scripted intent overrides (e2e / debug) skip past the
      // cinematic intro as well as the 3/2/1 ticks so test paths
      // aren't held up by the pre-race phase. Also hides the lights
      // row so the e2e harness doesn't see the lamp DOM in
      // mid-sequence state.
      raceIntro.skip()
      // Tick once so the director's done flag flips before the loop
      // sees `isActive()`.
      raceIntro.tick(0)
      raceHud.skipCountdown()
      startLights?.hide()
    },
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
        // Tenure-aware — must agree with multiplayer.isHost() or the
        // probe lies about who's simulating the AI.
        isHost: () => multiplayer.isHost(),
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
        bikePoses: () => multiplayer.probeBikePoses(),
        barrier: () => ({ ...multiplayer.raceStartBarrier() }),
      }
    },
  })
  if (backendEl) backendEl.textContent = `backend: ${backend}`
  if (finishSub) finishSub.textContent = track.name

  // Phase 7b — shader / pipeline pre-warm. WebGPU pipeline compilation
  // on first sight of a material is 5–20 ms each; on WebGL2 the GLSL
  // compile can be much worse on first program. Doing it here, under
  // the loading screen, replaces a visible mid-race hitch with a small
  // bump on the boot bar. We tick every render system once so per-eid
  // meshes (bikes, pickups, combat overlays) exist before
  // `compileAsync` walks the scene — the static-scene compiles
  // (terrain, water, sky, props, shadow pass) would happen either
  // way but the per-entity ones wouldn't.
  //
  // Progressive warm: three's WebGPU pipeline cache keys per material instance,
  // so a dressed track pays ~one compile per vinyl material (~87 ≈ 5 s on
  // Sandbar). We hide the static scenery (props + track buildings) so only the
  // player-essential set (bikes, riders, water, sky, terrain, gates) compiles
  // under the loading screen — the screen drops sooner — then reveal the scenery
  // a few meshes per frame once the race is live, letting the running loop
  // compile each on first sight (see progressive-warm.ts). Opt out: ?progwarm=0.
  let progWarm: ProgressiveWarm | null = null
  try {
    setLoadingMessage('Warming up shaders…')
    bikeRender()
    riderRender()
    pickupRender(0)
    combatRender(0)
    fxTick(0)
    // Tick the animated-prop system once so any skinned prop (the swimming
    // shark) has its skeleton bound + posed and its SkinnedMesh in the scene's
    // render state before `compileAsync` walks it below. It's preloaded +
    // instantiated at boot already, but it was the one render system the
    // pre-warm skipped — so its skinned (and skinned-shadow) pipeline compiled
    // on first sight mid-race instead: the "hitch when the shark spawns in".
    animatedProps?.update(0)
    if (params.get('progwarm') !== '0') {
      progWarm = deferSceneryWarm(collectVinylScenery([propsGroup, environmentGlbRoot]))
      bootStat('deferredScenery', progWarm.count)
    }
    const r = renderer as unknown as {
      compileAsync?: (scene: unknown, camera: unknown) => Promise<void>
    }
    // When a post-pipeline is active, the scene's render-time format is
    // the PassNode's HalfFloat RT, *not* the canvas. Compiling against
    // the canvas (`renderer.compileAsync(scene, camera)`) caches pipelines
    // under the wrong key — the cache misses at render time and the
    // framebuffer comes out solid black with no validation error. The
    // active pipeline's `compileAsync()` warms via one eager
    // `pipeline.render()` so the cache key matches what the rAF loop uses.
    const activePipeline = getActivePostPipeline()
    if (activePipeline) {
      await activePipeline.compileAsync()
    } else if (typeof r.compileAsync === 'function') {
      await r.compileAsync(scene, camera)
    }
  } catch (err) {
    // Pre-warm is best-effort. A failure here just means the first
    // race frame pays its own compile cost — same as before this
    // landed — not a boot blocker.
    // eslint-disable-next-line no-console
    console.warn('[main] shader pre-warm failed; first frame may hitch:', err)
  }
  bootMark('prewarm')

  // Warm + reveal the deferred scenery. Each mesh is compiled asynchronously
  // (createRenderPipelineAsync, main-thread yields) under the live render
  // path's cache key — the post-pipeline's PassNode RT when one is active —
  // and only made visible once its pipelines are cached, so the running loop
  // never pays a synchronous first-sight compile — letting it do so stalled
  // rAF 250–700 ms per reveal frame for the first ~7 s of the race. The
  // compile hook is
  // best-effort: progressive-warm falls back to the visibility-only reveal
  // without one, and reveals a mesh anyway if its compile rejects.
  let sceneryWarmComplete = true
  if (progWarm) {
    sceneryWarmComplete = progWarm.count === 0
    const warmPipeline = getActivePostPipeline()
    const warmRenderer = renderer as unknown as {
      compileAsync?: (scene: unknown, camera: unknown, targetScene?: unknown) => Promise<void>
    }
    progWarm.reveal({
      compile: warmPipeline
        ? (o) => warmPipeline.compileSubtreeAsync(o)
        : typeof warmRenderer.compileAsync === 'function'
          ? (o) => warmRenderer.compileAsync?.(o, camera, scene) ?? Promise.resolve()
          : undefined,
      onDone: () => {
        sceneryWarmComplete = true
        bootMark('scenery')
        bootReport()
      },
    })
  }

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
      horizonRing,
      waveField,
      sim,
      phys,
      terrainHeightmap: terrainHeightmap ?? null,
      waterMesh,
      bikeRender,
      riderRender,
      pickupRender,
      combatRender,
      fxTick,
      particleTick,
      landmarkTick,
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

  bootStat('vinylMaterials', vinylMaterialsBuilt())
  bootStat('props', track.props.length)
  bootReport()
  state.ready = true
  hideLoadingScreen()
  startGameLoop({
    state,
    sim,
    phys,
    scene,
    camera,
    renderer,
    gpuTimestampsTracked,
    audio,
    chase,
    waveField,
    waterMesh,
    sky,
    lapWeather,
    horizonRing,
    trackVisuals,
    raceHud,
    raceIntro,
    raceIntroUi,
    raceTick,
    dirArrow,
    physicsDebug,
    hoverDebug,
    bikeRender,
    riderRender,
    pickupRender,
    combatRender,
    fxTick,
    triggerPumpBurst: fx.triggerPumpBurst,
    particleTick,
    landmarkTick,
    track,
    trackId,
    manifest,
    playerEid,
    aiEids,
    playerVariant,
    multiplayer,
    roomId,
    cupId,
    recorder,
    recorderStart,
    lapState,
    control: {
      isAutoPlay: () => controls.isAutoPlay(),
      setAutoPlay: (on: boolean) => controls.setAutoPlay(on),
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
    tutorialMode: params.get('tutorial') === '1',
    timeTrialMode,
    ghostRunner,
    ...(waveRiderSys ? { waveRiderSys } : {}),
    ...(waveRiderRender ? { waveRiderRender } : {}),
    ...(animatedProps ? { animatedProps } : {}),
    sceneryWarmed: () => sceneryWarmComplete,
  })

  // Performance benchmark director (`?bench=1`). Installed after the race
  // game loop is live so the warmup→measure window samples a real running
  // race. Forces auto-play on (AI drives the player bike, hands-off) and
  // reads draw calls / triangles from the live renderer `.info`, mirroring
  // perf-hud. Production-safe — no dev gate. See src/boot/benchmark-mode.ts.
  if (benchMode) {
    // Same `renderer.info` read as perf-hud / game-loop: the WebGPURenderer
    // behind the WebGLRenderer cast exposes the live `info.render.*` counters.
    const benchRenderer = renderer as unknown as { info: RenderInfoLite }
    installBenchmark({
      renderer: benchRenderer,
      backend,
      controls: {
        setAutoPlay: (on: boolean) => controls.setAutoPlay(on),
        isAutoPlay: () => controls.isAutoPlay(),
      },
      trackId,
      bikeId: playerVariant.id,
    })
  }
}

/**
 * Stable per-track hash → seed for the horizon-ring layered-sine
 * generator. djb2 is plenty random for visual variety and stays
 * deterministic across reloads so replays match. Multiplied to a
 * reasonable phase range (the generator uses seed * i * 1.731 in its
 * octave offsets, so seeds of single digits would all look similar).
 */
function hashStringSeed(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h % 9973) * 0.137
}

boot().catch((err) => {
  console.error('[boot] fatal', err)
  const el = document.getElementById('hud-backend')
  if (el) el.textContent = `boot failed: ${String(err)}`
  setLoadingMessage(`Boot failed · ${String(err)}`)
})
