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
 *   - the licensed playlist (`setSoundtrack`)
 *   - the now-playing credit toast (`onSongChange` → toast)
 *   - the user-gesture unlock + visibility-resume listeners
 *
 * Browsers gate the AudioContext behind a user gesture, so nothing is
 * audible until the first key/pointer event — the unlock listener handles
 * that and then removes itself.
 */

import { createMusicCreditToast } from '@/engine/render/music-credit-toast'
import { type AudioEngine, createAudioEngine } from './audio'
import { setAudioEngine } from './audio-service'
import { SOUNDTRACK } from './soundtrack.generated'

export interface SoundtrackRadioOptions {
  /** Extra work to run on the first unlock gesture (e.g. the race path's
   *  fullscreen-on-first-interaction piggyback). Runs after `resume()`. */
  onUnlock?: () => void
}

export function installSoundtrackRadio(opts: SoundtrackRadioOptions = {}): AudioEngine {
  const audio = createAudioEngine()
  setAudioEngine(audio)

  // Credit toast lives in <body>, outside any per-race HUD lifecycle, so
  // it works on the menu + lobby surfaces too.
  const credit = createMusicCreditToast()
  audio.setSoundtrack(SOUNDTRACK)
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

  return audio
}
