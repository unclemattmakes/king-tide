/**
 * URL-param dispatch for the boot sequence.
 *
 * `main.ts` calls `runEarlyModeDispatch()` before any heavy subsystem is
 * created. The dispatcher inspects `window.location.search` and either:
 *
 *   - Runs to completion + returns `'handled'` if the URL selects one of
 *     the pre-race surfaces (viewer / cold-boot menu / multiplayer lobby).
 *     The caller's `boot()` returns immediately afterwards.
 *   - Returns `'continue'` so `boot()` proceeds to subsystem setup and
 *     the live race / replay / edit code paths.
 *
 * Keeping this here means `boot()` doesn't have to thread the four
 * "we're navigating away" branches before getting to the game-loop
 * meat.
 */

import { hideLoadingScreen, setLoadingMessage } from './loading-screen'

export type EarlyDispatch = 'handled' | 'continue'

/** URL keys that opt into a specific game/replay/editor mode. Their
 *  presence means we skip the cold-boot menu flow. */
const GAME_SIGNALS = [
  'race',
  'autostart',
  'bench',
  'track',
  'bike',
  'cup',
  'room',
  'edit',
  'replay',
  'determinism',
  'calibrate',
  'rideredit',
  'tutorial',
] as const

/** Lazily create the fixed-position container that hosts the attract-mode
 *  canvas. Sits behind the cold-boot menu and the multiplayer lobby so
 *  AI racers + cinematic camera cuts are the live backdrop for every
 *  broadcast surface. Created once per page lifetime. */
export function ensureAttractStage(): HTMLElement {
  let stage = document.getElementById('attract-stage')
  if (stage) return stage
  stage = document.createElement('div')
  stage.id = 'attract-stage'
  document.body.appendChild(stage)
  return stage
}

/** Wire an attract-mode handle so the page swaps to the live feed as
 *  background once the first attract frame renders. */
function watchAttractLive(
  promise: Promise<{ isLive: () => boolean; dispose: () => void }>,
): Promise<{ dispose: () => void }> {
  return promise.then((handle) => {
    const watch = () => {
      if (handle.isLive()) {
        document.body.classList.add('attract-live')
      } else {
        requestAnimationFrame(watch)
      }
    }
    watch()
    return handle
  })
}

/**
 * Import the attract-mode module graph in STAGES with frame yields between.
 *
 * On a warm cache (every dev reload; production with HTTP cache) a single
 * `import('./attract-mode')` evaluates the whole game graph — three.js +
 * every render/sim system — as ONE continuous main-thread task (~4.6 s on
 * the dev server, smaller but same-shaped minified): the freshly-painted
 * menu freezes for all of it. Pre-importing the big libraries one at a time
 * with a rAF gap after each breaks that into bounded tasks — each stage's
 * eval is cached by the module registry, so the final attract import only
 * pays the game-code remainder. The 250 ms lead-in lets the player's first
 * hover/click land before any eval task does.
 */
async function importAttractStaged(): Promise<typeof import('./attract-mode')> {
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  await new Promise((resolve) => setTimeout(resolve, 250))
  await import('three')
  await nextFrame()
  await import('three/webgpu')
  await nextFrame()
  await import('three/tsl')
  await nextFrame()
  return import('./attract-mode')
}

/**
 * Inspect URL params and run the relevant pre-race surface. When this
 * function returns `'handled'`, `boot()` should return without touching
 * any further game subsystems.
 */
export async function runEarlyModeDispatch(appEl: HTMLElement): Promise<EarlyDispatch> {
  const earlyParams = new URLSearchParams(window.location.search)

  // Stand-alone bike viewer: `?viewer=<bikeId>` (or `?viewer=1` for
  // the manifest's first bike). Skips the entire game boot — no
  // track, no physics, no AI, no audio. See src/viewer/bike-viewer.ts.
  const viewerParam = earlyParams.get('viewer')
  if (viewerParam !== null) {
    setLoadingMessage('Loading bike viewer…')
    const { bootBikeViewer } = await import('@/viewer/bike-viewer')
    const bikeId = viewerParam === '1' || viewerParam === '' ? null : viewerParam
    await bootBikeViewer(appEl, { bikeId })
    hideLoadingScreen()
    return 'handled'
  }

  // Stand-alone prop viewer: `?propviewer=<assetId>` (or `=1`/empty for the
  // first catalogue prop). The validation bench for the painterly-vinyl look —
  // one prop on a neutral studio stage, orbit cam, raw/vinyl toggle, live dials.
  // No game boot. See src/viewer/prop-viewer.ts + docs/painterly-vinyl-pipeline.md.
  const propViewerParam = earlyParams.get('propviewer')
  if (propViewerParam !== null) {
    setLoadingMessage('Loading prop viewer…')
    const { bootPropViewer } = await import('@/viewer/prop-viewer')
    const propId = propViewerParam === '1' || propViewerParam === '' ? null : propViewerParam
    await bootPropViewer(appEl, { propId })
    hideLoadingScreen()
    return 'handled'
  }

  // Rider-pose calibration scene: `?calibrate=1`. One bike + one rider,
  // orbit camera, turbulence generator. Used to dial in rest-pose joint
  // angles and reactive-pose tuning constants.
  if (earlyParams.get('calibrate') !== null) {
    setLoadingMessage('Loading calibration scene…')
    const { bootCalibrationMode } = await import('./calibration-mode')
    await bootCalibrationMode(appEl)
    return 'handled'
  }

  // Rider editor: `?rideredit=1`. One bike + rider, orbit camera, panels
  // for per-bone geometric primitive + colour and the seated pose. Loads
  // the existing rider, lets you redesign it, and saves / exports the
  // design. See src/boot/rider-editor-mode.ts.
  if (earlyParams.get('rideredit') !== null) {
    setLoadingMessage('Loading rider editor…')
    const { bootRiderEditorMode } = await import('./rider-editor-mode')
    await bootRiderEditorMode(appEl)
    return 'handled'
  }

  // Wave-rider validation scene: `?waveriders=1`. Water + lights + a
  // row of buoys / logs + a WASD probe ball to ram them with. Isolates
  // the kinematic-buoyancy + spring-perturbation system for tuning.
  if (earlyParams.get('waveriders') !== null) {
    setLoadingMessage('Loading wave-rider validation scene…')
    const { bootWaveRiderMode } = await import('./wave-rider-mode')
    await bootWaveRiderMode(appEl)
    return 'handled'
  }

  // Water lab: `?waterlab=1`. Deep open ocean + the full WATER tuner
  // (auto-opened) + motion ground-truth instruments (phase-speed pace
  // cones, drifter grid, analytic iso-line speed probe) for analyzing
  // the water's look — built for the contour-line "sliding" study.
  if (earlyParams.get('waterlab') !== null) {
    setLoadingMessage('Loading water lab…')
    const { bootWaterLabMode } = await import('./water-lab-mode')
    await bootWaterLabMode(appEl)
    return 'handled'
  }

  // End-of-cup podium ceremony: `?podium=1`. Reads the completed cup from
  // sessionStorage, stages the 3D trophy ceremony, then slides the final
  // championship standings card in. Reached from the cup-finale finish
  // screen's "PODIUM →" button. No race subsystems.
  if (earlyParams.get('podium') !== null) {
    setLoadingMessage('Loading podium ceremony…')
    const { bootPodiumMode } = await import('./podium-mode')
    await bootPodiumMode(appEl)
    return 'handled'
  }

  // Cold-boot menu flow — sports-broadcast styled title → mode → track
  // → bike (single-player) or → room (multiplayer). The menu only runs
  // when no game-mode URL param is present, so deep links + tests with
  // `?autostart=1` (or `?race=1`, `?track=`, `?room=`, etc.) skip
  // straight into boot. Hitting the title resolves with a fully-formed
  // race URL; we navigate and let the page reload pick it up.
  const hasGameSignal = GAME_SIGNALS.some((k) => earlyParams.has(k))
  if (!hasGameSignal) {
    setLoadingMessage('Loading manifest…')
    const [{ loadManifest }, { runMenuFlow }] = await Promise.all([
      import('@/game/assets/manifest'),
      import('@/engine/menus/menu-flow'),
    ])
    const manifest = await loadManifest()
    const reason = earlyParams.get('back') === '1' ? 'exit-from-race' : 'cold'

    // Soundtrack radio — play music from the menu, not just once a race
    // loads. Installed before the menu renders so the first click/keypress
    // unlocks audio. (The page reloads into the race, which stands up its
    // own radio for that lifetime.)
    const { installSoundtrackRadio } = await import('@/engine/audio/soundtrack-radio')
    installSoundtrackRadio()

    // Menu first, attract second. The attract-mode import pulls the whole
    // game module graph (three.js + every render/sim system) — awaiting it
    // here kept the loading screen up for the entire module evaluation
    // (~4.6 s single main-thread task on a warm dev server; smaller but
    // same-shaped in production). Hide the loading screen and run the menu
    // NOW, then kick the attract import fire-and-forget after a short idle
    // gap so the player's first hover/click lands before the heavy eval
    // task does. Once the first attract frame renders, `attract-live`
    // drops the menu's solid backdrop exactly as before.
    hideLoadingScreen()
    const attractStage = ensureAttractStage()
    const attractPromise = watchAttractLive(
      importAttractStaged().then(({ bootAttractMode }) =>
        bootAttractMode({ parent: attractStage }),
      ),
    )

    const result = await runMenuFlow({
      manifestTracks: manifest.tracks,
      reason,
    })
    // Final commit — tear the attract loop down BEFORE navigating, and give
    // the browser a short beat to start draining the GPU-side destruction
    // (device, 590k-vert water buffers, pipelines). Navigating while that
    // teardown is in flight contends with the race page's load in the same
    // renderer process — measured as a multi-second main-thread blob at the
    // start of the next page. The 200 ms grace is imperceptible on a click
    // that already implies a page load.
    try {
      const handle = await Promise.race([
        attractPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
      ])
      handle?.dispose()
      if (handle) await new Promise((resolve) => setTimeout(resolve, 200))
    } catch {
      /* attract never came up — nothing to tear down */
    }
    window.location.assign(result.href)
    return 'handled'
  }

  // Multiplayer lobby phase: `?room=<id>` without `race=1` shows the
  // lobby overlay (per-player bike + track picks + smash-bros vote)
  // and resolves with the race URL once everyone's ready. Late joiners
  // whose `hello` arrives with `raceStarted` skip the lobby and
  // navigate straight into the active race.
  if (earlyParams.has('room') && !earlyParams.has('race')) {
    setLoadingMessage('Loading lobby…')
    const [{ loadManifest }, { runMpLobby }] = await Promise.all([
      import('@/game/assets/manifest'),
      import('@/engine/menus/mp-lobby'),
    ])
    const manifest = await loadManifest()
    const PROD_PARTY_HOST_LOBBY = 'hoverbike.occ-matt.partykit.dev'
    const netHost =
      earlyParams.get('host') ?? (import.meta.env.DEV ? 'localhost:1999' : PROD_PARTY_HOST_LOBBY)
    const bikeParam = earlyParams.get('bike')
    const trackParam = earlyParams.get('track')

    // Same soundtrack radio behind the lobby as the menu — keeps music
    // continuous across the pre-race surfaces.
    const { installSoundtrackRadio } = await import('@/engine/audio/soundtrack-radio')
    installSoundtrackRadio()

    hideLoadingScreen()
    // Same broadcast attract feed sits behind the lobby — keeps the
    // hand-off into the live race feeling cohesive. Same lobby-first
    // ordering as the menu path above: never block the surface on the
    // heavy attract import.
    const attractStage = ensureAttractStage()
    const attractPromise = watchAttractLive(
      importAttractStaged().then(({ bootAttractMode: bootMp }) => bootMp({ parent: attractStage })),
    )
    const result = await runMpLobby({
      roomId: earlyParams.get('room') as string,
      netHost,
      manifestTracks: manifest.tracks,
      ...(bikeParam ? { initialBikeId: bikeParam as 'cruiser' | 'racer' | 'stunt' } : {}),
      ...(trackParam ? { initialTrackId: trackParam } : {}),
    })
    // Same dispose-then-breathe handoff as the menu path above.
    try {
      const handle = await Promise.race([
        attractPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
      ])
      handle?.dispose()
      if (handle) await new Promise((resolve) => setTimeout(resolve, 200))
    } catch {
      /* attract never came up — nothing to tear down */
    }
    window.location.assign(result.href)
    return 'handled'
  }

  return 'continue'
}
