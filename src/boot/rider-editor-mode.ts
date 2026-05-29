/**
 * Rider editor — one bike + one rider, no race, no AI.
 *
 * Purpose: redesign the rider's look + seated pose without driving through a
 * track. Three things are editable, each previewed live on the spawned rider:
 *
 *   1. **Geometric primitive** per bone (capsule / box / sphere / cylinder /
 *      cone) — mutates `RIDER_APPEARANCE`, which the rider render system reads.
 *   2. **Colour** per bone — explicit colour, or "auto" to fall back to the
 *      per-rider tint.
 *   3. **Seated pose** — the rest-pose joint angles + seat anchor that decide
 *      how the rider sits on the bike. These bind to `RIDER_POSE_TUNING`, the
 *      same object the in-game pose system reads, so the rider re-poses with
 *      no respawn.
 *
 * The bike hovers in place at the start gate (no turbulence, no input) so the
 * rider holds a clean static pose while the camera orbits by drag. "Load
 * existing rider" resets everything to the shipped defaults; "Save" persists
 * the design to localStorage; "Export JSON" downloads it.
 *
 * Triggered by `?rideredit=1` (see url-modes.ts dispatch). Self-contained boot
 * — no menu flow, no race state. Loads the lagoon track only for the ground
 * surface the bike hovers over. Sibling of the calibration scene
 * (`calibration-mode.ts`), which tunes the reactive (in-motion) pose response.
 */

import { emptyIntent } from '@/engine/input/intent'
import { createBikeRenderSystem } from '@/engine/render/render-systems'
import { createRenderer } from '@/engine/render/renderer'
import { renderFrame } from '@/engine/render/renderer-service'
import {
  bumpRiderAppearance,
  exportRiderAppearanceJSON,
  loadStoredRiderAppearance,
  persistRiderAppearance,
  RIDER_APPEARANCE,
  RIDER_PRIMITIVES,
  resetRiderAppearance,
} from '@/engine/render/rider-appearance'
import { createRiderRenderSystem } from '@/engine/render/rider-systems'
import { createScene } from '@/engine/render/scene'
import { createSkySystem } from '@/engine/render/sky'
import { createTrackVisuals } from '@/engine/render/track-mesh'
import { createWaterMesh, updateUnderwaterFog } from '@/engine/render/water'
import { createSimWorld } from '@/engine/sim/ecs/world'
import { createPhysicsWorld } from '@/engine/sim/physics/rapier'
import {
  createWaveField,
  defaultWaves,
  sampleHeight,
  setShoreField,
} from '@/engine/sim/water/wave-field'
import { applyStoredWaterTuning } from '@/engine/water-debug-storage'
import { loadBike } from '@/game/assets/bike-loader'
import { resolveBikeVariant } from '@/game/bikes/variants'
import { ControlIntentStore, RBHandleStore, TransformStore } from '@/game/components'
import { RIDER_BONE_NAMES } from '@/game/components/rider'
import { createBike } from '@/game/entities/bike'
import { createRider } from '@/game/entities/rider'
import { simulateStep } from '@/game/sim-step'
import { RIDER_POSE_TUNING, resetRiderForBike } from '@/game/systems/rider-pose'
import { hideLoadingScreen, setLoadingMessage } from './loading-screen'
import { loadTrackForBoot } from './track-loader'

/** Fallback colour shown in a bone's colour swatch when it's set to "auto".
 *  Matches the rider render system's first per-rider colour so the swatch
 *  reflects what the single editor rider actually renders as. */
const PREVIEW_RIDER_COLOR = 0x2233aa

const RIDER_POSE_STORAGE_KEY = 'hoverbike.riderPose.v1'

type RestAngles = typeof RIDER_POSE_TUNING.restAngles
type RestAngleKey = keyof RestAngles

/** Serialize the editable seated pose (seat anchor + rotation + rest angles
 *  + IK pole bend directions). */
function serializePose() {
  const s = RIDER_POSE_TUNING.seatLocal
  const ap = RIDER_POSE_TUNING.armPole
  const lp = RIDER_POSE_TUNING.legPole
  return {
    seatLocal: { x: s.x, y: s.y, z: s.z },
    seatRot: { ...RIDER_POSE_TUNING.seatRot },
    restAngles: { ...RIDER_POSE_TUNING.restAngles },
    armPole: { x: ap.x, y: ap.y, z: ap.z },
    legPole: { x: lp.x, y: lp.y, z: lp.z },
  }
}

function persistPose(): void {
  try {
    window.localStorage.setItem(RIDER_POSE_STORAGE_KEY, JSON.stringify(serializePose()))
  } catch {
    // ignore — pose still applies for this session.
  }
}

function loadStoredPose(): void {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(RIDER_POSE_STORAGE_KEY)
  } catch {
    return
  }
  if (!raw) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  const p = parsed as Record<string, unknown>
  const loadVec = (src: unknown, dst: { x: number; y: number; z: number }) => {
    if (!src || typeof src !== 'object') return
    const o = src as Record<string, unknown>
    for (const axis of ['x', 'y', 'z'] as const) {
      const v = o[axis]
      if (typeof v === 'number' && Number.isFinite(v)) dst[axis] = v
    }
  }
  loadVec(p.seatLocal, RIDER_POSE_TUNING.seatLocal)
  loadVec(p.armPole, RIDER_POSE_TUNING.armPole)
  loadVec(p.legPole, RIDER_POSE_TUNING.legPole)
  if (p.seatRot && typeof p.seatRot === 'object') {
    const sr = p.seatRot as Record<string, unknown>
    for (const key of ['pitch', 'yaw', 'roll'] as const) {
      const v = sr[key]
      if (typeof v === 'number' && Number.isFinite(v)) RIDER_POSE_TUNING.seatRot[key] = v
    }
  }
  if (p.restAngles && typeof p.restAngles === 'object') {
    const ra = p.restAngles as Record<string, unknown>
    for (const key of Object.keys(RIDER_POSE_TUNING.restAngles) as RestAngleKey[]) {
      const v = ra[key]
      if (typeof v === 'number' && Number.isFinite(v)) RIDER_POSE_TUNING.restAngles[key] = v
    }
  }
}

function intToHex(c: number): string {
  return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`
}
function hexToInt(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16) & 0xffffff
}

export type RiderEditorHandle = {
  dispose(): void
}

export async function bootRiderEditorMode(appEl: HTMLElement): Promise<RiderEditorHandle> {
  setLoadingMessage('Loading rider editor…')

  // Snapshot the shipped pose BEFORE loading any saved overrides so "Load
  // existing rider" has the true source defaults to restore to.
  const DEFAULT_SEAT = { ...RIDER_POSE_TUNING.seatLocal }
  const DEFAULT_SEAT_ROT = { ...RIDER_POSE_TUNING.seatRot }
  const DEFAULT_REST_ANGLES = { ...RIDER_POSE_TUNING.restAngles }
  const DEFAULT_ARM_POLE = { ...RIDER_POSE_TUNING.armPole }
  const DEFAULT_LEG_POLE = { ...RIDER_POSE_TUNING.legPole }

  // Restore the last saved design (no-op on a fresh browser — defaults are
  // already in place, which reproduces the shipped rider exactly).
  loadStoredRiderAppearance()
  loadStoredPose()

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
  setShoreField(waveField, terrainHeightmap?.shoreField ?? null)

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

  // One bike + rider at the start gate.
  const racerVariant = resolveBikeVariant('racer')
  const racerBikeGlb = await loadBike('/assets/bikes/racer.glb')
  const bikePos = {
    x: track.start.position.x,
    y: track.start.position.y,
    z: track.start.position.z,
  }
  const halfStartYaw = track.start.yaw / 2
  const startQuat = { x: 0, y: Math.sin(halfStartYaw), z: 0, w: Math.cos(halfStartYaw) }
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
  if (!handleEntry) throw new Error('rider-editor: bike RB missing post-spawn')
  const bikeRbHandle = handleEntry.handle
  createRider(sim, phys, { bikeEid, bikeRbHandle, bikePos, bikeRot: startQuat })

  const bikeRender = createBikeRenderSystem(scene, sim, {
    byVariantId: { racer: racerBikeGlb },
    default: racerBikeGlb,
  })
  const riderRender = createRiderRenderSystem(scene, sim)

  // ---- Orbit camera (drag to rotate, wheel to zoom) -----------------
  let camYaw = track.start.yaw + Math.PI
  let camPitch = 0.32
  let camRadius = 5.5
  const camTargetY = 1.1
  let dragging = false
  let lastPx = 0
  let lastPy = 0
  function onPointerDown(e: PointerEvent) {
    dragging = true
    lastPx = e.clientX
    lastPy = e.clientY
    canvas.setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return
    camYaw -= (e.clientX - lastPx) * 0.01
    camPitch = Math.max(-0.4, Math.min(1.3, camPitch + (e.clientY - lastPy) * 0.01))
    lastPx = e.clientX
    lastPy = e.clientY
  }
  function onPointerUp(e: PointerEvent) {
    dragging = false
    try {
      canvas.releasePointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault()
    camRadius = Math.max(2.5, Math.min(14, camRadius + e.deltaY * 0.01))
  }
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })

  const intent = emptyIntent()

  // ---- Appearance panel (left) --------------------------------------
  const appearanceEl = document.createElement('div')
  appearanceEl.id = 'rider-editor-appearance'
  appearanceEl.style.cssText = panelCss('left')
  document.body.appendChild(appearanceEl)

  function buildAppearancePanel(): void {
    appearanceEl.innerHTML = ''
    const header = document.createElement('div')
    header.style.cssText = headerCss
    header.textContent = 'RIDER · BODY PARTS'
    appearanceEl.appendChild(header)

    const hint = document.createElement('div')
    hint.style.cssText = 'color:#888;font-size:10px;margin-bottom:8px'
    hint.textContent = 'primitive + colour per bone · "auto" uses the rider tint'
    appearanceEl.appendChild(hint)

    for (const name of RIDER_BONE_NAMES) {
      const app = RIDER_APPEARANCE.bones[name]
      const block = document.createElement('div')
      block.style.cssText =
        'margin:4px 0;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,0.06)'
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:5px'

      const label = document.createElement('span')
      label.style.cssText = 'width:78px;color:#bbb;font-size:10px'
      label.textContent = name
      row.appendChild(label)

      const select = document.createElement('select')
      select.style.cssText =
        'flex:1;background:#1a2332;color:#cfe;border:1px solid #345;border-radius:3px;font-family:inherit;font-size:10px;padding:2px'
      for (const prim of RIDER_PRIMITIVES) {
        const opt = document.createElement('option')
        opt.value = prim
        opt.textContent = prim
        if (prim === app.primitive) opt.selected = true
        select.appendChild(opt)
      }
      select.addEventListener('change', () => {
        app.primitive = select.value as (typeof RIDER_PRIMITIVES)[number]
        bumpRiderAppearance()
      })
      row.appendChild(select)

      const color = document.createElement('input')
      color.type = 'color'
      color.style.cssText =
        'width:28px;height:20px;padding:0;border:none;background:none;cursor:pointer'
      color.value = intToHex(app.color ?? PREVIEW_RIDER_COLOR)
      row.appendChild(color)

      const autoWrap = document.createElement('label')
      autoWrap.style.cssText =
        'display:flex;align-items:center;gap:2px;color:#999;font-size:9px;cursor:pointer'
      const auto = document.createElement('input')
      auto.type = 'checkbox'
      auto.checked = app.color === null
      auto.style.cssText = 'cursor:pointer'
      autoWrap.appendChild(auto)
      autoWrap.appendChild(document.createTextNode('auto'))
      row.appendChild(autoWrap)

      color.addEventListener('input', () => {
        app.color = hexToInt(color.value)
        auto.checked = false
        bumpRiderAppearance()
      })
      auto.addEventListener('change', () => {
        app.color = auto.checked ? null : hexToInt(color.value)
        bumpRiderAppearance()
      })

      block.appendChild(row)

      // Visual size — per-axis (W/H/D) multipliers. Render-only.
      const sizeRow = document.createElement('div')
      sizeRow.style.cssText =
        'display:flex;align-items:center;gap:4px;margin-top:3px;padding-left:78px'
      const sizeLabel = document.createElement('span')
      sizeLabel.style.cssText = 'color:#789;font-size:9px'
      sizeLabel.textContent = 'size'
      sizeRow.appendChild(sizeLabel)
      for (const axis of ['x', 'y', 'z'] as const) {
        const wrap = document.createElement('label')
        wrap.style.cssText = 'display:flex;align-items:center;gap:2px;color:#789;font-size:9px'
        wrap.appendChild(document.createTextNode(axis === 'x' ? 'W' : axis === 'y' ? 'H' : 'D'))
        const num = document.createElement('input')
        num.type = 'number'
        num.min = '0.1'
        num.max = '5'
        num.step = '0.05'
        num.value = String(app.scale[axis])
        num.style.cssText =
          'width:42px;background:#1a2332;color:#cfe;border:1px solid #345;border-radius:3px;font-family:inherit;font-size:9px;padding:1px 2px'
        num.addEventListener('input', () => {
          const v = Number(num.value)
          if (Number.isFinite(v) && v > 0) {
            app.scale[axis] = v
            bumpRiderAppearance()
          }
        })
        wrap.appendChild(num)
        sizeRow.appendChild(wrap)
      }
      block.appendChild(sizeRow)

      appearanceEl.appendChild(block)
    }

    // Action buttons.
    const actions = document.createElement('div')
    actions.style.cssText = 'margin-top:12px;display:flex;flex-direction:column;gap:6px'

    actions.appendChild(
      makeButton('Load existing rider', () => {
        resetRiderAppearance()
        Object.assign(RIDER_POSE_TUNING.seatLocal, DEFAULT_SEAT)
        Object.assign(RIDER_POSE_TUNING.seatRot, DEFAULT_SEAT_ROT)
        Object.assign(RIDER_POSE_TUNING.restAngles, DEFAULT_REST_ANGLES)
        Object.assign(RIDER_POSE_TUNING.armPole, DEFAULT_ARM_POLE)
        Object.assign(RIDER_POSE_TUNING.legPole, DEFAULT_LEG_POLE)
        resetRiderForBike(sim, phys, bikeEid)
        buildAppearancePanel()
        buildPosePanel()
      }),
    )
    actions.appendChild(
      makeButton('Save design', () => {
        persistRiderAppearance()
        persistPose()
        flashStatus('saved to this browser')
      }),
    )
    actions.appendChild(
      makeButton('Export JSON', () => {
        const payload = JSON.stringify(
          { appearance: JSON.parse(exportRiderAppearanceJSON()), pose: serializePose() },
          null,
          2,
        )
        const blob = new Blob([payload], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'rider-design.json'
        a.click()
        URL.revokeObjectURL(url)
      }),
    )
    appearanceEl.appendChild(actions)

    const status = document.createElement('div')
    status.id = 'rider-editor-status'
    status.style.cssText = 'margin-top:6px;color:#7cf;font-size:10px;min-height:12px'
    appearanceEl.appendChild(status)
  }

  function flashStatus(msg: string): void {
    const status = document.getElementById('rider-editor-status')
    if (!status) return
    status.textContent = msg
    window.setTimeout(() => {
      if (status.textContent === msg) status.textContent = ''
    }, 2000)
  }

  // ---- Pose panel (right) -------------------------------------------
  const poseEl = document.createElement('div')
  poseEl.id = 'rider-editor-pose'
  poseEl.style.cssText = panelCss('right')
  document.body.appendChild(poseEl)

  type SliderSpec = {
    label: string
    min: number
    max: number
    step: number
    get(): number
    set(v: number): void
  }

  function buildPosePanel(): void {
    const ra = RIDER_POSE_TUNING.restAngles
    const sl = RIDER_POSE_TUNING.seatLocal
    const sr = RIDER_POSE_TUNING.seatRot
    const ap = RIDER_POSE_TUNING.armPole
    const lp = RIDER_POSE_TUNING.legPole
    const angle = (label: string, key: RestAngleKey, min: number, max: number): SliderSpec => ({
      label,
      min,
      max,
      step: 1,
      get: () => ra[key],
      set: (v) => {
        ra[key] = v
      },
    })

    const groups: { section: string; specs: SliderSpec[] }[] = [
      {
        section: 'SEAT (bike-local m)',
        specs: [
          {
            label: 'seat X',
            min: -0.3,
            max: 0.3,
            step: 0.01,
            get: () => sl.x,
            set: (v) => {
              sl.x = v
            },
          },
          {
            label: 'seat Y (up)',
            min: 0,
            max: 1.2,
            step: 0.01,
            get: () => sl.y,
            set: (v) => {
              sl.y = v
            },
          },
          {
            label: 'seat Z (fwd)',
            min: -1,
            max: 1,
            step: 0.01,
            get: () => sl.z,
            set: (v) => {
              sl.z = v
            },
          },
        ],
      },
      {
        section: 'SEAT ROTATION (deg)',
        specs: [
          {
            label: 'pitch',
            min: -90,
            max: 90,
            step: 1,
            get: () => sr.pitch,
            set: (v) => {
              sr.pitch = v
            },
          },
          {
            label: 'yaw',
            min: -90,
            max: 90,
            step: 1,
            get: () => sr.yaw,
            set: (v) => {
              sr.yaw = v
            },
          },
          {
            label: 'roll',
            min: -90,
            max: 90,
            step: 1,
            get: () => sr.roll,
            set: (v) => {
              sr.roll = v
            },
          },
        ],
      },
      {
        section: 'SPINE / HEAD (deg)',
        specs: [
          angle('spine lower', 'spine_lower', -30, 60),
          angle('spine upper', 'spine_upper', -30, 60),
          angle('neck', 'neck', -60, 30),
        ],
      },
      {
        section: 'ARMS (deg, R mirrors)',
        specs: [
          angle('shoulder pitch', 'shoulder_pitch', -120, 30),
          angle('shoulder yaw', 'shoulder_yaw', -90, 90),
          angle('shoulder roll', 'shoulder_roll', -30, 60),
          angle('elbow', 'elbow', -120, 90),
        ],
      },
      {
        section: 'LEGS (deg, R mirrors)',
        specs: [
          angle('hip pitch', 'hip_pitch', -120, 30),
          angle('hip yaw', 'hip_yaw', -90, 90),
          angle('hip roll', 'hip_roll', -45, 45),
          angle('knee', 'knee', -30, 120),
        ],
      },
      {
        // IK pole Z (forward/back). Flips which way the elbow / knee folds.
        // Drag negative if the joint bends the wrong way ("backwards").
        section: 'LIMB BEND (fwd ↔ back)',
        specs: [
          {
            label: 'elbow bend',
            min: -1,
            max: 1,
            step: 0.05,
            get: () => ap.z,
            set: (v) => {
              ap.z = v
            },
          },
          {
            label: 'knee bend',
            min: -1,
            max: 1,
            step: 0.05,
            get: () => lp.z,
            set: (v) => {
              lp.z = v
            },
          },
        ],
      },
    ]

    poseEl.innerHTML = ''
    const header = document.createElement('div')
    header.style.cssText = headerCss
    header.textContent = 'RIDER · SEATED POSE'
    poseEl.appendChild(header)

    for (const group of groups) {
      const h = document.createElement('div')
      h.style.cssText = 'color:#aaa;font-weight:600;margin-top:8px;margin-bottom:4px'
      h.textContent = group.section
      poseEl.appendChild(h)
      for (const s of group.specs) {
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0'
        const label = document.createElement('span')
        label.style.cssText = 'width:96px;color:#bbb;font-size:10px'
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
        const fmt = (v: number) => (s.step >= 1 ? v.toFixed(0) : v.toFixed(2))
        val.textContent = fmt(s.get())
        input.addEventListener('input', () => {
          const v = Number(input.value)
          s.set(v)
          val.textContent = fmt(v)
        })
        row.appendChild(label)
        row.appendChild(input)
        row.appendChild(val)
        poseEl.appendChild(row)
      }
    }
  }

  buildAppearancePanel()
  buildPosePanel()

  // ---- Frame loop ---------------------------------------------------
  let disposed = false
  let rafHandle = 0
  let last = performance.now()
  let physAccum = 0
  const peerInputs = new Map<number, ReturnType<typeof emptyIntent>>()
  peerInputs.set(0, intent)
  ControlIntentStore.set(bikeEid, { ...intent })
  const raceTick = () => {
    /* no race in the editor */
  }

  function frame(now: number) {
    if (disposed) return
    const dt = Math.min((now - last) / 1000, 1 / 15)
    last = now

    physAccum += dt
    while (physAccum >= phys.fixedDt) {
      simulateStep(sim, phys, waveField, track, raceTick, {
        peerInputs,
        locked: false,
        autoPlay: false,
        waveTimeScale: waterMesh.debug.getTimeScale(),
        runAI: false,
      })
      physAccum -= phys.fixedDt
    }

    const t = TransformStore.get(bikeEid)
    if (t) {
      const cp = Math.cos(camPitch)
      camera.position.set(
        t.x + Math.sin(camYaw) * camRadius * cp,
        t.y + camTargetY + Math.sin(camPitch) * camRadius,
        t.z + Math.cos(camYaw) * camRadius * cp,
      )
      camera.lookAt(t.x, t.y + camTargetY, t.z)
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
    renderFrame(scene, camera)

    rafHandle = requestAnimationFrame(frame)
  }
  rafHandle = requestAnimationFrame(frame)
  hideLoadingScreen()

  return {
    dispose() {
      disposed = true
      cancelAnimationFrame(rafHandle)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
      appearanceEl.remove()
      poseEl.remove()
      try {
        disposeRenderer()
      } catch (err) {
        console.warn('[rider-editor] teardown:', err)
      }
    },
  }
}

const headerCss = 'font-weight:600;color:#7cf;font-size:12px;margin-bottom:8px'

function panelCss(side: 'left' | 'right'): string {
  return `
    position: fixed;
    top: 12px;
    ${side}: 12px;
    z-index: 100;
    background: rgba(0, 0, 0, 0.78);
    color: #eee;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    padding: 10px 14px;
    border-radius: 6px;
    width: 300px;
    line-height: 1.4;
    max-height: calc(100vh - 24px);
    overflow-y: auto;
  `
}

function makeButton(text: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.textContent = text
  btn.style.cssText =
    'width:100%;background:#2c4060;color:#cfe;border:1px solid #4080a0;padding:6px;cursor:pointer;font-family:inherit;font-size:11px;border-radius:3px'
  btn.addEventListener('click', onClick)
  return btn
}
