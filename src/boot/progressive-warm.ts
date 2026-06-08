/**
 * Progressive shader pre-warm for the static scenery.
 *
 * Boot's shader pre-warm (`main.ts` phase 7b) compiles every material in the
 * scene under the loading screen — and since three's WebGPU pipeline cache keys
 * on per-instance node ids (each distinct `NodeMaterial` compiles its own
 * program), a dressed track pays ~one compile per vinyl material. On Sandbar
 * that's ~87 compiles ≈ 5 s, and ~half of them are the track's buildings +
 * scatter props the player never sees before the start line.
 *
 * This defers those: hide the scenery meshes so the essential warm (bikes,
 * riders, water, sky, terrain, gates) compiles fast and the loading screen drops
 * sooner, then reveal them a few per frame once the race is live. The running
 * game loop compiles each on first sight, so the cost spreads across the
 * countdown as small dips instead of one upfront block — and because the warm
 * runs through the real render path, it's correct for the post-pipeline's render
 * target (a detached pre-compile would cache under the wrong key — see
 * post-pipeline.ts). Visibility-only: no reparenting, so colliders, animation
 * rigs, and world transforms are untouched.
 */
import type * as THREE from 'three'

export type ProgressiveWarm = {
  /** How many meshes were deferred. */
  readonly count: number
  /**
   * Reveal the deferred meshes `perFrame` at a time via requestAnimationFrame;
   * the live render loop compiles each newly-visible mesh on first sight. Calls
   * `onDone` once every mesh is back. Falls back to an immediate reveal where
   * requestAnimationFrame isn't available (jsdom / SSR).
   */
  reveal(perFrame?: number, onDone?: () => void): void
}

/**
 * Hide `meshes` immediately (so the boot warm skips them) and return a handle
 * that reveals them progressively. Pass the static scenery only — movers
 * (bikes/riders) must stay visible so the grid is solid from the first frame.
 */
export function deferSceneryWarm(meshes: THREE.Mesh[]): ProgressiveWarm {
  for (const m of meshes) m.visible = false
  return {
    count: meshes.length,
    reveal(perFrame = 2, onDone?: () => void) {
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null
      if (!raf) {
        for (const m of meshes) m.visible = true
        onDone?.()
        return
      }
      let i = 0
      const step = (): void => {
        for (let k = 0; k < perFrame && i < meshes.length; k++, i++) {
          const m = meshes[i]
          if (m) m.visible = true
        }
        if (i < meshes.length) raf(step)
        else onDone?.()
      }
      raf(step)
    },
  }
}

/**
 * Collect the painterly-vinyl meshes under the given roots (the track's
 * buildings/set-pieces + the scatter-prop group) — the scenery whose shader
 * compile we defer. Identified by the `mat_vinyl*` material name the vinyl pass
 * stamps, so terrain (`mat_terrain`), foliage (`mat_foliage`), lava, water, and
 * the gates/horizon (separate roots) are left essential. Movers live under their
 * own roots and are never passed in.
 */
export function collectVinylScenery(roots: Array<THREE.Object3D | undefined | null>): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  for (const root of roots) {
    if (!root) continue
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const mat = mesh.material
      const name = Array.isArray(mat) ? mat[0]?.name : (mat as THREE.Material | null)?.name
      if (typeof name === 'string' && name.startsWith('mat_vinyl')) out.push(mesh)
    })
  }
  return out
}
