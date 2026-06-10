/**
 * Water-contact discovery — where the sea meets the world.
 *
 * A *contact* is a compact piece of static geometry that pierces the water
 * surface: a bridge pillar, a placed rock, a dock pylon, a crane leg. The
 * water shader draws a wave-modulated foam collar + wash ripples around each
 * one (see `contactFoam` in water.ts) and the contact-splash driver
 * (contact-splash.ts) bursts spray off it when a crest slams through — the
 * two halves that make obstacles feel *in* the sea instead of pasted onto a
 * rubber sheet. Both are shading/particles only: water DISPLACEMENT is never
 * touched, so the sim↔render buoyancy contract stays intact.
 *
 * Discovery is automatic: walk the loaded render roots (environment GLB +
 * static props root) and accept every visible mesh whose world bounding box
 * straddles the waterline band and whose footprint is compact enough to be
 * an obstacle rather than terrain. Terrain itself, the water sheet, horizon
 * silhouettes, decals and hidden collision proxies are excluded by kind /
 * name; floating props (wave-riders) and animated props live under different
 * hosts and are never walked here — their collar follows them via the live
 * update path instead.
 *
 * Structurally typed (no Three import) so it unit-tests against plain
 * objects; THREE.Object3D / Mesh satisfy `ContactScanNode` as-is. Callers
 * must `root.updateMatrixWorld(true)` before scanning.
 */

import { resolveNodeKind } from '../asset-kinds'

/** One waterline contact disc, world space. */
export type WaterContact = {
  /** Disc centre, world XZ. */
  x: number
  z: number
  /** Collar radius (m) — the obstacle's footprint radius at the waterline. */
  radius: number
  /** Foam collar strength multiplier, 0..1. */
  strength: number
}

/** Shader-side cap — contact slots packed into the shared wave-event uniform
 *  array (see water.ts). Tracks may discover more; the nearest N to the
 *  camera-following mesh origin are uploaded each frame. */
export const MAX_WATER_CONTACTS = 24

/** Minimal structural slice of THREE.Object3D the scan walks. The explicit
 *  `| undefined` on every optional keeps THREE's own types assignable under
 *  `exactOptionalPropertyTypes`. */
export type ContactScanNode = {
  name?: string | undefined
  visible?: boolean | undefined
  userData?: { kind?: unknown } | undefined
  parent?: ContactScanNode | null | undefined
  children?: ContactScanNode[] | undefined
  /** Present (true) on THREE.Mesh. */
  isMesh?: boolean | undefined
  /** Present (true) on THREE.InstancedMesh — repeated asset props instance
   *  together (props-mesh.ts), so each placement is a matrix in
   *  `instanceMatrix`, not a child node. */
  isInstancedMesh?: boolean | undefined
  count?: number | undefined
  instanceMatrix?: { array: ArrayLike<number> } | undefined
  geometry?:
    | {
        boundingBox: Box3Like | null
        computeBoundingBox(): void
      }
    | undefined
  matrixWorld?: { elements: ArrayLike<number> } | undefined
}

type Vec3Like = { x: number; y: number; z: number }
type Box3Like = { min: Vec3Like; max: Vec3Like }

export type ContactScanOptions = {
  /** Sea surface height (world Y) the straddle band is centred on. */
  waterY: number
  /** Half-height of the straddle band (m): how far the live swell can reach
   *  above/below the still-water line. A mesh must span INTO this band from
   *  both sides to count — fully-dry and fully-sunken geometry is skipped. */
  reach?: number
  /** Reject meshes whose XZ footprint exceeds this (m) — terrain chunks,
   *  buildings and merged multi-pillar meshes aren't a single collar. */
  maxFootprintM?: number
  /** Hard cap on discovered contacts (largest-first) so a pathological
   *  track can't build an unbounded list. */
  maxContacts?: number
}

const DEFAULT_REACH_M = 1.5
const DEFAULT_MAX_FOOTPRINT_M = 14
const DEFAULT_MAX_CONTACTS = 96
const MIN_RADIUS_M = 0.3
const MAX_RADIUS_M = 7

/** Mesh kinds that can host a collar. `prop` covers asset-prop subtrees
 *  (kind lives on the root empty), `track`/`decoration` cover authored
 *  set-dressing; undefined covers editor primitives that carry no kind. */
const INCLUDE_KINDS = new Set<string | undefined>(['track', 'decoration', 'prop', undefined])

/** Name fragments that are never obstacles, whatever their kind says:
 *  terrain carries the shore foam system already, water/skirt are the sea
 *  itself, horizon is a 1.4 km backdrop. */
const EXCLUDE_NAME = /terrain|water|skirt|horizon/i

/**
 * Walk `roots` and collect waterline contacts. Pure traversal — no Three
 * import, no scene mutation. World matrices must be current.
 */
export function collectWaterContacts(
  roots: readonly ContactScanNode[],
  opts: ContactScanOptions,
): WaterContact[] {
  const reach = opts.reach ?? DEFAULT_REACH_M
  const maxFootprint = opts.maxFootprintM ?? DEFAULT_MAX_FOOTPRINT_M
  const out: WaterContact[] = []

  const visit = (node: ContactScanNode): void => {
    if (node.visible === false) return // hidden collision proxies etc.
    if (node.isMesh && node.geometry && node.matrixWorld) {
      const kind = resolveNodeKind(node)
      if (INCLUDE_KINDS.has(kind) && !EXCLUDE_NAME.test(node.name ?? '')) {
        if (node.isInstancedMesh && node.instanceMatrix && node.count) {
          // Each placement is one matrix; compose mesh-world × instance-local
          // so every repeated rock/pylon gets its own disc.
          const local = localBbox(node)
          if (local) {
            for (let i = 0; i < node.count; i++) {
              const m = composeInstanceWorld(
                node.matrixWorld.elements,
                node.instanceMatrix.array,
                i,
              )
              const contact = contactFromBbox(
                transformBbox(local, m),
                opts.waterY,
                reach,
                maxFootprint,
              )
              if (contact) out.push(contact)
            }
          }
        } else {
          const local = localBbox(node)
          if (local) {
            const contact = contactFromBbox(
              transformBbox(local, node.matrixWorld.elements),
              opts.waterY,
              reach,
              maxFootprint,
            )
            if (contact) out.push(contact)
          }
        }
      }
    }
    if (node.children) for (const child of node.children) visit(child)
  }
  for (const root of roots) visit(root)

  const merged = mergeNearbyContacts(out)
  // Largest-first cap: if a track somehow yields hundreds, keep the discs
  // that read at race speed.
  merged.sort((a, b) => b.radius - a.radius)
  return merged.slice(0, opts.maxContacts ?? DEFAULT_MAX_CONTACTS)
}

/** Local bounding box of a mesh's geometry, computed on demand. Null for
 *  empty/degenerate geometry (three parks empty boxes at ±Infinity). */
function localBbox(node: ContactScanNode): Box3Like | null {
  const geom = node.geometry!
  if (!geom.boundingBox) geom.computeBoundingBox()
  const local = geom.boundingBox
  if (!local) return null
  if (!Number.isFinite(local.min.x) || !Number.isFinite(local.max.x)) return null
  return local
}

/** AABB of `local` pushed through a column-major 4×4, corner by corner
 *  (no Three dependency). */
function transformBbox(local: Box3Like, e: ArrayLike<number>): Box3Like {
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (let c = 0; c < 8; c++) {
    const lx = c & 1 ? local.max.x : local.min.x
    const ly = c & 2 ? local.max.y : local.min.y
    const lz = c & 4 ? local.max.z : local.min.z
    const wx = e[0]! * lx + e[4]! * ly + e[8]! * lz + e[12]!
    const wy = e[1]! * lx + e[5]! * ly + e[9]! * lz + e[13]!
    const wz = e[2]! * lx + e[6]! * ly + e[10]! * lz + e[14]!
    if (wx < min.x) min.x = wx
    if (wy < min.y) min.y = wy
    if (wz < min.z) min.z = wz
    if (wx > max.x) max.x = wx
    if (wy > max.y) max.y = wy
    if (wz > max.z) max.z = wz
  }
  return { min, max }
}

/** meshWorld × instanceLocal for instance `i` (both column-major). */
function composeInstanceWorld(
  world: ArrayLike<number>,
  instances: ArrayLike<number>,
  i: number,
): number[] {
  const base = i * 16
  const out = new Array<number>(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) {
        sum += world[k * 4 + row]! * instances[base + col * 4 + k]!
      }
      out[col * 4 + row] = sum
    }
  }
  return out
}

/** Straddle + footprint filter → contact disc, or null. */
function contactFromBbox(
  bbox: Box3Like,
  waterY: number,
  reach: number,
  maxFootprint: number,
): WaterContact | null {
  // Must reach below the band's top AND above its bottom — i.e. the mesh
  // actually crosses the water the swell can occupy.
  if (bbox.min.y > waterY + reach || bbox.max.y < waterY - reach) return null
  const sizeX = bbox.max.x - bbox.min.x
  const sizeZ = bbox.max.z - bbox.min.z
  const footprint = Math.max(sizeX, sizeZ)
  if (footprint > maxFootprint || footprint <= 0) return null
  const radius = Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, footprint * 0.5))
  return {
    x: (bbox.min.x + bbox.max.x) * 0.5,
    z: (bbox.min.z + bbox.max.z) * 0.5,
    radius,
    strength: 1,
  }
}

/**
 * Merge contacts whose discs substantially overlap (a pillar mesh + its base
 * mesh, a rock cluster) into one collar — overlapping collars double-bright
 * and read as a rendering bug. Greedy largest-first absorption: a smaller
 * disc whose centre sits within ~the larger disc is dropped, slightly
 * growing the survivor.
 */
export function mergeNearbyContacts(contacts: readonly WaterContact[]): WaterContact[] {
  const sorted = [...contacts].sort((a, b) => b.radius - a.radius)
  const out: WaterContact[] = []
  for (const c of sorted) {
    let absorbed = false
    for (const kept of out) {
      const d = Math.hypot(c.x - kept.x, c.z - kept.z)
      if (d < kept.radius + c.radius * 0.25) {
        // Grow the keeper just enough to cover the absorbed disc's far edge,
        // clamped so clusters don't snowball into a giant collar.
        kept.radius = Math.min(MAX_RADIUS_M, Math.max(kept.radius, d + c.radius * 0.8))
        absorbed = true
        break
      }
    }
    if (!absorbed) out.push({ ...c })
  }
  return out
}

/** Nearest-N selection for the shader's fixed slot budget. Stable for ties;
 *  returns a new array, never mutates input. */
export function selectNearestContacts(
  contacts: readonly WaterContact[],
  originX: number,
  originZ: number,
  max: number = MAX_WATER_CONTACTS,
): WaterContact[] {
  if (contacts.length <= max) return [...contacts]
  return [...contacts]
    .sort(
      (a, b) =>
        (a.x - originX) ** 2 + (a.z - originZ) ** 2 - ((b.x - originX) ** 2 + (b.z - originZ) ** 2),
    )
    .slice(0, max)
}
