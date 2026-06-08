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

  /** Collide-but-don't-render mesh — a real triangle mesh that gets a
   *  trimesh collider (exactly like `track`) but is HIDDEN from render.
   *  The vehicle pattern (a hidden primitive `collider` empty + a
   *  separate visible mesh) extended to curve-/generator-driven track
   *  geometry, where the collider must be a swept surface, not a box.
   *  Pair it with a detailed visible mesh tagged `decoration` (which
   *  opts out of collision) to get a simplified invisible collision
   *  proxy. First user: HV_Dock's smooth swept deck slab — the irregular
   *  plank deck renders as `decoration`, this slab carries collision so
   *  the bike rides a smooth surface instead of every floating plank.
   *  Hidden by `loadGlbTrackVisuals` but INCLUDED by `attachTrackColliders`
   *  and `buildTerrainHeightmap`, so collision + shoaling stay consistent. */
  COLLIDER_MESH: 'collider_mesh',

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

  /** Decal mesh — a thin projected quad that lays on top of terrain /
   *  road geometry to add wear, paint, posters, oil stains, etc.
   *  Authored as `decal_NN` meshes in Blender; the runtime walks them
   *  on load and applies the decal material profile (alpha-blend,
   *  depth-test ON / write OFF, slight polygon offset to avoid
   *  z-fighting with the surface, no shadow casting). Skipped by the
   *  trimesh-collider attach step — decals are render-only. */
  DECAL: 'decal',

  /** Wave-rider marker. Reserved for future authoring sites that want
   *  to flag a non-prop node as a wave-rider (track-baked floating
   *  debris, scattered marker buoys, etc.). The current asset-prop
   *  flow keeps `kind = prop` on the root empty and uses a sibling
   *  extras key `wave_rider_archetype: "buoy" | "log"` to mark the
   *  asset as wave-riding — that path preserves backward compat with
   *  every track GLB / loader site that already special-cases
   *  `kind === 'prop'`. Adding the dedicated kind here lets future
   *  pipelines (e.g. inline wave-rider markers in a track GLB) use
   *  a single-extras tag without the prop indirection. */
  WAVE_RIDER: 'wave_rider',
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

/** Minimal structural shape of a three.js `Object3D` needed to resolve a
 *  `kind`. Declared structurally so this widely-imported module stays
 *  Three-free. */
type KindCarrier = {
  userData?: { kind?: unknown }
  parent?: KindCarrier | null
}

/**
 * Resolve the authored `kind` for a loaded glTF object, walking up the
 * parent chain to the nearest ancestor that carries one.
 *
 * Why the walk and not a plain `obj.userData?.kind`: Blender writes `kind`
 * as a glTF **node** extra, but three.js's GLTFLoader splits a
 * multi-primitive node (a mesh with >1 material) into a parent `Group` —
 * which receives the node extras — plus one child `Mesh` per primitive
 * carrying only *mesh*-level extras, i.e. no `kind`. So a per-mesh read
 * misses the tag on every multi-material authored object: e.g. HV_Dock's
 * plank deck + pylons (2 materials → 2 primitives) loads as
 * `Group{kind:'decoration'} → [Mesh(planks), Mesh(pylons)]`, and a
 * collider/heightmap pass that checks the child `Mesh` would never see the
 * `decoration` opt-out — so the deck still collides per-plank. Resolving
 * through the parent restores the authored intent for the split children.
 *
 * Returns the nearest `kind` string (note `'decoration'` is a valid value
 * even though it isn't in `ExportedKind`), or undefined if neither the
 * object nor any ancestor carries one.
 */
export function resolveNodeKind(obj: KindCarrier | null | undefined): string | undefined {
  let cur: KindCarrier | null | undefined = obj
  while (cur) {
    const k = cur.userData?.kind
    if (typeof k === 'string') return k
    cur = cur.parent
  }
  return undefined
}
