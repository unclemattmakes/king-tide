/**
 * Seeded pseudo-random generator for the sim layer.
 *
 * Math.random() is forbidden anywhere the sim reads from, because future
 * multiplayer lockstep requires that two clients given the same seed +
 * inputs produce bit-identical state. The PRNG state itself is part of
 * world state — snapshot it with state() / setState() for rollback or
 * desync hashing.
 *
 * Algorithm: mulberry32. Single uint32 state, ~2^32 period, ~3 ns/call.
 * For a 5-minute race at 60 Hz with ~10 rolls/tick the budget is ~180k
 * rolls << 2^32, well within period.
 */
export type Rng = {
  /** Uniform float in [0, 1). */
  next(): number
  /** Uniform integer in [0, max). max must be positive. */
  nextInt(max: number): number
  /** Snapshot the internal state (for rollback / desync hash). */
  state(): number
  /** Restore from a snapshot taken by state(). */
  setState(s: number): void
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0
  // mulberry32 degenerates to all-zero output if seeded with 0.
  if (s === 0) s = 0x12345678
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    nextInt: (max) => Math.floor(next() * max),
    state: () => s,
    setState: (ns) => {
      s = ns >>> 0
      if (s === 0) s = 0x12345678
    },
  }
}
