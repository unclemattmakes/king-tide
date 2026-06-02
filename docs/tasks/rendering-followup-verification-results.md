# Results: Local WebGPU verification + profiler-gated render follow-ups

Companion to [rendering-followup-local-verification.md](rendering-followup-local-verification.md).
This records the in-browser verification (Part A) and the profiler run (Part B)
that the cloud session which shipped PR #260 could not do (no WebGPU).

**Status of #260:** merged to `main` (commit `0754bf5`) before this verification
ran, so this is a **stacked follow-up**, not a flip of the original draft. The
three shipped changes are confirmed working on real WebGPU hardware below.

## Environment

- **GPU:** NVIDIA Blackwell (RTX 5050), Windows 11.
- **Backend:** `[render] backend: webgpu` confirmed; adapter
  `vendor=nvidia architecture=blackwell`. `timestamp-query` present (the
  profiler's `?gpuprofile=1` armed without the "unavailable" warning).
- **How:** headed Playwright Chromium against `pnpm dev` (port 5191). Headed =
  real GPU (per `playwright.config.ts`), and Playwright's default launch flags
  disable background-tab throttling, so the rAF race loop runs full-speed.
  Harness: [`tools/profile-tracks.mjs`](../../tools/profile-tracks.mjs),
  [`tools/capture-sway.mjs`](../../tools/capture-sway.mjs),
  [`tools/capture-outline-ab.mjs`](../../tools/capture-outline-ab.mjs),
  [`tools/capture-postfx.mjs`](../../tools/capture-postfx.mjs).

> **Gotcha worth recording:** a Chrome MCP / DevTools tab that is *hidden* gets
> rAF-throttled to ~1 fps (`document.visibilityState === 'hidden'`), which
> freezes the race clock and makes every GPU/CPU number meaningless. The
> headed-Playwright harness sidesteps it. Don't profile from a background tab.

## Part A — shipped changes verified

### 1. Foliage sway (TSL positionNode) — ✅ FIXED, with a characterized limit

- **The P0 bug is fixed.** On sandbar, **all 24 foliage meshes**
  (`mat_foliage_palm`, `mat_foliage_palm_trunk`) are converted to
  `MeshStandardNodeMaterial` carrying the sway `positionNode` + `NODE_SWAYED`
  marker. Before this change they were plain `MeshStandardMaterial` patched
  only via `onBeforeCompile` — a WebGL2 no-op — so they sat dead-still for
  every WebGPU user. Now they move.
- **Motion confirmed visually.** Idle bike, fixed camera, wind uniform toggled
  0 → 28 via the live module: the same palm cluster's fronds go from upright to
  violently streaked along the wind vector. Wind/clock are live (`updateWind`
  applied 0.18 default; sway clock advances with the wave field at 60 fps).
  Screenshots: `sway-0-rigid.png` vs `sway-1-bent-*.png`.
- **Known limit — lockstep (the doc's decision point), re-characterized.** The
  palms' `COLOR_0.b` phase channel is **0 across all palm geometry**, and the
  12 frond meshes **share one geometry datablock**. So every palm sways at the
  identical phase → perfect lockstep. Two refinements to the task's framing:
  - It is **not** the dropped per-instance `instanceMatrix` hash (the
    `TODO` in `foliage-sway.ts`): sandbar's palms are **separate meshes, not an
    `InstancedMesh`** (`instancedFoliage: 0`). Even the WebGL2 path would show
    lockstep here, because `COLOR_0.b` is unpopulated.
  - **Verdict:** at the shipped wind (strength `0.18`, very gentle) the sway is
    subtle and the lockstep reads as a soft synchronized breeze — **acceptable
    for v1.** The cheap, correct fix is a **per-mesh phase** seeded from each
    palm's world position in `applyFoliageSwayToMesh` (these are distinct
    meshes, so no instance-matrix accessor is needed) — and, upstream, the
    Blender foliage builder should stamp a non-zero `COLOR_0.b`. Filed as a
    follow-up, not done here (keeps this PR to verification + tooling).
  - **RESOLVED (follow-up).** The lockstep is fixed in `foliage-sway.ts`:
    `applyFoliageSwayToMesh` now hashes a per-mesh phase from the mesh's world
    position (`swayPhaseFromPosition`) and threads it through both the TSL and
    WebGL2 paths; `InstancedMesh` foliage additionally gets a per-instance
    phase (`instanceIndex` hash) — closing the old `TODO`. Upstream, the palm
    builder (`build_palm_mesh`) now stamps a per-frond `COLOR_0.b` so the
    phase data exists in the GLB (needs a props-library re-seed + re-export to
    land in shipped GLBs; the runtime hash is the fallback that fixes the
    *current* GLBs with no re-export). Verified on real WebGPU: the live phase
    registry (`debugSwayMeshes`) reports **12/12 distinct phases** across
    sandbar's 12 palm meshes, and `tools/capture-sway-desync.mjs` frames the
    closest pair bending at visibly different phases.

### 2. GPU-time profiler (`?gpuprofile=1`) — ✅ VERIFIED

- Top-left overlay reads `GPU render: X.XX ms / compute: 0.00 ms` with real
  timings; `window.__gpuProfile` reads in console
  (`{renderMs, computeMs, lastRenderMs, samples}`).
- Silent no-op without the flag and on `?backend=webgl2` (feature-gated in
  `renderer.ts`; logs the "unavailable" warning when asked but unsupported).

### 3. Post FX (cel/ink outline + motion blur, default-off) — ✅ VERIFIED

- **Default-off identity holds.** With both effects off the graph is
  `scenePassColor.add(bloom)` with no velocity MRT (by construction; every
  default capture renders as today's bloom-only look).
- **Opt-in outline** (`sky.outline`): full-scene Sobel ink reads cleanly on the
  bike silhouette, terrain folds, and waterline; scales with `strength`
  (`outline-OFF/ON/STRONG.png`). Tasteful at the default `0.85` — matches the
  "light ink/edge darkening (cel-adjacent)" art direction, not a heavy black
  outline. No black/broken frames.
- **Opt-in motion blur** (`sky.motionBlur`): velocity MRT wires correctly; a
  subtle directional smear at speed, and the **HUD stays crisp** (it's a DOM
  overlay, outside the render pass). No black/broken frames.
- **Cost:** both effects on added ~no GPU time (within sample noise of the
  bloom-only baseline).
- **Tuning note:** Sobel is a screen-space edge pass, so temporal shimmer on
  high-frequency edges at 40 m/s is the thing to watch in motion (stills can't
  show it). MSAA-on input helps. If it crawls, gate the ink by distance or tie
  `threshold` to speed. **Picking 1–2 tracks to ship it on is an art call** —
  left to Matt; not baked into any track JSON here.

## Part B — 8-bike profile (1080p, WebGPU, real GPU)

Full grid (player + 7 AI), autopilot, ~8 s sample after settle. `render` = GPU
profiler rolling avg; `fps`/`p95` = CPU frame recorder; `calls` =
`renderer.info.render.calls` (added via a new `__hover.perf.renderInfo()`).

| Track | GPU render | CPU fps | p95 | Draw calls | Tris | meshes | inst. |
|---|---|---|---|---|---|---|---|
| sandbar | **2.7 ms** | 67 | 22 ms | 18,379 | 4.0M | 315 | 93 |
| the-maw | **3.4 ms** | 80 | 17 ms | 21,211 | 4.1M | 197 | 802 |
| liberty-drowned | **2.1 ms** | 83 | 17 ms | 22,443 | 3.2M | 436 | 0 |
| kilauea-crown | **3.2 ms** | 78 | 17 ms | 21,979 | 3.9M | 195 | 442 |
| the-maw `?aa=off` | **1.3 ms** | 89 | 17 ms | 24,587 | 4.1M | 197 | 802 |

### What the numbers say

1. **Not GPU-bound — anywhere.** GPU render is **1.3–3.4 ms** across every
   track, far under the 16.6 ms (60 fps) budget. So the **GPU-side P2 items are
   not justified by the data**: octahedral impostors (a fill/vertex-bound fix)
   and GPU-compute culling target a bottleneck we don't have. **Do not build
   them** on current evidence.

2. **MSAA is the single biggest GPU line item.** the-maw `3.4 → 1.3 ms` with
   `?aa=off` ⇒ **MSAA 4× costs ~2.1 ms** (~60% of the GPU frame). This is the
   concrete payoff behind the **P1 TRAA / post-AA** idea: moving AA into the
   post graph reclaims ~2 ms *and* unblocks simultaneous planar reflections
   (today it's MSAA **or** reflections). It's a quality/feature unlock, low
   urgency since we're not GPU-bound.

3. **Draw calls are 18–24k — ~6× the tech review's ~3,273 assumption.** This
   count is build-independent and consistent. Caveats before acting on it:
   - It is a **per-frame total across all passes** the pipeline submits (scene,
     shadow map, planar water reflection, bloom mips) **plus** any active
     particle sprites — not 22k *track props*. Per-pass attribution was **not
     isolated** (the FX/particle pools don't expose active counts in the shape
     probed). **That attribution is the required next step before any
     `BatchedMesh` work** — exactly the "don't implement blind" gate.
   - On *this* (high-end) GPU + a **dev build**, all tracks hold ≥60 fps even
     unoptimized, so there is no present CPU emergency here. The tech review's
     concern is **target-class (M1 / Ryzen 5000)** hardware, which I can't
     measure on this machine.

### Recommendation (the P2 gate, answered by data)

- **Skip** octahedral impostors and GPU-compute culling for now — not
  GPU-bound. Re-evaluate only if a future fill/vertex-bound track appears.
- **Before any `BatchedMesh` investment:** (a) attribute the 18–24k draw calls
  by pass + particles, and (b) re-profile on a **production build**
  (`pnpm build` + `preview`) and ideally a **target-class GPU**, because dev-build
  CPU numbers (and a Blackwell GPU) overstate our headroom. `BatchedMesh` /
  instance-merging is the right lever *if* that profile shows draw-submission
  CPU as the bottleneck — but it's not yet justified blind.
- **Highest-value next render item is P1 TRAA/post-AA** (reclaims the measured
  ~2 ms MSAA cost and unblocks reflections), not a P2 perf item.

## Tooling added

- `__hover.perf.renderInfo()` (`src/debug.ts`, wired in `src/boot/game-loop.ts`)
  — on-demand `renderer.info` snapshot (draw calls / triangles / geometries /
  textures), dev-gated like the rest of `__hover`. The draw-call question can't
  be answered without it; pairs with `window.__gpuProfile`.
- `tools/profile-tracks.mjs` — the reusable 8-bike perf harness the tech review
  called for (the "8-bike perf-budget pass" was listed as still pending).
  Plus `tools/capture-{sway,postfx,outline-ab}.mjs` for re-running the Part A
  visuals.

## Pre-existing CI state (NOT introduced by this work)

Verified by stashing this branch's changes and re-running against pristine
`0754bf5`:

- `pnpm typecheck` — **clean.**
- `pnpm lint` — 3 **pre-existing** biome *format* errors in untouched files
  (`specs/props/ai/sandbar.json`, `specs/props/ai/the-maw.json`,
  `tests/unit/replay-state-reconstructor.test.ts`), plus a `$schema`
  version-drift INFO (`biome.json` pins `2.4.15`; package/lockfile install
  `2.4.16`). My changed files are lint-clean. Left untouched — out of scope.
- `pnpm test` — **923/924 pass.** The 1 failure (`bike-loader.test.ts`,
  `racer.glb` missing `mat_bike_racer_fork`) is a **pre-existing** bike-asset
  contract drift, unrelated to these changes.
