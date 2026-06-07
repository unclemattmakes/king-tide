import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import type { SurfaceTypeValue } from '@/engine/sim/surface-types'

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
  /** Road centerline polyline, baked from `road_curve_main` at Blender
   *  export time. Drives bridge-support placement at runtime — the
   *  pillars only appear under sections where the road is genuinely
   *  elevated. Absent on tracks without an authored road (open-water
   *  courses, procedural tracks) — bridge supports are then skipped. */
  roadSpline?: RoadSpline
  /** Boost pads — speed-up volumes the bike triggers by driving over. */
  boostPads: BoostPad[]
  /** Anti-gravity zones — MK8-style sections where gravity points along the
   *  zone's local −Y (so the road surface acts as "down" instead of world
   *  down). Author rotates the zone box so its local floor lies flat on the
   *  road surface; the bike re-orients to that plane while inside. */
  antiGravZones: AntiGravZone[]
  /** Wave-mastery volume zones — oriented boxes that scale the global
   *  Gerstner wave amplitude / frequency inside the box, with an optional
   *  periodic surge (Aqualand tsunami) and swell-direction override. Soft
   *  edges via `blendRadiusM` so the boundary isn't visible. Required
   *  field; defaults to empty for tracks with uniform global seas. */
  waveZones: WaveZone[]
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
  /** Optional distant-horizon overrides. If absent, the runtime falls
   *  back to a procedural silhouette seeded off the track id hash —
   *  matches the historical look. Authors can either tune the procedural
   *  knobs here (radius, peakHeight, seed, silhouetteDark) or author a
   *  bespoke mesh in Blender — when a `kind=horizon` mesh ships inside
   *  `environmentGlb`, the runtime uses its geometry directly and these
   *  knobs only contribute `silhouetteDark`. */
  horizon?: HorizonConfig
  /** Optional terrain-shader knobs. Authored in the Blender addon panel and
   *  written into the JSON on export. The runtime applies these as uniforms
   *  when it builds the terrain material — see
   *  [terrain-shader.ts](../../engine/render/terrain-shader.ts). Absent
   *  → runtime defaults (matches the seeded Blender preview). */
  terrainShader?: TerrainShaderConfig
  /** Optional per-lap weather snapshots. Indexed by lap number (0 =
   *  starting weather, 1 = lap 1 target, ...). Each lap transition lerps
   *  cloudiness / sun-intensity / Beaufort wave-amplitude scale toward
   *  the next entry over `transitionSeconds`. Use for tracks where the
   *  weather changes during the race — Hatteras' storm rolling in, The
   *  Maw's swell building. Empty/absent → static weather matching the
   *  track's `sky` config. See [lap-weather.ts](../../engine/render/lap-weather.ts). */
  lapWeather?: LapWeather[]
  /** Optional per-track audio palette — licensed music slot + layered
   *  ambient bed. Editor-authored (or hand-edited in the JSON) because
   *  music is licensed/commissioned and not procedural. When absent,
   *  the procedural pad bed in the audio engine stays as the music
   *  fallback and only the global ambient water rumble plays. */
  audio?: AudioConfig
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
  /** World-Y of the water surface the wet band + underwater tint anchor to.
   *  Defaults to 0. Set from `track.water.height` at load so the damp-sand
   *  band and submerged tint sit at the real waterline on raised / sunken-
   *  water tracks instead of always at y=0. */
  waterLevel?: number
  /** RGB tint mixed in where the baked racing-line wear (COLOR_0.B) is
   *  high. Default [0.30, 0.24, 0.18] — packed-dirt brown. */
  pathTint?: [number, number, number]
  /** Strength of low-freq domain warping applied to the colour-noise
   *  UVs. 0 disables (stock noise); 0.5 = subtle organic veining;
   *  1.5+ = strong, painterly. Default 0.5. */
  warpStrength?: number
  /** World-space wavelength (m) of the macro biome variation that
   *  shifts saturation + altitude bands across large regions. Higher
   *  = larger biome patches. Default 120. */
  macroScale?: number
  /** World-space wavelength (m) of the micro detail noise. Drives the
   *  fine-grain brightness wobble that breaks the ramp banding. Default 8. */
  microScale?: number
  /** Vertical jitter (m) added to the altitude band per fragment so
   *  contour lines aren't perfectly level — gives natural feathering
   *  along the sand→grass / grass→rock transitions. Default 4. */
  altJitter?: number
  /** Width of the scree (intermediate-slope) band that introduces a
   *  gravel/rubble layer between the flat ramp and the cliff ramp.
   *  0 = hard cut, 0.4 = wide gravelly transition. Default 0.25. */
  screeBand?: number
  /** Output saturation multiplier in the linear-RGB → final pass.
   *  1 = neutral; >1 = punchier biome reads; <1 = washed/stylised.
   *  Default 1.05. */
  saturation?: number
  /** Blend factor between top-down (XZ-only) sampling of the noise
   *  and triplanar (XY+YZ+XZ) sampling. 0 = stock (cliffs stretch);
   *  1 = fully triplanar (cliffs read varied). Default 0.6. */
  triplanar?: number
  /** Strength (0..1) of the "waterline trio" shoreline banding stacked on
   *  the wet band, bottom→top: a new-life algae/coral fringe just below the
   *  line, a barnacle/verdigris crust at the line, and a salt-bleach strip
   *  just above. 0 disables (every non-coastal track stays byte-identical);
   *  1 = full. Default 0. */
  waterline?: number
}

export type PlayerStart = {
  position: Vec3
  /** Yaw in radians (0 = facing +Z, π/2 = facing +X). */
  yaw: number
  /** Optional bind to the main AI spline. If set, the loader derives
   *  `position` (xz) and `yaw` from the spline at parameter t (0..1 along
   *  the closed loop). The editor's translate gizmo then slides the start
   *  along the spline rather than allowing free placement, and the visual
   *  starting platform stays glued to the racing line as anchors move.
   *  Editing the curve auto-updates the start's pose. */
  splineT?: number
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

/**
 * Road centerline. A dense polyline baked at export time from the
 * `road_curve_main` Bezier curve in Blender's Road tool. Used by
 * `bridge-supports.ts` to know where to drop pillars under elevated
 * road sections; never sampled by gameplay (the AI follows
 * `aiSplines`, not this). Absent when the author hasn't run the Road
 * tool — bridge supports are then skipped entirely, which is the
 * desired behavior for open-water courses like the drowned-city
 * tracks where the racing line crosses water with no road slab.
 */
export type RoadSpline = {
  /** World-space samples of the road centerline, in three.js coords.
   *  May be open (point-to-point) or closed (loop); bridge-supports
   *  treats either case the same. */
  points: Vec3[]
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
  /** Optional per-anchor banking (rotation around the spline tangent in
   *  radians). 0 = world-up, ±π/2 = wall, ±π = upside-down ceiling.
   *  Loader interpolates to the dense `bankings` array. Anti-grav resolver
   *  uses this + the tangent to derive a smoothly-varying "up" vector
   *  along the curve — banked corners, wall sections, helixes, and loops
   *  fall out of the same authoring affordance. */
  anchorBankings?: number[]
  /** Loader-derived dense banking samples, one per `points[i]`. Linear
   *  interp of `anchorBankings` per segment. Absent on splines that
   *  don't participate in anti-grav. */
  bankings?: number[]
  /** Opt-in flag: when true (or when any `anchorBankings` entry is
   *  non-zero), the anti-grav system samples this spline per-tick to
   *  compute a curve-following gravity vector for bikes near it. */
  antiGrav?: boolean
  /** Distance (m) from the spline at which curve-following gravity
   *  fades back to world. Inside this radius the bike feels the curve's
   *  "down"; beyond it gravity returns to world-down. Default 8m. */
  antiGravFalloff?: number
}

export type BoostPad = {
  position: Vec3
  /** Pad orientation. Boost direction = rotation·(+Z), the same convention
   *  as checkpoint forward. */
  rotation: Quat
  /** Half-extent across the pad (m), perpendicular to boost direction. */
  halfWidth: number
  /** Half-extent along the pad-local +Y (vertical in the pad's frame).
   *  Pads are oriented boxes — a bike triggers the boost while its centre
   *  is inside the volume. Default 4 m on new pads; legacy tracks without
   *  an authored value get a generous band via json-loader
   *  (LEGACY_BOOST_PAD_HALF_HEIGHT) so the bike's hover height over a
   *  high-water surface still lands inside the volume. */
  halfHeight: number
  /** Half-extent along the boost direction (m). */
  halfDepth: number
  /** Multiplier applied to top speed while bike is on pad. 1.0 = no boost. */
  strength: number
}

/**
 * MK8-style anti-grav volume. While a bike's center is inside the oriented
 * box, gravity is replaced with `−rotation·(+Y) · GRAVITY` — i.e. the box's
 * local up axis defines "up" for the bike. The bike also receives a gentle
 * PD-aligned torque so its own +Y rotates onto the zone's up.
 *
 * Authoring: rotate the zone so its local floor lies flat on the road
 * surface. On a flat road, no rotation is needed; on a banked corner, yaw
 * to follow the road and roll/pitch so the box's local +Y matches the road
 * normal.
 */
export type AntiGravZone = {
  position: Vec3
  rotation: Quat
  /** Half-extent along the box's local X axis (m). */
  halfWidth: number
  /** Half-extent along the box's local Y axis (m). Defines how much vertical
   *  clearance the bike can have above/below the road plane and still count
   *  as "in the zone". */
  halfHeight: number
  /** Half-extent along the box's local Z axis (m). */
  halfDepth: number
}

/**
 * Per-track wave-field modifier. While a sample point's XZ projection is
 * inside the zone's oriented bounding box (vertical extent is generous and
 * mostly informational — y is rarely a useful gate for surface samples), the
 * global Gerstner amplitudes scale by `heightMult` and per-wave frequencies
 * scale by `freqMult`. An optional periodic surge term is added on top to
 * drive the Aqualand-style tsunami timer. Soft edges across `blendRadiusM`
 * keep the OBB face invisible; multi-zone overlaps use a soft-max so the
 * larger amplifier wins without a step at the seam.
 *
 * Authoring lives in Blender as `wave_zone_NN` empties; runtime evaluation
 * is in `wave-field.ts::sampleZoneFactors`.
 */
export type WaveZone = {
  position: Vec3
  rotation: Quat
  /** Half-extent along the box's local X axis (m). Also the axis the
   *  dominant swell aligns to when `directionDeg` is unset. */
  halfWidth: number
  /** Half-extent along the box's local Y axis (m). Vertical clearance —
   *  most surface sample callers ignore Y entirely, but kept for
   *  future bike-in-zone semantics (e.g. pump charge multipliers). */
  halfHeight: number
  /** Half-extent along the box's local Z axis (m). */
  halfDepth: number
  /** Multiplier on global wave amplitude inside the zone. 1 = neutral,
   *  >1 = heavier waves, <1 = calmer. Required positive. */
  heightMult: number
  /** Multiplier on per-wave frequency (1/wavelength) inside the zone.
   *  1 = neutral, >1 = shorter wavelengths (choppier), <1 = longer
   *  (rolling swells). Required positive. */
  freqMult: number
  /** Optional dominant swell-direction override in degrees, world-XZ.
   *  0° = +X swell train, 90° = +Z. When set, replaces the global
   *  `waveBearing` for samples inside this zone (with the same blend
   *  envelope as the multipliers). Leave undefined to inherit the
   *  global bearing. */
  directionDeg?: number
  /** Optional surge period in seconds. Combined with `surgeAmplitude`
   *  to add `surgeAmplitude * max(0, sin(2π·t / surgePeriodS))` to the
   *  zone's sampled height. Both must be set together. */
  surgePeriodS?: number
  /** Optional surge amplitude (m). See `surgePeriodS`. */
  surgeAmplitude?: number
  /** Soft-edge falloff distance, metres. The zone's blend weight
   *  smoothsteps from 0 (outside this distance from the box surface)
   *  to 1 (inside the box). Keeps amplitude continuous across the OBB
   *  face. Required positive. */
  blendRadiusM: number
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
  /** Optional surface material tag — `'default' | 'asphalt' | 'sand' |
   *  'ice' | 'metal' | 'water'`. The runtime registers the prop's
   *  collider in the surface registry so the hover/drift physics scales
   *  grip by the material. Absent → DEFAULT (grippy, no behaviour
   *  change). See `engine/sim/surface-types.ts`. */
  surface?: SurfaceTypeValue
  /** Animated-prop opt-in. When `true` AND the referenced asset GLB ships
   *  skeletal animation clips (a rigged `SkinnedMesh`), the placement is
   *  routed to the animated-prop render path
   *  (`engine/render/animated-props.ts`): the GLB is skeleton-cloned per
   *  instance, given a `THREE.AnimationMixer`, and ticked each frame.
   *  Animated props are render-only decoration — no collider, no sim
   *  coupling — so they're skipped by `createPropsMesh` /
   *  `createPropColliders`. Ignored for non-asset props or assets with no
   *  clips (those fall back to the static instanced path). */
  animated?: boolean
  /** Which animation clip to play, by name (exact, else case-insensitive
   *  substring). Defaults to the GLB's first clip — robust for the
   *  one-clip-per-asset Quaternius fish whose clip is named
   *  `Armature|Armature|Swim`. Only meaningful with `animated: true`. */
  clip?: string
  /** Loop the clip (default `true`). Set `false` to play once and hold
   *  the final pose. Only meaningful with `animated: true`. */
  loop?: boolean
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
 * Per-lap weather snapshot. Position N in `Track.lapWeather` is the target
 * state the runtime lerps toward when lap N starts. Entry 0 (if present)
 * overrides the boot state; subsequent entries describe later laps.
 *
 *   cloudiness    — 0..1 sky cloud-cover (and shadow strength on terrain).
 *                   Replaces `track.sky.cloudiness` for this lap onward.
 *   beaufort      — 0..12 Beaufort wind scale. Sets the live wave
 *                   amplitude relative to the per-track seed baseline
 *                   (the boot-time Beaufort sets that baseline; per-lap
 *                   beaufort scales it up or down). Higher = stormier.
 *   sunIntensity  — multiplier on the directional sun. Drop toward
 *                   0.3-0.5 for "the storm just rolled over the sun".
 *   transitionSeconds — seconds to lerp the previous state to this
 *                   entry's target. Default 5 s. Applied on lap entry.
 */
export type LapWeather = {
  cloudiness?: number
  beaufort?: number
  sunIntensity?: number
  transitionSeconds?: number
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
 *   colorGrade     — LUT preset name from the bundled set
 *                    (`SKY_COLOR_GRADES`). Drives a per-preset ramp /
 *                    saturation / contrast tweak on the sky shader (no
 *                    image LUTs yet). `'neutral'` is a no-op. Defaults
 *                    to `'neutral'`.
 *   bloom          — 0..2 intensity multiplier on the renderer's bloom
 *                    pass (the WebGPU post-pipeline; see
 *                    `engine/render/post-pipeline.ts`). Defaults to 0 = off.
 *                    Typical authored ranges: 0.2–0.4 daytime, 0.4–0.7
 *                    sunset / overcast, 0.7–1.0 neon / night, 1.0+ for
 *                    extreme bloom-driven looks (use with care — bright
 *                    skies can saturate the framebuffer past ~1.2).
 *   seaStateBeaufort — 0..12 Beaufort wind scale. Drives a single
 *                    amplitude multiplier on the wave field at boot
 *                    (see `beaufortToAmplitudeScale`). Defaults to
 *                    `undefined` = leave the wave field untouched
 *                    (i.e. Beaufort ≈4 / 1.0× — current shipping look).
 *   toneMapping    — Three.js tone-mapping curve name. The renderer's
 *                    default is `'aces_filmic'`; per-track overrides
 *                    let the cup match its palette (e.g. AgX for
 *                    Big-Sur golden hour, neutral for crisp daylight,
 *                    aces_filmic for high-contrast neon).
 */
/**
 * Volumetric toy-cumulus field — discrete low-poly cloud blobs placed at
 * altitude that parallax against the world and drift on the wind. This is a
 * separate layer from the dome's painted `cloudiness` band (which stays for
 * far haze / high cirrus): the dome can't give the *volume* and *parallax*
 * of the chonky cumulus in the concept art, so a placed mesh field carries
 * the hero clouds and the dome carries the backdrop.
 *
 * Absent (or `count: 0`) → no hero clouds, i.e. the existing-track look is
 * unchanged. A track opts in by supplying a `clouds` block. All fields are
 * optional with runtime defaults; see `createCloudLayer` in
 * `engine/render/clouds.ts`.
 */
export type CloudFieldConfig = {
  /** Number of cloud blobs in the field. 0 / absent → layer off entirely. */
  count?: number
  /** Altitude (metres) the cloud masses are centred on. Default 320. */
  altitude?: number
  /** ± vertical jitter around `altitude`, metres. Default 70. */
  altitudeJitter?: number
  /** Half-extent (metres) of the camera-locked scatter torus the field
   *  drifts through. Larger → clouds spread further out toward the horizon.
   *  Default 1100. */
  spreadRadius?: number
  /** Min/max scale of a blob in metres (a blob is authored ~1 unit wide).
   *  This is the dominant "how big do the clouds feel" lever. The field
   *  size-grades within this range, skewing the biggest masses toward the
   *  horizon so they read as a towering cumulus skyline. Default [150, 380]. */
  scaleRange?: [number, number]
  /** Vertical towering, 0..~1.5. Stretches the largest masses upward into
   *  cumulonimbus columns (small fair-weather puffs stay rounded), for the
   *  big billowing towers the concept art is built around. 0 = no stretch
   *  (every blob keeps its authored aspect). Default 0.4. */
  towering?: number
  /** Wind drift in (x, z) metres per second. Default { x: 1, z: 0.2 } to
   *  match the foliage wind so cloud / sea / foliage drift stay coherent. */
  wind?: { x: number; z: number }
  /** Directional-light strength on the clouds, 0..1. 1 = full sun-wrap +
   *  sun-lit-crown highlight (sunny-cumulus pop, default). 0 = flat ambient —
   *  only the vertical base→crown gradient survives — for an overcast look
   *  where there's no directional sun. Default 1. */
  sunPop?: number
  /** Number of distinct blob silhouettes to author. Default 4. */
  variants?: number
  /** Shadowed-base colour (hex, sRGB). Default a cool blue-grey. */
  coolBase?: string
  /** Sun-lit crown colour (hex, sRGB). Default a warm white. */
  warmTop?: string
  /** PRNG seed for blob shapes + scatter — fixed so captures reproduce.
   *  Default 1337. */
  seed?: number
}

export type SkyConfig = {
  tint?: string
  cloudiness?: number
  sunIntensity?: number
  fogNear?: number
  fogFar?: number
  timeOfDay?: number
  colorGrade?: SkyColorGrade
  bloom?: number
  seaStateBeaufort?: number
  toneMapping?: SkyToneMapping
  /** Hero cumulus field — discrete low-poly cloud meshes at altitude.
   *  Absent → no hero clouds (existing look). See {@link CloudFieldConfig}. */
  clouds?: CloudFieldConfig
  /** 0..1 — how billowy/towering the clouds read. 0 = flat overcast band
   *  (legacy look); higher pushes domain-warped cauliflower cumulus with
   *  cheap self-shadow volume lighting. Pure dome-shader cost. */
  cloudTowering?: number
  /** Sun disc + corona angular size multiplier. 1 = tight ~1° disc
   *  (legacy); larger gives a big dramatic low sun with a warm corona,
   *  e.g. finale / sunset tracks. */
  sunSize?: number
  /** Full-scene cel/ink outline (post-pipeline Sobel edge darkening). Off
   *  by default; a track opts in for the Wind-Waker ink-line look. See
   *  `OutlineOptions` in `engine/render/post-pipeline.ts`. */
  outline?: {
    enabled?: boolean
    /** Ink darkness 0..1 at a full edge. Default 0.85. */
    strength?: number
    /** Ink line colour (hex). Default near-black. */
    color?: number
    /** Sobel magnitude below this reads as flat. Default 0.1. */
    threshold?: number
    /** Sobel magnitude at/above this is a full line. Default 0.4. */
    softness?: number
  }
  /** Velocity-buffer motion blur (post-pipeline). Off by default; a track
   *  opts in for a stronger speed sensation. Enabling it grows the scene
   *  pass with a velocity MRT. See `MotionBlurOptions` in
   *  `engine/render/post-pipeline.ts`. */
  motionBlur?: {
    enabled?: boolean
    /** Sample count along the velocity vector. Default 16. */
    samples?: number
  }
}

/**
 * Bundled tone-mapping curve names. Mirror of the cases in
 * `applySkyToneMapping` (in `engine/render/sky.ts`). Adding a new
 * preset is one entry here + one mapping case + one JSON-loader
 * accept; the unit-tested round-trip will catch drift.
 */
export const SKY_TONE_MAPPINGS = [
  'neutral', // THREE.NeutralToneMapping — flat / crisp daylight
  'aces_filmic', // THREE.ACESFilmicToneMapping — punchy, default
  'agx', // THREE.AgXToneMapping — soft roll-off, golden hour
  'reinhard', // THREE.ReinhardToneMapping — vintage, low contrast
  'cineon', // THREE.CineonToneMapping — film-emulation cold
] as const

export type SkyToneMapping = (typeof SKY_TONE_MAPPINGS)[number]

/**
 * Bundled color-grade preset names. The runtime sky shader maps each to
 * a per-preset (ramp tint, saturation, contrast) triple — no actual LUT
 * image is sampled; this stays a tight set of shader-uniform tweaks so
 * the renderer doesn't pay a texture read per fragment for the dome.
 *
 * Authoring lives in the Blender addon's Sky preset sub-panel; the
 * names round-trip through `public/tracks/<id>.json`.
 */
export type SkyColorGrade =
  | 'neutral'
  | 'miami_pastel'
  | 'mexico_city_rosa'
  | 'tokyo_neon'
  | 'big_sur_golden'
  | 'venice_warm'
  | 'nyc_sunset'
  | 'cape_town_blue'
  | 'kilauea_volcanic'

export const SKY_COLOR_GRADES: readonly SkyColorGrade[] = [
  'neutral',
  'miami_pastel',
  'mexico_city_rosa',
  'tokyo_neon',
  'big_sur_golden',
  'venice_warm',
  'nyc_sunset',
  'cape_town_blue',
  'kilauea_volcanic',
] as const

/**
 * Per-track distant-horizon overrides. All fields optional; absent fields
 * fall back to the defaults baked into
 * [horizon-ring.ts](../../engine/render/horizon-ring.ts) (radius 1400,
 * peakHeight 300, seed hashed from the track id, silhouetteDark 0.45).
 *
 *   radius          — ring radius in metres. Far enough that bike
 *                     traverse parallax is negligible, close enough to
 *                     survive the scene fog. Default 1400.
 *   peakHeight      — max silhouette peak above y=0, in metres. Drives
 *                     how big "distant mountains" feel. Default 300.
 *   seed            — PRNG seed for the procedural fallback's layered-
 *                     sine shape. Ignored when the GLB ships a
 *                     `kind=horizon` mesh. If absent, the runtime hashes
 *                     the track id so every track is procedurally
 *                     distinct without authoring.
 *   silhouetteDark  — 0..1 multiplier on the horizon colour applied at
 *                     peak tops. < 1 = darker silhouette; > 1 lifts
 *                     toward a haze read. Default 0.45.
 *
 * Authoring lives in two places: knobs in the Blender addon's Horizon
 * sub-panel write here; a bespoke mesh authored via *Add Horizon Ring*
 * lives in the GLB with `kind=horizon` and wins when present.
 */
export type HorizonConfig = {
  radius?: number
  peakHeight?: number
  seed?: number
  silhouetteDark?: number
}

/**
 * Per-track audio palette. All fields optional; absent fields fall
 * back to the procedural music bed + global ambient rumble baked into
 * [audio.ts](../../engine/audio/audio.ts). Paths target real files
 * under `public/audio/music/` and `public/audio/ambient/`; missing
 * files load gracefully (warned, never crashed) so the schema can
 * ship ahead of licensed assets.
 *
 *   music             — basename under `public/audio/music/` (e.g.
 *                       "south-beach-vaporwave.opus"). When present
 *                       and the file is reachable, the licensed track
 *                       plays on the music bus and the procedural pad
 *                       bed is silenced. When absent (or 404), the
 *                       procedural pad bed continues as the fallback.
 *   ambient           — array of basenames under `public/audio/ambient/`
 *                       (e.g. ["gulls.opus", "surf-light.opus"]).
 *                       Each layer loops on the ambient bus
 *                       simultaneously. Empty/absent → only the
 *                       global procedural water rumble plays.
 *   ambientGains      — per-layer gain multipliers in [0, …). Same
 *                       length as `ambient`; missing entries default
 *                       to 1.0. Lets authors tune per-track layer
 *                       balance (gulls louder than surf, etc.).
 *   music3dEffects.duckOnPump — multiplier on the default 0.35 amount
 *                       the music bus dips when a wave pump fires.
 *                       Heavier music wants a deeper duck so the
 *                       chime still cuts through. Default 1.0
 *                       (= use the engine's base 0.35).
 */
export type AudioConfig = {
  music?: string
  ambient?: string[]
  ambientGains?: number[]
  music3dEffects?: {
    duckOnPump?: number
  }
}
