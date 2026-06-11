# Kilauea Crown — Art Target (Continental Cup visual pass)

> **What this is.** A visual build-target for Kilauea Crown (Continental Cup
> closer — the single-lap volcano descent), from a Midjourney environment-concept
> pass (2026-06-01). No authored `.blend` yet — mood/material targets grounded in
> the design docs. Layout follows [tracks/kilauea-crown.md](./kilauea-crown.md),
> the *look* follows this doc. **Completes the Continental cup.**
>
> Downstream of [art-direction.md](../art-direction.md) and
> [track-art-direction.md](../track-art-direction.md#9-kilauea-crown--volcanic-outlier--0--20--80)
> (Kilauea = **Volcanic outlier**, **0 built / 20 broken / 80 blooming** — its own
> grade; "blooming" here = primal *creation*, the mountain still building).

## Source material

- **Concept plates (curated best-of, 6 beats):**
  `C:\project-content\hoverbike\concept-art\midjourney\kilauea-crown\best\`
  (`kilauea_hero_volcano`, `_windward_climb`, `_caldera_rim`, `_black_beach`,
  `_descent_finish`, `_lava_ocean`). Grids in `_montage\`, raw cells in the parent
  folder, `CONTACT_SHEET.png` + `best\_BEST_STRIP.png`.
- **MJ prompt lane** (house lane, **volcanic grade**):
  `<scene>; … glowing orange-red lava and black basalt, white steam plumes,
  volcanic-blue crater lake, lush green windward rainforest, blue sky, lava the
  only emissive, bold colour blocking and clean stylized forms, Wind Waker meets
  Wipeout colour confidence, matte gouache key art, primal and alive --ar 16:9
  --style raw --s 250 --no … wheels`. *Wheels watch:* the banked-rim "riding" beat
  pulled a hard **motorbike** prior (3 of 4 cells) — picks are the clean
  hover-craft cells; keep the hover phrase + `--no wheels` on re-rolls.

## The look in one line

**Orange lava against blue ocean and sky** — an actively erupting volcano risen as
the new high ground, glowing lava and black basalt, towering white steam where it
meets the sea, lush green windward rainforest below. *Primal creation, not decay*
— the most saturated colour-contrast track in the set. "Pele kept building."

## Palette (Volcanic outlier — its own grade)

| Role | Hex | Use |
|---|---|---|
| Lava (emissive) | `#FF4D1A` orange-red | the privileged emissive — lava lake, waterfall, glowing cracks |
| Basalt | `#1A1714` near-black | the slopes, the cooled rock, the black-sand beach |
| Steam | `#F2F4F3` white | towering plumes where lava meets ocean — the "spray" of this track |
| Crater lake | `#2E7E9E` volcanic blue | the caldera lake; also the ocean below |
| Windward green | `#3E7A3A` lush | the rainforest + palms at the sea-level beach |
| Sky / ocean | `#2E6FA8` blue | the cool field the lava pops against |

Sky preset: **`kilauea_volcanic`** (lava reads orange against blue). Lava is the
**only privileged emissive** — let it glow under the blue sky; bloom the steam.
Section-3 crescendo lighting at the lava waterfall.

## Material-state ratio: 0 built / 20 broken / 80 blooming

- **Built (0):** none — the mountain is the new high ground, untouched by the
  Circuit beyond the racing line.
- **Broken (20):** old lava fields, cooled basalt, weathered rock.
- **Blooming (80):** the dominant — active lava (emissive), the lush windward
  forest, steam plumes, the volcanic-blue lake. **Life and fire, not decay.**

## Per-section build notes

Single-lap descent in three sections (Mount Wario template — non-loopable).

### Hero · `kilauea_hero_volcano`
Establishing: the actively erupting volcano risen above the drowned lowlands, the
caldera + glowing lava, lush green slopes, the new ocean below. Lock `terrain_island`
(tall central peak + crater, base ~800 m) + the **Maui/Mauna Kea horizon ring**;
lava the emissive glow.

### Section 1 — Windward climb · `kilauea_windward_climb`  *(0–45 s)*
Climb from a black-sand beach up the slope through sparse green rainforest, glowing
boost-pads, sparse palms at the shoreline, the blue ocean below. Build the
windward `road_curve_main` ridge roads + lava-field shelves; `scatter_palms` at
sea level only (~20), `scatter_rocks` heavy + dark on the slope (~80).

### Section 2 — Caldera rim · `kilauea_caldera_rim`  *(45–105 s, the hard section)*
Ride the **banked inside rim of the caldera** like a velodrome, the glowing
orange-red lava lake ~200 m below, heat haze. **Build actions:**
- `caldera_rim_road` = a **banked terrain berm, ≤45°**, full circle — ridden at
  normal gravity (the cut anti-grav wall-ride is retired). Continuous banked
  cornering, lava lake the failure consequence below. `emitter_caldera_haze` heat
  shimmer. The pick is the clean wheelless hover-craft on the bank.

### Section 3a — The Black Beach · `kilauea_black_beach`  *(105–150 s, the set-piece)*
Hero set-piece: ride **alongside** a colossal lava waterfall pouring molten rock
straight into the ocean, exploding into towering white steam. **Build actions:**
- The lava waterfall ridge (`kind=track`); the lava itself is decoration
  (orange-emissive, shader-panned UV). `emitter_lava_waterfall_*` (embers + steam,
  5+ empties) + `emitter_steam_explosion` at the lava-meets-ocean point, synced to
  the audio cue. The plate (cell 2) is the read — waterfall + steam + hover-craft
  skimming alongside, *not through* the lava.

### Section 3b — Descent finish · `kilauea_descent_finish`  *(to the finish)*
Steep leeward descent on a single black basalt ridge to the black-sand-beach finish
at sea level, the lava waterfall + steam to one side, ocean ahead. Build the
`Black Beach finish` plinth at sea level; **pros take the waterfall side** — frame
the set-piece on that line.

### Detail — Lava meets ocean · `kilauea_lava_ocean`
The *spec image* — **the most dramatic waterline in the set**: molten orange-red
lava chilling to black basalt crust at the waterline, explosive white steam, glowing
cracks in the new black rock, volcanic-blue water. The steam *is* the spray; the
lava-to-basalt chill *is* the waterline. No kelp/barnacle trio here — this shoreline
is being *born*.

## Build order

1. **`terrain_island` peak + caldera + the lava emissive** — the volcano silhouette
   and the privileged orange glow; the whole track is lit by it.
2. **Lava waterfall + steam emitters** (the set-piece) — build + light first; the
   Section-3 crescendo is the payoff.
3. **Banked `caldera_rim_road`** (Section 2) — normal-gravity berm, ≤45°.
4. **Windward climb** ridges + boost-pads + sparse palms/rock scatter.
5. **Lava-meets-ocean waterline** (steam + chill-to-basalt) on the leeward base.
6. **Primal life** — ash drift, heat haze, steam explosions, the lava grumble glow.

> Single-lap (`singleLap: true`). Lava is the only emissive; let the orange-vs-blue
> contrast carry every frame — it's the most saturated track in the v1 set.

## References
- [kilauea-crown.md](./kilauea-crown.md) — the track (sections, props, palette).
- Sister passes: [marina-bay-7](./marina-bay-7-art-target.md) · [doges-drift](./doges-drift-art-target.md) · [golden-gate-drowned](./golden-gate-drowned-art-target.md) · [the-maw](./the-maw-art-target.md) · [shibuya](./shibuya-submerged-art-target.md) · Reef ([mexico-city](./mexico-city-art-target.md) · [cape-town](./cape-town-drift-art-target.md) · [hatteras](./hatteras-light-art-target.md) · [sandbar](./sandbar-art-target.md)).
- [art-direction.md](../art-direction.md) — register, material-state rule, waterline trio.
