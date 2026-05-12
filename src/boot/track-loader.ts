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
 * In edit mode (`?edit=1`) we skip environment visuals (the editor
 * provides its own viewport) and fall back to an empty draft track if
 * neither JSON nor GLB exists yet — the user authors from scratch.
 *
 * Safety floor (universal backstop collider at y = 0) is created up
 * front so anything that bricks during track build still has ground.
 */

import type * as THREE from 'three'
import { createIslandMesh } from '@/engine/render/arena-mesh'
import { createCliffsideMesh } from '@/engine/render/cliffside-mesh'
import { attachTrackColliders, loadGlbTrackVisuals } from '@/engine/render/glb-track'
import { createRampMesh } from '@/engine/render/ramp-mesh'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { createLagoonIsland, createSafetyFloor } from '@/game/entities/arena'
import { createCliffsideTerrain } from '@/game/entities/cliffside-terrain'
import { createRamp } from '@/game/entities/ramp'
import { createCliffside } from '@/game/tracks/cliffside'
import { loadTrackFromGlb } from '@/game/tracks/glb-loader'
import { buildTrackFromJson } from '@/game/tracks/json-loader'
import { createLagoonLoop } from '@/game/tracks/lagoon-loop'
import type { Track } from '@/game/tracks/types'
import { emptyDraftTrack } from './utils'

export async function loadTrackForBoot(opts: {
  trackId: string
  scene: THREE.Scene
  phys: PhysicsWorld
  editMode: boolean
}): Promise<Track> {
  const { trackId, scene, phys, editMode } = opts

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
    scene.add(createIslandMesh())
    createRamp(phys)
    scene.add(createRampMesh())
  }

  if (trackId === 'cliffside') return createCliffside()
  if (trackId === 'lagoon') return createLagoonLoop()

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
    if (track.environmentGlb && !editMode) {
      const env = await loadGlbTrackVisuals(track.environmentGlb, {
        terrainShader: track.terrainShader,
      })
      scene.add(env.scene)
      attachTrackColliders(env.scene, phys)
    }
    return track
  }
  if (!jsonRes.ok && jsonRes.status !== 404) {
    throw new Error(`track: fetch ${jsonUrl} failed: ${jsonRes.status} ${jsonRes.statusText}`)
  }

  // No JSON. Two paths:
  //   - GLB exists: load it as the legacy all-in-glb track.
  //   - Edit mode + no GLB: stub an empty draft so the editor can
  //     open a fresh track for the user to author. Saving from the
  //     editor materialises `public/tracks/<id>.json`.
  const glbUrl = `/assets/tracks/${trackId}.glb`
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
    if (!editMode) {
      const env = await loadGlbTrackVisuals(glbUrl)
      scene.add(env.scene)
      attachTrackColliders(env.scene, phys)
    }
    return track
  }
  if (editMode) {
    return emptyDraftTrack(trackId)
  }
  throw new Error(`track: no JSON at ${jsonUrl} and no GLB at ${glbUrl}`)
}
