# Shibuya Submerged — Art Target (Open Sea Cup visual pass)

> **What this is.** A visual build-target for Shibuya Submerged (Open Sea Cup #2,
> "the postcard that goes on the trailer"), from a Midjourney environment-concept
> pass (2026-06-01). No authored `.blend` yet — these are mood/material targets
> grounded in the design docs. When Shibuya is blocked out, this is the postcard
> to build toward; layout follows [tracks/shibuya-submerged.md](./shibuya-submerged.md),
> the *look* follows this doc.
>
> **Completes the Open Sea cup** with [the-maw](./the-maw-art-target.md). Downstream
> of [art-direction.md](../art-direction.md) and
> [track-art-direction.md](../track-art-direction.md#5-shibuya-submerged--urban-neon--60--25--15)
> (Shibuya = **Urban neon**, **60 built / 25 broken / 15 blooming** — the most
> *built* track, the neon showcase). This is the **first non-blue-water track** in
> the set: the palette swaps hard from sun-on-sea to **night neon**.

## Source material

- **Concept plates (curated best-of, 6 beats):**
  `C:\project-content\hoverbike\concept-art\midjourney\shibuya-submerged\best\`
  (`shibuya_hero_nightcity`, `_crossing_cables`, `_cocoon_cascade`,
  `_skyscraper_canyon`, `_rooftop_finish`, `_crossing_reflection`). Full 4-up grids
  in `_montage\`, raw cells (`<beat>_0..3.png`) in the parent folder,
  `CONTACT_SHEET.png` + `best\_BEST_STRIP.png`.
- **MJ prompt lane** (house lane, **night-neon grade** — no sun/water-grade words):
  `<concrete scene>; painterly cinematic concept art, retro-future post-apocalyptic
  solarpunk drowned-world hover-bike racing game, saturated night scene lit by
  hot-pink and electric-blue kanji neon, wet neon reflections on black flood water,
  Wipeout-bright not Akira-rainy, defiant party not abandoned ruin, bold colour
  blocking and clean stylized forms, Wind Waker meets Wipeout colour confidence,
  matte gouache key art --ar 16:9 --style raw --s 250 --no rain, grimdark, gritty
  gloom, cute, vinyl toy, chibi, smooth plastic, infantile, busy detail, text,
  watermark, wheels`. **Two deliberate negative changes vs the water tracks:** add
  `rain, grimdark, gritty gloom` (the brief is *defiant party, not Akira-rainy
  ruin*); **drop `glossy`** from the negative (wet neon reflections are core to the
  look). Bike beats add the hover-craft phrase + `--no wheels, tires`.

## The look in one line

**Drowned Tokyo at night, neon still on.** Shinjuku tops above black flood water,
**hot-pink and electric-blue kanji signage** reflected up through the water, the
Skytree silhouette on the backdrop. Saturated, *defiant, bright* — a party during
the collapse, not a Blade-Runner funeral. "Somebody is still paying the bill."

## Palette (Urban neon — night)

| Role | Hex | Use on Shibuya |
|---|---|---|
| Key light = **neon** | `#FF2E88` hot-pink + `#16E0FF` electric-blue | the neon *is* the light source; no sun |
| Water (dark) | `#0A1A2A` black flood | the flooded crossing/streets; a mirror for the neon |
| Built | `#2A3340` wet concrete + glass | skyscraper tops, rooftop bridges, the racing surface |
| Broken | `#3A4654` | the drowned crossing, collapsed Cocoon lattice, wet asphalt |
| Blooming | `#2F6E5A` | sparse — a little algae in the flooded streets below |
| Emissive | hot-pink + electric-blue + warm window `#FFD27A` | kanji neon, billboards, microgrid windows — *everything alive glows* |

Sky preset: **`tokyo_neon`** (night; the neon is the light source). Keep it
**saturated and bright** — Wipeout, not Akira. Neon glare intensifies across laps
(`emitter_neon_glare_*` rate doubles lap 3 — lights the underwater crossing
brighter).

## Material-state ratio: 60 built / 25 broken / 15 blooming

The most *built* track — the neon showcase. The city refused to die quietly.

- **Built (60):** lit skyscraper tops, kanji neon, rooftop generators/microgrids,
  narrow rooftop bridges, signage everywhere, the cable network. This is the
  60-percent that carries the postcard.
- **Broken (25):** the drowned Shibuya Crossing ten storeys below, the collapsed
  Cocoon lattice, wet asphalt on the rooftop sections.
- **Blooming (15):** sparse rooftop green, a little algae in the flooded streets.

## Per-beat build notes

Beats follow [shibuya-submerged.md](./shibuya-submerged.md) (loop + cable
set-piece + Cocoon climb, 58 s lap).

### 1 — Hero night-city · `shibuya_hero_nightcity`
The postcard: drowned Tokyo at night, Shinjuku tops above black flood water with
**neon still on**, a web of **powerline cables** strung over the flooded crossing,
the **Skytree** silhouette on the backdrop, reflections. **Build actions:**
- **Lock the Skytree + Mt. Fuji horizon ring first** — "the only Shibuya track in
  v1; the horizon has to *say* Tokyo." The cables strung across sell the set-piece
  location from the establishing shot.
- Neon discipline: *everything alive glows* (kanji signage, microgrid windows);
  the black flood water is the mirror.

### 2 — Crossing Cables · `shibuya_crossing_cables`  *(10–22 s, the set-piece)*
Hero set-piece: a hover-craft racing the **toppled neon signage + powerline
cables** across the flooded five-way Shibuya scramble, the kanji neon reflected up
through the dark water, **Hachiko patient on the seafloor**. **Build actions:**
- Build the **cable network mesh** (3 parallel ~30 m cables + toppled neon-signage
  planks bridging gaps, ~0.6 m collider so the bike doesn't slip) as the racing
  surface; the flooded crossing ~15 m below with `emitter_crossing_reflections`
  bouncing neon up toward the cables.
- **Hachiko** (`decoration`) on the seafloor, visible through the water shader.
- *Note:* MJ rendered the craft **skimming the flooded crossing** rather than
  literally up on the cables — treat the plate as mood (the neon-reflected crossing,
  the saturated billboards), not literal geometry; the cables are the racing
  surface per the track doc.

### 3 — Cocoon Cascade · `shibuya_cocoon_cascade`  *(22–34 s, the climb)*
Ride the **Cocoon Tower's collapsed diagonal exo-lattice** as a steep ramp
up-and-over to the next rooftop, hot-pink neon glow below, lit window ledges.
**Build actions:**
- Build the **Cocoon Cascade** ramp (~80 m run, collapsed diagonal lattice;
  window-ledge obstacles ~2 m proud forcing a snaking line) — **normal-gravity
  ramp, not a wall-ride** (the cut anti-grav banked-strip is retired).
- `emitter_cocoon_window_light` on random ledges — the building still has power.
- Music shifts to higher BPM here; the art shifts to the vertical lattice silhouette.

### 4 — Skyscraper canyon · `shibuya_skyscraper_canyon`  *(34–46 s)*
Thread between neon tower tops: a **rooftop-bridge path** and a **flooded
water-channel path**, kanji signage on every face, high-altitude haze. **Build
actions:**
- Build the branch: `road_curve_main` rooftop-bridge slab (banked at the corner)
  vs the water-channel below. The plate shows both — the bridge crossing over the
  channel the bike threads.
- `emitter_skyscraper_haze` up high; neon signage on every tower face.

### 5 — Rooftop finish · `shibuya_rooftop_finish`  *(46–58 s, finish straight)*
A wide **wet neon rooftop finish straight**, signage + a finish gate, the neon
skyline and Skytree beyond, puddle reflections. **Build actions:**
- Wet asphalt rooftop (the racing surface = building *tops*, raised to sea level);
  puddle reflections of the neon are the signature. Skytree silhouette closes the loop.

### 6 — Crossing reflection · `shibuya_crossing_reflection`
The *signature effect* (per art-direction, "light the underwater neon reflection
as a hero effect"): brilliant kanji neon from the towers reflected and refracted in
the dark flood water of the crossing, Hachiko dim on the seafloor. **Build
actions:**
- This is the **water-shader hero shot** — `emitter_crossing_reflections` +
  the neon emissive bouncing in the black water. Match the plate (reflection cell
  0): mirror-clean neon reflections, the crossing walkways + Hachiko faint below.

## Build order (what to do first to hit the target)

1. **Skytree + Mt. Fuji horizon ring + the neon palette** — the horizon must say
   Tokyo; the hot-pink/electric-blue neon is the whole light model.
2. **Crossing + neon-reflection water shader** (beat 6 effect) — the underwater
   neon reflection is the postcard; build it early, it carries the track.
3. **Cable network set-piece** (beat 2) — cables + toppled signage over the crossing.
4. **Cocoon Cascade** ramp (beat 3) — collapsed diagonal lattice, normal gravity.
5. **Rooftop bridges + water channels** (beat 4) + the finish straight (beat 5).
6. **Neon life** — glare emitters (double lap 3), microgrid windows, haze. Motion
   in the neon flicker sells "the bill is still being paid."

> Built-dominant: spend density on **signage + lit windows**, not foliage. Keep the
> racing line (cables / ramp / rooftop) readable against the neon riot.

## References
- [shibuya-submerged.md](./shibuya-submerged.md) — the track (beats, props, palette).
- [the-maw-art-target.md](./the-maw-art-target.md) — Open Sea cup sister.
- Reef cup: [mexico-city](./mexico-city-art-target.md) · [cape-town](./cape-town-drift-art-target.md) · [hatteras](./hatteras-light-art-target.md) · [sandbar](./sandbar-art-target.md).
- [track-art-pass-playbook.md](../track-art-pass-playbook.md) — placement / re-export.
- [art-direction.md](../art-direction.md) — register, material-state rule, waterline trio, palette appendix.
