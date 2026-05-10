import { hasComponent, query } from 'bitecs'
import * as THREE from 'three'
import { attribute, texture as tslTexture } from 'three/tsl'
import { SpriteNodeMaterial } from 'three/webgpu'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import {
  BikeTag,
  HoverState,
  HoverStateStore,
  RBHandle,
  RBHandleStore,
  Transform,
  TransformStore,
} from '@/game/components'

/**
 * Hand-rolled particle FX driven by TSL node materials.
 *
 * One `THREE.InstancedMesh` per effect type, capacity-bounded, with a
 * CPU-side Float32Array pool for state (position / velocity / age) and a
 * `SpriteNodeMaterial` that auto-billboards each instance to face the
 * camera. Per-instance alpha is fed in as an `InstancedBufferAttribute`
 * read by the material's `opacityNode` TSL graph, so each particle fades
 * independently over its own lifetime. The graph compiles to WGSL on
 * WebGPU and GLSL on the WebGL2 fallback via the same NodeBuilder as the
 * water shader, so particles work on every backend the renderer supports.
 *
 * Why InstancedMesh over `THREE.Points`: WebGPU silently caps point
 * primitives at 1 pixel regardless of `material.size`, making Points
 * invisible. Three.js docs explicitly recommend instanced sprites for
 * sized particles on WebGPU.
 *
 * Why not three.quarks: that library builds a classic `THREE.ShaderMaterial`
 * internally, which the project's `WebGPURenderer` rejects with
 * `THREE.NodeBuilder: Material "ShaderMaterial" is not compatible.`
 *
 * Why not TSL compute shaders (the webgpu_compute_particles pattern): they
 * are WebGPU-only and would force-drop the WebGL2 fallback the renderer
 * still supports. At our scale (~1–3 K particles peak) the boilerplate buys
 * nothing perceptual. CPU-side state is plenty fast and keeps every effect
 * working on both backends.
 *
 * Effect routing — read-only of HoverState + the rigid-body's velocity, so
 * FX never feeds back into the sim:
 *   foam   → emitted while `isGrounded && surfaceIsWater && speed > FOAM_MIN`
 *   sparks → emitted while `isGrounded && !surfaceIsWater && speed > SPARK_MIN`
 *
 * Pools are shared across all bikes to keep this at one draw call per
 * effect type regardless of racer count.
 */

// Per-effect emission tuning. Rates ramp linearly between MIN and FULL speed.
const FOAM_MAX_RATE = 80 // particles/sec at full strength (per bike)
const SPARK_MAX_RATE = 60
const FOAM_SPEED_FULL = 25
const SPARK_SPEED_FULL = 30
const FOAM_MIN_SPEED = 3
const SPARK_MIN_SPEED = 8
// Emission origin in bike-local coords. The bike's render-systems.ts
// applies a 2× visual scale to the mesh while keeping the physics body
// at authored size — the bike's *transform* still uses physics-space
// coordinates, so these offsets are scaled to land at the visible stern
// (foam) and visible base (sparks) of the rendered bike.
const STERN_OFFSET = new THREE.Vector3(0, 0.1, -1.4)
const SPARK_OFFSET = new THREE.Vector3(0, -0.2, 0)

// Pool capacities — sized for ~5–8 bikes at full emission. Foam drifts
// longer (lifetime ~1 s, rate ~80/s → ~80 alive per bike), so 480 covers
// six emitting bikes with margin. Sparks are short (lifetime ~0.4 s, rate
// ~60/s → ~24 alive per bike), so 200 is comfortable.
const FOAM_CAPACITY = 480
const SPARK_CAPACITY = 200

function makeRadialTexture(rgb: [number, number, number]): THREE.Texture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('fx: 2d context unavailable')
  const c = size / 2
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c)
  const [r, g, b] = rgb
  grad.addColorStop(0, `rgba(${r},${g},${b},1)`)
  grad.addColorStop(0.4, `rgba(${r},${g},${b},0.55)`)
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  return tex
}

type Pool = {
  capacity: number
  /** Per-particle state arrays (CPU). Indices 0..capacity-1. */
  positions: Float32Array
  velocities: Float32Array
  ages: Float32Array // current age in seconds
  maxAges: Float32Array // lifetime in seconds
  /** Per-instance world size (sprite quad scale). */
  sizes: Float32Array
  /** Per-instance alpha [0, 1]. */
  alphas: Float32Array
  /** Free-slot stack — indices of dead particles ready to be reused. */
  freeStack: Int32Array
  freeCount: number
  /** Default world-space sprite size used when emit() doesn't override. */
  defaultSize: number
  /** GPU-facing instance buffers. We bump needsUpdate per frame. */
  posInstAttr: THREE.InstancedBufferAttribute
  alphaInstAttr: THREE.InstancedBufferAttribute
  sizeInstAttr: THREE.InstancedBufferAttribute
  mesh: THREE.Mesh
  /** Constant Y acceleration (m/s²). +ve = upward (foam). -ve = gravity (sparks). */
  gravity: number
  /** Linear drag coefficient applied to velocity each step. */
  drag: number
}

function createPool(params: {
  capacity: number
  defaultSize: number
  texture: THREE.Texture
  blending: THREE.Blending
  gravity: number
  drag: number
}): Pool {
  const { capacity, defaultSize, texture, blending, gravity, drag } = params

  const positions = new Float32Array(capacity * 3)
  const velocities = new Float32Array(capacity * 3)
  const ages = new Float32Array(capacity)
  const maxAges = new Float32Array(capacity)
  const sizes = new Float32Array(capacity)
  const alphas = new Float32Array(capacity)

  // All slots start free.
  const freeStack = new Int32Array(capacity)
  for (let i = 0; i < capacity; i++) freeStack[i] = capacity - 1 - i
  const freeCount = capacity

  // Park dead instances at +inf so the GPU clips them — alpha=0 covers it
  // for the fragment, but parking also keeps the SpriteNodeMaterial's
  // billboard math from compositing instances at world origin during the
  // first frame when nothing has been emitted yet.
  for (let i = 0; i < capacity; i++) {
    positions[i * 3 + 0] = 0
    positions[i * 3 + 1] = 1e9
    positions[i * 3 + 2] = 0
    sizes[i] = defaultSize
  }

  // Shared 1×1 plane geometry — SpriteNodeMaterial billboards it to face
  // the camera. We build an InstancedBufferGeometry on top so we can
  // attach per-instance position/alpha/size attributes.
  const planeGeo = new THREE.PlaneGeometry(1, 1)
  const geometry = new THREE.InstancedBufferGeometry()
  const planePos = planeGeo.getAttribute('position')
  const planeUv = planeGeo.getAttribute('uv')
  if (planePos) geometry.setAttribute('position', planePos)
  if (planeUv) geometry.setAttribute('uv', planeUv)
  if (planeGeo.index) geometry.index = planeGeo.index
  geometry.instanceCount = capacity

  const posInstAttr = new THREE.InstancedBufferAttribute(positions, 3)
  posInstAttr.usage = THREE.DynamicDrawUsage
  geometry.setAttribute('aPos', posInstAttr)

  const alphaInstAttr = new THREE.InstancedBufferAttribute(alphas, 1)
  alphaInstAttr.usage = THREE.DynamicDrawUsage
  geometry.setAttribute('aAlpha', alphaInstAttr)

  const sizeInstAttr = new THREE.InstancedBufferAttribute(sizes, 1)
  sizeInstAttr.usage = THREE.DynamicDrawUsage
  geometry.setAttribute('aSize', sizeInstAttr)

  // Loose bounding sphere — particles can be anywhere in the racing area;
  // skipping frustum culling on the mesh handles the rest.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

  const material = new SpriteNodeMaterial({
    transparent: true,
    blending,
    depthWrite: false,
    map: texture,
  })
  // Position each sprite's center at the per-instance world position.
  material.positionNode = attribute('aPos', 'vec3')
  // Per-instance uniform scale (the y is implied by the sprite's billboard
  // math which uses the same value).
  material.scaleNode = attribute('aSize', 'float')
  // Modulate texture alpha by the per-instance aAlpha so each particle
  // fades over its own lifetime independently.
  material.opacityNode = tslTexture(texture).a.mul(attribute('aAlpha', 'float'))
  // Texture RGB is pre-tinted at canvas creation time; pass through.
  material.colorNode = tslTexture(texture).rgb

  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 2

  return {
    capacity,
    positions,
    velocities,
    ages,
    maxAges,
    sizes,
    alphas,
    freeStack,
    freeCount,
    defaultSize,
    posInstAttr,
    alphaInstAttr,
    sizeInstAttr,
    mesh,
    gravity,
    drag,
  }
}

// Spawn `n` particles at (x,y,z) with velocities sampled in a cone around
// (vx,vy,vz). Caller-supplied lifetime + velocity-jitter shape the effect.
function emit(
  pool: Pool,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  jitter: number,
  lifeMin: number,
  lifeMax: number,
  size: number,
  count: number,
): void {
  for (let k = 0; k < count; k++) {
    if (pool.freeCount === 0) return
    pool.freeCount -= 1
    const i = pool.freeStack[pool.freeCount]!
    const o3 = i * 3
    pool.positions[o3 + 0] = x
    pool.positions[o3 + 1] = y
    pool.positions[o3 + 2] = z
    // Random unit vector for jitter direction.
    const u = Math.random() * 2 - 1
    const t = Math.random() * Math.PI * 2
    const r = Math.sqrt(1 - u * u)
    pool.velocities[o3 + 0] = vx + Math.cos(t) * r * jitter
    pool.velocities[o3 + 1] = vy + u * jitter
    pool.velocities[o3 + 2] = vz + Math.sin(t) * r * jitter
    pool.ages[i] = 0
    pool.maxAges[i] = lifeMin + Math.random() * (lifeMax - lifeMin)
    pool.sizes[i] = size
    // Initial alpha = 1; advance() will fade.
    pool.alphas[i] = 1
  }
}

function advance(pool: Pool, dt: number): void {
  const cap = pool.capacity
  const dragK = Math.exp(-pool.drag * dt) // exponential decay each step
  for (let i = 0; i < cap; i++) {
    const a = pool.ages[i]!
    const max = pool.maxAges[i]!
    if (max === 0) continue // never-emitted slot
    if (a >= max) continue // dead, will be reused on next emit
    const newAge = a + dt
    if (newAge >= max) {
      // Just expired — park offscreen, push to free stack.
      pool.ages[i] = max
      pool.alphas[i] = 0
      pool.positions[i * 3 + 1] = 1e9
      pool.freeStack[pool.freeCount] = i
      pool.freeCount += 1
      continue
    }
    pool.ages[i] = newAge
    const o3 = i * 3
    // Integrate velocity + gravity, apply drag.
    pool.velocities[o3 + 0]! *= dragK
    pool.velocities[o3 + 1] = pool.velocities[o3 + 1]! * dragK + pool.gravity * dt
    pool.velocities[o3 + 2]! *= dragK
    pool.positions[o3 + 0]! += pool.velocities[o3 + 0]! * dt
    pool.positions[o3 + 1]! += pool.velocities[o3 + 1]! * dt
    pool.positions[o3 + 2]! += pool.velocities[o3 + 2]! * dt
    // Quadratic alpha falloff feels softer than linear for sprite particles.
    const lifeFrac = newAge / max
    pool.alphas[i] = (1 - lifeFrac) * (1 - lifeFrac)
  }
  pool.posInstAttr.needsUpdate = true
  pool.alphaInstAttr.needsUpdate = true
  pool.sizeInstAttr.needsUpdate = true
}

export function createFxSystem(scene: THREE.Scene, sim: SimWorld, phys: PhysicsWorld) {
  const foamTex = makeRadialTexture([235, 245, 255])
  const sparkTex = makeRadialTexture([255, 200, 120])

  const foam = createPool({
    capacity: FOAM_CAPACITY,
    // Sized to visually match the 2× scale bike's stern footprint.
    defaultSize: 1.0,
    texture: foamTex,
    blending: THREE.NormalBlending,
    gravity: 1.4, // slight upward drift (Y is up)
    drag: 1.6,
  })
  const sparks = createPool({
    capacity: SPARK_CAPACITY,
    defaultSize: 0.25,
    texture: sparkTex,
    blending: THREE.AdditiveBlending,
    gravity: -16,
    drag: 0.8,
  })

  scene.add(foam.mesh)
  scene.add(sparks.mesh)

  // Reusable scratch math.
  const sternWorld = new THREE.Vector3()
  const sparkWorld = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  const tmpPos = new THREE.Vector3()
  const fwd = new THREE.Vector3()

  // Per-bike fractional emission accumulators — emit rate × dt is usually
  // < 1 per frame, so we accumulate the fraction across frames and emit
  // when it crosses a whole particle. Map<eid, { foam, sparks }>.
  const emitAccum = new Map<number, { foam: number; sparks: number }>()

  // Debug hook so the headed-browser verification can introspect rates,
  // free-slot counts, and live-particle counts. Removed when the dust
  // settles, but cheap to keep in dev. Strip in a future cleanup pass.
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __fx?: unknown }).__fx = {
      foam,
      sparks,
      emitAccum,
      stats: () => ({
        foamAlive: foam.capacity - foam.freeCount,
        sparkAlive: sparks.capacity - sparks.freeCount,
        foamFirstAlive: (() => {
          for (let i = 0; i < foam.capacity; i++) {
            if (foam.alphas[i]! > 0) {
              return {
                i,
                x: foam.positions[i * 3 + 0],
                y: foam.positions[i * 3 + 1],
                z: foam.positions[i * 3 + 2],
                size: foam.sizes[i],
                alpha: foam.alphas[i],
              }
            }
          }
          return null
        })(),
      }),
    }
  }

  return function tick(dt: number): void {
    const eids = query(sim, [BikeTag, Transform, HoverState])

    for (const eid of eids) {
      if (!hasComponent(sim, eid, RBHandle)) continue
      const rbh = RBHandleStore.must(eid)
      const rb = phys.world.getRigidBody(rbh.handle)
      if (!rb) continue
      const transform = TransformStore.must(eid)
      const hover = HoverStateStore.must(eid)
      const v = rb.linvel()
      const speed = Math.hypot(v.x, v.z)

      tmpQuat.set(transform.qx, transform.qy, transform.qz, transform.qw)
      tmpPos.set(transform.x, transform.y, transform.z)

      let acc = emitAccum.get(eid)
      if (!acc) {
        acc = { foam: 0, sparks: 0 }
        emitAccum.set(eid, acc)
      }

      // Foam — bike stern, water + speed.
      if (hover.isGrounded && hover.surfaceIsWater && speed > FOAM_MIN_SPEED) {
        const rate =
          Math.min(1, (speed - FOAM_MIN_SPEED) / (FOAM_SPEED_FULL - FOAM_MIN_SPEED)) *
          FOAM_MAX_RATE
        acc.foam += rate * dt
        const n = Math.floor(acc.foam)
        if (n > 0) {
          acc.foam -= n
          sternWorld.copy(STERN_OFFSET).applyQuaternion(tmpQuat).add(tmpPos)
          // Toss puffs slightly outward (away from bike heading) so the
          // wake reads as a fan, not a solid stripe. Forward direction:
          // bike-fwd in world is (sin(yaw), 0, cos(yaw)).
          fwd.set(0, 0, -1).applyQuaternion(tmpQuat) // backward in bike-local
          emit(
            foam,
            sternWorld.x,
            sternWorld.y,
            sternWorld.z,
            fwd.x * 1.5,
            0.4,
            fwd.z * 1.5,
            1.2,
            0.6,
            1.0,
            // Slight per-particle size jitter so the wake reads as varied
            // puffs rather than uniform stamps.
            foam.defaultSize * (0.7 + Math.random() * 0.6),
            n,
          )
        }
      } else {
        acc.foam = 0
      }

      // Sparks — bike base, land + speed.
      if (hover.isGrounded && !hover.surfaceIsWater && speed > SPARK_MIN_SPEED) {
        const rate =
          Math.min(1, (speed - SPARK_MIN_SPEED) / (SPARK_SPEED_FULL - SPARK_MIN_SPEED)) *
          SPARK_MAX_RATE
        acc.sparks += rate * dt
        const n = Math.floor(acc.sparks)
        if (n > 0) {
          acc.sparks -= n
          sparkWorld.copy(SPARK_OFFSET).applyQuaternion(tmpQuat).add(tmpPos)
          emit(
            sparks,
            sparkWorld.x,
            sparkWorld.y,
            sparkWorld.z,
            0,
            2,
            0,
            5,
            0.25,
            0.5,
            sparks.defaultSize * (0.6 + Math.random() * 0.8),
            n,
          )
        }
      } else {
        acc.sparks = 0
      }
    }

    advance(foam, dt)
    advance(sparks, dt)
  }
}
