import { hasComponent, query } from 'bitecs'
import * as THREE from 'three'
import { attribute, texture as tslTexture, uniform } from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import type { SimWorld } from '@/engine/sim/ecs/world'
import {
  BikeStatsStore,
  BikeTag,
  GhostTag,
  PlayerTag,
  Transform,
  TransformStore,
} from '@/game/components'
import type { BikeRenderRegistry } from './render-systems'

/**
 * Painterly **ribbon** trails streaming off each bike's engine nozzles.
 *
 * Each bike's authored FX thruster sockets (`fx_thruster_l` / `_r`, resolved
 * from the bike registry's per-variant `socketLocals`) get a camera-facing
 * quad-strip rebuilt every frame from the last `TRAIL_LENGTH` world-space
 * anchor positions of that nozzle. Because we append one anchor per frame and
 * keep a fixed count, the ribbon spans a ~0.6 s window — so its LENGTH scales
 * with speed for free: a gentle stub when cruising, a long streak at full tilt.
 * Ribbon width + alpha additionally ramp with speed so it reads gentle when
 * slow. A brush texture (soft across, bristle grain along) + per-bike accent
 * tint give the painted read; additive + depth-write-off makes it glow.
 *
 * Adapted from the retired `trail-render.ts` (the tail-light ribbon), now
 * brush-textured and origin'd on the real engine sockets. WebGPU/TSL node
 * material. The sim never sees this — render-only, read-only of Transform.
 */
const TRAIL_LENGTH = 16 // ribbon resolution (samples)
// THE length dial: the ribbon spans this many seconds of travel, so its world
// length ≈ speed × TRAIL_SECONDS — frame-rate independent. At ~14 m/s cruise this
// is a ~3 m stub; it grows with speed and a boost burst stretches it out.
const TRAIL_SECONDS = 0.22
const SAMPLE_DT = TRAIL_SECONDS / (TRAIL_LENGTH - 1) // time between committed anchors
const HALF_WIDTH = 0.24 // ribbon half-width (metres) at full speed
const MIN_SPEED = 2.5 // below this the ribbon thins + fades toward a gentle stub
const FULL_SPEED = 22 // width/alpha reach full here
const SLOW_FLOOR = 0.18 // residual width/alpha fraction at a standstill (never 0)
const DEFAULT_OFFSET = { x: 0, y: 0.05, z: -1.5 } // engine point when a bike has no FX sockets
const PLAYER_COLOR = new THREE.Color(0xffb070) // warm amber for the player
const AI_COLORS = [0x66ccff, 0x77ee99, 0xdd88ff, 0xffe066, 0xff8899].map((c) => new THREE.Color(c))
const ENGINE_SLOTS = ['fx_thruster_l', 'fx_thruster_r'] as const

/** Soft-edged white band (alpha fades across U) with vertical bristle streaks
 *  (along V) — the ribbon's painted grain. Tinted per-bike by the vertex aTint. */
function makeRibbonTexture(): THREE.Texture {
  const w = 48
  const h = 128
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('engine-trail: 2d context unavailable')
  // Across-U soft edge: transparent → opaque → transparent.
  const grad = ctx.createLinearGradient(0, 0, w, 0)
  grad.addColorStop(0, 'rgba(255,255,255,0)')
  grad.addColorStop(0.5, 'rgba(255,255,255,1)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  // Along-V bristle streaks for a hand-painted grain.
  ctx.globalCompositeOperation = 'destination-out'
  for (let k = 0; k < 7; k++) {
    const x = Math.random() * w
    ctx.strokeStyle = `rgba(0,0,0,${0.15 + Math.random() * 0.3})`
    ctx.lineWidth = 0.6 + Math.random() * 1.4
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x + (Math.random() * 2 - 1) * 4, h)
    ctx.stroke()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  return tex
}

function buildIndices(): Uint16Array {
  const ix: number[] = []
  for (let i = 0; i < TRAIL_LENGTH - 1; i++) {
    const a = 2 * i
    ix.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  return new Uint16Array(ix)
}
const TRAIL_INDICES = buildIndices()

type Trail = {
  mesh: THREE.Mesh
  geometry: THREE.BufferGeometry
  anchors: Float32Array // world history, TRAIL_LENGTH * 3
  ribbon: Float32Array // vertex positions, TRAIL_LENGTH * 2 * 3
  uAlpha: ReturnType<typeof uniform>
  prevHead: THREE.Vector3
  primed: boolean
  sampleAccum: number
}

export function createEngineTrailSystem(
  scene: THREE.Scene,
  sim: SimWorld,
  bikeRegistry?: BikeRenderRegistry,
) {
  const trails = new Map<number, Trail>()
  const ribbonTex = makeRibbonTexture()
  let aiCursor = 0

  const quat = new THREE.Quaternion()
  const pos = new THREE.Vector3()
  const anchor = new THREE.Vector3()
  const tangent = new THREE.Vector3()
  const viewDir = new THREE.Vector3()
  const widthDir = new THREE.Vector3()
  const camPos = new THREE.Vector3()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const engineLocals: { x: number; y: number; z: number }[] = []

  /** The set of engine-nozzle local points for a bike: both thrusters if
   *  authored, else the single exhaust socket, else a default rear point. */
  function resolveEngineLocals(eid: number): void {
    engineLocals.length = 0
    const variantId = BikeStatsStore.get(eid)?.variantId
    const loaded =
      (variantId !== undefined ? bikeRegistry?.byVariantId[variantId] : undefined) ??
      bikeRegistry?.default
    const sl = loaded?.socketLocals
    if (sl) {
      for (const slot of ENGINE_SLOTS) if (sl[slot]) engineLocals.push(sl[slot]!)
      if (engineLocals.length === 0 && sl.fx_exhaust) engineLocals.push(sl.fx_exhaust)
    }
    if (engineLocals.length === 0) engineLocals.push(DEFAULT_OFFSET)
  }

  function createTrail(eid: number): Trail {
    const isPlayer = hasComponent(sim, eid, PlayerTag)
    const color = isPlayer
      ? PLAYER_COLOR
      : (AI_COLORS[aiCursor++ % AI_COLORS.length] ?? PLAYER_COLOR)

    const anchors = new Float32Array(TRAIL_LENGTH * 3)
    const ribbon = new Float32Array(TRAIL_LENGTH * 2 * 3)
    const uv = new Float32Array(TRAIL_LENGTH * 2 * 2)
    const tint = new Float32Array(TRAIL_LENGTH * 2 * 3)
    const fade = new Float32Array(TRAIL_LENGTH * 2)
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      const u = i / (TRAIL_LENGTH - 1) // 0 = oldest tail, 1 = newest head
      const f = u * u // quadratic fade — bright at the nozzle, gone at the tail
      for (let side = 0; side < 2; side++) {
        const vi = i * 2 + side
        uv[vi * 2 + 0] = side
        uv[vi * 2 + 1] = 1 - u // texture head at the nozzle
        tint[vi * 3 + 0] = color.r
        tint[vi * 3 + 1] = color.g
        tint[vi * 3 + 2] = color.b
        fade[vi] = f
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(ribbon, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geometry.setAttribute('aTint', new THREE.BufferAttribute(tint, 3))
    geometry.setAttribute('aFade', new THREE.BufferAttribute(fade, 1))
    geometry.setIndex(new THREE.BufferAttribute(TRAIL_INDICES, 1))
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

    const uAlpha = uniform(0)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    // biome-ignore lint/suspicious/noExplicitAny: TSL node assignment to material slots
    material.colorNode = tslTexture(ribbonTex).rgb.mul(attribute('aTint', 'vec3')) as any
    // Contrast-budget cap: the ribbon is additive AND double-sided, so
    // every quad contributes twice, and two nozzles × 8 bikes stack to
    // a white core that outshines actual gameplay signals. Cap the
    // whole ribbon's energy under the "brightest thing on screen is a
    // gameplay event" rule (making-of ch. 8).
    const TRAIL_LUMA_CAP = 0.6
    // biome-ignore lint/suspicious/noExplicitAny: TSL .mul() overloads vs uniform() node type
    material.opacityNode = tslTexture(ribbonTex)
      .a.mul(attribute('aFade', 'float'))
      .mul(uAlpha as any)
      .mul(TRAIL_LUMA_CAP) as any

    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = 1
    scene.add(mesh)
    return {
      mesh,
      geometry,
      anchors,
      ribbon,
      uAlpha,
      prevHead: new THREE.Vector3(),
      primed: false,
      sampleAccum: 0,
    }
  }

  function tick(camera: THREE.Camera, dt: number): void {
    camera.getWorldPosition(camPos)
    const eids = query(sim, [BikeTag, Transform])
    const live = new Set<number>()

    for (const eid of eids) {
      if (hasComponent(sim, eid, GhostTag)) continue
      const t = TransformStore.must(eid)
      quat.set(t.qx, t.qy, t.qz, t.qw)
      pos.set(t.x, t.y, t.z)
      resolveEngineLocals(eid)

      for (let ei = 0; ei < engineLocals.length; ei++) {
        const key = eid * 4 + ei
        live.add(key)
        let trail = trails.get(key)
        if (!trail) {
          trail = createTrail(eid)
          trails.set(key, trail)
        }

        const loc = engineLocals[ei]!
        anchor.set(loc.x, loc.y, loc.z).applyQuaternion(quat).add(pos)

        // Speed proxy from how far the nozzle moved this frame (no physics dep).
        const speed = trail.primed ? anchor.distanceTo(trail.prevHead) / Math.max(dt, 1e-4) : 0
        trail.prevHead.copy(anchor)

        const anchors = trail.anchors
        const last = (TRAIL_LENGTH - 1) * 3
        if (!trail.primed) {
          for (let i = 0; i < TRAIL_LENGTH; i++) {
            anchors[i * 3 + 0] = anchor.x
            anchors[i * 3 + 1] = anchor.y
            anchors[i * 3 + 2] = anchor.z
          }
          trail.primed = true
          trail.sampleAccum = 0
        } else {
          // The head always tracks the live nozzle; a spaced anchor is committed
          // every SAMPLE_DT so the ribbon spans TRAIL_SECONDS of travel regardless
          // of frame rate (length = speed × TRAIL_SECONDS).
          anchors[last + 0] = anchor.x
          anchors[last + 1] = anchor.y
          anchors[last + 2] = anchor.z
          trail.sampleAccum += dt
          let guard = TRAIL_LENGTH
          while (trail.sampleAccum >= SAMPLE_DT && guard-- > 0) {
            trail.sampleAccum -= SAMPLE_DT
            anchors.copyWithin(0, 3)
            anchors[last + 0] = anchor.x
            anchors[last + 1] = anchor.y
            anchors[last + 2] = anchor.z
          }
        }

        // Speed → width + alpha (gentle when slow, full when fast).
        const sp = Math.min(1, Math.max(0, (speed - MIN_SPEED) / (FULL_SPEED - MIN_SPEED)))
        const k = SLOW_FLOOR + (1 - SLOW_FLOOR) * sp
        const halfW = HALF_WIDTH * k
        ;(trail.uAlpha as unknown as { value: number }).value = k

        // Camera-facing ribbon: extrude each anchor ± (tangent × viewDir).
        const ribbon = trail.ribbon
        for (let i = 0; i < TRAIL_LENGTH; i++) {
          const ip = Math.max(0, i - 1)
          const inx = Math.min(TRAIL_LENGTH - 1, i + 1)
          a.set(anchors[inx * 3]!, anchors[inx * 3 + 1]!, anchors[inx * 3 + 2]!)
          b.set(anchors[ip * 3]!, anchors[ip * 3 + 1]!, anchors[ip * 3 + 2]!)
          tangent.copy(a).sub(b)
          if (tangent.lengthSq() < 1e-10) tangent.set(0, 0, 1)
          else tangent.normalize()
          viewDir
            .set(anchors[i * 3]!, anchors[i * 3 + 1]!, anchors[i * 3 + 2]!)
            .sub(camPos)
            .normalize()
          widthDir.copy(tangent).cross(viewDir)
          const len = widthDir.length()
          if (len < 1e-6) widthDir.set(1, 0, 0)
          else widthDir.multiplyScalar(halfW / len)
          const ax = anchors[i * 3]!
          const ay = anchors[i * 3 + 1]!
          const az = anchors[i * 3 + 2]!
          const li = i * 2 * 3
          ribbon[li + 0] = ax + widthDir.x
          ribbon[li + 1] = ay + widthDir.y
          ribbon[li + 2] = az + widthDir.z
          ribbon[li + 3] = ax - widthDir.x
          ribbon[li + 4] = ay - widthDir.y
          ribbon[li + 5] = az - widthDir.z
        }
        ;(trail.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
      }
    }

    // Dispose trails for nozzles/bikes that are gone.
    for (const [key, trail] of trails) {
      if (live.has(key)) continue
      scene.remove(trail.mesh)
      trail.geometry.dispose()
      if (trail.mesh.material instanceof THREE.Material) trail.mesh.material.dispose()
      trails.delete(key)
    }
  }

  return { tick }
}
