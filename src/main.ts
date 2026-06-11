import { bootMark } from './boot/boot-trace'
import { setLoadingMessage } from './boot/loading-screen'
import { runEarlyModeDispatch } from './boot/url-modes'
import { installConsoleTrap } from './engine/qa/console-trap'

/**
 * Thin entry shell (docs/boot-overhaul-plan.md).
 *
 * This module's static import graph is deliberately tiny — boot-trace,
 * loading-screen, the URL dispatcher and the QA console trap. The heavy
 * game graph (three.js + every render/sim system) lives behind the dynamic
 * `import('./boot/race-boot')` below, so:
 *
 *   - The cold-boot menu / lobby / viewer paths paint without evaluating
 *     any of it. Before this split, the fresh-load menu sat behind a
 *     ~4.6 s single main-thread module-evaluation task (dev server; the
 *     production bundle is faster but the same shape) — the page LOOKED
 *     crashed before the menu ever appeared.
 *   - The race path pays one extra dynamic-import hop for the same bytes
 *     it was importing statically before — no extra work, just moved off
 *     the menu's critical path.
 *
 * The race boot itself (subsystems → assets → spawn → systems → pre-warm →
 * game loop) lives in `src/boot/race-boot.ts`.
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

  // Phase 2+ — the live race. Loaded on demand; the module-evaluation cost
  // of the full game graph lands here, inside the loading screen, instead
  // of ahead of every pre-race surface.
  setLoadingMessage('Loading game…')
  const { bootRace } = await import('./boot/race-boot')
  await bootRace(appEl)
}

boot().catch((err) => {
  console.error('[boot] fatal', err)
  const el = document.getElementById('hud-backend')
  if (el) el.textContent = `boot failed: ${String(err)}`
  setLoadingMessage(`Boot failed · ${String(err)}`)
})
