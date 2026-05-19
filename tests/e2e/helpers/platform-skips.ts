/**
 * Cross-browser / cross-platform skip predicates.
 *
 * Centralizes the "this combination has no real GPU access through
 * Playwright" calls so a future platform change (WebKitGTK gaining a
 * real GL context, Linux Firefox running headed by default, etc.)
 * doesn't require fanning out edits across five specs.
 *
 * Usage in a spec:
 *
 *   import { skipWebKitLinux } from './helpers/platform-skips'
 *
 *   test.describe('M9 cliffside', () => {
 *     skipWebKitLinux(test)
 *     test('cliff drop works', async ({ page }) => { ... })
 *   })
 *
 * Pass the imported `test` so we can stay agnostic about which test
 * binding the spec uses (the bare `@playwright/test` import, or the
 * extended one from `./console-errors`).
 */
import type { TestType } from '@playwright/test'

/**
 * Skip the enclosing describe when running on the Linux WebKit project.
 * WebKitGTK in Playwright on Linux only ships a software WebGL pipeline,
 * so any GPU-bound spec (water, shaders, cliffside FFT) flaps under load
 * without telling you anything useful about the actual product.
 *
 * macOS WebKit gets the real Metal pipeline, so this only filters the
 * Linux project — run those specs on macOS or Windows for true WebKit
 * coverage.
 */
// biome-ignore lint/suspicious/noExplicitAny: TestType has too many generics to forward usefully
export function skipWebKitLinux(test: TestType<any, any>): void {
  test.skip(
    ({ browserName }) => browserName === 'webkit' && process.platform === 'linux',
    'WebKitGTK on Linux has only software WebGL through Playwright — see docs/cross-browser.md',
  )
}
