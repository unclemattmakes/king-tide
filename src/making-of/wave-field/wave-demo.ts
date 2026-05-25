import * as THREE from 'three'
import {
  advanceWaveField,
  createWaveField,
  defaultWaves,
  sampleSurface,
  type Wave,
} from '@/engine/sim/water/wave-field'
import { createDemoHarness } from '../shared/demo-harness'
import { buildBike, buildWaterGrid } from '../shared/scene-bits'
import { panel, readout, segmented, slider, toggle } from '../shared/ui'

/**
 * The "build-a-sea" demo. The water mesh and the floating bike are both
 * driven by `sampleSurface` from the shipping sim module — drag the
 * sliders and you are editing the exact wave field the real game floats
 * its bikes on.
 */

const GRID_SIZE = 72 // meters across the visible patch
const BIKE_FLOAT = 0.12 // sits this far proud of the surface

type DemoState = {
  layers: number
  ampScale: number
  wlScale: number
  bearingDeg: number
  paused: boolean
  wireframe: boolean
  moving: boolean
}

export function mountWaveDemo(stage: HTMLElement, controlsHost: HTMLElement): () => void {
  const harness = createDemoHarness(stage, {
    cameraPos: [0, 26, 40],
    target: [0, 0, 0],
    fov: 50,
  })
  const { scene } = harness

  // ── Lighting ──────────────────────────────────────────────────────────
  scene.add(new THREE.HemisphereLight(0x9fc8ff, 0x0a2030, 0.85))
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.6)
  sun.position.set(-18, 16, 22)
  scene.add(sun)

  // ── Wave field (the real sim state) ───────────────────────────────────
  const baseWaves = defaultWaves()
  const field = createWaveField([], { baseY: 0 })
  field.wakes.push({ x: 0, z: 0, vx: 0, vz: 0, weight: 0 })

  const state: DemoState = {
    layers: 1,
    ampScale: 1,
    wlScale: 1,
    bearingDeg: 0,
    paused: false,
    wireframe: false,
    moving: false,
  }

  let sumAmp = 1
  function rebuildWaves() {
    const slice = baseWaves.slice(0, state.layers)
    const waves: Wave[] = slice.map((w) => ({
      dirX: w.dirX,
      dirZ: w.dirZ,
      amplitude: w.amplitude * state.ampScale,
      wavelength: w.wavelength * state.wlScale,
      speed: w.speed,
      phase: w.phase,
    }))
    field.waves = waves
    field.waveBearing = (state.bearingDeg * Math.PI) / 180
    sumAmp = Math.max(
      0.25,
      waves.reduce((s, w) => s + w.amplitude, 0),
    )
  }
  rebuildWaves()

  // ── Water mesh ────────────────────────────────────────────────────────
  const seg = isCoarseDevice() ? 72 : 116
  const geo = buildWaterGrid(seg, GRID_SIZE)
  const waterMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.32,
    metalness: 0.04,
  })
  const water = new THREE.Mesh(geo, waterMat)
  scene.add(water)

  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute
  const normAttr = geo.getAttribute('normal') as THREE.BufferAttribute
  const colAttr = geo.getAttribute('color') as THREE.BufferAttribute
  const baseXZ = (geo.userData.baseXZ as Float32Array) ?? new Float32Array()
  const vertCount = posAttr.count

  const deepColor = new THREE.Color(0x05303f)
  const crestColor = new THREE.Color(0x66e8ff)
  const scratchColor = new THREE.Color()

  // ── Floating bike ─────────────────────────────────────────────────────
  const bike = buildBike(1.4)
  scene.add(bike)
  let bikeAngle = 0

  // Reusable vectors so the per-frame loop allocates nothing.
  const up = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const right = new THREE.Vector3()
  const basis = new THREE.Matrix4()

  // ── Controls panel ────────────────────────────────────────────────────
  const heightOut = readout('Surface height under bike')
  const tiltOut = readout('Bike tilt off-level')

  controlsHost.append(
    panel('Stack the sines', [
      slider({
        label: 'Wave layers',
        min: 1,
        max: baseWaves.length,
        step: 1,
        value: state.layers,
        format: (v) => `${v} of ${baseWaves.length}`,
        onInput: (v) => {
          state.layers = v
          rebuildWaves()
        },
      }),
      slider({
        label: 'Wave height',
        min: 0,
        max: 2.5,
        step: 0.05,
        value: state.ampScale,
        format: (v) => `${v.toFixed(2)}×`,
        onInput: (v) => {
          state.ampScale = v
          rebuildWaves()
        },
      }),
      slider({
        label: 'Wavelength',
        min: 0.5,
        max: 2,
        step: 0.05,
        value: state.wlScale,
        format: (v) => `${v.toFixed(2)}×`,
        onInput: (v) => {
          state.wlScale = v
          rebuildWaves()
        },
      }),
      slider({
        label: 'Swell bearing',
        min: -180,
        max: 180,
        step: 1,
        value: state.bearingDeg,
        format: (v) => `${v}°`,
        onInput: (v) => {
          state.bearingDeg = v
          rebuildWaves()
        },
      }),
    ]),
    panel('Watch it float', [
      segmented({
        label: 'Bike',
        value: 'bob',
        options: [
          { value: 'bob', label: 'Hold still' },
          { value: 'ride', label: 'Ride a wake' },
        ],
        onChange: (v) => {
          state.moving = v === 'ride'
        },
      }),
      toggle({
        label: 'Pause time',
        value: state.paused,
        onChange: (v) => {
          state.paused = v
        },
      }),
      toggle({
        label: 'Wireframe',
        value: state.wireframe,
        onChange: (v) => {
          waterMat.wireframe = v
        },
      }),
      heightOut.node,
      tiltOut.node,
    ]),
  )

  // ── Frame loop ────────────────────────────────────────────────────────
  const unsub = harness.onFrame((dt) => {
    if (!state.paused) advanceWaveField(field, dt)

    // Drive the bike: either parked at the origin or circling so its
    // wake carves the surface.
    let bx = 0
    let bz = 0
    if (state.moving) {
      const radius = 16
      const speed = 9 // m/s — comfortably above WAKE_SPEED_HIGH
      bikeAngle += (speed / radius) * (state.paused ? 0 : dt)
      bx = Math.cos(bikeAngle) * radius
      bz = Math.sin(bikeAngle) * radius
      const vx = -Math.sin(bikeAngle) * speed
      const vz = Math.cos(bikeAngle) * speed
      const wake = field.wakes[0]
      if (wake) {
        wake.x = bx
        wake.z = bz
        wake.vx = vx
        wake.vz = vz
        wake.weight = 1
      }
    } else {
      const wake = field.wakes[0]
      if (wake) wake.weight = 0
    }

    // Deform the water surface from the real sampler.
    for (let i = 0; i < vertCount; i++) {
      const x = baseXZ[i * 2] ?? 0
      const z = baseXZ[i * 2 + 1] ?? 0
      const s = sampleSurface(field, x, z)
      posAttr.setY(i, s.y)
      normAttr.setXYZ(i, s.nx, s.ny, s.nz)
      const t = THREE.MathUtils.clamp(0.5 + (0.5 * s.y) / sumAmp, 0, 1)
      scratchColor.copy(deepColor).lerp(crestColor, t)
      colAttr.setXYZ(i, scratchColor.r, scratchColor.g, scratchColor.b)
    }
    posAttr.needsUpdate = true
    normAttr.needsUpdate = true
    colAttr.needsUpdate = true

    // Float the bike on the surface, tilted to the wave normal — the same
    // height + normal the game's buoyancy reads.
    const bs = sampleSurface(field, bx, bz)
    up.set(bs.nx, bs.ny, bs.nz).normalize()
    const heading = state.moving ? bikeAngle + Math.PI / 2 : Math.PI / 2
    fwd.set(Math.cos(heading), 0, Math.sin(heading))
    fwd.addScaledVector(up, -fwd.dot(up)).normalize()
    right.crossVectors(up, fwd).normalize()
    basis.makeBasis(right, up, fwd)
    bike.quaternion.setFromRotationMatrix(basis)
    bike.position.set(bx, bs.y + BIKE_FLOAT, bz)

    heightOut.set(`${bs.y >= 0 ? '+' : ''}${bs.y.toFixed(2)} m`)
    const tiltDeg = (Math.acos(THREE.MathUtils.clamp(bs.ny, -1, 1)) * 180) / Math.PI
    tiltOut.set(`${tiltDeg.toFixed(1)}°`)
  })

  return () => {
    unsub()
    harness.dispose()
    geo.dispose()
    waterMat.dispose()
  }
}

function isCoarseDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches
}
