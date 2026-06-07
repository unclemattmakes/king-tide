import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import { isAnimatedAssetProp, type LoadedProp } from '@/game/assets/prop-loader'
import { deriveWaveRiderTuning } from '@/game/components/wave-rider'
import { buildPropColliderDesc, colliderExtents } from '@/game/entities/prop-collider'
import { createWaveRider } from '@/game/entities/wave-rider'
import type { Prop } from '@/game/tracks/types'

/** Pre-loaded prop GLBs keyed by `assetId`. Empty / undefined when no
 *  asset-props are in the track. */
export type PropAssetRegistry = Map<string, LoadedProp>

/** Returned by `createPropColliders` so the render layer can match
 *  each spawned wave-rider entity to the prop asset it came from. The
 *  wave-rider render system uses this to clone the asset's GLB mesh
 *  for the entity instead of the primitive-archetype fallback. Keyed
 *  by ECS entity id; absent when the placement is a static prop. */
export type WaveRiderAssetBindings = Map<number, string>

/**
 * Static physics colliders for editor-authored props, plus wave-rider
 * entity spawns for any asset-prop tagged as a wave-rider.
 *
 *  - box        → cuboid collider (cheap + exact)
 *  - sphere     → ball collider
 *  - cylinder   → cylinder collider (axis = local Y)
 *  - pipe       → trimesh built from the same ring geometry as the visual.
 *                 Pipes / half-pipes are non-convex hollow shells, so cuboid /
 *                 capsule approximations don't work; trimesh is the right tool
 *                 even though Rapier's broadphase has known issues with thin
 *                 trimesh on fast-moving capsules (see status.md). Wall
 *                 thickness ≥ 0.3m is recommended.
 *  - halfpipe   → trimesh, same as pipe (upper half omitted).
 *
 * Wave-rider behaviour: a placement floats when EITHER its GLB carries
 * the `wave_rider_archetype` extras (asset-level buoy/log) OR the
 * placement itself opts in via `p.waveRider` (per-instance "float on
 * waves", which wins). Floats are routed through `createWaveRider` — the
 * runtime makes a kinematic body that tracks the wave surface and reacts
 * to hits, and the render layer hosts the visual via the wave-rider
 * render system. Static-collider creation is skipped for that placement.
 * Per-instance floats use the prop's OWN collider + a tuning auto-derived
 * from its size that rests at the authored height (`position.y` above
 * `opts.baseY`, the mean water level). `sim` is required for the
 * wave-rider spawn path; without it (legacy call sites that haven't been
 * upgraded), wave-rider props degrade to static colliders.
 *
 * Returns the eid → assetId mapping for every wave-rider that was
 * spawned, so the render layer can pick up the right GLB mesh per
 * entity instead of falling back to the primitive archetype mesh.
 */
export function createPropColliders(
  phys: PhysicsWorld,
  props: Prop[],
  assets?: PropAssetRegistry,
  sim?: SimWorld,
  opts: { baseY?: number } = {},
): WaveRiderAssetBindings {
  const waveRiderBindings: WaveRiderAssetBindings = new Map()
  // Mean water level — per-instance floats rest at `position.y` relative
  // to this, so a floated prop bobs around where the author placed it.
  const baseY = opts.baseY ?? 0
  for (const p of props) {
    if (p.type === 'asset') {
      if (!p.assetId) continue
      const loaded = assets?.get(p.assetId)
      if (!loaded) continue
      // Animated props are render-only decoration — no collider, no sim
      // coupling (hosted by `animated-props`).
      if (isAnimatedAssetProp(p, loaded)) continue
      // Per-instance float: THIS placement opts in via `p.waveRider`,
      // regardless of the asset's own archetype. Floats with the prop's
      // own collider + a size-derived tuning resting at the authored
      // height. Wins over the asset-level archetype below.
      if (p.waveRider !== undefined && sim) {
        const first = loaded.colliders[0]
        const ext = first ? colliderExtents(first, p.size) : { halfHeight: 0.5, footprint: 0.5 }
        const tuning = deriveWaveRiderTuning({
          halfHeight: ext.halfHeight,
          footprint: ext.footprint,
          restOffsetY: p.position.y - baseY,
          dof: p.waveRider.dof ?? 'locked',
        })
        const eid = createWaveRider(sim, phys, {
          position: p.position,
          yaw: yawFromQuat(p.rotation),
          tuning,
          colliders: loaded.colliders,
          size: p.size,
        })
        waveRiderBindings.set(eid, p.assetId)
        continue
      }
      if (loaded.waveRider !== undefined && sim) {
        // Asset-level wave-rider (buoy/log GLB): kinematic body with the
        // archetype's hand-tuned preset + primitive collider. Unchanged
        // path for shipped buoys/logs. Static colliders are skipped — the
        // wave-rider body owns the physics presence.
        const eid = createWaveRider(sim, phys, {
          position: p.position,
          archetype: loaded.waveRider,
          yaw: yawFromQuat(p.rotation),
        })
        waveRiderBindings.set(eid, p.assetId)
        continue
      }
      addAssetPropColliders(phys, p, loaded)
      continue
    }
    if (p.type === 'box') {
      const desc = phys.rapier.RigidBodyDesc.fixed().setTranslation(
        p.position.x,
        p.position.y,
        p.position.z,
      )
      desc.setRotation(p.rotation)
      const rb = phys.world.createRigidBody(desc)
      const col = phys.rapier.ColliderDesc.cuboid(
        Math.max(0.05, p.size.x),
        Math.max(0.05, p.size.y),
        Math.max(0.05, p.size.z),
      ).setFriction(0.7)
      tagSurface(phys, phys.world.createCollider(col, rb), p.surface)
      continue
    }
    if (p.type === 'sphere') {
      const desc = phys.rapier.RigidBodyDesc.fixed().setTranslation(
        p.position.x,
        p.position.y,
        p.position.z,
      )
      desc.setRotation(p.rotation)
      const rb = phys.world.createRigidBody(desc)
      const col = phys.rapier.ColliderDesc.ball(Math.max(0.05, p.size.x)).setFriction(0.7)
      tagSurface(phys, phys.world.createCollider(col, rb), p.surface)
      continue
    }
    if (p.type === 'cylinder') {
      const desc = phys.rapier.RigidBodyDesc.fixed().setTranslation(
        p.position.x,
        p.position.y,
        p.position.z,
      )
      desc.setRotation(p.rotation)
      const rb = phys.world.createRigidBody(desc)
      const col = phys.rapier.ColliderDesc.cylinder(
        Math.max(0.05, p.size.y),
        Math.max(0.05, p.size.x),
      ).setFriction(0.7)
      tagSurface(phys, phys.world.createCollider(col, rb), p.surface)
      continue
    }
    // pipe / halfpipe — trimesh from world-space vertices.
    const { verts, indices } = ringTrimeshWorld(
      p.position,
      p.rotation,
      p.size,
      p.type === 'halfpipe',
    )
    const desc = phys.rapier.RigidBodyDesc.fixed()
    const rb = phys.world.createRigidBody(desc)
    const col = phys.rapier.ColliderDesc.trimesh(verts, indices)
      .setFriction(0.6)
      .setRestitution(0.05)
    tagSurface(phys, phys.world.createCollider(col, rb), p.surface)
  }
  return waveRiderBindings
}

/** Register a freshly-created collider's surface tag, if the prop
 *  declared one. No-op for undefined / DEFAULT (the registry falls
 *  back to DEFAULT on lookup either way). */
function tagSurface(
  phys: PhysicsWorld,
  collider: { handle: number },
  surface: Prop['surface'],
): void {
  if (surface) phys.surfaces.tag(collider.handle, surface)
}

/** Yaw around world-Y from a quaternion via the YXZ Euler decomposition.
 *  Matches the convention used in `glb-loader.readYaw` and elsewhere
 *  so authored prop rotations survive the round-trip into the wave-
 *  rider's initial yaw. */
function yawFromQuat(q: Quat): number {
  const r02 = 2 * (q.x * q.z + q.y * q.w)
  const r22 = 1 - 2 * (q.x * q.x + q.y * q.y)
  return Math.atan2(r02, r22)
}

/**
 * Static collider for an asset-prop instance. Builds the collider from the
 * GLB's first `collider_*` descriptor via {@link buildPropColliderDesc}
 * (scaled by the prop's `size`, carrying its local pose within `prop_root`),
 * then attaches it to a fixed body at the editor-authored pose. The local
 * pose matters: library props often pivot at the model BASE with the
 * collider carrying a +Y offset to sit at the centre, so dropping it would
 * sink the collider below the visible mesh.
 */
function addAssetPropColliders(phys: PhysicsWorld, p: Prop, loaded: LoadedProp): void {
  if (loaded.colliders.length === 0) return
  const col = buildPropColliderDesc(phys, loaded.colliders[0]!, p.size)
  if (!col) return
  col.setFriction(0.6)
  const desc = phys.rapier.RigidBodyDesc.fixed().setTranslation(
    p.position.x,
    p.position.y,
    p.position.z,
  )
  desc.setRotation(p.rotation)
  const rb = phys.world.createRigidBody(desc)
  const created = phys.world.createCollider(col, rb)
  if (p.surface) phys.surfaces.tag(created.handle, p.surface)
}

/**
 * Build a hollow ring trimesh in world space. Mirrors the visual geometry
 * from `props-geometry.ts` but with double-winding (each triangle emitted
 * both ways) so Rapier's one-sided trimesh doesn't miss the bike from
 * either side of a wall. Slightly fewer radial segments than the visual
 * to keep the trimesh cheap.
 */
function ringTrimeshWorld(
  position: Vec3,
  rotation: Quat,
  size: Vec3,
  open: boolean,
): { verts: Float32Array; indices: Uint32Array } {
  const outer = Math.max(0.2, size.x)
  const halfLen = Math.max(0.1, size.y)
  const wall = Math.max(0.05, Math.min(size.z, outer - 0.05))
  const inner = outer - wall
  const radialSegs = 24
  const lengthSegs = 1
  const ringCount = lengthSegs + 1
  const thetaStart = open ? Math.PI : 0
  const thetaRange = Math.PI * 2

  const localVerts: number[] = []
  for (let l = 0; l < ringCount; l++) {
    const z = -halfLen + (l / lengthSegs) * (halfLen * 2)
    for (let r = 0; r <= radialSegs; r++) {
      const t = thetaStart + (r / radialSegs) * thetaRange
      localVerts.push(Math.cos(t) * outer, Math.sin(t) * outer, z)
    }
  }
  const innerStart = ringCount * (radialSegs + 1)
  for (let l = 0; l < ringCount; l++) {
    const z = -halfLen + (l / lengthSegs) * (halfLen * 2)
    for (let r = 0; r <= radialSegs; r++) {
      const t = thetaStart + (r / radialSegs) * thetaRange
      localVerts.push(Math.cos(t) * inner, Math.sin(t) * inner, z)
    }
  }

  // Triangles (one winding — we double them at the end for two-sidedness).
  const baseIdx: number[] = []
  for (let l = 0; l < lengthSegs; l++) {
    for (let r = 0; r < radialSegs; r++) {
      const a = l * (radialSegs + 1) + r
      const b = a + 1
      const c = a + (radialSegs + 1)
      const d = c + 1
      baseIdx.push(a, c, b, b, c, d)
      const ia = innerStart + l * (radialSegs + 1) + r
      const ib = ia + 1
      const ic = ia + (radialSegs + 1)
      const id = ic + 1
      baseIdx.push(ia, ib, ic, ib, id, ic)
    }
  }
  for (let l = 0; l < ringCount; l++) {
    const oBase = l * (radialSegs + 1)
    const iBase = innerStart + l * (radialSegs + 1)
    const isStart = l === 0
    for (let r = 0; r < radialSegs; r++) {
      const oA = oBase + r
      const oB = oBase + r + 1
      const iA = iBase + r
      const iB = iBase + r + 1
      if (isStart) baseIdx.push(oA, oB, iA, iA, oB, iB)
      else baseIdx.push(oA, iA, oB, oB, iA, iB)
    }
  }

  // Apply prop pose to vertices so the trimesh is in world space.
  const worldVerts = new Float32Array(localVerts.length)
  for (let i = 0; i < localVerts.length; i += 3) {
    const lx = localVerts[i]!
    const ly = localVerts[i + 1]!
    const lz = localVerts[i + 2]!
    const rotated = quatRotate(rotation, lx, ly, lz)
    worldVerts[i] = rotated.x + position.x
    worldVerts[i + 1] = rotated.y + position.y
    worldVerts[i + 2] = rotated.z + position.z
  }

  // Double-winding so trimesh is two-sided.
  const baseLen = baseIdx.length
  const indices = new Uint32Array(baseLen * 2)
  for (let i = 0; i < baseLen; i += 3) {
    const a = baseIdx[i]!
    const b = baseIdx[i + 1]!
    const c = baseIdx[i + 2]!
    indices[i] = a
    indices[i + 1] = b
    indices[i + 2] = c
    indices[baseLen + i] = a
    indices[baseLen + i + 1] = c
    indices[baseLen + i + 2] = b
  }
  return { verts: worldVerts, indices }
}

function quatRotate(q: Quat, x: number, y: number, z: number): Vec3 {
  const tx = 2 * (q.y * z - q.z * y)
  const ty = 2 * (q.z * x - q.x * z)
  const tz = 2 * (q.x * y - q.y * x)
  return {
    x: x + q.w * tx + (q.y * tz - q.z * ty),
    y: y + q.w * ty + (q.z * tx - q.x * tz),
    z: z + q.w * tz + (q.x * ty - q.y * tx),
  }
}
