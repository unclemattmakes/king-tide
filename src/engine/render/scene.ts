import * as THREE from 'three'

/**
 * M0 placeholder scene: a checkered floor + skydome + slowly rotating cube
 * to prove the render loop is alive.
 */
export function createPlaceholderScene(): {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  tick: (dt: number) => void
} {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x12161c)
  scene.fog = new THREE.Fog(0x12161c, 50, 250)

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000)
  camera.position.set(6, 4, 10)
  camera.lookAt(0, 1, 0)
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
  })

  const hemi = new THREE.HemisphereLight(0xbbddff, 0x223040, 0.7)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xffeecc, 1.0)
  sun.position.set(20, 30, 10)
  scene.add(sun)

  // Checkered floor — stand-in for "ground"
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x445566, roughness: 0.9 }),
  )
  floor.rotation.x = -Math.PI / 2
  scene.add(floor)
  const grid = new THREE.GridHelper(200, 40, 0x66aaff, 0x334455)
  grid.position.y = 0.01
  scene.add(grid)

  // Spinning cube — proves frames are advancing
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 1.5, 1.5),
    new THREE.MeshStandardMaterial({ color: 0xff7733, roughness: 0.4 }),
  )
  cube.position.set(0, 1.5, 0)
  scene.add(cube)

  const tick = (dt: number) => {
    cube.rotation.y += dt * 0.6
    cube.rotation.x += dt * 0.3
  }

  return { scene, camera, tick }
}
