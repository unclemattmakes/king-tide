/**
 * Rider appearance design — per-bone geometric primitive + colour overrides
 * that the rider render system reads when building each bone mesh.
 *
 * This is the data the **rider editor** (`?rideredit=1`,
 * `src/boot/rider-editor-mode.ts`) authors. It's a module-level singleton so
 * the editor can mutate it live and the render system picks the changes up on
 * the next frame (a `version` counter is bumped on every edit so the render
 * system knows to rebuild the bone meshes).
 *
 * Defaults reproduce the historical look exactly — every bone is a capsule
 * except the head, which is a box (rendered with the forward visor wedge that
 * makes the head's facing legible). Each bone's `color` defaults to `null`,
 * meaning "use the per-rider colour the render system assigns" — so the main
 * game, which never loads a saved design, renders identically to before this
 * module existed. Only an explicit colour set in the editor overrides that.
 */

import { RIDER_BONE_NAMES, type RiderBoneName } from '@/game/components/rider'

/** Geometric primitive a rider bone can be drawn as. */
export type RiderPrimitive = 'capsule' | 'box' | 'sphere' | 'cylinder' | 'cone'

export const RIDER_PRIMITIVES: readonly RiderPrimitive[] = [
  'capsule',
  'box',
  'sphere',
  'cylinder',
  'cone',
]

export type RiderScale = { x: number; y: number; z: number }

export type RiderBoneAppearance = {
  primitive: RiderPrimitive
  /** Explicit bone colour as 0xRRGGBB, or `null` to fall back to the
   *  per-rider colour the render system assigns. */
  color: number | null
  /** Per-axis VISUAL scale on top of the primitive's capsule-derived size.
   *  {1,1,1} = no change. Render-only — physics/collision is untouched. */
  scale: RiderScale
}

export type RiderAppearance = {
  bones: Record<RiderBoneName, RiderBoneAppearance>
  /** Bumped on every edit so the render system can detect a change and
   *  rebuild its bone meshes without per-bone diffing. */
  version: number
}

/** Default geometric primitive per bone. The shipped rider mixes shapes:
 *  a boxy torso + arms over capsule legs, with a spherical head. (Adopted
 *  from the tuned `rider-design.json` baseline.) */
export function defaultBonePrimitive(name: RiderBoneName): RiderPrimitive {
  switch (name) {
    case 'head':
      return 'sphere'
    case 'chest':
    case 'upper_arm_L':
    case 'lower_arm_L':
    case 'upper_arm_R':
    case 'lower_arm_R':
      return 'box'
    default:
      return 'capsule'
  }
}

/** Default explicit colour per bone, or `null` to use the per-rider tint.
 *  Only the head carries an explicit colour (a muted helmet indigo). */
export function defaultBoneColor(name: RiderBoneName): number | null {
  return name === 'head' ? 0x414881 : null
}

export function defaultRiderAppearance(): RiderAppearance {
  const bones = {} as Record<RiderBoneName, RiderBoneAppearance>
  for (const name of RIDER_BONE_NAMES) {
    bones[name] = {
      primitive: defaultBonePrimitive(name),
      color: defaultBoneColor(name),
      scale: { x: 1, y: 1, z: 1 },
    }
  }
  return { bones, version: 0 }
}

/** Live singleton the render system reads and the editor mutates. */
export const RIDER_APPEARANCE: RiderAppearance = defaultRiderAppearance()

/** Signal that the appearance changed so the render system rebuilds meshes. */
export function bumpRiderAppearance(): void {
  RIDER_APPEARANCE.version++
}

/** Reset every bone back to its default primitive + colour + scale. */
export function resetRiderAppearance(): void {
  const def = defaultRiderAppearance()
  for (const name of RIDER_BONE_NAMES) {
    const b = RIDER_APPEARANCE.bones[name]
    const d = def.bones[name]
    b.primitive = d.primitive
    b.color = d.color
    b.scale = { ...d.scale }
  }
  bumpRiderAppearance()
}

export const RIDER_APPEARANCE_STORAGE_KEY = 'hoverbike.riderAppearance.v1'

function isPrimitive(v: unknown): v is RiderPrimitive {
  return typeof v === 'string' && (RIDER_PRIMITIVES as readonly string[]).includes(v)
}

/** Merge a persisted appearance payload onto `RIDER_APPEARANCE` in place.
 *  Tolerant per-bone/per-field — unknown bones and malformed fields are
 *  ignored so an old or partial payload still loads onto current defaults. */
export function applyRiderAppearancePayload(parsed: unknown): void {
  if (!parsed || typeof parsed !== 'object') return
  const bones = (parsed as { bones?: unknown }).bones
  if (!bones || typeof bones !== 'object') return
  const map = bones as Record<string, unknown>
  for (const name of RIDER_BONE_NAMES) {
    const entry = map[name]
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const target = RIDER_APPEARANCE.bones[name]
    if (isPrimitive(e.primitive)) target.primitive = e.primitive
    if (e.color === null) {
      target.color = null
    } else if (typeof e.color === 'number' && Number.isFinite(e.color)) {
      target.color = e.color & 0xffffff
    }
    if (e.scale && typeof e.scale === 'object') {
      const s = e.scale as Record<string, unknown>
      for (const axis of ['x', 'y', 'z'] as const) {
        const v = s[axis]
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) target.scale[axis] = v
      }
    }
  }
  bumpRiderAppearance()
}

/** Load any persisted rider-appearance design onto the live singleton.
 *  Called by the rider editor at boot; the main game never calls it, so the
 *  in-race rider keeps its default look. */
export function loadStoredRiderAppearance(): void {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(RIDER_APPEARANCE_STORAGE_KEY)
  } catch {
    return
  }
  if (!raw) return
  try {
    applyRiderAppearancePayload(JSON.parse(raw))
  } catch {
    // Corrupt payload — fall back to defaults already in place.
  }
}

/** Serialize the current design to a plain object (no `version`, which is a
 *  runtime-only change counter). */
export function serializeRiderAppearance(): { bones: Record<string, RiderBoneAppearance> } {
  const bones: Record<string, RiderBoneAppearance> = {}
  for (const name of RIDER_BONE_NAMES) {
    const b = RIDER_APPEARANCE.bones[name]
    bones[name] = { primitive: b.primitive, color: b.color, scale: { ...b.scale } }
  }
  return { bones }
}

export function persistRiderAppearance(): void {
  try {
    window.localStorage.setItem(
      RIDER_APPEARANCE_STORAGE_KEY,
      JSON.stringify(serializeRiderAppearance()),
    )
  } catch {
    // ignore — the design still applies for this session.
  }
}

export function exportRiderAppearanceJSON(): string {
  return JSON.stringify(serializeRiderAppearance(), null, 2)
}
