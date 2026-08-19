# King Tide — Painterly Aesthetic & Style-as-Legibility Plan

> Research + roadmap for two linked goals: (1) deepen the procedural **painterly**
> look toward the Sea of Thieves × TF2 × Arkane target, and (2) **use that style
> to increase the legibility of gameplay events at race speed** (the arcade-racer
> thesis). Where [art-direction.md](./art-direction.md) sets *what the look is*
> and [painterly-vinyl-pipeline.md](./painterly-vinyl-pipeline.md) sets *how we
> impose it on assets*, this doc sets *how we deepen the render model* and *how we
> turn style into a gameplay-readability system.*
>
> **Canonical for:** the illustrative-lighting upgrade, the contrast/saturation
> budget, and the style-as-legibility mechanics.
> **Defers to:** [art-direction.md](./art-direction.md) (the register, the two
> ditches, material-state + waterline rules), [painterly-vinyl-pipeline.md](./painterly-vinyl-pipeline.md)
> (material intake + the shared vinyl material), [water-next-research.md](./water-next-research.md)
> (the water readability layers it references), [design-targets.md](./design-targets.md)
> (the 40 m/s / 60 fps perf contract).
>
> Status: **research complete; foundations + first wins implemented** (2026-06-14
> — see [Implementation status](#implementation-status-2026-06-14)). File/line
> refs are pointers and will drift — grep the symbol, not the line.
>
> **Update (2026-06-16 — water look pass).** The water P1 readability **overlays**
> championed below (contour-line foam, the posterized value ramp, rising-face
> strokes, Langmuir lanes) were found to be collectively reading as *allover
> noise* when shipped at full strength, and were flipped to **near-zero global
> defaults**: the curvature whitecap + value ramp carry the swell read, with only
> a whisper of solid contour relief. `contourBreakup`, `langmuir` and `riseStroke`
> were then REMOVED outright (2026-06-17 perf pass — each still cost a per-fragment
> texture sample even at 0). The look pass also added two render
> knobs — `reflRoughness` (roughness-coupled reflections) + `paintNormal` (a
> painterly macro-normal). The legibility *thesis* below stands; the water layers
> are just dialled to a whisper rather than full. Detail:
> [water-next-research.md](./water-next-research.md).

---

## TL;DR (say it in one breath)

We already made the one architecturally correct bet — **the paint lives in
materials and surfaces, not in a screen filter** — which is exactly the bet Valve
(TF2) and Rare (Sea of Thieves) both made, and for the same reason: it's the only
painterly approach that stays *temporally stable at 40 m/s*. So the path forward
is **not** a Kuwahara/oil-paint post pass. It's three moves:

1. **Add the illustrative *lighting* model we never built.** Today every painterly
   trick (brush strokes, weathering, rim, edge-wear) is composited into the
   **albedo** of a stock PBR material — the *lighting* is still physically based.
   The single biggest "more painterly" lever is the **TF2 diffuse warp ramp**
   (Half-Lambert → 1D ramp: cool shadows, warm terminator, slight overbright) plus
   a proper **additive rim**. Cheap, temporally bulletproof, transforms the read.

2. **Author a contrast/saturation budget.** Painterly's superpower over photoreal
   is that *you* decide where the lights, darks, and saturation go. Hold the world
   in a muted band so the brightest, most-saturated thing on screen is **always a
   gameplay event**. This is the foundation of the legibility thesis.

3. **Spend that budget on a small, reserved vocabulary of style signals** wired to
   the gameplay events the player must parse at speed — boost, hazard, pickup, the
   racing/wave line, drift/charge state, rivals, the wave face itself. Style stops
   being decoration and becomes the HUD.

---

## Implementation status (2026-06-14)

Built on branch `claude/painterly-legibility` via parallel Opus-agent passes.
Foundations shipped default-off; then, per Matt's call, the **diffuse warp**, the
**prop waterline trio**, and **foam oil-strokes** were flipped **on by default**
(see "Defaults flipped ON" below). Every commit passes `pnpm typecheck` /
`pnpm test` (1249) / `pnpm build`, headed-verified on real WebGPU.

**Landed (committed):**
- **A1 — TF2 illustrative lighting** ([illustrative-lighting.ts](../src/engine/render/illustrative-lighting.ts)):
  warp-ramp diffuse + true additive rim via an `IllustrativeLightingModel`
  (subclasses `PhysicalLightingModel`, overrides only `direct()` — shadows /
  ambient / specular preserved). **`illum` now defaults ON (1)** — the warp is the
  default vinyl look; the additive `rimEmissive` stays 0 (it's the signal channel).
  **Verified headed (real WebGPU).** Tune: dev palette → Tuners → **Brush strokes**
  → *Illustrative warp* / *Rim glow* (live, in-race).
- **A2 — scene-wide colour grade** ([post-pipeline.ts](../src/engine/render/post-pipeline.ts)):
  identity-default `setGrade()` + per-track `sky.scenicGrade` authoring. The
  contrast-budget vehicle. **Verified headed.** Toggle: dev palette → World →
  **Scene grade (muted)** (coarse on/off); per-track via `sky.scenicGrade`.
- **A3 — SoT crest sub-surface glow** ([water.ts](../src/engine/render/water.ts)):
  in-fragment (no new varying/uniform), default 0. Dial: dev palette → Tuners →
  **Water debug** → *Crest SSS glow* (or `?waterlab`).
- **B0 — signal-colour vocabulary** ([signal-colors.ts](../src/engine/render/signal-colors.ts)):
  the reserved, double-coded palette (blue/orange primary).
- **B1 / B5 — rim-as-signal** ([signal-state.ts](../src/engine/render/signal-state.ts)):
  three cues, all behind a default-off master flag (dev palette → Toggles →
  **Gameplay signals (rim)**; `?signals=1` / `window.__signals` for automation):
  (1) **drift-charge ladder** on every bike incl. the player's own (instanced +
  single-mesh hops wired); (2) **magenta pickup pulse**; (3) **rival draft rim**
  ([fx/index.ts](../src/engine/render/fx/index.ts)) — a rival you're drafting rims
  cyan, one drafting you rims warm (render-only XZ cone, no sim component).
  **Finding:** the charge ladder only fires on a **human mini-turbo drift-charge**
  (AI don't drift-charge); the **rival draft rim is the broadly-visible cue** and is
  headed-verified firing (warm on a drafting rival, eid 161, strength 0.7).
- **A0a — foliage sway** backend wired at boot (WebGL2-fallback fix + verification
  harness); the TSL sway itself was already correct — the original "broken on
  WebGPU" item was stale doc drift (fixed in PR #260).

**Defaults flipped ON (2026-06-14, Matt's call — the look-changing knobs):**
- **Diffuse warp** (`illum` 0 → 1) — the TF2 re-light is now the default vinyl look.
- **Prop waterline trio** — props get the algae/barnacle/salt-bleach bands by
  default (world-height gated; sea level threaded from `track.water.height`); opt
  out per prop via `Prop.waterline = false` (per-asset for instanced placements).
- **Foam oil-strokes** — already the default (`FOAM_BRUSH_DEFAULT = 1.0`); confirmed.
- **Water readability layers** (contour lines / value ramp / rising-face strokes /
  Langmuir) — found to be **already ON by default** (non-zero constants); confirmed
  visible on open-ocean swell. The plan's earlier "default-off" note was wrong.
- **Rival draft rim** — shipped this pass (render-only, default-off behind signals).

**Remaining work / resolutions:**
- **B3** racing/wave-line flow ribbon — **delivered** by the spawned A4/B3 session
  ([racing-line-ribbon.ts](../src/engine/render/racing-line-ribbon.ts) + a dev-menu
  toggle + `tools/verify-raceline.mjs`): a Forza-grammar cool/warm ribbon along the
  track's `main` `aiSplines` line (reused, not re-derived) with scrolling
  brushstroke flow + a forward chevron in the **alpha** (the painted surface IS the
  arrow), default-off. One unlit `MeshBasicNodeMaterial`, `renderOrder = 1` (the
  ghost-vs-water sort fix), `depthTest` on so crests/terrain/the bike occlude it; a
  lead-fade keeps it brightest around + ahead of the bike. Master flag DEFAULTS OFF
  (frame byte-identical until enabled): dev palette → Toggles → **Racing-line
  ribbon**, `?raceline=1` for e2e, `window.__raceline` (enable + live width /
  opacity / flow / brake dials; the chevrons flow FORWARD along the race line — a
  negative `flowSpeed` reverses the scroll). **Verified headed (real WebGPU, 0
  console errors):** reads as a green flow band tracing the line, fading ahead,
  warming to amber on the curved approaches; clean on/off. (A first pass had the
  chevrons pointing backward — the arrow geometry was rebuilt from a single
  "distance behind the tip" term so vertex + crisp edge + scroll can't disagree.) *In the working tree on
  `claude/painterly-a4b3`, pending a playtest pass.* **Open for the playtest:** over
  Mayday Bay's teal lagoon the ideal-green sits a touch close in hue (it pops more
  over deep-blue ocean + with the A2 muted grade on) — colour balance, width and
  brake thresholds are the live dials for the owner to sign off by eye.
- **A4** painterly normals — assessed headed (warp `illum=1` default-on) and
  **already covered**, not separately implemented. The vinyl material's
  `normalNode = bumpMap(streak, uBrush.mul(2.5))`
  ([painterly-vinyl-material.ts](../src/engine/render/painterly-vinyl-material.ts))
  already perturbs the shading normal from the brush-stroke height, and that
  perturbed `normalView` flows through the TF2 ramp — so the *lighting* already
  reads brushed. Cranking `brush` moves mostly the **albedo** mottle; the
  normal-relief term is a subtle tertiary contributor at race distance, and the
  curvature half is carried by the edge-wear convexity drybrush (`COLOR_0.A`, wired
  + on). A dedicated tangent-space brush normal map would only refine that tertiary
  term, at the cost of authoring a sheet, an extra fetch on every vinyl material,
  and double-perturbation risk — **below the bar.**
- **B2** event juice — **CUT** (2026-06-15, Matt's call): hitstop touches sim
  timing, which we won't risk in a multiplayer game. The render-only parts (event
  flash, anticipation telegraphs) remain possible later but are deprioritized.

**How to evaluate:** run headed on your own server (`pnpm dev --port <N>
--strictPort`, or `BASE=… node tools/verify-painterly.mjs` for an autopilot
capture), open the **dev palette (Ctrl/⌘K)**, and flip the entries above by eye —
nothing changes the look until you do. The warp ramp curve, grade values, and
signal hues are all playtest-validatable starting points, not final. (Note:
`?propviewer` has its *own* per-prop sliders and is **not** wired to the live
brush tuner — exercise illum/rim in-race.)

---

## Part 1 — Where we are (verified against the code)

The painterly look is **~80% material-space brush impasto + ~20% GPU procedural
foam**, with minimal post. This is an accurate inventory, not the aspirational doc.

### Shipped and ON by default

| Technique | Where | Mechanism |
|---|---|---|
| Triplanar real-oil brush strokes | [painterly-vinyl-material.ts](../src/engine/render/painterly-vinyl-material.ts) (`brushHeightTriplanar`, ~L345-423), [terrain-shader.ts](../src/engine/render/terrain-shader.ts) | Shared `brush_strokes.png` (3 stroke scales packed R/G/B), triplanar, size-adaptive; world-space on statics, object-space on movers (bikes/riders). Modulates albedo **and** roughness/normal (impasto relief). |
| Procedural weathering wash | painterly-vinyl-material.ts (~L339-343) | 2-octave value noise → ±brightness mottle. |
| Soft fresnel rim | painterly-vinyl-material.ts (L458-463) | `pow(1−N·V, 3)` mixed **into albedo** toward a warm tint. |
| Edge-wear drybrush | painterly-vinyl-material.ts (L449-456), [edge-wear-convexity.ts](../src/engine/render/edge-wear-convexity.ts) | Convexity baked in `COLOR_0.A` → drybrush convex ridges. |
| Bloom | [post-pipeline.ts](../src/engine/render/post-pipeline.ts) | Per-track `sky.bloom`; the "finished" lift. |
| Stylized water | [water.ts](../src/engine/render/water.ts) | Analytic Gerstner (not FFT), oil-stroke foam (mass+streak sheets), curvature whitecaps + leading-edge bias, wave zones/sets/spectrum presets, Wind-Waker dark-twin, warm crest tint. |
| Painted UI ("Regatta") | [ui-art-direction.md](./ui-art-direction.md) | Hand-painted race-day signage; "glow is a privilege." |

### Built but OFF / opt-in / parked

| Technique | Where | State |
|---|---|---|
| **Diffuse warp / toon ramp** | infra `makeRampTexture` in terrain-shader.ts | **Never wired into the vinyl material.** The lighting is stock PBR. |
| Cel/ink **outline** (Sobel) | post-pipeline.ts (L31-35, `setOutline`) | Default-off; requires rebuild. *Should stay off* — see Part 6. |
| Motion blur | post-pipeline.ts | Default-off. |
| Scene-wide **colour grade** | — | Missing; grade is **dome-only** ([sky.ts](../src/engine/render/sky.ts)). |
| Water **contour lines / value ramp / rising-face strokes / Langmuir lanes** | water.ts | **ON by default** (`CONTOUR_STRENGTH` 0.55, `RAMP_STRENGTH` 0.45, `RISE_STROKE` 0.5, `LANGMUIR` 0.6) — read on open-ocean swell, subtle on calm lagoons; live-tune in the Water debug panel. *(An earlier "default-off" note was wrong.)* |
| Waterline trio on **props** | [waterline.ts](../src/engine/render/waterline.ts) | Opt-in, mostly off; terrain ships it. |
| Foam oil-strokes vs discs | water.ts (`foamBrush`) | Default `0` = round discs; oil-strokes off. |

### The legibility gap (the important finding)

**Gameplay events drive particles and camera FX — never the style/material layer.**
- [pump-fx.ts](../src/engine/render/pump-fx.ts): FOV punch + shake + DOM speed-lines on wave-pump.
- [fx/index.ts](../src/engine/render/fx/index.ts): spray/spark particles, reading `DriftStateStore` / `HoverStateStore` / `ControlIntentStore` **read-only**.
- Drift boost: speed-lines only. Collision/contact: spray particles.

There is **no** reserved-hue vocabulary, **no** rim-colour-as-signal, **no**
racing/wave-line cue, **no** anticipation telegraph, **no** hitstop, and the one
wave-shape legibility tool that exists (contour foam) is **off by default**. The
painterly look is *static* — keyed to geometry and water state, not to what the
player just did or needs to do next. **This is the whole opportunity.**

### Known look-debt that undercuts the goal

- **Foliage sway is broken on WebGPU** (the primary path) — palms/banners sit dead
  still; kills the "alive" pillar *and* removes peripheral motion the eye uses to
  judge speed/position. (rendering-tech-review.md P0.)
- **Mid-ground filler missing** — 11/12 tracks have zero foliage scatter
  (level-visual-quality-research.md). Density is what sells "alive" and frames the
  clean racing line.
- **Materials still flat on many landmarks** — trim sheets exist for Shibuya only;
  hero set-pieces are boxes (reef-cup-art-quality-catalog.md).

---

## Part 2 — Where we need to be (from the research)

Three reference games, three transferable lessons (full sourcing in
[References](#references)):

**Team Fortress 2 — *Illustrative Rendering in TF2*, NPAR 2007.** The look is a
**view-independent + view-dependent lighting model**, summed per-pixel:
- **Half-Lambert** (`N·L * 0.5 + 0.5`) feeds a **1D diffuse warp ramp** (a texture
  lookup): grayscale on the lit side, **cool gradient in shadow (never black)**, a
  **reddish saturation spike at the terminator**, and a `×2` after the lookup for
  controllable overbright. *This single ramp is ~70% of the TF2 read.*
- **Rim** = `pow(1 − N·V, 4)`, masked, combined with sharp Phong via `max()`, plus
  an **upward-biased** view-ray ambient rim (`saturate(N·up)`) so silhouettes read
  even away from lights. Crucially the rim is its **own additive term**, strongest
  where you need to separate from background.
- Valve frames all of this as **readability-first**: "quickly identify other
  players… assess the possible threat." The world is **muted**; saturation is
  **hoarded** on gameplay-critical things. They explicitly chose object-space brush
  strokes over an image-space painterly pass for "superior perceptual properties"
  (frame-to-frame coherence). *We made the same choice; we just stopped at albedo.*

**Sea of Thieves — *The Technical Art of SoT*, SIGGRAPH 2018.** (SoT ships FFT, but
the *techniques* port to our Gerstner pipeline.)
- **Water colour = scattering approximation, not PBR**: lerp deep-water ↔
  sub-surface colour by a **wave-peak mask derived from choppiness offset** — crests
  glow translucent. Direct lift onto our per-vertex choppiness.
- **Foam = feedback-blurred buffer blended with hand-authored foam textures**,
  **state-driven** by sea state (we already have a Beaufort knob).
- **Hand-painted low-noise albedo + art-directed sky** carry the soft tone;
  "use the light source to change the mode" — lighting/time-of-day is a *primary*
  stylization lever.

**Arkane.** *Dishonored*: painterly read from **hand-painted albedo + exaggerated
proportion**, restrained lighting — validates spending effort on
albedo/silhouette, not filters. *Deathloop*: the "graphic" read is mostly
**characterful colour grade (LUT) + 2D graphic overlays** — cheap, temporally
rock-stable, stacks on top of everything else.

**The legibility literature** (Valve, Swink's *Game Feel*, Vlambeer's *Art of
Screenshake*, Disney principles, racing-genre grammar) converges on one system:
**contrast/saturation budgeting.** Keep the environment in a narrow value +
saturation band; spend pure saturation, top-of-value, reserved hues, hitstop, and
exaggerated staging **only** on events the player must parse. Painterly *enables*
this because you author the value structure; photoreal *fights* it because PBR puts
contrast wherever the sun and materials happen to.

---

## Part 3 — The strategic spine (two framings that drive the plan)

**A. The look's missing layer is *lighting*, not more albedo tricks.** We have
brush + weathering + rim + relief all baked into `colorNode` on a
`MeshStandardNodeMaterial` (painterly-vinyl-material.ts L294, L465) — then lit by
default PBR diffuse. Adding the TF2 **illustrative diffuse + additive rim** is the
highest-identity, lowest-cost, zero-temporal-risk change available, and it's the
difference between "PBR object with painted texture" and "painted object." The
vehicle already exists (`makeRampTexture`); it's never been wired in.

**B. Legibility is a *budget*, and painterly is how you fund it.** Every frame has
a finite amount of "eye-grab" (contrast, saturation, motion, reserved hue). Today
the world spends it indiscriminately. The plan **caps world spend** (muted grade +
authored value) and **reallocates it to gameplay events** via a small, learned,
colour+shape+motion vocabulary. This is the through-line that makes "painterly" and
"legible at speed" the *same* project, not two.

---

## Part 4 — The gap, itemized

| Capability | Have | Need | Track |
|---|---|---|---|
| Illustrative diffuse (Half-Lambert + warp ramp) | ❌ stock PBR | TF2 1D ramp in the vinyl + terrain + water light comp | A |
| Additive rim as silhouette signal | ⚠️ rim mixed into albedo (gets lit) | rim as its own additive term; **rim colour as a state channel** | A + B |
| Scene-wide colour grade / contrast budget | ❌ dome-only | global muted grade + reserved-hue lockout | A + B |
| Crest sub-surface glow | ❌ | choppiness-peak → SSS lerp (SoT) | A |
| Wave-shape legibility (contour foam) | ⚠️ built, off | **on**, playtest-tuned | B |
| Reserved gameplay-colour vocabulary | ❌ | locked ~5-token palette, enforced | B |
| Boost / hazard / pickup style signals | ⚠️ particles only | anticipation + reserved hue + hitstop + shape | B |
| Racing/wave-line direction cue | ❌ | brushstroke-flow ribbon down the line | B |
| Drift/charge state on the bike | ❌ (HUD only) | painted rim/glow ladder in peripheral view | B |
| Peripheral motion ("alive") | ❌ sway broken on WebGPU | port sway to TSL `positionNode` | A (debt) |

---

## Part 5 — The plan (phased)

Two tracks run in parallel. **Track A** deepens the painterly render model;
**Track B** builds the style-as-legibility system on top of it. Do **A0/A1 before
B**, because the legibility budget assumes the illustrative-lighting + grade
foundation. Each item lists files, rough effort, risk, and how to verify (always
**headed Playwright on your own server**, hard rule 2 — never the in-app preview).

### Track A — Deepen the painterly look

**A0 — Fix the look-debt that undercuts everything (P0).**
- Port **foliage sway** to TSL `positionNode` so it runs on WebGPU (rendering-tech-review.md P0). *Files:* [foliage-sway.ts](../src/engine/render/foliage-sway.ts). *Effort:* S. *Risk:* low. *Verify:* `?propviewer` + a track with palms/banners; confirm motion at speed.
- Stand up the **WebGPU GPU-time profiler** (`?gpuprofile=1`) so every later step is measured, not guessed (rendering-tech-review.md P0, [gpu-profiler.ts](../src/engine/render/gpu-profiler.ts)). *Effort:* S.

**A1 — Illustrative lighting model (the keystone, P1).**
Add a TF2-style diffuse warp + true additive rim to the shared vinyl material, then
fan it out. *This is the single highest-value change in the doc.*
- Build a **1D warp-ramp** `DataTexture` (cool-shadow → neutral → warm-terminator,
  `×2` overbright) via the existing `makeRampTexture`; index it by **Half-Lambert**
  `dot(N,L)*0.5+0.5`. Apply by overriding the material's diffuse light response
  (TSL light-model hook on `MeshStandardNodeMaterial`, or a custom `lightsNode`).
- **Move the rim out of albedo** into an **additive** term (emissive-like), masked
  by Fresnel and upward bias `saturate(N·up)`, so it reads strongest on
  silhouettes against sky/water — and expose a **`rimColor` uniform per object**
  (this becomes a Track-B signal channel).
- *Files:* painterly-vinyl-material.ts (L458-465 rim, L294 material build),
  terrain-shader.ts (`makeRampTexture`), brush-tuning-service.ts (add a ramp dial).
  *Effort:* M. *Risk:* medium (touches the lighting of every vinyl object — gate
  behind a uniform so default = today's look; ramp up by eye). *Verify:*
  `?propviewer=cc0/chest` + a dressed track via `gen:track-shots`; Matt signs off
  the ramp by eye (playtest-is-truth).

**A2 — Scene-wide colour grade + the contrast budget (P1).**
- Add a final **grade node** (LUT or lift/gamma/gain + global desaturation toward
  the world band) in post-pipeline.ts, per-track tunable like `sky.bloom`. This is
  the Deathloop lesson and the vehicle for the legibility budget.
- *Files:* post-pipeline.ts (final output node), sky.ts (per-track params),
  [quality-preset.ts](../src/engine/render/quality-preset.ts) (keep on all tiers;
  it's cheap and on-brand). *Effort:* M. *Risk:* low. *Verify:* grayscale + squint
  pass on `gen:track-shots` for each Reef Cup map.

**A3 — Water painterly deepening (P2, complements water-next-research).**
- **Crest sub-surface glow:** lerp deep↔SSS colour by choppiness-peak mask (SoT).
- Turn the **foam toward oil-strokes** (`foamBrush` > 0) and validate the
  feedback-soften idea against our buffer. *Files:* water.ts, oil-stroke-texture.ts.
  *Effort:* M. *Risk:* low-medium (varying/uniform caps — see water_webgpu notes;
  pack into existing interPack vec4s / shared uniform arrays). *Verify:* `?waterlab`
  + posed deep-ocean cam.

**A4 — Painterly-normals + curvature shading (P3, polish).**
- Perturb the shading normal through a brush-stroke **normal** map so the *lighting*
  looks brushed (not just the albedo); extend the existing edge-wear with curvature
  emphasis. *Files:* painterly-vinyl-material.ts (`normalNode`, L488). *Effort:* M.
  *Risk:* low. Stretch: **fin/shell textures** for off-silhouette brush fluff on
  hero assets only (riders, signage) — temporally stable, but authoring + overdraw
  cost; hero-only.

### Track B — Style-as-legibility (the thesis)

**B0 — Lock the gameplay-colour vocabulary (P1, design gate, do first).**
A short, *sacred* token set, each double-coded **colour + shape + motion** so it
survives grayscale (colourblind + peripheral vision). Primary opposition is
**blue/orange**, not red/green. Starting proposal (validate in playtest):

| State | Hue | Shape | Motion |
|---|---|---|---|
| Boost / go | cyan | chevron | lunge + streak |
| Pickup | magenta | ring → burst | pulse |
| Hazard / brake | red-amber | angular | rear/telegraph |
| Racing/wave line ideal | green | flow ribbon | scrolls forward |
| Max charge | violet | dense sparks | glow ramp |

Forbid these exact hues in environment art (enforced via the A2 grade + art
review). *Deliverable:* a short addition to art-direction.md + a `signalColors`
constant. *Effort:* S (design) + the lockout discipline.

### B0 — signal colour vocabulary (locked)

Implemented as the single source of truth in
[signal-colors.ts](../src/engine/render/signal-colors.ts) (`SIGNAL_COLORS`,
`CHARGE_LADDER`, `linear()`). Later slices import these tokens, never raw hexes.

| State | sRGB hex | Shape | Motion |
|---|---|---|---|
| boost / go | `#19E0FF` | chevron | lunge + streak |
| pickup | `#FF2BD6` | ring → burst | pulse |
| hazard / brake | `#FF5A2A` | angular | rear / telegraph |
| racingLineIdeal | `#2EE66B` | flow ribbon | scrolls forward |
| maxCharge | `#A24BFF` | dense sparks | glow ramp |

Drift/charge ladder (`CHARGE_LADDER`, ascending): blue `#2A7BFF` → orange
`#FF8A2A` → `maxCharge` violet — the deficiency-safe **blue/orange** axis, with
spark *density* as the redundant grayscale cue.

Rules baked into the module: (1) **forbid these exact hues in environment art**
(world stays in the muted art-direction.md band); (2) **primary opposition is
blue/orange, not red/green**; (3) **every token is double-coded colour + shape +
motion** (survives grayscale / colourblindness / peripheral vision). Colour
space: each token carries a linear `THREE.Color` (emissive/rim) **and** an sRGB
hex (HUD/CSS). Hexes are playtest-tunable; the vocabulary itself is locked.

**B1 — Rim-colour as a state channel (P1, cheapest high-value signal).**
Reuse the A1 per-object `rimColor` uniform to **paint state into the lighting**: a
rival bike rims **cyan** when you're in its slipstream, **warm** when it's drafting
you; a hazard arming rims **red-amber**; a pickup pulses **magenta**. Reads as
painted light, not a UI gizmo — the TF2 "assess the threat" device. *Files:*
painterly-vinyl-material.ts (rimColor uniform), [instanced-bikes.ts](../src/engine/render/instanced-bikes.ts),
fx/index.ts (state read), pickup-render.ts. *Effort:* M. *Verify:* 8-bike headed run.

**B2 — Event juice that's *legibility*, not just polish (P1).**
For the events that must read instantly (boost-pad hit, hazard contact, perfect
wave landing): **anticipation telegraph** (the pad/hazard pulses *before* contact),
**reserved-hue flash**, **1–3 frame hitstop**, exaggerated **follow-through**. Keep
screen-shake subtle and reserved for *magnitude* (a racer punishes heavy shake).
*Files:* pump-fx.ts, fx/index.ts, the FX driver in [game-loop.ts](../src/boot/game-loop.ts).
*Effort:* M. *Risk:* medium (hitstop touches feel — Matt's hands decide). 

**B3 — The racing/wave line as a painted flow ribbon (P2, the signature move).**
A **brushstroke-flow ribbon** on the water along the racing line, coloured
Forza-style (cool = hold/accelerate, warm = brake/bad approach). Brushstroke
direction *is* the arrow — painterly-native wayfinding with zero HUD clutter. Pairs
with **contour foam ON** (B4) so the rideable wave face vs the breaking crest read
as distinct shapes — the legibility key to the wave-mastery mechanic. *Files:*
water.ts (surface overlay), direction-arrow.ts (retire/augment). *Effort:* L.
*Risk:* medium. *Verify:* `?waterlab` + a real track at pace.

**B4 — Turn the water readability layers ON and tune them (P2).**
The contour lines, swell value-ramp, and rising-face strokes are built and
default-off (water-next-research §5). Enable, playtest-gate, and bind to the colour
budget. *Files:* water.ts, water-debug-menu.ts. *Effort:* S-M (mostly tuning).

**B5 — Drift/charge ladder painted on the bike (P2).**
Mario-Kart blue→orange→violet charge ladder as a **rim/glow on the bike itself**
(peripheral view, never look away from the line), redundant with spark *density*.
Drives off `DriftStateStore`. *Files:* fx/index.ts, instanced-bikes.ts, the A1 rim.
*Effort:* M.

**B6 — Off-track / out-of-bounds + position-change reads (P3).**
Desaturate/cool-shift the world grade (A2) when off the racing line or OOB so the
return path pops; reuse the HUD's existing gain/lose-position mint/hazard flash
([ui-art-direction.md](./ui-art-direction.md)) into the world rim. *Effort:* S-M.

---

## Part 6 — What NOT to do (the anti-plan)

**Do not add a full-frame screen-space painterly post pass** (Kuwahara, flow-based
abstraction, DoG/XDoG outlines, stroke-splatting). The research is unambiguous and
matches our own prior parks:
- These have **no motion model**; at 40 m/s interiors **boil**, stroke/flow
  directions **crawl**, and edge lines **pop and dissolve** under temporal blending.
  The academic "temporally coherent" claims are measured on slow-pan footage.
- **No AAA fast-action game ships one** — they live in ReShade mods and photo-modes.
- **TF2 itself avoided image-space outlining** for exactly this reason, and chose
  object-space. We already chose object-space too.
- **Allowed exception:** a **photo-mode** Kuwahara/DoG toggle on a paused frame
  (the existing `setOutline` + a future Kuwahara node), depth-gated. Never in live
  play. (This reconciles the `TODO — Kuwahara` note in painterly-vinyl-pipeline.md.)

**Keep the screen-space cel/ink outline OFF.** *Doc-drift flag:*
rendering-tech-review.md still lists "screen-space cel/ink outline" as a P1
"explicitly requested in art-direction.md" — but **art-direction.md v2 explicitly
dropped outlines** ("No outlines. v1's cel ink/edge-darkening is dropped"). v2
wins; the rim + value separation carry the silhouette. If any line accent is ever
wanted, use **object-space** normal/ID contours, not the Sobel pass. (Update
rendering-tech-review.md to match.)

**Don't chase FFT water or SSR** — both parked correctly (analytic Gerstner + planar
reflection are right for a gameplay-wave racer at a low camera).

---

## Part 7 — Sequencing & definition-of-done

Recommended order (each gated by Matt's headed-playtest sign-off — feel/look is not
settled by analysis):

1. **A0** (sway + profiler) — unblocks measurement and the "alive" read.
2. **A1** (illustrative lighting) — the keystone; everything else looks better after.
3. **A2 + B0** (grade + colour vocabulary) — the contrast budget + its currency.
4. **B1 + B2** (rim-as-signal + legibility juice) — first real style-as-legibility wins.
5. **A3 / B3 / B4** (water glow + flow-ribbon + readability layers) — the signature
   wave-mastery legibility.
6. **A4 / B5 / B6** (polish: painterly normals, charge ladder, off-track reads).

**Done = ** every Reef Cup map (Mayday Bay → Mexico City → Cape Town) (a) passes a
**grayscale + squint test** where the brightest/most-saturated things are gameplay
events, (b) reads the wave face vs crest at pace, and (c) signals boost / hazard /
pickup / charge / rivals through the locked vocabulary — all verified on a **headed
Playwright run at race speed**, not stills.

---

## Part 8 — Verification & dev scenes

Per hard rule 2, build focused scenes; never trust the in-app preview or stills for
feel:
- **`?propviewer=cc0/chest`** — A1 ramp/rim tuning on a single prop.
- **`?waterlab`** + posed deep-ocean cam — A3/B3/B4 water work, frozen via
  `setTimeScale(0)`.
- **`pnpm gen:track-shots`** (real-WebGPU autopilot; pin `E2E_PORT`, junction
  `public/assets`) — per-track grayscale/squint regression.
- **Brush tuner / dev palette (Ctrl/⌘K)** — live uniform dial-in (add a ramp dial).
- **8-bike headed e2e** — B1/B5 rival-rim and charge reads in a full field.

---

## References

**External (technique):**
- *Illustrative Rendering in Team Fortress 2*, Mitchell/Francke/Eng, NPAR 2007 —
  [Valve PDF](https://steamcdn-a.akamaihd.net/apps/valve/2007/NPAR07_IllustrativeRenderingInTeamFortress2.pdf) ·
  [TF2 Wiki mirror](https://wiki.teamfortress.com/wiki/Illustrative_Rendering_in_Team_Fortress_2)
- *The Technical Art of Sea of Thieves*, Ang et al., SIGGRAPH 2018 Talks —
  [PDF](https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf) ·
  [GDC18 art direction, 80.lv](https://80.lv/articles/gdc18-visual-adventures-on-sea-of-thieves)
- Dishonored art direction — [Game Informer](https://gameinformer.com/b/features/archive/2016/05/23/oppression-opulence-and-decay-inside-dishonored-2s-bold-art-direction.aspx) ·
  Deathloop pipeline — [Adobe Substance](https://www.adobe.com/products/substance3d/magazine/deathloops-award-winning-art-pipeline-with-substance.html)
- Anisotropic Kuwahara — [Kyprianidis 2009](https://www.kyprianidis.com/p/pg2009/) ·
  [Acerola, "This is the Kuwahara Filter"](https://www.youtube.com/watch?v=LDhN-JK3U9g) (temporal caveats)
- Stylized water foam — [Daniel Ilett, Wind Waker/BotW foam](https://danielilett.com/2020-04-05-tut5-3-urp-stylised-water/) ·
  [Simon Schreibt, Stylized VFX in RiME](https://simonschreibt.de/gat/stylized-vfx-in-rime/)
- *Fin Textures for Real-Time Painterly Aesthetics*, Disney Research —
  [PDF](https://studios.disneyresearch.com/wp-content/uploads/2019/03/Fin-Textures-for-Real-Time-Painterly-Aesthetics.pdf)

**External (legibility):**
- TF2 vs Overwatch readability — [Coelho-Kostolny, Medium](https://medium.com/@xavierck/character-readability-in-team-fortress-2-and-overwatch-68c41d454465) ·
  [80.lv](https://80.lv/articles/comparing-team-fortress-2-and-overwatch-art-direction)
- *Game Feel*, Swink — [Game Developer summary](https://www.gamedeveloper.com/design/game-feel-the-secret-ingredient)
- *The Art of Screenshake*, Nijman/Vlambeer — [breakdown](https://theengineeringofconsciousexperience.com/jan-willem-nijman-vlambeer-the-art-of-screenshake/) ·
  hitstop as legibility — [Sakurai/Source Gaming](https://sourcegaming.info/2015/11/11/thoughts-on-hitstop-sakurais-famitsu-column-vol-490-1/)
- Disney 12 principles in games — [Game Anim](https://www.gameanim.com/2019/05/15/the-12-principles-of-animation-in-video-games/)
- Racing grammar — [Forza racing line](https://traxion.gg/the-racing-line-explained/) ·
  [Mario Kart Dash Panel](https://www.mariowiki.com/Dash_Panel) ·
  [Mini-Turbo ladder](https://www.mariowiki.com/Mini-Turbo) ·
  [Wave Race 64 buoys](https://en.wikipedia.org/wiki/Wave_Race_64)
- Colour signalling + colourblind safety — [IGDA color stories](https://igda.org/news-archive/color-stories-in-game-design/) ·
  [colorblind.io](https://colorblind.io/guides/designing-for-color-blindness)

**Internal:**
- [art-direction.md](./art-direction.md) · [painterly-vinyl-pipeline.md](./painterly-vinyl-pipeline.md) ·
  [rendering-tech-review.md](./rendering-tech-review.md) · [water-next-research.md](./water-next-research.md) ·
  [water-foam-look-plan.md](./water-foam-look-plan.md) · [level-visual-quality-research.md](./level-visual-quality-research.md) ·
  [reef-cup-art-quality-catalog.md](./reef-cup-art-quality-catalog.md) · [ui-art-direction.md](./ui-art-direction.md) ·
  [design-targets.md](./design-targets.md)
</content>
</invoke>
