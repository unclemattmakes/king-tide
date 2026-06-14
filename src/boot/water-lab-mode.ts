/**
 * Water lab — the dedicated scene for analyzing the water's motion and
 * customizing its visual qualities. Deep open ocean + sky + the full WATER
 * tuner panel (auto-opened), with motion ground-truth instruments that make
 * the "contour lines slide over the surface" class of artifact directly
 * visible and measurable:
 *
 *   - PACE CONES — one marker per swell train gliding at exactly that
 *     train's phase speed (plus a magenta marker at the painted foam
 *     field's 0.1 m/s drift). Contour lines should never visibly outrun
 *     the cones; before the iso-coherence fix they periodically do.
 *   - DRIFTER GRID — red dots pinned to fixed world XZ riding the sim
 *     surface (the closest thing to "the water itself" — real water
 *     translates at ~Stokes-drift speed, not phase speed).
 *   - ISO-SPEED PROBE — analytic −∂h/∂t ÷ |∇h| of the swell-only
 *     readability field at the origin pillar: the exact speed an
 *     iso-height contour line sweeps past the pillar, live in the HUD
 *     with a peak-hold. A CPU mirror of the GPU field (including the
 *     contour-coherence blend), so the number IS the line speed.
 *
 * Triggered by `?waterlab=1`. No track, no physics, no bikes — boots in a
 * couple of seconds and isolates the open-ocean swell (no shoaling, no
 * zones), per the deep-ocean test-bed lesson.
 *
 * Controls:
 *   drag / scroll — orbit camera
 *   1 / 2 / 3     — camera presets: race-height grazing / three-quarter /
 *                   top-down (the topo-map read — racing is most legible here)
 *   Space         — pause the wave clock (the tuner's Time-scale slider
 *                   still applies when running)
 *   .             — step one 60 Hz frame while paused
 *   G / P / O     — toggle drifter grid / pace cones / probe pillar
 *   T / Shift+T   — step time-of-day ±20 s around the 0–360 s sky cycle
 *
 * e2e hook: `window.__waterlab` (see WaterLabHook) — exposes the analytic
 * probe + a time×space scanner so the racing diagnosis and the coherence
 * fix are CI-assertable numbers, not just eyeballs.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createRenderer } from '@/engine/render/renderer'
import { renderFrame } from '@/engine/render/renderer-service'
import { createScene } from '@/engine/render/scene'
import { createSkySystem } from '@/engine/render/sky'
import { createWaterMesh, updateUnderwaterFog, type WaterMesh } from '@/engine/render/water'
import {
  advanceWaveField,
  createWaveField,
  defaultWaves,
  SWELL_WAVELENGTH_MIN,
  sampleHeight,
} from '@/engine/sim/water/wave-field'
import { installWaterDebugMenu } from '@/engine/water-debug-menu'
import { applyStoredWaterTuning } from '@/engine/water-debug-storage'
import { hideLoadingScreen, setLoadingMessage } from './loading-screen'
import { createSimSurfaceProbe } from './sim-surface-probe'

export type WaterLabModeHandle = {
  dispose(): void
}

declare global {
  interface Window {
    /** Water-lab e2e/console hook — present only in the `?waterlab` scene. */
    __waterlab?: WaterLabHook
  }
}

/** Analytic swell-only signal at one point — the CPU mirror of the GPU's
 *  readability field (`swellSig` in water.ts): height, time derivative and
 *  world-frame gradient of the coherence-weighted swell sum. */
type SwellSignal = { h: number; ht: number; gx: number; gz: number }

export type WaterLabHook = {
  /** Live iso-line sweep speed at the probe pillar, m/s. */
  isoSpeed(): number
  /** Peak iso-line sweep speed over the trailing ~5 s, m/s. */
  isoPeak(): number
  /** The swell trains the readability field sums. */
  phaseSpeeds(): Array<{ wavelength: number; speed: number }>
  /** Set-beat period of the two largest swell trains, seconds (null if <2). */
  beatPeriodS(): number | null
  /**
   * Scan iso-line sweep speed over time × space (analytic, no rendering):
   * the max of −∂h/∂t ÷ |∇h| over `durationS` of field time on a
   * ±`gridHalf` m grid, counting only points whose swell slope ≥ `slopeMin`
   * (lines below the legacy gate floor are invisible anyway). Uses the LIVE
   * contour-coherence value, so coherence 0 exposes the two-train racing
   * and coherence 1 must report the dominant train's phase speed exactly.
   */
  scanIsoMax(opts?: {
    durationS?: number
    slopeMin?: number
    gridHalf?: number
    gridStep?: number
    dtS?: number
  }): { maxV: number; atSlope: number }
  /** Sim surface height at world (x, z) — what the red drifter dots trace
   *  and what buoyancy floats the bike on (`sampleHeight`). Pause assertions
   *  read it. */
  surfaceYAt(x: number, z: number): number
  /** The RENDERED mesh position for the rest-grid vertex (x, z): the GPU
   *  vertex shader's forward Gerstner transform mirrored on the CPU
   *  (`waterMesh.renderVertex`). Returns the displaced world position
   *  `{ x, y, z }` — where the wireframe actually draws that vertex. */
  meshVertexAt(x: number, z: number): { x: number; y: number; z: number }
  /**
   * Dot↔mesh sync scan: for a rest-grid of vertices, forward-transform each
   * to its drawn world position via the GPU mirror, then sample the SIM
   * surface (the red dots) at that same world XZ. The residual `dot − mesh`
   * is the vertical gap the dots show against the rendered wireframe — 0
   * means the buoyancy field the bike feels is exactly the surface drawn.
   * Pure math, no rendering; pause first for a stable phase.
   */
  dotMeshResidual(opts?: { half?: number; step?: number }): {
    maxAbs: number
    mean: number
    n: number
    worst: { x: number; z: number; dot: number; mesh: number; d: number }
  }
  setPaused(on: boolean): void
  isPaused(): boolean
  /** Advance exactly one 60 Hz frame (works while paused). */
  step(): void
  setCamPreset(n: 1 | 2 | 3 | 4): void
  /** The live water-shader debug surface (same object the tuner drives). */
  water: WaterMesh['debug']
}

/** Pace-marker palette: primary swell, further trains, paint drift. */
const PACE_COLORS = [0x36e26a, 0xffc83c, 0x7ad7ff, 0xc9ff5e]
const PAINT_DRIFT_COLOR = 0xff4fd8
/** The foam brush field's travel drift, m/s — `brushTravel`'s
 *  `.sub(tNode.mul(0.1))` in water.ts. The slowest "surface paint" cue. */
const PAINT_DRIFT_SPEED = 0.1
/** Pace corridor: markers glide along travel and wrap inside ±half. */
const PACE_WRAP_HALF = 70

export async function bootWaterLabMode(appEl: HTMLElement): Promise<WaterLabModeHandle> {
  setLoadingMessage('Loading water lab…')

  const { renderer, backend, canvas, dispose: disposeRenderer } = await createRenderer(appEl)
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'

  const { scene, camera, sun, hemi } = createScene()
  // No track geometry to hide the fog seam — push it out like waveriders.
  scene.fog = new THREE.Fog(0xa6c4e2, 200, 1600)

  const waveField = createWaveField(defaultWaves())
  const waterMesh = createWaterMesh(waveField, { backend })
  scene.add(waterMesh.mesh)
  // Mirror-pass cull (sky-only here — no terrain in the lab); keeps the
  // lab's frame representative of the shipped reflection cost.
  waterMesh.configureReflectionCulling(camera)
  applyStoredWaterTuning(waterMesh)
  // Full WATER tuner, auto-opened — this scene exists to turn its knobs.
  document.body.classList.add('dev-build')
  const waterMenu = installWaterDebugMenu(waterMesh)
  waterMenu.open()

  const sky = createSkySystem({
    scene,
    renderer,
    camera,
    sun,
    hemi,
    water: waterMesh,
  })

  // ---- Analytic swell-only probe (CPU mirror of the GPU field) -------
  // Mirrors `buildGerstnerHeight` (water.ts) restricted to the swell band,
  // with the dominant-train coherence weighting applied the same way the
  // vertex stage blends it. Open ocean: no zones, shoalFactor = 1.
  function dominantSwellIdx(): number {
    let dom = -1
    for (let i = 0; i < waveField.waves.length; i++) {
      const w = waveField.waves[i]!
      if (w.wavelength < SWELL_WAVELENGTH_MIN) continue
      if (dom < 0 || Math.abs(w.amplitude) > Math.abs(waveField.waves[dom]!.amplitude)) dom = i
    }
    return dom
  }

  const _sig: SwellSignal = { h: 0, ht: 0, gx: 0, gz: 0 }
  function sampleSwellSignal(x: number, z: number, t: number, out: SwellSignal): void {
    const bearingRad = (waterMesh.debug.getWaveBearing() * Math.PI) / 180
    const coherence = waterMesh.debug.getContourCoherence()
    const dom = dominantSwellIdx()
    const cosB = Math.cos(bearingRad)
    const sinB = Math.sin(bearingRad)
    const xRot = x * cosB + z * sinB
    const zRot = z * cosB - x * sinB
    let h = 0
    let ht = 0
    let rgx = 0
    let rgz = 0
    for (let i = 0; i < waveField.waves.length; i++) {
      const w = waveField.waves[i]!
      if (w.wavelength < SWELL_WAVELENGTH_MIN) continue
      const weight = i === dom ? 1 : 1 - coherence
      if (weight <= 0) continue
      const k = (2 * Math.PI) / w.wavelength
      const omega = w.speed * k
      const phase = k * (w.dirX * xRot + w.dirZ * zRot) - omega * t + w.phase
      const a = w.amplitude * weight
      const s = Math.sin(phase)
      const c = Math.cos(phase)
      h += a * s
      ht += a * c * -omega
      rgx += a * c * k * w.dirX
      rgz += a * c * k * w.dirZ
    }
    out.h = h
    out.ht = ht
    // Rotate the rotated-frame gradient back to world XZ (chain rule),
    // exactly as the shader does.
    out.gx = rgx * cosB - rgz * sinB
    out.gz = rgx * sinB + rgz * cosB
  }

  /** Iso-line sweep speed −∂h/∂t ÷ |∇h| from a sampled signal, m/s. */
  function isoSpeedOf(sig: SwellSignal): number {
    const slope = Math.hypot(sig.gx, sig.gz)
    return Math.abs(sig.ht) / Math.max(slope, 1e-4)
  }

  // Probe state — sampled at the pillar (world origin) each frame. Readings
  // only update while the local swell slope clears the legacy gate floor
  // (0.02): below it the shader fades the lines out, so an iso speed there
  // is real math about an invisible line — the HUD flags it instead.
  let probeIso = 0
  let probeFaded = false
  let probePeak = 0
  let probePeakAge = 0
  const PROBE_PEAK_HOLD_S = 5
  const PROBE_SLOPE_VISIBLE = 0.02

  function swellTrains(): Array<{ wavelength: number; speed: number }> {
    return waveField.waves
      .filter((w) => w.wavelength >= SWELL_WAVELENGTH_MIN)
      .map((w) => ({ wavelength: w.wavelength, speed: w.speed }))
  }

  function beatPeriodS(): number | null {
    const swells = waveField.waves
      .filter((w) => w.wavelength >= SWELL_WAVELENGTH_MIN)
      .sort((a, b) => Math.abs(b.amplitude) - Math.abs(a.amplitude))
      .slice(0, 2)
    if (swells.length < 2) return null
    const omega = (w: (typeof swells)[number]) => (w.speed * 2 * Math.PI) / w.wavelength
    const dOmega = Math.abs(omega(swells[0]!) - omega(swells[1]!))
    return dOmega < 1e-6 ? null : (2 * Math.PI) / dOmega
  }

  // ---- Probe pillar (watch contour lines cross it) --------------------
  const pillarGeo = new THREE.CylinderGeometry(0.09, 0.09, 3.2, 10)
  const pillarMat = new THREE.MeshBasicMaterial({ color: 0x37e0ff })
  const pillar = new THREE.Mesh(pillarGeo, pillarMat)
  pillar.renderOrder = 998
  scene.add(pillar)

  // ---- Drifter grid (the "water itself" reference) ---------------------
  const drifters = createSimSurfaceProbe(scene)

  // ---- Pace cones (phase-speed ground truth) ---------------------------
  function makeLabelSprite(text: string, color: string): THREE.Sprite {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 48
    const ctx = c.getContext('2d')
    if (ctx) {
      ctx.font = 'bold 26px ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineWidth = 6
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'
      ctx.strokeText(text, 128, 24)
      ctx.fillStyle = color
      ctx.fillText(text, 128, 24)
    }
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }),
    )
    sprite.scale.set(6.4, 1.2, 1)
    return sprite
  }

  type PaceMarker = {
    mesh: THREE.Mesh
    label: THREE.Sprite
    speed: number
    /** Wave-bank direction (pre-bearing); world dir derives per frame. */
    dirX: number
    dirZ: number
    crossOffset: number
    alongOffset: number
  }
  const paceGroup = new THREE.Group()
  scene.add(paceGroup)
  const paceGeo = new THREE.ConeGeometry(0.5, 1.5, 12)
  const paceMarkers: PaceMarker[] = []
  const paceMats: THREE.MeshBasicMaterial[] = []

  function addPaceMarker(
    labelText: string,
    color: number,
    speed: number,
    dirX: number,
    dirZ: number,
    crossOffset: number,
  ): void {
    const mat = new THREE.MeshBasicMaterial({ color })
    paceMats.push(mat)
    const mesh = new THREE.Mesh(paceGeo, mat)
    mesh.renderOrder = 998
    const label = makeLabelSprite(labelText, `#${color.toString(16).padStart(6, '0')}`)
    paceGroup.add(mesh)
    paceGroup.add(label)
    paceMarkers.push({
      mesh,
      label,
      speed,
      dirX,
      dirZ,
      crossOffset,
      alongOffset: -PACE_WRAP_HALF * 0.5 + paceMarkers.length * 7,
    })
  }

  {
    let i = 0
    for (const w of waveField.waves) {
      if (w.wavelength < SWELL_WAVELENGTH_MIN) continue
      addPaceMarker(
        `λ${w.wavelength.toFixed(0)} swell · ${w.speed.toFixed(1)} m/s`,
        PACE_COLORS[i % PACE_COLORS.length]!,
        w.speed,
        w.dirX,
        w.dirZ,
        i * 12 - 6,
      )
      i++
    }
    addPaceMarker(
      `foam paint · ${PAINT_DRIFT_SPEED.toFixed(1)} m/s`,
      PAINT_DRIFT_COLOR,
      PAINT_DRIFT_SPEED,
      1,
      0,
      -18,
    )
  }

  const _coneUp = new THREE.Vector3(0, 1, 0)
  const _dir3 = new THREE.Vector3()
  function updatePaceMarkers(): void {
    const bearingRad = (waterMesh.debug.getWaveBearing() * Math.PI) / 180
    const cosB = Math.cos(bearingRad)
    const sinB = Math.sin(bearingRad)
    for (const m of paceMarkers) {
      // Wave direction rotated by the live bearing into world frame.
      const wx = m.dirX * cosB - m.dirZ * sinB
      const wz = m.dirX * sinB + m.dirZ * cosB
      // Crest axis (perpendicular) carries the lane offset.
      const cx = -wz
      const cz = wx
      const travelled = m.speed * waveField.time + m.alongOffset
      const along =
        ((((travelled + PACE_WRAP_HALF) % (PACE_WRAP_HALF * 2)) + PACE_WRAP_HALF * 2) %
          (PACE_WRAP_HALF * 2)) -
        PACE_WRAP_HALF
      const x = wx * along + cx * m.crossOffset
      const z = wz * along + cz * m.crossOffset
      const y = sampleHeight(waveField, x, z)
      m.mesh.position.set(x, y + 0.75, z)
      _dir3.set(wx, 0, wz).normalize()
      m.mesh.quaternion.setFromUnitVectors(_coneUp, _dir3)
      m.label.position.set(x, y + 2.1, z)
    }
  }

  // ---- Camera ----------------------------------------------------------
  const orbit = new OrbitControls(camera, canvas)
  orbit.enableDamping = true
  orbit.dampingFactor = 0.09
  orbit.minDistance = 2
  orbit.maxDistance = 220
  orbit.maxPolarAngle = Math.PI * 0.495
  orbit.target.set(0, 0, 0)

  function setCamPreset(n: 1 | 2 | 3 | 4): void {
    const bearingRad = (waterMesh.debug.getWaveBearing() * Math.PI) / 180
    const wx = Math.cos(bearingRad)
    const wz = Math.sin(bearingRad)
    if (n === 1) {
      // Race-height grazing shot looking INTO the approaching swell.
      camera.position.set(wx * 42, 5, wz * 42)
    } else if (n === 2) {
      // Three-quarter diagnostic view.
      camera.position.set(wx * 38 - wz * 30, 26, wz * 38 + wx * 30)
    } else if (n === 3) {
      // Top-down — the topo-map read; iso-line motion is most legible here.
      camera.position.set(2, 95, 2)
    } else {
      // Side PROFILE — sit out along the crest axis (perpendicular to wave
      // travel) at near-water height and look horizontally across the swell.
      // Crests run toward/away from camera, so the surface reads as a 2-D
      // wave profile and the red sim dots sit visibly ON (or floating OFF)
      // the rendered mesh. This is the dot↔mesh height check — perspective
      // can't fake a vertical gap here the way the ¾/persp views can.
      const cx = -wz
      const cz = wx
      camera.position.set(cx * 58, 5.5, cz * 58)
    }
    orbit.target.set(0, 0, 0)
    orbit.update()
  }
  setCamPreset(2)

  // ---- Time controls ---------------------------------------------------
  let labPaused = false
  let todSeconds: number | null = null
  const FIXED_DT = 1 / 60
  // Advance synchronously (not queued for the frame loop): Chromium starves
  // rAF in unfocused headed windows, so a queued step would silently never
  // land for a backgrounded e2e page — the probe/render catch up next frame.
  function stepOneFrame(): void {
    advanceWaveField(waveField, FIXED_DT)
  }

  // ---- HUD --------------------------------------------------------------
  const hudEl = document.createElement('div')
  hudEl.id = 'waterlab-hud'
  hudEl.style.cssText = `
    position: fixed;
    top: 12px;
    left: 12px;
    z-index: 100;
    background: rgba(0, 0, 0, 0.72);
    color: #eee;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
    padding: 12px 16px;
    border-radius: 6px;
    min-width: 320px;
    pointer-events: none;
    line-height: 1.45;
  `
  document.body.appendChild(hudEl)

  function updateHud(): void {
    const trains = swellTrains()
    const beat = beatPeriodS()
    const coherence = waterMesh.debug.getContourCoherence()
    // Red when lines outran every swell train — genuine racing, not just
    // the secondary train's faster phase speed.
    const fastestTrain = trains.reduce((m, t) => Math.max(m, t.speed), 0)
    const isoColor = probeIso > 1.05 * fastestTrain ? '#ff5d72' : '#7cf'
    const fadedTag = probeFaded ? ' <span style="color:#667">(face flat — line faded)</span>' : ''
    hudEl.innerHTML = `
      <div style="font-weight:600;color:#7cf;font-size:13px;margin-bottom:6px">WATER LAB</div>
      <div><span style="color:#888">iso sweep @pillar </span><b style="color:${isoColor}">${probeIso.toFixed(1)} m/s</b><span style="color:#888"> · peak ${PROBE_PEAK_HOLD_S}s </span>${probePeak.toFixed(1)} m/s${fadedTag}</div>
      <div><span style="color:#888">swell trains      </span>${trains.map((t) => `λ${t.wavelength.toFixed(0)} @ ${t.speed.toFixed(1)} m/s`).join(' · ')}</div>
      <div><span style="color:#888">set beat          </span>${beat ? `${beat.toFixed(1)} s` : '—'}<span style="color:#888"> · coherence(eff) </span>${coherence.toFixed(2)}${labPaused ? ' · <b style="color:#ffc83c">PAUSED</b>' : ''}${todSeconds !== null ? `<span style="color:#888"> · tod </span>${todSeconds.toFixed(0)}s` : ''}</div>
      <div style="margin-top:8px;color:#7cf;font-size:11px">
        1/2/3/4 cam (graze · ¾ · top-down · side) · drag orbit<br>
        Space pause · . step · G drifters · P pace cones · O pillar<br>
        T / Shift+T time of day · tuner → WATER (top-right)
      </div>
      <div style="margin-top:8px;color:#9fb3c8;font-size:11px;line-height:1.5">
        Contour lines should ride the <b style="color:#36e26a">pace cones</b> —
        never outrun them. Red <b style="color:#ff2d4b">drifters</b> are the
        water itself. Crank <b>Contour coherence</b> in the tuner and watch
        the iso sweep speed pin to the primary swell.
      </div>
    `
  }

  // ---- Keyboard ---------------------------------------------------------
  function onKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      labPaused = !labPaused
      e.preventDefault()
    } else if (e.code === 'Period') {
      stepOneFrame()
    } else if (e.code === 'KeyG') {
      drifterVisible = !drifterVisible
      drifters.setVisible(drifterVisible)
    } else if (e.code === 'KeyP') {
      paceGroup.visible = !paceGroup.visible
    } else if (e.code === 'KeyO') {
      pillar.visible = !pillar.visible
    } else if (e.code === 'Digit1') {
      setCamPreset(1)
    } else if (e.code === 'Digit2') {
      setCamPreset(2)
    } else if (e.code === 'Digit3') {
      setCamPreset(3)
    } else if (e.code === 'Digit4') {
      setCamPreset(4)
    } else if (e.code === 'KeyT') {
      const step = e.shiftKey ? -20 : 20
      todSeconds = ((((todSeconds ?? 40) + step) % 360) + 360) % 360
      sky.setTimeOfDay(todSeconds)
    }
  }
  window.addEventListener('keydown', onKeyDown)
  let drifterVisible = true

  // ---- e2e / console hook ----------------------------------------------
  const hook: WaterLabHook = {
    isoSpeed: () => probeIso,
    isoPeak: () => probePeak,
    phaseSpeeds: swellTrains,
    beatPeriodS,
    scanIsoMax(opts) {
      const durationS = opts?.durationS ?? 30
      const slopeMin = opts?.slopeMin ?? 0.04
      const gridHalf = opts?.gridHalf ?? 60
      const gridStep = opts?.gridStep ?? 3
      const dtS = opts?.dtS ?? 0.25
      const sig: SwellSignal = { h: 0, ht: 0, gx: 0, gz: 0 }
      let maxV = 0
      let atSlope = 0
      for (let t = waveField.time; t <= waveField.time + durationS; t += dtS) {
        for (let x = -gridHalf; x <= gridHalf; x += gridStep) {
          for (let z = -gridHalf; z <= gridHalf; z += gridStep) {
            sampleSwellSignal(x, z, t, sig)
            const slope = Math.hypot(sig.gx, sig.gz)
            if (slope < slopeMin) continue
            const v = Math.abs(sig.ht) / slope
            if (v > maxV) {
              maxV = v
              atSlope = slope
            }
          }
        }
      }
      return { maxV, atSlope }
    },
    surfaceYAt: (x, z) => sampleHeight(waveField, x, z),
    meshVertexAt(x, z) {
      const out = { x: 0, y: 0, z: 0 }
      waterMesh.renderVertex(x, z, out)
      return out
    },
    dotMeshResidual(opts) {
      const half = opts?.half ?? 24
      const step = opts?.step ?? 2
      const out = { x: 0, y: 0, z: 0 }
      let maxAbs = 0
      let sum = 0
      let n = 0
      const worst = { x: 0, z: 0, dot: 0, mesh: 0, d: 0 }
      for (let rx = -half; rx <= half; rx += step) {
        for (let rz = -half; rz <= half; rz += step) {
          // Forward-displace the rest vertex to where the GPU draws it…
          waterMesh.renderVertex(rx, rz, out)
          // …then sample the SIM surface (the dots) at that drawn XZ.
          const dot = sampleHeight(waveField, out.x, out.z)
          const d = dot - out.y
          const ad = Math.abs(d)
          if (ad > maxAbs) {
            maxAbs = ad
            worst.x = out.x
            worst.z = out.z
            worst.dot = dot
            worst.mesh = out.y
            worst.d = d
          }
          sum += ad
          n++
        }
      }
      return { maxAbs, mean: n > 0 ? sum / n : 0, n, worst }
    },
    setPaused(on) {
      labPaused = on
    },
    isPaused: () => labPaused,
    step: stepOneFrame,
    setCamPreset,
    water: waterMesh.debug,
  }
  window.__waterlab = hook

  // ---- Frame loop -------------------------------------------------------
  let disposed = false
  let rafHandle = 0
  let last = performance.now()

  function frame(now: number): void {
    if (disposed) return
    const dt = Math.min((now - last) / 1000, 1 / 15)
    last = now

    if (!labPaused) {
      advanceWaveField(waveField, dt * waterMesh.debug.getTimeScale())
    }

    // Probe the iso-line sweep speed at the pillar (visible-line gated).
    sampleSwellSignal(0, 0, waveField.time, _sig)
    probeFaded = Math.hypot(_sig.gx, _sig.gz) < PROBE_SLOPE_VISIBLE
    if (!probeFaded) {
      probeIso = isoSpeedOf(_sig)
      probePeakAge += dt
      if (probeIso >= probePeak || probePeakAge > PROBE_PEAK_HOLD_S) {
        probePeak = probeIso
        probePeakAge = 0
      }
    }
    pillar.position.set(0, _sig.h + 0.9, 0)

    drifters.tick(waveField, 0, 0)
    updatePaceMarkers()

    orbit.update()
    // Origin-anchored water (no camera-follow re-centering): instruments sit
    // at fixed world points, so the mesh must stay pinned under them.
    waterMesh.tick([])
    sky.tick(waveField.time, dt, { x: camera.position.x, z: camera.position.z })
    updateUnderwaterFog(
      scene,
      camera.position.y,
      sampleHeight(waveField, camera.position.x, camera.position.z),
    )
    renderFrame(scene, camera)
    updateHud()

    rafHandle = requestAnimationFrame(frame)
  }
  rafHandle = requestAnimationFrame(frame)
  hideLoadingScreen()

  return {
    dispose() {
      disposed = true
      cancelAnimationFrame(rafHandle)
      window.removeEventListener('keydown', onKeyDown)
      delete window.__waterlab
      hudEl.remove()
      waterMenu.close()
      orbit.dispose()
      drifters.dispose()
      pillarGeo.dispose()
      pillarMat.dispose()
      paceGeo.dispose()
      for (const m of paceMats) m.dispose()
      for (const m of paceMarkers) {
        m.label.material.map?.dispose()
        m.label.material.dispose()
      }
      try {
        disposeRenderer()
      } catch (err) {
        console.warn('[waterlab] teardown:', err)
      }
    },
  }
}
