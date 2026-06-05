import { hasComponent, query } from 'bitecs'
import * as THREE from 'three'
import { attribute, texture as tslTexture } from 'three/tsl'
import { SpriteNodeMaterial } from 'three/webgpu'
import { playerSettings, TUCK_VFX_SCALAR, WAVE_SPRAY_SCALAR } from '@/engine/player-settings'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { sampleHeight, sampleSurface, type WaveFieldState } from '@/engine/sim/water/wave-field'
import {
  BikeTag,
  ControlIntent,
  ControlIntentStore,
  DriftStateStore,
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
import { slopeAwareSweetSpot, tuckFactor } from '@/game/systems/hover'

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
// Wake spread half-arc. Particles eject in a random direction within
// (back ± halfArc) so the wake reads as a turbulent fan plume rather
// than two crisp diagonals. Mirrors how dust randomises its radial
// angle for a full-spread look. ~63° gives a wide V-blossom.
const FOAM_V_HALF_ANGLE = 1.1

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

// Tuck slipstream — cool vapor streaks pulled off the bike as the player
// leans into the tuck sweet spot. Emission rate + sprite size both scale
// with the live tuck factor (peaks at the sweet spot, falls off as the
// lean over-shoots into the belly-scrape), so the effect is "more
// prevalent the closer you are to the sweet spot" by construction. Gated
// to grounded / over-water frames — the same surface the tuck physics
// acts on. Negative tuck factor (over-tuck) emits nothing.
const TUCK_MAX_RATE = 70 // particles/sec at a perfect sweet-spot tuck
const TUCK_MIN_FACTOR = 0.05 // dead-zone so a feather-touch lean shows nothing

// Emission origins in bike-local coords. The bike's render-systems.ts
// applies a 2× visual scale to the mesh while keeping the physics body
// at authored size — the bike's *transform* still uses physics-space
// coordinates, so these offsets are scaled to land at the visible stern
// (foam), visible base (sparks), and visible rear-bottom (exhaust) of
// the rendered bike.
const STERN_OFFSET = new THREE.Vector3(0, 0.1, -1.4)
const SPARK_OFFSET = new THREE.Vector3(0, -0.2, 0)
const EXHAUST_OFFSET = new THREE.Vector3(0, -0.2, -1.6)
// Drift sparks fire from the two rear underside corners while the
// player is committed to a drift — the visual reads as "tyres skidding
// across the surface." Two offsets so blue and orange both come from
// the outside-rear corner, the canonical MK kart spark point.
const DRIFT_SPARK_OFFSET_PORT = new THREE.Vector3(-0.45, -0.2, -1.2)
const DRIFT_SPARK_OFFSET_STARBOARD = new THREE.Vector3(0.45, -0.2, -1.2)
// Tuck streaks shed from the cockpit / leading shoulders of the bike,
// then rush backward — the air the rider is ducking under.
const TUCK_OFFSET = new THREE.Vector3(0, 0.35, 0.2)

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
// Tuck: ~70/s × ~0.5 s life ≈ 35 alive per bike at the sweet spot. Tuck
// is overwhelmingly a player-only input (AI doesn't tuck), so a couple of
// bikes' worth of headroom is plenty.
const TUCK_CAPACITY = 120

// Drift sparks — two pools (blue + orange) that emit while the player
// holds a committed drift, with the tier on `DriftState.highestTier`
// switching color. Tier 0 emits nothing (no commitment yet). Tier 1+
// emits blue; tier 2+ also emits the brighter orange burst layered on
// top so the SMT tier-up reads as a visible boost in spark density.
// Rate is constant per tier rather than speed-modulated — the player
// already knows they're drifting; the spark cue is for the CHARGE
// state, not the speed.
const DRIFT_SPARK_RATE_T1 = 70 // particles/sec while drifting at blue tier
const DRIFT_SPARK_RATE_T2 = 110 // particles/sec extra layered at orange tier
const DRIFT_SPARK_RATE_T3 = 90 // particles/sec extra layered at purple UMT tier
const DRIFT_SPARK_LIFE_MIN = 0.18
const DRIFT_SPARK_LIFE_MAX = 0.45
// Pool capacities tuned for two-bike peak emission: tier 2 emits
// ~110/s × 0.45 s = ~50 alive per bike × 2 = 100; 160 leaves headroom.
const DRIFT_SPARK_BLUE_CAPACITY = 160
const DRIFT_SPARK_ORANGE_CAPACITY = 160
const DRIFT_SPARK_PURPLE_CAPACITY = 120

// Plunge bubbles — thick cloud that boils around a bike/rider when they
// punch through the water surface, choking off at the apex of the dive
// (the moment downward velocity reverses and the bike starts rising).
// Rate is high enough that a 0.6–1.0 s descent reads as a roiling cloud,
// not a thin stream. Lifetime ~0.7–1.3 s + plenty of drag so bubbles
// hang and dissipate instead of jetting away from the bike.
const BUBBLE_PLUNGE_BURST = 40 // particles fired once at the moment of crossing
const BUBBLE_DESCEND_RATE = 90 // particles/sec while the bike sinks
const BUBBLE_CAPACITY = 420
// Vertical extent of the per-frame emission column around the bike's
// origin — covers the chassis (≈ 0.5 m) and the rider above it (≈ 1.5 m).
const BUBBLE_BODY_BOTTOM = -0.4
const BUBBLE_BODY_TOP = 1.6
// Surface-crossing hysteresis (m). Slightly larger than the fog band so
// the bubble plunge-burst doesn't fire spuriously on a wave crest that
// just brushes the bike's hull during a normal foam-wake run.
const BUBBLE_SUBMERGE_DEPTH = 0.25

// Breaking-crest spray — the ambient "poof" fired by the wave-crest-spray
// driver (engine/render/wave-crest-spray.ts) the moment a crest breaks
// ANYWHERE on the sea, independent of any bike. This is the layer that stops
// the ocean reading as a shaded rubber sheet: pale wind-torn spray erupts up
// off the breaking crest and drifts downwind, then arcs back down. Pool sized
// for the driver's capped burst rate (≤ ~14 cells/tick × ~6–14 sprites/burst
// × ~0.9 s life), shared across the whole visible sea at one draw call.
const CREST_SPRAY_CAPACITY = 700
// Per-burst sprite count = base + strength · span, so a barely-breaking crest
// throws a wisp and a full whitecap throws a sheet.
const CREST_SPRAY_BASE_COUNT = 5
const CREST_SPRAY_SPAN_COUNT = 11

// Bow spray — wave-aware sheet thrown off the bike's nose when it drives INTO
// a rising wave face. Closing rate is the bike's forward speed projected onto
// the local up-slope of the surface (m/s of vertical climb into the face), so
// it only fires when the rider is actually punching up a crest — directly
// rewarding the wave-mastery pump. Reuses the crest-spray pool + emitter.
const BOW_SPRAY_MIN_CLOSING = 1.3 // m/s vertical climb before any bow spray
const BOW_SPRAY_FULL_CLOSING = 6.0 // m/s climb at which the sheet is full
const BOW_SPRAY_MAX_RATE = 90 // particles/sec at full closing
// Local-space bow point (visible nose of the 2×-scaled bike) the sheet
// erupts from; the bike's forward is local +Z.
const BOW_OFFSET = new THREE.Vector3(0, 0.05, 1.5)

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

export function createFxSystem(
  scene: THREE.Scene,
  sim: SimWorld,
  phys: PhysicsWorld,
  waveField?: WaveFieldState,
) {
  const foamTex = makeRadialTexture([235, 245, 255])
  const sparkTex = makeRadialTexture([255, 200, 120])
  const exhaustTex = makeRadialTexture([255, 130, 60])
  const dustTex = makeRadialTexture([195, 180, 155])
  const explosionTex = makeRadialTexture([255, 165, 50])
  const missileTrailTex = makeRadialTexture([220, 220, 230])
  // Bubbles read brighter than foam — a pale cyan-tinted white that
  // stands out against the saturated teal underwater fog.
  const bubbleTex = makeRadialTexture([220, 240, 250])
  // Cool cyan-white — reads as cold slipstream vapor, distinct from the
  // warm exhaust and the pale foam.
  const tuckTex = makeRadialTexture([170, 225, 255])

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
  // Drift sparks — three pools, one per mini-turbo tier. Blue is the
  // MT base layer; orange + purple stack on top at the higher tiers so
  // a player visually reads SMT / UMT as "more colored sparks."
  // Additive blending so the colors stay punchy against the bike's
  // shadow. Smaller default size than the scrape spark — drift sparks
  // are a flurry of small flecks, not a single arc.
  const driftSparkBlueTex = makeRadialTexture([110, 180, 255])
  const driftSparkOrangeTex = makeRadialTexture([255, 180, 90])
  const driftSparkPurpleTex = makeRadialTexture([220, 130, 255])
  const driftSparksBlue = createPool({
    capacity: DRIFT_SPARK_BLUE_CAPACITY,
    defaultSize: 0.22,
    texture: driftSparkBlueTex,
    blending: THREE.AdditiveBlending,
    gravity: -10,
    drag: 1.2,
  })
  const driftSparksOrange = createPool({
    capacity: DRIFT_SPARK_ORANGE_CAPACITY,
    defaultSize: 0.26,
    texture: driftSparkOrangeTex,
    blending: THREE.AdditiveBlending,
    gravity: -10,
    drag: 1.2,
  })
  const driftSparksPurple = createPool({
    capacity: DRIFT_SPARK_PURPLE_CAPACITY,
    defaultSize: 0.3,
    texture: driftSparkPurpleTex,
    blending: THREE.AdditiveBlending,
    gravity: -10,
    drag: 1.2,
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
  const bubbles = createPool({
    capacity: BUBBLE_CAPACITY,
    // Chunky — these are "cloud" bubbles, not pinpricks. Sized so a
    // boil of 30+ reads as a solid plume from chase-cam distance.
    defaultSize: 0.7,
    texture: bubbleTex,
    blending: THREE.NormalBlending,
    // Strong upward buoyancy mimics a sudden plunge's air pocket, but
    // heavy drag damps it so bubbles cluster around the bike for half
    // a second before drifting toward the surface and fading out.
    gravity: 4.5,
    drag: 2.8,
  })

  const tuckStream = createPool({
    capacity: TUCK_CAPACITY,
    defaultSize: 0.4,
    texture: tuckTex,
    blending: THREE.AdditiveBlending,
    // Near-neutral buoyancy + light drag so streaks hang in the
    // slipstream behind the bike and fade rather than shoot away.
    gravity: 0.2,
    drag: 2.0,
  })

  // Breaking-crest spray — pale wind-torn water lofted off the sea's own
  // crests. Negative gravity (real droplets fall back) + light drag gives a
  // genuine ballistic arc rather than the buoyant hang of the foam-wake
  // puffs, so the eye reads it as water thrown UP off the break, not as
  // surface foam. Same pale-cyan-white as the plunge bubbles.
  const crestSprayTex = makeRadialTexture([225, 240, 255])
  const crestSpray = createPool({
    capacity: CREST_SPRAY_CAPACITY,
    defaultSize: 1.1,
    texture: crestSprayTex,
    blending: THREE.NormalBlending,
    gravity: -4.0,
    drag: 1.1,
  })

  scene.add(foam.mesh)
  scene.add(sparks.mesh)
  scene.add(driftSparksBlue.mesh)
  scene.add(driftSparksOrange.mesh)
  scene.add(driftSparksPurple.mesh)
  scene.add(exhaust.mesh)
  scene.add(dust.mesh)
  scene.add(explosion.mesh)
  scene.add(missileTrail.mesh)
  scene.add(bubbles.mesh)
  scene.add(tuckStream.mesh)
  scene.add(crestSpray.mesh)

  // Reusable scratch math.
  const sternWorld = new THREE.Vector3()
  const sparkWorld = new THREE.Vector3()
  const exhaustWorld = new THREE.Vector3()
  const _dustWorld = new THREE.Vector3()
  const tuckWorld = new THREE.Vector3()
  const bowWorld = new THREE.Vector3()
  const bowFwd = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  const tmpPos = new THREE.Vector3()
  const back = new THREE.Vector3()
  const right = new THREE.Vector3()

  // Per-bike fractional emission accumulators — emit rate × dt is usually
  // < 1 per frame, so we accumulate the fraction across frames and emit
  // when it crosses a whole particle.
  const emitAccum = new Map<
    number,
    {
      foam: number
      sparks: number
      exhaust: number
      dust: number
      tuck: number
      bowSpray: number
      driftBlue: number
      driftOrange: number
      driftPurple: number
    }
  >()

  // Per-bike transition memory for event-driven bursts. We need the
  // previous frame's grounded state to detect "just landed on water"
  // (splash) and "just touched down hard" (impact dust). Initialised
  // lazily on first sight of each bike.
  const lastGrounded = new Map<number, boolean>()

  // Per-bike plunge state. The dive lifecycle is:
  //   above-water → (cross surface, vy < 0) plunge burst, start descent
  //   descending  → continuous bubble cloud while still sinking
  //   apex (vy ≥ 0) → emission stops; below surface but no more bubbles
  //   resurface   → state resets, ready for the next plunge
  // Stored separately from `lastGrounded` because "submerged" is a
  // wave-field-derived check independent of the hover-spring grounded
  // state (the bike can be submerged while still rotor-pushing upward).
  type DiveState = { wasSubmerged: boolean; descending: boolean; emitAccum: number }
  const dive = new Map<number, DiveState>()

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
      bubbles,
      tuckStream,
      crestSpray,
      driftSparksBlue,
      driftSparksOrange,
      driftSparksPurple,
      dive,
      stats: () => ({
        foamAlive: foam.capacity - foam.freeCount,
        sparkAlive: sparks.capacity - sparks.freeCount,
        exhaustAlive: exhaust.capacity - exhaust.freeCount,
        dustAlive: dust.capacity - dust.freeCount,
        explosionAlive: explosion.capacity - explosion.freeCount,
        missileTrailAlive: missileTrail.capacity - missileTrail.freeCount,
        bubbleAlive: bubbles.capacity - bubbles.freeCount,
        tuckAlive: tuckStream.capacity - tuckStream.freeCount,
        crestSprayAlive: crestSpray.capacity - crestSpray.freeCount,
        driftBlueAlive: driftSparksBlue.capacity - driftSparksBlue.freeCount,
        driftOrangeAlive: driftSparksOrange.capacity - driftSparksOrange.freeCount,
        driftPurpleAlive: driftSparksPurple.capacity - driftSparksPurple.freeCount,
      }),
    }
  }

  // Per-bike scratch for triggerPumpBurst — re-uses the same backward
  // vector + stern-offset math as the per-frame exhaust emission so
  // the burst geometry matches the bike's authored rear.
  const pumpBurstWorld = new THREE.Vector3()
  const pumpBurstQuat = new THREE.Quaternion()
  const pumpBurstPos = new THREE.Vector3()
  const pumpBurstBack = new THREE.Vector3()

  function triggerPumpBurst(eid: number, strength: number, perfect: boolean): void {
    // Pull the bike's transform straight from ECS — bike body offsets
    // match the per-frame exhaust path so the burst reads as a single
    // huge thrust pulse out of the same nozzle.
    const transform = TransformStore.get(eid)
    if (!transform) return
    if (!hasComponent(sim, eid, RBHandle)) return
    const rbh = RBHandleStore.must(eid)
    const rb = phys.world.getRigidBody(rbh.handle)
    if (!rb) return
    pumpBurstQuat.set(transform.qx, transform.qy, transform.qz, transform.qw)
    pumpBurstPos.set(transform.x, transform.y, transform.z)
    pumpBurstWorld.copy(EXHAUST_OFFSET).applyQuaternion(pumpBurstQuat).add(pumpBurstPos)
    pumpBurstBack.set(0, 0, -1).applyQuaternion(pumpBurstQuat)
    // Scale particle count + speed + size with strength + perfect tier.
    // Perfect bursts roughly double the count and add a bigger sprite
    // for the "afterburner kicked in" beat.
    const s = Math.max(0.2, Math.min(1, strength))
    const count = perfect ? 32 + Math.floor(s * 18) : 18 + Math.floor(s * 12)
    const ejectSpeed = perfect ? 16 : 11
    const sizeMul = perfect ? 1.7 : 1.25
    const lifeMin = perfect ? 0.35 : 0.28
    const lifeMax = perfect ? 0.85 : 0.65
    emit(
      exhaust,
      pumpBurstWorld.x,
      pumpBurstWorld.y,
      pumpBurstWorld.z,
      pumpBurstBack.x * ejectSpeed,
      pumpBurstBack.y * ejectSpeed + 0.4,
      pumpBurstBack.z * ejectSpeed,
      // Wider cone than baseline exhaust — the burst should fan out
      // dramatically rather than streaming in a tight cylinder.
      perfect ? 3.5 : 2.2,
      lifeMin,
      lifeMax,
      exhaust.defaultSize * sizeMul,
      count,
    )
  }

  // Ambient breaking-crest spray. Called by the wave-crest-spray driver
  // (wired in main.ts) at a world point (x, y, z) where a crest just broke,
  // with `strength` in [0, 1] (the breaking-foam likelihood) and a unit wind
  // direction the spray drifts downwind along. `scale` folds in the player's
  // "Wave spray" setting (full / subtle) so emission density tracks the knob.
  // Sprites erupt mostly upward with a downwind lean and a wide cone, then arc
  // back down under the pool's negative gravity.
  function emitWaveSpray(
    x: number,
    y: number,
    z: number,
    strength: number,
    windX: number,
    windZ: number,
    scale = 1,
  ): void {
    const s = strength < 0 ? 0 : strength > 1 ? 1 : strength
    const count = Math.max(
      1,
      Math.round((CREST_SPRAY_BASE_COUNT + s * CREST_SPRAY_SPAN_COUNT) * scale),
    )
    // Upward eject scales with how hard the crest is breaking; downwind drift
    // gives the plume its wind-torn lean.
    const up = 2.2 + s * 3.4
    const drift = 1.2 + s * 2.2
    for (let k = 0; k < count; k++) {
      // Spawn jittered across a small disc on the crest so the burst reads as
      // a chunk of the wave-face tearing, not a point source.
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * 0.8
      const vy = up * (0.6 + Math.random() * 0.8)
      // Each droplet also gets a small radial outward kick on top of the
      // shared downwind drift, for the fan.
      const radial = 0.6 + Math.random() * 1.4
      emit(
        crestSpray,
        x + Math.cos(a) * r,
        y + 0.1,
        z + Math.sin(a) * r,
        windX * drift + Math.cos(a) * radial,
        vy,
        windZ * drift + Math.sin(a) * radial,
        0.7,
        0.5,
        0.95,
        crestSpray.defaultSize * (0.6 + s * 0.6) * (0.7 + Math.random() * 0.6),
        1,
      )
    }
  }

  function tick(dt: number): void {
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
        acc = {
          foam: 0,
          sparks: 0,
          exhaust: 0,
          dust: 0,
          tuck: 0,
          bowSpray: 0,
          driftBlue: 0,
          driftOrange: 0,
          driftPurple: 0,
        }
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

      // Foam — turbulent spray plume springing from the *water surface*
      // behind the bike's stern, not from the bike body. Spawning at
      // water level (transform.y − groundDistance) makes the wake read
      // as the surface being disturbed by the hull, not as exhaust
      // shooting from the stern. Mirrors how dust spawns at ground
      // level under the bike.
      //
      // Each spawn picks a random angle within the backward arc
      // (±FOAM_V_HALF_ANGLE) and a random outward speed. The result is
      // a fanned-out blossom matching the hover-wash dust pattern,
      // rather than two crisp parallel V lines. Spawn position is
      // jittered within a small disc around the stern so the trail
      // doesn't read as a single source point.
      if (hover.isGrounded && hover.surfaceIsWater && speed > FOAM_MIN_SPEED) {
        const rate =
          Math.min(1, (speed - FOAM_MIN_SPEED) / (FOAM_SPEED_FULL - FOAM_MIN_SPEED)) * FOAM_MAX_RATE
        acc.foam += rate * dt
        const n = Math.floor(acc.foam)
        if (n > 0) {
          acc.foam -= n
          // Stern XZ comes from the bike-local offset; Y is overridden
          // to the water surface so the wake originates at the
          // disturbed surface, not the bike's hull.
          sternWorld.copy(STERN_OFFSET).applyQuaternion(tmpQuat).add(tmpPos)
          sternWorld.y = transform.y - hover.groundDistance + 0.05
          back.set(0, 0, -1).applyQuaternion(tmpQuat)
          right.set(1, 0, 0).applyQuaternion(tmpQuat)
          const baseWakeSpeed = 1.5 + speed * 0.07
          for (let k = 0; k < n; k++) {
            // Random angle in [-halfArc, +halfArc] from straight-back.
            const ang = (Math.random() * 2 - 1) * FOAM_V_HALF_ANGLE
            const cosA = Math.cos(ang)
            const sinA = Math.sin(ang)
            const dx = back.x * cosA + right.x * sinA
            const dz = back.z * cosA + right.z * sinA
            // Per-particle speed jitter so the fan has depth instead of
            // a hard outer ring.
            const wakeSpeed = baseWakeSpeed * (0.5 + Math.random() * 0.9)
            // Spawn-point jitter within a small disc around the stern,
            // so the source reads as a chunk of disturbed water rather
            // than a single emission point.
            const spawnAng = Math.random() * Math.PI * 2
            const spawnRadius = Math.random() * 0.5
            const sxOff = Math.cos(spawnAng) * spawnRadius
            const szOff = Math.sin(spawnAng) * spawnRadius
            // Strong upward spray reads as a real water plume.
            const vy = 1.4 + Math.random() * 0.9
            emit(
              foam,
              sternWorld.x + sxOff,
              sternWorld.y,
              sternWorld.z + szOff,
              dx * wakeSpeed,
              vy,
              dz * wakeSpeed,
              0.5, // spherical jitter on top of the angled vector
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

      // Bow spray — wave-aware sheet off the nose when the bike drives INTO a
      // rising wave face. We read the live surface slope + the bike's forward
      // velocity to compute the vertical "closing rate" up the face: only a
      // rider actually climbing a crest at speed throws the sheet, so pumping
      // into a wave is visibly rewarded while skimming a flat sea is not.
      // Gated by the same Wave-spray setting as the ambient crest poofs.
      const waveSprayScale = WAVE_SPRAY_SCALAR[playerSettings.waveSprayIntensity]
      if (
        waveField &&
        waveSprayScale > 0 &&
        hover.isGrounded &&
        hover.surfaceIsWater &&
        speed > 4
      ) {
        const surf = sampleSurface(waveField, transform.x, transform.z)
        // ∇y = (−nx/ny, −nz/ny); forward is bike-local +Z in world frame.
        bowFwd.set(0, 0, 1).applyQuaternion(tmpQuat)
        const dydx = -surf.nx / surf.ny
        const dydz = -surf.nz / surf.ny
        const slopeFwd = dydx * bowFwd.x + dydz * bowFwd.z // >0 = climbing the face
        // Vertical climb rate into the face, minus the surface's own upward
        // motion (a face rising to meet the bike closes faster).
        const closing = speed * Math.max(0, slopeFwd) - Math.min(0, surf.vy)
        if (closing > BOW_SPRAY_MIN_CLOSING) {
          const t01 = Math.min(
            1,
            (closing - BOW_SPRAY_MIN_CLOSING) / (BOW_SPRAY_FULL_CLOSING - BOW_SPRAY_MIN_CLOSING),
          )
          acc.bowSpray += BOW_SPRAY_MAX_RATE * t01 * waveSprayScale * dt
          const n = Math.floor(acc.bowSpray)
          if (n > 0) {
            acc.bowSpray -= n
            bowWorld.copy(BOW_OFFSET).applyQuaternion(tmpQuat).add(tmpPos)
            // Erupt off the surface at the bow, leaning forward (the bike's
            // own heading) — emitWaveSpray adds the upward arc + cone.
            bowWorld.y = transform.y - hover.groundDistance + 0.05
            for (let k = 0; k < n; k++) {
              emitWaveSpray(bowWorld.x, bowWorld.y, bowWorld.z, t01, bowFwd.x, bowFwd.z, 1)
            }
          }
        } else {
          acc.bowSpray = 0
        }
      } else {
        acc.bowSpray = 0
      }

      // Plunge bubbles — fire a thick cloud burst the moment the bike
      // punches through the water surface heading down, then keep
      // boiling bubbles around the chassis/rider until the bike reaches
      // the apex of its dive (vy crosses back to non-negative). Tracked
      // against the wave-displaced surface at the bike's XZ so a wave
      // crest sliding overhead doesn't constantly retrigger the burst.
      const surfaceY = waveField ? sampleHeight(waveField, transform.x, transform.z) : 0
      const submergedDepth = surfaceY - transform.y // +ve = under the surface
      const isSubmerged = submergedDepth > BUBBLE_SUBMERGE_DEPTH
      let ds = dive.get(eid)
      if (!ds) {
        ds = { wasSubmerged: false, descending: false, emitAccum: 0 }
        dive.set(eid, ds)
      }
      if (!ds.wasSubmerged && isSubmerged && v.y < 0) {
        // PLUNGE BURST — a one-shot ring + vertical scatter of bubbles
        // around the bike body, scaled by entry speed. Origin is the
        // surface point at the bike's XZ so the cloud reads as the
        // moment of impact, not as a delayed body emission.
        const plungeSpeed = Math.min(20, Math.abs(v.y))
        const burst = BUBBLE_PLUNGE_BURST + Math.floor(plungeSpeed * 2)
        for (let k = 0; k < burst; k++) {
          const ang = Math.random() * Math.PI * 2
          const cx = Math.cos(ang)
          const cz = Math.sin(ang)
          // Spread bubbles across a chunky disc around the impact column
          // and a small vertical jitter down into the just-displaced water.
          const radius = 0.25 + Math.random() * 0.7
          const sy = surfaceY - Math.random() * 0.4
          // Mostly outward + upward — the air pocket erupts away from
          // the body. A small fraction (~25%) gets a downward push so
          // some bubbles trail with the descending bike instead of all
          // racing for the surface immediately.
          const outSpeed = 1.0 + plungeSpeed * 0.25 + Math.random() * 1.5
          const vyDir = Math.random() < 0.25 ? -0.5 - Math.random() : 0.6 + Math.random() * 1.4
          emit(
            bubbles,
            transform.x + cx * radius,
            sy,
            transform.z + cz * radius,
            cx * outSpeed,
            vyDir,
            cz * outSpeed,
            0.8,
            0.7,
            1.3,
            bubbles.defaultSize * (0.8 + Math.random() * 0.9),
            1,
          )
        }
        ds.descending = true
      }
      // Apex check — bike reached its lowest point and is now rising.
      // From here on, no more bubbles even if still submerged. The cloud
      // already in flight will naturally finish its life.
      if (ds.descending && v.y >= 0) {
        ds.descending = false
        ds.emitAccum = 0
      }
      if (ds.descending && isSubmerged) {
        ds.emitAccum += BUBBLE_DESCEND_RATE * dt
        const n = Math.floor(ds.emitAccum)
        if (n > 0) {
          ds.emitAccum -= n
          for (let k = 0; k < n; k++) {
            // Emit in a slim cylinder around the bike body so the cloud
            // wraps both chassis and rider. Y picks anywhere in the body
            // envelope and X/Z stays inside a 0.5 m radius disc.
            const ang = Math.random() * Math.PI * 2
            const r = 0.15 + Math.random() * 0.4
            const px = transform.x + Math.cos(ang) * r
            const pz = transform.z + Math.sin(ang) * r
            const py =
              transform.y +
              BUBBLE_BODY_BOTTOM +
              Math.random() * (BUBBLE_BODY_TOP - BUBBLE_BODY_BOTTOM)
            // Initial velocity is gentle — buoyancy + drag from the
            // pool config does most of the work. A tiny outward kick
            // keeps the cloud from collapsing onto the spawn line.
            const outSpeed = 0.4 + Math.random() * 0.8
            emit(
              bubbles,
              px,
              py,
              pz,
              Math.cos(ang) * outSpeed,
              0.4 + Math.random() * 0.8,
              Math.sin(ang) * outSpeed,
              0.5,
              0.4,
              1.0,
              bubbles.defaultSize * (0.55 + Math.random() * 0.8),
              1,
            )
          }
        }
      } else {
        ds.emitAccum = 0
      }
      // Reset the dive arc when the bike comes back above the surface,
      // so the next plunge can fire fresh.
      if (ds.wasSubmerged && !isSubmerged) {
        ds.descending = false
        ds.emitAccum = 0
      }
      ds.wasSubmerged = isSubmerged

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

      // Drift sparks — fire while the bike is in active drift state.
      // Three colored pools layer based on the highest tier reached
      // this drift: blue from tier 1 (MT), orange added at tier 2
      // (SMT), purple added at tier 3 (UMT). Gated by `driftIntensity`:
      // 'off' → no sparks; 'subtle' → blue only at half rate; 'full'
      // → all layers at full rate. Spawn origin is the rear-OUTSIDE
      // corner of the bike for the canonical MK kart spark read —
      // left drift fires from port-rear, right drift from starboard-
      // rear. Ungrounded ticks (briefly airborne mid-drift) skip
      // emission so the sparks don't streak through the air.
      const drift = DriftStateStore.get(eid)
      const intensity = playerSettings.driftIntensity
      if (
        drift &&
        drift.driftDir !== 0 &&
        drift.highestTier >= 1 &&
        hover.isGrounded &&
        intensity !== 'off'
      ) {
        // Outside-rear corner (port-rear for a left drift, starboard-
        // rear for a right drift). Drift sparks fly inward + back to
        // read as "skidding sideways."
        const offset =
          drift.driftDir === -1 ? DRIFT_SPARK_OFFSET_PORT : DRIFT_SPARK_OFFSET_STARBOARD
        sparkWorld.copy(offset).applyQuaternion(tmpQuat).add(tmpPos)
        const rateScale = intensity === 'subtle' ? 0.5 : 1.0

        // Blue layer — tier 1+.
        acc.driftBlue += DRIFT_SPARK_RATE_T1 * rateScale * dt
        const nBlue = Math.floor(acc.driftBlue)
        if (nBlue > 0) {
          acc.driftBlue -= nBlue
          emit(
            driftSparksBlue,
            sparkWorld.x,
            sparkWorld.y,
            sparkWorld.z,
            0,
            1,
            0,
            3,
            DRIFT_SPARK_LIFE_MIN,
            DRIFT_SPARK_LIFE_MAX,
            driftSparksBlue.defaultSize * (0.7 + Math.random() * 0.6),
            nBlue,
          )
        }

        // Orange layer — tier 2+. Only emitted on 'full' intensity so
        // 'subtle' players see the MT tier-up via boost feel rather
        // than spark color, keeping the visual quieter.
        if (drift.highestTier >= 2 && intensity === 'full') {
          acc.driftOrange += DRIFT_SPARK_RATE_T2 * dt
          const nOrange = Math.floor(acc.driftOrange)
          if (nOrange > 0) {
            acc.driftOrange -= nOrange
            emit(
              driftSparksOrange,
              sparkWorld.x,
              sparkWorld.y,
              sparkWorld.z,
              0,
              1.5,
              0,
              4,
              DRIFT_SPARK_LIFE_MIN,
              DRIFT_SPARK_LIFE_MAX,
              driftSparksOrange.defaultSize * (0.7 + Math.random() * 0.6),
              nOrange,
            )
          }
        } else {
          acc.driftOrange = 0
        }

        // Purple UMT layer — tier 3, full intensity only.
        if (drift.highestTier >= 3 && intensity === 'full') {
          acc.driftPurple += DRIFT_SPARK_RATE_T3 * dt
          const nPurple = Math.floor(acc.driftPurple)
          if (nPurple > 0) {
            acc.driftPurple -= nPurple
            emit(
              driftSparksPurple,
              sparkWorld.x,
              sparkWorld.y,
              sparkWorld.z,
              0,
              2,
              0,
              5,
              DRIFT_SPARK_LIFE_MIN,
              DRIFT_SPARK_LIFE_MAX,
              driftSparksPurple.defaultSize * (0.7 + Math.random() * 0.6),
              nPurple,
            )
          }
        } else {
          acc.driftPurple = 0
        }
      } else {
        acc.driftBlue = 0
        acc.driftOrange = 0
        acc.driftPurple = 0
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
          Math.min(1, (speed - DUST_MIN_SPEED) / (DUST_SPEED_FULL - DUST_MIN_SPEED)) * DUST_MAX_RATE
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
        const rate = throttleMag * EXHAUST_THROTTLE_RATE + (intent.boost ? EXHAUST_BOOST_RATE : 0)
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

      // Tuck slipstream — cool vapor streaks shed off the bike's shoulders
      // as the player leans into the tuck sweet spot. Both the emission
      // rate and the sprite size scale with the live tuck factor, clamped
      // to its positive (sweet-spot) side: a feather-light lean shows
      // almost nothing, the sweet spot fans out a full stream, and an
      // over-tuck past the sweet spot (negative factor → belly-scrape)
      // emits nothing — speed VFX shouldn't reward burying the nose. The
      // player's VFX-intensity setting is the global ceiling on top.
      // Grounded / over-water only, matching where tuck physics pays out.
      const tuckSetting = TUCK_VFX_SCALAR[playerSettings.tuckVfxIntensity]
      // Same slope-aware sweet spot the physics + HUD grade off, so the
      // stream fans out at the lean that actually pays on this slope.
      const tf = hover.isGrounded
        ? tuckFactor(
            Math.max(-intent.pitch, 0),
            slopeAwareSweetSpot(-Math.atan(hover.forwardSlope)),
          )
        : 0
      const tuckIntensity = Math.max(0, tf) * tuckSetting
      if (tuckIntensity > TUCK_MIN_FACTOR) {
        acc.tuck += TUCK_MAX_RATE * tuckIntensity * dt
        const n = Math.floor(acc.tuck)
        if (n > 0) {
          acc.tuck -= n
          tuckWorld.copy(TUCK_OFFSET).applyQuaternion(tmpQuat).add(tmpPos)
          back.set(0, 0, -1).applyQuaternion(tmpQuat)
          right.set(1, 0, 0).applyQuaternion(tmpQuat)
          // Streaks rush backward relative to the bike, a touch faster +
          // wider near the sweet spot, with a port/starboard spread so
          // they fan off both shoulders instead of a single line.
          const streamSpeed = 7 + speed * 0.12 + tuckIntensity * 4
          for (let k = 0; k < n; k++) {
            const side = (Math.random() * 2 - 1) * 0.5
            const dx = back.x + right.x * side
            const dy = back.y + 0.15
            const dz = back.z + right.z * side
            // Spawn jittered across the bike's shoulders.
            const sx = right.x * side * 0.6
            const sz = right.z * side * 0.6
            emit(
              tuckStream,
              tuckWorld.x + sx,
              tuckWorld.y,
              tuckWorld.z + sz,
              dx * streamSpeed,
              dy * streamSpeed,
              dz * streamSpeed,
              0.6,
              0.22,
              0.5,
              tuckStream.defaultSize * (0.7 + tuckIntensity * 0.8) * (0.7 + Math.random() * 0.6),
              1,
            )
          }
        }
      } else {
        acc.tuck = 0
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
      // Bonus burst — if the loaded track happens to have a
      // ``kind=emitter`` empty named ``emitter_explosion``, fire it
      // off too so authors can attach a track-specific atlas-sprite
      // burst (lava chunks for Kilauea, glass shards for Cape Town
      // aquarium) without touching code. The lookup goes through the
      // ``__particles`` global the boot wires up; a no-op when no
      // such emitter exists or particles are disabled.
      const particleHook = (
        window as unknown as {
          __particles?: { triggerBurst?: (name: string, count: number) => void }
        }
      ).__particles
      if (particleHook?.triggerBurst) {
        try {
          particleHook.triggerBurst('emitter_explosion', 24)
        } catch {
          // ignore — never let a hook failure tank the render frame
        }
      }
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
    advance(driftSparksBlue, dt)
    advance(driftSparksOrange, dt)
    advance(driftSparksPurple, dt)
    advance(exhaust, dt)
    advance(dust, dt)
    advance(explosion, dt)
    advance(missileTrail, dt)
    advance(bubbles, dt)
    advance(crestSpray, dt)
  }

  return { tick, triggerPumpBurst, emitWaveSpray }
}
