/**
 * Soundtrack-radio bootstrap shared by every page surface that should
 * have music: the cold-boot menu, the multiplayer lobby, and the live
 * race. Each of those is a separate page lifetime (the menu navigates to
 * the race URL and the page reloads), so each calls this once to stand up
 * its own engine — the radio then starts on the first user interaction
 * wherever the player happens to land.
 *
 * What it wires:
 *   - the AudioEngine + its global registration (`setAudioEngine`)
 *   - the playlist for this surface (`setSoundtrack`, scene-scoped)
 *   - the now-playing credit toast (`onSongChange` → toast)
 *   - an eager resume + the user-gesture unlock + visibility-resume listeners
 *
 * Autoplay handling: on install we eagerly resume the context. On the
 * desktop/Electron build (autoplay policy disabled in `electron/main.cjs`)
 * and for returning web players with a high media-engagement score, that
 * starts the context `running` and music plays from boot with no gesture.
 * Where the browser still gates autoplay (first-time / low-engagement web
 * visits), the eager attempt is a harmless no-op and the first key/pointer
 * event unlocks it via the listeners below (which then remove themselves).
 * Either way music resumes across a scene change without a dedicated
 * "click to re-focus" — every scene transition here is a full page reload,
 * which re-arms Chromium's per-document autoplay gate.
 */

import { createMusicCreditToast } from '@/engine/render/music-credit-toast'
import { type AudioEngine, createAudioEngine } from './audio'
import { setAudioEngine } from './audio-service'
import { levelPlaylist, menuPlaylist, type SoundtrackEntry } from './soundtrack'
import { SOUNDTRACK } from './soundtrack.generated'

/** Which slice of the soundtrack a surface should play. See the content-dir
 *  `playlists.json` + the resolvers in `soundtrack.ts`. */
export type SoundtrackScene =
  | { kind: 'all' }
  | { kind: 'menu' }
  | { kind: 'level'; trackId: string }

export interface SoundtrackRadioOptions {
  /** Scene slice to play. Defaults to the full pool. */
  scene?: SoundtrackScene
  /** Extra work to run on the first unlock gesture (e.g. the race path's
   *  fullscreen-on-first-interaction piggyback). Runs after `resume()`. */
  onUnlock?: () => void
}

function resolvePlaylist(scene: SoundtrackScene | undefined): readonly SoundtrackEntry[] {
  switch (scene?.kind) {
    case 'menu':
      return menuPlaylist(SOUNDTRACK)
    case 'level':
      return levelPlaylist(SOUNDTRACK, scene.trackId)
    default:
      return SOUNDTRACK
  }
}

export function installSoundtrackRadio(opts: SoundtrackRadioOptions = {}): AudioEngine {
  const audio = createAudioEngine()
  setAudioEngine(audio)

  // Credit toast lives in <body>, outside any per-race HUD lifecycle, so
  // it works on the menu + lobby surfaces too.
  const credit = createMusicCreditToast()
  audio.setSoundtrack(resolvePlaylist(opts.scene))
  audio.onSongChange((entry) => credit.show(entry))

  const unlock = () => {
    audio.resume()
    opts.onUnlock?.()
    window.removeEventListener('keydown', unlock)
    window.removeEventListener('pointerdown', unlock)
  }
  window.addEventListener('keydown', unlock)
  window.addEventListener('pointerdown', unlock)

  // AudioContext can drop to 'suspended' after a sleep / lock-screen;
  // re-resume on visibility-restore. No-op when already running.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') audio.resume()
  })

  // Best-effort eager start — try to run audio immediately rather than
  // waiting for a gesture. Succeeds on desktop (Electron disables autoplay
  // policy) and for high-engagement returning web sessions; otherwise it's
  // a no-op the gesture listeners above recover from. This is what makes
  // music resume across scene reloads without a manual re-focus click.
  void audio.resume()

  return audio
}
