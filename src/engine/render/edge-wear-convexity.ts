/**
 * Runtime edge-wear convexity stamp for procedurally-built geometry.
 *
 * The painterly-vinyl material drybrushes convex edges by reading per-vertex
 * `(1 − COLOR_0.A)`, where `A = 1 − convexity`. Asset GLBs carry this channel
 * (baked by `tools/blender/condition_ai_mesh.py` / refreshed by
 * `patch_convexity.py`), but geometry built in-engine (the box/sphere/cylinder/
 * pipe primitive props) has no `COLOR_0` at all — so it can't use edge wear and,
 * worse, a fully-absent attribute reads 0 on every channel under TSL (AO → 0.55
 * darken, edge → full bleach). This stamps the channel so primitives both look
 * right and pick up the same hard-surface edge wear as the asset library.
 *
 * Convexity is computed on a POSITION-WELDED view of the mesh, mirroring
 * `tools/blender/patch_convexity.py` / `vertex_attrs.welded_convexity`: primitive
 * geometries split vertices along every hard edge (a BoxGeometry corner is three
 * coincident verts, each with its own face normal), so a naive per-triangle
 * neighbour graph only ever sees coplanar in-face edges and reads convexity ~0.
 * Welding by position reconnects the corners, a smooth per-position normal is
 * recomputed from the incident faces, and `A = 1 − convexity` is mapped back
 * onto every original vertex.
 */
import * as THREE from 'three'

const GAIN = 1.6
/** Position-quantise grid for welding. Coincident split verts share an exact
 *  position so any precision merges them; this only bounds how close two
 *  distinct verts may sit before folding together. 1e4 → 0.1 mm, well below any
 *  primitive feature. */
const WELD_Q = 1e4

/**
 * Stamp a `COLOR_0` (vec4: R=1, G=1 AO, B=0, A=1−convexity) carrying edge-wear
 * convexity on a BufferGeometry. No-op if a `color` attribute already exists.
 * Cheap — primitive props are a few hundred verts.
 */
export function stampConvexityColor0(geom: THREE.BufferGeometry): void {
  if (geom.getAttribute('color')) return
  const posAttr = geom.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!posAttr) return
  const n = posAttr.count
  if (n === 0) return

  const index = geom.getIndex()
  const idxCount = index ? index.count : n
  const vertOf = (i: number): number => (index ? index.getX(i) : i)

  // Weld vertices by quantised position → unique-position buckets.
  const keyToUniq = new Map<string, number>()
  const orig2uniq = new Int32Array(n)
  const uxArr: number[] = []
  const uyArr: number[] = []
  const uzArr: number[] = []
  for (let i = 0; i < n; i++) {
    const x = posAttr.getX(i)
    const y = posAttr.getY(i)
    const z = posAttr.getZ(i)
    const key = `${Math.round(x * WELD_Q)},${Math.round(y * WELD_Q)},${Math.round(z * WELD_Q)}`
    let u = keyToUniq.get(key)
    if (u === undefined) {
      u = uxArr.length
      keyToUniq.set(key, u)
      uxArr.push(x)
      uyArr.push(y)
      uzArr.push(z)
    }
    orig2uniq[i] = u
  }
  const un = uxArr.length

  // Per-unique accumulators. Plain dense arrays; reads are guarded with `?? 0`
  // for `noUncheckedIndexedAccess` (every index is < un by construction, so the
  // guard never actually fires — it's a type-level no-op).
  const nx = new Array<number>(un).fill(0)
  const ny = new Array<number>(un).fill(0)
  const nz = new Array<number>(un).fill(0)
  const edges = new Set<number>()
  for (let t = 0; t + 2 < idxCount; t += 3) {
    const a = orig2uniq[vertOf(t)] ?? 0
    const b = orig2uniq[vertOf(t + 1)] ?? 0
    const c = orig2uniq[vertOf(t + 2)] ?? 0
    const ax = uxArr[a] ?? 0
    const ay = uyArr[a] ?? 0
    const az = uzArr[a] ?? 0
    const v1x = (uxArr[b] ?? 0) - ax
    const v1y = (uyArr[b] ?? 0) - ay
    const v1z = (uzArr[b] ?? 0) - az
    const v2x = (uxArr[c] ?? 0) - ax
    const v2y = (uyArr[c] ?? 0) - ay
    const v2z = (uzArr[c] ?? 0) - az
    const fx = v1y * v2z - v1z * v2y
    const fy = v1z * v2x - v1x * v2z
    const fz = v1x * v2y - v1y * v2x
    nx[a] = (nx[a] ?? 0) + fx
    ny[a] = (ny[a] ?? 0) + fy
    nz[a] = (nz[a] ?? 0) + fz
    nx[b] = (nx[b] ?? 0) + fx
    ny[b] = (ny[b] ?? 0) + fy
    nz[b] = (nz[b] ?? 0) + fz
    nx[c] = (nx[c] ?? 0) + fx
    ny[c] = (ny[c] ?? 0) + fy
    nz[c] = (nz[c] ?? 0) + fz
    // Edge key = lo*un + hi (un < a few thousand for primitives → safe integer).
    edges.add((a < b ? a : b) * un + (a < b ? b : a))
    edges.add((b < c ? b : c) * un + (b < c ? c : b))
    edges.add((c < a ? c : a) * un + (c < a ? a : c))
  }

  // Accumulate per-vertex dot(edge dir, unit normal) over unique edges. Convex
  // verts have their edges trending away from the normal (negative dot).
  const sum = new Array<number>(un).fill(0)
  const cnt = new Array<number>(un).fill(0)
  for (const e of edges) {
    const a = Math.floor(e / un)
    const b = e % un
    const ex = (uxArr[b] ?? 0) - (uxArr[a] ?? 0)
    const ey = (uyArr[b] ?? 0) - (uyArr[a] ?? 0)
    const ez = (uzArr[b] ?? 0) - (uzArr[a] ?? 0)
    const el = Math.hypot(ex, ey, ez)
    if (el < 1e-9) continue
    const nax = nx[a] ?? 0
    const nay = ny[a] ?? 0
    const naz = nz[a] ?? 0
    const nla = Math.hypot(nax, nay, naz) || 1
    sum[a] = (sum[a] ?? 0) + (ex * nax + ey * nay + ez * naz) / (el * nla)
    cnt[a] = (cnt[a] ?? 0) + 1
    const nbx = nx[b] ?? 0
    const nby = ny[b] ?? 0
    const nbz = nz[b] ?? 0
    const nlb = Math.hypot(nbx, nby, nbz) || 1
    sum[b] = (sum[b] ?? 0) + (-ex * nbx - ey * nby - ez * nbz) / (el * nlb)
    cnt[b] = (cnt[b] ?? 0) + 1
  }

  // A = 1 − convexity onto every original vertex sharing a welded position.
  const colors = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    const u = orig2uniq[i] ?? 0
    const c = cnt[u] ?? 0
    const conv = c ? Math.max(0, Math.min(1, -((sum[u] ?? 0) / c) * GAIN)) : 0
    colors[i * 4] = 1 // R unused
    colors[i * 4 + 1] = 1 // G = AO (no darken)
    colors[i * 4 + 2] = 0 // B unused
    colors[i * 4 + 3] = 1 - conv // A = 1 − convexity
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 4))
}
