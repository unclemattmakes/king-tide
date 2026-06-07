# The Maw — Art Target (Open Sea Cup visual pass)

> **What this is.** A visual build-target for The Maw (Open Sea Cup #1, the
> showcase wave track), from a Midjourney environment-concept pass (2026-06-01).
> No authored `.blend` yet — these are mood/material targets grounded in the
> design docs. When The Maw is blocked out, this is the postcard to build toward;
> layout follows [tracks/the-maw.md](./the-maw.md), the *look* follows this doc.
>
> **First Open Sea cup pass** — opens a new palette family after the Reef cup
> ([sandbar](./sandbar-art-target.md) · [texcoco](./texcoco-rising-art-target.md)
> · [cape-town](./cape-town-drift-art-target.md) · [hatteras](./hatteras-light-art-target.md)).
> Downstream of [art-direction.md](../art-direction.md) and
> [track-art-direction.md](../track-art-direction.md#4-the-maw--open-sea-cool--5--30--65)
> (The Maw = **Open Sea cool**, **5 built / 30 broken / 65 blooming** — the purest
> *world-as-place* track: nature-dominant, barely any built).

## Source material

- **Concept plates (curated best-of, 6 beats):**
  `C:\project-content\hoverbike\concept-art\midjourney\the-maw\best\`
  (`the_maw_hero_arena`, `_arches`, `_setpiece`, `_inner_channel`, `_mcway_falls`,
  `_waterline_detail`). Full 4-up grids in `_montage\`, raw cells
  (`<beat>_0..3.png`) in the parent folder, `CONTACT_SHEET.png` +
  `best\_BEST_STRIP.png`.
- **MJ prompt lane** (house lane, **golden-hour Pacific grade**):
  `<concrete scene>; painterly cinematic concept art, retro-future post-apocalyptic
  solarpunk drowned-world hover-bike racing game, golden-hour Pacific light, deep
  navy ocean and gold weathered rock, white foam and dramatic cloud shadows, bold
  colour blocking and clean stylized forms, Wind Waker meets Wipeout colour
  confidence, matte gouache key art, nature-dominant and alive --ar 16:9 --style
  raw --s 250 --no cute, vinyl toy, chibi, smooth plastic, glossy, infantile, busy
  detail, text, watermark, wheels`. Bike beats add the hover-craft magic phrase +
  `--no wheels, tires, jet-ski sitting in the water, hull half-submerged`. The
  wheelless craft rendered clean (open ocean, no competing vehicle).

## The look in one line

**Golden-hour Pacific** — deep navy ocean, colossal **gold weathered rock arches**
silhouetted against bright sky, white foam exploding, dramatic cloud shadows. All
ocean, no land underfoot; the **wave is the track** and the rock is the only
structure. Big Sur / Cabo-arch monumentality.

## Palette (Open Sea cool — golden-hour Pacific)

| Role | Hex | Use on The Maw |
|---|---|---|
| Sky / key (warm) | `#F0C27A` golden | golden-hour sun, the warm key on the rock |
| Water (cool) | `#1B3A6B` deep navy → `#2FA0B8` teal shallows | deep navy Pacific; bright teal in the lee/shallows |
| Built | `#9A9388` | *almost none* — only the collapsed concrete bridge remnant + a nav-marker |
| Broken | `#8A7A5E` | weathered cliff grey-gold, the Bixby superstructure chunk |
| Blooming | `#C98A3C` gold rock + `#3E7E72` kelp | the dominant — gold weathered arches, kelp, foam, the living sea |
| Foam / spray | `#F2F4F3` | white foam crests, arch-crown spray, McWay mist |

Sky preset: the track design calls for **`big_sur_golden`** sky
(`seaStateBeaufort=5`). Light golden-hour so the foam and wet rock pop; silhouette
the arches hard against the bright sky.

## Material-state ratio: 5 built / 30 broken / 65 blooming

The most *nature-dominant* track in the set — the sea is the content.

- **Built (5):** essentially none. The bridge that fell is *gone*; only a
  collapsed concrete remnant (the opener jump) + maybe a single weathered
  nav-marker. Resist adding structures.
- **Broken (30):** the collapsed Bixby superstructure chunk, weathered grey-gold
  cliff and arch stone.
- **Blooming (65):** *the dominant* — deep navy Pacific, gold rock arches, white
  foam, kelp, McWay Falls. The ocean *is* the level.

## Per-beat build notes

Beats follow [the-maw.md](./the-maw.md) (all-ocean arena loop, 60 s lap — the
purest wave-mastery test).

### 1 — Hero arena · `the_maw_hero_arena`
The postcard: the all-ocean Big Sur arena — the Maw arch in the middle distance,
tall **sea stacks** foreground, deep navy Pacific, golden cloud shadows. **Build
actions:**
- Establish the **arena read**: three arches in series + ~15 sea stacks
  (`scatter_rocks`, larger than default) on open ocean, the Maw dominant in the
  mid-distance. No land underfoot.
- Water shader: deep navy in the open, brighter teal in the lee — the depth
  two-tone is the whole arena's legibility.

### 2 — Arches · `the_maw_arches`  *(15–28 s, first arches + small Maw)*
A hover-craft threading between **two gold rock arches in series** on rolling
golden-hour swell, sea stacks, white foam. **Build actions:**
- Two smaller arches (≥4 m wall thickness) as the either-or path; the bike threads
  *between* them. Keep the gap line readable on the swell.
- Pumping pays here (~5 s gain in the opener) — the swell should read big enough
  that "pump the crest" is legible.

### 3 — The Maw · `the_maw_setpiece`  *(28–42 s, the set-piece)*
Hero set-piece: the **colossal gold arch** (~50 m span × ~30 m high) silhouetted
against bright golden sky, a hover-craft launching through on the **crest of a
huge breaking wave**, a wall of water curling at the arch mouth, sun-haze inside
the arch volume. **Build actions:**
- *The drama is the wall of water*, not surface detail — build the swell + the
  `emitter_maw_spray` arch-crown burst (fires harder on big swells) + the
  `emitter_arch_haze` sun-haze that sells the arch *volume*.
- Silhouette the arch hard against the bright sky; light golden-hour so the foam
  and wet rock pop. The plate (cell 0) is the target — wave + arch + bike-through.
- *Alt:* a more monumental symmetric-arch framing exists (maw cell 2) if a
  grander, calmer hero is wanted — but the wave is the gameplay story.
- **Wave timing = world wave timing** — the swell that decides launch-vs-eaten is
  legible 4–6 s ahead; the art must telegraph the incoming crest.

### 4 — Inner channel · `the_maw_inner_channel`  *(42–52 s, recovery beat)*
Calmer water in the arches' lee: glassy bright-teal Pacific reflecting gold sea
stacks, a hover-craft cruising, soft sun-haze. **Build actions:**
- The recovery beat — glassy, reflective, calm after the Maw. Bright teal (shallow
  lee) vs the open navy; clean reflections sell the calm.

### 5 — McWay Falls · `the_maw_mcway_falls`  *(52–60 s, finish + drift)*
The finish: a tall gold coastal cliff with **McWay Falls pouring straight into the
Pacific**, a hover-craft racing through the drifting spray at the base. **Build
actions:**
- `emitter_mcway_falls` — a column of falling spray off the cliff (the one tall
  vertical element); the bike drifts the finish through the mist.
- This is the only proper *cliff* on the track (east edge); everything else rises
  from open water.

### 6 — Waterline detail · `the_maw_waterline_detail`
The *spec image*: the gold rock base meeting the deep navy Pacific — the
**wet-rock waterline**, every arch base wearing it. Match it on every rock:
1. **Kelp + mussel skirt** below the line. *Blooming.*
2. **Dark foam-scoured tide-stain band** at the line — *wet and alive at the
   surface*. *Broken.*
3. **Dry gold sun-warmed rock** above.
Clear navy water with sun-dappled caustics over the submerged rock.

## Build order (what to do first to hit the target)

1. **Rock arches ×3 + sea stacks** — the Maw (~50 m span) + two smaller arches +
   ~15 sea stacks; the silhouettes are the whole arena.
2. **Water + sky grade** — `big_sur_golden`, deep-navy/teal depth two-tone,
   Beaufort-5 swell, white foam.
3. **The Maw wave-zone + emitters** (beat 3) — the most tuned wave config in v1;
   the breaking-wave launch + arch-crown spray + sun-haze.
4. **Wet-rock waterline trio** on every arch base + sea stack.
5. **McWay Falls** cliff + spray column (beat 5).
6. **Sparse life** — kelp sway, foam, drifting spray, gulls; the moving sea sells
   "alive."

> No land underfoot — it's 100% water. Keep the racing line readable through the
> arches; the rock is dense at the *edges*, the line threads the gaps.

## References
- [the-maw.md](./the-maw.md) — the track (beats, props, palette, wave config).
- Reef cup sisters: [texcoco](./texcoco-rising-art-target.md) · [cape-town](./cape-town-drift-art-target.md) · [hatteras](./hatteras-light-art-target.md) · [sandbar](./sandbar-art-target.md).
- [track-art-pass-playbook.md](../track-art-pass-playbook.md) — placement / re-export.
- [art-direction.md](../art-direction.md) — register, material-state rule, waterline trio, palette appendix.
