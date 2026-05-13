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
  'track',
  'bike',
  'room',
  'edit',
  'replay',
  'determinism',
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

    // Kick off the attract-mode background race in parallel with the
    // menu render. The menu paints immediately (CSS-only) while the
    // attract loop streams in scene + bikes; once the first attract
    // frame renders we drop the menu's solid backdrop so the live
    // footage becomes the menu's background.
    const attractStage = ensureAttractStage()
    const { bootAttractMode } = await import('./attract-mode')
    const attractPromise = watchAttractLive(bootAttractMode({ parent: attractStage }))

    hideLoadingScreen()
    const result = await runMenuFlow({
      manifestTracks: manifest.tracks,
      reason,
    })
    // Final commit — tear the attract loop down so the next page load
    // boots a fresh renderer into the live race without two canvases
    // competing for the GPU.
    attractPromise.then((handle) => handle.dispose()).catch(() => undefined)
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

    // Same broadcast attract feed sits behind the lobby — keeps the
    // hand-off into the live race feeling cohesive.
    const attractStage = ensureAttractStage()
    const { bootAttractMode: bootMp } = await import('./attract-mode')
    const attractPromise = watchAttractLive(bootMp({ parent: attractStage }))

    hideLoadingScreen()
    const result = await runMpLobby({
      roomId: earlyParams.get('room') as string,
      netHost,
      manifestTracks: manifest.tracks,
      ...(bikeParam ? { initialBikeId: bikeParam as 'cruiser' | 'racer' | 'stunt' } : {}),
      ...(trackParam ? { initialTrackId: trackParam } : {}),
    })
    attractPromise.then((handle) => handle.dispose()).catch(() => undefined)
    window.location.assign(result.href)
    return 'handled'
  }

  return 'continue'
}
