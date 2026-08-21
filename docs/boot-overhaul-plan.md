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
- **Warm restart** (pause-menu RESTART without the full reload) — the
  smaller sibling of the handoff above, scoped 2026-08-19 during the
  playtest-fixes pass and deliberately **not** shipped blind: every
  stateful subsystem needs an explicit reset, and one missed store means
  corrupted restarts in prod. The complete seam list, for whoever picks
  it up:
  - `RaceHud.reset()` (race-hud.ts:598) — re-arms 3-2-1 + clears the
    shared gate-time table; already built for this.
  - Per-bike: re-place via `resolveGridSlotWorld` (grid-offsets.ts),
    zero velocities, `resetRiderForBike` + `clearCrashTracking`
    (rider-crash.ts) per bike.
  - `RacerStore` back to the initial literal (bike.ts ~:234 — extract
    an exported `resetRacer()`); `createRaceSystem`'s closure-scoped
    `prevSigned`/`prevPos` maps need a new reset hook (race.ts:50-53);
    the `TELEPORT_DIST_SQ` guard then absorbs the teleports.
  - Combat: despawn in-flight missiles/mines/explosions (entities with
    colliders), clear shield/stun/boost effect stores, reset pickup
    spawner cooldowns + held pickups.
  - Loop state: `finishShown` (via `ControlsHandle.setFinishShown`),
    `lapState` best-lap pair, replay `recorder` restart, OOB
    `resolveOob`, `RescueStateStore`, `LaunchGradeStore`, boost meter,
    drift + trick state.
  - Multiplayer stays reload-based (restart is already disabled in MP).
  Verify with a dedicated e2e: restart mid-race with a mine placed + a
  missile in flight + rider launched, assert lap 1 / clean standings /
  no orphan colliders.
- ~~Mexico City content diet (material count / prop merging)~~ **DONE
  2026-06-12** — both halves landed and measured (perf-baseline.md): the
  shadow-caster size gate (shadow-caster-gate.ts) plus the decoration merge
  (tools/blender/optimize_track_glb.py, 455→117 GLB meshes) took the city
  from p50 22.1 ms / 50 fps to **11.2 ms / ~75–80 fps** steady-state on the
  iGPU box. Material COUNT (41) is unchanged — vinyl structural sharing
  remains the boot-time lever above; the frame-time problem it shared with
  this item is resolved.
- ~~fps tuning of the June-10 water layers~~ **RESOLVED 2026-06-11, and the
  cause was not the layers**: the water-ablation kit measured every June-10
  look layer together as ≈ free; the regression was the planar-reflection
  pass re-encoding the scene every frame (+ the 768² water mesh). Fixed by
  the mirror layer cull + 512² default — sandbar 58–65 → 82–88 fps,
  mexico-city steady-state p50 16.7 ms (see status.md + perf-baseline.md).
  Mexico City's remaining frame cost is its own draw count + the lap-1
  scenery stream — the vinyl-structural-sharing / content-diet items above.

## 2026-06-21 — race-load re-profile + collision proxies + dev cold-start

Re-profiled the race load on this machine (WebGPU, headed, warm dev server,
median of 3 via a per-phase `window.__bootTrace` reader). Dressed-track totals
land ~3.8–4.6 s. The category split is the headline — **the load is no longer
prewarm-dominated**; it's spread, and one big cost was hiding inside a phase
label:

| Cost (sandbar) | ms | notes |
|---|---|---|
| Shader pre-warm (`warmEarly`+`warmFinal`) | ~1.9 s | still #1; mostly FIXED pipelines (water is the single biggest), not per-track — the vinyl-sharing follow-up above is still the lever |
| **Rapier collider build** | **~0.6–0.9 s** | was hidden in the `track+env` phase; trimesh BVH over the full render geometry (sandbar 522k verts, doubled for raycast safety) |
| Water mesh build | ~0.65 s | fixed tax every load (TSL graph + 512² plane); already cut 768²→512² |
| Renderer + Rapier WASM init | ~0.4 s | fixed |
| GLB parse | ~0.23 s | the part meshopt would help |
| Heightmap bake | ~0.2 s | small |

**The `track+env` phase is collider-dominated, not parse-dominated** (sandbar:
collider 879 ms vs GLB parse 234 ms vs heightmap 200 ms). So shrinking the GLB
(meshopt) is the *deployed-download* win, not the local-dev lever it looks like.

What we ruled out: **Rapier-compat exposes no heightfield collider** (would have
near-eliminated the terrain BVH), and the heightmap is 512² (~1.9 m cells) — too
coarse to ride anyway. **Overlap** has ~no room: the post-pipeline warm is a
blocking eager render (see "What we learned" above) and Rapier runs on the main
thread, so nothing concurrent fills the gap.

### Collision proxies (the collider lever)

[`tools/blender/build_track_collider.py`](../tools/blender/build_track_collider.py)
generates `<track>-collider.glb` — a **collapse-decimated, collide-only** copy of
the collidable meshes, so Rapier's BVH builds over a fraction of the triangles.
Collapse (quadric-error) not planar dissolve: dissolve makes n-gons the glTF
exporter re-triangulates into duplicated verts (16 MB), collapse emits clean
shared-index tris (4.4 MB at ratio 0.5) and drops normals/materials a collider
never reads. **Keep `ratio` conservative — the hover ray rides the collider, so
ramp lips / jump takeoffs are feel-critical; playtest before going lower.**

Two objects come out: `HV_TrackCollider` (the decimated bulk) and, when the
source GLB has any, `HV_TrackColliderExact` — the `collider_mesh` meshes joined
**verbatim**, no weld, no collapse. Those are hand-authored collide-only proxies
already (a dock's swept deck slab is ~1k tris against terrain's ~200k), and they
carry the *whole* collision for anything whose visual is tagged `decoration`.
The proxy REPLACES the render geometry as the collision source, so its strip
list is not an optimisation knob — a kind dropped there is collision that
vanishes in-race while the mesh still draws. That is exactly how Mayday Bay's
dock ramps lost collision until 2026-08-20 (`collider_mesh` was in the strip
list). `NON_COLLIDING_KINDS` must mirror the runtime set in
[glb-track.ts](../src/engine/render/glb-track.ts); `tests/unit/track-collider-proxy.test.ts`
fails if they drift, and `tests/e2e/dock-collision.spec.ts` checks the *shipped*
proxy still carries the slabs — rebuilding without `pnpm assets:push` leaves the
bug live, since `.env` points `/assets/**` at R2 even in dev.

Runtime ([`loadColliderProxy`](../src/engine/render/glb-track.ts) +
[track-loader.ts](../src/boot/track-loader.ts)) is **backward-compatible**: if a
track ships `<glb>-collider.glb` it colliders that; absent (legacy tracks) it
colliders the render geometry exactly as before. The HEAD content-type guard
sidesteps Vite's dev SPA fallback (missing static file → 200 + index.html).
Heightmap + water shoaling still read the high-poly mesh.

Sandbar pilot (ratio 0.5): `track+env` **1528 → 1170 ms (~358 ms)**, hover
settled within **6 cm** of the render-mesh baseline (5.34 vs 5.28 m), 0 errors.
Modest at the safe ratio — the proxy's own load eats some of the BVH saving.

Open / remaining for a full roll-out:
- **Tune `ratio` per track** (feel playtest) — 0.3–0.2 ~doubles the win.
- **meshopt the proxy** so prod download doesn't regress (+4.4 MB/track now).
- **Prefetch** the proxy load to overlap the env-GLB load.
- Generate one per dressed track + `pnpm assets:push` (R2). Only `sandbar` has
  one so far; every other track silently runs the legacy path.

### Dev cold-start (the "blank page before KING TIDE on first `pnpm dev`")

Separate from the in-app load: on a cold `node_modules/.vite` cache, Vite
esbuild-**scans** the whole Three-heavy source graph (~40 s+) before serving
anything, holding the first request — the browser sits blank (not even the
inline loading screen) the whole time. Fixed in
[vite.config.ts](../vite.config.ts): `optimizeDeps.noDiscovery` + an explicit
`include` of every bare browser import skips the scan and pre-bundles at server
startup (terminal-visible), `server.warmup` pre-transforms the entry/boot
graphs, and `coldStartHintPlugin` prints a heads-up when the deps cache is
absent. Deployed/warm loads were already fine (KING TIDE in ~0.2–0.6 s) — this
is dev-only. **Maintenance: with discovery off, every NEW bare browser import
must be added to `optimizeDeps.include`** (a missing CJS dep fails loudly at dev
start; a missing ESM one just serves unbundled).
