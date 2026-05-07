import * as THREE from 'three'
import { sampleSurface, type WaveFieldState } from '@/engine/sim/water/wave-field'

export type WaterMesh = {
  mesh: THREE.Mesh
  tick(): void
  dispose(): void
}

/**
 * CPU-driven water mesh. We update vertex Y + normal each frame from the
 * SAME `sampleSurface` math the buoyancy system uses — so visuals and physics
 * agree exactly without a separate shader implementation.
 *
 * Trade-off: ~4k vertices × 4 wave components is ~100k trig ops per frame,
 * trivial on any modern CPU. The win is cross-backend simplicity (works on
 * WebGL2 and WebGPU without a shader rewrite) and a single source of truth
 * for the wave field.
 */
export function createWaterMesh(
  field: WaveFieldState,
  opts?: { size?: number; subdivisions?: number },
): WaterMesh {
  const size = opts?.size ?? 240
  const subs = opts?.subdivisions ?? 64

  const geom = new THREE.PlaneGeometry(size, size, subs, subs)
  geom.rotateX(-Math.PI / 2) // XY plane → XZ plane

  const mat = new THREE.MeshStandardMaterial({
    color: 0x1c5680,
    roughness: 0.18,
    metalness: 0.05,
    flatShading: false,
  })

  const mesh = new THREE.Mesh(geom, mat)
  mesh.name = 'water'
  mesh.position.y = 0

  const positions = geom.attributes.position as THREE.BufferAttribute
  const normals = geom.attributes.normal as THREE.BufferAttribute

  // Cache original (x, z) per vertex — these don't change.
  const count = positions.count
  const baseX = new Float32Array(count)
  const baseZ = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    baseX[i] = positions.getX(i)
    baseZ[i] = positions.getZ(i)
  }

  function tick() {
    const posArr = positions.array as Float32Array
    const nrmArr = normals.array as Float32Array
    for (let i = 0; i < count; i++) {
      const s = sampleSurface(field, baseX[i]!, baseZ[i]!)
      const o = i * 3
      posArr[o + 1] = s.y // X and Z stay; only Y is displaced
      nrmArr[o] = s.nx
      nrmArr[o + 1] = s.ny
      nrmArr[o + 2] = s.nz
    }
    positions.needsUpdate = true
    normals.needsUpdate = true
  }

  function dispose() {
    geom.dispose()
    mat.dispose()
  }

  // Initial tick so the first frame shows waves, not a flat plane.
  tick()

  return { mesh, tick, dispose }
}
