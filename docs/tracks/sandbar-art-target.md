# Mayday Bay — Art Target (near-shipping visual pass)

> **What this is.** A visual build-target for the Mayday Bay tutorial track, derived
> from a Midjourney environment-concept pass (2026-06-01) that pushes the
> *look* to near-shipping while the **gameplay layout stays exactly as authored**
> in `tracks-src/sandbar.blend`. The concept plates are the postcard we're
> building toward; this doc translates them into concrete build actions per beat.
>
> **This doc is downstream of** [art-direction.md](../art-direction.md) (register,
> material-state rule, waterline trio) and
> [track-art-direction.md](../track-art-direction.md#tutorial--mayday-bay--reef-pastel--45--15--40)
> (Mayday Bay = Reef pastel, **45 built / 15 broken / 40 blooming**). It does not
> change lore, palette, or layout — it shows how to *apply* them here.

## Source material

- **Concept plates (curated best-of, 6 beats):**
  `C:\project-content\hoverbike\concept-art\midjourney\sandbar\near-shipping-pass\best\`
  (`sandbar_hero_aerial`, `_marina_hub`, `_awash_sandbar`, `_south_bay`,
  `_crest_launch`, `_waterline_detail`). Full 4-up grids + a `CONTACT_SHEET.png`
  sit one level up; the prior env-plate pass (`sandbar_env_01..04`) is in the
  parent folder.
- **Layout reference renders** (the *real* authored geometry, bathymetric +
  beat cameras): `…\sandbar\_layout_ref\` — these are the ground truth the
  plates were prompted against. The plates are mood/material targets, **not**
  geometry sources; where a plate and the `.blend` disagree, the `.blend` wins.
- **MJ prompt lane** (reproducible): `painterly cinematic concept art,
  retro-future post-apocalyptic solarpunk drowned-world hover-bike racing game,
  warm pastel mid-morning sun on cool turquoise water, bold colour blocking,
  matte gouache key art … --ar 16:9 --style raw --s 250 --no cute, vinyl toy,
  chibi, smooth plastic, glossy, infantile, busy detail, text, watermark`.
  (Never say "toy" to MJ — it renders vinyl figurines; "retro-future" is the
  on-brand word.)

## The look in one line

Warm rose-peach mid-morning sky over **glassy turquoise shallows**; a cared-for
training cove that's *defiant and alive*, not a ruin. Decay is one salt-bleach
band and one half-sunk piling — no more.

## Palette (Reef pastel — sample by role)

| Role | Hex | Use on Mayday Bay |
|---|---|---|
| Sky / key (warm) | `#FFB3C7` → peach | rose-peach mid-morning gradient, the master warm |
| Water (cool) | `#36C8C0` | turquoise shallows; darken to deep teal off the steep island shores |
| Built | `#F2E4C6` | repainted dock timber, cream-stucco shack, ramp |
| Broken | `#A7B2AC` | the single salt-bleach band, half-sunk piling |
| Blooming | `#3DA35D` | cove palms, reef/kelp under the shallows, dune-crest coral |
| Emissive | `#6CFFC8` (+ warm `#FFC24D` work-lights) | shack signage, the work-light string — **only** powered things glow |

Colour grade: track JSON ships `venice_warm` (tint `#ffe0c8`, bloom 0.6,
sunIntensity 1.1, low cloud). The plates match that; keep it.

## Material-state ratio: 45 built / 15 broken / 40 blooming

All three must read in the hero framing. Mayday Bay leans **built + blooming** with
near-zero decay — it's a *classroom*, kept tidy on purpose.

- **Built (45):** the retrofitted marina — repainted timber dock on stilts,
  cream/teal pilot-school shack with hand-lettered signage + a warm work-light
  string, mooring bollards, marker buoys, the single training ramp, one base-camp
  tarp/crate cluster.
- **Broken (15):** one salt-bleach band at the tide line, one half-sunk piling.
  *That's the budget.* Resist adding rust/ruin — the plates that read best have
  almost none.
- **Blooming (40):** cove palms (the 12 already placed), reef + kelp visible
  through the clear shallows, coral on the dune crest, algae fringe at the
  waterline.

## Per-beat build notes

Coordinates are Blender (z-up); three.js = (bx, bz, −by). Loop runs the 8 gates
clockwise from the start cove.

### 1 — Hero aerial · `sandbar_hero_aerial`
The postcard: tall green-and-sand island, the cove marina, braided turquoise
racing channels, pale sandbars, an awash bar far east. **Build actions:**
- Push the **water shader** to the plate's two-tone read — bright turquoise over
  the shallow racing channel, deep teal in the off-channel drop-offs (shores fall
  to −20…−37 m just off the island, so the contrast is *already in the terrain* —
  drive shallow-water tint by depth).
- Terrain `COLOR_0`: warm pale-sand band at/above the waterline, green on the
  mid-slopes, neutral on the peaks (the bathymetric ref in `_layout_ref` shows
  the elevation bands to paint to).
- This is the screenshot the track is judged on — get the water + sky grade right
  here first.

### 2 — Marina hub · `sandbar_marina_hub`  *(start cove, ~Blender (20,−140), palms x∈[−88,−40])*
The built heart: repainted dock on stilts, the pilot-school shack with signage +
work-lights, moored boats, buoys, palms, one half-sunk piling. **Build actions:**
- This is the one **hero set-piece** — spend prop budget here, keep the rest of
  the loop clean. Dock + shack + ramp + buoys + a base-camp tarp/crate cluster.
- Emissive discipline: only the **signage** and the **work-light string** glow
  (`#6CFFC8` sign, `#FFC24D` lights). Nothing dead emits.
- Waterline trio on every piling and the shack stilts (see spec below).
- Reuse existing kit: `prop_palm` (placed), marker buoys, ramp_jump; the shack +
  dock are the candidates for a new/AI prop if budget allows.

### 3 — Awash sandbar · `sandbar_awash_sandbar`  *(far east, ~gate_02/03, x≈230→295, h≈0)*
The track's namesake: a long low bar *barely breaking* a glassy sea, golden wet
sand + tide pools, buoys marking the channel beside it, a small palm islet, gulls.
**Build actions:**
- Author the awash band so it reads **wet and just-submerged** — a darker
  saturated wet-sand `COLOR_0` at h≈−0.3…+0.2, with the water plane lapping over
  it (caustics on, foam line subtle). This is where the player first reads "the
  sea is shallow here."
- Keep props **outside the buoy channel wall** (the buoys are the channel walls;
  the AI corridor must stay clear — see the art-pass playbook). Scatter coral/kelp
  and a few gulls (animated) on the *outer* flank only.

### 4 — South bay · `sandbar_south_bay`  *(gates 4–6, the wide bay sweep)*
Wide braided sandbars and a sweeping turquoise racing channel, sparse buoys,
distant island. **Build actions:**
- This is **clean racing water** — do not force props into the corridor (the bay
  fills with the line; the original art pass correctly left it clear). Dress the
  *far* sandbar edges only.
- Sell depth with the shallow-water tint gradient + a couple of grounded-wreck
  silhouettes far off the line for scale (broken budget, used sparingly).

### 5 — Crest launch · `sandbar_crest_launch`  *(the 42–55 s set-piece)*
The frozen-wave **packed-sand dune** with a clean takeoff lip against open sky;
a hover-craft launches off it (came out correctly wheelless). **Build actions:**
- Build the crest as **packed dry golden sand**, not a water wave — a single
  clean curling lip, *dead-simple read, no clutter* (the lesson must be legible).
  A little coral on the crest is the only dressing.
- Frame it against **open sky** so the launch silhouettes — keep the background
  empty behind the lip. Optional sparse beach-grass tufts at the base for scale.

### 6 — Waterline detail · `sandbar_waterline_detail`
The instructional close-up: clear turquoise reef shallows on a structure, the
**three-band waterline**, sun-dappled caustics, a repainted piling + bright buoy.
This is the *spec image* for the waterline trio below — match it on every shore.

## Waterline trio (universal — match `sandbar_waterline_detail`)

Every static surface crossing the sea line (`y=−1.5`) gets three marks,
bottom→top — a **shader-driven** pass (world-Y waterline), **not** new geometry:

1. **New-life fringe** (below + at line): coral / kelp / algae skirt. *Blooming.*
2. **Crust band** (at line): barnacle / verdigris / slime. *Broken* — keep it
   **clean and instructive** here (this is the player's first water-read), not grimy.
3. **Salt-bleach band** (just above): a paler, chalkier strip.

## Build order (what to do first to hit the target)

1. **Water + sky grade** to the hero plate (turquoise-by-depth shader, rose-peach
   `venice_warm` sky, bloom). Biggest visual lift; everything else sits on it.
2. **Terrain `COLOR_0`** elevation bands (wet-sand → sand → green → neutral peak),
   awash-band wet-sand at the east bar.
3. **Marina hub set-piece** (beat 2) — the one place to spend prop density.
4. **Waterline trio** (shader-driven, world-Y) on every passed shore + the pilings.
5. **Crest-launch** dune material + clean-sky framing.
6. **Sparse life** — animated gulls, palm sway, buoy bob, a couple of distant
   wrecks for scale. A few moving things sell "alive."

> Keep the **racing line + ~6 m shoulder swept clean** (the scatter mask already
> computes this). The plates are dense at the *edges* and empty on the *line* —
> that's deliberate; preserve it.

## Sky & background (engine capability added this pass)

The dome shader (`src/engine/render/sky.ts`) gained two per-track `sky` knobs so
the background can match the concept skies (towering lit cumulus, big dramatic
sun) **at near-zero cost** — it's the sky dome, no geometry overdraw, just a few
extra fragment-noise taps:

- **`cloudTowering`** (0–1, default 0.35) — domain-warped, **self-shadowed**
  billowing cumulus. The trick: re-sample cloud density offset toward the sun;
  denser-toward-sun = shadowed flank, thinner = lit top. That delta fakes volume
  with no raymarching. Higher = bigger, rounder, taller-reading masses with a
  cool base / warm top. `0` falls back to the legacy flat band.
- **`sunSize`** (default 1.0 = tight ~1° disc) — widens the disc and adds a warm
  **corona**; use a big value on sunset/finale tracks for a giant low sun.

The cloud upgrade (cool-base self-shadow + elevation lift) is a strict
improvement for **every** track; the drama is opt-in via the two knobs.

**Mayday Bay values:** `cloudiness 0.5`, `cloudTowering 0.75`, `sunSize 1.7` —
big soft cumulus + a warm low sun, kept friendly for the calm classroom.
Perf: ~2 FBM + 2 value-noise taps per sky pixel (dome only); held 70+ fps on
the dev GPU. If the M1/Ryzen floor ever struggles, the second (self-shadow) FBM
tap is the lever to cheapen first.

## Build status (2026-06-01 implementation pass)

What landed in-engine this pass (all verified live on WebGPU unless noted):

- **Sky/grade/fog** tuned in `sandbar.json`; **cloudTowering 0.75 + sunSize 1.7**
  (big lit cumulus + warm sun). **Waterline trio** on (`terrainShader.waterline 1.0`).
- **Marina hero set-piece — built + placed (first pass):**
  - `pilot_shack` ran the **full AI pipeline** (ComfyUI concept → boxier re-roll →
    Hunyuan mesh → Blender condition → integrate). Compiled GLB committed:
    `public/assets/props/ai/pilot_shack.glb` (raw `.blend` in the content root).
    Prompt/seed anchor in `specs/props/ai/sandbar.json`.
  - **Procedural** dock + pilings authored as primitives directly in `props[]`
    (`box` deck + 6 `cylinder` pilings, Reef-pastel tints).
  - **Placement (three.js, cove, clear of the AI corridor — all x ≤ −38, 53–78 m
    off the start line):** shack ≈ `(−58, 2.5, 126)`; dock deck `(−47, 1.6, 140)`
    8×0.25×3; pilings around `x −54…−38, z 135…152`. **Loads clean, no console
    errors.** This is a *rough first pass* — the seating/framing wants a hands-on
    designer nudge (the dock slab reads thin edge-on; the shack is tucked behind
    the palm shore and barely visible from the start). Tune the coords above.
- **Deferred:** the `emitter_gulls` flock (needs an emitter empty in the env GLB +
  a re-export; the 98 wave-rider channel buoys already provide bobbing life).

## References
- [sandbar.md](./sandbar.md) — the track (beats, props, palette).
- [track-art-pass-playbook.md](../track-art-pass-playbook.md) — placement /
  AI-corridor clearance / GLB re-export procedure.
- [art-direction.md](../art-direction.md) — register, material-state rule,
  waterline trio, palette appendix.
