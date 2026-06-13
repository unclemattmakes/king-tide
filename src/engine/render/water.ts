import * as THREE from 'three'
import {
  abs,
  cameraFar,
  cameraNear,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  Fn,
  float,
  floor,
  fract,
  fwidth,
  If,
  int,
  Loop,
  max,
  min,
  mix,
  normalize,
  perspectiveDepthToViewZ,
  positionLocal,
  positionView,
  positionWorld,
  pow,
  reflector,
  screenUV,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import {
  CONTOUR_DASH_SPEC,
  FOAM_STROKE_MASS_SPEC,
  FOAM_STROKE_STREAK_SPEC,
  packSheetRGBA8,
  rasterizeContourDashRows,
  rasterizeOilStrokeSheet,
  WAKE_STROKE_SPEC,
} from '@/engine/render/oil-stroke-texture'
import { getActiveQuality } from '@/engine/render/quality-preset'
import { TERRAIN_HEIGHTMAP_RESOLUTION } from '@/engine/render/terrain-heightmap'
// Waterline obstacle contacts — foam collars around pillars/rocks/pylons.
// Render-only shading (no displacement), so no buoyancy mirror is needed.
import {
  MAX_WATER_CONTACTS,
  selectNearestContacts,
  type WaterContact,
} from '@/engine/render/water-contacts'
import {
  MAX_SPLASH_RINGS,
  SPLASH_RING_LIFE_S,
  SPLASH_RING_SPEED,
  SPLASH_RING_WIDTH,
  // Ring waveform constants + the CPU sampler (renderVertex mirror) —
  // single source, drift-tested like the SHORE_*/STAMP_* sets.
  sampleSplashRings,
} from '@/engine/sim/water/splash-rings'
// Trail recording rules — sim-owned (`field.trails` is fed by
// wakeUpdateSystem; this module only uploads + mirrors the profile in TSL).
// Imported, never re-declared, so the GPU segment loop can't drift from the
// CPU buoyancy sampler.
import {
  MAX_WAKE_TRAILS,
  WAKE_AGE_TAU,
  WAKE_TRAIL_MAX_SEG,
  WAKE_TRAIL_POINTS,
} from '@/engine/sim/water/wake-trail'
import {
  // Shipped-look per-band amplitude scales — the menu defaults below use
  // these so the spectrum generator's pre-divide (spectrum.ts) can never
  // drift from what boot applies.
  DEFAULT_CHOP_TUNING_SCALE,
  DEFAULT_SWELL_TUNING_SCALE,
  effectiveSteepness,
  // Stamp + zone caps shared with the CPU sampler (the setters truncate to
  // them; the uniform arrays below are sized by them). Drift-tested.
  MAX_WAVE_STAMPS,
  MAX_WAVE_ZONES,
  // Shore-aligned wave + shoaling constants — single source of truth shared
  // with the CPU buoyancy sampler. `tests/unit/shore-constants-drift.test.ts`
  // enforces that this shader imports them rather than re-declaring literals.
  SHOAL_BREAK_GAMMA,
  SHOAL_FADE_DEPTH,
  SHOAL_GAIN_MAX,
  SHOAL_GREEN_REF_DEPTH,
  SHOAL_HEFF_MIN,
  SHORE_AMP,
  SHORE_ASYM,
  SHORE_ASYM_PHASE,
  SHORE_BAND_DEPTH,
  SHORE_DEPTH_CAP,
  SHORE_K,
  SHORE_OMEGA,
  SHORE_PHASE,
  SHORE_SWELL_DRIVE_MAX,
  SHORE_SWELL_DRIVE_MIN,
  SHORE_SWELL_DRIVE_REF,
  STAMP_DEPTH_CAP,
  STAMP_END_FEATHER_M,
  STAMP_RELEASE_RATIO,
  // Swell/chop wavelength threshold — the SWELL_INDICES subset below is
  // derived from it per bank (per-track spectrum banks reorder/resize the
  // wave list, so hardcoded indices would silently mistag).
  SWELL_WAVELENGTH_MIN,
  // CPU stamp sampler — the `renderVertex` mirror adds the authored
  // stamps the vertex stage draws.
  sampleStampsAt,
  // CPU zone-factor blend — used by the `renderVertex` CPU mirror so the
  // diagnostic stays an exact twin of the vertex stage. The shader itself
  // re-implements the same math in TSL (`waveZoneFactors`).
  sampleZoneFactors,
  // CPU shoal factor — used by the `renderVertex` CPU mirror so the
  // diagnostic models the same shallow-water attenuation the vertex
  // stage applies (the shader mirrors the math in TSL above).
  shoalAttenuation,
  WAKE_BASE_WIDTH,
  WAKE_DISP_AMP,
  WAKE_EDGE_BELL_HALFWIDTH,
  WAKE_HALF_ANGLE_TAN,
  WAKE_LONG_DECAY,
  WAKE_LONG_RAMP,
  WAKE_SPEED_HIGH,
  WAKE_SPEED_LOW,
  WAKE_TRANS_AMP,
  WAKE_TRANS_K,
  WAKE_TRANS_OMEGA,
  type WaveFieldState,
  type WaveStampRuntime,
  type WaveZoneRuntime,
} from '@/engine/sim/water/wave-field'

/**
 * Per-frame data describing how a bike pushes/marks the water.
 * - x, z: world position of the hull on the XZ plane
 * - vx, vz: horizontal velocity (used for wake direction + length)
 * - weight: 0..1, fades the effect when the bike is airborne / far above
 *   the surface. Inactive bikes (weight ~ 0) are parked at distance ∞ in
 *   the shader so their Gaussian dimple + wake contribute nothing.
 */
export type BikeImpact = {
  x: number
  z: number
  vx: number
  vz: number
  weight: number
}

/**
 * Opt-in camera layer for the planar-reflection pass. The mirror's virtual
 * camera renders ONLY this layer (see `configureReflectionCulling`): the sky
 * dome opts in at creation (sky.ts) and terrain/landmark-scale meshes opt in
 * via track-loader's size gate. Everything else — props, bikes, FX, small
 * dressing, late-streamed scenery — stays mirror-invisible by default, which
 * is what keeps the reflection pass from re-encoding the whole scene
 * (~98 extra draw calls on sandbar pre-cull; the water-ablation headline).
 * Objects keep layer 0, so main cameras are unaffected.
 */
export const WATER_REFLECTION_LAYER = 1

export type WaterMesh = {
  mesh: THREE.Mesh
  /**
   * Updates the time uniform from the field clock and pushes per-bike
   * impact data into the shader's uniform array. Pass `originXZ` (the
   * camera's XZ position) to lock the mesh to the camera so vertex
   * density tracks the visible region. Pass an empty / omitted impacts
   * array (e.g. in editor mode) to leave the surface clean.
   */
  tick(impacts?: readonly BikeImpact[], originXZ?: { x: number; z: number }): void
  /**
   * Updates the water shader's sun-direction uniform from a world-space
   * sun position (typically the directional light's position). The
   * vector is normalized internally; pass either a position or already-
   * normalized direction. Used by the day-night cycle in `main.ts` to
   * keep the water's sun-glow + scatter blend in sync with the moving
   * directional light.
   */
  setSunDirection(x: number, y: number, z: number): void
  /**
   * Updates the horizon-haze color used for the aerial-perspective fade
   * at long view distances. The sky module calls this each tick with the
   * current palette horizon color so distant water naturally picks up
   * sunset / dawn warmth, twilight blue, etc. — keeps the horizon line
   * in tonal harmony with the sky behind it instead of reading as a
   * fixed teal-grey haze. RGB values are linear, in [0, 1].
   */
  setHorizonColor(r: number, g: number, b: number): void
  /** Install the track's terrain heightmap. The shader uses it to attenuate
   *  wave displacement in shallow water (so crests stop clipping through
   *  the seabed and shoreline geometry) and to drive depth-driven surf
   *  foam at the waterline. Call once per track load after the GLB /
   *  procedural terrain is in place. The water shader's behaviour is
   *  unchanged for tracks where no heightmap is installed (e.g. editor
   *  mode) — wave amplitude stays at full strength everywhere. */
  setTerrainHeightmap(heightmap: import('./terrain-heightmap').TerrainHeightmap): void
  /** Install / replace the waterline obstacle contacts (pillars, rocks,
   *  pylons — see water-contacts.ts). The shader draws a wave-modulated foam
   *  collar + wash ripples around each; the nearest `MAX_WATER_CONTACTS` to
   *  the mesh origin are uploaded per tick, so lists may exceed the slot cap.
   *  Pass an empty array to clear. Shading-only — displacement (and so
   *  buoyancy) is untouched. */
  setWaterContacts(contacts: readonly WaterContact[]): void
  /** Diagnostic: the world position the vertex shader places the rest point
   *  (x, z) — Gerstner height + horizontal displacement — via a CPU mirror of
   *  the shader using the same live uniforms/constants. The sim buoyancy
   *  (`sampleHeight`) is vertical-only, so the XZ gap between this point and
   *  (x, z) IS the render↔sim horizontal displacement. Open-water only (no
   *  terrain/shore/bike terms). Writes into `out` to avoid per-call alloc. */
  renderVertex(x: number, z: number, out: { x: number; y: number; z: number }): void
  /** Restrict the planar-reflection pass to the opt-in
   *  `WATER_REFLECTION_LAYER` for renders through `camera` (the mirror then
   *  draws sky + terrain/landmark silhouettes only — see the layer's doc).
   *  Call once per scene after the camera exists; no-op when the reflection
   *  pass is disabled (`?reflect=0`) or `?reflectfull=1` requests the
   *  legacy full-scene mirror. Safe to call again after a camera swap. */
  configureReflectionCulling(camera: THREE.Camera): void
  /** Live-tunable knobs for the water debug menu. All setters apply
   *  immediately — no material rebuild, no reload. */
  debug: {
    /** Defaults captured at construction so the menu's RESET button can
     *  restore them without hard-coding values that may drift. */
    readonly defaults: WaterDebugDefaults
    /** Global Gerstner steepness multiplier (Q). 0 = round bumps,
     *  ~0.7 = SoT default, >1.3 risks crests folding. */
    setSteepness(s: number): void
    /** Multiplier on the two long-period swell amplitudes (waves 0–1).
     *  Mutates `field.waves[i].amplitude` so CPU buoyancy follows. */
    setSwellScale(s: number): void
    /** Multiplier on the four wind-chop amplitudes (waves 2–5).
     *  Mutates `field.waves[i].amplitude` so CPU buoyancy follows. */
    setChopScale(s: number): void
    /** Multiplier on `dt` passed to `advanceWaveField` from the main
     *  loop. The main loop reads `getTimeScale()` each step. */
    setTimeScale(s: number): void
    /** Fresnel cap on the planar reflection (0..1). 0 disables the
     *  reflection entirely; 0.85 is the v2 default. */
    setReflectionStrength(s: number): void
    /** Multiplier on the sun-backlight glow on tall crests. */
    setSunGlow(s: number): void
    /** Material base roughness (away from sparkle patches). */
    setRoughBase(s: number): void
    /** Material roughness inside sparkle patches (lower = brighter
     *  pin-point glints). */
    setRoughSparkle(s: number): void
    /** Strength of the sub-Gerstner detail-normal cascades. 0 = bypass
     *  detail (analytic-Gerstner only); 1 = the default cascade
     *  contribution that stands in for SoT-style FFT chop. */
    setDetailStrength(s: number): void
    /** Beer-Lambert body absorption rate. Scales the per-channel σ
     *  triplet that converts view-ray path-length into transmission.
     *  1.0 = the calibrated default (cyan body reads out to ~10 m of
     *  path). 0 = no absorption (whole body reads as seabedColor,
     *  even in open ocean). 3 = very fast absorption (shallow water
     *  darkens to near-deepColor within 2 m). */
    setBodyAbsorption(s: number): void
    /** Karis sun-disc emissive strength. 0 = no disc, 1 = baseline,
     *  3 = blown-out. Driven by the same horizon-haze tint as the
     *  fresnel emissive, so disc color follows time-of-day. */
    setSunDiscStrength(s: number): void
    /** Anisotropic sun-streak emissive strength. 0 = pure Karis
     *  disc; higher values elongate the highlight along the wave-
     *  front tangent for the SoT "low-sun streak across choppy
     *  water" look. */
    setSunStreakStrength(s: number): void
    /** Streak elongation (σ_along of the 2D Gaussian). Higher =
     *  longer streak; lower = more disc-like. Default 0.4. */
    setStreakElongation(s: number): void
    /** Shore-aligned wave strength, 0..2. Scales the amplitude of the
     *  coast-parallel breakers that fill the near-shore band. 0 = off
     *  (byte-identical to no shore field), 1 = default, 2 = exaggerated.
     *  Sets both the GPU uniform and the CPU `field.shoreWaveStrength` so
     *  buoyancy and visuals track, exactly like `setWaveBearing`. */
    setShoreWaveStrength(s: number): void
    /** Shoaling-v2 blend, 0..1 (water-next-research §7.3). 0 = the legacy
     *  quadratic shallow-water kill-switch, 1 = full surf (Green's-law
     *  stack + depth-limited breaking + swell-driven, forward-leaning
     *  shore breakers). Writes the FIELD and the GPU uniform from one
     *  scalar, like setSteepness, so buoyancy and visuals always shoal
     *  identically. */
    setShoalSurf(s: number): void
    /** Splash-ring strength, 0..1.5 (P4.1 landing event waves). One
     *  scalar drives BOTH buoyancy and the GPU (the shoreWaveStrength
     *  discipline). 0 = off (and the spawner stops filling the pool). */
    setSplashRings(s: number): void
    /** Contact-foam collar strength, 0..2 (waterline obstacles). Render-only
     *  shading — safe to scrub live. 0 = collars off. */
    setContactFoam(s: number): void
    /** Pinch direction in degrees, 0..90. Rotates the Gerstner
     *  horizontal-displacement vector relative to the per-wave
     *  travel direction. 0° = standard Gerstner (particles bulge
     *  along the wave direction, sharpening crest LINES in the
     *  direction of travel). 90° = particles bulge ALONG the
     *  crest-line axis (perpendicular to wave travel), producing
     *  ridges elongated in the wave-travel direction instead of
     *  short across-axis pinches. */
    setPinchDirection(deg: number): void
    /** Wave-field bearing in degrees, -180..180. Rotates the WHOLE
     *  swell train globally so the user can re-aim the wave
     *  direction (e.g. "waves should be coming toward shore").
     *  Render + CPU buoyancy stay locked — the bearing rotates both
     *  the GPU sample coords and the CPU sampleSurface/sampleHeight
     *  via the shared `field.waveBearing` scalar.
     *
     *  The SOURCE of this value is per-track authoring
     *  (`water.swellBearingDeg`, applied at boot; absent →
     *  {@link WAVE_BEARING_DEFAULT}). The debug menu's slider is a live
     *  session override and is deliberately not persisted — a bearing
     *  dialed on one track must never silently re-aim every other
     *  track's swell (water-next-research.md §4.5). */
    setWaveBearing(deg: number): void
    /** Current wave-field bearing in degrees. Lets the (lazily-installed)
     *  debug menu seed its live-only bearing slider from the
     *  track-authored value rather than a persisted setting. */
    getWaveBearing(): number
    /** Crest-mist ribbon strength, 0..1+. A soft additive haze lofted on the
     *  upper faces of steep breaking crests, weighted toward grazing view
     *  angles + distance so it fills in for the discrete crest-spray sprites
     *  out where individual particles read too sparse. 0 = off (the shaded
     *  whitecaps still draw); 1 = the default ribbon. Gated by the
     *  Settings → Video "Wave spray" knob via `water-service`. */
    setCrestMistStrength(s: number): void
    /** Curvature-based whitecap gain. The PRIMARY whitecap control (foam v3):
     *  foam fires on crest CURVATURE (sharp crests), so it reads as a thin line
     *  ON the crest, not a wide height band. Higher = foam on gentler curvature
     *  (more coverage); lower = only the sharpest breaking crests. ~4 default. */
    setWhitecapCurvature(g: number): void
    /** Leading-edge bias, 0..1. How hard to push the whitecap onto the wave's
     *  LEADING (rising/front) face via ∂h/∂t. 0 = symmetric crest line; 1 =
     *  front-only ("breaking forward"). 1 default. */
    setWhitecapLeadBias(b: number): void
    /** @deprecated Legacy height/slope/mode whitecap knobs — no longer affect
     *  the wave whitecap (curvature replaced them). Kept so persisted tuning +
     *  the foam-sweep harness keep loading; safe to retire in a cleanup pass. */
    setWhitecapHeight(m: number): void
    /** @deprecated See {@link setWhitecapCurvature}. No-op for the wave whitecap. */
    setWhitecapSlope(s: number): void
    /** @deprecated See {@link setWhitecapLeadBias}. No-op for the wave whitecap. */
    setWhitecapMode(m: number): void
    /** Foam warmth, 0..2. Scales the light-driven warm tint + warm emissive
     *  bloom on sun-raked foam. 0 = flat white foam (legacy); 1 = baseline
     *  sunset-kissed crests. Follows the sky, so it's near-neutral at midday. */
    setFoamWarmth(s: number): void
    /** Foam streaks, 0..2. Scales the brushstroke foam bands on steep wave
     *  faces (running along the local crest line). 0 = isotropic bubbles only
     *  (legacy); 1 = baseline streaks. */
    setFoamStreak(s: number): void
    /** Foam brush, 0..1. Blends the foam break-up pattern from the legacy
     *  round-disc bubble sheet (0) to oil-paint brush strokes pulled along
     *  the crest lines (1) — the engine-trail painted read applied to foam. */
    setFoamBrush(s: number): void
    /** P2.3 tangential foam warp, 0..2. Wobbles the foam break-up sample
     *  coords along the CREST axis (±4 m at 1) so stroke/bubble rows bend
     *  organically instead of running straight forever. Never warps the
     *  travel/height axes (those carry the steepness/timing signal). */
    setFoamWarp(s: number): void
    /** P2.3 Langmuir streak lanes, 0..1.5. Faint travel-aligned windrow
     *  brightness lanes on calm low-slope water — the "which way is the
     *  sea moving" prime where no crest/foam cue fires. 0 = off. */
    setLangmuir(s: number): void
    /** Bike-wake strength, 0..2. Scales the trail wake — both the churn/rail
     *  foam ribbon laid along each bike's ridden path and its V-ridge
     *  DISPLACEMENT. 1 = baseline; 0 = no rendered wake (buoyancy still
     *  feels the analytic sim wake — dev-only setting). */
    setWakeStrength(s: number): void
    /** P1 readability — crest-to-trough value-ramp strength, 0..1. Scales the
     *  posterized "one value sweep per wave face" brightness modulation
     *  (water-next-research §8 P1.1). 0 = off. */
    setRampStrength(s: number): void
    /** P1 readability — number of posterize bands in the value ramp, 2..5. */
    setRampSteps(n: number): void
    /** P1 readability — 0 = continuous ramp, 1 = fully quantized bands. */
    setRampPosterize(s: number): void
    /** P1 readability — contour-line foam strength, 0..1.5 (§8 P1.2). The
     *  iso-height "topo lines" whose packing IS the steepness cue. 0 = off. */
    setContourStrength(s: number): void
    /** P1 readability — vertical interval between contour lines, metres
     *  (0.2..1.5). Smaller = more lines = finer height reading. */
    setContourSpacing(m: number): void
    /** P1 readability — Wind-Waker dark-twin strength, 0..1 (§8 P1.3). Draws
     *  a dark teal line offset away from the sun beside each light line. */
    setContourRelief(s: number): void
    /** P1 readability — contour-line break-up, 0..1. 0 = solid unbroken iso
     *  lines; 1 = lines dissolve into crest-aligned brush dashes, gently
     *  nicked near crests and hardest in the troughs (lines cling to the
     *  crests instead of running the whole sea). */
    setContourBreakup(s: number): void
    /** Iso-coherence for the readability field (ramp + contours + relief),
     *  0..1. Iso-lines of the legacy multi-train swell sum locally race far
     *  past any train's phase speed where the trains' slopes cancel (the
     *  "contours slide over the surface" artifact, worst once per set-beat
     *  cycle); at 1 the field keys to the dominant train only, so every
     *  contour rides the primary swell at exactly its phase speed. */
    setContourCoherence(s: number): void
    /** Live EFFECTIVE iso-coherence (authored base + the speed-coupled calm
     *  drive, as rendered this frame) — the `?waterlab` CPU probe mirrors
     *  the GPU blend with it. */
    getContourCoherence(): number
    /** Speed-coupled contour calm, 0..1. Drives the effective coherence
     *  toward 1 as the observer (camera origin) slows: standing riders and
     *  the intro flyby see lines pinned to the primary swell (riding the
     *  crests, never outrunning them), and the authored two-train
     *  liveliness fades back in by ~11 m/s. 0 = no coupling (legacy). */
    setContourCalmAtRest(s: number): void
    /** Contour slope-gate raise, 0..1. Iso-lines sweep at ∂h/∂t ÷ slope, so
     *  the flattest gated-in faces carry the fastest-sliding lines; raising
     *  the window (0 = legacy 0.02..0.06 → 1 = 0.06..0.14) trims those
     *  first. */
    setContourGate(s: number): void
    /** Rising-face strokes, 0..2. Tapered brush strokes pulled UP the leading
     *  (rising) face of an approaching wave — perpendicular to the contour
     *  crest lines (the "vertical strokes climbing the wave coming at you"
     *  read). 0 = off, 0.5 = baseline. Front-face + steep-swell gated. */
    setRiseStroke(s: number): void
    /** P2.1 wave sets — envelope period in seconds (0 = off). Writes the
     *  FIELD (the sim source of truth, like setWaveBearing); tick() mirrors
     *  to the GPU. Track-authored via `water.swellSets` — the menu rows are
     *  live session overrides, not persisted. */
    setSwellSetPeriod(s: number): void
    /** P2.1 wave sets — envelope depth 0..0.6 (amplitude swings ±depth
     *  around the static sea state). 0 = off. */
    setSwellSetDepth(d: number): void
    /** Current swell-set envelope params (for live-only menu rows). */
    getSwellSet(): { periodS: number; depth: number }
    /** Snapshot of the live wake trails (e2e harness probe): one entry per
     *  active trail with the breadcrumb count and total recorded arc length.
     *  Cheap copy — call freely from test code, not per-frame game code. */
    getWakeTrails(): Array<{ id: number; count: number; headArc: number }>
    /** Render the wave geometry as wireframe. Useful for tuning wave /
     *  wake amplitudes against the actual displacement. */
    setWireframe(on: boolean): void
    /** Paint each water layer in a distinct flat color (center=red,
     *  outer=green, skirt=blue) so the LOD boundaries between the
     *  three meshes are visible. Used with the water-test track's
     *  camera-locked transition markers to diagnose where seams sit.
     *  No material rebuild — flips a uniform mix factor. */
    setColorize(on: boolean): void
    /** Hide/show the whole water stack (center + outer LOD + skirt) — the
     *  water-ablation tool's "what does ALL water cost" probe. Dev-only;
     *  not persisted, not in the menu. */
    setWaterVisible(on: boolean): void
    /** Live A/B for the mirror cull: true = legacy full-scene reflection,
     *  false = the opt-in `WATER_REFLECTION_LAYER` (default). Applies to
     *  cameras already configured via `configureReflectionCulling`. */
    setReflectionFullScene(on: boolean): void
    /** Time-scale getter for the main loop. */
    getTimeScale(): number
  }
  dispose(): void
}

export type WaterDebugDefaults = {
  steepness: number
  swellScale: number
  chopScale: number
  timeScale: number
  reflectionStrength: number
  sunGlow: number
  roughBase: number
  roughSparkle: number
  detailStrength: number
  /** Beer-Lambert body absorption rate. 1 = calibrated default. */
  bodyAbsorption: number
  /** Karis sun-disc emissive strength. 1.4 = baseline. */
  sunDiscStrength: number
  /** Anisotropic sun-streak emissive strength. 0.8 = baseline. */
  sunStreakStrength: number
  /** Streak elongation σ_along. 0.4 = baseline. */
  streakElongation: number
  /** Shore-aligned wave strength, 0..2. 1 = baseline, 0 = off. */
  shoreWaveStrength: number
  /** Shoaling-v2 blend 0..1: legacy kill-switch (0) ↔ full surf (1). */
  shoalSurf: number
  /** Splash-ring strength 0..1.5 (landing event waves). 1 = baseline. */
  splashRings: number
  /** Contact-foam collar strength 0..2 (waterline obstacles). 1 = baseline,
   *  0 = off. */
  contactFoam: number
  /** Gerstner pinch direction in degrees, 0..90. */
  pinchDirection: number
  /** Curvature-based whitecap gain (foam v3). 4 = baseline. Higher = foam on
   *  gentler curvature; lower = only the sharpest crests. Primary whitecap knob. */
  whitecapCurvature: number
  /** Leading-edge bias 0..1: push the whitecap onto the rising/front face.
   *  1 = baseline (front-loaded), 0 = symmetric crest line. */
  whitecapLeadBias: number
  /** @deprecated Legacy whitecap height threshold — no longer drives the wave
   *  whitecap (curvature replaced it). Retained for store back-compat. */
  whitecapHeight: number
  /** @deprecated Legacy whitecap slope threshold — no-op for the wave whitecap. */
  whitecapSlope: number
  /** @deprecated Legacy whitecap gate mode — no-op for the wave whitecap. */
  whitecapMode: number
  /** Foam warmth 0..2: light-driven warm tint + bloom on sun-raked foam.
   *  1 = baseline, 0 = flat white (legacy). */
  foamWarmth: number
  /** P1 readability ramp strength 0..1 (posterized value sweep). */
  rampStrength: number
  /** P1 readability ramp band count, 2..5. */
  rampSteps: number
  /** P1 readability ramp posterize blend, 0..1. */
  rampPosterize: number
  /** P1 readability contour-line strength, 0..1.5. */
  contourStrength: number
  /** P1 readability contour spacing, metres. */
  contourSpacing: number
  /** P1 readability relief (dark twin) strength, 0..1. */
  contourRelief: number
  /** P1 readability contour break-up, 0..1 (solid lines ↔ trough-biased dashes). */
  contourBreakup: number
  /** Iso-coherence 0..1: legacy multi-train readability field (0) ↔ keyed to
   *  the dominant swell train only (1) — kills the iso-line "racing". */
  contourCoherence: number
  /** Speed-coupled calm 0..1: effective coherence → 1 as the observer slows
   *  (rest/intro = lines pinned to the primary swell), authored look returns
   *  at speed. 0 = no coupling. */
  contourCalmAtRest: number
  /** Contour slope-gate raise 0..1 (legacy 0.02..0.06 ↔ 0.06..0.14 window). */
  contourGate: number
  /** Rising-face strokes, 0..2: crest-perpendicular brush marks climbing the
   *  leading face of approaching waves. 0.5 = baseline, 0 = off. */
  riseStroke: number
  /** Foam streaks 0..2: brushstroke bands on steep faces, along the local
   *  crest line. 1 = baseline, 0 = isotropic bubbles only (legacy). */
  foamStreak: number
  /** Foam brush 0..1: disc-bubble (0) ↔ oil-stroke (1) foam break-up. */
  foamBrush: number
  /** P2.3 tangential foam warp 0..2: along-crest wobble of the foam
   *  break-up sample coords. 1 = baseline ±4 m. */
  foamWarp: number
  /** P2.3 Langmuir lanes 0..1.5: travel-aligned windrow brightness lanes
   *  on calm water. 0.6 = baseline. */
  langmuir: number
  /** Bike-wake strength 0..2: trail-wake foam + ridge displacement. */
  wakeStrength: number
  wireframe: boolean
  /** When true, each water layer paints in a distinct flat color so
   *  LOD seams are visible. Off by default. */
  colorize: boolean
}

/** Maximum bikes the water shader renders wakes/dimples for per frame. MUST be
 * ≥ the live race field: the grid is player + NUM_AI (7) = 8 bikes (see
 * `src/boot/spawn-bikes.ts` + `grid-offsets`). Each slot adds an unrolled
 * vertex-stage Gaussian dimple plus a fragment-stage early-out check, so this
 * is a genuine per-bike GPU cost — the 8-bike perf pass measures exactly this.
 * NOTE: the sim's buoyancy (`wake-update.ts` → `wave-field.ts`) already
 * deposits a wake per bike *uncapped*, so this only bounds the *rendered*
 * wake; keep it ≥ the grid size or trailing bikes lose their visible wake.
 * (Was 5 — a stale "player + 4 AI" assumption that predated the 8-bike grid.) */
const MAX_BIKES = 8
/** Cull radius for fragment-stage AT-BIKE effects (stern propwash + bow
 * spray — the trail wake culls separately per trail, below). Propwash dies
 * within ~4 m behind the hull and bow spray ~2.5 m ahead, so outside this
 * radius the per-bike math is guaranteed ≈ 0 and an `If` early-out skips it.
 * Squared comparison avoids a sqrt. */
const BIKE_INFLUENCE_R = 14.0
const BIKE_INFLUENCE_R_SQ = BIKE_INFLUENCE_R * BIKE_INFLUENCE_R
/** Hull dimple radius (Gaussian σ) — controls how wide the depression is. */
const BIKE_DIMPLE_R = 1.6
/** Peak depth of the hull dimple, meters. */
const BIKE_DIMPLE_DEPTH = 0.32
/** Squared cull radius for the vertex-stage dimple. exp(-r²/R²) is below
 * 1e-7 outside ~6σ, so we can skip the exp entirely past this distance. */
const BIKE_DIMPLE_CULL_R_SQ = BIKE_DIMPLE_R * 6 * (BIKE_DIMPLE_R * 6)

// ---- Wake trail (the trailing wake's path history) -------------------------
//
// The wake follows a recorded breadcrumb TRAIL of each bike's ridden path —
// "behind" is arc-distance back along the path and "perp" the lateral offset
// from the nearest trail segment, so the wake curves with the line, a jump
// leaves a real gap, and a stopped bike's wake age-fades in place.
//
// THE SIM OWNS THE TRAILS (`wake-trail.ts`, fed per fixed step by
// `wakeUpdateSystem` into `field.trails`): CPU buoyancy samples the same
// points with the same profile (`sampleWakeFromTrail`), so the ridge a
// trailing rider feels — and can jump — is exactly the one drawn here. This
// module only UPLOADS those points each frame (`tick()`) and mirrors the
// profile in TSL; all trail constants + recording rules live sim-side and
// are imported, never re-declared.

/** Trail-aligned stroke-sheet tiles: U (along the ridden path) / V (lateral).
 * 7 m × 3.5 m puts the sheet's 0.3–0.55-fraction ropy streaks at ~2–4 m. */
const WAKE_STROKE_TILE_U = 7.0
const WAKE_STROKE_TILE_V = 3.5

const INACTIVE_FAR = 1e6

// ---------------------------------------------------------------------------
// Procedural sub-Gerstner detail normal map.
//
// SoT and Atlas (GDC 2019) reach sub-meter wave detail via FFT cascades. We
// stand in for that with a single tileable wave-like normal map sampled at
// two world-XZ scales + scroll directions in the fragment. The slopes from
// these two cascades add to the analytic Gerstner gradient before the normal
// is built, so the surface picks up the fine "wave chop" that Gerstner can't
// reach without an explosive vertex count — and hardware mipmap filtering
// kills the per-pixel speckle that an FFT in WebGPU would still need a
// custom AA pass to solve.
//
// The texture encodes pre-computed surface slopes (dh/du, dh/dv) into the RG
// channels with the standard [-1,1] → [0,1] convention. At sample time the
// shader decodes (px*2-1, py*2-1), scales by `detailStrength / tileScale`,
// and adds to the heightfield's (dydx, dydz) gradient. The actual height of
// the detail isn't reconstructed — only slopes matter for shading.
//
// Tileability: each component sine uses integer (kx, kz) on the N×N grid, so
// the heightfield (and thus its slopes) repeats seamlessly across tile
// boundaries. The texture is set up with REPEAT wrapping + anisotropy so
// grazing-angle samples don't smear.
// ---------------------------------------------------------------------------

/** Cached procedural detail-normal texture — RGBA8 / REPEAT / mipmapped. */
let sharedWaveDetailNormal: THREE.DataTexture | null = null

function buildWaveDetailNormalTexture(): THREE.DataTexture {
  const N = 256
  const data = new Uint8Array(N * N * 4)

  // Integer (kx, kz) pairs — each is one tileable directional sine on the
  // unit tile. The set roughly approximates a Phillips spectrum (more energy
  // mid-frequency, less at the highest cells) so the detail reads as wave
  // chop rather than noise.
  const RAW_DIRS: [number, number][] = [
    [3, 1],
    [2, 3],
    [4, -1],
    [1, 4],
    [-1, 3],
    [-3, 2],
    [6, 2],
    [5, -3],
    [-2, 5],
    [3, 5],
    [-4, 4],
    [7, 1],
    [8, 4],
    [-5, 6],
    [6, -5],
    [9, 3],
    [4, 8],
    [-7, -5],
    [11, 4],
    [-8, 7],
    [10, -6],
    [13, 5],
  ]
  type Comp = { kx: number; kz: number; amp: number; phase: number }
  const FREQS: Comp[] = RAW_DIRS.map(([kx, kz]) => {
    const k = Math.hypot(kx, kz)
    return {
      kx,
      kz,
      amp: 1 / k ** 1.3,
      // Deterministic per-component phase via a cheap hash.
      phase: ((Math.sin(kx * 12.9898 + kz * 78.233) * 43758.5453) % 1) * (2 * Math.PI),
    }
  })

  // Heights on unit tile.
  const heights = new Float32Array(N * N)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N
      const v = y / N
      let h = 0
      for (const f of FREQS) {
        h += f.amp * Math.sin(2 * Math.PI * (f.kx * u + f.kz * v) + f.phase)
      }
      heights[y * N + x] = h
    }
  }

  // Toroidal central-difference slopes (so the tile is seamless under REPEAT).
  // `dh/du` is the slope per unit of u ∈ [0,1]; runtime divides by tileScale
  // to convert that into world-space dh/dx.
  const slopes = new Float32Array(N * N * 2)
  let smax = 0
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const left = heights[y * N + ((x - 1 + N) % N)]!
      const right = heights[y * N + ((x + 1) % N)]!
      const up = heights[((y - 1 + N) % N) * N + x]!
      const down = heights[((y + 1) % N) * N + x]!
      // (right - left) / 2 is ∂h/∂(u·N); multiply by N to get ∂h/∂u.
      const dhdu = (right - left) * 0.5 * N
      const dhdv = (down - up) * 0.5 * N
      slopes[(y * N + x) * 2 + 0] = dhdu
      slopes[(y * N + x) * 2 + 1] = dhdv
      const am = Math.max(Math.abs(dhdu), Math.abs(dhdv))
      if (am > smax) smax = am
    }
  }

  // Pack with a normalization that leaves headroom in the [-1, +1] range.
  // 0.5/smax puts the peak slope at ±0.5 of the encoded range; runtime scales
  // back up via `detailStrength` so the visible amplitude is tunable.
  const inorm = smax > 0 ? 0.5 / smax : 0
  for (let i = 0; i < N * N; i++) {
    const ndx = slopes[i * 2 + 0]! * inorm
    const ndz = slopes[i * 2 + 1]! * inorm
    data[i * 4 + 0] = Math.max(0, Math.min(255, Math.round((ndx * 0.5 + 0.5) * 255)))
    data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round((ndz * 0.5 + 0.5) * 255)))
    data[i * 4 + 2] = 128
    data[i * 4 + 3] = 255
  }

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.name = 'water:detailNormal'
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  // Without anisotropy the texture smears noticeably as the camera tilts
  // toward grazing — 4× is the standard SoT-style sweet spot and is cheap.
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

function getWaveDetailNormalTexture(): THREE.DataTexture {
  if (!sharedWaveDetailNormal) {
    sharedWaveDetailNormal = buildWaveDetailNormalTexture()
  }
  return sharedWaveDetailNormal
}

// ---------------------------------------------------------------------------
// Procedural foam-bubble texture — solid overlapping discs.
//
// The SoT SIGGRAPH 2018 paper credits its foam look to "blending the foam
// mask with artist-authored textures." We don't have authored foam art, so
// this builder bakes a tileable field of SOLID white circles — one jittered
// disc per cell, unioned via max() so neighbouring discs overlap into chunky
// clusters. Deliberately simple: flat-filled discs (1 inside, 0 outside, with
// a thin AA rim), NOT the previous bright-center two-octave Worley bubbles,
// which read as a fizz of tiny rings. Sampled per-pixel by the foam
// composition and multiplied into `foamMask`, so every foam source (wake,
// bow spray, shoreline surf, breaking-crest cap) inherits the same disc
// structure: where a disc covers, foam punches to full white; between discs
// the strength-aware floor dims toward clean water.
//
// Two octaves of differently-sized discs (8² big + 14² medium) give a little
// size variation while staying bold. Toroidal cell-index wrap keeps the
// texture tileable under REPEAT sampling. Output is grayscale packed into
// RGBA8 (the shader reads the .r channel only).
// ---------------------------------------------------------------------------

let sharedFoamBubbleTexture: THREE.DataTexture | null = null
let sharedFoamStreakTexture: THREE.DataTexture | null = null
let sharedFoamStrokeMassTexture: THREE.DataTexture | null = null
let sharedContourDashTexture: THREE.DataTexture | null = null
let sharedWakeStrokeTexture: THREE.DataTexture | null = null

/** Wrap a procedural mask grid in a repeat-tiling DataTexture (grayscale in
 *  `.r`, same sampler setup as the bubble sheet). */
function buildStrokeMaskDataTexture(
  grid: Float32Array,
  size: number,
  name: string,
): THREE.DataTexture {
  const data = packSheetRGBA8(grid)
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.name = name
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

function buildFoamBubbleTexture(): THREE.DataTexture {
  const N = 512
  const data = new Uint8Array(N * N * 4)

  // Deterministic per-cell hash → jittered disc-center offset in [0,1]².
  function hash2(cx: number, cy: number, salt: number): [number, number] {
    const s1 = Math.sin(cx * 12.9898 + cy * 78.233 + salt * 53.123) * 43758.5453
    const s2 = Math.sin(cx * 39.346 + cy * 11.135 + salt * 17.421) * 91234.7891
    return [s1 - Math.floor(s1), s2 - Math.floor(s2)]
  }

  // One jittered SOLID disc per cell. `radius` is in cell units; > 0.5 so a
  // disc reaches into its neighbours and the union reads as overlapping
  // circles rather than a tiled grid of separate dots.
  type Octave = { cells: number; radius: number; salt: number }
  const octaves: Octave[] = [
    // Big bold circles — 8 across the 512-px tile (~64-px discs).
    { cells: 8, radius: 0.62, salt: 0 },
    // Medium fill circles — 14 across (~37-px discs), for some size variety.
    { cells: 14, radius: 0.5, salt: 1 },
  ]
  // Soft-rim width (cell units) — antialiases the disc edge so close-up rims
  // don't stair-step. Small relative to radius → discs stay flat-solid inside.
  const AA = 0.05

  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      // Union (max) of every disc covering this texel — overlapping discs
      // merge into solid clusters instead of darkening at the seams.
      let v = 0

      for (const oct of octaves) {
        const cellSize = N / oct.cells
        const cx = Math.floor(px / cellSize)
        const cy = Math.floor(py / cellSize)

        // 3×3 neighbor cells (with toroidal wrap) so the disc field is
        // seamless across the tile edge.
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ncx = (((cx + dx) % oct.cells) + oct.cells) % oct.cells
            const ncy = (((cy + dy) % oct.cells) + oct.cells) % oct.cells
            const [hx, hy] = hash2(ncx, ncy, oct.salt)
            const centerPx = (cx + dx + hx) * cellSize
            const centerPy = (cy + dy + hy) * cellSize
            const distCell = Math.hypot(px - centerPx, py - centerPy) / cellSize
            // Solid disc: 1 inside (radius − AA), linear AA ramp to 0 at radius.
            const disc = Math.max(0, Math.min(1, (oct.radius - distCell) / AA))
            if (disc > v) v = disc
          }
        }
      }

      const byte = Math.round(v * 255)
      const idx = (py * N + px) * 4
      data[idx + 0] = byte
      data[idx + 1] = byte
      data[idx + 2] = byte
      data[idx + 3] = 255
    }
  }

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.name = 'water:foamBubbles'
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

function getFoamBubbleTexture(): THREE.DataTexture {
  if (!sharedFoamBubbleTexture) {
    sharedFoamBubbleTexture = buildFoamBubbleTexture()
  }
  return sharedFoamBubbleTexture
}

/**
 * Flow-stroke foam sheet — long thin tapered oil strokes running along the
 * texture's U axis with clean gaps between, rasterized procedurally at first
 * use (`oil-stroke-texture.ts`, `FOAM_STROKE_STREAK_SPEC`). Sampled in the
 * fragment shader with U mapped to the cross-slope direction, so on steep
 * faces the brushstrokes run along the local crest line and trace the wave's
 * shape/curvature. R = stroke alpha (0 = clean water, 1 = stroke core).
 *
 * Replaces the R2-served `foam_streaks.png` (Brushstroke-Tools harvest): that
 * sheet's silent-404 fallback meant any clone that hadn't run `assets:pull`
 * since it was pushed rendered NO streaks in dev — the look silently forked
 * between machines. Procedural = identical bytes everywhere, no hydration.
 */
function getFoamStreakTexture(): THREE.DataTexture {
  if (!sharedFoamStreakTexture) {
    sharedFoamStreakTexture = buildStrokeMaskDataTexture(
      rasterizeOilStrokeSheet(FOAM_STROKE_STREAK_SPEC),
      FOAM_STROKE_STREAK_SPEC.size,
      'water:foamStreaks',
    )
  }
  return sharedFoamStreakTexture
}

/**
 * Oil-stroke foam-mass sheet — chunky tapered brush dabs (two size classes,
 * bristle-split tails, per-stroke paint strength), the painterly alternative
 * to the round-disc bubble sheet as the foam break-up pattern. Sampled with U
 * aligned to the CREST direction (perpendicular to swell travel) so foam
 * dissolves into strokes pulled along the wave fronts — the painted read of
 * the bikes' engine-trail ribbons, tracing the crests. The `foamBrush` knob
 * blends disc ↔ stroke break-up live.
 */
function getFoamStrokeMassTexture(): THREE.DataTexture {
  if (!sharedFoamStrokeMassTexture) {
    sharedFoamStrokeMassTexture = buildStrokeMaskDataTexture(
      rasterizeOilStrokeSheet(FOAM_STROKE_MASS_SPEC),
      FOAM_STROKE_MASS_SPEC.size,
      'water:foamStrokeMass',
    )
  }
  return sharedFoamStrokeMassTexture
}

/**
 * Hex-tiled (stochastic) texture tap — the P2.3 anti-tiling sampler
 * (water-next-research §7.8; Mikkelsen, *Practical Real-Time Hex-Tiling*,
 * JCGT 2022 — this is the lean triangle-lattice/3-tap core of it, without
 * the per-tile rotations or histogram preservation the full method adds).
 *
 * UV space is partitioned into a triangle lattice (~2 texture tiles per
 * cell); each lattice vertex gets a stable hashed UV offset; the texture
 * is sampled at the three surrounding vertices' offset UVs and blended
 * with the barycentric weights. Strict periodicity dies because no two
 * lattice regions read the same patch of texture in the same place —
 * the repeat distance becomes the lattice hash period (effectively
 * never) instead of the tile size.
 *
 * Two properties make the cheap variant artifact-free here:
 *  - at any lattice edge, the vertex whose hash CHANGES has barycentric
 *    weight 0, so there is no visible pattern seam (and the mip-
 *    derivative spike on that sample is invisible for the same reason);
 *  - the blend zones linearly mix three decorrelated samples, which
 *    slightly softens contrast there — acceptable for our low-contrast
 *    slope/mask sheets (they all feed smoothstep gates downstream), so
 *    the full method's histogram-preserving transform isn't needed.
 *
 * Plain JS code-gen helper (not a TSL Fn): emits the node graph inline at
 * the call site, three `texture()` taps per call.
 */
// biome-ignore lint/suspicious/noExplicitAny: TSL node-graph builder values
function hexTiledTap(tex: THREE.Texture, uv: any): any {
  // Lattice cells span ~2 texture tiles — big enough that each randomized
  // region shows a coherent stretch of pattern, small enough that the eye
  // never sees two aligned repeats.
  const HEX_LATTICE_SCALE = 0.5
  // biome-ignore lint/suspicious/noExplicitAny: TSL node-graph builder values
  const st = (uv as any).mul(float(HEX_LATTICE_SCALE))
  // Skew UV into the triangle lattice frame.
  const sx = st.x.sub(st.y.mul(float(0.57735027)))
  const sy = st.y.mul(float(1.15470054))
  const cellX = floor(sx)
  const cellY = floor(sy)
  const fx = fract(sx)
  const fy = fract(sy)
  const fz = float(1).sub(fx).sub(fy)
  // Branchless lower/upper triangle select: weights sum to 1 in both.
  const up = step(fz, float(0)) // 0 = lower triangle, 1 = upper
  const w1 = mix(fz, fz.negate(), up)
  const w2 = mix(fy, float(1).sub(fy), up)
  const w3 = mix(fx, float(1).sub(fx), up)
  const v1 = vec2(cellX, cellY).add(mix(vec2(0, 0), vec2(1, 1), up))
  const v2 = vec2(cellX, cellY).add(mix(vec2(0, 1), vec2(1, 0), up))
  const v3 = vec2(cellX, cellY).add(mix(vec2(1, 0), vec2(0, 1), up))
  // Stable per-vertex hash → UV offset in [0,1)² (REPEAT wrap makes any
  // offset valid). Two decorrelated dot-hashes per vertex.
  // biome-ignore lint/suspicious/noExplicitAny: TSL node-graph builder values
  const hashOffset = (v: any) =>
    vec2(
      fract(sin(dot(v, vec2(127.1, 311.7))).mul(float(43758.5453))),
      fract(sin(dot(v, vec2(269.5, 183.3))).mul(float(43758.5453))),
    )
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle types
  const t1 = texture(tex, (uv as any).add(hashOffset(v1))) as any
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle types
  const t2 = texture(tex, (uv as any).add(hashOffset(v2))) as any
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle types
  const t3 = texture(tex, (uv as any).add(hashOffset(v3))) as any
  return t1.mul(w1).add(t2.mul(w2)).add(t3.mul(w3))
}

/**
 * Contour-dash sheet — a stack of independent 1-D dash rows the contour layer
 * uses as a KEEP mask so its iso-height lines dissolve into hand-pulled
 * dashes instead of running unbroken across the whole sea. Each iso line
 * samples one row at its V center (keyed to the line's level) — see the
 * contour-breakup block in the fragment stage for the phase-locking
 * rationale.
 */
function getContourDashTexture(): THREE.DataTexture {
  if (!sharedContourDashTexture) {
    sharedContourDashTexture = buildStrokeMaskDataTexture(
      rasterizeContourDashRows(CONTOUR_DASH_SPEC),
      CONTOUR_DASH_SPEC.size,
      'water:contourDash',
    )
  }
  return sharedContourDashTexture
}

/**
 * Bike-wake churn sheet — ropy along-axis streaks + short tufts, sampled in
 * TRAIL-ALIGNED UV (U = arc length along the ridden path, V = lateral offset)
 * so the strokes stream along the wake. Because U is pinned to path arc
 * length the pattern is painted onto the world and stays put as the bike
 * pulls away — the trailing-wake read — instead of the world-anchored bubble
 * discs the wake foam used to inherit (polka dots) or the crest-combed mass
 * strokes (combed along the SWELL, not the wake).
 */
function getWakeStrokeTexture(): THREE.DataTexture {
  if (!sharedWakeStrokeTexture) {
    sharedWakeStrokeTexture = buildStrokeMaskDataTexture(
      rasterizeOilStrokeSheet(WAKE_STROKE_SPEC),
      WAKE_STROKE_SPEC.size,
      'water:wakeStrokes',
    )
  }
  return sharedWakeStrokeTexture
}

/**
 * Global swell-train bearing applied when a track doesn't author
 * `water.swellBearingDeg` (degrees CCW from world +X). 47° is the look every
 * shipped track was graded against before the bearing became per-track data
 * (P0.3, water-next-research.md §4.5) — it was the construction default the
 * debug menu used to persist machine-wide. Tracks that want a different
 * bearing author the JSON key; this constant only preserves the legacy look
 * for the ones that don't.
 */
export const WAVE_BEARING_DEFAULT = 47

/**
 * GPU-shader water built on Three.js's TSL node pipeline.
 *
 * The vertex shader Gerstner-displaces a flat plane, subtracts a per-bike
 * Gaussian "hull dimple", and adds each bike's wake ridge evaluated along a
 * recorded TRAIL of its ridden path (see the wake-trail constants block).
 * The wake profile mirrors the sim's `sampleWakeFromSource` cross-section, so
 * for straight-line riding the buoyancy bump a trailing rider feels lines up
 * with the drawn ridge ("jump my wake"); mid-turn the drawn wake follows the
 * path while buoyancy stays on the heading ray (documented divergence).
 *
 * The fragment shader recomputes the analytic normal per pixel — including
 * both the dimple and wake gradients — and adds:
 *
 *  - PBR-style albedo gradient (deep blue → cyan with crest height)
 *  - Crest foam from height + slope of the wave field
 *  - Trailing wake foam (center churn + diverging edge rails) laid along
 *    each bike's trail, broken up by a trail-aligned stroke sheet
 *  - Stern propwash + bow spray anchored at each hull
 *  - Fresnel sky-tint on the emissive channel
 *  - Cheap hash-noise sparkle, gated to crests
 *
 * The Gerstner sum mirrors `sampleSurface` in the sim's wave-field module so
 * the rendered surface and the buoyancy field stay in lock-step. The CPU
 * sampler remains the source of truth for buoyancy; this is its visual twin.
 *
 * Wave parameters (wavelength / direction / phase / count) are baked into
 * the shader at construction from whatever `field.waves` holds at that
 * moment — the hand-tuned `defaultWaves()` bank or a per-track generated
 * spectrum (spectrum.ts; main.ts installs it on the field BEFORE building
 * this mesh). Only amplitudes are live-mirrored. If the bank is ever
 * mutated structurally at runtime, rebuild the material.
 */
export function createWaterMesh(
  field: WaveFieldState,
  opts?: {
    size?: number
    subdivisions?: number
    /** Renderer backend. Required to know whether to use the GPU FFT
     *  compute path (WebGPU only) or fall back to the static CPU bake
     *  when `?water=fft` is active. Detected by `createRenderer` and
     *  passed through from boot. Omit to default to WebGL2 (skip GPU
     *  compute). */
    backend?: 'webgpu' | 'webgl2'
  },
): WaterMesh {
  const size = opts?.size ?? 960
  // 768 subs × 960 m ≈ 1.25 m vertex spacing. The mesh follows the
  // camera (see `tick`'s `originXZ` arg + the meshOrigin uniform), so the
  // 960 m of mesh stays centered on the visible patch instead of being
  // anchored at world origin (with the player at z ≈ 90 sitting near the
  // edge). 960 m half-extent (480 m to each side, ~680 m at the corners)
  // pushes the geometric edge well below the bike-POV horizon line, so
  // the center→outer cross-fade band (see `centerEdgeFade` below) lands
  // where it reads as a continuous tone shift rather than a sharp seam.
  // Default dropped 768² → 512² (1.25 → 1.875 m spacing) on the water-
  // ablation numbers: the June-10 vertex work (trails/stamps/rings/crest
  // signals per vertex) made density a real lever — 512² is +7 fps on the
  // iGPU dev box and the win is already saturated there (384² measures the
  // same), while the 4 m wake wavelength keeps ~2.1 verts per crest and
  // the sub-4 m chop lives in the detail-normal cascades anyway (verified
  // against the wake-look captures). `?watersubs=<n>` (64..1024) remains
  // the per-boot A/B axis — `?watersubs=768` is the legacy density.
  const subsParam =
    typeof window !== 'undefined'
      ? Number(new URLSearchParams(window.location.search).get('watersubs'))
      : Number.NaN
  const subs =
    opts?.subdivisions ??
    (Number.isFinite(subsParam) && subsParam >= 64 && subsParam <= 1024
      ? Math.round(subsParam)
      : getActiveQuality().waterSubdivisions)

  // ---- Debug toggles ----------------------------------------------------
  // Analytic-Gerstner displacement + procedural detail-normal map +
  // SoT-style fragment shading (Beer-Lambert depth, Karis sun disc,
  // anisotropic streak, bubble foam, height whitecaps, three-color
  // blend) is the only path. `?wire=1` renders the displaced mesh as
  // wireframe; `?steep=<n>` overrides the initial steepness scale;
  // `?reflect=0` disables the planar reflection pass for perf tests;
  // `?aa=off` drops MSAA so the scene-depth copy (and its shoreline
  // foam) can run on WebGPU.
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null

  // Scene-depth copy is forbidden when the framebuffer is multisampled —
  // `copyFramebufferToTexture` would try to copy a 4-sample depth attachment
  // into our 1-sample `sceneDepthTexture` and WebGPU invalidates the entire
  // command buffer at submit time, blanking the frame. MSAA is on by default
  // on WebGPU (renderer.ts antialias=true), so we skip the copy in that case
  // and accept the visual cost: shoreline foam from scene-depth comparison
  // is suppressed (the shader keeps a sane default), but the rest of the
  // surface renders normally. Players who want the shoreline foam back can
  // pass `?aa=off` to drop MSAA — the copy then succeeds.
  // WebGL2 + WebGPU-with-`?aa=off` both keep the copy.
  const aaOn = params?.get('aa') !== 'off'
  const disableSceneDepthCopy = opts?.backend === 'webgpu' && aaOn
  const wireFlag = params?.get('wire') === '1'
  // P2.3 anti-tiling sampler kill switch (`?hextile=0`) — structural
  // shader change, so the A/B is per-boot rather than a live knob. ON by
  // default; the off path keeps the plain single-tap samples for
  // comparison shots + a perf control.
  const hexTileFlag = params?.get('hextile') !== '0'

  const geom = new THREE.PlaneGeometry(size, size, subs, subs)
  geom.rotateX(-Math.PI / 2)

  // Time uniform driven from the sim's `field.time`. Using the sim clock
  // (rather than wall-clock) keeps rendering deterministic and matches
  // buoyancy exactly across rewinds / fixed-step runs.
  const tNode = uniform(field.time)

  // Global steepness scale Q ∈ [0, ~1.5]. 0 = vertical-only Gerstner (round
  // bumps); higher values pinch crests laterally (Sea-of-Thieves-style
  // ridges). Each wave has a per-wave Q_BASE in waveConsts (chops sharper
  // than swells); this uniform multiplies all of them. Default 0.7 keeps the
  // sum Σ Q_eff · k · A well below the loop-formation limit (~1).
  const initialSteepness = Math.max(0, Math.min(1.5, Number(params?.get('steep') ?? '0.44')))
  const steepnessUniform = uniform(initialSteepness)

  // Pinch direction (degrees, 0..90). Rotates the Gerstner horizontal-
  // displacement vector relative to wave direction. 0° = standard
  // (along wave, sharpens crest LINES in direction of travel); 90° =
  // perpendicular (along crest-line axis, elongates ridges in the
  // direction the wave is moving). Stored as pre-computed cos/sin
  // pair so the rotation lives on the GPU side as two multiplies.
  const PINCH_DIRECTION_DEFAULT = 0
  const pinchDirectionUniform = uniform(PINCH_DIRECTION_DEFAULT)
  const pinchCosUniform = uniform(Math.cos((PINCH_DIRECTION_DEFAULT * Math.PI) / 180))
  const pinchSinUniform = uniform(Math.sin((PINCH_DIRECTION_DEFAULT * Math.PI) / 180))

  // The wave field is the single source of truth for the Gerstner params the
  // CPU buoyancy sampler reads; seed it from this mesh's construction defaults
  // so sim + render displace identically. The menu setters + `tick` keep them
  // in lockstep afterward.
  field.steepness = initialSteepness
  field.pinchCos = Math.cos((PINCH_DIRECTION_DEFAULT * Math.PI) / 180)
  field.pinchSin = Math.sin((PINCH_DIRECTION_DEFAULT * Math.PI) / 180)

  // Wave bearing (degrees, -180..180). Rotates the WHOLE wave field's
  // travel direction in world XZ so the user can re-aim the swell
  // train (e.g. "waves should be coming toward the island"). Applied
  // as a 2D rotation on the sample (x, z) before the phase calc —
  // mathematically equivalent to rotating every wave's (dirX, dirZ)
  // by +bearing without mutating the per-wave consts. Slopes that
  // come out of the phase calc are in the ROTATED frame and rotated
  // back to world XZ via the inverse rotation before being used by
  // the normal / shading pipeline (see `worldDydx`, `worldDydz`
  // below). CPU buoyancy mirrors this in `wave-field.ts::sampleSurface`
  // so render and physics stay locked.
  // Stored as degrees only — the vertex stage derives the effective
  // cos/sin per vertex inside `waveZoneFactors` (zones can override the
  // bearing locally, so a single pre-computed cos/sin pair no longer
  // covers the whole surface).
  const waveBearingDegUniform = uniform(WAVE_BEARING_DEFAULT)

  // Wave-set envelope (water-next-research §7.2) — `1 + depth·sin(ω·t + φ)`
  // multiplying the ambient amplitude on EVERY layer (center / outer /
  // skirt) via the zone heightMult slot. The three scalars mirror
  // `field.swellSet*` each tick() (omega pre-derived from periodS, depth
  // gated to 0 when the period is unset) so CPU buoyancy — which applies
  // `waveSetFactor` to the same slot — and the rendered surface breathe
  // through a set in lockstep. Pure function of the shared sim clock, so
  // it's deterministic and replay-safe by construction.
  const swellSetOmegaUniform = uniform(0)
  const swellSetDepthUniform = uniform(0)
  const swellSetPhaseUniform = uniform(0)
  const setEnvNode = float(1).add(
    swellSetDepthUniform.mul(sin(tNode.mul(swellSetOmegaUniform).add(swellSetPhaseUniform))),
  )

  // ---- Tunable scalars (water debug menu) -------------------------------
  // Each is a uniform so the menu can scrub it live without rebuilding the
  // material. Defaults match the values the v2 shader was authored against;
  // RESET in the menu restores them via `waterMesh.debug.defaults`.
  // Reflection cap pulled down from 0.85 → 0.55 so the deep turquoise
  // water body actually reads through the surface — at 0.85 fresnel at
  // race-camera-low view angles painted nearly the whole surface with
  // reflected horizon, hiding the wave color. 0.55 lets the body color
  // dominate troughs and reflection take over only at the truly grazing
  // edges where Schlick fresnel already saturates.
  const REFLECTION_STRENGTH_DEFAULT = 0.55
  const SUN_GLOW_DEFAULT = 0.6
  // Roughness base bumped back up — the previous 0.12 lit every chop
  // wavelet with a tight specular dot which the close-in band rendered
  // as a "sparkle storm" across the surface. 0.22 fuzzes the lobe so
  // close-in highlights blur into broader glints; sparkle patches
  // still tighten roughness toward `ROUGH_SPARKLE_DEFAULT` for the
  // wandering bright-glint character.
  const ROUGH_BASE_DEFAULT = 0.22
  const ROUGH_SPARKLE_DEFAULT = 0.06
  // Sub-Gerstner detail-normal strength. Pulled down from 1.4 → 0.5.
  // The previous value piled slopes onto every surface fragment and
  // pushed pixelFoam → 1 everywhere there was any chop, blowing the
  // surface out to white. The reference target wants clean glassy
  // wave faces (turquoise body visible through the surface) with
  // detail only providing texture, not silhouette. 0.5 keeps the
  // mip-filtered close-in chop reading as surface texture but doesn't
  // hijack the big-wave silhouette. `?detail=0` parks this at 0 for
  // A/B; `?detail=hi` (handled below) re-enables the punchier 1.4
  // for tracks that want the busier surface.
  const DETAIL_STRENGTH_DEFAULT = 0.5
  const reflStrengthUniform = uniform(REFLECTION_STRENGTH_DEFAULT)
  const sunGlowUniform = uniform(SUN_GLOW_DEFAULT)
  const roughBaseUniform = uniform(ROUGH_BASE_DEFAULT)
  const roughSparkleUniform = uniform(ROUGH_SPARKLE_DEFAULT)
  const detailStrengthUniform = uniform(DETAIL_STRENGTH_DEFAULT)
  // Debug colorize. When `debugColorizeMixUniform` is 1 each of the three
  // water layers is painted in a distinct flat color so the boundaries
  // between center mesh / outer LOD tile / horizon skirt are obvious —
  // pairs with the camera-locked transition markers used by the
  // water-test track to make the LOD architecture visible. The center
  // mesh's emissive (foam, sun glow, sun disc/streak) is faded by the
  // same factor so the colored zone reads clean rather than being
  // washed out by highlights.
  const CENTER_DEBUG_COLOR_DEFAULT = new THREE.Color(0.95, 0.18, 0.18)
  const OUTER_DEBUG_COLOR_DEFAULT = new THREE.Color(0.18, 0.85, 0.32)
  const SKIRT_DEBUG_COLOR_DEFAULT = new THREE.Color(0.22, 0.45, 0.98)
  const centerDebugColorUniform = uniform(CENTER_DEBUG_COLOR_DEFAULT)
  const outerDebugColorUniform = uniform(OUTER_DEBUG_COLOR_DEFAULT)
  const skirtDebugColorUniform = uniform(SKIRT_DEBUG_COLOR_DEFAULT)
  const debugColorizeMixUniform = uniform(0)
  // Per-wave amplitude is owned by `field.waves[i].amplitude` (the CPU
  // buoyancy field) and mirrored to the GPU live (see `waveAmpUniform`),
  // so the rendered surface and the buoyancy field can never disagree on
  // how tall the waves are. SWELL_INDICES tags the long-period swells vs
  // the chop bands so the debug menu's separate swell/chop sliders scale
  // the right subset, the P1 readability layers key on a swell-only
  // field, and the outer/skirt layers draw only the swells. Derived from
  // wavelength (≥ SWELL_WAVELENGTH_MIN) rather than hardcoded indices —
  // per-track spectrum banks (spectrum.ts) replace the default 6-wave
  // list with sorted generated components, so positions aren't stable
  // across tracks. For the default bank this lands on the historical
  // {0, 1}. `baseAmplitudes` is the pristine preset captured before any
  // per-track / menu scaling, so the sliders scale from a stable
  // baseline.
  const SWELL_INDICES = new Set(
    field.waves
      .map((w, i) => (w.wavelength >= SWELL_WAVELENGTH_MIN ? i : -1))
      .filter((i) => i >= 0),
  )
  const baseAmplitudes = field.waves.map((w) => w.amplitude)
  // Live per-wave amplitude uniform array. The vertex shader reads THIS
  // instead of a constant baked at construction, so every amplitude writer
  // — per-track Beaufort (main.ts), the per-lap storm ramp (lap-weather.ts),
  // and the swell/chop sliders below — lands on the rendered surface in
  // lockstep with CPU buoyancy, which samples the same `field.waves`.
  // `field.waves` is the single source of truth; `tick()` copies it here
  // each frame (≤6 scalars). This is what keeps "what you see" and "what the
  // rider floats on" identical.
  const liveWaveAmps = field.waves.map((w) => w.amplitude)
  const waveAmpUniform = uniformArray(liveWaveAmps, 'float')
  // Live swell-band amplitude sum — Σ|A_i| over SWELL_INDICES, from the
  // same mirrored uniform buoyancy reads. Three consumers: the shoaling-v2
  // break cap + the shore-wave swell drive (vertex stage, both × the set
  // envelope = the CPU's `shoalEffectiveSwell` / `shoreSwellDrive`), and
  // the P1 ramp's span normalisation (fragment).
  // biome-ignore lint/suspicious/noExplicitAny: TSL node accumulated across a JS-level loop
  let swellAmpSumAcc: any = float(0)
  for (const i of SWELL_INDICES) {
    // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray element
    swellAmpSumAcc = swellAmpSumAcc.add(abs(float(waveAmpUniform.element(i) as any)))
  }
  const swellAmpSum = float(swellAmpSumAcc)
  // Iso-coherence for the P1 readability field (ramp + contour lines +
  // relief twin — the `?waterlab` scene's primary knob). An iso-height line
  // of a height field sweeps at −∂h/∂t ÷ |∇h|: for a SINGLE wave train
  // that's exactly its phase speed everywhere, but for the multi-train
  // swell sum it exceeds the primary train's phase speed with sideways
  // direction wobble wherever the trains' slopes partially cancel (which
  // the deliberate set-beat pair guarantees every cycle; ~10–11 m/s vs
  // the 8.6 m/s primary at gated-in slopes, unbounded below the gate
  // where lines fade) — the "contour lines slide over the surface faster
  // than the water" artifact. At coherence 1 the readability field keys
  // to the DOMINANT swell train alone, so every contour rides the
  // primary swell at exactly its phase speed; 0 = legacy full swell sum.
  // Blended in the VERTEX stage so no extra varyings are spent; costs one
  // extra wave's sin/cos per vertex. Render-readability only — buoyancy,
  // shoaling and the drawn geometry never read it.
  const CONTOUR_COHERENCE_DEFAULT = 0
  const contourCoherenceUniform = uniform(CONTOUR_COHERENCE_DEFAULT)
  // Speed-coupled calm (Matt's call after the ?waterlab study): the slide
  // reads worst when the OBSERVER is still — standing riders, the intro
  // flyby — because nothing masks the line motion; at race speed your own
  // motion dominates and the livelier two-train field is fine. So tick()
  // drives the EFFECTIVE coherence toward 1 as the observer slows:
  //   effective = mix(authored base, 1, calmAtRest × (1 − speedFactor))
  // where speedFactor ramps 0→1 over CALM_SPEED_LO..HI m/s of smoothed
  // mesh-origin (camera) speed. At rest the lines pin to the primary swell
  // (riding the crests, never outrunning them); by ~swell phase speed the
  // authored look is fully back. calmAtRest 0 = no coupling (legacy).
  const CONTOUR_CALM_AT_REST_DEFAULT = 1
  let contourCoherenceBase = CONTOUR_COHERENCE_DEFAULT
  let contourCalmAtRest = CONTOUR_CALM_AT_REST_DEFAULT
  const CALM_SPEED_LO = 2
  const CALM_SPEED_HI = 11
  /** Observer-speed smoothing time constant, s — absorbs chase-cam bob and
   *  the 1 m origin snap without lagging a real launch/stop by much. */
  const CALM_SPEED_TAU = 0.6
  /** Instantaneous speed cap, m/s — a respawn/camera-cut teleport must not
   *  spike the EMA with a 1-frame multi-hundred-m/s sample. */
  const CALM_SPEED_MAX = 60
  let observerSpeedSmoothed = 0
  let observerPrevX: number | null = null
  let observerPrevZ: number | null = null
  let observerPrevMs: number | null = null
  let dominantSwellIndex = -1
  for (const i of SWELL_INDICES) {
    const a = Math.abs(baseAmplitudes[i] ?? 0)
    if (dominantSwellIndex < 0 || a > Math.abs(baseAmplitudes[dominantSwellIndex] ?? 0)) {
      dominantSwellIndex = i
    }
  }
  const DOMINANT_SWELL_INDICES: ReadonlySet<number> = new Set(
    dominantSwellIndex >= 0 ? [dominantSwellIndex] : [],
  )
  // Live |A| of the dominant train — the ramp's span normalisation follows
  // the coherence blend (full swell span ↔ dominant-only span) so band
  // centring holds at any coherence. (Amplitude writers scale the swell
  // band together, so the static argmax pick stays the live dominant.)
  const dominantSwellAmpAbs =
    dominantSwellIndex >= 0
      ? // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray element
        abs(float(waveAmpUniform.element(dominantSwellIndex) as any))
      : float(0)
  // Shoaling-v2 blend (legacy kill-switch ↔ surf), mirroring
  // `field.shoalSurfStrength` — the setter writes both, like steepness.
  const SHOAL_SURF_DEFAULT = 1.0
  const shoalSurfUniform = uniform(SHOAL_SURF_DEFAULT)
  // Time scale for the main loop. Stored here rather than as a uniform
  // because dt is consumed by `advanceWaveField` on the CPU side; the
  // shader reads `field.time` regardless of how fast it advances.
  let timeScale = 1

  // World-XZ origin of the mesh — set by `tick(...)` to the camera's XZ
  // each frame so the mesh follows the camera. The wave / wake math
  // samples at WORLD coords (positionLocal + meshOrigin), so the surface
  // stays continuous in world space even though the mesh slides under
  // the camera. This keeps the dense-vertex region pinned to the visible
  // area regardless of where the player has driven on the lagoon.
  const meshOriginX = uniform(0)
  const meshOriginZ = uniform(0)

  // Terrain heightmap (top-down max-Y) sampled by the vertex shader to
  // attenuate wave displacement in shallow water and by the fragment shader
  // to drive depth-driven surf foam at the waterline. A fixed-size
  // placeholder filled with `DEEP_SENTINEL` is allocated at construction
  // so the shader compiles + binds safely on every platform;
  // `setTerrainHeightmap` copies the track's baked data into this same
  // texture in-place (so the GPU-side texture binding never changes,
  // avoiding driver re-allocation pitfalls). While disabled,
  // `terrainEnabledUniform = 0` makes the shader treat the whole sea as
  // bottomless — full waves, no surf foam.
  const TERRAIN_HEIGHTMAP_RES = TERRAIN_HEIGHTMAP_RESOLUTION
  const DEEP_HALF = THREE.DataUtils.toHalfFloat(-10000)
  const heightmapData = new Uint16Array(TERRAIN_HEIGHTMAP_RES * TERRAIN_HEIGHTMAP_RES)
  heightmapData.fill(DEEP_HALF)
  const terrainHeightTex = new THREE.DataTexture(
    heightmapData,
    TERRAIN_HEIGHTMAP_RES,
    TERRAIN_HEIGHTMAP_RES,
    THREE.RedFormat,
    THREE.HalfFloatType,
  )
  terrainHeightTex.name = 'water:terrainHeightmap'
  terrainHeightTex.minFilter = THREE.LinearFilter
  terrainHeightTex.magFilter = THREE.LinearFilter
  terrainHeightTex.wrapS = THREE.ClampToEdgeWrapping
  terrainHeightTex.wrapT = THREE.ClampToEdgeWrapping
  terrainHeightTex.generateMipmaps = false
  terrainHeightTex.needsUpdate = true
  const terrainMinUniform = uniform(new THREE.Vector2(0, 0))
  const terrainMaxUniform = uniform(new THREE.Vector2(1, 1))
  const terrainEnabledUniform = uniform(0)
  // Absolute water surface Y in world space. Mirrors `mesh.position.y`,
  // which `main.ts` sets from `track.water.height`. Used to compute
  // `waterDepth = waterY − terrainY` for shoaling + surf.
  const waterYUniform = uniform(0)
  // Wave amplitude reaches full strength by `SHOAL_FADE_DEPTH` (3 m) of depth
  // and smoothly fades to zero at the waterline (depth = 0). The constant now
  // lives in `wave-field.ts` so the CPU buoyancy sampler attenuates by the
  // SAME shoaling factor (a drift test enforces the single source) — without
  // that, the rider floats on a full-amplitude surface the shader never draws
  // and sinks below the seabed in shallow water.

  // Shore field (RGBA16F): R = distance-to-shore (m), G = offshore normal X,
  // B = offshore normal Z, A = water depth (m). Same coverage + resolution as
  // the terrain heightmap, so the vertex shader reuses `terrainU`/`terrainV`
  // to sample it. Drives shore-aligned waves: crests parallel to the coast,
  // marching shoreward, that bring the formerly-dead near-shore band to life.
  // Allocated once and filled in-place by `setTerrainHeightmap` (the shore
  // field rides on the same `TerrainHeightmap` object). While
  // `shoreEnabledUniform = 0` (no coastline / editor) the term is bypassed.
  const SHORE_WAVE_STRENGTH_DEFAULT = 1.0
  const shoreFieldData = new Uint16Array(TERRAIN_HEIGHTMAP_RES * TERRAIN_HEIGHTMAP_RES * 4)
  const shoreFieldTex = new THREE.DataTexture(
    shoreFieldData,
    TERRAIN_HEIGHTMAP_RES,
    TERRAIN_HEIGHTMAP_RES,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  )
  shoreFieldTex.name = 'water:shoreField'
  shoreFieldTex.minFilter = THREE.LinearFilter
  shoreFieldTex.magFilter = THREE.LinearFilter
  shoreFieldTex.wrapS = THREE.ClampToEdgeWrapping
  shoreFieldTex.wrapT = THREE.ClampToEdgeWrapping
  shoreFieldTex.generateMipmaps = false
  shoreFieldTex.needsUpdate = true
  const shoreEnabledUniform = uniform(0)
  const shoreWaveStrengthUniform = uniform(SHORE_WAVE_STRENGTH_DEFAULT)

  // Bike slot uniform array. Each vec4 = (px, pz, vx, vz). Inactive slots
  // are parked at INACTIVE_FAR so their Gaussian + wake fall off to zero.
  // Velocity is stored UNWEIGHTED — `weights[i]` is the separate fade
  // multiplier (so that wake amplitude scales linearly with weight while
  // direction stays accurate even at small weights).
  const bikeSlots: THREE.Vector4[] = []
  const bikeWeights: number[] = []
  for (let i = 0; i < MAX_BIKES; i++) {
    bikeSlots.push(new THREE.Vector4(INACTIVE_FAR, INACTIVE_FAR, 0, 0))
    bikeWeights.push(0)
  }
  const bikesUniform = uniformArray(bikeSlots, 'vec4')
  const weightsUniform = uniformArray(bikeWeights, 'float')

  // Wake-trail uniform arrays — MAX_BIKES blocks of WAKE_TRAIL_POINTS slots.
  // Per point: vec4(x, z, arcLen, dropTime) + a separate strength float
  // (airborne weight × speed gate, baked at drop so a bike that slows keeps
  // the fast wake it already laid). Slot order inside a block is
  // oldest→newest with slot WAKE_TRAIL_POINTS-1 the live head (the bike's
  // current position) — the shader walks consecutive pairs as segments with
  // no head-segment special case. Unfilled slots park at INACTIVE_FAR so
  // their segments fail the MAX_SEG gate.
  // Wake-trail uniform blocks — a GPU copy of the SIM's `field.trails`
  // (wake-trail.ts), re-uploaded each tick(). Per point: vec4(x, z, arcLen,
  // dropTime) + a separate strength float. Slot order inside a block is
  // oldest→newest with the last slot the live head (the bike's current
  // position) — the shader walks consecutive pairs as segments with no
  // head-segment special case. Unfilled slots park at INACTIVE_FAR so their
  // segments fail the MAX_SEG gate.
  const wakeTrailSlots: THREE.Vector4[] = []
  const wakeTrailStrengths: number[] = []
  for (let i = 0; i < MAX_WAKE_TRAILS * WAKE_TRAIL_POINTS; i++) {
    wakeTrailSlots.push(new THREE.Vector4(INACTIVE_FAR, INACTIVE_FAR, 0, 0))
    wakeTrailStrengths.push(0)
  }
  const wakeTrailUniform = uniformArray(wakeTrailSlots, 'vec4')
  const wakeTrailStrengthUniform = uniformArray(wakeTrailStrengths, 'float')
  // Per-trail cull circle, CPU-fit each frame over the live points:
  // vec4(centerX, centerZ, radius², headArc). Tighter than a bike-centered
  // circle (the trail extends ~30 m BEHIND the bike) and one compare per
  // trail per vertex/fragment. headArc rides along so the shader can turn a
  // segment's interpolated arc into "meters behind the bike". (Render-only
  // view data — the sim's sampler reject is its own AABB on the trail.)
  const wakeTrailCulls: THREE.Vector4[] = []
  for (let i = 0; i < MAX_WAKE_TRAILS; i++) {
    wakeTrailCulls.push(new THREE.Vector4(INACTIVE_FAR, INACTIVE_FAR, 0, 0))
  }
  const wakeTrailCullUniform = uniformArray(wakeTrailCulls, 'vec4')
  // Trail-wake master strength (debug knob): scales foam AND displacement.
  // RENDER-ONLY — buoyancy ignores it (a localStorage-persisted knob must
  // never reach the deterministic sim), so any value ≠ 1 desyncs the drawn
  // ridge from the felt one. Dev/tuning setting, not a shippable look.
  const WAKE_STRENGTH_DEFAULT = 1.0
  const wakeStrengthUniform = uniform(WAKE_STRENGTH_DEFAULT)

  type WaveConst = {
    k: number
    omega: number
    dirX: number
    dirZ: number
    amp: number
    phase: number
    /** Per-wave steepness coefficient (multiplied at runtime by the global
     * `steepnessUniform`). Higher values pinch the wave's crest laterally;
     * 0 falls back to a pure heightfield (no horizontal displacement).
     * Tuned per-wave so chops are sharper (more "ridge"-like) than the
     * long swells (which stay rolling). */
    qBase: number
  }
  // Per-wave Q comes from the wave field (`defaultWaves` sets it), so this
  // shader and the CPU buoyancy sampler pinch crests by the same per-wave
  // amount — they share one source of truth.
  const waveConsts: WaveConst[] = field.waves.map((w) => {
    const k = (2 * Math.PI) / w.wavelength
    return {
      k,
      omega: w.speed * k,
      dirX: w.dirX,
      dirZ: w.dirZ,
      amp: w.amplitude,
      phase: w.phase,
      qBase: w.qBase ?? 0.7,
    }
  })

  // ---- Per-track wave zones (sim↔render sync) ----------------------------
  //
  // Wave zones are authored OBBs that locally scale wave amplitude
  // (heightMult), wavelength (freqMult), override the swell bearing, and add
  // a periodic surge. The CPU buoyancy sampler has applied them since they
  // shipped (`sampleZoneFactors` in wave-field.ts); this block is the GPU
  // half — without it the rider FEELS zone waves the player never SEES
  // (sandbar's 0.5× calm, The Maw's 1.4×/0.85-freq swell, Mexico City's local
  // 1.3×). The math below mirrors `zoneWeight` + `sampleZoneFactors`
  // EXACTLY, quirks included:
  //
  //  - smoothstep OBB falloff: weight 1 inside the box, cubic-smoothstep to
  //    0 across `blendRadiusM` outside the 2D face (Y ignored for surface
  //    samples).
  //  - soft-max blend: the strongest-weighted zone wins on heightMult /
  //    freqMult / bearing (each lerped toward neutral by its weight);
  //    surges from ALL zones sum.
  //  - the bearing override is "sticky": a later, stronger zone WITHOUT an
  //    override does not clear a weaker zone's override (CPU loop keeps
  //    `bestBearing` across iterations). Also note the override snaps at
  //    any weight > 0 rather than blending — a direction-override zone has
  //    a hard phase seam at its blend-radius edge on both CPU and GPU. No
  //    shipped track uses `directionDeg`; if one ever does, consider
  //    blending phase on BOTH sides in lockstep.
  //
  // Data is packed into fixed-size uniform arrays (MAX_WAVE_ZONES slots —
  // the constant is imported from wave-field.ts, where `setWaveZones`
  // truncates the CPU list to the same cap):
  //   A: (centerX, centerZ, cosYaw, sinYaw)
  //   B: (halfWidth, halfDepth, blendRadiusM, heightMult)
  //   C: (freqMult, bearingOverrideRad, hasBearingOverride, surgeOmega)
  //   surgeAmp: float
  // Slots are populated by `syncWaveZones` (called from `tick` whenever
  // `field.zones` is replaced — `setWaveZones` always installs a new array,
  // so a reference check suffices). Zones with blendRadiusM ≤ 0 are skipped
  // at upload: the CPU's `zoneWeight` returns 0 everywhere for them
  // (`outsideDist >= blendRadiusM` is true even at distance 0), so dropping
  // them is exact and saves the per-vertex divide-by-zero guard.
  //
  // Cost: one evaluation per vertex per water layer (center / outer /
  // skirt), shared by every wave function via the returned factors. The
  // per-zone body runs under a uniform branch (`i < count`), so tracks
  // without zones pay ~nothing and shipped tracks pay for 1–2 zones, not 8.
  const waveZoneSlotsA: THREE.Vector4[] = []
  const waveZoneSlotsB: THREE.Vector4[] = []
  const waveZoneSlotsC: THREE.Vector4[] = []
  const waveZoneSurgeAmps: number[] = []
  for (let i = 0; i < MAX_WAVE_ZONES; i++) {
    waveZoneSlotsA.push(new THREE.Vector4(0, 0, 1, 0))
    waveZoneSlotsB.push(new THREE.Vector4(1, 1, 1, 1))
    waveZoneSlotsC.push(new THREE.Vector4(1, 0, 0, 0))
    waveZoneSurgeAmps.push(0)
  }
  const waveZonesAUniform = uniformArray(waveZoneSlotsA, 'vec4')
  const waveZonesBUniform = uniformArray(waveZoneSlotsB, 'vec4')
  const waveZonesCUniform = uniformArray(waveZoneSlotsC, 'vec4')
  const waveZoneSurgeAmpUniform = uniformArray(waveZoneSurgeAmps, 'float')
  const waveZoneCountUniform = uniform(0)

  // ---- Authored wave stamps (water-next-research §7.10, P3.2) -----------
  //
  // The signature jump waves: crest segment + traveling sech² pulse,
  // evaluated per vertex from fixed-size uniform arrays (MAX_WAVE_STAMPS
  // slots; `setWaveStamps` truncates the CPU list to the same cap).
  // Packing, per slot:
  //   A: (x0, z0, ux, uz)            — segment origin + unit direction
  //   B: (len, amplitude, widthM, periodS)
  //   C: (phase01, speed, approachM, 0)
  // `syncWaveStamps` uploads on reference change (setWaveStamps installs a
  // new array), exactly like the zone sync.
  // ONE shared event-uniform array for stamps (3 vec4 rows each) AND the
  // splash rings (1 vec4 each, appended after the stamp block). WebGPU
  // caps UNIFORM BUFFERS at 12 per stage and every TSL uniformArray is
  // its own buffer — four separate event arrays blew the vertex stage to
  // 14 ("exceeds the maximum per-stage limit"), the bind-group cousin of
  // the 16-varying cap. Packing layout:
  //   [i*3 + 0]  stamp i row A: (x0, z0, ux, uz)
  //   [i*3 + 1]  stamp i row B: (len, amplitude, widthM, periodS)
  //   [i*3 + 2]  stamp i row C: (phase01, speed, approachM, 0)
  //   [RING_BASE + j]  ring j: (x, z, t0, amp)
  //   [CONTACT_BASE + k]  contact k: (x, z, radius, strength) — waterline
  //                       obstacle foam collars (water-contacts.ts)
  const WAVE_EVENT_RING_BASE = MAX_WAVE_STAMPS * 3
  const WAVE_EVENT_CONTACT_BASE = WAVE_EVENT_RING_BASE + MAX_SPLASH_RINGS
  const waveEventSlots: THREE.Vector4[] = []
  for (let i = 0; i < WAVE_EVENT_CONTACT_BASE + MAX_WATER_CONTACTS; i++) {
    waveEventSlots.push(new THREE.Vector4(0, 0, 0, 0))
  }
  // Park ring slots dead (t0 = −1e9 → age far past LIFE). Contact slots park
  // at radius 0 (the collar band evaluates to 0 there) and are further gated
  // by the count uniform.
  for (let j = 0; j < MAX_SPLASH_RINGS; j++) {
    waveEventSlots[WAVE_EVENT_RING_BASE + j]!.set(0, 0, -1e9, 0)
  }
  const waveEventsUniform = uniformArray(waveEventSlots, 'vec4')
  const waveStampCountUniform = uniform(0)

  // Per-vertex stamp evaluation — two TSL Fns over the same unrolled
  // slot loop (an Fn body is required for If/toVar; one Fn can return only
  // one node, hence the geometry/signals split — the same constraint that
  // split gerstnerHeight/gerstnerDisp). Mirrors `computeStamps` in
  // wave-field.ts term for term: the same sech² pulse, life/feather
  // envelopes, and depth cap (GPU depth comes from the terrain heightmap —
  // the same bake the CPU's shore field carries).
  //
  //  - waveStampGeometry → vec3(y, dy/dx, dy/dz): the ridge the vertex
  //    rides (travel-direction slopes only, like the CPU).
  //  - waveStampSignals → vec2(curv, rise): the crest curvature
  //    (−∂²y/∂d², a thin whitecap line on the stamp's crest) and ∂h/∂t
  //    (leading-edge bias on its rising face) — fed into the foam stack so
  //    an authored jump wave foams like any natural breaking crest.
  //
  // biome-ignore lint/suspicious/noExplicitAny: TSL node-graph builder values
  function emitStampLoop(xN: any, zN: any, tN: any, depthN: any, emit: 'geometry' | 'signals') {
    const out0 = float(0).toVar()
    const out1 = float(0).toVar()
    const out2 = float(0).toVar()
    // Dynamic loop to the live stamp count — ONE emitted body instead of
    // MAX_WAVE_STAMPS unrolled copies (×2 call sites). Slot math is identical
    // per iteration, so the surface is unchanged; only the generated WGSL
    // shrinks (pipeline-compile time is the boot lever).
    Loop(
      { start: int(0), end: int(waveStampCountUniform), type: 'int', condition: '<' },
      ({ i }) => {
        // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray swizzle proxy
        const a = waveEventsUniform.element(int(i).mul(3)) as any
        // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray swizzle proxy
        const b = waveEventsUniform.element(int(i).mul(3).add(1)) as any
        // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray swizzle proxy
        const cc = waveEventsUniform.element(int(i).mul(3).add(2)) as any
        const x0 = float(a.x)
        const z0 = float(a.y)
        const ux = float(a.z)
        const uz = float(a.w)
        const segLen = float(b.x)
        const amplitude = float(b.y)
        const widthM = float(b.z)
        const periodS = float(b.w)
        const phase01 = float(cc.x)
        const speed = float(cc.y)
        const approachM = float(cc.z)
        const releaseM = approachM.mul(float(STAMP_RELEASE_RATIO))
        // Pulse center for this cycle (fract = the CPU's mod-floor).
        const tt = fract(tN.div(periodS).add(phase01))
        const c = approachM.negate().add(tt.mul(speed).mul(periodS))
        // Segment frame.
        const rx = xN.sub(x0)
        const rz = zN.sub(z0)
        const sAlong = rx.mul(ux).add(rz.mul(uz))
        const nxN = uz.negate()
        const nzN = ux
        const d = rx.mul(nxN).add(rz.mul(nzN))
        const xi = d.sub(c).div(widthM)
        // Life + feather envelopes (mirror computeStamps; smoothstep is the
        // same cubic both sides).
        const life = smoothstep(approachM.negate(), approachM.negate().mul(float(0.55)), c).mul(
          float(1).sub(smoothstep(releaseM.mul(float(0.25)), releaseM, c)),
        )
        const feather = smoothstep(float(0), float(STAMP_END_FEATHER_M), sAlong).mul(
          float(1).sub(smoothstep(segLen.sub(float(STAMP_END_FEATHER_M)), segLen, sAlong)),
        )
        // Depth cap (no-op in bottomless water: depth is huge there).
        const amp = max(min(amplitude, float(STAMP_DEPTH_CAP).mul(depthN)), float(0))
        // sech/tanh via one exp (clamped ξ keeps exp finite; sech² ≈ 0 by
        // |ξ| = 6 anyway, matching the CPU early-out).
        const xiC = clamp(xi, float(-6), float(6))
        const eP = exp(xiC)
        const eM = float(1).div(eP)
        const sech = float(2).div(eP.add(eM))
        const sech2 = sech.mul(sech)
        const tanhN = eP.sub(eM).div(eP.add(eM))
        const envelope = amp.mul(life).mul(feather)
        if (emit === 'geometry') {
          out0.addAssign(envelope.mul(sech2))
          const dyDd = envelope.mul(float(-2)).div(widthM).mul(sech2).mul(tanhN)
          out1.addAssign(dyDd.mul(nxN))
          out2.addAssign(dyDd.mul(nzN))
        } else {
          // −∂²y/∂d² = (E/w²)·(2sech⁴ − 4sech²tanh²) peaks at the pulse
          // crest; ∂h/∂t (pulse-motion term) > 0 on the rising front face.
          out0.addAssign(
            envelope
              .div(widthM.mul(widthM))
              .mul(float(2).mul(sech2).mul(sech2).sub(float(4).mul(sech2).mul(tanhN).mul(tanhN))),
          )
          out1.addAssign(envelope.mul(float(2)).div(widthM).mul(sech2).mul(tanhN).mul(speed))
        }
      },
    )
    return { out0, out1, out2 }
  }
  const waveStampGeometry = Fn(([x, z, t, depth]: [unknown, unknown, unknown, unknown]) => {
    const r = emitStampLoop(x, z, t, depth, 'geometry')
    return vec3(r.out0, r.out1, r.out2)
  })
  const waveStampSignals = Fn(([x, z, t, depth]: [unknown, unknown, unknown, unknown]) => {
    const r = emitStampLoop(x, z, t, depth, 'signals')
    return vec2(r.out0, r.out1)
  })

  let lastUploadedStamps: readonly WaveStampRuntime[] | null = null
  function syncWaveStamps(): void {
    if (field.stamps === lastUploadedStamps) return
    lastUploadedStamps = field.stamps
    let n = 0
    for (const st of field.stamps) {
      if (n >= MAX_WAVE_STAMPS) break
      waveEventSlots[n * 3]!.set(st.x0, st.z0, st._ux, st._uz)
      waveEventSlots[n * 3 + 1]!.set(st._len, st.amplitude, st.widthM, st.periodS)
      waveEventSlots[n * 3 + 2]!.set(st.phase01 ?? 0, st.speed, st.approachM, 0)
      n++
    }
    waveStampCountUniform.value = n
  }

  // ---- Splash rings (water-next-research §7.5, P4.1) ---------------------
  //
  // Landing event waves: the sim's `field.rings` pool (splash-rings.ts)
  // mirrored into a fixed uniform array — vec4(x, z, t0, amp) per slot,
  // re-uploaded every tick like the wake trails (rings mutate in place;
  // 12 vec4s is nothing). The vertex Fn below evaluates the identical
  // closed form the CPU samplers use, so the bump a trailing rider feels
  // from someone's landing IS the ring the player sees radiate.
  const SPLASH_RING_STRENGTH_DEFAULT = 1.0
  const splashRingStrengthUniform = uniform(SPLASH_RING_STRENGTH_DEFAULT)
  function syncSplashRings(): void {
    for (let i = 0; i < MAX_SPLASH_RINGS; i++) {
      const ring = field.rings[i]
      const slot = waveEventSlots[WAVE_EVENT_RING_BASE + i]!
      if (ring) slot.set(ring.x, ring.z, ring.t0, ring.amp)
      else slot.set(0, 0, -1e9, 0)
    }
  }

  // vec3(y, dy/dx, dy/dz) — mirror of `sampleSplashRings` (vy is CPU-only).
  // Dead slots (t0 = −1e9 → age past LIFE) zero out via the age gate.
  const splashRingSum = Fn(([x, z, t]: [unknown, unknown, unknown]) => {
    const xN = x as ReturnType<typeof float>
    const zN = z as ReturnType<typeof float>
    const tN = t as ReturnType<typeof float>
    const y = float(0).toVar()
    const dydx = float(0).toVar()
    const dydz = float(0).toVar()
    // Dynamic loop over the ring slots — one emitted body instead of
    // MAX_SPLASH_RINGS unrolled copies (dead slots still zero out via the
    // age gate, exactly as before; only the generated WGSL shrinks).
    Loop(MAX_SPLASH_RINGS, ({ i }) => {
      // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray swizzle proxy
      const slot = waveEventsUniform.element(int(i).add(WAVE_EVENT_RING_BASE)) as any
      const ox = float(slot.x)
      const oz = float(slot.y)
      const t0 = float(slot.z)
      const ampRaw = float(slot.w)
      const age = tN.sub(t0)
      // Age gate folds the slot-dead case in (huge age → 0).
      const aliveT = clamp(float(1).sub(age.div(float(SPLASH_RING_LIFE_S))), float(0), float(1))
      If(aliveT.greaterThan(float(0)).and(age.greaterThan(float(0))), () => {
        const dx = xN.sub(ox)
        const dz = zN.sub(oz)
        const r = sqrt(dx.mul(dx).add(dz.mul(dz)).add(float(1e-9)))
        const R = age.mul(float(SPLASH_RING_SPEED))
        const xi = clamp(r.sub(R).div(float(SPLASH_RING_WIDTH)), float(-6), float(6))
        const decay = aliveT.mul(aliveT)
        const spread = float(1).div(sqrt(float(1).add(R)))
        const eP = exp(xi)
        const eM = float(1).div(eP)
        const sech = float(2).div(eP.add(eM))
        const sech2 = sech.mul(sech)
        const tanhN = eP.sub(eM).div(eP.add(eM))
        const envelope = ampRaw.mul(splashRingStrengthUniform).mul(decay).mul(spread)
        y.addAssign(envelope.mul(sech2))
        const dyDr = envelope.mul(float(-2)).div(float(SPLASH_RING_WIDTH)).mul(sech2).mul(tanhN)
        dydx.addAssign(dyDr.mul(dx).div(r))
        dydz.addAssign(dyDr.mul(dz).div(r))
      })
    })
    return vec3(y, dydx, dydz)
  })

  // ---- Waterline contact foam (obstacle collars) --------------------------
  //
  // Static obstacles that pierce the surface — bridge pillars, placed rocks,
  // dock pylons — discovered by water-contacts.ts and uploaded nearest-first
  // into the shared event array (slots CONTACT_BASE+, one vec4 each:
  // x, z, radius, strength). Each gets a foam collar hugging the mesh at the
  // waterline plus faint concentric wash ripples drifting outward — the
  // "sea acknowledges the world" read. SHADING ONLY: contacts add zero
  // displacement, so unlike rings/stamps there is no buoyancy mirror to keep
  // in lockstep — the sim never knows they exist.
  //
  // The collar breathes with the live sea: brightness + width surge as the
  // local ambient crest sweeps through (the same signal the shoreline surf
  // keys on), so a passing wave visibly washes UP the obstacle instead of
  // sliding under it. The contact-splash particle driver fires off the same
  // crests, so foam and spray agree about when the sea is angry.
  const CONTACT_FOAM_DEFAULT = 1.0
  const contactFoamStrengthUniform = uniform(CONTACT_FOAM_DEFAULT)
  const waterContactCountUniform = uniform(0)
  // Fragment-stage sum. `ambientH` is the un-attenuated ambient wave height
  // at the fragment (≥ 0 on crests) — the crest-pass pulse.
  const contactFoamSum = Fn(([x, z, t, ambientH]: [unknown, unknown, unknown, unknown]) => {
    const xN = x as ReturnType<typeof float>
    const zN = z as ReturnType<typeof float>
    const tN = t as ReturnType<typeof float>
    const ambientHN = ambientH as ReturnType<typeof float>
    const foam = float(0).toVar()
    // Dynamic loop to the live contact count — one emitted body instead of
    // MAX_WATER_CONTACTS (24!) unrolled copies in the fragment stage, and the
    // GPU only iterates the populated slots instead of predicating all 24.
    Loop(
      { start: int(0), end: int(waterContactCountUniform), type: 'int', condition: '<' },
      ({ i }) => {
        // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray swizzle proxy
        const slot = waveEventsUniform.element(int(i).add(WAVE_EVENT_CONTACT_BASE)) as any
        const cx = float(slot.x)
        const cz = float(slot.y)
        const radius = float(slot.z)
        const strength = float(slot.w)
        const dx = xN.sub(cx)
        const dz = zN.sub(cz)
        const r = sqrt(dx.mul(dx).add(dz.mul(dz)).add(float(1e-6)))
        const edge = r.sub(radius) // 0 at the rim, positive outside
        // Crest-pass pulse: how tall the local ambient sea stands right here,
        // squashed to 0..1. Drives collar brightness AND width so a passing
        // wave widens the wash as it climbs the obstacle.
        const pulse = clamp(ambientHN.mul(float(0.8)), float(0), float(1))
        const collarW = clamp(radius.mul(float(0.55)), float(0.5), float(2.2)).mul(
          float(1).add(pulse.mul(float(0.7))),
        )
        // Band: peaks at the rim, gone by collarW outward. The inner gate
        // keeps foam out of the disc interior so thin/open obstacles (gate
        // posts, lattice legs) don't read as a filled white disc.
        const band = float(1)
          .sub(smoothstep(float(0), collarW, edge))
          .mul(smoothstep(radius.mul(float(0.3)), radius.mul(float(0.85)), r))
        // Wash ripples: concentric wavelets drifting outward off the rim
        // (~0.5 m/s, ~1.2 m wavelength), damped within ~2.6 collar widths.
        // Squared so they read as discrete crests; per-contact phase from
        // the centre coordinate breaks cross-contact sync.
        const ringPhase = edge
          .mul(float(5.2))
          .sub(tN.mul(float(2.6)))
          .add(cx.mul(float(0.7)))
        const ringWave = sin(ringPhase).mul(float(0.5)).add(float(0.5))
        const ringDamp = float(1).sub(smoothstep(float(0), collarW.mul(float(2.6)), edge))
        const ripples = ringWave.mul(ringWave).mul(ringDamp).mul(float(0.3))
        // Calm seas keep a quiet lap line (base 0.5); crests surge the core.
        const core = band.mul(float(0.5).add(pulse.mul(float(0.75))))
        const washing = ripples.mul(float(0.45).add(pulse.mul(float(0.55))))
        foam.assign(max(foam, strength.mul(core.add(washing))))
      },
    )
    return foam.mul(contactFoamStrengthUniform)
  })

  // CPU-side contact store + nearest-N upload. The LIST is static per track
  // (or swapped live by the dev hook / floating-prop follower), but the slot
  // SELECTION tracks the camera-locked mesh origin with a 12 m hysteresis so
  // big tracks with more contacts than slots always spend the budget on the
  // discs the player can actually see.
  let liveContacts: readonly WaterContact[] = []
  let contactSelectionDirty = false
  let lastContactOriginX = Infinity
  let lastContactOriginZ = Infinity
  function setWaterContacts(contacts: readonly WaterContact[]): void {
    liveContacts = contacts
    contactSelectionDirty = true
  }
  function syncWaterContacts(originX: number, originZ: number): void {
    const dxO = originX - lastContactOriginX
    const dzO = originZ - lastContactOriginZ
    if (!contactSelectionDirty && dxO * dxO + dzO * dzO < 12 * 12) return
    contactSelectionDirty = false
    lastContactOriginX = originX
    lastContactOriginZ = originZ
    const picked = selectNearestContacts(liveContacts, originX, originZ, MAX_WATER_CONTACTS)
    for (let i = 0; i < MAX_WATER_CONTACTS; i++) {
      const c = picked[i]
      if (c) waveEventSlots[WAVE_EVENT_CONTACT_BASE + i]!.set(c.x, c.z, c.radius, c.strength)
      else waveEventSlots[WAVE_EVENT_CONTACT_BASE + i]!.set(0, 0, 0, 0)
    }
    waterContactCountUniform.value = Math.min(picked.length, MAX_WATER_CONTACTS)
  }

  // Blended zone factors at world (x, z) and field time t. Returns
  // vec4(heightMult, freqMult, effectiveBearingRad, surgeY) — the effective
  // bearing defaults to the GLOBAL wave bearing so callers can take cos/sin
  // of `.z` unconditionally (zones with no override leave it untouched).
  const waveZoneFactors = Fn(([x, z, t]: [unknown, unknown, unknown]) => {
    const xN = x as ReturnType<typeof float>
    const zN = z as ReturnType<typeof float>
    const tN = t as ReturnType<typeof float>
    const bestWeight = float(0).toVar()
    const heightMult = float(1).toVar()
    const freqMult = float(1).toVar()
    const bearingRad = float(waveBearingDegUniform)
      .mul(float(Math.PI / 180))
      .toVar()
    const surgeY = float(0).toVar()
    for (let i = 0; i < MAX_WAVE_ZONES; i++) {
      If(float(i).lessThan(waveZoneCountUniform), () => {
        // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray swizzle proxy
        const a = waveZonesAUniform.element(i) as any
        // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray swizzle proxy
        const b = waveZonesBUniform.element(i) as any
        // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray swizzle proxy
        const c = waveZonesCUniform.element(i) as any
        // Wrap every component in float() so downstream abs/max/mul resolve
        // to the scalar overloads (a raw `any` swizzle resolves them to
        // vec-returning ones) — same trick as the shore-field sample.
        const centerX = float(a.x)
        const centerZ = float(a.y)
        const cosYaw = float(a.z)
        const sinYaw = float(a.w)
        const halfW = float(b.x)
        const halfD = float(b.y)
        const blendR = float(b.z)
        const zHeightMult = float(b.w)
        const zFreqMult = float(c.x)
        const zBearingRad = float(c.y)
        const zHasBearing = float(c.z)
        const zSurgeOmega = float(c.w)
        // World → zone local: subtract centre, rotate by -yaw. Mirror of
        // `zoneWeight` in wave-field.ts.
        const dx = xN.sub(centerX)
        const dz = zN.sub(centerZ)
        const lx = dx.mul(cosYaw).add(dz.mul(sinYaw))
        const lz = dz.mul(cosYaw).sub(dx.mul(sinYaw))
        const qx = abs(lx).sub(halfW)
        const qz = abs(lz).sub(halfD)
        const outX = max(qx, float(0))
        const outZ = max(qz, float(0))
        const outsideDist = sqrt(outX.mul(outX).add(outZ.mul(outZ)))
        // t = 1 − d/blendRadius; cubic smoothstep; ≤ 0 → weight 0. The
        // uploader guarantees blendRadius > 0 for live slots.
        const w = smoothstep(float(0), float(1), float(1).sub(outsideDist.div(blendR)))
        If(w.greaterThan(bestWeight), () => {
          // Soft-max: strongest-weighted zone wins on mults / bearing.
          bestWeight.assign(w)
          heightMult.assign(float(1).add(zHeightMult.sub(float(1)).mul(w)))
          freqMult.assign(float(1).add(zFreqMult.sub(float(1)).mul(w)))
          // Sticky override — only ASSIGNED when the winning zone has one,
          // mirroring the CPU's keep-previous-value behaviour.
          If(zHasBearing.greaterThan(float(0.5)), () => {
            bearingRad.assign(zBearingRad)
          })
        })
        // Surges accumulate across zones (additive, not soft-maxed):
        // amp · max(0, sin(ω_surge · t)) · weight.
        // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray element
        const surgeAmp = float(waveZoneSurgeAmpUniform.element(i) as any)
        surgeY.addAssign(surgeAmp.mul(max(float(0), sin(tN.mul(zSurgeOmega)))).mul(w))
      })
    }
    return vec4(heightMult, freqMult, bearingRad, surgeY)
  })

  // Gerstner — heightfield part: returns vec3(y, dy/dx, dy/dz). These are the
  // same values you'd get from a vertical-only sum of sines, used both for the
  // wave's vertical displacement and for the x/z components of the surface
  // normal (cosine slopes). Waves are unrolled at build time. Per-wave amp
  // is read live from `waveAmpUniform` (mirrors `field.waves[i].amplitude`),
  // so per-track Beaufort, the lap-weather storm ramp, and the debug menu's
  // swell/chop sliders all show on the surface in lockstep with buoyancy.
  // Zone factors (zHeightMult / zFreqMult / the effective-bearing cos/sin)
  // arrive pre-blended from `waveZoneFactors` — passed in rather than
  // re-evaluated so one zone pass per vertex serves every wave function.
  //
  // Built per index-subset: `null` = the full bank (the center plane's
  // truth), SWELL_INDICES = the long-period swells only. The swell variant
  // serves two consumers:
  //  - the P1 readability layers key on a swell-only field (chop in the key
  //    carves the bands/lines into squiggles — §4.3's cel-session lesson);
  //  - the OUTER TILE + HORIZON SKIRT geometry (P2.2): at 380 m+ the chop
  //    bands are sub-pixel AND under-sampled by the outer's 5.6 m vertex
  //    grid (alias shimmer, not detail) — the silhouette only needs the
  //    swells, and dropping chop there keeps those layers' vertex cost
  //    flat as per-track spectrum banks grow the component count.
  const buildGerstnerHeight = (indices: ReadonlySet<number> | null) =>
    Fn(
      ([x, z, t, zHeightMult, zFreqMult, zCosB, zSinB]: [
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
      ]) => {
        const xN = x as ReturnType<typeof float>
        const zN = z as ReturnType<typeof float>
        const tN = t as ReturnType<typeof float>
        const hm = zHeightMult as ReturnType<typeof float>
        const fm = zFreqMult as ReturnType<typeof float>
        const cosB = zCosB as ReturnType<typeof float>
        const sinB = zSinB as ReturnType<typeof float>
        // Apply the EFFECTIVE wave-bearing rotation (global, or the winning
        // zone's override — pre-resolved by `waveZoneFactors`) to the sample
        // coords — equivalent to rotating every wave's (dirX, dirZ) by
        // +bearing. Slopes accumulate in the rotated frame and get rotated
        // back to world frame after the per-wave loop (chain rule).
        const xRot = xN.mul(cosB).add(zN.mul(sinB))
        const zRot = zN.mul(cosB).sub(xN.mul(sinB))
        const y = float(0).toVar()
        const rotDydx = float(0).toVar()
        const rotDydz = float(0).toVar()
        for (let i = 0; i < waveConsts.length; i++) {
          if (indices && !indices.has(i)) continue
          const w = waveConsts[i]!
          // Live per-wave amplitude (mirrors `field.waves[i].amplitude`); the
          // wavenumber/direction/phase stay baked. See `waveAmpUniform`.
          // Zone heightMult scales amplitude. Zone freqMult scales the
          // DYNAMIC part of the phase: k' = k·fm and ω' = speed·k' = ω·fm,
          // so k'·(D·x) − ω'·t = fm·(k·(D·x) − ω·t) — the static phase
          // offset is NOT scaled. Mirror of `sampleHeight` in wave-field.ts.
          // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray element
          const ampI = waveAmpUniform.element(i) as any
          const ampZ = hm.mul(ampI)
          const phase = float(w.k * w.dirX)
            .mul(xRot)
            .add(float(w.k * w.dirZ).mul(zRot))
            .sub(tN.mul(w.omega))
            .mul(fm)
            .add(float(w.phase))
          const s = sin(phase)
          const c = cos(phase)
          y.addAssign(s.mul(ampZ))
          rotDydx.addAssign(
            c
              .mul(ampZ)
              .mul(float(w.k * w.dirX))
              .mul(fm),
          )
          rotDydz.addAssign(
            c
              .mul(ampZ)
              .mul(float(w.k * w.dirZ))
              .mul(fm),
          )
        }
        // Rotate the rotated-frame slopes back to world XZ.
        const dydx = rotDydx.mul(cosB).sub(rotDydz.mul(sinB))
        const dydz = rotDydx.mul(sinB).add(rotDydz.mul(cosB))
        return vec3(y, dydx, dydz)
      },
    )
  const gerstnerHeight = buildGerstnerHeight(null)
  const gerstnerSwellHeight = buildGerstnerHeight(SWELL_INDICES)
  // Dominant-train-only variant for the readability iso-coherence blend
  // (see CONTOUR_COHERENCE_DEFAULT above). Drawn geometry never uses it.
  const gerstnerDominantSwellHeight = buildGerstnerHeight(DOMINANT_SWELL_INDICES)

  // Analytic crest signals for curvature-based whitecap foam (foam pass v3).
  // Two extra sums over the same waves the height uses — both reuse sin/cos so
  // they cost almost nothing, and both are STEEPNESS-INDEPENDENT: they read the
  // raw height field, not the Gerstner pinch (which Matt no longer uses because
  // its sim↔render phase drifts — so visuals must not lean on it).
  //   .x = crest curvature = Σ A·k²·sin(phase)  — the negative Laplacian of the
  //        height field: most POSITIVE at sharp crests, negative in troughs (the
  //        fragment clamps ≥0 so only crests foam). Sharply peaked at the crest,
  //        so foam reads as a thin line on the crest, not a wide height band.
  //   .y = ∂h/∂t = −Σ A·ω·cos(phase)  — vertical surface velocity: >0 where the
  //        water is RISING = the leading/FRONT face of an advancing crest, <0 on
  //        the trailing face. Drives the leading-edge bias.
  // Both are rotation-invariant scalars (a Laplacian and a time derivative), so
  // unlike the slopes there's no rotate-back — the bearing only enters via the
  // rotated phase, which is identical to gerstnerHeight's.
  const gerstnerCrestSignals = Fn(
    ([x, z, t, zHeightMult, zFreqMult, zCosB, zSinB]: [
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
    ]) => {
      const xN = x as ReturnType<typeof float>
      const zN = z as ReturnType<typeof float>
      const tN = t as ReturnType<typeof float>
      const hm = zHeightMult as ReturnType<typeof float>
      const fm = zFreqMult as ReturnType<typeof float>
      const cosB = zCosB as ReturnType<typeof float>
      const sinB = zSinB as ReturnType<typeof float>
      const xRot = xN.mul(cosB).add(zN.mul(sinB))
      const zRot = zN.mul(cosB).sub(xN.mul(sinB))
      const curv = float(0).toVar()
      const dhdt = float(0).toVar()
      for (let i = 0; i < waveConsts.length; i++) {
        const w = waveConsts[i]!
        // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray element
        const ampI = waveAmpUniform.element(i) as any
        // Zone factors flow through the derivatives consistently with the
        // zone-scaled height: amplitude × hm, k² × fm², ω × fm — so foam
        // signals fire on the crests the player actually sees inside zones.
        const ampZ = hm.mul(ampI)
        const phase = float(w.k * w.dirX)
          .mul(xRot)
          .add(float(w.k * w.dirZ).mul(zRot))
          .sub(tN.mul(w.omega))
          .mul(fm)
          .add(float(w.phase))
        curv.addAssign(
          sin(phase)
            .mul(ampZ)
            .mul(float(w.k * w.k))
            .mul(fm)
            .mul(fm),
        )
        dhdt.addAssign(cos(phase).mul(ampZ).mul(float(-w.omega)).mul(fm))
      }
      return vec2(curv, dhdt)
    },
  )

  // Gerstner — horizontal-displacement part: returns vec3(dx, dz, qSum).
  // The horizontal displacement is what produces the SoT-style pinched
  // ridges (vs round bumps). qSum is the y-component reduction in the
  // normal formula (GPU Gems eq.13: N.y = 1 - Σ Q·k·A·sin(phase)).
  // Two-Fn split (rather than one monolithic Fn) is forced by TSL's single-
  // node return; the duplicated sin/cos per wave is trivial on a real GPU.
  // With Q=0 (`?water=classic`) this Fn returns vec3(0, 0, 0) and the
  // surface collapses to the pure heightfield case.
  //
  // Built per index-subset like `buildGerstnerHeight` — the swell-only
  // variant displaces the outer tile (whose height also sums only swells;
  // a full-bank pinch on a swell-only height would shear phantom chop
  // texture into geometry that doesn't carry it).
  const buildGerstnerDisp = (indices: ReadonlySet<number> | null) =>
    Fn(
      ([x, z, t, zHeightMult, zFreqMult, zCosB, zSinB]: [
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
      ]) => {
        const xN = x as ReturnType<typeof float>
        const zN = z as ReturnType<typeof float>
        const tN = t as ReturnType<typeof float>
        const hm = zHeightMult as ReturnType<typeof float>
        const fm = zFreqMult as ReturnType<typeof float>
        const cosB = zCosB as ReturnType<typeof float>
        const sinB = zSinB as ReturnType<typeof float>
        // Bearing-rotated sample coords (same convention as gerstnerHeight).
        const xRot = xN.mul(cosB).add(zN.mul(sinB))
        const zRot = zN.mul(cosB).sub(xN.mul(sinB))
        // dx, dz accumulate in the rotated frame; we rotate back to world
        // XZ at the end so the horizontal displacement applied to the
        // vertex position uses world coordinates.
        const dxRot = float(0).toVar()
        const dzRot = float(0).toVar()
        const qSum = float(0).toVar()
        for (let i = 0; i < waveConsts.length; i++) {
          if (indices && !indices.has(i)) continue
          const w = waveConsts[i]!
          // Live per-wave amplitude (mirrors `field.waves[i].amplitude`); see
          // `waveAmpUniform`. Wavenumber/direction/phase stay baked. Zone
          // factors scale amplitude (hm) and the dynamic phase / wavenumber
          // (fm) exactly as in gerstnerHeight, mirrored by the CPU's
          // `ambientDisp` so the buoyancy inverse map lands on this surface.
          // biome-ignore lint/suspicious/noExplicitAny: TSL uniformArray element
          const ampI = waveAmpUniform.element(i) as any
          const ampZ = hm.mul(ampI)
          const phase = float(w.k * w.dirX)
            .mul(xRot)
            .add(float(w.k * w.dirZ).mul(zRot))
            .sub(tN.mul(w.omega))
            .mul(fm)
            .add(float(w.phase))
          const s = sin(phase)
          const c = cos(phase)
          const qScaled = steepnessUniform.mul(float(w.qBase))
          // Horizontal displacement: P.x += Q·A·D.x · cos(phase),
          //                          P.z += Q·A·D.z · cos(phase)
          //
          // The displacement DIRECTION is rotated by `pinchDirection`
          // (a uniform-driven 2D rotation) from the wave direction
          // (dirX, dirZ). At 0° the displacement runs along the wave,
          // particles bulge forward, and crest LINES sharpen in the
          // direction of travel — standard Gerstner. At 90° the
          // displacement runs along the crest-line axis (the
          // perpendicular: (-dirZ, dirX)), so particles bulge along
          // the crest and the wave reads as elongated ridges running
          // in the direction of travel instead of short across-axis
          // bumps. The CPU buoyancy sampler inverse-maps this exact
          // displacement (`ambientDisp` mirrors this loop, pinch and
          // zone factors included) so the bike floats on the pinched
          // surface the shader draws.
          const rotDirX = float(w.dirX).mul(pinchCosUniform).sub(float(w.dirZ).mul(pinchSinUniform))
          const rotDirZ = float(w.dirX).mul(pinchSinUniform).add(float(w.dirZ).mul(pinchCosUniform))
          dxRot.addAssign(qScaled.mul(rotDirX).mul(ampZ).mul(c))
          dzRot.addAssign(qScaled.mul(rotDirZ).mul(ampZ).mul(c))
          // Normal y-component reduction: Σ Q · k' · A' · sin(phase)
          qSum.addAssign(qScaled.mul(float(w.k)).mul(fm).mul(ampZ).mul(s))
        }
        // Rotate the rotated-frame horizontal displacement back to
        // world XZ so the vertex shader can add it to positionLocal.xz
        // in world coords.
        const dx = dxRot.mul(cosB).sub(dzRot.mul(sinB))
        const dz = dxRot.mul(sinB).add(dzRot.mul(cosB))
        return vec3(dx, dz, qSum)
      },
    )
  const gerstnerDisp = buildGerstnerDisp(null)
  const gerstnerSwellDisp = buildGerstnerDisp(SWELL_INDICES)

  // Nearest-segment scan over one bike's wake trail. JS-level code-gen
  // helper, NOT a TSL Fn — it emits the scan inline wherever it's called
  // (must be inside an Fn body: it uses If/Loop + toVar) and returns the
  // result registers as an object, which a TSL Fn's single return value
  // can't do. Called once per bike by BOTH the vertex displacement and the
  // fragment foam, so the trail parameterization can't drift between them.
  //
  // Walks the WAKE_TRAIL_POINTS-1 consecutive segment pairs (slot layout:
  // oldest→newest, last slot = live bike head) and keeps the segment whose
  // CAPSULE distance to (xN, zN) is smallest. Returns:
  //  - dist2:      squared capsule distance (lateral inside the polyline;
  //                naturally rounds the tail cap so the wake can't smear
  //                past the oldest point)
  //  - perpSigned: lateral offset signed by the segment normal — the stroke
  //                sheet's V coordinate
  //  - behind:     arc-meters back from the live head (the trail "behind")
  //  - arc:        absolute arc length at the foot — the stroke sheet's U
  //                coordinate; pinned to the path so laid foam STAYS PUT
  //  - strength:   per-point drop strength lerped along the segment
  //  - age:        seconds since the foot's points were dropped
  //  - dirX/dirZ:  unit direction fragment←foot (∇ of the capsule distance,
  //                the displacement gradient direction)
  // All zero/huge when no live segment is in range (strength 0 kills every
  // downstream term).
  //
  // `trailIndex` is a TSL int node (the caller's per-trail loop var), so this
  // body is emitted ONCE per stage and iterated, instead of MAX_WAKE_TRAILS
  // unrolled copies — the wake-trail WGSL was the single biggest contributor
  // to the water pipeline's compile time.
  // biome-ignore lint/suspicious/noExplicitAny: TSL node-graph builder values
  function emitTrailScan(trailIndex: any, xN: any, zN: any, tN: any) {
    const base = int(trailIndex).mul(WAKE_TRAIL_POINTS)
    // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
    const cull = wakeTrailCullUniform.element(int(trailIndex)) as any
    const headArc = cull.w
    const bestD2 = float(1e9).toVar()
    const bestPerpSigned = float(0).toVar()
    const bestBehind = float(0).toVar()
    const bestArc = float(0).toVar()
    const bestStrength = float(0).toVar()
    const bestAge = float(0).toVar()
    const bestDirX = float(0).toVar()
    const bestDirZ = float(0).toVar()
    Loop(WAKE_TRAIL_POINTS - 1, ({ i }) => {
      const idxA = base.add(i)
      const idxB = idxA.add(int(1))
      // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
      const a = wakeTrailUniform.element(idxA) as any
      // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
      const b = wakeTrailUniform.element(idxB) as any
      const abx = b.x.sub(a.x)
      const abz = b.y.sub(a.y)
      const segLen2 = abx.mul(abx).add(abz.mul(abz)).toVar()
      // Live segments only: INACTIVE_FAR padding and teleport gaps fail the
      // MAX_SEG gate; the lower floor drops degenerate zero-length pairs.
      If(segLen2.lessThan(float(WAKE_TRAIL_MAX_SEG * WAKE_TRAIL_MAX_SEG)), () => {
        If(segLen2.greaterThan(float(1e-6)), () => {
          const apx = xN.sub(a.x)
          const apz = zN.sub(a.y)
          const tSeg = clamp(apx.mul(abx).add(apz.mul(abz)).div(segLen2), float(0), float(1))
          const dxF = apx.sub(abx.mul(tSeg))
          const dzF = apz.sub(abz.mul(tSeg))
          const d2 = dxF.mul(dxF).add(dzF.mul(dzF))
          If(d2.lessThan(bestD2), () => {
            bestD2.assign(d2)
            // Lateral offset signed by the left-of-travel normal (a→b is
            // older→newer, i.e. the direction the bike rode).
            bestPerpSigned.assign(
              dzF
                .mul(abx)
                .sub(dxF.mul(abz))
                .div(max(sqrt(segLen2), float(1e-4))),
            )
            const arcAtFoot = mix(a.z, b.z, tSeg)
            bestArc.assign(arcAtFoot)
            bestBehind.assign(max(headArc.sub(arcAtFoot), float(0)))
            // biome-ignore lint/suspicious/noExplicitAny: TSL UniformArrayElementNode lacks float-typing in TS
            const sA = wakeTrailStrengthUniform.element(idxA) as any
            // biome-ignore lint/suspicious/noExplicitAny: TSL UniformArrayElementNode lacks float-typing in TS
            const sB = wakeTrailStrengthUniform.element(idxB) as any
            bestStrength.assign(mix(sA, sB, tSeg))
            bestAge.assign(max(tN.sub(mix(a.w, b.w, tSeg)), float(0)))
            const d = max(sqrt(d2), float(1e-4))
            bestDirX.assign(dxF.div(d))
            bestDirZ.assign(dzF.div(d))
          })
        })
      })
    })
    return {
      dist2: bestD2,
      perpSigned: bestPerpSigned,
      behind: bestBehind,
      arc: bestArc,
      strength: bestStrength,
      age: bestAge,
      dirX: bestDirX,
      dirZ: bestDirZ,
    }
  }

  // Per-bike vertex contribution: hull dimple (subtractive, from the
  // bike's CURRENT position) + trail-wake ridge displacement (additive,
  // evaluated along the sim's recorded path — see the wake-trail block).
  // Returns vec3(deltaY, ddelta/dx, ddelta/dz) so callers do
  // `wave + bikeContrib`.
  //
  // Dimple:  -D · exp(-r² / R²)
  // Wake:    A · strength(drop) · trans(perp) · ramp(b) · decay(b)
  //          · sin(K · b − Ω · t) · agefade · knob
  // where b = arc-meters behind the live head and perp = capsule distance to
  // the trail polyline. EXACT mirror of the sim's `sampleWakeFromTrail`
  // (same trail points via the uniforms, same profile constants), so the
  // ridge a trailing rider feels through buoyancy is the ridge drawn here —
  // straights, turns, gaps and all. Change one and the other must move.
  const bikeSurfaceContrib = Fn(([x, z, t]: [unknown, unknown, unknown]) => {
    const xN = x as ReturnType<typeof float>
    const zN = z as ReturnType<typeof float>
    const tN = t as ReturnType<typeof float>
    const y = float(0).toVar()
    const dydx = float(0).toVar()
    const dydz = float(0).toVar()
    const invR2 = 1 / (BIKE_DIMPLE_R * BIKE_DIMPLE_R)
    for (let i = 0; i < MAX_BIKES; i++) {
      // ----- Dimple (close-in band around the live bike) -----
      // TSL's UniformArrayElementNode types don't expose vec4 swizzles even
      // though the runtime proxy makes `.x`/`.y`/`.z`/`.w` work. Cast to
      // `any` so the build-time TS check stops complaining without us
      // losing the runtime ergonomics.
      // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
      const slot = bikesUniform.element(i) as any
      // biome-ignore lint/suspicious/noExplicitAny: TSL types lose precision here
      const dx = xN.sub(slot.x) as any
      // biome-ignore lint/suspicious/noExplicitAny: TSL types lose precision here
      const dz = zN.sub(slot.y) as any
      const r2 = dx.mul(dx).add(dz.mul(dz))
      If(r2.lessThan(float(BIKE_DIMPLE_CULL_R_SQ)), () => {
        const e = exp(r2.mul(-invR2))
        const depth = e.mul(-BIKE_DIMPLE_DEPTH)
        y.addAssign(depth)
        // d(depth)/dx = depth · (-2 dx / R²) — note: depth is negative
        // here (dimple is subtractive), so the gradient sign also flips.
        dydx.addAssign(depth.mul(dx).mul(-2 * invR2))
        dydz.addAssign(depth.mul(dz).mul(-2 * invR2))
      })
    }
    // Dynamic per-trail loop ('ti' — distinct name so it can't shadow the
    // segment scan's inner 'i'). One ridge body in the WGSL instead of
    // MAX_WAKE_TRAILS unrolled copies. (`name` is supported by LoopNode at
    // runtime; the published .d.ts lags, hence the casts.)
    Loop(
      // biome-ignore lint/suspicious/noExplicitAny: LoopNode accepts `name` at runtime
      { start: int(0), end: int(MAX_WAKE_TRAILS), type: 'int', condition: '<', name: 'ti' } as any,
      // biome-ignore lint/suspicious/noExplicitAny: named loop var surfaces under its custom key
      ({ ti }: any) => {
        // ----- Trail-wake ridge (whole recorded path) -----
        // Per-trail CPU-fit cull circle: one compare for the common case
        // (vertex nowhere near this trail). The circle is parked at
        // INACTIVE_FAR with r²=0 for slots with no live trail.
        // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
        const cull = wakeTrailCullUniform.element(int(ti)) as any
        // biome-ignore lint/suspicious/noExplicitAny: TSL types lose precision here
        const cdx = xN.sub(cull.x) as any
        // biome-ignore lint/suspicious/noExplicitAny: TSL types lose precision here
        const cdz = zN.sub(cull.y) as any
        If(cdx.mul(cdx).add(cdz.mul(cdz)).lessThan(cull.z), () => {
          const scan = emitTrailScan(ti, xN, zN, tN)
          If(scan.strength.greaterThan(float(0.001)), () => {
            const perp = sqrt(scan.dist2)
            const behind = scan.behind
            const wakeWidth = behind.mul(WAKE_HALF_ANGLE_TAN).add(float(WAKE_BASE_WIDTH))
            // Two-piece signed transverse profile (Kelvin-style V):
            //   inside V (perp < wakeWidth):   -cos(π · perp / wakeWidth)
            //                                   → -1 at axis (trough), +1 at edge (ridge)
            //   outside V (perp >= wakeWidth): linear fade 1 → 0 over halfwidth
            // Combined: `insidePart * fadeOut`. For perp <= wakeWidth, fadeOut=1
            // so the cosine dominates. For perp > wakeWidth, insidePart clamps
            // to +1 (cos(π) = -1, negated → 1) and fadeOut handles the falloff.
            const insideArg = min(perp, wakeWidth).div(wakeWidth).mul(Math.PI)
            const insidePart = cos(insideArg).negate()
            const fadeOut = max(
              float(0),
              float(1).sub(max(float(0), perp.sub(wakeWidth)).div(float(WAKE_EDGE_BELL_HALFWIDTH))),
            )
            const transverseSigned = insidePart.mul(fadeOut)
            const longRamp = float(1).sub(exp(behind.mul(-WAKE_LONG_RAMP)))
            const longDecay = exp(behind.mul(-WAKE_LONG_DECAY))
            // Transverse "scallops" (M9.35): sin(K · behind − ω · t) modulates
            // the ridge along its length; the pattern drifts backward along
            // the trail as t advances — now following the ridden path.
            const longPhase = tN.mul(-WAKE_TRANS_OMEGA).add(behind.mul(WAKE_TRANS_K))
            const transverseMod = float(1).add(sin(longPhase).mul(WAKE_TRANS_AMP))
            const ageFade = exp(scan.age.div(-WAKE_AGE_TAU))
            const amp = float(WAKE_DISP_AMP)
              .mul(scan.strength)
              .mul(longRamp)
              .mul(longDecay)
              .mul(transverseMod)
              .mul(ageFade)
              .mul(wakeStrengthUniform)
            y.addAssign(amp.mul(transverseSigned))
            // Approximate gradient: dominated by the lateral direction (the V
            // shape's slope across the trail). scan.dirX/dirZ is ∇(capsule
            // distance), so the inside-V slope rides it directly. Drops the
            // longitudinal-decay cross-term (small at typical scale), same as
            // the old heading-ray version.
            const dProfileDPerp = sin(insideArg).mul(float(Math.PI).div(wakeWidth))
            const ampDProfile = amp.mul(dProfileDPerp)
            dydx.addAssign(ampDProfile.mul(scan.dirX))
            dydz.addAssign(ampDProfile.mul(scan.dirZ))
          })
        })
      },
    )
    return vec3(y, dydx, dydz)
  })

  // Vertex stage: ambient Gerstner waves + fused per-bike contribution
  // (hull dimple subtracts, wake adds — see `bikeSurfaceContrib` for the
  // sign handling). The mesh slides under the camera each frame, so we
  // sample the wave/wake field at WORLD coords (`positionLocal + meshOrigin`)
  // — that keeps the surface continuous in world space even as the mesh's
  // local origin moves.
  //
  // We use the standard Gerstner formulation (GPU Gems Ch.1) — vertices
  // are displaced both horizontally and vertically, so crests pinch into
  // ridges instead of being round bumps:
  //
  //   P.x = x0 + Σ Q_i · A_i · D_i.x · cos(phase_i)
  //   P.y = y0 + Σ A_i · sin(phase_i)
  //   P.z = z0 + Σ Q_i · A_i · D_i.z · cos(phase_i)
  //
  // The closed-form normal from GPU Gems eq. 13:
  //   N = (-Σ A·k·D.x·cos, 1 - Σ Q·k·A·sin, -Σ A·k·D.z·cos)
  //
  // Note that the heightfield slopes (Σ A·k·D.x·cos) are the SAME values
  // we'd compute for a pure heightfield Gerstner; the only new term in
  // the normal is the y-component reduction (`qSum`). With Q=0 (classic
  // mode) the formula collapses exactly to the old heightfield normal.
  //
  // We compute the gradients here at the vertex stage and forward them
  // via `varying(...)` so the fragment can build the surface normal from
  // interpolated values instead of re-running the Gerstner sum per pixel.
  // Per-vertex + interp is visually indistinguishable here because the
  // mesh resolution (≈ 0.6 m) is finer than the wave gradient.
  //
  // Physics-side note: wave-field.ts (CPU buoyancy) keeps the simpler
  // vertical-only formulation. With low-to-moderate Q, the rendered
  // surface and the buoyancy field stay within ~0.4 m of each other
  // horizontally — well below visible disconnect for a hoverbike skimming
  // the surface. If steepness is pushed past 1, consider a Newton iteration
  // on the CPU side to recover the rest position from world XZ.
  const worldX = positionLocal.x.add(meshOriginX)
  const worldZ = positionLocal.z.add(meshOriginZ)
  // Per-track wave-zone factors at this vertex — evaluated ONCE and shared
  // by every wave function below (height, disp, crest signals, foam
  // accumulator). vec4(heightMult, freqMult, effectiveBearingRad, surgeY);
  // cos/sin of the effective bearing are taken here so the wave Fns get
  // them pre-computed. Tracks without zones resolve to the neutral
  // (1, 1, global bearing, 0) and the surface is bit-identical to the
  // pre-zone shader.
  const zoneFx = waveZoneFactors(worldX, worldZ, tNode)
  // Wave-set envelope rides the same amplitude-multiplier slot as the
  // zones — every wave function below (height, disp, crest signals, foam
  // accumulator, swell-only signals) inherits it through this one product,
  // exactly like the CPU samplers' `envHeightMult`.
  const zoneHeightMult = zoneFx.x.mul(setEnvNode)
  const zoneFreqMult = zoneFx.y
  const zoneCosBearing = cos(zoneFx.z)
  const zoneSinBearing = sin(zoneFx.z)
  const zoneSurgeY = zoneFx.w
  // Big-wave source: sums the unrolled `waveConsts` array analytically
  // per vertex. Returns vec3(y, dy/dx, dy/dz) for the heightfield part
  // and vec3(dx, dz, qSum) for the Tessendorf horizontal-displacement
  // part; `qSum` is the GPU-Gems-eq.13 normal-Y reduction from
  // horizontal pinching, used downstream by the SoT-style peak-mask
  // SSS path.
  const vertexHeight = gerstnerHeight(
    worldX,
    worldZ,
    tNode,
    zoneHeightMult,
    zoneFreqMult,
    zoneCosBearing,
    zoneSinBearing,
  )
  const vertexDisp = gerstnerDisp(
    worldX,
    worldZ,
    tNode,
    zoneHeightMult,
    zoneFreqMult,
    zoneCosBearing,
    zoneSinBearing,
  )
  const vertexBike = bikeSurfaceContrib(worldX, worldZ, tNode)
  // vertexHeight = vec3(y, dy/dx, dy/dz)
  // vertexDisp   = vec3(dx, dz, qSum)
  // vertexBike   = vec3(deltaY, ddelta/dx, ddelta/dz)

  // Terrain-driven shoaling. Sample the baked top-down terrain heightmap
  // at this vertex's world XZ, compute vertical water depth, and fade the
  // wave displacement smoothly to zero as depth → 0. This is the geometric
  // fix for wave crests poking up through shoreline / seabed geometry:
  // wherever the water plane sits above terrain, depth is positive and
  // waves swing freely; wherever terrain rises into or above the water,
  // depth pinches toward zero and the waves flatten out. Real shoaling
  // physics actually steepens waves before breaking — that's modeled in
  // the fragment surf foam below instead, where it shows up as visible
  // breakers without risking geometry clipping.
  //
  // While `terrainEnabledUniform = 0` (no heightmap installed yet, e.g.
  // editor mode) we force `effectiveTerrainY` to the deep sentinel so the
  // shoal factor reads 1 and the original full-amplitude behaviour stays
  // intact. Out-of-AABB sampling falls back the same way: water past the
  // baked terrain area (open-horizon backdrop) reads as deep ocean.
  const tMin = terrainMinUniform
  const tMax = terrainMaxUniform
  const terrainU = worldX.sub(tMin.x).div(tMax.x.sub(tMin.x))
  const terrainV = worldZ.sub(tMin.y).div(tMax.y.sub(tMin.y))
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
  const terrainSample = texture(terrainHeightTex, vec2(terrainU, terrainV)) as any
  const sampledTerrainY = terrainSample.r
  const inU = float(1)
    .sub(smoothstep(float(0.998), float(1.002), terrainU))
    .mul(smoothstep(float(-0.002), float(0.002), terrainU))
  const inV = float(1)
    .sub(smoothstep(float(0.998), float(1.002), terrainV))
    .mul(smoothstep(float(-0.002), float(0.002), terrainV))
  const inBounds = inU.mul(inV).mul(terrainEnabledUniform)
  const effectiveTerrainY = mix(float(-10000), sampledTerrainY, inBounds)
  const vertexWaterDepth = waterYUniform.sub(effectiveTerrainY)
  // Shoaling factor — exact mirror of the CPU's `shoalAttenuation` (two
  // regimes blended by the shared `shoalSurfStrength` scalar):
  //  - LEGACY (blend 0): quadratic fade to flat below SHOAL_FADE_DEPTH —
  //    the original geometric kill-switch.
  //  - SURF v2 (blend 1, default — water-next-research §7.3): Green's-law
  //    gain as the swell feels the bottom (clamped (REF/d)^¼ ≤ GAIN_MAX),
  //    capped by depth-limited breaking γ·d / H_eff — the cap doubles as
  //    the seabed guard (trough ≥ −γ·d), which is what lets surf stay
  //    ALIVE right up the beach where the quadratic had flattened it.
  // H_eff = live swell-band Σ|A| × the set envelope (mirrored scalars), so
  // a big set breaks farther out — on both sides identically.
  const shoalRaw = clamp(vertexWaterDepth.div(float(SHOAL_FADE_DEPTH)), float(0), float(1))
  const shoalLegacy = shoalRaw.mul(shoalRaw)
  const shoalHEff = max(float(SHOAL_HEFF_MIN), swellAmpSum.mul(setEnvNode))
  const shoalDepthPos = max(vertexWaterDepth, float(1e-4))
  const shoalGain = clamp(
    pow(float(SHOAL_GREEN_REF_DEPTH).div(shoalDepthPos), float(0.25)),
    float(1),
    float(SHOAL_GAIN_MAX),
  )
  const shoalBreakCap = float(SHOAL_BREAK_GAMMA).mul(shoalDepthPos).div(shoalHEff)
  // step() zeroes the factor on dry land (depth ≤ 0), mirroring the CPU's
  // early-out.
  const shoalSurf = min(shoalGain, shoalBreakCap).mul(step(float(0), vertexWaterDepth))
  const shoalFactor = mix(shoalLegacy, shoalSurf, shoalSurfUniform)

  // Apply the shoaling attenuation to BOTH the ambient swell/chop and the
  // horizontal Gerstner displacement. Wake (bikeSurfaceContrib) is left at
  // full strength: the bike is always in deep-enough water to ride, and
  // the wake is what gives the racing surface its sense of motion. Slopes
  // get the same multiplier so the surface normal stays consistent with
  // the attenuated height — without this, calm shallows would still
  // shimmer with crest-strength sun glints.
  const attenAmbient = vertexHeight.x.mul(shoalFactor)
  const attenDydx = vertexHeight.y.mul(shoalFactor)
  const attenDydz = vertexHeight.z.mul(shoalFactor)
  const attenDispX = vertexDisp.x.mul(shoalFactor)
  const attenDispZ = vertexDisp.y.mul(shoalFactor)
  const attenQSum = vertexDisp.z.mul(shoalFactor)

  // Shore-aligned wave. Sample the baked shore field (shares the terrain AABB,
  // so reuse terrainU/terrainV). Crests run parallel to the coast and march
  // shoreward (phase = K·dist + Ω·t); amplitude peaks in the surf band and is
  // capped by the water column so a trough can't breach the seabed. This is a
  // pure vertical term (no horizontal displacement) — the exact mirror of
  // `computeShore` in wave-field.ts (shared SHORE_* consts + the identical
  // baked field), so buoyancy and the rendered surface agree. Gated to zero
  // by `shoreEnabledUniform` when no coastline is installed.
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
  const shoreSample = texture(shoreFieldTex, vec2(terrainU, terrainV)) as any
  // Wrap each component in float() so downstream min/max/mul resolve to the
  // scalar overloads (a raw `any` swizzle resolves them to vec-returning ones).
  const shoreDist = float(shoreSample.r)
  const shoreNrmRawX = float(shoreSample.g)
  const shoreNrmRawZ = float(shoreSample.b)
  const shoreDepth = float(shoreSample.a)
  // Renormalise the offshore normal — bilinear filtering shrinks it near the
  // medial axis (matches the CPU sampler's renormalise-or-zero).
  const shoreNrmLen = max(
    sqrt(shoreNrmRawX.mul(shoreNrmRawX).add(shoreNrmRawZ.mul(shoreNrmRawZ))),
    float(1e-4),
  )
  const shoreNrmX = shoreNrmRawX.div(shoreNrmLen)
  const shoreNrmZ = shoreNrmRawZ.div(shoreNrmLen)
  const shoreBandGate = float(1).sub(smoothstep(float(0), float(SHORE_BAND_DEPTH), shoreDepth))
  // Shore-wave v2 (shoaling v2): the breaker amplitude scales with the
  // live ambient swell — Σ|A_swell| × set envelope vs the shipped
  // reference, clamped — so calm lagoons lap and storm sets pound. The
  // depth cap keeps the final word (seabed guard). Mirror of
  // `shoreSwellDrive` in wave-field.ts; `shoalSurfUniform` blends the
  // drive away toward the legacy constant amplitude.
  const shoreDriveRaw = clamp(
    swellAmpSum.mul(setEnvNode).div(float(SHORE_SWELL_DRIVE_REF)),
    float(SHORE_SWELL_DRIVE_MIN),
    float(SHORE_SWELL_DRIVE_MAX),
  )
  const shoreDrive = mix(float(1), shoreDriveRaw, shoalSurfUniform)
  const shoreAmpCap = min(
    float(SHORE_AMP).mul(shoreDrive),
    float(SHORE_DEPTH_CAP).mul(max(shoreDepth, float(0))),
  )
  const shoreAmp = shoreAmpCap
    .mul(shoreBandGate)
    .mul(shoreWaveStrengthUniform)
    .mul(shoreEnabledUniform)
  const shorePhase = float(SHORE_K)
    .mul(shoreDist)
    .add(tNode.mul(float(SHORE_OMEGA)))
    .add(float(SHORE_PHASE))
  const shoreSin = sin(shorePhase)
  const shoreCos = cos(shorePhase)
  // Breaker-forward asymmetry (shoaling v2): phase-locked second harmonic
  // leans each breaker's shoreward face steeper than its back — y/A =
  // sin φ + a₂·sin(2φ + β). Mirror of `computeShore`; fades in with the
  // surf blend.
  const shoreAsym = float(SHORE_ASYM).mul(clamp(shoalSurfUniform, float(0), float(1)))
  const shorePhase2 = shorePhase.mul(float(2)).add(float(SHORE_ASYM_PHASE))
  const shoreSin2 = sin(shorePhase2)
  const shoreCos2 = cos(shorePhase2)
  const shoreY = shoreAmp.mul(shoreSin.add(shoreAsym.mul(shoreSin2)))
  // ∂phase/∂x = K·nrmX (world frame; harmonic at 2K); add alongside the
  // world-frame ambient + bike slopes below.
  const shoreWaveSlope = shoreAmp
    .mul(float(SHORE_K))
    .mul(shoreCos.add(shoreAsym.mul(shoreCos2).mul(float(2))))
  const shoreDydx = shoreWaveSlope.mul(shoreNrmX)
  const shoreDydz = shoreWaveSlope.mul(shoreNrmZ)

  // Authored wave stamps — the signature jump waves, evaluated at the
  // vertex's world XZ with the heightmap depth for the cap. Unattenuated
  // by shoaling (authored absolutes; the cap is their seabed guard) and
  // outside the set envelope, mirroring `sampleHeight`.
  const stampGeom = waveStampGeometry(worldX, worldZ, tNode, vertexWaterDepth)
  const stampSig = waveStampSignals(worldX, worldZ, tNode, vertexWaterDepth)
  // Splash rings — landing event waves, same world-XZ evaluation.
  const ringGeom = splashRingSum(worldX, worldZ, tNode)

  // Zone surge joins UNattenuated, after the shoal-multiplied wave sum —
  // mirror of `sampleHeight` (`y += zoneFx.surgeY` outside the shoal term).
  // Like the CPU, surge contributes height only: zero slope (the lift is
  // near-uniform inside the zone's weight envelope), so the normals below
  // don't tilt with it.
  const totalHeight = attenAmbient
    .add(vertexBike.x)
    .add(shoreY)
    .add(zoneSurgeY)
    .add(stampGeom.x)
    .add(ringGeom.x)
  const totalDydx = attenDydx.add(vertexBike.y).add(shoreDydx).add(stampGeom.y).add(ringGeom.y)
  const totalDydz = attenDydz.add(vertexBike.z).add(shoreDydz).add(stampGeom.z).add(ringGeom.z)

  // Foam accumulator (stateless, no render targets needed).
  //
  // The trick: waves are deterministic functions of (x, z, t), so "did this
  // position have a crest 0.5s ago?" reduces to evaluating gerstner(x, z,
  // t-0.5). We sample the foam-trigger signal (slopeFoam OR foldFoam) at
  // N time steps in the recent past, decay each by exp(-i·dt·k), and take
  // the max. The result: foam appears AT a crest and lingers behind for
  // ~1s as the wave moves on, instead of vanishing the moment the crest
  // passes. That's what gives ocean foam its "trail" character — the
  // crest moves on but the whitecap doesn't.
  //
  // This is the cheap stateless cousin of SoT's persistent foam texture
  // (which uses an FFT Jacobian + render-target ping-pong). For our
  // arcade racer, 4 time samples × 6 waves × 2 trig per call ≈ 96 trig
  // per vertex on top of the existing 24 — well within the per-frame
  // budget on any real GPU.
  //
  // Wakes are NOT included in the time history (would need historical
  // bike positions). Wake foam stays current-time only via bikeFoam below.
  // Off in classic mode for clean A/B comparison.
  const foamAccumulator = Fn(
    ([x, z, t, zHeightMult, zFreqMult, zCosB, zSinB]: [
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
    ]) => {
      const xN = x as ReturnType<typeof float>
      const zN = z as ReturnType<typeof float>
      const tN = t as ReturnType<typeof float>
      const maxFoam = float(0).toVar()
      const NUM_SAMPLES = 4
      const DT = 0.25
      const DECAY_RATE = 1.5 // half-life ≈ 0.46s
      for (let i = 0; i < NUM_SAMPLES; i++) {
        const dt = i * DT
        const tShifted = tN.sub(float(dt))
        // Zone factors are position-driven (weight/mults don't move with t;
        // only the surge does, and surge has no slope/fold signal), so the
        // caller's factors apply unchanged to the time-shifted samples.
        const h = gerstnerHeight(xN, zN, tShifted, zHeightMult, zFreqMult, zCosB, zSinB)
        const d = gerstnerDisp(xN, zN, tShifted, zHeightMult, zFreqMult, zCosB, zSinB)
        // h.y, h.z are dy/dx, dy/dz at this time sample.
        const slope = sqrt(h.y.mul(h.y).add(h.z.mul(h.z)))
        // Foam triggers use a power curve (slope^2 stretched) instead of
        // smoothstep. The smoothstep had a hard zero plateau below the
        // lower threshold, so adjacent vertices straddling the threshold
        // produced visible foam/no-foam edges on wave faces. Power curve
        // is smooth everywhere — even tiny slopes produce a wisp of foam
        // that fades continuously to zero — so per-vertex transitions
        // never snap on or off. The temporal max() of this curve over
        // four past time samples still gives lingering foam trails behind
        // passing crests.
        const slopeFoam = pow(clamp(slope.mul(float(1.4)), float(0), float(1)), float(2.0))
        const foldFoam = pow(
          clamp(max(float(0), d.z).mul(float(3.0)), float(0), float(1)),
          float(2.0),
        )
        // slopeFoam peaks on the wave FACE (slope is max mid-face, ~0 at the
        // crest), so it's downweighted — the bright foam belongs on the crest
        // cap (height-driven, in the fragment), not banded across the face.
        // foldFoam (Tessendorf pinch, crest-aligned) keeps full weight and
        // carries the lingering trail behind a passing crest.
        const localFoam = max(slopeFoam.mul(float(0.45)), foldFoam)
        const decay = float(Math.exp(-dt * DECAY_RATE))
        maxFoam.assign(max(maxFoam, localFoam.mul(decay)))
      }
      return maxFoam
    },
  )
  // Foam accumulator is attenuated by the same shoaling factor so the
  // existing slope/fold-driven foam doesn't keep firing on flat shallows
  // where wave geometry has been damped to zero.
  const vertexFoamAccum = foamAccumulator(
    worldX,
    worldZ,
    tNode,
    zoneHeightMult,
    zoneFreqMult,
    zoneCosBearing,
    zoneSinBearing,
  ).mul(shoalFactor)

  // positionNode is in mesh-local space; the mesh translation
  // (mesh.position.x/z = camera XZ) carries the vertex out to world.
  // Adding the Gerstner horizontal displacement to positionLocal.x/z applies
  // the pinching in mesh-local space — equivalent to world-space because
  // the mesh transform is a pure translation. Horizontal disp is shoaling-
  // attenuated alongside the vertical, so shallow water also stops
  // pinching laterally toward terrain.
  const positionNode = vec3(
    positionLocal.x.add(attenDispX),
    totalHeight,
    positionLocal.z.add(attenDispZ),
  )

  // Curvature + leading-edge signals for the curvature-based whitecap (foam v3).
  // Attenuated by the same shoaling factor as the geometry, so shallow water —
  // where the waves are damped flat — doesn't sprout foam from residual
  // curvature. `.x` = crest curvature (neg-Laplacian), `.y` = ∂h/∂t (rising =
  // front face). See `gerstnerCrestSignals` + the whitecap gate below.
  const crestSignals = gerstnerCrestSignals(
    worldX,
    worldZ,
    tNode,
    zoneHeightMult,
    zoneFreqMult,
    zoneCosBearing,
    zoneSinBearing,
  )
  // Wave-peak mask — the magnitude of the horizontal Tessendorf
  // displacement (λ·Dx, λ·Dz) already in `attenDispX`/`attenDispZ`.
  // Sea of Thieves' SIGGRAPH 2018 talk credits this signal as the
  // gate for their subsurface-scattering color blend: choppy peaks
  // pinch large displacements, and those are the spots where light
  // travels a short path through the wave, so they read as bright
  // scatter. We expose it as a varying so the fragment can use it
  // to push scatter on pinched crests independent of raw height
  // (a flat-but-pinching wave face is a peak too).
  //
  // attenDispX/Z are the closed-form Tessendorf horizontal pinch
  // (qSum·Dx, qSum·Dz) summed across the 6 waves.
  const peakSignal = attenDispX.mul(attenDispX).add(attenDispZ.mul(attenDispZ)).sqrt()
  // Swell-only height + world-frame gradient for the P1 readability layers
  // (value ramp + contour-line foam — see the fragment block below).
  // Shoal-scaled like the drawn geometry so the layers die out in shallows
  // alongside the swell itself. Shore / surge / wake terms are deliberately
  // EXCLUDED: surge lifts a whole zone uniformly (iso-lines keyed on it
  // would detach from the swell shape), and wakes/shore carry their own
  // foam languages. The gradient also powers the relief twin's first-order
  // offset re-sample, so it must carry the same zone/shoal scaling as the
  // height.
  const swellSigFull = gerstnerSwellHeight(
    worldX,
    worldZ,
    tNode,
    zoneHeightMult,
    zoneFreqMult,
    zoneCosBearing,
    zoneSinBearing,
  )
  // Iso-coherence blend (see CONTOUR_COHERENCE_DEFAULT): full swell sum ↔
  // dominant train only. mix(full, dom, c) = dom + (1−c)·(other trains),
  // so 0 is byte-identical to the legacy field. Blending HERE (before the
  // varying pack) is what keeps the varying budget flat at the WebGPU cap.
  const swellSigDominant = gerstnerDominantSwellHeight(
    worldX,
    worldZ,
    tNode,
    zoneHeightMult,
    zoneFreqMult,
    zoneCosBearing,
    zoneSinBearing,
  )
  const swellSig = mix(swellSigFull, swellSigDominant, contourCoherenceUniform)
  const swellScaled = swellSig.mul(shoalFactor)

  // Forward the per-vertex signals to the fragment stage, PACKED four to a
  // vec4. WebGPU caps vertex outputs at 16 LOCATIONS and every varying —
  // even a single float — burns a whole location; the eleven loose float
  // varyings this material used to declare put it at exactly the cap, and
  // the P1 swell varying pushed it to 17 ("EntryPoint main infringes
  // limits" → the whole surface vanished). Packing is numerically a no-op
  // (interpolation is per-component) and leaves ~7 locations of headroom
  // for future signals. The unpacked names keep every downstream read
  // source-identical.
  const interPackA = varying(vec4(totalHeight, totalDydx, totalDydz, attenQSum))
  const heightFrag = interPackA.x
  const dydx = interPackA.y
  const dydz = interPackA.z
  const qSumFrag = interPackA.w
  const interPackB = varying(
    vec4(
      vertexFoamAccum,
      vertexWaterDepth,
      crestSignals.x.mul(shoalFactor).add(stampSig.x),
      crestSignals.y.mul(shoalFactor).add(stampSig.y),
    ),
  )
  const foamAccumFrag = interPackB.x
  const waterDepthFrag = interPackB.y
  const crestCurvFrag = interPackB.z
  const crestRiseFrag = interPackB.w
  // Pack C: peak mask + pre-attenuation ambient height (the surf pulse
  // reads it so breakers keep the incoming-crest cadence where geometry
  // went flat) + shore-wave displacement + the P1 swell-only height.
  const interPackC = varying(vec4(peakSignal, vertexHeight.x, shoreY, swellScaled.x))
  const peakMaskFrag = interPackC.x
  const ambientHeightFrag = interPackC.y
  const shoreHeightFrag = interPackC.z
  const swellHeightFrag = interPackC.w
  const interPackD = varying(vec2(swellScaled.y, swellScaled.z))
  const swellDydxFrag = interPackD.x
  const swellDydzFrag = interPackD.y

  // Sub-Gerstner detail-normal cascades. Two world-XZ-aligned samples of the
  // procedural wave-detail texture at different tile sizes + scroll speeds,
  // their decoded slopes summed into the heightfield gradient before the
  // normal is built. This is the "FFT-lite" layer: it fills in the chop
  // below the 5.5 m wavelength floor of the Gerstner set, with hardware
  // mipmap filtering providing distance anti-aliasing for free.
  //
  // Cascade A — 6 m tile, slow scroll along the swell direction. Reads as
  // medium chop riding on the back of each Gerstner wave.
  // Cascade B — 1.5 m tile, faster scroll on a near-perpendicular axis. The
  // sub-meter ripple texture that catches sun glints and breaks up the
  // mirror-surface look at close range.
  //
  // Strengths are tuned so the combined slope contribution rarely exceeds
  // ~0.35 (well below the analytic Gerstner peaks of ~1.0), so the detail
  // reads as surface texture without erasing the silhouette of the big waves.
  // Detail-cascade texture — the procedural 22-sine analytic bake.
  // RGBA8 / REPEAT / mipmapped, sampled below at two world-XZ scales.
  const detailTex: THREE.Texture = getWaveDetailNormalTexture()
  // Tiles enlarged from (6 m, 1.5 m) → (11 m, 2 m) and the UV axes rotated
  // by non-perpendicular angles (+23° / -37°) so the texture's natural
  // pattern doesn't read as obvious world-grid-aligned strips. Two layers
  // of mitigation against the "tiling repetition" complaint: larger tiles
  // mean fewer full repeats visible in a single viewport, and the off-axis
  // rotation breaks the cross-hatch beat that two axis-aligned cascades at
  // different scales would otherwise produce.
  //
  // Slope scales bumped proportionally so the peak world-space slope
  // contribution stays in the same range (~0.21 cascade A, ~0.30 cascade B)
  // despite the larger tile size. Bake normalization pegs decoded values
  // at ±0.5, so peak ≈ 0.5 · (SCALE / TILE).
  const DETAIL_A_TILE = 11.0
  const DETAIL_B_TILE = 2.0
  const DETAIL_A_SCALE = 4.5
  const DETAIL_B_SCALE = 1.2
  const A_ANGLE = 0.4
  const B_ANGLE = -0.65
  const aCos = Math.cos(A_ANGLE)
  const aSin = Math.sin(A_ANGLE)
  const bCos = Math.cos(B_ANGLE)
  const bSin = Math.sin(B_ANGLE)

  // Domain warping. Sample the detail texture itself at a very low
  // frequency (35 m tile) to produce a slow, non-periodic noise field,
  // then use that to displace the world-XZ coords BEFORE they're rotated
  // into each cascade's local frame. Both cascades now read at positions
  // that drift on a 35 m scale, so even at the same world coordinate the
  // cascade pattern won't align with itself repeatedly. This is the
  // standard FFT-cascades-lite trick for hiding strict tile periodicity
  // without piling on additional cascades, and at the cost of just one
  // extra texture sample (which the mip filter resolves to a high mip
  // for free — slow noise reads from a low-resolution mip).
  const warpUv = positionWorld.xz.div(float(35))
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle types
  const warpSample = texture(detailTex, warpUv) as any
  const warpX = warpSample.r.sub(float(0.5)).mul(float(2.5))
  const warpZ = warpSample.g.sub(float(0.5)).mul(float(2.5))
  const warpedX = positionWorld.x.add(warpX)
  const warpedZ = positionWorld.z.add(warpZ)

  // Grazing-angle fade for the detail cascades. At near-horizon viewing,
  // the texture's intrinsic pattern reads as visible diagonal striations
  // on wave faces (the "stair-stepping" artifact in side-view screenshots
  // — a side effect of viewing a fine-grained slope perturbation across a
  // long oblique path through pixel-space). Fade detail toward zero at
  // grazing so the horizon line is carried purely by the big-shape
  // analytic-Gerstner silhouette + the foam mask. `viewDir.y` is a clean
  // proxy that doesn't depend on the surface normal (no feedback loop
  // with detailSlope, which feeds INTO the normal).
  const viewDirEarly = normalize(cameraPosition.sub(positionWorld))
  const verticalView = max(float(0), viewDirEarly.y)
  const detailGrazeFade = smoothstep(float(0.1), float(0.5), verticalView)

  // Rotate WARPED world XZ into each cascade's local frame, then divide
  // by tile size and offset by scroll. The scroll directions stay in
  // tile-local space, so cascade A's scroll runs along its own rotated +X
  // and cascade B's runs along its own rotated -X — adds further temporal
  // variety on top of the off-axis spatial layout.
  const wxA0 = warpedX.mul(float(aCos)).sub(warpedZ.mul(float(aSin)))
  const wzA0 = warpedX.mul(float(aSin)).add(warpedZ.mul(float(aCos)))
  const detailUvA = vec2(wxA0, wzA0)
    .div(float(DETAIL_A_TILE))
    .add(vec2(tNode.mul(float(0.04)), tNode.mul(float(-0.027))))
  const wxB0 = warpedX.mul(float(bCos)).sub(warpedZ.mul(float(bSin)))
  const wzB0 = warpedX.mul(float(bSin)).add(warpedZ.mul(float(bCos)))
  const detailUvB = vec2(wxB0, wzB0)
    .div(float(DETAIL_B_TILE))
    .add(vec2(tNode.mul(float(-0.11)), tNode.mul(float(0.08))))
  // Hex-tiled taps (P2.3): the 11 m / 2 m cascades repeat every tile
  // without it — under the 35 m warp the strict beat is already broken,
  // but the PATTERN content still recurs per tile; the stochastic tap
  // decorrelates it per ~2-tile lattice cell. `?hextile=0` restores the
  // plain taps for A/B.
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle types
  const detailSampleA = (
    hexTileFlag ? hexTiledTap(detailTex, detailUvA) : texture(detailTex, detailUvA)
  ) as any
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle types
  const detailSampleB = (
    hexTileFlag ? hexTiledTap(detailTex, detailUvB) : texture(detailTex, detailUvB)
  ) as any
  // Decoded slopes are in TILE-LOCAL frame (because the UV was rotated).
  // Rotate them back into world XZ via the inverse rotation matrix
  // (transpose of the forward rotation) so they add correctly to the
  // analytic Gerstner slopes which live in world space.
  const rsAx = detailSampleA.r.mul(float(2)).sub(float(1))
  const rsAy = detailSampleA.g.mul(float(2)).sub(float(1))
  const detailSlopeA = vec2(
    rsAx.mul(float(aCos)).add(rsAy.mul(float(aSin))),
    rsAx.mul(float(-aSin)).add(rsAy.mul(float(aCos))),
  ).mul(float(DETAIL_A_SCALE).div(float(DETAIL_A_TILE)))
  const rsBx = detailSampleB.r.mul(float(2)).sub(float(1))
  const rsBy = detailSampleB.g.mul(float(2)).sub(float(1))
  const detailSlopeB = vec2(
    rsBx.mul(float(bCos)).add(rsBy.mul(float(bSin))),
    rsBx.mul(float(-bSin)).add(rsBy.mul(float(bCos))),
  ).mul(float(DETAIL_B_SCALE).div(float(DETAIL_B_TILE)))
  const detailSlope = detailSlopeA.add(detailSlopeB).mul(detailStrengthUniform).mul(detailGrazeFade)

  // Camera-to-fragment distance. Used by the analytic-slope flatten below,
  // the hash-noise distance fades (foam / shoreline / sparkle), the planar-
  // reflection distortion taper, and the aerial-perspective haze mix.
  // Computed once and reused everywhere.
  const camDist = cameraPosition.sub(positionWorld).length()

  // Flatten the analytic Gerstner slopes toward zero with distance. The
  // Gerstner gradients are high-frequency relative to camera-space
  // wavelength past ~25 m at 1080p — without flattening, the PBR specular
  // lobe picks up pixel-sized glints that flicker frame-to-frame. The
  // detail-normal cascades DON'T need this lerp: hardware mipmap filtering
  // already collapses their slopes toward zero at distance. So we flatten
  // analytic slopes only, then add detail on top — the close-in band keeps
  // both layers, the horizon band keeps just the (filtered) detail.
  const analyticFlatten = smoothstep(float(25), float(140), camDist)
  const analyticDydxFlat = mix(dydx, float(0), analyticFlatten)
  const analyticDydzFlat = mix(dydz, float(0), analyticFlatten)
  const qSumFlat = mix(qSumFrag, float(0), analyticFlatten)

  // Combined heightfield gradient (analytic-flattened + detail). Used by
  // the normal, by the reflection distortion, and by the slope-driven foam
  // below.
  const effDydx = analyticDydxFlat.add(detailSlope.x)
  const effDydz = analyticDydzFlat.add(detailSlope.y)

  // GPU Gems eq.13 normal: (-Σdy/dx, 1 - Σ Q·k·A·sin, -Σdy/dz).
  // The wake's gradients are folded into dydx/dydz; the wake has no
  // horizontal-displacement term so it doesn't contribute to qSum. The
  // analytic-slope flatten + detail mip-LOD give us all the distance AA
  // we need at the slope level — the Toksvig-style roughness boost on
  // `roughnessNode` (below) mops up any residual per-pixel normal
  // variance the lighting model would otherwise alias on. So rawNormal
  // IS the per-pixel normal — no extra flatten pass needed.
  const rawNormal = normalize(vec3(effDydx.negate(), float(1).sub(qSumFlat), effDydz.negate()))
  const normalNode = rawNormal

  // View vector + ndotv computed once and reused by both the scatter blend
  // (base color) and the fresnel sky-tint emissive below.
  const viewDir = normalize(cameraPosition.sub(positionWorld))
  const ndotv = max(dot(normalNode, viewDir), float(0))

  // Scene-depth sample. The texture is populated via
  // `renderer.copyFramebufferToTexture` from this mesh's `onBeforeRender`
  // (near the bottom of the file), AFTER all opaque objects have been
  // encoded into the active pass — that's the moment when the depth
  // attachment reflects "scene minus water". `closeness` derived from it
  // feeds two consumers:
  //   1. The shallow-water tint in `baseColor` below (this block),
  //   2. The shoreline intersection foam further down in the fragment.
  //
  // Why our own DepthTexture instead of Three.js's
  // `viewportDepthTexture()`: that helper's `updateBefore` fires once
  // per render at the first node referencing it — under WebGPURenderer
  // that resolves to BEFORE any opaque has been encoded into the active
  // pass, so the texture captures a cleared depth buffer (= 1.0
  // everywhere). With the helper, the depth compare reads the scene as
  // "all at the far plane" and the shallow tint + intersection foam
  // never fire.
  const sceneDepthTexture = new THREE.DepthTexture(1, 1)
  sceneDepthTexture.name = 'water:sceneDepth'
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
  const sceneDepthSampleNode = texture(sceneDepthTexture, screenUV) as any
  const sceneDepthRaw = sceneDepthSampleNode.r
  const sceneViewZ = perspectiveDepthToViewZ(sceneDepthRaw, cameraNear, cameraFar)
  const waterViewZ = positionView.z
  // Positive = terrain is BEHIND water (deeper into the scene from the
  // camera's POV). View-space Z is negative for points in front of the
  // camera, so waterViewZ − sceneViewZ is positive when sceneViewZ is
  // more negative. This is the distance along the VIEW RAY between the
  // water surface and the seabed / shoreline terrain — at grazing angles
  // that path is much longer than the vertical depth, which is exactly
  // the Beer-Lambert path-length we want for absorption tinting.
  const closenessSigned = waterViewZ.sub(sceneViewZ)
  const closeness = max(float(0), closenessSigned)

  // Albedo: two-color scatter blend.
  //
  // Sea-of-Thieves-style: a deep teal in troughs blends to a bright
  // cyan-green "scatter color" on crests, on grazing-view-angle samples,
  // AND on waves backlit by the sun. The three contributions stack:
  //
  //   heightFactor   — crest faces scatter, troughs don't
  //   viewFactor     — sub-surface scattering makes wave bodies brightest
  //                    when viewed nearly along the surface (grazing)
  //   sunBackscatter — light passing through a wave from sun-side to eye-
  //                    side; peaks when the line of sight points roughly
  //                    toward the sun
  //
  // Classic mode (`?water=classic`) keeps the original blue→cyan mix with
  // pure height-driven blending for A/B comparison.
  // Color-ramp ranges widened to (-2, 2) — at the bumped amplitude the
  // visible wave heightFrag often saturated the previous tight (-0.5,
  // 0.5) window across most of a single wave face, which produced
  // visible HEIGHT ISOLINES (banded color stripes along the surface
  // that traced contours of constant height). Stretching the input
  // range lets the smoothstep transition over the full natural wave
  // amplitude so the deep→scatter gradient reads as smooth shading
  // instead of contour lines.
  const heightNorm = smoothstep(float(-2.0), float(2.0), heightFrag)
  const heightFactor = smoothstep(float(-1.5), float(1.5), heightFrag)
  // Deep ocean body color. Pushed from a nearly-black navy
  // (0.01, 0.09, 0.20) to a visibly turquoise-cyan so the body of
  // the water reads as ocean instead of a void. Reference: clear
  // tropical seawater transmits 470–500 nm (cyan) up to ~10 m
  // before absorption dominates, which is what gives reef water
  // its glowing aqua body. We're a deep open-water scene so we
  // keep red low (long-wavelength absorption is fast), but the
  // green+blue channels are raised so the surface paints a visible
  // turquoise even where the fresnel reflection would otherwise
  // dominate. Classic preset unchanged for A/B.
  const deepColor = vec3(0.02, 0.22, 0.32)
  // Two distinct "scatter" colors per Sea of Thieves' three-color
  // albedo system (deep + scatter + subsurface). The height-driven
  // `scatterColor` is the legacy SoT-style cyan-green that lights up
  // the upper half of wave faces — neutral teal so it works under
  // any sky color. The peak-mask SSS color is more YELLOW-GREEN —
  // that's the SoT "lit from within" glow that fires specifically
  // where the Tessendorf horizontal pinch is large (i.e. light has
  // a SHORT path through the wave because it's about to break).
  // The yellow lift comes from the warmer end of the visible
  // spectrum getting absorbed less than the cooler end at short
  // travel distances — the same Rayleigh / Beer-Lambert physics
  // that makes shallow ocean read turquoise instead of navy.
  // Mid-water scatter brightened toward saturated tropical turquoise.
  // Previous (0.18, 0.78, 0.78) was a flat teal that read as fabric
  // when sun-lit. The reference target's "tube glow" comes from light
  // travelling through the wave body and emerging cyan — we want
  // crests to PUNCH this color toward the camera, so a higher
  // green+blue (and a touch of red) gives a brighter perceived
  // brightness without losing the ocean hue.
  const scatterColor = vec3(0.22, 0.85, 0.92)
  // SSS — the SoT three-color recipe's "lit from within" glow on
  // pinched crests. Push toward bright tropical-tube turquoise rather
  // than yellow-green: a Pipeline surf-photo lip is white-cyan, not
  // chartreuse. Previous (0.20, 0.95, 0.50) read distractingly green.
  const sssColor = vec3(0.35, 0.95, 0.85)

  // Beer-Lambert depth absorption — the missing piece that was making
  // our water read as "perfectly clear" vs SoT's depth-varied body.
  //
  // Physics: each spectral channel of light attenuates exponentially
  // with path length through water, `T = exp(-σ · t)`. Red absorbs
  // fastest (long wavelength → high σ), green moderately, blue almost
  // not at all — that's why deep ocean reads navy and shallow reads
  // cyan-green. σ values are tuned for stylized clarity (real
  // open-ocean σ_R is closer to 0.7/m and would absorb to navy by
  // 5 m; we keep some color reach so the surf-photo cyan body reads
  // out to ~10 m of path, which is the visual target).
  //
  // Path length uses the FLAT vertical water depth (`waterDepthFrag`)
  // with a 1/ndotv grazing correction, NOT the view-ray closeness.
  // The view-ray version varied per-vertex with wave displacement
  // (crest vs trough), producing visible "contour-stripe" bands
  // along constant-height isolines of the wave surface — the user-
  // flagged wave-stripe artifact. Vertical depth is independent of
  // wave displacement, so the body color reads as smooth gradient
  // across each wave face instead of contour lines.
  //
  // "Sandy seabed" assumed bright cyan-white for the transmitted
  // term. Where there's no real seabed (open ocean past the
  // heightmap), waterDepthFrag is the DEEP_SENTINEL (very large
  // positive number) → transmission → 0 → body collapses to
  // deepColor, which is what we want for open ocean.
  // 0.7 (down from 1.0) — the per-channel σ triplet softens, so the
  // body colour holds onto more of the bright seabedColor across mid-
  // depths instead of collapsing to deepColor by 3 m of path. Paired
  // with the lower shallow-water alpha (see `seabedSeeThrough` below),
  // it means the seabed reads visibly through the water in shallow-to-
  // mid depths without the water layer adding a heavy cyan overcoat.
  const BODY_ABSORPTION_DEFAULT = 0.7
  const bodyAbsorptionUniform = uniform(BODY_ABSORPTION_DEFAULT)
  const sigmaR = float(0.35).mul(bodyAbsorptionUniform)
  const sigmaG = float(0.06).mul(bodyAbsorptionUniform)
  const sigmaB = float(0.015).mul(bodyAbsorptionUniform)
  // Approximate the view-ray path length through water as
  // (vertical depth) / cos(view angle from vertical), clamped so
  // grazing samples don't blow up to infinity. cos(view from
  // vertical) is the y-component of the view direction, which we
  // approximate from ndotv on the FLAT plane — using the normal
  // would re-introduce wave-displacement banding here too.
  const verticalViewForOpticalPath = max(viewDir.y, float(0.15))
  const opticalPath = max(waterDepthFrag, float(0)).div(verticalViewForOpticalPath)
  const transR = exp(sigmaR.mul(opticalPath).negate())
  const transG = exp(sigmaG.mul(opticalPath).negate())
  const transB = exp(sigmaB.mul(opticalPath).negate())
  const seabedColor = vec3(0.85, 0.92, 0.85)
  // "Do we have real depth data" gate. Without a terrain heightmap
  // installed, `vertexWaterDepth` returns the deep sentinel
  // (`waterY − -10000` = ~10004) — so a tiny depth reading means
  // either a pixel sitting right at the water-line OR no heightmap
  // is bound. Smooth over the first half-meter and resolve to "treat
  // as deep" for the no-data case so open ocean doesn't accidentally
  // get seabed transmission.
  const depthValidGate = smoothstep(float(0.25), float(0.75), waterDepthFrag)
  // Beer-Lambert: body = deepColor·(1−T) + seabedColor·T per channel.
  // Multiplying by depthValidGate folds in the validity check —
  // gate=0 collapses to deepColor regardless of T.
  const beerLambertBody = vec3(
    mix(
      deepColor.x,
      deepColor.x.mul(float(1).sub(transR)).add(seabedColor.x.mul(transR)),
      depthValidGate,
    ),
    mix(
      deepColor.y,
      deepColor.y.mul(float(1).sub(transG)).add(seabedColor.y.mul(transG)),
      depthValidGate,
    ),
    mix(
      deepColor.z,
      deepColor.z.mul(float(1).sub(transB)).add(seabedColor.z.mul(transB)),
      depthValidGate,
    ),
  )
  const tintedDeepColor = beerLambertBody
  // Shallow-gate (separate from the body color blend above) for the
  // caustic veining below — caustics fade out in deep water because
  // real seabed caustics dim with depth. 0..1 ramp over the first 8 m
  // of closeness.
  const shallowFactor = float(1).sub(smoothstep(float(0), float(8), closeness))

  // Sun-direction back-scatter. uSunDir matches the scene's
  // DirectionalLight (50, 70, 70) — see scene.ts. Stored normalized as a
  // uniform so a future day/night cycle can animate it. The dot is
  // viewDir.negate() · sunDir = (line-of-sight) · (toward-sun); peaks at
  // 1.0 when the camera is looking toward the sun, falls to 0 when
  // looking perpendicular, < 0 when looking away (clamped). Squared so
  // the boost is concentrated near the sun direction.
  const sunDirUniform = uniform(new THREE.Vector3(50, 70, 70).normalize())
  // Horizon haze color — what the surface fades toward at long view
  // distances (aerial perspective; see the `aerialMix` block in the
  // albedo composition below). Default is a desaturated cool teal that
  // works at midday; the sky module mutates it each tick via
  // `setHorizonColor(...)` so sunset / dawn / dusk water picks up the
  // matching sky warmth automatically.
  const horizonHazeUniform = uniform(new THREE.Vector3(0.4, 0.55, 0.6))
  const sunBackscatter = pow(max(float(0), dot(viewDir.negate(), sunDirUniform)), float(2))

  // SoT-style choppiness peak mask: `length(λ·Dx, λ·Dz) / scale`
  // saturated to [0, 1]. Where the Tessendorf horizontal pinch is
  // large (= near a crest about to break), light has a shorter path
  // through the wave body so subsurface scatter dominates. The scale
  // divisor sets where the mask saturates — peakSignal peaks around
  // ~0.4 m on choppy crests at our amplitudes, so dividing by 0.35
  // lands the mask at full strength on visible peaks without needing
  // extreme pinching.
  const peakMaskScaled = clamp(peakMaskFrag.div(float(0.35)), float(0), float(1))
  // Crest scatter ramps with height; grazing view bumps it; sun
  // backlight bumps it further. Combined boost can exceed 1.0 (we
  // clamp at the end so deep troughs stay dark even with sun
  // alignment). This drives the legacy scatter-color blend (cyan-
  // green) — the warmer SSS color is layered on top below via the
  // peak mask.
  const scatterAmount = (() => {
    const viewFactor = float(1).sub(ndotv)
    const baseBoost = mix(float(0.55), float(1.0), viewFactor)
    const sunBoost = sunBackscatter.mul(0.55)
    return clamp(heightFactor.mul(baseBoost.add(sunBoost)), float(0), float(1))
  })()
  // Step 1 of the SoT three-color blend: deep → mid-water scatter
  // (the legacy cyan-green). Captures height-driven swell shading.
  const scatterBlended = mix(tintedDeepColor, scatterColor, scatterAmount)
  // Step 2: layer the SSS yellow-green on top, gated by the peak
  // mask (choppiness pinch) and modulated by sun-backlight
  // alignment. SoT's recipe: SSS fires where the wave is pinched
  // AND the sun is roughly behind the wave from the camera's POV
  // (the literal "light through the wave" geometry).
  //
  // Ambient floor (0.35) so SSS reads on crests even when the sun
  // isn't aligned with the camera — without it, the sunset palette
  // (sun behind the player most of the time) makes SSS invisible.
  // The (sunBackscatter + 0.35) ramps SSS from 35% to ~135% as the
  // camera turns toward the sun. Tuned via Chrome MCP A/B —
  // higher floors (0.5) overdid the yellow-green tint and washed
  // out the cyan scatter, lower floors (0.25) made SSS invisible
  // at sunset.
  const sssGate = clamp(peakMaskScaled.mul(sunBackscatter.add(float(0.35))), float(0), float(1))
  // SSS mix uncapped (was 0.55) so on perfect peaks with sun
  // backlighting, the subsurface color fully dominates — that's the
  // "tube glow" effect from the SoT recipe ("we blend between a deep
  // water colour and a sub-surface water colour"). The 0.55 cap was
  // a holdover from an earlier conservative tune; with the
  // brightened scatter + sss colors and proper peak masking, full
  // mix gives crests the lit-from-within cyan punch without
  // washing the rest of the surface (sssGate already restricts to
  // pinched crests × sun alignment).
  const baseColorPreCaustic = mix(scatterBlended, sssColor, sssGate)

  // Caustics — bright veining where sunlight refracts through wave
  // crests and concentrates on the seabed. Real caustics are projected
  // onto the underwater geometry; we cheat by painting them onto the
  // water surface itself, modulated to only appear where the water
  // reads "clear" (shallow + looking-down), so the player's brain
  // attributes the pattern to the seabed below.
  //
  // Pattern: two grids of `abs(sin)*abs(sin)` checkerboards at different
  // scales / rotations, intersected (min) and powered up. The
  // intersection produces curving veining where both grids happen to
  // brighten — that's the hallmark caustic look.
  //
  // Visibility is gated by:
  //   - `shallowFactor`: only show in shallows. Out in deep ocean, no
  //     caustics — that's correct, real caustics dim with depth.
  //   - `ndotv`: only when looking through clear (mostly down) water.
  //     At grazing the surface is opaque (Beer-Lambert) so caustics
  //     wouldn't be visible through it anyway.
  //   - distance fade: aliases hard past ~60 m, so fade to 0 there.
  //   - sun visibility (via the lighting model, since this is a
  //     baseColor contribution and not emissive): no sun → no caustics,
  //     shadow on water → no caustics in that patch. Both correct.
  //
  // Layer 1: uniform-scale grid scrolling at one velocity.
  const causticAX = positionWorld.x.mul(float(0.5)).add(tNode.mul(float(0.18)))
  const causticAY = positionWorld.z.mul(float(0.5)).add(tNode.mul(float(-0.13)))
  // Layer 2: anisotropic scale + opposite scroll direction so the two
  // grids slide past each other; the intersections that brighten form
  // the wandering caustic veining.
  const causticBX = positionWorld.x.mul(float(0.42)).add(tNode.mul(float(-0.22)))
  const causticBY = positionWorld.z.mul(float(0.58)).add(tNode.mul(float(0.16)))
  const causticLayer1 = abs(sin(causticAX).mul(sin(causticAY)))
  const causticLayer2 = abs(sin(causticBX).mul(sin(causticBY)))
  const causticPattern = pow(min(causticLayer1, causticLayer2), float(2.5))
  const causticDistFade = float(1).sub(smoothstep(float(20), float(70), camDist))
  const causticIntensity = causticPattern
    .mul(shallowFactor)
    .mul(ndotv)
    .mul(causticDistFade)
    .mul(float(0.55))
  // A cool aqua boost — same family as scatterColor but a touch lighter
  // so caustics read as "bright spots on the sand" rather than "more
  // surface color". Goes through the lighting model so shadow + night
  // dim it naturally.
  const causticColor = vec3(0.45, 0.85, 0.78)
  const baseColor = baseColorPreCaustic.add(causticColor.mul(causticIntensity))

  // Sun glow emissive — additive on top of the scatter blend for the
  // unmistakable SoT "lit-from-behind" wave glow. Peaks on tall crests
  // (`heightFactor`) lit from behind (`sunBackscatter`), tinted with
  // scatterColor.
  const sunGlow = scatterColor.mul(sunBackscatter.mul(heightFactor).mul(sunGlowUniform))

  // Karis-style sun disc reflection (SoT SIGGRAPH 2018, citing UE4's
  // closest-point-on-sphere). Standard MeshStandardNodeMaterial
  // gives a tight pin-prick specular at sun position; SoT widens
  // that into a finite disc + halo so the "bright low-sun reflection
  // streak" reads as a real area light rather than a hot pixel.
  //
  // Per-pixel: reflect view through the surface normal, take the
  // dot product with the sun direction. A two-stop smoothstep
  // (tight inner core + wide softer halo) maps that to disc
  // intensity. Tinted by the horizon-haze color which is already
  // tracking the sky palette tick-by-tick, so a sunset disc is
  // peach-warm and a midday disc is cool-white automatically.
  //
  // Off in classic mode.
  const reflView = viewDir.negate()
  const reflRay = reflView.sub(normalNode.mul(dot(reflView, normalNode).mul(float(2))))
  const sunAlign = max(float(0), dot(reflRay, sunDirUniform))
  // Inner core: ~3° half-angle (cos(3°) ≈ 0.9986). Outer halo:
  // ~12° half-angle (cos(12°) ≈ 0.978). Lower-sun atmospheric
  // smear bumps the effective halo on top of this.
  const sunDiscCore = smoothstep(float(0.9986), float(0.9999), sunAlign)
  const sunDiscHalo = smoothstep(float(0.978), float(0.998), sunAlign).mul(float(0.45))
  const sunDiscIntensity = max(sunDiscCore, sunDiscHalo)
  const sunDiscColor = horizonHazeUniform
  // Sun-disc strength uniform so the debug menu can scrub the
  // bright low-sun reflection without rebuilding the material.
  const SUN_DISC_STRENGTH_DEFAULT = 1.4
  const sunDiscStrengthUniform = uniform(SUN_DISC_STRENGTH_DEFAULT)
  const sunDisc = sunDiscColor.mul(sunDiscIntensity).mul(sunDiscStrengthUniform)

  // Anisotropic specular streak along wave fronts. SoT's low-sun
  // reflection isn't a clean Karis disc — it elongates into a
  // streak along the wave-front tangent direction because each
  // wave's normal sweeps across a range of angles AS YOU MOVE
  // ALONG the wave front. Proper anisotropic PBR needs a custom
  // BSDF (MeshStandardNodeMaterial doesn't support an anisotropy
  // direction), so we approximate the look via an emissive
  // contribution that uses a Gaussian-like falloff with different
  // sigmas in (along-wave-front) vs (across-wave-front) — visually
  // identical for the bright-streak use case.
  //
  // We use the surface slope gradient (effDydx, effDydz) to find
  // the wave-front tangent direction in the horizontal plane.
  // Where the slope is small (flat water), this collapses to a
  // disc; where slope is large (steep wave face), the streak
  // dominates and aligns with the wave-front.
  const slopeXZ = vec2(effDydx, effDydz)
  const slopeMagXZ = max(slopeXZ.length(), float(0.0001))
  // Slope direction (uphill) + wave-front tangent (perpendicular).
  const slopeDirN = slopeXZ.div(slopeMagXZ)
  const waveFrontN = vec2(slopeDirN.y.negate(), slopeDirN.x)
  // Horizontal components of sun direction + reflection ray.
  const sunH = vec2(sunDirUniform.x, sunDirUniform.z)
  const reflH = vec2(reflRay.x, reflRay.z)
  const deltaH = sunH.sub(reflH)
  // Project onto wave-front tangent (along the streak) vs slope
  // direction (across the streak). Squared distances feed a 2D
  // Gaussian with anisotropic sigmas — wide along (0.40) lets the
  // streak elongate, tight across (0.06) keeps it visually thin.
  const along = dot(deltaH, waveFrontN)
  const across = dot(deltaH, slopeDirN)
  // Streak elongation = sigmaAlong (wider sigma => longer streak
  // along the wave-front tangent). Live-tunable via the debug menu.
  // sigmaAcross stays fixed at 0.06 — it's the "how thin is the
  // streak" knob that needs to stay tight for the look to read as
  // a streak vs a circular smear.
  const STREAK_ELONGATION_DEFAULT = 0.4
  const streakElongationUniform = uniform(STREAK_ELONGATION_DEFAULT)
  const sigmaAlong = streakElongationUniform
  const sigmaAcross = float(0.06)
  const streakArg = along
    .mul(along)
    .div(sigmaAlong.mul(sigmaAlong))
    .add(across.mul(across).div(sigmaAcross.mul(sigmaAcross)))
  // Streak only fires where the slope is non-trivial (waveFront
  // tangent is meaningful) AND the reflection aligns roughly with
  // the sun horizontally. Slope gate ramps in over 0.05–0.20 of
  // slope magnitude so calm patches don't get spurious streaks.
  const slopeGate = smoothstep(float(0.05), float(0.2), slopeMagXZ)
  const sunHGate = max(float(0), dot(reflH.normalize(), sunH.normalize()))
  const streakIntensity = exp(streakArg.negate()).mul(slopeGate).mul(sunHGate)
  // Sun-streak strength uniform so the debug menu can scrub the
  // anisotropic wave-front reflection streak independently of the
  // disc above. 0 = no streak (just the Karis disc); higher values
  // brighten the elongated highlight.
  const SUN_STREAK_STRENGTH_DEFAULT = 0.8
  const sunStreakStrengthUniform = uniform(SUN_STREAK_STRENGTH_DEFAULT)
  const sunStreak = sunDiscColor.mul(streakIntensity).mul(sunStreakStrengthUniform)

  // Crest-mist ribbon strength uniform. Drives the lofted wind-spray haze on
  // breaking crests (composed into the emissive sum below). Default 1; the
  // Settings → Video "Wave spray" knob scales it via `water-service` so the
  // GPU haze and the discrete crest-spray sprites fade together.
  const CREST_MIST_STRENGTH_DEFAULT = 1.0
  const crestMistStrengthUniform = uniform(CREST_MIST_STRENGTH_DEFAULT)

  // ── Whitecap controls (foam pass v3 — curvature + leading-edge) ──────
  // Foam fires on crest CURVATURE biased toward the wave's LEADING edge, NOT on
  // height. The height-led predecessor painted a wide symmetric band straddling
  // the crest, which read as flat "white bars" — height is a poor placement
  // signal because the whole top of a swell clears any height threshold.
  //
  //   `whitecapCurvature` — gain on the crest-curvature signal (the negative
  //   Laplacian of the height field, `crestCurvFrag`). Higher = foam on gentler
  //   curvature (more coverage); lower = only the sharpest breaking crests.
  //   Curvature is sharply peaked at the crest, so foam reads as a thin line ON
  //   the crest instead of a band. Steepness-independent (reads the height
  //   field, not the Gerstner pinch, which is effectively unused — see
  //   feedback_steepness_pinch_unused in memory / docs).
  //
  //   `whitecapLeadBias` — 0..1, how hard to push foam onto the LEADING (rising/
  //   front) face via ∂h/∂t (`crestRiseFrag`). 0 = symmetric crest line; 1 =
  //   front-only, the "wave breaking forward" look. This is what turns the old
  //   symmetric bar into a forward-loaded cap.
  //
  //   `WHITECAP_LEAD_REF` — ∂h/∂t magnitude (m/s) at which the front face is
  //   fully lit / the back fully cut. Not a knob; tuned with the field.
  const WHITECAP_CURVATURE_DEFAULT = 4.0
  const WHITECAP_LEAD_BIAS_DEFAULT = 1.0
  const WHITECAP_LEAD_REF = 0.5
  const whitecapCurvatureUniform = uniform(WHITECAP_CURVATURE_DEFAULT)
  const whitecapLeadBiasUniform = uniform(WHITECAP_LEAD_BIAS_DEFAULT)
  // Legacy height/slope/mode whitecap uniforms — no longer feed the wave
  // whitecap gate (curvature replaced them), but retained so the existing debug
  // setters / persisted-store keys / foam-sweep harness keep working without a
  // store-version bump. Safe to retire in a follow-up cleanup pass.
  const WHITECAP_HEIGHT_START_DEFAULT = 0.5
  const WHITECAP_SLOPE_START_DEFAULT = 0.36
  const WHITECAP_MODE_DEFAULT = 0.0
  const whitecapHeightStartUniform = uniform(WHITECAP_HEIGHT_START_DEFAULT)
  const whitecapSlopeStartUniform = uniform(WHITECAP_SLOPE_START_DEFAULT)
  const whitecapModeUniform = uniform(WHITECAP_MODE_DEFAULT)
  // Foam warmth (foam-coverage pass, step 2): scales the light-driven warm
  // tint + warm emissive bloom applied to foam where the low sun rakes it (see
  // the foam-colour block below). 0 = flat white foam (the legacy look); 1 =
  // baseline sunset-kissed crests. The tint follows `horizonHazeUniform`, so at
  // midday (cool horizon) it's near-neutral and only warms at golden/sunset.
  const FOAM_WARMTH_DEFAULT = 1.0
  const foamWarmthUniform = uniform(FOAM_WARMTH_DEFAULT)
  // Directional foam streaks (foam-coverage pass, step 3): scales the
  // brushstroke foam bands painted on steep wave faces, running along the
  // local crest line (the painterly streaks of the concept frames) vs the
  // isotropic round-bubble texture. 0 = bubbles only (legacy); 1 = baseline
  // streaks. See the foam-mask block below.
  const FOAM_STREAK_DEFAULT = 1.0
  const foamStreakUniform = uniform(FOAM_STREAK_DEFAULT)
  // Foam brush (oil-stroke rework): blends the foam BREAK-UP pattern from the
  // legacy round-disc bubble sheet (0) to tapered oil-paint brush strokes
  // pulled along the crest lines (1) — the engine-trail painted read applied
  // to every foam fringe. See the foam-mask block below.
  const FOAM_BRUSH_DEFAULT = 1.0
  const foamBrushUniform = uniform(FOAM_BRUSH_DEFAULT)
  // P2.3 tangential foam-mask warp: low-frequency wobble of the foam
  // break-up sample coords ALONG the crest axis only (never along travel
  // or in height — those carry the steepness/timing signal; §7.8's rule).
  // 1 = baseline ±4 m wobble at the 35 m warp-noise scale, 0 = off.
  const FOAM_WARP_DEFAULT = 1.0
  const foamWarpUniform = uniform(FOAM_WARP_DEFAULT)
  // P2.3 Langmuir streak lanes: faint elongated brightness lanes aligned
  // WITH the swell travel direction (real windrows align with the wind),
  // gated to calm low-slope water — the "which way is the sea moving"
  // prime on stretches where no crest/foam cue fires (§5's calm gap).
  const LANGMUIR_DEFAULT = 0.6
  const langmuirUniform = uniform(LANGMUIR_DEFAULT)

  // Wave-driven foam — two stacked layers via max():
  //   1. The vertex-stage accumulator (`foamAccumFrag`) — sampled at 4 past
  //      time steps, decayed exponentially, max-reduced. Gives foam a
  //      ~1 s lingering trail behind each passing crest. Sampled per-vertex
  //      and varying-interpolated, so adjacent vertices with very different
  //      slopes can produce visibly different foam values that bilinear
  //      interpolation reveals as "stair-stepping" bands on wave faces.
  //   2. A per-pixel current-time foam term (`pixelFoam`) computed from
  //      the per-pixel interpolated slope (which IS smooth across the
  //      triangle, since slopes are themselves varyings of smooth Gerstner
  //      math + the mip-filtered detail cascades). This layer fills in
  //      the smooth spatial gradient that the vertex sampling can't
  //      resolve, killing the stair-step artifact at wave-face peaks.
  //
  // max() lets each layer win where it's stronger — pixelFoam dominates
  // at active crests (smooth peaks, no banding), the accumulator
  // dominates in the trail behind passing crests (where slope is now
  // low but used to be high). Power curve (~slope^2 stretched) replaces
  // the hard-zero smoothstep so very small slopes still produce a wisp
  // of foam rather than snapping off — eliminates the foam/no-foam
  // threshold edge entirely.
  const pixelSlope = sqrt(effDydx.mul(effDydx).add(effDydz.mul(effDydz)))
  // pow(.,3) keeps pixelFoam near 0 until the slope really spikes.
  const pixelFoam = pow(clamp(pixelSlope.mul(float(0.5)), float(0), float(1)), float(3.0))
  // Shared turbulent foam noise — world XZ + time scroll. Used to break
  // up the otherwise-too-clean foam edges of shoreline, wake, and bow
  // spray so they all read as living turbulence instead of stamped
  // outlines.
  //
  // The same noise is sampled by:
  //   - shoreline foam range (lapping in/out by ±0.2m via `foamNoiseRaw`)
  //   - wake foam intensity (multiplicative `foamTurbulence`)
  //   - bow spray intensity (multiplicative `foamTurbulence`)
  // so all foam in the scene moves with a unified visual rhythm.
  const foamNoiseUV = positionWorld.xz.mul(0.35).add(vec2(tNode.mul(-0.18), tNode.mul(0.13)))
  const foamNoiseRawHF = fract(
    sin(foamNoiseUV.x.mul(12.9898).add(foamNoiseUV.y.mul(78.233))).mul(43758.5453),
  )
  // Distance-fade the hash toward its mean (0.5). The 2.86 m wavelength of
  // the hash aliases badly once one screen pixel covers >1 noise cell, which
  // happens between ~20 and ~70 m at typical FOV / 1080p. Past the fade
  // window the noise collapses to a constant — distant shoreline + wake
  // foam reads as a smooth bright band instead of pixel-speckle. Window
  // pulled in from (30, 80) since the detail-normal upgrade made it more
  // obvious that hash sites still flickered in the 20–30 m band.
  const foamNoiseAntialias = float(1).sub(smoothstep(float(20), float(70), camDist))
  const foamNoiseRaw = mix(float(0.5), foamNoiseRawHF, foamNoiseAntialias)
  const foamNoiseSmooth = smoothstep(float(0.2), float(0.85), foamNoiseRaw)
  // Multiplier in [0.5, 1.0] — never erases foam, just breaks up its
  // intensity into turbulent patches.
  const foamTurbulence = mix(float(0.5), float(1.0), foamNoiseSmooth)
  // Subtler variant for wave-crest foam fibers. [0.6, 1.0] gives whitecaps
  // visible structure (splotches with subtle brightness variation) without
  // speckling — wider ranges read as TV-static when foam is widespread.
  const foamFiber = mix(float(0.6), float(1.0), foamNoiseSmooth)

  // Curvature-based whitecap foam (foam pass v3) — see the whitecap controls
  // block above. Replaces the height/slope/mode gate, which painted a wide
  // symmetric band straddling the crest ("white bars").
  //
  //   WHERE — `crestCurvFrag` is the negative Laplacian of the height field
  //   (Σ A·k²·sin φ), most positive at sharp crests, ≤0 in troughs. Clamp ≥0 and
  //   gain by `whitecapCurvature`, then it concentrates foam to a thin line ON
  //   the crest rather than a height band. (smoothstep into [0,1] for a soft
  //   coverage ramp.)
  const crestCurvature = max(float(0), crestCurvFrag)
  const curvCoverage = smoothstep(float(0), float(1), crestCurvature.mul(whitecapCurvatureUniform))
  //   WHICH SIDE — `crestRiseFrag` is ∂h/∂t. `leadBiasRaw` = smoothstep(−ref,
  //   +ref, ∂h/∂t) → ~0 on the trailing face, ~0.5 at the crest, ~1 on the
  //   leading/front face. `whitecapLeadBias` mixes from symmetric (0) to
  //   front-only (1): it cuts the trailing half of the old bar and pushes the
  //   cap onto the wave's leading edge — the "breaking forward" look.
  const leadBiasRaw = smoothstep(float(-WHITECAP_LEAD_REF), float(WHITECAP_LEAD_REF), crestRiseFrag)
  const leadBias = mix(float(1), leadBiasRaw, whitecapLeadBiasUniform)
  // pow() sharpens the soft shoulder so the cap reads as crisp solid white, not
  // a soft haze; `foamFiber` breaks it into bubbly turbulence.
  const whitecapGate = pow(curvCoverage.mul(leadBias), float(1.4))
  const whitecapFoam = whitecapGate.mul(foamFiber)
  // History-accumulated foam (the time-shifted Gerstner sampler builds
  // a lingering trail behind each passing crest, since the analytic
  // formula is bit-identical between past and present) plus softened
  // pixelFoam and whitecapFoam — the three combine to give crests both
  // an active highlight and a fading trail.
  //
  // `pixelFoam` is SLOPE-driven, so it paints the rising FACE, not the crest —
  // it was a big part of the "white foam under the whitecap" look. Downweighted
  // to a faint wisp so the height-driven crest cap (`whitecapFoam`) is the
  // dominant bright foam; the accumulator still carries the trailing foam.
  const waveFoam = max(max(foamAccumFrag.mul(float(0.7)), pixelFoam.mul(float(0.3))), whitecapFoam)

  // Per-bike AT-HULL foam: stern propwash + bow spray. (The trailing wake
  // foam moved to `computeWakeTrail` below — it follows the recorded path,
  // not the bike's current heading.) We wrap the per-bike work in
  // a Fn() so we can use If(...) to early-out for slots whose bike is far
  // from this fragment — most fragments are far from every bike, so this
  // turns a constant per-fragment cost into a roughly O(1) one. Using `If`
  // also requires being inside Fn() since it relies on the assignment
  // stack.
  //
  // Inactive slots are parked at distance 1e6 by `tick()`, so their squared
  // distance is ≫ the cull radius and they short-circuit on the first cmp.
  //
  // The perpendicular distance uses a 2D cross product
  // (|d.x*hat.y - d.y*hat.x|) rather than `length(d - hat * parallel)` —
  // one mul + one mul + one sub + one abs vs. a square + sqrt.
  const computeBikeFoam = Fn(() => {
    const sum = float(0).toVar()
    for (let i = 0; i < MAX_BIKES; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
      const slot = bikesUniform.element(i) as any
      // biome-ignore lint/suspicious/noExplicitAny: TSL types lose precision here
      const dxRel = positionWorld.x.sub(slot.x) as any
      // biome-ignore lint/suspicious/noExplicitAny: TSL types lose precision here
      const dzRel = positionWorld.z.sub(slot.y) as any
      const r2 = dxRel.mul(dxRel).add(dzRel.mul(dzRel))
      If(r2.lessThan(float(BIKE_INFLUENCE_R_SQ)), () => {
        // biome-ignore lint/suspicious/noExplicitAny: TSL UniformArrayElementNode lacks float-typing in TS
        const weight = weightsUniform.element(i) as any
        // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
        const vx = slot.z as any
        // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
        const vz = slot.w as any
        const speed = sqrt(vx.mul(vx).add(vz.mul(vz)))
        const safeSpeed = max(speed, float(0.001))
        const hatX = vx.div(safeSpeed)
        const hatZ = vz.div(safeSpeed)
        const parallel = dxRel.mul(hatX).add(dzRel.mul(hatZ))
        const behind = max(parallel.negate(), float(0))
        const ahead = max(parallel, float(0))
        // 2D perpendicular distance via cross-product magnitude (cheaper
        // than `length(d - hat * parallel)`).
        const perp = abs(dxRel.mul(hatZ).sub(dzRel.mul(hatX)))
        const speedGate = smoothstep(float(WAKE_SPEED_LOW), float(WAKE_SPEED_HIGH), speed)

        // (Hull foam ring removed — it read as a "circle under the bike".
        // The propwash below fills the wake's apex where the ring was.)

        // Stern propwash (M9.33): bright concentrated foam centred on the
        // bike, peaking right AT the hull and fading back — this is the filled
        // "point" of the V where the hull ring used to be, the kinetic "boat is
        // here" mass. NOT noise-modulated — a solid foam mass the bike actively
        // generates, distinct from the turbulent V edges.
        //
        // The axial profile must die just AHEAD of the hull: `behind` is
        // clamped to 0 for the entire forward half-plane, so gating on it alone
        // smears the propwash into a line in front of the rider. `forwardCut`
        // (keyed off `ahead`) kills it within 0.35 m forward; `backFalloff`
        // trails it behind. Peak sits at the hull (ahead ≈ behind ≈ 0).
        const propwashBackFalloff = exp(behind.mul(-1.0))
        const propwashForwardCut = float(1).sub(smoothstep(float(0.0), float(0.35), ahead))
        const propwashLateral = float(1).sub(smoothstep(float(0), float(0.8), perp))
        const propwash = propwashForwardCut
          .mul(propwashBackFalloff)
          .mul(speedGate)
          .mul(propwashLateral)
          .mul(weight)
          .mul(0.8)

        // Bow spray: forward foam "moustache" in front of the bike,
        // peaking just ahead and fading to 0 by ~1.5m forward. Same
        // Kelvin-V geometry as the wake but FORWARD-facing with a
        // tighter half-angle, so the spray reads as a sharp arc rather
        // than a long trail. Speed-gated so a parked bike doesn't spray.
        // The bike's hull pushes water forward at race pace; this is
        // the visual cue for that interaction. Noise-modulated for the
        // same turbulent character as the wake.
        const splashHalfAngle = 0.35
        const splashWidth = ahead.mul(splashHalfAngle).add(float(0.35))
        const aheadGate = smoothstep(float(0.0), float(0.25), ahead)
        const aheadFalloff = exp(ahead.mul(-1.6))
        const splashEdge = smoothstep(splashWidth.add(0.3), splashWidth.sub(0.4), perp)
        const bowSpray = aheadGate
          .mul(speedGate)
          .mul(aheadFalloff)
          .mul(splashEdge)
          .mul(weight)
          .mul(0.85)
          .mul(foamTurbulence)

        sum.addAssign(propwash.add(bowSpray))
      })
    }
    return sum
  })
  const bikeFoam = computeBikeFoam()

  // Trailing wake foam — the V that used to be stamped from the bike's
  // current heading now lies along each bike's recorded trail (same scan the
  // vertex displacement uses, so foam sits ON the ridge it displaces).
  // Cross-profile is two parts instead of the old filled wedge:
  //  - center CHURN: a narrow, slowly-widening strip of prop-churned water
  //    down the trail axis — the long "trailing wake" spine. Persists
  //    (e-fold ~18 m behind).
  //  - edge RAILS: thin bells riding the diverging displacement ridge
  //    (|perp| = wakeWidth), bright near the bike and gone by ~20 m — the
  //    Kelvin arms. Their angle matches the felt buoyancy bump.
  // Returns vec3(mask, arcU, perpV): the mask plus the trail-frame texture
  // coordinate of the STRONGEST contributing trail. The wake stroke sheet is
  // sampled OUTSIDE this Fn — fragment texture reads with implicit
  // derivatives aren't allowed in the non-uniform control flow inside.
  const computeWakeTrail = Fn(() => {
    const mask = float(0).toVar()
    const arcU = float(0).toVar()
    const perpV = float(0).toVar()
    const behindOut = float(0).toVar()
    // Same dynamic per-trail loop as the vertex ridge ('ti' so the segment
    // scan's inner 'i' can't shadow) — one churn/rail body in the fragment
    // WGSL instead of MAX_WAKE_TRAILS unrolled copies.
    Loop(
      // biome-ignore lint/suspicious/noExplicitAny: LoopNode accepts `name` at runtime
      { start: int(0), end: int(MAX_WAKE_TRAILS), type: 'int', condition: '<', name: 'ti' } as any,
      // biome-ignore lint/suspicious/noExplicitAny: named loop var surfaces under its custom key
      ({ ti }: any) => {
        // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
        const cull = wakeTrailCullUniform.element(int(ti)) as any
        // biome-ignore lint/suspicious/noExplicitAny: TSL types lose precision here
        const cdx = positionWorld.x.sub(cull.x) as any
        // biome-ignore lint/suspicious/noExplicitAny: TSL types lose precision here
        const cdz = positionWorld.z.sub(cull.y) as any
        If(cdx.mul(cdx).add(cdz.mul(cdz)).lessThan(cull.z), () => {
          const scan = emitTrailScan(ti, positionWorld.x, positionWorld.z, tNode)
          If(scan.strength.greaterThan(float(0.001)), () => {
            const dLat = sqrt(scan.dist2)
            const behind = scan.behind
            // Center churn strip: solid at the axis, soft edge, widening
            // slowly (NOT at the V's rate — churn is hull-width turbulence).
            // Amplitude gets a strong close-in boost (the prop-churned water
            // right off the hull) on top of the long tail decay, so the wake
            // reads as a confident ribbon near the bike that thins into
            // dissolving tufts down the trail.
            const churnHW = behind.mul(0.06).add(float(0.65))
            const churn = smoothstep(churnHW, churnHW.mul(0.5), dLat)
            const churnFade = exp(behind.mul(-0.055)).mul(
              float(0.7).add(exp(behind.mul(-1 / 7)).mul(0.4)),
            )
            // Edge rails on the displacement ridge.
            const wakeWidth = behind.mul(WAKE_HALF_ANGLE_TAN).add(float(WAKE_BASE_WIDTH))
            const rail = float(1).sub(smoothstep(float(0), float(1.1), abs(dLat.sub(wakeWidth))))
            const railFade = exp(behind.mul(-0.11))
            // Taper into the propwash apex at the hull.
            const headRamp = smoothstep(float(0.0), float(1.2), behind)
            const ageFade = exp(scan.age.div(-WAKE_AGE_TAU))
            const m = churn
              .mul(churnFade)
              .add(rail.mul(railFade).mul(0.9))
              .mul(headRamp)
              .mul(scan.strength)
              .mul(ageFade)
              .mul(wakeStrengthUniform)
            // Strongest trail wins the texture frame (overlaps are brief and
            // both trails sample the same sheet — no visible handoff).
            If(m.greaterThan(mask), () => {
              mask.assign(m)
              arcU.assign(scan.arc)
              perpV.assign(scan.perpSigned)
              behindOut.assign(behind)
            })
          })
        })
      },
    )
    return vec4(clamp(mask, float(0), float(1)), arcU, perpV, behindOut)
  })
  const wakeTrail = computeWakeTrail()
  // Trail-aligned churn strokes: U pinned to path arc length (the pattern is
  // painted onto the world and trails behind the bike), V lateral. Sampled
  // at top level — see the Fn note above.
  const wakeStrokeUV = vec2(
    wakeTrail.y.div(float(WAKE_STROKE_TILE_U)),
    wakeTrail.z.div(float(WAKE_STROKE_TILE_V)),
  )
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
  const wakeStrokeSample = texture(getWakeStrokeTexture(), wakeStrokeUV) as any
  // Stroke break-up ramps in DOWN the trail: near the hull the ribbon stays
  // a solid sheet (high floor — fresh churn hasn't broken up yet); by ~16 m
  // back the floor drops and the 0.2 edge-snap downstream dissolves the
  // tail into the sheet's painted tufts.
  const wakeStrokeFloor = mix(
    float(0.65),
    float(0.25),
    smoothstep(float(2.0), float(16.0), wakeTrail.w),
  )
  // Chase-cam guard: the player's OWN near wake sits right under the low
  // chase camera, and foreshortening turns a few meters of solid churn into
  // the whole bottom third of the frame — a blown-out white sheet. Fade the
  // wake foam out within ~8 m of the camera; everyone else's wake (and your
  // own, one beat back) is past that. The ridge displacement is untouched,
  // so the faded band still reads as moving water, not a hole.
  const wakeCamFade = smoothstep(float(4.0), float(9.0), camDist)
  const wakeTrailFoam = wakeTrail.x
    .mul(mix(wakeStrokeFloor, float(1.0), wakeStrokeSample.r))
    .mul(wakeCamFade)

  // Shoreline foam: white foam where terrain is just below the water
  // surface. Reads from the shared `closeness` / `closenessSigned`
  // values lifted to the top of the fragment composition (originally
  // local to this block) so the shallow-water color tint in `baseColor`
  // can read the same depth signal. `behindGate` keeps foam from firing
  // where opaque objects (e.g. a bike) occlude the water plane between
  // camera and the actual water surface — without it, those samples
  // would read negative closeness and falsely trigger foam.
  const intersectionFoam = (() => {
    // Wide band of soft foam that reaches 6 m off-shore + a tight
    // bright peak right at the water-line. Two layers maxed together:
    //   - `bandFoam`   — 0..1 over a breathing depth range, with the
    //                    falloff biased so the half-mark is still
    //                    quite bright. Reads as a surf zone rather
    //                    than a thin ribbon.
    //   - `peakFoam`   — narrow bright lip in the first ~1 m of
    //                    submersion. This is the unmistakable "foam
    //                    at the geometry edge" beat.
    const FOAM_BAND_BASE = 6.0
    const PEAK_RANGE = 1.0
    // Swash run-up reach (extra metres the foam climbs the beach at the top
    // of a shore-wave crest).
    const SWASH_REACH = 3.0
    const behindGate = smoothstep(float(-0.05), float(0.05), closenessSigned)
    // Swash: each shoreward-marching shore-wave crest pushes the foam edge up
    // the beach, then the trough lets it slide back — the lacy run-up/retreat
    // at the waterline. `shoreHeightFrag` is the signed shore-wave height
    // (already scaled by shore strength + gated to 0 without a shore field),
    // so this is a clean no-op on open water.
    const swash = smoothstep(float(0.0), float(0.35), shoreHeightFrag)
    // Lapping shoreline: the depth threshold breathes ±1.0 m around
    // the 6.0 m base as the shared foam noise scrolls; swash extends the
    // reach further up-beach on incoming crests.
    const noiseRangeOffset = foamNoiseRaw.sub(float(0.5)).mul(float(2.0))
    const bandRangeNow = float(FOAM_BAND_BASE)
      .add(noiseRangeOffset)
      .add(swash.mul(float(SWASH_REACH)))
    // Pow-0.4 falloff: fuller-bright across more of the band. At half
    // the band depth, foam still reads at ~0.76 brightness.
    const bandLinear = float(1).sub(clamp(closeness.div(bandRangeNow), float(0), float(1)))
    const bandFoam = pow(bandLinear, float(0.4))
    // Tight bright peak right at the intersection — the unmistakable
    // waterline lip on top of the wider band. Its reach widens with the
    // swash so the bright leading edge of foam visibly climbs the sand.
    const peakRangeNow = float(PEAK_RANGE).add(swash.mul(float(1.5)))
    const peakLinear = float(1).sub(smoothstep(float(0), peakRangeNow, closeness))
    const peakFoam = peakLinear.mul(float(1.15))
    const intensityModulator = mix(float(0.9), float(1.2), foamNoiseSmooth)
    return behindGate.mul(max(bandFoam, peakFoam)).mul(intensityModulator)
  })()

  // Shoreline surf — pulsing breakers driven by true vertical water
  // depth + incoming wave crests. Complements `intersectionFoam` above
  // (which is screen-space depth, great visual cue at grazing angles) by
  // adding geometrically-correct surf that fires per-pixel on the
  // terrain-shoaled cells. The pulse is what makes the coastline feel
  // alive: each ambient swell crest gets brighter as it sweeps into
  // shallow water (real-world shoaling: waves slow + steepen + break),
  // so the surf line breathes with the wave field instead of sitting
  // as a static foam ring. Inactive when no heightmap is installed
  // (waterDepthFrag stays ≈ +10000 → shoreBand ≈ 0).
  const shorelineSurf = (() => {
    // Strong only in the last ~3 m of depth — same envelope as the
    // vertex shoaling so foam and damped geometry align.
    const SURF_BAND_DEPTH = 3.0
    const shoreBand = float(1).sub(smoothstep(float(0), float(SURF_BAND_DEPTH), waterDepthFrag))
    // Crest signal: the stronger of the un-attenuated ambient wave height and
    // the shore-aligned wave height. Positive values are wave faces marching
    // toward shore — exactly what we want to "break" into surf. The ambient
    // term keeps the pulse cadence locked to the natural swell even where the
    // geometry is damped; the shore term makes the surf line break in step
    // with the shoreward-marching shore waves that now drive the band.
    const crestSignal = clamp(max(ambientHeightFrag, shoreHeightFrag), float(0), float(1.5))
    // Pow-1.6 biases the response: small crests produce faint surf;
    // once a real crest arrives, foam saturates fast.
    const crestBreaker = pow(smoothstep(float(0.05), float(0.6), crestSignal), float(1.6))
    // Persistent waterline lip — always-on faint band at the shoreline
    // edge (≤ 0.5 m depth) so the boundary never disappears between
    // crests, even on calm seas.
    const waterlineBase = float(1)
      .sub(smoothstep(float(0), float(0.5), waterDepthFrag))
      .mul(float(0.35))
    const turbulence = mix(float(0.7), float(1.15), foamNoiseSmooth)
    const breaker = shoreBand.mul(crestBreaker).mul(turbulence).mul(float(1.25))
    return max(breaker, waterlineBase.mul(shoreBand))
  })()

  // Waterline obstacle collars + wash ripples (see contactFoamSum above) —
  // skipped entirely by the uniform count gate on contact-free tracks.
  const contactFoam = contactFoamSum(positionWorld.x, positionWorld.z, tNode, ambientHeightFrag)

  // Intersection foam is full-opaque white where it fires (we want the
  // shoreline edge to read clearly against the water), so we max-combine
  // it with the (waveFoam + bikeFoam) sum rather than adding — additive
  // would create unnaturally over-bright zones at gate posts where the
  // ramp hits water. Final clamp raised from 0.95 to 1.0 so the bright
  // peak at the water-line can reach pure white. The new `shorelineSurf`
  // (depth-driven pulsing breakers) folds in via max so its bright
  // crest-strike pulses can paint over the static intersection band; the
  // obstacle contact foam folds the same way so collars never over-brighten
  // where they overlap surf or wakes.
  const foamMaskRaw = clamp(
    max(max(waveFoam.add(bikeFoam), intersectionFoam), max(shorelineSurf, contactFoam)),
    float(0),
    float(1),
  )
  // Foam bubble texture — the SoT "authored bubble" layer. Sampled at
  // world XZ so bubbles read as a property of the surface (they don't
  // move with the camera) but with a slow wind-aligned scroll so the
  // foam visually drifts with the air-foam buffer's advection. 4 m tile
  // → bubbles read ~25-50 cm in race-camera space. The R channel holds
  // the Worley-cluster pattern; G/B/A are unused.
  //
  // The bubble pattern modulates `foamMask` so every foam source —
  // wake, bow spray, shoreline surf, breaking-wave fold-foam — inherits
  // bubble structure. mix(0.35, 1.0, bubble) keeps strong-foam zones
  // bright while breaking dim-foam edges into discrete bubble blobs.
  // Swell frame for the foam break-up patterns + the Langmuir lanes below:
  // world XZ rotated by the global wave bearing. (Computed before the
  // bubble sample now — both break-up sheets share the tangential warp.)
  const brushBearingRad = waveBearingDegUniform.mul(float(Math.PI / 180))
  const brushCos = float(cos(brushBearingRad))
  const brushSin = float(sin(brushBearingRad))
  // P2.3 tangential warp scalar: the 35 m detail-warp noise projected onto
  // the CREST axis — a slow ±4 m wobble that bends the break-up patterns
  // along the wave fronts. Along-crest ONLY (§7.8): warping the travel
  // coordinate would slide foam against the wave motion, and any height
  // warp would falsify the steepness read. Reuses `warpX/warpZ` (already
  // sampled for the detail cascades) so it costs zero extra taps.
  const crestAxisWarp = float(
    warpZ.mul(brushCos).sub(warpX.mul(brushSin)).mul(float(1.6)).mul(foamWarpUniform),
  )

  const foamBubbleTex = getFoamBubbleTexture()
  // The bubble sheet is isotropic in world XZ; its tangential warp shifts
  // the sample position along the world-space crest direction. float()
  // wraps resolve the scalar overloads (file convention).
  const bubbleWarpX = float(brushSin.negate().mul(crestAxisWarp))
  const bubbleWarpZ = float(brushCos.mul(crestAxisWarp))
  const foamBubbleUV = vec2(
    float(positionWorld.x.add(bubbleWarpX)),
    float(positionWorld.z.add(bubbleWarpZ)),
  )
    .div(float(4.0))
    .add(vec2(tNode.mul(float(0.012)), tNode.mul(float(-0.008))))
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
  const foamBubbleSample = (
    hexTileFlag ? hexTiledTap(foamBubbleTex, foamBubbleUV) : texture(foamBubbleTex, foamBubbleUV)
  ) as any
  const foamBubblePattern = foamBubbleSample.r

  // Oil-stroke foam mass — the painterly alternative to the disc bubbles.
  // Sampled in a CREST-ALIGNED frame (world XZ rotated by the global wave
  // bearing) so the sheet's tapered strokes run PARALLEL TO THE CREST
  // LINES — foam dissolves into brush strokes that trace the wave fronts,
  // the way a seascape painter pulls the brush along each crest.
  // (Playtest-corrected: the first cut combed strokes along the swell's
  // TRAVEL direction and read exactly 90° wrong.) The frame is constant
  // per track (no per-fragment flow rotation), so the pattern never warps
  // or seams where the local gradient flips; the streak layer below adds
  // the on-face variant of the same crest-parallel language. The travel
  // coordinate drifts slowly with time so the paint rides with the waves.
  const FOAM_BRUSH_TILE_M = 5.0
  // Coordinate along the swell's TRAVEL direction (waves advance along it)…
  const brushTravel = positionWorld.x
    .mul(brushCos)
    .add(positionWorld.z.mul(brushSin))
    .sub(tNode.mul(float(0.1)))
  // …and along the CREST direction (perpendicular — the wave-front axis),
  // wobbled by the tangential warp so the stroke rows don't run
  // geometrically straight forever.
  const brushCrest = positionWorld.x
    .mul(brushSin.negate())
    .add(positionWorld.z.mul(brushCos))
    .add(crestAxisWarp)
  const foamStrokeMassTex = getFoamStrokeMassTexture()
  // Texture U (the strokes' long axis) ← crest coordinate; V ← travel.
  const foamStrokeMassUV = vec2(brushCrest, brushTravel).div(float(FOAM_BRUSH_TILE_M))
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
  const foamStrokeMassSample = (
    hexTileFlag
      ? hexTiledTap(foamStrokeMassTex, foamStrokeMassUV)
      : texture(foamStrokeMassTex, foamStrokeMassUV)
  ) as any
  // The break-up pattern every foam source inherits: disc bubbles ↔ strokes.
  const foamBreakupPattern = mix(foamBubblePattern, foamStrokeMassSample.r, foamBrushUniform)

  // ── P2.3 Langmuir streak lanes ──────────────────────────────────────
  // Real seas under sustained wind develop windrows — faint foam/slick
  // lanes ALIGNED WITH the wind, tens of metres apart. They're the one
  // natural cue that signals the sea's travel direction on water too calm
  // for crest/foam cues to fire (§5's "nothing on calm stretches" gap).
  // Implementation: the detail texture sampled in the swell frame with a
  // strongly anisotropic tile (≈140 m along travel × 18 m across), gated
  // to a sparse lane mask, faded out wherever the ANALYTIC swell slope
  // says the sea already carries shape cues, and faded with distance
  // (sub-pixel past ~300 m). Brightness-only modulation on the surface
  // color — no vertex or foam-gate contribution, so it can't lie about
  // the physics (it sits safely in §3's normal/shading-only band).
  const laneUv = vec2(brushTravel.div(float(140)), brushCrest.div(float(18)))
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
  const laneSample = texture(detailTex, laneUv) as any
  const laneMask = smoothstep(float(0.58), float(0.82), laneSample.r)
  const analyticSlopeMag = sqrt(dydx.mul(dydx).add(dydz.mul(dydz)))
  const laneCalmGate = float(1).sub(smoothstep(float(0.1), float(0.22), analyticSlopeMag))
  const laneDistFade = float(1).sub(smoothstep(float(160), float(300), camDist))
  const langmuirLane = laneMask.mul(laneCalmGate).mul(laneDistFade).mul(langmuirUniform)

  // ── Directional foam streaks (step 3, reworked) ─────────────────────
  // Paint foam on the wave faces as long brushstrokes running ALONG the
  // local crest line (perpendicular to the surface gradient) — the on-face
  // variant of the crest-parallel stroke language above, tracing the wave's
  // shape the way the contour-line layer does. (Playtest-corrected with the
  // mass pattern: strokes originally combed DOWN the face — 90° wrong.) The
  // stroke sheet (`getFoamStreakTexture`, tapered strokes along its U axis)
  // is sampled with U mapped to the cross-slope direction; the down-face
  // coordinate scrolls with time so the stroke bands still slide down each
  // breaking face.
  const slopeMagS = sqrt(effDydx.mul(effDydx).add(effDydz.mul(effDydz))).max(float(0.0008))
  const flowDirX = effDydx.div(slopeMagS)
  const flowDirZ = effDydz.div(slopeMagS)
  // Down-face (gradient) coordinate, scrolled so strokes drift downhill…
  const streakFlow = positionWorld.x
    .mul(flowDirX)
    .add(positionWorld.z.mul(flowDirZ))
    .sub(tNode.mul(float(0.6)))
  // …and the cross-slope coordinate — the local crest-line direction.
  const streakCross = positionWorld.x.mul(flowDirZ.negate()).add(positionWorld.z.mul(flowDirX))
  const streakTex = getFoamStreakTexture()
  // U (stroke long axis) ← cross-slope, V ← down-face. Tile spans
  // 1/0.08 ≈ 12.5 m along the crest × 1/0.14 ≈ 7 m down the face →
  // strokes ~2–7 m long and ~0.2–0.4 m wide, a few stacked per face.
  const streakUV = vec2(streakCross.mul(float(0.08)), streakFlow.mul(float(0.14)))
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
  const streakSample = texture(streakTex, streakUV) as any
  // Concentrate the streaks where the wave is actually breaking or steep — near
  // crests (reuse `whitecapGate`) and on the steeper part of the face — NOT on
  // every gentle swell (gating only on a low slope painted the whole sea with
  // strokes). They still extend down the face (the steep-face term) so they
  // trace the wave shape, just not across flat water. Faded at distance (the
  // flow orientation goes noisy far off + the strokes alias), scaled by the
  // uniform.
  const streakConc = clamp(
    max(whitecapGate, smoothstep(float(0.22), float(0.46), slopeMagS).mul(float(0.7))),
    float(0),
    float(1),
  )
  const streakFaceWeight = streakConc
    .mul(float(1).sub(smoothstep(float(55), float(140), camDist)))
    .mul(foamStreakUniform)
  const streakFoam = streakSample.r.mul(streakFaceWeight)

  // Bubble-texture floor (strength-aware): thin foam → 0.05 (discrete bubbles
  // over clean water), strong foam (propwash / breaking crest) → 0.6 (solid).
  // The wash-killer — without it broad thin foam paints a uniform milky sheet.
  // Applied to the wave/shore/at-hull foam; the streak layer and the trail
  // wake carry their own stroke shapes, so they're combined in after — the
  // trail wake in particular must NOT inherit this world-anchored disc/crest
  // pattern (polka-dot wake was the exact complaint that retired it).
  const foamBubbleFloor = mix(float(0.05), float(0.6), clamp(foamMaskRaw, float(0), float(1)))
  const foamBubbly = foamMaskRaw.mul(mix(foamBubbleFloor, float(1.0), foamBreakupPattern))
  const foamCoverage = max(foamBubbly, max(streakFoam, wakeTrailFoam))
  // Near-BINARY edge: the concept foam is on/off and SHRINKS in area rather
  // than fading in opacity. A tight smoothstep around 0.2 snaps mid-coverage
  // to clean water or solid foam, so as a crest passes its peak the foam patch
  // shrinks instead of dissolving to a haze. The ramp widens with distance so
  // the crisp edge doesn't alias/shimmer in the far field.
  const foamEdgeAA = mix(float(0.05), float(0.2), smoothstep(float(30), float(120), camDist))
  const foamMask = smoothstep(float(0.2).sub(foamEdgeAA), float(0.2).add(foamEdgeAA), foamCoverage)
  // Slightly warmer / brighter than v2's (0.92, 0.96, 1.0). Real surf
  // foam reads near-white-with-a-warm-tilt under sunlight; the previous
  // cool tint was getting tugged blue by the deep-water albedo it sat on
  // top of, especially while the alpha was 0.78.
  const foamColor = vec3(0.97, 0.99, 1.0)

  // ── Light-driven foam tint (step 2) ──────────────────────────────────
  // Real surf foam is not a flat white sheet: the low sun rakes its edges
  // warm (coral/gold), the dense breaking core stays white-hot, and foam
  // away from the sun reads cooler. We tint foam toward a saturated sunset
  // coral — but only as much as (a) the view faces the low sun, (b) the sky
  // itself is warm, and (c) the foam noise says, so the tint is patchy and
  // self-disables at midday rather than dyeing every sea orange.
  //
  // `foamWarmRake` is the warm amount — strongest looking toward the low sun
  // (`sunBackscatter`), lifted on crests (`heightFactor`), broken by the
  // shared foam noise (`foamFiber`). The +0.15 / +0.4 floors keep a little
  // warmth on crests even when the sun is behind the camera.
  const foamWarmRake = clamp(
    sunBackscatter.add(float(0.15)).mul(heightFactor.add(float(0.4))),
    float(0),
    float(1),
  )
    .mul(foamFiber)
    .mul(foamWarmthUniform)
  // How warm the sky is right now: horizon-haze red minus blue. >0 at
  // golden/sunset, ≈0 at cool midday — so the saturated tint only fires when
  // the light actually is warm (mixing toward the *desaturated* horizon haze,
  // as the crest-mist does, barely shifts near-white foam — hence a dedicated
  // saturated target gated by this).
  const skyWarmth = clamp(
    horizonHazeUniform.x.sub(horizonHazeUniform.z).mul(float(2.4)),
    float(0),
    float(1),
  )
  // Saturated sunset-coral foam tint. Bright (so foam stays luminous) but
  // blue-deficient (so it reads coral/gold, not muddy orange).
  const foamWarmTint = vec3(1.0, 0.66, 0.44)
  const foamWarmAmount = clamp(foamWarmRake.mul(skyWarmth), float(0), float(0.82))
  const foamColorLit = mix(foamColor, foamWarmTint, foamWarmAmount)

  // Fresnel: standard Schlick approximation. Used both as a strength
  // weight for the planar reflection (below) and as the fallback sky-tint
  // emissive when reflections are off (classic mode / `?reflect=0`).
  // (viewDir + ndotv computed earlier and shared with the scatter blend.)
  const f0 = float(0.02)
  const fresnel = f0.add(
    float(1)
      .sub(f0)
      .mul(pow(float(1).sub(ndotv), 5)),
  )

  // Planar reflection (M9.38). The TSL `reflector()` node manages a
  // virtual mirror camera + render-target, samples them via screenUV. The
  // call returns a TextureNode whose .rgb gives the reflected scene color.
  //
  // We distort the reflection UV by the wave-normal slopes (dydx, dydz)
  // so the reflection ripples with the surface — without distortion the
  // mirror image looks glassy and the wave geometry feels disconnected
  // from what's painted on it. Distortion magnitude tapers with
  // view-distance so distant waves don't smear the reflection across the
  // screen (typical mirror-distortion trick: closer = more refraction).
  //
  // The reflection is mixed into the base water color via Fresnel — at
  // grazing angles the surface reflects strongly (sky/horizon hits the
  // eye), at the zenith the diffuse scatter color dominates. The fresnel
  // sky-tint emissive that previously approximated this is dropped when
  // reflections are on (the actual reflected sky subsumes it); classic
  // mode and `?reflect=0` preserve the cheap fake.
  //
  // Cost: a full additional render pass at half-res per frame. Rendered
  // scene includes sky + bikes + terrain + props but excludes the water
  // itself (the reflector toggles `material.visible = false` during its
  // pass). At 0.5 resolutionScale on a 1080p framebuffer that's 540p, a
  // few hundred k pixels — trivial on real GPUs, fine on WebGPU + WebGL2.
  // `?reflect=0|1` forces the planar-reflection pass (ablation axis);
  // absent → the resolved quality tier (off on Low). The pass is already
  // layer-culled (#371), so this is the Low-tier "drop it entirely" switch.
  const reflectFlag = params?.has('reflect')
    ? params.get('reflect') !== '0'
    : getActiveQuality().reflection
  // Mirror-pass scene cull (the water-ablation tool's headline finding):
  // the reflector re-renders the scene into its RT every frame — ~98 extra
  // draw calls on sandbar, ~÷2 fps — yet at our fresnel cap + wave
  // distortion the reflection legibly carries only the SKY and the big
  // terrain/landmark silhouettes. So the virtual camera is restricted to
  // an OPT-IN layer (`WATER_REFLECTION_LAYER`): the sky dome opts in at
  // creation (sky.ts), terrain + landmark-scale meshes opt in via the
  // size gate in track-loader.ts, and everything else — props, bikes,
  // FX, small dressing, anything streamed later — stays out by default,
  // so new content can't silently regress the mirror cost.
  // `?reflectfull=1` restores the legacy full-scene mirror for A/B.
  const reflectFullFlag = params?.get('reflectfull') === '1'
  let reflectionRgb: ReturnType<typeof vec3> | null = null
  let reflectorTarget: THREE.Object3D | null = null
  // biome-ignore lint/suspicious/noExplicitAny: TSL ReflectorNode TS surface lacks getVirtualCamera
  let reflectorNode: any = null
  if (reflectFlag) {
    const mirror = reflector({
      resolutionScale: 0.5,
      bounces: false,
      generateMipmaps: false,
    })
    reflectorNode = mirror
    // Distortion: scale wave-normal gradients by an inverse-distance
    // factor so the close-in 1–2 m of water in front of the camera
    // distorts visibly while horizon samples stay nearly mirror-flat.
    // The 0.04 base is the gentlest setting that still reads as "moving
    // water" rather than "glass"; bump if the reflection feels too
    // perfect, drop if it smears.
    const distortAmt = float(0.02).add(float(0.6).div(camDist.add(float(2.0))))
    // Use the combined (analytic + detail) slopes so the reflection ripples
    // with the fine wave chop the detail-normal cascades add. Without this,
    // close-range reflections look glassy under the visibly-bumpy surface.
    const distortion = vec2(effDydx, effDydz).mul(distortAmt)
    // biome-ignore lint/suspicious/noExplicitAny: TSL ReflectorNode TS surface lacks .uvNode/.rgb/.target getters
    const m = mirror as any
    m.uvNode = m.uvNode.add(distortion)
    reflectionRgb = m.rgb
    reflectorTarget = m.target
  }

  // ── P1 readability layers (water-next-research.md §5, §8 P1) ─────────
  // Fragment-only signals that make the SWELL SHAPE readable at race speed,
  // pairing the two channels the perception research says reinforce each
  // other (shaded relief + contours beat either alone):
  //
  //  1. Crest-to-trough VALUE RAMP, posterized into bands — "one value
  //     sweep per wave face" (the Wave Race 64 lesson). Keyed to the
  //     swell-only varying; band BOUNDARIES are the signal, and posterizing
  //     a smooth field preserves the orientation flow that carries shape
  //     (Fleming et al.). NOTE this is intentionally the opposite call from
  //     the old "height isolines" bug fix at `heightNorm` above: those bands
  //     were accidental, full-spectrum (chop included) and uncontrolled —
  //     these are swell-only, quantized on purpose, and behind live knobs.
  //  2. CONTOUR-LINE FOAM — thin iso-height lines off the same swell-only
  //     field (the re-landed 2026-06-06 cel-session layer, §4.3). A fixed
  //     height interval means lines pack together exactly where the face
  //     steepens — line density IS the steepness cue (the topo-map
  //     property). fwidth keeps the width ~constant in pixels, and the
  //     lines fade wherever they'd crowd below a few pixels (the known
  //     distant-moiré failure), with every 3rd line heavier (cartographic
  //     index contours) so the eye can count big intervals at a glance.
  //  3. WIND-WAKER RELIEF PAIR — the same line mask re-sampled on a height
  //     extrapolated a small step AWAY from the sun (first-order, via the
  //     swell gradient varying) paints a dark-teal twin beside each light
  //     line: the cheapest "embossed relief" read.
  //
  // All three die out (a) in shallows (the varyings are shoal-scaled), (b)
  // toward the center↔outer LOD cross-fade band (the outer tile doesn't run
  // them, so they fade before the seam could show a tonal step), and (c)
  // the ramp additionally backs off as the sun climbs — at high noon the
  // luminance field frequency-doubles against the surface and extra band
  // contrast reads as dirt, not shape (the cel session's auto-centering
  // lesson, simplified to a guard).
  const RAMP_STRENGTH_DEFAULT = 0.45
  const RAMP_STEPS_DEFAULT = 3
  const RAMP_POSTERIZE_DEFAULT = 0.7
  const CONTOUR_STRENGTH_DEFAULT = 0.55
  const CONTOUR_SPACING_DEFAULT = 0.45
  const CONTOUR_RELIEF_DEFAULT = 0.6
  const CONTOUR_BREAKUP_DEFAULT = 1.0
  // Slope-gate raise (the iso-coherence knob's partner — `?waterlab`).
  // Iso-lines sweep at ∂h/∂t ÷ slope, so the FLATTEST faces that pass the
  // gate carry the fastest-sliding lines; raising the gate window from the
  // legacy (0.02, 0.06) toward (0.06, 0.14) trims those first while steep
  // faces (where lines pack into the steepness cue) keep their contours.
  const CONTOUR_GATE_DEFAULT = 0
  const rampStrengthUniform = uniform(RAMP_STRENGTH_DEFAULT)
  const rampStepsUniform = uniform(RAMP_STEPS_DEFAULT)
  const rampPosterizeUniform = uniform(RAMP_POSTERIZE_DEFAULT)
  const contourStrengthUniform = uniform(CONTOUR_STRENGTH_DEFAULT)
  const contourSpacingUniform = uniform(CONTOUR_SPACING_DEFAULT)
  const contourReliefUniform = uniform(CONTOUR_RELIEF_DEFAULT)
  const contourBreakupUniform = uniform(CONTOUR_BREAKUP_DEFAULT)
  const contourGateUniform = uniform(CONTOUR_GATE_DEFAULT)
  // Rising-face strokes (2026-06-10) — the perpendicular partner of the
  // contour lines. Where contours trace iso-height bands ALONG each crest,
  // these are tapered brush strokes pulled UP the leading (rising) face of an
  // approaching wave — perpendicular to the crest, the "vertical strokes
  // climbing the wave coming at you" read. Same painterly foam-stroke language
  // as the face streaks, but oriented along the swell TRAVEL axis and gated to
  // the front face via ∂h/∂t. 0 = off.
  const RISE_STROKE_DEFAULT = 0.5
  const riseStrokeUniform = uniform(RISE_STROKE_DEFAULT)

  // Normalised swell phase 0..1 across the LIVE swell envelope — the amps
  // come from the same mirrored uniform buoyancy uses, so Beaufort, the
  // lap-weather storm ramp and the menu sliders keep the bands centred.
  // (`swellAmpSum` is the shared swell-band Σ|A| node defined alongside
  // `waveAmpUniform` — the shoaling-v2 break cap reads the same one.)
  // Span follows the iso-coherence blend (full swell span ↔ dominant-only
  // span) so the ramp bands stay centred on the field actually drawn.
  const swellSpan = max(mix(swellAmpSum, dominantSwellAmpAbs, contourCoherenceUniform), float(0.05))
  const rampT = clamp(
    swellHeightFrag.div(swellSpan.mul(float(2))).add(float(0.5)),
    float(0),
    float(1),
  )
  const rampStepsF = max(rampStepsUniform, float(2))
  const rampQ = clamp(
    floor(rampT.mul(rampStepsF)).add(float(0.5)).div(rampStepsF),
    float(0),
    float(1),
  )
  const rampMix = mix(rampT, rampQ, rampPosterizeUniform)
  const sunHighGuard = mix(
    float(1.0),
    float(0.55),
    smoothstep(float(0.55), float(0.9), sunDirUniform.y),
  )
  const rampDistFade = float(1).sub(smoothstep(float(130), float(260), camDist))
  // Value sweep, multiplicative around 1 so the Beer-Lambert body + scatter
  // hues keep their identity; warm/teal duality rides on top — crest bands
  // lean warm only as much as the sky itself is warm (sunset palette), so
  // the duality self-disables at midday instead of dyeing the sea.
  const rampDeviation = rampMix
    .sub(float(0.5))
    .mul(rampStrengthUniform)
    .mul(float(0.55))
    .mul(sunHighGuard)
    .mul(rampDistFade)
  const rampBandTint = mix(vec3(0.94, 1.0, 1.04), vec3(1.06, 1.0, 0.95), rampMix)
  const rampTint = mix(vec3(1, 1, 1), rampBandTint, skyWarmth.mul(rampDistFade))

  // Contour lines. Slope gate: fract(h/spacing) degenerates into giant
  // on/off regions on near-flat water (which needs no shape cue anyway).
  const swellSlopeMag = sqrt(swellDydxFrag.mul(swellDydxFrag).add(swellDydzFrag.mul(swellDydzFrag)))
  // Gate window rides the contourGate knob: legacy (0.02, 0.06) at 0 up to
  // (0.06, 0.14) at 1 — see CONTOUR_GATE_DEFAULT for why raising it tames
  // the fast-sliding lines on near-flat faces.
  const contourGateLo = mix(float(0.02), float(0.06), contourGateUniform)
  const contourGateHi = mix(float(0.06), float(0.14), contourGateUniform)
  const contourSlopeGate = smoothstep(contourGateLo, contourGateHi, swellSlopeMag)
  // Screen-space height derivative — line width stays ~constant in pixels
  // on any face angle, and lines fade out where they'd pack below ~5 px.
  const swellHeightPx = max(fwidth(swellHeightFrag), float(1e-5))
  const contourSpacing = max(contourSpacingUniform, float(0.1))
  // Plain JS helper (compile-time unrolled, not a TSL Fn): node params are
  // typed loosely because derived/varying float nodes don't satisfy the
  // narrower VarNode the `float()` constructor returns.
  const contourLineMask = (h: unknown, spacingN: unknown, widthPx: number) => {
    const hN = h as ReturnType<typeof float>
    const spN = spacingN as ReturnType<typeof float>
    const ph = fract(hN.div(spN))
    const distH = min(ph, float(1).sub(ph)).mul(spN)
    const w = swellHeightPx.mul(float(widthPx))
    return float(1).sub(smoothstep(w.mul(float(0.5)), w.mul(float(1.5)), distH))
  }
  const contourMinor = contourLineMask(swellHeightFrag, contourSpacing, 1.1)
  const contourIndex = contourLineMask(swellHeightFrag, contourSpacing.mul(float(3)), 2.0)
  const contourCrowdFade = float(1).sub(
    smoothstep(contourSpacing.div(float(9)), contourSpacing.div(float(4.5)), swellHeightPx),
  )
  const contourDistFade = float(1).sub(smoothstep(float(160), float(300), camDist))
  // Break-up: an iso-height mask is constant along its own line, so without
  // help every contour runs unbroken across the whole sea — too clean for the
  // painted read. The dash sheet is a stack of 1-D dash rows used as a KEEP
  // mask, keyed to invariants that RIDE WITH the line: U is the crest-axis
  // coordinate (a point on a travelling iso line keeps its crest-axis
  // position — swell advances perpendicular to it) and V picks one row per
  // iso LEVEL (a line is its level, forever; neighbouring lines cycle
  // different rows; index lines coincide with every 3rd minor level so one id
  // covers both, and the sub-metre relief shift never moves h across a band
  // midpoint so the dark twin shares the row). The first cut sampled
  // world-space instead and strobed: lines cross a ~0.4 m stroke footprint in
  // 2–3 frames at swell phase speed (~10 m/s), blinking every dash. V is
  // piecewise-constant; its derivative blows up only at band midpoints, where
  // the line masks are zero by construction, so the garbage mip fetch there
  // is always masked. The cut rides the swell phase (`rampT`, 0 = trough,
  // 1 = crest — constant per line, so each line keeps one dash character):
  // crest lines keep long confident dashes with generous negative space, and
  // in the troughs the cut climbs into the per-dash gain range so only sparse
  // stroke cores survive — lines cling to the crests and the trough floor
  // reads clean. Both cut points are pinned against the sheet's rows in
  // oil-stroke-texture.test.ts.
  const CONTOUR_DASH_TILE_M = 11.0
  const CONTOUR_DASH_ROWS = CONTOUR_DASH_SPEC.rows
  const contourBandId = floor(swellHeightFrag.div(contourSpacing).add(float(0.5)))
  const contourDashUV = vec2(
    brushCrest.div(float(CONTOUR_DASH_TILE_M)),
    // Row CENTER for level k (fract wraps negative levels into 0..rows-1).
    fract(contourBandId.div(float(CONTOUR_DASH_ROWS))).add(float(0.5 / CONTOUR_DASH_ROWS)),
  )
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
  const contourDashSample = texture(getContourDashTexture(), contourDashUV) as any
  const contourCrestBias = smoothstep(float(0.12), float(0.62), rampT)
  const contourDashCut = mix(float(0.92), float(0.16), contourCrestBias)
  const contourDashMask = smoothstep(
    contourDashCut.sub(float(0.1)),
    contourDashCut.add(float(0.1)),
    contourDashSample.r,
  )
  // Surviving trough dashes also carry less paint — brush pressure easing off.
  const contourBreakup = mix(
    float(1),
    contourDashMask.mul(mix(float(0.7), float(1), contourCrestBias)),
    contourBreakupUniform,
  )
  const contourBase = max(contourMinor.mul(float(0.75)), contourIndex)
    .mul(contourSlopeGate)
    .mul(contourCrowdFade)
    .mul(contourDistFade)
    .mul(contourBreakup)
  const contourLight = clamp(contourBase.mul(contourStrengthUniform), float(0), float(1))
  // Relief twin: extrapolate the swell height a small step away from the
  // sun (horizontal), re-run the same line masks, draw dark where the
  // light line isn't. First-order h + ∇h·offset is exact enough at swell
  // wavelengths (50–85 m) for a sub-meter offset, and the gradient varying
  // carries the zone/shoal scaling so the twin hugs the drawn surface.
  const sunAwayLen = max(
    sqrt(sunDirUniform.x.mul(sunDirUniform.x).add(sunDirUniform.z.mul(sunDirUniform.z))),
    float(1e-3),
  )
  const RELIEF_OFFSET_M = 0.55
  const reliefShift = swellDydxFrag
    .mul(sunDirUniform.x.negate().div(sunAwayLen))
    .add(swellDydzFrag.mul(sunDirUniform.z.negate().div(sunAwayLen)))
    .mul(float(RELIEF_OFFSET_M))
  const swellHeightShifted = swellHeightFrag.add(reliefShift)
  const contourMinorD = contourLineMask(swellHeightShifted, contourSpacing, 1.1)
  const contourIndexD = contourLineMask(swellHeightShifted, contourSpacing.mul(float(3)), 2.0)
  const contourDark = clamp(
    max(contourMinorD.mul(float(0.75)), contourIndexD)
      .mul(contourSlopeGate)
      .mul(contourCrowdFade)
      .mul(contourDistFade)
      // Same break-up as the light line so the relief pair dashes together —
      // a solid dark twin under a dashed light line reads as a glitch.
      .mul(contourBreakup)
      .mul(contourReliefUniform)
      .mul(contourStrengthUniform)
      .mul(float(1).sub(contourLight)),
    float(0),
    float(1),
  )

  // ── Rising-face strokes (crest-perpendicular brush marks) ────────────
  // The sibling of the contour lines: contours run ALONG the crests (iso
  // height); these run UP the face, square to them. Reuses the face-streak
  // oil sheet (tapered strokes along its +U axis) but samples it in the
  // GLOBAL swell frame with U ← the TRAVEL axis (so each stroke's long axis
  // climbs the face, perpendicular to the crest) and V ← the crest axis (so
  // strokes sit side-by-side across the front). Gates:
  //   • front/rising face only — `crestRiseFrag` is ∂h/∂t, > 0 on the
  //     leading face of an approaching wave (the same signal the whitecap
  //     lead-bias rides); strokes never paint the trailing/back face.
  //   • steep SWELL faces only (no chop in the gate) — flat water stays clean
  //     and the gate doesn't crawl with the sub-metre ripple.
  //   • build UP the face toward the crest (`rampT`) so they read as climbing
  //     strokes, faint at the trough.
  //   • fade with distance (the strokes alias once sub-pixel).
  // World-anchored like the face streaks: a stroke lights up smoothly as a
  // wave front sweeps over it (∂h/∂t ramps across ~a second — no strobe) and
  // fades as the crest passes. Folded into the foam paint so it inherits the
  // foam colour / warmth / bloom — it IS foam, pulled into vertical strokes.
  const RISE_STROKE_TILE_M = 8.0
  const riseStrokeUV = vec2(brushTravel, brushCrest).div(float(RISE_STROKE_TILE_M))
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
  const riseStrokeSample = texture(getFoamStreakTexture(), riseStrokeUV) as any
  // Crisp-ish stroke cores with negative space between (a painted read, not a
  // smear). The swell-only slope keeps the gate off the chop.
  const riseStrokeCore = smoothstep(float(0.25), float(0.7), riseStrokeSample.r)
  const riseFrontFace = smoothstep(float(0), float(0.45), crestRiseFrag)
  const riseSlopeGate = smoothstep(float(0.05), float(0.14), swellSlopeMag)
  const risePhaseWeight = mix(float(0.35), float(1), smoothstep(float(0.2), float(0.85), rampT))
  const riseDistFade = float(1).sub(smoothstep(float(60), float(150), camDist))
  const riseStrokeLight = clamp(
    riseStrokeCore
      .mul(riseFrontFace)
      .mul(riseSlopeGate)
      .mul(risePhaseWeight)
      .mul(riseDistFade)
      .mul(riseStrokeUniform),
    float(0),
    float(1),
  )

  // Albedo composition: deep/scatter blend → planar reflection (Fresnel-
  // weighted) → aerial perspective haze → foam paints over the result.
  // Foam comes LAST so it still reads as opaque white where it fires
  // (foam is water particles, not the surface — it shouldn't reflect
  // and shouldn't get blue-shifted by aerial perspective).
  // Distance fade on the reflection contribution. The bright low-sky /
  // horizon-haze the reflector samples at extreme grazing painted a
  // visible "mirror band" right where the water meets the sky — even
  // when the haze approximation was replaced with the real reflection
  // texture, the bright sunset horizon is what the water physically
  // reflects there, so the band stayed.
  //
  // Cap the reflection past ~500 m so distant water reverts to its
  // body color (dark teal) instead of mirroring the bright sky. Past
  // 500 m the outer LOD tile + skirt dominate anyway, both of which
  // are already body-color → the three layers converge tonally
  // instead of stepping. This trades physical correctness for the
  // smoother horizon read users actually want at sunset.
  const reflDistFade = float(1).sub(smoothstep(float(200), float(500), camDist))
  const reflectedOrBase = reflectionRgb
    ? mix(baseColor, reflectionRgb, fresnel.mul(reflStrengthUniform).mul(reflDistFade))
    : baseColor

  // Aerial perspective: distant water reads denser. Real ocean past
  // ~150 m takes on a flattened, hazier tone as the atmosphere absorbs /
  // scatters along the long view path. Without this, the horizon water
  // reads as the same color as foreground water and the scene loses its
  // sense of scale. The horizon color is driven from the sky palette via
  // `horizonHazeUniform` (see `setHorizonColor` + the sky module's tick),
  // so sunset water picks up warmth, twilight reads cool blue, etc.
  //
  // Cap at 0.25 (not the previous 0.5) so the shader's haze blend
  // stays a light atmospheric tint rather than dominating the colour
  // — scene fog (linear 500 → 2200 m) is already painting up to ~60 %
  // sky-colour by the far skirt edge, so any higher cap here was
  // double-counting the same horizon haze and showing as a bright
  // band a few pixels below the horizon line where the cap maxed out.
  const aerialMix = smoothstep(float(120), float(280), camDist).mul(float(0.25))
  const surfaceColor = mix(reflectedOrBase, horizonHazeUniform, aerialMix)

  // P1 layers land here: the posterized value sweep + warm/teal band tint
  // modulate the shaded surface, the dark relief twin carves its line, and
  // the light contour line joins the foam mask so it inherits the foam
  // color/warmth (it IS foam — the §4.3 layer re-landed inside the stack).
  // The P2.3 Langmuir lanes ride the same multiplicative slot: a faint
  // (≤ +7 %) brightness lift along the travel-aligned windrow lanes.
  const surfaceReadable = surfaceColor
    .mul(
      float(1)
        .add(rampDeviation)
        .add(langmuirLane.mul(float(0.07))),
    )
    .mul(rampTint)
  const surfaceWithRelief = mix(
    surfaceReadable,
    deepColor.mul(float(0.7)),
    contourDark.mul(float(0.8)),
  )
  const foamMaskWithContours = max(max(foamMask, contourLight), riseStrokeLight)

  const albedo = mix(
    mix(surfaceWithRelief, foamColorLit, foamMaskWithContours),
    centerDebugColorUniform,
    debugColorizeMixUniform,
  )

  // Sky-tint emissive: only used as a fallback when reflections are off
  // (`?reflect=0`). When the reflection is active, the actual reflected
  // sky already paints the grazing-angle bright band and stacking a
  // fake sky tint on top reads as chrome.
  const skyTint = vec3(0.55, 0.72, 0.95)
  const fresnelEmissive = reflectionRgb ? vec3(0, 0, 0) : skyTint.mul(fresnel.mul(0.32))

  // Sparkle: low-frequency hash on world XZ + animated UV scroll, gated to
  // crests. Drops the local roughness so the PBR specular lobe tightens
  // INTO sparkle bursts where the sun catches the surface — that's the
  // SoT-style glistening, realised entirely through the lighting model
  // rather than additive emissive.
  //
  // We deliberately do NOT stack a high-frequency per-pixel emissive on
  // top: that pin-prick layer alias-flickers as TV-static at any distance
  // the camera can't pixel-resolve the noise cell, and even tightly
  // distance-faded it reads as noise rather than glint on the close-in
  // band. The roughness modulation alone gives the wandering-glint
  // character without sampling a hash per fragment.
  //
  // Distance-fade the broad hash toward its mean (0.5) past ~35 m so the
  // sparkle patches stop firing/clearing at sub-pixel rates on the horizon
  // — past the fade window only the base roughness (and the Toksvig AA
  // boost below) decide the specular tightness.
  const broadSeed = positionWorld.xz.mul(0.18).add(vec2(tNode.mul(-0.11), tNode.mul(0.08)))
  const broadNoiseHash = fract(
    sin(broadSeed.x.mul(12.9898).add(broadSeed.y.mul(78.233))).mul(43758.5453),
  )
  const broadNoiseAA = float(1).sub(smoothstep(float(35), float(110), camDist))
  const broadNoise = mix(float(0.5), broadNoiseHash, broadNoiseAA)
  // Sparkle gate tightened — was (0.45, 0.85) which fired sparkle on
  // most upper-half wave faces and produced a "speckle storm" once the
  // larger-amplitude long swell came online. (0.70, 0.95) restricts
  // sparkle to the actual crest peaks, which is where catching glints
  // make narrative sense anyway. The hash threshold is also raised
  // (0.65) so only the rarer "bright" patches paint sparkle, not every
  // mid-tone hash cell.
  const sparkleHeightGate = smoothstep(float(0.7), float(0.95), heightNorm)
  const broadMask = smoothstep(float(0.65), float(0.9), broadNoise).mul(sparkleHeightGate)

  const mat = new MeshStandardNodeMaterial({
    transparent: true,
    // Water is a dielectric, so metalness must be 0 — F0 stays at the PBR
    // dielectric default (~0.04) and Schlick correctly drives specular
    // toward white at grazing angles. The previous 0.45 was blending F0
    // toward the deep-teal baseColor, which tinted near-zenith sun glints
    // a dark blue and made the surface look like blued steel from above.
    // From below the surface, ndotv was already clamped to 0 (Fresnel = 1),
    // so the wrong F0 was hidden — which is why the above-water view read
    // worse than the below-water view despite using the same material.
    metalness: 0,
    // roughness is now driven by `roughnessNode` below; this constant is the
    // base value (used when `roughnessNode` evaluates to 1.0 — i.e. away
    // from sparkle patches).
    roughness: 0.18,
    envMapIntensity: 0.9,
    // DoubleSide so the underside of the surface renders when the camera
    // dips below water. With the analytical normal pointing up regardless
    // of which face is drawn, ndotv is clamped to 0 from below — that's
    // intentional: it pegs Fresnel to 1 so the underside reads as a fully
    // reflective sky-tinted ceiling, the same effect Snell's-window views
    // produce in real underwater photography.
    side: THREE.DoubleSide,
  })
  mat.name = 'water'
  mat.positionNode = positionNode
  mat.normalNode = normalNode
  mat.colorNode = albedo
  // Foam needs a constant emissive lift. Real foam scatters sky light
  // independently of the direct sun, so it stays readably bright even
  // when the surface is in shadow (cliff side, behind a bike) — without
  // this, foam in shadowed shoreline reads as grey. Bumped from 0.28 →
  // 0.5 in the SoT-research pass: the original was meant to read
  // against the warm sunset haze but ended up too subtle even on
  // pinched breaking crests; foam should pop visibly bright since it's
  // the "this wave is actually breaking" signal a player relies on for
  // arcade water reads.
  //
  // Step 2: emit the *lit* foam colour (warm where the sun rakes) and add a
  // warm-rake bonus on top of the 0.5 base, so sun-struck crests glow brighter
  // and the bloom pass (post-pipeline) catches them as a warm sunset bloom —
  // the glowing crests of the concept frames. The base 0.5 keeps shadowed
  // foam readable; the bonus tops out at +0.5 on fully sun-raked crests.
  // Contour lines join at half weight — enough emissive lift to stay
  // readable in cliff shadow without blooming like a breaking crest.
  const foamEmissiveMask = max(
    max(foamMask, contourLight.mul(float(0.5))),
    riseStrokeLight.mul(float(0.5)),
  )
  const foamEmissive = foamColorLit
    .mul(foamEmissiveMask)
    .mul(float(0.5).add(foamWarmRake.mul(float(0.5))))

  // Crest-mist ribbon — a soft wind-spray haze lofted on the upper faces of
  // steep breaking crests, biased toward grazing view angles + distance where
  // the discrete crest-spray sprites (fx/index.ts `crestSpray` pool) read too
  // sparse to sell the break. Keyed off the same whitecap signal the foam
  // draws from (`whitecapFoam` = height × slope × fiber), so the haze appears
  // exactly where the surface is already whitecapping — no new wave math. The
  // grazing + distance weighting keeps it invisible looking straight down at
  // close range (where the sprites carry the effect) and fills the far field
  // toward the horizon. Tinted halfway to the horizon haze so it reads as
  // atmospheric spray rather than a second foam layer.
  const crestMistGrazing = pow(float(1).sub(ndotv), float(3.0))
  const crestMistDist = smoothstep(float(25), float(140), camDist)
  const crestMistAmount = whitecapFoam
    .mul(crestMistGrazing)
    .mul(crestMistDist)
    .mul(crestMistStrengthUniform)
    .mul(float(0.6))
  const crestMist = mix(foamColor, horizonHazeUniform, float(0.5)).mul(crestMistAmount)

  // Fade emissive contributions out when the debug colorize is on, so the
  // center mesh's red tint isn't washed out by foam / sun-disc highlights.
  const emissiveSum = fresnelEmissive
    .add(sunGlow)
    .add(sunDisc)
    .add(sunStreak)
    .add(foamEmissive)
    .add(crestMist)
  mat.emissiveNode = emissiveSum.mul(float(1).sub(debugColorizeMixUniform))
  // View-angle-dependent shallow-seabed transparency. Only applies in
  // shallow water where there's real terrain underneath — gated by
  // `depthValidGate` (no heightmap data → open ocean → stay fully
  // opaque, so the void past the heightmap edge never bleeds through).
  //
  // Downward views in shallow water resolve to alpha ≈ 0.42 so the
  // seabed reads clearly through the water without losing the water's
  // own colour layer; grazing samples lift toward 0.88 because the
  // view ray travels through a much longer column of water and the
  // body absorption + reflection should dominate at those angles.
  // The depth range extends out to ~11 m so the see-through effect
  // doesn't snap to opaque the moment the player skims out of the
  // ankle-deep band — terrain stays partially visible through honest
  // mid-depth water too. Foam stamps full opacity on top.
  const seabedSeeThrough = mix(float(0.42), float(0.88), float(1).sub(ndotv))
  // Use flat vertical water depth (same as Beer-Lambert) so the
  // shallow-seabed transparency doesn't band along wave isolines.
  const shallowSeabedRange = float(1).sub(smoothstep(float(3), float(11), waterDepthFrag))
  const shallowTransparency = depthValidGate.mul(shallowSeabedRange)
  const depthGatedAlpha = mix(float(0.98), seabedSeeThrough, shallowTransparency)
  // Center mesh edge fade. The center geometry is a hard 960 × 960 m
  // square — its outer ±480 m edge sits exactly where (looking forward
  // from bike POV) the horizon line begins. Without a fade, the
  // PBR-lit center hard-stops at that edge and the (basic-shaded,
  // dimmer, hazier) outer LOD tile begins, painting a visible
  // horizontal line a few pixels below the horizon — the "water ends
  // early" seam users notice most. Cross-blending the two over a
  // wider band (380–480 m) hides the geometric edge: as center
  // opacity ramps 1 → 0, the outer ramps 0 → 1 over the same band
  // (set further down at `outerOpacityNode`), so summed coverage
  // stays at 1 throughout and the shading character softens
  // continuously instead of switching abruptly.
  //
  // Width: 100 m spans enough vertical pixels near the horizon (where
  // pixel density per metre is highest) to read as a smooth gradient
  // rather than a band. Anchored on the OUTSIDE edge (480 m) so the
  // center's full-detail water stays solid through the inner 380 m.
  const centerBoxCoord = max(positionLocal.x.abs(), positionLocal.z.abs())
  const centerEdgeFade = float(1).sub(smoothstep(float(380), float(480), centerBoxCoord))
  mat.opacityNode = mix(depthGatedAlpha, float(0.98), foamMask).mul(centerEdgeFade)
  // Noise-modulated roughness. In sparkle patches roughness drops from 0.18
  // to ~0.04, tightening the specular lobe and producing crisp highlights.
  // Classic mode keeps the constant 0.18 so the A/B comparison is clean.
  // Both base + sparkle ends are uniforms so the debug menu can scrub them.
  //
  // Toksvig-style specular AA on top: fwidth(normalNode) reports how much
  // the normal swings per screen pixel. Where that's large — typically wave
  // crests projected at a glancing angle, where the wave's own slope flips
  // across a single pixel — the PBR specular lobe is wider than the normal
  // it's reflecting around, and the highlight aliases to single-pixel pin
  // pricks. Push roughness up proportionally so the lobe stays wider than
  // the screen-space normal variance, and the highlight smears into a
  // stable line of glints instead of flickering noise.
  //
  // 0.18 max boost is enough to fully shut down the worst-case sparkle
  // while leaving sub-pixel-stable areas untouched.
  {
    const normalScreenDelta = fwidth(normalNode).length()
    const aaBoost = smoothstep(float(0.05), float(0.5), normalScreenDelta).mul(float(0.18))
    const sparkleRough = mix(roughBaseUniform, roughSparkleUniform, broadMask)
    mat.roughnessNode = clamp(sparkleRough.add(aaBoost), float(0), float(1))
  }

  // Debug knob surface (water-debug-menu.ts talks to this). All setters
  // clamp inputs and apply to the relevant uniform / mesh state. The
  // amp scales also mutate `field.waves[i].amplitude` so the CPU
  // buoyancy sampler stays in lockstep with the GPU shader.
  const defaults: WaterDebugDefaults = {
    steepness: initialSteepness,
    // The shipped-look per-band scales — imported from wave-field.ts so
    // the spectrum generator (which pre-divides by them) can never drift
    // from what boot actually applies.
    swellScale: DEFAULT_SWELL_TUNING_SCALE,
    chopScale: DEFAULT_CHOP_TUNING_SCALE,
    timeScale: 0.85,
    reflectionStrength: REFLECTION_STRENGTH_DEFAULT,
    sunGlow: SUN_GLOW_DEFAULT,
    roughBase: ROUGH_BASE_DEFAULT,
    roughSparkle: ROUGH_SPARKLE_DEFAULT,
    detailStrength: DETAIL_STRENGTH_DEFAULT,
    bodyAbsorption: BODY_ABSORPTION_DEFAULT,
    sunDiscStrength: SUN_DISC_STRENGTH_DEFAULT,
    sunStreakStrength: SUN_STREAK_STRENGTH_DEFAULT,
    streakElongation: STREAK_ELONGATION_DEFAULT,
    shoreWaveStrength: SHORE_WAVE_STRENGTH_DEFAULT,
    shoalSurf: SHOAL_SURF_DEFAULT,
    splashRings: SPLASH_RING_STRENGTH_DEFAULT,
    contactFoam: CONTACT_FOAM_DEFAULT,
    pinchDirection: PINCH_DIRECTION_DEFAULT,
    whitecapCurvature: WHITECAP_CURVATURE_DEFAULT,
    whitecapLeadBias: WHITECAP_LEAD_BIAS_DEFAULT,
    whitecapHeight: WHITECAP_HEIGHT_START_DEFAULT,
    whitecapSlope: WHITECAP_SLOPE_START_DEFAULT,
    whitecapMode: WHITECAP_MODE_DEFAULT,
    foamWarmth: FOAM_WARMTH_DEFAULT,
    foamStreak: FOAM_STREAK_DEFAULT,
    foamBrush: FOAM_BRUSH_DEFAULT,
    foamWarp: FOAM_WARP_DEFAULT,
    langmuir: LANGMUIR_DEFAULT,
    wakeStrength: WAKE_STRENGTH_DEFAULT,
    rampStrength: RAMP_STRENGTH_DEFAULT,
    rampSteps: RAMP_STEPS_DEFAULT,
    rampPosterize: RAMP_POSTERIZE_DEFAULT,
    contourStrength: CONTOUR_STRENGTH_DEFAULT,
    contourSpacing: CONTOUR_SPACING_DEFAULT,
    contourRelief: CONTOUR_RELIEF_DEFAULT,
    contourBreakup: CONTOUR_BREAKUP_DEFAULT,
    contourCoherence: CONTOUR_COHERENCE_DEFAULT,
    contourCalmAtRest: CONTOUR_CALM_AT_REST_DEFAULT,
    contourGate: CONTOUR_GATE_DEFAULT,
    riseStroke: RISE_STROKE_DEFAULT,
    wireframe: wireFlag,
    colorize: false,
  }
  const clamp01 = (n: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo))
  function applySwellScale(s: number): void {
    // Upper bound 8× matches the Water debug menu's slider ceiling so
    // the player can push proper open-ocean rollers if they want. The
    // shader's Gerstner sum has been validated past 5× without crest
    // folding at the default steepness of 0.7; beyond ~6× expect some
    // tip-over on the largest swells.
    const v = clamp01(s, 0, 8)
    // Write the CPU field only; the shader reads this live via
    // `waveAmpUniform` (synced in tick()) — no separate GPU uniform.
    for (let i = 0; i < field.waves.length; i++) {
      if (SWELL_INDICES.has(i)) field.waves[i]!.amplitude = baseAmplitudes[i]! * v
    }
  }
  function applyChopScale(s: number): void {
    // Upper bound 6× — chop is shorter-wavelength so it folds earlier
    // than swell; this still permits a stormy surface without
    // sustained crest flips.
    const v = clamp01(s, 0, 6)
    for (let i = 0; i < field.waves.length; i++) {
      if (!SWELL_INDICES.has(i)) field.waves[i]!.amplitude = baseAmplitudes[i]! * v
    }
  }
  const debug: WaterMesh['debug'] = {
    defaults,
    setSteepness(s) {
      // The field owns steepness (the CPU buoyancy sampler reads it). The GPU
      // uniform is synced to the CLAMPED effective steepness here and in tick()
      // so both sides pinch by the same sub-folding amount.
      field.steepness = clamp01(s, 0, 1.5)
      steepnessUniform.value = effectiveSteepness(field)
    },
    setSwellScale: applySwellScale,
    setChopScale: applyChopScale,
    setTimeScale(s) {
      timeScale = clamp01(s, 0, 5)
    },
    getTimeScale: () => timeScale,
    setReflectionStrength(s) {
      reflStrengthUniform.value = clamp01(s, 0, 1)
    },
    setSunGlow(s) {
      sunGlowUniform.value = clamp01(s, 0, 3)
    },
    setRoughBase(s) {
      roughBaseUniform.value = clamp01(s, 0, 1)
    },
    setRoughSparkle(s) {
      roughSparkleUniform.value = clamp01(s, 0, 1)
    },
    setDetailStrength(s) {
      detailStrengthUniform.value = clamp01(s, 0, 2)
    },
    setBodyAbsorption(s) {
      // 0..3 — scales the per-channel Beer-Lambert sigmas. 1 =
      // calibrated default; lower → less absorption (water bodies
      // read brighter, seabed shows through deeper); higher →
      // more absorption (shallow water already reads deep).
      bodyAbsorptionUniform.value = clamp01(s, 0, 3)
    },
    setSunDiscStrength(s) {
      // 0..3 — scales the Karis sun-disc emissive.
      sunDiscStrengthUniform.value = clamp01(s, 0, 3)
    },
    setSunStreakStrength(s) {
      // 0..3 — scales the anisotropic wave-front streak emissive.
      sunStreakStrengthUniform.value = clamp01(s, 0, 3)
    },
    setStreakElongation(s) {
      // 0.1..1.5 — σ_along of the 2D Gaussian. Lower clamps
      // toward 0.1 (disc-like); higher elongates the streak.
      streakElongationUniform.value = clamp01(s, 0.1, 1.5)
    },
    setCrestMistStrength(s) {
      // 0..2 — scales the lofted crest-mist haze. 0 = off (whitecaps
      // still draw); 1 = default ribbon. The Settings "Wave spray" knob
      // passes 0 / 0.5 / 1 for off / subtle / full.
      crestMistStrengthUniform.value = clamp01(s, 0, 2)
    },
    setWhitecapCurvature(g) {
      // 0..12 — gain on the crest-curvature signal. Higher foams gentler
      // curvature (more coverage); lower restricts to the sharpest breaking
      // crests. The primary whitecap control (foam v3).
      whitecapCurvatureUniform.value = clamp01(g, 0, 12)
    },
    setWhitecapLeadBias(b) {
      // 0..1 — push the whitecap onto the rising/front (leading) face via ∂h/∂t.
      // 0 = symmetric crest line; 1 = front-only ("breaking forward").
      whitecapLeadBiasUniform.value = clamp01(b, 0, 1)
    },
    setWhitecapHeight(m) {
      // @deprecated legacy — no longer affects the wave whitecap (curvature
      // replaced it). Kept so persisted tuning still loads without throwing.
      whitecapHeightStartUniform.value = clamp01(m, 0, 3)
    },
    setWhitecapSlope(s) {
      // @deprecated legacy — no-op for the wave whitecap.
      whitecapSlopeStartUniform.value = clamp01(s, 0, 1)
    },
    setWhitecapMode(m) {
      // @deprecated legacy — no-op for the wave whitecap.
      whitecapModeUniform.value = clamp01(m, 0, 1)
    },
    setFoamWarmth(s) {
      // 0..2 — scales the light-driven warm foam tint + warm emissive bloom.
      // 0 = flat white foam (legacy); 1 = baseline; >1 = punchier sunset glow.
      foamWarmthUniform.value = clamp01(s, 0, 2)
    },
    setFoamStreak(s) {
      // 0..2 — scales the flow-aligned directional foam combing. 0 = isotropic
      // bubbles only (legacy); 1 = baseline streaks; >1 = deeper-cut stripes.
      foamStreakUniform.value = clamp01(s, 0, 2)
    },
    setFoamBrush(s) {
      // 0..1 — foam break-up pattern: disc bubbles (0) ↔ crest-parallel
      // oil-paint strokes (1).
      foamBrushUniform.value = clamp01(s, 0, 1)
    },
    setFoamWarp(s) {
      // 0..2 — along-crest wobble of the foam break-up sample coords.
      foamWarpUniform.value = clamp01(s, 0, 2)
    },
    setLangmuir(s) {
      // 0..1.5 — travel-aligned windrow lanes on calm water.
      langmuirUniform.value = clamp01(s, 0, 1.5)
    },
    setWakeStrength(s) {
      // 0..2 — trail-wake master strength (churn/rail foam AND ridge
      // displacement). 1 = baseline; 0 = no drawn wake. Render-only: the sim
      // wake buoyancy is untouched, so 0 leaves invisible-but-feelable
      // ridges — a dev/tuning setting, not a shippable look.
      wakeStrengthUniform.value = clamp01(s, 0, 2)
    },
    getWakeTrails() {
      // Read-through to the SIM's trails (field.trails) — the same points
      // this mesh uploads and buoyancy samples.
      const out: Array<{ id: number; count: number; headArc: number }> = []
      for (const tr of field.trails) {
        if (tr.count === 0) continue
        out.push({ id: tr.id, count: tr.count, headArc: tr.headArc })
      }
      return out
    },
    // P1 readability layers — all fragment-only uniforms, no rebuild.
    setRampStrength(s) {
      rampStrengthUniform.value = clamp01(s, 0, 1)
    },
    setRampSteps(n) {
      rampStepsUniform.value = clamp01(Math.round(n), 2, 5)
    },
    setRampPosterize(s) {
      rampPosterizeUniform.value = clamp01(s, 0, 1)
    },
    setContourStrength(s) {
      contourStrengthUniform.value = clamp01(s, 0, 1.5)
    },
    setContourSpacing(m) {
      contourSpacingUniform.value = clamp01(m, 0.2, 1.5)
    },
    setContourRelief(s) {
      contourReliefUniform.value = clamp01(s, 0, 1)
    },
    setContourBreakup(s) {
      contourBreakupUniform.value = clamp01(s, 0, 1)
    },
    setContourCoherence(s) {
      // Authored BASE — tick() blends it toward 1 by calmAtRest × rest
      // factor and writes the effective value to the uniform.
      contourCoherenceBase = clamp01(s, 0, 1)
    },
    getContourCoherence: () => contourCoherenceUniform.value,
    setContourCalmAtRest(s) {
      contourCalmAtRest = clamp01(s, 0, 1)
    },
    setContourGate(s) {
      contourGateUniform.value = clamp01(s, 0, 1)
    },
    setRiseStroke(s) {
      riseStrokeUniform.value = clamp01(s, 0, 2)
    },
    // P2.1 wave-set envelope — the field owns the params (CPU buoyancy reads
    // them via waveSetFactor); tick() mirrors them to the GPU uniforms.
    setSwellSetPeriod(s) {
      field.swellSetPeriodS = clamp01(s, 0, 180)
    },
    setSwellSetDepth(d) {
      // 0.6 cap: past that the trough phase of a set (factor 0.4) starts
      // reading as "the sea turned off", and the crest phase (1.6×) can
      // push high-Beaufort tracks into constant whitecap.
      field.swellSetDepth = clamp01(d, 0, 0.6)
    },
    getSwellSet() {
      return { periodS: field.swellSetPeriodS, depth: field.swellSetDepth }
    },
    setShoreWaveStrength(s) {
      // 0..2 — scales the shore-aligned breaker amplitude. Mirrors the
      // value onto the CPU field so buoyancy rides the same waves the
      // shader renders (same discipline as setWaveBearing).
      const v = clamp01(s, 0, 2)
      shoreWaveStrengthUniform.value = v
      field.shoreWaveStrength = v
    },
    setShoalSurf(s) {
      // 0..1 — legacy shallow-water kill-switch ↔ full shoaling-v2 surf.
      // Field + uniform from one scalar (the setSteepness discipline):
      // the factor changes BUOYANCY near shores, so the two sides must
      // never see different blends.
      const v = clamp01(s, 0, 1)
      shoalSurfUniform.value = v
      field.shoalSurfStrength = v
    },
    setSplashRings(s) {
      // 0..1.5 — landing event-wave strength, both sides from one scalar.
      const v = clamp01(s, 0, 1.5)
      splashRingStrengthUniform.value = v
      field.splashRingStrength = v
    },
    setContactFoam(s) {
      // 0..2 — obstacle collar + wash-ripple strength. Render-only shading
      // (contacts never displace), so scrubbing live is always safe.
      contactFoamStrengthUniform.value = clamp01(s, 0, 2)
    },
    setPinchDirection(deg) {
      // 0..90° — rotation of the Gerstner horizontal-displacement
      // vector from along-wave to across-wave. Pre-compute the
      // cos/sin once on slider drag so the GPU evaluates two
      // multiplies per wave rather than a trig pair per vertex.
      const v = clamp01(deg, 0, 90)
      pinchDirectionUniform.value = v
      const rad = (v * Math.PI) / 180
      pinchCosUniform.value = Math.cos(rad)
      pinchSinUniform.value = Math.sin(rad)
      // Mirror onto the field so CPU buoyancy pinches in the same direction.
      field.pinchCos = Math.cos(rad)
      field.pinchSin = Math.sin(rad)
    },
    setWaveBearing(deg) {
      // -180..180° — rotate the whole wave field. Updates the
      // CPU-side field.waveBearing (so sampleSurface/sampleHeight
      // see it for buoyancy) AND the GPU deg uniform (the vertex
      // stage derives its effective cos/sin from it per vertex via
      // `waveZoneFactors`, so zones can override the bearing
      // locally). The two paths recompute their rotations from the
      // same scalar, so they stay locked.
      const v = clamp01(deg, -180, 180)
      waveBearingDegUniform.value = v
      field.waveBearing = (v * Math.PI) / 180
    },
    getWaveBearing() {
      return waveBearingDegUniform.value as number
    },
    setWireframe(on) {
      mat.wireframe = !!on
      outerMat.wireframe = !!on
    },
    setColorize(on) {
      debugColorizeMixUniform.value = on ? 1 : 0
    },
    setWaterVisible(on) {
      mesh.visible = on
    },
    setReflectionFullScene(on) {
      const base = reflectorBase()
      if (!base) return
      for (const cam of reflectionCulledCams) {
        const vc = base.getVirtualCamera(cam) as THREE.Camera
        if (on) vc.layers.enableAll()
        else vc.layers.set(WATER_REFLECTION_LAYER)
      }
    },
  }

  // Debug: ?wire=1 renders the water mesh as wireframe so you can see
  // the actual vertex displacement (vs. just shaded color). Useful when
  // tuning the wake / dimple / wave amplitudes — turn it on, drive the
  // bike, see the actual ridges in the geometry.
  if (typeof window !== 'undefined') {
    if (wireFlag) {
      mat.wireframe = true
      mat.transparent = false
      mat.opacityNode = float(1)
      // The outer LOD tile's wireframe is mirrored after it's constructed
      // below — `outerMat` doesn't exist yet at this point.
    }
    // Live tuning hook for playtest: in the dev console, call
    //   __waterSteepness(0.9)
    // to scrub the global Q multiplier without reloading. Returns the
    // clamped value actually applied. 0 = vertical-only blobs, 0.7 = SoT
    // default, 1+ = ridge-y / chop-heavy. Past ~1.3 the sum may form loops
    // (vertices crossing) — visually jagged but not crashing.
    // biome-ignore lint/suspicious/noExplicitAny: dev-only debug hook
    ;(window as any).__waterSteepness = (s: number) => {
      debug.setSteepness(s)
      return steepnessUniform.value
    }
    // Sub-Gerstner detail-normal strength. 0 = bypass detail (analytic-only),
    // 1 = default cascade contribution, 2 = punchy / overdriven for tuning.
    // biome-ignore lint/suspicious/noExplicitAny: dev-only debug hook
    ;(window as any).__waterDetail = (s: number) => {
      debug.setDetailStrength(s)
      return detailStrengthUniform.value
    }
  }

  const mesh = new THREE.Mesh(geom, mat as unknown as THREE.Material)
  mesh.name = 'water'
  mesh.position.y = 0
  // Receive shadows from bikes / props / terrain. The node-material's
  // colorNode is treated as albedo by the standard lighting model, so
  // shadow attenuation darkens the deep-blue/cyan diffuse while the
  // emissiveNode (sun glow, fresnel sky tint, foam, sparkle) stays
  // bright — highlights still pop in shadow. We deliberately don't set
  // `castShadow` on water: bumpy wave normals would alias the shadow
  // map and self-shadow ugly.
  mesh.receiveShadow = true

  // Reflector target: the Object3D that anchors the mirror plane. Its
  // local +Z axis is the plane normal, so we rotate -90° around X to
  // align local +Z with world +Y for a horizontal water mirror. Parented
  // to the (camera-locked) water mesh — the plane reference position
  // moves in X/Z but reflection across an infinite horizontal plane is
  // independent of the in-plane offset, so the math still holds. Without
  // this wiring the reflector falls back to `_defaultRT` (a 1x1 cleared
  // texture) and renders nothing.
  if (reflectorTarget) {
    reflectorTarget.rotation.x = -Math.PI / 2
    mesh.add(reflectorTarget)
  }

  // Pre-water depth snapshot. Three.js calls `onBeforeRender` per object
  // right before its draw is encoded — by the time water (transparent)
  // gets here, all opaques have been encoded into the same pass, so a
  // copy of the framebuffer's depth attachment at this point captures
  // post-opaque depth. `copyFramebufferToTexture` ends the active render
  // pass on the encoder, copies the depth, then begins a new pass with
  // `loadOp = Load` so the depth values survive. The shoreline foam in the
  // shader samples `sceneDepthTexture` at `screenUV` and compares to the
  // water fragment's view-Z; without this manual snapshot, the equivalent
  // `viewportDepthTexture()` helper captures a cleared depth buffer too
  // early in the frame and the comparison reads the scene as "all at the
  // far plane" — no foam ever fires.
  const _sceneDepthSize = new THREE.Vector2()
  mesh.onBeforeRender = (renderer) => {
    if (disableSceneDepthCopy) return
    // biome-ignore lint/suspicious/noExplicitAny: WebGPURenderer cast
    const r = renderer as any
    r.getDrawingBufferSize(_sceneDepthSize)
    const w = _sceneDepthSize.x | 0
    const h = _sceneDepthSize.y | 0
    if (w <= 0 || h <= 0) return
    if (sceneDepthTexture.image.width !== w || sceneDepthTexture.image.height !== h) {
      sceneDepthTexture.image.width = w
      sceneDepthTexture.image.height = h
      sceneDepthTexture.needsUpdate = true
    }
    if (typeof r.copyFramebufferToTexture === 'function') {
      r.copyFramebufferToTexture(sceneDepthTexture)
    }
  }

  // ── Outer LOD tile ──────────────────────────────────────────────────────
  // Lower-detail wave plane extending past the center mesh's reach, so the
  // visible wave geometry covers ~720 m to the sides (vs. 480 m on the
  // center alone). Pushes the boundary between displaced water and the
  // flat skirt well past the player's tilt-down view — at 720 m the seam
  // is also at ~13 % fog density on the way to dissolving into sky.
  //
  // Shares the wave-field uniforms (amplitudes, frequencies, time,
  // bearing, mesh origin, horizon haze) with the center mesh because the
  // material is built inside the same closure; both meshes animate in
  // lock-step with zero per-frame CPU pushes.
  //
  // Drops the expensive bits of the center shader:
  //  - planar reflection (one full-screen mirror pass — biggest single
  //    cost on the water; redundant at 280 m+ where the ripple detail
  //    that mirrors carry is already sub-pixel),
  //  - bike-wake displacement (the wake decays well within 40 m so it
  //    contributes nothing meaningful out here, and skipping the per-
  //    bike convolution saves both ALU and uniform bandwidth),
  //  - sub-Gerstner detail-normal cascades (texture samples; the chop
  //    they add is sub-pixel at this distance),
  //  - foam, caustics, sun-streak, sun-disc — all sub-pixel detail at
  //    the outer mesh's view range.
  //
  // Sun shading is reduced to a single ndotL term computed off the
  // analytic Gerstner normal — cheap, enough to keep wave silhouettes
  // legible without falling back to a flat-tinted plane that reads as
  // a stuck texture.
  //
  // Render order: outer (-1) sits under the center mesh (0, default) and
  // above the skirt (-2). Where the center overlaps the outer the
  // center's full-detail shading wins on top; where only the outer
  // overlaps the skirt the outer's wavy geometry wins; past the outer's
  // square footprint the skirt is the last reader before fog.
  //
  // Geometry: 1440 m × 1440 m at 256² subs ≈ 5.6 m / vertex. That's
  // coarse compared to the center's 0.6 m / vertex but it resolves the
  // long-period swells, which is all that reads at 300 m+ distance —
  // and all this tile SUMS: the outer evaluates the swell-only Gerstner
  // subset (P2.2). The chop bands (λ < 30 m) are sub-pixel out here and
  // under-sampled by the 5.6 m grid (alias shimmer, not detail), and at
  // the 380→480 m cross-fade band the center's chop amplitude (≤ 0.22 m)
  // is well under a pixel, so the blend can't show the difference. The
  // wake's 4 m wavelength was never drawn on this tile. ~66 k verts:
  // roughly 1/9th of the center mesh, so the outer's vertex pass adds
  // well under a millisecond on any real GPU — and stays flat as
  // per-track spectrum banks (spectrum.ts) grow the chop count.
  const OUTER_SIZE = 1440
  const OUTER_SUBS = 256

  const outerGeom = new THREE.PlaneGeometry(OUTER_SIZE, OUTER_SIZE, OUTER_SUBS, OUTER_SUBS)
  outerGeom.rotateX(-Math.PI / 2)

  // The outer mesh is a child of the (camera-locked) center mesh, so its
  // local origin coincides with the center's `meshOrigin{X,Z}` snap. Same
  // formula as the center's `worldX/worldZ` — the Gerstner sum samples
  // world coordinates so phase stays continuous across the outer/center
  // boundary regardless of how the camera moves.
  const outerWorldX = positionLocal.x.add(meshOriginX)
  const outerWorldZ = positionLocal.z.add(meshOriginZ)
  // Same per-vertex zone factors as the center mesh — a zone reaching into
  // the 380→480 m cross-fade band (or a surge lifting a whole region) must
  // displace both layers identically or the blend shows a phase seam.
  const outerZoneFx = waveZoneFactors(outerWorldX, outerWorldZ, tNode)
  const outerZoneCosB = cos(outerZoneFx.z)
  const outerZoneSinB = sin(outerZoneFx.z)
  // Same zone × set-envelope amplitude slot as the center mesh — an
  // envelope swelling the center but not the outer would show as a
  // breathing seam at the 380→480 m cross-fade band.
  const outerHeightMult = outerZoneFx.x.mul(setEnvNode)
  const outerGerst = gerstnerSwellHeight(
    outerWorldX,
    outerWorldZ,
    tNode,
    outerHeightMult,
    outerZoneFx.y,
    outerZoneCosB,
    outerZoneSinB,
  )
  const outerDispVec = gerstnerSwellDisp(
    outerWorldX,
    outerWorldZ,
    tNode,
    outerHeightMult,
    outerZoneFx.y,
    outerZoneCosB,
    outerZoneSinB,
  )

  // Position: Gerstner vertical + horizontal pinch, no shoaling
  // attenuation (the shoaling sample would return DEEP_SENTINEL at most
  // outer-tile positions anyway since the heightmap doesn't extend out
  // this far) and no bike-wake contribution. Zone surge rides on top,
  // same as the center mesh.
  const outerPositionNode = vec3(
    positionLocal.x.add(outerDispVec.x),
    outerGerst.x.add(outerZoneFx.w),
    positionLocal.z.add(outerDispVec.y),
  )

  // Camera-relative distance (radial, XZ-only) for aerial perspective.
  const outerCamDist = positionLocal.xz.length()

  // Aerial-perspective ramp: matches the center mesh's `aerialMix` cap
  // of 0.25 at 280 m so the colour is continuous where they meet, and
  // holds across the rest of the outer's extent. Scene fog handles the
  // remainder of the dissolve into sky past the outer's far rim.
  const outerAerialMix = clamp(
    smoothstep(float(120), float(280), outerCamDist).mul(float(0.25)),
    float(0),
    float(1),
  )

  // Subtle directional shading off the analytic Gerstner normal so the
  // outer reads as a lit surface rather than a stuck texture. ndotL on
  // a flat plane is sin(sunElev); the displacement modulates around
  // that so crests facing the sun pick up a touch more brightness than
  // troughs. Pulled in tight (0.85..1.0) so the outer never reads as
  // dramatically darker than the haze it dissolves into.
  const outerNormal = vec3(outerGerst.y.negate(), float(1), outerGerst.z.negate()).normalize()
  const outerNdotL = max(dot(outerNormal, sunDirUniform), float(0))
  const outerShade = float(0.85).add(outerNdotL.mul(float(0.15)))

  // Body colour: anchored on the same deep-trough colour the center
  // shader and the skirt both use, with a height-driven scatter lift on
  // crests. Same `vec3(0.02, 0.22, 0.32)` / `vec3(0.22, 0.85, 0.92)`
  // pair as the center.
  //
  // Scatter cap raised from 0.4 → 0.6 so crests aren't artificially
  // dimmer than the center's: at the cross-fade boundary the eye was
  // catching the brightness step (center's reflection-lit crests vs
  // outer's clamped-dim ones) as a tonal seam.
  const outerHeightVary = varying(outerGerst.x)
  const outerHeightFactor = smoothstep(float(-1.5), float(1.5), outerHeightVary)
  const outerDeep = vec3(0.02, 0.22, 0.32)
  const outerScatter = vec3(0.22, 0.85, 0.92)
  const outerBody = mix(outerDeep, outerScatter, outerHeightFactor.mul(float(0.6))).mul(outerShade)

  // Schlick fresnel toward the sky's horizon haze at grazing. We
  // intentionally do NOT sample the center mesh's `reflectionRgb`
  // node here even though it would paint a more faithful sky-tint:
  // ReflectorNode hides only ONE owner material during its mirror
  // render pass (via `material.visible = false`), so if outer/skirt
  // also reference the reflector texture, they stay visible while the
  // mirror RT is being WRITTEN — and they sample from it in the same
  // pass. That's a read-write hazard on the texture in WebGPU and
  // nukes the whole frame to black. Horizon-haze stand-in only.
  //
  // Same distance fade the center uses — by 500 m the contribution is
  // gone and the outer reads as pure outerBody. Keeps the cross-fade
  // band (380 → 480 m) shading-continuous with the center as both
  // ramp grazing-tint down together.
  const outerViewDir = normalize(cameraPosition.sub(positionWorld))
  const outerNdotV = max(dot(outerNormal, outerViewDir), float(0))
  const outerFresnel = pow(float(1).sub(outerNdotV), float(5))
  const outerReflFade = float(1).sub(smoothstep(float(200), float(500), outerCamDist))
  const outerSurfaceLit = mix(
    outerBody,
    horizonHazeUniform,
    outerFresnel.mul(outerReflFade).mul(float(0.4)),
  )

  const outerColorNode = mix(
    mix(outerSurfaceLit, horizonHazeUniform, outerAerialMix),
    outerDebugColorUniform,
    debugColorizeMixUniform,
  )

  // Hide the outer tile inside the center mesh's 960 m × 960 m footprint
  // and cross-fade with the center across its outer edge. The center is
  // a child plane at the same origin (parented through `mesh`), so both
  // meshes' `positionLocal` share the same camera-locked frame: the
  // center covers |x| ≤ 480, |z| ≤ 480. The 380→480 m fade-in window
  // mirrors the center's `centerEdgeFade` (set above) — as the center
  // ramps 1 → 0 across that band, the outer ramps 0 → 1, so summed
  // coverage stays at 1 and the eye sees a continuous tone shift from
  // PBR-lit center water to basic-shaded outer water rather than a hard
  // horizontal edge a few pixels below the horizon line.
  const outerBoxCoord = max(positionLocal.x.abs(), positionLocal.z.abs())
  const outerOpacityNode = smoothstep(float(380), float(480), outerBoxCoord)

  const outerMat = new MeshBasicNodeMaterial({
    // Scene fog still applies — between the outer's far rim (≈720 m
    // cardinal, ≈1018 m diagonal) and the fog-far at 2200 m the linear
    // ramp eats whatever tone mismatch survives the aerial-perspective
    // blend, so the outer dissolves into the same sky the horizon ring
    // and skirt dissolve into.
    fog: true,
    side: THREE.FrontSide,
    // See the `outerOpacityNode` comment above — transparent + depthWrite
    // off so the outer never wins a depth test against the higher-detail
    // center mesh in the overlap zone.
    transparent: true,
    depthWrite: false,
  })
  outerMat.name = 'water-outer'
  outerMat.positionNode = outerPositionNode
  outerMat.colorNode = outerColorNode
  outerMat.opacityNode = outerOpacityNode

  const outerMesh = new THREE.Mesh(outerGeom, outerMat as unknown as THREE.Material)
  outerMesh.name = 'water-outer'
  outerMesh.frustumCulled = false
  outerMesh.castShadow = false
  // The sun's shadow cascade is sized ±90 m around the player; at 720 m
  // out, the outer tile is well past anything that could cast a shadow
  // on it. Skip the cascade sample entirely.
  outerMesh.receiveShadow = false
  // Renders in the transparent pass (we made the material transparent so
  // it can fade out inside the center's footprint). Sits between the
  // skirt (-2) and the center (default 0) so back-to-front blending
  // produces skirt → outer → center in the donut where all three
  // overlap, and outer → center where only those two do.
  outerMesh.renderOrder = -1
  mesh.add(outerMesh)

  // Mirror the boot-time `?wire=1` wireframe state set on the center
  // material above. Live toggles via `debug.setWireframe` already update
  // both materials.
  if (wireFlag) outerMat.wireframe = true

  // ── Horizon skirt ──────────────────────────────────────────────────────
  // The main wave plane is 960 m square (camera-locked, ~480 m visible to
  // the sides, ~680 m at the corners). The horizon ring sits at ~1.4 km.
  // Without anything between them, the player sees a visible donut of sky
  // between the water plane's edge and the horizon — i.e. the water
  // bounds are obvious.
  //
  // The skirt is a flat ring extending from inside the main plane out past
  // the horizon ring. It's a child of the main mesh so it inherits the
  // camera-locked XZ and the track's water-height Y automatically.
  // Material is dirt-cheap: a haze-tinted unlit shader. No displacement,
  // no reflection, no foam — at this distance the main plane's wave
  // detail is already sub-pixel and the player's eye reads the skirt as
  // "more water out to the horizon", not as a separate object.
  //
  // The fragment shader anchors on the same `deepColor` the wave mesh
  // uses for its troughs so the skirt reads as water (not sky) across
  // most of its extent — wide-angle views of the wave plane are
  // trough-dominated, so matching that tone hides the boundary between
  // displaced geometry and the flat skirt. The far rim ramps into the
  // sky's `horizonHazeUniform` for aerial perspective; scene fog then
  // dissolves the outermost band into the sky just like everything else.
  // Alpha ramps in over the inner edge so any tiny tonal mismatch under
  // the main plane is hidden by the main plane drawing on top.
  const SKIRT_INNER_RADIUS = 120 // m — well inside the 480 m plane half-extent
  const SKIRT_OUTER_RADIUS = 1600 // m — past the default 1400 m horizon ring
  const SKIRT_ANGULAR_SEGMENTS = 128
  // Radial subdivisions: 192 → ≈ 7.7 m between vertices across the
  // 1480 m radial span. Carries the 25–50 m long-wavelength swells
  // with ≥ 3 verts/crest, which is what reads at the skirt's distance
  // (the shorter 5.5 m chop is sub-pixel past ~600 m anyway). Up from
  // a flat 16-segment ring; the Gerstner displacement set on
  // `skirtMat.positionNode` below has nothing to interpolate without
  // this denser tessellation. 192 × 128 ≈ 25 k verts — trivial.
  const SKIRT_RADIAL_SEGMENTS = 192
  const skirtGeom = new THREE.RingGeometry(
    SKIRT_INNER_RADIUS,
    SKIRT_OUTER_RADIUS,
    SKIRT_ANGULAR_SEGMENTS,
    SKIRT_RADIAL_SEGMENTS,
  )
  skirtGeom.rotateX(-Math.PI / 2)

  const skirtMat = new MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
    fog: true, // dissolves into the sky at the far rim, same as the horizon ring
    transparent: true,
    depthWrite: false,
  })
  skirtMat.name = 'water-skirt'
  {
    // Distance from camera in world XZ. The skirt is camera-locked (it's
    // a child of `mesh`), so positionLocal.xz is exactly the radial
    // offset from the camera's XZ — no need to round-trip through
    // positionWorld / cameraPosition.
    const radial = positionLocal.xz.length()
    // Inner alpha ramp: 0 at the inner edge → 1 by 240 m, well inside
    // the 480 m plane half-extent. Picking 240 m (rather than the new
    // 480 m side-edge or the 680 m corner) means the skirt is fully
    // opaque long before the center→outer cross-blend band starts at
    // 380 m — without that head room, the band's reduced layer alpha
    // would let sky-clear leak through if the skirt were still
    // ramping in. The plane is fully opaque on top inside 380 m so
    // the early-opaque skirt doesn't tonally compete in the inner
    // region.
    const innerFadeIn = smoothstep(float(SKIRT_INNER_RADIUS), float(240), radial)
    // Aerial-perspective ramp — mirrors the main plane's `aerialMix`
    // cap of 0.25 so the tone is continuous across the wave-plane
    // boundary. Scene fog (linear 500 → 2200 m) handles the rest of
    // the dissolve into sky at the far rim.
    const hazeMix = smoothstep(float(120), float(280), radial).mul(float(0.25))
    // Gerstner displacement on the skirt. Without it the skirt reads
    // as a flat painted ring — even at long range the eye picks up
    // "no waves here = not water" against the center mesh's displaced
    // surface. The shared gerstnerHeight call samples the SAME world
    // coords / time / amplitudes the center + outer meshes use, so
    // the wave phase stays continuous across all three layers (no
    // visible "wave train jumps direction" at the skirt boundary).
    // Skip the horizontal pinch — at this distance the sub-degree
    // crest sharpening is sub-pixel, and dropping the dispersion
    // sample halves the shader cost on the skirt.
    const skirtWorldX = positionLocal.x.add(meshOriginX)
    const skirtWorldZ = positionLocal.z.add(meshOriginZ)
    // Zone factors + surge for phase continuity with the center/outer
    // layers, same as the outer tile above (a large zone or surge can
    // reach the skirt's inner band).
    const skirtZoneFx = waveZoneFactors(skirtWorldX, skirtWorldZ, tNode)
    // Swell-only sum (P2.2) — chop is sub-pixel everywhere the skirt is
    // visible (720 m+), and the swell subset keeps the skirt's vertex
    // cost flat as per-track spectrum banks grow the chop count.
    const skirtGerst = gerstnerSwellHeight(
      skirtWorldX,
      skirtWorldZ,
      tNode,
      // Zone × set envelope, matching the center + outer layers.
      skirtZoneFx.x.mul(setEnvNode),
      skirtZoneFx.y,
      cos(skirtZoneFx.z),
      sin(skirtZoneFx.z),
    )
    skirtMat.positionNode = vec3(positionLocal.x, skirtGerst.x.add(skirtZoneFx.w), positionLocal.z)

    // Anchor on the wave mesh's deep trough colour, then lift toward
    // horizon haze at grazing via Schlick fresnel. We intentionally
    // do NOT sample the center mesh's `reflectionRgb` reflector node
    // here — see the matching note on `outerSurfaceLit` for why
    // sharing the RT across multiple materials breaks WebGPU.
    //
    // Same distance fade as the center / outer. The skirt sits
    // entirely past 480 m so its `radial` is always ≥ 480, fade is
    // already at zero, and the skirt stays at skirtDeepColor anyway.
    // Left in for symmetry with the other layers + so a future
    // SKIRT_INNER_RADIUS shrink still does the right thing.
    const skirtDeepColor = vec3(0.02, 0.22, 0.32)
    const skirtNormal = vec3(skirtGerst.y.negate(), float(1), skirtGerst.z.negate()).normalize()
    const skirtViewDir = normalize(cameraPosition.sub(positionWorld))
    const skirtNdotV = max(dot(skirtNormal, skirtViewDir), float(0))
    const skirtFresnel = pow(float(1).sub(skirtNdotV), float(5))
    const skirtReflFade = float(1).sub(smoothstep(float(200), float(500), radial))
    const skirtSurfaceLit = mix(
      skirtDeepColor,
      horizonHazeUniform,
      skirtFresnel.mul(skirtReflFade).mul(float(0.4)),
    )
    skirtMat.colorNode = mix(
      mix(skirtSurfaceLit, horizonHazeUniform, hazeMix),
      skirtDebugColorUniform,
      debugColorizeMixUniform,
    )
    skirtMat.opacityNode = innerFadeIn
  }

  const skirtMesh = new THREE.Mesh(skirtGeom, skirtMat as unknown as THREE.Material)
  skirtMesh.name = 'water-skirt'
  skirtMesh.frustumCulled = false
  skirtMesh.castShadow = false
  skirtMesh.receiveShadow = false
  // Sits below both the center mesh (default 0) and the outer LOD tile
  // (-1) in draw order, so it's the back-most water layer and only
  // shows in the donut past the outer tile's square footprint (~720 m
  // cardinal, ~1018 m diagonal). The outer is opaque + writes depth, so
  // the skirt's transparent fragments behind it are correctly culled.
  skirtMesh.renderOrder = -2
  mesh.add(skirtMesh)

  // Mirror `field.zones` into the GPU zone uniform arrays. `setWaveZones`
  // replaces the array wholesale (and is the only writer), so a reference
  // check per frame is enough — no per-frame repack. Zones with
  // blendRadiusM ≤ 0 are skipped: the CPU's `zoneWeight` returns 0
  // everywhere for them (`outsideDist >= blendRadiusM` holds even at
  // distance 0 inside the box), so dropping them mirrors the CPU exactly
  // and keeps the shader free of divide-by-zero guards. The sim already
  // caps the list at MAX_WAVE_ZONES; the slice here is belt-and-braces.
  let lastUploadedZones: readonly WaveZoneRuntime[] | null = null
  function syncWaveZones(): void {
    if (field.zones === lastUploadedZones) return
    lastUploadedZones = field.zones
    let n = 0
    for (const z of field.zones) {
      if (n >= MAX_WAVE_ZONES) break
      if (z.blendRadiusM <= 0) continue
      waveZoneSlotsA[n]!.set(z.position.x, z.position.z, z._cosYaw, z._sinYaw)
      waveZoneSlotsB[n]!.set(z.halfWidth, z.halfDepth, z.blendRadiusM, z.heightMult)
      const hasDir = z.directionDeg !== undefined
      const hasSurge = z.surgePeriodS !== undefined && z.surgeAmplitude !== undefined
      waveZoneSlotsC[n]!.set(
        z.freqMult,
        hasDir ? (z.directionDeg! * Math.PI) / 180 : 0,
        hasDir ? 1 : 0,
        hasSurge ? (2 * Math.PI) / z.surgePeriodS! : 0,
      )
      waveZoneSurgeAmps[n] = hasSurge ? z.surgeAmplitude! : 0
      n++
    }
    waveZoneCountUniform.value = n
  }

  function tick(impacts?: readonly BikeImpact[], originXZ?: { x: number; z: number }): void {
    tNode.value = field.time
    // Mirror the live per-wave amplitudes into the GPU uniform so the
    // rendered surface tracks whatever mutated `field.waves` this frame
    // (per-track Beaufort, the per-lap storm ramp, the debug menu). Buoyancy
    // reads the same `field.waves`, so visuals and physics stay locked.
    for (let i = 0; i < liveWaveAmps.length; i++) {
      liveWaveAmps[i] = field.waves[i]!.amplitude
    }
    // Per-track wave zones + stamps — re-uploaded only on list change.
    syncWaveZones()
    syncWaveStamps()
    // Splash rings — re-uploaded every tick (the pool mutates in place).
    syncSplashRings()
    // Waterline contact collars — nearest-N selection follows the
    // camera-locked mesh origin (re-picked on 12 m moves / list swaps).
    // Originless callers (editor) select around the world origin, which is
    // moot anyway: no environment GLB → no contacts.
    syncWaterContacts(originXZ?.x ?? 0, originXZ?.z ?? 0)
    // Keep the GPU steepness at the CLAMPED effective value — it depends on the
    // live amplitudes that Beaufort / lap-weather / the menu mutate. The CPU
    // buoyancy sampler clamps identically, so render + physics pinch the same.
    steepnessUniform.value = effectiveSteepness(field)
    // Wave-set envelope params — field-owned (the CPU sampler reads them
    // via waveSetFactor), mirrored every frame like the amplitudes so the
    // two sides can never disagree on the set rhythm. Omega pre-derived;
    // depth gated to 0 for an unset/invalid period (matches the CPU's
    // early-out in waveSetFactor).
    const setOn = field.swellSetPeriodS > 0 && field.swellSetDepth > 0
    swellSetOmegaUniform.value = setOn ? (2 * Math.PI) / field.swellSetPeriodS : 0
    swellSetDepthUniform.value = setOn ? field.swellSetDepth : 0
    swellSetPhaseUniform.value = field.swellSetPhase
    // Sync the world water-surface Y from the mesh so the shoaling /
    // surf shader reads the right "what's the sea level" value even
    // when callers mutate `mesh.position.y` directly (e.g. tracks with
    // a non-zero `water.height`). Cheap scalar copy per frame.
    waterYUniform.value = mesh.position.y
    if (originXZ) {
      // Snap to integer-meter grid so the mesh doesn't crawl under high-
      // frequency camera jitter — keeps wave phase visually stable when
      // the camera bobbles by < 1 m. The shader still samples world
      // coords so larger camera moves slide the mesh smoothly.
      const ox = Math.round(originXZ.x)
      const oz = Math.round(originXZ.z)
      meshOriginX.value = ox
      meshOriginZ.value = oz
      mesh.position.x = ox
      mesh.position.z = oz
    }
    // Speed-coupled contour calm (see CONTOUR_CALM_AT_REST_DEFAULT).
    // Observer speed = raw (un-snapped) origin delta over wall time — the
    // origin IS the camera in every gameplay mode, and it's the observer's
    // motion that masks (or exposes) the iso-line slide. Originless scenes
    // (?waterlab, ?waveriders, editor) decay to rest, which is the calm
    // endpoint they want anyway.
    {
      const nowMs = performance.now()
      const rawX = originXZ?.x ?? 0
      const rawZ = originXZ?.z ?? 0
      if (observerPrevMs !== null && observerPrevX !== null && observerPrevZ !== null) {
        const dtS = Math.min(Math.max((nowMs - observerPrevMs) / 1000, 1e-3), 0.25)
        const inst = Math.min(
          Math.hypot(rawX - observerPrevX, rawZ - observerPrevZ) / dtS,
          CALM_SPEED_MAX,
        )
        const alpha = 1 - Math.exp(-dtS / CALM_SPEED_TAU)
        observerSpeedSmoothed += (inst - observerSpeedSmoothed) * alpha
      }
      observerPrevX = rawX
      observerPrevZ = rawZ
      observerPrevMs = nowMs
      const t = Math.min(
        Math.max((observerSpeedSmoothed - CALM_SPEED_LO) / (CALM_SPEED_HI - CALM_SPEED_LO), 0),
        1,
      )
      const speedFactor = t * t * (3 - 2 * t)
      const calmDrive = contourCalmAtRest * (1 - speedFactor)
      contourCoherenceUniform.value = contourCoherenceBase + (1 - contourCoherenceBase) * calmDrive
    }
    for (let i = 0; i < MAX_BIKES; i++) {
      const slot = bikeSlots[i]!
      const im = impacts?.[i]
      if (im && im.weight > 0.05) {
        slot.set(im.x, im.z, im.vx, im.vz)
        bikeWeights[i] = im.weight
      } else {
        slot.set(INACTIVE_FAR, INACTIVE_FAR, 0, 0)
        bikeWeights[i] = 0
      }
    }

    // ---- Wake trails: upload the SIM's `field.trails` into the uniform
    // blocks. The sim owns the recording (wakeUpdateSystem feeds the trails
    // per fixed step; buoyancy samples the same points), so this is a pure
    // copy — no render-side trail state to drift. History right-aligns
    // against INACTIVE_FAR left-padding (those segments fail the shader's
    // MAX_SEG gate); the last slot is the live head. Fully age-faded trails
    // (abandoned bikes, modes that never feed) park their cull circle so
    // they cost one dead compare per vertex/fragment.
    const trailCount = Math.min(field.trails.length, MAX_WAKE_TRAILS)
    for (let i = 0; i < MAX_WAKE_TRAILS; i++) {
      const tr = i < trailCount ? field.trails[i] : undefined
      const blockBase = i * WAKE_TRAIL_POINTS
      const histSlots = WAKE_TRAIL_POINTS - 1
      const dead = !tr || tr.count === 0 || field.time - tr.headT > WAKE_AGE_TAU * 5
      const pad = tr ? histSlots - tr.count : histSlots
      for (let j = 0; j < histSlots; j++) {
        const slot = wakeTrailSlots[blockBase + j]!
        if (dead || j < pad) {
          slot.set(INACTIVE_FAR, INACTIVE_FAR, 0, 0)
          wakeTrailStrengths[blockBase + j] = 0
        } else {
          const src = j - pad
          slot.set(tr!.px[src]!, tr!.pz[src]!, tr!.arc[src]!, tr!.dropT[src]!)
          wakeTrailStrengths[blockBase + j] = tr!.str[src]!
        }
      }
      const headSlot = wakeTrailSlots[blockBase + histSlots]!
      const cullSlot = wakeTrailCulls[i]!
      if (dead) {
        headSlot.set(INACTIVE_FAR, INACTIVE_FAR, 0, 0)
        wakeTrailStrengths[blockBase + histSlots] = 0
        cullSlot.set(INACTIVE_FAR, INACTIVE_FAR, 0, 0)
        continue
      }
      headSlot.set(tr!.headX, tr!.headZ, tr!.headArc, tr!.headT)
      wakeTrailStrengths[blockBase + histSlots] = tr!.headStr
      // Cull circle fit over the live span, padded by the widest possible
      // lateral reach (V half-width at the tail + edge bell + rail blur).
      const cx = (tr!.px[0]! + tr!.headX) * 0.5
      const cz = (tr!.pz[0]! + tr!.headZ) * 0.5
      let r = Math.hypot(tr!.headX - cx, tr!.headZ - cz)
      for (let j = 0; j < tr!.count; j++) {
        const dj = Math.hypot(tr!.px[j]! - cx, tr!.pz[j]! - cz)
        if (dj > r) r = dj
      }
      const span = tr!.headArc - tr!.arc[0]!
      const reach = WAKE_BASE_WIDTH + WAKE_HALF_ANGLE_TAN * span + WAKE_EDGE_BELL_HALFWIDTH + 1.5
      cullSlot.set(cx, cz, (r + reach) * (r + reach), tr!.headArc)
    }
  }

  function setSunDirection(x: number, y: number, z: number): void {
    const len = Math.hypot(x, y, z) || 1
    sunDirUniform.value.set(x / len, y / len, z / len)
  }

  // CPU mirror of the vertex shader's transform (waveZoneFactors +
  // gerstnerHeight + gerstnerDisp + the shoaling factor) using the same
  // live uniforms/constants the GPU reads. No shore-wave or bike terms —
  // a clean diagnostic point to compare against the vertical-only
  // `sampleHeight` anywhere outside the shore-wave band (depth ≥
  // SHORE_BAND_DEPTH). Terrain shoaling IS modelled (since shoaling v2
  // reaches out to SHOAL_GREEN_REF_DEPTH = 14 m, coastal-track transects
  // would otherwise have nowhere left to compare): the factor comes from
  // `shoalAttenuation` — the baked shore field's depth, vs the GPU's
  // heightmap texture sample of the same bake; sub-mm filtering
  // differences, same approximation class as the zone-factor rest-point
  // note below. Zone factors are evaluated at the REST point (x, z),
  // exactly where the GPU evaluates them for a mesh vertex.
  // See the WaterMesh `renderVertex` type doc.
  function renderVertex(x: number, z: number, out: { x: number; y: number; z: number }): void {
    const t = field.time
    const zoneFx = sampleZoneFactors(field.zones, x, z, t)
    const globalBearingRad = ((waveBearingDegUniform.value as number) * Math.PI) / 180
    const bearing = zoneFx.bearingRad ?? globalBearingRad
    const cosB = Math.cos(bearing)
    const sinB = Math.sin(bearing)
    const xRot = x * cosB + z * sinB
    const zRot = -x * sinB + z * cosB
    const pinchCos = pinchCosUniform.value as number
    const pinchSin = pinchSinUniform.value as number
    const steep = steepnessUniform.value as number
    // Wave-set envelope — mirror the GPU exactly: recompute the factor
    // from the SYNCED uniforms (not the field) so this stays a faithful
    // twin of what the vertex stage evaluates this frame.
    const envFactor =
      1 +
      (swellSetDepthUniform.value as number) *
        Math.sin(
          t * (swellSetOmegaUniform.value as number) + (swellSetPhaseUniform.value as number),
        )
    // Shoaling factor at the rest point — the GPU multiplies BOTH the
    // ambient height and the horizontal pinch displacement by it.
    const shoal = shoalAttenuation(field, x, z)
    let y = 0
    let dxRot = 0
    let dzRot = 0
    for (let i = 0; i < waveConsts.length; i++) {
      const w = waveConsts[i]!
      const amp = liveWaveAmps[i]! * zoneFx.heightMult * envFactor
      const k = w.k * zoneFx.freqMult
      const omega = w.omega * zoneFx.freqMult
      const phase = k * w.dirX * xRot + k * w.dirZ * zRot - t * omega + w.phase
      const s = Math.sin(phase)
      const c = Math.cos(phase)
      y += s * amp
      const qScaled = steep * w.qBase
      const rotDirX = w.dirX * pinchCos - w.dirZ * pinchSin
      const rotDirZ = w.dirX * pinchSin + w.dirZ * pinchCos
      dxRot += qScaled * rotDirX * amp * c
      dzRot += qScaled * rotDirZ * amp * c
    }
    out.x = x + (dxRot * cosB - dzRot * sinB) * shoal
    // Authored stamps + splash rings join unattenuated, like surge (the
    // GPU adds them to totalHeight outside the shoal multiply).
    out.y =
      y * shoal +
      zoneFx.surgeY +
      sampleStampsAt(field, x, z, t).y +
      sampleSplashRings(field, x, z, t).y +
      mesh.position.y
    out.z = z + (dxRot * sinB + dzRot * cosB) * shoal
  }

  function setHorizonColor(r: number, g: number, b: number): void {
    horizonHazeUniform.value.set(r, g, b)
  }

  function setTerrainHeightmap(heightmap: import('./terrain-heightmap').TerrainHeightmap): void {
    // Copy the baked heightmap data into the pre-allocated GPU texture
    // so the binding the shader compiled against stays stable. Locked
    // to TERRAIN_HEIGHTMAP_RES on both ends — `buildTerrainHeightmap`
    // emits at the same resolution constant.
    const src = heightmap.texture.image.data as Uint16Array
    if (heightmap.resolution !== TERRAIN_HEIGHTMAP_RES || src.length !== heightmapData.length) {
      // Should never trip — both sides import the same constant — but
      // log loudly if it does so the desync is visible rather than
      // silently producing garbled depth.
      // eslint-disable-next-line no-console
      console.warn(
        `[water] terrain heightmap resolution mismatch: got ${heightmap.resolution}, expected ${TERRAIN_HEIGHTMAP_RES}; ignoring`,
      )
      return
    }
    heightmapData.set(src)
    terrainHeightTex.needsUpdate = true
    terrainMinUniform.value.copy(heightmap.worldMin)
    terrainMaxUniform.value.copy(heightmap.worldMax)
    terrainEnabledUniform.value = 1

    // Shore field rides on the same heightmap object (baked from the same
    // raster pass over the same AABB). Pack dist/normal/depth into the RGBA16F
    // texture and enable the shore-wave term. A track with no coastline bakes
    // `shoreField = null` → leave the term disabled (legacy open water).
    const shore = heightmap.shoreField
    if (shore && shore.resolution === TERRAIN_HEIGHTMAP_RES) {
      for (let i = 0; i < shore.dist.length; i++) {
        const o = i * 4
        shoreFieldData[o] = THREE.DataUtils.toHalfFloat(shore.dist[i]!)
        shoreFieldData[o + 1] = THREE.DataUtils.toHalfFloat(shore.nrmX[i]!)
        shoreFieldData[o + 2] = THREE.DataUtils.toHalfFloat(shore.nrmZ[i]!)
        shoreFieldData[o + 3] = THREE.DataUtils.toHalfFloat(shore.depth[i]!)
      }
      shoreFieldTex.needsUpdate = true
      shoreEnabledUniform.value = 1
    } else {
      shoreEnabledUniform.value = 0
    }
  }

  function dispose() {
    geom.dispose()
    mat.dispose()
    skirtGeom.dispose()
    skirtMat.dispose()
    terrainHeightTex.dispose()
    shoreFieldTex.dispose()
  }

  // Cameras whose mirror virtual-cameras have been culled to the opt-in
  // layer — the debug full-scene toggle re-walks them for live A/B.
  const reflectionCulledCams: THREE.Camera[] = []
  // `reflector()` returns the TextureNode wrapper; the virtual-camera
  // registry lives on its `.reflector` (the ReflectorBaseNode).
  const reflectorBase = () => reflectorNode?.reflector ?? null
  function configureReflectionCulling(camera: THREE.Camera): void {
    const base = reflectorBase()
    if (!base || reflectFullFlag) return
    const vc = base.getVirtualCamera(camera) as THREE.Camera
    vc.layers.set(WATER_REFLECTION_LAYER)
    if (!reflectionCulledCams.includes(camera)) reflectionCulledCams.push(camera)
  }

  return {
    mesh,
    tick,
    renderVertex,
    setSunDirection,
    setHorizonColor,
    setTerrainHeightmap,
    setWaterContacts,
    configureReflectionCulling,
    debug,
    dispose,
  }
}

/**
 * Underwater-fog override. Call once per frame AFTER the sky system has
 * updated `scene.fog` for the day-night palette. Smoothly blends the
 * sky-driven air fog into a dense water-tinted version as the camera
 * crosses the actual water surface at its XZ — `waterY` should be the
 * wave-displaced surface height there (use `sampleHeight(waveField, …)`),
 * NOT the mean sea level, so the fog doesn't flip on/off behind wave
 * crests when the camera is bobbing through them.
 *
 * The previous implementation used hard hysteresis against a fixed
 * `cameraY < -0.5` threshold, which fired the fog before the camera was
 * visibly submerged (whenever the local wave trough sat below the camera)
 * and snapped off in a single frame on the way back up. Replacing that
 * with a thin smoothed band around the true surface gives a transition
 * that lines up with what the player actually sees.
 *
 * Subnautica-style: the dense water fog is what sells "you are underwater"
 * more than any single visual on its own. It piggybacks on every receive-
 * shadow / lit surface in the scene, so terrain, bikes, and props all dim
 * into the depths without per-material plumbing.
 */

/** Half-width of the surface blend band, in metres. The camera transitions
 *  through the full air→water blend over `2 * SURFACE_BAND_HALF` of vertical
 *  travel relative to the local wave-displaced surface. */
const SURFACE_BAND_HALF = 0.35
const UNDERWATER_FOG_COLOR = new THREE.Color(0.04, 0.2, 0.3)
const UNDERWATER_FOG_NEAR = 0
const UNDERWATER_FOG_FAR = 28

/** Sky writes `fog.near` / `fog.far` once at init and doesn't touch them
 *  per-tick, so we have to remember the air values ourselves — without
 *  this, the fog stays clamped to the underwater range after the player
 *  resurfaces. Re-captured whenever the camera is clearly above water so
 *  a palette / track change still propagates. Color is left to the sky
 *  module, which writes it every tick. */
const airFogRanges = new WeakMap<THREE.Fog, { near: number; far: number }>()

export function updateUnderwaterFog(scene: THREE.Scene, cameraY: number, waterY = 0): void {
  const fog = scene.fog
  if (!(fog instanceof THREE.Fog)) return
  // `depth` is positive when the camera is below the local surface.
  const depth = waterY - cameraY
  // Clearly above water — refresh the air-fog snapshot and leave the
  // sky-driven values alone.
  if (depth <= -SURFACE_BAND_HALF) {
    airFogRanges.set(fog, { near: fog.near, far: fog.far })
    return
  }
  // First frame in the surface band: seed the snapshot from whatever the
  // sky module just wrote. Without this the underwater values would never
  // have an "above water" endpoint to blend from on the first dip.
  let air = airFogRanges.get(fog)
  if (!air) {
    air = { near: fog.near, far: fog.far }
    airFogRanges.set(fog, air)
  }
  // Linear ramp 0..1 across the surface band; saturated at 1 below it.
  // Smoothstep on top so the edges of the band feather instead of
  // visibly kinking.
  const lin = depth >= SURFACE_BAND_HALF ? 1 : (depth + SURFACE_BAND_HALF) / (2 * SURFACE_BAND_HALF)
  const t = lin * lin * (3 - 2 * lin)
  fog.color.lerp(UNDERWATER_FOG_COLOR, t)
  fog.near = air.near + (UNDERWATER_FOG_NEAR - air.near) * t
  fog.far = air.far + (UNDERWATER_FOG_FAR - air.far) * t
}
