import type { Quat, Vec3 } from '@/engine/sim/physics/vec'

/**
 * A track. Authored either procedurally (M3) or from a Blender .glb (later).
 * Loaders for both sources resolve to the same Track shape so the runtime
 * doesn't care where it came from.
 */
export type Track = {
  id: string
  name: string
  start: PlayerStart
  /** Ordered. Player must cross all in order, then start again, to count a lap. */
  checkpoints: Checkpoint[]
  /** Number of laps to finish the race. */
  lapsToFinish: number
  /** Optional terrain/track surface meshes — flat-water tracks have none. */
  surfaces: TrackSurface[]
  /** Pickup spawn points (M5). */
  pickupSpawns: Vec3[]
  /** AI splines (M4). The 'main' branch is the canonical racing line. */
  aiSplines: AISpline[]
}

export type PlayerStart = {
  position: Vec3
  /** Yaw in radians (0 = facing +Z, π/2 = facing +X). */
  yaw: number
}

export type Checkpoint = {
  /** 0-based, contiguous, cp_00..cp_(N-1). */
  index: number
  position: Vec3
  /** Gate orientation. The "forward through gate" direction is rotation·(+Z). */
  rotation: Quat
  /** Half-width of the gate (m). */
  halfWidth: number
  /** Height of the gate (m). */
  height: number
}

export type TrackSurface = {
  id: string
  // M3: no procedural surfaces yet — the existing island + water carry us.
  // Future: { meshData, collider } for arbitrary glTF meshes.
}

export type AISpline = {
  id: string
  /** Loop-closed sequence of points along the racing line. */
  points: Vec3[]
}
