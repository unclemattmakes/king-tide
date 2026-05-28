import * as THREE from 'three'
import { defaultBikeStats } from '@/game/bikes/stats'
import { BIKE_VARIANTS, type BikeVariantId, DEFAULT_BIKE_VARIANT } from '@/game/bikes/variants'
import { createDemoHarness } from '../shared/demo-harness'
import { buildBike } from '../shared/scene-bits'
import { el, panel, readout, segmented, slider } from '../shared/ui'

/**
 * Chapter 07 / drive demo. The arcade thrust + steer model from
 * `src/game/systems/hover.ts`, simplified to a flat-ground 2D rigid body
 * so a reader can fly a bike around with WASD or an on-screen joystick.
 *
 * The motion math mirrors the shipping code:
 *
 *   speedFalloff = max(0, 1 − speed / topSpeed)
 *   aThrust      = throttle · accel · scale · speedFalloff
 *   aLateral     = −vRight · lateralDrag
 *   aYaw         = steer · turnTorque   (sign matches our chase-cam convention)
 *
 * Variants come straight from `BIKE_VARIANTS` so picking "Cruiser"
 * gives you the cruiser's actual stats — drop accel, soft turn torque
 * — not a stand-in.
 */

const FORWARD_DRAG = 0.4 // gentle rolling resistance so the bike eventually stops
const ANGULAR_DAMP = 2.5 // rigid-body angular damping (per s)
const STEP_HZ = 120 // sub-step at 120 Hz for stability even at high spring
const GROUND_SIZE = 80
const GRID_SPACING = 4
const CAMERA_OFFSET = new THREE.Vector3(0, 4, -7) // behind & above the bike

type Stats = {
  accel: number
  topSpeed: number
  turnTorque: number
  lateralDrag: number
  reverseScale: number
}

export function mountDriveDemo(stage: HTMLElement, controlsHost: HTMLElement): () => void {
  const harness = createDemoHarness(stage, {
    cameraPos: [CAMERA_OFFSET.x, CAMERA_OFFSET.y, CAMERA_OFFSET.z],
    target: [0, 0.4, 2],
    fov: 55,
    background: 0x070f1a,
  })
  const { scene, controls } = harness
  controls.enabled = false // chase camera handles framing

  scene.add(new THREE.HemisphereLight(0x9fc8ff, 0x0a1526, 0.85))
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.5)
  sun.position.set(-6, 9, 4)
  scene.add(sun)

  // ── Ground + grid for sense of motion ────────────────────────────────
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_SIZE * 4, GROUND_SIZE * 4),
    new THREE.MeshStandardMaterial({ color: 0x0b1828, roughness: 0.95 }),
  )
  ground.rotation.x = -Math.PI / 2
  scene.add(ground)

  const grid = new THREE.GridHelper(
    GROUND_SIZE * 2,
    Math.round((GROUND_SIZE * 2) / GRID_SPACING),
    0x2f6f8a,
    0x1c3a4a,
  )
  ;(grid.material as THREE.Material).transparent = true
  ;(grid.material as THREE.Material).opacity = 0.4
  scene.add(grid)

  // ── Bike + heading arrow + velocity arrow ────────────────────────────
  const startVariant = BIKE_VARIANTS[DEFAULT_BIKE_VARIANT]
  const bike = buildBike(1.0, { bodyColor: startVariant.bodyColor })
  scene.add(bike)

  // A faint heading arrow that always points along the bike's facing.
  const headingArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0.05, 0),
    2.4,
    0xffd54a,
    0.5,
    0.3,
  )
  scene.add(headingArrow)
  // A second arrow tracks actual velocity — when this diverges from
  // heading you're seeing lateral drift in action.
  const velocityArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0.06, 0),
    1.5,
    0x4dd6ff,
    0.4,
    0.25,
  )
  velocityArrow.visible = false
  scene.add(velocityArrow)

  // ── State (seeded from the racer's defaults) ─────────────────────────
  const seed = defaultBikeStats()
  const stats: Stats = {
    accel: seed.accel,
    topSpeed: seed.topSpeed,
    turnTorque: seed.turnTorque,
    lateralDrag: seed.lateralDrag,
    reverseScale: seed.reverseScale,
  }
  const body = {
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    yaw: 0, // 0 = facing +Z
    yawRate: 0,
  }
  let throttleIn = 0
  let steerIn = 0
  let keyT = 0
  let keyS = 0
  let joyT = 0
  let joyS = 0
  let joyActive = false

  function reset(): void {
    body.x = 0
    body.z = 0
    body.vx = 0
    body.vz = 0
    body.yaw = 0
    body.yawRate = 0
  }

  // ── On-screen joystick (also captures touch) ─────────────────────────
  const hint = el('div', { class: 'mo-drive-hint' }, [
    'Drag the joystick (or press W/A/S/D) to drive. Space resets.',
  ])
  stage.append(hint)

  const knob = el('div', { class: 'mo-joystick-knob' })
  const joystick = el('div', { class: 'mo-joystick' }, [knob])
  stage.append(joystick)

  function setKnob(px: number, py: number): void {
    knob.style.transform = `translate(${px}px, ${py}px)`
  }

  function joyUpdate(e: PointerEvent): void {
    const rect = joystick.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const r = rect.width / 2 - 14
    let dx = e.clientX - cx
    let dy = e.clientY - cy
    const len = Math.hypot(dx, dy)
    if (len > r) {
      dx = (dx * r) / len
      dy = (dy * r) / len
    }
    setKnob(dx, dy)
    joyS = Math.max(-1, Math.min(1, dx / r))
    joyT = Math.max(-1, Math.min(1, -dy / r)) // up = forward
  }

  function joyEnd(): void {
    joyActive = false
    joyS = 0
    joyT = 0
    setKnob(0, 0)
    knob.style.transition = 'transform 0.15s ease'
    setTimeout(() => {
      knob.style.transition = ''
    }, 160)
  }

  joystick.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    joyActive = true
    joystick.setPointerCapture(e.pointerId)
    knob.style.transition = ''
    joyUpdate(e)
  })
  joystick.addEventListener('pointermove', (e) => {
    if (joyActive) joyUpdate(e)
  })
  joystick.addEventListener('pointerup', joyEnd)
  joystick.addEventListener('pointercancel', joyEnd)

  // ── Keyboard (WASD; only active when the stage is in viewport) ───────
  function onKey(e: KeyboardEvent, down: boolean): void {
    // We don't grab keys when the user is typing into something else.
    const tgt = e.target as HTMLElement | null
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return
    // We also don't grab keys when the demo is scrolled off screen — the
    // harness's IntersectionObserver pauses the loop already, but the
    // pointerEvents wouldn't fire on an off-screen joystick anyway.
    const rect = stage.getBoundingClientRect()
    const visible =
      rect.bottom > 0 && rect.top < (window.innerHeight || document.documentElement.clientHeight)
    if (!visible) return
    let used = true
    switch (e.code) {
      case 'KeyW':
        keyT = down ? 1 : 0
        break
      case 'KeyS':
        keyT = down ? -1 : 0
        break
      case 'KeyA':
        keyS = down ? -1 : 0
        break
      case 'KeyD':
        keyS = down ? 1 : 0
        break
      case 'Space':
        if (down) reset()
        break
      default:
        used = false
    }
    if (used) e.preventDefault()
  }
  const onKeyDown = (e: KeyboardEvent) => onKey(e, true)
  const onKeyUp = (e: KeyboardEvent) => onKey(e, false)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)

  // ── Controls panel ───────────────────────────────────────────────────
  const speedOut = readout('Speed')
  const headingOut = readout('Heading')
  const slipOut = readout('Lateral slip')
  const resetBtn = el('button', { type: 'button', class: 'mo-drift-btn' }, ['Reset position'])
  resetBtn.addEventListener('click', reset)

  const accelSlider = slider({
    label: 'Accel',
    min: 5,
    max: 30,
    step: 0.5,
    value: stats.accel,
    format: (v) => `${v.toFixed(1)} m/s²`,
    onInput: (v) => {
      stats.accel = v
    },
  })
  const topSpeedSlider = slider({
    label: 'Top speed',
    min: 12,
    max: 45,
    step: 0.5,
    value: stats.topSpeed,
    format: (v) => `${v.toFixed(1)} m/s`,
    onInput: (v) => {
      stats.topSpeed = v
    },
  })
  const turnSlider = slider({
    label: 'Turn torque',
    min: 1,
    max: 8,
    step: 0.1,
    value: stats.turnTorque,
    format: (v) => `${v.toFixed(1)} rad/s²`,
    onInput: (v) => {
      stats.turnTorque = v
    },
  })
  const dragSlider = slider({
    label: 'Lateral drag',
    min: 1,
    max: 20,
    step: 0.5,
    value: stats.lateralDrag,
    format: (v) => `${v.toFixed(1)} m/s² / (m/s)`,
    onInput: (v) => {
      stats.lateralDrag = v
    },
  })

  function applyVariant(id: BikeVariantId): void {
    const v = BIKE_VARIANTS[id]
    stats.accel = v.stats.accel
    stats.topSpeed = v.stats.topSpeed
    stats.turnTorque = v.stats.turnTorque
    stats.lateralDrag = v.stats.lateralDrag
    stats.reverseScale = v.stats.reverseScale
    const bodyMat = (bike.userData as { bodyMat?: THREE.MeshStandardMaterial }).bodyMat
    if (bodyMat) bodyMat.color.setHex(v.bodyColor)
    setSliderTo(accelSlider, v.stats.accel)
    setSliderTo(topSpeedSlider, v.stats.topSpeed)
    setSliderTo(turnSlider, v.stats.turnTorque)
    setSliderTo(dragSlider, v.stats.lateralDrag)
  }

  controlsHost.append(
    panel('Pick a flavor', [
      segmented({
        label: 'Variant',
        value: DEFAULT_BIKE_VARIANT,
        options: [
          { value: 'racer', label: 'Racer' },
          { value: 'cruiser', label: 'Cruiser' },
          { value: 'stunt', label: 'Stunt' },
          { value: 'scout', label: 'Scout' },
          { value: 'sparrow', label: 'Sparrow' },
        ],
        onChange: (v) => applyVariant(v as BikeVariantId),
      }),
    ]),
    panel('Hand-tune the stats', [accelSlider, topSpeedSlider, turnSlider, dragSlider]),
    panel('Telemetry', [speedOut.node, headingOut.node, slipOut.node, resetBtn]),
  )

  // ── Frame loop (scratch vectors reused each tick to avoid GC churn) ──
  const tmpFwd = new THREE.Vector3()
  const tmpRight = new THREE.Vector3()
  const tmpVel = new THREE.Vector3()
  const camPos = new THREE.Vector3()
  const lookAt = new THREE.Vector3()

  const unsub = harness.onFrame((dt) => {
    // Joystick wins while it's held; otherwise WASD drives the inputs.
    throttleIn = joyActive ? joyT : keyT
    steerIn = joyActive ? joyS : keyS

    // Sub-step the integrator so high-stat tunings stay stable.
    const sdt = 1 / STEP_HZ
    let acc = dt
    while (acc > 0) {
      const h = Math.min(sdt, acc)
      stepBody(body, stats, throttleIn, steerIn, h)
      acc -= h
    }

    // Apply pose to the visible bike.
    bike.position.set(body.x, 0.05, body.z)
    bike.rotation.y = body.yaw

    // Update arrows.
    tmpFwd.set(Math.sin(body.yaw), 0, Math.cos(body.yaw))
    headingArrow.position.set(body.x, 0.05, body.z)
    headingArrow.setDirection(tmpFwd)
    const speed = Math.hypot(body.vx, body.vz)
    if (speed > 0.5) {
      velocityArrow.visible = true
      velocityArrow.position.set(body.x, 0.06, body.z)
      tmpVel.set(body.vx / speed, 0, body.vz / speed)
      velocityArrow.setDirection(tmpVel)
      velocityArrow.setLength(Math.min(speed / 4, 4), 0.4, 0.25)
    } else {
      velocityArrow.visible = false
    }

    // Chase camera.
    tmpRight.set(tmpFwd.z, 0, -tmpFwd.x)
    camPos
      .copy(tmpFwd)
      .multiplyScalar(CAMERA_OFFSET.z)
      .add(tmpRight.multiplyScalar(CAMERA_OFFSET.x))
    camPos.x += body.x
    camPos.z += body.z
    camPos.y = CAMERA_OFFSET.y
    harness.camera.position.lerp(camPos, 1 - Math.exp(-dt / 0.18))
    lookAt.set(body.x + tmpFwd.x * 4, 0.4, body.z + tmpFwd.z * 4)
    harness.camera.lookAt(lookAt)

    // Telemetry.
    speedOut.set(`${speed.toFixed(1)} m/s`)
    headingOut.set(`${((body.yaw * 180) / Math.PI).toFixed(0)}°`)
    // Slip = component of velocity orthogonal to heading.
    const vFwd = body.vx * tmpFwd.x + body.vz * tmpFwd.z
    const vRight = body.vx * tmpFwd.z + body.vz * -tmpFwd.x
    const slipDeg = speed < 0.3 ? 0 : (Math.atan2(Math.abs(vRight), Math.abs(vFwd)) * 180) / Math.PI
    slipOut.set(`${slipDeg.toFixed(0)}°`)
  })

  return () => {
    unsub()
    harness.dispose()
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    hint.remove()
    joystick.remove()
    ground.geometry.dispose()
    ;(ground.material as THREE.Material).dispose()
    grid.geometry.dispose()
    ;(grid.material as THREE.Material).dispose()
  }
}

type Body = {
  x: number
  z: number
  vx: number
  vz: number
  yaw: number
  yawRate: number
}

/**
 * One sub-step of the arcade physics. Mirrors `src/game/systems/hover.ts`
 * (ground branch): thrust scaled by `speedFalloff`, lateral drag on the
 * right-component of velocity, yaw as a torque with angular damping.
 */
function stepBody(b: Body, s: Stats, throttle: number, steer: number, dt: number): void {
  // Forward = +Z when yaw = 0; rotate by yaw around +Y axis.
  const fx = Math.sin(b.yaw)
  const fz = Math.cos(b.yaw)
  const rx = fz
  const rz = -fx

  const vFwd = b.vx * fx + b.vz * fz
  const vRight = b.vx * rx + b.vz * rz
  const speed = Math.hypot(b.vx, b.vz)

  const scale = throttle >= 0 ? 1 : s.reverseScale
  const speedFalloff = Math.max(0, 1 - speed / s.topSpeed)
  const aThrust = throttle * s.accel * scale * speedFalloff
  const aFwdDrag = -vFwd * FORWARD_DRAG
  const aLatDrag = -vRight * s.lateralDrag

  b.vx += (fx * (aThrust + aFwdDrag) + rx * aLatDrag) * dt
  b.vz += (fz * (aThrust + aFwdDrag) + rz * aLatDrag) * dt

  // Yaw is a torque. Our convention: forward = (sin yaw, 0, cos yaw),
  // so yaw increases as the nose rotates from +Z toward +X — which is
  // a right-swing from the chase camera's POV. Steer = +1 (D pressed)
  // therefore wants +yaw.
  const aYaw = steer * s.turnTorque
  b.yawRate += aYaw * dt
  b.yawRate *= Math.exp(-ANGULAR_DAMP * dt)
  b.yaw += b.yawRate * dt
  b.x += b.vx * dt
  b.z += b.vz * dt
}

// ── Slider re-targeting (used by the variant picker) ────────────────────
function setSliderTo(sliderEl: HTMLElement, value: number): void {
  const input = sliderEl.querySelector('input[type="range"]') as HTMLInputElement | null
  if (!input) return
  input.value = String(value)
  // 'input' refreshes both the value label and the onInput callback (which
  // re-writes the same stat we just set, harmless).
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
