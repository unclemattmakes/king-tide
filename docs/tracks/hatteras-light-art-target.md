# Hatteras Light — Art Target (Reef Cup visual pass)

> **What this is.** A visual build-target for the Hatteras Light track (Reef Cup
> #3, the cup closer), from a Midjourney environment-concept pass (2026-06-01). As
> with the other Reef passes there is **no authored `.blend` yet** — these are
> mood/material targets grounded in the design docs. When Hatteras is blocked out,
> this is the postcard to build toward; layout follows
> [tracks/hatteras-light.md](./hatteras-light.md), the *look* follows this doc.
>
> **Downstream of** [art-direction.md](../art-direction.md) and
> [track-art-direction.md](../track-art-direction.md#3-hatteras-light--reef-pastel-cool-grade--30--35--35)
> (Hatteras = Reef pastel **cool grade**, **30 built / 35 broken / 35 blooming** —
> the most *balanced* Reef track: the lighthouse is kept, the sea is winning).
> Completes the Reef cup alongside
> [mexico-city-art-target.md](./mexico-city-art-target.md) (warm) and
> [cape-town-drift-art-target.md](./cape-town-drift-art-target.md) (cool bright).
> Hatteras is the **moody overcast** end of the Reef range.

## Source material

- **Concept plates (curated best-of, 6 beats):**
  `C:\project-content\hoverbike\concept-art\midjourney\hatteras-light\best\`
  (`hatteras_hero_aerial`, `_atlantic_swell`, `_lamp_room`, `_cliff_drop`,
  `_base_approach`, `_waterline_detail`). Full 4-up grids in `_montage\`, raw cells
  (`<beat>_0..3.png`) in the parent folder, `CONTACT_SHEET.png` +
  `best\_BEST_STRIP.png`.
- **MJ prompt lane** (house lane, **overcast cool-grey grade**, no land/palms):
  `<concrete scene>; painterly cinematic concept art, retro-future post-apocalyptic
  solarpunk drowned-world hover-bike racing game, cool grey-green Atlantic under
  low overcast cloud, the one warm rotating lamp the only warm light, bold colour
  blocking and clean stylized forms, Wind Waker meets Wipeout colour confidence,
  matte gouache key art, lonely but defiant not mournful --ar 16:9 --style raw --s
  250 --no land, shoreline, beach, island, palms, cute, vinyl toy, chibi, smooth
  plastic, glossy, infantile, busy detail, text, watermark, wheels`. **The
  `--no land, shoreline, beach, island` clause is load-bearing** — without it MJ's
  lighthouse-on-a-beach prior wins; the Outer Banks are *gone*, the tower stands
  alone in open water. `--no palms` too (wrong climate). Bike beats add the
  hover-craft magic phrase + `--no wheels, tires`.

## The look in one line

A lone **black-and-white barber-pole lighthouse** standing a third sunk in **open
grey-green Atlantic** under **low overcast cloud**, heavy foam-green swell, no land
for kilometres — and the **one warm rotating lamp** the only warm light in the
frame. Lonely, cold, and *defiant*, never mournful.

## Palette (Reef pastel — cool overcast grade)

| Role | Hex | Use on Hatteras |
|---|---|---|
| Sky / key (cool) | `#9FB0AE` overcast | low grey-green overcast cloud, the master cool |
| Water (cool) | `#3E7E72` foam-green | heavy Beaufort-5 swell, white foam crests |
| Built | `#EDEAE3` / `#1C1C1C` | the black-and-white spiral lighthouse, gallery ironwork |
| Broken | `#8A938C` | the submerged third, foam-worn stone, weathered rail |
| Blooming | `#5E8C61` | kelp skirt at the base, gull-perch crags, sea-life |
| Emissive | **warm `#FFC24D`** | **the lamp — the single warm emissive**; nothing else glows |

Sky preset: the track reuses **`cape_town_blue`** but graded **greyer / overcast**
(`seaStateBeaufort=5`, the highest in Reef — the "you're ready for Open Sea" stress
test). The lamp is the privileged warm light; let it read against the grey, and
**brighten it across laps** (per the per-lap note — visual climax build).

## Material-state ratio: 30 built / 35 broken / 35 blooming

The most *balanced* Reef track — the lighthouse is kept, the sea is winning.

- **Built (30):** the black-and-white spiral lighthouse + the still-spinning lamp
  ("someone keeps the lamp spinning"). The one maintained, warm thing.
- **Broken (35):** the submerged third, the wrecked exterior gallery + keeper's
  stair (now the ramp), foam-worn stone, weathered rail.
- **Blooming (35):** foam-green water, kelp skirt at the base, gull-perch crags
  with sea-life. The living, cold ocean.

## Per-beat build notes

Beats follow [hatteras-light.md](./hatteras-light.md) (loop + vertical climb +
cliff-drop finish, 50 s lap).

### 1 — Hero aerial · `hatteras_hero_aerial`
The postcard: the **black-and-white spiral barber-pole lighthouse** alone in open
churning grey-green sea, no land, foam crests, low overcast. **Build actions:**
- The lighthouse silhouette is *the* identity — hand-modelled ~60 m, the iconic
  black/white spiral via the two material slots. Lock it first; it's visible from
  anywhere on the track.
- Water: heavy foam-green swell (Beaufort 5), white crests; this is the first real
  wave-reading test, so the swell has to read *big* even from the establishing shot.

### 2 — Atlantic swell · `hatteras_atlantic_swell`  *(0–12 s, the wave-reading test)*
A hover-craft pumping over a big foam-green wave crest, the lighthouse small on the
grey horizon, spray, overcast. **Build actions:**
- This sells the **Beaufort-5 swell** — the heaviest in the Reef cup. Big rolling
  wave faces, white foam, the craft riding the crest (clean wheelless hover-craft —
  rendered well here).
- The lighthouse is a distant beacon on the horizon; the swell is the content.

### 3 — The Lamp Room · `hatteras_lamp_room`  *(20–32 s, the set-piece)*
Hero set-piece: the hover-craft riding **up the exterior gallery-spiral ramp** that
wraps the tower toward the **warm rotating lamp** at the top. **Build actions:**
- Build `ramp_helix_gallery` as a **normal-gravity helix road** wrapping the tower
  ~1.5× to the gallery deck (≈25–30° pitch, ~50 m climb). The fiction: the iron
  gallery + external stair peeled off the tower into a ramp. The plate (cell 0) is
  the exact target — bike on the spiralling ramp, lamp glowing above.
- **The lamp is the privileged warm emissive** (`emitter_lamp_glare`, rotates with
  it) against the low grey cloud — the one warm light, brighter each lap.
- The gallery **railing rim is the launch lip**; the rotating beacon arm is the
  Hard-mode timing hazard at the launch window.

### 4 — Cliff drop · `hatteras_cliff_drop`  *(32–42 s, the finale)*
The cup's emotional payoff: the craft **launches off the gallery railing** into a
long big-air drop toward the open sea far below, lighthouse behind. **Build
actions:**
- Sell **height + vertigo** — the cool grey sea far below, the lighthouse receding.
  This is the Jet-Moto-Cliffdiver lap-ender that "lands every lap."
- *Note:* one MJ cell rendered the climb as a glowing **neon-green spiral loop** —
  that reads as the **cut anti-grav corkscrew**; do **not** use it. The ramp is a
  normal-gravity road, the drop is a free launch, never a gravity flip.

### 5 — Base approach · `hatteras_base_approach`  *(42–50 s, finish straight)*
A low approach across foam-green swell toward the submerged base, the **warm lamp
glowing high above** through cold foghorn mist, submerged shoal rocks, gulls.
**Build actions:**
- `emitter_foghorn_mist` (cold-air-on-warm-water) at the base; ~8 submerged shoal
  rocks (`scatter_rocks`); a few gulls on a crag (animated life).
- The lamp glowing high above is the warm anchor in an otherwise cold-grey frame.

### 6 — Waterline detail · `hatteras_waterline_detail`
The *spec image*: the lighthouse base in foam-green water with the full **three-band
waterline** wrapping the painted stone — Hatteras gets the heaviest, oldest
waterline in the Reef cup (decades of rising water). Match it on the base:
1. **Kelp skirt + sea-life** below the line. *Blooming.*
2. **Heavy barnacle + verdigris crust** at the line. *Broken.*
3. **Salt-bleach band** just above, foam-worn stone.

## Build order (what to do first to hit the target)

1. **Lighthouse + lamp** — the ~60 m spiral tower (two-slot black/white) and the
   warm rotating lamp; the silhouette is the whole track's identity.
2. **Water + sky grade** — overcast grey-green, Beaufort-5 foam-green swell, the
   lamp the one warm light.
3. **`ramp_helix_gallery` set-piece** (beat 3) — the normal-gravity helix climb.
4. **Cliff-drop framing** (beat 4) — height + the launch lip; never a gravity flip.
5. **Waterline trio** (heavy/old) on the base + shoal rocks.
6. **Sparse cold life** — gulls, foghorn mist, kelp sway, lamp brightening per lap.

> No palms (wrong climate). Keep the **racing line + ~6 m shoulder swept clean**;
> the sea is the stage, the lighthouse the single set-piece.

## References
- [hatteras-light.md](./hatteras-light.md) — the track (beats, props, palette).
- [mexico-city-art-target.md](./mexico-city-art-target.md) · [cape-town-drift-art-target.md](./cape-town-drift-art-target.md) · [sandbar-art-target.md](./sandbar-art-target.md) — sister passes.
- [track-art-pass-playbook.md](../track-art-pass-playbook.md) — placement / AI-corridor clearance / re-export.
- [art-direction.md](../art-direction.md) — register, material-state rule, waterline trio, palette appendix.
