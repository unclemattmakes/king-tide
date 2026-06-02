# Task: Local WebGPU verification + profiler-gated render follow-ups

**Status:** open · **Depends on:** PR #260 (rendering tech review +
WebGPU/TSL improvements) · **Scope:** in-browser verification, then
data-gated perf work · **Est:** medium · **Requires:** a machine with a
**real WebGPU GPU** (this is the whole point — the work below could not be
done in the cloud container that opened PR #260).

## Why this hands off to a local agent

PR #260 landed three render changes plus a review doc, all typecheck/lint/
unit-test green. But the cloud session that wrote them **has no WebGPU**, so
none of the *visual* / GPU-timing behaviour could be confirmed — only that
the node graphs construct. A local Claude Code session with a GPU picks up
here: verify the shaders actually look right, capture profiler numbers, then
let those numbers decide the P2 work.

## Setup

```bash
git fetch origin claude/game-rendering-research-KCgyx
git checkout claude/game-rendering-research-KCgyx
git lfs install && git lfs pull   # cloud container skipped this — real GLB bytes needed
pnpm install
pnpm dev                          # vite dev server; open in a WebGPU browser (Chrome/Edge/Safari 26+)
```

Confirm the backend pill / console says `[render] backend: webgpu`. If it says
`webgl2`, the checks below still run (TSL compiles to GLSL) but you're not
testing the primary path — check `chrome://gpu` / enable WebGPU.

Develop on **your own feature branch** off `claude/game-rendering-research-KCgyx`.
Do **not** push to that branch directly.

## What already shipped in #260 — do NOT rebuild

- **Foliage sway TSL port** — `src/engine/render/foliage-sway.ts`
  (`applyFoliageSwayToMesh`, `buildSwayPositionNode`, `toSwayNodeMaterial`)
  \+ caller in `src/engine/render/glb-track.ts`. Converts `mat_foliage_*`
  materials to `MeshStandardNodeMaterial` with a TSL `positionNode`.
- **GPU-time profiler** — `src/engine/render/gpu-profiler.ts`, wired via
  `renderer.ts` (`trackTimestamp`, `gpuTimestampsTracked`) → `main.ts` →
  `game-loop.ts` (`gpuProfiler.tick()` after `renderFrame`). Flag
  `?gpuprofile=1`.
- **Post FX** — `src/engine/render/post-pipeline.ts` cel/ink outline (Sobel)
  \+ motion blur (velocity MRT), both **default-off**, threaded through
  `SkyConfig.outline` / `.motionBlur` (`src/game/tracks/types.ts`, `sky.ts`).

Full context: [docs/rendering-tech-review.md](../rendering-tech-review.md).

## Part A — verify the shipped changes (in-browser, WebGPU)

1. **Foliage sway.** Load a track with `mat_foliage_*` props (palms/banners —
   e.g. a beach/sandbar track). Confirm foliage now *sways* under WebGPU (it
   was previously dead-still). Check that scattered instanced palms don't all
   sway in lockstep — and note the known limitation: the TSL path uses
   per-vertex `COLOR_0.b` phase only (per-instance `instanceMatrix` desync was
   dropped; see the `TODO` in `foliage-sway.ts`). **Decision point:** is the
   per-vertex desync visually acceptable, or worth implementing a per-instance
   phase via a TSL instance-matrix accessor? If yes, that's a sub-task.

2. **GPU profiler.** Run `pnpm dev` with `?gpuprofile=1`. Confirm the top-left
   overlay shows `GPU render: X.XX ms` (and that `window.__gpuProfile` reads
   in the console). Verify it's a silent no-op without the flag and on WebGL2
   (`?backend=webgl2`).

3. **Post FX (default-off).** Confirm a normal track looks **identical** to
   `main` (bloom only) — the graph must be unchanged when both effects are off.
   Then enable per-track in a track's JSON sky block:
   ```json
   "sky": { "outline": { "enabled": true, "strength": 0.85 },
            "motionBlur": { "enabled": true, "samples": 16 } }
   ```
   Verify the cel/ink line reads at race speed (40 m/s) without shimmering,
   and that motion blur conveys speed without smearing the HUD. Tune defaults
   to taste and, if good, pick 1–2 tracks where art wants them on.

> If any effect renders black/broken, suspect the PassNode RT pre-warm (see
> the `compileAsync` comment in `post-pipeline.ts`) or the velocity MRT wiring;
> capture the console + a screenshot in the PR.

## Part B — profiler-gated perf work (only after Part A gives numbers)

Profile an **8-bike, wave-heavy** track at 1080p on the target-class GPU
(M1 / Ryzen 5000) using `?gpuprofile=1`. Record render-pass ms and where time
goes. Then, and only then, pick from the P2 roadmap in
[rendering-tech-review.md](../rendering-tech-review.md):

- **`BatchedMesh` + GPU-driven culling** — only if draw-call/CPU-bound at the
  ~3,273 instances/track scale. Consider `InstancedMesh2` (BVH cull + LOD) as
  the lower-effort middle ground before hand-rolled compute culling.
- **Octahedral impostors** for distant landmarks — if fill/vertex-bound on
  far skylines.

Don't implement these blind — the doc explicitly gates them on this data.

## Done criteria

- Part A checklist confirmed in-browser (screenshots in the PR), defaults tuned.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green; relevant `pnpm e2e` if you
  touch UI.
- Any Part B work justified by captured profiler numbers, posted in the PR.
- Update PR #260 (or a stacked PR) and flip it out of draft once verified.
</content>
