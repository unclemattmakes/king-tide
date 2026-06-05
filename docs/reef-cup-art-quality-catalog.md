# Reef Cup — Art-Quality Catalog (path to AA-indie)

> **Companion to** [reef-cup-vertical-slice-status.md](reef-cup-vertical-slice-status.md).
> That doc answered *"is it wired / does it exist?"* — and over-credited
> "set-piece **built**" as if a box labelled `seaplane` were done. **This doc is
> the craft audit:** what's the *quality* of what exists, and what's the actual
> work to take the Reef Cup from "blocked out + checked off" to **AA-quality
> indie polish.**
>
> **Method:** every asset below was opened in Blender (`C:\project-content\hoverbike\tracks-src\*.blend`)
> and **judged by eye** in a clean solid-shaded viewport — not inferred from
> face counts. (Face counts misled badly: Cape Town's `cape_wheel` and
> `great_white` carry primitive *datablock names* — `Torus.004`, `Sphere` — yet
> are properly modelled. Datablock name ≠ geometry. Verify by looking.)

---

## The bar: what "AA-quality" means *for this game*

The target register is **not** photoreal PBR — it's the project's own
[**"clean stylized toy"**](art-direction.md): confident low-poly silhouettes,
bold colour blocking, Wind Waker / Wipeout confidence. So "AA-quality" here
means the **polish tier** of a strong stylized indie, which is four things the
current build mostly lacks:

1. **Silhouette that reads the real thing** at 40 m/s — a seaplane reads as a
   *plane*, a mansion as a *mansion*, the mountain *dominates*. Boxes labelled
   with the right name don't count.
2. **Stylized-but-rich materials** — not flat single-colour plastic. Gradient/
   value variation, baked AO in the crevices, edge/rim wear, the **waterline
   trio**, working **emissive** for powered things. This is the single biggest
   "looks shipped vs looks placeholder" lever after silhouette.
3. **Composition, lighting & post** — the hero set-piece is framed, lit, and
   carries the postcard; grade/bloom/fog do real work.
4. **Density** — JetMoto / Wave-Race edge-clutter (props, foliage, boats,
   debris) so the world feels lived-in, racing line swept clean.

The geometry **register is right and the layouts work.** The gap is that most
assets sit at **clean-blockout** quality, materials are **flat untextured
colour** everywhere, and the **three hero set-pieces — the postcards — are the
weakest assets relative to their importance.**

## Quality tiers (used in the tables)

- **A — shippable low-poly:** real modelled form, reads at speed. Needs only
  material + weathering polish.
- **B — good blockout:** correct massing/forms, but missing the detail/break/
  material that makes it land. A *detailing* pass, not a rebuild.
- **C — crude blockout / kit-box:** a primitive or box-kitbash standing in for
  the thing. Needs **real modelling** or **replacement with a library prop.**

---

## Cross-cutting craft gaps (these touch every asset)

### A. Materials are flat, untextured colour — **the biggest lever**
- **All three GLBs ship `images: 0`** — zero texture maps. Every material is a
  single flat `baseColorFactor`. No AO, no normal/roughness detail, no gradient,
  no painted wear. Even the genuinely-good geometry (the wheel, the shark) wears
  flat plastic.
- **No weathering reaches any building or prop** — the **waterline trio**
  (coral/crust/salt) and the **built/broken/blooming** wear are a
  vertex-colour/`COLOR_0` job, and `COLOR_0` is missing on every non-terrain
  mesh (the [COLOR_0 export gap](reef-cup-vertical-slice-status.md#cross-cutting-findings-fix-once-all-three-benefit)).
  So today nothing has barnacles, rust streaks, salt bleach, or algae — the
  "working ruin" / "defiantly alive" notes are entirely unexpressed.
- **Emissive is unverified.** South Beach authored `mat_track_sb_neon_*` and Cape
  Town/Sandbar have signage materials, but whether they actually *emit* (the
  "only powered things glow" rule) needs confirming — in-engine nothing glows.
- **Work:** a stylized-material system pass — even just **baked AO + a
  gradient/edge-wear ramp + the waterline trio + working emissive** — would lift
  *every* asset on *every* track at once. Highest ROI art task in the cup.

### B. The "clean stylized toy" detail vocabulary isn't applied
Boxes are fine *as a starting point* for this register, but stylized games sell
boxes with **chamfered edges, a bevel pass, eyebrow/awning shades, stepped
crowns, and a few signature curves.** None of that is present — the kit is
literal `8-vert / 6-face` cubes. A light **bevel + silhouette-cue pass** on the
building kits is cheap and transforms the read.

### C. Dressing density — *use the Quaternius library*
Per the CC0 `keep_material` lane (~56 multi-tone Quaternius props in
`public/assets/props/cc0/`), most **dressing is a placement job, not a modelling
job**: boats, crates, market stalls, barrels, urban kit, palms, cute-fish for
the aquarium, container props. South Beach + Cape Town currently place **zero**
runtime props. This is the fastest density win and needs no new art.

### D. The hero set-pieces don't carry their postcard (detailed below)
Art-direction's rule is "**the set-piece carries the postcard — build + light it
first.**" All three are currently the *weakest* assets on their track.

### E. Rigged/animated "life" props — a runtime lane is needed first

> **✅ Resolved 2026-06-05.** Both prerequisites below are done. A
> skinning-preserving ship lane ([`tools/blender/ship_animated_prop.py`](ai-prop-pipeline.md#animated-props-rigged-sea-life--skinning-preserving-lane))
> shipped the whole Animated Fish Pack (Shark, Whale, Fish1-3, Dolphin, Manta
> ray) to `public/assets/props/cc0/` with skin + `Swim` clip intact, and the
> runtime animated-prop lane (`src/engine/render/animated-props.ts`) drives a
> `THREE.AnimationMixer` per placement — confirmed rendering + **deforming** on
> WebGPU. **First consumer:** Cape Town's *Two Oceans Wreck* — the static
> `great_white` was removed (blend + GLB) and replaced with an animated
> `cc0/shark` `props[]` entry that swims in the tank. Whale/fish/gull schools are
> now unblocked (instanced-skinned school density is the one follow-up).

Preferred direction (Matt, 2026-06-05): replace bespoke decorations like the
shark with the **rigged + animated library props**, not hand-models. The library
*has* them — the Quaternius **Animated Fish Pack**
(`external/quaternius/extracted/animated-fish/glb/`) ships **Shark, Whale, Fish1–3**,
each with a real **armature skin + a `Swim` animation clip** (verified). That's a
strictly better great white than the current sphere-derived mesh, and it *moves*.
**Two prerequisites, both currently missing:**
1. **Not shipped + the conditioner blobs rigs.** Only *static* fish
   (`clownfish`, `blue_tang`) are conditioned into `public/assets/props/cc0/`;
   the animated pack was deferred because `condition_ai_batch` bakes/strips the
   skin (the shipped clownfish has 0 skins / 0 animations). Needs a
   **skinning-preserving ship lane** (or ship the rigged GLB more directly).
2. **The runtime has no skeletal animation.** There is **zero**
   `AnimationMixer` / `SkinnedMesh` / `clipAction` in `src/` — the prop system
   loads static meshes only (even the rider is *procedurally* posed, not
   clip-driven). A shipped-but-undriven shark would freeze in bind pose. Needs a
   new **animated-prop path**: load the GLB's `skins` + `animations`, build a
   `THREE.AnimationMixer` per animated-prop instance, tick it each frame, with a
   perf budget + LOD/instancing story for schools.

**Why it's worth it:** this is a *reusable* feature, not a one-off. Once the
runtime drives skinned GLBs, you unlock the whole pack — the **Two Oceans great
white circling**, fish schools in the shallows, the whale on the horizon, gulls,
and any future animated prop — which is the cheapest, biggest "the world is
*alive*" win in the cup (a core art-direction note). Interim if the feature
slips: **kinematic circling** (path-follow the static shark mesh) gives motion
without body deformation — cheaper, but no tail-swim.

---

## Sandbar — current craft ceiling (our most-complete track)

Sandbar is the reference for "our current best," and even here the hero is a
blockout. The dock structure is the nicest thing in the cup.

| Asset | Tier | Eye-verified state | AA work | Approach |
|---|---|---|---|---|
| Marina **dock/deck + pilings** | **B** | Clean: deck box on proper **cylinder stilt pilings** — reads as a pier | Plank/board detail, weathered timber material, rope/cleat dressing | Detail + material |
| Marina **shack** | **C** | A `6×5×4.8 m` **box + pyramid roof + box sign** — no door, windows, corrugation, or character | Real characterful shack (corrugated tin, door, signage, string-lights, clutter) | **Model** — *or wire in the existing `pilot_shack.glb` AI prop, which was built but isn't placed (the box is used instead)* |
| **Sea-stacks** ×6 | **B** | GeoNode-shaped rocks — decent organic form | Material (wet/algae waterline), maybe silhouette variety | Material |
| AI props (sea-boulder, anchor, wreck, cab) | **B** | Conditioned AI-pipeline props, real form | Material/weathering pass | Material |
| **Crest-launch dune** | **?** | **Not found as a named mesh** — the wave-mastery lesson may be terrain-only | Author a clean packed-sand launch lip that reads | Verify → model/terrain |

**Headline:** wire in the better `pilot_shack` that already exists; give the
marina the waterline + timber-weathering it's missing; confirm the crest dune.

---

## South Beach Sunken — 100% box-kitbash (most work)

Every object is `8 verts / 6 faces` — the **entire track is stacked boxes.** The
material palette (pastel + neon) is authored and the massing/layout is right, but
there is **no modelled detail anywhere**, and the two signature assets (the
Versace mansion and the **seaplane launch ramp**) are box piles that won't read.

| Asset | Tier | Eye-verified state | AA work | Approach |
|---|---|---|---|---|
| **Versace mansion** (`base/tier/tower/steps`) | **C** | **3 stacked boxes + 5 box steps.** No arches, columns, tiled roof, balustrade, ornament | The ornate Casa-Casuarina read — arched loggia, columns, terracotta tiled roof, grand steps | **Model** (hero) |
| **Seaplane ramp** (`wingramp/fuse/tail/floats`) | **C** | **Boxes.** A box "fuselage" + box "wing" — reads as a crate, not a plane | Curved fuselage, airfoil wing (the takeoff lip), engine cowl, struts, floats — must read as a vintage seaplane *and* a launch ramp | **Model** (hero, gameplay-critical) |
| **Hotel kit** (`sb_s/i/r_*`, ~10 buildings) | **C** | Box mass + box parapets + box "windows" (glass-coloured slabs) + box awning + neon strip | Deco silhouette cues (curved corners, eyebrow shades, stepped/ziggurat crowns, vertical fins); modelled window recesses; working neon | **Detail the kit** (lifts all 10) + material |
| **Lifeguard hut** | **C** | Box hut + box roof + box rail on 4 cylinder legs | Pitched roof, open front, ladder, flag — small charming model | Model (small) or library |
| **Barge / wrecks** | **C** | Boxes | Hull shaping + rust weathering | Model or library |
| **OOB skyline dressing** (crane, billboard, ships) | **C** | Boxes | Distant silhouette — boxes may pass with material; or library | Material / library |
| **36 palms** | **B** | Instanced palm kit — fine | Sway + material | Material |

**Headline:** the two postcards (mansion + seaplane) need real modelling; the
hotel kit needs a Deco-silhouette + neon pass (do it once on the kit, propagates
to all 10); then materials + the dark-render fix from the status doc.

---

## Cape Town Drift — mixed (the best *and* some of the worst)

The most uneven track: two genuinely-good modelled assets, a solid set-piece
blockout, and two crude ones.

| Asset | Tier | Eye-verified state | AA work | Approach |
|---|---|---|---|---|
| **Cape Wheel** | **A−** | **Properly modelled Ferris wheel** — double rim, radial spokes, hub, ~16 gondola cabins | The "half-tilted/leaning" character, gondola detail, rust/weathering, material | Material + lean tweak |
| **Great white** | **A** | **Cleanly modelled shark** — reads unmistakably — but static | **Replace with the rigged Quaternius shark** (skin + `Swim` clip) so it *circles + swims*; light it to silhouette through the glass | **Swap to rigged lib prop** — needs the animated-prop runtime lane (cross-cut **E**) |
| **Aquarium hall** | **B** | **Barrel-vaulted hall** with modelled ribs, end wall, base — but **intact & clean** | The set-piece is a *shattered* tank: jagged broken glass, the skylight-rim shortcut edge, **lit interior**, glass material, weathering | Detail (break it) + material |
| **Table Mountain** (`horizon_ring`) | **B** | Flat-top mesa **profile is correct**, but a thin smooth single-side silhouette that **washes into the sky** | More dominant proportion, value contrast (grey-green + cliff face), atmospheric separation so it reads as *the* landmark | Proportion + material |
| **Wreck containers** | **B−** | Box stacks (containers *are* boxes, so silhouette OK) | Corrugation, door detail, **oxidised-red rust/barnacle** waterline (the dominant "broken-50%" note) | Detail + material (or library container props) |
| **Grounded freighter** | **C** | **~6 boxes** — wedge hull + stacked superstructure, no raked prow/deck/funnel/rails | Real ship silhouette | **Model** or library (maritime CC0) |
| **Harbour dressing** | **C** | **Box-row skyline** — building masses + box roofs on a quay; no windows/doors/stalls/boats modelled | Survivor-harbour character + market stalls + boats | **Library props** (urban/ship/market kit) > modelling |

**Headline:** the wheel + shark are nearly there (mostly material/lighting);
*shatter and light* the aquarium; make the **mountain dominate**; replace the
freighter + harbour box-fill with library props + a weathering pass.

---

## The three postcards (where to spend hero effort)

Each track's design names a set-piece that must "carry the postcard." All three
are currently their track's **weakest** asset:

1. **South Beach — Versace Steps + seaplane** → stacked boxes. The single
   highest-visibility miss in the cup: it's the track's hero shot *and* the
   launch ramp the player reads for gameplay. **Two real models.**
2. **Cape Town — Two Oceans Wreck** → a good *intact* arched hall + a good shark,
   not yet a *shattered, lit* predator tank. **A detailing/break + lighting pass**
   on assets that are already 70% there — best effort-to-payoff in the cup.
3. **Sandbar — marina hub** → a box shack on a nice dock, when a **better AI
   `pilot_shack` already exists unused.** Possibly a *wiring* fix, not a build.

---

## Sequence & rough effort to AA

Front-load the **shared material/weathering system** — it lifts everything — then
hero-model the postcards, then detail the kits, then dress.

0. **South Beach flipped-normals fix — ✅ DONE (2026-06-05).** Every SB mesh
   shipped with inward normals → rendered black. Recalculated-outside (210
   meshes) + re-exported; the hotels now render pastel with glowing neon
   in-engine (details in the status doc). SB's art is now *visible* — the rest
   of this catalog can proceed on top of it.
1. **Material/weathering system pass** (shared): COLOR_0 fix → baked AO + edge-wear
   ramp + **waterline trio** + working emissive, applied across all three. *The
   highest-ROI task; do it first.* **~2–4 days.**
2. **Hero set-pieces** (the 3 postcards): South Beach mansion + seaplane (model),
   Cape Town aquarium shatter + lit interior (detail), Sandbar shack (wire the AI
   prop or model). **~4–7 days.**
3. **Kit silhouette pass**: bevel/Deco cues on South Beach's hotel kit; container
   corrugation; freighter remodel/replace. **~3–5 days.**
4. **Landmark legibility**: Table Mountain proportion/material/atmosphere; Cape
   Wheel lean; seaplane read. **~1–2 days.**
5. **Dressing density via Quaternius**: place boats, crates, market stalls,
   barrels, aquarium fish, palms to JetMoto density on all three. **~2–3 days.**
6. **Lighting + grade + post** per track (sky grades, calm-water zones; the SB
   dark render is *not* here — it's the step-0 normals fix). **~2–3 days.**

**Rough total to AA-indie across the three tracks: ~3–4 focused art weeks**, on
top of the wiring/playability work in the status doc. The biggest accelerators
are (a) the shared material system — one pass, every asset benefits — and (b)
leaning on the **Quaternius library + the AI prop pipeline** so dressing and a
few heroes are *placement/generation*, not hand-modelling.

> **Honest summary:** the blocking pass got the layouts, massing, and a few
> genuinely-good models (Cape Town's wheel & shark) in place — that's real
> progress. But "AA-quality" is a **craft pass that has barely started**:
> flat untextured materials everywhere, no weathering, box-kit set-pieces, and
> three postcards that don't yet sell their shot. None of it is *blocked* — it's
> just the art-production work, and it's weeks, not days.

---

## References
- [reef-cup-vertical-slice-status.md](reef-cup-vertical-slice-status.md) — the
  wiring/playability/render-bug companion (read together).
- [art-direction.md](art-direction.md) · per-track `*-art-target.md` — the
  concept-art targets each asset is measured against.
- CC0 Quaternius library: `public/assets/props/cc0/` +
  `specs/props/cc0/quaternius.json` (the `keep_material` multi-tone lane).
- AI prop pipeline: [ai-prop-pipeline.md](ai-prop-pipeline.md) — for hero props
  like `pilot_shack` (built, unused) and bespoke set-piece detail.
