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
  /** Target gate spacing in metres, used by the editor's "Auto-place gates
   *  from spline" action and Blender's gate-preview overlay. The actual
   *  count is rounded to fit the closed-loop arc length cleanly; see
   *  `gate-placement.ts` for the algorithm. Defaults to
   *  `DEFAULT_GATE_SPACING_M` when absent from the JSON. */
  gateSpacing?: number
  /** Editor-authored static props (boxes, pipes, half-pipes, etc).
   *  Rendered + collidable at runtime. Empty for procedural tracks. */
  props: Prop[]
  /** Optional .glb URL for collidable environment geometry. JSON-authored
   *  tracks reference a Blender-exported asset here; the runtime loads it
   *  via the render-side glb loader and registers static colliders. */
  environmentGlb?: string
  /** Optional water tuning. If absent, the runtime defaults are used. */
  water?: WaterConfig
  /** Optional sky / atmosphere tuning. If absent, the runtime defaults are used. */
  sky?: SkyConfig
  /** Optional terrain-shader knobs. Authored in the Blender addon panel and
   *  written into the JSON on export. The runtime applies these as uniforms
   *  when it builds the terrain material — see
   *  [terrain-shader.ts](../../engine/render/terrain-shader.ts). Absent
   *  → runtime defaults (matches the seeded Blender preview). */
  terrainShader?: TerrainShaderConfig
}

/**
 * Author-tunable knobs on the runtime slope/altitude terrain shader. All
 * fields optional — missing fields fall back to the constants baked into
 * ``terrain-shader.ts``. See the addon panel "Terrain shader (runtime)"
 * box in [hoverbike_addon.py](../../../tools/blender/hoverbike_addon.py)
 * for the authoring side.
 */
export type TerrainShaderConfig = {
  /** World-Y mapped to ramp position 0 (deepest abyssal blue). Default -50. */
  altMin?: number
  /** World-Y mapped to ramp position 1 (volcanic top). Default 120. */
  altMax?: number
  /** Cos of slope angle below which terrain uses the flat (sand/grass)
   *  ramp. Default 0.85 ≈ 30°. */
  slopeStart?: number
  /** Cos of slope angle above which terrain uses the cliff (rock) ramp.
   *  Default 0.55 ≈ 55°. */
  slopeEnd?: number
  /** ±brightness variation from the per-vertex value noise. Default 0.30. */
  variation?: number
  /** Half-height (m) of the |y|-mask wet-band darken around the waterline.
   *  Default 2.0. */
  wetBand?: number
  /** RGB tint mixed in where the baked racing-line wear (COLOR_0.B) is
   *  high. Default [0.30, 0.24, 0.18] — packed-dirt brown. */
  pathTint?: [number, number, number]
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
  /** Optional bind to the main AI spline. If set, the loader derives
   *  `position` and `rotation` from the spline at parameter t (0..1
   *  along the closed loop). The editor's translate gizmo then slides
   *  the gate along the spline rather than allowing free placement.
   *  Editing the curve auto-updates the gate's pose. */
  splineT?: number
}

export type TrackSurface = {
  id: string
  // M3: no procedural surfaces yet — the existing island + water carry us.
  // Future: { meshData, collider } for arbitrary glTF meshes.
}

export type AISpline = {
  id: string
  /** Loop-closed dense polyline along the racing line. The runtime AI
   *  controller follows this directly. */
  points: Vec3[]
  /** Optional sparse control points. When present, the loader samples
   *  these via Catmull-Rom into `points` at load time and the editor
   *  edits these (not the dense samples). Drag an anchor to reshape
   *  the curve. The dense `points` array is regenerated on save. */
  anchors?: Vec3[]
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

/**
 * Editor-authored static prop. The `type` discriminator decides how `size`
 * is interpreted and what mesh + collider the runtime builds.
 *
 *   - `box`       → cuboid. size = { halfWidth, halfHeight, halfDepth }
 *   - `sphere`    → ball.   size.x = radius (y, z unused)
 *   - `cylinder`  → solid cylinder. size = { radius, halfHeight, _unused }
 *   - `pipe`      → hollow tube. size = { outerRadius, halfHeight, wallThickness }
 *   - `halfpipe`  → upper half removed (open-top tube ridable from inside).
 *                   size = { outerRadius, halfHeight, wallThickness }
 *
 * The cylinder's local axis is +Y. Pipe / halfpipe are oriented so the
 * tube runs along local +Z (drive-through axis); their "open" face for
 * halfpipe is +Y (sky).
 */
export type Prop = {
  type: PropType
  position: Vec3
  rotation: Quat
  size: Vec3
  /** Optional hex tint for the rendered mesh, e.g. "#88ccff". */
  color?: string
  /** Asset-prop reference. When set, the runtime ignores `type/size/color`
   *  and instantiates from `public/assets/props/<assetId>.glb` instead.
   *  Sourced from the asset manifest (built by `pnpm gen:props`). */
  assetId?: string
}

export type PropType = 'box' | 'sphere' | 'cylinder' | 'pipe' | 'halfpipe' | 'asset'

export type WaterConfig = {
  /** Mean water surface y (m). 0 by default. */
  height: number
  /** Wave amplitude scalar passed to the wave field. */
  waveHeight: number
  /** Wave frequency scalar passed to the wave field. */
  waveFreq: number
}

/**
 * Per-track sky / atmosphere overrides. All fields optional — the sky system
 * fills in defaults from `DEFAULT_SKY_CONFIG`. Authoring lives alongside
 * `water` in `tracks-src/<id>.json`.
 *
 *   tint           — hex string (e.g. "#ffe4c4") multiplied onto the base
 *                    palette. Use to bias a track warm/cool without rewriting
 *                    the palette ramps. Defaults to white (no tint).
 *   cloudiness     — 0..1. 0 = clear sky, 1 = solid overcast. Default 0.45.
 *   sunIntensity   — multiplier on the directional sun-light intensity and
 *                    sun-disc brightness in the dome shader. Default 1.0.
 *   fogNear/fogFar — exponential fog distances in metres. Defaults 250/900,
 *                    matching the historical horizon blend.
 *   timeOfDay      — seconds into the sky system's 360 s day-night cycle. The
 *                    sun is positioned once at level load and held there for
 *                    the whole race (so the env-map bake stays one-shot and
 *                    we don't hitch every few seconds). Default 0 ≈ a high
 *                    mid-morning sun. See sky.ts for the elevation/azimuth math.
 */
export type SkyConfig = {
  tint?: string
  cloudiness?: number
  sunIntensity?: number
  fogNear?: number
  fogFar?: number
  timeOfDay?: number
}
