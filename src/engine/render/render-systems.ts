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
import { createInstancedBikeField } from './instanced-bikes'
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

/** Edge-wear drybrush on the bikes — bakes per-vertex convexity and lightens the
 *  hard chassis edges (the painted-miniature pop). A touch under the 0.66 prop
 *  default so the livery still reads. Stable on the moving bike because it's a
 *  baked vertex attribute, not a world-space field. Tune by eye. */
const BIKE_EDGE_WEAR = 0.55

/** Capacity of the instanced AI/peer field — the max non-player, non-ghost bikes
 *  drawn through the shared racer GLB (single-player tops out ~7; leaves room for
 *  a full multiplayer room). */
const MAX_INSTANCED_BIKES = 16

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
  opts?: { instanced?: boolean },
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

  // Instanced AI/peer field on the racer GLB — built eagerly (when a registry is
  // present) so its handful of shared materials compile in the boot pre-warm
  // instead of one set per cloned bike.
  const field =
    registry && opts?.instanced !== false
      ? createInstancedBikeField(registry.default, MAX_INSTANCED_BIKES, {
          brush: BIKE_BRUSH,
          edgeWear: BIKE_EDGE_WEAR,
          visualScale: BIKE_VISUAL_SCALE,
        })
      : null
  if (field) {
    scene.add(field.group)
    // Dev/test read-back hook so a harness can assert the field renders distinct,
    // placed bikes regardless of camera framing.
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      ;(window as unknown as { __bikeField?: typeof field }).__bikeField = field
    }
  }
  const bikeIndex = new Map<number, number>()
  const freeIndices: number[] = []
  let nextIndex = 0
  const bikePos = new THREE.Vector3()
  const bikeMat = new THREE.Matrix4()
  const ONE = new THREE.Vector3(1, 1, 1)

  // AI/peer bikes whose variant resolves to the default (racer) GLB render in the
  // instanced field; the player, the TT ghost, any non-default variant, and the
  // no-registry test path stay on the per-clone single-mesh path.
  function instanceable(eid: number, isPlayer: boolean, isGhost: boolean): boolean {
    if (!field || !registry || isPlayer || isGhost) return false
    const variantId = BikeStatsStore.get(eid)?.variantId
    const loaded = (variantId && registry.byVariantId[variantId]) || registry.default
    return loaded === registry.default
  }

  // Per-bike accent colours: a deterministic peerId slot for remote peers, else
  // the cursor cycle for AI. Shared by the instanced + single paths.
  function aiColors(eid: number): { livery: number; exhaust: number } {
    const peer = hasComponent(sim, eid, PeerControlled) ? PeerControlledStore.get(eid) : null
    const slot =
      peer !== null && peer !== undefined
        ? peer.peerId % AI_BODY_COLORS.length
        : aiColorCursor++ % AI_BODY_COLORS.length
    return {
      livery: AI_BODY_COLORS[slot] ?? 0xaaaaaa,
      exhaust: AI_EXHAUST_COLORS[slot] ?? 0xffffff,
    }
  }

  // Build a per-clone bike mesh (player / TT ghost / non-default AI / procedural).
  function createSingleBikeMesh(eid: number, isPlayer: boolean, isGhost: boolean): THREE.Object3D {
    const stats = BikeStatsStore.get(eid)
    const variantId = stats?.variantId
    const variantColor = stats?.bodyColor
    let mesh: THREE.Object3D
    if (registry) {
      const loaded = (variantId && registry.byVariantId[variantId]) || registry.default
      if (isGhost) {
        mesh = cloneLoadedBike(loaded, { tintLivery: GHOST_TINT, tintExhaust: GHOST_TINT }).root
      } else if (isPlayer) {
        // Player livery follows the variant's bodyColor so the bike picker reads
        // visibly distinct in race (Sparrow etc. ship as a Racer copy for now).
        const tintLivery = variantColor
        mesh = cloneLoadedBike(loaded, {
          tintExhaust: PLAYER_EXHAUST_COLOR,
          ...(tintLivery !== undefined ? { tintLivery } : {}),
        }).root
      } else {
        const c = aiColors(eid)
        mesh = cloneLoadedBike(loaded, { tintLivery: c.livery, tintExhaust: c.exhaust }).root
      }
    } else {
      const color = isGhost
        ? GHOST_TINT
        : isPlayer
          ? (variantColor ?? PLAYER_FALLBACK_COLOR)
          : aiColors(eid).livery
      mesh = createBikeMesh({ bodyColor: color })
    }
    mesh.scale.setScalar(BIKE_VISUAL_SCALE)
    // Ghosts keep their clean hologram look; everything else takes the painterly-
    // vinyl brush in the bike's own (object) space so strokes don't swim as it
    // tears across the map.
    if (isGhost) applyGhostMaterial(mesh)
    else
      applyVinylMaterialToScene(mesh, {
        brush: BIKE_BRUSH,
        edgeWear: BIKE_EDGE_WEAR,
        brushObjectSpace: true,
      })
    return mesh
  }

  return function tick(): void {
    const eids = query(sim, [BikeTag, Transform])
    live.clear()
    for (const eid of eids) {
      live.add(eid)
      const isPlayer = hasComponent(sim, eid, PlayerTag)
      const isGhost = hasComponent(sim, eid, GhostTag)

      // Base orientation + the visual-only trick spin — shared by both render
      // paths. (Y = yaw, X = flip, Z = roll; phase 1 → 0 eases one clean
      // revolution. The rigid body never sees this, so a trick mid-corner doesn't
      // veer the bike off its line.)
      const t = TransformStore.must(eid)
      baseQuat.set(t.qx, t.qy, t.qz, t.qw)
      const trick = hasComponent(sim, eid, TrickState) ? TrickStateStore.get(eid) : null
      if (trick && trick.spinPhase > 0) {
        const ax = trick.spinAxisX
        const ay = trick.spinAxisY
        const az = trick.spinAxisZ
        const len2 = ax * ax + ay * ay + az * az
        if (len2 > 1e-6) {
          const progress = 1 - trick.spinPhase
          const eased = 1 - (1 - progress) * (1 - progress)
          const angle = eased * Math.PI * 2
          const invLen = 1 / Math.sqrt(len2)
          spinAxis.set(ax * invLen, ay * invLen, az * invLen)
          spinQuat.setFromAxisAngle(spinAxis, angle)
          baseQuat.multiply(spinQuat)
        }
      }

      // ── Instanced path: AI / peer bikes sharing the racer GLB. ──
      if (field && instanceable(eid, isPlayer, isGhost)) {
        let idx = bikeIndex.get(eid)
        if (idx === undefined) {
          idx = freeIndices.pop() ?? nextIndex++
          bikeIndex.set(eid, idx)
          const c = aiColors(eid)
          field.setColors(idx, c.livery, c.exhaust)
        }
        bikePos.set(t.x, t.y, t.z)
        bikeMat.compose(bikePos, baseQuat, ONE)
        field.setMatrix(idx, bikeMat)
        continue
      }

      // ── Single-mesh path: player, TT ghost, non-default AI, procedural. ──
      let mesh = meshes.get(eid)
      if (!mesh) {
        mesh = createSingleBikeMesh(eid, isPlayer, isGhost)
        scene.add(mesh)
        meshes.set(eid, mesh)
      }
      mesh.position.set(t.x, t.y, t.z)
      mesh.quaternion.copy(baseQuat)
    }

    // Despawn — free instanced slots, drop single meshes.
    for (const [eid, idx] of bikeIndex) {
      if (!live.has(eid)) {
        field?.park(idx)
        freeIndices.push(idx)
        bikeIndex.delete(eid)
      }
    }
    for (const [eid, mesh] of meshes) {
      if (!live.has(eid)) {
        scene.remove(mesh)
        meshes.delete(eid)
      }
    }
    field?.setDrawCount(nextIndex)
    field?.flush()
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
