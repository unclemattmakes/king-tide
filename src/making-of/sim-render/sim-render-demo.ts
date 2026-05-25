import * as THREE from 'three'
import { createDemoHarness } from '../shared/demo-harness'
import { buildBike } from '../shared/scene-bits'
import { panel, readout, slider, toggle } from '../shared/ui'

/**
 * Chapter 05 demo: the two clocks. A bike follows a circular path whose
 * "sim" advances on a fixed, low tick rate while the render runs every
 * frame. With interpolation off you see the raw stepped sim (it lurches
 * `simHz` times a second); with it on, the render smoothly interpolates
 * between the two most recent snapshots — a simplified model of the real
 * loop (60 Hz fixed sim, 20 Hz snapshots, ~100 ms interp delay; see
 * remote-interp.ts + the fixed-dt accumulator in game-loop.ts).
 *
 * This demo is illustrative — it doesn't import sim code, because the
 * point is the *shape* of the loop, not a particular system.
 */

const RADIUS = 6
const ANG_SPEED = 0.7 // rad/s of the underlying motion
const SNAP_KEEP = 48

type Snap = { t: number; x: number; z: number }

type State = {
  simHz: number
  interpolate: boolean
  showTicks: boolean
}

export function mountSimRenderDemo(stage: HTMLElement, controlsHost: HTMLElement): () => void {
  const harness = createDemoHarness(stage, {
    cameraPos: [0, 13, 11],
    target: [0, 0, 0],
    fov: 50,
    background: 0x070f1a,
  })
  const { scene, controls } = harness
  controls.minDistance = 6
  controls.maxDistance = 40

  scene.add(new THREE.HemisphereLight(0x9fc8ff, 0x0a1526, 0.95))
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.3)
  sun.position.set(-6, 12, 4)
  scene.add(sun)
  scene.add(new THREE.GridHelper(28, 28, 0x244055, 0x162a3c))

  // Faint continuous "true" path the sim is sampling.
  const ringPts: THREE.Vector3[] = []
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2
    ringPts.push(new THREE.Vector3(Math.cos(a) * RADIUS, 0.02, Math.sin(a) * RADIUS))
  }
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(ringPts),
    new THREE.LineBasicMaterial({ color: 0x335066 }),
  )
  scene.add(ring)

  const bike = buildBike(0.8)
  scene.add(bike)

  // Pool of snapshot markers — the discrete sim states.
  const dotGeo = new THREE.SphereGeometry(0.13, 10, 8)
  const dotMat = new THREE.MeshBasicMaterial({ color: 0x4dd6ff })
  const dots: THREE.Mesh[] = []
  for (let i = 0; i < SNAP_KEEP; i++) {
    const d = new THREE.Mesh(dotGeo, dotMat)
    d.visible = false
    scene.add(d)
    dots.push(d)
  }

  const state: State = { simHz: 6, interpolate: true, showTicks: true }
  const snaps: Snap[] = []

  let elapsed = 0
  let nextTickAt = 0
  let fpsEMA = 60
  let prevX = RADIUS
  let prevZ = 0

  const simOut = readout('Sim rate')
  const fpsOut = readout('Render rate')
  const gapOut = readout('Time between ticks')

  controlsHost.append(
    panel('Two clocks', [
      slider({
        label: 'Sim tick rate',
        min: 2,
        max: 60,
        step: 1,
        value: state.simHz,
        format: (v) => `${v} Hz`,
        onInput: (v) => {
          state.simHz = v
        },
      }),
      toggle({
        label: 'Interpolate render',
        value: state.interpolate,
        onChange: (v) => {
          state.interpolate = v
        },
      }),
      toggle({
        label: 'Show sim ticks',
        value: state.showTicks,
        onChange: (v) => {
          state.showTicks = v
          if (!v) for (const d of dots) d.visible = false
        },
      }),
      simOut.node,
      fpsOut.node,
      gapOut.node,
    ]),
  )

  const unsub = harness.onFrame((dt) => {
    elapsed += dt
    fpsEMA += (1 / Math.max(dt, 1e-3) - fpsEMA) * 0.1
    const simDt = 1 / state.simHz

    // Fixed-rate "sim": record the true position at each tick.
    if (elapsed < nextTickAt - simDt * 2) nextTickAt = elapsed // resync after a pause
    let guard = 0
    while (elapsed >= nextTickAt && guard++ < 8) {
      const a = nextTickAt * ANG_SPEED
      snaps.push({ t: nextTickAt, x: Math.cos(a) * RADIUS, z: Math.sin(a) * RADIUS })
      if (snaps.length > SNAP_KEEP) snaps.shift()
      nextTickAt += simDt
    }
    if (snaps.length === 0) return

    // Render position: interpolate between snapshots at (now - delay), or
    // snap to the latest tick.
    let rx: number
    let rz: number
    const latest = snaps[snaps.length - 1]
    if (!latest) return
    if (state.interpolate && snaps.length >= 2) {
      const delay = simDt * 1.5
      const sampleT = elapsed - delay
      let a = snaps[0]
      let b = snaps[snaps.length - 1]
      for (let i = snaps.length - 1; i > 0; i--) {
        const lo = snaps[i - 1]
        const hi = snaps[i]
        if (lo && hi && lo.t <= sampleT && sampleT <= hi.t) {
          a = lo
          b = hi
          break
        }
      }
      if (a && b) {
        const span = b.t - a.t
        const f = span > 1e-5 ? THREE.MathUtils.clamp((sampleT - a.t) / span, 0, 1) : 0
        rx = a.x + (b.x - a.x) * f
        rz = a.z + (b.z - a.z) * f
      } else {
        rx = latest.x
        rz = latest.z
      }
    } else {
      rx = latest.x
      rz = latest.z
    }

    bike.position.set(rx, 0.2, rz)
    const dx = rx - prevX
    const dz = rz - prevZ
    if (dx * dx + dz * dz > 1e-6) bike.rotation.y = Math.atan2(dx, dz)
    prevX = rx
    prevZ = rz

    // Draw the kept snapshots as discrete sim-state markers.
    for (let i = 0; i < dots.length; i++) {
      const dot = dots[i]
      const snap = snaps[i]
      if (!dot) continue
      if (state.showTicks && snap) {
        dot.visible = true
        dot.position.set(snap.x, 0.12, snap.z)
      } else {
        dot.visible = false
      }
    }

    simOut.set(`${state.simHz} ticks/s`)
    fpsOut.set(`${fpsEMA.toFixed(0)} fps`)
    gapOut.set(`${(simDt * 1000).toFixed(0)} ms`)
  })

  return () => {
    unsub()
    harness.dispose()
    dotGeo.dispose()
    dotMat.dispose()
    ring.geometry.dispose()
  }
}
