import * as THREE from 'three'

/**
 * Generic per-entity mesh-lifecycle helper used by render systems that
 * follow the same pattern:
 *
 *   1. Query a set of sim entities each frame.
 *   2. Lazily create a THREE.Object3D per eid (factory).
 *   3. Update each mesh from the entity's current state (update).
 *   4. Dispose meshes whose entities have gone away.
 *
 * Extracted from `combat-render.ts`, which had four near-identical
 * blocks (mines, missiles, shields, explosions). Callers pass the live
 * `eids` iterable from their own `query()` call so they keep full
 * control over component selection and any extra filtering.
 *
 * `filter` is an optional secondary predicate — used by shield rendering
 * to skip bikes whose ShieldEffect timer is exhausted before allocating
 * a mesh for them.
 */
// Per-meshes-map scratch Set, reused across calls. Each `meshes` Map gets
// its own Set so concurrent callers (combat-render runs four lifecycle
// blocks in one frame, each with its own map) don't share state. WeakMap
// keying so the scratch is GC'd alongside its owning map.
const SCRATCH_LIVE = new WeakMap<Map<number, THREE.Object3D>, Set<number>>()

export function syncEntityMeshes(opts: {
  scene: THREE.Scene
  meshes: Map<number, THREE.Object3D>
  eids: Iterable<number>
  factory: (eid: number) => THREE.Object3D
  update: (mesh: THREE.Object3D, eid: number) => void
  filter?: (eid: number) => boolean
}): void {
  const { scene, meshes, eids, factory, update, filter } = opts
  let live = SCRATCH_LIVE.get(meshes)
  if (!live) {
    live = new Set<number>()
    SCRATCH_LIVE.set(meshes, live)
  } else {
    live.clear()
  }
  for (const eid of eids) {
    if (filter && !filter(eid)) continue
    live.add(eid)
    let mesh = meshes.get(eid)
    if (!mesh) {
      mesh = factory(eid)
      scene.add(mesh)
      meshes.set(eid, mesh)
    }
    update(mesh, eid)
  }
  for (const [eid, mesh] of meshes) {
    if (!live.has(eid)) {
      scene.remove(mesh)
      disposeMesh(mesh)
      meshes.delete(eid)
    }
  }
}

/** Recursively dispose a THREE.Object3D's geometries + materials. */
export function disposeMesh(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose()
      const m = child.material
      if (Array.isArray(m)) {
        for (const mm of m) mm.dispose()
      } else if (m) {
        m.dispose()
      }
    }
  })
}
