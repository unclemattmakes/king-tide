import { addComponent, hasComponent, query, removeComponent } from 'bitecs'
import * as THREE from 'three'
import { installDebugApi, type PlayerSnapshot, type RaceSnapshot } from './debug'
import { createAudioEngine } from './engine/audio/audio'
import { loadDevSettings } from './engine/dev-settings'
import { installDevSettingsMenu } from './engine/dev-settings-menu'
import { installTrackEditor } from './engine/editor/track-editor'
import { formatLap, installGarageMenu } from './engine/garage'
import {
  emptyIntent,
  type Intent,
  inputSourceLabel,
  installInput,
  readPlayerIntent,
} from './engine/input'
import { installCameraLookInput, tickCameraLook } from './engine/input/camera-look'
import { createChaseCamera } from './engine/render/camera'
import { createCliffsideMesh } from './engine/render/cliffside-mesh'
import { createCombatRenderSystem } from './engine/render/combat-render'
import { createDirectionArrow } from './engine/render/direction-arrow'
import { attachTrackColliders, loadGlbTrackVisuals } from './engine/render/glb-track'
import { createPickupRenderSystem } from './engine/render/pickup-render'
import { createRampMesh } from './engine/render/ramp-mesh'
import { createBikeRenderSystem } from './engine/render/render-systems'
import { createRenderer } from './engine/render/renderer'
import { createScene } from './engine/render/scene'
import { createTrackVisuals } from './engine/render/track-mesh'
import { createTrailRenderSystem } from './engine/render/trail-render'
import { type BikeImpact, createWaterMesh } from './engine/render/water'
import { getBestLap, recordLapTime } from './engine/save-state'
import { createSimWorld } from './engine/sim/ecs/world'
import { createPhysicsWorld } from './engine/sim/physics/rapier'
import { vecHorizontalLength } from './engine/sim/physics/vec'
import {
  advanceWaveField,
  createWaveField,
  defaultWaves,
  sampleHeight,
} from './engine/sim/water/wave-field'
import { resolveBikeVariant } from './game/bikes/variants'
import { BikeTag, HoverStateStore, RBHandleStore, TransformStore } from './game/components'
import { AIController, AIControllerStore, AITag, defaultAIController } from './game/components/ai'
import { ExplosionTag, MineTag, MissileTag } from './game/components/combat'
import type { PickupType } from './game/components/pickup'
import { RacerStore } from './game/components/race'
import { createLagoonIsland, createSafetyFloor } from './game/entities/arena'
import { createBike } from './game/entities/bike'
import { createCliffsideTerrain } from './game/entities/cliffside-terrain'
import { createPickupSpawn } from './game/entities/pickup-spawn'
import { createRamp } from './game/entities/ramp'
import { aiCombatSystem } from './game/systems/ai-combat'
import { aiControlSystem } from './game/systems/ai-control'
import {
  explosionTickSystem,
  mineSystem,
  missileSystem,
  shieldTickSystem,
  stunOverrideSystem,
  stunTickSystem,
} from './game/systems/combat'
import { hoverSystem } from './game/systems/hover'
import { applyPlayerIntent } from './game/systems/input-apply'
import {
  boostTickSystem,
  getHeldPickup,
  pickupSystem,
  pickupUseSystem,
} from './game/systems/pickup'
import { createRaceSystem } from './game/systems/race'
import { rubberBandSystem } from './game/systems/rubber-band'
import { computeStandings } from './game/systems/standings'
import { syncFromPhysics } from './game/systems/sync-from-physics'
import { createCliffside } from './game/tracks/cliffside'
import { loadTrackFromJson } from './game/tracks/json-loader'
import { createLagoonLoop } from './game/tracks/lagoon-loop'

const NUM_AI = 4

async function boot() {
  const appEl = document.getElementById('app')
  if (!appEl) throw new Error('#app not found')

  const fpsEl = document.getElementById('hud-fps')
  const backendEl = document.getElementById('hud-backend')
  const inputEl = document.getElementById('hud-input')
  const raceEl = document.getElementById('hud-race')
  const audioEl = document.getElementById('hud-audio')
  const finishEl = document.getElementById('finish')
  const finishTitle = document.getElementById('finish-title')
  const finishSub = document.getElementById('finish-sub')
  const finishPos = document.getElementById('finish-pos')
  const finishTime = document.getElementById('finish-time')
  const finishBest = document.getElementById('finish-best')

  loadDevSettings()
  installInput()
  installCameraLookInput()

  const { renderer, backend } = await createRenderer(appEl)
  const { scene, camera } = createScene()
  const phys = await createPhysicsWorld()
  const sim = createSimWorld()
  const chase = createChaseCamera(camera)

  const waveField = createWaveField(defaultWaves())
  // Subdivision count drives vertex-stage Gerstner cost. 96 is plenty
  // once the wave gradient is analytic (per-vertex, interpolated to
  // fragment); see notes in `engine/render/water.ts`. The CPU-driven
  // version needed 256 to keep wave detail crisp; the shader gets the
  // same visible smoothness with far fewer verts.
  const waterMesh = createWaterMesh(waveField, { size: 800, subdivisions: 96 })
  scene.add(waterMesh.mesh)

  const params = new URLSearchParams(window.location.search)

  // Track selection. Two procedural tracks are baked in: `lagoon` (default)
  // and `cliffside`. Anything else is treated as a JSON track id and loaded
  // from `/tracks/<id>.json` — the new hybrid pipeline (gameplay data in
  // JSON authored via the in-app editor, optional environment .glb authored
  // in Blender).
  //
  // Edit mode (`?edit=1`) defaults to the `lagoon-edit` JSON snapshot of
  // the procedural Lagoon Loop, so the editor opens on something familiar
  // rather than the bare calibration scene.
  const editModeFlag = params.get('edit') === '1'
  const rawTrack = params.get('track')
  const trackId =
    rawTrack && rawTrack.length > 0 ? rawTrack : editModeFlag ? 'lagoon-edit' : 'lagoon'

  // Bike variant. URL `?bike=cruiser|racer|stunt` picks the player's
  // archetype; AI bikes always use the racer baseline for now. Variant
  // controls both stats and body color via BikeStats.bodyColor.
  const playerVariant = resolveBikeVariant(params.get('bike'))

  // Garage menu — DOM overlay opened from a HUD button.
  installGarageMenu({ initialTrackId: trackId, initialBikeId: playerVariant.id })

  // Dev settings — live-tunable input/camera feel knobs.
  installDevSettingsMenu()

  // Best-lap tracking. We compare each completed lap to the saved best
  // for (track, bike) and update on every personal-best.
  let lapStartRaceTime = 0
  let bestLapThisRace: number | null = null
  let bestLapAllTime: number | null = getBestLap({
    trackId,
    bikeId: playerVariant.id,
  })

  // Universal: backstop floor for any track.
  createSafetyFloor(phys)

  // Per-track terrain (physics + visuals). Procedural tracks build their
  // own terrain in code; .glb-backed tracks load mesh + collider geometry
  // straight from the asset.
  if (trackId === 'cliffside') {
    createCliffsideTerrain(phys)
    scene.add(createCliffsideMesh())
  } else if (trackId === 'lagoon') {
    createLagoonIsland(phys)
    createRamp(phys)
    scene.add(createRampMesh())
  }

  const editMode = editModeFlag

  let track: import('./game/tracks/types').Track
  if (trackId === 'cliffside') {
    track = createCliffside()
  } else if (trackId === 'lagoon') {
    track = createLagoonLoop()
  } else {
    // JSON-authored track. Fetch + validate, then optionally load the
    // referenced environment .glb for collidable terrain + visuals.
    track = await loadTrackFromJson(`/tracks/${trackId}.json`)
    if (track.environmentGlb && !editMode) {
      const env = await loadGlbTrackVisuals(track.environmentGlb)
      scene.add(env.scene)
      attachTrackColliders(env.scene, phys)
    }
  }

  // Edit mode: the editor owns the canvas, sim/physics are skipped, no AI
  // bikes, no race system. The user authors the track and saves to disk;
  // hitting "Play" reloads without `?edit=1` to drive the changes.
  if (editMode) {
    if (backendEl) backendEl.textContent = `editor · backend ${backend}`
    const editor = installTrackEditor({ scene, camera, renderer, domEl: appEl, track })
    function editFrame() {
      waterMesh.tick()
      editor.tick()
      requestAnimationFrame(editFrame)
    }
    requestAnimationFrame(editFrame)
    return
  }
  const trackVisuals = createTrackVisuals(track)
  scene.add(trackVisuals.group)

  // Pickup spawns from track.
  for (let i = 0; i < track.pickupSpawns.length; i++) {
    createPickupSpawn(sim, track.pickupSpawns[i]!, i)
  }

  const startPos = track.start.position
  const playerEid = createBike(sim, phys, {
    position: startPos,
    yaw: track.start.yaw,
    isPlayer: true,
    asRacer: true,
    stats: { ...playerVariant.stats, bodyColor: playerVariant.bodyColor },
  })

  // Spread AI bikes across a 4-wide grid behind the player on the right
  // straight, each with a different perpendicular race-line offset. The
  // straight is 28m wide (gate halfWidth × 2), so we spread offsets across
  // ±6m. Bikes spawn at the same lateral offset so they hold their lane.
  const aiEids: number[] = []
  const aiSlots = [
    { dx: -6, dz: -5, off: -6 },
    { dx: -2, dz: -10, off: -2 },
    { dx: 2, dz: -10, off: 2 },
    { dx: 6, dz: -5, off: 6 },
  ]
  for (let i = 0; i < Math.min(NUM_AI, aiSlots.length); i++) {
    const slot = aiSlots[i]!
    const aiEid = createBike(sim, phys, {
      position: { x: startPos.x + slot.dx, y: startPos.y, z: startPos.z + slot.dz },
      yaw: track.start.yaw,
      asRacer: true,
      ai: { splineId: 'main', lineOffset: slot.off },
    })
    aiEids.push(aiEid)
  }

  // Mark the initial "next" gate (cp 0). After the first frame the race
  // callback takes over.
  trackVisuals.setCheckpointState(0, 'next')

  const raceTick = createRaceSystem(track, {
    onCheckpoint: (eid, justCrossed) => {
      if (eid !== playerEid) return
      const r = RacerStore.get(eid)
      if (!r) return
      // The race system has already advanced nextCheckpoint by the time this
      // fires (post-update), so r.nextCheckpoint is the *upcoming* gate.
      // Mark each gate by its relationship to that pointer.
      for (const cp of track.checkpoints) {
        if (cp.index === r.nextCheckpoint) {
          trackVisuals.setCheckpointState(cp.index, 'next')
        } else if (cp.index === justCrossed) {
          trackVisuals.setCheckpointState(cp.index, 'passed')
        } else {
          trackVisuals.setCheckpointState(cp.index, 'upcoming')
        }
      }
      // Audio cue + lap timing.
      // - First cp 0 crossing (`checkpointsCrossed === 1`) is the
      //   "engines on" moment: zero the lap timer so the spawn-to-line
      //   drive doesn't pad lap 1.
      // - Subsequent cp 0 crossings end a lap: emit the celebratory
      //   arpeggio, record the time, persist if it beats the all-time
      //   best for this (track, bike) combo.
      // - Any other gate is just a quick ding.
      if (justCrossed === 0 && r.checkpointsCrossed === 1) {
        lapStartRaceTime = r.raceTime
        audio.gateCleared()
      } else if (justCrossed === 0 && r.checkpointsCrossed > 1) {
        audio.lapCompleted()
        const lapTime = r.raceTime - lapStartRaceTime
        lapStartRaceTime = r.raceTime
        if (bestLapThisRace === null || lapTime < bestLapThisRace) {
          bestLapThisRace = lapTime
        }
        if (recordLapTime({ trackId, bikeId: playerVariant.id }, lapTime)) {
          bestLapAllTime = lapTime
        }
      } else {
        audio.gateCleared()
      }
    },
  })

  const bikeRender = createBikeRenderSystem(scene, sim)
  const trailRender = createTrailRenderSystem(scene, sim)
  const pickupRender = createPickupRenderSystem(scene, sim)
  const combatRender = createCombatRenderSystem(scene, sim)
  const dirArrow = createDirectionArrow()
  scene.add(dirArrow.mesh)

  // Audio: lazy-init AudioContext on first user gesture (browsers block
  // autoplay until then). The engine itself is safe to call before
  // `resume()` — every method early-returns without a context.
  const audio = createAudioEngine()
  const unlockAudio = () => {
    audio.resume()
    window.removeEventListener('keydown', unlockAudio)
    window.removeEventListener('pointerdown', unlockAudio)
  }
  window.addEventListener('keydown', unlockAudio, { once: false })
  window.addEventListener('pointerdown', unlockAudio, { once: false })

  // Per-frame audio dispatch needs to remember "what was true last tick" so
  // it can fire one-shots on transitions. Player slot for collect/fire
  // events; sim entity counts for any-bike weapon spawns.
  let prevPlayerHeld: PickupType | null = null
  let prevMineCount = 0
  let prevMissileCount = 0
  let prevExplosionCount = 0

  const state = {
    ready: false,
    backend,
    fps: 0,
    frame: 0,
    intent: emptyIntent() as Intent,
    intentOverride: null as Intent | null,
    playerSnapshot: null as PlayerSnapshot | null,
    raceSnapshot: null as RaceSnapshot | null,
  }

  installDebugApi(state, {
    sim: () => sim,
    phys: () => phys,
    track: () => track,
    playerEid: () => playerEid,
    toggleAutoPlay: () => {
      setAutoPlay(!autoPlay)
      return autoPlay
    },
    isAutoPlay: () => autoPlay,
  })
  if (backendEl) backendEl.textContent = `backend: ${backend}`
  if (finishSub) finishSub.textContent = track.name

  let finishShown = false
  let autoPlay = false

  /** Attach/detach AITag on the player. When attached, ai-control-system
   *  drives the player's ControlIntent (overwriting applyPlayerIntent's write
   *  because aiControlSystem runs after it). */
  function setAutoPlay(on: boolean) {
    autoPlay = on
    if (on) {
      if (!hasComponent(sim, playerEid, AITag)) {
        addComponent(sim, playerEid, AITag)
        addComponent(sim, playerEid, AIController)
      }
      // Always reset AI state on toggle — fresh closest-point search, no carry
      // over from previous auto-play sessions on the same page.
      AIControllerStore.set(playerEid, defaultAIController('main'))
    } else if (hasComponent(sim, playerEid, AITag)) {
      removeComponent(sim, playerEid, AITag)
    }
  }

  /** Snap the player back to the spawn pose with zero velocity. Useful after
   *  collisions leave the bike upside-down, off-track, or unrecoverable. */
  function respawnPlayer() {
    const handle = RBHandleStore.get(playerEid)
    if (!handle) return
    const rb = phys.world.getRigidBody(handle.handle)
    if (!rb) return
    const halfYaw = track.start.yaw / 2
    rb.setTranslation(
      { x: track.start.position.x, y: track.start.position.y, z: track.start.position.z },
      true,
    )
    rb.setRotation({ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) }, true)
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
  }

  // Keys: R to restart after finish; T (or F1) to toggle auto-play;
  // Backspace to respawn the player in place.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && finishShown) {
      window.location.reload()
    } else if (e.code === 'KeyT' || e.code === 'F1') {
      setAutoPlay(!autoPlay)
    } else if (e.code === 'KeyM') {
      audio.setMuted(!audio.isMuted())
    } else if (e.code === 'Backspace') {
      respawnPlayer()
      e.preventDefault()
    }
  })

  const tmpPos = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()

  // Reused per-frame buffer for the GPU water shader's bike impact array.
  // Each frame we query every BikeTag entity, sample the wave height under
  // it, and translate altitude → impact weight (1 = on water, 0 = airborne).
  // The water shader uses these to depress the surface (hull dimple) and
  // draw a V-wake stripe behind moving bikes.
  const bikeImpacts: BikeImpact[] = []
  function gatherBikeImpacts(): readonly BikeImpact[] {
    bikeImpacts.length = 0
    const eids = query(sim, [BikeTag])
    for (const eid of eids) {
      const t = TransformStore.get(eid)
      const rbh = RBHandleStore.get(eid)
      if (!t || !rbh) continue
      const rb = phys.world.getRigidBody(rbh.handle)
      if (!rb) continue
      const v = rb.linvel()
      // Altitude above the *wave-displaced* surface at the bike's XZ. The
      // shader's dimple/wake should fade out as the bike lifts off — full
      // strength at the water line, zero by the time it's clearly airborne.
      const surfaceY = sampleHeight(waveField, t.x, t.z)
      const altitude = t.y - surfaceY
      let weight = 1
      if (altitude > 0.5) {
        weight = Math.max(0, 1 - (altitude - 0.5) / 1.5)
      }
      bikeImpacts.push({ x: t.x, z: t.z, vx: v.x, vz: v.z, weight })
    }
    return bikeImpacts
  }

  let last = performance.now()
  let physAccum = 0
  let framesThisSecond = 0
  let fpsAccumStart = last

  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 1 / 15)
    last = now

    state.intent = state.intentOverride ?? readPlayerIntent(dt)

    physAccum += dt
    while (physAccum >= phys.fixedDt) {
      advanceWaveField(waveField, phys.fixedDt)
      // Player intent first; AI runs after and overwrites for entities tagged
      // AITag (which now includes the player while auto-play is on). After
      // ai-control writes the racing-line intent, ai-combat decides whether
      // to flip fire=true based on the AI's held pickup. Stun runs LAST in
      // the intent chain so spun-out bikes can't drive through their own
      // hit reaction.
      if (!autoPlay) applyPlayerIntent(sim, state.intent)
      aiControlSystem(sim, phys, track)
      aiCombatSystem(sim, phys)
      stunOverrideSystem(sim)
      hoverSystem(sim, phys, waveField)
      phys.step()
      syncFromPhysics(sim, phys)
      raceTick(sim, phys, phys.fixedDt)
      pickupSystem(sim, phys, phys.fixedDt)
      pickupUseSystem(sim, phys)
      mineSystem(sim, phys, phys.fixedDt)
      missileSystem(sim, phys, phys.fixedDt)
      explosionTickSystem(sim, phys.fixedDt)
      boostTickSystem(sim, phys.fixedDt)
      shieldTickSystem(sim, phys.fixedDt)
      stunTickSystem(sim, phys.fixedDt)
      rubberBandSystem(sim, track)
      physAccum -= phys.fixedDt
    }

    const rbHandle = RBHandleStore.get(playerEid)
    const hover = HoverStateStore.get(playerEid)
    if (rbHandle && hover) {
      const playerRb = phys.world.getRigidBody(rbHandle.handle)
      if (playerRb) {
        const t = playerRb.translation()
        const v = playerRb.linvel()
        const q = playerRb.rotation()
        tmpPos.set(t.x, t.y, t.z)
        tmpQuat.set(q.x, q.y, q.z, q.w)
        const look = tickCameraLook(dt)
        chase.setOrbit(look.yaw, look.pitch)
        chase.tick(tmpPos, tmpQuat, dt)
        state.playerSnapshot = {
          eid: playerEid,
          position: { x: t.x, y: t.y, z: t.z },
          velocity: { x: v.x, y: v.y, z: v.z },
          groundDistance: hover.groundDistance,
          isGrounded: hover.isGrounded,
          speed: vecHorizontalLength({ x: v.x, y: 0, z: v.z }),
        }
      }
    }

    // Audio dispatch — runs once per render frame, after physics.
    // Continuous engine + wind layers are driven by the player's speed.
    audio.tickEngine(state.playerSnapshot?.speed ?? 0)

    // Player slot transitions: collected (null → X), or fired with a
    // non-spawning effect (boost / shield). Mine and missile fires also
    // empty the slot, but those sounds come from the entity-spawn path
    // below — handling them here would double-fire on the player's
    // firing tick.
    const currentPlayerHeld = getHeldPickup(playerEid)
    if (prevPlayerHeld === null && currentPlayerHeld !== null) {
      audio.pickupCollect()
    } else if (
      prevPlayerHeld !== null &&
      currentPlayerHeld === null &&
      (prevPlayerHeld === 'boost' || prevPlayerHeld === 'shield')
    ) {
      audio.pickupFire(prevPlayerHeld)
    }
    prevPlayerHeld = currentPlayerHeld

    // Combat entity spawns: any new mine/missile/explosion in the world
    // gets a sound (so AI weapons are audible too, not just the player's).
    const mineCount = query(sim, [MineTag]).length
    if (mineCount > prevMineCount) audio.pickupFire('mine')
    prevMineCount = mineCount
    const missileCount = query(sim, [MissileTag]).length
    if (missileCount > prevMissileCount) audio.pickupFire('missile')
    prevMissileCount = missileCount
    const explosionCount = query(sim, [ExplosionTag]).length
    if (explosionCount > prevExplosionCount) audio.explosion()
    prevExplosionCount = explosionCount

    const racer = RacerStore.get(playerEid)
    if (racer) {
      state.raceSnapshot = {
        lap: racer.lap,
        lapsToFinish: track.lapsToFinish,
        nextCheckpoint: racer.nextCheckpoint,
        checkpointsCrossed: racer.checkpointsCrossed,
        totalCheckpoints: track.checkpoints.length,
        finished: racer.finished,
        raceTime: racer.raceTime,
      }
    }

    waterMesh.tick(gatherBikeImpacts())
    bikeRender()
    trailRender(camera)
    pickupRender(dt)
    combatRender(dt)

    // Direction arrow points the player to the next checkpoint.
    const racerNow = RacerStore.get(playerEid)
    if (racerNow && !racerNow.finished) {
      const nextCp = track.checkpoints[racerNow.nextCheckpoint]
      if (nextCp) {
        const targetVec = new THREE.Vector3(nextCp.position.x, nextCp.position.y, nextCp.position.z)
        dirArrow.tick(tmpPos, targetVec, dt)
      } else {
        dirArrow.tick(tmpPos, null, dt)
      }
    } else {
      dirArrow.tick(tmpPos, null, dt)
    }

    renderer.render(scene, camera)

    state.frame += 1
    framesThisSecond += 1
    if (now - fpsAccumStart >= 500) {
      state.fps = (framesThisSecond * 1000) / (now - fpsAccumStart)
      framesThisSecond = 0
      fpsAccumStart = now
      if (fpsEl) fpsEl.textContent = `fps: ${state.fps.toFixed(0)}`
      if (audioEl) audioEl.textContent = `audio: ${audio.isMuted() ? 'muted (M)' : 'on (M)'}`
      if (inputEl) {
        const i = state.intent
        const speed = state.playerSnapshot?.speed ?? 0
        const held = getHeldPickup(playerEid) ?? '—'
        inputEl.textContent = `${inputSourceLabel()} | thr ${i.throttle.toFixed(2)} steer ${i.steer.toFixed(2)} | ${speed.toFixed(1)} m/s | item: ${held}`
      }
      if (raceEl && state.raceSnapshot) {
        const rs = state.raceSnapshot
        const standings = computeStandings(sim, track)
        const me = standings.find((s) => s.eid === playerEid)
        const status = rs.finished
          ? 'FINISHED'
          : `cp ${rs.nextCheckpoint + 1}/${rs.totalCheckpoints}`
        const auto = autoPlay ? ' [AUTO]' : ''
        raceEl.textContent = `lap ${rs.lap}/${rs.lapsToFinish} | pos ${me?.position ?? '?'}/${standings.length} | ${status} | ${rs.raceTime.toFixed(1)}s${auto}`

        if (rs.finished && !finishShown && finishEl) {
          finishShown = true
          finishEl.classList.add('show')
          if (finishPos && me) finishPos.textContent = ordinal(me.position)
          if (finishTime) finishTime.textContent = formatTime(rs.raceTime)
          if (finishTitle) finishTitle.textContent = me?.position === 1 ? 'WINNER' : 'FINISH'
          if (finishSub) finishSub.textContent = `${track.name} · ${playerVariant.name}`
          if (finishBest) {
            const parts: string[] = []
            if (bestLapThisRace !== null) {
              parts.push(`Best lap: <b>${formatLap(bestLapThisRace)}</b>`)
            }
            if (bestLapAllTime !== null) {
              parts.push(`All-time: <b>${formatLap(bestLapAllTime)}</b>`)
            }
            finishBest.innerHTML = parts.length ? `<br />${parts.join(' · ')}` : ''
          }
        }
      }
    }
    requestAnimationFrame(frame)
  }

  state.ready = true
  requestAnimationFrame(frame)
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return m > 0 ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${s.toFixed(2)}s`
}

boot().catch((err) => {
  console.error('[boot] fatal', err)
  const el = document.getElementById('hud-backend')
  if (el) el.textContent = `boot failed: ${String(err)}`
})
