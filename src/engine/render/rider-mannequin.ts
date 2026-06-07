import { query } from 'bitecs'
import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { LoadedProp } from '@/game/assets/prop-loader'
import { resolveBikeVariant } from '@/game/bikes/variants'
import { BikeStatsStore, TransformStore } from '@/game/components'
import { Rider, type RiderBoneName, RiderStore } from '@/game/components/rider'
import type { BikeRenderRegistry } from './render-systems'

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
 *  - **attached → clip + additive physics.** Plays `Sitting_Idle_Loop` on a
 *    per-rider `AnimationMixer` (correct mannequin proportions; the seated base
 *    pose is refined in-anim). On top: the group is seated on the bike and
 *    inherits the bike's full orientation (banks/pitches/bounces with the bike),
 *    PLUS the rider's smoothed `RiderPoseResponse` (bounce / drift-lean / turn-in
 *    twist) is layered ADDITIVELY as an extra body tilt — "physics on the anim."
 *
 *  - **launched → full ragdoll.** On a crash / shark-grab the sim rider goes
 *    dynamic; here we stop the clip and drive the UE bones straight from the 12
 *    dynamic bodies' world poses. The proportion stretch that made this drive
 *    wrong for a clean seated pose is exactly right for a flailing ragdoll. 🦴
 */

// Seated idle loop (falls back to the first clip if absent).
const RIDE_CLIP = 'Sitting_Idle_Loop'
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
const HEAD_YAW_GAIN = 0.6 // headYaw   → head leads the steer (Head bone, local Y)

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

  let last = 0

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
    scene.add(group)
    const mixer = new THREE.AnimationMixer(group)
    const clip = resolveSeatedClip(resolveRiderClip(bikeEid))
    const action = clip ? mixer.clipAction(clip) : null
    action?.play()
    const inst: MannequinInstance = {
      group,
      mixer,
      action,
      bones,
      bikeEid,
      seatLocal,
      socketSeat: resolveSocketSeat(bikeEid),
      ragdoll: false,
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

      inst.mixer.update(dt)

      // Head leads the steer — layered on top of the clip's neck pose.
      const head = inst.bones.get('Head')
      if (head) {
        headEuler.set(0, r.poseResponse.headYaw * HEAD_YAW_GAIN, 0, 'XYZ')
        headQuat.setFromEuler(headEuler)
        head.quaternion.multiply(headQuat)
      }
    }

    for (const [eid, inst] of instances) {
      if (!live.has(eid)) {
        scene.remove(inst.group)
        instances.delete(eid)
      }
    }
  }
}
