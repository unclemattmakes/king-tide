import * as THREE from 'three'
import { TUCK_SCRAPE_FLOOR, TUCK_SWEET_SPOT, tuckFactor } from '@/game/systems/tuck-curve'
import { createDemoHarness } from '../shared/demo-harness'
import { buildBike, createScrollDeck } from '../shared/scene-bits'
import { el, panel, readout, slider, toggle } from '../shared/ui'

/**
 * "Tuning the Feel" demo: the tuck sweet-spot. The shipped curve is the
 * real `tuckFactor` from src/game/systems/tuck-curve.ts (pinned by
 * tests/unit/tuck-sweet-spot). You can re-tune your own copy of the curve
 * and feel the difference on the bike — the deck scrolls at the speed cap
 * the lean earns, so the sweet spot is something you can see, not just read.
 */

// Stat defaults from src/game/bikes/stats.ts.
const TUCK_SPEED_BOOST = 1.15
const TUCK_DRAG_MUL = 0.5
const TOP_SPEED_REF = 58 // indicative display figure for the cap readout
const BASE_SCROLL = 16 // m/s of deck scroll at neutral
const LEAN_MAX_RAD = 0.5
const HOVER_Y = 0.92

type State = {
  lean: number
  sweet: number
  floor: number
  matchShipped: boolean
}

/** Re-parameterized tuck curve so the reader can re-tune sweet spot + floor. */
function customTuck(d: number, sweet: number, floor: number): number {
  const c = d <= 0 ? 0 : d >= 1 ? 1 : d
  if (c <= sweet) return c / sweet
  const over = (c - sweet) / (1 - sweet)
  return 1 + (floor - 1) * over
}

export function mountTuckDemo(stage: HTMLElement, controlsHost: HTMLElement): () => void {
  const harness = createDemoHarness(stage, {
    cameraPos: [3.4, 3.0, -6.2],
    target: [0, 0.8, 1.5],
    fov: 50,
    background: 0x070f1a,
  })
  const { scene, controls } = harness
  controls.minDistance = 4
  controls.maxDistance = 28
  controls.target.set(0, 0.7, 1.2)

  scene.add(new THREE.HemisphereLight(0x9fc8ff, 0x0a1526, 0.9))
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.4)
  sun.position.set(-6, 9, -4)
  scene.add(sun)

  // ── Deck + scrolling rungs (the speed cue) ────────────────────────────
  const deck = createScrollDeck(scene)

  // ── Bike + scrape spark ───────────────────────────────────────────────
  const bike = buildBike(1.0)
  scene.add(bike)
  const spark = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffd54a }),
  )
  spark.visible = false
  scene.add(spark)

  // ── State ─────────────────────────────────────────────────────────────
  const state: State = {
    lean: 0,
    sweet: TUCK_SWEET_SPOT,
    floor: TUCK_SCRAPE_FLOOR,
    matchShipped: false,
  }
  const tfOf = (d: number) =>
    state.matchShipped ? tuckFactor(d) : customTuck(d, state.sweet, state.floor)

  // ── Curve plot ────────────────────────────────────────────────────────
  const plot = makeCurvePlot()

  // ── Controls ──────────────────────────────────────────────────────────
  const speedOut = readout('Top-speed cap')
  const dragOut = readout('Lateral drag')
  const factorOut = readout('Tuck factor')

  controlsHost.append(
    panel('Bury the nose', [
      slider({
        label: 'Nose-down lean',
        min: 0,
        max: 1,
        step: 0.01,
        value: state.lean,
        format: (v) => `${(v * 100).toFixed(0)}%`,
        onInput: (v) => {
          state.lean = v
        },
      }),
      speedOut.node,
      dragOut.node,
      factorOut.node,
    ]),
    panel('Re-tune the curve', [
      plot.node,
      slider({
        label: 'Sweet spot',
        min: 0.5,
        max: 0.95,
        step: 0.01,
        value: state.sweet,
        format: (v) => `${(v * 100).toFixed(0)}%`,
        onInput: (v) => {
          state.sweet = v
          refreshCurve()
        },
      }),
      slider({
        label: 'Scrape floor',
        min: -1,
        max: 0,
        step: 0.05,
        value: state.floor,
        format: (v) => v.toFixed(2),
        onInput: (v) => {
          state.floor = v
          refreshCurve()
        },
      }),
      toggle({
        label: 'Match shipped tuning',
        value: state.matchShipped,
        onChange: (v) => {
          state.matchShipped = v
          refreshCurve()
        },
      }),
    ]),
  )

  function refreshCurve() {
    plot.setYourCurve((d) => tfOf(d), state.matchShipped ? TUCK_SWEET_SPOT : state.sweet)
  }
  plot.setShippedCurve((d) => tuckFactor(d))
  refreshCurve()

  // ── Frame loop ────────────────────────────────────────────────────────
  const unsub = harness.onFrame((dt) => {
    const tf = tfOf(state.lean)
    const capMul = 1 + (TUCK_SPEED_BOOST - 1) * tf
    const dragMul = 1 - (1 - TUCK_DRAG_MUL) * tf

    // Scroll the deck at the cap the lean earns.
    deck.scroll(BASE_SCROLL * capMul * dt)

    // Bike pitches nose-down and sinks toward the deck as the lean grows.
    bike.rotation.x = state.lean * LEAN_MAX_RAD
    bike.position.set(0, HOVER_Y - 0.6 * state.lean, 0)

    // Scrape spark fires once the factor goes negative (belly on the deck).
    const scraping = tf < 0
    spark.visible = scraping
    if (scraping) {
      const noseZ = 1.3
      spark.position.set((Math.random() - 0.5) * 0.3, 0.06, noseZ - state.lean * 0.4)
      const s = 0.7 + Math.random() * 0.6
      spark.scale.setScalar(s)
    }

    plot.setMarker(state.lean, tf)
    speedOut.set(`${capMul.toFixed(2)}× · ${(TOP_SPEED_REF * capMul).toFixed(0)}`)
    dragOut.set(`${dragMul.toFixed(2)}×`)
    factorOut.set(`${tf >= 0 ? '+' : ''}${tf.toFixed(2)}`)
  })

  return () => {
    unsub()
    harness.dispose()
    deck.dispose()
  }
}

// ── Inline SVG curve plot ─────────────────────────────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg'
const W = 248
const H = 140
const PAD_X = 26
const PAD_TOP = 12
const PAD_BOT = 24
const F_MIN = -1
const F_MAX = 1.2

type CurvePlot = {
  node: HTMLElement
  setShippedCurve: (fn: (d: number) => number) => void
  setYourCurve: (fn: (d: number) => number, sweet: number) => void
  setMarker: (lean: number, factor: number) => void
}

function makeCurvePlot(): CurvePlot {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('class', 'mo-plot')

  const zeroY = yPix(0)
  svg.append(
    line(PAD_X, zeroY, W - PAD_X, zeroY, 'mo-plot-axis'),
    text(2, zeroY + 3, '0'),
    text(2, PAD_TOP + 4, '+1'),
    text(PAD_X - 2, H - 6, 'feather'),
    text(W - PAD_X - 26, H - 6, 'jam →'),
  )

  const sweetLine = line(0, PAD_TOP, 0, H - PAD_BOT, 'mo-plot-sweet')
  const shipped = path('mo-plot-shipped')
  const yours = path('mo-plot-yours')
  const marker = document.createElementNS(SVG_NS, 'circle')
  marker.setAttribute('r', '3.5')
  marker.setAttribute('class', 'mo-plot-marker')
  svg.append(sweetLine, shipped, yours, marker)

  const legend = el('div', { class: 'mo-plot-legend' }, [
    el('span', { class: 'mo-plot-key mo-key-shipped' }, ['shipped']),
    el('span', { class: 'mo-plot-key mo-key-yours' }, ['your tuning']),
  ])
  const node = el('div', { class: 'mo-plot-wrap' }, [svg, legend])

  return {
    node,
    setShippedCurve(fn) {
      shipped.setAttribute('d', curvePath(fn))
    },
    setYourCurve(fn, sweet) {
      yours.setAttribute('d', curvePath(fn))
      const sx = xPix(sweet)
      sweetLine.setAttribute('x1', String(sx))
      sweetLine.setAttribute('x2', String(sx))
    },
    setMarker(lean, factor) {
      marker.setAttribute('cx', String(xPix(lean)))
      marker.setAttribute('cy', String(yPix(factor)))
    },
  }
}

function curvePath(fn: (d: number) => number): string {
  const steps = 48
  let d = ''
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    d += `${i === 0 ? 'M' : 'L'}${xPix(t).toFixed(1)},${yPix(fn(t)).toFixed(1)}`
  }
  return d
}

function xPix(lean: number): number {
  return PAD_X + lean * (W - 2 * PAD_X)
}
function yPix(f: number): number {
  const clamped = Math.max(F_MIN, Math.min(F_MAX, f))
  return PAD_TOP + ((F_MAX - clamped) / (F_MAX - F_MIN)) * (H - PAD_TOP - PAD_BOT)
}

function line(x1: number, y1: number, x2: number, y2: number, cls: string): SVGLineElement {
  const l = document.createElementNS(SVG_NS, 'line')
  l.setAttribute('x1', String(x1))
  l.setAttribute('y1', String(y1))
  l.setAttribute('x2', String(x2))
  l.setAttribute('y2', String(y2))
  l.setAttribute('class', cls)
  return l
}
function path(cls: string): SVGPathElement {
  const p = document.createElementNS(SVG_NS, 'path')
  p.setAttribute('class', cls)
  p.setAttribute('fill', 'none')
  return p
}
function text(x: number, y: number, s: string): SVGTextElement {
  const t = document.createElementNS(SVG_NS, 'text')
  t.setAttribute('x', String(x))
  t.setAttribute('y', String(y))
  t.setAttribute('class', 'mo-plot-label')
  t.textContent = s
  return t
}
