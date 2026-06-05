/**
 * Animated-prop runtime lane — unit coverage for the data plumbing and the
 * skeleton-clone / mixer wiring. The actual on-GPU skinned render is proven
 * separately via `pnpm gen:track-shots` (real WebGPU); these tests pin the
 * routing predicate, clip selection, the skip in `createPropsMesh`, and that
 * a mixer genuinely advances a cloned instance's pose.
 */
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAnimatedPropsSystem } from '../../src/engine/render/animated-props'
import { createPropsMesh } from '../../src/engine/render/props-mesh'
import {
  isAnimatedAssetProp,
  type LoadedProp,
  pickAnimationClip,
} from '../../src/game/assets/prop-loader'
import type { Prop } from '../../src/game/tracks/types'

function swimClip(name = 'Swim'): THREE.AnimationClip {
  // A trivial clip that drives child "body" from y=0 to y=1 over 1s, so we
  // can assert a mixer actually moves the cloned pose.
  const track = new THREE.VectorKeyframeTrack('body.position', [0, 1], [0, 0, 0, 0, 1, 0])
  return new THREE.AnimationClip(name, 1, [track])
}

function stubAnimatedProp(clips: THREE.AnimationClip[]): LoadedProp {
  const root = new THREE.Group()
  root.name = 'prop_fish_root'
  root.userData.kind = 'prop'
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  body.name = 'body'
  root.add(body)
  return {
    root,
    colliders: [],
    extras: { prop_id: 'fish', category: 'fauna' },
    animations: clips,
  }
}

function stubStaticProp(): LoadedProp {
  const root = new THREE.Group()
  root.name = 'prop_rock_root'
  root.userData.kind = 'prop'
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  root.add(body)
  return { root, colliders: [], extras: { prop_id: 'rock', category: 'decor' }, animations: [] }
}

const at = (assetId: string, animated = true): Prop => ({
  type: 'asset',
  assetId,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  size: { x: 1, y: 1, z: 1 },
  ...(animated ? { animated: true } : {}),
})

afterEach(() => vi.restoreAllMocks())

describe('pickAnimationClip', () => {
  it('returns undefined when no clips', () => {
    expect(pickAnimationClip([])).toBeUndefined()
  })
  it('defaults to clip 0 when no name given (Quaternius one-clip case)', () => {
    const a = swimClip('Armature|Armature|Swim')
    expect(pickAnimationClip([a])).toBe(a)
  })
  it('matches by exact name, then case-insensitive substring', () => {
    const a = swimClip('Idle')
    const b = swimClip('Armature|Armature|Swim')
    expect(pickAnimationClip([a, b], 'Armature|Armature|Swim')).toBe(b)
    expect(pickAnimationClip([a, b], 'swim')).toBe(b)
  })
  it('warns and falls back to clip 0 on an unknown name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = swimClip('Swim')
    expect(pickAnimationClip([a], 'Nope')).toBe(a)
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('isAnimatedAssetProp', () => {
  const animated = stubAnimatedProp([swimClip()])
  const staticP = stubStaticProp()
  it('true only for opted-in asset props that ship clips', () => {
    expect(isAnimatedAssetProp(at('cc0/fish'), animated)).toBe(true)
  })
  it('false without the opt-in flag', () => {
    expect(isAnimatedAssetProp(at('cc0/fish', false), animated)).toBe(false)
  })
  it('false when the asset ships no clips', () => {
    expect(isAnimatedAssetProp(at('cc0/rock'), staticP)).toBe(false)
  })
  it('false for wave-rider assets (that routing wins)', () => {
    const wr: LoadedProp = { ...animated, waveRider: 'buoy' }
    expect(isAnimatedAssetProp(at('cc0/fish'), wr)).toBe(false)
  })
  it('false when the asset failed to load', () => {
    expect(isAnimatedAssetProp(at('cc0/fish'), undefined)).toBe(false)
  })
})

describe('createPropsMesh skips animated placements', () => {
  it('emits no instanced mesh for an animated asset prop', () => {
    const assets = new Map<string, LoadedProp>([['cc0/fish', stubAnimatedProp([swimClip()])]])
    const group = createPropsMesh([at('cc0/fish')], assets)
    expect(group.children.length).toBe(0)
  })
  it('still instances a non-animated asset prop', () => {
    const assets = new Map<string, LoadedProp>([['cc0/rock', stubStaticProp()]])
    const group = createPropsMesh([at('cc0/rock', false)], assets)
    expect(group.children.length).toBeGreaterThan(0)
  })
})

describe('createAnimatedPropsSystem', () => {
  it('clones + drives only animated placements, and a mixer advances the pose', () => {
    const scene = new THREE.Scene()
    const assets = new Map<string, LoadedProp>([
      ['cc0/fish', stubAnimatedProp([swimClip()])],
      ['cc0/rock', stubStaticProp()],
    ])
    const sys = createAnimatedPropsSystem(scene, [at('cc0/fish'), at('cc0/rock', false)], assets)
    expect(sys.count).toBe(1)
    const inst = scene.children.find((c) => c.name === 'animated-prop:cc0/fish')
    expect(inst).toBeDefined()
    const body = inst!.getObjectByName('body')!
    expect(body.position.y).toBeCloseTo(0, 5)
    sys.update(0.5) // halfway through the 1s clip → y ≈ 0.5
    expect(body.position.y).toBeGreaterThan(0.3)
    sys.dispose()
    expect(scene.children.find((c) => c.name === 'animated-prop:cc0/fish')).toBeUndefined()
  })

  it('caps instances and warns (no silent truncation)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const scene = new THREE.Scene()
    const assets = new Map<string, LoadedProp>([['cc0/fish', stubAnimatedProp([swimClip()])]])
    const props = [at('cc0/fish'), at('cc0/fish'), at('cc0/fish')]
    const sys = createAnimatedPropsSystem(scene, props, assets, { maxInstances: 2 })
    expect(sys.count).toBe(2)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('skips the mixer tick for instances past the LOD distance', () => {
    const scene = new THREE.Scene()
    const assets = new Map<string, LoadedProp>([['cc0/fish', stubAnimatedProp([swimClip()])]])
    const far: Prop = { ...at('cc0/fish'), position: { x: 1000, y: 0, z: 0 } }
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(0, 0, 0)
    const sys = createAnimatedPropsSystem(scene, [far], assets, { camera, lodDistance: 100 })
    const body = scene.children
      .find((c) => c.name === 'animated-prop:cc0/fish')!
      .getObjectByName('body')!
    sys.update(0.5)
    expect(body.position.y).toBeCloseTo(0, 5) // frozen — never ticked
  })
})
