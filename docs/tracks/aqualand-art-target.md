# Aqualand — Art Target (Drowned Cup visual pass)

> **What this is.** A visual build-target for Aqualand (Drowned Cup #1 — the chaos
> slot, a doubly-drowned waterpark), from a Midjourney environment-concept pass
> (2026-06-01). No authored `.blend` yet — mood/material targets grounded in the
> design docs. Layout follows [tracks/aqualand.md](./aqualand.md), the *look*
> follows this doc. **First Drowned cup pass.**
>
> Downstream of [art-direction.md](../art-direction.md) and
> [track-art-direction.md](../track-art-direction.md#10-aqualand--waterpark-outlier--30--45--25)
> (Aqualand = **Waterpark outlier**, **30 built / 45 broken / 25 blooming** — its
> own faded-primary grade; *trashy, funny, sun-bleached* — the Circuit thinks this
> is hilarious and the art should too).

## Source material

- **Concept plates (curated best-of, 6 beats):**
  `C:\project-content\hoverbike\concept-art\midjourney\aqualand\best\`
  (`aqualand_hero_park`, `_lazy_river`, `_the_tsunami`, `_half_pipe`,
  `_concourse_finish`, `_waterline_detail`). Grids in `_montage\`, raw cells in the
  parent folder, `CONTACT_SHEET.png` + `best\_BEST_STRIP.png`.
- **MJ prompt lane** (house lane, **faded-waterpark grade**):
  `<scene>; … drowned Florida waterpark, faded sun-bleached primary colours, algae
  greens, pool-tile blue through grime, trashy and funny not bleak, bold colour
  blocking and clean stylized forms, Wind Waker meets Wipeout colour confidence,
  matte gouache key art, cheerful decay --ar 16:9 --style raw --s 250 --no
  grimdark, gritty gloom, … wheels`. Keep `--no grimdark, gritty gloom` — the tone
  is *cheerful trashy decay*, not ruin-porn.

## The look in one line

**Trashy and cheerful.** A doubly-drowned Florida waterpark — faded sun-bleached
primary-colour slides and fiberglass tubes now holding the actual ocean, tilted
lifeguard towers with glowing countdown signs, **algae green over pool-tile blue**.
The wave generator never got turned off. Bad-Hawaiian-shirt energy.

## Palette (Waterpark outlier — faded primary)

| Role | Hex | Use |
|---|---|---|
| Faded primaries | `#E08A2E` orange + `#D8C24A` yellow + `#C24A3E` red | the slides, tubes, lifeguard towers — *sun-bleached*, not bright |
| Pool-tile blue | `#3FA8C8` | the signature — pool tile peeking through grime |
| Algae green | `#5E8A4E` | over everything at and below the waterline |
| Water | `#4E9E96` murky teal | the flooded pools + the ocean they now hold |
| Sun-bleach | `#D8D2C2` | the chalky bleached plastic + concrete |
| Emissive | warm `#FF5A3C` countdown | the lifeguard-tower digital countdown sign — the one glow |

Sky preset: **`miami_pastel` (faded)**. Keep the faded primaries *cheerful*, never
bleak — the bright pool-tile blue through grime is the signature read.

## Material-state ratio: 30 built / 45 broken / 25 blooming

- **Built (30):** the still-running wave generator, the half-pipe slide, lifeguard
  towers (at angles), the PA system still cycling snack-bar ads.
- **Broken (45):** sun-bleached faded plastic, algae everywhere, locker rooms full
  of crab nests, grime over the bright pool tile.
- **Blooming (25):** algae greens, crab/sea-life nests, pool-life in the flooded basins.

## Per-beat build notes

Beats follow [aqualand.md](./aqualand.md) (5-lap chaos arena, 22 s lap, per-lap
escalating surge).

### 1 — Hero park · `aqualand_hero_park`
Aerial establishing: the doubly-drowned waterpark — faded slides + pools holding
the ocean, tilted lifeguard towers, the big wave pool at the centre, sun-bleached
palms. Lock the **wave-pool bowl + the tilted lifeguard tower silhouette** as the
read; faded primaries over algae teal.

### 2 — Lazy river · `aqualand_lazy_river`  *(0–6 s, opener)*
Rush through the still-running lazy-river fiberglass tube tunnels — faded
primary-colour fiberglass streaked with algae, pool-tile blue water. Build
`tunnel_curve_main` (radius 5) as the U-shaped lazy-river footprint; the big orange
tube-rings are the iconography.

### 3 — The Tsunami · `aqualand_the_tsunami`  *(6–11 s, the set-piece)*
Hero set-piece: the wave pool's escalating surge — a big artificial tsunami wave, a
hover-craft riding up the face toward the **banked pool-bowl rim**, the tilted
lifeguard tower with its **glowing digital countdown** tracking the next surge.
**Build actions:**
- `bowl_rim_berm` (banked ≤45° half-arc on the wave-pool's upper rim) — the lap-3+
  mandatory high line; always present. `emitter_tsunami_spray` burst on every surge
  crest. The countdown sign is the warm emissive cue (animated UV). The plate (cell
  0) is the read — surge wave + countdown tower + craft.
- The surge escalates per lap (1.5 → 3.0 → 5.0 m) — the art should make the wave
  read *big and growing*.

### 4 — Half-pipe · `aqualand_half_pipe`  *(11–17 s)*
Drop down a faded curved half-pipe water-slide — sun-bleached primary fiberglass
streaked with algae, a brief steep drop, pool-tile blue at the base. Single curved
mesh ~20 m, ~6 m drop, smooth interior.

### 5 — Concourse finish · `aqualand_concourse_finish`  *(17–22 s, finish)*
A finish straight along the faded main concourse — past the tilted lifeguard tower,
shuttered **snack-bar and locker buildings** (the PA still cycling ads), sun-bleached
palms. The snack-bar signage is the trashy-cheerful character note.

### 6 — Waterline detail · `aqualand_waterline_detail`
The *spec image*: faded sun-bleached primary plastic meeting algae-green pool water,
the **bright pool-tile blue peeking through the grime** — the signature read:
1. **Algae + pool-life** below the line. *Blooming.*
2. **Grime + algae band** at the line. *Broken* — but keep the colour cheerful.
3. **Sun-bleach band** just above on the faded plastic; pool-tile blue showing through.

## Build order

1. **Wave-pool bowl + tilted lifeguard tower + the slide/tube kit** — the waterpark
   identity shapes.
2. **Water + sky grade** — faded `miami_pastel`, murky teal pools, algae over
   pool-tile blue.
3. **The Tsunami** (beat 3) — the surge + `bowl_rim_berm` + countdown emissive; the
   per-lap escalation is the set's destructible-layout representative.
4. **Lazy-river tubes + half-pipe** (beats 2, 4).
5. **Algae/grime waterline** on every faded-plastic surface (the signature).
6. **Trashy life** — chlorine haze, palm decay, surge spray, the PA-ad countdown glow.

## References
- [aqualand.md](./aqualand.md) — the track (beats, props, surge config).
- Sister Continental/Open Sea/Reef passes — see [the index in track docs](./README.md).
- [art-direction.md](../art-direction.md) — register, material-state rule, waterline trio.
