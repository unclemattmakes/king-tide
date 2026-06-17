/**
 * Water tune mode — `?watertune=<slug>`.
 *
 * Loads a REAL track's environment (terrain, obstacles, seabed) and its
 * authored water + sky config, with a FREE ORBIT CAMERA and the WATER tuner
 * auto-opened — and NONE of the race machinery (no bikes, AI, countdown, HUD,
 * lap logic, collisions). The point: dial a level's water look in its real
 * context — contact foam has obstacles to bloom around, body absorption has a
 * seabed to read through, the grade matches the track — without fighting a
 * live race for the camera.
 *
 * It's the water lab pointed at a track instead of open ocean. The tuner is
 * TRACK-SCOPED (water-debug-storage), so edits autosave per slug and EXPORT
 * writes this track's `water` block to paste into public/tracks/<slug>.json.
 *
 * Controls:
 *   drag / scroll — orbit camera
 *   Space         — freeze the wave clock (for clean inspection)
 *   T / Shift+T   — step time of day ±20 s around the 0–360 s sky cycle
 *
 * Mirrors race-boot's water/sky setup block; reuses `loadTrackForBoot` for the
 * environment so the geometry, terrain heightmap and shore field are identical
 * to what races see. `editMode:false` is deliberate — editMode SKIPS the env
 * GLB, and we want the geometry; the physics world we create is only there to
 * satisfy the loader (colliders attach to it but nothing ever steps it).
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createRenderer } from '@/engine/render/renderer'
import { renderFrame } from '@/engine/render/renderer-service'
import { createScene } from '@/engine/render/scene'
import { beaufortToAmplitudeScale, createSkySystem } from '@/engine/render/sky'
import { setSkySystem } from '@/engine/render/sky-service'
import { sampleTerrainHeightAtXZ } from '@/engine/render/terrain-heightmap'
import { createWaterMesh, updateUnderwaterFog, WAVE_BEARING_DEFAULT } from '@/engine/render/water'
import {
  collectWaterContacts,
  gatePostWaterContacts,
  type WaterContact,
} from '@/engine/render/water-contacts'
import { setWaterMesh } from '@/engine/render/water-service'
import { createPhysicsWorld } from '@/engine/sim/physics/rapier'
import { generateSpectrumWaves } from '@/engine/sim/water/spectrum'
import {
  advanceWaveField,
  createWaveField,
  defaultWaves,
  sampleHeight,
  setShoreField,
  setWaveStamps,
  setWaveZones,
} from '@/engine/sim/water/wave-field'
import { installWaterDebugMenu } from '@/engine/water-debug-menu'
import {
  applyLookOverrides,
  applyWaterSettings,
  defaultsToSettings,
  loadTrackOverrides,
  setWaterTuningScope,
} from '@/engine/water-debug-storage'
import { hideLoadingScreen, setLoadingMessage } from './loading-screen'
import { loadTrackForBoot } from './track-loader'

export type WaterTuneModeHandle = {
  dispose(): void
}

export async function bootWaterTuneMode(
  appEl: HTMLElement,
  trackId: string,
): Promise<WaterTuneModeHandle> {
  setLoadingMessage(`Loading water tune · ${trackId}…`)

  const { renderer, backend, canvas, dispose: disposeRenderer } = await createRenderer(appEl)
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'

  const { scene, camera, sun, hemi } = createScene()

  // Physics world only exists to satisfy loadTrackForBoot (colliders attach to
  // it). We never spawn a dynamic body or step it.
  const phys = await createPhysicsWorld()

  // Real track environment: GLB geometry + terrain heightmap + track JSON.
  // editMode:false so the env GLB + seabed actually load (editMode skips them).
  const { track, terrainHeightmap, environmentGlbRoot } = await loadTrackForBoot({
    trackId,
    scene,
    phys,
    editMode: false,
  })

  // ---- wave field + per-track water identity (mirrors race-boot) ----------
  const waveField = createWaveField(defaultWaves())
  const spectrum = track.water?.spectrum ?? null
  if (spectrum) waveField.waves = generateSpectrumWaves(spectrum).waves

  const waterMesh = createWaterMesh(waveField, { backend })
  scene.add(waterMesh.mesh)
  waterMesh.configureReflectionCulling(camera)
  setWaterMesh(waterMesh)

  // Track-scoped look: shipped defaults + committed `water.look` (JSON) + any
  // machine-local per-slug working tuning. The tuner reads this scope to
  // persist per slug and EXPORT this track's block.
  const committedLook = track.water?.look ?? {}
  setWaterTuningScope({ kind: 'track', slug: trackId, committed: committedLook })
  applyLookOverrides(waterMesh, committedLook)
  applyLookOverrides(waterMesh, loadTrackOverrides(trackId))

  const waterHeight = track.water?.height ?? 0
  waveField.baseY = waterHeight
  waterMesh.mesh.position.y = waterHeight
  waterMesh.debug.setWaveBearing(track.water?.swellBearingDeg ?? WAVE_BEARING_DEFAULT)
  waveField.swellSetPeriodS = track.water?.swellSets?.periodS ?? 0
  waveField.swellSetDepth = track.water?.swellSets?.depth ?? 0
  waveField.swellSetPhase = track.water?.swellSets?.phase ?? 0
  const beaufort = track.sky?.seaStateBeaufort
  if (beaufort !== undefined) {
    const scale = beaufortToAmplitudeScale(beaufort)
    for (const w of waveField.waves) w.amplitude *= scale
  }
  setWaveZones(waveField, track.waveZones)
  setWaveStamps(waveField, track.waveStamps ?? [])
  if (terrainHeightmap) waterMesh.setTerrainHeightmap(terrainHeightmap)
  setShoreField(waveField, terrainHeightmap?.shoreField ?? null)

  // ---- sky / grade from the track (timeOfDay, colorGrade, fog, bloom) ------
  const todParam = new URLSearchParams(window.location.search).get('tod')
  const todOverride =
    todParam !== null && todParam !== '' && Number.isFinite(Number(todParam))
      ? Number(todParam)
      : null
  const skyConfig =
    todOverride !== null ? { ...(track.sky ?? {}), timeOfDay: todOverride } : track.sky
  const sky = createSkySystem({
    scene,
    renderer,
    camera,
    sun,
    hemi,
    water: waterMesh,
    config: skyConfig,
  })
  setSkySystem(sky)

  // ---- waterline contacts so contact foam has obstacles to bloom around ----
  environmentGlbRoot?.updateMatrixWorld(true)
  const reach = Math.min(
    4,
    Math.max(
      0.8,
      waveField.waves.reduce((a, w) => a + w.amplitude, 0),
    ),
  )
  const contacts: WaterContact[] = []
  if (environmentGlbRoot) {
    contacts.push(...collectWaterContacts([environmentGlbRoot], { waterY: waveField.baseY, reach }))
  }
  const seabedY = (x: number, z: number) =>
    (terrainHeightmap ? sampleTerrainHeightAtXZ(terrainHeightmap, x, z) : null) ?? -10000
  contacts.push(
    ...gatePostWaterContacts(track.checkpoints, {
      waterY: waveField.baseY,
      reach,
      groundY: seabedY,
    }),
  )
  if (contacts.length > 0) waterMesh.setWaterContacts(contacts)

  // ---- WATER tuner (track-scoped, auto-opened) ----------------------------
  document.body.classList.add('dev-build')
  const waterMenu = installWaterDebugMenu(waterMesh)
  waterMenu.open()

  // ---- free orbit camera over the start line ------------------------------
  const start = track.start.position
  const orbit = new OrbitControls(camera, canvas)
  orbit.enableDamping = true
  orbit.dampingFactor = 0.09
  orbit.minDistance = 3
  orbit.maxDistance = 600
  orbit.maxPolarAngle = Math.PI * 0.495
  orbit.target.set(start.x, waterHeight + 1.5, start.z)
  camera.position.set(start.x + 42, waterHeight + 24, start.z + 42)
  orbit.update()

  // ---- minimal HUD --------------------------------------------------------
  const hudEl = document.createElement('div')
  hudEl.id = 'watertune-hud'
  hudEl.style.cssText = `
    position: fixed;
    bottom: 12px;
    right: 12px;
    z-index: 100;
    background: rgba(0, 0, 0, 0.72);
    color: #eee;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
    padding: 10px 14px;
    border-radius: 6px;
    max-width: 360px;
    pointer-events: none;
    line-height: 1.5;
  `
  document.body.appendChild(hudEl)

  let frozen = false
  let todSeconds: number | null = null
  // Posed-camera override for headed capture specs. When set, the frame loop
  // parks the camera here and skips orbit.update() so screenshots are
  // deterministic (no damping drift). Driven via window.__watertune.pose().
  let posedCam: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null
  function updateHud(): void {
    hudEl.innerHTML = `
      <div style="font-weight:600;color:#6ad9c5;font-size:13px;margin-bottom:4px">WATER TUNE · ${trackId}</div>
      <div style="color:#9fb3c8">free cam — no race${frozen ? ' · <b style="color:#ffc83c">FROZEN</b>' : ''}${todSeconds !== null ? ` · tod ${todSeconds.toFixed(0)}s` : ''}</div>
      <div style="margin-top:6px;color:#7cf;font-size:11px">
        drag orbit · scroll zoom · Space freeze · T / Shift+T time of day<br>
        tuner → WATER (left) · EXPORT writes ${trackId}.json
      </div>
    `
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      frozen = !frozen
      e.preventDefault()
    } else if (e.code === 'KeyT') {
      const step = e.shiftKey ? -20 : 20
      todSeconds = ((((todSeconds ?? 40) + step) % 360) + 360) % 360
      sky.setTimeOfDay(todSeconds)
    }
  }
  window.addEventListener('keydown', onKeyDown)

  // ---- frame loop ---------------------------------------------------------
  let disposed = false
  let rafHandle = 0
  let last = performance.now()
  function frame(now: number): void {
    if (disposed) return
    const dt = Math.min((now - last) / 1000, 1 / 15)
    last = now
    if (!frozen) advanceWaveField(waveField, dt * waterMesh.debug.getTimeScale())
    if (posedCam) {
      camera.position.copy(posedCam.pos)
      camera.lookAt(posedCam.target)
    } else {
      orbit.update()
    }
    // Camera-lock the water so its dense vertex region + coverage track the
    // free cam; shoaling reads the world-space heightmap so the shoreline
    // stays put against the fixed terrain.
    waterMesh.tick([], { x: camera.position.x, z: camera.position.z })
    sky.tick(waveField.time, dt, { x: camera.position.x, z: camera.position.z })
    updateUnderwaterFog(
      scene,
      camera.position.y,
      sampleHeight(waveField, camera.position.x, camera.position.z),
    )
    renderFrame(scene, camera)
    updateHud()
    rafHandle = requestAnimationFrame(frame)
  }
  rafHandle = requestAnimationFrame(frame)
  hideLoadingScreen()

  // Headed-capture test hook. Lets a Playwright spec pose the camera, freeze
  // the wave clock, step the sky, and scrub water look knobs live — so the
  // water art pass can A/B many values per boot instead of recompiling. Only
  // the look knobs in WATER_SETTERS are honoured (validated in applyLookOverrides).
  ;(window as unknown as { __watertune?: unknown }).__watertune = {
    backend: () => backend,
    pose(pos: [number, number, number], target: [number, number, number]) {
      posedCam = {
        pos: new THREE.Vector3(pos[0], pos[1], pos[2]),
        target: new THREE.Vector3(target[0], target[1], target[2]),
      }
    },
    clearPose() {
      posedCam = null
    },
    freeze(v: boolean) {
      frozen = v
    },
    setTimeOfDay(s: number) {
      todSeconds = ((s % 360) + 360) % 360
      sky.setTimeOfDay(todSeconds)
    },
    applyLook(o: Record<string, number>) {
      applyLookOverrides(waterMesh, o)
    },
    // Restore the shipped baseline (constructor defaults + this track's
    // committed look) so a capture spec can A/B several presets cleanly on
    // one boot without earlier knobs bleeding into later ones.
    resetLook() {
      applyWaterSettings(waterMesh, defaultsToSettings(waterMesh.debug.defaults))
      applyLookOverrides(waterMesh, committedLook)
    },
    water: waterMesh,
  }

  return {
    dispose() {
      disposed = true
      cancelAnimationFrame(rafHandle)
      window.removeEventListener('keydown', onKeyDown)
      hudEl.remove()
      waterMenu.close()
      orbit.dispose()
      try {
        disposeRenderer()
      } catch (err) {
        console.warn('[watertune] teardown:', err)
      }
    },
  }
}
