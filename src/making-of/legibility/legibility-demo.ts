import * as THREE from 'three'
import { CHARGE_LADDER, SIGNAL_COLORS, type SignalState } from '@/engine/render/signal-colors'
import {
  advanceWaveField,
  createWaveField,
  defaultWaves,
  sampleSurface,
} from '@/engine/sim/water/wave-field'
import { createDemoHarness } from '../shared/demo-harness'
import { buildBike, buildWaterGrid } from '../shared/scene-bits'
import { el, panel, readout, segmented, toggle } from '../shared/ui'

/**
 * Chapter 08 demo: "the contrast budget." A deliberately muted seascape —
 * teal water, slate skyline, two dull bikes — with a small set of gameplay
 * tokens (boost, pickup, hazard) floating in it. The token colours,
 * shapes, and motions are read STRAIGHT from the shipping vocabulary in
 * `@/engine/render/signal-colors` (SIGNAL_COLORS + CHARGE_LADDER) — the
 * same frozen tokens the in-game rim/ribbon/HUD slices import, so a signal
 * reads here exactly as it does in a race.
 *
 * Three things the reader can prove for themselves:
 *  - "Light the signals" off → the tokens drop into the world band and you
 *    lose them. That's the whole point of holding the world muted: the
 *    brightest thing on screen should always be a gameplay event.
 *  - "Grayscale" → the signals still read, because every token is
 *    double-coded (colour + shape + motion). Colour alone is never the cue.
 *  - The drift-charge ladder ramps blue → orange → violet on the player's
 *    own bike, the deficiency-safe axis the vocabulary is built around.
 */

type Token = {
  state: SignalState
  group: THREE.Group
  mat: THREE.MeshStandardMaterial
  /** Animate the token's intended motion; `lit` gates the signal palette. */
  animate: (t: number, lit: boolean) => void
}

// The muted world band — deliberately desaturated teal/slate so nothing in
// the environment competes with a signal hue (signal-colors.ts, rule 1).
const WORLD_DEEP = 0x0c2030
const WORLD_CREST = 0x1d5468
const SKYLINE = 0x223a4d
const MUTED_TOKEN = 0x2b4358 // what a token fades to when the signals are off

export function mountLegibilityDemo(stage: HTMLElement, controlsHost: HTMLElement): () => void {
  const harness = createDemoHarness(stage, {
    cameraPos: [0, 7.5, 17],
    target: [0, 1.2, 0],
    fov: 50,
    background: 0x081320,
  })
  const { scene, controls, renderer } = harness
  controls.minDistance = 8
  controls.maxDistance = 48
  controls.target.set(0, 1.2, 0)

  scene.add(new THREE.HemisphereLight(0x9fc8ff, 0x0a1828, 0.8))
  const sun = new THREE.DirectionalLight(0xffe9cf, 1.25)
  sun.position.set(-12, 14, 10)
  scene.add(sun)

  // ── Muted seascape ─────────────────────────────────────────────────────
  const field = createWaveField(
    defaultWaves().map((w) => ({ ...w, amplitude: w.amplitude * 0.4 })),
    { baseY: 0 },
  )
  const seg = window.matchMedia('(max-width: 720px)').matches ? 64 : 110
  const waterGeo = buildWaterGrid(seg, 60)
  const waterMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.42,
    metalness: 0.04,
  })
  const water = new THREE.Mesh(waterGeo, waterMat)
  scene.add(water)
  const wPos = waterGeo.getAttribute('position') as THREE.BufferAttribute
  const wNorm = waterGeo.getAttribute('normal') as THREE.BufferAttribute
  const wCol = waterGeo.getAttribute('color') as THREE.BufferAttribute
  const wBase = (waterGeo.userData.baseXZ as Float32Array) ?? new Float32Array()
  const deep = new THREE.Color(WORLD_DEEP)
  const crest = new THREE.Color(WORLD_CREST)
  const scratch = new THREE.Color()

  // A low slate skyline so the world has muted mass to compete with signals.
  const skylineMat = new THREE.MeshStandardMaterial({ color: SKYLINE, roughness: 0.9 })
  const skyline = new THREE.Group()
  const towerGeo = new THREE.BoxGeometry(1, 1, 1)
  for (let i = 0; i < 9; i++) {
    const t = new THREE.Mesh(towerGeo, skylineMat)
    const w = 1.6 + Math.random() * 1.4
    const h = 2.5 + Math.random() * 5
    t.scale.set(w, h, w)
    t.position.set(-24 + i * 6 + Math.random() * 2, h / 2 - 1.2, -22 - Math.random() * 6)
    skyline.add(t)
  }
  scene.add(skyline)

  // ── Player + rival bikes (muted, so a rim signal can pop off them) ──────
  const playerBike = buildBike(1.1, { bodyColor: 0x9a5a3c, trimColor: 0x141c28 })
  playerBike.position.set(0, 1.0, 2)
  scene.add(playerBike)

  const rivalBike = buildBike(1.1, { bodyColor: 0x44525f, trimColor: 0x141c28 })
  rivalBike.position.set(-3.2, 1.0, 4.2)
  rivalBike.rotation.y = 0.18
  scene.add(rivalBike)

  // Rear sparks on the player bike — the drift-charge ladder's "denseSparks".
  const sparkGeo = new THREE.SphereGeometry(0.13, 10, 8)
  const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const sparks: THREE.Mesh[] = []
  const sparkGroup = new THREE.Group()
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Mesh(sparkGeo, sparkMat)
    const side = i % 2 === 0 ? 0.45 : -0.45
    s.position.set(side, 0.2 + (i >> 1) * 0.06, -1.15 - (i >> 1) * 0.18)
    sparks.push(s)
    sparkGroup.add(s)
  }
  sparkGroup.visible = false
  playerBike.add(sparkGroup)

  // ── Gameplay tokens, built from the shipping vocabulary ────────────────
  const tokens: Token[] = [
    makeBoost(new THREE.Vector3(0, 2.4, -7)),
    makePickup(new THREE.Vector3(6, 2.0, -2)),
    makeHazard(new THREE.Vector3(-6.5, 1.6, -3)),
  ]
  for (const tk of tokens) scene.add(tk.group)

  // ── Controls ───────────────────────────────────────────────────────────
  let signalsLit = true
  let grayscale = false
  let chargeStage = 0 // 0 = none, 1..3 = CHARGE_LADDER rungs

  const boostOut = readout('Boost token')
  const pickupOut = readout('Pickup token')
  const hazardOut = readout('Hazard token')
  const chargeOut = readout('Charge rim')
  boostOut.set(`${SIGNAL_COLORS.boost.srgbHex} · chevron`)
  pickupOut.set(`${SIGNAL_COLORS.pickup.srgbHex} · ring`)
  hazardOut.set(`${SIGNAL_COLORS.hazard.srgbHex} · angular`)
  chargeOut.set('—')

  controlsHost.append(
    panel('Spend the budget', [
      toggle({
        label: 'Light the signals',
        value: signalsLit,
        onChange: (v) => {
          signalsLit = v
        },
      }),
      toggle({
        label: 'Grayscale (peripheral test)',
        value: grayscale,
        onChange: (v) => {
          grayscale = v
          renderer.domElement.style.filter = v ? 'grayscale(1) contrast(1.04)' : ''
        },
      }),
      el('p', { class: 'mo-ctrl-hint' }, [
        'Turn the signals off and the gameplay events sink into the muted world. Grayscale proves they still read by shape + motion, not hue alone.',
      ]),
    ]),
    panel('Drift-charge ladder', [
      segmented({
        label: 'Charge stage',
        value: '0',
        options: [
          { value: '0', label: 'None' },
          { value: '1', label: 'Blue' },
          { value: '2', label: 'Orange' },
          { value: '3', label: 'Violet' },
        ],
        onChange: (v) => {
          chargeStage = Number(v)
          const rung = chargeStage > 0 ? CHARGE_LADDER[chargeStage - 1] : undefined
          chargeOut.set(rung ? `${rung.srgbHex} · ${rung.meaning.split('—')[0]?.trim()}` : '—')
        },
      }),
      el('p', { class: 'mo-ctrl-hint' }, [
        'Blue → orange → violet — the colourblind-safe axis the whole vocabulary is built on. Density ramps too, so the stage survives the grayscale test.',
      ]),
    ]),
    panel('Live, from signal-colors.ts', [
      boostOut.node,
      pickupOut.node,
      hazardOut.node,
      chargeOut.node,
    ]),
  )

  // ── Frame loop ─────────────────────────────────────────────────────────
  const unsub = harness.onFrame((dt, t) => {
    advanceWaveField(field, dt)
    for (let i = 0; i < wPos.count; i++) {
      const x = wBase[i * 2] ?? 0
      const z = wBase[i * 2 + 1] ?? 0
      const s = sampleSurface(field, x, z)
      wPos.setY(i, s.y)
      wNorm.setXYZ(i, s.nx, s.ny, s.nz)
      const k = THREE.MathUtils.clamp(0.5 + s.y / 1.4, 0, 1)
      scratch.copy(deep).lerp(crest, k)
      wCol.setXYZ(i, scratch.r, scratch.g, scratch.b)
    }
    wPos.needsUpdate = true
    wNorm.needsUpdate = true
    wCol.needsUpdate = true

    for (const tk of tokens) tk.animate(t, signalsLit)

    // Drift-charge rim + sparks on the player bike.
    const rung = chargeStage > 0 ? CHARGE_LADDER[chargeStage - 1] : undefined
    sparkGroup.visible = signalsLit && !!rung
    if (signalsLit && rung) {
      sparkMat.color.copy(rung.color)
      const pulse = 0.7 + 0.4 * Math.abs(Math.sin(t * 16))
      // Density ramps with the stage — the peripheral/grayscale-safe cue.
      const shown = 1 + chargeStage
      for (let i = 0; i < sparks.length; i++) {
        const s = sparks[i]
        if (!s) continue
        s.visible = i < shown * 2
        s.scale.setScalar(pulse * (0.8 + chargeStage * 0.12))
      }
    }
  })

  return () => {
    unsub()
    renderer.domElement.style.filter = ''
    harness.dispose()
    waterGeo.dispose()
    waterMat.dispose()
    towerGeo.dispose()
    skylineMat.dispose()
    sparkGeo.dispose()
    sparkMat.dispose()
    for (const tk of tokens) {
      tk.mat.dispose()
      tk.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose()
      })
    }
  }
}

// ── Token builders ─────────────────────────────────────────────────────────

/** A token material that swaps between its signal hue and the muted band. */
function tokenMaterial(state: SignalState): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: SIGNAL_COLORS[state].color,
    emissive: SIGNAL_COLORS[state].color,
    roughness: 0.4,
  })
}

/** Set lit vs muted on a token material in one place. */
function setLit(
  mat: THREE.MeshStandardMaterial,
  state: SignalState,
  lit: boolean,
  intensity: number,
) {
  if (lit) {
    mat.color.copy(SIGNAL_COLORS[state].color)
    mat.emissive.copy(SIGNAL_COLORS[state].color)
    mat.emissiveIntensity = intensity
  } else {
    mat.color.setHex(MUTED_TOKEN)
    mat.emissive.setHex(MUTED_TOKEN)
    mat.emissiveIntensity = 0.04
  }
}

/** Boost — a forward chevron that lunges (shape: chevron, motion: lungeStreak). */
function makeBoost(pos: THREE.Vector3): Token {
  const mat = tokenMaterial('boost')
  const group = new THREE.Group()
  group.position.copy(pos)
  const armGeo = new THREE.BoxGeometry(0.32, 0.32, 2.0)
  for (const sign of [-1, 1]) {
    const arm = new THREE.Mesh(armGeo, mat)
    arm.rotation.y = sign * 0.62
    arm.position.x = sign * 0.85
    group.add(arm)
  }
  return {
    state: 'boost',
    group,
    mat,
    animate(t, lit) {
      // Lunge forward (+Z) on a sawtooth, then snap back — a "go" streak.
      const phase = (t * 1.6) % 1
      group.position.z = pos.z + phase * 3.2
      setLit(mat, 'boost', lit, 0.6 + 0.5 * (1 - phase))
    },
  }
}

/** Pickup — a ring that pulses (shape: ringBurst, motion: pulse). */
function makePickup(pos: THREE.Vector3): Token {
  const mat = tokenMaterial('pickup')
  const group = new THREE.Group()
  group.position.copy(pos)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.16, 12, 28), mat)
  group.add(ring)
  return {
    state: 'pickup',
    group,
    mat,
    animate(t, lit) {
      group.rotation.y = t * 0.9
      const pulse = 0.85 + 0.15 * Math.sin(t * 4)
      group.scale.setScalar(pulse)
      setLit(mat, 'pickup', lit, 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 4)))
    },
  }
}

/** Hazard — an angular prism that telegraphs (shape: angular, motion: telegraph). */
function makeHazard(pos: THREE.Vector3): Token {
  const mat = tokenMaterial('hazard')
  const group = new THREE.Group()
  group.position.copy(pos)
  const prism = new THREE.Mesh(new THREE.OctahedronGeometry(0.95, 0), mat)
  group.add(prism)
  return {
    state: 'hazard',
    group,
    mat,
    animate(t, lit) {
      group.rotation.set(t * 0.4, t * 0.7, 0)
      // Telegraph: a steady, deliberate on/off blink rather than a smooth glow.
      const blink = Math.sin(t * 5) > 0 ? 1 : 0.18
      setLit(mat, 'hazard', lit, 0.35 + 0.75 * blink)
    },
  }
}
