# Hoverbike — Prop Art Direction v1

> Per-archetype-family application of [art-direction.md](./art-direction.md) —
> the "clean stylized toy" register, the **built / broken / blooming** rule, the
> waterline rule, and "glow is a privilege." For each prop family it gives the
> default material-state, the silhouette read, and — for the AI-lane organic
> families — a **copy-paste ComfyUI concept prompt** that feeds the `make-props`
> concept phase.
>
> **Defers to:** [props-production-plan.md](./props-production-plan.md) for the
> production lanes, conditioning pass, and per-prop definition-of-done; and to
> [art-direction.md](./art-direction.md) for the register itself. This doc is
> the *look per family*, that doc is the *pipeline*.

---

## The lane rule decides whether there's even a prompt

From [props-production-plan.md](./props-production-plan.md): image-to-3D
(Hunyuan, the ComfyUI→mesh path) is excellent at **compact / solid / closed**
forms and fragments **thin / spindly / spanning** ones. So:

- **AI lane (has a ComfyUI prompt below):** rocks, boulders, sea-stacks, idols +
  carved faces, sea-life, statues, anchors, chests, urns, barrels, crates,
  bollards, debris, the hero sculpts.
- **Procedural lane (no prompt — author via `bmesh`/Geometry-Nodes):** towers,
  facades, arches, bridges, cables, lattice masts, gates, lamp posts, coral
  *fans*, kelp, branching foliage. A clean procedural silhouette beats a
  fragmented AI guess every time.

**Prompt toward solidity even inside the AI lane** — "massive solid brain-coral
**boulder**, rounded" reads far better than "branching coral."

---

## Shared prop style (every family)

Applies the register to props specifically (see also the per-prop
definition-of-done in [props-production-plan.md](./props-production-plan.md)):

- **Silhouette before surface** — nameable as a black cut-out at 200 m.
- **Bold value blocking**, 2–4 hues, saturated-not-muddy.
- **One material state** (or a deliberate ratio) per prop — built / broken /
  blooming, tinted to the track it dresses.
- **Waterline trio** (kelp/coral fringe → crust/oxidation → salt-bleach) on
  anything that crosses the sea line.
- **Emissive only if alive/powered** — and authored to survive bloom.
- **Oversize 2–4×** for landmarks/hazards/hero props; reads at 40 m/s.
- Full `COLOR_0` contract, primitive collider, one `mat_*` family shader.

### Shared ComfyUI blocks (AI-lane only)

Prepend the style block, append the family prompt; carry the negative block.

**Style:**
```
game prop concept art, single isolated object, stylized 3D, "clean stylized
toy" look, bold flat color blocking, strong readable silhouette, soft cel
shading with a gentle light-to-shadow gradient, subtle rim light, confident
slightly-oversized rounded-but-faceted form, matte stylized surface, post-
apocalyptic solarpunk drowned-world, 3/4 view, centered, neutral studio
background, clean even lighting, Wind Waker x Wipeout
```

**Negative** (the "thin/floating" terms steer toward solid, Hunyuan-friendly
forms):
```
photorealistic, photoscan, realistic PBR, heavy rust, grimdark, gritty, muddy
desaturated, brown, busy surface detail, noise, text, watermark, logo,
signature, multiple objects, scene, background clutter, lowres, blurry, thin
spindly fragments, floating disconnected parts, holes
```

---

## AI lane — organic + sculptural families (with prompts)

### Rock family — sea-stacks · shoal rocks · boulders · temple rubble

*Used by:* The Maw, Hatteras, Liberty, Angkor, South Beach, Cape Town. The
de-risking pilot family — runs the full `make-props` chain cleanly.

- **Material state:** **broken + blooming** — weathered stone mass with a
  blooming waterline (kelp/coral/moss fringe). Dry and warm-lit above the line.
- **Silhouette:** one solid columnar/rounded mass; exaggerate the taper or the
  lean. Tint to the track (gold for The Maw, grey for Hatteras, mossy ochre for
  Angkor).

```
[style] + massive solid sea-stack rock spire, weathered stone, rounded
columnar mass, kelp skirt and barnacle band at the waterline, single solid
closed form
```
```
[style] + massive rounded boulder, solid closed form, moss on top, algae
waterline band, stylized stone
```
```
[style] + chunky carved sandstone temple rubble block, moss-covered, laterite
ochre, strangler-fig root creeping over it, solid mass
```

### Sea life — great white · sea turtle · chunky fauna

*Used by:* Cape Town (the great white), open-water tracks. Compact closed bodies
= ideal AI subjects.

- **Material state:** **blooming** — life persisting. A little barnacle/algae
  (broken accent) on shells/backs.
- **Silhouette:** chunky toy proportions, calm readable form; the shark should
  read menacing-but-still from one glance.

```
[style] + stylized great white shark, smooth solid body, chunky toy
proportions, pale grey back, white belly, calm menacing silhouette, single
solid form
```
```
[style] + stylized sea turtle, rounded solid shell, chunky flippers, barnacles
and algae on the shell, friendly readable silhouette
```

### Idols + carved faces — Bayon faces · stone idols

*Used by:* Angkor (the sixteen Smiling Faces). Compact closed blocks = great AI
subjects; the *detail* is AI, the tower *structure* is procedural.

- **Material state:** **broken + blooming** — ancient mossy stone, dappled light.
- **Silhouette:** serene, symmetrical, unmistakable at speed — the faces must
  read as *watching* from 200 m.

```
[style] + serene giant carved stone face, Bayon four-faced tower block, mossy
weathered sandstone, calm closed-eyes expression, solid closed form, warm gold
stone in green dapple
```

### Hero sculpts — Statue of Liberty · monumental figures

*Used by:* Liberty (finale postcard). Larger-than-life; AI body + procedural
fine structure, conditioned and oversized.

- **Material state:** **broken-heavy** (copper-green verdigris) **+ blooming**
  (barnacle/algae waterline) **+ a glint of built** (survivor microgrid).
- **Silhouette:** the most important silhouette in the game — heroic, readable,
  end-of-day backlit.

```
[style] + Statue of Liberty, copper-green verdigris oxidation, riveted
construction, half-submerged at the waist, barnacle and algae waterline band,
solid heroic silhouette, warm end-of-day sunset backlight
```

### Compact salvage decor — anchors · chests · urns · barrels · bollards · crates

*Used by:* most tracks (debris, dressing). Solid closed objects — fast, clean AI
subjects (the AEGIS V body + a barrel were the first clean conditions).

- **Material state:** **built** (kept signage/barrels) or **broken** (debris) —
  tint per use; light salvage weathering, never grimdark.

```
[style] + single salvage [anchor / wooden chest / ceramic urn / metal barrel /
mooring bollard / shipping crate], solid object, stylized, lightly weathered,
[built warm paint | broken oxidised] finish
```

---

## Procedural lane — hard-surface + spanning families (no prompt)

Author via `bmesh`/Geometry-Nodes (the existing landmark + props-library
builders). Art direction still applies — these just don't go through ComfyUI.

### Towers + facades — lighthouse · spire · Campanile · skyscraper grid

- **Material state:** **built** where the city is kept (Shibuya neon, Golden Gate
  microgrids) · **broken** where drowned (Liberty rooftops, the submerged grid).
  Same archetype, opposite tint — that contrast *is* the world.
- **Silhouette:** the landmark sells the place; lock it first. Trim sheets
  (per-cup) carry window/ledge/signage detail; emissive for lit windows + neon.

### Arches + tunnels — Maw arches · Rialto · aquarium shell

- **Material state:** **broken + blooming** — weathered rock/concrete with a
  kelp + tide-stain waterline; wet-read at the surface, dry above.
- **Silhouette:** clean columnar/arched primitives — exactly the case where
  procedural beats a fragmented AI arch.

### Industrial rigs — gantry cranes · supertanker · bridge towers + cables

- **Material state:** **built (running) + broken (oxidised)** — Marina Bay's
  "automated itself and nobody told it to stop." Sodium-yellow work-lights are
  legit emissive; oxidised hull reds + rust streaks for the broken half.
- **Silhouette:** read the crane jib / tanker hull from afar; cables + lattice
  stay procedural (they'd fragment in AI).

### Water-feature structures — wave-pool · slide · lava-waterfall ridge

- **Material state:** Aqualand = **broken + faded-built** (sun-bleached primaries,
  algae, the still-running generator). Kilauea = **volcanic** (lava emissive,
  basalt, steam) — its own grade, not the three-state mix.

### Thin street dressing — lamp posts · antenna masts · gates · turn-indicators

- **Material state:** **built** (kept/powered) — mostly. Lamp posts + neon
  signage are emissive survivor-life cues.
- **Silhouette:** thin by nature → procedural only. Keep them sparse on the line.

### Coral fans · kelp · branching foliage · palms

- **Material state:** **blooming** — the life-reclaim layer; vivid, soft leaf
  translucency, vertex-sway.
- **Silhouette:** thin/branching → procedural/GN scatter (the foliage-sway hook
  reads `COLOR_0.r`). Palms scatter at volume; coral *fans* and kelp fragment in
  AI, so author them as GN.

---

## Glow props — the emissive privilege

*Murano furnaces · microgrid survivor windows · torch flame · neon signage · lava
· bioluminescent waterline.* These pair with the emitter system
(`kind="emitter"`) and the emissive `mat_*` setup.

- **Material state:** **built + emissive** — these are the game's "alive" signal.
  At night they're what tells the player a drowned place is *inhabited*, not
  abandoned. That's the whole "defiant & alive" thesis in one prop.
- **Rule:** nothing else on the track emits (pillar 6). Author emissive strength
  to bloom without smearing; test against the track's worst-case sun angle.
- **Per-track glow accents:** Shibuya kanji neon · Marina Bay sodium lamps ·
  Doge's furnace-orange · Hatteras lamp room · Liberty torch flame · Golden Gate
  microgrid windows · Kilauea lava · Aqualand countdown sign.

---

## References

- [art-direction.md](./art-direction.md) — the parent register, material-state
  rule, glow rule, palette-family hexes.
- [props-production-plan.md](./props-production-plan.md) — production lanes,
  the AI-suitability rule, the conditioning pass, per-prop definition-of-done.
- [track-art-direction.md](./track-art-direction.md) — which material-state
  ratio + palette each track wants the props tinted to.
- [track-art-pass-playbook.md](./track-art-pass-playbook.md) — placing + dressing
  props on a track (AI-corridor clearance, seating, re-export).
- make-props skill / [`tools/make_level_props.py`](../tools/make_level_props.py)
  — drives the ComfyUI concept phase these prompts feed.
</content>
