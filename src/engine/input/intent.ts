export type Intent = {
  throttle: number // -1..1 (negative = reverse)
  steer: number // -1..1 (negative = left)
  brake: number // 0..1
  fire: boolean
  boost: boolean
  /**
   * -1..1. Positive = nose UP / lift (jump off a wave, climb in air).
   * Negative = nose DOWN / dive into wave.
   * Convention set by M9.18 follow-up — hover.ts vectors air thrust along
   * the bike's nose, so positive pitch produces upward acceleration.
   */
  pitch: number
  /**
   * MK8-style hop-trick buttons. Held-state booleans; the rising edge fires
   * a vertical hop impulse + visual Y-rotation overlay (left = CCW from
   * above, right = CW). Holding does nothing — only fresh presses count.
   * If a trick edge lands inside the crest-apex window, the observer
   * grants the boost reward on landing.
   */
  trickLeft: boolean
  trickRight: boolean
}

export function emptyIntent(): Intent {
  return {
    throttle: 0,
    steer: 0,
    brake: 0,
    fire: false,
    boost: false,
    pitch: 0,
    trickLeft: false,
    trickRight: false,
  }
}
