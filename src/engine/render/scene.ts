import * as THREE from 'three'
import { createSkyDome } from './sky'

/**
 * M6 scene: gradient sky + lighting. Water + bikes + pickups + per-track
 * terrain (island, mesa, ramps, .glb meshes) are added by their respective
 * systems.
 */
export function createScene(): {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
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
  sun.position.set(50, 70, 70) // matches sky's uSunDir roughly
  scene.add(sun)

  return { scene, camera }
}
