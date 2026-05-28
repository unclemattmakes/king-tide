import * as THREE from 'three'
import { defaultBikeStats } from '@/game/bikes/stats'
import { createDemoHarness } from '../shared/demo-harness'
import { buildBike } from '../shared/scene-bits'
import { el, panel, readout, slider, toggle } from '../shared/ui'

/**
 * Chapter 07 / hover-spring demo. A 1D PD controller running the exact
 * formula from `src/game/bikes/stats.ts`:
 *
 *   aUp = g + hoverSpring * (target - distance) - hoverDamp * vy
 *
 * The reader drops a bike from a chosen height and tunes the spring +
 * damping. A live SVG plot traces height-over-time so the response shape
 * is visible at a glance (overdamped = lazy climb; underdamped = bounce;
 * undamped = forever).
 *
 * The seed values come from `defaultBikeStats()` so the demo's "shipped"
 * baseline tracks the shipping bike.
 */

// The game's PD formula is `aUp = g + spring*err - damp*vy`. The +g
// cancels gravity at rest, so the net acceleration on the bike is just
// `spring*err - damp*vy` — which is exactly what we integrate below
// (no explicit gravity term needed).
const SUBSTEPS = 6 // sub-step the integrator so high spring + low damp stays stable.

export function mountHoverSpringDemo(stage: HTMLElement, controlsHost: HTMLElement): () => void {
  const harness = createDemoHarness(stage, {
    cameraPos: [5.2, 2.0, 0.8],
    target: [0, 1.2, 0],
    fov: 42,
    background: 0x070f1a,
  })
  const { scene, controls } = harness
  controls.target.set(0, 1.2, 0)
  controls.minDistance = 3
  controls.maxDistance = 14

  scene.add(new THREE.HemisphereLight(0x9fc8ff, 0x0a1526, 0.85))
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.4)
  sun.position.set(-6, 9, 4)
  scene.add(sun)

  // ── Ground + side rule for visual reference ──────────────────────────
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 14),
    new THREE.MeshStandardMaterial({ color: 0x0b1828, roughness: 0.9 }),
  )
  ground.rotation.x = -Math.PI / 2
  scene.add(ground)

  // A faint vertical ruler so the eye has something to measure against.
  const rulerGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 6, 0),
  ])
  const rulerMat = new THREE.LineDashedMaterial({
    color: 0x4dd6ff,
    dashSize: 0.18,
    gapSize: 0.18,
    transparent: true,
    opacity: 0.35,
  })
  const ruler = new THREE.Line(rulerGeo, rulerMat)
  ruler.computeLineDistances()
  scene.add(ruler)

  // A glowing ring at the current target hover height.
  const targetGeo = new THREE.TorusGeometry(0.85, 0.025, 8, 36)
  targetGeo.rotateX(Math.PI / 2)
  const targetMat = new THREE.MeshBasicMaterial({
    color: 0xffd54a,
    transparent: true,
    opacity: 0.8,
  })
  const targetRing = new THREE.Mesh(targetGeo, targetMat)
  scene.add(targetRing)

  // ── Bike ─────────────────────────────────────────────────────────────
  const bike = buildBike(1.0)
  scene.add(bike)

  // ── State (seeded from real stats) ───────────────────────────────────
  const seed = defaultBikeStats()
  const state = {
    spring: seed.hoverSpring,
    damp: seed.hoverDamp,
    target: seed.hoverHeight,
    dropFrom: 4.0,
    dampingOn: true,
  }
  let y = state.dropFrom
  let vy = 0
  let elapsed = 0
  let settledAtS: number | null = null
  let peakOvershoot = 0
  // We only start counting "overshoot" once the bike crosses the target
  // line, otherwise the drop height itself would be reported as overshoot.
  let hasCrossed = false
  let startedAbove = state.dropFrom > state.target

  // ── Plot (live height-over-time trace) ───────────────────────────────
  const plot = makePlot()

  function reset(): void {
    y = state.dropFrom
    vy = 0
    elapsed = 0
    settledAtS = null
    peakOvershoot = 0
    hasCrossed = false
    startedAbove = state.dropFrom > state.target
    plot.clear()
  }

  // ── Controls panel ───────────────────────────────────────────────────
  const settledOut = readout('Settled within ±5 cm at')
  const overshootOut = readout('Peak overshoot')
  const zetaOut = readout('Damping ratio ζ')
  const omegaOut = readout('Natural freq (Hz)')

  const dropBtn = el('button', { type: 'button', class: 'mo-drift-btn' }, ['Re-drop'])
  dropBtn.addEventListener('click', reset)

  function updateDerived(): void {
    const w0 = Math.sqrt(Math.max(state.spring, 0))
    const zeta = state.dampingOn && w0 > 0 ? state.damp / (2 * w0) : 0
    zetaOut.set(zeta.toFixed(2))
    omegaOut.set(`${(w0 / (2 * Math.PI)).toFixed(2)} Hz`)
  }

  controlsHost.append(
    panel('The PD controller', [
      slider({
        label: 'Hover spring (P)',
        min: 5,
        max: 60,
        step: 1,
        value: state.spring,
        format: (v) => `${v} m/s² / m`,
        onInput: (v) => {
          state.spring = v
          updateDerived()
        },
      }),
      slider({
        label: 'Hover damping (D)',
        min: 0,
        max: 20,
        step: 0.5,
        value: state.damp,
        format: (v) => `${v.toFixed(1)} m/s² / (m/s)`,
        onInput: (v) => {
          state.damp = v
          updateDerived()
        },
      }),
      slider({
        label: 'Target hover height',
        min: 0.4,
        max: 2.5,
        step: 0.05,
        value: state.target,
        format: (v) => `${v.toFixed(2)} m`,
        onInput: (v) => {
          state.target = v
          targetRing.position.y = v
        },
      }),
      toggle({
        label: 'Damping on (off = pure spring)',
        value: state.dampingOn,
        onChange: (v) => {
          state.dampingOn = v
          updateDerived()
        },
      }),
    ]),
    panel('Drop a bike', [
      slider({
        label: 'Drop from',
        min: 0.1,
        max: 8,
        step: 0.1,
        value: state.dropFrom,
        format: (v) => `${v.toFixed(1)} m`,
        onInput: (v) => {
          state.dropFrom = v
        },
      }),
      dropBtn,
      plot.node,
      settledOut.node,
      overshootOut.node,
      zetaOut.node,
      omegaOut.node,
    ]),
  )

  targetRing.position.y = state.target
  updateDerived()

  // ── Frame loop ───────────────────────────────────────────────────────
  const SETTLE_BAND = 0.05 // metres

  const unsub = harness.onFrame((dt) => {
    const sdt = dt / SUBSTEPS
    for (let s = 0; s < SUBSTEPS; s++) {
      const err = state.target - y
      const damp = state.dampingOn ? state.damp : 0
      const a = state.spring * err - damp * vy
      vy += a * sdt
      y += vy * sdt
      // Hard floor — the bike can't drive itself underground.
      if (y < 0) {
        y = 0
        if (vy < 0) vy = 0
      }
    }
    elapsed += dt

    bike.position.y = y
    plot.push(elapsed, y, state.target)

    // Overshoot = furthest excursion from target after the bike first
    // crosses the target line — captures both an underdamped bounce above
    // and the dive-then-spring rebound below.
    if (!hasCrossed && (startedAbove ? y < state.target : y > state.target)) {
      hasCrossed = true
    }
    if (hasCrossed) {
      const o = Math.abs(y - state.target)
      if (o > peakOvershoot) peakOvershoot = o
    }
    overshootOut.set(hasCrossed ? `${peakOvershoot.toFixed(2)} m` : '…')

    if (settledAtS === null && Math.abs(state.target - y) < SETTLE_BAND && Math.abs(vy) < 0.25) {
      settledAtS = elapsed
    }
    settledOut.set(settledAtS === null ? '…' : `${settledAtS.toFixed(2)} s`)
  })

  return () => {
    unsub()
    harness.dispose()
    rulerGeo.dispose()
    rulerMat.dispose()
    targetGeo.dispose()
    targetMat.dispose()
    ground.geometry.dispose()
    ;(ground.material as THREE.Material).dispose()
  }
}

// ── Inline SVG plot of y(t) — last few seconds visible ──────────────────
const SVG_NS = 'http://www.w3.org/2000/svg'
const PLOT_W = 248
const PLOT_H = 140
const PLOT_PAD_L = 20
const PLOT_PAD_R = 8
const PLOT_PAD_T = 10
const PLOT_PAD_B = 18
const PLOT_WINDOW_S = 4 // seconds shown
const PLOT_Y_MAX = 8 // meters shown on the Y axis

type Plot = {
  node: HTMLElement
  push: (t: number, y: number, target: number) => void
  clear: () => void
}

function makePlot(): Plot {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${PLOT_W} ${PLOT_H}`)
  svg.setAttribute('class', 'mo-plot')

  const baseY = yPix(0)
  const axis = svgLine(PLOT_PAD_L, baseY, PLOT_W - PLOT_PAD_R, baseY, 'mo-plot-axis')
  const targetLine = svgLine(PLOT_PAD_L, baseY, PLOT_W - PLOT_PAD_R, baseY, 'mo-plot-sweet')
  const trace = svgPath('mo-plot-yours')
  const labels = [
    svgText(2, baseY + 3, '0'),
    svgText(2, PLOT_PAD_T + 4, `${PLOT_Y_MAX}m`),
    svgText(PLOT_PAD_L + 2, PLOT_H - 6, '0s'),
    svgText(PLOT_W - 24, PLOT_H - 6, `${PLOT_WINDOW_S}s`),
  ]
  svg.append(axis, targetLine, trace, ...labels)

  const legend = el('div', { class: 'mo-plot-legend' }, [
    el('span', { class: 'mo-plot-key mo-key-yours' }, ['height']),
    el('span', { class: 'mo-plot-key mo-key-shipped' }, ['target']),
  ])
  const node = el('div', { class: 'mo-plot-wrap' }, [svg, legend])

  // Ring buffer of (t, y) samples covering the last PLOT_WINDOW_S seconds.
  const samples: { t: number; y: number }[] = []
  let lastTarget = 0

  function redraw(now: number): void {
    const tMin = now - PLOT_WINDOW_S
    while (samples.length && (samples[0]?.t ?? 0) < tMin) samples.shift()
    // Target line at current target height.
    const yT = yPix(lastTarget)
    targetLine.setAttribute('y1', String(yT))
    targetLine.setAttribute('y2', String(yT))
    // Trace path.
    let d = ''
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i]
      if (!p) continue
      const xN = (p.t - tMin) / PLOT_WINDOW_S
      const x = PLOT_PAD_L + xN * (PLOT_W - PLOT_PAD_L - PLOT_PAD_R)
      const y = yPix(p.y)
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    }
    trace.setAttribute('d', d)
  }

  return {
    node,
    push(t, y, target) {
      lastTarget = target
      samples.push({ t, y })
      redraw(t)
    },
    clear() {
      samples.length = 0
      trace.setAttribute('d', '')
    },
  }
}

function yPix(meters: number): number {
  const clamped = Math.max(0, Math.min(PLOT_Y_MAX, meters))
  return PLOT_PAD_T + ((PLOT_Y_MAX - clamped) / PLOT_Y_MAX) * (PLOT_H - PLOT_PAD_T - PLOT_PAD_B)
}

function svgLine(x1: number, y1: number, x2: number, y2: number, cls: string): SVGLineElement {
  const l = document.createElementNS(SVG_NS, 'line')
  l.setAttribute('x1', String(x1))
  l.setAttribute('y1', String(y1))
  l.setAttribute('x2', String(x2))
  l.setAttribute('y2', String(y2))
  l.setAttribute('class', cls)
  return l
}
function svgPath(cls: string): SVGPathElement {
  const p = document.createElementNS(SVG_NS, 'path')
  p.setAttribute('class', cls)
  p.setAttribute('fill', 'none')
  return p
}
function svgText(x: number, y: number, s: string): SVGTextElement {
  const t = document.createElementNS(SVG_NS, 'text')
  t.setAttribute('x', String(x))
  t.setAttribute('y', String(y))
  t.setAttribute('class', 'mo-plot-label')
  t.textContent = s
  return t
}
