/**
 * Track-loading branch of the boot sequence. Handles three sources:
 *
 *   1. Procedural — `lagoon` (default) and `cliffside` are baked into
 *      the codebase. Their terrain (collider + mesh) is created in code.
 *   2. JSON — anything served from `/tracks/<id>.json` (typically
 *      authored via the in-app editor). Optional `environmentGlb`
 *      pulls in environment visuals + static colliders.
 *   3. GLB — legacy hand-authored tracks at `/assets/tracks/<id>.glb`.
 *      Treated as the "all-in-glb" pipeline; environment visuals
 *      load from the same file.
 *
 * In edit mode (`?edit=1`) we still load environment visuals + bake the
 * terrain heightmap (so the author sees real terrain, shoaling water, and
 * the material waterline) but skip the static colliders — the editor runs
 * no physics. A missing/not-yet-exported env GLB degrades gracefully in
 * edit mode rather than bricking the editor. We fall back to an empty draft
 * track if neither JSON nor GLB exists yet — the user authors from scratch.
 *
 * Safety floor (universal backstop collider at y = 0) is created up
 * front so anything that bricks during track build still has ground.
 */

import * as THREE from 'three'
import { assetUrl } from '@/engine/asset-url'
import { createIslandMesh } from '@/engine/render/arena-mesh'
import { createCliffsideMesh } from '@/engine/render/cliffside-mesh'
import { type CollisionCorridor, makeCollisionCorridor } from '@/engine/render/collision-corridor'
import {
  attachTrackColliders,
  loadColliderProxy,
  loadGlbTrackVisuals,
} from '@/engine/render/glb-track'
import { createRampMesh } from '@/engine/render/ramp-mesh'
import { gateShadowCaster, resolveShadowCastMinRadius } from '@/engine/render/shadow-caster-gate'
import { buildTerrainHeightmap, type TerrainHeightmap } from '@/engine/render/terrain-heightmap'
import { WATER_REFLECTION_LAYER } from '@/engine/render/water'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { createLagoonIsland, createSafetyFloor } from '@/game/entities/arena'
import { createCliffsideTerrain } from '@/game/entities/cliffside-terrain'
import { createRamp } from '@/game/entities/ramp'
import { leashFor } from '@/game/systems/out-of-bounds'
import { createCliffside } from '@/game/tracks/cliffside'
import { loadTrackFromGlb } from '@/game/tracks/glb-loader'
import { buildTrackFromJson } from '@/game/tracks/json-loader'
import { createLagoonLoop } from '@/game/tracks/lagoon-loop'
import type { Track } from '@/game/tracks/types'
import { emptyDraftTrack } from './utils'

/**
 * Corridor used to clip out-of-bounds geometry from the static collision
 * (collision-corridor.ts). Built from the track's racing line + the
 * out-of-bounds hard-leash, so collision is only dropped where the bike would
 * already be dead. Null when the track has no usable line (collide everything)
 * or when disabled via `?clipcollision=0`.
 */
function collisionCorridorFor(track: Track): CollisionCorridor | null {
  if (typeof window !== 'undefined') {
    if (new URLSearchParams(window.location.search).get('clipcollision') === '0') return null
  }
  const leash = leashFor(track)
  if (!leash) return null
  return makeCollisionCorridor(leash.points, leash.hard)
}

export type LoadedTrack = {
  track: Track
  /** Top-down max-Y heightmap of all static terrain in the track, used by
   *  the water shader to attenuate wave displacement in shallows and drive
   *  surf foam. Baked in BOTH race and edit mode now (the editor renders the
   *  environment). Null only for the empty-draft fallback (no terrain to
   *  sample) or when an env GLB failed to load in edit mode. */
  terrainHeightmap: TerrainHeightmap | null
  /** Author-supplied horizon mesh geometry pulled out of the track's GLB
   *  (any mesh tagged `kind=horizon`). Forwarded to `createHorizonRing`
   *  so the bespoke silhouette replaces the procedural fallback. Absent
   *  when the GLB shipped no horizon mesh (or the track has no GLB). */
  horizonGeometry?: THREE.BufferGeometry
  /** Loaded environment-GLB scene root, when present. Boot scans this
   *  for `kind=emitter` nodes and hands them to the particle system.
   *  Absent for procedural tracks (lagoon, cliffside) and for the
   *  empty-draft editor fallback. */
  environmentGlbRoot?: THREE.Object3D
}

export async function loadTrackForBoot(opts: {
  trackId: string
  scene: THREE.Scene
  phys: PhysicsWorld
  editMode: boolean
}): Promise<LoadedTrack> {
  const { trackId, scene, phys, editMode } = opts

  // Universal: backstop floor for any track.
  createSafetyFloor(phys)

  // Collects every render-side terrain root added below so we can bake a
  // single combined heightmap at the end. Each entry is a THREE.Object3D
  // whose world-baked geometry the heightmap walks.
  const terrainRoots: THREE.Object3D[] = []

  // Opt landmark-scale meshes into the water mirror's layer, then bake the
  // heightmap — both walk the same finished terrainRoots, so every track
  // path funnels through here right before returning. The water reflection
  // renders ONLY sky + this opt-in set (water.ts WATER_REFLECTION_LAYER):
  // terrain islands + monumental landmarks clear the size gate and keep
  // their mirrored silhouettes; small dressing / props / streamed scenery
  // stay out, which is what keeps the mirror pass from re-encoding the
  // scene (the water-ablation finding — ~98 extra draw calls on sandbar).
  const bakeHeightmapAndMarkReflections = (waterLevel: number) => {
    const REFLECT_MIN_RADIUS_M = 25
    // Shadow-caster size gate — same walk, inverted polarity: reflections
    // opt the big things IN, shadows opt the small things OUT. The sun's
    // depth pass pays per CASTER (mexico-city's ~477 dressing casters were
    // its whole ~6.5 ms CPU gap; map resolution measured free) — see
    // shadow-caster-gate.ts + docs/perf-baseline.md. `?shadowcast=0` = legacy.
    const shadowMinR = resolveShadowCastMinRadius()
    let castersSeen = 0
    let castersGated = 0
    const worldScale = new THREE.Vector3()
    for (const root of terrainRoots) {
      root.updateMatrixWorld(true)
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh || !m.geometry) return
        const geo = m.geometry as THREE.BufferGeometry
        if (!geo.boundingSphere) geo.computeBoundingSphere()
        worldScale.setFromMatrixScale(m.matrixWorld)
        const worldR =
          (geo.boundingSphere?.radius ?? 0) * Math.max(worldScale.x, worldScale.y, worldScale.z)
        if (worldR >= REFLECT_MIN_RADIUS_M) m.layers.enable(WATER_REFLECTION_LAYER)
        if (m.castShadow) castersSeen++
        if (gateShadowCaster(m, worldR, shadowMinR)) castersGated++
      })
    }
    if (castersGated > 0) {
      // eslint-disable-next-line no-console
      console.info(
        `[shadow-gate] ${castersGated}/${castersSeen} static casters below ${shadowMinR} m stop casting`,
      )
    }
    return buildTerrainHeightmap(terrainRoots, { waterLevel })
  }

  // Per-track terrain (physics + visuals). Procedural tracks build their
  // own terrain in code; .glb-backed tracks load mesh + collider geometry
  // straight from the asset.
  if (trackId === 'cliffside') {
    createCliffsideTerrain(phys)
    const m = createCliffsideMesh()
    scene.add(m)
    terrainRoots.push(m)
  } else if (trackId === 'lagoon') {
    createLagoonIsland(phys)
    const island = createIslandMesh()
    scene.add(island)
    terrainRoots.push(island)
    createRamp(phys)
    const ramp = createRampMesh()
    scene.add(ramp)
    terrainRoots.push(ramp)
  }

  if (trackId === 'cliffside') {
    const track = createCliffside()
    return {
      track,
      terrainHeightmap: bakeHeightmapAndMarkReflections(track.water?.height ?? 0),
    }
  }
  if (trackId === 'lagoon') {
    const track = createLagoonLoop()
    return {
      track,
      terrainHeightmap: bakeHeightmapAndMarkReflections(track.water?.height ?? 0),
    }
  }

  // Try a JSON-authored track first (gameplay data from the in-app
  // editor or hand-edited spec). On 404, fall back to a hand-authored
  // Blender export at the conventional GLB path so anything produced
  // by `tools/export_track.py` is playable via `?track=<id>` without
  // a per-track branch here.
  const jsonUrl = `/tracks/${trackId}.json`
  const jsonRes = await fetch(jsonUrl)
  // Vite's SPA fallback returns 200 + index.html for missing static
  // files, so a "real" JSON track has to be both 200 AND served as
  // application/json. Anything else falls through to the GLB / draft
  // path below as a missing track.
  const jsonContentType = jsonRes.headers.get('content-type') ?? ''
  const jsonExists = jsonRes.ok && jsonContentType.includes('json')
  if (jsonExists) {
    const track = buildTrackFromJson(JSON.parse(await jsonRes.text()))
    let horizonGeometry: THREE.BufferGeometry | undefined
    let environmentGlbRoot: THREE.Object3D | undefined
    if (track.environmentGlb) {
      // Edit mode now renders the environment too (so the author sees real
      // terrain/buildings + the waterline + shoaling water, not a bare
      // plane). A missing / not-yet-exported GLB must NOT brick the editor,
      // so the load degrades gracefully there; in the race path it stays a
      // hard error.
      try {
        const env = await loadGlbTrackVisuals(assetUrl(track.environmentGlb), {
          // Anchor the terrain wet band + underwater tint to the real water
          // surface (not y=0) by threading the track's water height in.
          terrainShader: { ...track.terrainShader, waterLevel: track.water?.height ?? 0 },
        })
        scene.add(env.scene)
        // Collision is race-only — the editor runs no physics, so skip the
        // (expensive) trimesh BVH build entirely in edit mode. Prefer a
        // shipped decimated proxy (`<glb>-collider.glb`, built by
        // tools/blender/build_track_collider.py) so Rapier's BVH builds over
        // a fraction of the render mesh's triangles — the bulk of the
        // `track+env` boot cost — falling back to the render geometry. The
        // heightmap below still bakes from the high-poly mesh in BOTH modes,
        // so water shoaling + the waterline read identically in the editor.
        if (!editMode) {
          const colliderProxy = await loadColliderProxy(
            assetUrl(track.environmentGlb.replace(/\.glb$/i, '-collider.glb')),
          )
          attachTrackColliders(colliderProxy ?? env.scene, phys, collisionCorridorFor(track))
        }
        terrainRoots.push(env.scene)
        horizonGeometry = env.horizonGeometry
        environmentGlbRoot = env.scene
      } catch (e) {
        if (!editMode) throw e
        // eslint-disable-next-line no-console
        console.warn(
          `[editor] environment GLB failed to load (${track.environmentGlb}); authoring without it`,
          e,
        )
      }
    }
    return {
      track,
      terrainHeightmap: bakeHeightmapAndMarkReflections(track.water?.height ?? 0),
      ...(horizonGeometry ? { horizonGeometry } : {}),
      ...(environmentGlbRoot ? { environmentGlbRoot } : {}),
    }
  }
  if (!jsonRes.ok && jsonRes.status !== 404) {
    throw new Error(`track: fetch ${jsonUrl} failed: ${jsonRes.status} ${jsonRes.statusText}`)
  }

  // No JSON. Two paths:
  //   - GLB exists: load it as the legacy all-in-glb track.
  //   - Edit mode + no GLB: stub an empty draft so the editor can
  //     open a fresh track for the user to author. Saving from the
  //     editor materialises `public/tracks/<id>.json`.
  const glbUrl = assetUrl(`/assets/tracks/${trackId}.glb`)
  const glbHead = await fetch(glbUrl, { method: 'HEAD' })
  const glbContentType = glbHead.headers.get('content-type') ?? ''
  const glbExists =
    glbHead.ok &&
    (glbContentType.includes('octet-stream') ||
      glbContentType.includes('gltf') ||
      glbContentType.includes('binary'))
  if (glbExists) {
    const track = await loadTrackFromGlb(glbUrl, {
      id: trackId,
      name: trackId,
      lapsToFinish: 3,
    })
    let horizonGeometry: THREE.BufferGeometry | undefined
    let environmentGlbRoot: THREE.Object3D | undefined
    // Render the environment in edit mode too; collision stays race-only.
    const env = await loadGlbTrackVisuals(glbUrl, {
      terrainShader: { waterLevel: track.water?.height ?? 0 },
    })
    scene.add(env.scene)
    if (!editMode) {
      // Same decimated-collision-proxy preference as the JSON-track path above,
      // with the corridor clip applied to whichever mesh we collide.
      const colliderProxy = await loadColliderProxy(glbUrl.replace(/\.glb$/i, '-collider.glb'))
      attachTrackColliders(colliderProxy ?? env.scene, phys, collisionCorridorFor(track))
    }
    terrainRoots.push(env.scene)
    horizonGeometry = env.horizonGeometry
    environmentGlbRoot = env.scene
    return {
      track,
      terrainHeightmap: bakeHeightmapAndMarkReflections(track.water?.height ?? 0),
      ...(horizonGeometry ? { horizonGeometry } : {}),
      ...(environmentGlbRoot ? { environmentGlbRoot } : {}),
    }
  }
  if (editMode) {
    return { track: emptyDraftTrack(trackId), terrainHeightmap: null }
  }
  throw new Error(`track: no JSON at ${jsonUrl} and no GLB at ${glbUrl}`)
}
