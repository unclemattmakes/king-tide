# Performance Audit — May 2026

A second pass over the runtime hot paths, picking up where
[`code-review-2026-05.md`](./code-review-2026-05.md)'s perf section left
off. PR #39 already landed the obvious sim-side wins (`distanceSquared`,
`*_SQ` constants, cached bike query, spline-query caching, mesh entity
pool). PR #40 landed lazy debug menus. This audit focuses on what's still
costing frame time today, with verified `file:line` citations and an
explicit "what's actually slow vs. what looks slow but isn't" split.

> Findings come from static reading of the worktree at branch
> `claude/practical-beaver-30361e` against `main` (HEAD: A9 FFT complete).
> Numbers labelled "est." are educated guesses based on code shape;
> "verified" means I traced the call path. Anyone landing fixes should
> measure first with the browser profiler — the gap between estimate and
> reality on WebGPU is sometimes 5× either way.

## TL;DR

The top three runtime costs, in order:

1. **Minimap canvas redraw + DOM thrash in the race HUD** — full canvas
   2D clear+redraw and 4+ `textContent` writes every rAF, regardless of
   whether anything changed. The single biggest easy win.
2. **GPU FFT dispatch overhead** — ~68 compute dispatches per cascade
   per frame at N=128. Submission cost dominates the actual GPU work.
   Real, structural, and already called out in the file's own comment
   (`gpu-bake-fft.ts:73-81`).
3. **Per-tick allocations in the sim hot path** — `new phys.rapier.Ray`
   in `hover.ts:73` runs 5× per bike per tick (~1500 alloc/sec at 5
   bikes × 60 Hz). Compounded by smaller per-frame allocations in render
   systems.

Boot-time costs (terrain shader first-compile, bike GLB clone) are real
but one-shot — only worth chasing if startup hitch becomes a complaint.

## Method note

The Explore agent's first pass over-claimed two items that I want to
flag so they don't end up in a future review:

- **`cloud-shadows.ts:184` `needsUpdate = true` is NOT per-frame.** It's
  called inside `applyCloudShadowsToScene`, a one-shot scene walk guarded
  by `userData.__cloudShadowApplied`. Verified at
  `src/engine/render/cloud-shadows.ts:172-186`.
- **`sky.ts` PMREM env-map bake is NOT per-frame.** The 4-second rebake
  was removed when the sun was frozen; bake now runs once in
  `applyStaticState`. Verified at `src/engine/render/sky.ts:504-520`.
- **`foliage-sway.ts` `updateWind`/`updateSwayTime` are never called —
  but it's intentional scaffolding, not dead code.** Grep across `src/`
  shows zero call sites, but the module is referenced from
  `vertex-attribute-spec.md`, `blender-wishlist.md`, `status.md`, and
  `blender-pipeline-guide.md` as the future hook point for foliage
  authored in Blender (item 6 in the wishlist). The `onBeforeCompile`
  patch carries no runtime cost when no material calls
  `applyFoliageSway()`, which today is none of them — so the "perf
  win" of removing it is zero. Leaving in place; if the Blender path
  lands, this is where the wiring goes.

---

## 1. Definitely slow (fix first)

### 1.1 Minimap full canvas redraw every rAF

- **Where:** [src/engine/render/race-hud.ts:301](src/engine/render/race-hud.ts:301)
  (`drawMinimap` called unconditionally from `tick`).
- **What:** Every rAF, the minimap clears the entire canvas, redraws the
  background fill + border, walks every point on the AI spline as a
  stroked polyline (two passes — thick ribbon + inner stripe), redraws
  the checkpoint marker + next-checkpoint highlight, then sorts and
  draws every bike dot. The spline never moves; checkpoints never move;
  only bike dots and the "next CP" highlight change between frames.
- **Why slow:** Canvas 2D `stroke()` on a long polyline is the costliest
  operation — every segment costs a path-segment + AA rasterization.
  Splines are typically 100–400 points, drawn twice. On low-end devices
  this is a real fraction of the budget.
- **Cost:** est. 1–3 ms/frame on integrated GPU laptops; less on a
  discrete GPU. Multiply by 60 → 60–180 ms/sec spent redrawing a static
  background.
- **Fix:** Bake the static layers (background + spline + start gate
  marker) into an offscreen canvas once at HUD construction. Each
  frame: `drawImage()` the cache, then draw only the dynamic overlay
  (player next-CP ring + bike dots). The spline polyline becomes a
  single bitmap blit, ~50 μs.

### 1.2 HUD text writes + string allocations every rAF

- **Where:** [src/engine/render/race-hud.ts:274-283](src/engine/render/race-hud.ts:274)
  (`tick` function, "Timer card" block).
- **What:** Five DOM `textContent` writes per frame regardless of
  change: race time, lap time, lap label, position, lap-extra. Each
  `formatTime()` call allocates a fresh string; `parts.push` + `parts.join(' · ')`
  allocate an array + string every frame.
- **Why slow:** DOM writes are cheap individually but force layout
  invalidation on the timer card. Combined with the minimap canvas
  redraw above, the HUD is doing real per-frame work even when nothing
  visible has changed (e.g. paused / between gate crossings).
- **Cost:** est. 0.2–0.5 ms/frame DOM + GC pressure from 4–6 small
  string allocations.
- **Fix:** Cache last-rendered values; only write when changed. Most
  race-time changes will still update every frame (race time advances
  monotonically) but lap label, position, and lap-extra change rarely.

### 1.3 Bike dot list shallow-cloned + sorted every frame

- **Where:** [src/engine/render/race-hud.ts:370](src/engine/render/race-hud.ts:370)
  (`const sorted = [...input.bikes].sort(...)`).
- **What:** A spread copy and re-sort of the bike-dots array on every
  HUD tick to get z-ordering right (opponents → leader → player on top).
- **Cost:** Allocation per frame; sort is O(n log n) but n ≤ 8 today.
  Trivial today; trap waiting if/when grid sizes grow.
- **Fix:** Sort once when the dot pool is populated in
  [src/boot/game-loop.ts:474-484](src/boot/game-loop.ts:474), or do three
  passes (non-player non-leader, leader, player) without a sort.

### 1.4 GPU FFT dispatch overhead

- **Where:** [src/engine/render/ocean-fft/gpu-bake-fft.ts:73-81](src/engine/render/ocean-fft/gpu-bake-fft.ts:73)
  (called per frame from the water tick).
- **What:** At N=128 with batched 8-into-4 packing, the IFFT pipeline
  runs ~17 dispatches × 4 cascades = **~68 compute dispatches per frame**.
  The file's own status comment estimates ~10 μs submission cost per
  dispatch → ~0.7 ms/frame on CPU just feeding command buffers.
- **Why slow:** Each WebGPU `computePass.dispatchWorkgroups()` carries
  fixed CPU overhead from binding, pipeline state, and command-buffer
  encoding that doesn't scale down with kernel size. The actual GPU
  work is fast; the CPU is the bottleneck.
- **Cost:** ~0.6–0.8 ms/frame verified by the file's own comment.
  Scales with refresh rate — 120 Hz displays pay 2× per second.
- **Fix options, easiest first:**
  - Drop default N from 128 → 64 (2× fewer dispatches, ~halves cost,
    surface detail drop is hard to spot at typical camera distance).
    Gate behind a `?fft=hi` query for the prettier version.
  - Fuse adjacent butterfly stages into a single workgroup-shared
    kernel — collapse 17 → 5 dispatches per IFFT (radix-8 instead of
    radix-2). Significant rewrite of `fft-tsl.ts`.
  - Move the FFT to a worker / `requestIdleCallback` and accept one
    frame of latency on the water surface (probably not visible at
    racing speed).

### 1.5 `new phys.rapier.Ray` per probe per bike per tick

- **Where:** [src/game/systems/hover.ts:73](src/game/systems/hover.ts:73)
  (`probeSurface`, called once for the center probe and 4× per bike
  for the footprint probes from elsewhere in the same file).
- **What:** Every hover probe constructs a fresh `Ray({...}, {...})`.
  Rapier WASM bindings allocate a wrapper object on each call.
- **Cost:** ~5 rays × 5 bikes × 60 Hz = **1500 Ray allocations/sec**
  in steady-state racing. Each is a small WASM-bound object — exact
  GC cost is hard to estimate without measuring but it's the biggest
  per-tick alloc source in the sim layer.
- **Fix:** Hoist two reusable scratch Ray instances (`scratchRayDown`
  with origin mutated per call) to module scope and mutate in-place.
  Pattern already used in `game-loop.ts` for `tmpPos`/`tmpQuat`.

---

## 2. Probably slow (measure, then fix)

### 2.1 bitECS `new Set<number>()` per render system per frame

- **Where:** Multiple render systems build a fresh "live eids" Set to
  reconcile mesh maps:
  - [src/engine/render/render-systems.ts:61](src/engine/render/render-systems.ts:61) (bike mesh)
  - [src/engine/render/pickup-render.ts:29](src/engine/render/pickup-render.ts:29)
- **Cost:** Negligible per call (4–8 entries). Adds up across N render
  systems and creates predictable GC pressure.
- **Fix:** Hoist one reusable `Set` per system; clear at top of tick.

### 2.2 Combat missile `new THREE.Vector3` per missile per frame

- **Where:** [src/engine/render/combat-render.ts:66-71](src/engine/render/combat-render.ts:66).
- **What:** `mesh.lookAt(new THREE.Vector3(...))` per active missile
  per frame. At 5 missiles in flight that's 5 allocs/frame = 300/sec.
- **Cost:** Small but in a deterministic hot path.
- **Fix:** Hoist one module-scope scratch Vector3 and `set()` into it
  before `lookAt`.

### 2.3 AI `track.aiSplines.find(...)` per AI per tick

- **Where:** [src/game/systems/ai-control.ts:49](src/game/systems/ai-control.ts:49).
- **What:** Each AI looks up its spline by ID via `Array.find` every
  tick. Splines are typically 1–2 per track, so the cost is small, but
  the lookup itself is wasteful — `splineId` is immutable per AI.
- **Fix:** Resolve `spline` to a direct reference at AI spawn time
  (store on the AI controller or a side table). Removes the find from
  the hot loop entirely. Bonus: removes an indirection that defeats
  V8's inline cache for the loop body.

### 2.4 Replay capture allocates every frame even when rate-limited

- **Where:** [src/boot/game-loop.ts:336-364](src/boot/game-loop.ts:336).
- **What:** Every render frame, the replay loop walks all bike slots,
  fetches `phys.world.getRigidBody(handle.handle)`, then calls
  `rb.translation()` and `rb.rotation()`. Both return fresh
  `Vector`/`Rotation` objects from Rapier's WASM binding. The
  `replayFlat` Float64Array is pre-allocated (good), but the per-call
  WASM bridge isn't free.
- **Cost:** ~5 bikes × 2 calls × 60 Hz = 600 WASM-bound allocs/sec.
- **Fix:** The recorder rate-limits internally to ~30 Hz, so the
  caller should check `recorder.shouldSample(now)` (add that API)
  before doing any of the work. Skips the alloc entirely on the
  frames the recorder would discard.

### 2.5 `WebGPURenderer` with `antialias: true`

- **Where:** [src/engine/render/renderer.ts:42](src/engine/render/renderer.ts:42).
- **What:** MSAA is on by default. On WebGPU, MSAA enables
  multisampled color attachments — 2–4× memory bandwidth on the main
  pass.
- **Cost:** Hardware-dependent. On integrated GPUs, can shave 1–2 ms.
- **Fix:** Expose `?aa=off` for a smoke test before committing. Maybe
  default off and re-enable as a setting if it doesn't look much
  worse — water foam + sky bands hide aliasing reasonably well.

### 2.6 Shadow map PCFSoft @ 2048² every frame for every caster

- **Where:**
  [src/engine/render/renderer.ts:60-61](src/engine/render/renderer.ts:60)
  (PCFSoft enabled), [src/engine/render/scene.ts:52](src/engine/render/scene.ts:52)
  (2048² map, 180×180 m bbox).
- **What:** `PCFSoftShadowMap` is the most expensive built-in filter;
  every shadow-casting object renders an extra depth pass. The
  shadow camera's 180 m bbox means anything in a 90 m radius around
  the bike re-renders.
- **Cost:** Highly hardware-dependent. On low-end devices this can
  easily be 3–5 ms; on a discrete GPU it's negligible.
- **Fix options:**
  - Drop to `PCFShadowMap` (cheaper filter, similar visual quality at
    2048²).
  - Drop map to 1024² (half memory, ~2× faster) and accept slightly
    softer edges.
  - Tighten the shadow camera bbox to 60×60 m — most relevant shadows
    are within ~30 m of the bike.

---

## 3. Worth measuring (not yet a known problem)

### 3.1 `computeStandings` runs every rAF

- **Where:** [src/boot/game-loop.ts:462](src/boot/game-loop.ts:462).
- **What:** Called once per render frame to feed both the HUD and the
  FPS-rate status line. Function not read here, but the call site
  comment notes "we only call computeStandings once per render frame"
  — implying earlier it ran more than once. The cost itself isn't
  measured.
- **Fix:** Sample at 10 Hz (positions don't change often enough to
  need 60 Hz); the per-frame minimap can use the standings-via-cache.

### 3.2 Hot-path `Math.hypot` in AI control

- **Where:** [src/game/systems/ai-control.ts:56, 87, 97](src/game/systems/ai-control.ts:56).
- **What:** Three `Math.hypot` calls per AI per tick. Each is a sqrt.
- **Cost:** Tiny — 4 AIs × 3 hypot × 60 Hz = 720 sqrt/sec. V8 inlines
  `Math.hypot` aggressively.
- **Fix:** Only worth doing for the comparison case (`speedHoriz` vs
  threshold) — replace with `dx*dx+dz*dz > T*T` per existing convention.
  Direction normalization needs the actual length, leave as-is.

### 3.3 Bike GLB clone at race start

- **Where:** [src/engine/render/render-systems.ts:74, 89](src/engine/render/render-systems.ts:74).
- **What:** `cloneLoadedBike()` runs once per bike at first sighting,
  including material recolour. For 1 player + 4 AI = 5 clones at race
  start, est. 1–2 ms each → ~10 ms one-shot pause at race start.
- **Cost:** One-shot, visible as a small hitch when bikes spawn.
- **Fix:** Pre-warm during loading-screen phase. Material recolour
  can be deferred — clone with default tint, retint on next frame.

### 3.4 Terrain shader first-compile

- **Where:** [src/engine/render/terrain-shader.ts](src/engine/render/terrain-shader.ts)
  (the `MeshStandardNodeMaterial` with FBM noise + ramp + triplanar).
- **What:** First render with this material triggers shader compile.
  Per the May 15 status comment, the shader now also has domain-warped
  noise + triplanar cliff sampling + slope split + altitude jitter +
  HSV saturation — meaningfully more node-graph nodes than before.
- **Cost:** est. 5–20 ms one-shot at track load (WebGPU faster,
  WebGL2 slower).
- **Fix:** Render a single dummy quad with the material during the
  loading screen to force compile before the first race frame.

---

## 4. Bundle / startup

### 4.1 Eager imports of `three/webgpu` and `three/tsl`

- **What:** Most render files at `src/engine/render/*.ts` import from
  `three/webgpu` (the WebGPU/TSL build) and `three/tsl`. These are
  large; tree-shaking helps but the surface area is wide.
- **Audit needed:** Run a `vite build --report` (if not already
  scripted) and look at the top-10 chunk contributors. The water
  shader + ocean-fft directory is suspected biggest.
- **Possible win:** Code-split the editor (`?edit=1`) and viewer
  (`?viewer=`) paths — they're rarely loaded in the racing path but
  may be in the main bundle today.

### 4.2 Debug menus

Already addressed in PR #40 (lazy-loaded). Sanity check: confirm the
chunks still split as expected after recent changes.

---

## 5. Suggested fix plan

Order chosen for ratio of frame-time-saved to risk-of-regression.

### Batch A — HUD cleanup (low risk, ~1 ms/frame back)

1. Bake static minimap layers (background + spline + start gate
   marker) into an offscreen canvas once at HUD construction; blit
   per frame, then draw bike dots + player next-CP highlight on top
   ([race-hud.ts:301](src/engine/render/race-hud.ts:301)).
2. Skip HUD `textContent` writes when the value hasn't changed
   ([race-hud.ts:274-283](src/engine/render/race-hud.ts:274)).
3. Drop the `[...input.bikes].sort()` allocation
   ([race-hud.ts:370](src/engine/render/race-hud.ts:370)) — either
   sort once in `game-loop.ts` or use three sequential passes.

**Verification:** Compare rAF frametime histogram in `?fps` before/after
on a typical race. Look for the floor under 16.7 ms to widen.

### Batch B — Per-frame allocations (low risk, GC-pressure win)

4. Hoist `phys.rapier.Ray` to scratch instances in `hover.ts`
   ([hover.ts:73](src/game/systems/hover.ts:73)).
5. Hoist `Vector3` to scratch in `combat-render.ts:66`
   ([combat-render.ts:66](src/engine/render/combat-render.ts:66)).
6. Hoist `Set` to scratch in `render-systems.ts:61`,
   `pickup-render.ts:29`, and any other render-system mesh-map
   reconcilers ([render-systems.ts:61](src/engine/render/render-systems.ts:61),
   [pickup-render.ts:29](src/engine/render/pickup-render.ts:29)).
7. Resolve `spline` once at AI spawn instead of `find`-ing it per tick
   ([ai-control.ts:49](src/game/systems/ai-control.ts:49)).
8. Add `recorder.shouldSample(now)` and short-circuit the per-frame
   replay loop in `game-loop.ts:336-364` when the recorder will
   discard ([game-loop.ts:336](src/boot/game-loop.ts:336)).

**Verification:** Chrome devtools "Performance" → Memory graph slope
should flatten between full GCs in long races.

### Batch C — Water FFT (medium risk, ~0.4 ms/frame back)

9. Add `?fft=lo` (default) at N=64 and `?fft=hi` at N=128, plumbed
   through `gpu-bake-fft.ts`'s instantiation. Validate visual delta
   with playtests across `?track=lagoon`, `?track=cliffside`, and a
   downtown variant ([gpu-bake-fft.ts](src/engine/render/ocean-fft/gpu-bake-fft.ts)).
10. *(later)* Investigate radix-8 fusion of butterfly stages —
    rewrite of `fft-tsl.ts`. Defer until the easy wins land.

**Verification:** GPU dispatch count visible in browser GPU profiler
(Chrome → DevTools → Performance → GPU). Should halve.

### Batch D — Shadow / AA tuning (low risk, hardware-dependent win)

11. Switch `PCFSoftShadowMap` → `PCFShadowMap`; drop shadow map to
    1024²; tighten shadow camera bbox to 60×60 m
    ([renderer.ts:60-61](src/engine/render/renderer.ts:60),
    [scene.ts:52](src/engine/render/scene.ts:52)).
12. Add `?aa=off` and playtest — if water + sky still look acceptable
    without MSAA, default off on integrated-GPU detection
    ([renderer.ts:42](src/engine/render/renderer.ts:42)).

**Verification:** Playtest. Visual quality is the hard constraint
here; frame-time win is secondary.

### Batch E — Dead-code + cleanup

13. ~~Wire or delete `foliage-sway.ts`.~~ **Withdrawn after closer
    reading.** The module is intentional scaffolding for Blender-
    authored foliage (see `docs/vertex-attribute-spec.md`,
    `docs/blender-wishlist.md` item 6, and `docs/status.md`). Until a
    material calls `applyFoliageSway()`, the `onBeforeCompile` patch
    has zero runtime cost — nothing to win by deleting, and the
    delete would have to be undone when the Blender foliage path
    lands. Updated `§Method note` above accordingly.
14. Update stale `gpu-bake-fft.ts:34-38` "WIP / amplitude bug" comment —
    `git log --oneline` shows commit `35440ee feat(water): A9 complete
    — fix FFT amplitude bug` landed since. The doc-block lied to the
    next reader. Replaced with a status line that points at the
    Batch C resolution-tier knob.

### Batch F — Boot-time hitches (one-shot)

15. Pre-warm the terrain shader during loading-screen by rendering a
    single dummy quad
    ([terrain-shader.ts](src/engine/render/terrain-shader.ts)).
16. Pre-warm `cloneLoadedBike()` during loading-screen for all
    expected variants ([render-systems.ts:74](src/engine/render/render-systems.ts:74)).

---

## Priority matrix

| # | Batch | Issue | File | Effort | Cost saved (est.) |
|---|-------|-------|------|--------|-------------------|
| 1 | A | Minimap static-layer cache | race-hud.ts:301 | Low | 1–3 ms/frame |
| 2 | A | HUD textContent dirty-flag | race-hud.ts:274 | Trivial | 0.2–0.5 ms/frame |
| 3 | A | Drop bike-dot sort alloc | race-hud.ts:370 | Trivial | GC |
| 4 | B | Hoist Rapier Ray scratch | hover.ts:73 | Low | 1500 alloc/sec |
| 5 | B | Hoist missile Vector3 | combat-render.ts:66 | Trivial | 300 alloc/sec |
| 6 | B | Hoist render-system Sets | render-systems.ts:61 + others | Trivial | GC |
| 7 | B | Cache AI spline ref | ai-control.ts:49 | Trivial | Find/tick |
| 8 | B | Replay shouldSample gate | game-loop.ts:336 | Low | 600 WASM-bound alloc/sec |
| 9 | C | Default FFT to N=64 | gpu-bake-fft.ts | Medium | ~0.4 ms/frame |
| 10 | C | Radix-8 FFT butterfly fusion | fft-tsl.ts | High | ~0.5 ms/frame |
| 11 | D | Shadow filter + map size | renderer.ts:60, scene.ts:52 | Low | 1–3 ms/frame (low-end) |
| 12 | D | `?aa=off` toggle | renderer.ts:42 | Trivial | 1–2 ms/frame (low-end) |
| 13 | E | ~~Wire or delete foliage sway~~ — withdrawn | foliage-sway.ts | — | n/a |
| 14 | E | Update stale FFT comment | gpu-bake-fft.ts:34 | Trivial | Doc |
| 15 | F | Pre-warm terrain shader | terrain-shader.ts | Low | 5–20 ms one-shot |
| 16 | F | Pre-warm bike clones | render-systems.ts:74 | Low | 10 ms one-shot |

Estimated combined frame-time saving from Batches A–D: **~3–6 ms/frame**
on integrated-GPU hardware; **~1–2 ms** on a discrete GPU. Worth doing
mainly for the cheaper-device experience.

## Open questions

- Is there a measured baseline frametime on a target device? The
  estimates above are educated guesses; without a profile, the actual
  ROI may reorder this list.
- The Explore agent flagged GPU FFT dispatch as the biggest win;
  in practice, item #1 (minimap) is probably bigger because it pays
  on every device including the discrete-GPU path. Measure both
  before deciding what to attack first.
