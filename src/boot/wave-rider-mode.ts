/**
 * Wave-rider validation scene — water, lights, a row of buoys + logs,
 * and a WASD-driven probe ball you can ram into them. No track, no
 * bike, no AI, no race.
 *
 * Triggered by `?waveriders=1`. The point is to validate the
 * kinematic-buoyancy + spring-perturbation system in isolation before
 * we wire it into real tracks.
 *
 * Controls:
 *   W/A/S/D — drive the probe ball horizontally (world-frame)
 *   Shift   — sprint
 *   Space   — hop (vertical impulse)
 *   R       — recentre the probe
 *   1 / 2   — spawn a new buoy / log at the probe's position
 *   H       — orbit-cam toggle (default: chase the probe)
 *   ←/→     — orbit angle when in orbit-cam
 */

import * as THREE from 'three'
import { createCombatRenderSystem } from '@/engine/render/combat-render'
import { createFxSystem } from '@/engine/render/fx'
import { createRenderer } from '@/engine/render/renderer'
import { renderFrame } from '@/engine/render/renderer-service'
import { createScene } from '@/engine/render/scene'
import { createSkySystem } from '@/engine/render/sky'
import { createWaterMesh, updateUnderwaterFog } from '@/engine/render/water'
import { createWaveRiderRenderSystem } from '@/engine/render/wave-rider-render'
import { createSimWorld } from '@/engine/sim/ecs/world'
import { createPhysicsWorld } from '@/engine/sim/physics/rapier'
import {
  advanceWaveField,
  createWaveField,
  defaultWaves,
  sampleHeight,
} from '@/engine/sim/water/wave-field'
import { applyStoredWaterTuning } from '@/engine/water-debug-storage'
import {
  WAVE_RIDER_TUNING,
  type WaveRiderArchetypeId,
  WaveRiderStore,
} from '@/game/components/wave-rider'
import { createWaveRider } from '@/game/entities/wave-rider'
import { createWaveRiderSystem } from '@/game/systems/wave-rider'
import { hideLoadingScreen, setLoadingMessage } from './loading-screen'

export type WaveRiderModeHandle = {
  dispose(): void
}

/** Initial buoys / logs to spawn around the probe. */
const INITIAL_SPAWNS: Array<{
  archetype: WaveRiderArchetypeId
  x: number
  z: number
  yaw?: number
}> = [
  { archetype: 'buoy', x: -6, z: -4 },
  { archetype: 'buoy', x: -2, z: -4 },
  { archetype: 'buoy', x: 2, z: -4 },
  { archetype: 'buoy', x: 6, z: -4 },
  { archetype: 'log', x: -4, z: 4, yaw: 0.3 },
  { archetype: 'log', x: 0, z: 5, yaw: -0.2 },
  { archetype: 'log', x: 4, z: 4, yaw: 0.6 },
]

const PROBE_RADIUS = 0.6
const PROBE_DRIVE_FORCE = 60
const PROBE_DRIVE_FORCE_SPRINT = 130
const PROBE_HOP_IMPULSE = 7
const PROBE_MAX_SPEED = 14
/** Where the probe's centre sits relative to the wave surface at rest. */
const PROBE_FLOAT_OFFSET = 0.4
/** Buoyancy spring stiffness (1/s²) on submerged depth. */
const PROBE_BUOY_K = 90
/** Vertical drag for the wave-following spring (1/s). */
const PROBE_BUOY_DAMP = 6

export async function bootWaveRiderMode(appEl: HTMLElement): Promise<WaveRiderModeHandle> {
  setLoadingMessage('Loading wave-rider validation scene…')

  const { renderer, backend, canvas, dispose: disposeRenderer } = await createRenderer(appEl)
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'

  const { scene, camera, sun, hemi } = createScene()
  // Push the fog out a bit further than the default — there's no track
  // geometry in this scene to hide the seam, so a softer fade looks
  // less abrupt against the open horizon.
  scene.fog = new THREE.Fog(0xa6c4e2, 200, 1600)

  const phys = await createPhysicsWorld()
  const sim = createSimWorld()

  const waveField = createWaveField(defaultWaves())
  const waterMesh = createWaterMesh(waveField, { backend })
  scene.add(waterMesh.mesh)
  applyStoredWaterTuning(waterMesh)

  const sky = createSkySystem({
    scene,
    renderer,
    camera,
    sun,
    hemi,
    water: waterMesh,
  })

  const waveRiderSys = createWaveRiderSystem(sim, phys, waveField)
  const waveRiderRender = createWaveRiderRenderSystem(scene, sim)

  // Spawn the initial set.
  for (const s of INITIAL_SPAWNS) {
    createWaveRider(sim, phys, {
      position: { x: s.x, y: 0, z: s.z },
      archetype: s.archetype,
      ...(s.yaw !== undefined ? { yaw: s.yaw } : {}),
    })
  }

  // ---- Probe ball (dynamic body, WASD-driven) -----------------------
  // Gravity scale 0: the probe rides the wave surface via the spring in
  // `driveProbe` instead of fighting gravity. There's no track collider
  // in this scene to land on, so gravity would just sink the probe past
  // the buoy field before the player can ram them.
  const probeRbDesc = phys.rapier.RigidBodyDesc.dynamic()
    .setTranslation(0, 1, 0)
    .setLinearDamping(0.6)
    .setAngularDamping(0.4)
    .setGravityScale(0)
  const probeRb = phys.world.createRigidBody(probeRbDesc)
  const probeColDesc = phys.rapier.ColliderDesc.ball(PROBE_RADIUS)
    .setRestitution(0.35)
    .setFriction(0.4)
    .setDensity(1.2)
  phys.world.createCollider(probeColDesc, probeRb)
  const probeMesh = new THREE.Mesh(
    new THREE.SphereGeometry(PROBE_RADIUS, 22, 16),
    new THREE.MeshStandardMaterial({
      color: 0x33ddff,
      emissive: 0x114455,
      emissiveIntensity: 0.6,
      roughness: 0.3,
      metalness: 0.1,
    }),
  )
  probeMesh.castShadow = true
  scene.add(probeMesh)

  // Hit detection: each step, for each wave-rider, check if the probe
  // is touching it (centre-to-centre distance < sum of radii). On first
  // contact, build an impulse from the probe's velocity along the
  // contact direction and kick the spring. A `lastHit` map suppresses
  // repeat hits while still in contact — fires once per approach.
  const lastHitTick = new Map<number, number>()
  let tickCounter = 0

  function detectAndApplyHits() {
    tickCounter += 1
    const probePos = probeRb.translation()
    const probeVel = probeRb.linvel()
    WaveRiderStore.forEach((wr, eid) => {
      // Cylinder collider half-extents (matches entities/wave-rider.ts).
      const tuning = wr.tuning
      const halfH = wr.archetype === 'buoy' ? 0.45 : 1.2
      const radius = wr.archetype === 'buoy' ? 0.4 : 0.3
      // Approx test: horizontal distance vs (radius + probe), vertical
      // distance vs (halfH + probe). Good enough for a contact pulse.
      const surfaceY = sampleHeight(waveField, wr.anchorX, wr.anchorZ)
      const bodyY = surfaceY + tuning.floatOffsetY + wr.perturbY
      const dx = probePos.x - wr.anchorX
      const dz = probePos.z - wr.anchorZ
      const dy = probePos.y - bodyY
      const horiz = Math.hypot(dx, dz)
      const touching = horiz < radius + PROBE_RADIUS && Math.abs(dy) < halfH + PROBE_RADIUS
      if (!touching) return
      const last = lastHitTick.get(eid) ?? -100
      if (tickCounter - last < 6) return // ~0.1s debounce
      lastHitTick.set(eid, tickCounter)
      // Impulse magnitude scaled by probe's speed toward the buoy.
      // Project probe velocity onto the contact direction (probe → buoy
      // is the direction the buoy gets pushed).
      const cx = -dx
      const cz = -dz
      const cLen = Math.hypot(cx, cz)
      if (cLen < 1e-3) return
      const nx = cx / cLen
      const nz = cz / cLen
      const approach = -(probeVel.x * nx + probeVel.z * nz)
      const speed = Math.max(0, approach)
      const horizMag = Math.min(6, speed * 0.5)
      const vertMag = Math.min(3, Math.abs(probeVel.y) * 0.4)
      waveRiderSys.applyHit(eid, {
        x: -nx * horizMag,
        y: probeVel.y < 0 ? -vertMag : vertMag * 0.3,
        z: -nz * horizMag,
      })
    })
  }

  // ---- Keyboard input -----------------------------------------------
  const keyDown = new Set<string>()
  function onKeyDown(e: KeyboardEvent) {
    keyDown.add(e.code)
    if (e.code === 'KeyR') {
      probeRb.setTranslation({ x: 0, y: 2, z: 0 }, true)
      probeRb.setLinvel({ x: 0, y: 0, z: 0 }, true)
    } else if (e.code === 'Digit1') {
      spawnAtProbe('buoy')
    } else if (e.code === 'Digit2') {
      spawnAtProbe('log')
    } else if (e.code === 'KeyH') {
      orbitMode = !orbitMode
    } else if (e.code === 'Space') {
      probeRb.applyImpulse({ x: 0, y: PROBE_HOP_IMPULSE, z: 0 }, true)
      e.preventDefault()
    }
  }
  function onKeyUp(e: KeyboardEvent) {
    keyDown.delete(e.code)
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)

  function spawnAtProbe(archetype: WaveRiderArchetypeId) {
    const p = probeRb.translation()
    createWaveRider(sim, phys, {
      position: { x: p.x, y: 0, z: p.z + 2 },
      archetype,
      yaw: Math.random() * Math.PI * 2,
    })
  }

  function driveProbe(dt: number) {
    const sprint = keyDown.has('ShiftLeft') || keyDown.has('ShiftRight')
    const force = sprint ? PROBE_DRIVE_FORCE_SPRINT : PROBE_DRIVE_FORCE
    let fx = 0
    let fz = 0
    if (keyDown.has('KeyW')) fz -= 1
    if (keyDown.has('KeyS')) fz += 1
    if (keyDown.has('KeyA')) fx -= 1
    if (keyDown.has('KeyD')) fx += 1
    const mag = Math.hypot(fx, fz)
    if (mag > 0) {
      fx = (fx / mag) * force
      fz = (fz / mag) * force
      probeRb.applyImpulse({ x: fx, y: 0, z: fz }, true)
    }
    // Wave-following spring — probe rides the surface like a buoy. Gravity
    // is disabled on the probe (gravityScale=0), so this spring is the
    // only thing setting its vertical motion until the player hops or
    // bumps into something.
    const p = probeRb.translation()
    const v = probeRb.linvel()
    const surfaceY = sampleHeight(waveField, p.x, p.z)
    const restY = surfaceY + PROBE_FLOAT_OFFSET
    const springAcc = PROBE_BUOY_K * (restY - p.y) - PROBE_BUOY_DAMP * v.y
    probeRb.applyImpulse({ x: 0, y: springAcc * dt, z: 0 }, true)
    // Speed cap to prevent the probe from rocketing off into the fog.
    const v2 = probeRb.linvel()
    const sp = Math.hypot(v2.x, v2.z)
    if (sp > PROBE_MAX_SPEED) {
      const k = PROBE_MAX_SPEED / sp
      probeRb.setLinvel({ x: v2.x * k, y: v2.y, z: v2.z * k }, true)
    }
  }

  // ---- Camera --------------------------------------------------------
  let orbitMode = false
  let orbitAngle = 0
  const camHeight = 6
  const camDist = 11
  function updateCamera(dt: number) {
    const p = probeRb.translation()
    if (orbitMode) {
      if (keyDown.has('ArrowLeft')) orbitAngle -= dt * 1.5
      if (keyDown.has('ArrowRight')) orbitAngle += dt * 1.5
      orbitAngle += dt * 0.15
      camera.position.set(
        p.x + Math.sin(orbitAngle) * camDist,
        p.y + camHeight,
        p.z + Math.cos(orbitAngle) * camDist,
      )
      camera.lookAt(p.x, p.y, p.z)
    } else {
      // Chase: behind +Z relative to probe. Static, lets the player drive
      // around the buoy field without camera-induced disorientation.
      const target = new THREE.Vector3(p.x, p.y + camHeight * 0.5, p.z + camDist)
      camera.position.lerp(target, 1 - Math.exp(-dt * 4))
      camera.lookAt(p.x, p.y, p.z)
    }
  }

  // ---- HUD -----------------------------------------------------------
  const hudEl = document.createElement('div')
  hudEl.id = 'waverider-hud'
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

  // ---- Tuner panel ---------------------------------------------------
  // Mutates the global archetype tuning table — every wave-rider of
  // that archetype picks it up on the next step (each entity's
  // `tuning` field references a fresh clone of the table at spawn time
  // intentionally NOT — let me revisit; if we want live tuning across
  // existing entities we should reference the global directly).
  //
  // For simplicity the panel mutates each entity's per-instance tuning
  // copy on every change. Slow path but the entity count is tiny here.
  const tunerEl = document.createElement('div')
  tunerEl.id = 'waverider-tuner'
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
    width: 270px;
    line-height: 1.4;
    max-height: calc(100vh - 24px);
    overflow-y: auto;
  `
  document.body.appendChild(tunerEl)

  type TuningKey = keyof typeof WAVE_RIDER_TUNING.buoy
  type SliderSpec = {
    label: string
    min: number
    max: number
    step: number
    key: TuningKey
  }
  const SLIDERS: SliderSpec[] = [
    { label: 'floatOffsetY', min: -0.5, max: 1.5, step: 0.02, key: 'floatOffsetY' },
    { label: 'normalFollow', min: 0, max: 1.5, step: 0.02, key: 'normalFollow' },
    { label: 'springK', min: 1, max: 80, step: 1, key: 'springK' },
    { label: 'springDamping', min: 0, max: 15, step: 0.1, key: 'springDamping' },
    { label: 'tiltK', min: 1, max: 60, step: 1, key: 'tiltK' },
    { label: 'tiltDamping', min: 0, max: 10, step: 0.1, key: 'tiltDamping' },
    { label: 'yawDriftRate', min: -1, max: 1, step: 0.01, key: 'yawDriftRate' },
  ]

  function buildTunerSection(archetype: WaveRiderArchetypeId) {
    const h = document.createElement('div')
    h.style.cssText = 'color:#7cf;font-weight:600;margin-top:10px;margin-bottom:4px'
    h.textContent = archetype.toUpperCase()
    tunerEl.appendChild(h)
    for (const s of SLIDERS) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0'
      const label = document.createElement('span')
      label.style.cssText = 'width:110px;color:#bbb;font-size:10px'
      label.textContent = s.label
      const input = document.createElement('input')
      input.type = 'range'
      input.min = String(s.min)
      input.max = String(s.max)
      input.step = String(s.step)
      input.value = String(WAVE_RIDER_TUNING[archetype][s.key])
      input.style.cssText = 'flex:1;cursor:pointer'
      const val = document.createElement('span')
      val.style.cssText =
        'width:46px;text-align:right;color:#7cf;font-size:10px;font-variant-numeric:tabular-nums'
      const fmt = (v: number) =>
        s.step >= 1 ? v.toFixed(0) : s.step >= 0.01 ? v.toFixed(2) : v.toFixed(3)
      val.textContent = fmt(WAVE_RIDER_TUNING[archetype][s.key])
      input.addEventListener('input', () => {
        const v = Number(input.value)
        WAVE_RIDER_TUNING[archetype][s.key] = v
        // Propagate to live entities of this archetype.
        WaveRiderStore.forEach((wr) => {
          if (wr.archetype === archetype) wr.tuning[s.key] = v
        })
        val.textContent = fmt(v)
      })
      row.appendChild(label)
      row.appendChild(input)
      row.appendChild(val)
      tunerEl.appendChild(row)
    }
  }
  const header = document.createElement('div')
  header.style.cssText = 'font-weight:600;color:#7cf;font-size:12px'
  header.textContent = 'WAVE-RIDER TUNING'
  tunerEl.appendChild(header)
  buildTunerSection('buoy')
  buildTunerSection('log')

  function updateHud() {
    const probePos = probeRb.translation()
    const probeVel = probeRb.linvel()
    const speed = Math.hypot(probeVel.x, probeVel.z)
    const surfaceY = sampleHeight(waveField, probePos.x, probePos.z)
    let buoyCount = 0
    let logCount = 0
    WaveRiderStore.forEach((wr) => {
      if (wr.archetype === 'buoy') buoyCount++
      else logCount++
    })
    hudEl.innerHTML = `
      <div style="font-weight:600;color:#7cf;font-size:13px;margin-bottom:6px">WAVE-RIDER VALIDATION</div>
      <div><span style="color:#888">probe pos </span>(${probePos.x.toFixed(1)}, ${probePos.y.toFixed(1)}, ${probePos.z.toFixed(1)})</div>
      <div><span style="color:#888">probe vel </span>${speed.toFixed(2)} m/s (vy ${probeVel.y.toFixed(2)})</div>
      <div><span style="color:#888">surface Y </span>${surfaceY.toFixed(2)} m</div>
      <div><span style="color:#888">buoys     </span>${buoyCount}</div>
      <div><span style="color:#888">logs      </span>${logCount}</div>
      <div><span style="color:#888">camera    </span>${orbitMode ? 'ORBIT' : 'CHASE'}</div>
      <div style="margin-top:8px;color:#7cf;font-size:11px">
        WASD drive · Shift sprint · Space hop · R reset<br>
        1 spawn buoy · 2 spawn log · H toggle cam · ←/→ orbit
      </div>
    `
  }

  // ---- FX + extra render systems (kept minimal — fxSystem feeds water
  //      splashes if any bike-like impact events fire; we don't drive
  //      it here but keep the call site to match the calibration
  //      shape, so the wake/foam path is exercised. ---------
  const fxTick = createFxSystem(scene, sim, phys, waveField).tick
  const combatRender = createCombatRenderSystem(scene, sim)

  // ---- Frame loop ----------------------------------------------------
  let disposed = false
  let rafHandle = 0
  let last = performance.now()
  let physAccum = 0

  function frame(now: number) {
    if (disposed) return
    const dt = Math.min((now - last) / 1000, 1 / 15)
    last = now

    physAccum += dt
    while (physAccum >= phys.fixedDt) {
      driveProbe(phys.fixedDt)
      advanceWaveField(waveField, phys.fixedDt * waterMesh.debug.getTimeScale())
      waveRiderSys.step(phys.fixedDt)
      detectAndApplyHits()
      phys.step()
      physAccum -= phys.fixedDt
    }

    // Sync the probe visual from the dynamic body.
    const pp = probeRb.translation()
    probeMesh.position.set(pp.x, pp.y, pp.z)
    const pq = probeRb.rotation()
    probeMesh.quaternion.set(pq.x, pq.y, pq.z, pq.w)

    updateCamera(dt)

    waterMesh.tick([], { x: camera.position.x, z: camera.position.z })
    sky.tick(waveField.time, dt, { x: camera.position.x, z: camera.position.z })
    updateUnderwaterFog(
      scene,
      camera.position.y,
      sampleHeight(waveField, camera.position.x, camera.position.z),
    )
    waveRiderRender.render()
    combatRender(dt)
    fxTick(dt)
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
      window.removeEventListener('keyup', onKeyUp)
      hudEl.remove()
      tunerEl.remove()
      waveRiderRender.dispose()
      try {
        disposeRenderer()
      } catch (err) {
        console.warn('[waverider] teardown:', err)
      }
    },
  }
}
