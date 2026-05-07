import * as THREE from 'three'

/**
 * M1 scene: lighting, sky, and a flat ground that visually matches the
 * physics ground collider. The bike mesh is added separately by the bike
 * render system.
 */
export function createScene(): {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
} {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x12161c)
  scene.fog = new THREE.Fog(0x12161c, 80, 400)

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 1000)
  camera.position.set(0, 4, -10)
  camera.lookAt(0, 1, 0)
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
  })

  // Lighting
  scene.add(new THREE.HemisphereLight(0xbbddff, 0x223040, 0.8))
  const sun = new THREE.DirectionalLight(0xffeecc, 1.0)
  sun.position.set(40, 60, 20)
  scene.add(sun)

  // Ground (matches Rapier static cuboid at y=-0.5..0)
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1000, 1000),
    new THREE.MeshStandardMaterial({ color: 0x3a4654, roughness: 0.95 }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.y = 0
  scene.add(ground)

  // Reference grid so motion is readable
  const grid = new THREE.GridHelper(800, 80, 0x66aaff, 0x33445a)
  grid.position.y = 0.01
  scene.add(grid)

  return { scene, camera }
}
