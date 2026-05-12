/**
 * Boot-time loading overlay. Hand-rolled DOM (no Three.js) so it can be
 * shown before any of the heavier subsystems are ready. The markup lives
 * in `index.html` and is visible by default — that way the first paint
 * already covers the empty canvas while `boot()` resolves the manifest,
 * track, props, and bike GLBs. Add `loading-hidden` on `<body>` (or
 * equivalent class on the root) to take it down once the race / menu /
 * viewer / editor is ready to render.
 */

const ROOT_ID = 'loading-screen'
const MSG_ID = 'loading-screen-msg'
const HIDDEN_CLASS = 'loading-hidden'

function root(): HTMLElement | null {
  return document.getElementById(ROOT_ID)
}

/** Update the status line under the title. No-op if the DOM is absent. */
export function setLoadingMessage(msg: string): void {
  const el = document.getElementById(MSG_ID)
  if (el) el.textContent = msg
}

/** Re-show the overlay (e.g. between races). Optionally updates the message. */
export function showLoadingScreen(msg?: string): void {
  const r = root()
  if (!r) return
  if (msg !== undefined) setLoadingMessage(msg)
  r.classList.remove(HIDDEN_CLASS)
}

/** Take the overlay down. Safe to call multiple times. */
export function hideLoadingScreen(): void {
  const r = root()
  if (!r) return
  r.classList.add(HIDDEN_CLASS)
}
