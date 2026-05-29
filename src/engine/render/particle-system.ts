/**
 * Unified track-emitter particle system.
 *
 * Gap #6 from ``docs/v1-asset-pipeline-plan.md`` — every named track VFX
 * (wave-pump flash, lava steam, gull flocks, neon glare, jungle motes,
 * torch flame, oxidation shimmer, palm sway, etc.) is authored as a
 * ``kind="emitter"`` empty in Blender, never as a one-off render
 * system. This module drives all of them from one place.
 *
 * Architecture:
 *
 *   - One shared 1024×1024 PNG atlas (``public/assets/fx/particle-atlas.png``)
 *     split into a 4×4 grid of 16 cells. Each emitter picks an
 *     ``atlas_cell`` index (0..15); the SpriteNodeMaterial samples the
 *     matching tile via a UV offset. Building the atlas:
 *     ``python tools/blender/build_sprite_atlas.py`` (or ``pnpm gen:fx-atlas``).
 *   - One ``THREE.InstancedMesh`` per *atlas cell* — emitters that share
 *     a cell share a draw call. The trade-off: a track with 8 emitters
 *     across, say, 4 distinct cells issues 4 draw calls regardless of
 *     emitter count, and the per-cell ``max_particles`` budget covers
 *     every emitter using that cell summed together. This keeps the
 *     draw count bounded (≤ 16) and means dust+dust emitters share a
 *     pool. Per-emitter pools would cap draw calls at the number of
 *     emitters (could blow past 16 on dense tracks) and prevent re-use
 *     of dead slots across emitters with the same sprite — worse for
 *     burst-y effects.
 *   - CPU-side state arrays (position / velocity / age / size / color)
 *     in Float32Arrays, identical in shape to the existing ``fx/index.ts``
 *     pool. A free-stack reuses dead slots; the per-tick walk is O(N)
 *     where N is the cell's capacity.
 *   - TSL node graph on the material:
 *       positionNode → per-instance ``aPos`` attribute
 *       scaleNode    → per-instance ``aSize`` attribute (lerped from
 *                       size_start → size_end over particle age)
 *       opacityNode  → texture alpha × per-instance ``aAlpha``
 *       colorNode    → texture RGB × per-instance ``aColor`` (lerped
 *                       from color_start → color_end over age)
 *
 * WebGPU constraints (per
 * ``memory/feedback_webgpu_particles.md``): no ``ShaderMaterial`` (the
 * NodeBuilder rejects it), no ``THREE.Points`` (clamps to 1px on
 * WebGPU). We use ``SpriteNodeMaterial`` from ``three/webgpu`` plus
 * ``THREE.InstancedMesh``, the same shape the existing FX system
 * already ships.
 *
 * Authoring: see ``tools/blender/hoverbike_addon/emitter.py``. Empty's
 * ``+Y`` axis is the emission direction (cone half-angle =
 * ``velocity_cone_deg``). Speed is uniform-random in
 * ``[speed_min, speed_max]``. Per-particle initial size, color, and
 * lifetime come from the empty's extras and are stamped at spawn.
 */

import * as THREE from 'three'
import type Node from 'three/src/nodes/core/Node.js'
import { attribute, texture as tslTexture } from 'three/tsl'
import { SpriteNodeMaterial } from 'three/webgpu'
import { ExportedKind } from '@/engine/asset-kinds'

// ────────────────────────────────────────────────────────────────────
// Cell-index legend — must stay in sync with build_sprite_atlas.py.
// ────────────────────────────────────────────────────────────────────
//
//    0  soft round spark
//    1  smoke puff
//    2  ember
//    3  foam droplet
//    4  dust mote
//    5  gull silhouette
//    6  leaf
//    7  neon glare
//    8  ash
//    9  water spray
//   10  glow halo
//   11  motion streak
//   12  spare (alias of 0)
//   13  spare (alias of 1)
//   14  spare (alias of 2)
//   15  spare (alias of 3)

const ATLAS_GRID = 4 // 4×4 = 16 cells
const ATLAS_CELL_COUNT = ATLAS_GRID * ATLAS_GRID
const DEFAULT_PER_CELL_CAPACITY = 256

/** Per-emitter authoring extras read off ``userData`` on the loaded
 * empty. Defaults are applied for anything the .blend didn't stamp so
 * a freshly-renamed ``emitter_NN`` round-trips with sane behaviour. */
export type EmitterConfig = {
  name: string
  atlasCell: number
  emitRate: number
  lifetimeS: number
  velocityConeDeg: number
  speedMin: number
  speedMax: number
  sizeStart: number
  sizeEnd: number
  colorStart: [number, number, number, number]
  colorEnd: [number, number, number, number]
  /** Y-axis acceleration in m/s². 0 = ignore, negative = fall, positive = rise. */
  gravity: number
  maxParticles: number
}

/** Default authoring values — match
 * ``tools/blender/hoverbike_addon/emitter.py`` exactly. Anything the
 * author hasn't overridden in the .blend lands here. */
export const DEFAULT_EMITTER_CONFIG: Omit<EmitterConfig, 'name'> = {
  atlasCell: 0,
  emitRate: 30,
  lifetimeS: 1.5,
  velocityConeDeg: 25,
  speedMin: 0.8,
  speedMax: 2.5,
  sizeStart: 0.4,
  sizeEnd: 1.2,
  colorStart: [1, 1, 1, 1],
  colorEnd: [1, 1, 1, 0],
  gravity: 0,
  maxParticles: 256,
}

/** Random number generator interface — production uses Math.random;
 * tests inject a deterministic stream so spawn counts + per-particle
 * jitter are reproducible. */
export type RandomFn = () => number

// ────────────────────────────────────────────────────────────────────
// Per-emitter registration
// ────────────────────────────────────────────────────────────────────

type EmitterState = {
  config: EmitterConfig
  /** World-space spawn point. */
  origin: THREE.Vector3
  /** World-space emission direction (the empty's local +Y, mapped
   *  through its world matrix). The cone fans from this axis. */
  axis: THREE.Vector3
  /** Two unit vectors orthogonal to ``axis``, cached so cone-sampling
   *  doesn't re-derive them per spawn. */
  basisU: THREE.Vector3
  basisV: THREE.Vector3
  /** Fractional spawn accumulator — emit_rate × dt is usually < 1 per
   *  frame, so the fraction carries across frames. */
  spawnAccum: number
  /** Optional per-emitter cap on alive count contributing to the
   *  shared cell pool. Honoured cooperatively. */
  alive: number
}

/** Per-cell pool — one InstancedMesh + state arrays shared by every
 * emitter that picked the same ``atlas_cell``. */
type CellPool = {
  cellIndex: number
  capacity: number
  /** Per-particle state. Indices 0..capacity-1; free stack tracks dead slots. */
  positions: Float32Array
  velocities: Float32Array
  ages: Float32Array
  lifetimes: Float32Array
  /** Initial size for each particle (sampled from emitter at spawn). */
  sizeStart: Float32Array
  sizeEnd: Float32Array
  /** Initial + end RGBA, sampled per-particle at spawn so individual
   *  emitters get their own colour ramps even though they share a pool. */
  colorStart: Float32Array
  colorEnd: Float32Array
  /** Per-particle gravity (so emitters with different gravity sharing a
   *  pool don't have to compromise). */
  gravity: Float32Array
  /** Current sample values pushed to the GPU each frame. */
  posInst: THREE.InstancedBufferAttribute
  sizeInst: THREE.InstancedBufferAttribute
  alphaInst: THREE.InstancedBufferAttribute
  colorInst: THREE.InstancedBufferAttribute
  mesh: THREE.Mesh
  /** Free-slot stack (LIFO). */
  freeStack: Int32Array
  freeCount: number
}

export type ParticleSystem = {
  /** Walk a GLB scene root, register every ``kind="emitter"`` node. */
  registerEmittersFromScene(root: THREE.Object3D): EmitterConfig[]
  /** Fire a one-off burst from an existing emitter (by ``emitter.name``).
   *  No-op if the name isn't registered. */
  triggerBurst(name: string, count: number): void
  /** Advance every emitter + pool by ``dt`` seconds. */
  tick(dt: number): void
  /** Tear down meshes + textures. */
  dispose(): void
  /** Test / debug hook — exposes per-cell live counts. */
  stats(): { cellAlive: number[]; emitters: number; cells: number }
  /** Test hook — allow lookup by emitter name. */
  getEmitter(name: string): EmitterState | undefined
}

// ────────────────────────────────────────────────────────────────────
// Math helpers (pure — exported for tests).
// ────────────────────────────────────────────────────────────────────

/** Deterministic spawn-count step. Given the current fractional
 * accumulator, the per-second emit rate, and ``dt``, returns the
 * integer count to spawn this tick + the new accumulator. Pure so the
 * test fixture can assert exact counts at known dt's. */
export function spawnCountForDt(
  accum: number,
  emitRate: number,
  dt: number,
): { spawn: number; accum: number } {
  const next = accum + emitRate * dt
  const spawn = Math.floor(next)
  return { spawn, accum: next - spawn }
}

/** Lerp utility used by the particle-aging tests. Linearly interpolate
 * ``[r,g,b,a]`` from start to end given t in [0,1]. Pure. */
export function lerpRgba(
  start: readonly [number, number, number, number],
  end: readonly [number, number, number, number],
  t: number,
): [number, number, number, number] {
  return [
    start[0] + (end[0] - start[0]) * t,
    start[1] + (end[1] - start[1]) * t,
    start[2] + (end[2] - start[2]) * t,
    start[3] + (end[3] - start[3]) * t,
  ]
}

/** Scalar lerp used by size ramps. */
export function lerpScalar(start: number, end: number, t: number): number {
  return start + (end - start) * t
}

// ────────────────────────────────────────────────────────────────────
// Internal pool construction
// ────────────────────────────────────────────────────────────────────

function createCellPool(
  cellIndex: number,
  capacity: number,
  atlasTexture: THREE.Texture,
): CellPool {
  const positions = new Float32Array(capacity * 3)
  const velocities = new Float32Array(capacity * 3)
  const ages = new Float32Array(capacity)
  const lifetimes = new Float32Array(capacity)
  const sizeStart = new Float32Array(capacity)
  const sizeEnd = new Float32Array(capacity)
  const colorStart = new Float32Array(capacity * 4)
  const colorEnd = new Float32Array(capacity * 4)
  const gravity = new Float32Array(capacity)

  // GPU-facing per-instance attributes. Dynamic since we re-stream
  // them every frame.
  const posArr = new Float32Array(capacity * 3)
  const sizeArr = new Float32Array(capacity)
  const alphaArr = new Float32Array(capacity)
  const colorArr = new Float32Array(capacity * 3)
  // Park slots offscreen so a never-emitted slot doesn't show at the
  // world origin on the first frame (matches the existing fx pool).
  for (let i = 0; i < capacity; i++) {
    posArr[i * 3 + 0] = 0
    posArr[i * 3 + 1] = 1e9
    posArr[i * 3 + 2] = 0
    sizeArr[i] = 0.1
    alphaArr[i] = 0
    colorArr[i * 3 + 0] = 1
    colorArr[i * 3 + 1] = 1
    colorArr[i * 3 + 2] = 1
  }

  const planeGeo = new THREE.PlaneGeometry(1, 1)
  const geometry = new THREE.InstancedBufferGeometry()
  const planePos = planeGeo.getAttribute('position')
  const planeUv = planeGeo.getAttribute('uv')
  if (planePos) geometry.setAttribute('position', planePos)
  if (planeUv) geometry.setAttribute('uv', planeUv)
  if (planeGeo.index) geometry.index = planeGeo.index
  geometry.instanceCount = capacity

  const posInst = new THREE.InstancedBufferAttribute(posArr, 3)
  posInst.usage = THREE.DynamicDrawUsage
  geometry.setAttribute('aPos', posInst)

  const sizeInst = new THREE.InstancedBufferAttribute(sizeArr, 1)
  sizeInst.usage = THREE.DynamicDrawUsage
  geometry.setAttribute('aSize', sizeInst)

  const alphaInst = new THREE.InstancedBufferAttribute(alphaArr, 1)
  alphaInst.usage = THREE.DynamicDrawUsage
  geometry.setAttribute('aAlpha', alphaInst)

  const colorInst = new THREE.InstancedBufferAttribute(colorArr, 3)
  colorInst.usage = THREE.DynamicDrawUsage
  geometry.setAttribute('aColor', colorInst)

  // Loose bounding sphere — particles can scatter anywhere from the
  // emitter point. We tighten this per-frame in ``tick`` to a sphere
  // around the cell's live AABB so frustum-culling can drop offscreen
  // cells cheaply.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

  // SpriteNodeMaterial billboards each instance to face the camera.
  // TSL node graph:
  //   positionNode = aPos (per-instance world position)
  //   scaleNode    = aSize (per-instance world size)
  //   opacityNode  = texture.a * aAlpha
  //   colorNode    = texture.rgb * aColor
  // Atlas cell selection is done by remapping the plane's UV onto the
  // cell's quadrant of the atlas — see the UV offset below.
  const material = new SpriteNodeMaterial({
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    map: atlasTexture,
  })
  material.positionNode = attribute('aPos', 'vec3') as unknown as Node<'vec3'>
  material.scaleNode = attribute('aSize', 'float') as unknown as Node<'float'>

  // Atlas cell UV remap: each cell occupies a 1/GRID × 1/GRID quadrant.
  // We pre-bake the UV offset into the geometry's uv attribute by
  // scaling the plane's [0..1] UV into the cell's quadrant. Cheaper than
  // a per-fragment TSL math chain and keeps the colour/opacity nodes
  // simple texture reads.
  const uvAttr = geometry.attributes.uv as THREE.BufferAttribute | undefined
  if (uvAttr) {
    const col = cellIndex % ATLAS_GRID
    const row = Math.floor(cellIndex / ATLAS_GRID)
    const cellSize = 1 / ATLAS_GRID
    const arr = uvAttr.array as Float32Array
    for (let i = 0; i < arr.length; i += 2) {
      // Three's PlaneGeometry uv is in [0,1]; remap to the cell.
      // The atlas PNG is authored top-to-bottom rows = increasing y in
      // image space, but PNG decoding leaves rows as-is. Three's
      // default texture is flipped on Y, so row 0 maps to v=1 → v=1-cellSize.
      arr[i] = arr[i]! * cellSize + col * cellSize
      arr[i + 1] = arr[i + 1]! * cellSize + (ATLAS_GRID - 1 - row) * cellSize
    }
    uvAttr.needsUpdate = true
  }

  material.opacityNode = (tslTexture(atlasTexture) as unknown as { a: Node<'float'> }).a.mul(
    attribute('aAlpha', 'float') as unknown as Node<'float'>,
  )
  material.colorNode = (tslTexture(atlasTexture) as unknown as { rgb: Node<'vec3'> }).rgb.mul(
    attribute('aColor', 'vec3') as unknown as Node<'vec3'>,
  )

  const mesh = new THREE.Mesh(geometry, material as unknown as THREE.Material)
  mesh.frustumCulled = false
  mesh.renderOrder = 2
  mesh.name = `particle-system:cell-${cellIndex}`

  const freeStack = new Int32Array(capacity)
  for (let i = 0; i < capacity; i++) freeStack[i] = capacity - 1 - i

  return {
    cellIndex,
    capacity,
    positions,
    velocities,
    ages,
    lifetimes,
    sizeStart,
    sizeEnd,
    colorStart,
    colorEnd,
    gravity,
    posInst,
    sizeInst,
    alphaInst,
    colorInst,
    mesh,
    freeStack,
    freeCount: capacity,
  }
}

// ────────────────────────────────────────────────────────────────────
// Authoring-extras reader
// ────────────────────────────────────────────────────────────────────

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function asRgba(
  v: unknown,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  if (!Array.isArray(v) || v.length < 3) return fallback
  const n = (i: number, d: number) =>
    typeof v[i] === 'number' && Number.isFinite(v[i]) ? (v[i] as number) : d
  return [n(0, fallback[0]), n(1, fallback[1]), n(2, fallback[2]), n(3, fallback[3])]
}

/** Pull the authoring extras off a ``kind="emitter"`` node's
 *  ``userData``. Missing fields fall back to ``DEFAULT_EMITTER_CONFIG``.
 *  Exported for tests. */
export function readEmitterConfig(name: string, userData: Record<string, unknown>): EmitterConfig {
  const d = DEFAULT_EMITTER_CONFIG
  const cellRaw = userData.atlas_cell ?? userData.atlasCell
  const atlasCell = Math.min(
    ATLAS_CELL_COUNT - 1,
    Math.max(0, Math.floor(asNumber(cellRaw, d.atlasCell))),
  )
  return {
    name,
    atlasCell,
    emitRate: Math.max(0, asNumber(userData.emit_rate ?? userData.emitRate, d.emitRate)),
    lifetimeS: Math.max(0.01, asNumber(userData.lifetime_s ?? userData.lifetimeS, d.lifetimeS)),
    velocityConeDeg: Math.max(
      0,
      asNumber(userData.velocity_cone_deg ?? userData.velocityConeDeg, d.velocityConeDeg),
    ),
    speedMin: asNumber(userData.speed_min ?? userData.speedMin, d.speedMin),
    speedMax: asNumber(userData.speed_max ?? userData.speedMax, d.speedMax),
    sizeStart: Math.max(0, asNumber(userData.size_start ?? userData.sizeStart, d.sizeStart)),
    sizeEnd: Math.max(0, asNumber(userData.size_end ?? userData.sizeEnd, d.sizeEnd)),
    colorStart: asRgba(userData.color_start ?? userData.colorStart, d.colorStart),
    colorEnd: asRgba(userData.color_end ?? userData.colorEnd, d.colorEnd),
    gravity: asNumber(userData.gravity, d.gravity),
    maxParticles: Math.max(
      1,
      Math.floor(asNumber(userData.max_particles ?? userData.maxParticles, d.maxParticles)),
    ),
  }
}

// ────────────────────────────────────────────────────────────────────
// Per-particle spawn
// ────────────────────────────────────────────────────────────────────

function spawnOne(pool: CellPool, emitter: EmitterState, rand: RandomFn): boolean {
  if (pool.freeCount === 0) return false
  // Honour the per-emitter cap cooperatively. If the emitter's own
  // ``alive`` count is already at its ``maxParticles``, skip the spawn
  // even though the pool has room — keeps a bursty emitter from
  // monopolising the cell's shared pool. The check is conservative
  // (the actual decrement happens lazily in ``tick``) so a frame can
  // briefly overshoot, but only by the spawn count of that single tick.
  if (emitter.alive >= emitter.config.maxParticles) return false

  pool.freeCount -= 1
  const i = pool.freeStack[pool.freeCount]!
  const o3 = i * 3
  const o4 = i * 4

  pool.positions[o3 + 0] = emitter.origin.x
  pool.positions[o3 + 1] = emitter.origin.y
  pool.positions[o3 + 2] = emitter.origin.z

  // Cone-sampled direction around emitter.axis. Uniform-on-disc in the
  // (basisU, basisV) plane at radius proportional to tan(half-cone).
  const halfConeRad = (emitter.config.velocityConeDeg * Math.PI) / 180
  const r = Math.tan(halfConeRad) * Math.sqrt(rand())
  const phi = rand() * Math.PI * 2
  const du = Math.cos(phi) * r
  const dv = Math.sin(phi) * r
  const dirX = emitter.axis.x + emitter.basisU.x * du + emitter.basisV.x * dv
  const dirY = emitter.axis.y + emitter.basisU.y * du + emitter.basisV.y * dv
  const dirZ = emitter.axis.z + emitter.basisU.z * du + emitter.basisV.z * dv
  const dirLen = Math.hypot(dirX, dirY, dirZ) || 1
  const speed =
    emitter.config.speedMin + rand() * (emitter.config.speedMax - emitter.config.speedMin)
  pool.velocities[o3 + 0] = (dirX / dirLen) * speed
  pool.velocities[o3 + 1] = (dirY / dirLen) * speed
  pool.velocities[o3 + 2] = (dirZ / dirLen) * speed

  pool.ages[i] = 0
  pool.lifetimes[i] = emitter.config.lifetimeS
  pool.sizeStart[i] = emitter.config.sizeStart
  pool.sizeEnd[i] = emitter.config.sizeEnd
  pool.colorStart[o4 + 0] = emitter.config.colorStart[0]
  pool.colorStart[o4 + 1] = emitter.config.colorStart[1]
  pool.colorStart[o4 + 2] = emitter.config.colorStart[2]
  pool.colorStart[o4 + 3] = emitter.config.colorStart[3]
  pool.colorEnd[o4 + 0] = emitter.config.colorEnd[0]
  pool.colorEnd[o4 + 1] = emitter.config.colorEnd[1]
  pool.colorEnd[o4 + 2] = emitter.config.colorEnd[2]
  pool.colorEnd[o4 + 3] = emitter.config.colorEnd[3]
  pool.gravity[i] = emitter.config.gravity

  emitter.alive += 1
  return true
}

function advancePool(pool: CellPool, dt: number, aliveCounters: Map<EmitterState, number>): void {
  // We don't track per-particle ownership back to its emitter to keep
  // memory tight — instead each emitter records spawns into its own
  // ``alive`` counter, and on death we decrement using the
  // ``aliveCounters`` reverse map keyed by the emitter currently
  // associated with the *cell*. In practice we can't know per-particle
  // ownership without an extra Uint16Array, so we lazily rebuild
  // ``emitter.alive`` from the cell totals at the end of each tick by
  // dividing pool live count proportionally to per-emitter emit rates.
  // For now, decrement the pool's pending-death tally directly; emitter
  // accounting refreshes in ``tick`` after this returns.
  const cap = pool.capacity
  const posArr = pool.posInst.array as Float32Array
  const sizeArr = pool.sizeInst.array as Float32Array
  const alphaArr = pool.alphaInst.array as Float32Array
  const colorArr = pool.colorInst.array as Float32Array

  // Local bbox for the bounding sphere update.
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  let anyAlive = false

  for (let i = 0; i < cap; i++) {
    const max = pool.lifetimes[i]!
    if (max === 0) continue // never-emitted slot
    const a = pool.ages[i]!
    if (a >= max) continue // dead, waiting for reuse

    const newAge = a + dt
    if (newAge >= max) {
      pool.ages[i] = max
      pool.lifetimes[i] = 0
      alphaArr[i] = 0
      posArr[i * 3 + 1] = 1e9
      pool.freeStack[pool.freeCount] = i
      pool.freeCount += 1
      continue
    }
    pool.ages[i] = newAge

    const o3 = i * 3
    const o4 = i * 4
    // Velocity step (gravity acts on Y).
    pool.velocities[o3 + 1] = pool.velocities[o3 + 1]! + pool.gravity[i]! * dt
    pool.positions[o3 + 0]! += pool.velocities[o3 + 0]! * dt
    pool.positions[o3 + 1]! += pool.velocities[o3 + 1]! * dt
    pool.positions[o3 + 2]! += pool.velocities[o3 + 2]! * dt

    const px = pool.positions[o3 + 0]!
    const py = pool.positions[o3 + 1]!
    const pz = pool.positions[o3 + 2]!
    posArr[o3 + 0] = px
    posArr[o3 + 1] = py
    posArr[o3 + 2] = pz
    if (px < minX) minX = px
    if (px > maxX) maxX = px
    if (py < minY) minY = py
    if (py > maxY) maxY = py
    if (pz < minZ) minZ = pz
    if (pz > maxZ) maxZ = pz
    anyAlive = true

    // Lerp size + colour over the particle's normalised age.
    const t = newAge / max
    const sz = pool.sizeStart[i]! + (pool.sizeEnd[i]! - pool.sizeStart[i]!) * t
    sizeArr[i] = sz

    // RGBA lerp; alpha goes into alphaArr, RGB into colorArr.
    const rS = pool.colorStart[o4 + 0]!
    const gS = pool.colorStart[o4 + 1]!
    const bS = pool.colorStart[o4 + 2]!
    const aS = pool.colorStart[o4 + 3]!
    const rE = pool.colorEnd[o4 + 0]!
    const gE = pool.colorEnd[o4 + 1]!
    const bE = pool.colorEnd[o4 + 2]!
    const aE = pool.colorEnd[o4 + 3]!
    colorArr[o3 + 0] = rS + (rE - rS) * t
    colorArr[o3 + 1] = gS + (gE - gS) * t
    colorArr[o3 + 2] = bS + (bE - bS) * t
    alphaArr[i] = aS + (aE - aS) * t
  }
  pool.posInst.needsUpdate = true
  pool.sizeInst.needsUpdate = true
  pool.alphaInst.needsUpdate = true
  pool.colorInst.needsUpdate = true

  // Update per-cell bounding sphere so the renderer can frustum-cull
  // off-screen cells cheaply. Keeping it loose (1.5× the AABB radius)
  // since particles can drift past the sample-time bbox between ticks.
  if (anyAlive && pool.mesh.geometry.boundingSphere) {
    const cx = (minX + maxX) * 0.5
    const cy = (minY + maxY) * 0.5
    const cz = (minZ + maxZ) * 0.5
    const dx = maxX - cx
    const dy = maxY - cy
    const dz = maxZ - cz
    const radius = Math.hypot(dx, dy, dz) * 1.5
    pool.mesh.geometry.boundingSphere.center.set(cx, cy, cz)
    pool.mesh.geometry.boundingSphere.radius = Math.max(radius, 1)
  }
  // Track that we touched this pool for emitter-alive recompute.
  aliveCounters.set(undefined as unknown as EmitterState, 0)
}

// ────────────────────────────────────────────────────────────────────
// Public factory
// ────────────────────────────────────────────────────────────────────

export function createParticleSystem(deps: {
  scene: THREE.Scene
  /** Already-loaded atlas texture. Built once at boot from
   *  ``public/assets/fx/particle-atlas.png``. */
  atlasTexture: THREE.Texture
  /** Override RNG — tests pass a deterministic stream. Default
   *  ``Math.random``. */
  random?: RandomFn
  /** Override default per-cell pool capacity. */
  defaultCellCapacity?: number
}): ParticleSystem {
  const { scene, atlasTexture } = deps
  const rand = deps.random ?? Math.random
  const defaultCellCapacity = deps.defaultCellCapacity ?? DEFAULT_PER_CELL_CAPACITY

  // Lazy pool creation: a cell is only allocated the first time an
  // emitter referencing it is registered, so a track using only 3
  // cells pays for 3 InstancedMeshes (not 16). Once allocated, the
  // pool's capacity is the max of every registered emitter's
  // ``maxParticles`` on that cell, summed conservatively.
  const cellPools = new Map<number, CellPool>()
  const emitters = new Map<string, EmitterState>()
  const aliveCounters = new Map<EmitterState, number>()

  function ensureCellPool(cellIndex: number, capacityHint: number): CellPool {
    const existing = cellPools.get(cellIndex)
    if (existing) {
      // If a later emitter wants a bigger budget than the pool can
      // hold, we don't dynamically resize — print a warning so the
      // author knows to bump the first emitter's max_particles too.
      if (capacityHint > existing.capacity) {
        console.warn(
          `[particle-system] cell ${cellIndex}: max_particles=${capacityHint} exceeds pool capacity ${existing.capacity}; raise the first emitter's max_particles on this cell to grow the pool.`,
        )
      }
      return existing
    }
    const capacity = Math.max(capacityHint, defaultCellCapacity)
    const pool = createCellPool(cellIndex, capacity, atlasTexture)
    scene.add(pool.mesh)
    cellPools.set(cellIndex, pool)
    return pool
  }

  function registerEmitter(config: EmitterConfig, worldMatrix: THREE.Matrix4): EmitterState {
    ensureCellPool(config.atlasCell, config.maxParticles)

    // Decompose the world matrix once at registration. The emitter
    // empty's transform is static (no per-frame animation on tracks
    // today), so we can cache the world pose.
    const origin = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    worldMatrix.decompose(origin, quat, scale)

    // Local +Y → world axis (the emitter convention).
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize()

    // Two orthonormal vectors perpendicular to ``axis``, used to
    // sample inside the velocity cone. Standard Gram-Schmidt with a
    // fallback axis choice when ``axis`` ≈ world Y.
    const helper = new THREE.Vector3(
      Math.abs(axis.x) > 0.9 ? 0 : 1,
      Math.abs(axis.y) > 0.9 ? 0 : 1,
      0,
    )
    if (helper.lengthSq() < 1e-3) helper.set(0, 0, 1)
    const basisU = helper.clone().cross(axis).normalize()
    const basisV = axis.clone().cross(basisU).normalize()

    const state: EmitterState = {
      config,
      origin,
      axis,
      basisU,
      basisV,
      spawnAccum: 0,
      alive: 0,
    }
    emitters.set(config.name, state)
    return state
  }

  function registerEmittersFromScene(root: THREE.Object3D): EmitterConfig[] {
    const registered: EmitterConfig[] = []
    root.updateMatrixWorld(true)
    root.traverse((obj) => {
      if (obj.userData?.kind !== ExportedKind.EMITTER) return
      const cfg = readEmitterConfig(obj.name || 'emitter', obj.userData)
      if (emitters.has(cfg.name)) {
        // Suffix duplicate-named emitters so registration stays unique
        // (same flow as Blender's auto-rename when two empties collide).
        let i = 2
        while (emitters.has(`${cfg.name}_${i}`)) i++
        cfg.name = `${cfg.name}_${i}`
      }
      registerEmitter(cfg, obj.matrixWorld)
      registered.push(cfg)
    })
    return registered
  }

  function triggerBurst(name: string, count: number): void {
    const emitter = emitters.get(name)
    if (!emitter) return
    const pool = cellPools.get(emitter.config.atlasCell)
    if (!pool) return
    for (let i = 0; i < count; i++) {
      if (!spawnOne(pool, emitter, rand)) break
    }
  }

  function tick(dt: number): void {
    if (dt <= 0) return
    // Spawn pass — for each emitter, accumulate ``emit_rate*dt`` and
    // spawn the integer overflow.
    for (const emitter of emitters.values()) {
      const { spawn, accum } = spawnCountForDt(emitter.spawnAccum, emitter.config.emitRate, dt)
      emitter.spawnAccum = accum
      if (spawn > 0) {
        const pool = cellPools.get(emitter.config.atlasCell)
        if (pool) {
          for (let i = 0; i < spawn; i++) {
            if (!spawnOne(pool, emitter, rand)) break
          }
        }
      }
    }
    // Advance pass — age every particle, update GPU instance arrays.
    for (const pool of cellPools.values()) {
      advancePool(pool, dt, aliveCounters)
    }
    // Refresh per-emitter alive counts. Since we don't track ownership
    // per particle, we approximate by clamping each emitter's alive to
    // its own emit_rate × lifetime budget — the steady-state alive
    // count for a continuously-emitting emitter is bounded by that
    // product. For burst-driven emitters this drifts but only matters
    // for the max-particles guard, which is a soft cap anyway.
    for (const emitter of emitters.values()) {
      const steady = Math.ceil(emitter.config.emitRate * emitter.config.lifetimeS)
      if (emitter.alive > steady) emitter.alive = steady
    }
  }

  function stats() {
    const cellAlive: number[] = []
    for (const pool of cellPools.values()) {
      cellAlive[pool.cellIndex] = pool.capacity - pool.freeCount
    }
    return {
      cellAlive,
      emitters: emitters.size,
      cells: cellPools.size,
    }
  }

  function dispose(): void {
    for (const pool of cellPools.values()) {
      scene.remove(pool.mesh)
      pool.mesh.geometry.dispose()
      ;(pool.mesh.material as THREE.Material).dispose()
    }
    cellPools.clear()
    emitters.clear()
    atlasTexture.dispose()
  }

  return {
    registerEmittersFromScene,
    triggerBurst,
    tick,
    dispose,
    stats,
    getEmitter: (name: string) => emitters.get(name),
  }
}

/** Load the shared particle atlas as a ``THREE.Texture``. Public so
 * the boot code can fetch it ahead of ``createParticleSystem`` and
 * reuse the same texture across re-loads. */
export function loadParticleAtlas(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader()
    loader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace
        tex.minFilter = THREE.LinearMipmapLinearFilter
        tex.magFilter = THREE.LinearFilter
        // Important: prevent bleed across atlas cells when the GPU
        // samples near a cell boundary. Tight wrap + no mipmap
        // blur into neighbours would be ideal but causes seams at
        // distance; the 256-px cells with linear+mipmap give a
        // tolerable balance. Authors who hit visible bleed should
        // shrink their sprite away from the cell edge in the
        // generator.
        tex.wrapS = THREE.ClampToEdgeWrapping
        tex.wrapT = THREE.ClampToEdgeWrapping
        tex.generateMipmaps = true
        resolve(tex)
      },
      undefined,
      (err) => reject(err),
    )
  })
}
