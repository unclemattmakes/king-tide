# Texcoco Rising — Art Target (Reef Cup visual pass)

> **What this is.** A forward-looking visual build-target for the Texcoco
> Rising track (Reef Cup #1 — drowned Mexico City), grounded in the design
> docs. There is **no authored `.blend` and no concept-plate pass yet** —
> the track is concept-locked, geometry pending — so these are pure
> mood/material targets to build toward. A Midjourney/ComfyUI concept pass
> (prompt lane below) is **TODO** before the art pass. The layout follows
> [tracks/texcoco-rising.md](./texcoco-rising.md), the *look* follows this doc.
>
> **This doc is downstream of** [art-direction.md](../art-direction.md) (register,
> material-state rule, waterline trio) and
> [track-art-direction.md](../track-art-direction.md#1-texcoco-rising--reef-rosa--50--20--30)
> (Texcoco Rising = Reef rosa, **50 built / 20 broken / 30 blooming**). It does
> not change lore, palette, or layout — it shows how to *apply* them here. Pairs
> with [sandbar-art-target.md](./sandbar-art-target.md), which set the Reef
> house look first.

## Source material

- **Concept plates:** *none yet.* Run the MJ/ComfyUI lane below for a 6-beat
  best-of (hero aerial, causeway run, Zócalo lagoon, El Ángel set-piece,
  Chapultepec finish, waterline detail) and curate to
  `concept-art/.../texcoco-rising/best/` before the art pass.
- **MJ prompt lane** (reproducible — same lane as Sandbar, restyled to Mexico
  City): `<concrete scene>; painterly cinematic concept art, retro-future
  post-apocalyptic solarpunk drowned-world hover-bike racing game, warm
  rosa-mexicano-pink and marigold sunset over a calm teal high-altitude lake,
  gold Ángel de la Independencia statue, colourful Xochimilco trajinera boats,
  raised Aztec stone causeways, twin volcanoes on the horizon, bold colour
  blocking and clean stylized forms, Wind Waker meets Wipeout colour
  confidence, matte gouache key art, defiant and alive not mournful --ar 16:9
  --style raw --s 250 --no cute, vinyl toy, chibi, smooth plastic, glossy,
  infantile, busy detail, text, watermark, wheels`. (Never say "toy" to MJ;
  "retro-future" is the on-brand word. On the bike beat add the hover-craft
  magic phrase + `--no wheels, tires`.)

## The look in one line

Golden-hour **rosa-mexicano-and-marigold sky** over a **glassy teal lake** at
altitude; a defiant party on the water — gold Ángel, colour-drenched
trajineras, papel-picado banners — among the drowned cathedral and the
re-surfacing Aztec city. The lake came back and the city threw a party on it.

## Palette (Reef rosa — sample by role)

| Role | Hex | Use on Texcoco Rising |
|---|---|---|
| Sky / key (warm) | `#E4007C` → `#FF8C1A` | rosa-mexicano-to-marigold sunset gradient, the master warm |
| Water (cool) | `#2E9E8F` | teal lake shallows; deeper green-blue off the causeway drop-offs |
| Built | `#E8C9A0` + painted (rosa / cobalt / ochre) | colonial stucco + Aztec basalt — repaint in confident blocks |
| Broken | `#6E6A66` | drowned-ruin basalt, the mineral/salt band at the line |
| Blooming | `#8A6FD1` jacaranda / `#3DA35D` chinampa | jacarandas + ahuehuete on causeways, chinampa reeds, lake green |
| Emissive | gold `#FFD23D` (Ángel + cathedral gilt) + warm string-lights + neon sonidero | **only** powered/gilt things glow |

Sky preset: **`mexico_city_rosa`** (added with this track) — rosa-mexicano lift,
punchy saturation. Grade to late-afternoon. Keep saturation *up* — this is the
brightest, friendliest grade in the Reef cup alongside Sandbar.

## Material-state ratio: 50 built / 20 broken / 30 blooming

All three must read in the hero framing. Texcoco leans **built + blooming** —
a dense, defiantly-alive city, with ruin kept to a budget.

- **Built (50):** painted colonial facades + Aztec stonework kept lit, the gold
  Ángel, the cathedral, gilded altarpiece glints, trajineras, papel-picado, the
  causeway roadways. The defiant-party note.
- **Broken (20):** the collapsed Segundo Piso freeway deck (the ramp), the
  half-sunk cathedral lean, a mineral/salt band on lower facades. *That's the
  budget* — resist over-ruining.
- **Blooming (30):** jacarandas + ahuehuete cypress locals kept, chinampa reeds
  and floating-garden green, lily/algae fringe at the waterline.

## Per-beat build notes

Beats follow [texcoco-rising.md](./texcoco-rising.md) (causeway loop, 45 s lap).

### 1 — Hero aerial
The postcard: a teal lake threaded by raised Aztec causeways, the gold Ángel
catching low sun mid-frame, trajineras fanned across the water, twin volcanoes
on the horizon. **Build first:** drive the **water shader** to a two-tone read
(bright teal over the shallow causeway channels, deeper green-blue off-channel)
and lock the **`mexico_city_rosa` sky grade** + bloom. This is the screenshot
the track is judged on.

### 2 — Calzada / causeway run  *(0–10 s)*
Elevated causeway down a flooded Centro Histórico lined with painted colonial
facades, jacarandas, string-lights. **Spend prop budget here** — facades,
signage, banners, the causeway stonework — and keep the rest of the loop clean.
Emissive discipline: only signage, string-lights, and gilt glow.

### 3 — Zócalo lagoon  *(10–20 s, weave)*
The half-sunk Catedral Metropolitana leaning over the water beside the
re-emerging Templo Mayor steps; trajineras fanned across the plaza-turned-lagoon.
Build the cathedral lean + the pyramid steps as the unmistakable read; the
trajineras + papel-picado are the colour that sells "the party didn't stop."

### 4 — El Ángel  *(28–36 s, the set-piece)*
The hero: the **gold Ángel** standing in the lake on Paseo de la Reforma, the
**collapsed Segundo Piso freeway deck** as the obvious takeoff ramp (tilted
deck = run-up, broken lip = launch lip), Popocatépetl smoking behind. Build +
light this first after the water/sky. The statue is decoration; the freeway
deck is `kind=track`.

### 5 — Chapultepec finish  *(36–45 s, turn / finish)*
A bank through drowned Chapultepec park — flooded ahuehuete groves, the castle
silhouette on its hill as the finish landmark — sweeping back to the causeway
start. Sell depth with the distant volcano + skyline silhouette and reflection.

### 6 — Waterline detail
The instructional close-up: a painted colonial facade (or basalt causeway)
meeting clear teal lake shallows — the *spec image* for the trio below. Author
the **bright, instructive** waterline (this is among the friendliest in the set).

## Waterline trio (universal — per art-direction)

Every static surface crossing the lake line gets three marks, bottom→top — a
`COLOR_0`/decal job, **not** new geometry:

1. **New-life fringe** (below + at line): chinampa reed / lily / algae skirt. *Blooming.*
2. **Crust band** (at line): mineral / verdigris — keep it **bright and clean**, not grimy.
3. **Salt-bleach band** (just above): a paler, chalkier strip (the lake is alkaline).

## Build order (what to do first to hit the target)

1. **Water + sky grade** to the hero plate (teal-by-depth shader,
   `mexico_city_rosa` late-afternoon sky, bloom). Biggest lift; everything sits on it.
2. **Causeway-run dressing** (beat 2) — the one place to spend prop density:
   painted facades, signage, banners, jacarandas.
3. **El Ángel** (beat 4) — gold statue + collapsed-freeway ramp.
4. **Waterline trio** decal/`COLOR_0` pass on every passed shore + the cathedral / causeway bases.
5. **Zócalo lagoon** (beat 3) — cathedral lean, Templo Mayor steps, trajineras.
6. **Sparse life** — papel-picado drift, jacaranda fall, gilt flicker, distant volcano reflection.

> Keep the **racing line + ~6 m shoulder swept clean** (the scatter mask computes
> this). Density at the *edges*, empty on the *line*.

## References
- [texcoco-rising.md](./texcoco-rising.md) — the track (beats, props, palette).
- [texcoco-rising-concept-pass.md](./texcoco-rising-concept-pass.md) — per-beat concept prompts (the shot sheet).
- [texcoco-rising-prop-manifest.md](./texcoco-rising-prop-manifest.md) — bespoke props + ComfyUI sculpt prompts.
- [sandbar-art-target.md](./sandbar-art-target.md) — sister doc; set the Reef house look.
- [track-art-pass-playbook.md](../track-art-pass-playbook.md) — placement /
  AI-corridor clearance / GLB re-export procedure.
- [art-direction.md](../art-direction.md) — register, material-state rule,
  waterline trio, palette appendix.
