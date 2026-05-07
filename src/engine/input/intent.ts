export type Intent = {
  throttle: number // -1..1 (negative = reverse)
  steer: number // -1..1 (negative = left)
  brake: number // 0..1
  fire: boolean
  boost: boolean
  /** -1..1. Positive = nose down (dive into wave). Negative = nose up (jump off wave). */
  pitch: number
}

export function emptyIntent(): Intent {
  return { throttle: 0, steer: 0, brake: 0, fire: false, boost: false, pitch: 0 }
}
