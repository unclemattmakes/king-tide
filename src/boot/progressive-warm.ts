/**
 * Progressive shader pre-warm for the static scenery.
 *
 * Boot's shader pre-warm (`main.ts` phase 7b) compiles every material in the
 * scene under the loading screen — and since three's WebGPU pipeline cache keys
 * on per-instance node ids (each distinct `NodeMaterial` compiles its own
 * program), a dressed track pays ~one compile per vinyl material. On Sandbar
 * that's ~87 compiles ≈ 5 s, and ~half of them are the track's buildings +
 * scatter props the player never sees before the start line.
 *
 * This defers those: hide the scenery meshes so the essential warm (bikes,
 * riders, water, sky, terrain, gates) compiles fast and the loading screen
 * drops sooner, then bring them back once the race is live. Visibility-only:
 * no reparenting, so colliders, animation rigs, and world transforms are
 * untouched.
 *
 * How a deferred mesh comes back matters. Letting the running loop compile it
 * on first sight (the original design) creates the pipeline *synchronously
 * inside a rAF frame* — on Windows/D3D12 a single vinyl compile is 100–300 ms,
 * and at 2 reveals/frame Sandbar's 44 deferred meshes produced ~7 s of
 * 250–700 ms frames right at the start line, plus echo hitches through lap 1
 * for meshes that were frustum-culled at reveal time and only compiled when
 * the camera first swung past them. So when the caller supplies a `compile`
 * hook (the post-pipeline's `compileSubtreeAsync`, or `renderer.compileAsync`
 * when no post chain is active), each mesh is instead compiled *off the hot
 * path* — async pipeline creation with main-thread yields — and only made
 * visible once its pipelines are cached, so its first rendered frame costs
 * nothing. The hook compiles under the same cache key the live render uses
 * (see post-pipeline.ts); without a hook we fall back to the visibility-only
 * reveal.
 */
import type * as THREE from 'three'
import { bootStat } from './boot-trace'

/**
 * Compiles one object's GPU pipelines + resources asynchronously under the
 * same cache key the live render path uses. `PostPipeline.compileSubtreeAsync`
 * when a post chain is active, else `renderer.compileAsync(o, camera, scene)`.
 */
export type SubtreeCompiler = (object: THREE.Object3D) => Promise<void>

export type RevealOptions = {
  /** Meshes made visible per rAF step on the legacy (no-compile) path.
   *  Default 2. The compiled path paces itself: one pipeline-group per frame
   *  (or `concurrency` groups per frame). */
  perFrame?: number
  /** Async pre-compiler; when present each mesh is warmed before reveal. */
  compile?: SubtreeCompiler | undefined
  /** How many pipeline-groups to compile concurrently on the compiled path.
   *  Default 1 — one group per frame, the gentle background pace used while the
   *  game loop is live (so a reveal never bursts compiles into a racing frame).
   *  Raising it only helps when nothing interactive is running — but note the
   *  wall-clock is dominated by a one-time stall on the FIRST compile call
   *  (~8–12 s on an iGPU: createRenderPipelineAsync resolves behind the boot
   *  pre-warm's driver-side pipeline backlog, regardless of group count), which
   *  is why the intro path now skips deferral entirely (race-boot.ts
   *  `deferScenery`) instead of revealing under the loader at high concurrency.
   *  Clamped to ≥1. */
  concurrency?: number
  /** Called once every mesh is back. */
  onDone?: () => void
  /** Called after each pipeline-group reveals (compile path only), with the
   *  groups done so far / total. Lets a long warm drive a visible counter —
   *  Mexico City holds the intro loader ~14 s across ~140 groups, and a
   *  static message reads as a hang. */
  onProgress?: (done: number, total: number) => void
}

export type ProgressiveWarm = {
  /** How many meshes were deferred. */
  readonly count: number
  /**
   * Reveal the deferred meshes. With `compile`, each mesh is asynchronously
   * pre-compiled (pipelines + textures) and revealed only once ready; without
   * it, meshes are revealed `perFrame` at a time via requestAnimationFrame and
   * the live render loop compiles each on first sight. Calls `onDone` once
   * every mesh is back. Falls back to an immediate reveal where
   * requestAnimationFrame isn't available (jsdom / SSR).
   */
  reveal(opts?: RevealOptions): void
}

type Raf = (cb: (t: number) => void) => unknown

/**
 * Hide `meshes` immediately (so the boot warm skips them) and return a handle
 * that reveals them progressively. Pass the static scenery only — movers
 * (bikes/riders) must stay visible so the grid is solid from the first frame.
 */
export function deferSceneryWarm(meshes: THREE.Mesh[]): ProgressiveWarm {
  for (const m of meshes) m.visible = false
  return {
    count: meshes.length,
    reveal(opts: RevealOptions = {}) {
      const { perFrame = 2, compile, concurrency = 1, onDone, onProgress } = opts
      const raf: Raf | null =
        typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null
      if (!raf) {
        for (const m of meshes) m.visible = true
        onDone?.()
        return
      }
      if (compile) {
        void revealCompiled(meshes, compile, raf, onDone, concurrency, onProgress)
        return
      }
      let i = 0
      const step = (): void => {
        for (let k = 0; k < perFrame && i < meshes.length; k++, i++) {
          const m = meshes[i]
          if (m) m.visible = true
        }
        if (i < meshes.length) raf(step)
        else onDone?.()
      }
      raf(step)
    },
  }
}

/**
 * Collect the painterly-vinyl meshes under the given roots (the track's
 * buildings/set-pieces + the scatter-prop group) — the scenery whose shader
 * compile we defer. Identified by the `mat_vinyl*` material name the vinyl pass
 * stamps, so terrain (`mat_terrain`), foliage (`mat_foliage`), lava, water, and
 * the gates/horizon (separate roots) are left essential. Movers live under their
 * own roots and are never passed in.
 */
export function collectVinylScenery(roots: Array<THREE.Object3D | undefined | null>): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  for (const root of roots) {
    if (!root) continue
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const mat = mesh.material
      const name = Array.isArray(mat) ? mat[0]?.name : (mat as THREE.Material | null)?.name
      if (typeof name === 'string' && name.startsWith('mat_vinyl')) out.push(mesh)
    })
  }
  return out
}

/**
 * Group meshes that share GPU pipelines: same material instance(s) + same
 * vertex-attribute layout + same object class (instanced / skinned / plain) +
 * indexed-ness — the inputs three's pipeline + node-builder cache keys derive
 * from. One compile of the group's lead mesh warms every member, so a dressed
 * track's hundreds of scenery meshes collapse to ~one compile per distinct
 * vinyl material (Mexico City: 477 meshes → ~155 groups) and a whole family
 * (a landmark's detail set, a prop run) pops in together instead of
 * trickling. Anything that would change the pipeline key splits the group.
 */
function groupForWarm(meshes: THREE.Mesh[]): THREE.Mesh[][] {
  const byKey = new Map<string, THREE.Mesh[]>()
  for (const m of meshes) {
    const mat = m.material
    const matId = Array.isArray(mat) ? mat.map((x) => x?.uuid ?? '?').join('+') : (mat?.uuid ?? '?')
    const geom = m.geometry
    const attrs = Object.keys(geom.attributes).sort().join(',')
    const cls = (m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh
      ? 'i'
      : (m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh
        ? 's'
        : 'm'
    const key = `${matId}|${attrs}|${geom.index ? 1 : 0}|${cls}`
    const g = byKey.get(key)
    if (g) g.push(m)
    else byKey.set(key, [m])
  }
  return [...byKey.values()]
}

/**
 * Warm-then-reveal, `concurrency` pipeline-groups per frame (default 1). For
 * each group's lead mesh the synchronous window around `compile()` flips
 * `visible` on (and `frustumCulled` off — the compile-path frustum is stale, and
 * a culled mesh would silently compile nothing, deferring the real compile to
 * whenever the racing camera first swings past it): `renderer.compileAsync`'s
 * synchronous prologue is what snapshots the render list, so the flags can be
 * restored before awaiting and no rAF frame ever renders the mesh uncompiled —
 * and because the snapshot is taken per lead while only that lead is visible,
 * several leads can be kicked off in one frame and awaited together without
 * cross-contaminating each other's render list. Once a group's lead pipelines
 * (and the shared material's textures) are resident, the whole group reveals
 * together. If a compile fails, the group is revealed anyway — first sight then
 * pays its own compile cost, exactly the pre-warm-less behavior, correctness
 * over smoothness.
 */
async function revealCompiled(
  meshes: THREE.Mesh[],
  compile: SubtreeCompiler,
  raf: Raf,
  onDone?: () => void,
  concurrency = 1,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const nextFrame = (): Promise<void> => new Promise((resolve) => raf(() => resolve()))
  const CONC = Math.max(1, Math.floor(concurrency))
  const groups = groupForWarm(meshes)
  // The warm's wall-clock scales with the group count (~one pipeline compile
  // per group) — surface it next to deferredScenery/vinylMaterials so a boot
  // trace shows whether a content change actually collapsed groups.
  bootStat('warmGroups', groups.length)
  let groupsDone = 0
  for (let i = 0; i < groups.length; i += CONC) {
    const batch = groups.slice(i, i + CONC)
    const pending: Array<{ group: THREE.Mesh[]; compiled: Promise<void> | null }> = []
    for (const group of batch) {
      const lead = group[0]
      if (!lead) continue
      let compiled: Promise<void> | null = null
      const cull = lead.frustumCulled
      lead.visible = true
      lead.frustumCulled = false
      try {
        compiled = compile(lead)
      } catch {
        compiled = null
      } finally {
        lead.visible = false
        lead.frustumCulled = cull
      }
      pending.push({ group, compiled })
    }
    for (const { group, compiled } of pending) {
      if (compiled) {
        try {
          await compiled
        } catch {
          /* best-effort — reveal below; first sight pays its own compile */
        }
      }
      for (const m of group) m.visible = true
      groupsDone++
      onProgress?.(groupsDone, groups.length)
    }
    // One batch per frame: spreads the members' first-sight bind-group +
    // geometry-upload work instead of bursting every group into one frame.
    await nextFrame()
  }
  onDone?.()
}
