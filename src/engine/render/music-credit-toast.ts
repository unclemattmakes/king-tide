/**
 * Now-playing credit toast — the MTV / EA-Trax lower-third that slides in
 * when the soundtrack radio starts a new song, crediting the artist + title.
 *
 * Subscribes to the audio engine's `onSongChange` (wired in `main.ts`).
 * Purely informational: `pointer-events: none`, no focus, no input — so it
 * sits outside the keyboard/controller/touch navigability convention (it's
 * not interactive UI). Visibility is gated by the `musicCreditsEnabled`
 * player setting; reduced-motion is handled globally by the
 * `body[data-reduced-motion-override]` stylesheet rule (transitions snap).
 *
 * The element is created in `<body>` rather than the race HUD because the
 * radio plays across menus + races, outside the per-race HUD lifecycle.
 * Styling lives in `index.html` (`#music-credit`), matching the project's
 * single-stylesheet convention.
 */

import type { SoundtrackEntry } from '@/engine/audio/soundtrack'
import { playerSettings } from '@/engine/player-settings'

/** How long the credit stays up before fading out. */
const HOLD_MS = 6000

export interface MusicCreditToast {
  /** Show the credit for `entry`, or hide if `null` (playback failure). */
  show(entry: SoundtrackEntry | null): void
  dispose(): void
}

export function createMusicCreditToast(): MusicCreditToast {
  const root = document.createElement('div')
  root.id = 'music-credit'
  root.setAttribute('aria-hidden', 'true')
  root.innerHTML = `
    <div class="mc-kicker">♪ NOW PLAYING</div>
    <div class="mc-title"></div>
    <div class="mc-artist"></div>`
  document.body.appendChild(root)

  const titleEl = root.querySelector('.mc-title') as HTMLElement
  const artistEl = root.querySelector('.mc-artist') as HTMLElement

  let hideTimer: ReturnType<typeof setTimeout> | undefined

  function clearHideTimer(): void {
    if (hideTimer !== undefined) {
      clearTimeout(hideTimer)
      hideTimer = undefined
    }
  }

  return {
    show(entry) {
      clearHideTimer()
      if (!entry || !playerSettings.musicCreditsEnabled) {
        root.classList.remove('show')
        return
      }
      titleEl.textContent = entry.title
      artistEl.textContent = entry.artist
      // Re-trigger the enter transition even if a prior credit is still
      // up: drop `show`, force a reflow, re-add. Cheap and reliable.
      root.classList.remove('show')
      void root.offsetWidth
      root.classList.add('show')
      hideTimer = setTimeout(() => {
        root.classList.remove('show')
      }, HOLD_MS)
    },

    dispose() {
      clearHideTimer()
      root.remove()
    },
  }
}
