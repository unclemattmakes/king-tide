/**
 * Object-extras `kind` values that flow Blender → glTF → runtime.
 *
 * Mirror of the `ExportedKind` class in `tools/blender/hoverbike_kinds.py`.
 * The unit test `tests/unit/asset-kinds.test.ts` parses the Python file
 * and asserts both sides stay in sync — adding a value here without a
 * matching entry there (or vice versa) fails the test.
 *
 * Why a registry exists at all: bugs like terrain-shader's old
 * `kind === 'track'` accidentally matching downtown buildings + ramps
 * + tunnel liners were caused by stringly-typed comparisons inlined at
 * the call site. With this registry, typos become TS errors and the
 * full set of allowed values is one search away.
 *
 * Renaming any value here is a breaking change for already-built GLBs
 * — extras live inside the binary blob and won't migrate themselves.
 */
export const ExportedKind = {
  /** Collidable terrain / walls / road / buildings. Runtime spawns a
   * trimesh collider against every mesh with this kind. */
  TRACK: 'track',

  /** Water-volume marker (empty at the surface). Runtime reads
   * location.z for sea level + spawns the water plane. */
  WATER: 'water',

  /** Gate position empty. Runtime spawns checkpoint gizmos + triggers. */
  CHECKPOINT: 'checkpoint',

  /** The AI's racing-line curve. One per track. Runtime samples it. */
  AI_SPLINE: 'ai_spline',

  /** Pickup spawn marker. */
  PICKUP_SPAWN: 'pickup_spawn',

  /** Bike start-position empty. Multiple allowed (grid starts). */
  START: 'start',

  /** Speed-boost pad. Runtime spawns a boost trigger at the pose. */
  BOOST_PAD: 'boost_pad',

  /** Bike root empty — every bike GLB carries exactly one. */
  BIKE: 'bike',

  /** Bike socket — attachment point. Accompanied by a `slot` extra
   * naming which socket this is (handlebars, seat, foot peg, etc.). */
  SOCKET: 'socket',

  /** Primitive collider — box / sphere / cylinder. Accompanied by a
   * `shape` extra + dimension extras (`half_extents`, `radius`,
   * `height`, etc.). */
  COLLIDER: 'collider',

  /** Prop root empty — every prop GLB carries exactly one. */
  PROP: 'prop',

  /** Anti-gravity volume zone — oriented box. The bike's gravity
   *  flips to the zone's local +Y while inside. Complements per-anchor
   *  banking on AI splines for off-route stretches without a curve. */
  ANTIGRAV_ZONE: 'antigrav_zone',

  /** Distant-horizon silhouette mesh — a ring of background terrain
   *  the runtime camera-locks to the player so the world has a
   *  tangible far-field shape instead of an empty fog gradient. One
   *  per track. Authors drop a starter ring via the Blender addon's
   *  *Add Horizon Ring*, then tab into edit mode and reshape into
   *  recognizable skyline silhouettes (Skytree for Shibuya, Table
   *  Mountain for Cape Town). The runtime extracts the mesh from
   *  the GLB on load and feeds its geometry into `createHorizonRing`
   *  instead of the procedural fallback. Skipped by the trimesh-
   *  collider attach step — the ring is 1.4 km away and render-only. */
  HORIZON: 'horizon',

  /** Particle-emitter empty — spawn point + orientation for the
   *  shared particle system. Each `emitter_NN` carries a fixed extras
   *  block (`atlas_cell`, `emit_rate`, `lifetime_s`,
   *  `velocity_cone_deg`, `speed_min`/`speed_max`,
   *  `size_start`/`size_end`, `color_start`/`color_end`, `gravity`,
   *  `max_particles`) that the runtime reads at GLB load and
   *  registers with `createParticleSystem`. The empty's transform is
   *  the spawn pose; particles emit along the local +Y direction
   *  within `velocity_cone_deg` half-cone. Skipped by the trimesh-
   *  collider attach step — emitters are render-only. */
  EMITTER: 'emitter',

  /** Wave-mastery volume zone — oriented box. Multiplies the global
   *  Gerstner wave amplitude / frequency inside the box, with an
   *  optional periodic surge term and an optional swell-direction
   *  override. Soft-blends across `blendRadius` so the boundary isn't
   *  visible. Authored as `wave_zone_NN` empties in Blender. */
  WAVE_ZONE: 'wave_zone',
} as const

export type ExportedKindValue = (typeof ExportedKind)[keyof typeof ExportedKind]

/** All ExportedKind values as a Set, for membership tests. */
export const EXPORTED_KIND_VALUES: ReadonlySet<string> = new Set(Object.values(ExportedKind))

/** Narrowing helper for `obj.userData?.kind` reads. Returns the value
 * unchanged if it's a known ExportedKind, undefined otherwise.
 * Prefer this over `userData?.kind === ExportedKind.TRACK` if you
 * also want to reject unknown / typo'd values at runtime. */
export function asExportedKind(value: unknown): ExportedKindValue | undefined {
  if (typeof value !== 'string') return undefined
  return EXPORTED_KIND_VALUES.has(value) ? (value as ExportedKindValue) : undefined
}
