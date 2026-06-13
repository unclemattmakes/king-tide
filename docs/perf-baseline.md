# Perf baseline — 8 bikes on target hardware

> Fill-in-as-you-go results sheet for the project's first real performance
> baseline. Methodology up top, blank result tables below — measure, paste a
> row, commit.

## Purpose

This is the **first real perf baseline on target hardware**. Until now,
8-bike performance was measured exactly once, on an over-powered dev GPU
(RTX 5050) — and our own notes admit that number "overstates headroom." So
the headline target in [design-targets.md §3](./design-targets.md#3-numeric-targets)
("60 fps target" row) and [§8](./design-targets.md#8-success-metrics-for-v1)
is still flagged 🟡: a guess, not a measurement. This sheet captures numbers
on the actual target devices so that target stops being a guess.

We measure the **dressed tracks only** — `sandbar` and `the-maw`. Per
[CLAUDE.md](../CLAUDE.md), the rest are greybox route-stubs; their perf isn't
representative until the v2 art pass lands. *(The `south-beach-sunken` rows
below are **stale**: Miami was cut in the 2026-06 content pass and the Reef
opener is being rebuilt from scratch as `mexico-city` —
concept-locked, not yet measurable. Rows kept as placeholders until the
rebuild lands.)*

## The target

From [design-targets.md §3](./design-targets.md#3-numeric-targets) +
[§8](./design-targets.md#8-success-metrics-for-v1):

> **60 fps at 1080p on M1 / Ryzen 5000, with 8-bike fields on wave-heavy
> tracks.**

8 bikes = 1 player + 7 AI. Wave-heavy tracks are the budget item — the water
shader plus 8 wakes is where the frame goes, which is exactly why this
baseline runs the dressed tracks at the full field.

### Interpreting the numbers

60 fps = **16.6 ms/frame**. Read the **p95** column first — average FPS hides
the hitches that actually get felt.

| p95 frame time | Reading | Verdict |
|---|---|---|
| ≤ ~16.6 ms | Comfortably holding 60 | ✅ |
| ≤ ~22 ms | Acceptable — occasional dips below 60 | 🟡 |
| > ~33 ms | Past the hitch threshold — failing | ❌ |

(33 ms = two missed frames in a row; that's the point a dip reads as a stutter
rather than a soft slowdown.)

### The decision this baseline drives

This is a real fork, not a formality. If a wave-heavy track **can't** hold 8
bikes at 60 on a target device, the fallback is the hedge already written into
[design-targets.md §6, open question #6](./design-targets.md#6-open-questions):

> drop that track's field to **6 bikes (1 player + 5 AI)** on wave-heavy
> tracks, keep 8 on land-heavy tracks.

This data is what resolves §6. A clean ✅ across the target devices retires the
6-bike hedge; an ❌ on a device we care about ships it.

## How to measure

Two paths to the same numbers — pick by what the device can run. Both run the
same three tracks at the 8-bike field. (Both harnesses are being built in
parallel by other workers; the interface below is the spec.)

### Path A — handheld / phone / Deck (any device, just a browser)

No toolchain. Open the deployed build with the bench flag:

```
<VERCEL_URL>/?bench=1
```

(The live URL is in [README.md](../README.md) — use that, don't hardcode it
here.) `?bench=1` auto-runs an 8-bike autoplay across the three dressed
tracks — **~3 s warmup + ~10 s measure** each — then shows an on-screen
results panel with a **"Copy results (Markdown)"** button and a **JSON
download**.

Two ways to record:

- **Screenshot the panel** — it's laid out for it.
- **Tap Copy** and paste the row straight into the matching table below.

Want to watch it frame-by-frame instead of trusting the summary? `?perf=1`
toggles the live perf HUD.

This is the only path for the Deck-in-Gaming-Mode, an iPhone, or any device
without a dev toolchain.

### Path B — desktop (automated)

Where a toolchain is present (this laptop, the 3070 desktop):

```
pnpm profile
```

Runs the same three tracks at the 8-bike field via Playwright on the real GPU,
and writes a Markdown table to `perf-report/`. Paste its rows into the tables
below.

### Path C — water-cost attribution (when a number above regresses)

```
node tools/water-ablation.mjs            # sandbar; TRACK=<id> to override
```

One 8-bike autoplay boot; flips each water layer via `__hover.waterDebug()`
and samples `__hover.perf` per config, plus separate boots for structural
variants (`?reflect=0` / `?reflectfull=1`, `?hextile=0`, `?watersubs=<n>`).
This is what attributed the June-10 regression to the reflection pass rather
than the look layers. Caveats: 5 s windows alias the autoplay lap (the
baseline-repeat row bounds the drift) and p50 quantizes at vsync — read mean
FPS + p95 + draw calls together. `tools/water-reflect-ab.mjs` captures posed
culled-vs-full mirror pairs for the visual half of the story.

### Path D — whole-frame attribution + production builds

```
node tools/frame-ablation.mjs           # sandbar; TRACK=<id> to override
pnpm build && node tools/bench-prod.mjs # production-build rows
```

`frame-ablation.mjs` is the water kit's sibling for the REST of the frame:
one boot per structural axis (`?shadows=0`, `?shadowmap=512`, `?post=0`,
`?aa=off`, `?reflect=0`, `?ai=5`) plus a live scenery-hidden row
(`__hover.scenery()`), each with the `?gpuprofile=1` GPU-pass average so
CPU and GPU attribution land in the same table. `bench-prod.mjs` drives the
production-safe `?bench=1` director against a `pnpm preview` of `dist/`
(the dev `__hover.perf` surface is dev/test-gated, so prod numbers can only
come from the bench panel) — note its window starts 3 s after boot, so
dressed-track rows include the lap-1 scenery stream; `track#progwarm=0`
specs give the steady-state variant.

## Results

One table per device. Rows are pre-filled; fill the metric cells (`—` =
not yet measured). Verdict per the [interpretation guide](#interpreting-the-numbers).

**Backend** = WebGPU or WebGL2 — record which one actually ran (Safari
without WebGPU falls back to WebGL2; so does Firefox). It's the single
biggest swing factor, so always note it.

### This laptop — RTX 5050 dev machine

| Track | Backend | FPS | p50 ms | p95 ms | p99 ms | Draw calls | Triangles | Verdict |
|---|---|---|---|---|---|---|---|---|
| `sandbar` | WebGPU | 40.0 | 22.0 | 77.7 | 138.9 | 320 | 4.53 M | ❌ |
| `the-maw` | — | — | — | — | — | — | — | — |
| `mexico-city` | WebGPU | 18.2¹ | 27.6 | 129.0 | 169.2 | 898 | 4.72 M | ❌ |

_Date / build SHA / notes:_ 2026-06-10, boot-overhaul branch, **dev build**
(vite, unminified) at 1280×720 — relative reads only, not absolute prod
numbers. Measured AFTER the June-10 water roadmap landed (trails, contacts,
rings, stamps, hex-tiling, rising strokes all on). ¹ mexico-city's sample
window still overlapped its 477-mesh scenery stream (one 9.4 s stall
included) — lap-1 experience, steady-state p50 is the honest row. For
context: the same machine held 100+ fps on these tracks before the June-10
water layers + Mexico City dressing; the frame regression is content/shader
cost, not the boot path (see docs/boot-overhaul-plan.md follow-ups).

### dev-box — Ryzen 5 240 / Radeon 760M iGPU (dev box)

Measured with `node tools/water-ablation.mjs` (same `__hover.perf` surfaces as
`pnpm profile`, 1280×720 dev build, 8-bike autoplay) **before/after the
2026-06-11 water-perf pass** (mirror-pass layer cull + 512² water mesh — see
status.md):

| Track | Backend | FPS | p50 ms | p95 ms | Draw calls | Triangles | Verdict |
|---|---|---|---|---|---|---|---|
| `sandbar` (pre-pass) | WebGPU | 58–65 | 13.6 | 20.2 | 272 | 4.46M | 🟡 |
| `sandbar` (post-pass) | WebGPU | 82–88 | 11.1 | 16.7 | 182 | 2.68M | ✅ |
| `mexico-city` (post-pass, steady-state) | WebGPU | 53–67 | 16.7 | 22–28 | 349–513¹ | 2.3M | ✅/🟡 |

_2026-06-11. ¹ mexico-city draw calls swing with the lap (city density) and
its lap-1 scenery stream still hitches (p95 112 ms in stream-overlapped
windows) — that's content streaming, not water. For scale: the same track
recorded 18.2 fps / p50 27.6 / 898 draws on the RTX 5050 box pre-pass; the
mirror pass was re-encoding the dressed city every frame._

**2026-06-11 (later) — post-#371 main, `pnpm profile` with the new GPU-split
column (`#gpuprofile=1` variants), same box / 720p / 8-bike autoplay:**

| Track | Backend | FPS | p50 ms | p95 ms | p99 ms | Draw calls | Triangles | GPU ms | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| `sandbar` | WebGPU | 82.1 | 13.2 | 14.1 | 20.2 | 185 | 2.75M | 4.0 | ✅ |
| `the-maw` | WebGPU | 89.8 | 13.1 | 13.8 | 14.2 | 216 | 1.86M | 4.0 | ✅ |
| `mexico-city` | WebGPU | 46.7 | 19.9 | 59.7 | 96.0 | 385 | 2.58M | 4.2 | ❌ (hitches) |

**The GPU column is the headline: ~4 ms flat on every dressed track — the
iGPU is NOT the bottleneck at 720p.** The frame is CPU-bound (dev build)
plus hitch-bound; mexico-city's ❌ is 28–36 hitches per 10 s window from the
lap-1 scenery-compile stream, not steady-state pixels.

**Same day — production build (`pnpm build` + `node tools/bench-prod.mjs`,
the `?bench=1` panel rows):**

| Track | Backend | FPS | p50 ms | p95 ms | p99 ms | Hitches | Verdict |
|---|---|---|---|---|---|---|---|
| `sandbar` | WebGPU | 45.2 | 16.7 | 72.3 | 116.7 | 43 | ❌ (lap-1 window) |
| `the-maw` | WebGPU | 75.9 | 11.2 | 16.8 | 17.0 | 1 | ✅ |
| `mexico-city` | WebGPU | 48.9 | 16.7 | 55.6 | 100.0 | 37 | ❌ (lap-1 window) |
| `sandbar#progwarm=0` (steady state) | WebGPU | 96.8 | 7.1 | 14.1 | 14.1 | 2 | ✅ |
| `mexico-city#progwarm=0` (steady state) | WebGPU | 50.4 | 21.0 | 28.0 | 37.8 | 8 | 🟡 |

_Prod caveats: the bench director's fixed 3 s warmup samples INSIDE the lap-1
scenery-compile stream on dressed tracks — the default rows are honest
"first lap on a cold load"; the `#progwarm=0` rows (scenery compiled under
the loading screen) are steady state. Steady-state reading: sandbar's whole
prod problem was the stream (43 hitches → 2, p50 7.1 ms ✅); mexico-city's
steady 21 ms CPU is REAL in prod, not dev overhead — the shadow-caster /
per-mesh cost the ablation table below attributes. The panel's draw-call
cell is the cumulative-since-boot counter on prod (no `?perf=1` reset
path) — ignore it until the per-frame `drawCalls` fix (branch
`claude/peaceful-khorana-fe9df1`) lands._

**Same day — whole-frame attribution (`node tools/frame-ablation.mjs`, full
tables in `perf-report/frame-ablation-*`):**

| Axis (off vs baseline) | sandbar (75 fps base) | mexico-city (33–46 fps base¹) |
|---|---|---|
| Scenery hidden (`__hover.scenery()`) | free at p50; p95 19.9→14.4 | **+47 fps (→79.7), p95 87.9→14.6** |
| Shadow pass off (`?shadows=0`) | **+27 fps (→102.3)** | **+28 fps (→60.6)** |
| Post/bloom off (`?post=0`) | **+24 fps (→99.7)** | ~free |
| Reflection pass off (`?reflect=0`, post-cull) | +16 fps | free |
| MSAA off (`?aa=off`) | +11 fps (GPU 1.8→1.0 ms) | free (GPU 2.3→1.4 ms) |
| Shadow map 1024²→512² (`?shadowmap=512`) | free | free |
| 6-bike field (`?ai=5`) | ~free | free |
| **Floor (shadows+post+aa+reflect off)** | **134 fps / 6.6 ms** | **89 fps / 13.1 ms** |

_¹ mexico-city baseline windows overlap its scenery stream (repeat row 46 fps
vs first 32.7 — the documented drift), but the structural reads hold._

**Reading.** GPU render is ~2 ms everywhere — at 720p this class is entirely
CPU-side. Mexico City's deficit and its hitches are one mechanism: the
dressed city's ~477 meshes, dominated by their **shadow-caster** cost —
scenery-hidden (−6.6 ms) ≈ shadows-off (−6.5 ms), i.e. the dressing's
main-pass draws are nearly free while every mesh re-encodes into the sun's
depth pass per frame. Map **resolution** is free; caster **count** is the
bill. The design-targets §6 six-bike hedge buys nothing on this class.
Measured lever order: (1) shadow-caster size gate (the mirror cull's ≥25 m
precedent, inverted for small dressing), (2) the city's residual floor
(13.1 vs sandbar's 6.6 ms — per-mesh CPU, the vinyl structural-sharing /
content-diet items), (3) post / MSAA / reflection as quality-ladder rungs
(they pay on lighter tracks and weaker GPUs, not on the city's CPU wall).

**2026-06-12 — both mexico-city fixes landed and measured** (same box,
15 s windows, `&progwarm=0` steady state, dev build):

| mexico-city config | FPS | p50 ms | p95 ms | Draw calls |
|---|---|---|---|---|
| legacy (no gate, pre-merge GLB) | 50.1 | 22.1–22.2 | 27.6 | 413 |
| + shadow-caster size gate (default 6 m) | 53.7 | 16.7–17.1 | 23.3 | 338 |
| + decoration merge (455→117 GLB meshes) | **74.1–79.9** | **11.1–11.2** | **16.7–16.8** | 202–278 |

- **Shadow-caster size gate** ([shadow-caster-gate.ts](../src/engine/render/shadow-caster-gate.ts),
  `?shadowcast=<m>`, default 6 m, foliage exempt, `0` = legacy): gated
  368/455 casters pre-merge (~5.1 ms back). Post-merge the merged clusters
  exceed the gate (17/117 gated) and the mesh-count win dominates instead —
  the gate stays as the guard rail against future many-small-casters content.
  Wave-rider fields (buoys/logs) never cast now: their shadows land on
  water, which receives no shadow maps.
- **Decoration merge** ([tools/blender/optimize_track_glb.py](../tools/blender/optimize_track_glb.py),
  headless): joins `kind=decoration` pieces per (landmark-group × material) —
  455→117 mesh nodes; `kind=track` gameplay meshes, terrain, materials, and
  COLOR_0 untouched. The city dressing's steady-state CPU went 5.5 ms →
  ~0.1 ms. Visual pairs: `artifacts/shadow-gate/`. The GLB is R2-hosted —
  re-run the script after any re-export, then `pnpm assets:push`.
- **Sandbar with the gate**: ms-neutral (draws 227→190; its casters were
  never the dressing). Its remaining shadow cost is the **movers** — 8 bikes
  + 8 multi-primitive procedural riders — measured at **4.75 ms**
  (`?shadows=0`: 97.3→119.3 fps, p50 11.1→6.35). Gating/merging tiny rider
  segment casters is the named next lever.

### Steam Deck — native Electron build

Per [steam-deck.md](./steam-deck.md): native Electron (real Chromium WebGPU on
the RADV/Vulkan stack), 1280×800, 60 fps cap. Note LCD vs OLED — the cap is
the same 60, but the OLED's higher package power affects sustained thermals.

| Track | Backend | FPS | p50 ms | p95 ms | p99 ms | Draw calls | Triangles | Verdict |
|---|---|---|---|---|---|---|---|---|
| `sandbar` | — | — | — | — | — | — | — | — |
| `the-maw` | — | — | — | — | — | — | — | — |
| `south-beach-sunken` | — | — | — | — | — | — | — | — |

_Date / build SHA / notes (LCD/OLED?):_

### Dev-kit Steam machine

| Track | Backend | FPS | p50 ms | p95 ms | p99 ms | Draw calls | Triangles | Verdict |
|---|---|---|---|---|---|---|---|---|
| `sandbar` | — | — | — | — | — | — | — | — |
| `the-maw` | — | — | — | — | — | — | — | — |
| `south-beach-sunken` | — | — | — | — | — | — | — | — |

_Date / build SHA / notes:_

### Desktop — RTX 3070

| Track | Backend | FPS | p50 ms | p95 ms | p99 ms | Draw calls | Triangles | Verdict |
|---|---|---|---|---|---|---|---|---|
| `sandbar` | — | — | — | — | — | — | — | — |
| `the-maw` | — | — | — | — | — | — | — | — |
| `south-beach-sunken` | — | — | — | — | — | — | — | — |

_Date / build SHA / notes:_

### iPhone 13 Pro (Safari)

A15 Bionic. **Highest-risk device:** if Safari has no WebGPU it falls to the
WebGL2 path (see [README.md](../README.md) tier matrix — iOS is tier 2). Note
the backend carefully here — it's the whole story.

| Track | Backend | FPS | p50 ms | p95 ms | p99 ms | Draw calls | Triangles | Verdict |
|---|---|---|---|---|---|---|---|---|
| `sandbar` | — | — | — | — | — | — | — | — |
| `the-maw` | — | — | — | — | — | — | — | — |
| `south-beach-sunken` | — | — | — | — | — | — | — | — |

_Date / build SHA / notes (WebGPU or WebGL2?):_

## What to do with the results

- **iPhone / Safari tanks** (the likely outcome — A15 on a WebGL2 fallback if
  there's no WebGPU): that doesn't fail the M1/Ryzen target, but it reframes
  the **mobile tier-2 story**. Decide whether tier 2 means "8 bikes at a lower
  cap," "6 bikes," or "playable, not 60." Feed it back into the
  [cross-browser tier matrix](./cross-browser.md).
- **Deck holds 8 at 60** on the wave-heavy tracks: the
  [§6 6-bike hedge](./design-targets.md#6-open-questions) can be **dropped** —
  ship 8 everywhere. If it can't, that's the §6 fork resolving toward 6.
- **`MAX_BIKES` water-shader detail:** there's a known cap in the water shader
  that has to be lifted before the 8-bike **wake** cost is actually exercised —
  otherwise the bench under-counts the very thing that's expensive on
  wave-heavy tracks. It's being fixed in this same perf kit; **confirm the fix
  is in the build under test** before trusting these numbers, and note the
  build SHA so a pre-fix run can't be mistaken for a clean pass.
