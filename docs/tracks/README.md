# Hoverbike — Per-track design docs

> Canonical per-track home for the v1 track set. One doc per track lives
> in this folder. These docs **supersede** the per-track stat blocks in
> [../track-themes.md](../track-themes.md) (content bible) and
> [../track-design-specs.md](../track-design-specs.md) (deep impl spec)
> wherever they disagree — both of those predate the **no-anti-grav
> reconciliation pass** captured here.
>
> The bible and specs docs are still the reference for lore, palette,
> audio, beat timing, wave-zone tuning, and emitter configs. This folder
> is the reference for **what each track is now that anti-grav is cut**,
> and for the **prop manifest** (unique-per-track + common-to-all).

## The design constraint: no anti-grav moments

**Decision (v1):** anti-grav is **cut from the v1 race set.** No track
ships a gravity-flip moment — no riding walls, ceilings, undersides, or
vertical tubes. The hover physics always run with normal "down."

**Why:** anti-grav is not one prop, it's a *system* — a controller
gravity-flip mode, three authoring profiles (`antigrav_curve_*` tube /
banked-strip / ribbon), bespoke chase-camera handling for inverted
travel, a dedicated tutorial beat, and a QA surface across every device
and input method. Cutting it removes a whole vertical slice of
engineering and test cost. The set loses nothing it can't get back from
**terrain and ramps**, and we ship sooner. Golden Gate Drowned was
already authored this way ("land as waves frozen in time") and proves
the verticality reads without the gravity flip.

**This is the reconciliation pass** that [track-themes.md](../track-themes.md)
and [track-design-specs.md](../track-design-specs.md) flagged as pending
("final cup order set in the anti-grav reconciliation pass"). Eight
tracks carried anti-grav and have been reworked below; the four that
never used it (the Reef opener, Cape Town, The Maw, Marina Bay 7) and Golden
Gate are unchanged. *(The Reef opener is now Mexico City,
which replaced South Beach Sunken / Miami in the 2026-06 content pass — it
likewise never used anti-grav.)*

## Replacement verticality vocabulary

Every cut anti-grav moment is rebuilt from one of these **normal-gravity**
primitives. The hard rule: **no racing surface is ridden with flipped
gravity; banking never exceeds ~45°; no undersides, ceilings, or vertical
walls as drivable surface.**

1. **Frozen-wave terrain** — hills and crests authored as a swell
   heightfield; you surf up the back and launch off the top, the same
   gesture you pump on water. *(Golden Gate "the hills"; the model for
   the whole pass.)*
2. **Ramps & launches** — collapsed structures, wings, slabs, fallen
   towers used as takeoff lips for big air. *(South Beach seaplane wing,
   the reworked Campanile, the reworked torch arm.)*
3. **Rideable incline / helix ramps** — normal-gravity climbing *roads*
   that wrap a structure (think parking-helix or Rainbow-Road incline,
   not a wall). *(Reworked Hatteras gallery spiral.)*
4. **Banked berms & bowl rims** — banked roads ridden like a velodrome or
   luge, capped at ~45°. *(Reworked Kilauea caldera rim, reworked
   Aqualand pool bowl.)*
5. **Cliff drops & descents** — the lap-ending plunge to sea level.
   *(Hatteras, Golden Gate "The Break", Kilauea, the reworked Liberty
   finale.)*
6. **Tunnels** — already gravity-normal; unchanged. *(Doge's Rialto arch,
   Angkor root tunnel, Aqualand lazy river.)*

A per-track "**Verticality without anti-grav**" section appears in each of
the eight reworked docs explaining which primitive replaced the cut
moment.

## Track index (cup / play order)

| # | Track | Cup | Location | Old anti-grav | New verticality | Doc |
|---|---|---|---|---|---|---|
| — | Mayday Bay | Tutorial | (fictional) | brief intro arch | crest-launch lesson | [sandbar.md](./sandbar.md) |
| 1 | Mexico City | Reef | Mexico City | none | collapsed-freeway ramp | [mexico-city.md](./mexico-city.md) |
| 2 | Cape Town Drift | Reef | Cape Town | none | flat / slalom | [cape-town-drift.md](./cape-town-drift.md) |
| 3 | Needle Sound | Harbor | Seattle | none | pier/ferry ramps + Space Needle saucer | [needle-sound.md](./needle-sound.md) |
| 4 | Golden Gate Drowned | Harbor | San Francisco | none (was always terrain) | frozen-wave hills + The Break | [golden-gate-drowned.md](./golden-gate-drowned.md) |
| 5 | Opera Drowned | Harbor (closer) | Sydney | none | Harbour Bridge arch + drop | [opera-drowned.md](./opera-drowned.md) |
| 6 | Marina Bay 7 | Continental | Singapore | none | container/deck terrain | [marina-bay-7.md](./marina-bay-7.md) |
| 7 | Doge's Drift | Continental | Venice | Campanile climb | toppled Campanile ramp | [doges-drift.md](./doges-drift.md) |
| 8 | Shibuya Submerged | Continental | Tokyo | Cocoon wall-ride | Cocoon collapsed-lattice ramp | [shibuya-submerged.md](./shibuya-submerged.md) |
| 9 | Kilauea Crown | Continental (closer) | Hawaii | caldera-rim wall-ride | banked caldera-rim road | [kilauea-crown.md](./kilauea-crown.md) |
| 10 | Aqualand | Drowned | Florida | bowl-wall | banked pool-bowl rim | [aqualand.md](./aqualand.md) |
| 11 | Angkor Drowned | Drowned | Cambodia | spire corkscrew | temple-stair ramps | [angkor-drowned.md](./angkor-drowned.md) |
| 12 | Liberty Drowned — *FINALE* | Drowned | NYC | torch underside + crown loop | ride-up torch ramp + crown gates + drop | [liberty-drowned.md](./liberty-drowned.md) |
| — | The Maw *(parked → B-list)* | — | Big Sur | none | wave launch (arch) | [the-maw.md](./the-maw.md) |
| — | Hatteras Light *(parked → B-list)* | — | NC Outer Banks | lighthouse corkscrew | gallery-spiral ramp + cliff drop | [hatteras-light.md](./hatteras-light.md) |

> **Harbor Cup (v2 rework).** The open-water **Open Sea Cup** was retired in
> the no-open-water pass — every track must now combine over-water land/props
> with water. Its replacement, the **Harbor Cup** (drowned harbor cities),
> runs **Needle Sound → Golden Gate Drowned → Opera Drowned**: Golden Gate
> moved up from Continental, **Shibuya Submerged** backfilled the Continental
> slot it vacated, and the two pure-open-water tracks — **The Maw** and
> **Hatteras Light** — are parked to the
> [B-list](../track-themes.md#b-list--future-content-packs) (files kept,
> pulled from the ship cups). **Needle Sound** (Seattle) and **Opera Drowned**
> (Sydney) are fresh concepts, greybox-pending. The Drowned Cup keeps
> Aqualand → Angkor → Liberty.

---

## Props — common to all tracks

"**Prop**," in this pipeline, means any authored Blender object keyed to
the addon vocabulary in [../blender-pipeline-guide.md](../blender-pipeline-guide.md)
— set-piece geometry, decoration meshes, scatter empties, particle
emitters, and the gameplay/system empties. Each per-track doc lists only
the props **unique** to that track. The props below are present on
**every** track, so they're documented once here instead of repeated
thirteen times.

### Required gameplay / system objects (every track JSON needs these)

| Prop | Kind / vocabulary | Notes |
|---|---|---|
| `ai_spline_main` | AI racing line | One per track; CP count scales with length (8 short → 36 Kilauea). |
| `cp_00`..`cp_NN` | checkpoint ring | One ring per track; placed at beat boundaries. |
| `start_00`..`start_NN` | start grid | 4-bike (Continental) or 8-bike grid; snap to spline. |
| `boost_NN` | boost pad | ≥1 per track (most have 2–5); rhythm + reward placement. |
| `pickup_*` | item pickup spawner | ≥1 per track (chaos tracks denser). |
| `wave_zone_NN` | wave field zone | **≥1 on every track** — even calm tracks use a low `heightMult` zone (see specs §3.3). |
| `emitter_explosion` | particle emitter (atlas_cell 1) | **Required by the runtime on every track** for crash VFX. |
| `camera_hero` | hero camera | Loading-screen / postcard framing; 35 mm or 50 mm. |
| Sky preset | `SKY_GRADE_TABLE` grade | One per track; named in each doc. |
| Horizon ring | `horizon_ring` (procedural or bespoke) | Procedural fallback for empty-ocean tracks; bespoke silhouette where a landmark sells the place. |
| Global water surface | engine water plane | The shared sim/render water; not authored per track but always present. |
| Racer grid | hoverbike entities | Player + AI bikes spawned on the start grid; shared asset, not authored per track. |

### Common environment dressing (present on most tracks)

These recur widely enough to treat as shared, but are **not strictly
universal** — a track only includes the ones that fit its setting. Each
per-track doc still calls out its specific counts/tints under unique props
when the dressing is load-bearing for the look.

| Prop | Kind / vocabulary | Where it appears |
|---|---|---|
| `emitter_gulls` | emitter (atlas_cell 5) | Every coastal/open-water track (all but the deep-jungle/industrial interiors, which swap it for cicadas/none). |
| `scatter_rocks` / coral-debris | GN scatter of `prop_rock` | Most tracks — submerged rock, coral, or rubble under the water line. |
| Ambient haze / dust-mote emitter | emitter (atlas_cell 4) | Most tracks — sun-haze, dust, or heat shimmer that sells volume. |
| `scatter_palms` | GN scatter of `prop_palm` | **Tropical tracks only** (Mayday Bay, Kilauea sea-level, Aqualand, Angkor). Listed per-track because counts/tints vary. (Mexico City scatters jacaranda/ahuehuete instead — see its doc.) |

> **One anti-grav prop is now retired set-wide:** `antigrav_curve_*` (in
> all three profiles — Tube, Banked strip, Ribbon). It appears on **zero**
> v1 tracks. The reworked docs note what replaced it on each.

## References

- [../track-themes.md](../track-themes.md) — content bible (lore, palette,
  set-piece names). Per-track stat blocks there are superseded by this folder.
- [../track-design-specs.md](../track-design-specs.md) — deep authoring
  spec (beat timing, wave-zone tuning, emitter configs). Still authoritative
  for those numbers; anti-grav curves in it are retired by this pass.
- [../track-art-pass-playbook.md](../track-art-pass-playbook.md) — how to dress
  an existing gameplay-complete track with props + foliage (prop placement,
  AI-corridor clearance, seating/sink, GLB re-export that preserves the
  authored JSON, headless-verification gotchas). Read before doing a prop pass.
- [../track-art-direction.md](../track-art-direction.md) — per-track **art
  direction**: material-state (built/broken/blooming) ratio, palette family,
  waterline + set-piece dressing notes for all 13 tracks. Read alongside the
  per-track doc before an art pass.
- [../blender-pipeline-guide.md](../blender-pipeline-guide.md) — the object
  vocabulary every prop name here is sourced from.
- [../design-targets.md](../design-targets.md) — numeric targets (the
  anti-grav target is dropped to 0 by this pass).
- [../../research/track-flow-analysis.md](../../research/track-flow-analysis.md)
  — cross-game flow analysis behind cup ordering and set-piece placement.
