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
import {
  createInstancedBikeField,
  type InstancedBikeField,
  type SharedVinylCache,
} from './instanced-bikes'
import { applyVinylMaterialToScene, vinylRimHandle } from './painterly-vinyl-material'
import { getBikeSignal } from './signal-state'

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
 * If a `registry` is supplied (the runtime path), each bike renders its
 * variant's GLB — the player as a per-clone hero mesh with variant livery,
 * AI/peer bikes through a per-variant instanced field with their slot's
 * accent color as a per-instance tint so the grid reads varied.
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
  // Per-eid additive-rim handles for single-mesh bikes (the player + TT-ghost /
  // non-default-AI path) — drives the style-as-legibility rim from each bike's
  // signal each frame (the instanced path uses per-instance attributes instead).
  const rimHandles = new Map<number, NonNullable<ReturnType<typeof vinylRimHandle>>[]>()
  // Reused per-frame scratch for the live-eids reconciliation set.
  const live = new Set<number>()
  let aiColorCursor = 0
  // Reusable quaternion + axis scratch — applying the trick-spin
  // every frame would otherwise alloc per bike per tick.
  const baseQuat = new THREE.Quaternion()
  const spinQuat = new THREE.Quaternion()
  const spinAxis = new THREE.Vector3()

  // Instanced AI/peer fields — ONE per distinct bike GLB in play (AI spawn with
  // their slot's variantId, so a race grid fields every variant). Each field
  // shares a single vinyl material set across its instances with per-instance
  // aTint livery; the records for bikes that already spawned (phase 5 precedes
  // render-system construction) are built eagerly below so their materials
  // compile in the boot pre-warm. Late arrivals (multiplayer joins) build
  // their field on first claim.
  type FieldRecord = {
    field: InstancedBikeField
    bikeIndex: Map<number, number>
    freeIndices: number[]
    nextIndex: number
  }
  const instancedOn = Boolean(registry && opts?.instanced !== false)
  const fields = new Map<LoadedBike, FieldRecord>()
  // One vinyl cache across ALL fields: equivalent materials in different
  // variant GLBs (untextured livery/glow under aTint, the near-black chassis
  // family) collapse to single compiled instances, so a five-variant grid
  // pre-warms ~one field's worth of materials, not five.
  const sharedVinyl: SharedVinylCache = new Map()

  /** The GLB a bike renders with (variant when loaded, else the default). */
  function resolveLoadedBike(eid: number): LoadedBike | null {
    if (!registry) return null
    const variantId = BikeStatsStore.get(eid)?.variantId
    return (variantId && registry.byVariantId[variantId]) || registry.default
  }

  function fieldFor(loaded: LoadedBike): FieldRecord {
    let rec = fields.get(loaded)
    if (!rec) {
      rec = {
        field: createInstancedBikeField(loaded, MAX_INSTANCED_BIKES, {
          brush: BIKE_BRUSH,
          edgeWear: BIKE_EDGE_WEAR,
          visualScale: BIKE_VISUAL_SCALE,
          sharedVinyl,
        }),
        bikeIndex: new Map(),
        freeIndices: [],
        nextIndex: 0,
      }
      scene.add(rec.field.group)
      fields.set(loaded, rec)
    }
    return rec
  }

  // AI/peer bikes render in the instanced field for their variant's GLB; the
  // player (hero clone with variant livery), the TT ghost (hologram material),
  // and the no-registry test path stay on the per-clone single-mesh path.
  function instanceable(isPlayer: boolean, isGhost: boolean): boolean {
    return instancedOn && !isPlayer && !isGhost
  }

  if (instancedOn) {
    // Eager pre-build for the spawned grid so the pre-warm sees every field.
    for (const eid of query(sim, [BikeTag])) {
      const isPlayer = hasComponent(sim, eid, PlayerTag)
      const isGhost = hasComponent(sim, eid, GhostTag)
      if (!instanceable(isPlayer, isGhost)) continue
      const loaded = resolveLoadedBike(eid)
      if (loaded) fieldFor(loaded)
    }
    // Dev/test read-back hook so a harness can assert the field renders
    // distinct, placed bikes regardless of camera framing. Aggregates across
    // the per-variant fields.
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      const aggregate = {
        debug: () => [...fields.values()].flatMap((rec) => rec.field.debug()),
      }
      ;(window as unknown as { __bikeField?: typeof aggregate }).__bikeField = aggregate
    }
  }
  const bikePos = new THREE.Vector3()
  const bikeMat = new THREE.Matrix4()
  const ONE = new THREE.Vector3(1, 1, 1)

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

      // ── Instanced path: AI / peer bikes on their variant's field. ──
      if (instanceable(isPlayer, isGhost)) {
        const loaded = resolveLoadedBike(eid)
        if (loaded) {
          const rec = fieldFor(loaded)
          let idx = rec.bikeIndex.get(eid)
          if (idx === undefined) {
            idx = rec.freeIndices.pop() ?? rec.nextIndex++
            rec.bikeIndex.set(eid, idx)
            const c = aiColors(eid)
            rec.field.setColors(idx, c.livery, c.exhaust)
          }
          bikePos.set(t.x, t.y, t.z)
          bikeMat.compose(bikePos, baseQuat, ONE)
          rec.field.setMatrix(idx, bikeMat)
          // Style-as-legibility (B1/B5): paint this bike's gameplay-state rim
          // signal (drift-charge ladder, rival/draft) per instance. No-op while
          // the master flag is off — getBikeSignal returns a strength-0 signal,
          // so the rim contributes vec3(0). See signal-state.ts /
          // docs/painterly-legibility-plan.md.
          rec.field.setRimSignal(idx, getBikeSignal(eid))
          continue
        }
      }

      // ── Single-mesh path: player, TT ghost, non-default AI, procedural. ──
      let mesh = meshes.get(eid)
      if (!mesh) {
        mesh = createSingleBikeMesh(eid, isPlayer, isGhost)
        scene.add(mesh)
        meshes.set(eid, mesh)
        // Cache the per-object rim handles once so the per-frame signal update is
        // a couple of uniform writes (ghosts use a non-vinyl material → none).
        const collected: NonNullable<ReturnType<typeof vinylRimHandle>>[] = []
        mesh.traverse((obj) => {
          const m = obj as THREE.Mesh
          if (!m.isMesh || !m.material) return
          const mats = Array.isArray(m.material) ? m.material : [m.material]
          for (const mat of mats) {
            const h = vinylRimHandle(mat)
            if (h) collected.push(h)
          }
        })
        rimHandles.set(eid, collected)
      }
      mesh.position.set(t.x, t.y, t.z)
      mesh.quaternion.copy(baseQuat)
      // Style-as-legibility (B1/B5): drive this single-mesh bike's rim from its
      // gameplay-state signal (the player's own drift-charge ladder). getBikeSignal
      // returns strength 0 when the master flag is off, so this is a no-op then.
      const sig = getBikeSignal(eid)
      const handles = rimHandles.get(eid)
      if (handles) {
        for (const h of handles) {
          h.uStrength.value = sig.strength
          if (sig.strength > 0) h.uColor.value.copy(sig.color)
        }
      }
    }

    // Despawn — free instanced slots, drop single meshes.
    for (const rec of fields.values()) {
      for (const [eid, idx] of rec.bikeIndex) {
        if (!live.has(eid)) {
          rec.field.park(idx)
          rec.freeIndices.push(idx)
          rec.bikeIndex.delete(eid)
        }
      }
    }
    for (const [eid, mesh] of meshes) {
      if (!live.has(eid)) {
        scene.remove(mesh)
        meshes.delete(eid)
        rimHandles.delete(eid)
      }
    }
    for (const rec of fields.values()) {
      rec.field.setDrawCount(rec.nextIndex)
      rec.field.flush()
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
