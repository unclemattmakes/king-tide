import * as THREE from 'three'
import {
  driftBoostParams,
  TIER_1_THRESHOLD_S,
  TIER_2_THRESHOLD_S,
  TIER_3_THRESHOLD_S,
  tierFor,
} from '@/game/systems/drift-tiers'
import { createDemoHarness } from '../shared/demo-harness'
import { buildBike, createScrollDeck } from '../shared/scene-bits'
import { el, panel, readout } from '../shared/ui'

/**
 * Chapter 04 demo: the mini-turbo. Hold to drift-charge and watch the
 * tiers build (blue → orange → purple) at the REAL thresholds from
 * src/game/systems/drift-tiers.ts; release to fire the tiered boost the
 * shipping `driftBoostParams` returns. The deck scrolls at the boost the
 * charge earns, so a longer hold visibly slingshots further.
 */

const MAX_S = 3.0 // charge-meter scale (a touch past the UMT threshold)
const BASE_SCROLL = 15
const DRIFT_YAW = 0.42
const DRIFT_ROLL = -0.22

const TIER_COLORS = [0x6b7a90, 0x4da6ff, 0xff7a3a, 0xb06bff]
const TIER_NAMES = ['— charging', 'Blue · MT', 'Orange · SMT', 'Purple · UMT']

export function mountDriftDemo(stage: HTMLElement, controlsHost: HTMLElement): () => void {
  const harness = createDemoHarness(stage, {
    cameraPos: [3.2, 2.8, -6.5],
    target: [0, 0.7, 1.5],
    fov: 50,
    background: 0x070f1a,
  })
  const { scene, controls } = harness
  controls.minDistance = 4
  controls.maxDistance = 26
  controls.target.set(0, 0.7, 1.2)

  scene.add(new THREE.HemisphereLight(0x9fc8ff, 0x0a1526, 0.9))
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.4)
  sun.position.set(-6, 9, -4)
  scene.add(sun)

  const deck = createScrollDeck(scene)

  // ── Bike + rear sparks + boost glow ───────────────────────────────────
  const bike = buildBike(1.0)
  scene.add(bike)

  const sparkMat = new THREE.MeshBasicMaterial({ color: TIER_COLORS[0] ?? 0x6b7a90 })
  const sparkGeo = new THREE.SphereGeometry(0.12, 10, 8)
  const sparks = [new THREE.Mesh(sparkGeo, sparkMat), new THREE.Mesh(sparkGeo, sparkMat)]
  sparks[0]?.position.set(0.42, 0.18, -1.0)
  sparks[1]?.position.set(-0.42, 0.18, -1.0)
  const sparkGroup = new THREE.Group()
  for (const s of sparks) sparkGroup.add(s)
  sparkGroup.visible = false
  bike.add(sparkGroup)

  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 })
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.6, 16, 12), glowMat)
  glow.position.set(0, 0.4, -1.1)
  bike.add(glow)

  // ── State ─────────────────────────────────────────────────────────────
  let charging = false
  let chargeS = 0
  let boostS = 0
  let boostInitialS = 0
  let boostMul = 1
  let curYaw = 0
  let curRoll = 0
  let pulse = 0

  // ── Controls ──────────────────────────────────────────────────────────
  const meter = makeChargeMeter()
  const chargeOut = readout('Charge held')
  const tierOut = readout('Tier')
  const boostOut = readout('Boost on release')

  const holdBtn = el('button', { type: 'button', class: 'mo-drift-btn' }, ['Hold to drift'])

  controlsHost.append(
    panel('Charge a mini-turbo', [
      el('p', { class: 'mo-ctrl-hint' }, [
        'Hold the button (or press and hold Space, or press on the scene). Release to fire.',
      ]),
      holdBtn,
      meter.node,
      chargeOut.node,
      tierOut.node,
      boostOut.node,
    ]),
  )

  function startCharge() {
    if (charging) return
    charging = true
    chargeS = 0
  }
  function endCharge() {
    if (!charging) return
    charging = false
    const tier = tierFor(chargeS)
    const params = driftBoostParams(tier)
    if (params) {
      boostInitialS = params.durationS
      boostS = params.durationS
      boostMul = params.multiplier
      boostOut.set(`${TIER_NAMES[tier]} → ${params.multiplier.toFixed(2)}× · ${params.durationS}s`)
    } else {
      boostOut.set('too short — no boost')
    }
  }

  // Input wiring.
  const onBtnDown = (e: Event) => {
    e.preventDefault()
    startCharge()
  }
  const onUp = () => endCharge()
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault()
      startCharge()
    }
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') endCharge()
  }
  holdBtn.addEventListener('pointerdown', onBtnDown)
  holdBtn.addEventListener('pointerup', onUp)
  holdBtn.addEventListener('pointerleave', onUp)
  stage.addEventListener('pointerdown', onBtnDown)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)

  // ── Frame loop ────────────────────────────────────────────────────────
  const unsub = harness.onFrame((dt) => {
    pulse += dt

    if (charging) chargeS = Math.min(chargeS + dt, MAX_S)
    if (boostS > 0) boostS = Math.max(0, boostS - dt)
    const boosting = boostS > 0
    if (!boosting) boostMul = 1

    const tier = charging ? tierFor(chargeS) : 0

    // Deck speed: scrub while drifting, slingshot while boosting, else cruise.
    const speedMul = charging ? 0.7 : boosting ? boostMul : 1
    deck.scroll(BASE_SCROLL * speedMul * dt)

    // Bike pose eases toward drift or straight.
    const targetYaw = charging ? DRIFT_YAW : 0
    const targetRoll = charging ? DRIFT_ROLL : 0
    const ease = 1 - Math.exp(-dt / 0.08)
    curYaw += (targetYaw - curYaw) * ease
    curRoll += (targetRoll - curRoll) * ease
    bike.rotation.set(boosting ? -0.04 : 0, curYaw, curRoll)

    // Rear sparks: colored by tier while charging, pulsing.
    sparkGroup.visible = charging
    if (charging) {
      const c = TIER_COLORS[tier] ?? TIER_COLORS[0] ?? 0xffffff
      sparkMat.color.setHex(c)
      const s = 0.7 + 0.4 * Math.abs(Math.sin(pulse * 18))
      for (const sp of sparks) sp.scale.setScalar(s)
    }

    // Boost glow: tier-colored flash that fades over the boost.
    if (boosting) {
      const t = boostInitialS > 0 ? boostS / boostInitialS : 0
      const lastTier = tierFor(chargeS) // tier that fired (charge frozen at release)
      glowMat.color.setHex(TIER_COLORS[lastTier] ?? 0xffffff)
      glowMat.opacity = 0.5 * t
      glow.scale.setScalar(1 + (1 - t) * 1.5)
    } else {
      glowMat.opacity = 0
    }

    meter.set(chargeS, tier, charging)
    chargeOut.set(`${chargeS.toFixed(2)} s`)
    tierOut.set(charging ? (TIER_NAMES[tier] ?? '—') : boosting ? 'boosting' : '—')
  })

  return () => {
    unsub()
    holdBtn.removeEventListener('pointerdown', onBtnDown)
    holdBtn.removeEventListener('pointerup', onUp)
    holdBtn.removeEventListener('pointerleave', onUp)
    stage.removeEventListener('pointerdown', onBtnDown)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    harness.dispose()
    deck.dispose()
    sparkGeo.dispose()
    sparkMat.dispose()
    glow.geometry.dispose()
    glowMat.dispose()
  }
}

// ── Charge meter (DOM) ────────────────────────────────────────────────────
type ChargeMeter = {
  node: HTMLElement
  set: (chargeS: number, tier: number, charging: boolean) => void
}

function makeChargeMeter(): ChargeMeter {
  const zones: { from: number; to: number; color: number }[] = [
    { from: 0, to: TIER_1_THRESHOLD_S, color: TIER_COLORS[0] ?? 0x6b7a90 },
    { from: TIER_1_THRESHOLD_S, to: TIER_2_THRESHOLD_S, color: TIER_COLORS[1] ?? 0x4da6ff },
    { from: TIER_2_THRESHOLD_S, to: TIER_3_THRESHOLD_S, color: TIER_COLORS[2] ?? 0xff7a3a },
    { from: TIER_3_THRESHOLD_S, to: MAX_S, color: TIER_COLORS[3] ?? 0xb06bff },
  ]
  const bar = el('div', { class: 'mo-charge-bar' })
  for (const z of zones) {
    const left = (z.from / MAX_S) * 100
    const width = ((z.to - z.from) / MAX_S) * 100
    bar.append(
      el('div', {
        class: 'mo-charge-zone',
        style: `left:${left}%;width:${width}%;background:${hex(z.color)}`,
      }),
    )
  }
  const fill = el('div', { class: 'mo-charge-fill' })
  bar.append(fill)

  const ticks = el('div', { class: 'mo-charge-ticks' })
  for (const s of [TIER_1_THRESHOLD_S, TIER_2_THRESHOLD_S, TIER_3_THRESHOLD_S]) {
    ticks.append(el('span', { style: `left:${(s / MAX_S) * 100}%` }, [`${s}s`]))
  }

  const node = el('div', { class: 'mo-charge-meter' }, [bar, ticks])
  return {
    node,
    set(chargeS, tier, charging) {
      fill.style.width = `${Math.min(chargeS / MAX_S, 1) * 100}%`
      const c = charging ? (TIER_COLORS[tier] ?? TIER_COLORS[0] ?? 0x6b7a90) : 0x6b7a90
      fill.style.background = hex(c)
      fill.style.opacity = charging ? '0.95' : '0.4'
    },
  }
}

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`
}
