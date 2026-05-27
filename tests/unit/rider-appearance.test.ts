/**
 * Rider-appearance design + per-primitive bone mesh generation.
 *
 * These guard the rider editor's two render-facing contracts:
 *   1. The default appearance reproduces the shipped rider (capsules, head
 *      box) with no explicit colours — so the main game, which never loads a
 *      saved design, is unchanged.
 *   2. Every selectable primitive builds a real Object3D without throwing.
 */
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  applyRiderAppearancePayload,
  bumpRiderAppearance,
  defaultBonePrimitive,
  defaultRiderAppearance,
  RIDER_APPEARANCE,
  RIDER_PRIMITIVES,
  resetRiderAppearance,
  serializeRiderAppearance,
} from '@/engine/render/rider-appearance'
import { createRiderBoneMesh } from '@/engine/render/rider-mesh'
import { RIDER_BONE_NAMES } from '@/game/components/rider'

describe('defaultRiderAppearance', () => {
  it('covers every bone with a primitive, unit scale, and a colour only on the head', () => {
    const app = defaultRiderAppearance()
    for (const name of RIDER_BONE_NAMES) {
      const bone = app.bones[name]
      expect(bone).toBeDefined()
      expect(bone.scale).toEqual({ x: 1, y: 1, z: 1 })
      if (name === 'head') {
        expect(bone.primitive).toBe('sphere')
        expect(bone.color).toBe(0x414881)
      } else {
        expect(bone.color).toBeNull()
      }
    }
  })

  it('defaultBonePrimitive matches the shipped mixed-shape rider', () => {
    expect(defaultBonePrimitive('head')).toBe('sphere')
    expect(defaultBonePrimitive('chest')).toBe('box')
    expect(defaultBonePrimitive('upper_arm_L')).toBe('box')
    expect(defaultBonePrimitive('pelvis')).toBe('capsule')
    expect(defaultBonePrimitive('lower_leg_R')).toBe('capsule')
  })
})

describe('RIDER_APPEARANCE singleton edits', () => {
  it('bump increments the version so the render system rebuilds', () => {
    const before = RIDER_APPEARANCE.version
    bumpRiderAppearance()
    expect(RIDER_APPEARANCE.version).toBe(before + 1)
  })

  it('reset restores defaults (incl. scale) and bumps the version', () => {
    RIDER_APPEARANCE.bones.head.primitive = 'cone'
    RIDER_APPEARANCE.bones.chest.color = 0x123456
    RIDER_APPEARANCE.bones.pelvis.scale = { x: 2, y: 3, z: 4 }
    const before = RIDER_APPEARANCE.version
    resetRiderAppearance()
    expect(RIDER_APPEARANCE.bones.head.primitive).toBe('sphere')
    expect(RIDER_APPEARANCE.bones.chest.color).toBeNull()
    expect(RIDER_APPEARANCE.bones.pelvis.scale).toEqual({ x: 1, y: 1, z: 1 })
    expect(RIDER_APPEARANCE.version).toBeGreaterThan(before)
  })
})

describe('appearance payload round-trip', () => {
  it('applies a serialized payload (incl. scale) and ignores malformed fields', () => {
    resetRiderAppearance()
    RIDER_APPEARANCE.bones.chest.primitive = 'cone'
    RIDER_APPEARANCE.bones.chest.color = 0xff8800
    RIDER_APPEARANCE.bones.chest.scale = { x: 1.5, y: 0.5, z: 2 }
    const payload = serializeRiderAppearance()

    resetRiderAppearance()
    expect(RIDER_APPEARANCE.bones.chest.primitive).toBe('box')
    expect(RIDER_APPEARANCE.bones.chest.scale).toEqual({ x: 1, y: 1, z: 1 })

    // Inject junk alongside the real payload — must be ignored, not throw.
    ;(payload.bones as Record<string, unknown>).pelvis = {
      primitive: 'not-a-shape',
      color: 'red',
      scale: { x: -2, y: 'big', z: 0 },
    }
    applyRiderAppearancePayload(payload)
    expect(RIDER_APPEARANCE.bones.chest.primitive).toBe('cone')
    expect(RIDER_APPEARANCE.bones.chest.color).toBe(0xff8800)
    expect(RIDER_APPEARANCE.bones.chest.scale).toEqual({ x: 1.5, y: 0.5, z: 2 })
    // Malformed pelvis entry left the defaults in place (capsule, unit scale).
    expect(RIDER_APPEARANCE.bones.pelvis.primitive).toBe('capsule')
    expect(RIDER_APPEARANCE.bones.pelvis.scale).toEqual({ x: 1, y: 1, z: 1 })

    resetRiderAppearance()
  })

  it('tolerates non-object input', () => {
    expect(() => applyRiderAppearancePayload(null)).not.toThrow()
    expect(() => applyRiderAppearancePayload('nope')).not.toThrow()
    expect(() => applyRiderAppearancePayload({ bones: 5 })).not.toThrow()
  })
})

describe('createRiderBoneMesh primitives', () => {
  it('builds a mesh for every primitive without throwing', () => {
    for (const primitive of RIDER_PRIMITIVES) {
      const obj = createRiderBoneMesh('upper_arm_L', 0.18, 0.07, 0x44aa88, primitive)
      expect(obj).toBeInstanceOf(THREE.Object3D)
      // Every primitive carries renderable geometry somewhere in its tree.
      let hasGeometry = false
      obj.traverse((c) => {
        if (c instanceof THREE.Mesh) hasGeometry = true
      })
      expect(hasGeometry).toBe(true)
    }
  })

  it('head box is a group with a visor (multiple child meshes)', () => {
    const head = createRiderBoneMesh('head', 0.05, 0.16, 0x2233aa, 'box')
    let meshCount = 0
    head.traverse((c) => {
      if (c instanceof THREE.Mesh) meshCount++
    })
    expect(meshCount).toBeGreaterThan(1)
  })

  it('head with a non-box primitive drops the visor (single mesh)', () => {
    const head = createRiderBoneMesh('head', 0.05, 0.16, 0x2233aa, 'sphere')
    expect(head).toBeInstanceOf(THREE.Mesh)
  })

  it('defaults primitive from the bone name when omitted', () => {
    // Legs default to capsule → single mesh.
    const leg = createRiderBoneMesh('upper_leg_L', 0.24, 0.1, 0x2233aa)
    expect(leg).toBeInstanceOf(THREE.Mesh)
    // Head defaults to sphere → single mesh (no visor).
    const head = createRiderBoneMesh('head', 0.05, 0.16, 0x2233aa)
    expect(head).toBeInstanceOf(THREE.Mesh)
  })
})
