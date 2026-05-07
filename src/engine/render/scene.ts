import * as THREE from 'three'
import { createIslandMesh } from './arena-mesh'

/**
 * M2 scene: lighting + sky + island mesh. Water + bikes are added by their
 * respective systems.
 */
export function createScene(): {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
} {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x1a2f48)
  scene.fog = new THREE.Fog(0x1a2f48, 90, 380)

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 1500)
  camera.position.set(0, 6, -14)
  camera.lookAt(0, 3, 0)
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
  })

  scene.add(new THREE.HemisphereLight(0x88bbff, 0x223040, 0.7))
  const sun = new THREE.DirectionalLight(0xffeecc, 1.2)
  sun.position.set(40, 80, 30)
  scene.add(sun)

  scene.add(createIslandMesh())

  return { scene, camera }
}
