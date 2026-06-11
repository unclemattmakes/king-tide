# Golden Gate Drowned — Art Target (Continental Cup visual pass)

> **What this is.** A visual build-target for Golden Gate Drowned (Continental Cup
> #3 — the track that proved the no-anti-grav, *land-as-frozen-waves* direction),
> from a Midjourney environment-concept pass (2026-06-01). No authored `.blend`
> yet — mood/material targets grounded in the design docs. Layout follows
> [tracks/golden-gate-drowned.md](./golden-gate-drowned.md), the *look* follows
> this doc.
>
> Downstream of [art-direction.md](../art-direction.md) and
> [track-art-direction.md](../track-art-direction.md#8-golden-gate-drowned--urban-neon-fog-grade--45--40--15)
> (Golden Gate = **Urban neon, fog grade**, **45 built / 40 broken / 15 blooming**
> — fog as a mechanic, hills as frozen waves).

## Source material

- **Concept plates (curated best-of, 6 beats):**
  `C:\project-content\hoverbike\concept-art\midjourney\golden-gate-drowned\best\`
  (`golden_gate_hero_bay`, `_downtown_canyon`, `_hills`, `_the_break`,
  `_bay_return`, `_fog_signature`). Grids in `_montage\`, raw cells in the parent
  folder, `CONTACT_SHEET.png` + `best\_BEST_STRIP.png`.
- **MJ prompt lane** (house lane, **fog grade**):
  `<scene>; … drowned San Francisco, International-Orange bridge steel in fog, bay
  steel blue-green water, white-grey marine-layer fog in volume, warm low sun,
  survivor microgrid warm lights, bold colour blocking and clean stylized forms,
  Wind Waker meets Wipeout colour confidence, matte gouache key art, defiant not
  mournful --ar 16:9 --style raw --s 250 --no … wheels`. *Wheels watch:* the SF
  hill-street beats can pull a motorbike prior — the picks are the clean
  hover-craft cells; keep the hover phrase + `--no wheels` on re-rolls.

## The look in one line

**Fog is the protagonist.** International-Orange bridge steel and drowned FiDi
tower-tops (Salesforce, Transamerica) rising from a steel blue-green bay, the
**white-grey marine layer rolling in volume**, warm low sun breaking through — and
**the hills surfed like frozen swell.** "The bridge outlasted the coastline too."

## Palette (Urban neon — fog grade)

| Role | Hex | Use |
|---|---|---|
| Bridge steel | `#C0410E` International Orange | the Golden Gate silhouette — the one saturated accent in the fog |
| Fog | `#C9D2D0` white-grey | the marine layer, rendered as **volume** — the identity |
| Water (cool) | `#3A6B6E` bay steel blue-green | the flooded canyons + open bay |
| Built | `#7E8A8C` glass/concrete | drowned FiDi towers, hill row-houses |
| Emissive | warm `#FFC24D` microgrid | survivor windows + canyon vents — warm dots in the cold fog |
| Blooming | `#3E6B5A` | kelp + bay life in the flooded grid, hillside green (sparse) |

Sky preset: **`golden_gate_fog`** (or warmed `cape_town_blue` fallback). **The fog
is animated** — oscillate `fogNear` 150↔40 / `fogFar` 700↔250 on a ~18 s world
timer (not lap-keyed), so each lap sees both thick + cleared states. Telegraphed,
never blinding — edge-lights + the wave-line stay visible.

## Material-state ratio: 45 built / 40 broken / 15 blooming

- **Built (45):** the hill survivors with warm microgrid lights (Nob/Russian/
  Telegraph), the bridge silhouette, Coit/Sutro towers — the dry-land party.
- **Broken (40):** the drowned Financial District, Salesforce + Transamerica rising
  from flooded canyons, the streets-turned-canals.
- **Blooming (15):** kelp + bay life in the flooded grid, hillside green.

## Per-beat build notes

### 1 — Hero bay + FiDi · `golden_gate_hero_bay`
Establishing: the drowned Financial District towers rising from the foggy steel
blue-green bay, the **International-Orange bridge silhouette** behind, hills above.
Lock the **bridge silhouette + the Salesforce/Transamerica tower-tops + Sutro
Tower** as the skyline reads; depth-tint the bay vs the flooded canyon floors.

### 2 — Downtown canyon · `golden_gate_downtown_canyon`  *(14–28 s, the tight section)*
Thread the flooded skyscraper grid — narrow walled "street-canals" of blue-green
water between half-submerged glass towers, fog drifting between them, warm
microgrid window lights. Build the `downtown_NN` towers (lower floors capped below
the waterline) + the drowned street grid; clip the walls = damage. `emitter_
canyon_steam` at a warm survivor vent.

### 3 — The hills · `golden_gate_hills`  *(28–44 s, the frozen waves)*
**The template beat:** a hover-craft surfs up the back of a steep SF street that
rises from the bay *like a frozen wave*, pastel row-houses on the crest, catching
air off the top, the bridge + drowned skyline behind. **Build actions:**
- The hills are a **frozen-swell heightfield** (displace a plane with the *same*
  swell-profile as the bay) — you surf up the back and launch off the crest, the
  same gesture you pump on water. +40–70 m hills, windward face ramping from the
  waterline. The plate (cell 0) is the target — craft climbing the street, bridge behind.

### 4 — The Break · `golden_gate_the_break`  *(44–52 s, the set-piece)*
Hero set-piece: crest the steepest near-vertical street where the road plunges
straight into the bay, the craft **airborne over the fallen city + drowned
tower-tops spread below through fog**, then a big splashdown. "The frozen wave
breaking into the real one." **Build actions:**
- Terrain-only cliff drop (part of the hill landmass); light the crest warm, the
  drop cool-and-foggy. `emitter_bay_spray` at the splashdown. The plate (cell 0) is
  the read — clean hover-craft over the drowned foggy city.

### 5 — Bay return · `golden_gate_bay_return`  *(52–58 s, finish)*
A low open-water run across the bay back to start, **Alcatraz** + the
International-Orange bridge a silhouette in the marine-layer fog, warm low sun.
Build Alcatraz as the low turn-island; the bridge is a decoration silhouette near
the horizon ring (not a raced surface).

### 6 — The fog · `golden_gate_fog_signature`
The *signature spec image*: **Karl as volume** — the white-grey marine layer
swallowing the gate, the bridge silhouette half-dissolved, warm low sun through it.
This is the track's identity (`emitter_fog_bank`, ~3 empties drifting east). Build
the fog as animated volume, not a flat overlay; the drowned tower bases get a
kelp/crust waterline where the bay reclaimed the grid (the hills stay dry above).

## Build order

1. **Bridge silhouette + drowned-tower skyline + the hill landmass** (frozen-swell
   heightfield) — the three identity shapes.
2. **The animated fog volume** — the signature; build + tune the ~18 s tide early,
   it carries the whole track.
3. **The Break + the hills** (beats 3–4) — the frozen-wave terrain verticality.
4. **Downtown canyon** (beat 2) — flooded grid + microgrid lights.
5. **Waterline** (kelp/crust) on the drowned tower bases; hills dry above.
6. **Warm life in the cold** — microgrid windows, canyon steam, bay spray, gulls.

## References
- [golden-gate-drowned.md](./golden-gate-drowned.md) — the track (beats, props, fog config).
- Sister passes: [marina-bay-7](./marina-bay-7-art-target.md) · [doges-drift](./doges-drift-art-target.md) · [the-maw](./the-maw-art-target.md) · [shibuya](./shibuya-submerged-art-target.md) · Reef ([mexico-city](./mexico-city-art-target.md) · [cape-town](./cape-town-drift-art-target.md) · [hatteras](./hatteras-light-art-target.md) · [sandbar](./sandbar-art-target.md)).
- [art-direction.md](../art-direction.md) — register, material-state rule, waterline trio.
