import { hasComponent, query } from 'bitecs'
import * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { BikeTag, PlayerTag, Transform, TransformStore } from '@/game/components'

/**
 * Long-exposure tail-light trail behind every bike. Each bike gets a Line
 * that buffers the last TRAIL_LENGTH world-space anchor positions (the
 * tail-light position rotated into world by the bike's quaternion). Vertex
 * colors fade quadratically from full at the newest end to black at the
 * oldest, and the material is additive + depth-write off so the trail
 * reads as a glowing streak rather than a hard line.
 *
 * WebGL's LineBasicMaterial doesn't honor linewidth > 1 reliably, so we
 * lean on additive blending against the dark sky/water for visual punch
 * rather than thick geometry. If we ever want chunkier strokes, swap to
 * a TubeGeometry rebuilt per frame or a quad-strip facing the camera.
 */
const TRAIL_LENGTH = 40
const TAIL_LOCAL = new THREE.Vector3(0, 0.4, -0.7) // matches tail light in bike-mesh
const PLAYER_TRAIL_COLOR = new THREE.Color(0xffaa55)
const AI_TRAIL_COLORS = [0x55ccff, 0x66ee88, 0xdd66ff, 0xffdd44, 0xff7799]

type TrailState = {
  line: THREE.Line
  positions: Float32Array
  geometry: THREE.BufferGeometry
  primed: boolean
}

export function createTrailRenderSystem(scene: THREE.Scene, sim: SimWorld) {
  const trails = new Map<number, TrailState>()
  let aiCursor = 0

  const tmpQuat = new THREE.Quaternion()
  const tmpAnchor = new THREE.Vector3()
  const tmpPos = new THREE.Vector3()

  return function tick(): void {
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

        const positions = new Float32Array(TRAIL_LENGTH * 3)
        const colors = new Float32Array(TRAIL_LENGTH * 3)
        for (let i = 0; i < TRAIL_LENGTH; i++) {
          const u = i / (TRAIL_LENGTH - 1) // 0 = oldest, 1 = newest
          const intensity = u * u // quadratic so the tail fades softly
          colors[i * 3 + 0] = baseColor.r * intensity
          colors[i * 3 + 1] = baseColor.g * intensity
          colors[i * 3 + 2] = baseColor.b * intensity
        }

        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
        const material = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
        const line = new THREE.Line(geometry, material)
        line.frustumCulled = false
        line.renderOrder = 1
        scene.add(line)

        trail = { line, positions, geometry, primed: false }
        trails.set(eid, trail)
      }

      const t = TransformStore.must(eid)
      tmpQuat.set(t.qx, t.qy, t.qz, t.qw)
      tmpPos.set(t.x, t.y, t.z)
      tmpAnchor.copy(TAIL_LOCAL).applyQuaternion(tmpQuat).add(tmpPos)

      const positions = trail.positions
      if (!trail.primed) {
        // First frame: fill the whole buffer with the current anchor so
        // the trail doesn't snap from world origin to spawn.
        for (let i = 0; i < TRAIL_LENGTH; i++) {
          positions[i * 3 + 0] = tmpAnchor.x
          positions[i * 3 + 1] = tmpAnchor.y
          positions[i * 3 + 2] = tmpAnchor.z
        }
        trail.primed = true
      } else {
        // Shift left by one (3 floats per point), drop the oldest.
        positions.copyWithin(0, 3)
        const tailIdx = (TRAIL_LENGTH - 1) * 3
        positions[tailIdx + 0] = tmpAnchor.x
        positions[tailIdx + 1] = tmpAnchor.y
        positions[tailIdx + 2] = tmpAnchor.z
      }
      const posAttr = trail.geometry.getAttribute('position') as THREE.BufferAttribute
      posAttr.needsUpdate = true
    }

    for (const [eid, trail] of trails) {
      if (!live.has(eid)) {
        scene.remove(trail.line)
        trail.geometry.dispose()
        if (trail.line.material instanceof THREE.Material) trail.line.material.dispose()
        trails.delete(eid)
      }
    }
  }
}
