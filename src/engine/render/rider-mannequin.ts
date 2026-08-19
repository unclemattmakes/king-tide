import { hasComponent, query } from 'bitecs'
import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { LoadedProp } from '@/game/assets/prop-loader'
import { resolveBikeVariant } from '@/game/bikes/variants'
import {
  BikeStatsStore,
  GhostTag,
  PeerControlled,
  PeerControlledStore,
  PlayerTag,
  TransformStore,
} from '@/game/components'
import { Rider, type RiderBoneName, RiderStore } from '@/game/components/rider'
import { applyVinylMaterialToScene, stampVinylTint, UD_TINT } from './painterly-vinyl-material'
import type { BikeRenderRegistry } from './render-systems'
import { riderPaletteForSlot } from './rider-palette'

/**
 * Rider mannequin render system — now the **default** rider visual
 * (opt out with `?rider=capsule`). Started as a spike; promoted to default.
 *
 * Renders the rigged **Quaternius Universal** character (UE-mannequin skeleton,
 * `cc0/rider_mannequin`) in place of the capsule rider, to explore replacing the
 * rider + re-meshing custom characters onto this rig later
 * (docs/rider-character-investigation.md). Render-only — the sim's 12-bone
 * physics rider still drives gameplay/ragdoll.
 *
 * Two states, read from `RiderData.state`:
 *
 *  - **attached → clip + additive physics.** Plays the bike's seated idle (the
 *    per-variant `riderClip`, default `Sitting_Idle_Loop`) on a per-rider
 *    `AnimationMixer` (correct mannequin proportions; the seated base pose is
 *    refined in-anim). On top: the group is seated on the bike and inherits the
 *    bike's full orientation (banks/pitches/bounces with the bike), PLUS the
 *    rider's smoothed `RiderPoseResponse` (bounce / drift-lean / turn-in twist)
 *    is layered ADDITIVELY as an extra body tilt — "physics on the anim."
 *
 *    Bone-level additives (the head-look) MUST go through the clip-pose cache:
 *    restore the cached pure clip pose, `mixer.update`, re-cache, then multiply
 *    the offset on top. Multiplying directly and trusting the mixer to re-write
 *    the bone next frame breaks on the vehicle-specific idles — they're static
 *    pose clips, and `PropertyMixer.apply` skips `setValue` when the sampled
 *    value didn't change, so the offset would accumulate frame over frame
 *    (the "rider heads spin freely" bug).
 *
 *  - **launched → full ragdoll.** On a crash / shark-grab the sim rider goes
 *    dynamic; here we stop the clip and drive the UE bones straight from the 12
 *    dynamic bodies' world poses. The proportion stretch that made this drive
 *    wrong for a clean seated pose is exactly right for a flailing ragdoll. 🦴
 */

// Seated idle loop (falls back to the first clip if absent).
const RIDE_CLIP = 'Sitting_Idle_Loop'
/** Brush-stroke amount on the rider mannequin (tune by eye). */
const RIDER_BRUSH = 0.85
// Yaw to align the mannequin's facing onto the bike's forward (π faced it
// backwards in playtest, so 0).
const FACING_YAW = 0
// Rider placement on the bike — all tunable + HMR-live (edit, save, the running
// dev server reloads the page):
//   SEAT_OFFSET — nudge in bike-local metres on top of the sim seat anchor:
//     x = right, y = up, z = forward. (Tuned y=-0.8 from playtest.)
//   FIT_SCALE  — uniform size.   FACING_YAW (above) — facing.
const FIT_SCALE = 1.0
const SEAT_OFFSET = { x: 0, y: -0.4, z: 0 }

// Additive reactive gains — scale the smoothed RiderPoseResponse offsets (±0.5-
// 0.8 rad) down to a believable body tilt on top of the seated anim. Tunable;
// flip a sign if a reaction reads inverted.
const PITCH_GAIN = 0.5 // bouncePitch  → lean forward / back (about local X)
const YAW_GAIN = 0.3 // flowYaw      → torso twist into the turn (about local Y)
const ROLL_GAIN = 0.7 // leanRoll     → bank into the drift (about local Z)
const HEAD_YAW_GAIN = 0.75 // headYaw  → head leads the steer (about local Y).
// Bumped 0.6 → 0.75 with the fast-attack look (rider-pose.ts headYawAttack)
// so the "head turns first" read is legible at chase-cam distance: full
// deflection ≈ 30° total across neck + head. Tune by eye on playtest.
const HEAD_PITCH_GAIN = 0.5 // headPitch → nod with throttle / brake (about local X)

/** Bones that take the head-look offset, with their share of the total angle.
 *  Splitting across neck + head reads as the rider turning to look rather than
 *  the skull hinging on a frozen neck. Shares sum to 1 so the total equals the
 *  tuned single-bone gain. Both bones' local axes sit ≈ character-aligned in
 *  this rig (Y up, X right), so a local-Y yaw / local-X pitch is correct. */
const HEAD_LOOK_BONES: ReadonlyArray<{ bone: string; share: number }> = [
  { bone: 'neck_01', share: 0.35 },
  { bone: 'Head', share: 0.65 },
]

/** 12 logical rider bones → UE-mannequin bone (skin joint) names — ragdoll. */
const BONE_MAP: Record<RiderBoneName, string> = {
  pelvis: 'pelvis',
  abdomen: 'spine_01',
  chest: 'spine_03',
  head: 'Head',
  upper_arm_L: 'upperarm_l',
  lower_arm_L: 'lowerarm_l',
  upper_arm_R: 'upperarm_r',
  lower_arm_R: 'lowerarm_r',
  upper_leg_L: 'thigh_l',
  lower_leg_L: 'calf_l',
  upper_leg_R: 'thigh_r',
  lower_leg_R: 'calf_r',
}
const DRIVE_ORDER: RiderBoneName[] = [
  'pelvis',
  'abdomen',
  'chest',
  'head',
  'upper_arm_L',
  'lower_arm_L',
  'upper_arm_R',
  'lower_arm_R',
  'upper_leg_L',
  'lower_leg_L',
  'upper_leg_R',
  'lower_leg_R',
]

type MannequinInstance = {
  group: THREE.Object3D
  mixer: THREE.AnimationMixer
  action: THREE.AnimationAction | null
  bones: Map<string, THREE.Object3D>
  bikeEid: number
  seatLocal: { x: number; y: number; z: number }
  /** The bike's authored `socket_seat` in bike-local space — used as the root
   *  anchor when present (per-bike). Null → legacy seatLocal + SEAT_OFFSET. */
  socketSeat: { x: number; y: number; z: number } | null
  ragdoll: boolean
  /** Pure clip pose of each head-look bone, cached AFTER `mixer.update` and
   *  restored before the next one — see the layering note in the header. */
  clipPose: Map<string, THREE.Quaternion>
  /** Load-time local pose of every bone this system writes outside the mixer
   *  (ragdoll-driven + head-look). Restored on ragdoll → attached re-arm,
   *  because a static pose clip's mixer skips redundant writes and would
   *  otherwise leave the skeleton mangled where the ragdoll dropped it. */
  restPose: Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>
}

export function createRiderMannequinSystem(
  scene: THREE.Scene,
  sim: SimWorld,
  rig: LoadedProp,
  bikeRegistry?: BikeRenderRegistry,
): () => void {
  const instances = new Map<number, MannequinInstance>()
  const facingQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), FACING_YAW)

  // Scratch.
  const bikePos = new THREE.Vector3()
  const bikeQuat = new THREE.Quaternion()
  const seat = new THREE.Vector3()
  const additiveEuler = new THREE.Euler()
  const additiveQuat = new THREE.Quaternion()
  const headEuler = new THREE.Euler()
  const headQuat = new THREE.Quaternion()
  // Ragdoll bone-drive scratch.
  const worldM = new THREE.Matrix4()
  const parentInv = new THREE.Matrix4()
  const localM = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const one = new THREE.Vector3(1, 1, 1)
  const scratchScale = new THREE.Vector3()

  // Convert the SHARED rig's materials to painterly-vinyl ONCE, up front, so every
  // cloned rider references the SAME vinyl material — one shader compile for the
  // whole field instead of one per rider. Skinned meshes can't be merged into an
  // InstancedMesh (each needs its own skeleton), but they can share a material;
  // skinning is per-mesh, the material is not. brushObjectSpace keeps the strokes
  // riding the skin (bind-pose frame) rather than swimming as the rider moves.
  // `tintUserData` makes the base albedo a per-MESH read (UD_TINT) instead of the
  // material's flat colour, so every rider clone can carry its own suit tint off
  // the ONE shared material — no extra pipeline per colour (the field was eight
  // identical bright-yellow clones before). Each rider's meshes are stamped in
  // `build`; the player/host/ghost stamp each mesh's ORIGINAL material colour
  // (captured below, pre-conversion) so their shipped look is byte-faithful.
  //
  // Capture each mesh's pre-conversion flat colour first — the shipped look
  // multiplied it into the baked albedo, and the per-object tint path replaces
  // exactly that term. Keyed by mesh name (SkeletonUtils.clone preserves names).
  const originalTintByMesh = new Map<string, THREE.Color>()
  rig.root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const color = (mat as Partial<THREE.MeshStandardMaterial> | undefined)?.color
    originalTintByMesh.set(mesh.name, color ? color.clone() : new THREE.Color(1, 1, 1))
  })
  applyVinylMaterialToScene(rig.root, {
    brush: RIDER_BRUSH,
    brushObjectSpace: true,
    tintUserData: UD_TINT,
  })

  // Deterministic per-slot suit tint. Slot resolution mirrors render-systems.ts
  // `aiColors`: a peer uses its network peerId, an AI uses a stable spawn-order
  // cursor (1-based, so AI map onto the same 1..N grid slots the bikes do), and
  // the local human (PlayerTag / peerId 0) / any ghost gets no jersey — `null`
  // here means "stamp each mesh's original material colour" (the shipped look).
  let aiTintCursor = 0
  const tintByRider = new Map<number, THREE.Color | null>()
  const WHITE = new THREE.Color(1, 1, 1)
  function suitTintForRider(riderEid: number, bikeEid: number): THREE.Color | null {
    const cached = tintByRider.get(riderEid)
    if (cached !== undefined) return cached
    let slot: number
    if (hasComponent(sim, bikeEid, PlayerTag) || hasComponent(sim, bikeEid, GhostTag)) {
      slot = 0
    } else if (hasComponent(sim, bikeEid, PeerControlled)) {
      slot = PeerControlledStore.get(bikeEid)?.peerId ?? 0
    } else {
      // AI: next spawn-order slot, 1-based (slot 0 is the player's pole).
      slot = ++aiTintCursor
    }
    const palette = riderPaletteForSlot(slot)
    // Hex → linear so the multiply lands in the same space as the (linear)
    // mannequin albedo. new THREE.Color(hex) treats the hex as sRGB and
    // converts to linear working space, matching the bike livery tint path.
    const c = palette ? new THREE.Color(palette.suit) : null
    tintByRider.set(riderEid, c)
    return c
  }
  /** Stamp a rider clone's meshes with its suit tint so the shared per-object
   *  tint material reads the right colour for every mesh in this rider. A
   *  `null` tint (player / ghost) stamps each mesh's captured original material
   *  colour instead — the pre-palette shipped look, exactly. */
  function stampRiderTint(group: THREE.Object3D, tint: THREE.Color | null): void {
    group.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return
      stampVinylTint(o, tint ?? originalTintByMesh.get(o.name) ?? WHITE)
    })
  }

  let last = 0

  // Dev/test read-back hook (mirrors `__bikeField`) so a harness can assert
  // head-pose boundedness without depending on camera framing. Head/neck are
  // LOCAL quaternions: the clip pose ⊗ the bounded reactive offset, so their
  // deviation from the seated pose must stay small while attached.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const debug = () => {
      const riders = []
      for (const [eid, inst] of instances) {
        const head = inst.bones.get('Head')
        const neck = inst.bones.get('neck_01')
        riders.push({
          eid,
          bikeEid: inst.bikeEid,
          ragdoll: inst.ragdoll,
          clip: inst.action ? inst.action.getClip().name : null,
          running: inst.action?.isRunning() ?? false,
          headLocal: head ? head.quaternion.toArray() : [0, 0, 0, 1],
          neckLocal: neck ? neck.quaternion.toArray() : [0, 0, 0, 1],
          headYaw: RiderStore.get(eid)?.poseResponse.headYaw ?? 0,
        })
      }
      return riders
    }
    ;(window as unknown as { __riderMannequin?: { debug: typeof debug } }).__riderMannequin = {
      debug,
    }
  }

  /** The bike's authored seat anchor (`socket_seat`) in bike-local space, or
   *  null when the bike has no socket / no registry (procedural bikes, tests).
   *  Per-variant constant — resolved once per rider instance. */
  function resolveSocketSeat(bikeEid: number): { x: number; y: number; z: number } | null {
    if (!bikeRegistry) return null
    const variantId = BikeStatsStore.get(bikeEid)?.variantId
    const loaded =
      (variantId !== undefined && bikeRegistry.byVariantId[variantId]) || bikeRegistry.default
    return loaded.seatLocal ?? null
  }

  /** The seated clip name this bike poses with — the per-variant `riderClip`
   *  (undefined → the shared default). Resolved per rider instance. */
  function resolveRiderClip(bikeEid: number): string | undefined {
    const variantId = BikeStatsStore.get(bikeEid)?.variantId
    return resolveBikeVariant(variantId).riderClip
  }

  /** Resolve a seated clip by name with graceful fallback: the bike's authored
   *  clip when it exists in the rig, else the shared `Sitting_Idle_Loop`, else
   *  the first clip. A per-bike name that hasn't been authored yet falls back
   *  to the seated idle rather than T-posing (clip 0 is `A_TPose`). */
  function resolveSeatedClip(name: string | undefined): THREE.AnimationClip | undefined {
    const want = name ?? RIDE_CLIP
    return (
      rig.animations.find((a) => a.name === want) ??
      rig.animations.find((a) => a.name === RIDE_CLIP) ??
      rig.animations[0]
    )
  }

  function build(
    riderEid: number,
    bikeEid: number,
    seatLocal: MannequinInstance['seatLocal'],
  ): MannequinInstance {
    const group = cloneSkeleton(rig.root)
    group.name = `rider-mannequin:${riderEid}`
    group.scale.setScalar(FIT_SCALE)
    const bones = new Map<string, THREE.Object3D>()
    group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.frustumCulled = false
      }
      if (o.name) bones.set(o.name, o)
    })
    // Material is already painterly-vinyl (converted once on the shared rig above),
    // so the clone references it by reference — no per-rider conversion or compile.
    // Stamp this rider's per-slot suit tint onto its meshes so the shared
    // per-object tint material paints the right jersey colour (an unstamped mesh
    // would read 0 → black); the local human / host / ghost stamps the captured
    // original material colours — the shipped look, not a jersey.
    stampRiderTint(group, suitTintForRider(riderEid, bikeEid))
    scene.add(group)
    const mixer = new THREE.AnimationMixer(group)
    const clip = resolveSeatedClip(resolveRiderClip(bikeEid))
    const action = clip ? mixer.clipAction(clip) : null
    action?.play()
    const restPose = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>()
    const written = new Set<string>([
      ...Object.values(BONE_MAP),
      ...HEAD_LOOK_BONES.map((h) => h.bone),
    ])
    for (const name of written) {
      const bone = bones.get(name)
      if (bone) restPose.set(name, { p: bone.position.clone(), q: bone.quaternion.clone() })
    }
    const inst: MannequinInstance = {
      group,
      mixer,
      action,
      bones,
      bikeEid,
      seatLocal,
      socketSeat: resolveSocketSeat(bikeEid),
      ragdoll: false,
      clipPose: new Map(),
      restPose,
    }
    instances.set(riderEid, inst)
    return inst
  }

  /** Place a bone at a sim bone's full world transform (ragdoll drive). */
  function setBoneWorld(
    bone: THREE.Object3D,
    t: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number },
  ): void {
    const parent = bone.parent
    if (!parent) return
    parent.updateWorldMatrix(true, false)
    p.set(t.x, t.y, t.z)
    q.set(t.qx, t.qy, t.qz, t.qw)
    worldM.compose(p, q, one)
    parentInv.copy(parent.matrixWorld).invert()
    localM.multiplyMatrices(parentInv, worldM)
    localM.decompose(bone.position, bone.quaternion, scratchScale)
    bone.scale.set(1, 1, 1)
    bone.updateWorldMatrix(false, false)
  }

  return function tick(): void {
    const now = performance.now()
    const dt = last === 0 ? 0 : Math.min((now - last) / 1000, 1 / 15)
    last = now

    const riderEids = query(sim, [Rider])
    const live = new Set<number>()
    for (const riderEid of riderEids) {
      const r = RiderStore.get(riderEid)
      if (!r) continue
      live.add(riderEid)
      const inst = instances.get(riderEid) ?? build(riderEid, r.bikeEid, r.seatLocal)

      if (r.state === 'launched') {
        // ── Ragdoll: stop the clip, follow the 12 dynamic bodies. ──
        if (!inst.ragdoll) {
          inst.action?.stop()
          inst.ragdoll = true
        }
        for (const logical of DRIVE_ORDER) {
          const t = TransformStore.get(r.bones[logical])
          if (!t) continue
          const ueBone = inst.bones.get(BONE_MAP[logical])
          if (ueBone) setBoneWorld(ueBone, t)
        }
        continue
      }

      // ── Attached: re-arm the clip after a respawn, then seat + react. ──
      if (inst.ragdoll) {
        inst.ragdoll = false
        // Hand-restore every bone the ragdoll drove: a static pose clip's
        // mixer skips redundant writes, so it would never repair them.
        for (const [name, rest] of inst.restPose) {
          const bone = inst.bones.get(name)
          if (!bone) continue
          bone.position.copy(rest.p)
          bone.quaternion.copy(rest.q)
          bone.scale.set(1, 1, 1)
        }
        inst.action?.reset().play()
      }

      const bt = TransformStore.get(inst.bikeEid)
      if (bt) {
        bikePos.set(bt.x, bt.y, bt.z)
        bikeQuat.set(bt.qx, bt.qy, bt.qz, bt.qw)
        // Seat anchor: the bike's authored socket_seat when present (per-bike,
        // raw bike-local), else the legacy global seatLocal + SEAT_OFFSET.
        const anchor = inst.socketSeat
        if (anchor) {
          seat.set(anchor.x, anchor.y, anchor.z)
        } else {
          seat.set(
            inst.seatLocal.x + SEAT_OFFSET.x,
            inst.seatLocal.y + SEAT_OFFSET.y,
            inst.seatLocal.z + SEAT_OFFSET.z,
          )
        }
        seat.applyQuaternion(bikeQuat).add(bikePos)
        inst.group.position.copy(seat)
        // Body orientation = bike ⊗ facing ⊗ additive reactive tilt. The
        // additive (in the rider's bike-aligned local frame) layers our
        // RiderPoseResponse on top of the seated anim: pitch=bounce, yaw=turn-in,
        // roll=drift-bank.
        const pr = r.poseResponse
        additiveEuler.set(
          pr.bouncePitch * PITCH_GAIN,
          pr.flowYaw * YAW_GAIN,
          pr.leanRoll * ROLL_GAIN,
          'XYZ',
        )
        additiveQuat.setFromEuler(additiveEuler)
        inst.group.quaternion.copy(bikeQuat).multiply(facingQuat).multiply(additiveQuat)
      }

      // Undo last frame's head-look so the mixer sees — and, when it skips the
      // redundant write of a static pose clip, the graph keeps — the pure clip
      // pose. Without this the additive multiply below accumulates.
      for (const [name, q] of inst.clipPose) inst.bones.get(name)?.quaternion.copy(q)

      inst.mixer.update(dt)

      // Head leads the steer + nods with throttle, split across neck + head,
      // layered on the clip's pose (re-cached pure each frame).
      for (const { bone: name, share } of HEAD_LOOK_BONES) {
        const bone = inst.bones.get(name)
        if (!bone) continue
        let cached = inst.clipPose.get(name)
        if (!cached) {
          cached = new THREE.Quaternion()
          inst.clipPose.set(name, cached)
        }
        cached.copy(bone.quaternion)
        headEuler.set(
          r.poseResponse.headPitch * HEAD_PITCH_GAIN * share,
          r.poseResponse.headYaw * HEAD_YAW_GAIN * share,
          0,
          'XYZ',
        )
        headQuat.setFromEuler(headEuler)
        bone.quaternion.multiply(headQuat)
      }
    }

    for (const [eid, inst] of instances) {
      if (!live.has(eid)) {
        scene.remove(inst.group)
        instances.delete(eid)
        // Drop the cached tint too so a recycled eid re-resolves its slot
        // (and the map doesn't grow across a long session).
        tintByRider.delete(eid)
      }
    }
  }
}
