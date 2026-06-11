# Reef Cup — External-Prop Replacement Catalog

> ⚠️ **South Beach Sunken / Miami was cut (2026-06 content pass)** and the Reef
> opener rebuilt from scratch as **Mexico City** (the drowned capital —
> [tracks/mexico-city.md](tracks/mexico-city.md)), concept-locked /
> geometry-pending. All "South Beach" prop-replacement notes below are
> **historical** (they describe the discarded Miami build).

> **✅ IMPLEMENTED 2026-06-05.** The placeholder→Quaternius swap is **done and
> verified in-engine on all three Reef tracks** (Mayday Bay, Cape Town, South Beach).
> See [Status — implemented](#status--implemented-2026-06-05) at the bottom for
> exactly what shipped. This doc is kept as the rationale + per-track replace map.

> **Companion to** [reef-cup-art-quality-catalog.md](reef-cup-art-quality-catalog.md)
> (cross-cut **C**: "Dressing density — *use the Quaternius library*") and
> [reef-cup-vertical-slice-status.md](reef-cup-vertical-slice-status.md)
> (cross-cut #4: runtime props absent on two of three tracks).
>
> **Purpose.** Catalog the **external prop library** and map it onto the three
> Reef Cup tracks — **Mayday Bay, South Beach Sunken, Cape Town Drift** — so the
> crude blocked-in / box-kitbash dressing can be **replaced with library props**
> (a placement job, not a modelling job).
>
> **Method — judged by eye, not by datablock name.** Every ready-to-place GLB in
> `public/assets/props/cc0/` (63) + `public/assets/props/ai/` (13) was rendered
> to a framed thumbnail and tiled into category contact sheets
> (`test-results/prop-catalog/sheet_*.png`, regenerate with
> `render_thumbs.py` + `make_sheets.py` in that folder). Grades below come from
> looking at the render, per the project rule (face counts / names mislead).

---

## The library at a glance

| Source | Where | Count | State | Register |
|---|---|---|---|---|
| **Quaternius CC0** (Pirate, Toon-Shooter, Nature-Crops, Ships, Cute-Fish, Cyberpunk, Animated-Fish) | `public/assets/props/cc0/` | 63 | **ready + wired** (`keep_material` multi-tone; place as `cc0/<id>`) | clean multi-tone "toy" — on-target |
| **AI-pipeline** | `public/assets/props/ai/` | 13 | **ready + wired** (place as `ai/<id>`) | flat single-tint — reads more placeholder |
| **Staged, NOT conditioned** (Downtown-City 153, Textured-Buildings 102, Stylized-Nature 68, Simple-Nature) | `C:\project-content\hoverbike\external\quaternius\extracted\<pack>\` | ~320 | needs conditioning before placement | the missing **buildings** + **blooming foliage** |

Two facts that shape everything below:

1. **Placement is already wired.** The runtime loads `cc0/<id>` and `ai/<id>`
   from a track's `props[]` (e.g. Cape Town already places `cc0/shark`,
   animated). So replacing dressing is a **JSON edit**, no new code — except the
   baked-in *track GLB* set-pieces (hotels, freighter, marina shack), which are
   geometry inside `<id>.glb` and must be deleted in Blender + re-exported, then
   the prop placed in JSON.
2. **CC0 multi-tone > AI flat-tint, visually.** The CC0 `keep_material` props
   render with their painted multi-tone surface; the AI props are a single flat
   tint (the AI lane strips material for a `mat_<family>` colour). Where both
   exist for the same need, **prefer the CC0 prop** for finished look. (The AI
   props are still fine Tier-B dressing — Mayday Bay already ships 25 of them.)

---

## The replace map — per track

Legend: **GLB-baked** = geometry inside the track `.glb` (delete + re-export to
replace). **JSON** = pure `props[]` placement. Tiers (C/B/A) from the
[art-quality catalog](reef-cup-art-quality-catalog.md).

### Mayday Bay (tutorial / classroom)

| Blocked-in today | Where | Replace with | Notes |
|---|---|---|---|
| **Marina shack** — box + pyramid roof (Tier C) | GLB-baked | **`ai/pilot_shack`** (already built, unused) *or* **`cc0/house_1`** (pirate cabin) | The art-quality catalog's top Mayday Bay fix: a real shack exists — wire it. `house_1` is a weathered tropical cabin alternative. |
| Marina **dock / pilings** (Tier B, fine) | GLB-baked | optionally accent with **`cc0/dock`, `cc0/dock_pole`, `cc0/dock_broken`** | The dock is the nicest thing in the cup — keep it; add broken-dock + extra pilings for ruin texture at the cove edge. |
| `scatter_palms` (~12, instanced kit) | JSON/scatter | **`cc0/palm_2`** (lush) + `palm_1`/`palm_3` for variety | Pirate palms read fuller than the current kit. |
| Marina clutter (none placed) | JSON | **`cc0/anchor`, `cc0/barrel`, `cc0/crate`, `cc0/bucket`, `cc0/boat`, `cc0/lifeboat`** | "Cared-for marina" dressing — anchor + a moored boat sell the pilot-school. |
| Coral/debris under waterline | JSON | **`cc0/coastal_rock`, `cc0/rock_2..5`** | Replaces/augments `scatter_rocks`. |

> Mayday Bay is already the most-dressed (25 `ai/*` + 100 buoys). The win here is the
> **`pilot_shack` swap** + a few CC0 marina accents, not volume.

### South Beach Sunken (Reef #1) — currently **0 props placed**

| Blocked-in today | Where | Replace with | Notes |
|---|---|---|---|
| **Barge / wrecks** (Tier C boxes) | GLB-baked | **`cc0/boat`, `cc0/lifeboat`, `cc0/sail_ship`, `cc0/cruise_ship`** | Drop the box wrecks; place real hull silhouettes. `sail_ship` reads as a derelict. |
| **OOB skyline ships** (Tier C boxes) | GLB-baked | **`cc0/cruise_ship`, `cc0/sail_ship`** | Distant silhouette dressing. |
| **Lifeguard hut** (Tier C box) | GLB-baked | **`cc0/house_1`** (stand-in) *or* model | No perfect match — `house_1` is the closest small structure; flag for a small model if it must read as a lifeguard tower. |
| Half-submerged **lounge chairs** (called for, absent) | JSON | ⚠️ **no library fit** | Gap — needs a model or a conditioned `toon-shooter` Sofa. |
| **Flamingo** lawn ornament (the postcard joke) | JSON | ⚠️ **no library fit** | Gap — small bespoke/AI prop. |
| `scatter_palms` (~20 rooftop) | JSON/scatter | **`cc0/palm_1/2/3`** | Rooftop palms. |
| `scatter_rocks` (~30 coral) | JSON | **`cc0/coastal_rock`, `cc0/rock_2..5`, `cc0/debris_pile`** | Under-waterline coral/debris. |
| Rooftop clutter (sells "lived-in") | JSON | **`cc0/water_tank`, `cc0/cyber_ac`, `cc0/cyber_antenna`** | Rooftop AC/tank/antenna — the "they kept the lights on" texture. |
| **Hotel kit / Versace / seaplane** (Tier C heroes) | GLB-baked | ❌ **not prop-replaceable** | These are the **postcards** — need real modelling (or the staged building packs, below). Props don't solve heroes. |

### Cape Town Drift (Reef #2) — currently **1 prop** (`cc0/shark`)

| Blocked-in today | Where | Replace with | Notes |
|---|---|---|---|
| **Wreck containers** — box stacks (Tier B−) | GLB-baked | **`cc0/shipping_container`** (red), **`cc0/container_small`** (blue) | The standout match. Mixed-orientation half-sunk stack = the harbour-slalom obstacles. |
| **Grounded freighter** — ~6 boxes (Tier C) | GLB-baked | **`cc0/cruise_ship`** or **`cc0/sail_ship`** (or keep + dress) | No raked-hull freighter in the library; the ships are the nearest maritime silhouette. |
| **Harbour dressing** — box-row skyline (Tier C) | GLB-baked | **`cc0/house_1/2/3`** + **`cc0/boat`, `cc0/lifeboat`, `cc0/crate`, `cc0/pallet`, `cc0/barrel`, `cc0/oil_drum`, `cc0/gas_tank`, `cc0/fence`, `cc0/street_light`** | "Survivor-harbour character + market stalls + boats" — this is a pure placement job. Pirate houses = shanty quay; toon-shooter kit = industrial clutter. |
| Container **rust / oxidation** (broken-50% note) | material | (place **`cc0/oil_drum`, `cc0/debris_pile`, `cc0/debris_tires`** for rust-field texture) | Real rust is the `COLOR_0`/waterline material job; props add the ruin clutter around it. |
| **Two Oceans aquarium** — intact tank (Tier B) | GLB-baked | keep + **fill with sea life** (below) | Detailing/break job on the hall; props make it *alive*. |
| Aquarium **sea life** (only the shark today) | JSON | **`cc0/clownfish`, `cc0/blue_tang`** (static) + **`cc0/fish_1/2/3`, `cc0/manta_ray`, `cc0/dolphin`** (animated, `Swim`) | The biggest "alive" win in the cup — schools circling the great white in the tank. Animated lane already shipped. |
| Open-water life (horizon) | JSON | **`cc0/whale`** (animated) | A whale on the Atlantic horizon. |
| Market stalls (called for) | JSON | ⚠️ **partial** — improvise from `cc0/crate` + `cc0/pallet` + `cc0/fence`; true stalls need a conditioned pack | Gap for proper awning stalls. |

---

## Useful library props, by category (eye-verified)

Grade: **A** = use as-is (great silhouette + multi-tone), **B** = good, minor,
**C** = situational. See `test-results/prop-catalog/sheet_*.png`.

**Maritime & harbour** (sheet 01) — the richest, most on-theme vein:
- **A:** `shipping_container`, `container_small`, `dock_broken`, `sail_ship`,
  `anchor`, `boat`, `lifeboat`
- **B:** `dock`, `dock_pole`, `cruise_ship`, `oil_drum`, `barrel`, `crate`,
  `pallet`, `gas_tank`, `water_tank`, `trash_container`

**Rocks & cliffs** (sheet 02): **B** across — `coastal_rock`, `rock_2..5`
(coral/debris scatter), `cliff_2/3/4` (coastal verticality, supporting rock; for
*hero* sea-stacks keep the GeoNode `HV_SeaStack`). `cliff_1` flatter.

**Tropical foliage** (sheet 03): **A:** `palm_2` (lush), `palm_1`, `palm_3`.
**B:** `palm` (Nature-Crops), `bamboo`, `coconut`. Skip crops (`corn`, `pumpkin`,
`watermelon`, `cactus`) — off-theme.

**Urban / wreckage** (sheet 04): **B:** `house_1/2/3` (weathered tropical
shanties — quay/marina structures), `debris_pile`, `debris_tires`, `debris_car`,
`fence`, `street_light`. **C:** `traffic_cone`.

**Sea life** (sheet 07): **A** for the aquarium — static `clownfish`, `blue_tang`;
animated `shark` (in use), `manta_ray`, `dolphin`, `fish_1/2/3`, `whale`. All
multi-tone; animated ones drive a `Swim` clip via the animated-prop lane.

**Neon / rooftop** (sheet 05): **B:** `cyber_ac`, `cyber_antenna` (rooftop
clutter). **C:** `neon_sign` (blank lit panel — no Deco character; weak for South
Beach signage), `street_lamp_neon`.

---

## Skip (off-theme for a near-future drowned-reef world)
Pirate fantasy & farm: `chest`, `chest_gold`, `cannon`, `bottle` (sheet 06);
`cactus`, `corn`, `pumpkin`, `watermelon` (sheet 03). `bucket` is borderline
(marina dressing OK).

## Gaps — no library fit (need model / AI / conditioning)
- **Hero set-pieces:** Versace mansion, vintage seaplane ramp, Table Mountain,
  Cape Wheel — the postcards. Props don't solve these.
- **Specific dressing:** lounge chairs, flamingo, lifeguard tower, market stalls
  with awnings, harbour crane.
- **The fix for the building gap → condition the staged packs.** `downtown-city`
  (modular drowned-city kit) and `textured-buildings` (102 prefab 1–6-story
  buildings) are downloaded and GLB-ready in the content stash but **not
  conditioned** (scale/COLOR_0/collider). Running them through
  `condition_ai_batch.py` (`keep_material`) would give South Beach a hotel/skyline
  backdrop and Cape Town a real harbour-building set — the single biggest unlock
  beyond what's already in `cc0/`. `stylized-nature` (trees, dead trees, ferns,
  flowers) would supply the **blooming** half of the built/broken/blooming ratio.

---

## Status — implemented (2026-06-05)

Done in the live Blender session (placeholder boxes deleted from each `.blend` +
re-exported; replacements placed via the addon's **Prop Placements → JSON**
round-trip, so they ship as instanced `props[]`). All three `.blend`s saved; all
three verified in-engine (`gen:track-shots`, `consoleErrors=false`).

| Track | Was (placeholder) | Now (`props[]`) |
|---|---|---|
| **Cape Town** | `grounded_freighter` box; `wreck_containers` (332 box-blobs); `harbour_dressing` box skyline | **349 props** — `cruise_ship` (grounded), **332 `shipping_container`** rebuilt 1:1 from the `wreck_containers` block-in (exact position, **full 3D orientation incl. the tilted ride-off ramps**, and per-box size; now genuinely collidable), 8 `house_*` + 2 `boat` + 5 `crate`/`barrel` on the kept quay; animated `shark` preserved |

> **Revised 2026-06-06.** The first swap (above, 118 props) replaced the 332-box
> block-in with a fresh, sparser scatter whose **orientations didn't match** the
> deliberately-placed yard (p50 yaw off 43°) and which had **no working collision**.
> Root cause of the latter was an **engine bug**, not the assets: `addAssetPropColliders`
> ignored the GLB collider node's local offset, so every base-pivoted prop's collider
> sank below its visual (containers/cruise_ship/houses on every track). Fixed in
> `src/game/entities/props.ts` (+ regression test). Containers then rebuilt 1:1 from the
> pre-swap `wreck_containers` mesh: each of the 332 box islands fitted with a full
> **oriented bounding box** (numpy PCA) so the **tilt is preserved** — the originals are
> ramps (median tilt 11.7°, max 44.6°, 259/332 tilted >5°) you ride up and launch off;
> pose+size mapped onto `cc0/shipping_container` (the box collider inherits the prop's
> full rotation, so the collidable shape tilts with the visual).
| **South Beach** | 2 `sb_wreck*` boxes; 36 flat `sb_palm` | **38 props** — 2 `boat`/`lifeboat` (tilted, half-sunk), 36 lush `cc0` palms. *Hotels/Versace/seaplane left for a modeling pass (no library match); `kind=track` barges + seaplane ramp untouched.* |
| **Mayday Bay** | `marina_shack_body`+`_roof` box+pyramid | marina shack → **`ai/pilot_shack`** (built but never wired). *(Sea-stacks→cliffs + wrecks→boats already done earlier.)* |

**Deploy:** track `*.json` are git-tracked (commit); the re-exported GLBs are
gitignored → R2, so they need **`pnpm assets:push`**.

### Remaining / not done
- **South Beach hero modeling** — Art-Deco hotels, Versace mansion, seaplane (no
  library fit). Optionally condition the staged `textured-buildings` pack.
- **South Beach rooftop clutter** (AC/tanks/antennas) + **lifeguard** (a `cc0`
  house won't read as a lifeguard tower) — deferred.
- **`cc0/anchor` + `cc0/debris_pile` re-condition** — mis-scaled flat slabs (the
  only two unusable library props); tracked separately.
- **8-bike AI ride-over check** on Cape Town's container yard. The tilted containers
  sit on/along the race line by design (**82 of 332 within 6 m**) — they're ride-up-and-
  launch-off ramps, not walls (collision is opt-out via `kind` for GLB-baked geometry;
  these are props with box colliders). The player line is the fun; the open gate is
  confirming the **AI field rides the ramps instead of jamming** on the steepest /
  most-on-line ones. If any prove to be hard blockers for the bots, nudge those few
  aside or lower their tilt — don't flatten the field.
- **Other (non-Reef) tracks** place zero props (greybox-pending) — nothing to swap
  until their v2 art pass.

Per the [art-pass playbook](track-art-pass-playbook.md): props are kept **outside
the AI corridor** (Catmull-Rom + buoy wall) and re-exported so the authored JSON is
preserved.
