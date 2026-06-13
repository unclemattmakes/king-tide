import * as THREE from 'three'
import { getActiveQuality } from './quality-preset'
import { WATER_REFLECTION_LAYER } from './water'

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
  // active palette / SkyConfig. Distances are tuned for the 512 m authored
  // track footprint (≈724 m corner-to-corner): geometry stays sharp through
  // the whole playable area (fog near at 500 m) and dissolves into the
  // horizon ring + sky between 500 m and 2200 m. Beyond 2200 m only the
  // sky dome and the horizon-ring silhouette remain, and the dome opts
  // out of fog so the haze never eats the gradient.
  scene.fog = new THREE.Fog(0x9ec1e0, 500, 2200)

  // Far plane 4000 m comfortably contains the 2000 m sky dome, the 1700 m
  // horizon ring, and the 2200 m fog cut-off with headroom. Shadow camera
  // far stays at 500 m (sized to the bike + nearby props), so the bump
  // here only costs depth precision — fine on the WebGPU 32-bit pipeline.
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 4000)
  camera.position.set(0, 6, -14)
  camera.lookAt(0, 3, 0)
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
  })

  // Lights pass a per-camera layer test (`light.layers.test(camera.layers)`),
  // and the water's mirror camera renders ONLY the opt-in reflection layer —
  // without these bits the mirror's terrain/landmarks draw unlit black and
  // the "reflection" reads as a black sea (found via the reflect A/B
  // captures). Layer 0 stays on, so main cameras see no change.
  const hemi = new THREE.HemisphereLight(0xa6c8e8, 0x223040, 0.85)
  hemi.layers.enable(WATER_REFLECTION_LAYER)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(0xfff2dc, 1.4)
  sun.layers.enable(WATER_REFLECTION_LAYER)
  sun.position.set(50, 70, 70) // sky system animates this; starting pose matches the original
  // Shadow map: orthographic frustum sized to follow the player (sky system
  // re-positions sun + target each frame). ±90 m covers the visible play
  // area at any reasonable elevation; 1024² gives ~18 cm/texel — crisp
  // enough for bike + prop shadows. Was 2048² (~9 cm/texel) but the
  // depth-pass cost scaled quadratically with map size and the visible
  // difference at racing speed was negligible. PCFSoftShadowMap (set in
  // renderer.ts) hides aliasing on the larger texels.
  sun.castShadow = true
  // `?shadowmap=<n>` (256..2048) overrides the map resolution per boot —
  // the depth-pass cost scales quadratically with the map (that's what
  // motivated 2048→1024 below), so this is the cheap ladder axis to A/B
  // without a rebuild. Absent → the resolved quality tier (1024 High,
  // 512 Medium/Low — see quality-preset.ts).
  const shadowMapParam =
    typeof window !== 'undefined'
      ? Number(new URLSearchParams(window.location.search).get('shadowmap'))
      : Number.NaN
  const shadowMapSize =
    Number.isFinite(shadowMapParam) && shadowMapParam >= 256 && shadowMapParam <= 2048
      ? Math.round(shadowMapParam)
      : getActiveQuality().shadowMapSize
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize)
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = 500
  sun.shadow.camera.left = -90
  sun.shadow.camera.right = 90
  sun.shadow.camera.top = 90
  sun.shadow.camera.bottom = -90
  // Depth bias to suppress self-shadowing — the "shadow acne" striped banding
  // that appears on large surfaces seen at a grazing angle to the sun.
  // `normalBias` offsets the receiver's shadow lookup along its surface normal
  // and MUST scale with texel size: at ~18 cm/texel the old 0.05 m was far too
  // small (<1/3 of a texel), so wide flat walls banded badly. ~0.6 m (≈3
  // texels) clears it. If contact shadows start detaching ("peter-panning")
  // under bikes/props, dial back toward 0.3. `bias` is a small constant nudge
  // in clip depth — kept low so face-on surfaces don't peter-pan.
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.6
  scene.add(sun)
  // Target must be in the scene for its world matrix to update when the
  // sky system moves it to track the player.
  scene.add(sun.target)

  return { scene, camera, sun, hemi }
}
