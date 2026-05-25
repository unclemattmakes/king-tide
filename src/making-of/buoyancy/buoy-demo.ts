import * as THREE from 'three'
import {
  advanceWaveField,
  createWaveField,
  defaultWaves,
  sampleHeight,
  sampleSurface,
} from '@/engine/sim/water/wave-field'
import { createDemoHarness } from '../shared/demo-harness'
import { buildBike, buildWaterGrid } from '../shared/scene-bits'
import { panel, readout, segmented, slider, toggle } from '../shared/ui'

/**
 * Chapter 02 demo: how the bike *reads* the wave field. The surface is the
 * real `sampleSurface`; the bike's pose is derived two ways so you can
 * compare them:
 *   - "center" — orient to the analytic surface normal under the hull's
 *     midpoint (the naive read the game deliberately avoids).
 *   - "footprint" — sample four probes (bow/stern/port/starboard) and
 *     derive pitch + roll from their height differences, exactly like
 *     `sampleSurfaceFootprint` in src/game/systems/hover.ts.
 *
 * The bike faces +X into the oncoming swell, so forward/right are fixed.
 */

// Real defaults pulled from src/engine/dev-settings.ts + hover.ts.
const DEF_HALF_LEN = 0.8
const DEF_HALF_WIDTH = 0.4
const PROBE_SPEED_SCALE = 0.05
const PROBE_SPEED_CAP = 1.4
const SLOPE_FILTER_TAU = 0.05
const GRID_SIZE = 26
const FLOAT = 0.14

type Mode = 'footprint' | 'center'

type State = {
  mode: Mode
  halfLen: number
  halfWidth: number
  approachSpeed: number
  seaScale: number
  showProbes: boolean
  paused: boolean
}

export function mountBuoyancyDemo(stage: HTMLElement, controlsHost: HTMLElement): () => void {
  const harness = createDemoHarness(stage, {
    cameraPos: [5.5, 4.5, 7.5],
    target: [0, 0, 0],
    fov: 48,
  })
  const { scene, controls } = harness
  controls.minDistance = 3
  controls.maxDistance = 30
  controls.target.set(0, 0.2, 0)

  scene.add(new THREE.HemisphereLight(0x9fc8ff, 0x0a2030, 0.9))
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.5)
  sun.position.set(-8, 10, 6)
  scene.add(sun)

  // ── Wave field (real sampler) ─────────────────────────────────────────
  const baseWaves = defaultWaves()
  const field = createWaveField([], { baseY: 0 })

  const state: State = {
    mode: 'footprint',
    halfLen: DEF_HALF_LEN,
    halfWidth: DEF_HALF_WIDTH,
    approachSpeed: 0,
    seaScale: 1,
    showProbes: true,
    paused: false,
  }

  function rebuildSea() {
    field.waves = baseWaves.map((w) => ({ ...w, amplitude: w.amplitude * state.seaScale }))
  }
  rebuildSea()

  // ── Water mesh ────────────────────────────────────────────────────────
  const seg = isCoarseDevice() ? 80 : 140
  const geo = buildWaterGrid(seg, GRID_SIZE)
  const waterMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.3,
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

  // ── Bike + probes ─────────────────────────────────────────────────────
  const bike = buildBike(DEF_HALF_LEN)
  scene.add(bike)

  // Bow/stern read pitch (yellow); port/starboard read roll (cyan).
  const pitchMat = new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0x4a3a00 })
  const rollMat = new THREE.MeshStandardMaterial({ color: 0x4dd6ff, emissive: 0x003a4a })
  const probeGeo = new THREE.SphereGeometry(0.13, 16, 12)
  // Slots: 0 bow, 1 stern, 2 starboard, 3 port — index matches feeler pairs.
  const probeMeshes = [
    new THREE.Mesh(probeGeo, pitchMat),
    new THREE.Mesh(probeGeo, pitchMat),
    new THREE.Mesh(probeGeo, rollMat),
    new THREE.Mesh(probeGeo, rollMat),
  ]
  const probeGroup = new THREE.Group()
  for (const p of probeMeshes) probeGroup.add(p)
  // Vertical "feeler" lines from hull down to each sampled surface point.
  const feelerGeo = new THREE.BufferGeometry()
  feelerGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3))
  const feelerPos = feelerGeo.getAttribute('position') as THREE.BufferAttribute
  const feelerMat = new THREE.LineBasicMaterial({
    color: 0x88a0c0,
    transparent: true,
    opacity: 0.6,
  })
  const feelers = new THREE.LineSegments(feelerGeo, feelerMat)
  probeGroup.add(feelers)
  scene.add(probeGroup)

  // ── Controls ──────────────────────────────────────────────────────────
  const pitchOut = readout('Pitch (nose up/down)')
  const rollOut = readout('Roll (side to side)')
  const reachOut = readout('Effective probe reach')

  controlsHost.append(
    panel('How the bike reads the sea', [
      segmented({
        label: 'Sampling',
        value: state.mode,
        options: [
          { value: 'footprint', label: '4 probes' },
          { value: 'center', label: 'Center only' },
        ],
        onChange: (v) => {
          state.mode = v as Mode
        },
      }),
      slider({
        label: 'Footprint length',
        min: 0.3,
        max: 3,
        step: 0.05,
        value: state.halfLen,
        format: (v) => `${(v * 2).toFixed(1)} m`,
        onInput: (v) => {
          state.halfLen = v
        },
      }),
      slider({
        label: 'Footprint width',
        min: 0.2,
        max: 2,
        step: 0.05,
        value: state.halfWidth,
        format: (v) => `${(v * 2).toFixed(1)} m`,
        onInput: (v) => {
          state.halfWidth = v
        },
      }),
      slider({
        label: 'Approach speed',
        min: 0,
        max: 25,
        step: 0.5,
        value: state.approachSpeed,
        format: (v) => `${v.toFixed(0)} m/s`,
        onInput: (v) => {
          state.approachSpeed = v
        },
      }),
    ]),
    panel('Conditions', [
      slider({
        label: 'Sea height',
        min: 0,
        max: 2.5,
        step: 0.05,
        value: state.seaScale,
        format: (v) => `${v.toFixed(2)}×`,
        onInput: (v) => {
          state.seaScale = v
          rebuildSea()
        },
      }),
      toggle({
        label: 'Show probes',
        value: state.showProbes,
        onChange: (v) => {
          state.showProbes = v
          probeGroup.visible = v
        },
      }),
      toggle({
        label: 'Pause time',
        value: state.paused,
        onChange: (v) => {
          state.paused = v
        },
      }),
      pitchOut.node,
      rollOut.node,
      reachOut.node,
    ]),
  )

  // ── Math scratch (allocated once) ─────────────────────────────────────
  const up = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const right = new THREE.Vector3()
  const basis = new THREE.Matrix4()
  let filtFwdSlope = 0
  let filtRightSlope = 0

  // Bike faces +X, so forward = +X and right = +Z throughout.
  function orientAndPlace(surfaceY: number) {
    fwd.set(1, 0, 0).addScaledVector(up, -up.x).normalize()
    right.crossVectors(up, fwd).normalize()
    basis.makeBasis(right, up, fwd)
    bike.quaternion.setFromRotationMatrix(basis)
    bike.position.set(0, surfaceY + FLOAT, 0)
  }

  function setProbe(slot: number, x: number, z: number, hullY: number) {
    const y = sampleHeight(field, x, z)
    probeMeshes[slot]?.position.set(x, y, z)
    feelerPos.setXYZ(slot * 2, x, hullY, z)
    feelerPos.setXYZ(slot * 2 + 1, x, y, z)
  }

  const unsub = harness.onFrame((dt) => {
    if (!state.paused) advanceWaveField(field, dt)

    // Deform the visible surface from the real sampler.
    const colorAmp = Math.max(0.4, state.seaScale * 1.4)
    for (let i = 0; i < vertCount; i++) {
      const x = baseXZ[i * 2] ?? 0
      const z = baseXZ[i * 2 + 1] ?? 0
      const s = sampleSurface(field, x, z)
      posAttr.setY(i, s.y)
      normAttr.setXYZ(i, s.nx, s.ny, s.nz)
      const t = THREE.MathUtils.clamp(0.5 + (0.5 * s.y) / colorAmp, 0, 1)
      scratchColor.copy(deepColor).lerp(crestColor, t)
      colAttr.setXYZ(i, scratchColor.r, scratchColor.g, scratchColor.b)
    }
    posAttr.needsUpdate = true
    normAttr.needsUpdate = true
    colAttr.needsUpdate = true

    // Fore/aft spread grows with speed (anticipation), capped like hover.ts.
    const reach = state.halfLen + Math.min(state.approachSpeed * PROBE_SPEED_SCALE, PROBE_SPEED_CAP)
    const four = state.mode === 'footprint'

    if (four) {
      const hBow = sampleHeight(field, reach, 0)
      const hStern = sampleHeight(field, -reach, 0)
      const hStar = sampleHeight(field, 0, state.halfWidth)
      const hPort = sampleHeight(field, 0, -state.halfWidth)
      const fwdSlopeRaw = (hBow - hStern) / (2 * reach)
      const rightSlopeRaw = (hStar - hPort) / (2 * state.halfWidth)
      // The same dt-aware 50 ms low-pass the game runs on the raw slope.
      const alpha = state.paused ? 1 : 1 - Math.exp(-dt / SLOPE_FILTER_TAU)
      filtFwdSlope += (fwdSlopeRaw - filtFwdSlope) * alpha
      filtRightSlope += (rightSlopeRaw - filtRightSlope) * alpha
      // Normal implied by the two slopes (forward = +X, right = +Z).
      up.set(-filtFwdSlope, 1, -filtRightSlope).normalize()
      orientAndPlace((hBow + hStern + hStar + hPort) / 4)
      pitchOut.set(`${degOf(Math.atan(filtFwdSlope))}°`)
      rollOut.set(`${degOf(Math.atan(filtRightSlope))}°`)
    } else {
      const s = sampleSurface(field, 0, 0)
      up.set(s.nx, s.ny, s.nz).normalize()
      orientAndPlace(s.y)
      pitchOut.set(`${degOf(Math.atan(-s.nx / Math.max(s.ny, 1e-3)))}°`)
      rollOut.set(`${degOf(Math.atan(-s.nz / Math.max(s.ny, 1e-3)))}°`)
    }

    // Probe markers + feelers.
    const hullY = bike.position.y + 0.2
    for (let k = 1; k < 4; k++) {
      const visible = four
      const mesh = probeMeshes[k]
      if (mesh) mesh.visible = visible
    }
    if (four) {
      setProbe(0, reach, 0, hullY)
      setProbe(1, -reach, 0, hullY)
      setProbe(2, 0, state.halfWidth, hullY)
      setProbe(3, 0, -state.halfWidth, hullY)
    } else {
      setProbe(0, 0, 0, hullY)
      for (let k = 1; k < 4; k++) {
        feelerPos.setXYZ(k * 2, 0, hullY, 0)
        feelerPos.setXYZ(k * 2 + 1, 0, hullY, 0)
      }
    }
    feelerPos.needsUpdate = true
    reachOut.set(`${(reach * 2).toFixed(1)} m`)
  })

  return () => {
    unsub()
    harness.dispose()
    geo.dispose()
    waterMat.dispose()
    probeGeo.dispose()
    feelerGeo.dispose()
  }
}

function degOf(rad: number): string {
  const d = (rad * 180) / Math.PI
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}`
}

function isCoarseDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches
}
