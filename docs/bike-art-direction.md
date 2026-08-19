# King Tide — Bike Art Direction v1

> Per-variant art direction for the five v1 bikes. Sits under
> [art-direction.md](./art-direction.md) (the "clean stylized toy" register,
> the built/broken/blooming rule, "glow is a privilege") and is grounded in the
> **locked** stats + palettes in [`src/game/bikes/variants.ts`](../src/game/bikes/variants.ts)
> and [`specs/bikes/*.json`](../specs/bikes/). It fills the gap those leave open:
> what each bike *looks like*.
>
> **Built for concept generation.** Each bike below has a copy-paste ComfyUI
> prompt block. The palettes are **ship-locked** — match them in concepts or
> recolor after. The pipeline (one `.blend` per variant → addon export) is in
> [asset-pipeline-guide.md](./asset-pipeline-guide.md); this doc is the *look*,
> that doc is the *build*.

---

## The thesis — "hover-moto"

**A Wave Race stand-up jetski fused with a Jet Moto dirt-bike, then lifted off
the water.** That fusion is the whole silhouette language:

- **From the jetski:** a planing **hull/ski prow** that noses up over swell, a
  low wet centre of mass, marine intakes/vents, a spray-cutting nose.
- **From the moto:** a **straddled riding posture**, handlebars, a sport/dirt
  **fairing + tail**, a vertical **fin/stabilizer** standing in for the rear
  wheel's mass.
- **From the hover:** **no wheels, ever.** Twin **thruster pods** and a centre
  exhaust where the drivetrain would be; the bike floats ~1 m over the surface.

These are **post-collapse machines, not showroom vehicles** — field-kitted,
salvage-built, individual ([art-direction.md](./art-direction.md) "explorer
touch"). Clean stylized toy, not Mad Max rust: think *maintained salvage* —
repainted plating, jubilee-clipped solar trickle lines, hand-numbered livery.

### Shared anatomy (match the rig)

Every bike concept should place these so it maps onto the export sockets
([docs-site/modding/bikes.md], `build_bike.py`):

| Feature | Where | Socket it feeds |
|---|---|---|
| Straddle seat | centre, single rider | `socket_seat` |
| Nose / prow | front tip | `socket_nose_cam` (chase cam) |
| Twin thruster pods | rear left + right | `socket_fx_thruster_l/r` |
| Centre exhaust | rear centre, low | `socket_fx_exhaust` |
| Fin / stabilizer | rear, vertical | (reads the wave; mass cue) |

### Surface mix (built / broken / blooming)

Bikes are active, cared-for machines: **~80 % built / ~15 % salvage-broken /
~5 % life-trace.** Built = repainted plating, clean glass, glowing thruster
throats. Salvage = mismatched panels, patched seams, exposed cabling, a
field-welded bracket. Life-trace = a barnacle scar along the hull's waterline, a
sun-faded sticker, the odd painted leaf/flag motif. Don't over-grime — pillar 3
(defiant & alive) and the toy register both forbid ruin-porn weathering.

### Glow is a privilege (pillar 6)

The **only** emissive on a bike is its powered systems: **thruster throats,
exhaust glow, fin edge-light, HUD/dash, and the livery accent strip.** Each bike
has a locked `glowColor` + `glowIntensity` — that accent is the bike's "alive"
signal and its team-read on a crowded grid. Nothing else lights up.

---

## How to use this with ComfyUI

1. **Build a prompt** = the shared style block + the per-bike block below.
2. **Views:** generate a **3/4 front hero** (primary), a **clean side profile**
   (best reference for modelling proportions), and optionally a **front 3/4**.
3. **Palette is ship-locked.** SDXL won't read hex — the prompts give color
   *words*; the hex is listed for you to match/recolor against the shipping
   material (`mat_bike_<id>_livery / _chassis / _glow`).
4. **If you push a concept through the image→3D pipeline** (`make-props` /
   Hunyuan): keep the **hull one solid closed mass** — image-to-3D nails
   compact solid forms and fragments thin/spindly ones
   ([props-production-plan.md](./props-production-plan.md) lane rule). Treat
   handlebars, fin struts, antennae, and grab-rails as **thin parts to re-add
   procedurally** in Blender, not to reconstruct from the image. The Scout
   (AEGIS V) body already proved it conditions cleanly when kept solid.

### Shared style block (prepend to every bike)

```
arcade racing game vehicle concept art, stylized 3D, "clean stylized toy" look,
bold flat color blocking, strong readable silhouette, soft cel shading with a
gentle light-to-shadow gradient, crisp rim light, subtle bloom on glowing parts,
confident slightly-oversized rounded-but-faceted forms, matte painted salvage
metal, post-apocalyptic solarpunk hover-bike, jetski-meets-dirtbike, NO WHEELS,
twin rear thruster pods, single straddle seat, hovering above water, 3/4 front
hero view, neutral studio background, clean lighting,
Wave Race x Jet Moto x Wipeout x Wind Waker
```

### Shared negative block

```
photorealistic, photoscan, realistic PBR, heavy rust, grimdark, gritty,
muddy desaturated, brown, wheels, tires, car, truck, motorcycle wheels,
busy surface detail, noise, text, watermark, logo, signature, lowres, blurry,
deformed, extra riders, cluttered background, drop shadow
```

---

## Cruiser — "the freight"

`id: cruiser` · livery `#335599` (steel-blue) · chassis `#1a1c20` (near-black) ·
glow `#55aaff` (cyan) @1.2

**Handling made visible.** Mass 200, top speed 32, lowest spring (24) and low
surfaceFollow (0.55): it *plows through chop*, loves straights, wallows in turns.
So it must look like a **heavyweight that ignores the water** — long, low, broad,
planted, freight-train inevitability.

- **Silhouette & proportions:** the longest wheelbase in the set; low and wide;
  a big slab nose that shoulders swell aside rather than riding it. Bagger /
  muscle-cruiser stance. Reads heavy from 200 m.
- **Hero features:** oversized twin thruster cowls (the kinetic-energy engine),
  a broad full fairing, deep marine intakes along a fat hull. Stable tripod feel.
- **Surface & salvage:** thick repainted armor plating, riveted seams, a
  scavenged-but-maintained look; cyan thruster throats glowing steady.

```
[shared style block] +
heavy long low wide hover cruiser, drowned-world muscle bike, big slab spray-
cutting nose, oversized twin thruster cowls, broad full fairing, deep marine
intakes, thick repainted steel-blue armor plating with rivets, near-black
chassis, glowing cyan thruster throats, planted stable heavyweight stance,
steel blue (#335599) body, near-black (#1a1c20) metal, cyan (#55aaff) glow
```

---

## Racer — "the platonic"

`id: racer` · livery `#ff7733` (orange-red) · chassis `#222428` (graphite) ·
glow `#ffaa55` (gold) @1.4

**Handling made visible.** All-default stats: the balanced all-rounder. This is
the **reference hover-moto** — the silhouette every other bike is a deviation
from. **Establish this one first;** it defines the shared language.

- **Silhouette & proportions:** textbook sport-bike-on-a-ski. Mid everything —
  medium wheelbase, clean sport fairing, an aggressive-but-friendly rake.
  Nothing exaggerated; everything balanced and confident.
- **Hero features:** a crisp sport fairing with a single bold gold livery stripe,
  neatly faired mid-mounted thrusters, a modest swept fin.
- **Surface & salvage:** the cleanest, most "kept" of the set — a proud
  daily-driver. Light field-kit (a numbered plate, one patched panel).

```
[shared style block] +
balanced sport hover-bike, classic jetski-motorbike fusion, clean aerodynamic
fairing, single bold gold livery stripe, neatly faired mid-mounted twin
thrusters, modest swept fin, aggressive-but-friendly rake, well-maintained
orange-red bodywork, graphite chassis, warm gold thruster glow,
orange-red (#ff7733) body, graphite (#222428) metal, gold (#ffaa55) glow
```

---

## Stunt — "the flick"

`id: stunt` · livery `#33aa66` (forest green) · chassis `#1c2620` (dark green-
black) · glow `#66ff99` (lime) @1.6 *(brightest glow in the set)*

**Handling made visible.** Mass 115, top speed 25, highest surfaceFollow (1.0),
high turn-torque (5.0), inside-drift: it **banks every wave and snaps into the
apex**. So it should look **compact, upswept, and twitchy** — a freestyle trick
machine.

- **Silhouette & proportions:** short and tall-ish, steep rake, weight forward;
  the most vertical fin in the set (it reads the wave geometry hard). BMX / moto
  freestyle energy. Looks like it wants to be sideways.
- **Hero features:** a tall expressive **wave-reading fin**, stubby aggressive
  fairing, exposed flickable frame, the brightest accent glow (it's the
  show-off). Knobbly grip surfaces.
- **Surface & salvage:** covered in stickers and hand-paint, the most
  *personalized* bike — a skate-deck attitude. Lime edge-lighting everywhere
  glow is allowed.

```
[shared style block] +
compact agile freestyle hover trick-bike, short tall twitchy proportions, steep
rake weight-forward, tall expressive wave-reading fin, stubby aggressive
fairing, exposed flickable frame, knobbly grips, covered in stickers and hand-
paint, skate-deck attitude, forest-green bodywork, dark green-black chassis,
bright lime edge-glow, forest green (#33aa66) body, dark (#1c2620) metal,
lime (#66ff99) glow
```

---

## Scout (AEGIS V) — "the expedition"

`id: scout` · livery `#ff6633` (burnt orange) · chassis `#222428` (graphite) ·
glow `#5cf2ff` (ice cyan) @1.4 · **codename AEGIS V**

**Handling made visible.** Heaviest (mass 220), lowest spring (22), lowest
surfaceFollow (0.4), **lowest hover height (0.8 m)**, biggest launch, punishing
late-reacting pump. So it should look **armored, ground-hugging, and built to
go where others won't** — this is where the *intrepid-explorer* fantasy
concentrates. The name AEGIS (a shield) is the cue: a repurposed
utility/recon machine, salvage-armored for the long haul.

- **Silhouette & proportions:** lowest and most planted — rides closest to the
  surface, a heavy skirted hull that hugs the water. Wide armored shoulders,
  the biggest thruster mass in the set, a blunt purposeful prow.
- **Hero features:** **expedition kit** — lashed-on salvage panniers, a rolled
  tarp, a roll-cage grab frame, a small dish/antenna, headlamp at the prow
  (legit emissive — it's powered). Bolted shield-plating with a stenciled
  "AEGIS V" / unit-number. Ice-cyan running lights against burnt orange.
- **Surface & salvage:** the most field-kitted, most *broken-salvage*-leaning of
  the set (still ~70/25/5) — mismatched bolted plates, patched welds — but kept
  battle-ready, not derelict.

```
[shared style block] +
heavy armored low-slung expedition hover-scout, ground-hugging skirted hull
riding close to the water, wide armored shoulders, biggest twin thrusters,
blunt purposeful prow with a powered headlamp, lashed-on salvage panniers and
rolled tarp, roll-cage grab frame, small antenna dish, bolted shield-plating
with stenciled unit number "AEGIS V", mismatched patched panels kept battle-
ready, burnt-orange bodywork, graphite chassis, ice-cyan running lights,
burnt orange (#ff6633) body, graphite (#222428) metal, ice cyan (#5cf2ff) glow
```

---

## Sparrow — "the feather"

`id: sparrow` · livery `#ddbb44` (mustard gold) · chassis `#1c1f1e` (charcoal) ·
glow `#fff088` (pale gold) @1.5

**Handling made visible.** Lightest (mass 80), stiffest spring (38), highest
surfaceFollow (1.05) and turn-torque (5.5), inside-drift, lowest damping: it
**springs off every crest**, forgiving, with a dramatic initial cut. So it
should look **small, lean, stripped, and bird-quick** — the name is the brief.

- **Silhouette & proportions:** the smallest, leanest, lightest read; a café-
  racer-of-the-sea. Thin forks, minimal fairing, exposed lightweight frame, a
  high taut stance (it springs). Swept-back wing-like fin — the sparrow tail.
- **Hero features:** stripped-to-essentials frame, a tiny aero cowl, slender
  twin thrusters, delicate swept fin reading like folded wings. Visibly the
  bike that weighs nothing.
- **Surface & salvage:** the most *stripped* salvage — anything non-essential
  removed for weight; bare honest panels, a single mustard livery wrap, pale-
  gold accents. Light, sun-bleached, fast.

```
[shared style block] +
tiny lean lightweight hover sport-bike, cafe-racer of the sea, stripped-to-
essentials exposed lightweight frame, thin forks, minimal aero cowl, slender
twin thrusters, delicate swept-back wing-like fin, high taut springy stance,
weighs almost nothing, bare honest panels, single mustard-gold livery wrap,
pale-gold accent glow, sun-bleached, mustard gold (#ddbb44) body,
charcoal (#1c1f1e) metal, pale gold (#fff088) glow
```

---

## Rider (light touch)

Per [art-direction.md](./art-direction.md), the explorer fantasy is carried
lightly and mostly by the bike. The rider is a **field-kitted Circuit explorer**:
a salvaged wet/drysuit, a chest harness, a helmet with a small prow-style
headlamp, scavenged pads — individual, not a uniform. Keep it readable as a
single confident silhouette at race distance; don't out-detail the bike. One
shared rider archetype with palette/livery tints per team is enough for v1 — no
per-bike bespoke rider.

---

## Quick reference — locked palettes

| Bike | id | Livery (body) | Chassis (metal) | Glow (accent) | Glow ✕ | Essence |
|---|---|---|---|---|---|---|
| Cruiser | `cruiser` | `#335599` steel-blue | `#1a1c20` | `#55aaff` cyan | 1.2 | freight |
| Racer | `racer` | `#ff7733` orange-red | `#222428` | `#ffaa55` gold | 1.4 | platonic |
| Stunt | `stunt` | `#33aa66` forest green | `#1c2620` | `#66ff99` lime | 1.6 | flick |
| Scout (AEGIS V) | `scout` | `#ff6633` burnt orange | `#222428` | `#5cf2ff` ice cyan | 1.4 | expedition |
| Sparrow | `sparrow` | `#ddbb44` mustard gold | `#1c1f1e` | `#fff088` pale gold | 1.5 | feather |

> Palettes recolor `mat_bike_<id>_livery / _chassis / _glow` at build time from
> [`specs/bikes/<id>.json`](../specs/bikes/) — see
> [asset-pipeline-guide.md](./asset-pipeline-guide.md). Change a colour there, no
> Blender round-trip needed. The stat profiles these looks dramatize live in
> [`src/game/bikes/variants.ts`](../src/game/bikes/variants.ts).

## References

- [art-direction.md](./art-direction.md) — the parent register, material-state
  rule, and glow/colour grammar this doc applies to bikes.
- [asset-pipeline-guide.md](./asset-pipeline-guide.md) — bike `.blend` → GLB
  pipeline, socket/collider requirements, recolor overrides.
- [props-production-plan.md](./props-production-plan.md) — image→3D suitability
  (keep hulls solid; thin parts fragment).
- [`src/game/bikes/variants.ts`](../src/game/bikes/variants.ts) /
  [`specs/bikes/`](../specs/bikes/) — the locked stats + palettes.
</content>
