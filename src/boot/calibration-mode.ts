/**
 * Calibration scene — one bike + one rider, no race, no AI.
 *
 * Purpose: dial in the rider's rest pose and the reactive pose-response
 * tuning (bounce / flow / head-yaw / head-pitch) without driving through
 * a track. Adds a turbulence generator that periodically kicks the bike
 * with linear + angular impulses so we can see the rider react to chop,
 * landings, lateral wobble, and yaw rate.
 *
 * Keys:
 *   R         — reset rider (re-attach if launched, zero pose response)
 *   Space     — toggle turbulence
 *   1 / 2 / 3 — set turbulence strength (light / medium / heavy)
 *   C         — force a crash launch (debug the ragdoll launch visually)
 *   L / J     — steer right/left (drives flow + head yaw)
 *   I / K     — throttle / brake (drives head pitch)
 *   Backspace — also resets (matches the main-race keybind)
 *
 * Triggered by `?calibrate=1` URL param (see url-modes.ts dispatch).
 * Self-contained boot — no menu flow, no race state, no replay. Loads
 * the lagoon track only for the ground surface; the bike hovers in place
 * at the start gate while the camera orbits.
 */

import type { Intent } from '@/engine/input/intent'
import { emptyIntent } from '@/engine/input/intent'
import { createCombatRenderSystem } from '@/engine/render/combat-render'
import { createFxSystem } from '@/engine/render/fx'
import { createPickupRenderSystem } from '@/engine/render/pickup-render'
import { createPropsMesh } from '@/engine/render/props-mesh'
import { createBikeRenderSystem } from '@/engine/render/render-systems'
import { createRenderer } from '@/engine/render/renderer'
import { createRiderRenderSystem } from '@/engine/render/rider-systems'
import { createScene } from '@/engine/render/scene'
import { createSkySystem } from '@/engine/render/sky'
import { createTrackVisuals } from '@/engine/render/track-mesh'
import { createWaterMesh, updateUnderwaterFog } from '@/engine/render/water'
import { createSimWorld } from '@/engine/sim/ecs/world'
import { createPhysicsWorld } from '@/engine/sim/physics/rapier'
import { createWaveField, defaultWaves, sampleHeight } from '@/engine/sim/water/wave-field'
import { applyStoredWaterTuning } from '@/engine/water-debug-storage'
import { loadBike } from '@/game/assets/bike-loader'
import { type LoadedProp, loadProp } from '@/game/assets/prop-loader'
import { resolveBikeVariant } from '@/game/bikes/variants'
import { ControlIntentStore, PlayerTag, RBHandleStore, TransformStore } from '@/game/components'
import { RIDER_BONE_NAMES, Rider, RiderStore } from '@/game/components/rider'
import { createBike } from '@/game/entities/bike'
import { createPropColliders } from '@/game/entities/props'
import { createRider } from '@/game/entities/rider'
import { simulateStep } from '@/game/sim-step'
import { RIDER_POSE_TUNING, resetRiderForBike } from '@/game/systems/rider-pose'
import { hideLoadingScreen, setLoadingMessage } from './loading-screen'
import { loadTrackForBoot } from './track-loader'

type TurbulenceLevel = 'off' | 'light' | 'medium' | 'heavy'

const TURBULENCE_PROFILES: Record<
  TurbulenceLevel,
  {
    /** Linear impulse magnitude on each axis (N·s / m·s mass-equiv). */
    linearMag: number
    /** Angular impulse magnitude (rad/s of body angvel kick). */
    angularMag: number
    /** Seconds between turbulence pulses. */
    period: number
  }
> = {
  off: { linearMag: 0, angularMag: 0, period: 1 },
  light: { linearMag: 50, angularMag: 1.2, period: 0.6 },
  medium: { linearMag: 120, angularMag: 2.5, period: 0.45 },
  heavy: { linearMag: 240, angularMag: 4.2, period: 0.3 },
}

export type CalibrationHandle = {
  dispose(): void
}

export async function bootCalibrationMode(appEl: HTMLElement): Promise<CalibrationHandle> {
  setLoadingMessage('Loading calibration scene…')

  const { renderer, backend, canvas, dispose: disposeRenderer } = await createRenderer(appEl)
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'

  const { scene, camera, sun, hemi } = createScene()
  const phys = await createPhysicsWorld()
  const sim = createSimWorld()

  const waveField = createWaveField(defaultWaves())
  const waterMesh = createWaterMesh(waveField, { backend })
  scene.add(waterMesh.mesh)
  applyStoredWaterTuning(waterMesh)

  const trackId = 'lagoon'
  const { track, terrainHeightmap } = await loadTrackForBoot({
    trackId,
    scene,
    phys,
    editMode: false,
  })
  if (terrainHeightmap) waterMesh.setTerrainHeightmap(terrainHeightmap)

  const sky = createSkySystem({
    scene,
    renderer,
    camera,
    sun,
    hemi,
    water: waterMesh,
    config: track.sky,
  })
  const trackVisuals = createTrackVisuals(track)
  scene.add(trackVisuals.group)

  // Editor-authored props on the start straight (visual scaffolding only).
  const assetIds = new Set<string>()
  for (const p of track.props) {
    if (p.type === 'asset' && p.assetId) assetIds.add(p.assetId)
  }
  const propAssets = new Map<string, LoadedProp>()
  if (assetIds.size > 0) {
    const loaded = await Promise.all(
      [...assetIds].map(async (id) => {
        try {
          return [id, await loadProp(`/assets/props/${id}.glb`)] as const
        } catch {
          return null
        }
      }),
    )
    for (const entry of loaded) {
      if (entry) propAssets.set(entry[0], entry[1])
    }
  }
  if (track.props.length > 0) {
    scene.add(createPropsMesh(track.props, propAssets))
    createPropColliders(phys, track.props, propAssets)
  }

  // Spawn ONE bike + rider. PlayerTag so the rider render system tints
  // the bike's exhaust as the "player" colour (matches the main race
  // colour scheme so calibration translates 1:1).
  const racerVariant = resolveBikeVariant('racer')
  const racerBikeGlb = await loadBike('/assets/bikes/racer.glb')
  const bikePos = {
    x: track.start.position.x,
    y: track.start.position.y,
    z: track.start.position.z,
  }
  const halfStartYaw = track.start.yaw / 2
  const startQuat = {
    x: 0,
    y: Math.sin(halfStartYaw),
    z: 0,
    w: Math.cos(halfStartYaw),
  }
  const bikeEid = createBike(sim, phys, {
    position: bikePos,
    yaw: track.start.yaw,
    isPlayer: true,
    peerId: 0,
    asRacer: false,
    stats: {
      ...racerVariant.stats,
      bodyColor: racerVariant.bodyColor,
      variantId: racerVariant.id,
    },
  })
  const handleEntry = RBHandleStore.get(bikeEid)
  if (!handleEntry) throw new Error('calibration: bike RB missing post-spawn')
  /** The bike's Rapier rigid-body handle — captured to a primitive so the
   *  closures below don't need to defensively re-check the ECS store. */
  const bikeRbHandle = handleEntry.handle
  createRider(sim, phys, {
    bikeEid,
    bikeRbHandle,
    bikePos,
    bikeRot: startQuat,
  })

  const bikeRender = createBikeRenderSystem(scene, sim, {
    byVariantId: { racer: racerBikeGlb },
    default: racerBikeGlb,
  })
  const riderRender = createRiderRenderSystem(scene, sim)
  const pickupRender = createPickupRenderSystem(scene, sim)
  const combatRender = createCombatRenderSystem(scene, sim)
  const fxTick = createFxSystem(scene, sim, phys, waveField).tick

  // Simple orbit camera locked on the bike. Auto-rotates so the user
  // sees every side of the rider over a few seconds.
  let camAngle = 0
  const camRadius = 6
  const camHeight = 2.4

  // Per-tick control state — driven by L/J/I/K keys so we can probe head
  // yaw + pitch + flow without driving the bike around.
  const intent = emptyIntent()

  // Turbulence state.
  let turbulence: TurbulenceLevel = 'off'
  let turbAccum = 0

  // Crash-trigger flag — pressed C sets this, sim step uses it to inject
  // a Δv > threshold velocity swing so the rider-crash system fires.
  let crashRequested = false
  let crashPhase = 0

  // ---- HUD overlay --------------------------------------------------
  const hudEl = document.createElement('div')
  hudEl.id = 'calibration-hud'
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
    min-width: 260px;
    pointer-events: none;
    line-height: 1.45;
  `
  document.body.appendChild(hudEl)

  // ---- Pose-tuning slider panel -------------------------------------
  // Right-side panel of sliders bound directly to RIDER_POSE_TUNING.
  // Changing a slider mutates the live tuning object — the pose system
  // reads it each tick, no respawn required.
  const tunerEl = document.createElement('div')
  tunerEl.id = 'calibration-tuner'
  tunerEl.style.cssText = `
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 100;
    background: rgba(0, 0, 0, 0.78);
    color: #eee;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    padding: 10px 14px;
    border-radius: 6px;
    width: 260px;
    line-height: 1.4;
    max-height: calc(100vh - 24px);
    overflow-y: auto;
  `
  document.body.appendChild(tunerEl)

  type SliderSpec = {
    label: string
    min: number
    max: number
    step: number
    get(): number
    set(v: number): void
  }

  function buildTuner() {
    const t = RIDER_POSE_TUNING
    const ra = t.restAngles
    const sl = t.seatLocal
    const bd = t.bounceDistribution
    // Builds a numeric slider spec — terser than the per-property objects
    // used in the first cut, keeps this block scannable.
    const S = (
      label: string,
      min: number,
      max: number,
      step: number,
      get: () => number,
      set: (v: number) => void,
    ): SliderSpec => ({ label, min, max, step, get, set })

    const sliders: { section: string; specs: SliderSpec[] }[] = [
      {
        section: 'SEAT (bike-local m)',
        specs: [
          S(
            'seat X',
            -0.3,
            0.3,
            0.01,
            () => sl.x,
            (v) => {
              sl.x = v
            },
          ),
          S(
            'seat Y (up)',
            0,
            1.2,
            0.01,
            () => sl.y,
            (v) => {
              sl.y = v
            },
          ),
          S(
            'seat Z (fwd)',
            -1,
            1,
            0.01,
            () => sl.z,
            (v) => {
              sl.z = v
            },
          ),
        ],
      },
      {
        section: 'SPINE / HEAD (deg)',
        specs: [
          S(
            'spine lower',
            -30,
            60,
            1,
            () => ra.spine_lower,
            (v) => {
              ra.spine_lower = v
            },
          ),
          S(
            'spine upper',
            -30,
            60,
            1,
            () => ra.spine_upper,
            (v) => {
              ra.spine_upper = v
            },
          ),
          S(
            'neck',
            -60,
            30,
            1,
            () => ra.neck,
            (v) => {
              ra.neck = v
            },
          ),
        ],
      },
      {
        section: 'SHOULDERS (deg, R mirrors)',
        specs: [
          S(
            'pitch',
            0,
            120,
            1,
            () => ra.shoulder_pitch,
            (v) => {
              ra.shoulder_pitch = v
            },
          ),
          S(
            'yaw (twist)',
            -90,
            90,
            1,
            () => ra.shoulder_yaw,
            (v) => {
              ra.shoulder_yaw = v
            },
          ),
          S(
            'roll (out)',
            -30,
            60,
            1,
            () => ra.shoulder_roll,
            (v) => {
              ra.shoulder_roll = v
            },
          ),
          S(
            'elbow',
            -120,
            30,
            1,
            () => ra.elbow,
            (v) => {
              ra.elbow = v
            },
          ),
        ],
      },
      {
        section: 'HIPS (deg, R mirrors)',
        specs: [
          S(
            'pitch (fwd)',
            -120,
            30,
            1,
            () => ra.hip_pitch,
            (v) => {
              ra.hip_pitch = v
            },
          ),
          S(
            'yaw (twist)',
            -90,
            90,
            1,
            () => ra.hip_yaw,
            (v) => {
              ra.hip_yaw = v
            },
          ),
          S(
            'roll (splay)',
            -45,
            45,
            1,
            () => ra.hip_roll,
            (v) => {
              ra.hip_roll = v
            },
          ),
          S(
            'knee',
            -30,
            120,
            1,
            () => ra.knee,
            (v) => {
              ra.knee = v
            },
          ),
        ],
      },
      {
        section: 'BOUNCE RESPONSE',
        specs: [
          S(
            'force gain',
            0,
            0.4,
            0.005,
            () => t.bounceForceGain,
            (v) => {
              t.bounceForceGain = v
            },
          ),
          S(
            'spring k',
            3,
            80,
            1,
            () => t.bounceSpringK,
            (v) => {
              t.bounceSpringK = v
            },
          ),
          S(
            'damping',
            0,
            20,
            0.2,
            () => t.bounceSpringDamping,
            (v) => {
              t.bounceSpringDamping = v
            },
          ),
          S(
            'max pitch (rad)',
            0.1,
            1.5,
            0.02,
            () => t.bounceMaxPitch,
            (v) => {
              t.bounceMaxPitch = v
            },
          ),
          S(
            'lower share',
            0,
            1,
            0.02,
            () => bd.spine_lower,
            (v) => {
              bd.spine_lower = v
              bd.spine_upper = 1 - v
            },
          ),
        ],
      },
      {
        section: 'FLOW / HEAD',
        specs: [
          S(
            'flow yaw/yawrate',
            0,
            1.5,
            0.02,
            () => t.flowYawPerYawRate,
            (v) => {
              t.flowYawPerYawRate = v
            },
          ),
          S(
            'flow max yaw',
            0,
            1.5,
            0.02,
            () => t.flowMaxYaw,
            (v) => {
              t.flowMaxYaw = v
            },
          ),
          S(
            'head yaw max',
            0,
            1.5,
            0.02,
            () => t.headYawMax,
            (v) => {
              t.headYawMax = v
            },
          ),
          S(
            'head pitch max',
            0,
            0.6,
            0.01,
            () => t.headPitchMax,
            (v) => {
              t.headPitchMax = v
            },
          ),
        ],
      },
      {
        section: 'IK STRENGTH',
        specs: [
          S(
            'hand IK',
            0,
            1,
            0.05,
            () => t.handIKStrength,
            (v) => {
              t.handIKStrength = v
            },
          ),
          S(
            'foot IK',
            0,
            1,
            0.05,
            () => t.footIKStrength,
            (v) => {
              t.footIKStrength = v
            },
          ),
        ],
      },
    ]

    tunerEl.innerHTML = ''
    const header = document.createElement('div')
    header.style.cssText = 'font-weight:600;color:#7cf;font-size:12px;margin-bottom:8px'
    header.textContent = 'POSE CALIBRATION'
    tunerEl.appendChild(header)

    for (const group of sliders) {
      const h = document.createElement('div')
      h.style.cssText = 'color:#aaa;font-weight:600;margin-top:8px;margin-bottom:4px'
      h.textContent = group.section
      tunerEl.appendChild(h)
      for (const s of group.specs) {
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0'
        const label = document.createElement('span')
        label.style.cssText = 'width:100px;color:#bbb;font-size:10px'
        label.textContent = s.label
        const input = document.createElement('input')
        input.type = 'range'
        input.min = String(s.min)
        input.max = String(s.max)
        input.step = String(s.step)
        input.value = String(s.get())
        input.style.cssText = 'flex:1;cursor:pointer'
        const val = document.createElement('span')
        val.style.cssText =
          'width:46px;text-align:right;color:#7cf;font-size:10px;font-variant-numeric:tabular-nums'
        const fmt = (v: number) =>
          s.step >= 1 ? v.toFixed(0) : s.step >= 0.01 ? v.toFixed(2) : v.toFixed(3)
        val.textContent = fmt(s.get())
        input.addEventListener('input', () => {
          const v = Number(input.value)
          s.set(v)
          val.textContent = fmt(v)
        })
        row.appendChild(label)
        row.appendChild(input)
        row.appendChild(val)
        tunerEl.appendChild(row)
      }
    }

    // Reset-to-defaults button.
    const resetBtn = document.createElement('button')
    resetBtn.textContent = 'reset tuning to defaults'
    resetBtn.style.cssText =
      'margin-top:10px;width:100%;background:#2c4060;color:#cfe;border:1px solid #4080a0;padding:5px;cursor:pointer;font-family:inherit;font-size:10px;border-radius:3px'
    resetBtn.addEventListener('click', () => {
      Object.assign(RIDER_POSE_TUNING.restAngles, DEFAULT_REST_ANGLES)
      Object.assign(RIDER_POSE_TUNING.seatLocal, DEFAULT_SEAT)
      Object.assign(RIDER_POSE_TUNING.bounceDistribution, DEFAULT_BOUNCE_DIST)
      RIDER_POSE_TUNING.bounceForceGain = DEFAULTS.bounceForceGain
      RIDER_POSE_TUNING.bounceSpringK = DEFAULTS.bounceSpringK
      RIDER_POSE_TUNING.bounceSpringDamping = DEFAULTS.bounceSpringDamping
      RIDER_POSE_TUNING.bounceMaxPitch = DEFAULTS.bounceMaxPitch
      RIDER_POSE_TUNING.flowYawPerYawRate = DEFAULTS.flowYawPerYawRate
      RIDER_POSE_TUNING.flowMaxYaw = DEFAULTS.flowMaxYaw
      RIDER_POSE_TUNING.headYawMax = DEFAULTS.headYawMax
      RIDER_POSE_TUNING.headPitchMax = DEFAULTS.headPitchMax
      RIDER_POSE_TUNING.handIKStrength = DEFAULTS.handIKStrength
      RIDER_POSE_TUNING.footIKStrength = DEFAULTS.footIKStrength
      buildTuner()
    })
    tunerEl.appendChild(resetBtn)
  }

  // Snapshot defaults at boot so the reset button has a target.
  const DEFAULT_REST_ANGLES = { ...RIDER_POSE_TUNING.restAngles }
  const DEFAULT_SEAT = { ...RIDER_POSE_TUNING.seatLocal }
  const DEFAULT_BOUNCE_DIST = { ...RIDER_POSE_TUNING.bounceDistribution }
  const DEFAULTS = {
    bounceForceGain: RIDER_POSE_TUNING.bounceForceGain,
    bounceSpringK: RIDER_POSE_TUNING.bounceSpringK,
    bounceSpringDamping: RIDER_POSE_TUNING.bounceSpringDamping,
    bounceMaxPitch: RIDER_POSE_TUNING.bounceMaxPitch,
    flowYawPerYawRate: RIDER_POSE_TUNING.flowYawPerYawRate,
    flowMaxYaw: RIDER_POSE_TUNING.flowMaxYaw,
    headYawMax: RIDER_POSE_TUNING.headYawMax,
    headPitchMax: RIDER_POSE_TUNING.headPitchMax,
    handIKStrength: RIDER_POSE_TUNING.handIKStrength,
    footIKStrength: RIDER_POSE_TUNING.footIKStrength,
  }
  buildTuner()

  // ---- Keyboard input -----------------------------------------------
  const keyDown = new Set<string>()
  function onKeyDown(e: KeyboardEvent) {
    keyDown.add(e.code)
    if (e.code === 'KeyR' || e.code === 'Backspace') {
      resetCalibration()
      e.preventDefault()
    } else if (e.code === 'Space') {
      cycleTurbulence()
      e.preventDefault()
    } else if (e.code === 'Digit1') {
      setTurbulence('light')
    } else if (e.code === 'Digit2') {
      setTurbulence('medium')
    } else if (e.code === 'Digit3') {
      setTurbulence('heavy')
    } else if (e.code === 'Digit0') {
      setTurbulence('off')
    } else if (e.code === 'KeyC') {
      crashRequested = true
    }
  }
  function onKeyUp(e: KeyboardEvent) {
    keyDown.delete(e.code)
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)

  function setTurbulence(level: TurbulenceLevel) {
    turbulence = level
  }
  function cycleTurbulence() {
    const order: TurbulenceLevel[] = ['off', 'light', 'medium', 'heavy']
    const i = order.indexOf(turbulence)
    const next = order[(i + 1) % order.length]
    if (next) setTurbulence(next)
  }
  function resetCalibration() {
    const rb = phys.world.getRigidBody(bikeRbHandle)
    if (rb) {
      rb.setTranslation(bikePos, true)
      rb.setRotation(startQuat, true)
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
    }
    resetRiderForBike(sim, phys, bikeEid)
  }

  // ---- Frame loop ---------------------------------------------------
  let disposed = false
  let rafHandle = 0
  let last = performance.now()
  let physAccum = 0
  const peerInputs = new Map<number, Intent>()
  const raceTick = () => {
    /* no-op */
  }

  function pumpIntent(dt: number) {
    // I/K throttle/brake; J/L steer.
    const target: Intent = {
      throttle: keyDown.has('KeyI') ? 1 : 0,
      brake: keyDown.has('KeyK') ? 1 : 0,
      steer: (keyDown.has('KeyL') ? 1 : 0) - (keyDown.has('KeyJ') ? 1 : 0),
      pitch: 0,
      fire: false,
      boost: false,
      trickLeft: false,
      trickRight: false,
    }
    // Smooth the steer slightly so the head-yaw lerp shows nicely.
    const cur = intent
    const blend = 1 - Math.exp(-dt * 14)
    cur.throttle += (target.throttle - cur.throttle) * blend
    cur.steer += (target.steer - cur.steer) * blend
    cur.brake += (target.brake - cur.brake) * blend
    cur.pitch = target.pitch
    cur.fire = target.fire
    cur.boost = target.boost
    peerInputs.clear()
    peerInputs.set(0, cur)
    // Mirror into the ECS so the rider-pose system can read it directly
    // (it queries ControlIntentStore by bikeEid, which is wired up by the
    // normal applyPeerInputs path, but in calibration we run that pass
    // too via simulateStep below).
    ControlIntentStore.set(bikeEid, { ...cur })
  }

  function applyTurbulence(dt: number) {
    if (turbulence === 'off') return
    const profile = TURBULENCE_PROFILES[turbulence]
    turbAccum += dt
    if (turbAccum < profile.period) return
    turbAccum = 0
    const rb = phys.world.getRigidBody(bikeRbHandle)
    if (!rb) return
    // Random impulse — biased to vertical so it feels like waves more
    // than a kick in the chest. Small horizontal component for variety.
    const linMag = profile.linearMag
    const angMag = profile.angularMag
    rb.applyImpulse(
      {
        x: (Math.random() - 0.5) * linMag * 0.4,
        y: (Math.random() * 0.8 + 0.2) * linMag * (Math.random() < 0.5 ? -1 : 1),
        z: (Math.random() - 0.5) * linMag * 0.4,
      },
      true,
    )
    rb.applyTorqueImpulse(
      {
        x: (Math.random() - 0.5) * angMag,
        y: (Math.random() - 0.5) * angMag,
        z: (Math.random() - 0.5) * angMag,
      },
      true,
    )
  }

  function injectCrashSwing(dt: number) {
    // 3-phase pulse: ramp forward velocity to 25 m/s, then slam to -2
    // m/s next physics step. Lets us see the rider's launch + ragdoll
    // without driving into a wall.
    if (!crashRequested && crashPhase === 0) return
    const rb = phys.world.getRigidBody(bikeRbHandle)
    if (!rb) return
    if (crashRequested) {
      crashRequested = false
      crashPhase = 1
      // Fling the bike forward in its current facing.
      const q = rb.rotation()
      const fwdX = 2 * (q.x * q.z + q.w * q.y)
      const fwdZ = 1 - 2 * (q.x * q.x + q.y * q.y)
      rb.setLinvel({ x: fwdX * 25, y: 0, z: fwdZ * 25 }, true)
      return
    }
    if (crashPhase === 1) {
      // Next tick, slam to opposite-direction small velocity → big Δv.
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
      // Also lift it a bit so the ragdoll has a moment to extend before
      // hitting the surface.
      const t = rb.translation()
      rb.setTranslation({ x: t.x, y: t.y + 0.5, z: t.z }, true)
      crashPhase = 0
    }
    void dt
  }

  function updateHud() {
    const rider = (() => {
      // Walk RiderStore for our bike. Cheap — one entry in calibration.
      let r: ReturnType<typeof RiderStore.must> | null = null
      RiderStore.forEach((data) => {
        if (data.bikeEid === bikeEid) r = data
      })
      return r
    })() as ReturnType<typeof RiderStore.must> | null
    if (!rider) {
      hudEl.textContent = 'Rider not spawned yet'
      return
    }
    const p = rider.poseResponse
    const stateLabel =
      rider.state === 'attached' ? 'ATTACHED' : `LAUNCHED (${rider.stateAge.toFixed(2)}s)`
    const turbLabel = turbulence.toUpperCase()
    const rb = phys.world.getRigidBody(bikeRbHandle)
    const vy = rb ? rb.linvel().y : 0
    const yawRate = rb ? rb.angvel().y : 0
    const intentLabel =
      `thr=${intent.throttle.toFixed(2)} brk=${intent.brake.toFixed(2)} ` +
      `steer=${intent.steer.toFixed(2)}`
    hudEl.innerHTML = `
      <div style="font-weight:600;color:#7cf;font-size:13px;margin-bottom:6px">RIDER CALIBRATION</div>
      <div><span style="color:#888">state    </span>${stateLabel}</div>
      <div><span style="color:#888">turbulence</span> ${turbLabel}</div>
      <div><span style="color:#888">bike vy  </span>${vy.toFixed(2)} m/s</div>
      <div><span style="color:#888">yaw rate </span>${yawRate.toFixed(2)} rad/s</div>
      <div><span style="color:#888">intent   </span>${intentLabel}</div>
      <div style="margin-top:6px;color:#aaa;font-weight:600">pose response</div>
      <div><span style="color:#888">bouncePitch</span> ${p.bouncePitch.toFixed(3)} rad (vel ${p.bouncePitchVel.toFixed(3)})</div>
      <div><span style="color:#888">flowYaw   </span>${p.flowYaw.toFixed(3)} rad</div>
      <div><span style="color:#888">headYaw   </span>${p.headYaw.toFixed(3)} rad</div>
      <div><span style="color:#888">headPitch </span>${p.headPitch.toFixed(3)} rad</div>
      <div style="margin-top:8px;color:#7cf;font-size:11px">
        R reset · Space cycle turb · 0/1/2/3 turb level<br>
        C crash · I/K thr/brk · J/L steer
      </div>
    `
  }

  function frame(now: number) {
    if (disposed) return
    const dt = Math.min((now - last) / 1000, 1 / 15)
    last = now

    pumpIntent(dt)
    injectCrashSwing(dt)

    physAccum += dt
    while (physAccum >= phys.fixedDt) {
      // Apply turbulence at the same cadence as physics ticks — looks more
      // natural than firing once per render frame.
      applyTurbulence(phys.fixedDt)
      simulateStep(sim, phys, waveField, track, raceTick, {
        peerInputs,
        locked: false,
        autoPlay: false,
        waveTimeScale: waterMesh.debug.getTimeScale(),
        runAI: false,
      })
      physAccum -= phys.fixedDt
    }

    // Read player bike pose for the orbit camera.
    const t = TransformStore.get(bikeEid)
    if (t) {
      camAngle += dt * 0.18
      camera.position.set(
        t.x + Math.sin(camAngle) * camRadius,
        t.y + camHeight,
        t.z + Math.cos(camAngle) * camRadius,
      )
      camera.lookAt(t.x, t.y + 0.6, t.z)
    }

    waterMesh.tick([], { x: camera.position.x, z: camera.position.z })
    sky.tick(waveField.time, dt, { x: camera.position.x, z: camera.position.z })
    updateUnderwaterFog(
      scene,
      camera.position.y,
      sampleHeight(waveField, camera.position.x, camera.position.z),
    )
    bikeRender()
    riderRender()
    pickupRender(dt)
    combatRender(dt)
    fxTick(dt)
    renderer.render(scene, camera)
    updateHud()

    rafHandle = requestAnimationFrame(frame)
  }
  rafHandle = requestAnimationFrame(frame)
  hideLoadingScreen()

  // Tag the player entity (defensive — createBike already added PlayerTag
  // when isPlayer=true, but keeping this explicit removes any boot-order
  // surprise for downstream systems that key off PlayerTag).
  void PlayerTag
  void RIDER_BONE_NAMES // referenced for IDE find-all-refs convenience
  void Rider
  void RIDER_POSE_TUNING

  return {
    dispose() {
      disposed = true
      cancelAnimationFrame(rafHandle)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      hudEl.remove()
      tunerEl.remove()
      try {
        disposeRenderer()
      } catch (err) {
        console.warn('[calibration] teardown:', err)
      }
    },
  }
}
