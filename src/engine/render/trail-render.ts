import { hasComponent, query } from 'bitecs'
import * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { BikeTag, PlayerTag, Transform, TransformStore } from '@/game/components'

/**
 * Long-exposure tail-light trail behind every bike. Each bike gets a
 * camera-facing quad strip rebuilt every frame from the last TRAIL_LENGTH
 * world-space anchor positions (the tail-light point rotated into world by
 * the bike's quaternion). At each anchor we offset two vertices left/right
 * along (tangent × view-direction) so the ribbon always shows its broad
 * face to the camera. Vertex colors fade quadratically from full at the
 * newest end to black at the oldest, additive-blended and depth-write off
 * so it reads as a glowing streak rather than a solid strap.
 *
 * We can't lean on LineBasicMaterial linewidth because WebGL caps it at 1px,
 * so the ribbon mesh is what gives the trail its actual visual thickness.
 */
const TRAIL_LENGTH = 40
const TRAIL_HALF_WIDTH = 0.18 // total ribbon ≈ 0.36m, about 1.5× the tail-light sphere
const TAIL_LOCAL = new THREE.Vector3(0, 0.4, -0.7) // matches tail light in bike-mesh
const PLAYER_TRAIL_COLOR = new THREE.Color(0xffaa55)
const AI_TRAIL_COLORS = [0x55ccff, 0x66ee88, 0xdd66ff, 0xffdd44, 0xff7799]

type TrailState = {
  mesh: THREE.Mesh
  /** Flat array of world-space anchor history, length TRAIL_LENGTH * 3. */
  anchors: Float32Array
  /** Vertex position buffer for the ribbon, length 2 * TRAIL_LENGTH * 3. */
  ribbon: Float32Array
  geometry: THREE.BufferGeometry
  primed: boolean
}

function buildIndices(): Uint16Array {
  const ix: number[] = []
  for (let i = 0; i < TRAIL_LENGTH - 1; i++) {
    const a = 2 * i
    ix.push(a, a + 1, a + 2)
    ix.push(a + 1, a + 3, a + 2)
  }
  return new Uint16Array(ix)
}

const TRAIL_INDICES = buildIndices()

export function createTrailRenderSystem(scene: THREE.Scene, sim: SimWorld) {
  const trails = new Map<number, TrailState>()
  let aiCursor = 0

  const tmpQuat = new THREE.Quaternion()
  const tmpAnchor = new THREE.Vector3()
  const tmpPos = new THREE.Vector3()
  const tangent = new THREE.Vector3()
  const viewDir = new THREE.Vector3()
  const widthDir = new THREE.Vector3()
  const camWorldPos = new THREE.Vector3()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()

  return function tick(camera: THREE.Camera): void {
    camera.getWorldPosition(camWorldPos)

    const eids = query(sim, [BikeTag, Transform])
    const live = new Set<number>()
    for (const eid of eids) {
      live.add(eid)
      let trail = trails.get(eid)
      if (!trail) {
        const isPlayer = hasComponent(sim, eid, PlayerTag)
        const baseColor = isPlayer
          ? PLAYER_TRAIL_COLOR
          : new THREE.Color(AI_TRAIL_COLORS[aiCursor++ % AI_TRAIL_COLORS.length] ?? 0xaaaaaa)

        const anchors = new Float32Array(TRAIL_LENGTH * 3)
        const ribbon = new Float32Array(TRAIL_LENGTH * 2 * 3)
        const colors = new Float32Array(TRAIL_LENGTH * 2 * 3)
        for (let i = 0; i < TRAIL_LENGTH; i++) {
          const u = i / (TRAIL_LENGTH - 1) // 0 = oldest, 1 = newest
          const intensity = u * u
          for (let side = 0; side < 2; side++) {
            const o = (i * 2 + side) * 3
            colors[o + 0] = baseColor.r * intensity
            colors[o + 1] = baseColor.g * intensity
            colors[o + 2] = baseColor.b * intensity
          }
        }

        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(ribbon, 3))
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
        geometry.setIndex(new THREE.BufferAttribute(TRAIL_INDICES, 1))
        const material = new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
        const mesh = new THREE.Mesh(geometry, material)
        mesh.frustumCulled = false
        mesh.renderOrder = 1
        scene.add(mesh)

        trail = { mesh, anchors, ribbon, geometry, primed: false }
        trails.set(eid, trail)
      }

      const t = TransformStore.must(eid)
      tmpQuat.set(t.qx, t.qy, t.qz, t.qw)
      tmpPos.set(t.x, t.y, t.z)
      tmpAnchor.copy(TAIL_LOCAL).applyQuaternion(tmpQuat).add(tmpPos)

      const anchors = trail.anchors
      if (!trail.primed) {
        for (let i = 0; i < TRAIL_LENGTH; i++) {
          anchors[i * 3 + 0] = tmpAnchor.x
          anchors[i * 3 + 1] = tmpAnchor.y
          anchors[i * 3 + 2] = tmpAnchor.z
        }
        trail.primed = true
      } else {
        anchors.copyWithin(0, 3)
        const last = (TRAIL_LENGTH - 1) * 3
        anchors[last + 0] = tmpAnchor.x
        anchors[last + 1] = tmpAnchor.y
        anchors[last + 2] = tmpAnchor.z
      }

      // Build the ribbon by extruding each anchor left/right along
      // (tangent × view-direction). This always shows the ribbon's broad
      // face to the camera so the perceived width stays constant.
      const ribbon = trail.ribbon
      for (let i = 0; i < TRAIL_LENGTH; i++) {
        const ip = Math.max(0, i - 1)
        const in_ = Math.min(TRAIL_LENGTH - 1, i + 1)
        a.set(anchors[in_ * 3 + 0] ?? 0, anchors[in_ * 3 + 1] ?? 0, anchors[in_ * 3 + 2] ?? 0)
        b.set(anchors[ip * 3 + 0] ?? 0, anchors[ip * 3 + 1] ?? 0, anchors[ip * 3 + 2] ?? 0)
        tangent.copy(a).sub(b)
        if (tangent.lengthSq() < 1e-10) tangent.set(0, 0, 1)
        else tangent.normalize()

        viewDir
          .set(anchors[i * 3 + 0] ?? 0, anchors[i * 3 + 1] ?? 0, anchors[i * 3 + 2] ?? 0)
          .sub(camWorldPos)
          .normalize()

        widthDir.copy(tangent).cross(viewDir)
        const len = widthDir.length()
        if (len < 1e-6) widthDir.set(1, 0, 0)
        else widthDir.multiplyScalar(TRAIL_HALF_WIDTH / len)

        const ax = anchors[i * 3 + 0] ?? 0
        const ay = anchors[i * 3 + 1] ?? 0
        const az = anchors[i * 3 + 2] ?? 0
        const li = i * 2 * 3
        ribbon[li + 0] = ax + widthDir.x
        ribbon[li + 1] = ay + widthDir.y
        ribbon[li + 2] = az + widthDir.z
        ribbon[li + 3] = ax - widthDir.x
        ribbon[li + 4] = ay - widthDir.y
        ribbon[li + 5] = az - widthDir.z
      }
      const posAttr = trail.geometry.getAttribute('position') as THREE.BufferAttribute
      posAttr.needsUpdate = true
    }

    for (const [eid, trail] of trails) {
      if (!live.has(eid)) {
        scene.remove(trail.mesh)
        trail.geometry.dispose()
        if (trail.mesh.material instanceof THREE.Material) trail.mesh.material.dispose()
        trails.delete(eid)
      }
    }
  }
}
