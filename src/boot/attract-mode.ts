import * as THREE from 'three'
import type { Intent } from '@/engine/input/intent'
import { createBroadcastDirector } from '@/engine/render/broadcast-director'
import { createCombatRenderSystem } from '@/engine/render/combat-render'
import { createFxSystem } from '@/engine/render/fx'
import { loadGateProp } from '@/engine/render/gate-prop'
import { createPickupRenderSystem } from '@/engine/render/pickup-render'
import { createPropsMesh } from '@/engine/render/props-mesh'
import { createBikeRenderSystem } from '@/engine/render/render-systems'
import { createRenderer } from '@/engine/render/renderer'
import { renderFrame } from '@/engine/render/renderer-service'
import { createRiderRenderSystem } from '@/engine/render/rider-systems'
import { createScene } from '@/engine/render/scene'
import { createSkySystem } from '@/engine/render/sky'
import { createTrackVisuals } from '@/engine/render/track-mesh'
import { createWaterMesh, updateUnderwaterFog } from '@/engine/render/water'
import { createWaveRiderRenderSystem } from '@/engine/render/wave-rider-render'
import { createSimWorld } from '@/engine/sim/ecs/world'
import { createPhysicsWorld } from '@/engine/sim/physics/rapier'
import { createWaveField, defaultWaves, sampleHeight } from '@/engine/sim/water/wave-field'
import { applyStoredWaterTuning } from '@/engine/water-debug-storage'
import { loadBike } from '@/game/assets/bike-loader'
import { type LoadedProp, loadProp } from '@/game/assets/prop-loader'
import { resolveBikeVariant } from '@/game/bikes/variants'
import { ControlIntentStore, RBHandleStore } from '@/game/components'
import { createBike } from '@/game/entities/bike'
import { createPropColliders } from '@/game/entities/props'
import { createRider } from '@/game/entities/rider'
import { simulateStep } from '@/game/sim-step'
import { createWaveRiderSystem } from '@/game/systems/wave-rider'
import type { Track } from '@/game/tracks/types'
import { AI_GRID_SLOTS, resolveGridSlotWorld } from './grid-offsets'
import { loadTrackForBoot } from './track-loader'

/**
 * Attract-mode boot — a stripped-down race loop with no player, used as
 * a live game-feed background behind the cold-boot menu and other broadcast
 * surfaces.
 *
 * Differences from the main boot:
 *  - No player bike, no race system, no countdown, no HUD.
 *  - AI bikes lap the spline indefinitely; they aren't Racer-tagged so
 *    rubber-band/standings don't apply. They do have ControlIntent driven
 *    by the AI control system.
 *  - Camera is owned by `BroadcastDirector`, which cycles cinematic shots
 *    over the field every few seconds.
 *  - `dispose()` cleans up the renderer, canvas, physics, and frame loop
 *    so a navigation into the real race can swap in a fresh boot.
 *
 * Errors during attract boot are logged but never thrown — the cold-boot
 * menu must remain interactive even if asset loads stall, so attract mode
 * fails silently and just shows a black canvas.
 */
export type AttractHandle = {
  /** Tear down. Safe to call multiple times. */
  dispose(): void
  /** Tells the director to cut to a fresh shot on the next frame. */
  cut(): void
  /** True once the attract loop has rendered at least one frame. */
  isLive(): boolean
}

export type AttractOpts = {
  /** Element the canvas is appended to. Typically `#attract-stage`. */
  parent: HTMLElement
  /** Default 'lagoon'. */
  trackId?: string
}

export async function bootAttractMode(opts: AttractOpts): Promise<AttractHandle> {
  let disposed = false
  let live = false
  let rafHandle = 0
  let teardown: () => void = () => {
    /* replaced on success */
  }
  const handle: AttractHandle = {
    dispose() {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(rafHandle)
      teardown()
    },
    cut() {
      directorCutPending = true
    },
    isLive() {
      return live
    },
  }
  let directorCutPending = false

  try {
    const {
      renderer,
      backend,
      canvas,
      dispose: disposeRenderer,
    } = await createRenderer(opts.parent)
    // Attract canvas sits behind the menu — z-index 0; the menu is z-index 40+.
    canvas.style.position = 'absolute'
    canvas.style.inset = '0'
    canvas.style.zIndex = '0'

    const { scene, camera, sun, hemi } = createScene()
    const phys = await createPhysicsWorld()
    const sim = createSimWorld()

    if (disposed) {
      disposeRenderer()
      return handle
    }

    const waveField = createWaveField(defaultWaves())
    const waterMesh = createWaterMesh(waveField, { backend })
    scene.add(waterMesh.mesh)
    applyStoredWaterTuning(waterMesh)

    const trackId = opts.trackId ?? 'lagoon'
    const { track, terrainHeightmap } = await loadTrackForBoot({
      trackId,
      scene,
      phys,
      editMode: false,
    })
    if (disposed) {
      disposeRenderer()
      return handle
    }
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

    // Preload the gate prop mesh from the library so checkpoints
    // render with the Blender-authored mesh. Falls back to procedural
    // gates if the asset isn't present.
    const gatePropTemplate = await loadGateProp()
    const trackVisuals = createTrackVisuals(track, { gatePropTemplate })
    scene.add(trackVisuals.group)

    // Editor-authored props.
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
    let waveRiderSys: ReturnType<typeof createWaveRiderSystem> | undefined
    let waveRiderRender: ReturnType<typeof createWaveRiderRenderSystem> | undefined
    if (track.props.length > 0) {
      scene.add(createPropsMesh(track.props, propAssets))
      waveRiderSys = createWaveRiderSystem(sim, phys, waveField)
      const bindings = createPropColliders(phys, track.props, propAssets, sim)
      if (bindings.size > 0) {
        waveRiderRender = createWaveRiderRenderSystem(scene, sim, {
          assetResolver: (eid) => {
            const id = bindings.get(eid)
            return id ? propAssets.get(id) : undefined
          },
        })
      }
    }

    if (disposed) {
      disposeRenderer()
      return handle
    }

    // Single bike GLB — racer baseline for every attract rider.
    const racerBikeGlb = await loadBike('/assets/bikes/racer.glb')
    if (disposed) {
      disposeRenderer()
      return handle
    }

    // Spawn one bike per grid slot, all AI-controlled, NOT racer-tagged
    // (the field loops the spline indefinitely; no lap counters, no
    // finish state). Spread them around the spline so the broadcast
    // camera always has something to cut between.
    const racerVariant = resolveBikeVariant('racer')
    const grid = AI_GRID_SLOTS.slice(0, Math.min(5, AI_GRID_SLOTS.length))
    const aiEids: number[] = []
    const halfStartYaw = track.start.yaw / 2
    const startQuat = {
      x: 0,
      y: Math.sin(halfStartYaw),
      z: 0,
      w: Math.cos(halfStartYaw),
    }
    for (let i = 0; i < grid.length; i++) {
      const slot = grid[i]!
      const pos = resolveGridSlotWorld(track.start.position, track.start.yaw, slot.dx, slot.dz)
      const eid = createBike(sim, phys, {
        position: pos,
        yaw: track.start.yaw,
        asRacer: false,
        stats: {
          ...racerVariant.stats,
          bodyColor: racerVariant.bodyColor,
          variantId: racerVariant.id,
        },
        ai: { splineId: 'main', lineOffset: slot.lineOffset },
      })
      const handle = RBHandleStore.get(eid)
      if (handle) {
        createRider(sim, phys, {
          bikeEid: eid,
          bikeRbHandle: handle.handle,
          bikePos: pos,
          bikeRot: startQuat,
        })
      }
      aiEids.push(eid)
    }
    // Stagger AI bikes along the spline so they don't all start in a
    // tight pack — gives the broadcast a wider sample.
    staggerAlongSpline(track, phys.world, aiEids)

    const bikeRender = createBikeRenderSystem(scene, sim, {
      byVariantId: { racer: racerBikeGlb },
      default: racerBikeGlb,
    })
    const riderRender = createRiderRenderSystem(scene, sim)
    const pickupRender = createPickupRenderSystem(scene, sim)
    const combatRender = createCombatRenderSystem(scene, sim)
    const fxTick = createFxSystem(scene, sim, phys, waveField).tick

    const director = createBroadcastDirector({ camera })

    const tmpPoses = aiEids.map((_, i) => ({
      id: i,
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      score: 1,
    }))

    // No race tick in attract mode — bikes loop forever. We pass a no-op
    // raceTick to simulateStep.
    const raceTick = () => {
      /* no-op */
    }
    const peerInputs = new Map<number, Intent>()

    let last = performance.now()
    let physAccum = 0
    function frame(now: number) {
      if (disposed) return
      const dt = Math.min((now - last) / 1000, 1 / 15)
      last = now
      physAccum += dt
      while (physAccum >= phys.fixedDt) {
        // attract simulateStep: AI controls itself, no player input
        simulateStep(sim, phys, waveField, track, raceTick, {
          peerInputs,
          locked: false,
          autoPlay: false,
          waveTimeScale: waterMesh.debug.getTimeScale(),
          runAI: true,
          ...(waveRiderSys ? { waveRiders: waveRiderSys } : {}),
        })
        physAccum -= phys.fixedDt
      }

      // Refresh poses for the director.
      for (let i = 0; i < aiEids.length; i++) {
        const eid = aiEids[i]!
        const h = RBHandleStore.get(eid)
        if (!h) continue
        const rb = phys.world.getRigidBody(h.handle)
        if (!rb) continue
        const t = rb.translation()
        const q = rb.rotation()
        const pose = tmpPoses[i]!
        pose.position.set(t.x, t.y, t.z)
        pose.quaternion.set(q.x, q.y, q.z, q.w)
        // Score: forward speed (rough leader bias). Doesn't have to be
        // perfect — the director uses it as a weighted random.
        const v = rb.linvel()
        pose.score = Math.max(0.4, Math.hypot(v.x, v.z) / 30)
      }
      if (directorCutPending) {
        director.cut()
        directorCutPending = false
      }
      director.tick(tmpPoses, dt)

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
      waveRiderRender?.render()
      renderFrame(scene, camera)
      live = true
      rafHandle = requestAnimationFrame(frame)
    }
    rafHandle = requestAnimationFrame(frame)

    teardown = () => {
      try {
        cancelAnimationFrame(rafHandle)
        disposeRenderer()
      } catch (err) {
        console.warn('[attract] teardown:', err)
      }
    }
  } catch (err) {
    console.warn('[attract] boot failed:', err)
    disposed = true
  }

  return handle
}

/**
 * Spread the AI field around the spline before the first physics step so
 * the broadcast camera has riders at varied positions to cut between.
 * Each bike's rigid body is teleported to its sample point; ControlIntent
 * is nudged to full throttle so the AI controller has motion to react to.
 */
function staggerAlongSpline(
  track: Track,
  world: { getRigidBody: (h: number) => unknown },
  eids: number[],
): void {
  const spline = track.aiSplines.find((s) => s.id === 'main') ?? track.aiSplines[0]
  if (!spline || spline.points.length < 2) return
  const pts = spline.points
  for (let i = 0; i < eids.length; i++) {
    const eid = eids[i]!
    const handleRecord = RBHandleStore.get(eid)
    if (!handleRecord) continue
    const rb = world.getRigidBody(handleRecord.handle) as {
      setTranslation: (v: { x: number; y: number; z: number }, w: boolean) => void
      setRotation: (q: { x: number; y: number; z: number; w: number }, w: boolean) => void
      setLinvel: (v: { x: number; y: number; z: number }, w: boolean) => void
    } | null
    if (!rb) continue
    const frac = (i + 0.4) / eids.length
    const idx = Math.min(pts.length - 1, Math.floor(frac * pts.length))
    const a = pts[idx]!
    const b = pts[(idx + 1) % pts.length]!
    const dx = b.x - a.x
    const dz = b.z - a.z
    const yaw = Math.atan2(dx, dz)
    const halfYaw = yaw * 0.5
    rb.setTranslation({ x: a.x, y: a.y + 1.5, z: a.z }, true)
    rb.setRotation({ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) }, true)
    rb.setLinvel({ x: dx * 0.6, y: 0, z: dz * 0.6 }, true)
    const intent = ControlIntentStore.get(eid)
    if (intent) ControlIntentStore.set(eid, { ...intent, throttle: 1 })
  }
}
