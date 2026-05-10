import { hasComponent, query } from 'bitecs'
import * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { BikeTag, Transform, TransformStore } from '@/game/components'
import {
  ExplosionState,
  ExplosionStateStore,
  ExplosionTag,
  MineState,
  MineStateStore,
  MineTag,
  MissileState,
  MissileStateStore,
  MissileTag,
  ShieldEffect,
  ShieldEffectStore,
} from '@/game/components/combat'
import { syncEntityMeshes } from './mesh-sync'

/**
 * Render-side bookkeeping for combat visuals: mines, missiles, shield
 * bubbles, and explosions. Each entity type owns its own per-eid mesh
 * map; orphans are removed when their sim-side entities go away.
 *
 * The four lifecycle blocks share their structure via `syncEntityMeshes`
 * — each one supplies a factory, an update function, and (optionally) a
 * predicate to skip entities whose visual is inactive.
 */
export function createCombatRenderSystem(scene: THREE.Scene, sim: SimWorld) {
  const mineMeshes = new Map<number, THREE.Object3D>()
  const missileMeshes = new Map<number, THREE.Object3D>()
  const shieldMeshes = new Map<number, THREE.Object3D>()
  const explosionMeshes = new Map<number, THREE.Object3D>()

  return function tick(_dt: number): void {
    syncEntityMeshes({
      scene,
      meshes: mineMeshes,
      eids: query(sim, [MineTag, MineState]),
      factory: createMineMesh,
      update: (mesh, eid) => {
        const m = MineStateStore.must(eid)
        mesh.position.set(m.position.x, m.position.y, m.position.z)
        // Spin the disc.
        mesh.rotation.y = m.ageSec * 4
        // Pulse glow with age (low-frequency cosine for a steady throb).
        const glow = mesh.children[1] as THREE.Mesh
        const glowMat = glow.material as THREE.MeshBasicMaterial
        const pulse = 0.45 + 0.25 * Math.cos(m.ageSec * 6)
        glowMat.opacity = m.detonated ? 0 : pulse
      },
    })

    syncEntityMeshes({
      scene,
      meshes: missileMeshes,
      eids: query(sim, [MissileTag, MissileState]),
      factory: createMissileMesh,
      update: (mesh, eid) => {
        const m = MissileStateStore.must(eid)
        mesh.position.set(m.position.x, m.position.y, m.position.z)
        // Orient along velocity (cone tip points +Z, so look-at the
        // anti-velocity direction with up = world up).
        const speed = Math.hypot(m.velocity.x, m.velocity.y, m.velocity.z)
        if (speed > 0.001) {
          const lookTarget = new THREE.Vector3(
            m.position.x + m.velocity.x,
            m.position.y + m.velocity.y,
            m.position.z + m.velocity.z,
          )
          mesh.lookAt(lookTarget)
        }
      },
    })

    // Shield bubbles: one per bike with a live ShieldEffect. The filter
    // also guards against stale store entries from old hits where the
    // component itself has already been detached.
    syncEntityMeshes({
      scene,
      meshes: shieldMeshes,
      eids: query(sim, [BikeTag, Transform]),
      filter: (eid) => {
        const shield = ShieldEffectStore.get(eid)
        if (!shield || shield.remaining <= 0) return false
        return hasComponent(sim, eid, ShieldEffect)
      },
      factory: createShieldMesh,
      update: (mesh, eid) => {
        const shield = ShieldEffectStore.must(eid)
        const t = TransformStore.must(eid)
        mesh.position.set(t.x, t.y, t.z)
        // Fade out as it expires (last second drops to 0).
        const opacity = Math.min(1, shield.remaining) * 0.45
        const inner = mesh.children[0] as THREE.Mesh
        const innerMat = inner.material as THREE.MeshBasicMaterial
        innerMat.opacity = opacity
      },
    })

    syncEntityMeshes({
      scene,
      meshes: explosionMeshes,
      eids: query(sim, [ExplosionTag, ExplosionState]),
      factory: (eid) => createExplosionMesh(ExplosionStateStore.must(eid).color),
      update: (mesh, eid) => {
        const e = ExplosionStateStore.must(eid)
        mesh.position.set(e.position.x, e.position.y, e.position.z)
        const u = Math.min(1, e.ageSec / e.lifetime)
        const scale = 0.6 + u * 4.0 // grow from 0.6× to ~4.6× over lifetime
        mesh.scale.setScalar(scale)
        const mat = (mesh as THREE.Mesh).material as THREE.MeshBasicMaterial
        mat.opacity = (1 - u) * 0.9
      },
    })
  }
}

// --- Mesh factories ----------------------------------------------------------

function createMineMesh(): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'mine'
  const discMat = new THREE.MeshStandardMaterial({
    color: 0x66ddff,
    emissive: 0x3399cc,
    emissiveIntensity: 0.6,
    roughness: 0.4,
    metalness: 0.3,
  })
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 0.18, 16), discMat)
  root.add(disc)
  // Pulsing additive glow ring under the disc.
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0x66ddff,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const glow = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.2, 24), glowMat)
  glow.rotation.x = -Math.PI / 2
  glow.position.y = -0.05
  root.add(glow)
  return root
}

function createMissileMesh(): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'missile'
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xff5577,
    emissive: 0xff3344,
    emissiveIntensity: 0.7,
    roughness: 0.4,
    metalness: 0.3,
  })
  // Cone tip along +Z so lookAt(target) aims correctly.
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.9, 12), bodyMat)
  cone.rotation.x = Math.PI / 2
  cone.position.z = 0.15
  root.add(cone)
  // Glow halo at the back so the silhouette reads against any sky.
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xff5577,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), glowMat)
  glow.position.z = -0.35
  root.add(glow)
  return root
}

function createShieldMesh(): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'shield'
  // Inner additive shell — soft glow, never fully solid.
  const innerMat = new THREE.MeshBasicMaterial({
    color: 0x66ff99,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const inner = new THREE.Mesh(new THREE.SphereGeometry(1.4, 18, 14), innerMat)
  root.add(inner)
  return root
}

function createExplosionMesh(color: number): THREE.Object3D {
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), mat)
  mesh.frustumCulled = false
  return mesh
}
