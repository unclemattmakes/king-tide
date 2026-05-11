import { createWorld, type World } from 'bitecs'
import { createRng, type Rng } from '../rng'

export type SimWorld = World & {
  /** Sim-only PRNG. Anything in src/engine/sim or src/game/systems that
   *  needs randomness MUST use this — Math.random() in those layers
   *  breaks multiplayer determinism. */
  rng: Rng
}

export function createSimWorld(opts?: { seed?: number }): SimWorld {
  const world = createWorld() as SimWorld
  world.rng = createRng(opts?.seed ?? 0xc0ffee)
  return world
}
