# South Beach Sunken — Art Target (Reef Cup visual pass)

> **What this is.** A visual build-target for the South Beach Sunken track (Reef
> Cup #1), derived from a Midjourney environment-concept pass (2026-06-01) that
> pushes the *look* to near-shipping. Unlike the Sandbar pass there is **no
> authored `.blend` yet** to pin the plates to — these are pure mood/material
> targets grounded in the design docs. When South Beach is blocked out, this is
> the postcard to build toward; the layout follows
> [tracks/south-beach-sunken.md](./south-beach-sunken.md), the *look* follows
> this doc.
>
> **This doc is downstream of** [art-direction.md](../art-direction.md) (register,
> material-state rule, waterline trio) and
> [track-art-direction.md](../track-art-direction.md#1-south-beach-sunken--reef-pastel--45--15--40)
> (South Beach = Reef pastel, **45 built / 15 broken / 40 blooming**). It does not
> change lore, palette, or layout — it shows how to *apply* them here. Pairs with
> the Sandbar pass [sandbar-art-target.md](./sandbar-art-target.md), which set the
> Reef-pastel house look first.

## Source material

- **Concept plates (curated best-of, 6 beats):**
  `C:\project-content\hoverbike\concept-art\midjourney\south-beach-sunken\best\`
  (`south_beach_hero_aerial`, `_rooftop_chain`, `_versace_steps`, `_pool_deck`,
  `_lifeguard_finish`, `_waterline_detail`). Full 4-up grids sit in `_montage\`,
  the raw cells (`<beat>_0..3.png`) in the parent folder, and a combined
  `CONTACT_SHEET.png` + a `best\_BEST_STRIP.png` at the top.
- **MJ prompt lane** (reproducible — same lane as Sandbar, restyled to Miami):
  `<concrete scene>; painterly cinematic concept art, retro-future
  post-apocalyptic solarpunk drowned-world hover-bike racing game, warm pastel
  pink sunset on cool turquoise water, bold colour blocking and clean stylized
  forms, Wind Waker meets Wipeout colour confidence, matte gouache key art,
  defiant and alive not mournful --ar 16:9 --style raw --s 250 --no cute, vinyl
  toy, chibi, smooth plastic, glossy, infantile, busy detail, text, watermark,
  wheels`. (Never say "toy" to MJ — it renders vinyl figurines; "retro-future" is
  the on-brand word. On the bike beat add the hover-craft magic phrase + `--no
  wheels, tires, jet-ski sitting in the water, hull half-submerged`.)

## The look in one line

Golden-hour **sunset pink-and-mint sky** over **glassy turquoise reef shallows**;
a permanent rooftop spring-break on pastel Art-Deco hotels that refuse to go
under — the most *defiantly-alive* shoreline in the set. Decay is one salt-bleach
band and the half-buried seaplane — no more.

## Palette (Reef pastel — sample by role)

| Role | Hex | Use on South Beach |
|---|---|---|
| Sky / key (warm) | `#FF8FB1` → peach | sunset flamingo-pink gradient, the master warm |
| Water (cool) | `#2FC6C2` | turquoise reef shallows; deep teal off the channel drop-offs |
| Built | `#F3D9C0` / pastel | Art-Deco stucco — repaint pink, cream, mint, butter-yellow |
| Broken | `#A9B4AE` | the single salt-bleach band, the half-buried seaplane skin |
| Blooming | `#3DA35D` | rooftop palms, turquoise reef + coral under the shallows |
| Emissive | `#6CFFC8` neon-mint (+ warm `#FFC24D` string-lights) | hotel signage, rooftop bar string-lights — **only** powered things glow |

Sky preset: the track design calls for **`miami_pastel`** sky; grade to sunset
golden hour (the plates are all end-of-afternoon pink). Keep the pastel
saturation *up* — this is the brightest, friendliest grade in the Reef cup.

## Material-state ratio: 45 built / 15 broken / 40 blooming

All three must read in the hero framing. South Beach leans **built + blooming**
with almost no decay — "they kept the lights on."

- **Built (45):** pastel Art-Deco hotel rooftops kept painted and lit — neon-mint
  signage, warm string-lights, rooftop bars, the lifeguard hut, the pool deck,
  one flamingo lawn ornament. The defiant-party note.
- **Broken (15):** the half-buried seaplane, a light salt-bleach band on the
  lower facades. *That's the budget* — resist rust/ruin; the plates that read
  best have almost none.
- **Blooming (40):** rooftop palms locals kept alive, turquoise reef + bright
  coral through the clear shallows, flowering planters, algae fringe at the line.

## Per-beat build notes

Beats follow [south-beach-sunken.md](./south-beach-sunken.md) (asymmetric kidney
loop, 45 s lap).

### 1 — Hero aerial · `south_beach_hero_aerial`
The postcard: a turquoise lagoon ringed by pastel Art-Deco buildings with a
palm island at centre and braided racing channels of reef-shallow water.
**Build actions:**
- Drive the **water shader** to the plate's two-tone read — bright turquoise over
  the shallow racing channels, deep teal in the off-channel drop-offs (depth-tint
  the shallows). This is the screenshot the track is judged on; get water + sky
  grade right here first.
- Terrain/roof `COLOR_0`: warm pale-sand + pastel-stucco band at/above the
  waterline, turquoise-shallow reef below.

### 2 — Rooftop chain · `south_beach_rooftop_chain`  *(10–22 s, three rooftops in series)*
The built heart: an elevated run down a flooded Ocean Drive lined with pastel
Art-Deco hotels, palms, neon-mint signage. **Build actions:**
- This is where to **spend prop budget** — the three hotel-rooftop plinths
  (per the unique-prop manifest), kept-painted facades, signage, string-lights,
  rooftop bars, the one flamingo lawn ornament. Keep the rest of the loop clean.
- Emissive discipline: only **signage** (`#6CFFC8`) and **string-lights**
  (`#FFC24D`) glow. Nothing dead emits.
- Skim-across rooftops should read as flat painted slabs at/above the waterline.

### 3 — Versace Steps · `south_beach_versace_steps`  *(22–32 s, the set-piece)*
The hero set-piece: the ornate Casa-Casuarina-style mansion front steps rising
straight out of glassy turquoise water, the half-buried seaplane as the launch
ramp, pink sky behind. **Build actions:**
- Build the **steps emerging from water** as the unmistakable read (the plates
  sell this), and the **seaplane wing as an obvious takeoff lip** — single
  smoothed mesh, leading edge = launch lip (per the track doc's prop manifest).
- *Note:* MJ drew the seaplane airborne / parked rather than half-buried-as-ramp;
  treat the plates as **mood + material** (ornate mansion, vintage seaplane skin,
  pink-sky framing), not literal geometry — the gameplay ramp is the half-buried
  wing per [south-beach-sunken.md](./south-beach-sunken.md).
- This is the postcard moment of the track; build + light it first.

### 4 — Pool deck · `south_beach_pool_deck`  *(32–40 s, inner-bay calm / shortcut)*
Calmer gulf-side water: a flooded Art-Deco hotel pool deck just under the
surface, a long turquoise pool flanked by pastel cabanas, half-submerged
candy-striped lounge chairs, the tiled pool edge reading as the shortcut.
**Build actions:**
- Author the **pool-deck shortcut plinth** as a tiled edge just at/under the
  waterline; the lounge chairs + cabana stripe are the dressing that sells "pool."
- Keep the racing water glassy and calm here (Gulf-side); depth-tint the pool a
  brighter turquoise than the open bay.

### 5 — Lifeguard finish · `south_beach_lifeguard_finish`  *(40–45 s, finish wraparound)*
The iconic pastel Miami lifeguard hut on stilts standing in shallow turquoise
water, a tight finish-line turn sweeping past it, the drowned-city skyline
behind. **Build actions:**
- The lifeguard hut is the **finish-line landmark** — pastel pink/blue/mint on
  stilts, salt-bleach band + coral fringe at the waterline (the full trio below).
- Sell depth with the distant pastel skyline silhouette + reflection; tight-left
  racing line past the hut back to the start grid.

### 6 — Waterline detail · `south_beach_waterline_detail`
The instructional close-up: a pastel Art-Deco facade meeting clear turquoise reef
shallows, the waterline band and submerged seabed visible. This is the *spec
image* for the trio below — match it on every passed shore.
- *Note:* MJ rendered building-meets-water portraits rather than a tight macro of
  the three bands; the trio spec still governs. Author the **bright, instructive**
  waterline (this is the friendliest shoreline in the set) per below.

## Waterline trio (universal — per art-direction)

Every static surface crossing the sea line gets three marks, bottom→top — a
`COLOR_0`/decal job, **not** new geometry:

1. **New-life fringe** (below + at line): bright coral / kelp / algae skirt. *Blooming.*
2. **Crust band** (at line): barnacle / verdigris. *Broken* — keep it **bright and
   clean** here (South Beach is the friendliest waterline in the set), not grimy.
3. **Salt-bleach band** (just above): a paler, chalkier strip.

## Build order (what to do first to hit the target)

1. **Water + sky grade** to the hero plate (turquoise-by-depth shader,
   `miami_pastel` sunset sky, bloom). Biggest visual lift; everything sits on it.
2. **Rooftop-chain set-piece dressing** (beat 2) — the one place to spend prop
   density: pastel facades, signage, string-lights, palms, flamingo.
3. **Versace Steps** (beat 3) — steps emerging from water + seaplane wing-ramp.
4. **Waterline trio** decal/`COLOR_0` pass on every passed shore + the lifeguard
   stilts and hotel bases.
5. **Pool-deck shortcut** + lounge-chair dressing (beat 4).
6. **Sparse life** — gulls, palm sway, neon flicker, distant skyline reflection.

> Keep the **racing line + ~6 m shoulder swept clean** (the scatter mask computes
> this). The plates are dense at the *edges* and empty on the *line* — preserve it.

## References
- [south-beach-sunken.md](./south-beach-sunken.md) — the track (beats, props, palette).
- [sandbar-art-target.md](./sandbar-art-target.md) — sister doc; set the Reef-pastel house look.
- [track-art-pass-playbook.md](../track-art-pass-playbook.md) — placement /
  AI-corridor clearance / GLB re-export procedure.
- [art-direction.md](../art-direction.md) — register, material-state rule,
  waterline trio, palette appendix.
