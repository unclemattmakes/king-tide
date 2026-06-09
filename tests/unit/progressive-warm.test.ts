/**
 * Progressive scenery warm — unit coverage for the reveal scheduling. The
 * actual GPU pipeline warm is proven on real WebGPU by
 * tests/e2e/hitch-profile.spec.ts + progressive-warm-visual.spec.ts; these
 * tests pin the invariants the compiled path relies on:
 *
 *  - deferral hides every mesh up front;
 *  - the compile hook sees the mesh visible + un-culled (the synchronous
 *    project window inside renderer.compileAsync), but the mesh is hidden
 *    again before any frame could render it uncompiled, and only revealed
 *    once its compile settles;
 *  - a rejected or throwing compile still reveals the mesh (first sight then
 *    pays its own compile — never a missing building);
 *  - the legacy no-hook path reveals perFrame meshes per rAF step.
 */
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferSceneryWarm } from '../../src/boot/progressive-warm'

function makeMeshes(n: number): THREE.Mesh[] {
  return Array.from({ length: n }, (_, i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    m.name = `scenery_${i}`
    return m
  })
}

/** Manual rAF pump so the async reveal loop advances deterministically. */
function stubRaf(): { pump: () => void } {
  let queue: Array<(t: number) => void> = []
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    queue.push(cb)
    return queue.length
  })
  return {
    pump() {
      const q = queue
      queue = []
      for (const cb of q) cb(0)
    },
  }
}

/** Pump rAF + flush microtasks until `cond` holds (bounded). */
async function drainUntil(cond: () => boolean, pump: () => void): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) {
    pump()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  expect(cond()).toBe(true)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deferSceneryWarm', () => {
  it('hides every deferred mesh immediately', () => {
    const meshes = makeMeshes(3)
    const warm = deferSceneryWarm(meshes)
    expect(warm.count).toBe(3)
    expect(meshes.every((m) => !m.visible)).toBe(true)
  })

  it('compiled path: compile sees visible+unculled, mesh stays hidden until its compile resolves', async () => {
    const { pump } = stubRaf()
    const meshes = makeMeshes(3)
    // One mesh authored with frustumCulled=false — must survive the dance.
    const m1 = meshes[1]
    if (m1) m1.frustumCulled = false
    const duringCompile: Array<{ visible: boolean; culled: boolean }> = []
    const resolvers: Array<() => void> = []
    const compile = vi.fn((o: THREE.Object3D) => {
      duringCompile.push({ visible: o.visible, culled: o.frustumCulled })
      return new Promise<void>((resolve) => resolvers.push(resolve))
    })
    let done = false
    const warm = deferSceneryWarm(meshes)
    warm.reveal({ compile, onDone: () => (done = true) })

    // The first compile is kicked synchronously inside reveal(); the mesh must
    // already be re-hidden (no rAF frame may render it uncompiled) with its
    // cull flag restored.
    expect(compile).toHaveBeenCalledTimes(1)
    expect(duringCompile[0]).toEqual({ visible: true, culled: false })
    expect(meshes[0]?.visible).toBe(false)
    expect(meshes[0]?.frustumCulled).toBe(true)

    // Resolving each compile reveals that mesh and advances to the next.
    await drainUntil(() => resolvers.length === 1, pump)
    resolvers[0]?.()
    await drainUntil(() => meshes[0]?.visible === true, pump)
    expect(meshes[1]?.visible).toBe(false)

    await drainUntil(() => resolvers.length === 2, pump)
    expect(duringCompile[1]).toEqual({ visible: true, culled: false })
    resolvers[1]?.()
    await drainUntil(() => meshes[1]?.visible === true, pump)
    expect(meshes[1]?.frustumCulled).toBe(false) // authored value restored

    await drainUntil(() => resolvers.length === 3, pump)
    resolvers[2]?.()
    await drainUntil(() => done, pump)
    expect(meshes.every((m) => m.visible)).toBe(true)
    expect(compile).toHaveBeenCalledTimes(3)
  })

  it('compiled path: meshes sharing material+layout reveal as one group with one compile', async () => {
    const { pump } = stubRaf()
    const sharedMat = new THREE.MeshBasicMaterial()
    const sharedGeom = new THREE.BoxGeometry(1, 1, 1)
    const a = new THREE.Mesh(sharedGeom, sharedMat)
    const b = new THREE.Mesh(sharedGeom.clone(), sharedMat) // same layout, same material
    const c = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    const compile = vi.fn(() => Promise.resolve())
    let done = false
    deferSceneryWarm([a, b, c]).reveal({ compile, onDone: () => (done = true) })
    await drainUntil(() => done, pump)
    expect([a, b, c].every((m) => m.visible)).toBe(true)
    // a+b share a pipeline group → one compile; c is its own group.
    expect(compile).toHaveBeenCalledTimes(2)
    expect(compile).toHaveBeenCalledWith(a)
    expect(compile).toHaveBeenCalledWith(c)
  })

  it('compiled path: rejected and throwing compiles still reveal every mesh', async () => {
    const { pump } = stubRaf()
    const meshes = makeMeshes(3)
    let calls = 0
    const compile = vi.fn(() => {
      calls++
      if (calls === 1) throw new Error('sync boom')
      if (calls === 2) return Promise.reject(new Error('async boom'))
      return Promise.resolve()
    })
    let done = false
    deferSceneryWarm(meshes).reveal({ compile, onDone: () => (done = true) })
    await drainUntil(() => done, pump)
    expect(meshes.every((m) => m.visible)).toBe(true)
    expect(compile).toHaveBeenCalledTimes(3)
  })

  it('legacy path (no compile hook): reveals perFrame meshes per rAF step', () => {
    const { pump } = stubRaf()
    const meshes = makeMeshes(5)
    let done = false
    deferSceneryWarm(meshes).reveal({ perFrame: 2, onDone: () => (done = true) })
    expect(meshes.every((m) => !m.visible)).toBe(true)
    pump()
    expect(meshes.filter((m) => m.visible).length).toBe(2)
    pump()
    expect(meshes.filter((m) => m.visible).length).toBe(4)
    pump()
    expect(meshes.filter((m) => m.visible).length).toBe(5)
    expect(done).toBe(true)
  })

  it('reveals everything immediately when requestAnimationFrame is unavailable', () => {
    vi.stubGlobal('requestAnimationFrame', undefined)
    const meshes = makeMeshes(2)
    let done = false
    deferSceneryWarm(meshes).reveal({
      compile: () => Promise.resolve(),
      onDone: () => (done = true),
    })
    expect(meshes.every((m) => m.visible)).toBe(true)
    expect(done).toBe(true)
  })
})
