import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createPostPipeline } from '../../src/engine/render/post-pipeline'

/**
 * Headless construction/teardown coverage for the WebGPU post-pipeline.
 *
 * There is no GPU in the node test env, so we never call `render()` /
 * `compileAsync()` (those touch the device). `createPostPipeline` only
 * builds TSL node graphs + a `RenderPipeline` that stores the renderer —
 * none of that needs a device — so construction and `dispose()` are
 * exercisable. The renderer is a minimal stub; the pipeline only holds the
 * reference until a real render, which we don't drive here.
 */

function makeDeps() {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000)
  // RenderPipeline just stashes the renderer; no device methods are hit
  // during graph construction.
  const renderer = {} as unknown as THREE.WebGLRenderer
  return { renderer, scene, camera }
}

describe('createPostPipeline', () => {
  it('builds with no options (shipping bloom-only path)', () => {
    const deps = makeDeps()
    const pipeline = createPostPipeline(deps)
    expect(pipeline.scene).toBe(deps.scene)
    expect(pipeline.camera).toBe(deps.camera)
    expect(typeof pipeline.render).toBe('function')
    expect(typeof pipeline.setBloom).toBe('function')
    expect(typeof pipeline.setOutline).toBe('function')
    expect(() => pipeline.setBloom(0.5)).not.toThrow()
    // setOutline is a safe no-op when the outline effect wasn't wired.
    expect(() => pipeline.setOutline(0.5)).not.toThrow()
    expect(() => pipeline.dispose()).not.toThrow()
  })

  it('builds with the cel/ink outline enabled', () => {
    const deps = makeDeps()
    const pipeline = createPostPipeline({
      ...deps,
      bloomStrength: 0.3,
      outline: { enabled: true, strength: 0.9, color: 0x101820, threshold: 0.12, softness: 0.5 },
    })
    expect(typeof pipeline.render).toBe('function')
    // Live-set of the wired outline mutates without throwing.
    expect(() => pipeline.setOutline(0.4, 0x000000)).not.toThrow()
    expect(() => pipeline.dispose()).not.toThrow()
  })

  it('builds with motion blur enabled (velocity MRT)', () => {
    const deps = makeDeps()
    const pipeline = createPostPipeline({
      ...deps,
      motionBlur: { enabled: true, samples: 8 },
    })
    expect(typeof pipeline.render).toBe('function')
    expect(() => pipeline.dispose()).not.toThrow()
  })

  it('builds with both new effects enabled together', () => {
    const deps = makeDeps()
    const pipeline = createPostPipeline({
      ...deps,
      bloomStrength: 0.5,
      outline: { enabled: true },
      motionBlur: { enabled: true },
    })
    expect(typeof pipeline.render).toBe('function')
    expect(() => pipeline.setBloom(1, 0.5, 0.8)).not.toThrow()
    expect(() => pipeline.setOutline(0.6)).not.toThrow()
    expect(() => pipeline.dispose()).not.toThrow()
  })

  it('treats explicit enabled:false the same as omitting the option', () => {
    const deps = makeDeps()
    const pipeline = createPostPipeline({
      ...deps,
      outline: { enabled: false },
      motionBlur: { enabled: false },
    })
    // Disabled outline → mutator no-ops, never throws.
    expect(() => pipeline.setOutline(1)).not.toThrow()
    expect(() => pipeline.dispose()).not.toThrow()
  })
})
