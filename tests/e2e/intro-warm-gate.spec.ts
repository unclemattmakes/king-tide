import { expect, test } from '@playwright/test'

/** Minimal shape of the Three.js objects we traverse in-page. */
type SceneObj = {
  isMesh?: boolean
  material?: { name?: string } | Array<{ name?: string } | undefined>
  visible?: boolean
  parent?: SceneObj | null
}

declare global {
  interface Window {
    /** Snapshot of vinyl-scenery visibility captured by the init script at the
     *  instant the loading screen drops. Null until then. */
    __loaderDropSnapshot?: { total: number; visible: number } | null
    /** Dev-only live scene handle (race-boot.ts sets it under import.meta.env.DEV). */
    __scene?: { traverse(cb: (o: SceneObj) => void): void }
  }
}

/**
 * Regression for the "rough load-in" fix: on the single-player cinematic-intro
 * path, boot now holds the loading screen up until the deferred scenery shader
 * warm has compiled + revealed every mesh, THEN drops the loader and starts the
 * fly-through — so the intro plays over a fully-dressed scene instead of
 * sweeping the map while buildings pop in (race-boot.ts → INTRO_WARM_LOADER_CAP_MS).
 *
 * The observable consequence we assert: at the instant the loader drops, the
 * set of visible painterly-vinyl scenery meshes is already the FULLY-revealed
 * set — i.e. nothing pops into view after the loader is gone. Before the fix the
 * loader dropped immediately and the reveal streamed in over the next several
 * seconds, so the loader-drop snapshot held far fewer visible vinyl meshes than
 * the final set.
 *
 * Heavy track on purpose: mexico-city defers ~150 vinyl materials, so the reveal
 * is multi-second and the loader-drop-vs-final comparison has real discriminating
 * power. The default `preLapIntro: 'full'` means a fresh context boots WITH the
 * intro (no `?skipintro=1`), which is exactly the path the gate guards.
 */
const TRACK = 'mexico-city'

/** Count every `mat_vinyl*` mesh in the live scene and how many are actually
 *  visible (the mesh AND all of its ancestors). Runs in the page. */
function snapshotVinylVisibility(): { total: number; visible: number } {
  const scene = window.__scene
  let total = 0
  let visible = 0
  if (scene) {
    scene.traverse((o: SceneObj) => {
      if (!o.isMesh) return
      const mat = Array.isArray(o.material) ? o.material[0] : o.material
      const name = mat?.name
      if (typeof name !== 'string' || !name.startsWith('mat_vinyl')) return
      total++
      let v = o.visible !== false
      let p = o.parent
      while (v && p) {
        v = p.visible !== false
        p = p.parent
      }
      if (v) visible++
    })
  }
  return { total, visible }
}

test('intro waits for scenery warm — nothing pops in after the loader drops', async ({ page }) => {
  // Heavy track + a full cinematic: the loader holds for the warm, then the
  // 7.6 s fly-through + 4.15 s countdown run before raceTime advances, so the
  // whole sequence comfortably outlasts Playwright's 30 s default per-test cap.
  test.setTimeout(120_000)

  // Snapshot vinyl-scenery visibility the instant `#loading-screen` gains the
  // `loading-hidden` class, before any further frames can reveal more.
  await page.addInitScript(() => {
    window.__loaderDropSnapshot = null
    const snap = (): { total: number; visible: number } => {
      const scene = window.__scene
      let total = 0
      let visible = 0
      if (scene) {
        scene.traverse((o) => {
          if (!o.isMesh) return
          const mat = Array.isArray(o.material) ? o.material[0] : o.material
          const name = mat?.name
          if (typeof name !== 'string' || !name.startsWith('mat_vinyl')) return
          total++
          let v = o.visible !== false
          let p = o.parent
          while (v && p) {
            v = p.visible !== false
            p = p.parent
          }
          if (v) visible++
        })
      }
      return { total, visible }
    }
    const poll = setInterval(() => {
      const ls = document.getElementById('loading-screen')
      if (ls?.classList.contains('loading-hidden')) {
        window.__loaderDropSnapshot = snap()
        clearInterval(poll)
      }
    }, 8)
  })

  await page.goto(`/?autostart=1&track=${TRACK}`)

  // The loader must eventually drop (bounded by the warm + INTRO_WARM_LOADER_CAP_MS
  // failsafe). If this ever hangs, the gate failed open — a hard regression.
  await page.waitForFunction(() => window.__loaderDropSnapshot != null, { timeout: 45_000 })

  // The race must actually start: raceTime only advances once the countdown
  // reaches GO and the sim unlocks. Proves the intro→countdown handoff still
  // fires (no post-intro hang) on the heavy-intro path.
  await page.waitForFunction(() => (window.__hover?.race()?.raceTime ?? 0) > 0, {
    timeout: 45_000,
  })

  const loaderDrop = await page.evaluate(() => window.__loaderDropSnapshot)
  if (!loaderDrop) throw new Error('expected a loader-drop snapshot to be captured')
  const final = await page.evaluate(snapshotVinylVisibility)

  // Sanity: this is genuinely a heavy, deferred-scenery track (otherwise the
  // test proves nothing).
  expect(final.total).toBeGreaterThan(20)
  expect(final.visible).toBeGreaterThan(0)

  // Core assertion: the scene was already fully dressed when the loader dropped.
  // Same mesh set, and the visible count at loader-drop matches the fully-warmed
  // visible count — so nothing popped into view after the loader was gone. A tiny
  // margin absorbs a straggler group or two if a much slower machine grazes the
  // INTRO_WARM_LOADER_CAP_MS failsafe; a real regression (loader dropping before
  // the warm) leaks dozens, so this still fails hard for it.
  expect(loaderDrop.total).toBe(final.total)
  expect(loaderDrop.visible).toBeGreaterThanOrEqual(final.visible - 2)
})
