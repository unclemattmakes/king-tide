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
   * MK-style trick buttons. Held-state booleans; only rising edges count
   * (held does nothing). A press inside an open airborne trick window
   * (or in the 200 ms pre-press buffer leading up to a qualifying
   * takeoff) fires the credible trick: boost + spin + meter charge.
   * A press on flat ground with no qualifying context fires a small
   * courtesy lift (no boost). See `src/game/systems/trick-hop.ts`.
   */
  trickLeft: boolean
  trickRight: boolean
  /**
   * Snowboarder-tuck — held while moving forward, raises the bike's
   * effective top-speed cap, reduces lateral drag, trades away ~half the
   * steering authority. Pays off on descents/wave faces where gravity is
   * doing the work and a raised cap converts more KE into forward speed.
   * Stacks with boost. See `src/game/systems/hover.ts`.
   */
  tuck: boolean
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
    tuck: false,
  }
}
