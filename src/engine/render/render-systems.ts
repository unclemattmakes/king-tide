import { hasComponent, query } from 'bitecs'
import type * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { cloneLoadedBike, type LoadedBike } from '@/game/assets/bike-loader'
import {
  BikeStatsStore,
  BikeTag,
  PeerControlled,
  PeerControlledStore,
  PlayerTag,
  Transform,
  TransformStore,
} from '@/game/components'
import { createBikeMesh } from './bike-mesh'

const PLAYER_FALLBACK_COLOR = 0xff7733
const AI_BODY_COLORS = [0x33aaff, 0x44dd66, 0xcc55ff, 0xffcc33, 0xff5577]
// Exhaust glow tints — formerly the long-ribbon trail colors. The thruster
// cone material (`mat_bike_*_glow`) is retinted per-bike so each racer
// stays color-identifiable now that the ribbon trails are gone.
const PLAYER_EXHAUST_COLOR = 0xffaa55
const AI_EXHAUST_COLORS = [0x55ccff, 0x66ee88, 0xdd66ff, 0xffdd44, 0xff7799]

// Visual-only bike scale. Physics colliders (read from the GLB at bike
// creation) stay at authored size — only the rendered mesh is scaled,
// so collisions / hover heights / wake source positions don't shift.
// Camera framing (camera.ts) is tuned around this 2× scale.
const BIKE_VISUAL_SCALE = 2.0

export type BikeRenderRegistry = {
  /** Resolve a variant id to a loaded GLB. Falls back to `default` when
   *  the id is unknown. */
  byVariantId: Record<string, LoadedBike>
  /** Default GLB used when no variant id is set or the id misses
   *  (typically the racer baseline). */
  default: LoadedBike
}

/**
 * Bike render system.
 *
 * If a `registry` is supplied (the runtime path), each bike's mesh is
 * cloned from a loaded bike GLB — the player gets their picked variant,
 * AI bikes use the default visual with their slot's accent color
 * tinting the livery material so the field reads varied.
 *
 * Without a registry the system falls back to the procedural
 * `createBikeMesh()` (kept for tests and any path that doesn't want to
 * fetch a GLB at boot).
 */
export function createBikeRenderSystem(
  scene: THREE.Scene,
  sim: SimWorld,
  registry?: BikeRenderRegistry,
) {
  const meshes = new Map<number, THREE.Object3D>()
  // Reused per-frame scratch for the live-eids reconciliation set.
  const live = new Set<number>()
  let aiColorCursor = 0

  return function tick(): void {
    const eids = query(sim, [BikeTag, Transform])
    live.clear()
    for (const eid of eids) {
      live.add(eid)
      let mesh = meshes.get(eid)
      if (!mesh) {
        const isPlayer = hasComponent(sim, eid, PlayerTag)
        const stats = BikeStatsStore.get(eid)
        const variantId = stats?.variantId
        const variantColor = stats?.bodyColor

        if (registry) {
          const loaded = (variantId && registry.byVariantId[variantId]) || registry.default
          if (isPlayer) {
            mesh = cloneLoadedBike(loaded, { tintExhaust: PLAYER_EXHAUST_COLOR }).root
          } else {
            // M10.9 — remote-peer bikes (tagged PeerControlled) use a
            // deterministic peerId-based color slot so a peer who
            // reconnects gets the same hue. AI bikes (no PeerControlled)
            // fall back to the cursor cycle.
            const peer = hasComponent(sim, eid, PeerControlled)
              ? PeerControlledStore.get(eid)
              : null
            const slot =
              peer !== null && peer !== undefined
                ? peer.peerId % AI_BODY_COLORS.length
                : aiColorCursor++ % AI_BODY_COLORS.length
            const tintLivery = AI_BODY_COLORS[slot] ?? 0xaaaaaa
            const tintExhaust = AI_EXHAUST_COLORS[slot] ?? 0xffffff
            mesh = cloneLoadedBike(loaded, { tintLivery, tintExhaust }).root
          }
        } else {
          const color = isPlayer
            ? (variantColor ?? PLAYER_FALLBACK_COLOR)
            : (AI_BODY_COLORS[aiColorCursor++ % AI_BODY_COLORS.length] ?? 0xaaaaaa)
          mesh = createBikeMesh({ bodyColor: color })
        }
        mesh.scale.setScalar(BIKE_VISUAL_SCALE)
        scene.add(mesh)
        meshes.set(eid, mesh)
      }
      const t = TransformStore.must(eid)
      mesh.position.set(t.x, t.y, t.z)
      mesh.quaternion.set(t.qx, t.qy, t.qz, t.qw)
    }
    for (const [eid, mesh] of meshes) {
      if (!live.has(eid)) {
        scene.remove(mesh)
        meshes.delete(eid)
      }
    }
  }
}
