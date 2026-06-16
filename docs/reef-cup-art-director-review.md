# Reef Cup — Art-Director Review (vertical-slice readiness)

> **Date:** 2026-06-16 · **Scope:** a full play-through of the Reef Cup —
> **Mayday Bay → Mexico City → Cape Town Drift** — plus the cup shell (menu →
> 3 races → standings → podium), evaluated from an art-director seat.
>
> **How this was assessed.** Headed Chromium on the **real GPU** (WebGPU), per
> [CLAUDE.md](../CLAUDE.md) hard-rule 2 — not the in-app preview. Autopilot
> sweeps of all three tracks (16 clean frames each, dev-dock hidden) via
> `pnpm gen:track-shots`, the full UI contact sheet via `pnpm gen:ui-shots`, and
> the cup-select / podium / standings surfaces via the new gated
> `tests/e2e/gen-cup-flow.spec.ts` (`CUP_FLOW=1`). **Zero console errors on any
> track. fps 46–97 single-bike on the dev GPU.** Frames live (gitignored) under
> `artifacts/track-clean/<id>/`, `artifacts/ui-shots/reef/`,
> `artifacts/cup-flow/current/`.
>
> **Sibling docs:** this one covers the **look + the cup as a played experience**;
> [reef-cup-vertical-slice-status.md](reef-cup-vertical-slice-status.md) covers
> wiring/playability/render-bugs, and
> [reef-cup-art-quality-catalog.md](reef-cup-art-quality-catalog.md) the
> asset-by-asset craft gap. Art targets:
> [tracks/sandbar-art-target.md](tracks/sandbar-art-target.md) ·
> [tracks/mexico-city-art-target.md](tracks/mexico-city-art-target.md) ·
> [tracks/cape-town-drift-art-target.md](tracks/cape-town-drift-art-target.md).

## Headline verdict

The Reef Cup is a **real, complete, error-free, end-to-end cup** — menu → three
races → full-field 8-rider standings → 3D podium all work. The slice is **not
blocked on building**; it's blocked on **two of three tracks not yet reading as
their place**, plus a polish/dressing layer. Triage:

| Track | Where it is | The one thing |
|---|---|---|
| **Mayday Bay** (`sandbar`) | ~80% — *polish track* | Marina hero under-reads |
| **Cape Town Drift** | grade good, *identity missing* | **Table Mountain + Cape Wheel don't read** |
| **Mexico City** | newest build, *biggest look gap* | **Water + sky grade murky / washed-out** |

## What's working — protect these

- **The water** (Mayday Bay) is the best thing in the game — painterly two-tone
  turquoise, real depth read, the surface/underwater cutaway at the shoreline,
  sun-glare. *This is the look.* It's the bar the other two tracks should hit.
- **Sky + cumulus** — self-shadowed painterly clouds, per-track warm/cool grades.
- **Wayfinding** — the golden checkpoint arches are bold, consistent, readable at
  speed. Excellent racing-line legibility.
- **Bikes** — chunky stylized hover-craft with golden hex thrusters; 5 distinct
  liveries; read well in-race and on the podium.
- **HUD** — clean, unobtrusive, legible at speed; doesn't fight the art.
- **Cup shell** — cup → bike → race → **"CHAMPION" 8-rider standings** → **3D
  podium + trophy** all wired, and the full-field points model computes correctly.
- **Race-day framing** — "KING TIDE" painted-script logo, "RACE DAY / ROUND ONE",
  **F1 start-lights** countdown, and a strong **aerial track-reveal intro**.
  Settings are comprehensive (incl. accessibility).

## Track by track

### Mayday Bay (`sandbar`) — *polish track (~80%)*
- **Working:** gorgeous turquoise two-tone water; warm peach sky + cumulus on
  target; broken-dock set-piece sells the drowned world; sea-stacks + arches give
  identity; the waterline cutaway is striking.
- **Not working:** the marina **hero** under-reads — the dock is plain weathered
  wood; the "cared-for cream/teal shack with hand-lettered signage + warm
  work-lights" isn't selling. Terrain/wet-sand reads flat muddy-brown. An
  **over-saturated blue crystal rock** prop recurs off-palette. Crest-launch dune
  isn't framed as a clean hero lip.

### Cape Town Drift (`cape-town-drift`) — *grade good, identity missing*
- **Working:** bright Atlantic-blue water + clean cool sky with cumulus (best
  grade of the two unfinished tracks); glassy reflections; the **red container
  ruin-field** reads as an identity element; the aquarium hall + shark silhouette
  appear late in the loop; AI leaps dynamically.
- **Not working — the central failure:** the two **primary identity landmarks** —
  the flat-top **Table Mountain** ("30% of the track's identity, on every
  horizon") and the leaning red **Cape Wheel** — **never read from the racing
  line**. Horizons are empty water+sky, so it looks like generic bright ocean, not
  Cape Town. Containers are flat clean-red (no rust/weathering).

### Mexico City (`mexico-city`) — *newest build, biggest LOOK gap*
- **Working:** the painted-box architecture (pink/blue/green/yellow) gives real
  "defiant party" color; vinyl brush texture reads on surfaces; a gold-domed
  cathedral is a decent landmark; causeway stonework with a green waterline band.
- **Not working:** the **water is desaturated grey-teal** (the single biggest
  miss — target is bright glassy teal, and it looks worse right after Mayday Bay);
  the **sky is a washed-out hazy pink**, not the punchy rosa-mexicano→marigold
  sunset the grade promises; buildings are simple low-detail boxes; the **gold
  Ángel hero set-piece isn't reading**; volcanoes are flat triangles; and a **cyan
  wireframe-cube anomaly** sits at the waterline (missing prop or leaked debug
  volume).

## Cross-cutting

- **Chase-cam doesn't showcase set-pieces** — landmarks sit off-axis/distant. The
  intro aerial frames the "place" well; lean into that, or nudge landmarks onto
  the racing sightline.
- **Terrain/sand reads flat-muddy** on all three.
- **Pause overlay shows "SANDBAR"** (the slug) while everywhere else shows "MAYDAY
  BAY" — route the pause subtitle through the `displayName` lookup
  (`game/tracks/theme-catalog.ts`).
- **Title attract-feed didn't go live** within 25 s → dark fallback backdrop; the
  first impression is darker than the bright game.
- **Podium stage is dark/empty** vs the polish elsewhere — wants painted
  banners/backdrop to match the Regatta race-day signage.
- **8-bike full-loop completion** (no jam, over 3 laps) and **8-bike perf on
  target hardware** (Deck/iGPU/mobile) remain unproven.

## Punch-list to a solid vertical slice

**P0 — identity & look (the slice lives/dies here)**
1. **Mexico City water + sky rescue** → bright teal water + punchy rosa sunset
   (mostly JSON / `water.look` levers). *Highest leverage.*
2. **Cape Town: make Table Mountain + Cape Wheel read** in the first 3 seconds.
3. **Fix the Mexico City wireframe-cube** anomaly.
4. **Prove the 8-bike field completes all three loops.**

**P1 — sell the place**
5. Mayday Bay marina hero: brighten/reframe + signage/work-light glow.
6. Cape Town: container rust/weathering + light the aquarium shark.
7. Mexico City: make El Ángel read; detail buildings; volcano silhouettes.
8. Warm the terrain/sand; replace the off-palette blue crystal prop.
9. Dress the podium stage to match the race-day UI.

**P2 — polish:** pause display-name; title attract-feed reliability; a
chase-cam/landmark framing pass; "alive" emitters (gulls, papel-picado, kelp sway).

---

## P0 pass — results (2026-06-16)

> Worked top-to-bottom through all four P0s in branch
> `claude/reef-cup-vslice-p0`. Results recorded here as each lands.

_(in progress — see below)_
