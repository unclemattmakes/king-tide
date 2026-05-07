import * as THREE from 'three'
import { sampleSurface, type WaveFieldState } from '@/engine/sim/water/wave-field'

export type WaterMesh = {
  mesh: THREE.Mesh
  tick(): void
  dispose(): void
}

/**
 * CPU-driven water mesh. Vertex Y + normal updated each frame from the same
 * `sampleSurface` math the buoyancy system uses — single source of truth for
 * visuals + physics.
 *
 * Visual approach: faceted (flatShading=true) so each triangle gets a single
 * per-face normal. Combined with low roughness + a touch of metalness, the
 * sun catches individual facets and produces sparkle-on-the-water highlights
 * — much more readable than smooth-normal water at this distance.
 */
export function createWaterMesh(
  field: WaveFieldState,
  opts?: { size?: number; subdivisions?: number },
): WaterMesh {
  const size = opts?.size ?? 240
  const subs = opts?.subdivisions ?? 80

  const geom = new THREE.PlaneGeometry(size, size, subs, subs)
  geom.rotateX(-Math.PI / 2)

  const mat = new THREE.MeshStandardMaterial({
    color: 0x1f5f8a,
    roughness: 0.28,
    metalness: 0.25,
    flatShading: true,
    envMapIntensity: 0.8,
  })

  const mesh = new THREE.Mesh(geom, mat)
  mesh.name = 'water'
  mesh.position.y = 0

  const positions = geom.attributes.position as THREE.BufferAttribute
  const normals = geom.attributes.normal as THREE.BufferAttribute
  const count = positions.count

  const baseX = new Float32Array(count)
  const baseZ = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    baseX[i] = positions.getX(i)
    baseZ[i] = positions.getZ(i)
  }

  function tick() {
    const posArr = positions.array as Float32Array
    for (let i = 0; i < count; i++) {
      const s = sampleSurface(field, baseX[i]!, baseZ[i]!)
      posArr[i * 3 + 1] = s.y
    }
    positions.needsUpdate = true
    // For faceted shading we let Three.js compute per-face normals from the
    // displaced vertices — gives cleaner specular highlights than per-vertex
    // wave normals because each facet picks up the sun in a way that varies
    // sharply across the surface.
    geom.computeVertexNormals()
    normals.needsUpdate = true
  }

  function dispose() {
    geom.dispose()
    mat.dispose()
  }

  tick()

  return { mesh, tick, dispose }
}
