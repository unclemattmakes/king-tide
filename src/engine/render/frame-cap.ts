/**
 * Frame-rate cap helper.
 *
 * The game loop is driven by `requestAnimationFrame`, so the browser already
 * paces frames to the display refresh (vsync). When the player wants a
 * tighter ceiling — battery savings on a Steam Deck OLED, capped streaming
 * bitrate, intentional fps lock for racing-line muscle memory — we gate the
 * expensive render + HUD work behind a wall-clock deadline.
 *
 * Important: the sim accumulator is unaffected. The game-loop's fixed-step
 * physics keeps stepping every rAF tick; capping only skips the
 * `renderer.render()` + perf-HUD-tick pair. That keeps sim determinism
 * independent of the cap.
 *
 * `capFps <= 0` disables the gate (returns true unconditionally).
 *
 * Hysteresis: we subtract half a millisecond of slack from the target
 * interval so a render that just-barely missed the previous deadline by
 * sub-ms timer noise still fires the next one. Without the slack, a 60 fps
 * cap on a 60 Hz monitor stutters every ~5 frames because the rAF callback
 * lands at 16.6 ms intervals while the gate demands 16.67 ms.
 */

const TIMER_SLACK_MS = 0.5

export function shouldRenderFrame(now: number, lastRendered: number, capFps: number): boolean {
  if (capFps <= 0 || !Number.isFinite(capFps)) return true
  const targetMs = 1000 / capFps - TIMER_SLACK_MS
  return now - lastRendered >= targetMs
}

/**
 * Map a Settings-overlay "Framerate cap" option label back to a numeric
 * cap. 'Unlimited' → 0 (gate disabled); the rest parse straight to fps.
 * Centralised so the settings overlay and `applyDeckProfile` agree on the
 * label ↔ number contract.
 */
export const FRAMERATE_CAP_LABELS = ['Unlimited', '30', '60', '90', '120', '144'] as const
export type FramerateCapLabel = (typeof FRAMERATE_CAP_LABELS)[number]

export function framerateCapFromLabel(label: string): number {
  if (label === 'Unlimited') return 0
  const n = Number(label)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function framerateCapToLabel(cap: number): FramerateCapLabel {
  if (cap <= 0) return 'Unlimited'
  // Snap to the nearest supported label so a stored value (e.g. from a
  // future "Custom…" row) round-trips cleanly.
  const supported = [30, 60, 90, 120, 144]
  let best = supported[0]
  let bestDiff = Math.abs(cap - best!)
  for (const v of supported) {
    const d = Math.abs(cap - v)
    if (d < bestDiff) {
      best = v
      bestDiff = d
    }
  }
  return String(best) as FramerateCapLabel
}
