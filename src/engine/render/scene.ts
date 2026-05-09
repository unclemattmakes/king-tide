import * as THREE from 'three'
import { createSkyDome } from './sky'

/**
 * M6 scene: gradient sky + lighting. Water + bikes + pickups + per-track
 * terrain (island, mesa, ramps, .glb meshes) are added by their respective
 * systems / per-track setup in `main.ts`.
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
  // Shadow map: orthographic frustum sized to follow the player (main.ts
  // re-positions sun + target each frame). ±90 m covers the visible play
  // area at any reasonable elevation; 2048² gives ~9 cm/texel — crisp
  // enough for bike + prop shadows without tanking GPU cost.
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = 500
  sun.shadow.camera.left = -90
  sun.shadow.camera.right = 90
  sun.shadow.camera.top = 90
  sun.shadow.camera.bottom = -90
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.05
  scene.add(sun)
  // Target must be in the scene for its world matrix to update when
  // main.ts moves it to track the player.
  scene.add(sun.target)

  return { scene, camera, sun }
}
