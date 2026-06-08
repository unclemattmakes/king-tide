import { hasComponent, query } from 'bitecs'
import * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { cloneLoadedBike, type LoadedBike } from '@/game/assets/bike-loader'
import {
  BikeStatsStore,
  BikeTag,
  GhostTag,
  PeerControlled,
  PeerControlledStore,
  PlayerTag,
  Transform,
  TransformStore,
  TrickState,
  TrickStateStore,
} from '@/game/components'
import { createBikeMesh } from './bike-mesh'
import { applyVinylMaterialToScene } from './painterly-vinyl-material'

const PLAYER_FALLBACK_COLOR = 0xff7733
const AI_BODY_COLORS = [0x33aaff, 0x44dd66, 0xcc55ff, 0xffcc33, 0xff5577]
const GHOST_OPACITY = 0.35
// Cyan-ish overlay tint so the ghost reads as "you (last run)" rather
// than a regular opponent. Matches the wave-pump HUD palette family.
const GHOST_TINT = 0x66ddff
// The ghost is the only bike rendered transparent with depthWrite=false
// (a hologram), so it never lands in the depth buffer. The center water
// surface is also transparent but writes depth and is near-opaque, and
// it's camera-locked — so its sort centroid sits nearer the camera than
// the chase-distance ghost and, in the back-to-front transparent sort,
// the water reliably draws AFTER the ghost and repaints every pixel where
// water is the backdrop, erasing it. A renderOrder above the water's (0)
// forces the ghost to composite after it; depthTest stays on, so the
// genuinely-submerged parts are still culled. Kept below the spray / foam
// particle FX (renderOrder 2) so kicked-up spray layers over the ghost
// the same way it does over opaque bikes. Opaque bikes don't need this —
// they're in the depth buffer already, so the water depth-tests against
// them and never paints over them.
const GHOST_RENDER_ORDER = 1
// Exhaust glow tints — formerly the long-ribbon trail colors. The thruster
// cone material (`mat_bike_*_glow`) is retinted per-bike so each racer
// stays color-identifiable now that the ribbon trails are gone.
const PLAYER_EXHAUST_COLOR = 0xffaa55
const AI_EXHAUST_COLORS = [0x55ccff, 0x66ee88, 0xdd66ff, 0xffdd44, 0xff7799]

// Bike visual scale. Physics colliders (read from the GLB at bike creation)
// are authored at 1× — and so are the track + props — so 1.0 makes the
// rendered bike match its own collider, the world, and a true human-scale
// rider. (Was 2.0, a render-only inflation that forced the rider to be sized
// ~2× human and the chase camera to be pulled in to compensate; both were
// reverted alongside this — see RIDER_SCALE in entities/rider.ts and the
// idealOffset in camera.ts.)
const BIKE_VISUAL_SCALE = 1.0

/** Brush-stroke amount on the bikes — a touch lighter than the prop/building
 *  default so the sleek hero chassis reads painterly without going busy at the
 *  close chase-cam distance. Tune by eye. */
const BIKE_BRUSH = 0.85

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
  // Reusable quaternion + axis scratch — applying the trick-spin
  // every frame would otherwise alloc per bike per tick.
  const baseQuat = new THREE.Quaternion()
  const spinQuat = new THREE.Quaternion()
  const spinAxis = new THREE.Vector3()

  return function tick(): void {
    const eids = query(sim, [BikeTag, Transform])
    live.clear()
    for (const eid of eids) {
      live.add(eid)
      let mesh = meshes.get(eid)
      if (!mesh) {
        const isPlayer = hasComponent(sim, eid, PlayerTag)
        const isGhost = hasComponent(sim, eid, GhostTag)
        const stats = BikeStatsStore.get(eid)
        const variantId = stats?.variantId
        const variantColor = stats?.bodyColor

        if (registry) {
          const loaded = (variantId && registry.byVariantId[variantId]) || registry.default
          if (isGhost) {
            mesh = cloneLoadedBike(loaded, {
              tintLivery: GHOST_TINT,
              tintExhaust: GHOST_TINT,
            }).root
          } else if (isPlayer) {
            // Player livery follows the variant's bodyColor so the
            // 5-bike picker reads visibly distinct in race. Phase F
            // of the asset-pipeline plan introduced Scout (orange) +
            // Sparrow (yellow) — without this tint, Sparrow would
            // render as the baked Racer orange since its GLB ships
            // as a Racer copy until a dedicated Blender source lands.
            const tintLivery = variantColor
            mesh = cloneLoadedBike(loaded, {
              tintExhaust: PLAYER_EXHAUST_COLOR,
              ...(tintLivery !== undefined ? { tintLivery } : {}),
            }).root
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
          const color = isGhost
            ? GHOST_TINT
            : isPlayer
              ? (variantColor ?? PLAYER_FALLBACK_COLOR)
              : (AI_BODY_COLORS[aiColorCursor++ % AI_BODY_COLORS.length] ?? 0xaaaaaa)
          mesh = createBikeMesh({ bodyColor: color })
        }
        mesh.scale.setScalar(BIKE_VISUAL_SCALE)
        // Painterly-vinyl brush treatment on the bike (ghosts keep their clean
        // hologram look). Runs AFTER cloneLoadedBike's per-bike livery/exhaust
        // tint so strokes ride on the racer colour; applyVinylMaterialToScene
        // stamps a neutral COLOR_0 (bikes carry none → no AO-darken), sizes the
        // strokes per mesh, and preserves the emissive glow material.
        if (isGhost) applyGhostMaterial(mesh)
        else applyVinylMaterialToScene(mesh, { brush: BIKE_BRUSH })
        scene.add(mesh)
        meshes.set(eid, mesh)
      }
      const t = TransformStore.must(eid)
      mesh.position.set(t.x, t.y, t.z)
      baseQuat.set(t.qx, t.qy, t.qz, t.qw)
      // Visual-only trick spin — multiply a signed-axis rotation
      // (Y = yaw, X = flip, Z = roll) onto the bike's base
      // quaternion. Phase 1 → 0 over the trick's lifetime, so
      // `(1 − phase)` is the eased "progress through the spin";
      // full 360° gives the bike one clean revolution around the
      // chosen axis. The rigid body never sees this — heading +
      // collision stay on the simulation's quaternion, so a trick
      // mid-corner doesn't veer the bike off line.
      const trick = hasComponent(sim, eid, TrickState) ? TrickStateStore.get(eid) : null
      if (trick && trick.spinPhase > 0) {
        const ax = trick.spinAxisX
        const ay = trick.spinAxisY
        const az = trick.spinAxisZ
        const len2 = ax * ax + ay * ay + az * az
        if (len2 > 1e-6) {
          const progress = 1 - trick.spinPhase
          // Quadratic ease-out so the spin starts crisp and decelerates
          // toward the landing pose — easier to read than a linear spin
          // at typical 0.6 s duration.
          const eased = 1 - (1 - progress) * (1 - progress)
          const angle = eased * Math.PI * 2
          // Sign + magnitude come from the axis vector — only one
          // component is non-zero per trick. Normalise just in case
          // an external setter writes a non-unit vector.
          const invLen = 1 / Math.sqrt(len2)
          spinAxis.set(ax * invLen, ay * invLen, az * invLen)
          spinQuat.setFromAxisAngle(spinAxis, angle)
          baseQuat.multiply(spinQuat)
        }
      }
      mesh.quaternion.copy(baseQuat)
    }
    for (const [eid, mesh] of meshes) {
      if (!live.has(eid)) {
        scene.remove(mesh)
        meshes.delete(eid)
      }
    }
  }
}

/**
 * Walk the cloned bike mesh and switch every material to additive-ish
 * translucency so the ghost reads as a hologram: see-through, cyan-
 * tinted, no shadow casting/receiving. Shadow toggles also prevent
 * the rendered ghost from punching a dark hole into the scene below
 * itself when the player is racing close to the same line.
 */
function applyGhostMaterial(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.castShadow = false
    mesh.receiveShadow = false
    // Composite after the (transparent, camera-locked) water — see
    // GHOST_RENDER_ORDER. Per-mesh because the transparent sort keys off
    // each object's own renderOrder, not the parent group's.
    mesh.renderOrder = GHOST_RENDER_ORDER
    const mat = mesh.material as
      | THREE.Material
      | THREE.Material[]
      | THREE.MeshStandardMaterial
      | undefined
    if (!mat) return
    if (Array.isArray(mat)) {
      mesh.material = mat.map((m) => makeGhostMaterial(m))
    } else {
      mesh.material = makeGhostMaterial(mat as THREE.Material)
    }
  })
}

function makeGhostMaterial(source: THREE.Material): THREE.Material {
  // Clone so the original (cached) material isn't mutated for other
  // bikes that share the same source GLB.
  const m = source.clone()
  m.transparent = true
  m.opacity = GHOST_OPACITY
  m.depthWrite = false
  const std = m as Partial<THREE.MeshStandardMaterial>
  if (std.emissive) {
    std.emissive.setHex(GHOST_TINT)
    std.emissiveIntensity = 0.6
  }
  return m
}
