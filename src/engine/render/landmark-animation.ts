/**
 * Runtime animation for ``landmark_mechanical_rig`` instances.
 *
 * The archetype (built by ``tools/blender/seed_landmarks_library.py``)
 * ships a parented swing-arm child object whose local origin is the
 * pivot. The arm node carries three custom-property extras that flow
 * Blender → glTF → ``Object3D.userData``:
 *
 *   * ``swing_period_s``    — full back-and-forth period in seconds
 *   * ``swing_amplitude_deg`` — peak rotation away from rest, degrees
 *   * ``swing_axis``        — "X" | "Y" | "Z" in arm-local space
 *
 * Per-instance tracks can override these on the instance empty (the
 * collection-instance parent of the arm subtree):
 *
 *   * Marina Bay 7's gauntlet stamps ``swing_period_s_override`` per
 *     crane (3.0 / 3.6 / 4.2 / 3.3 / 3.8 s) so the five-against-one
 *     rhythm reads as polyphonic rather than lock-step.
 *   * Doge's Drift's Campanile bell rewrites the full triplet on the
 *     instance empty (2.5 s / 18° / Y-axis) so the bell tolls along
 *     the rider's approach direction instead of swinging laterally
 *     like a gantry crane.
 *
 * Per-instance phase is derived from the arm's world position so two
 * cranes with the same period don't move in lock-step — defensive
 * against future tracks that drop a wave of identical instances. Phase
 * derivation is purely a function of the world XYZ, so two distinct
 * spawn positions yield distinct phases reproducibly.
 *
 * Render-only for the visual mesh; the kinematic-position rigid body
 * carrying the arm's trimesh collider is updated through the same
 * ``setNextKinematicTranslation`` / ``setNextKinematicRotation`` path
 * the multiplayer remote-bike system uses (see
 * ``src/game/systems/apply-snapshot.ts``). Replay recording / MP state
 * sync don't see the rotation as a sim variable — the arm's pose is a
 * pure function of ``elapsedSeconds since boot``, so two peers tick to
 * the same wave even without snapshots.
 *
 * Collider integration: ``glb-track.attachTrackColliders`` skips any
 * mesh whose ancestor chain carries ``landmark_id = "mechanical_rig_arm"``
 * (see ``isUnderMechanicalRigArm``). This module then walks the arm
 * subtree and attaches an arm-local-space trimesh collider per primitive
 * mesh onto a single kinematic body. The body's pose tracks the visual
 * arm each tick, so the bike physically interacts with the swinging
 * gauntlet.
 */

import type RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'

const TWO_PI = Math.PI * 2
const DEG_TO_RAD = Math.PI / 180

/** Names the runtime understands as ``swing_axis``. Stored uppercased
 *  in the GLB; the reader normalises any lowercase author input. */
export type SwingAxis = 'X' | 'Y' | 'Z'

const VALID_SWING_AXES: ReadonlySet<string> = new Set(['X', 'Y', 'Z'])

/**
 * Final resolved per-arm swing configuration after merging the
 * instance-level override layer onto the archetype defaults carried by
 * the arm subtree. Exposed for tests of the merge precedence rules.
 */
export type SwingConfig = {
  periodS: number
  amplitudeDeg: number
  axis: SwingAxis
}

const DEFAULT_SWING: Readonly<SwingConfig> = Object.freeze({
  periodS: 12.0,
  amplitudeDeg: 40.0,
  axis: 'Z',
})

/** Internal — one entry per discovered arm. */
type AnimatedArm = {
  arm: THREE.Object3D
  config: SwingConfig
  /** ``[0, 1)`` — added to ``t / period`` inside the sin so identical
   *  periods don't move in lock-step. Derived from the arm's world
   *  XYZ at registration time, then frozen. */
  phase: number
  /** Rest pose, captured once at registration. The tick writes
   *  ``rest + delta`` so toggling animation off can reset the arm
   *  back to ``rest`` cleanly. */
  restAngle: number
  /** Kinematic-position rigid body whose trimesh collider follows the
   *  arm's world pose each tick. ``null`` when the system was built
   *  without a ``phys`` handle (tests / edit mode) — the visual swing
   *  still runs in that case, the bike just doesn't collide. */
  body: RAPIER.RigidBody | null
}

/**
 * Inspect a node's ``userData`` for swing-related extras and return a
 * partial config containing only the fields that were actually
 * present. Used by both the arm pass (archetype defaults) and the
 * instance pass (per-track overrides).
 *
 * Recognises three precedence layers, in increasing priority:
 *
 *   1. ``swing_period_s`` / ``swing_amplitude_deg`` / ``swing_axis``
 *      (archetype defaults on the arm child)
 *   2. ``swing_period_s`` / ``swing_amplitude_deg`` / ``swing_axis``
 *      (instance-level overrides — Doge's Drift bell stamps these on
 *      the collection-instance empty)
 *   3. ``swing_period_s_override`` (period-only fast path — Marina
 *      Bay 7 cranes only re-tune timing, not amplitude or axis)
 *
 * The function does NOT decide precedence — it only reads what's
 * present. ``mergeSwingConfig`` composes archetype + override layers.
 */
export function readSwingExtras(userData: unknown): Partial<SwingConfig> {
  if (!userData || typeof userData !== 'object') return {}
  const u = userData as Record<string, unknown>
  const out: Partial<SwingConfig> = {}

  // Period: ``_override`` wins over the plain field on the same node,
  // since the override extra is specifically the per-instance knob
  // authors reach for when they want timing variation only.
  const periodOverride = u.swing_period_s_override
  const period = u.swing_period_s
  if (typeof periodOverride === 'number' && Number.isFinite(periodOverride) && periodOverride > 0) {
    out.periodS = periodOverride
  } else if (typeof period === 'number' && Number.isFinite(period) && period > 0) {
    out.periodS = period
  }

  const amplitude = u.swing_amplitude_deg
  if (typeof amplitude === 'number' && Number.isFinite(amplitude)) {
    out.amplitudeDeg = amplitude
  }

  const axis = u.swing_axis
  if (typeof axis === 'string') {
    const upper = axis.toUpperCase()
    if (VALID_SWING_AXES.has(upper)) out.axis = upper as SwingAxis
  }

  return out
}

/**
 * Merge archetype + instance partial configs into a final
 * ``SwingConfig``. Instance fields take priority field-by-field, so
 * Marina Bay 7's period-only override doesn't accidentally reset
 * amplitude or axis to defaults. Falls back to ``DEFAULT_SWING`` for
 * any field neither layer specified.
 */
export function mergeSwingConfig(
  archetype: Partial<SwingConfig>,
  instance: Partial<SwingConfig>,
): SwingConfig {
  return {
    periodS: instance.periodS ?? archetype.periodS ?? DEFAULT_SWING.periodS,
    amplitudeDeg: instance.amplitudeDeg ?? archetype.amplitudeDeg ?? DEFAULT_SWING.amplitudeDeg,
    axis: instance.axis ?? archetype.axis ?? DEFAULT_SWING.axis,
  }
}

/**
 * Derive a stable phase offset ``[0, 1)`` from a world-space position.
 *
 * Skips Y because most gantry-rig instances share an altitude band
 * and we'd lose entropy. Uses irrational-ish coefficients on X and Z
 * so two cranes at integer positions like ``(242, -50)`` vs
 * ``(242, -25)`` still produce distinct phase fractions instead of
 * both rounding to zero. That's the empirical Marina Bay 7 layout —
 * the per-crane periods carry most of the rhythm signal but a
 * defensive phase split protects future tracks that drop identical-
 * period instances in a row.
 *
 * Exposed for tests so a regression that changes the phase formula
 * doesn't silently shift the visible pattern.
 */
export function phaseFromWorldPos(x: number, z: number): number {
  // JavaScript's ``%`` keeps the sign of the dividend; the
  // ``+ 1) % 1`` step folds negatives back into ``[0, 1)``.
  const blend = x * 0.137 + z * 0.231
  return ((blend % 1) + 1) % 1
}

/**
 * Climb the parent chain from an arm node looking for the first
 * ancestor that carries any swing-related extra. That ancestor is the
 * instance empty whose overrides (Marina Bay's per-crane period,
 * Doge's bell's full triplet) should take priority over the archetype
 * defaults on the arm.
 *
 * Stops at the first hit so we don't accidentally pick up extras on a
 * deep root. Returns an empty object when no ancestor has anything —
 * the merge falls back to archetype defaults in that case.
 *
 * Exposed for tests of the multi-level walk.
 */
export function findInstanceSwingExtras(arm: THREE.Object3D): Partial<SwingConfig> {
  let node: THREE.Object3D | null = arm.parent
  while (node) {
    const extras = readSwingExtras(node.userData)
    if (
      extras.periodS !== undefined ||
      extras.amplitudeDeg !== undefined ||
      extras.axis !== undefined
    ) {
      return extras
    }
    node = node.parent
  }
  return {}
}

/**
 * The pendulum angle in radians for a given sample. Pure math —
 * exposed for tests of the sin curve.
 */
export function computeArmAngleRad(
  elapsedSeconds: number,
  config: SwingConfig,
  phase: number,
): number {
  const t = elapsedSeconds / config.periodS + phase
  return config.amplitudeDeg * DEG_TO_RAD * Math.sin(TWO_PI * t)
}

/**
 * Write ``angleRad`` into the arm's local Euler rotation along the
 * config's axis, preserving the rest pose on the other two axes. The
 * arm's rest rotation is restored verbatim when ``enabled=false`` so
 * toggling the setting off pins each crane to its authored pose.
 */
function applyArmAngle(
  arm: THREE.Object3D,
  axis: SwingAxis,
  restAngle: number,
  deltaRad: number,
): void {
  const angle = restAngle + deltaRad
  if (axis === 'X') arm.rotation.x = angle
  else if (axis === 'Y') arm.rotation.y = angle
  else arm.rotation.z = angle
}

/**
 * Build a kinematic-position rigid body for an arm subtree and attach
 * a trimesh collider per primitive mesh in arm-local space.
 *
 * The arm node itself is an Object3D (Three's GLTFLoader emits an empty
 * group for the glTF node, with one Mesh child per primitive). We bake
 * each primitive's local-relative-to-arm transform into its vertex
 * positions so the colliders sit at the arm's local origin in
 * collider-space; Rapier then re-applies the body's world pose every
 * step. The result is a single kinematic body whose pose is the arm's
 * world pose, with as many trimesh colliders as the arm has primitives
 * (typically two — one per material slot on the swing-arm mesh).
 *
 * Returns ``null`` if the arm has no primitive descendants (defensive —
 * the seed library always generates geometry, but a future authoring
 * variant could ship an empty arm).
 */
function buildArmKinematicBody(arm: THREE.Object3D, phys: PhysicsWorld): RAPIER.RigidBody | null {
  arm.updateMatrixWorld(true)
  const armInverse = arm.matrixWorld.clone().invert()

  // Capture the arm's current world pose as the body's starting pose.
  // Decompose returns position / quaternion / scale; we ignore scale
  // because Rapier kinematic bodies don't support non-uniform scaling
  // and the seed library never scales mechanical_rig instances. If a
  // future track scales the rig, the visual mesh will scale via Three
  // but the collider will run at unit scale — flag in a follow-up.
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  arm.matrixWorld.decompose(pos, quat, scale)

  // Build the body first so we have something to attach colliders to.
  const rbDesc = phys.rapier.RigidBodyDesc.kinematicPositionBased()
    .setTranslation(pos.x, pos.y, pos.z)
    .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
  const rb = phys.world.createRigidBody(rbDesc)

  let primitiveCount = 0
  arm.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    obj.updateMatrixWorld(true)
    // Transform from primitive-local to arm-local space. We need this
    // because each primitive Mesh sits at its own local pose under the
    // arm node (Three's glTF importer sometimes adds an identity
    // matrix, sometimes a non-trivial one — bake whatever's there).
    const meshToArm = new THREE.Matrix4().multiplyMatrices(armInverse, obj.matrixWorld)
    const verts = bakeVertsToFrame(obj.geometry as THREE.BufferGeometry, meshToArm)
    if (!verts) return
    const indices = buildDoubleSidedIndices(obj.geometry as THREE.BufferGeometry, verts.count)

    const colDesc = phys.rapier.ColliderDesc.trimesh(verts.array, indices)
      .setFriction(0.08)
      .setRestitution(0.05)
    phys.world.createCollider(colDesc, rb)
    primitiveCount += 1
  })

  if (primitiveCount === 0) {
    // Defensive cleanup — release the body so we don't leak a dangling
    // RigidBody handle when an arm somehow has no mesh primitives.
    phys.world.removeRigidBody(rb)
    return null
  }
  return rb
}

/** Bake `geometry.attributes.position` through `frame` (Matrix4) and
 *  return the resulting flat Float32Array. Returns null when the
 *  geometry has no position attribute — Three would have warned at
 *  load, but check defensively. */
function bakeVertsToFrame(
  geometry: THREE.BufferGeometry,
  frame: THREE.Matrix4,
): { array: Float32Array; count: number } | null {
  const posAttr = geometry.attributes.position
  if (!posAttr) return null
  const v = new THREE.Vector3()
  const verts = new Float32Array(posAttr.count * 3)
  for (let i = 0; i < posAttr.count; i++) {
    v.fromBufferAttribute(posAttr, i).applyMatrix4(frame)
    verts[i * 3] = v.x
    verts[i * 3 + 1] = v.y
    verts[i * 3 + 2] = v.z
  }
  return { array: verts, count: posAttr.count }
}

/** Double-side the index list so a Rapier trimesh raycast hits from
 *  either face winding. Mirrors ``attachTrackColliders`` — see that
 *  comment for the friction / one-sided-trimesh rationale. */
function buildDoubleSidedIndices(geometry: THREE.BufferGeometry, vertCount: number): Uint32Array {
  let baseIndices: ArrayLike<number>
  let baseLen: number
  const index = geometry.index
  if (index) {
    baseIndices = index.array
    baseLen = index.array.length
  } else {
    const synth = new Uint32Array(vertCount)
    for (let i = 0; i < vertCount; i++) synth[i] = i
    baseIndices = synth
    baseLen = synth.length
  }
  const indices = new Uint32Array(baseLen * 2)
  for (let i = 0; i < baseLen; i += 3) {
    const a = baseIndices[i] as number
    const b = baseIndices[i + 1] as number
    const c = baseIndices[i + 2] as number
    indices[i] = a
    indices[i + 1] = b
    indices[i + 2] = c
    indices[baseLen + i] = a
    indices[baseLen + i + 1] = c
    indices[baseLen + i + 2] = b
  }
  return indices
}

/** Push the arm's current world matrix to the kinematic body via
 *  ``setNextKinematic*``. Called every tick — Rapier consumes the
 *  next-pose target on the upcoming step, so over-calling is cheap
 *  (the most recent target wins). */
function syncBodyToArm(arm: THREE.Object3D, body: RAPIER.RigidBody): void {
  arm.updateMatrixWorld(true)
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  arm.matrixWorld.decompose(pos, quat, scale)
  body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z })
  body.setNextKinematicRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
}

export type LandmarkAnimationOptions = {
  /** Physics world handle. When provided, ``registerFromScene`` builds
   *  a kinematic-position rigid body per arm so the bike collides with
   *  the swinging gauntlet at race-time. Omit it in tests / edit mode
   *  where physics isn't initialised — the visual swing still runs,
   *  the bike just doesn't physically interact with the arms. */
  phys?: PhysicsWorld
}

export type LandmarkAnimationSystem = {
  /** Walk a loaded scene graph, register every ``landmark_mechanical_rig``
   *  arm node, and return the count. Safe to call multiple times — each
   *  call clears the prior registry first so re-running on a fresh
   *  track doesn't double up. */
  registerFromScene(root: THREE.Object3D): number
  /** Per-frame tick. ``enabled=false`` pins every arm to its rest pose
   *  without un-registering, so flipping the setting back on resumes
   *  from the current ``elapsedSeconds`` (no jump). Also pushes the
   *  arm's current world pose to its kinematic body via
   *  ``setNextKinematic*`` so the collider tracks the visual swing. */
  tick(elapsedSeconds: number, enabled: boolean): void
  /** Test / debug hook — exposes the registry shape. */
  arms(): ReadonlyArray<{
    name: string
    config: SwingConfig
    phase: number
    restAngle: number
    hasBody: boolean
  }>
  /** Test hook — clear the registry without traversing a scene.
   *  Releases any attached kinematic bodies through ``phys.world``. */
  reset(): void
}

/**
 * Build a fresh animation system instance. The runtime owns one of
 * these per loaded track; ``main.ts`` registers it against the
 * environment GLB root and calls ``tick(elapsedSeconds, enabled)``
 * once per render frame. Pass ``opts.phys`` to wire kinematic
 * colliders that follow the swinging arms.
 */
export function createLandmarkAnimation(
  opts: LandmarkAnimationOptions = {},
): LandmarkAnimationSystem {
  const animated: AnimatedArm[] = []
  const phys = opts.phys ?? null
  let lastEnabled = true

  function registerFromScene(root: THREE.Object3D): number {
    releaseBodies()
    animated.length = 0
    root.updateMatrixWorld(true)
    const worldPos = new THREE.Vector3()
    root.traverse((arm) => {
      // Arms are identified by the ``landmark_id = "mechanical_rig_arm"``
      // extra that ``seed_landmarks_library._make_mechanical_rig_collection``
      // stamps on the arm subtree root. We deliberately key off this
      // and NOT on the node name, because Three's GLTFLoader appends
      // ``_1`` / ``_2`` / … to duplicate names — the arm subtree may
      // arrive as ``landmark_mechanical_rig_arm_3`` for the fourth
      // crane and the mesh-primitive children that Three creates
      // (``..._arm_5``, ``..._arm_6``) match the name suffix without
      // carrying any swing metadata. Tagging on the extra cleanly
      // separates arm roots from their primitive descendants.
      if (arm.userData?.landmark_id !== 'mechanical_rig_arm') return
      const armExtras = readSwingExtras(arm.userData)
      // The arm subtree root must carry the full archetype triplet —
      // amplitude + axis live here even when the instance overrides
      // only the period. If a future authoring change strips the
      // extras we'd rather skip than animate with silent defaults.
      if (
        armExtras.periodS === undefined &&
        armExtras.amplitudeDeg === undefined &&
        armExtras.axis === undefined
      ) {
        return
      }
      // Walk up the parent chain looking for an instance-level
      // override block. The gantry-crane seed parents the arm under
      // the rig base, so the swing-period-override extra lives on the
      // GRANDPARENT (instance empty), not the immediate parent.
      // Doge's bell carries its overrides on the instance empty in
      // the same shape. We stop at the first ancestor that carries
      // any swing field, or fall through to archetype-only defaults.
      const instanceExtras = findInstanceSwingExtras(arm)
      const config = mergeSwingConfig(armExtras, instanceExtras)

      arm.getWorldPosition(worldPos)
      const phase = phaseFromWorldPos(worldPos.x, worldPos.z)
      // Capture the arm's authored rest rotation on its swing axis so
      // we can reset cleanly when the setting is toggled off and so
      // any non-zero authored bias (a crane parked mid-swing in the
      // .blend, say) is preserved as the swing centre.
      const restAngle =
        config.axis === 'X' ? arm.rotation.x : config.axis === 'Y' ? arm.rotation.y : arm.rotation.z
      // Build the kinematic body BEFORE the arm gets its first swing
      // delta applied — so the body's initial pose is the rest pose
      // and the collider verts are baked in arm-local space.
      const body = phys ? buildArmKinematicBody(arm, phys) : null
      animated.push({ arm, config, phase, restAngle, body })
    })
    return animated.length
  }

  function releaseBodies(): void {
    if (!phys) return
    for (const e of animated) {
      if (e.body) phys.world.removeRigidBody(e.body)
    }
  }

  function tick(elapsedSeconds: number, enabled: boolean): void {
    if (animated.length === 0) {
      lastEnabled = enabled
      return
    }
    if (!enabled) {
      // First frame after a flip: snap every arm back to rest AND
      // sync the kinematic body to that rest pose, then skip
      // subsequent ticks until re-enabled. Subsequent disabled ticks
      // don't re-issue setNextKinematic — Rapier will keep the body
      // at its last commanded pose, which is exactly what we want.
      if (lastEnabled) {
        for (const e of animated) {
          applyArmAngle(e.arm, e.config.axis, e.restAngle, 0)
          if (e.body) syncBodyToArm(e.arm, e.body)
        }
      }
      lastEnabled = false
      return
    }
    for (const e of animated) {
      const delta = computeArmAngleRad(elapsedSeconds, e.config, e.phase)
      applyArmAngle(e.arm, e.config.axis, e.restAngle, delta)
      if (e.body) syncBodyToArm(e.arm, e.body)
    }
    lastEnabled = true
  }

  function arms(): ReadonlyArray<{
    name: string
    config: SwingConfig
    phase: number
    restAngle: number
    hasBody: boolean
  }> {
    return animated.map((e) => ({
      name: e.arm.name,
      config: e.config,
      phase: e.phase,
      restAngle: e.restAngle,
      hasBody: e.body !== null,
    }))
  }

  function reset(): void {
    releaseBodies()
    animated.length = 0
    lastEnabled = true
  }

  return { registerFromScene, tick, arms, reset }
}
