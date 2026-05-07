export type Intent = {
  throttle: number // -1..1 (negative = reverse)
  steer: number // -1..1 (negative = left)
  brake: number // 0..1
  fire: boolean
  boost: boolean
}

export function emptyIntent(): Intent {
  return { throttle: 0, steer: 0, brake: 0, fire: false, boost: false }
}
