import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  computeArmAngleRad,
  createLandmarkAnimation,
  findInstanceSwingExtras,
  type LandmarkAnimationOptions,
  mergeSwingConfig,
  phaseFromWorldPos,
  readSwingExtras,
  type SwingConfig,
} from '../../src/engine/render/landmark-animation'

/**
 * Unit tests for the landmark-animation reader / pendulum math /
 * scene-traversal contract.
 *
 * The animation system is purely a function of:
 *   * what extras live on the arm node + its parent (precedence rules
 *     for archetype defaults vs Marina Bay 7's per-instance period
 *     override vs Doge's Drift's per-instance full triplet);
 *   * the deterministic phase derivation from world XYZ;
 *   * the sin pendulum sample value at (t, period, amplitude, phase);
 *   * the toggle-off contract — flipping `enabled=false` pins arms to
 *     their captured rest pose so per-track-tuned authored poses
 *     aren't lost when a player disables the animation.
 *
 * We don't spin up a renderer here. The traversal pass goes through
 * THREE.Object3D directly so the test is allocation-light and runs
 * without WebGL/WebGPU.
 */

describe('readSwingExtras — extras precedence + validation', () => {
  it('returns empty for missing or malformed userData', () => {
    expect(readSwingExtras(undefined)).toEqual({})
    expect(readSwingExtras(null)).toEqual({})
    expect(readSwingExtras('not-an-object')).toEqual({})
    expect(readSwingExtras({})).toEqual({})
  })

  it('reads the archetype defaults', () => {
    const out = readSwingExtras({
      swing_period_s: 12.0,
      swing_amplitude_deg: 40.0,
      swing_axis: 'Z',
    })
    expect(out).toEqual({ periodS: 12.0, amplitudeDeg: 40.0, axis: 'Z' })
  })

  it('prefers swing_period_s_override over swing_period_s on the same node', () => {
    const out = readSwingExtras({
      swing_period_s: 12.0,
      swing_period_s_override: 3.6,
    })
    expect(out.periodS).toBe(3.6)
  })

  it('drops non-finite or non-positive periods', () => {
    expect(readSwingExtras({ swing_period_s: 0 }).periodS).toBeUndefined()
    expect(readSwingExtras({ swing_period_s: -1 }).periodS).toBeUndefined()
    expect(readSwingExtras({ swing_period_s: Number.NaN }).periodS).toBeUndefined()
    expect(readSwingExtras({ swing_period_s_override: 0 }).periodS).toBeUndefined()
  })

  it('normalises swing_axis to uppercase + rejects unknown axes', () => {
    expect(readSwingExtras({ swing_axis: 'y' }).axis).toBe('Y')
    expect(readSwingExtras({ swing_axis: 'Y' }).axis).toBe('Y')
    expect(readSwingExtras({ swing_axis: 'W' }).axis).toBeUndefined()
    expect(readSwingExtras({ swing_axis: 42 }).axis).toBeUndefined()
  })
})

describe('findInstanceSwingExtras — multi-level parent walk', () => {
  it('returns empty when no ancestor carries swing extras', () => {
    const root = new THREE.Group()
    const arm = new THREE.Object3D()
    root.add(arm)
    expect(findInstanceSwingExtras(arm)).toEqual({})
  })

  it("finds extras on the immediate parent (Doge's bell shape)", () => {
    const parent = new THREE.Object3D()
    parent.userData = { swing_period_s: 2.5, swing_axis: 'Y' }
    const arm = new THREE.Object3D()
    parent.add(arm)
    expect(findInstanceSwingExtras(arm)).toEqual({ periodS: 2.5, axis: 'Y' })
  })

  it('climbs through an intermediate node (Marina Bay 7 shape — base sits between arm and instance)', () => {
    // arm -> base (no extras) -> gantry_crane (swing_period_s_override)
    const instance = new THREE.Object3D()
    instance.userData = { swing_period_s_override: 3.6 }
    const base = new THREE.Object3D()
    instance.add(base)
    const arm = new THREE.Object3D()
    base.add(arm)
    expect(findInstanceSwingExtras(arm)).toEqual({ periodS: 3.6 })
  })

  it('stops at the first ancestor that carries swing extras', () => {
    // If a far-up ancestor has unrelated extras, the closer one wins.
    const grand = new THREE.Object3D()
    grand.userData = { swing_period_s: 99 }
    const inst = new THREE.Object3D()
    inst.userData = { swing_period_s_override: 4.2 }
    grand.add(inst)
    const base = new THREE.Object3D()
    inst.add(base)
    const arm = new THREE.Object3D()
    base.add(arm)
    expect(findInstanceSwingExtras(arm)).toEqual({ periodS: 4.2 })
  })
})

describe('mergeSwingConfig — instance overrides win field-by-field', () => {
  it('falls back to defaults when both sides empty', () => {
    expect(mergeSwingConfig({}, {})).toEqual({
      periodS: 12.0,
      amplitudeDeg: 40.0,
      axis: 'Z',
    })
  })

  it('takes archetype values when no instance overrides', () => {
    expect(mergeSwingConfig({ periodS: 6, amplitudeDeg: 20, axis: 'X' }, {})).toEqual({
      periodS: 6,
      amplitudeDeg: 20,
      axis: 'X',
    })
  })

  it('Marina Bay 7 case — period override only, archetype keeps axis + amplitude', () => {
    const archetype: Partial<SwingConfig> = { periodS: 12, amplitudeDeg: 40, axis: 'Z' }
    const instance: Partial<SwingConfig> = { periodS: 3.6 }
    expect(mergeSwingConfig(archetype, instance)).toEqual({
      periodS: 3.6,
      amplitudeDeg: 40,
      axis: 'Z',
    })
  })

  it("Doge's Drift case — full instance triplet replaces archetype", () => {
    const archetype: Partial<SwingConfig> = { periodS: 12, amplitudeDeg: 40, axis: 'Z' }
    const instance: Partial<SwingConfig> = { periodS: 2.5, amplitudeDeg: 18, axis: 'Y' }
    expect(mergeSwingConfig(archetype, instance)).toEqual({
      periodS: 2.5,
      amplitudeDeg: 18,
      axis: 'Y',
    })
  })
})

describe('phaseFromWorldPos — stable, distinct phases for distinct positions', () => {
  it('returns 0 at the origin', () => {
    expect(phaseFromWorldPos(0, 0)).toBe(0)
  })

  it('is deterministic — same inputs map to the same phase across calls', () => {
    expect(phaseFromWorldPos(242, -50)).toBe(phaseFromWorldPos(242, -50))
    expect(phaseFromWorldPos(-3, 7.5)).toBe(phaseFromWorldPos(-3, 7.5))
  })

  it('always lands in [0, 1) even for negative coordinates', () => {
    const samples = [
      phaseFromWorldPos(-100, -100),
      phaseFromWorldPos(-1000.5, 999.2),
      phaseFromWorldPos(0.0001, -0.0001),
      phaseFromWorldPos(1e6, -1e6),
    ]
    for (const p of samples) {
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(1)
    }
  })

  it('distinguishes Marina Bay 7 cranes (integer positions, 25 m spacing)', () => {
    // Five cranes at (242, ±50/±25/0, …) — integer positions. A naive
    // ``(x + z) mod 1`` would round all five phases to zero; the
    // irrational-coefficient blend keeps them distinct.
    const phases = [
      phaseFromWorldPos(242, -50),
      phaseFromWorldPos(242, -25),
      phaseFromWorldPos(242, 0),
      phaseFromWorldPos(242, 25),
      phaseFromWorldPos(242, 50),
    ]
    const unique = new Set(phases.map((p) => p.toFixed(6)))
    expect(unique.size).toBe(5)
  })
})

describe('computeArmAngleRad — pendulum math', () => {
  it('starts at zero radians for phase=0 at t=0', () => {
    expect(computeArmAngleRad(0, { periodS: 4, amplitudeDeg: 40, axis: 'Z' }, 0)).toBeCloseTo(0, 12)
  })

  it('peaks at +amplitude after a quarter period (phase=0)', () => {
    const angle = computeArmAngleRad(1, { periodS: 4, amplitudeDeg: 40, axis: 'Z' }, 0)
    expect(angle).toBeCloseTo((40 * Math.PI) / 180, 9)
  })

  it('returns to zero at the half period', () => {
    const angle = computeArmAngleRad(2, { periodS: 4, amplitudeDeg: 40, axis: 'Z' }, 0)
    expect(angle).toBeCloseTo(0, 9)
  })

  it('hits the -amplitude trough at three-quarter period', () => {
    const angle = computeArmAngleRad(3, { periodS: 4, amplitudeDeg: 40, axis: 'Z' }, 0)
    expect(angle).toBeCloseTo(-(40 * Math.PI) / 180, 9)
  })

  it('phase=0.25 puts the bike at peak at t=0', () => {
    const angle = computeArmAngleRad(0, { periodS: 4, amplitudeDeg: 40, axis: 'Z' }, 0.25)
    expect(angle).toBeCloseTo((40 * Math.PI) / 180, 9)
  })
})

// ────────────────────────────────────────────────────────────────────
// Scene-graph integration: build a synthetic Three tree mirroring the
// shape Blender writes for collection-instance landmarks, then verify
// the system finds the arms, derives configs, and rotates them.
// ────────────────────────────────────────────────────────────────────

function makeArmNode(opts: {
  name: string
  archetypePeriodS?: number
  archetypeAmplitudeDeg?: number
  archetypeAxis?: 'X' | 'Y' | 'Z'
}): THREE.Object3D {
  const arm = new THREE.Object3D()
  arm.name = opts.name
  arm.userData = {
    kind: 'track',
    landmark_id: 'mechanical_rig_arm',
    swing_period_s: opts.archetypePeriodS ?? 12.0,
    swing_amplitude_deg: opts.archetypeAmplitudeDeg ?? 40.0,
    swing_axis: opts.archetypeAxis ?? 'Z',
  }
  return arm
}

/**
 * Mirror the realised collection-instance shape Blender exports:
 *
 *   instance empty (gantry_crane_NN)
 *     └── base mesh (landmark_mechanical_rig_base)
 *           └── arm subtree root (landmark_mechanical_rig_arm)
 *
 * The instance carries the swing-period override; the arm carries the
 * archetype defaults; the base is a passthrough. We replicate this
 * three-deep nesting because the runtime parent walk has to traverse
 * the base to find the override on the grandparent.
 */
function makeMarinaBayCrane(
  name: string,
  pos: [number, number, number],
  periodOverride: number,
): {
  inst: THREE.Object3D
  base: THREE.Object3D
  arm: THREE.Object3D
} {
  const inst = new THREE.Object3D()
  inst.name = name
  inst.position.set(...pos)
  inst.userData = {
    kind: 'track',
    landmark_id: 'mechanical_rig',
    hb_landmark: 'gantry_crane',
    swing_period_s_override: periodOverride,
  }
  const base = new THREE.Object3D()
  base.name = 'landmark_mechanical_rig_base'
  base.userData = { kind: 'track', landmark_id: 'mechanical_rig_base' }
  inst.add(base)
  const arm = makeArmNode({ name: 'landmark_mechanical_rig_arm' })
  base.add(arm)
  return { inst, base, arm }
}

function makeDogesBell(): { inst: THREE.Object3D; base: THREE.Object3D; arm: THREE.Object3D } {
  const inst = new THREE.Object3D()
  inst.name = 'campanile_bell'
  inst.position.set(5, 55, 0)
  inst.userData = {
    kind: 'decoration',
    landmark_id: 'mechanical_rig',
    set_piece: 'swinging_bell',
    swing_period_s: 2.5,
    swing_amplitude_deg: 18.0,
    swing_axis: 'Y',
  }
  const base = new THREE.Object3D()
  base.name = 'landmark_mechanical_rig_base'
  base.userData = { kind: 'decoration', landmark_id: 'mechanical_rig_base' }
  inst.add(base)
  const arm = makeArmNode({ name: 'landmark_mechanical_rig_arm' })
  base.add(arm)
  return { inst, base, arm }
}

describe('createLandmarkAnimation — scene traversal + tick', () => {
  it('registers Marina Bay 7 cranes (5 arms, period overrides applied)', () => {
    const root = new THREE.Group()
    const cranes = [
      makeMarinaBayCrane('gantry_crane_00', [242, 0, -50], 3.0),
      makeMarinaBayCrane('gantry_crane_01', [242, 0, -25], 3.6),
      makeMarinaBayCrane('gantry_crane_02', [242, 0, 0], 4.2),
      makeMarinaBayCrane('gantry_crane_03', [242, 0, 25], 3.3),
      makeMarinaBayCrane('gantry_crane_04', [242, 0, 50], 3.8),
    ]
    for (const c of cranes) root.add(c.inst)

    const anim = createLandmarkAnimation()
    expect(anim.registerFromScene(root)).toBe(5)

    const arms = anim.arms()
    // Each crane's resolved period matches its override.
    const periods = arms.map((a) => a.config.periodS).sort((a, b) => a - b)
    expect(periods).toEqual([3.0, 3.3, 3.6, 3.8, 4.2])
    // Amplitude + axis still come from the archetype (instance only
    // overrode period).
    for (const a of arms) {
      expect(a.config.amplitudeDeg).toBe(40.0)
      expect(a.config.axis).toBe('Z')
    }
    // All five distinct phases — pure x+z derivation, the +25m Z
    // spacing guarantees distinct sums.
    const phases = new Set(arms.map((a) => a.phase.toFixed(6)))
    expect(phases.size).toBe(5)
  })

  it("registers Doge's Drift bell with instance triplet override", () => {
    const root = new THREE.Group()
    const { inst } = makeDogesBell()
    root.add(inst)

    const anim = createLandmarkAnimation()
    expect(anim.registerFromScene(root)).toBe(1)
    const [bell] = anim.arms()
    expect(bell?.config).toEqual({ periodS: 2.5, amplitudeDeg: 18.0, axis: 'Y' })
  })

  it('skips nodes without landmark_id="mechanical_rig_arm"', () => {
    // A base mesh that happens to carry swing extras (a future
    // authoring slip) must not register as an arm — the runtime
    // would rotate the wrong object and the actual arm would never
    // move. The landmark_id tag is the canonical anchor.
    const root = new THREE.Group()
    const fake = new THREE.Object3D()
    fake.name = 'landmark_mechanical_rig_base'
    fake.userData = {
      landmark_id: 'mechanical_rig_base',
      swing_period_s: 5,
      swing_amplitude_deg: 10,
      swing_axis: 'Z',
    }
    root.add(fake)

    const anim = createLandmarkAnimation()
    expect(anim.registerFromScene(root)).toBe(0)
  })

  it('skips arm-tagged nodes without any swing metadata', () => {
    const root = new THREE.Group()
    const orphan = new THREE.Object3D()
    orphan.name = 'random_arm'
    orphan.userData = { landmark_id: 'mechanical_rig_arm' }
    root.add(orphan)

    const anim = createLandmarkAnimation()
    expect(anim.registerFromScene(root)).toBe(0)
  })

  it('ignores Three-suffixed mesh-primitive descendants under an arm', () => {
    // GLTFLoader appends `_5` / `_6` etc. to multi-primitive mesh
    // children of a glTF mesh node. Those siblings sit under the arm
    // root, share the `_arm` name prefix, but DON'T carry the
    // landmark_id tag — so the arm-root selector skips them.
    const root = new THREE.Group()
    const { inst, arm } = makeMarinaBayCrane('crane', [0, 0, 0], 4.0)
    const prim1 = new THREE.Object3D()
    prim1.name = 'landmark_mechanical_rig_arm_5'
    arm.add(prim1)
    const prim2 = new THREE.Object3D()
    prim2.name = 'landmark_mechanical_rig_arm_6'
    arm.add(prim2)
    root.add(inst)

    const anim = createLandmarkAnimation()
    // One arm registered, not three. Primitive descendants are ignored.
    expect(anim.registerFromScene(root)).toBe(1)
  })

  it('tick rotates arms around the configured axis with a sin pendulum', () => {
    const root = new THREE.Group()
    const { inst, arm } = makeMarinaBayCrane('crane', [0, 0, 0], 4.0)
    root.add(inst)

    const anim = createLandmarkAnimation()
    anim.registerFromScene(root)

    // At t=0, phase=0 (origin position), and archetype axis Z, the
    // arm's local Z rotation should be 0.
    anim.tick(0, true)
    expect(arm.rotation.x).toBe(0)
    expect(arm.rotation.y).toBe(0)
    expect(arm.rotation.z).toBeCloseTo(0, 9)

    // Quarter period (t=1, period=4) — Z rotation hits +amplitude.
    anim.tick(1.0, true)
    expect(arm.rotation.z).toBeCloseTo((40 * Math.PI) / 180, 6)
    // Other axes untouched.
    expect(arm.rotation.x).toBe(0)
    expect(arm.rotation.y).toBe(0)
  })

  it('tick rotates the bell around the Y axis (instance override)', () => {
    const root = new THREE.Group()
    const { inst, arm } = makeDogesBell()
    // Reposition to origin so phase=0; we want to test that the axis
    // dispatch lands on Y regardless of the archetype default.
    inst.position.set(0, 0, 0)
    root.add(inst)

    const anim = createLandmarkAnimation()
    anim.registerFromScene(root)
    // Quarter period of 2.5 s = 0.625 s — at that t, sin(π/2) = 1, so
    // the angle is +amplitude radians on the Y axis.
    anim.tick(0.625, true)
    expect(arm.rotation.y).toBeCloseTo((18 * Math.PI) / 180, 6)
    expect(arm.rotation.x).toBe(0)
    expect(arm.rotation.z).toBe(0)
  })

  it('toggling enabled=false pins arms back to rest pose', () => {
    const root = new THREE.Group()
    const { inst, arm } = makeMarinaBayCrane('crane', [0, 0, 0], 4.0)
    root.add(inst)

    const anim = createLandmarkAnimation()
    anim.registerFromScene(root)

    anim.tick(1.0, true) // peak +amplitude
    expect(Math.abs(arm.rotation.z)).toBeGreaterThan(0.1)

    anim.tick(1.5, false) // should snap to rest (0)
    expect(arm.rotation.z).toBe(0)

    // Subsequent disabled ticks remain at rest (no-op fast path).
    anim.tick(2.0, false)
    expect(arm.rotation.z).toBe(0)

    // Re-enabling resumes the sin from the live elapsedSeconds —
    // no jump back to a saved phase.
    anim.tick(3.0, true)
    // sin(2π · (3/4 + 0)) = sin(3π/2) = -1 → -amplitude.
    expect(arm.rotation.z).toBeCloseTo(-(40 * Math.PI) / 180, 6)
  })

  it('preserves an authored non-zero rest rotation as the swing centre', () => {
    const root = new THREE.Group()
    const { inst, arm } = makeMarinaBayCrane('crane', [0, 0, 0], 4.0)
    // Author parked the crane mid-swing — the sin should oscillate
    // around this value, and disabling animation should reset to it.
    arm.rotation.z = 0.3
    root.add(inst)

    const anim = createLandmarkAnimation()
    anim.registerFromScene(root)

    anim.tick(0, true)
    expect(arm.rotation.z).toBeCloseTo(0.3, 9)

    anim.tick(1.0, true) // delta peaks at +amplitude
    expect(arm.rotation.z).toBeCloseTo(0.3 + (40 * Math.PI) / 180, 6)

    anim.tick(1.5, false) // pin back to rest
    expect(arm.rotation.z).toBeCloseTo(0.3, 9)
  })

  it('reset clears the registry without traversing a scene', () => {
    const root = new THREE.Group()
    root.add(makeMarinaBayCrane('crane', [0, 0, 0], 4.0).inst)

    const anim = createLandmarkAnimation()
    anim.registerFromScene(root)
    expect(anim.arms()).toHaveLength(1)
    anim.reset()
    expect(anim.arms()).toHaveLength(0)
  })

  it('re-registering replaces the prior registry', () => {
    const root1 = new THREE.Group()
    root1.add(makeMarinaBayCrane('crane_0', [0, 0, 0], 4.0).inst)
    root1.add(makeMarinaBayCrane('crane_1', [25, 0, 0], 5.0).inst)
    const anim = createLandmarkAnimation()
    anim.registerFromScene(root1)
    expect(anim.arms()).toHaveLength(2)

    const root2 = new THREE.Group()
    root2.add(makeDogesBell().inst)
    anim.registerFromScene(root2)
    expect(anim.arms()).toHaveLength(1)
  })
})

// ────────────────────────────────────────────────────────────────────
// Kinematic-collider integration: stub the PhysicsWorld with mock
// objects that record calls so we can assert (a) the right number of
// kinematic bodies get built, (b) each tick pushes a fresh
// setNextKinematic* pair, (c) toggle-off issues one final sync to rest
// then stops calling, (d) reset releases bodies.
//
// We don't use a real Rapier instance here because spinning up the
// WASM init adds 50 ms per test and the only thing this test cares
// about is the call shape against the PhysicsWorld interface.
// ────────────────────────────────────────────────────────────────────

type FakeBody = {
  id: number
  translations: Array<{ x: number; y: number; z: number }>
  rotations: Array<{ x: number; y: number; z: number; w: number }>
}

function makeFakePhys() {
  const bodies: FakeBody[] = []
  const removed: FakeBody[] = []
  const colliders: Array<{ bodyId: number; vertCount: number; triCount: number }> = []
  let nextId = 1

  const fluentDesc = {
    _translation: { x: 0, y: 0, z: 0 },
    _rotation: { x: 0, y: 0, z: 0, w: 1 },
    setTranslation(x: number, y: number, z: number) {
      this._translation = { x, y, z }
      return this
    },
    setRotation(q: { x: number; y: number; z: number; w: number }) {
      this._rotation = { ...q }
      return this
    },
  }

  const colliderDesc = {
    _verts: new Float32Array(),
    _indices: new Uint32Array(),
    setFriction(_: number) {
      return this
    },
    setRestitution(_: number) {
      return this
    },
  }

  const rapier = {
    RigidBodyDesc: {
      kinematicPositionBased: () => {
        // Fresh fluent state for each call.
        const d = Object.assign({}, fluentDesc)
        d.setTranslation = fluentDesc.setTranslation.bind(d)
        d.setRotation = fluentDesc.setRotation.bind(d)
        return d
      },
    },
    ColliderDesc: {
      trimesh: (verts: Float32Array, indices: Uint32Array) => {
        const d = Object.assign({}, colliderDesc, { _verts: verts, _indices: indices })
        d.setFriction = colliderDesc.setFriction.bind(d)
        d.setRestitution = colliderDesc.setRestitution.bind(d)
        return d
      },
    },
  }

  const world = {
    createRigidBody: (_desc: unknown) => {
      const body: FakeBody = { id: nextId++, translations: [], rotations: [] }
      bodies.push(body)
      // Return a body proxy that records setNextKinematic* calls so the
      // tick path can be inspected. Each landmark arm gets one of these.
      return {
        _body: body,
        setNextKinematicTranslation(t: { x: number; y: number; z: number }) {
          body.translations.push({ ...t })
        },
        setNextKinematicRotation(r: { x: number; y: number; z: number; w: number }) {
          body.rotations.push({ ...r })
        },
      }
    },
    createCollider: (
      desc: { _verts: Float32Array; _indices: Uint32Array },
      parent: { _body: FakeBody },
    ) => {
      colliders.push({
        bodyId: parent._body.id,
        vertCount: desc._verts.length / 3,
        triCount: desc._indices.length / 3,
      })
    },
    removeRigidBody: (rb: { _body: FakeBody }) => {
      removed.push(rb._body)
    },
  }

  return {
    phys: { rapier, world } as unknown as NonNullable<LandmarkAnimationOptions['phys']>,
    bodies,
    removed,
    colliders,
  }
}

/** Build a Marina Bay crane scene with actual primitive Mesh
 *  geometry on the arm so the kinematic-body path has something to
 *  attach colliders to. */
function makeCraneWithGeometry(
  name: string,
  pos: [number, number, number],
  periodOverride: number,
): { inst: THREE.Object3D; arm: THREE.Object3D; prim: THREE.Mesh } {
  const { inst, arm } = makeMarinaBayCrane(name, pos, periodOverride)
  const geo = new THREE.BoxGeometry(0.3, 16, 0.3) // long thin arm-like volume
  const mat = new THREE.MeshBasicMaterial()
  const prim = new THREE.Mesh(geo, mat)
  prim.name = `${name}_arm_5` // mirrors Three's primitive auto-naming
  arm.add(prim)
  return { inst, arm, prim }
}

describe('createLandmarkAnimation — kinematic collider integration', () => {
  it('builds no kinematic bodies when no phys is passed', () => {
    const root = new THREE.Group()
    const { inst } = makeCraneWithGeometry('crane', [0, 0, 0], 4.0)
    root.add(inst)
    const anim = createLandmarkAnimation()
    anim.registerFromScene(root)
    expect(anim.arms()).toHaveLength(1)
    expect(anim.arms()[0]?.hasBody).toBe(false)
  })

  it('builds one kinematic body per arm + one trimesh collider per primitive when phys is passed', () => {
    const root = new THREE.Group()
    for (let i = 0; i < 5; i++) {
      root.add(makeCraneWithGeometry(`crane_${i}`, [0, 0, i * 25], 3.0 + i * 0.2).inst)
    }
    const fake = makeFakePhys()
    const anim = createLandmarkAnimation({ phys: fake.phys! })
    anim.registerFromScene(root)
    expect(anim.arms()).toHaveLength(5)
    expect(fake.bodies).toHaveLength(5) // one body per arm
    expect(fake.colliders).toHaveLength(5) // one trimesh per primitive child (each crane has 1)
    // BoxGeometry has 24 verts (Three reuses vertex slots per face) and
    // 12 triangles. We doubled the indices for two-sided trimesh — so
    // 24 triangles in the collider.
    expect(fake.colliders[0]?.triCount).toBe(24)
    // Each collider attached to a different body.
    const bodyIds = new Set(fake.colliders.map((c) => c.bodyId))
    expect(bodyIds.size).toBe(5)
  })

  it('tick pushes setNextKinematic* on every enabled tick', () => {
    const root = new THREE.Group()
    const { inst } = makeCraneWithGeometry('crane', [0, 0, 0], 4.0)
    root.add(inst)
    const fake = makeFakePhys()
    const anim = createLandmarkAnimation({ phys: fake.phys! })
    anim.registerFromScene(root)
    const body = fake.bodies[0]
    if (!body) throw new Error('expected one body')
    // Each tick records one translation + one rotation.
    anim.tick(0, true)
    expect(body.translations).toHaveLength(1)
    expect(body.rotations).toHaveLength(1)
    anim.tick(0.5, true)
    anim.tick(1.0, true)
    expect(body.translations).toHaveLength(3)
    expect(body.rotations).toHaveLength(3)
  })

  it('disabled tick syncs to rest once, then stops issuing kinematic updates', () => {
    const root = new THREE.Group()
    const { inst, arm } = makeCraneWithGeometry('crane', [0, 0, 0], 4.0)
    root.add(inst)
    const fake = makeFakePhys()
    const anim = createLandmarkAnimation({ phys: fake.phys! })
    anim.registerFromScene(root)
    const body = fake.bodies[0]
    if (!body) throw new Error('expected one body')

    // Two enabled ticks — body picks up two updates and ends at peak.
    anim.tick(0, true)
    anim.tick(1.0, true)
    expect(body.translations).toHaveLength(2)
    const peakArmZ = arm.rotation.z
    expect(Math.abs(peakArmZ)).toBeGreaterThan(0.1)

    // First disabled tick — issues ONE final sync to rest, then no
    // more updates on subsequent disabled ticks.
    anim.tick(1.5, false)
    expect(body.translations).toHaveLength(3)
    expect(arm.rotation.z).toBe(0)
    anim.tick(2.0, false)
    anim.tick(2.5, false)
    expect(body.translations).toHaveLength(3) // unchanged
  })

  it('reset releases every kinematic body through phys.world.removeRigidBody', () => {
    const root = new THREE.Group()
    root.add(makeCraneWithGeometry('a', [0, 0, 0], 4.0).inst)
    root.add(makeCraneWithGeometry('b', [25, 0, 0], 4.0).inst)
    root.add(makeCraneWithGeometry('c', [50, 0, 0], 4.0).inst)
    const fake = makeFakePhys()
    const anim = createLandmarkAnimation({ phys: fake.phys! })
    anim.registerFromScene(root)
    expect(fake.bodies).toHaveLength(3)
    expect(fake.removed).toHaveLength(0)
    anim.reset()
    expect(fake.removed).toHaveLength(3)
    expect(anim.arms()).toHaveLength(0)
  })

  it('re-registering releases prior bodies before building new ones', () => {
    const root1 = new THREE.Group()
    root1.add(makeCraneWithGeometry('a', [0, 0, 0], 4.0).inst)
    root1.add(makeCraneWithGeometry('b', [25, 0, 0], 4.0).inst)
    const fake = makeFakePhys()
    const anim = createLandmarkAnimation({ phys: fake.phys! })
    anim.registerFromScene(root1)
    expect(fake.bodies).toHaveLength(2)
    expect(fake.removed).toHaveLength(0)

    const root2 = new THREE.Group()
    root2.add(makeCraneWithGeometry('c', [0, 0, 0], 4.0).inst)
    anim.registerFromScene(root2)
    // Prior two bodies released, one new body built.
    expect(fake.removed).toHaveLength(2)
    expect(fake.bodies).toHaveLength(3) // cumulative create count: 2 + 1
  })
})
