# Rider → Quaternius Universal Character — investigation

> **Question (Matt, 2026-06-05):** can we replace the rider with the character
> from the Quaternius **Universal Animation Library**, and later re-mesh our own
> characters onto that rig?
>
> **Short answer: yes, and it's a good call.** The library is built on the
> **Unreal-Engine mannequin skeleton** — the de-facto *universal* humanoid rig —
> so any custom character retargeted/skinned to it inherits the same 45 clips and
> the same engine plumbing. The work is real but well-bounded, and the runtime
> tech is already proven (the rigged shark proved `SkinnedMesh` + `AnimationMixer`
> render on our WebGPU node-material renderer).

---

## 1. What's in the library

`external/quaternius/.../animation-library/Universal Animation Library[Standard]/`
ships one usable file: **`Unreal-Godot/UAL1_Standard.glb`** (8.1 MB, CC0; the
`Unity/UAL1_Standard.fbx` is the same asset). Inspected:

- **1 skinned mesh** `Mannequin` — 2 primitives (`M_Main`, `M_Joints`), with
  `JOINTS_0`/`WEIGHTS_0` and **two UV sets** (ready for textures; ships untextured
  greybox today). This is the dev/placeholder body — **our custom mesh replaces it.**
- **1 skin / 65 bones** — the **UE mannequin skeleton**:
  `root, pelvis, spine_01, spine_02, spine_03, neck_01, Head, clavicle_l,
  upperarm_l, lowerarm_l, hand_l (+ 5 fingers ×4 joints), thigh_l, calf_l, foot_l,
  ball_l` and the `_r` mirror. The `_leaf` bones are tip markers.
- **45 animation clips** (each 195 channels = all 65 bones). The ones that matter
  for a hover-bike rider:
  - **`Driving_Loop`** (1.67 s), **`Sitting_Idle_Loop`** / `Sitting_Enter` /
    `Sitting_Exit` — a seated base pose, *exactly* the rider posture.
  - **`Jump_Start` / `Jump_Loop` / `Jump_Land`**, **`Roll`** — air / trick / recovery.
  - **`Death01`, `Hit_Chest`, `Hit_Head`** — crash / shark-grab reactions.
  - plus Idle/Walk/Jog/Sprint/Swim/combat/etc. (unused, but free).

**Why "Standard" matters:** the UE-mannequin bone names mean Mixamo, UE, and most
"universal humanoid" tooling retarget to it directly. That's the lever behind the
re-mesh plan (§5).

## 2. How the rider works today

The current rider is **not a skinned mesh** — it's a procedural physics-rig
(`src/engine/render/rider-mesh.ts`, `src/game/entities/rider.ts`,
`src/game/components/rider.ts`):

- **12 logical bones** as Rapier rigid bodies + capsule visual meshes:
  `pelvis, abdomen, chest, head, upper/lower_arm_L/R, upper/lower_leg_L/R`.
- **Posed in the SIM, deterministically**, each fixed step by
  `riderPoseSystem` (`src/game/systems/rider-pose.ts`):
  - Reactive offsets smoothed from bike state: **bouncePitch** (vertical accel),
    **flowYaw** (yaw rate — torso twists into turns), **headYaw** (steer — head
    leads), **headPitch** (throttle/brake lean), **leanRoll** (drift bank).
  - A rest pose (seated motocross angles in `RIDER_POSE_TUNING.restAngles`) +
    **2-bone IK**: arms → handlebars, legs → foot-pegs.
  - Bones are `KinematicPositionBased` while seated (pose writes world transforms).
- **Ragdoll** (`src/game/systems/rider-crash.ts`): on a crash Δv (or the shark's
  `ejectRider`), the 12 bodies switch to **Dynamic** + 9 spherical joints and get
  launched — a real physics ragdoll.
- **Per bike**: a fresh `createRider` (12 entities) ×8; all in the sim
  (deterministic); player/AI distinguished by a colour palette. **No clips, no
  `AnimationMixer`, no GLB anywhere.**

So today's rider gives us two things a clip alone can't: a **reactive,
deterministic pose** (the feel) and a **physics ragdoll** (the crash). A drop-in
clip-driven character would *lose* both unless we keep them.

## 3. The gap

| | Today | Quaternius character |
|---|---|---|
| Body | 12 capsule primitives | skinned humanoid mesh |
| Rig | 12 logical bones (no fingers/toes) | 65-bone UE mannequin |
| Motion | procedural reactive pose (sim) | 45 baked clips |
| Crash | physics ragdoll (12 dynamic bodies) | `Death01` clip (or keep ragdoll) |

The bone mapping is clean (12 → UE):
`pelvis→pelvis · abdomen→spine_01(+spine_02) · chest→spine_03 · head→Head (via
neck_01) · upper/lower_arm_L→upperarm_l/lowerarm_l (hand_l = grip) · …_R mirror ·
upper/lower_leg_L→thigh_l/calf_l (foot_l = peg) · …_R mirror`. The extra bones
(fingers, toes, clavicles, mid-spine) ride their parent or take a static rest.

## 4. Recommended approach — phased

Keep what's good (reactive feel + ragdoll, both already in the sim); add the
skinned character as a **render layer**. Determinism is untouched because the sim
keeps driving the 12-bone rig; the skinned mesh just *follows* it.

**Phase 1 — mesh swap, posing unchanged (the milestone that answers the question).**
- New `rider-loader` (load + cache `cc0/rider_mannequin.glb`); per bike,
  `SkeletonUtils.clone` (proven pattern from `animated-props.ts`).
- New render system: each frame, read the 12 bone world poses the sim already
  computes and **drive the mapped UE bones** (set world rotation/position;
  intermediate bones slerp or rest). Hide the capsule meshes (keep them behind a
  debug flag).
- During ragdoll the same 12 dynamic bodies drive the skeleton → ragdoll "for
  free" on the new mesh.
- Result: the new character rides + crashes with the **current feel**, and
  swapping its mesh is a one-file change (§5). **This is the deliverable that
  proves the concept.**

**Phase 2 — clip polish (optional, leans on the 45 clips).**
- Base the seated body on **`Driving_Loop`/`Sitting_Idle_Loop`** via an
  `AnimationMixer`, then apply the reactive offsets as **additive** bone writes
  after `mixer.update` (lean/head/bounce on top of the clip), IK still locking
  hands/feet to bars/pegs. Higher-fidelity idle than the pure-procedural rest.
  **Trap (hit in practice):** an additive bone write must restore the cached
  pure clip pose *before* the next `mixer.update` — three's `PropertyMixer`
  skips `setValue` when the sampled value didn't change, so on a **static pose
  clip** (the per-bike `Ride_*` idles) the mixer never re-writes the bone and a
  naive multiply accumulates frame over frame (the "heads spin freely" bug; see
  the layering note in `rider-mannequin.ts`).
- Swap the physics ragdoll for **`Death01`/`Hit_*`/`Roll`** where a canned
  reaction reads better, or blend (ragdoll for big hits, clip for near-misses).

Reuses the runtime lane already built (`animated-props.ts`): `SkeletonUtils.clone`,
per-instance mixer, WebGPU skinning confirmed, the `maxInstances`/LOD budget
thinking for the 8-rider case.

## 5. The re-mesh assumption — validated

> *"I'm assuming I can re-mesh on top of that rig with our custom characters later."*

**Correct.** Because the rig is the **UE mannequin skeleton**, "re-mesh" =
skin a custom character to *that exact skeleton* (in Blender: parent the new mesh
to the UAL armature with weights, or retarget a Mixamo/other rig onto it). Then:
- it plays all **45 clips** unchanged,
- the Phase-1 bone-map drives it unchanged,
- only the **GLB asset id** changes in the rider loader.

So the workflow is: **adopt the UAL skeleton as our canonical rider rig now**
(mannequin as placeholder), build custom characters against it later. A
`ship_animated_prop`-style lane can wrap each character GLB (wrap root, stamp
COLOR_0, keep skin+clips) the same way the fish were shipped.

## 6. Risks & effort

- **Fit/scale to the bike** — the mannequin's proportions must seat correctly
  (hands on bars, feet on pegs). The existing IK targets (bar/peg world points)
  carry over; expect a per-bike fit/scale pass. *Medium.*
- **8 skinned humanoids @ 60 fps** — 8× a low-poly 65-bone mannequin is cheap on
  the 3070/desktop; **verify on Deck / iPhone** (the standing perf TODO). Distance-
  LOD (freeze far mixers / drop to capsule) is the lever. *Low–medium.*
- **Intermediate bones** (spine_02, neck_01, clavicles) — slerp between mapped
  parents/children so the torso/neck don't kink. *Low.*
- **Ragdoll mapping** — 12 dynamic bodies → 65 bones (unmapped bones follow
  parent). Looks fine for a ragdoll; the hands/feet won't flail independently. *Low.*
- **Determinism** — keep the pose in the sim; the skinned mesh is render-only, so
  lockstep/replay are unaffected. *No risk if Phase 1 is followed.*
- **Greybox today** — the mannequin is untextured; it's the dev rig. Shipping
  needs the custom character mesh (the point of §5).

## 7. Suggested next step

A **Phase-1 spike**: ship `UAL1_Standard.glb` as `cc0/rider_mannequin` (the
animated-prop ship lane already does the skin-preserving wrap), add a rider-render
system that drives the UE bones from the 12 sim poses behind a `?rider=mannequin`
flag, and eyeball it on a track + a crash. That turns this from "should work" into
"here it is riding," without touching the sim or the existing capsule rider.
