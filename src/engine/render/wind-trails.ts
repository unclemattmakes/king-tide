import * as THREE from 'three'
import type Node from 'three/src/nodes/core/Node.js'
import {
  attribute,
  cameraPosition,
  clamp,
  cross,
  float,
  fract,
  length,
  max,
  positionLocal,
  positionWorld,
  smoothstep,
  texture as tslTexture,
  uniform,
  uv,
  vec2,
} from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  type OilStrokeSheetSpec,
  packSheetRGBA8,
  rasterizeOilStrokeSheet,
} from '@/engine/render/oil-stroke-texture'
import { generateWindStreamline, resolveWindRegime } from '@/engine/render/wind-streamline'

/**
 * Ambient wind VFX — Wind-Waker-style illustrated gusts: white calligraphic
 * strokes that draw themselves along invisible streamlines around the player,
 * meandering with the wind and sometimes curling through a full loop-de-loop.
 *
 * How it works:
 *   - A fixed pool of streamline curves (`wind-streamline.ts` shapes them) is
 *     scattered in a shell around / ahead of the camera. Curves are static in
 *     the world while alive — what animates is a *stroke window* that sweeps
 *     head-to-tail along each curve in the shader, so the gust is "drawn in"
 *     at the head while the tail lifts off, like a brush pulled through air.
 *   - Everything per-frame lives on the GPU: one `uTime` uniform advances all
 *     strokes (per-trail birth/duration ride in a vertex attribute). The CPU
 *     only touches buffers when a trail's life ends and it respawns on a
 *     fresh curve near the camera (a few times per second across the pool).
 *   - One merged geometry + ONE node material + one draw call for the whole
 *     field — material count is the WebGPU pipeline-compile lever, and this
 *     adds exactly one.
 *   - The ribbon is extruded camera-facing in the vertex stage (tangent ×
 *     view), and off-window vertices collapse to zero width so dormant curve
 *     stretches cost no fill.
 *   - Edges dissolve through the same procedural oil-stroke language as the
 *     water foam (`oil-stroke-texture.ts`, PR #346): a seeded long-streak
 *     sheet erodes the stroke's flanks into bristle tips while the spine
 *     stays solid — painted, never airbrushed. No asset fetch, can't 404.
 *   - The look splits by what the rider feels: each respawn samples the
 *     APPARENT wind (true wind − smoothed camera velocity). Still = lazy,
 *     long-lived ghostly calligraphy drifting on the true wind, where a curl
 *     is a rare flourish; moving = speed-line streaks sweeping fast against
 *     your travel. `resolveWindRegime` blends the two continuously, with the
 *     ramp anchored to the bike: at 40% of normal top speed the lines are
 *     fully straight and curls stop spawning entirely (a hard rule).
 *
 * Render-only ambience: reads the camera + a wind/ground probe injected by
 * the caller, writes Three objects. The sim never knows wind trails exist.
 * Wired in `main.ts` next to the engine-trail tick; the clock is the wave
 * field's (`waveField.time`) so freeze-water freezes the gusts for clean
 * screenshots and replays reproduce them.
 */

export type WindSample = {
  /** TRUE-wind downwind direction, world XZ (need not be normalized). */
  x: number
  z: number
  /** True wind speed (m/s). What the strokes actually follow is the APPARENT
   *  wind (true wind − camera velocity, see resolveWindRegime), so this is
   *  the sweep speed only while the camera is still. */
  speed: number
}

export type WindTrailsOptions = {
  /** Live wind probe, sampled each time a trail respawns. */
  getWind: () => WindSample
  /** Highest blocking surface (terrain or water) at world XZ — trails keep
   *  ~1 m above it. Omit to float trails on `baseY` alone. */
  groundY?: (x: number, z: number) => number
  /** Fallback water level when `groundY` is absent. Default 0. */
  baseY?: number
  /** 0–12 Beaufort sea state — scales pool size + default wind speed so calm
   *  tracks get a few lazy curls and stormy ones a busy sky. Default 4. */
  beaufort?: number
  /** Override the Beaufort-derived pool size. */
  count?: number
  /** RNG seed for the curve shapes. */
  seed?: number
  /** The player bike's nominal top speed (m/s). Anchors the regime ramp and
   *  the hard no-curls cutoff at 40% of it. Default 28 (the stats baseline). */
  topSpeedMps?: number
}

export type WindTrailsSystem = {
  /** Per-frame update. `time` is the deterministic wave-field clock (s). */
  tick(camera: THREE.Camera, time: number): void
  setEnabled(on: boolean): void
  isEnabled(): boolean
  /** Global opacity scale (capture boosts / settings), clamped 0..2. */
  setIntensity(f: number): void
  /** Stroke tint — call once at boot to nudge toward the sky's warmth. */
  setTint(r: number, g: number, b: number): void
  /** Trails currently mid-stroke (debug/test hook). */
  activeCount(): number
  /** Per-trail spawn regime metadata (debug/test hook). */
  debug(): WindTrailDebug[]
  dispose(): void
}

// Stroke window as a fraction of curve arc length: the visible stroke is
// WINDOW/(1+WINDOW) ≈ 30% of its streamline at any instant.
const WINDOW = 0.42
// Curve resolution. 96 segments keeps a 1.5 m-radius curl (~24 segments
// around) round to the eye.
const SEGMENTS = 96
const HALF_WIDTH = 0.225 // metres at the stroke's fattest
const BASE_OPACITY = 0.55 // stroke-core alpha at intensity 1 — ghostly, not solid
const CLEARANCE = 1.1 // min metres above ground/water for any curve point
const TILE_METERS = 16 // world metres of stroke per grain-sheet repeat
// Curls are a rare flourish, and a hard rule kills them once you're moving
// with intent: at ≥ CURL_CUTOFF_FRAC of the bike's top speed every new
// streamline is loop-free — straight lines only.
const CURL_CHANCE_STILL = 0.22
const CURL_CUTOFF_FRAC = 0.4
const DEFAULT_TOP_SPEED = 28 // bikes/stats.ts default, for callers without stats

/**
 * The wind-stroke grain sheet: sparse, long, heavily-tapered bristle streaks
 * running along +U (the stroke direction). Sampled in a thin per-trail V band
 * to erode the ribbon's edges. Sister spec to the foam sheets — same
 * rasterizer, wind-trail scale.
 */
const WIND_STROKE_SHEET_SPEC: OilStrokeSheetSpec = {
  size: 512,
  seed: 4117,
  classes: [
    { count: 12, lenMin: 0.5, lenMax: 0.95, widthMin: 0.012, widthMax: 0.022, angleJitterDeg: 3 },
    { count: 12, lenMin: 0.22, lenMax: 0.5, widthMin: 0.007, widthMax: 0.014, angleJitterDeg: 5 },
  ],
  bristleMin: 2,
  bristleMax: 4,
  taperStart: 0.3,
  raggedness: 0.5,
}

/** Session-shared grain sheet (deterministic — one build serves every boot). */
let sharedWindSheet: THREE.DataTexture | null = null
function getWindStrokeTexture(): THREE.DataTexture {
  if (!sharedWindSheet) {
    const data = packSheetRGBA8(rasterizeOilStrokeSheet(WIND_STROKE_SHEET_SPEC))
    const tex = new THREE.DataTexture(
      data,
      WIND_STROKE_SHEET_SPEC.size,
      WIND_STROKE_SHEET_SPEC.size,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    )
    tex.name = 'wind:strokeGrain'
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.magFilter = THREE.LinearFilter
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.generateMipmaps = true
    tex.needsUpdate = true
    sharedWindSheet = tex
  }
  return sharedWindSheet
}

/** Deterministic PRNG (mulberry32) — same convention as clouds / oil sheets. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type TrailState = {
  birth: number
  duration: number
  /** Regime blend (0 ambient → 1 speed-lines) this trail spawned under. */
  blend: number
  /** Whether this trail's streamline carries a curl. */
  hasLoop: boolean
}

/** Per-trail spawn metadata, exposed for specs/tuning via `debug()`. */
export type WindTrailDebug = {
  blend: number
  hasLoop: boolean
  /** Mid-stroke right now (per the last ticked clock). */
  active: boolean
}

export function createWindTrailsSystem(
  scene: THREE.Scene,
  opts: WindTrailsOptions,
): WindTrailsSystem {
  const beaufort = Math.min(12, Math.max(0, opts.beaufort ?? 4))
  const count = Math.max(1, opts.count ?? Math.min(24, Math.round(6 + beaufort * 1.8)))
  const baseY = opts.baseY ?? 0
  const rng = mulberry32(opts.seed ?? 7331)
  // 40% of normal top speed: the regime ramp completes here AND new curls
  // stop spawning here — past it the wind is straight lines only.
  const curlCutoff = CURL_CUTOFF_FRAC * (opts.topSpeedMps ?? DEFAULT_TOP_SPEED)

  // ---- Geometry: `count` ribbons in one buffer, (SEGMENTS+1)×2 verts each.
  const ringsPerTrail = SEGMENTS + 1
  const vertsPerTrail = ringsPerTrail * 2
  const vertCount = count * vertsPerTrail
  const positions = new Float32Array(vertCount * 3)
  const tangents = new Float32Array(vertCount * 3)
  const seeds = new Float32Array(vertCount * 4)
  const uvs = new Float32Array(vertCount * 2)
  const indices = new Uint32Array(count * SEGMENTS * 6)

  for (let tr = 0; tr < count; tr++) {
    for (let i = 0; i < ringsPerTrail; i++) {
      const t = i / SEGMENTS
      for (let side = 0; side < 2; side++) {
        const vi = tr * vertsPerTrail + i * 2 + side
        uvs[vi * 2 + 0] = t
        uvs[vi * 2 + 1] = side
      }
    }
    let w = tr * SEGMENTS * 6
    for (let i = 0; i < SEGMENTS; i++) {
      const a = tr * vertsPerTrail + i * 2
      indices[w++] = a
      indices[w++] = a + 1
      indices[w++] = a + 2
      indices[w++] = a + 1
      indices[w++] = a + 3
      indices[w++] = a + 2
    }
  }

  const geometry = new THREE.BufferGeometry()
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage)
  const tanAttr = new THREE.BufferAttribute(tangents, 3).setUsage(THREE.DynamicDrawUsage)
  const seedAttr = new THREE.BufferAttribute(seeds, 4).setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', posAttr)
  geometry.setAttribute('aTangent', tanAttr)
  geometry.setAttribute('aSeed', seedAttr)
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  // The pool follows the camera; never let a stale bound cull it.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

  // ---- Material: one node material for the whole field.
  const uTime = uniform(0)
  const uWidth = uniform(HALF_WIDTH)
  const uOpacity = uniform(BASE_OPACITY)
  const uGrain = uniform(0.5) // edge-wobble amplitude: 0 = clean vector edge, ~1 = ragged dry brush
  const uGrainBand = uniform(0.035) // sheet-V half-band the ribbon's width samples
  // Slightly-HDR cool white: the cool nudge keeps the strokes legible against
  // warm haze skies, and the >1 push lets the bloom pass halo them faintly so
  // they read over bright backdrops the way WW's wind reads over blue.
  const uColor = uniform(new THREE.Color(1.16, 1.17, 1.22))

  const seed = attribute('aSeed', 'vec4') as unknown as Node<'vec4'>
  const aTangent = attribute('aTangent', 'vec3') as unknown as Node<'vec3'>
  const t = uv().x
  const across = uv().y.mul(2).sub(1) // -1 .. +1 across the ribbon
  const life = clamp(uTime.sub(seed.x).div(max(seed.y, float(1e-3))), 0, 1)
  const head = life.mul(1 + WINDOW)
  const tail = head.sub(WINDOW)

  // Stroke-window width profile: pointed lifting-off tail → blunt drawing
  // head (the oil-stroke silhouette, travelling). Ahead-of-head geometry
  // collapses to the centreline so invisible stretches rasterize nothing.
  const rel = clamp(t.sub(tail).div(WINDOW), 0, 1)
  const wProf = smoothstep(float(0), float(0.35), rel)
    .mul(float(1).sub(smoothstep(float(0.88), float(1), rel).mul(0.45)))
    .mul(float(1).sub(smoothstep(head, head.add(0.02), t)))
  const sizeJit = fract(seed.w.mul(7.31)).mul(0.5).add(0.75)
  const halfW = uWidth.mul(sizeJit).mul(wProf)

  const sideRaw = cross(aTangent, positionLocal.sub(cameraPosition))
  const sideN = sideRaw.div(max(length(sideRaw), float(1e-4)))

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  })
  // biome-ignore lint/suspicious/noExplicitAny: TSL node assignment to material slots
  material.positionNode = positionLocal.add(sideN.mul(halfW.mul(across))) as any

  // Alpha = stroke window sweep × crisp grain-wobbled edge × curve-end fades
  // × near-camera fade × per-trail strength jitter.
  //
  // Window: long dissolving tail, crisp drawing head (the brush tip).
  const aWin = smoothstep(tail, tail.add(WINDOW * 0.5), t).mul(
    float(1).sub(smoothstep(head.sub(WINDOW * 0.05), head, t)),
  )
  // Edge: a hard cutoff radius with a tight AA band — the vector-crisp WW
  // stroke — whose position the oil-grain sheet wobbles per-fragment, so the
  // flanks bristle like the foam's strokes instead of airbrushing out.
  const grainUv = vec2(
    t.mul(seed.z).add(fract(seed.w.mul(5.13)).mul(3)),
    seed.w.add(across.mul(uGrainBand)),
  )
  const grain = tslTexture(getWindStrokeTexture(), grainUv).r
  const edgePos = float(0.62).add(grain.sub(0.5).mul(uGrain))
  const profA = float(1).sub(smoothstep(edgePos.sub(0.18), edgePos, across.abs()))
  // The window usually hides the curve's geometric endpoints, but early/late
  // in life it can reach them — fade them out so a stroke never shows a hard
  // razor cut.
  const endFade = smoothstep(float(0), float(0.05), t).mul(
    float(1).sub(smoothstep(float(0.95), float(1), t)),
  )
  // Racing through a gust shouldn't white out the screen — dissolve strokes
  // as they close on the camera.
  const nearFade = smoothstep(float(4), float(9), length(positionWorld.sub(cameraPosition)))
  const opJit = fract(seed.w.mul(13.7)).mul(0.25).add(0.75)
  // biome-ignore lint/suspicious/noExplicitAny: TSL node assignment to material slots
  material.opacityNode = profA.mul(aWin).mul(endFade).mul(nearFade).mul(uOpacity).mul(opJit) as any
  // biome-ignore lint/suspicious/noExplicitAny: TSL node assignment to material slots
  material.colorNode = uColor as any

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'wind-trails'
  mesh.frustumCulled = false
  // Above the water's transparent repaint (see the ghost-vs-water sort trap)
  // and after the additive engine trails.
  mesh.renderOrder = 2
  scene.add(mesh)

  // ---- Pool state + respawn.
  const trails: TrailState[] = []
  for (let i = 0; i < count; i++) {
    trails.push({ birth: Number.POSITIVE_INFINITY, duration: 4, blend: 0, hasLoop: false })
  }

  const camPos = new THREE.Vector3()
  const camFwd = new THREE.Vector3()
  const lastCam = new THREE.Vector3()
  // Smoothed camera XZ velocity — spawn placement leads the camera by this so
  // the pool stays in front of a racing player instead of trailing behind.
  const camVel = new THREE.Vector3()
  let primed = false
  let lastTime = 0
  let enabled = true

  const groundAt = (x: number, z: number): number => (opts.groundY ? opts.groundY(x, z) : baseY)

  /** Regenerate one trail on a fresh streamline near the camera. `stagger`
   *  pushes its birth into the future so respawns never pop in mid-stroke. */
  function respawn(index: number, now: number, stagger: number): void {
    // Two regimes, blended by camera speed via the apparent wind (see
    // resolveWindRegime): still = the ambient calligraphy — slow, gently
    // curling, long-lived, drifting on the true wind; moving = speed-lines —
    // straight, short-lived streaks sweeping fast against your travel. The
    // ramp completes at the curl cutoff (40% of top speed), so by the time
    // curls are banned the lines are already fully straight.
    const regime = resolveWindRegime(opts.getWind(), camVel.x, camVel.z, {
      lo: curlCutoff * 0.45,
      hi: curlCutoff,
    })
    const b = regime.blend
    const lerp = (still: number, fast: number) => still + (fast - still) * b
    const drawnDuration = lerp(3.6, 1.6) + rng() * lerp(2.0, 0.8)
    // The hard rule: at ≥40% of normal top speed, no curls — straight lines
    // only. Below it they're a rare flourish that thins as you speed up.
    const camSpeed = Math.hypot(camVel.x, camVel.z)
    const curlChance = camSpeed >= curlCutoff ? 0 : CURL_CHANCE_STILL * (1 - b)
    // Clamp the curve length, then re-derive the life so the stroke window's
    // sweep speed stays the regime's apparent wind speed even when clamped.
    const lengthM = Math.min(60, Math.max(14, (regime.speed * drawnDuration) / (1 + WINDOW)))
    const duration = (lengthM * (1 + WINDOW)) / regime.speed

    const { points, loop } = generateWindStreamline(rng, {
      dirX: regime.dirX,
      dirZ: regime.dirZ,
      lengthM,
      segments: SEGMENTS,
      loopChance: curlChance,
      loopRadiusMin: 1.1,
      loopRadiusMax: 2.6,
      tiltMin: 0.45,
      tiltMax: 1.35,
      wander: lerp(0.5, 0.1),
      bobAmp: lerp(0.6, 0.25),
    })

    // Anchor the curve midpoint in a shell biased ahead of the camera, low
    // over whatever surface is there (most gusts skim; a few ride high).
    // "Ahead" follows the camera's motion when it's really moving (racing —
    // lead by where the camera will be mid-way through this stroke's life)
    // and its facing when near-still (countdown, podium drift).
    let fx = camSpeed > 3 ? camVel.x / camSpeed : camFwd.x
    let fz = camSpeed > 3 ? camVel.z / camSpeed : camFwd.z
    const fl = Math.hypot(fx, fz)
    if (fl > 1e-3) {
      fx /= fl
      fz /= fl
    } else {
      fx = 1
      fz = 0
    }
    const lead = Math.min(40, camSpeed) * (stagger + duration * 0.55)
    const dist = 9 + 40 * rng() * rng() + lead
    const lat = (rng() - 0.5) * 2 * (8 + 0.28 * dist)
    const ax = camPos.x + fx * dist - fz * lat
    const az = camPos.z + fz * dist + fx * lat
    // Most gusts skim low so the white reads against water/terrain rather than
    // washing out on a bright sky; a few ride high as sky calligraphy accents
    // when idle, almost none once you're racing (speed-lines hug the course).
    const skyRider = rng() < lerp(0.2, 0.04)
    const ay =
      groundAt(ax, az) + CLEARANCE + 0.4 + rng() * rng() * 6 + (skyRider ? 7 + rng() * 7 : 0)

    // Write the trail's buffer slice: anchored points (ground-clamped), then
    // central-difference tangents over the clamped result.
    const base = index * vertsPerTrail
    for (let i = 0; i < ringsPerTrail; i++) {
      const px = ax + points[i * 3 + 0]!
      let py = ay + points[i * 3 + 1]!
      const pz = az + points[i * 3 + 2]!
      const floor = groundAt(px, pz) + CLEARANCE
      if (py < floor) py = floor
      for (let side = 0; side < 2; side++) {
        const vi = (base + i * 2 + side) * 3
        positions[vi + 0] = px
        positions[vi + 1] = py
        positions[vi + 2] = pz
      }
    }
    for (let i = 0; i < ringsPerTrail; i++) {
      const iPrev = Math.max(0, i - 1)
      const iNext = Math.min(SEGMENTS, i + 1)
      const a = (base + iNext * 2) * 3
      const b = (base + iPrev * 2) * 3
      let tx = positions[a + 0]! - positions[b + 0]!
      let ty = positions[a + 1]! - positions[b + 1]!
      let tz = positions[a + 2]! - positions[b + 2]!
      const tl = Math.hypot(tx, ty, tz)
      if (tl > 1e-6) {
        tx /= tl
        ty /= tl
        tz /= tl
      } else {
        tx = fx
        ty = 0
        tz = fz
      }
      for (let side = 0; side < 2; side++) {
        const vi = (base + i * 2 + side) * 3
        tangents[vi + 0] = tx
        tangents[vi + 1] = ty
        tangents[vi + 2] = tz
      }
    }

    const trail = trails[index]!
    trail.birth = now + stagger
    trail.duration = duration
    trail.blend = b
    trail.hasLoop = loop !== null
    const s01 = rng()
    const uRepeat = lengthM / TILE_METERS
    for (let v = 0; v < vertsPerTrail; v++) {
      const vi = (base + v) * 4
      seeds[vi + 0] = trail.birth
      seeds[vi + 1] = duration
      seeds[vi + 2] = uRepeat
      seeds[vi + 3] = s01
    }
  }

  function markDirty(): void {
    posAttr.needsUpdate = true
    tanAttr.needsUpdate = true
    seedAttr.needsUpdate = true
  }

  /** Reseed the whole pool around the camera with births spread across one
   *  full cycle — boot, teleports, and clock rewinds all land here. */
  function resetAll(now: number): void {
    for (let i = 0; i < count; i++) respawn(i, now, rng() * 5)
    markDirty()
  }

  function tick(camera: THREE.Camera, time: number): void {
    ;(uTime as unknown as { value: number }).value = time
    if (!enabled) return
    camera.getWorldPosition(camPos)
    camera.getWorldDirection(camFwd)

    // Teleports (race restart, broadcast cuts) and clock rewinds (replay
    // scrubs) orphan the pool — reseed around the new view.
    const jumped = primed && camPos.distanceToSquared(lastCam) > 150 * 150
    const rewound = primed && time < lastTime - 0.5
    const dt = time - lastTime
    if (primed && !jumped && !rewound && dt > 1e-4 && dt < 0.5) {
      // Low-pass the camera velocity (~smoothing over a few frames) so one
      // hitchy frame doesn't fling the spawn lead.
      camVel.x += ((camPos.x - lastCam.x) / dt - camVel.x) * 0.2
      camVel.z += ((camPos.z - lastCam.z) / dt - camVel.z) * 0.2
    }
    lastCam.copy(camPos)
    lastTime = time
    if (!primed || jumped || rewound) {
      primed = true
      camVel.set(0, 0, 0)
      resetAll(time)
      return
    }

    let dirty = false
    for (let i = 0; i < count; i++) {
      const trail = trails[i]!
      if (time >= trail.birth + trail.duration) {
        respawn(i, time, rng() * 0.9)
        dirty = true
      }
    }
    if (dirty) markDirty()
  }

  function activeCount(): number {
    let n = 0
    for (const trail of trails) {
      const life = (lastTime - trail.birth) / trail.duration
      if (life > 0 && life < 1) n++
    }
    return n
  }

  const system: WindTrailsSystem = {
    tick,
    setEnabled(on: boolean) {
      enabled = on
      mesh.visible = on
    },
    isEnabled: () => enabled,
    setIntensity(f: number) {
      ;(uOpacity as unknown as { value: number }).value = BASE_OPACITY * Math.min(2, Math.max(0, f))
    },
    setTint(r: number, g: number, b: number) {
      ;(uColor as unknown as { value: THREE.Color }).value.setRGB(r, g, b)
    },
    activeCount,
    debug() {
      return trails.map((trail) => {
        const life = (lastTime - trail.birth) / trail.duration
        return { blend: trail.blend, hasLoop: trail.hasLoop, active: life > 0 && life < 1 }
      })
    },
    dispose() {
      scene.remove(mesh)
      geometry.dispose()
      material.dispose()
    },
  }

  // Dev/test read-back hook (mirrors `__bikeField`) so a harness can assert
  // live gusts without depending on camera framing.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    ;(window as unknown as { __windTrails?: WindTrailsSystem }).__windTrails = system
  }

  return system
}
