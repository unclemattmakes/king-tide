import * as THREE from 'three'

/**
 * M6 scene: lighting + fog + camera. The sky dome and its day-night cycle
 * are owned by `createSkySystem` (see ./sky.ts) and added after the scene
 * exists, so this factory only sets up the long-lived render state that
 * other systems depend on (camera, sun light + shadow camera, hemisphere
 * ambient, fog instance).
 *
 * The directional `sun` and `hemi` lights are returned so the sky system
 * can animate them along the day-night cycle and so callers can wire up
 * shadow-following (sun.target tracks the player each tick).
 */
export function createScene(): {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  sun: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
} {
  const scene = new THREE.Scene()
  // Fog: the sky system overwrites colour + distances each tick from the
  // active palette / SkyConfig. The starting values match the historical
  // horizon blend so any frame before the first sky tick still looks sane.
  scene.fog = new THREE.Fog(0x9ec1e0, 250, 900)

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 3000)
  camera.position.set(0, 6, -14)
  camera.lookAt(0, 3, 0)
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
  })

  const hemi = new THREE.HemisphereLight(0xa6c8e8, 0x223040, 0.85)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(0xfff2dc, 1.4)
  sun.position.set(50, 70, 70) // sky system animates this; starting pose matches the original
  // Shadow map: orthographic frustum sized to follow the player (sky system
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
  // Target must be in the scene for its world matrix to update when the
  // sky system moves it to track the player.
  scene.add(sun.target)

  return { scene, camera, sun, hemi }
}
