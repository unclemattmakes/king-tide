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
}

export function emptyIntent(): Intent {
  return { throttle: 0, steer: 0, brake: 0, fire: false, boost: false, pitch: 0 }
}
