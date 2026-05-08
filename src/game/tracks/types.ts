import type { Quat, Vec3 } from '@/engine/sim/physics/vec'

/**
 * A track. Authored three ways, all resolving to this shape:
 *  - **Procedural** in code (Lagoon Loop, Cliffside) — geometry baked in.
 *  - **JSON** under `tracks-src/<id>.json` — gameplay data (gates, splines,
 *    pickups, boost pads) authored in the in-app editor, optional reference
 *    to an environment `.glb` for collidable terrain authored in Blender.
 *  - **Pure .glb** — legacy path used by the M9.16 calibration scene.
 *    Metadata in node extras carries gates / spline / etc. Still supported
 *    but the JSON path is preferred for new tracks.
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
  /** Boost pads — speed-up volumes the bike triggers by driving over. */
  boostPads: BoostPad[]
  /** Optional .glb URL for collidable environment geometry. JSON-authored
   *  tracks reference a Blender-exported asset here; the runtime loads it
   *  via the render-side glb loader and registers static colliders. */
  environmentGlb?: string
  /** Optional water tuning. If absent, the runtime defaults are used. */
  water?: WaterConfig
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

export type BoostPad = {
  position: Vec3
  /** Pad orientation. Boost direction = rotation·(+Z), the same convention
   *  as checkpoint forward. */
  rotation: Quat
  /** Half-extent across the pad (m). */
  halfWidth: number
  /** Half-extent along the boost direction (m). */
  halfDepth: number
  /** Multiplier applied to top speed while bike is on pad. 1.0 = no boost. */
  strength: number
}

export type WaterConfig = {
  /** Mean water surface y (m). 0 by default. */
  height: number
  /** Wave amplitude scalar passed to the wave field. */
  waveHeight: number
  /** Wave frequency scalar passed to the wave field. */
  waveFreq: number
}
