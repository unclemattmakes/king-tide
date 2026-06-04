/**
 * Sim-surface probe — a dev diagnostic that parks a grid of bright dots at
 * the SIM water surface (`sampleHeight` — the exact height the buoyancy
 * sampler floats the bike on), following a world-space centre each frame.
 *
 * Gated by `?wavedots=1` in the game loop, which also forces the water mesh
 * to wireframe. The comparison is then direct and on a REAL track (with its
 * terrain heightmap + shore field installed, unlike the synthetic
 * `?waveriders=1` scene): the wireframe is what the shader DRAWS; the dots are
 * what the rider FEELS. Where they diverge is a sim↔render discrepancy you can
 * see frame-by-frame:
 *
 *   - Deep open water: dots sit on the wireframe (post-#284 the ambient
 *     Gerstner + horizontal-pinch inverse-map + shoaling all agree).
 *   - Under a bike: the mesh dips into its render-only hull dimple while the
 *     dots stay flat — the dimple is drawn but not felt.
 *   - Surf band (sandbar island, the Maw arches): the shore-breaker term lifts
 *     both the mesh and the dots; watch whether the bike body tracks the
 *     crests or sinks through them (the buoyancy lift-error cap).
 *
 * Two dot colours: RED at the sim surface, and (optionally) a fainter set the
 * caller can drive elsewhere. We keep it red-only here — the wireframe mesh is
 * the render ground truth, so a second CPU mirror would only duplicate it.
 *
 * Cost: one `sampleHeight` per dot per frame (a few hundred), render-only,
 * never touches the sim — so it's safe to leave on while driving.
 */
import * as THREE from 'three'
import { sampleHeight, type WaveFieldState } from '@/engine/sim/water/wave-field'

export type SimSurfaceProbe = {
  /** Reposition the dot grid around world (centreX, centreZ) and re-sample. */
  tick(field: WaveFieldState, centreX: number, centreZ: number): void
  setVisible(on: boolean): void
  dispose(): void
}

/** Half-extent of the dot grid, metres (covers ~3 chop wavelengths + half a
 *  swell so the surface shape reads, without flooding the frame). */
const GRID_HALF = 24
/** Dot spacing, metres. */
const GRID_STEP = 2

export function createSimSurfaceProbe(scene: THREE.Scene): SimSurfaceProbe {
  const perAxis = Math.floor((GRID_HALF * 2) / GRID_STEP) + 1
  const count = perAxis * perAxis

  const geo = new THREE.SphereGeometry(0.14, 8, 6)
  // MeshBasicNodeMaterial (the WebGPU default for MeshBasicMaterial) — unlit,
  // so the dots stay legibly bright against sea + sky at any sun angle.
  const mat = new THREE.MeshBasicMaterial({ color: 0xff2d4b })
  const mesh = new THREE.InstancedMesh(geo, mat, count)
  mesh.name = 'diag:sim-surface-probe'
  // The grid jumps a full metre when the centre snaps; never cull it on the
  // bounding sphere of frame N-1.
  mesh.frustumCulled = false
  mesh.renderOrder = 999
  scene.add(mesh)

  const dummy = new THREE.Object3D()

  function tick(field: WaveFieldState, centreX: number, centreZ: number): void {
    // Snap the centre to the metre grid so the dots stay pinned to fixed world
    // points as the player moves — the surface they trace then reads as a
    // stable field rather than a swarm sliding under the camera.
    const ox = Math.round(centreX)
    const oz = Math.round(centreZ)
    let i = 0
    for (let dx = -GRID_HALF; dx <= GRID_HALF; dx += GRID_STEP) {
      for (let dz = -GRID_HALF; dz <= GRID_HALF; dz += GRID_STEP) {
        const wx = ox + dx
        const wz = oz + dz
        dummy.position.set(wx, sampleHeight(field, wx, wz), wz)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        i++
      }
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  function setVisible(on: boolean): void {
    mesh.visible = on
  }

  function dispose(): void {
    scene.remove(mesh)
    geo.dispose()
    mat.dispose()
  }

  return { tick, setVisible, dispose }
}
