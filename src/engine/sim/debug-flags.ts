/**
 * Sim-side toggles for diagnostic data writes.
 *
 * The sim layer can't import from `@/engine/render` (CLAUDE.md), so any
 * flag that gates an expensive-when-on sim write — e.g. populating the
 * per-bike `HoverDebugStore` — needs to live here. Renderers toggle
 * these flags through `setHoverDebugEnabled` etc.; hot-path sim systems
 * read the flag to decide whether to allocate the per-tick debug
 * snapshot.
 */

let hoverDebugEnabled = false

export function isHoverDebugEnabled(): boolean {
  return hoverDebugEnabled
}
export function setHoverDebugEnabled(on: boolean): void {
  hoverDebugEnabled = on
}
