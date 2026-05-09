import * as THREE from 'three'
import { clamp, dot, max, mix, normalize, positionWorld, pow, uniform, vec3 } from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

/**
 * Vertical gradient sky implemented as a large inverted sphere.
 * Cheap (no atmospheric scattering), looks fine for an arcade racer, and
 * provides clear visual separation between sea and horizon.
 *
 * Implemented as a TSL node material so it works under both backends of
 * the unified `WebGPURenderer` (WebGPU + WebGL2 fallback). The legacy
 * `THREE.ShaderMaterial` is incompatible with WebGPURenderer's node-based
 * pipeline.
 */
export function createSkyDome(): THREE.Mesh {
  const topColor = new THREE.Color(0x0a1a30) // deep blue
  const horizonColor = new THREE.Color(0xa6c8e8) // hazy pale blue
  const sunGlow = new THREE.Color(0xffd9a8)

  const uTopColor = uniform(vec3(topColor.r, topColor.g, topColor.b))
  const uHorizonColor = uniform(vec3(horizonColor.r, horizonColor.g, horizonColor.b))
  const uSunDir = uniform(new THREE.Vector3(0.5, 0.45, 0.7).normalize())
  const uSunColor = uniform(vec3(sunGlow.r, sunGlow.g, sunGlow.b))

  // The dome is centered at world origin with identity rotation, so
  // positionWorld at each fragment is the world-space position of the
  // sphere surface. Normalizing gives the view direction from origin.
  const worldDir = normalize(positionWorld)
  const h = clamp(worldDir.y, 0.0, 1.0)
  const baseCol = mix(uHorizonColor, uTopColor, pow(h, 0.55))
  const sunDot = max(dot(worldDir, uSunDir), 0.0)
  const sunHighlight = uSunColor.mul(pow(sunDot, 8.0).mul(0.45))

  const material = new MeshBasicNodeMaterial({
    side: THREE.BackSide,
    depthWrite: false,
  })
  material.colorNode = baseCol.add(sunHighlight)

  // Big enough to encompass the whole arena (water is 800m wide).
  const geom = new THREE.SphereGeometry(2000, 32, 16)
  const mesh = new THREE.Mesh(geom, material as unknown as THREE.Material)
  mesh.name = 'sky'
  mesh.frustumCulled = false
  return mesh
}
