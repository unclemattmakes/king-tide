/**
 * Surface-type registry — per-collider material tags that flow into the
 * hover/drift physics so a track can mix grippy asphalt, loose sand,
 * slick ice, and clingy metal grating in one course.
 *
 * Sim-layer only (no Three import). The runtime tags each static
 * collider with a `SurfaceType` at creation (props.ts, glb-track.ts,
 * etc.) and the hover probe looks the tag up by collider handle every
 * tick to set `HoverState.surfaceType`. The drift + lateral-drag
 * physics then scale grip by the surface's profile.
 *
 * Design guarantees:
 *  - `DEFAULT` is a perfect 1.0 multiplier everywhere, so every
 *    existing track (none of which tag surfaces) is byte-identical to
 *    pre-surface behaviour. Only explicitly-tagged surfaces change feel.
 *  - `WATER` is informational — its distinctive lateral resistance is
 *    still handled by the `probe.isWater` path in hover.ts, so the
 *    profile here stays neutral (1.0) to avoid double-counting.
 *
 * Authoring today: the JSON `Prop.surface` field. GLB meshes can carry
 * a `surface` userData extra which the track-collider attach reads
 * opportunistically (validated against the known set; unknowns ignored).
 * A Blender-side `SurfaceType` mirror + addon UI is a follow-up — the
 * runtime path is ready for it.
 */

export const SurfaceType = {
  /** Standard track surface — the implicit default for every collider
   *  that isn't tagged. Neutral grip (1.0). */
  DEFAULT: 'default',
  /** Explicit grippy road. Same feel as DEFAULT; exists so authors can
   *  tag "this IS asphalt" deliberately vs "untagged → default". */
  ASPHALT: 'asphalt',
  /** Loose sand — washes out under lateral load. The bike slides wider
   *  and a drift is harder to hold on a tight line. */
  SAND: 'sand',
  /** Slick ice — very little lateral bite. Long, loose drifts that take
   *  real counter-steer to control. */
  ICE: 'ice',
  /** Clingy metal grating / deck plate — extra lateral bite. Tight
   *  drifts that snap to the apex. */
  METAL: 'metal',
  /** Water surface. Informational only — the wave-field path in
   *  hover.ts owns water's lateral feel, so this profile is neutral. */
  WATER: 'water',
} as const

export type SurfaceTypeValue = (typeof SurfaceType)[keyof typeof SurfaceType]

export const SURFACE_TYPE_VALUES: ReadonlySet<string> = new Set(Object.values(SurfaceType))

/**
 * Per-surface physics profile. `lateralGripMul` scales the bike's
 * lateral drag (both normal driving and drift): <1 = slides more,
 * >1 = bites harder. Kept to a single knob for now — the drift slip
 * and the normal grip both read from it so a surface feels coherent
 * (ice is slippery whether or not you're drifting).
 */
export type SurfaceProfile = {
  /** Display label for editors / debug overlays. */
  label: string
  /** Multiplier on lateral drag. 1.0 = baseline (DEFAULT). */
  lateralGripMul: number
}

export const SURFACE_PROFILES: Readonly<Record<SurfaceTypeValue, SurfaceProfile>> = Object.freeze({
  default: { label: 'Default', lateralGripMul: 1.0 },
  asphalt: { label: 'Asphalt', lateralGripMul: 1.0 },
  sand: { label: 'Sand', lateralGripMul: 0.7 },
  ice: { label: 'Ice', lateralGripMul: 0.35 },
  metal: { label: 'Metal', lateralGripMul: 1.25 },
  water: { label: 'Water', lateralGripMul: 1.0 },
})

/** Narrowing helper for untrusted `userData.surface` / JSON reads.
 *  Returns the value if it's a known SurfaceType, undefined otherwise. */
export function asSurfaceType(value: unknown): SurfaceTypeValue | undefined {
  if (typeof value !== 'string') return undefined
  return SURFACE_TYPE_VALUES.has(value) ? (value as SurfaceTypeValue) : undefined
}

/** Lateral-grip multiplier for a surface. Pure lookup; unknown /
 *  undefined types fall back to the DEFAULT (1.0) so a missing tag is
 *  always safe. */
export function surfaceGripMul(type: SurfaceTypeValue | undefined): number {
  if (!type) return 1.0
  return SURFACE_PROFILES[type]?.lateralGripMul ?? 1.0
}

/**
 * Collider → surface-type map. One instance lives on `PhysicsWorld`
 * (created in `createPhysicsWorld`, dies with the world each race), so
 * the tags are scoped to the live track and never leak across races.
 *
 * Colliders are tagged at creation; the hover probe reads them by
 * `hit.collider.handle`. Untagged colliders read as DEFAULT, so the
 * registry only needs entries for the non-default patches.
 */
export type SurfaceRegistry = {
  /** Tag a collider handle with a surface type. No-op for DEFAULT —
   *  the lookup falls back to DEFAULT anyway, so we don't waste a map
   *  entry on the common case. */
  tag(handle: number, type: SurfaceTypeValue): void
  /** Look up a collider's surface type. Returns DEFAULT for untagged
   *  handles. */
  get(handle: number): SurfaceTypeValue
  /** Drop every tag — called on track teardown if the world is reused. */
  clear(): void
  /** Live entry count (test/debug). */
  size(): number
}

export function createSurfaceRegistry(): SurfaceRegistry {
  const map = new Map<number, SurfaceTypeValue>()
  return {
    tag(handle, type) {
      if (type === SurfaceType.DEFAULT) return
      map.set(handle, type)
    },
    get(handle) {
      return map.get(handle) ?? SurfaceType.DEFAULT
    },
    clear() {
      map.clear()
    },
    size() {
      return map.size
    },
  }
}
