# Marina Bay 7 — Art Target (Continental Cup visual pass)

> **What this is.** A visual build-target for Marina Bay 7 (Continental Cup #1,
> industrial obstacle racing), from a Midjourney environment-concept pass
> (2026-06-01). No authored `.blend` yet — mood/material targets grounded in the
> design docs. Layout follows [tracks/marina-bay-7.md](./marina-bay-7.md), the
> *look* follows this doc. **First Continental cup pass.**
>
> Downstream of [art-direction.md](../art-direction.md) and
> [track-art-direction.md](../track-art-direction.md#6-marina-bay-7--urban-neon-industrial-grade--50--40--10)
> (Marina Bay 7 = **Urban neon, industrial grade**, **50 built / 40 broken / 10
> blooming** — built-but-filthy, running machinery in an oxidised harbour).

## Source material

- **Concept plates (curated best-of, 6 beats):**
  `C:\project-content\hoverbike\concept-art\midjourney\marina-bay-7\best\`
  (`marina_bay_hero_port`, `_container_streets`, `_the_gauntlet`, `_freighter_deck`,
  `_finish`, `_waterline_detail`). Grids in `_montage\`, raw cells in the parent
  folder, `CONTACT_SHEET.png` + `best\_BEST_STRIP.png`.
- **MJ prompt lane** (house lane, **industrial-dusk grade**):
  `<scene>; … industrial drowned megaport, orange shipping containers and grey
  steel gantry cranes, murky brown-green harbour water, oxidised hull reds, warm
  sodium-lamp glow, overcast industrial dusk, bold colour blocking and clean
  stylized forms, Wind Waker meets Wipeout colour confidence, matte gouache key
  art, running machinery not dead ruin --ar 16:9 --style raw --s 250 --no grimdark,
  gritty gloom, cute, vinyl toy, chibi, smooth plastic, glossy, infantile, busy
  detail, text, watermark, wheels`. Keep `--no grimdark, gritty gloom` — it's the
  grittiest track but the rule is *still no grimdark, keep colour*.

## The look in one line

**Built-but-filthy.** Orange container canyons and grey-steel gantry cranes still
running on solar, murky brown-green harbour water, **warm sodium-lamp glow** the
only warm note against an overcast industrial dusk. The port automated itself and
nobody told it to stop — *running machinery, not dead ruin.*

## Palette (Urban neon — industrial grade)

| Role | Hex | Use |
|---|---|---|
| Containers (built) | `#D2691E` orange | the stacks — the signature colour mass |
| Steel (built) | `#6B7A78` grey-teal | gantry cranes, the supertanker superstructure |
| Water (murky) | `#3C4A3A` brown-green | the flooded shipping channel; oily sheen |
| Broken | `#8A3B23` oxidised red | rust-bleed on hulls + containers |
| Blooming | `#4E6A4A` | sparse — barnacle/algae crust at the waterline only |
| Emissive | warm `#FFB23E` sodium | crane lamps, freighter windows — the only warm light |

Sky preset: **`singapore_industrial`** (new preset); overcast dusk, sodium-lamp
warmth. Low pump-duck — pumping is minor here; the obstacle timing is the skill.

## Material-state ratio: 50 built / 40 broken / 10 blooming

- **Built (50):** gantry cranes still running, container stacks, sodium lighting,
  the automated systems that won't quit.
- **Broken (40):** oxidised hull reds, the beached supertanker, rust streaks,
  murky brown-green water.
- **Blooming (10):** harbour algae + barnacle crust — minimal, it's an industrial zone.

## Per-beat build notes

### 1 — Hero port · `marina_bay_hero_port`
Aerial establishing: the drowned Tuas megaport — grids of half-submerged orange
container stacks, grey gantry cranes, a beached supertanker, warm sodium pockets.
Lock the **crane silhouettes + container colour-mass** + the tanker as the
centrepiece; murky brown-green water threading the stacks.

### 2 — Container streets · `marina_bay_container_streets`  *(10–22 s, the chicane)*
A racing lane down a canyon of towering orange container stacks, tight chicane.
Build ~25 `prop_container` stacks (mixed orientations, some half-submerged) as the
canyon walls; keep the chicane line readable. Warm sodium reflections on the water.

### 3 — The Gauntlet · `marina_bay_the_gauntlet`  *(22–34 s, the set-piece)*
Hero set-piece: five gantry cranes swinging orange containers across the lane at
chest height; the bike ducks under. **Build actions:**
- Build the 5 gantry cranes (~40 m) + `crane_NN_swing_load` animated containers on
  a fixed timer (glTF animation channels). The plate (cell 0) is the read — a
  container swung **across the lane**, the bike ducking beneath.
- `emitter_crane_sodium_lamp_*` warm-yellow at each crane top makes the swinging
  steel legible — the swing timing must read 4–5 s ahead.

### 4 — Freighter deck · `marina_bay_freighter_deck`  *(34–44 s, the shortcut)*
The bike launches onto the flat deck of the beached oxidised-red supertanker (the
shortcut + pickup-denial zone), rusty wheelhouse + faintly smoking funnel above.
Build the ~120 m hull with the deck raised ~8 m; `emitter_freighter_smoke` at the
funnel — *the ship still smokes faintly.*

### 5 — Finish · `marina_bay_finish`  *(44–55 s, gauntlet finish)*
Two more cranes (faster timers) + the finish gate, container stacks and tanker
beyond, warm sodium glow against the overcast dusk. The backlit crane silhouette
is the strong closing image.

### 6 — Waterline detail · `marina_bay_waterline_detail`
The *spec image*: the heaviest, most industrial waterline in the set — a
half-submerged oxidised container/hull meeting murky water:
1. **Algae fringe** below the line (sparse). *Blooming.*
2. **Oily barnacle + mussel crust** at the line. *Broken.*
3. **Rust-bleed streaks + salt-bleach** above, weathered steel; oily sheen on the water.

## Build order

1. **Crane silhouettes + container colour-mass + tanker** — the three identity
   shapes; lock them before dressing.
2. **Water + sky grade** — `singapore_industrial` overcast dusk, murky brown-green
   water, warm sodium pockets.
3. **The Gauntlet** (beat 3) — 5 cranes + animated swinging loads; the set-piece.
4. **Container-canyon chicane** (beat 2) + the freighter shortcut (beat 4).
5. **Heavy industrial waterline** (rust/oil/barnacle) on every hull + container.
6. **Running-machinery life** — crane motion, funnel smoke, sodium flicker, gulls.

> Built-dominant + filthy: spend density on **steel + containers + rust**, almost
> no foliage. Keep the chicane/gauntlet line readable through the container canyon.

## References
- [marina-bay-7.md](./marina-bay-7.md) — the track (beats, props, palette).
- Sister passes: Open Sea ([the-maw](./the-maw-art-target.md) · [shibuya](./shibuya-submerged-art-target.md)); Reef ([south-beach](./south-beach-sunken-art-target.md) · [cape-town](./cape-town-drift-art-target.md) · [hatteras](./hatteras-light-art-target.md) · [sandbar](./sandbar-art-target.md)).
- [art-direction.md](../art-direction.md) — register, material-state rule, waterline trio.
