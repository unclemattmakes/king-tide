import { hasComponent, query } from 'bitecs'
import * as THREE from 'three'
import { attribute, texture as tslTexture } from 'three/tsl'
import { SpriteNodeMaterial } from 'three/webgpu'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import {
  BikeTag,
  ControlIntent,
  ControlIntentStore,
  HoverState,
  HoverStateStore,
  RBHandle,
  RBHandleStore,
  Transform,
  TransformStore,
} from '@/game/components'
import {
  ExplosionState,
  ExplosionStateStore,
  ExplosionTag,
  MissileState,
  MissileStateStore,
  MissileTag,
} from '@/game/components/combat'

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
// 80/s × ~0.8 s avg life ≈ 64 alive per bike at top speed — enough for a
// clean Kelvin-style V wake without over-saturating the surface.
const FOAM_MAX_RATE = 80 // particles/sec at full strength (per bike)
const FOAM_SPEED_FULL = 25
const FOAM_MIN_SPEED = 3
// V-wake half-angle. The Kelvin wake is ~19° in nature; a touch wider
// reads more visible at game scale and matches the water shader wake.
const FOAM_V_HALF_ANGLE = 0.55 // ~31°

// Sparks fire only when the bike is genuinely scraping ground — not
// while hovering at normal height. Threshold sits well below the bike's
// 1.2 m hover target so casual driving over land doesn't shed sparks;
// only ramps, curbs, hard bottom-outs (groundDistance pushed near zero
// by the spring overshoot or a vertical impact) trigger them.
const SPARK_MAX_RATE = 80
const SPARK_MIN_SPEED = 4
const SPARK_SPEED_FULL = 22
const SPARK_GROUND_DIST_MAX = 0.4

// Dust kicked up by the hover thrust when the bike is *near* the ground
// but not scraping it — i.e. cruising in the hover zone over land. Reads
// as the rotor-wash blowing fine particulate outward in a fan.
const DUST_MAX_RATE = 60
const DUST_MIN_SPEED = 2
const DUST_SPEED_FULL = 18
// Sits just above the spark scrape threshold; ceiling is at ~80% of the
// grounded-cutoff so we never emit dust while airborne.
const DUST_GROUND_DIST_MIN = 0.4
const DUST_GROUND_DIST_MAX = 1.6

// Engine exhaust — emits while the bike is actively throttling. Boost
// (held shift OR a boost pickup) ramps the rate up to BOOST_MAX_RATE
// for that "thruster firing" beat.
const EXHAUST_THROTTLE_RATE = 35 // particles/sec at full forward throttle
const EXHAUST_BOOST_RATE = 90 // additional rate while boost is active
const EXHAUST_THROTTLE_MIN = 0.2 // dead-zone — no exhaust on micro inputs

// Missile trail — fired per frame from each in-flight missile. Reads
// as a smoky exhaust streak in the missile's wake.
const MISSILE_TRAIL_RATE = 35 // particles/sec per missile

// Emission origins in bike-local coords. The bike's render-systems.ts
// applies a 2× visual scale to the mesh while keeping the physics body
// at authored size — the bike's *transform* still uses physics-space
// coordinates, so these offsets are scaled to land at the visible stern
// (foam), visible base (sparks), and visible rear-bottom (exhaust) of
// the rendered bike.
const STERN_OFFSET = new THREE.Vector3(0, 0.1, -1.4)
const SPARK_OFFSET = new THREE.Vector3(0, -0.2, 0)
const EXHAUST_OFFSET = new THREE.Vector3(0, -0.2, -1.6)

// Pool capacities — sized for ~5–8 bikes at full emission. Foam drifts
// longer (lifetime ~1 s, rate ~80/s → ~80 alive per bike), so 480 covers
// six emitting bikes with margin. Sparks are short (lifetime ~0.4 s, rate
// ~60/s → ~24 alive per bike), so 200 is comfortable.
const FOAM_CAPACITY = 480
// Sparks now event-driven only (scrape contact). Few alive at a time.
const SPARK_CAPACITY = 200
// Dust similar shape to foam: continuous emission while in the hover zone
// over land. Lifetime ~0.7 s × ~60/s × ~3 active bikes ≈ 130 alive peak.
const DUST_CAPACITY = 320
// Exhaust: shorter lifetime than foam (~0.5s at boost) but higher peak
// rate when boosting (~125/s = ~63 alive per bike, plus regular throttle
// emission), so 320 covers ~5 boosting bikes plus margin.
const EXHAUST_CAPACITY = 320
// Explosion: bursts of ~30 particles per detonation, lifetime ~0.7 s.
// Peak comes from a multi-mine pile-up — 6 simultaneous = 180 alive.
const EXPLOSION_CAPACITY = 240
// Missile trail: continuous emission along missile path. ~30/s × 0.6 s
// life × up to 4 missiles in flight = ~72 peak; 200 covers boost cases.
const MISSILE_CAPACITY = 200

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
  const exhaustTex = makeRadialTexture([255, 130, 60])
  const dustTex = makeRadialTexture([195, 180, 155])
  const explosionTex = makeRadialTexture([255, 165, 50])
  const missileTrailTex = makeRadialTexture([220, 220, 230])

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
  const exhaust = createPool({
    capacity: EXHAUST_CAPACITY,
    defaultSize: 0.45,
    texture: exhaustTex,
    blending: THREE.AdditiveBlending,
    // Slight upward drift to read as hot air rising; drag dissipates it.
    gravity: 0.8,
    drag: 2.4,
  })
  const dust = createPool({
    capacity: DUST_CAPACITY,
    // Slightly bigger than foam puffs — dust clouds read better at scale.
    defaultSize: 1.2,
    texture: dustTex,
    blending: THREE.NormalBlending,
    // Faint upward drift + heavy drag so puffs hang and dissipate, not
    // shoot like exhaust.
    gravity: 0.3,
    drag: 3.5,
  })
  const explosion = createPool({
    capacity: EXPLOSION_CAPACITY,
    defaultSize: 1.4,
    texture: explosionTex,
    blending: THREE.AdditiveBlending,
    gravity: 1.0, // hot fireball rises briefly
    drag: 2.6,
  })
  const missileTrail = createPool({
    capacity: MISSILE_CAPACITY,
    defaultSize: 0.55,
    texture: missileTrailTex,
    blending: THREE.NormalBlending,
    gravity: 0.6, // smoke rises
    drag: 2.4,
  })

  scene.add(foam.mesh)
  scene.add(sparks.mesh)
  scene.add(exhaust.mesh)
  scene.add(dust.mesh)
  scene.add(explosion.mesh)
  scene.add(missileTrail.mesh)

  // Reusable scratch math.
  const sternWorld = new THREE.Vector3()
  const sparkWorld = new THREE.Vector3()
  const exhaustWorld = new THREE.Vector3()
  const dustWorld = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  const tmpPos = new THREE.Vector3()
  const back = new THREE.Vector3()
  const right = new THREE.Vector3()

  // Per-bike fractional emission accumulators — emit rate × dt is usually
  // < 1 per frame, so we accumulate the fraction across frames and emit
  // when it crosses a whole particle.
  const emitAccum = new Map<
    number,
    { foam: number; sparks: number; exhaust: number; dust: number }
  >()

  // Per-bike transition memory for event-driven bursts. We need the
  // previous frame's grounded state to detect "just landed on water"
  // (splash) and "just touched down hard" (impact dust). Initialised
  // lazily on first sight of each bike.
  const lastGrounded = new Map<number, boolean>()

  // Combat FX bookkeeping. We burst once per explosion entity at
  // detonation, then leave it alone — the engine's explosion system
  // handles its own visual decay. Missile trail emits per-frame from
  // each in-flight missile and uses a fractional accumulator so the
  // trail rate is frame-rate independent.
  const explosionsBurst = new Set<number>()
  const missileEmitAccum = new Map<number, number>()

  // Debug hook so the headed-browser verification can introspect rates,
  // free-slot counts, and live-particle counts. Removed when the dust
  // settles, but cheap to keep in dev. Strip in a future cleanup pass.
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __fx?: unknown }).__fx = {
      foam,
      sparks,
      exhaust,
      dust,
      emitAccum,
      explosion,
      missileTrail,
      stats: () => ({
        foamAlive: foam.capacity - foam.freeCount,
        sparkAlive: sparks.capacity - sparks.freeCount,
        exhaustAlive: exhaust.capacity - exhaust.freeCount,
        dustAlive: dust.capacity - dust.freeCount,
        explosionAlive: explosion.capacity - explosion.freeCount,
        missileTrailAlive: missileTrail.capacity - missileTrail.freeCount,
      }),
    }
  }

  return function tick(dt: number): void {
    const eids = query(sim, [BikeTag, Transform, HoverState, ControlIntent])

    for (const eid of eids) {
      if (!hasComponent(sim, eid, RBHandle)) continue
      const rbh = RBHandleStore.must(eid)
      const rb = phys.world.getRigidBody(rbh.handle)
      if (!rb) continue
      const transform = TransformStore.must(eid)
      const hover = HoverStateStore.must(eid)
      const intent = ControlIntentStore.must(eid)
      const v = rb.linvel()
      const speed = Math.hypot(v.x, v.z)

      tmpQuat.set(transform.qx, transform.qy, transform.qz, transform.qw)
      tmpPos.set(transform.x, transform.y, transform.z)

      let acc = emitAccum.get(eid)
      if (!acc) {
        acc = { foam: 0, sparks: 0, exhaust: 0, dust: 0 }
        emitAccum.set(eid, acc)
      }

      // Splash burst — bike just transitioned from airborne to grounded
      // *on water*, indicating a re-entry from a jump or ramp. Fire a
      // ring of foam particles upward + outward in a flat cone for the
      // belly-flop read. Uses the foam pool.
      const wasGrounded = lastGrounded.get(eid) ?? hover.isGrounded
      if (
        !wasGrounded &&
        hover.isGrounded &&
        hover.surfaceIsWater &&
        Math.abs(v.y) > 2 // landed with appreciable downward velocity
      ) {
        const splashCount = 18 + Math.min(20, Math.floor(Math.abs(v.y) * 1.5))
        // Splash origin is the bike base at impact, which is roughly the
        // water surface (groundDistance ≈ 0).
        const sx = transform.x
        const sz = transform.z
        const sy = transform.y - hover.groundDistance + 0.05
        for (let k = 0; k < splashCount; k++) {
          const ang = Math.random() * Math.PI * 2
          const cx = Math.cos(ang)
          const cz = Math.sin(ang)
          // Outward ring + strong upward burst. Faster impacts splash
          // higher and wider.
          const outSpeed = 2 + Math.abs(v.y) * 0.6 + Math.random() * 1.5
          const upSpeed = 2.5 + Math.abs(v.y) * 0.8 + Math.random() * 1.5
          emit(
            foam,
            sx + cx * 0.2,
            sy,
            sz + cz * 0.2,
            cx * outSpeed,
            upSpeed,
            cz * outSpeed,
            0.6,
            0.5,
            0.9,
            foam.defaultSize * (0.8 + Math.random() * 0.7),
            1,
          )
        }
      }
      lastGrounded.set(eid, hover.isGrounded)

      // Foam — V-shaped Kelvin wake behind the stern with an upward bias.
      // Each spawn picks a side (alternating L/R) and ejects along
      // (back · cos θ ± right · sin θ), matching the V-shape the water
      // displacement shader carves into the surface.
      if (hover.isGrounded && hover.surfaceIsWater && speed > FOAM_MIN_SPEED) {
        const rate =
          Math.min(1, (speed - FOAM_MIN_SPEED) / (FOAM_SPEED_FULL - FOAM_MIN_SPEED)) *
          FOAM_MAX_RATE
        acc.foam += rate * dt
        const n = Math.floor(acc.foam)
        if (n > 0) {
          acc.foam -= n
          sternWorld.copy(STERN_OFFSET).applyQuaternion(tmpQuat).add(tmpPos)
          back.set(0, 0, -1).applyQuaternion(tmpQuat)
          right.set(1, 0, 0).applyQuaternion(tmpQuat)
          const sinH = Math.sin(FOAM_V_HALF_ANGLE)
          const cosH = Math.cos(FOAM_V_HALF_ANGLE)
          // Wake speed scales with bike speed so the V opens proportionally.
          const wakeSpeed = 1.5 + speed * 0.07
          for (let k = 0; k < n; k++) {
            const side = (k & 1) === 0 ? -1 : 1
            const vx = back.x * cosH * wakeSpeed + right.x * sinH * side * wakeSpeed
            const vz = back.z * cosH * wakeSpeed + right.z * sinH * side * wakeSpeed
            // Strong upward spray reads as a real water plume.
            const vy = 1.6 + Math.random() * 0.6
            emit(
              foam,
              sternWorld.x,
              sternWorld.y,
              sternWorld.z,
              vx,
              vy,
              vz,
              0.4, // small spherical jitter on top of the V direction
              0.6,
              1.0,
              foam.defaultSize * (0.7 + Math.random() * 0.6),
              1,
            )
          }
        }
      } else {
        acc.foam = 0
      }

      // Sparks — only when the bike is genuinely scraping the ground.
      // We gate on `groundDistance < SPARK_GROUND_DIST_MAX` (well below
      // the bike's 1.2 m hover target) so casual driving over land
      // doesn't shed sparks; only ramp lips, bottom-outs from a hard
      // landing, or curb scrapes light up.
      if (
        hover.isGrounded &&
        !hover.surfaceIsWater &&
        hover.groundDistance < SPARK_GROUND_DIST_MAX &&
        speed > SPARK_MIN_SPEED
      ) {
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

      // Dust — rotor-wash kicked up while in the hover zone over land
      // but NOT scraping. Reads as fine particulate blowing radially
      // outward at ground level. Window:
      //   DUST_GROUND_DIST_MIN < groundDistance < DUST_GROUND_DIST_MAX
      // Below MIN we hand off to sparks (scraping); above MAX we're
      // either airborne or fading into "barely grounded" where there's
      // not enough downwash to stir up dust.
      if (
        hover.isGrounded &&
        !hover.surfaceIsWater &&
        hover.groundDistance > DUST_GROUND_DIST_MIN &&
        hover.groundDistance < DUST_GROUND_DIST_MAX &&
        speed > DUST_MIN_SPEED
      ) {
        const rate =
          Math.min(1, (speed - DUST_MIN_SPEED) / (DUST_SPEED_FULL - DUST_MIN_SPEED)) *
          DUST_MAX_RATE
        acc.dust += rate * dt
        const n = Math.floor(acc.dust)
        if (n > 0) {
          acc.dust -= n
          // Spawn at ground level directly under the bike, not at the
          // bike body. The rotor-wash hits the ground and fans outward
          // from there.
          const groundY = transform.y - hover.groundDistance + 0.05
          for (let k = 0; k < n; k++) {
            // Random radial direction in XZ for outward blow.
            const ang = Math.random() * Math.PI * 2
            const sx = Math.cos(ang)
            const sz = Math.sin(ang)
            // Eject speed scales with bike speed so faster passes
            // produce more dramatic dust.
            const ejectSpeed = 1.5 + speed * 0.18
            emit(
              dust,
              transform.x + sx * 0.3,
              groundY,
              transform.z + sz * 0.3,
              sx * ejectSpeed,
              0.4 + Math.random() * 0.5,
              sz * ejectSpeed,
              0.5,
              0.5,
              0.9,
              dust.defaultSize * (0.7 + Math.random() * 0.7),
              1,
            )
          }
        }
      } else {
        acc.dust = 0
      }

      // Exhaust — emits while the bike is throttling forward, blossoming
      // when boost is active. Emits regardless of surface (over water,
      // on land, or airborne) — a bike actively burning fuel produces
      // exhaust everywhere. Reverse throttle is intentionally excluded
      // so the rear-thruster read stays consistent with bike motion.
      const throttleMag = Math.max(0, intent.throttle) // forward only
      if (throttleMag > EXHAUST_THROTTLE_MIN || intent.boost) {
        const rate =
          throttleMag * EXHAUST_THROTTLE_RATE + (intent.boost ? EXHAUST_BOOST_RATE : 0)
        acc.exhaust += rate * dt
        const n = Math.floor(acc.exhaust)
        if (n > 0) {
          acc.exhaust -= n
          exhaustWorld.copy(EXHAUST_OFFSET).applyQuaternion(tmpQuat).add(tmpPos)
          // Fire backward in bike-local -Z (the bike's forward is +Z).
          back.set(0, 0, -1).applyQuaternion(tmpQuat)
          // Boost gets a stronger blast and slightly larger sprites for
          // a "thruster firing" beat distinct from idle exhaust.
          const boosting = intent.boost
          const ejectSpeed = boosting ? 9 : 5
          const sizeMul = boosting ? 1.3 : 1.0
          const lifeMul = boosting ? 1.0 : 0.7
          emit(
            exhaust,
            exhaustWorld.x,
            exhaustWorld.y,
            exhaustWorld.z,
            back.x * ejectSpeed,
            back.y * ejectSpeed + 0.3,
            back.z * ejectSpeed,
            // Wider cone when boosting reads as turbulent thrust; tighter
            // when idle-throttling reads as a clean stream.
            boosting ? 2.5 : 1.2,
            0.25 * lifeMul,
            0.55 * lifeMul,
            exhaust.defaultSize * sizeMul * (0.7 + Math.random() * 0.6),
            n,
          )
        }
      } else {
        acc.exhaust = 0
      }
    }

    // Missile trail — query every in-flight missile, emit smoky puffs
    // along its path. Per-missile accumulator so a missile that just
    // spawned starts emitting immediately rather than waiting for its
    // accumulator to reach 1.
    const missileEids = query(sim, [MissileTag, MissileState])
    const liveMissiles = new Set<number>()
    for (const eid of missileEids) {
      liveMissiles.add(eid)
      const m = MissileStateStore.get(eid)
      if (!m || m.detonated) continue
      let acc = missileEmitAccum.get(eid) ?? 0
      acc += MISSILE_TRAIL_RATE * dt
      const n = Math.floor(acc)
      if (n > 0) {
        acc -= n
        for (let k = 0; k < n; k++) {
          // Emit slightly behind the missile (against its velocity) so
          // the trail tracks the path the missile flew over.
          const vlen = Math.hypot(m.velocity.x, m.velocity.y, m.velocity.z) || 1
          const back_x = -m.velocity.x / vlen
          const back_y = -m.velocity.y / vlen
          const back_z = -m.velocity.z / vlen
          emit(
            missileTrail,
            m.position.x + back_x * 0.4,
            m.position.y + back_y * 0.4,
            m.position.z + back_z * 0.4,
            back_x * 1.5,
            0.3,
            back_z * 1.5,
            0.5,
            0.4,
            0.7,
            missileTrail.defaultSize * (0.7 + Math.random() * 0.6),
            1,
          )
        }
      }
      missileEmitAccum.set(eid, acc)
    }
    // Drop accumulator entries for missiles that no longer exist.
    for (const eid of missileEmitAccum.keys()) {
      if (!liveMissiles.has(eid)) missileEmitAccum.delete(eid)
    }

    // Explosion bursts — query every explosion entity, burst once per
    // entity at detonation. We track which eids we've already burst in
    // a Set; an explosion's lifetime is short (~0.5–1 s) so the Set
    // stays bounded. Entries are pruned when the explosion entity is no
    // longer in the world.
    const explosionEids = query(sim, [ExplosionTag, ExplosionState])
    const liveExplosions = new Set<number>()
    for (const eid of explosionEids) {
      liveExplosions.add(eid)
      if (explosionsBurst.has(eid)) continue
      explosionsBurst.add(eid)
      const e = ExplosionStateStore.get(eid)
      if (!e) continue
      // Burst ~30 particles in a sphere, mostly upward + outward.
      const burstCount = 30
      for (let k = 0; k < burstCount; k++) {
        // Random unit vector — square sample then renormalise.
        const u = Math.random() * 2 - 1
        const t = Math.random() * Math.PI * 2
        const r = Math.sqrt(1 - u * u)
        const dx = Math.cos(t) * r
        const dy = u * 0.6 + 0.6 // bias upward
        const dz = Math.sin(t) * r
        const speed_ = 6 + Math.random() * 4
        emit(
          explosion,
          e.position.x,
          e.position.y,
          e.position.z,
          dx * speed_,
          dy * speed_,
          dz * speed_,
          1.2,
          0.4,
          0.85,
          explosion.defaultSize * (0.7 + Math.random() * 0.7),
          1,
        )
      }
    }
    for (const eid of explosionsBurst) {
      if (!liveExplosions.has(eid)) explosionsBurst.delete(eid)
    }

    advance(foam, dt)
    advance(sparks, dt)
    advance(exhaust, dt)
    advance(dust, dt)
    advance(explosion, dt)
    advance(missileTrail, dt)
  }
}
