/**
 * Pump-trick FX controller — the loud, arcade-y reward feedback that
 * sits on top of the wave-pump observer.
 *
 * Three coordinated signals fire on every PumpEvent:
 *   - **FOV punch** — camera fov bumps outward by `fovPunchDeg`, decays
 *     back over `fovDecayMs`. Reads as a forward-thrust whoosh.
 *   - **Speedlines** — radial DOM streaks blast inward from the screen
 *     edges, ~350 ms life. The classic arcade "boost on" tell.
 *   - **Camera shake** — per-frame sub-meter jitter on camera.position
 *     decays exponentially. Sells impact without making the bike hard
 *     to read.
 *
 * Tier scaling — a perfect trick (player tapped pitchUp inside the
 * detector's trick window) doubles the FOV punch and shake amplitude
 * and uses a brighter speedlines variant. A normal auto-pump still
 * fires the FX, just at a softer level — accessibility floor first,
 * skill ceiling on top.
 *
 * Render-only. Never touches sim state. The game loop calls `fire()`
 * on a PumpEvent and `tick(dt)` each render frame; nothing else.
 *
 * Disposal removes the injected DOM + stylesheet so HMR + race-exit
 * paths don't leak elements.
 */

import * as THREE from 'three'
import { playerSettings } from '@/engine/player-settings'

export type PumpFxTuning = {
  /** FOV delta (deg) added on a normal pump fire. */
  fovPunchDeg: number
  /** FOV delta (deg) added on a perfect trick. */
  fovPunchDegPerfect: number
  /** Time constant (ms) for the FOV punch decay back to baseline. */
  fovDecayMs: number
  /** Camera-shake amplitude (m) at the moment of a normal pump fire. */
  shakeAmp: number
  /** Camera-shake amplitude (m) at the moment of a perfect trick. */
  shakeAmpPerfect: number
  /** Half-life (ms) for shake amplitude decay. */
  shakeHalfLifeMs: number
  /** Sustained camera-shake amplitude (m) while a Burnout-style boost
   *  meter is draining. Lower than the one-shot trick shake so it
   *  reads as "engine grit" rather than impact. */
  sustainedShakeAmp: number
}

export const DEFAULT_PUMP_FX_TUNING: Readonly<PumpFxTuning> = Object.freeze({
  fovPunchDeg: 6,
  fovPunchDegPerfect: 11,
  fovDecayMs: 380,
  shakeAmp: 0.12,
  shakeAmpPerfect: 0.22,
  shakeHalfLifeMs: 140,
  sustainedShakeAmp: 0.08,
})

export type PumpFx = {
  /** Fire all three feedback channels. `strength` is the observer's
   *  0..1 score; `perfect` upgrades to the high-tier variants. */
  fire(strength: number, perfect: boolean): void
  /** Toggle the sustained boost-meter camera shake. When true, a
   *  low-amplitude jitter rides over the chase camera every render
   *  frame until set back to false. Independent of the one-shot
   *  shake fired by `fire()` — both can stack. */
  setSustainedShake(active: boolean): void
  /** Advance the FOV punch + shake decay each render frame. The
   *  camera passed at construction is mutated in place. */
  tick(dt: number): void
  /** Read-only debug peek used by the verification harness. */
  debug(): { fovDelta: number; shakeAmp: number; lastFireAt: number; sustainedShake: boolean }
  /** Tear down the injected DOM + stylesheet. Safe to call twice. */
  dispose(): void
}

const STYLE_ID = 'pump-fx-styles'
const OVERLAY_ID = 'pump-fx-speedlines'

function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  // Two layered radial-gradient masks fan out from a transparent center.
  // Streaks blast inward then fade. `--pf-scale` controls how far the
  // streaks reach (perfect tricks blast wider), `--pf-tint` swaps the
  // accent colour for perfect vs. normal so the player can tell the
  // tiers apart at a glance even when the bar fill hasn't loaded yet.
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 60;
      opacity: 0;
      mix-blend-mode: screen;
      --pf-tint: rgba(255, 220, 110, 0.55);
      --pf-scale: 1;
    }
    #${OVERLAY_ID}.pf-perfect {
      --pf-tint: rgba(120, 240, 255, 0.85);
      --pf-scale: 1.4;
    }
    #${OVERLAY_ID}::before,
    #${OVERLAY_ID}::after {
      content: '';
      position: absolute;
      inset: 0;
      background:
        repeating-conic-gradient(
          from 0deg at 50% 50%,
          transparent 0deg 4deg,
          var(--pf-tint) 4deg 6deg,
          transparent 6deg 12deg
        );
      -webkit-mask-image: radial-gradient(
        ellipse 70% 70% at 50% 50%,
        transparent calc(35% / var(--pf-scale)),
        rgba(0,0,0,0.4) calc(60% / var(--pf-scale)),
        black calc(95% / var(--pf-scale))
      );
              mask-image: radial-gradient(
        ellipse 70% 70% at 50% 50%,
        transparent calc(35% / var(--pf-scale)),
        rgba(0,0,0,0.4) calc(60% / var(--pf-scale)),
        black calc(95% / var(--pf-scale))
      );
    }
    #${OVERLAY_ID}::after {
      transform: rotate(7deg);
      opacity: 0.7;
    }
    #${OVERLAY_ID}.pf-active {
      animation: pf-blast 420ms cubic-bezier(0.18, 0.86, 0.32, 1) forwards;
    }
    #${OVERLAY_ID}.pf-active.pf-perfect {
      animation-duration: 560ms;
    }
    @keyframes pf-blast {
      0%   { opacity: 0; transform: scale(0.6); }
      18%  { opacity: 1; transform: scale(1.0); }
      55%  { opacity: 0.6; transform: scale(1.18); }
      100% { opacity: 0; transform: scale(1.35); }
    }
    body[data-reduced-flash="1"] #${OVERLAY_ID} { display: none; }
    body[data-menu-open="1"]      #${OVERLAY_ID} { display: none; }
  `
  document.head.appendChild(style)
}

function ensureOverlay(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  let el = document.getElementById(OVERLAY_ID)
  if (el) return el
  injectStyles()
  el = document.createElement('div')
  el.id = OVERLAY_ID
  document.body.appendChild(el)
  return el
}

export function createPumpFx(
  camera: THREE.PerspectiveCamera,
  tuning: PumpFxTuning = DEFAULT_PUMP_FX_TUNING,
): PumpFx {
  // Snapshot the baseline FOV at construction time. The game's FOV
  // can change between races (track-specific, player setting, etc.),
  // so any external setter that swaps fov should expect us to track
  // the *new* baseline — we re-read on each tick when the punch has
  // fully decayed, so steady-state changes pick up automatically.
  let baseFov = camera.fov
  let fovDelta = 0
  let fovDeltaTarget = 0
  // FOV state-machine — punch up to target, then decay back. We use
  // two separate time constants so the bump-in is snappy (~60 ms) and
  // the decay is longer-tailed (~380 ms) for that "thrust + glide"
  // sensation rather than a symmetric ramp.
  const FOV_PUNCH_RISE_MS = 80
  const decayK = Math.log(2) / Math.max(1, tuning.fovDecayMs * 0.6) // ms⁻¹

  let shakeAmp = 0
  const shakeOffset = new THREE.Vector3()
  const shakeDecayK = Math.log(2) / Math.max(1, tuning.shakeHalfLifeMs) // ms⁻¹
  // Sustained shake — driven externally by the boost-meter system via
  // `setSustainedShake`. Stays at a fixed low amplitude while a boost
  // is draining; layers additively on top of any one-shot shake decay
  // already in flight.
  let sustainedShakeActive = false

  let lastFireAt = Number.NEGATIVE_INFINITY
  let lastWasPerfect = false

  const overlay = ensureOverlay()

  function flashOverlay(perfect: boolean): void {
    if (!overlay) return
    if (playerSettings.wavePumpIntensity === 'off') return
    overlay.classList.remove('pf-active', 'pf-perfect')
    // Force reflow so the next class-add reliably restarts the anim
    // even when two pumps land inside the same fade window.
    void overlay.offsetWidth
    if (perfect) overlay.classList.add('pf-perfect')
    overlay.classList.add('pf-active')
  }

  return {
    fire(strength, perfect) {
      const s = Math.max(0.2, Math.min(1, strength))
      const punchBase = perfect ? tuning.fovPunchDegPerfect : tuning.fovPunchDeg
      // Scale by strength so a marginal crest reads as a marginal
      // punch — keeps the FX honest with the underlying physics.
      fovDeltaTarget = punchBase * (0.5 + 0.5 * s)
      const shakeBase = perfect ? tuning.shakeAmpPerfect : tuning.shakeAmp
      shakeAmp = Math.max(shakeAmp, shakeBase * (0.5 + 0.5 * s))
      lastFireAt = performance.now()
      lastWasPerfect = perfect
      flashOverlay(perfect)
    },

    setSustainedShake(active) {
      sustainedShakeActive = active
    },

    tick(dt) {
      // FOV — chase target on rise, exponentially decay on fall.
      if (fovDeltaTarget > 0) {
        // Snap-rise: get to target fast.
        const riseT = 1 - Math.exp((-dt * 1000) / FOV_PUNCH_RISE_MS)
        fovDelta += (fovDeltaTarget - fovDelta) * riseT
        // Once we're close to the target, switch to decay phase.
        if (fovDelta >= fovDeltaTarget * 0.85) {
          fovDeltaTarget = 0
        }
      } else if (fovDelta > 0.001) {
        // Decay back to 0. `decayK` is in ms⁻¹ so convert dt to ms.
        fovDelta *= Math.exp(-decayK * dt * 1000)
        if (fovDelta < 0.001) {
          fovDelta = 0
          // Re-snapshot the baseline in case external code swapped it
          // while we weren't punching.
          baseFov = camera.fov
        }
      } else {
        // Idle — keep baseline in sync.
        baseFov = camera.fov
      }

      if (fovDelta > 0.001) {
        camera.fov = baseFov + fovDelta
        camera.updateProjectionMatrix()
      }

      // Shake — combined one-shot decay + sustained boost rumble.
      // Chase-camera's per-frame lerp toward goalPos creates the
      // natural smoothing/wiggle. One-shot amplitude decays on the
      // `shakeHalfLifeMs` half-life; sustained adds a fixed floor
      // while a boost is draining.
      const sustainedAmp = sustainedShakeActive ? tuning.sustainedShakeAmp : 0
      const effectiveAmp = Math.max(shakeAmp, sustainedAmp)
      if (effectiveAmp > 0.0005) {
        // Box-uniform jitter — fine enough for sub-meter shake that
        // the player feels but doesn't lose the bike to.
        const jx = (Math.random() * 2 - 1) * effectiveAmp
        const jy = (Math.random() * 2 - 1) * effectiveAmp * 0.6
        const jz = (Math.random() * 2 - 1) * effectiveAmp
        shakeOffset.set(jx, jy, jz)
        camera.position.add(shakeOffset)
        if (shakeAmp > 0.0005) {
          shakeAmp *= Math.exp(-shakeDecayK * dt * 1000)
        }
      }
    },

    debug() {
      return { fovDelta, shakeAmp, lastFireAt, sustainedShake: sustainedShakeActive }
    },

    dispose() {
      if (typeof document === 'undefined') return
      const el = document.getElementById(OVERLAY_ID)
      if (el?.parentNode) el.parentNode.removeChild(el)
      const style = document.getElementById(STYLE_ID)
      if (style?.parentNode) style.parentNode.removeChild(style)
      // Restore baseline FOV in case we were mid-punch on teardown.
      if (fovDelta > 0.001) {
        camera.fov = baseFov
        camera.updateProjectionMatrix()
      }
      fovDelta = 0
      fovDeltaTarget = 0
      shakeAmp = 0
      void lastWasPerfect
    },
  }
}
