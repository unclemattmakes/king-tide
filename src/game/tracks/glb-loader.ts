import { ExportedKind } from '@/engine/asset-kinds'
import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import type { Checkpoint, Track } from './types'

/**
 * .glb track loader. Reads the JSON chunk of a glTF Binary file, walks the
 * node tree, and builds a {@link Track} from the metadata in `extras`.
 *
 * Why parse the .glb manually instead of pulling in Three.js' GLTFLoader?
 * - Sim-side data (Track) must be Three-free per the architecture rule
 *   (see docs/status.md "Important conventions"). The loader produces a
 *   plain Track object.
 * - We don't need the binary buffer (mesh/animation/skeleton data). Every
 *   field the runtime cares about — checkpoint positions, AI spline points,
 *   start pose, pickup spawns — is in `node.extras`.
 *
 * Coordinate convention. glTF defaults to Y-up; the Blender exporter passes
 * `export_yup=True`; Three.js + this project's Track type are also Y-up.
 * Translations and rotations therefore round-trip without a basis change.
 *
 * Sister tools — see tools/blender/build_track.py (spec-driven scene
 * builder) + tools/export_track.py (validating exporter that bakes
 * NURBS curves into `extras.points` since glTF doesn't carry curves)
 * for the authoring-side conventions.
 */

type GltfPrimitiveExtras = {
  kind?: string
  index?: number
  half_width?: number
  height?: number
  branch?: string
  points?: number[]
  wave_height?: number
  wave_freq?: number
  // Bike / prop / collider / socket extras — open-ended since the
  // headless builders also emit shape-specific keys (half_extents,
  // slot, mass_kg, etc.). Test code reads these directly.
  [k: string]: unknown
}

type GltfNode = {
  name?: string
  extras?: GltfPrimitiveExtras
  translation?: [number, number, number]
  rotation?: [number, number, number, number]
  scale?: [number, number, number]
}

export type GltfRoot = {
  nodes?: GltfNode[]
  scenes?: { nodes?: number[] }[]
  scene?: number
}

const GLB_MAGIC = 0x46546c67 // "glTF" little-endian
const CHUNK_TYPE_JSON = 0x4e4f534a // "JSON" little-endian

/** Parse the JSON chunk out of a .glb buffer. The binary chunk is ignored. */
export function parseGlbJson(buffer: ArrayBuffer): GltfRoot {
  const view = new DataView(buffer)
  if (buffer.byteLength < 12) throw new Error('glb: buffer too small for header')
  const magic = view.getUint32(0, true)
  if (magic !== GLB_MAGIC) {
    throw new Error(`glb: invalid magic 0x${magic.toString(16)} (expected 0x46546c67)`)
  }
  let offset = 12
  while (offset + 8 <= buffer.byteLength) {
    const chunkLen = view.getUint32(offset, true)
    const chunkType = view.getUint32(offset + 4, true)
    if (chunkType === CHUNK_TYPE_JSON) {
      const decoder = new TextDecoder('utf-8')
      const json = decoder.decode(new Uint8Array(buffer, offset + 8, chunkLen))
      return JSON.parse(json) as GltfRoot
    }
    offset += 8 + chunkLen
  }
  throw new Error('glb: no JSON chunk found')
}

export type LoadTrackOptions = {
  /** Track id used by the runtime / debug API. */
  id: string
  /** Display name. */
  name: string
  /** Race length. */
  lapsToFinish: number
}

/** Fetch + parse + build. Network errors and validation errors throw. */
export async function loadTrackFromGlb(url: string, opts: LoadTrackOptions): Promise<Track> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`glb: fetch ${url} failed: ${res.status} ${res.statusText}`)
  const buf = await res.arrayBuffer()
  return buildTrackFromGltf(parseGlbJson(buf), opts)
}

/** Build a Track from an already-parsed gltf JSON root. Useful for tests. */
export function buildTrackFromGltf(gltf: GltfRoot, opts: LoadTrackOptions): Track {
  const nodes = gltf.nodes ?? []

  const byKind = new Map<string, GltfNode[]>()
  for (const node of nodes) {
    const kind = node.extras?.kind
    if (typeof kind !== 'string') continue
    const list = byKind.get(kind)
    if (list) list.push(node)
    else byKind.set(kind, [node])
  }

  const starts = byKind.get(ExportedKind.START) ?? []
  if (starts.length === 0) throw new Error(`glb: missing kind=${ExportedKind.START}`)
  starts.sort((a, b) => (a.extras?.index ?? 0) - (b.extras?.index ?? 0))
  const start0 = starts[0]!
  const startPos = readTranslation(start0)
  const startYaw = readYaw(start0)

  const cps = byKind.get(ExportedKind.CHECKPOINT) ?? []
  if (cps.length === 0) throw new Error(`glb: missing kind=${ExportedKind.CHECKPOINT}`)
  cps.sort((a, b) => (a.extras?.index ?? 0) - (b.extras?.index ?? 0))
  const checkpoints: Checkpoint[] = cps.map((node, i) => {
    const idx = node.extras?.index
    if (typeof idx !== 'number' || idx !== i) {
      throw new Error(
        `glb: checkpoint ${node.name ?? '?'} has index ${idx} but expected ${i} (must be contiguous from 0)`,
      )
    }
    const halfWidth = node.extras?.half_width
    const height = node.extras?.height
    if (typeof halfWidth !== 'number' || typeof height !== 'number') {
      throw new Error(
        `glb: checkpoint ${node.name ?? '?'} missing extras.half_width or extras.height`,
      )
    }
    return {
      index: idx,
      position: readTranslation(node),
      rotation: readRotation(node),
      halfWidth,
      height,
    }
  })

  const pickups = byKind.get(ExportedKind.PICKUP_SPAWN) ?? []
  const pickupSpawns: Vec3[] = pickups.map(readTranslation)

  const splineNodes = byKind.get(ExportedKind.AI_SPLINE) ?? []
  const aiSplines = splineNodes.map((node) => {
    const branch = node.extras?.branch
    const points = node.extras?.points
    if (typeof branch !== 'string') {
      throw new Error(`glb: ${ExportedKind.AI_SPLINE} ${node.name ?? '?'} missing extras.branch`)
    }
    if (!Array.isArray(points) || points.length < 6 || points.length % 3 !== 0) {
      throw new Error(
        `glb: ${ExportedKind.AI_SPLINE} ${node.name ?? '?'} extras.points must be a flat [x,y,z,...] with >=2 points (got ${points?.length ?? 0} floats)`,
      )
    }
    const samples: Vec3[] = []
    for (let i = 0; i < points.length; i += 3) {
      samples.push({
        x: points[i] as number,
        y: points[i + 1] as number,
        z: points[i + 2] as number,
      })
    }
    return { id: branch, points: samples }
  })
  if (!aiSplines.some((s) => s.id === 'main')) {
    throw new Error(`glb: missing ${ExportedKind.AI_SPLINE} branch=main`)
  }

  return {
    id: opts.id,
    name: opts.name,
    start: { position: startPos, yaw: startYaw },
    checkpoints,
    lapsToFinish: opts.lapsToFinish,
    surfaces: [],
    boostPads: [],
    props: [],
    pickupSpawns,
    aiSplines,
  }
}

function readTranslation(node: GltfNode): Vec3 {
  const t = node.translation
  if (!t) return { x: 0, y: 0, z: 0 }
  return { x: t[0], y: t[1], z: t[2] }
}

function readRotation(node: GltfNode): Quat {
  const r = node.rotation
  if (!r) return { x: 0, y: 0, z: 0, w: 1 }
  return { x: r[0], y: r[1], z: r[2], w: r[3] }
}

/** Yaw around world-Y, matching the convention used in hover.ts and the
 *  procedural track creators (atan2 of the YXZ Euler decomposition). */
function readYaw(node: GltfNode): number {
  const q = readRotation(node)
  const r02 = 2 * (q.x * q.z + q.y * q.w)
  const r22 = 1 - 2 * (q.x * q.x + q.y * q.y)
  return Math.atan2(r02, r22)
}
