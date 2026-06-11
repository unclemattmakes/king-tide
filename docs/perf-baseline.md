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

## Results

One table per device. Rows are pre-filled; fill the metric cells (`—` =
not yet measured). Verdict per the [interpretation guide](#interpreting-the-numbers).

**Backend** = WebGPU or WebGL2 — record which one actually ran (Safari
without WebGPU falls back to WebGL2; so does Firefox). It's the single
biggest swing factor, so always note it.

### This laptop — _(fill in: model / SoC / GPU)_

| Track | Backend | FPS | p50 ms | p95 ms | p99 ms | Draw calls | Triangles | Verdict |
|---|---|---|---|---|---|---|---|---|
| `sandbar` | — | — | — | — | — | — | — | — |
| `the-maw` | — | — | — | — | — | — | — | — |
| `south-beach-sunken` | — | — | — | — | — | — | — | — |

_Date / build SHA / notes:_

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
