import { createWorld, type World } from 'bitecs'

export type SimWorld = World

export function createSimWorld(): SimWorld {
  return createWorld()
}
