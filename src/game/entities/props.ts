import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import type { Prop } from '@/game/tracks/types'

/**
 * Static physics colliders for editor-authored props.
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
 */
export function createPropColliders(phys: PhysicsWorld, props: Prop[]): void {
  for (const p of props) {
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
      phys.world.createCollider(col, rb)
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
      phys.world.createCollider(col, rb)
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
      phys.world.createCollider(col, rb)
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
    phys.world.createCollider(col, rb)
  }
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

