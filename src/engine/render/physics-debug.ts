import * as THREE from 'three'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'

/**
 * Wireframe overlay of every collider Rapier knows about. Pulls
 * `world.debugRender()` (Float32Array vertex pairs + RGBA colors) and
 * pipes it into a single `THREE.LineSegments` each frame.
 *
 * Cheap when off — `tick()` returns immediately if disabled, so leaving
 * this in the scene at all times costs nothing until the user flips
 * it on.
 *
 * Toggle from `main.ts`:
 *   - F2 key (per-session)
 *   - `?debug=collision` URL param (boot-time)
 *   - `window.__hover.toggleCollisionDebug()` (programmatic)
 */
export type PhysicsDebugRenderer = {
  mesh: THREE.LineSegments
  tick(): void
  setEnabled(on: boolean): void
  isEnabled(): boolean
  toggle(): boolean
}

export function createPhysicsDebugRenderer(phys: PhysicsWorld): PhysicsDebugRenderer {
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 4))

  // depthTest stays on so colliders properly hide behind solid geometry —
  // viewing collision from outside should look like an X-ray of the
  // visible mesh, not a flattened overlay. depthWrite off keeps the
  // lines from blocking transparent passes (water) drawn after.
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  })
  const mesh = new THREE.LineSegments(geom, mat)
  mesh.name = 'physics-debug'
  mesh.visible = false
  // Rapier emits colliders in world space already; the LineSegments node
  // sits at the origin with identity transform, and frustumCulling can't
  // reason about a buffer we rewrite each frame.
  mesh.frustumCulled = false
  mesh.renderOrder = 999

  let enabled = false

  function pull(): void {
    const buffers = phys.world.debugRender()
    const verts = buffers.vertices
    const colors = buffers.colors
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute
    const colAttr = geom.getAttribute('color') as THREE.BufferAttribute
    // Reallocate when the vertex count changes (collider added / removed).
    // Otherwise just blit into the existing Float32Array — fewer GC bumps.
    if (posAttr.array.length !== verts.length) {
      geom.setAttribute('position', new THREE.BufferAttribute(verts, 3))
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 4))
    } else {
      ;(posAttr.array as Float32Array).set(verts)
      ;(colAttr.array as Float32Array).set(colors)
      posAttr.needsUpdate = true
      colAttr.needsUpdate = true
    }
  }

  return {
    mesh,
    tick() {
      if (!enabled) return
      pull()
    },
    setEnabled(on) {
      enabled = on
      mesh.visible = on
      if (on) pull()
    },
    isEnabled() {
      return enabled
    },
    toggle() {
      enabled = !enabled
      mesh.visible = enabled
      if (enabled) pull()
      return enabled
    },
  }
}
