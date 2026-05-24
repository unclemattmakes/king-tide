import RAPIER from '@dimforge/rapier3d-compat'
import { createSurfaceRegistry, type SurfaceRegistry } from '@/engine/sim/surface-types'

export type RapierAPI = typeof RAPIER

export type PhysicsWorld = {
  rapier: RapierAPI
  world: RAPIER.World
  step(): void
  fixedDt: number
  /** Collider → surface-type tags for the live track. Tagged at
   *  collider creation (props / GLB track meshes); read by the hover
   *  probe to set `HoverState.surfaceType`. Scoped to this world, so
   *  it dies with the world each race. */
  surfaces: SurfaceRegistry
}

let initPromise: Promise<void> | null = null

function initRapierOnce(): Promise<void> {
  if (!initPromise) initPromise = RAPIER.init()
  return initPromise
}

const FIXED_DT = 1 / 60

export async function createPhysicsWorld(opts?: { gravity?: number }): Promise<PhysicsWorld> {
  await initRapierOnce()
  const gravity = opts?.gravity ?? -25 // arcade gravity (real is -9.81)
  const world = new RAPIER.World({ x: 0, y: gravity, z: 0 })
  world.timestep = FIXED_DT
  return {
    rapier: RAPIER,
    world,
    step: () => world.step(),
    fixedDt: FIXED_DT,
    surfaces: createSurfaceRegistry(),
  }
}
