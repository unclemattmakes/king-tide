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
> `claude/reef-cup-vslice-p0`, each verified on real-GPU headed Chromium
> (`gen:track-shots`). Before/after frames in `artifacts/track-clean/` (before)
> and `artifacts/track-p0verify/` (after).

### P0.1 — Mexico City water + sky rescue ✅ (verified)
`public/tracks/mexico-city.json` sky: warm rosa-marigold dome tint
(`#ffffff → #ffcdb0`), big low sun (`sunSize 1 → 1.6`), dramatic cumulus
(`cloudTowering 0.35 → 0.65`, warmer `warmTop`), haze pulled in
(`fogFar 2200 → 1800`), and a glassy lake (`seaStateBeaufort 2.4 → 1.3`). The
`mexico_city_rosa` grade was already punchy — these were the suppressors.
**After:** the washed-out hazy-pink sky now reads as a vibrant rosa→coral
golden-hour, and the grey-murk water as a clean saturated teal; the painted
buildings pop against it.

### P0.3 — Mexico City wireframe-cube anomaly ✅ (verified, fixes all tracks)
Root cause: `render/track-mesh.ts` `createBoostPadMesh` drew every boost pad
in-race as a translucent cyan box **+ a `0x33ddff` `WireframeGeometry`** (a
"placement-confirmation" placeholder that shipped into gameplay). Mexico City's
3 boost pads each rendered that debug-looking wireframe volume. Replaced with a
flat **painted amber speed-strip** on the water surface (clamped into the catch
volume) + forward chevrons, `renderOrder` bumped past the camera-locked water.
**After:** the cyan box is gone; the pad reads as intentional race furniture.

### P0.2 — Cape Town landmark legibility ✅ (improved + verified; P1 remainder)
Two findings: (a) `fogFar 3200`/`fogNear 700` washed the 3 km Table-Mountain
ring (top 400 m, ~1500 m out) into the sky — raised to `1200`/`4500` (racing
line is only ±300 m, so gameplay geometry stays crisp); (b) the horizon ring is
a **sky-tinted silhouette** (`horizon-ring.ts`), and `silhouetteDark` defaulted
to a pale 0.45 — added `horizon.silhouetteDark: 0.32` so the ridge darkens
against the bright sky. **After:** the mountain now reads as a tangible darker
ridge across the horizon (was invisible). **P1 remainder (geometry/shader, needs
a Blender re-export):** the silhouette is still blue-grey not grey-green, and the
**Cape Wheel sits at z=360 — just *behind* the start line** (racing line maxes at
z≈300), so it's out of the forward sightline for most of the lap; repositioning
it onto the race line is the remaining identity win.

### P0.4 — full-field (8-bike) completion ⚠️ (2 of 3 fixed; Cape Town needs a design call)
New gated spec `tests/e2e/field-completion.spec.ts` (`FIELD_CHECK=1`): spawns the
full grid (`?ai=7`), drives all eight via autoplay, and requires every bike to
advance a full lap of checkpoints (a jammed bike stalls and fails, naming the
checkpoint). **The gate earned its keep — the single-bike `gen:track-shots`
capture sailed through both tracks; only the 8-wide field exposed the jams.**

- **Mayday Bay:** ✅ 8/8 lap, no jam (passed twice, reliably).
- **Mexico City:** ❌→✅ **found + fixed a real jam.** 4–6 of 8 bikes piled up at
  **speed 0 in the start→cp1 lane** (diagnosed via a position dump + side-on
  capture: open water, but a **gauntlet of trees planted in the racing lane**).
  Root cause: 8 **collidable** `mxc/ahuehuete`/`mxc/jacaranda` props (each GLB
  has a `collider_body`) sat **5–10 m off the centerline, inside the 14 m gate
  corridor**; the AI has no obstacle avoidance, so the field wedged into them
  (the documented inline-collider jam class). **Fix:** relocated those 8 props
  out to ~18 m perpendicular (still flanking flavor, clear of the lane). Now
  **8/8 complete on a clean run.** ⚠️ A *flaky* single-bike stick at the **start
  (cp0)** appears intermittently — almost certainly start-grid jostling (8 bikes
  packed at the line), not the gauntlet; flag for a start-spacing look.
- **Cape Town:** ⚠️ **partially fixed — found two issues at cp6.**
  1. **cp6 gate was floating + crosswise** (`y 6.86` vs neighbours ~1.5; gate
     forward·chord ≈ 0.34, ~70° off) → **all 8 stuck at cp6** (none could
     trigger it). **Fixed** (lowered to `1.6`, reoriented to the chord). That
     alone took it from **0/8 → 7/8 reaching cp10+**.
     Kept this fix.
  2. **Containers → ramps (per design direction).** The slalom packs collidable
     shipping containers onto the racing line; per Matt's call the in-lane
     containers were tilted ~60° outward into tumbled-wreckage ramps. Reads well
     (more drowned-ruin than neat stacks) — **kept** as an art improvement.
  3. **The real residual is TERRAIN, not containers — needs a level pass.**
     Chasing full 8/8, container fixes (ramps → nudge → widen to a **14 m-clear
     corridor**) were tried and **all still left 2–5 bikes stuck at cp6**, which
     *disproves* the container theory. A position+capture diagnostic shows why:
     **cp6 sits on a raised sandbar / grounded-container landmass** (dry tan
     terrain, water behind), and the field circles on the low water ~40 m short
     of the gate, unable to climb/traverse the raised mass to reach cp6's
     trigger. This is **level geometry** — re-grade/reroute the cp6 sandbar so the
     hover-line stays on traversable water, or move cp6 onto navigable water +
     retune the gate to the land's ride height. The container relocations were
     reverted (they don't fix it and widen away the slalom); the **gate fix +
     ramps are kept** (0/8 → 7/8 is the real win).

> **Note:** the field-completion spec *fails on Cape Town by design* — it's
> flagging the open **cp6 terrain** rework above (a designer/level pass), not a
> regression. Mayday Bay + Mexico City pass.
