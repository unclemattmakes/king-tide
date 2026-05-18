import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { ExportedKind } from '@/engine/asset-kinds'
import { applyTerrainShaderToScene } from '@/engine/render/terrain-shader'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { GltfRoot } from '@/game/tracks/glb-loader'
import type { TerrainShaderConfig } from '@/game/tracks/types'

/**
 * Render-side .glb track loader. Wraps Three.GLTFLoader so we get one fetch
 * that produces (a) the visual scene group and (b) the parsed glTF JSON so
 * the sim-side Track builder can run on the same data without a second
 * fetch.
 *
 * Why split this from src/game/tracks/glb-loader.ts: the sim layer has to
 * stay Three-free per the architecture rule. The sim-side loader parses
 * the .glb's JSON chunk manually. This file pulls in Three.js for the
 * visual side only; main.ts wires the two together.
 */
export type LoadedGlbTrack = {
  /** Add this to the Three scene to render the track meshes. */
  scene: THREE.Group
  /** Parsed glTF JSON, suitable for buildTrackFromGltf(). */
  parsedJson: GltfRoot
  /** If the GLB shipped a `kind=horizon` mesh, its geometry — already
   *  detached from the main scene so the regular render path doesn't
   *  draw it as a piece of nearby terrain. Pass this into
   *  `createHorizonRing` (via `HorizonRingConfig.geometry`) so the
   *  shipped silhouette gets the camera-locked sun-aware shader.
   *  Absent when no horizon mesh was authored. */
  horizonGeometry?: THREE.BufferGeometry
}

export async function loadGlbTrackVisuals(
  url: string,
  opts?: { terrainShader?: TerrainShaderConfig },
): Promise<LoadedGlbTrack> {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(url)
  const parsedJson = (gltf.parser as unknown as { json: GltfRoot }).json
  const scene = gltf.scene as unknown as THREE.Group

  // Pull any `kind=horizon` meshes out of the scene graph before the
  // shadow / shader passes run. They live 1.4 km away and are driven
  // by `createHorizonRing` — leaving them in the regular scene would
  // (a) shadow-cast nothing useful, (b) pick up the terrain shader
  // (wrong material), (c) register as a collider via `attachTrackColliders`,
  // and (d) double-render under the procedural ring. Detach all four
  // problems in one pass.
  let horizonGeometry: THREE.BufferGeometry | undefined
  const horizonNodes: THREE.Mesh[] = []
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.userData?.kind === ExportedKind.HORIZON) {
      horizonNodes.push(obj)
    }
  })
  for (const node of horizonNodes) {
    // Bake world transform into vertex positions so the geometry lands
    // at scene origin regardless of the author's transform on the
    // `horizon_ring` object — `createHorizonRing` re-positions the
    // mesh per-frame to follow the player, so any stored translation
    // would multiply on top.
    node.updateMatrixWorld(true)
    const baked = node.geometry.clone() as THREE.BufferGeometry
    baked.applyMatrix4(node.matrixWorld)
    // First horizon mesh wins; warn loudly on extras so authors don't
    // silently lose one (the kind is meant to be singular per track).
    if (!horizonGeometry) {
      horizonGeometry = baked
    } else {
      console.warn(
        `[glb-track] ${url}: multiple kind="horizon" meshes — using the first, ignoring the rest`,
      )
    }
    node.parent?.remove(node)
  }

  // Track environment is the dominant shadow receiver in any race —
  // and chunky meshes (mesa edges, hangar walls, ramps) should also
  // throw shadow themselves. Flag every mesh; we don't try to be
  // clever about decoration vs collision since the visual cost is
  // tied to the bike+sun shadow camera, not the per-mesh count.
  // Emitter "empties" sometimes round-trip as small placeholder meshes
  // through the glTF exporter — hide them from render so authors don't
  // see a stray cube at every emit point; the particle system still
  // finds them via the kind=emitter tag.
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh) {
      if (obj.userData?.kind === ExportedKind.EMITTER) {
        mesh.visible = false
        mesh.castShadow = false
        mesh.receiveShadow = false
        return
      }
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
  })
  // Replace the stock baseColor on every authored-as-terrain mesh with
  // the slope/altitude shader (see terrain-shader.ts). glTF can't carry
  // Blender's shader graph, so without this the runtime terrain reads
  // as a flat constant colour — the slope-aware look from the .blend
  // preview is recomputed per-fragment here. ``opts.terrainShader`` is
  // the optional per-track override block from
  // ``public/tracks/<id>.json`` — when present, the addon authored
  // these values in its "Terrain shader (runtime)" panel.
  applyTerrainShaderToScene(scene, opts?.terrainShader ?? {})
  return {
    scene,
    parsedJson,
    ...(horizonGeometry ? { horizonGeometry } : {}),
  }
}

/**
 * Walk the loaded scene and create a static Rapier trimesh collider for
 * every mesh, mirroring its world-space geometry. Opt-out: tag a mesh with
 * custom property `kind = "decoration"` in Blender to make it render-only.
 * (Pre-2026-05 the rule was opt-IN via `kind = "track"`; we flipped it
 * because decorative-only meshes are the rare case.)
 *
 * The track group should already be added to the scene (or its world
 * matrix manually updated) before calling.
 */
export function attachTrackColliders(group: THREE.Object3D, phys: PhysicsWorld): number {
  group.updateMatrixWorld(true)
  let attached = 0
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    if (obj.userData?.kind === 'decoration') return
    // Belt-and-suspenders: `loadGlbTrackVisuals` strips horizon meshes
    // out of the scene before we get here, but check anyway in case
    // `attachTrackColliders` is called directly with an un-stripped
    // group. Horizon rings live 1.4 km away and never collide.
    if (obj.userData?.kind === ExportedKind.HORIZON) return
    // Particle emitters are empties in Blender that occasionally get
    // converted to placeholder meshes by the exporter (cube primitive
    // as a viewport gizmo). Either way the particle system reads them
    // for spawn poses, not as collidable geometry — skip the trimesh
    // attach. Mesh stays in the scene graph so the particle-system
    // traversal finds the kind=emitter tag.
    if (obj.userData?.kind === ExportedKind.EMITTER) return
    // EXT_mesh_gpu_instancing produces THREE.InstancedMesh — scattered
    // props from Blender's GN scatter pipeline land here. The mesh's
    // matrixWorld is the prototype's transform, not the per-instance
    // transforms (those live in instanceMatrix). Registering one
    // trimesh against the prototype transform would put a single
    // collider in the wrong place. Per the Item 4 V1 scope in
    // docs/blender-wishlist.md, scatter is render-only by default;
    // a future `kind = "collidable_scatter"` extra can opt in by
    // iterating instanceMatrix here.
    if (obj instanceof THREE.InstancedMesh) return

    const geom = obj.geometry as THREE.BufferGeometry
    const posAttr = geom.attributes.position
    if (!posAttr) return

    // Bake mesh transform into vertex positions so the static trimesh
    // sits exactly where the visual mesh sits.
    const v = new THREE.Vector3()
    const mw = obj.matrixWorld
    const worldVerts = new Float32Array(posAttr.count * 3)
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(mw)
      worldVerts[i * 3] = v.x
      worldVerts[i * 3 + 1] = v.y
      worldVerts[i * 3 + 2] = v.z
    }

    // Double-sided index list (each triangle emitted both windings).
    // Rapier trimeshes are one-sided; if Blender's normals point the wrong
    // way relative to the bike's approach, the raycast misses. Doubling
    // the triangles is orientation-independent and cheap for static terrain.
    let baseIndices: ArrayLike<number>
    let baseLen: number
    const index = geom.index
    if (index) {
      baseIndices = index.array
      baseLen = index.array.length
    } else {
      const synth = new Uint32Array(posAttr.count)
      for (let i = 0; i < posAttr.count; i++) synth[i] = i
      baseIndices = synth
      baseLen = synth.length
    }
    const indices = new Uint32Array(baseLen * 2)
    for (let i = 0; i < baseLen; i += 3) {
      const a = baseIndices[i] as number
      const b = baseIndices[i + 1] as number
      const c = baseIndices[i + 2] as number
      indices[i] = a
      indices[i + 1] = b
      indices[i + 2] = c
      indices[baseLen + i] = a
      indices[baseLen + i + 1] = c
      indices[baseLen + i + 2] = b
    }

    const rbDesc = phys.rapier.RigidBodyDesc.fixed()
    const rb = phys.world.createRigidBody(rbDesc)
    // Friction is low (0.08) because a hoverbike is supposed to ride ABOVE
    // the trimesh, not on it. Lateral grip is provided by `lateralDrag` in
    // the sim, not by Rapier contact friction. The only times the capsule
    // actually touches the trimesh are incidental — clipping a ramp's
    // leading edge on a steep slope-change, scraping a wall, etc. With
    // grippy friction (the old 0.6) those incidents convert ~half the
    // bike's forward momentum into vertical bounce via friction's
    // tangent-component coupling, which makes the bike crawl to a near-
    // stop on any steep slope transition (measured on the 25° ramp in
    // slope-test: 23 m/s → 9 m/s in 150 ms). Low friction lets the
    // capsule slide along the contact tangent so forward speed survives
    // even if hover briefly fails to lift the chassis above the surface.
    const colDesc = phys.rapier.ColliderDesc.trimesh(worldVerts, indices)
      .setFriction(0.08)
      .setRestitution(0.05)
    phys.world.createCollider(colDesc, rb)
    attached += 1
  })
  return attached
}
