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

/**
 * Render-side bookkeeping for combat visuals: mines, missiles, shield
 * bubbles, and explosions. Each entity type has its own per-eid mesh map;
 * orphans are removed when their sim-side entities go away.
 */
export function createCombatRenderSystem(scene: THREE.Scene, sim: SimWorld) {
  const mineMeshes = new Map<number, THREE.Object3D>()
  const missileMeshes = new Map<number, THREE.Object3D>()
  const shieldMeshes = new Map<number, THREE.Object3D>()
  const explosionMeshes = new Map<number, THREE.Object3D>()

  return function tick(_dt: number): void {
    // --- Mines ---
    {
      const eids = query(sim, [MineTag, MineState])
      const live = new Set<number>()
      for (const eid of eids) {
        live.add(eid)
        const m = MineStateStore.must(eid)
        let mesh = mineMeshes.get(eid)
        if (!mesh) {
          mesh = createMineMesh()
          scene.add(mesh)
          mineMeshes.set(eid, mesh)
        }
        mesh.position.set(m.position.x, m.position.y, m.position.z)
        // Spin the disc.
        mesh.rotation.y = m.ageSec * 4
        // Pulse glow with age (low-frequency cosine for a steady throb).
        const glow = mesh.children[1] as THREE.Mesh
        const glowMat = glow.material as THREE.MeshBasicMaterial
        const pulse = 0.45 + 0.25 * Math.cos(m.ageSec * 6)
        glowMat.opacity = m.detonated ? 0 : pulse
      }
      for (const [eid, mesh] of mineMeshes) {
        if (!live.has(eid)) {
          scene.remove(mesh)
          disposeMesh(mesh)
          mineMeshes.delete(eid)
        }
      }
    }

    // --- Missiles ---
    {
      const eids = query(sim, [MissileTag, MissileState])
      const live = new Set<number>()
      for (const eid of eids) {
        live.add(eid)
        const m = MissileStateStore.must(eid)
        let mesh = missileMeshes.get(eid)
        if (!mesh) {
          mesh = createMissileMesh()
          scene.add(mesh)
          missileMeshes.set(eid, mesh)
        }
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
      }
      for (const [eid, mesh] of missileMeshes) {
        if (!live.has(eid)) {
          scene.remove(mesh)
          disposeMesh(mesh)
          missileMeshes.delete(eid)
        }
      }
    }

    // --- Shield bubbles (one per bike with ShieldEffect.remaining > 0) ---
    {
      const bikeEids = query(sim, [BikeTag, Transform])
      const live = new Set<number>()
      for (const bEid of bikeEids) {
        const shield = ShieldEffectStore.get(bEid)
        if (!shield || shield.remaining <= 0) continue
        // Make sure the bike actually has the ShieldEffect component
        // attached (not just a stale store entry from an old hit).
        if (!hasComponent(sim, bEid, ShieldEffect)) continue
        live.add(bEid)
        let mesh = shieldMeshes.get(bEid)
        if (!mesh) {
          mesh = createShieldMesh()
          scene.add(mesh)
          shieldMeshes.set(bEid, mesh)
        }
        const t = TransformStore.must(bEid)
        mesh.position.set(t.x, t.y, t.z)
        // Fade out as it expires (last second drops to 0).
        const opacity = Math.min(1, shield.remaining) * 0.45
        const inner = mesh.children[0] as THREE.Mesh
        const innerMat = inner.material as THREE.MeshBasicMaterial
        innerMat.opacity = opacity
      }
      for (const [eid, mesh] of shieldMeshes) {
        if (!live.has(eid)) {
          scene.remove(mesh)
          disposeMesh(mesh)
          shieldMeshes.delete(eid)
        }
      }
    }

    // --- Explosions ---
    {
      const eids = query(sim, [ExplosionTag, ExplosionState])
      const live = new Set<number>()
      for (const eid of eids) {
        live.add(eid)
        const e = ExplosionStateStore.must(eid)
        let mesh = explosionMeshes.get(eid)
        if (!mesh) {
          mesh = createExplosionMesh(e.color)
          scene.add(mesh)
          explosionMeshes.set(eid, mesh)
        }
        mesh.position.set(e.position.x, e.position.y, e.position.z)
        const u = Math.min(1, e.ageSec / e.lifetime)
        const scale = 0.6 + u * 4.0 // grow from 0.6× to ~4.6× over lifetime
        mesh.scale.setScalar(scale)
        const mat = (mesh as THREE.Mesh).material as THREE.MeshBasicMaterial
        mat.opacity = (1 - u) * 0.9
      }
      for (const [eid, mesh] of explosionMeshes) {
        if (!live.has(eid)) {
          scene.remove(mesh)
          disposeMesh(mesh)
          explosionMeshes.delete(eid)
        }
      }
    }
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

function disposeMesh(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose()
      const m = child.material
      if (Array.isArray(m)) {
        for (const mm of m) mm.dispose()
      } else if (m) {
        m.dispose()
      }
    }
  })
}
