/**
 * Wave-line HUD pip — DOM half of the wave-line shimmer signal.
 *
 * Hangs off the `#hud-wave-line` slot reserved in the Step 0 HUD
 * scaffold. Reads `playerSettings.waveLineIntensity`:
 *
 *   - `full`:   small "WAVE LINE" badge with a pulsing dot, visible
 *               whenever the system is on (so the player has a
 *               consistent affordance read even between locks).
 *   - `subtle`: the badge is hidden in the lulls and lights up only
 *               on a strong lock (score ≥ LOCK_THRESHOLD).
 *   - `off`:    slot stays hidden, calls are no-ops.
 *
 * The brightness of the dot blends with the latest score so a near-
 * miss reads as a dim glow before a saturated crest lights it solid.
 * Render-only — like the 3D shimmer it never touches sim state.
 */

import { playerSettings } from '@/engine/player-settings'

export interface WaveLineHud {
  /** Per-frame call. `maxScore` is the brightest score in the fan
   *  this tick — 0..1. Pass the shimmer's `currentMaxScore()`. */
  tick(maxScore: number): void
  dispose(): void
}

const LOCK_THRESHOLD = 0.55

export function createWaveLineHud(): WaveLineHud {
  const slot = document.getElementById('hud-wave-line')
  if (!slot) {
    return { tick() {}, dispose() {} }
  }
  slot.innerHTML = `
    <div class="wl-shell" data-mode="off" aria-hidden="true">
      <span class="wl-dot"></span>
      <span class="wl-label">WAVE LINE</span>
    </div>
  `
  const shell = slot.querySelector<HTMLElement>('.wl-shell')
  if (!shell) return { tick() {}, dispose() {} }

  let lastMode: string | null = null
  let lastActive = false
  let lastScoreBucket = -1

  function tick(maxScore: number): void {
    const mode = playerSettings.waveLineIntensity
    if (mode === 'off') {
      if (lastActive) {
        slot!.setAttribute('hidden', '')
        shell!.classList.remove('wl-active', 'wl-lock')
        lastActive = false
      }
      lastMode = mode
      return
    }
    const locked = maxScore >= LOCK_THRESHOLD
    const showBadge = mode === 'full' || locked
    if (showBadge !== lastActive) {
      if (showBadge) {
        slot!.removeAttribute('hidden')
        shell!.classList.add('wl-active')
      } else {
        slot!.setAttribute('hidden', '')
        shell!.classList.remove('wl-active', 'wl-lock')
      }
      lastActive = showBadge
    }
    if (!showBadge) {
      lastMode = mode
      return
    }
    if (mode !== lastMode) {
      shell!.dataset.mode = mode
      lastMode = mode
    }
    // Bucket the score to keep DOM churn down — 5 levels is plenty for
    // the dot brightness. Compare-then-update avoids style writes on
    // every frame.
    const bucket = locked ? 4 : Math.min(3, Math.max(0, Math.floor(maxScore * 4)))
    if (bucket !== lastScoreBucket) {
      shell!.style.setProperty('--wl-strength', (bucket / 4).toFixed(2))
      lastScoreBucket = bucket
    }
    if (locked && !shell!.classList.contains('wl-lock')) {
      shell!.classList.add('wl-lock')
    } else if (!locked && shell!.classList.contains('wl-lock')) {
      shell!.classList.remove('wl-lock')
    }
  }

  function dispose(): void {
    slot!.setAttribute('hidden', '')
    shell!.classList.remove('wl-active', 'wl-lock')
  }

  return { tick, dispose }
}
