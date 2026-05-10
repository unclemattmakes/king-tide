/**
 * Defer loading a debug overlay's heavy module until its toggle button
 * is first clicked. The button stays in the DOM at boot (defined in
 * index.html), but the module that wires sliders, builds DOM, and
 * persists state is dynamic-imported on demand so it lands in its own
 * Vite chunk instead of the main bundle.
 *
 * The supplied `loader` should resolve to the menu handle returned by
 * the install function (any object exposing an `open()` method) — on
 * first click we install, then immediately open, replicating the
 * eager-install behavior from the user's perspective.
 */
type OpenableMenu = { open(): void }

export function bindLazyMenuButton(buttonId: string, loader: () => Promise<OpenableMenu>): void {
  const btn = document.getElementById(buttonId)
  if (!btn) return
  let loading = false
  const handler = async (e: Event) => {
    if (loading) return
    loading = true
    e.preventDefault()
    btn.removeEventListener('click', handler)
    try {
      const handle = await loader()
      handle.open()
    } catch (err) {
      // If the chunk fails to load, restore the click handler so the
      // user can retry. Logging keeps the failure visible without
      // breaking the rest of the page.
      console.error(`[lazy-menu] failed to load #${buttonId}:`, err)
      btn.addEventListener('click', handler)
      loading = false
    }
  }
  btn.addEventListener('click', handler)
}
