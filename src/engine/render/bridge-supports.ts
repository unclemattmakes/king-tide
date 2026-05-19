import * as THREE from 'three'
import { sampleTerrainHeightAtXZ, type TerrainHeightmap } from '@/engine/render/terrain-heightmap'
import { DEFAULT_GATE_SPACING_M, resampleByArcLength } from '@/game/tracks/gate-placement'
import type { Track } from '@/game/tracks/types'

/**
 * Bridge-support pillars under elevated road segments. Walks the main AI
 * spline at a denser sample rate than route-markers, finds every sample
 * where the road sits at least `MIN_BRIDGE_HEIGHT_M` above the terrain
 * (or above open water), and stamps a stone pillar from ground level to
 * just under the road.
 *
 * The terrain already builds up underneath authored road shoulders in
 * some Blender source files — terrain artists sometimes ramp the
 * shoulder rather than ending it cleanly at the water — and that
 * mis-reads as "the ground floats up to meet the road." Adding visible
 * pillars where the road is genuinely bridged gives the section the
 * silhouette of a bridge regardless: the player reads the upright
 * columns and stops noticing the rampy shoulder.
 *
 * Pillars share one geometry + material across all instances via
 * InstancedMesh — one draw call regardless of count.
 */
export const MIN_BRIDGE_HEIGHT_M = 3.5
export const BRIDGE_SAMPLE_SPACING_M = 22

export type BridgeSupports = {
  group: THREE.Object3D
  dispose(): void
  count: number
}

export type BridgeSupportsDeps = {
  track: Track
  /** Terrain heightmap built at boot. When null, all samples are treated
   *  as open ocean → every elevated sample drops a pillar to water level. */
  heightmap: TerrainHeightmap | null
  /** Water surface Y. Defaults to 0. */
  waterY?: number
}

export function createBridgeSupports(deps: BridgeSupportsDeps): BridgeSupports | null {
  const { track, heightmap } = deps
  const waterY = deps.waterY ?? track.water?.height ?? 0

  const spline = track.aiSplines.find((s) => s.id === 'main') ?? track.aiSplines[0]
  if (!spline || spline.points.length < 2) return null

  // Density: tighter than route markers so a long bridge gets enough
  // columns to read as one (rather than one column every ~60 m).
  const placements = resampleByArcLength(
    spline.points,
    Math.min(track.gateSpacing ?? DEFAULT_GATE_SPACING_M, BRIDGE_SAMPLE_SPACING_M),
  )
  if (placements.length === 0) return null

  type Sample = {
    x: number
    z: number
    roadY: number
    groundY: number
    bridged: boolean
  }
  const samples: Sample[] = placements.map((p) => {
    const ground = heightmap ? sampleTerrainHeightAtXZ(heightmap, p.position.x, p.position.z) : null
    const groundY = ground !== null ? ground : waterY
    return {
      x: p.position.x,
      z: p.position.z,
      roadY: p.position.y,
      groundY,
      bridged: p.position.y - groundY >= MIN_BRIDGE_HEIGHT_M,
    }
  })
  const bridged = samples.filter((s) => s.bridged)
  if (bridged.length === 0) return null

  const root = new THREE.Group()
  root.name = 'bridge_supports'

  // Two stout pillars per sample — left and right of the spline.
  // Geometry is normalised to 1 m tall; we scale Y per-instance.
  const pillarGeom = new THREE.CylinderGeometry(0.65, 0.85, 1.0, 10)
  pillarGeom.translate(0, 0.5, 0)
  const pillarMat = new THREE.MeshStandardMaterial({
    color: 0x4a4842,
    roughness: 0.82,
    metalness: 0.06,
    emissive: 0x0a0908,
  })

  const halfWidth = 4.5 // half the typical road span
  const pillars = new THREE.InstancedMesh(pillarGeom, pillarMat, bridged.length * 2)
  pillars.name = 'bridge_pillars'
  pillars.castShadow = true
  pillars.receiveShadow = true
  pillars.frustumCulled = false

  const mat4 = new THREE.Matrix4()
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const pos = new THREE.Vector3()
  let writeIdx = 0
  // Use placements' tangent directions to find perpendicular for left/right.
  for (let i = 0; i < placements.length; i++) {
    if (!samples[i]!.bridged) continue
    const p = placements[i]!
    const s = samples[i]!
    const yaw = Math.atan2(p.tangent.x, p.tangent.z)
    const px = Math.cos(yaw)
    const pz = -Math.sin(yaw)
    // Pillar base sits at the ground (or seabed), top stops 0.4 m
    // beneath the road slab so it doesn't poke through.
    const baseY = s.groundY
    const height = Math.max(0.5, s.roadY - 0.4 - baseY)
    scale.set(1, height, 1)
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)

    pos.set(s.x - px * halfWidth, baseY, s.z - pz * halfWidth)
    mat4.compose(pos, quat, scale)
    pillars.setMatrixAt(writeIdx++, mat4)

    pos.set(s.x + px * halfWidth, baseY, s.z + pz * halfWidth)
    mat4.compose(pos, quat, scale)
    pillars.setMatrixAt(writeIdx++, mat4)
  }
  pillars.count = writeIdx
  pillars.instanceMatrix.needsUpdate = true
  root.add(pillars)

  return {
    group: root,
    count: writeIdx,
    dispose() {
      pillarGeom.dispose()
      pillarMat.dispose()
    },
  }
}
