/**
 * Replay-playback frame loop. `?replay=session` reads a JSON replay
 * payload from sessionStorage (stashed there by the garage's Load
 * Replay flow, which then navigates here). When active, the recorded
 * race is played back on the original track with the original bikes —
 * no input, no AI, no physics for the bikes themselves; just
 * interpolated transforms feeding into the existing render systems.
 *
 * `startReplayMode` replaces the live rAF frame with one that:
 *   1. Advances the wave field at `playerSpeed × waveTimeScale`.
 *   2. Samples poses from the replay player into `TransformStore`.
 *   3. Drives the spectator camera (auto/chase/orbit) off the followed
 *      slot.
 *   4. Runs the existing render systems against the now-populated ECS.
 *   5. Updates the spectator HUD.
 *
 * It does NOT call `sim`/`phys`/`raceTick` — those are explicitly the
 * live-race responsibilities.
 */

import * as THREE from 'three'
import type { HorizonRing } from '@/engine/render/horizon-ring'
import type { SkySystem } from '@/engine/render/sky'
import type { BikeImpact } from '@/engine/render/water'
import { updateUnderwaterFog } from '@/engine/render/water'
import type { ReplayFile } from '@/engine/replay/format'
import { createReplayPlayer, makePoseBuffer } from '@/engine/replay/player'
import { createSpectatorCamera } from '@/engine/replay/spectator-camera'
import { installSpectatorHud } from '@/engine/replay/spectator-hud'
import { advanceWaveField, type WaveFieldState } from '@/engine/sim/water/wave-field'
import { TransformStore } from '@/game/components'

export interface ReplayModeOpts {
  activeReplay: ReplayFile
  replayBikeEids: number[]
  appEl: HTMLElement
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  sky: SkySystem
  horizonRing: HorizonRing
  waveField: WaveFieldState
  waterMesh: {
    tick: (impacts: readonly BikeImpact[], focus: { x: number; z: number }) => void
    debug: { getTimeScale: () => number }
  }
  bikeRender: () => void
  riderRender: () => void
  pickupRender: (dt: number) => void
  combatRender: (dt: number) => void
  fxTick: (dt: number) => void
  /** Unified track-emitter particle system — same shape as the live loop. */
  particleTick: (dt: number) => void
  /** Landmark animation — drives ``landmark_mechanical_rig`` arm
   *  rotations. Same shape as the live loop; passing it through here
   *  keeps gantry cranes / bells swinging during replay playback so
   *  the scene reads correctly. */
  landmarkTick: (elapsedSeconds: number) => void
  physicsDebug: { tick: () => void }
  /** Shared boot state — flipped to `ready` once the first replay frame
   *  is queued; `frame` / `fps` accumulated each render frame for the
   *  debug overlay + HUD. */
  state: { ready: boolean; frame: number; fps: number }
  /** HUD elements that need to be hidden in playback (race row, audio
   *  row, etc.). `null` entries are tolerated for environments that
   *  stripped the HUD. */
  hud: {
    fpsEl: HTMLElement | null
    backendEl: HTMLElement | null
    audioEl: HTMLElement | null
    inputEl: HTMLElement | null
    raceEl: HTMLElement | null
  }
  backend: string
  /** Called once everything is armed and the rAF loop is about to run. */
  onReady: () => void
}

export function startReplayMode(opts: ReplayModeOpts): void {
  const {
    activeReplay,
    replayBikeEids,
    appEl,
    scene,
    camera,
    renderer,
    sky,
    horizonRing,
    waveField,
    waterMesh,
    bikeRender,
    riderRender,
    pickupRender,
    combatRender,
    fxTick,
    particleTick,
    landmarkTick,
    physicsDebug,
    state,
    hud,
    backend,
    onReady,
  } = opts

  const replayPlayer = createReplayPlayer(activeReplay)
  const poseBuffer = makePoseBuffer(replayPlayer.bikeCount)
  const spectator = createSpectatorCamera(camera)
  let followedSlot = 0

  const focalPos = new THREE.Vector3()
  const focalQuat = new THREE.Quaternion()
  // Re-used pose array for the broadcast director — same indices as
  // replayBikeEids so `id` maps cleanly back to a replay slot. The
  // director only consults the array in AUTO mode.
  const replayBikePoses = activeReplay.bikes.map((_, i) => ({
    id: i,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    score: 1,
  }))

  const spectatorHud = installSpectatorHud({
    replay: activeReplay,
    player: replayPlayer,
    camera: spectator,
    getFollowedSlot: () => followedSlot,
    setFollowedSlot: (s) => {
      if (s < 0 || s >= replayBikeEids.length) return
      followedSlot = s
      // Snap the camera to avoid an awkward swing across the map when
      // jumping between bikes that are far apart.
      const p = poseBuffer[s] as (typeof poseBuffer)[number]
      focalPos.set(p.x, p.y, p.z)
      focalQuat.set(p.qx, p.qy, p.qz, p.qw)
      spectator.snap(focalPos, focalQuat)
    },
    exit: () => {
      // Drop the pending replay so a refresh doesn't re-enter spectator
      // mode, then return to the garage on a clean URL.
      sessionStorage.removeItem('hover-replay-pending')
      const url = new URL(window.location.href)
      url.searchParams.delete('replay')
      window.location.assign(url.toString())
    },
  })
  spectatorHud.show()

  // Hide HUD bits that don't apply to playback. The race + audio rows
  // would just show stale zeros; the FPS row is fine to keep. Same for
  // the arcade race HUD (countdown banner, timer card, gap toast,
  // minimap) — those are tied to a live race the spectator isn't in.
  if (hud.raceEl) hud.raceEl.style.display = 'none'
  if (hud.inputEl) hud.inputEl.style.display = 'none'
  if (hud.audioEl) hud.audioEl.style.display = 'none'
  for (const id of ['race-banner', 'race-timer', 'race-gap', 'race-minimap']) {
    const el = document.getElementById(id)
    if (el) el.style.display = 'none'
  }
  if (hud.backendEl) hud.backendEl.textContent = `replay · backend ${backend}`

  // Free-orbit input: left mouse drag on canvas rotates, wheel zooms.
  // Right-click is reserved for the existing chase-mode camera-look so
  // we leave it alone.
  let orbitDragging = false
  let lastOrbitX = 0
  let lastOrbitY = 0
  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 0 && spectator.mode === 'orbit') {
      orbitDragging = true
      lastOrbitX = e.clientX
      lastOrbitY = e.clientY
      e.preventDefault()
    }
  }
  const onMouseMove = (e: MouseEvent) => {
    if (!orbitDragging) return
    spectator.rotate(e.clientX - lastOrbitX, e.clientY - lastOrbitY)
    lastOrbitX = e.clientX
    lastOrbitY = e.clientY
  }
  const onMouseUp = () => {
    orbitDragging = false
  }
  const onWheel = (e: WheelEvent) => {
    if (spectator.mode !== 'orbit') return
    spectator.zoom(e.deltaY)
    e.preventDefault()
  }
  appEl.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  appEl.addEventListener('wheel', onWheel, { passive: false })

  // Keyboard playback shortcuts. Numbered keys 1..9 follow that bike
  // slot (1 = recorded player). Space toggles play/pause; ←/→ scrub
  // ±5s; F toggles free-orbit camera.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      replayPlayer.paused = !replayPlayer.paused
      e.preventDefault()
    } else if (e.code === 'ArrowLeft') {
      replayPlayer.seek(replayPlayer.time - 5)
    } else if (e.code === 'ArrowRight') {
      replayPlayer.seek(replayPlayer.time + 5)
    } else if (e.code === 'KeyF') {
      // F now cycles AUTO → CHASE → FREE (orbit) → AUTO so each press
      // moves to a distinct broadcast paradigm.
      const next =
        spectator.mode === 'auto' ? 'chase' : spectator.mode === 'chase' ? 'orbit' : 'auto'
      spectator.setMode(next)
      if (next === 'orbit') spectator.resetOrbit()
    } else if (e.code === 'KeyC') {
      // Broadcast cut — only effective in AUTO mode, no-op elsewhere.
      spectator.cutAuto()
    } else if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5))
      if (n >= 1 && n <= replayBikeEids.length) {
        followedSlot = n - 1
        const p = poseBuffer[followedSlot] as (typeof poseBuffer)[number]
        focalPos.set(p.x, p.y, p.z)
        focalQuat.set(p.qx, p.qy, p.qz, p.qw)
        spectator.snap(focalPos, focalQuat)
      }
    }
  })

  // Spawn-pose snap: feed the very first replay frame into TransformStore
  // before anything renders, so the first paint has bikes in the right
  // place rather than at the spawn cluster.
  replayPlayer.sample(poseBuffer)
  for (let i = 0; i < replayBikeEids.length; i++) {
    const eid = replayBikeEids[i] as number
    const p = poseBuffer[i] as (typeof poseBuffer)[number]
    TransformStore.set(eid, {
      x: p.x,
      y: p.y,
      z: p.z,
      qx: p.qx,
      qy: p.qy,
      qz: p.qz,
      qw: p.qw,
    })
  }
  {
    const p0 = poseBuffer[followedSlot] as (typeof poseBuffer)[number]
    focalPos.set(p0.x, p0.y, p0.z)
    focalQuat.set(p0.qx, p0.qy, p0.qz, p0.qw)
    spectator.snap(focalPos, focalQuat)
  }

  let lastReplay = performance.now()
  let framesThisSecond = 0
  let fpsAccumStart = lastReplay
  function replayFrame(now: number): void {
    const dt = Math.min((now - lastReplay) / 1000, 1 / 15)
    lastReplay = now

    // Wave field still ticks so the water shader animates and the sun
    // continues its day-night cycle. Speed-scaled so 2× playback also
    // doubles the wave time-step, keeping the visual coupling intact.
    advanceWaveField(
      waveField,
      dt * waterMesh.debug.getTimeScale() * (replayPlayer.paused ? 0 : replayPlayer.speed),
    )

    replayPlayer.tick(dt, poseBuffer)
    for (let i = 0; i < replayBikeEids.length; i++) {
      const eid = replayBikeEids[i] as number
      const p = poseBuffer[i] as (typeof poseBuffer)[number]
      TransformStore.set(eid, {
        x: p.x,
        y: p.y,
        z: p.z,
        qx: p.qx,
        qy: p.qy,
        qz: p.qz,
        qw: p.qw,
      })
    }
    const fp = poseBuffer[followedSlot] ?? (poseBuffer[0] as (typeof poseBuffer)[number])
    focalPos.set(fp.x, fp.y, fp.z)
    focalQuat.set(fp.qx, fp.qy, fp.qz, fp.qw)
    // AUTO mode needs the full field of poses so the director can cut
    // between bikes; chase/orbit ignore the array and use focalPos.
    for (let i = 0; i < replayBikePoses.length; i++) {
      const p = poseBuffer[i]
      if (!p) continue
      const pose = replayBikePoses[i] as (typeof replayBikePoses)[number]
      pose.position.set(p.x, p.y, p.z)
      pose.quaternion.set(p.qx, p.qy, p.qz, p.qw)
    }
    spectator.tick(focalPos, focalQuat, dt, replayBikePoses)
    // Keep `followedSlot` in lockstep with the director's focus so the
    // HUD's FOLLOW pills + the camera agree on who's on screen.
    if (spectator.mode === 'auto') {
      const auto = spectator.getAutoFocusId()
      if (auto !== null && auto !== followedSlot) followedSlot = auto
    }

    waterMesh.tick([], { x: camera.position.x, z: camera.position.z })

    // Sky/atmosphere — same call as the live loop; sun follows the focal
    // bike so shadows stay framed during spectator pans.
    sky.tick(waveField.time, dt, { x: focalPos.x, z: focalPos.z })
    // Horizon silhouette follows the spectator camera so wide pans don't
    // expose the ring's centre offset from the player.
    horizonRing.tick({ x: camera.position.x, z: camera.position.z })
    updateUnderwaterFog(scene, camera.position.y)
    bikeRender()
    riderRender()
    pickupRender(dt)
    combatRender(dt)
    fxTick(dt)
    particleTick(dt)
    landmarkTick(now / 1000)
    physicsDebug.tick()

    spectatorHud.refresh()
    renderer.render(scene, camera)

    state.frame += 1
    framesThisSecond += 1
    if (now - fpsAccumStart >= 500) {
      state.fps = (framesThisSecond * 1000) / (now - fpsAccumStart)
      framesThisSecond = 0
      fpsAccumStart = now
      if (hud.fpsEl) hud.fpsEl.textContent = `fps: ${state.fps.toFixed(0)}`
    }
    requestAnimationFrame(replayFrame)
  }
  state.ready = true
  onReady()
  requestAnimationFrame(replayFrame)
}
