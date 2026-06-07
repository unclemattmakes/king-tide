# Cape Town Drift — Art Target (Reef Cup visual pass)

> **What this is.** A visual build-target for the Cape Town Drift track (Reef Cup
> #2), derived from a Midjourney environment-concept pass (2026-06-01). As with
> South Beach there is **no authored `.blend` yet** — these are mood/material
> targets grounded in the design docs. When Cape Town is blocked out, this is the
> postcard to build toward; layout follows
> [tracks/cape-town-drift.md](./cape-town-drift.md), the *look* follows this doc.
>
> **Downstream of** [art-direction.md](../art-direction.md) and
> [track-art-direction.md](../track-art-direction.md#2-cape-town-drift--reef-pastel-cool-grade--25--50--25)
> (Cape Town = Reef pastel **cool grade**, **25 built / 50 broken / 25 blooming** —
> the Reef cup's *broken-heavy ruin-field*). Sister docs:
> [texcoco-rising-art-target.md](./texcoco-rising-art-target.md),
> [sandbar-art-target.md](./sandbar-art-target.md). Cape Town is the **cool**
> counterweight to South Beach's warm pastel.

## Source material

- **Concept plates (curated best-of, 6 beats):**
  `C:\project-content\hoverbike\concept-art\midjourney\cape-town-drift\best\`
  (`cape_town_hero_aerial`, `_glass_slalom`, `_two_oceans_wreck`, `_cape_wheel`,
  `_market_finish`, `_waterline_detail`). Full 4-up grids in `_montage\`, raw
  cells (`<beat>_0..3.png`) in the parent folder, `CONTACT_SHEET.png` +
  `best\_BEST_STRIP.png`.
- **MJ prompt lane** (same house lane, **cool-blue grade** for Cape Town):
  `<concrete scene>; painterly cinematic concept art, retro-future
  post-apocalyptic solarpunk drowned-world hover-bike racing game, bright cool
  Atlantic-blue water under a clear sky, oxidised container reds against
  grey-green mountain, bold colour blocking and clean stylized forms, Wind Waker
  meets Wipeout colour confidence, matte gouache key art, a defiant working ruin
  not mournful --ar 16:9 --style raw --s 250 --no cute, vinyl toy, chibi, smooth
  plastic, glossy, infantile, busy detail, text, watermark, wheels`. Bike beats
  (wreck, Cape Wheel) add the hover-craft magic phrase + `--no wheels, tires,
  jet-ski sitting in the water, hull half-submerged`. **The wheelless hover-craft
  rendered clean here** (no competing vehicle prior, unlike the South Beach
  seaplane).

## The look in one line

**Bright cool Atlantic blue** under a clear sky, **oxidised-red container reds**
and a leaning red Ferris wheel reflected in **near-glassy slack water**, the
unmistakable **flat-topped grey-green mountain** on every horizon — a *working
ruin* that's still here, just lower. Broken-heavy, but the colour stays bright.

## Palette (Reef pastel — cool grade)

| Role | Hex | Use on Cape Town |
|---|---|---|
| Sky / key (cool) | `#3FA9D8` → pale | clear bright Atlantic-blue sky, the master cool |
| Water (cool) | `#1E8FB0` | bright Atlantic blue; near-glassy mirror in the harbour interior |
| Built | `#C9D2CC` | survivor harbour structures, a few warm-lit windows, aquarium shell |
| Broken | `#C7522A` oxidised red | **the dominant** — container reds, the red Cape Wheel struts, wreckage |
| Blooming | `#5E8C61` grey-green | the mountain's living flat top, harbour kelp, algae on the wreckage |
| Emissive | warm `#FFC24D` | a few survivor windows + market lamps — minimal, only powered things glow |

Sky preset: the track design calls for **`cape_town_blue`** sky; high, clear,
cool. Keep saturation up — this is *defiant working ruin*, not grimdark; the reds
and blues do the work.

## Material-state ratio: 25 built / 50 broken / 25 blooming

Cape Town is the Reef cup's **broken-heavy** track — but "still here, just lower."

- **Built (25):** survivor harbour structures with a few warm-lit windows, the
  still-standing aquarium shell, faded market stalls. The human-persistence note.
- **Broken (50):** *the dominant* — oxidised-red container stacks, the half-tilted
  Cape Wheel, shipping-yard wreckage, the tipped ferry, the shattered predator
  tank. Let the oxidation show; **keep the colour** (no grimdark).
- **Blooming (25):** harbour kelp + algae on the wreckage, the mountain's living
  grey-green flat top on the skyline.

## Per-beat build notes

Beats follow [cape-town-drift.md](./cape-town-drift.md) (calm-water slalom loop,
48 s lap — the set's calm-water skill check).

### 1 — Hero aerial · `cape_town_hero_aerial`
The postcard: the **flat-topped grey-green mountain** dominating the skyline, the
**red Cape Wheel** as the landmark, a harbour ruin-field of oxidised-red
containers + red-roofed survivor buildings, bright-blue racing channels winding
through. **Build actions:**
- **Lock the Table-Mountain horizon ring first** — it's "30% of the track's
  identity" (per the prop manifest). Flat-top silhouette, grey-green, always present.
- The **Cape Wheel** is the second silhouette landmark; red struts, slightly
  leaning. Water shader: bright Atlantic blue, near-glassy in the interior.

### 2 — Glass slalom · `cape_town_glass_slalom`  *(10–22 s, the hard section)*
The calm-water skill check: a narrow racing lane on **near-glassy mirror water**
walled by oxidised-red container stacks, a tipped ferry mid-lane, perfect
reflections. **Build actions:**
- Sell **Beaufort-1 slack water** — flat, mirror reflections of the containers
  (this is what makes pumping *not* pay here; the calm read is the whole point).
- Half-sunk container stacks (~6 meshes, mixed orientations) + the tipped ferry
  as the slalom gates; keep the racing line readable between them.
- Waterline trio + `emitter_container_rust` wet-decay on the containers.

### 3 — Two Oceans Wreck · `cape_town_two_oceans_wreck`  *(22–32 s, the set-piece)*
Hero set-piece: the shattered aquarium predator tank, a **great white still
circling** inside the broken arched glass-and-concrete hall, the tank interior
glowing so the shark silhouette reads, a hover-craft racing through. **Build
actions:**
- Build the **arched aquarium hall** as the `kind=track` shell with roof +
  seaward-wall openings; the **skylight rim** is the sharp top edge (the
  one-shot-kill expert shortcut).
- **Light the tank interior** so the shark silhouette is unmistakable through the
  broken glass — the shark is `decoration` (no collision), reads as *life
  persisting*. The plate (cell 0) is the exact target: shark above, bike through below.
- The shark silhouette should be visible from the harbour mouth (beat 1) — a
  long-distance tease.

### 4 — Cape Wheel underpass · `cape_town_cape_wheel`  *(32–42 s)*
The bike races **under the lower arc** of the leaning red Cape Wheel emerging
from the harbour (bike pitches up to clear — **no gravity flip**), mountain on the
skyline. **Build actions:**
- Lower arc = `kind=track` (bike passes under); upper struts/cars = `decoration`.
- Red struts against bright blue water + grey-green mountain — the colour-contrast
  hero shot. Keep the arc read clean so the underpass line is obvious.

### 5 — Market finish · `cape_town_market_finish`  *(42–48 s, finish straight)*
A clean **quay finish-straight** past red-roofed survivor harbour buildings and
faded market stalls, Cape Wheel mid-distance, flat-top mountain behind. **Build
actions:**
- `road_curve_main` waterfront-market slab as the finish straight; survivor
  buildings with a few warm-lit windows (the only emissive here).
- *Watch the mountain:* some MJ cells drifted to a pointed/snow-capped peak —
  **keep it the flat-topped grey-green Table Mountain**, never a sharp summit.

### 6 — Waterline detail · `cape_town_waterline_detail`
The working-ruin **three-band waterline** on a half-submerged oxidised-red
container/hull meeting bright-blue water — the *spec image* for Cape Town's
heavier waterline. Match it on every container and wreck:
1. **Kelp/algae fringe** below + at the line. *Blooming.*
2. **Heavy barnacle + rust-streak crust** at the line. *Broken* — Cape Town gets
   the heaviest crust in the Reef cup (it's a working ruin), but **keep colour**.
3. **Salt-bleach band** just above, weathered steel.

## Build order (what to do first to hit the target)

1. **Table-Mountain horizon ring + Cape Wheel silhouette** — the two identity
   landmarks; lock the flat-top + the red wheel before anything else.
2. **Water + sky grade** to the hero plate (`cape_town_blue`, near-glassy interior,
   bright Atlantic blue + the oxidised reds reflected).
3. **Two Oceans Wreck set-piece** (beat 3) — arched aquarium hall + lit shark.
4. **Container-stack slalom** + tipped ferry (beat 2) on mirror water.
5. **Waterline trio** (heavy crust) + rust decay on every container/wreck.
6. **Sparse life** — kelp sway, shark circling, a few warm market windows, gulls.

> Keep the **racing line + ~6 m shoulder swept clean**. The wreckage is dense at
> the *edges*; the slalom line threads *between* it, never through a wall.

## References
- [cape-town-drift.md](./cape-town-drift.md) — the track (beats, props, palette).
- [texcoco-rising-art-target.md](./texcoco-rising-art-target.md) · [sandbar-art-target.md](./sandbar-art-target.md) — sister passes.
- [track-art-pass-playbook.md](../track-art-pass-playbook.md) — placement / AI-corridor clearance / re-export.
- [art-direction.md](../art-direction.md) — register, material-state rule, waterline trio, palette appendix.
