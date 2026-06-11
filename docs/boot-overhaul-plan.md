# Boot overhaul — diagnosis + results (2026-06-10)

> Diagnosis, what landed, measured outcomes, and the named follow-ups for the
> 2026-06-10 loading-process overhaul. Measurements: headed Playwright on this
> machine (RTX 5050, WebGPU, warm dev server) via
> `tests/e2e/boot-timing.spec.ts` + `tests/e2e/menu-boot-timing.spec.ts`.

## What had regressed (June 8 → June 10)

The June-8 prewarm work measured **sandbar race boot at 4,246 ms** (prewarm
2,000 ms, 51 vinyl materials). Two days later the same boot measured
**8,093 ms**, and the fresh-load (menu) path froze long enough to read as a
crash. Causes, ranked:

1. **The "prewarm" was one synchronous render.** With the bloom post-pipeline
   active (default — the sky installs it), the pre-warm called
   `PostPipeline.compileAsync()`, which is one eager **synchronous**
   `pipeline.render()`: every pipeline in the essential set was created with
   blocking `createRenderPipeline` in a single 4.6–5.3 s main-thread stall.
   The loading screen could not repaint (its sweep bar animated `left`, a
   main-thread layout property — frozen too) and input was dead.

2. **The water shader grew ~2,900 lines in two days** (PRs #346–#366), with
   event layers JS-unrolled into the TSL graph: wake-trail capsule scans ×8
   in BOTH vertex and fragment stages (14-segment inner loop each), contact
   collars ×24, splash rings ×12, wave stamps ×8 twice. This roughly doubled
   the per-pipeline compile cost of the biggest pipeline in the game.

3. **The fresh-load menu path compiled a second full scene with no warm at
   all** — and worse, the cold-boot menu AWAITED the attract-mode import
   (the entire game module graph: three.js + every render/sim system) before
   even hiding the loading screen. Measured: menu responsive at **7.65 s**,
   attract backdrop at 12.2 s, main thread frozen **11.1 s of the first
   12 s** (worst single task 6,988 ms). On cold caches, far worse.

4. **Mexico City shipped heavy** (78 boot-path vinyl materials, 477 deferred
   scenery meshes) the same day the Reef Cup was ungated, stretching every
   per-material cost ~1.7× over sandbar.

## What landed

- **Entry split** ([main.ts](../src/main.ts) → thin shell;
  [race-boot.ts](../src/boot/race-boot.ts) dynamic): the menu path no longer
  evaluates the game graph at all before painting. Race path pays the same
  bytes behind the loading screen.
- **Menu-first attract ordering + staged import**
  ([url-modes.ts](../src/boot/url-modes.ts)): loading screen drops after the
  manifest; attract imports fire-and-forget 250 ms later, staged
  (`three` → `three/webgpu` → `three/tsl` → attract) with frame yields so
  warm-cache eval lands as bounded tasks, not one blob.
- **Chunked attract warm** ([attract-mode.ts](../src/boot/attract-mode.ts)):
  attract's scenery is deferred like the race boot's, movers get one system
  tick, then scene roots reveal a few at a time with an eager render after
  each — bounded ~1 s compile chunks with real rAF gaps, behind the menu's
  backdrop. The deferred scenery streams back via the progressive-warm
  compile hook once the pipeline state is real.
- **Split race-boot warm** ([race-boot.ts](../src/boot/race-boot.ts)): an
  early eager render right after the sky exists (terrain + env + water + sky
  — the heavyweights, ~1.5 s) and the final pre-warm render for movers
  (~2.3 s) — two shorter stalls with the loading screen repainting between,
  instead of one 4.6–5.3 s freeze. Env/prop scenery is hidden the moment its
  root loads so neither warm compiles it.
- **Water shader code diet** ([water.ts](../src/engine/render/water.ts)):
  the unrolled event loops became dynamic TSL `Loop`s (uniform-bounded where
  a live count exists). One emitted body per stage instead of 8–24 copies;
  per-slot math unchanged (verified: wake-look / contact-look / foam-sweep
  captures + instanced-bikes + determinism-suite green).
- **Boot DAG parallelization** ([race-boot.ts](../src/boot/race-boot.ts)):
  renderer ∥ Rapier WASM; manifest / bike GLBs / rider rig / gate prop
  fetches kick at the top of boot; track JSON + environment GLB (8–20 MB)
  prefetch warms the HTTP cache — overlaps the whole subsystem init on
  deployed builds.
- **Teardown-aware menu→race handoff** ([url-modes.ts](../src/boot/url-modes.ts)):
  attract is disposed (bounded 1.5 s wait) + 200 ms grace BEFORE
  `location.assign`. Navigating over a live WebGPU page's teardown contends
  in the same renderer process — measured as a multi-second main-thread blob
  at the start of the next page.
- **Compositor-driven loading bar** ([index.html](../index.html)): the sweep
  now animates `transform` (compositor thread) instead of `left` (main
  thread), so it keeps moving through any remaining stall — "loading", not
  "crashed".

## Measured outcomes (same machine, warm dev server)

Fresh-load menu path (`menu-boot-timing.spec.ts`, median of 3):

| Metric | Before | After |
|---|---|---|
| Menu interactive | 7,650 ms | **173 ms** |
| Attract backdrop live | 12,162 ms | **6,730 ms** |
| Worst main-thread stall | 6,988 ms | **1,018 ms** |
| Total frozen (first 12 s) | 11,097 ms | **2,819 ms** |

Race boot (`boot-timing.spec.ts`, median of 3). Note the trace boundary
moved: post-split totals INCLUDE the race-boot module evaluation
(~0.6–0.9 s) that previously ran before tracing started, and spec runs
reload over a live race page (teardown contention — see below):

| Track | Before | After (spec median) | After (clean nav probe) |
|---|---|---|---|
| sandbar | 8,093 ms | 8,590 ms¹ | ~7.3–7.6 s + eval |
| mexico-city | 8,253 ms | **6,331 ms** | ~6.7 s |

¹ sandbar's spec median is dominated by run-to-run reload contention
(9.0 / 8.6 / 7.4 s); wall-clock to READY on a clean navigation improved
~1.7 s.

## What we learned (read before touching this again)

- **The boot floor is per-pipeline cost × pipeline count on the main
  thread** (~60–90 ms per vinyl material via the batch render path), NOT
  shader size: the water code diet cut the biggest single pipeline but only
  ~0.4 s of prewarm. Orchestration cannot remove this floor — count can.
- **An eager `pipeline.render()` is the only correct warm for the water
  material.** Compiling it via `compileAsync`/`compileSubtreeAsync` mid-boot
  keys its scene-depth/MSAA-coupled pipelines wrong (`water:sceneDepth`
  sample-count mismatch → invalid bind groups → broken frames) AND the async
  subtree path costs ~3× more per material anyway. `compileSubtreeAsync` is
  only valid after a real render (the progressive scenery warm satisfies
  this; a hidden-scene "prime" does NOT).
- **Reloading over a live WebGPU page produces a multi-second main-thread
  blob in the NEXT page** (device/buffer teardown contention, same renderer
  process). It contaminates boot measurements — measure with a blank-gap
  navigation (the menu spec does this now) — and it is why the menu→race
  handoff disposes attract before navigating.

## Follow-ups (not in this pass)

- **Vinyl structural sharing — the next big wall-time lever.** ~40+ of the
  45–78 boot compiles are painterly-vinyl materials whose graphs differ only
  by baked constants (objectScale / weathering / edgeWear / colors).
  Extending the #345/#365 instance-sharing direction (params as uniforms or
  quantized shared instances) collapses pipeline count — the thing the boot
  floor is made of. Same lever shrinks Mexico City's 477-mesh scenery stream
  and attract's compile bill.
- **Track-loader phase split**: fetch track JSON first, build sky + water +
  start the early warm BEFORE the env GLB parse, so the heavy compile
  overlaps the 8–20 MB fetch + parse (mostly a deployed-build win — local
  fetch is free).
- **Single-boot menu→race handoff** (no page reload; reuse device, WASM,
  GLBs, compiled pipelines). Biggest remaining structural win; large
  `race-boot.ts` refactor.
- Mexico City content diet (material count / prop merging) — content work.
- fps tuning of the June-10 water layers — playtest territory
  (see perf-report/ for the 8-bike numbers).
