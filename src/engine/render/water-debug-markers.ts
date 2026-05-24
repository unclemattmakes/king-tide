/**
 * Camera-locked transition markers for the water LOD boundaries.
 *
 * The water shader composes three nested meshes:
 *  - Center mesh: 480 m × 480 m, full detail (Gerstner + detail
 *    cascades + foam + reflection). Camera-locked.
 *  - Outer LOD tile: 1440 m × 1440 m, Gerstner only. Camera-locked.
 *  - Horizon skirt: ring from 120 m to 1600 m, flat. Camera-locked.
 *
 * Their boundaries (±240 m for center, ±720 m for outer LOD on the
 * cardinal axes) are where the visible "seam" between displaced water
 * and flatter water lives. These markers paint tall pillars on a
 * circle at each boundary radius so the player can see exactly which
 * band each transition occupies as they drive around.
 *
 * The group is added as a child of the (camera-locked) water mesh, so
 * the pillars stay pinned to the LOD rings rather than sliding past
 * the player. From the bike's perspective the markers appear "frozen"
 * in space — that's the point: they're locked to the same camera
 * frame the water LODs use.
 *
 * `fog: false` on the materials so the outer ring remains visible
 * through the fog band that starts at 500 m — without that, the
 * 720 m markers would dissolve into the haze long before the player
 * could see them properly.
 */

import * as THREE from 'three'

/** Cardinal half-extent of the center mesh (960 m square). The outer
 *  LOD tile fades in across 380–480 m on the cardinal axis; 480 m
 *  pegs the outer end of that cross-blend band. */
const INNER_RING_RADIUS_M = 480
/** Cardinal half-extent of the outer LOD tile (1440 m square). Past
 *  this radius only the horizon skirt remains. */
const OUTER_RING_RADIUS_M = 720
/** Number of pillars per ring. Every 45° gives the player a marker
 *  in every cardinal + diagonal direction without crowding the ring. */
const MARKER_COUNT = 8

const INNER_HEIGHT_M = 14
const INNER_RADIUS_M = 1.4
const OUTER_HEIGHT_M = 26
const OUTER_RADIUS_M = 2.4

const INNER_COLOR = 0xff3838
const OUTER_COLOR = 0xffc83a

export type WaterTransitionMarkers = {
  /** The group to add as a child of the camera-locked water mesh. */
  group: THREE.Group
  setVisible(on: boolean): void
  isVisible(): boolean
  dispose(): void
}

export function createWaterTransitionMarkers(): WaterTransitionMarkers {
  const group = new THREE.Group()
  group.name = 'water-transition-markers'
  group.frustumCulled = false

  const innerGeom = new THREE.CylinderGeometry(INNER_RADIUS_M, INNER_RADIUS_M, INNER_HEIGHT_M, 14)
  innerGeom.translate(0, INNER_HEIGHT_M / 2, 0)
  const innerMat = new THREE.MeshBasicMaterial({ color: INNER_COLOR, fog: false })
  innerMat.name = 'water-marker-inner'

  const outerGeom = new THREE.CylinderGeometry(OUTER_RADIUS_M, OUTER_RADIUS_M, OUTER_HEIGHT_M, 14)
  outerGeom.translate(0, OUTER_HEIGHT_M / 2, 0)
  const outerMat = new THREE.MeshBasicMaterial({ color: OUTER_COLOR, fog: false })
  outerMat.name = 'water-marker-outer'

  for (let i = 0; i < MARKER_COUNT; i++) {
    const angle = (i / MARKER_COUNT) * Math.PI * 2
    const cx = Math.cos(angle)
    const cz = Math.sin(angle)

    const inner = new THREE.Mesh(innerGeom, innerMat)
    inner.position.set(cx * INNER_RING_RADIUS_M, 0, cz * INNER_RING_RADIUS_M)
    inner.frustumCulled = false
    inner.castShadow = false
    inner.receiveShadow = false
    group.add(inner)

    const outer = new THREE.Mesh(outerGeom, outerMat)
    outer.position.set(cx * OUTER_RING_RADIUS_M, 0, cz * OUTER_RING_RADIUS_M)
    outer.frustumCulled = false
    outer.castShadow = false
    outer.receiveShadow = false
    group.add(outer)
  }

  group.visible = false

  return {
    group,
    setVisible(on) {
      group.visible = !!on
    },
    isVisible() {
      return group.visible
    },
    dispose() {
      innerGeom.dispose()
      innerMat.dispose()
      outerGeom.dispose()
      outerMat.dispose()
    },
  }
}
