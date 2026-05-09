import * as THREE from 'three'
import { createIslandMesh } from './arena-mesh'
import { createSkyDome } from './sky'

/**
 * M6 scene: gradient sky + lighting + island. Water + bikes + pickups are
 * added by their respective systems.
 *
 * The directional `sun` light is returned so the day-night cycle in
 * `main.ts` can animate its position over the race timeline (and keep the
 * water shader's `sunDirUniform` in sync via `waterMesh.setSunDirection`).
 */
export function createScene(): {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  sun: THREE.DirectionalLight
} {
  const scene = new THREE.Scene()
  // Fog blends with horizon — color picked to match the sky's horizon hue.
  scene.fog = new THREE.Fog(0x9ec1e0, 250, 900)

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 3000)
  camera.position.set(0, 6, -14)
  camera.lookAt(0, 3, 0)
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
  })

  scene.add(createSkyDome())

  scene.add(new THREE.HemisphereLight(0xa6c8e8, 0x223040, 0.85))
  const sun = new THREE.DirectionalLight(0xfff2dc, 1.4)
  sun.position.set(50, 70, 70) // matches sky's uSunDir roughly; animated over time by sunCycleSystem
  scene.add(sun)

  scene.add(createIslandMesh())

  return { scene, camera, sun }
}
