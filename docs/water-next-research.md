# Water — what's next (research + roadmap)

> **Status: RESEARCH (2026-06-09) — now executing.** P0.1 (zone GPU port)
> landed as PR #340; P0.2 (pinch diagnosis) has a written verdict in §4.2 —
> Q is trusted. Remaining phases tracked in §8.
>
> Investigation of how the water system works
> end-to-end, what other games/papers have done, and a recommended path to
> **more nuance, less visible repetition, and a surface players can read** —
> the wave-mastery contract: a rider at 30–40 m/s must judge an approaching
> swell's height, steepness, face direction and timing well enough to pitch
> their takeoff and landing.
>
> Companions: [water-deep-dive.md](./water-deep-dive.md) (technical reference
> for the current shader), [water-foam-look-plan.md](./water-foam-look-plan.md)
> (the 2026-06 foam passes, including the curvature/leading-edge whitecap
> model now shipped), [design-targets.md](./design-targets.md) §2 (wave
> mastery = the signature axis).

## 1 · TL;DR

The architecture is genuinely good: **one analytic wave field, evaluated
identically by CPU buoyancy and GPU vertices**, with live-mirrored amplitudes,
shared constants enforced by drift tests, and a baked shore field giving both
sides identical near-shore behaviour. That contract — *the surface you see is
the surface you ride* — is the project's real asset, and everything below is
chosen to **strengthen it, never bypass it**.

But the investigation found the contract is currently **violated in three
places** (§4): wave zones are *felt but never drawn* (the GPU shader has no
zone code, while Sandbar/The Maw/Texcoco all ship zones); the Gerstner pinch
is distrusted ("physics out of phase with visuals") and so steepness — our
best curvature-sharpening lever — sits unused; and the readability work that
proved out (posterized bands + contour-line foam, 2026-06-06 session) was
never committed and exists only as session memory.

Recommended path, phased (detail in §8):

| Phase | Theme | Headline items |
|---|---|---|
| **P0** | Restore truth | Port wave zones to the GPU; diagnose the pinch phase-drift with `?wavedots`; make swell bearing track-authorable; prune dead `waveHeight`/`waveFreq` keys |
| **P1** | Readability layers | Crest-to-trough **value ramp** (pre-attentive height cue) + **contour-line foam** (re-land the lost experiment as a layer) + Wind-Waker light/dark line pair + per-track **low-cross sun rule** |
| **P2** | Nuance + anti-repetition | Per-track **spectrum presets** (replace the one global 6-wave bank); **wave sets/groups** (bichromatic pairs / slow envelopes — near-zero shader changes); hex-tile the detail/foam textures; fix the 4:1 cascade ratio |
| **P3** | Surf zones + signature waves | Depth-driven **shoaling v2** on the shore-field pattern (swell slows/steepens/stacks near shores and breaks); **authored wave stamps** — Blender-authored traveling jump waves on the set rhythm (the Horizon/surf-game lesson: signature waves are content) |
| **P4** | Dynamic water | Deterministic **wave particles** (landing splashes & set-piece rings other riders feel), wave-direction momentum ("catch the wave" push), wake drafting |
| Parked | — | FFT/spectral cascades, SSR, screen-space contour extraction (§7 verdicts) |

## 2 · How the water works today (system map)

One `WaveFieldState` ([wave-field.ts](../src/engine/sim/water/wave-field.ts))
is the single source of truth. Three consumers:

1. **CPU sim** — `sampleHeight`/`sampleSurface` for buoyancy (4-probe hover
   footprint), AI, spray drivers, floating props/gates, replay.
2. **GPU vertex** — the TSL shader in [water.ts](../src/engine/render/water.ts)
   re-evaluates the same closed forms per vertex.
3. **GPU fragment** — shading + foam, fed by varyings of the same signals.

### The wave bank

`defaultWaves()` — six hand-tuned Gerstner components, all within a ±25° fan
(deliberately: the previous 190° spread read as "confused seas" and was
untrackable under the bike):

| # | Role | λ (m) | A (m) | Speed (m/s) | Direction |
|---|---|---|---|---|---|
| 0 | Primary swell | 50 | 0.50 | 8.6 | 0° |
| 1 | Secondary swell | 85 | 0.35 | 11.2 | +10° |
| 2 | Mid chop | 16 | 0.22 | 5.0 | 0° |
| 3 | Cross chop | 10 | 0.16 | 4.0 | +25° |
| 4 | Cross chop | 6 | 0.10 | 3.1 | −20° |
| 5 | Fine chop | 4 | 0.06 | 2.5 | +10° |

Speeds track deep-water dispersion (`c ≈ √(gλ/2π)`) so crests travel at a
believable pace. Swells 0+1 beat constructively every ~24 s — the one
"bigger set" rhythm we currently have. Peak sum ≈ 1.4 m, RMS ≈ 0.55 m at
Beaufort 4.

Layered on top, in both samplers:

- **Per-track Beaufort scalar** (`sky.seaStateBeaufort`, 0→0.15× … 4→1.0× …
  12→2.5×, [sky.ts](../src/engine/render/sky.ts)) mutates `field.waves[i].amplitude`
  at boot; [lap-weather.ts](../src/engine/render/lap-weather.ts) ramps it per
  lap. Amplitudes are **live-mirrored to the GPU every frame**
  (`waveAmpUniform`), so amplitude changes can never desync — this mirror is
  the pattern several P2 proposals build on.
- **Wave zones** (OBB soft-max `heightMult`/`freqMult`/`directionDeg` +
  additive surge) — **CPU only**; see §4.1.
- **Shore field** ([shore-field.ts](../src/engine/sim/water/shore-field.ts)) —
  baked distance-to-shore + offshore normal + depth per cell, one
  deterministic bake handed to both CPU (arrays) and GPU (RGBA16F texture).
  Drives (a) shore-aligned breakers: phase = `K·dist + Ω·t`, crests parallel
  to the coast marching shoreward, amplitude capped by the water column;
  (b) **shoaling**: ambient swell fades as `(depth/3 m)²` so crests don't
  breach the seabed. `SHORE_*`/`SHOAL_*` constants are exported from the sim
  module and imported by the shader; `tests/unit/shore-constants-drift.test.ts`
  fails on divergence.
- **Per-bike wakes** — closed-form Kelvin-style V with transverse scallops,
  mirrored bit-for-bit on both sides; trailing riders can jump a leader's wake.
- **Gerstner pinch (steepness Q)** — the GPU displaces vertices toward crests;
  the CPU inverse-maps that displacement (4 fixed-point iterations,
  `STEEPNESS_SUM_LIMIT = 0.85` no-fold clamp, clamped Q synced to the GPU
  uniform every tick) so buoyancy floats on the pinched surface. In practice
  **distrusted and unused** — see §4.2.

### Render geometry + fragment

Three camera-locked layers: center **480 m plane at 768² subdivisions**
(0.625 m spacing, ~591 k verts — resolves the 4 m chop at ~6 verts/crest),
outer **1440 m tile at 256²** (~66 k), horizon **skirt annulus 120→1600 m**
(~25 k). Every center/outer vertex runs the 6-wave sums several times over
(height+slopes, pinch displacement, crest signals, and a 4-sample time-shifted
foam accumulator) — **vertex ALU scales linearly with wave count**, which is
the main constraint on "just add more waves" (§7).

Fragment (full reference in [water-deep-dive.md](./water-deep-dive.md)):
SoT-style three-color scatter (height + grazing + sun-backscatter), Beer-Lambert
depth absorption with seabed transmission, two detail-normal cascades (6 m /
1.5 m world-aligned, **visual-only**), planar reflection (half-res `reflector()`),
noise-wandering roughness/sparkle + Toksvig specular AA, Karis sun disc +
anisotropic streak, and the **2026-06 foam stack**: curvature-placed whitecaps
(`Σ A·k²·sin φ`, steepness-independent) biased to the **leading edge**
(`∂h/∂t > 0` = rising = front face), near-binary solid-disc bubble texture,
brushstroke streak sheet combed down steep faces, shoreline surf + swash,
crest-mist ribbon. Spray layers (crest poofs, climb-rate bow spray, surge
spray) are CPU-driven render-only particles.

### Physics coupling (what the bike actually reads)

[hover.ts](../src/game/systems/hover.ts): four probes (bow/stern/port/starboard,
~1.6 × 0.8 m) take `max(terrain raycast, wave height)` each; the **bow probe
extends with speed** (up to +1.4 m → ~2 m lead at 25 m/s) so the bike pitches
into what it's *about* to hit; slope is low-passed (~50 ms). A pitch PD holds
the chassis surface-tangent; **slope momentum** is strongly asymmetric
(1.0× push down a face, 0.15× brake climbing — the motocross slingshot);
hover damping references the **wave's own ∂y/∂t** (`WATER_SURFACE_FOLLOW = 1`)
so the bike rides up a rising crest instead of being damped through it. Pitch
input = dive/altitude model; tricks fire on credible vy-peak takeoffs
(`strengthFromTakeoffVy`, 2→8 m/s maps 0.4→1.0); landing >60° off the surface
contour at speed = crash. **So pitch already genuinely matters at takeoff and
landing — the open question is whether the player can *see* enough to act.**

### Authoring + diagnostics

Per-track today: `water.height`, `sky.seaStateBeaufort`, `waveZones[]`
(Blender-authored), `lapWeather`. **Not authorable:** the wave bank itself and
the global `waveBearing` (debug-menu only, and persisted in local storage
across tracks — see §4.5). Diagnostics already built: `?wavedots=1` (red dots
at the *sim* surface over the wireframed *render* surface, on any real track),
`?waveriders=1` (synthetic sync scene), `renderVertex()` (CPU mirror of the
GPU vertex incl. pinch), the deep-ocean camera-pose test bed
(`setCameraPose` + `setTimeScale(0)` — see memory/water-deep-dive), the
`foam-sweep` e2e grid, and `pnpm gen:track-shots`. Drift tests:
`shore-constants-drift`, `wave-field`, `wave-zone`, `water-coverage` units.

## 3 · The contract (and what's exempt)

Everything at **gameplay-relevant scales** must be evaluated identically on
both sides — the codebase does this four different ways, all worth preserving:

1. **Shared constants, imported one way** (sim → shader) + drift tests.
2. **Live mirroring** of mutable state (amplitudes, clamped steepness) every
   frame, ≤6 scalars.
3. **One deterministic bake** consumed by both sides (shore field / heightmap).
4. **Closed-form analytic terms** both sides can afford (wakes, shore waves).

Deliberately **visual-only** (and safely sub-threshold for pitch decisions):
detail-normal cascades, all foam/spray/mist, the hull dimple under bikes,
roughness/sparkle noise. The perception literature (§5) supports this split —
fine texture that doesn't perturb the *orientation field* of the surface
doesn't mislead shape reading.

The corollary that constrains everything in §7: **any technique that can't be
evaluated (or mirrored) deterministically on the CPU at per-probe cost cannot
contribute displacement.** Domain-warping the Gerstner phase, GPU-only
turbulence, screen-space tricks — fine for foam masks and normals, banned for
geometry.

The algorithms research (§7, §10) lets us state the "safe band" for
visual-only content precisely — a visible wave lies only if it changes
*surface slope at the bike's length scale* without physics agreeing, so
visual-only content must satisfy at least one of:

- wavelength below the bike's footprint (~2–3 m), **or**
- vertex amplitude inside the hover deadband (a few cm), **or**
- normal/shading-only, zero vertex displacement (players read it as texture,
  not terrain — they won't pitch for it).

This is shipped doctrine, not just intuition: Crest's physics-query API has a
*Min Spatial Length* parameter excluding sub-boat wavelengths, and Sea of
Thieves runs ship physics on a deliberately simplified surface because
full-detail coupling "gave everyone motion sickness". Two honesty rules in the
other direction: near-field mesh density must stay ≥ 2 verts per shortest
*physics* wavelength or the **drawn** surface aliases below the simulated one
(we're at 0.625 m spacing for the 4 m chop ≈ 6.4 verts/crest — fine, but it
caps how short future physics chop can get), and every foam/contour cue should
derive from the same analytic field physics uses (the #315 curvature foam
already does this).

## 4 · Truth gaps found (ranked by blast radius)

### 4.1 Wave zones are felt but never drawn — **the big one**

`sampleZoneFactors` modifies CPU buoyancy inside authored OBBs
(`heightMult`, `freqMult`, `directionDeg`, surge), but **the TSL shader has no
zone code at all** — `setWaveZones` is consumed only by the sim
([wave-field.ts:295](../src/engine/sim/water/wave-field.ts)); the GPU
`gerstnerHeight`/`gerstnerDisp` loops know only the global bearing + live
amplitudes. The [wave-zones cookbook](../docs-site/blender/wave-zones.md)
claims "the renderer's wave-displaced plane" applies zones — true of the v1
CPU-displaced plane, **stale since the TSL water landed**.

Shipped v2 tracks are live counter-examples: **Sandbar** wraps its whole play
area in `heightMult 0.5` (the rider floats on *half* the rendered amplitude —
crests visually swallow the bike, troughs leave it hovering on air), **The Maw**
runs `1.4×` height + `0.85×` *frequency* over most of the course (frequency
change = **different crest positions**, a literal phase mismatch), **Texcoco**
a local `1.3×`. This is the most likely root of the long-standing
"ride-on-top buoyancy still inconclusive" feel note, and plausibly feeds the
pinch distrust (§4.2): any steepness tuning done while riding a zoned track
was tuned against a desynced surface.

**Fix sketch (P0):** a fixed-size uniform array of ≤8 zones
(center, cos/sin yaw, half-extents, blendRadius, heightMult, freqMult,
bearing-override cos/sin + flag, surge period/amp), with the same
`zoneWeight` soft-max evaluated per vertex before the wave loop — `freqMult`
multiplies each wave's `k` inside the loop exactly as the CPU does, surge adds
post-loop. The math is already branchless-friendly (the CPU comments say so).
Cost: a handful of FLOPs × zone count per vertex on ~660 k verts — measure,
but it's additions/multiplies, not texture taps. Then **wave zones become a
usable design tool again** (surge set-pieces, calm-vs-storm contrast — the
authoring vocabulary the cookbook promises). Add a `zone-constants` drift test
mirroring the shore one, and a `?wavedots` pass over each zoned track to the
QA checklist.

### 4.2 The pinch is distrusted, so our best steepness lever sits idle

Matt stopped using steepness because "physics feels out of phase with the
visuals when we pinch" (memory `feedback_steepness_pinch_unused`; the foam
plan §12 explicitly routes around pinch-derived signals). Yet the code looks
right: `field.steepness` and the GPU uniform are both set to the **clamped**
`effectiveSteepness` at every tick ([water.ts:3393](../src/engine/render/water.ts)),
and the CPU inverse map exists precisely to float buoyancy on the pinched
surface. Candidate explanations, in order of likelihood:

1. **§4.1.** On zoned tracks the surface is out of phase *regardless* of
   pinch; raising steepness sharpens the visual crests and makes the
   pre-existing mismatch obvious. Sandbar (0.5× everywhere) is the worst case.
2. **Hover-spring phase lag, amplified.** Sharper crests = higher temporal
   frequency under a 40 m/s bike; the same PD lag that's invisible on round
   swells reads as "the bump arrived early/late" on pinched ones. That's a
   *feel* artifact, not a positional desync — distinguishable with
   `?wavedots` (dots ON the wireframe ⇒ positions agree ⇒ it's lag).
3. A residual math mismatch (e.g. pinch-direction rotation order,
   slope-at-rest-point approximation). `renderVertex()` exists exactly to
   catch this — diff it against `sampleHeight` along a transect at high Q.

**P0 is a diagnosis, not a rewrite**: run `?wavedots` at `?steep=1` on (a) the
deep-ocean test bed (no zones/terrain) and (b) Sandbar. If (a) is clean and
(b) isn't → it was §4.1 all along. Getting pinch trusted matters beyond feel:
**sharp crests are themselves a curvature cue**, and two shelved signals — the
Jacobian compression foam and SoT's choppiness-driven peak mask (§5, §7) —
need a non-zero, trusted Q.

> **VERDICT (2026-06-09, post-#340): the math is sound — Q stays, trusted.**
> Instrumented per §9 with the new `__hover.waterSync()` transect probe
> (rest points → `renderVertex`, the CPU mirror of the GPU vertex transform
> with live uniforms → diffed against `sampleHeight` at the displaced world
> point) plus `?wavedots=1&wire=1` GPU-truth captures
> ([pinch-diagnosis.spec.ts](../tests/e2e/pinch-diagnosis.spec.ts), artifacts
> under `artifacts/pinch-diagnosis/`). At Q = 1.2 — ≈3× the shipped 0.44 —
> buoyancy lands on the pinched surface to **≤ 3.1 mm** worst-case on
> full-amplitude open water (lagoon-edit; pinch displacement up to 1.37 m)
> and ≤ 5e-8 m inside Sandbar's 0.5× zone; the Q = 0 controls sit at float
> noise (1e-15), and the red sim dots ride the GPU wireframe on both tracks.
> So: candidate **(3) math mismatch — refuted**; candidate **(1) zones — was
> real, fixed by #340**; any "out of phase" feel that survives a post-#340
> playtest is candidate **(2) hover-spring phase lag** on sharper crests — a
> coupling-tuning question (§6 rule 3: tune the coupling, never the field),
> which is Matt's-hands territory, not a sync bug. Default **Q = 0.44 is now
> trusted**, and §7.4's Q-gated signals (Jacobian compression foam, SoT-style
> choppiness peak mask) are unblocked. One machine-local trap: the water
> debug menu persists steepness in localStorage (`hoverbike.waterDebug.v10`),
> so a distrust-era 0 keeps overriding the trusted default on that machine
> until the menu's RESET is hit.

### 4.3 The readability experiment that worked was never landed

A 2026-06-06 session built a cel/stepped water look — posterized swell-only
sun-lambert + **topographic contour-line foam** ("foam lines at regular
swell-height intervals… run along crests and stack down faces") — judged good
enough to be made the default, with the SoT pipeline behind `?water=realistic`.
**None of it is in the repo** (no commit anywhere contains `celPosterize` /
`__celLevels`; `water.ts` on main is the SoT pipeline + the #315 curvature
whitecaps). Treat memory `project_cel_water` as a *validated design study*,
not shipped work. Its durable lessons, confirmed independently by the
perception literature (§5): posterize only the **swell-scale** normal (chop in
the posterize carved squiggles); auto-center the light ramp on sun elevation;
height-driven contour lines are robust where flow-aligned strokes degenerate
(herringbone moiré on calm water). P1 re-lands the contour layer **inside**
the current pipeline as a knob — not as a parallel fork, which is how it got
lost.

### 4.4 The predictive wave-line HUD is gone

[design-targets.md](./design-targets.md) marks "wave-line guidance ✅ (3D
forward-fan shimmer over rising swell)" — no such code exists in `src/`
(evidently cut with the pump→pitch pivot). That's actually consistent with the
direction of this doc — **the water itself must carry the signal** — but the
design doc should stop claiming it ships, and if a guidance accessibility
option returns someday it should render *on the surface* (it can sample the
same field), not as a HUD fan.

### 4.5 Small but real authoring debris

- `water.waveHeight` / `water.waveFreq` are **required** by the JSON loader,
  drive nothing in the wave field (one vestigial use:
  [race.ts:79](../src/game/systems/race.ts) respawn margin), yet every track
  carries them with misleading values (The Maw says `waveFreq 0.4`). Prune or
  rename; today they invite authors to "tune" dead knobs.
- `waveBearing` is **not track-authorable** but *is* persisted from the debug
  menu in local storage — whatever bearing was last dialed silently applies to
  every track on that machine. P0: add `water.swellBearingDeg` to track JSON
  (defaulting to 0) and make the debug slider an override, not the source.
  Bearing-vs-racing-line is a readability lever we currently can't even set
  (§5, sun rule).
- The wave-zones cookbook's renderer claim (§4.1) needs a stale-docs fix
  either way.

## 5 · What the player must read, and which cues carry it

The pitch loop consumes four pieces of information, each mapping to a render
cue we either have, lost, or lack:

| Player question | Physical signal | Today | Gap |
|---|---|---|---|
| *Where's the crest?* | height field max | scatter color lifts crests; whitecap line at high curvature | works at close range; weak at 100 m+ on gentle swell |
| *How hard will it kick?* (pitch decision) | local steepness/curvature | curvature-gated whitecaps (only fires near breaking); detail normals | **no continuous steepness cue below the foam threshold** — the lost contour lines were exactly this |
| *Which way is the face moving?* | wave direction + ∂h/∂t | leading-edge foam bias (∂h/∂t>0); streak combing on steep faces | subtle; nothing on calm stretches |
| *When?* (timing the set) | amplitude envelope over time | the accidental 24 s swell beat | no authored set rhythm, no distance visibility of "the big one coming" |

Perception research (full sourcing in §10) gives a clear cue hierarchy for
judging a *moving* curved surface at a glance, and it validates the stylized
direction rather than fighting it:

- **Orientation fields are the master cue.** Shape-from-shading literature
  (Fleming et al.; PNAS 2025 follow-up) shows humans read 3D shape from the
  dominant local *image orientation flow* — and that drastic, nonlinear
  intensity transforms which **preserve** orientation structure leave shape
  perception intact. **Posterizing the lambert is perceptually safe**: band
  *boundaries* are the signal. What damages shape reading is high-frequency
  noise that corrupts flow direction — i.e. the one cheap way to "add nuance"
  (more normal noise on faces) is the one that hurts.
- **Sparse lines ≈ shading** for shape communication (Cole et al., the 275k-
  gauge line-drawing study): contour lines are a high-bandwidth channel, not a
  hack. Cartography adds the caveat: contours are precise but *slow* — at
  speed they must be backed by a **pre-attentive value ramp** (shaded-relief +
  contours beats either alone). Hence P1 pairs the ramp with the lines.
- **Specular flow encodes curvature specifically** (second-order shape, where
  matte flow only gives first-order) — but highlight *velocity* biases
  perceived curvature, so the sun streak should stay a secondary,
  confirmatory cue at racing speed.
- **Light direction is not a vibe choice.** Frontal lighting makes luminance
  "frequency-double" against the surface (two bright cycles per bump —
  actively misleading); raking/oblique light maximizes relief legibility. Sea
  of Thieves engineered a deliberately *low*, widened area-specular sun for
  exactly this reason. Our sunset palette is already the legibility-optimal
  regime — **but sun dead-ahead down a wave-reading straight silhouettes the
  faces**. With per-track `timeOfDay` frozen at boot and (post-P0)
  track-authorable swell bearing, "low cross-track sun on water sections"
  becomes an enforceable track-grading rule.
- **Wave Race 64's** famous readability (per the games research, §6) reduces
  to: few, long-wavelength swells; **one smooth value sweep rolling over each
  face** (sky-reflection gradient); shape carried by a single pre-attentive
  gradient, not detail. The transferable principle: *one value sweep per wave
  face beats ten detail cues.*

## 6 · Prior art — shipped games (what survives contact with players)

Full per-game sourcing in §10. The one-line headline: **our architecture is
the industry-validated one.** Skull & Bones' technical director, on a
$200M ocean game: *"What you see is what you can feel… our water is
essentially a deforming mesh, and that deforming mesh informs the physics."*
Uncharted's waves are stateless functions of time, "critical for cutscenes and
multiplayer consistency." Atlas runs **the same spectral field at low res on
the CPU/server for physics and high res on the GPU for pixels**. Sea of
Thieves ships deterministic, identical-for-everyone waves as a *fairness
feature*. Nobody with waves-as-gameplay ships physics on a surface the player
can't see.

| Game | Waves | Physics sync | Repetition fix | Readability lesson |
|---|---|---|---|---|
| **Wave Race 64 / Blue Storm** | CPU-deformed grid, few large per-course swells + currents; per-lap tide changes | one surface, sim = render | per-course authored conditions; weather variants | few large deterministic swells beat many small chaotic ones; roughness = an exposed difficulty dial |
| **Hydro Thunder Hurricane** (+ Riptide GP) | custom CPU heightfield; ambient field + **emitter-injected waves** (wakes, point waves, whirlpools, scripted surges) | one CPU sim drives both; hull-proxy buoyancy | dynamic emitters keep the surface eventful | "believable, not realistic"; **tune the coupling, never the waves** (softened buoyancy at speed); rival wakes are a *mechanic* (drafting boost in the calm wake center) |
| **Uncharted 1–3** | **4 Gerstner + 4 octaves of wave-particle displacement** per vertex; vector displacement for sharp crests | physics reads a B-spline approximation of the same shape; SPU (CPU) evaluation | wave particles: "no tiling artifacts, fast" | stateless/deterministic by design; the 4+4 split = physics-scale analytic + bounded dynamic layer |
| **Sea of Thieves** | Tessendorf FFT (Phillips) | simplified physics surface (full coupling "gave everyone motion sickness") | spectrum (the FFT answer) | every stylized cue **derives from sim quantities** — peak glow from choppiness, foam from the Jacobian, sea state modulates foam: the art never lies about the physics |
| **AC3 / Black Flag** | **precomputed looping FFT textures** (two tiling sets), camera-projected | hull buoyancy spheres + depth probes sample the same baked data on CPU | spectrum baked; **Beaufort 0–12** drives scale/chop/foam-decay | sea state standardized on a real-world scale — one dial, everything follows |
| **Skull & Bones** | spectral cascades, server-replicated | "what you see is what you can feel" | cascades + weather + zone modulation (coast/river/open) | shared predictable waves = competitive fairness; a dedicated water artist full-time |
| **Horizon Forbidden West** | **one baked breaking-wave cross-section** translated along artist-authored curves (shape/guide/animation), Coons-patch interpolated | gameplay could "change wave height or intensity or direction" on request — authored, not emergent | a variation strip (per-wavefront gaps/strength) de-clones the one profile | the signature readable wave is *authored content*, not a spectrum accident; foam in vertex color undersampled/popped — keep cues per-pixel |
| **Surf games** (True Surf, BLPS, Surf World Series, TransWorld) | authored per-beach wave identity; True Surf: "2D animations of vertical slices… blended" | physics-forward pumping (BLPS) | per-beach character + live forecast data (True Surf) | players read line/steepness/timing **seconds ahead** only on authored set-piece waves; per-track wave identity is content ("know where you are from the water alone") |
| **God of War** (counter-example) | screen-space parallax trick, no real waves | n/a — water is backdrop | n/a | wave *simulation* budgets only pay off when waves are **mechanics**; we are exactly the case where they pay |

Five design rules distilled from the games where waves ARE the game:

1. **Few large deterministic swells** beat many small chaotic ones (WR64 —
   the entire game was built around what made the tech demo readable).
2. **Roughness is a dial**, exposed per course/weather (WR64 wildness, Blue
   Storm weather, BLPS weather tool, AC3 Beaufort — our `seaStateBeaufort`
   is the right shape, it should just drive *more* than amplitude).
3. **Believable, not realistic** — tune the bike's coupling (buoyancy,
   damping, downforce), never falsify the field (HTH/Riptide).
4. **Per-track wave identity is content** (TransWorld/SWS) — the argument for
   per-track spectrum presets over one global bank.
5. **Signature jumps are authored** (Horizon, every surf game) — the spectrum
   supplies nuance *under* learnable set-piece waves, it doesn't replace them.

## 7 · Algorithm options (with "fits our foundation?" verdicts)

The algorithms research's through-line, verbatim: *"your current architecture
(shared analytic bank + iterative pinch inverse) is not a stopgap — it is the
architecture War Thunder, Uncharted 3, UE's mirrored-Gerstner plugins, and
Tidewater converge on."* Even our inverse map's iteration count is
independently production-validated — War Thunder's CPU readback of choppy
displacement uses the same locally-linear fixed-point method, "4 steps is
enough" (we use 4). The recommendations: grow the bank toward a spectrum,
depth, and groups; add CPU-resident interactive waves; treat FFT only as a
*baked or mirrored* layer, never a readback dependency.

**7.1 Spectrum-sampled Gerstner bank (per-track).** The cleanest nuance
lever that keeps the contract trivially intact — the bank is already data
(`Wave[]`), already live-mirrored. Replace the hand-tuned 6-bank with a
deterministic per-track generator: integrate JONSWAP/TMA energy per octave bin
(amplitude `a = √(2·S(ω)·Δω)`), sample directions from a spreading function
(cos^s or Donelan-Banner), seeded phases, **randomized (non-harmonic)
wavelengths within octaves** — commensurate frequency ratios become
measure-zero, so the repeat period stretches to minutes without any trick
(randomize k and derive ω from the dispersion relation; *don't* detune phase
speed, players subconsciously read group/shoaling timing). Reference points:
Crest ships 8 components/octave; the visible-repetition cliff is crossed
around **30–60 well-spread components**; Uncharted shipped oceans on 4
Gerstner + 4 wave-particle octaves. CPU cost is a non-issue (a measured
60-component implementation samples a whole grid in 0.18 ms; our per-probe
load is dozens of points). The real budget is **vertex ALU on the 768² center
plane** — so split the bank per §3's safe band: a *physics set* (everything
≥ bike scale, vertex-displaced, target 10–16 components, Σ Q·k·A ≤ ~0.8) and
a *render-only tail* (short-λ components below the thresholds, GPU-only —
the GPU Gems "4 geometry + 15 normal-map waves" pattern), plus drop chop
entirely from the outer tile + skirt (silhouette only needs swells). 6→N
needs an A/B perf measurement first (vertex-bound risk; mitigation:
768→640 subs ≈ −31 % verts buys ~4 waves). **Verdict: do (P2), measured.**

**7.2 Wave groups / sets.** Real swell arrives in groups (envelopes travel
at *half* phase speed in deep water); reading sets **is** surf timing skill —
exactly the wave-mastery fantasy, and the strongest anti-monotony move in the
time domain. Two fully-analytic constructions, both exact on CPU+GPU:

- **Bichromatic pairs (preferred):** pair a swell at ω with a sibling at
  ω+δ → amplitude envelope with beat period 2π/δ traveling at group speed.
  *It's literally just two more Gerstner components* — no new machinery, no
  sync caveats; pick δ for a 20–40 s set period per swell. (Our current bank
  accidentally has one such pair — waves 0+1 beating every ~24 s; this makes
  it deliberate and per-track-tunable.)
- **Explicit slow envelopes:** modulate `field.waves[i].amplitude` on the CPU
  as an analytic function of `field.time` — the existing per-frame amplitude
  mirror ships it to the GPU with **zero shader changes** (War Thunder uses
  exactly this for shore-break regularity, envelope advected at c/2). Caveat:
  the stateless foam accumulator samples `t−Δ` with current amplitudes —
  negligible for ≥45 s envelopes vs its 0.5 s lookback.

Either way, foam gain + the P1 crest-ramp brightness should follow the
envelope so "the big set" reads at 200 m (§5's timing gap). **Verdict: do
(P2) — highest nuance-per-effort in the whole doc.**

**7.3 Depth-aware shoaling v2 (surf zones).** Today shallow water just
*fades* the swell (`(depth/3 m)²` kill-switch). Real shoaling first **slows,
shortens and steepens** the wave (then breaks it) — the most readable,
physically intuitive nuance in nature: players learn "shallows = ramp
incoming". Naive per-sample `k(depth)` breaks phase continuity (phase becomes
a path integral), but the codebase already solved this class of problem: the
**shore wave's phase rides the baked distance field** (`K·dist + Ω·t`) — and
the algorithms research confirms this is the production recipe, not a local
hack: War Thunder bakes a world distance-field/depth/gradient texture and
uses **distance-to-shore as the breaker phase** (shore-parallel crests for
free), scales amplitude by depth, adds seabed drag, pitches wave tops forward
for breaker asymmetry, and lerps ocean→shore displacement. v2 ingredients,
all closed-form in `dist`/`depth` from the existing bake, identical both
sides: dispersion `ω² = g·k·tanh(k·h)` (2–3 Newton steps or a shared 1D
LUT), shoaling gain (energy-flux `K_s`, asymptotically Green's law
`H ∝ h^(−1/4)`), TMA depth attenuation at bank-generation time, refraction
as a direction nudge along −∇h (or a once-per-track baked direction field for
true lensing around flooded landmarks), and **breaking criteria**: depth
ratio `H/h ≈ 0.78` + steepness (Miche `H/L = 0.142·tanh(kh)`; Gerstner
self-intersection at `Q·k·A ≥ 1`), with hysteresis, feeding the existing
whitecap/spray stack. The `SHORE_*` system is this feature at 30 % power; v2
is amplitude + wavelength behaviour + a break line, not a new architecture.
**Verdict: do (P3).**

**7.4 Trusted pinch (after P0 diagnosis) + Jacobian foam.** With Q trusted
and non-zero, two shelved signals unlock: the analytic **Jacobian compression
term** (closed-form from the Gerstner partials — foam that fires on the
*front face as it steepens, before the crest*: an anticipation cue pure
curvature can't give; production-standard thresholds J < ~0.3–0.5, accumulate
linearly / decay exponentially), and an SoT-style choppiness peak mask for
the P1 value ramp. Both fragment-only. **Verdict: gated on P0; then cheap.**

**7.5 Wave particles / event waves (Yuksel 2007; Uncharted's shipped form).**
Closed-form, finite-support displacement kernels spawned from events — the
canonical answer for *dynamic* waves (landing splashes that radiate and are
**felt** by other riders, set-piece rings, richer wakes). The shipped
precedents are exactly our shape: **Uncharted 1–3** ran wave particles on
SPUs (CPU), summed analytically, "intuitive for artists, **no tiling
artifacts**, fast", with gameplay point queries against the same data and
stateless determinism as an explicit design goal; **Hydro Thunder Hurricane**
was an ambient CPU heightfield + *emitter-injected* wakes/point-waves/
whirlpools (one sim drives render and hull physics — it even ported to a 2011
phone CPU intact). One hard warning from a 2025 hybrid paper: never build the
*ambient* sea from particles (4 FPS vs FFT's 2000+ in their measurement) —
particles are for local, transient, interactive content only. For us it's the
`WakeSource` pattern generalized: sim owns a fixed pool (~16–32) advanced
deterministically from sim events, spatial-hash CPU queries, mirrored to a
GPU uniform array like `bikesUniform`, identical kernels both sides.
**Verdict: do (P4) — the "simulate better" feature with the most gameplay in
it.**

**7.6 Wave-direction momentum (catch-the-wave push) + wake drafting.** Slope
momentum already slingshots the bike down faces (`SLOPE_DOWN_GAIN = 1.0`) —
but it's direction-blind: descending the *back* of a wave pays the same as
riding the face of one. A modest bonus/malus keyed to `dot(bike forward, wave
travel dir)` × local `∂h/∂t` (both already computed) turns faces into
directional conveyors — ride *with* the set to surf, fight it and you bog.
Sibling experiment from HTH: their best emergent racing came from **wake
drafting** (steer into the calm center of a rival's wake for a boost) — our
wakes are already rideable geometry; a drafting reward inside the V is a
`hover.ts`-level experiment with the same shape. Analytic, deterministic,
dev-flag prototypes. Risk is balance (AI + lap times), not tech. **Verdict:
prototype (P4), playtest-gated** — per `feedback_playtest_truth`, Matt's
hands decide.

**7.7 FFT/spectral cascades (Tessendorf).** What SoT/Atlas/Skull & Bones
use, and the standard answer to "less repetition". The research catalogued
every known way to keep physics honest against an FFT sea:

- **(a) Async GPU readback** — 1–3 frames of latency (≈ 0.7–2 m of track at
  race speed), nondeterministic. *Nobody ships racing-grade buoyancy on it.*
  Rejected.
- **(b) CPU mirror of the same spectrum** (the WaveWorks/War Thunder/Just
  Cause 3 model): authoritative fixed-tick CPU sim at 128² while the GPU
  renders 256–512² of the same seeded spectrum — measured divergence
  **< 5 cm at 3 m amplitude**. Proven, deterministic… and heavy for us: a
  WASM FFT, dual spectrum implementations, a WebGL2 fallback, and permanent
  drift vigilance. This is the "if art ever demands a live spectral sea"
  path, not a near-term one.
- **(c) Baked looping FFT** (AC3/Black Flag; Crest's `CollProviderBakedFFT`):
  quantize ω to multiples of 2π/T so the sim loops, bake one mid-band cascade
  offline (~128² × 64–128 frames RGBA16F ≈ 8–32 MB — fits the R2 asset
  pipeline), sample as a texture array on GPU and the identical Float32Array
  on CPU — **bit-identical, deterministic, replay-safe, zero readback**. The
  honest middle path if the analytic bank ever reads too "clean", with the
  §3 discipline: keep this layer's amplitude inside the hover deadband or
  match the bilinear+time filtering exactly.

Our visible field is 480 m with gameplay at 4–85 m wavelengths; a
spectrum-sampled bank + detail cascades covers that range, so FFT's marginal
win is far-field micro-texture we already fake. **Verdict: stays parked; (c)
first if ever revisited.** (Worth a cheap shortcut either way: **Tidewater**,
a May-2026 three.js TSL ocean kit — cascaded FFT + Gerstner swells + CPU
buoyancy mirror + stamped wake field, $75 — is the closest existing artifact
to this exact problem and worth buying just to read.)

**7.8 Hex-tiling + cascade hygiene (shading-level anti-repetition).**
Mikkelsen's 3-tap hex tiling (JCGT 2022) on the detail-normal + foam-bubble
textures kills their tiling without touching any signal; and the two cascade
tile sizes are currently **6 m / 1.5 m — an exact 4:1**, which re-aligns every
6 m (the known "common factor" tiling artifact); nudge to an irrational-ish
ratio (e.g. 6 / 1.45). Also: tangential-only domain warp on foam masks (warp
along-crest, never in height — height warp would falsify the steepness
signal), `fwidth`-based contour thinning at distance, index contours (every
Nth line heavier). **Verdict: do (P2, polish tier).**

**7.9 Water Surface Wavelets / shallow-water solvers / screen-space
contour extraction.** Wavelets (Jeschke et al. 2018): impressive
interactivity, but the community Unity port runs ~80 FPS at 1080p on an RTX
2080 Super *with no gameplay height-query API* — a faithful CPU mirror means
re-implementing amplitude-grid advection per tick; there is no cheap
closed-form point query. SWE grids (and the Wave Break spring-grid pattern):
stateful, non-deterministic across machines, breaks replay/netcode ambitions.
Screen-space suggestive contours: temporal-coherence instability at racing
speed (the NPR literature's known hard problem) — our world-space iso-height
lines are the stable formulation. **Verdict: all three parked.**

**7.10 Authored "wave stamps" — signature jump waves (new; from the games
research).** The strongest cross-game convergence in §6: **a readable
breaking/feature wave is one animated cross-section profile translated along
an authored front curve.** Horizon Forbidden West shipped a AAA open world on
*one* baked cross-section + artist-laid shape/guide/animation curves + a
variation strip (per-front strength/gaps); True Surf independently built
"2D animations of vertical slices… blended"; every surf game authors
per-beach wave identity this way — because a player can only read line,
steepness and break timing *seconds ahead* on a wave that is **content, not a
spectrum accident**. Our version stays analytic (no Houdini bake needed at
our stylization level): a stamp = closed-form crest profile (e.g. a sech² or
windowed-cos pulse, optionally steepening over its life) × an authored crest
**spline** + travel speed + period/phase offset — authored in Blender exactly
like wave zones (curve + custom props → JSON), superposed on the ambient
field, evaluated identically by `wave-field.ts` and the shader (a
`uniformArray` of stamp params, same pattern as wakes). This is what the
zone-surge system was reaching for (a timed "launch wave"), upgraded from
"the whole box lifts" to a *traveling, shaped, learnable* wave — same wave,
same place in the set rhythm, every lap: the motocross jump made of water.
Pairs naturally with 7.2 (stamps fire on the set envelope) and 7.3 (reef
stamps at the break line). **Verdict: do (P3, after zones render) — this is
the wave-mastery feature.**

## 8 · Recommended roadmap

Phases are sized so each lands with its own verification loop (headed
Playwright on a pinned port + the diagnostics in §2 — never the in-app
preview; CLAUDE.md hard rule 2).

### P0 — Restore truth (prerequisite for everything)

1. ✅ **Port wave zones to the GPU** (§4.1) — **LANDED (PR #340,
   2026-06-09).** Uniform-array OBB soft-max in the vertex wave loop
   (`waveZoneFactors`), `MAX_WAVE_ZONES = 8` sim-owned + drift-tested, CPU
   inverse map folds zone factors in, `?wavedots` QA pass on
   Sandbar/Maw/Texcoco captured in
   [wave-zone-sync.spec.ts](../tests/e2e/wave-zone-sync.spec.ts).
2. ✅ **Diagnose the pinch** (§4.2) — **VERDICT WRITTEN (2026-06-09): Q
   trusted at the shipped 0.44 default.** See the verdict block in §4.2 —
   math refuted as a cause (≤ 3.1 mm worst-case at Q = 1.2), zones were the
   real desync (#340), residual feel = hover-spring lag → coupling tuning.
   Diagnostics institutionalized: `__hover.waterSync()` +
   [pinch-diagnosis.spec.ts](../tests/e2e/pinch-diagnosis.spec.ts).
3. ✅ **Authoring hygiene** (§4.5) — **DONE (2026-06-09).**
   `water.swellBearingDeg` is track-authorable (absent →
   `WAVE_BEARING_DEFAULT` = 47°, the pre-existing shipped look); the debug
   menu's bearing slider is a live-only override (no longer persisted —
   stale localStorage bearings are ignored by the per-key loader);
   `waveHeight`/`waveFreq` pruned from every shipped JSON, ignored by the
   loader, dropped from the Blender exporter (N-panel sliders remain as
   preview-only), and race.ts's respawn margin no longer reads them; the
   wave-zones cookbook now states the GPU evaluation + the 8-zone cap, and
   design-targets' wave-line claim is corrected to "cut".

### P1 — Readability layers (the curvature ask, directly)

> ✅ **SHIPPED (2026-06-09) — pending Matt's playtest verdict on defaults.**
> All four items landed: posterized swell-keyed value ramp (default 0.45 ×
> 3 bands × 0.7 posterize), contour-line foam (0.55 × 0.45 m spacing,
> fwidth-thinned, crowd-faded, 3rd-line index contours), Wind-Waker dark
> twin (0.6, sun-away first-order offset), all live in the water debug menu
> (`Value ramp` … `Contour relief`) and persisted per-key; the sun/bearing
> rule + Reef Cup audit live in
> [track-art-direction.md](./track-art-direction.md) §Cross-track rules.
> Implementation keys on a new swell-only varying (waves 0–1, zone/shoal
> scaled); all signals fade before the center↔outer LOD cross-fade band.
> NOTE for future varyings: WebGPU caps vertex outputs at 16 locations and
> the material WAS at the cap — per-vertex signals are now packed 4-per-vec4
> (`interPackA…D` in water.ts) with ~7 locations of headroom. Verification:
> readability A/B grid (`FOAM_SWEEP=1 FOAM_SWEEP_READABILITY=1`, captures in
> `artifacts/readability-sweep-p1/`), within-boot perf A/B = no measurable
> cost (p50 identical ON/OFF), Reef Cup `gen:track-shots` pass
> (`artifacts/track-shots-p1/`) — Sandbar's calm lagoon correctly shows no
> lines (slope gate), Texcoco's gentle swell shows them subtly (flagged as
> the first knob-tuning question for the playtest).

All fragment-only, all behind live debug-menu knobs (the cel session's
console-only hooks are part of why that work was lost):

1. **Crest-to-trough value ramp, posterized 2–3 steps** — the pre-attentive
   "one value sweep per face" (Wave Race / SoT lesson), keyed to height +
   curvature proxy (not pinch, until P0.2 lands), auto-centered on sun
   elevation (cel-session lesson), warm/teal duality preserved.
2. **Contour-line foam layer** (re-land §4.3 inside the current foam stack):
   iso-height lines off the **swell-only** field, density = steepness;
   `fwidth` thinning at distance; every 3rd line heavier (index contours).
3. **Wind-Waker light/dark pair** on those lines (re-sample the mask with a
   small sun-away offset in dark teal) — cheapest "embossed relief" upgrade.
4. **Sun/bearing track rule** — document in the track-grading guide: low sun,
   cross-track or over-shoulder on wave-reading sections; never dead-ahead.
   Audit the three Reef Cup maps' `timeOfDay` + (new) `swellBearingDeg`.

Verification: deep-ocean test bed A/B grid (extend `foam-sweep.spec.ts` with
the new knobs), then chase-cam `gen:track-shots` on the Reef Cup trio, then
Matt playtests — the readability claim is only provable by hands + eyes.

### P2 — Nuance + anti-repetition

1. ✅ **Wave sets/groups** (§7.2) — **SHIPPED (2026-06-09)** as an analytic
   envelope: `water.swellSets {periodS, depth, phase?}` →
   `1 + depth·sin(2π·t/periodS + φ)` multiplying the ambient amplitude in
   both samplers + every GPU layer via the zone-heightMult slot
   (`waveSetFactor` in wave-field.ts / `setEnvNode` in water.ts — a
   first-class field term rather than the doc's amplitude-mutation sketch,
   so it can't compound with Beaufort / lap-weather / menu writers and
   replays stay pure-in-t; exact `vy` rate term included for hover
   damping). Foam/whitecaps + the P1 ramp follow automatically (they're
   amplitude-driven). The accidental 24 s bichromatic pair stays as the
   global texture beat (see the `defaultWaves` note for why the authorable
   rhythm is the envelope, not per-track pair re-spacing). Cape Town
   authors `{60 s, 0.3}` (playtest-gated); live-only menu rows (Set
   period / Set depth) for tuning. Verified:
   [wave-sets.test.ts](../tests/unit/wave-sets.test.ts) (purity +
   hand-scaled-amplitude equivalence oracle + vy finite-difference) and
   [wave-set-sync.spec.ts](../tests/e2e/wave-set-sync.spec.ts) (waterSync
   ≤ 1.2e-6 m across three phases of Cape Town's cycle; set-high/low
   captures in `artifacts/wave-set-sync/`).
2. **Per-track spectrum presets** (§7.1) — `water.spectrum` JSON block
   (preset name + seed + spread + swell/chop balance), generator emits the
   `Wave[]`; perf-gate the vertex-displacing count (measure 8/12/16 on the
   768² plane), shader-only sub-threshold tail for extra texture, drop chop
   from outer/skirt layers. Per-track water identity is content (§6 rule 4).
3. **Shading anti-repetition kit** (§7.8) — hex-tile detail normals + foam
   bubbles, fix the 4:1 cascade ratio, tangential foam-mask warp, Langmuir
   streak lanes (faint, swell-aligned — a "which way is the sea moving" prime
   on calm stretches).

### P3 — Surf zones + signature waves (the wave-mastery content layer)

1. **Shoaling v2** (§7.3) — swell that visibly slows/steepens/stacks into the
   shallows and breaks at a depth-determined line (Green's law gain,
   `H/h ≈ 0.78` + steepness break criteria with hysteresis, refraction nudge,
   breaker-forward asymmetry), phased on the existing shore-field distance
   bake. Turns every island approach into readable, rideable surf and gives
   Sandbar/Cape Town their signature breaks. (This is where the cut
   South-Beach "wave zone TODO" energy actually belongs.)
2. **Authored wave stamps** (§7.10) — Blender-authored crest splines +
   analytic traveling profiles, superposed on the ambient field, identical
   both sides; fired on the set rhythm (P2.1). Learnable signature jumps —
   same wave, same place, every lap. Start with one per Reef Cup track.

### P4 — Dynamic water (simulate better, with gameplay teeth)

1. **Wave particles / event waves** (§7.5) — landing splashes + set-piece
   rings, sim-owned deterministic pool, GPU mirror like bikes/wakes; never
   the ambient sea.
2. **Catch-the-wave momentum + wake drafting** (§7.6) — dev-flag prototypes,
   Matt playtest gate, AI/lap-time rebalance if adopted.

### Explicitly parked

FFT cascades (7.7), SSR, screen-space contours, stateful SWE sims, and any
displacement-affecting domain warp. Each has a one-line "why" in §7 so the
next person doesn't re-litigate from scratch.

## 9 · Verification protocol (consolidated)

1. **Sync truth:** `?wavedots=1` (+ `?wire=1` implicit) on every zoned track
   and the deep-ocean bed, before/after each P0 item; `renderVertex` transect
   dump at `?steep=1`.
2. **Look:** deep-ocean posed-camera test bed (`setCameraPose`, far from
   shoaling, `setTimeScale(0)` to freeze a crest) for shading layers;
   `FOAM_SWEEP=1` e2e grid extended with each new knob; `pnpm gen:track-shots`
   for per-track grades.
3. **Feel:** headed Playwright autopilot for regressions (`m2-water`,
   `m9-air-control`), then **Matt's hands** for anything touching ride feel —
   playtest verdict outranks instrumented "verification"
   (`feedback_playtest_truth`).
4. **Perf:** draw-call census + boot-timing specs already exist; add a
   vertex-cost A/B (6 vs N waves, zones on/off) on the 768² plane before
   committing P2 component counts.
5. **Determinism:** `m10-determinism` must stay green — every new term is a
   pure function of `(x, z, field.time)` or sim-event-driven state advanced in
   fixed step.

## 10 · Sources

### Perception / stylized readability (agent-verified 2026-06-09)

- Fleming et al., *PNAS* 2011 + PNAS 2025 follow-up — orientation fields
  predict shape-from-shading; intensity transforms preserving orientation
  preserve perceived shape. <https://www.pnas.org/doi/10.1073/pnas.1114619109>,
  <https://pmc.ncbi.nlm.nih.gov/articles/PMC12280972/>
- Cole et al., *How Well Do Line Drawings Depict Shape?* (Princeton) —
  <https://gfx.cs.princeton.edu/pubs/Cole_2009_HWD/cole_2009_hwd.pdf>
- Norman, Todd & Orban 2004 (specular highlights & 3D shape);
  JOV specular-motion curvature studies —
  <https://journals.sagepub.com/doi/10.1111/j.0956-7976.2004.00720.x>,
  <https://jov.arvojournals.org/article.aspx?articleid=2630899>
- Luminance/curvature frontal-light ambiguity —
  <https://pmc.ncbi.nlm.nih.gov/articles/PMC10184780/>
- Texture-orientation slant cues — <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3536750/>
- Cartographic relief practice (contours + shading; index contours) —
  <https://www.maplibrary.org/939/best-relief-shading-techniques-for-topographic-maps/>,
  <https://docs.os.uk/more-than-maps/geographic-data-visualisation/guide-to-cartography/relief-representation>
- *The Technical Art of Sea of Thieves*, SIGGRAPH 2018 —
  <https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf>
- Wind Waker ocean reconstruction (Gordon) — <https://medium.com/@gordonnl/the-ocean-170fdfd659f1>
- Crest ocean docs — <https://crest.readthedocs.io/en/latest/user/water-appearance.html>
- Mikkelsen, *Practical Real-Time Hex-Tiling*, JCGT 2022 —
  <https://jcgt.org/published/0011/03/05/paper-lowres.pdf>; Bitterli
  histogram tiling — <https://benedikt-bitterli.me/histogram-tiling/>
- Ocean rendering series (Jacobian foam, cascade ratios) —
  <https://rtryan98.github.io/2025/10/04/ocean-rendering-part-1.html>;
  Tessendorf course notes —
  <https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2002.pdf>
- Langmuir circulation (wind streaks) — <https://en.wikipedia.org/wiki/Langmuir_circulation>
- Hydro Thunder Hurricane water design interview —
  <https://gemubaka.com/2012/05/07/making-waves-vector-units-matt-small-on-hydro-thunder-hurricane/>
- Wave Race 64 retrospectives —
  <https://www.nintendolife.com/features/soapbox-wave-race-64-is-now-25-years-old-and-it-still-rules>,
  <https://www.thegamer.com/25-years-later-wave-race-64s-water-is-still-undefeated/>

### Shipped-game tech (agent-verified 2026-06-09)

- Uncharted — *Water Technology of Uncharted*, GDC 2012 (4 Gerstner + 4
  wave-particle octaves, SPU evaluation, stateless determinism) —
  <https://www.gdcvault.com/play/1015517/Water-Technology-of>,
  slides: <https://cgzoo.files.wordpress.com/2012/04/water-technology-of-uncharted-gdc-2012.pdf>
- Horizon Forbidden West — Malan, *Rendering Water*, SIGGRAPH 2022 Advances
  (authored breaking-wave cross-sections + curves; full deck) —
  <https://advances.realtimerendering.com/s2022/SIGGRAPH2022-Advances-Water-Malan.pdf>
- AC3/Black Flag ocean (baked looping FFT, Beaufort 0–12, buoyancy probes) —
  <https://www.fxguide.com/fxfeatured/assassins-creed-iii-the-tech-behind-or-beneath-the-action/>
- Atlas / WaveWorks — *Interactive Water Simulation in Atlas*, GDC 2019 —
  <https://gdcvault.com/play/1025819/Advanced-Graphics-Techniques-Tutorial-Wakes>;
  War Thunder / WaveWorks CPU-mirror architecture (128² physics vs 512²
  render, <5 cm divergence; distance-field shore recipe; "4 steps is enough"
  inverse map), CGDC 2015 —
  <https://developer.download.nvidia.com/assets/gameworks/downloads/regular/events/cgdc15/CGDC2015_ocean_simulation_en.pdf>
- Skull & Bones — Kirkpatrick interview ("what you see is what you can
  feel") —
  <https://www.gamerbraves.com/skull-and-bones-technical-director-kris-kirkpatrick-talks-making-water-physics-for-an-open-ocean/>
- Hydro Thunder Hurricane — postmortem + Matt Small interview (CPU emitter
  heightfield, hull proxies, wake drafting; *no* GDC wave talk exists — a
  common misattribution) —
  <https://www.gamedeveloper.com/design/postmortem-vector-unit-s-i-hydro-thunder-hurricane-i->,
  <https://gemubaka.com/2012/05/07/making-waves-vector-units-matt-small-on-hydro-thunder-hurricane/>;
  Riptide GP postmortem (same sim on a 2011 phone CPU; fill-rate lessons) —
  <https://www.gamedeveloper.com/design/postmortem-vector-unit-s-i-riptide-gp-i->
- Wave Race 64 / Blue Storm — retrospectives + video analyses (no Nintendo
  technical record) — <https://en.wikipedia.org/wiki/Wave_Race_64>,
  <https://moegamer.net/2018/02/09/n64-essentials-wave-race-64/>
- Surf games — True Surf (blended 2D wave slices, live forecast data)
  <https://www.meta.com/blog/true-surf-launch/>; Barton Lynch Pro Surfing
  <https://thegameofnerds.com/2024/11/09/riding-the-digital-wave-an-in-depth-look-at-barton-lynch-pro-surfing/>;
  Surf World Series <https://gamingbolt.com/surf-world-series-interview-hanging-ten>
- God of War water = screen-space trick (the counter-example) —
  <https://80.lv/articles/santa-monica-s-senior-programmer-on-how-god-of-war-ragnar-k-s-snow-system-was-made>

### Algorithms (agent-verified 2026-06-09)

- Tessendorf, *Simulating Ocean Water* (FFT bible; Jacobian foam) —
  <https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2002.pdf>
- Horvath, *Empirical Directional Wave Spectra for Computer Graphics*,
  DigiPro 2015 (JONSWAP/TMA/Donelan-Banner) —
  <https://dl.acm.org/doi/10.1145/2791261.2791267>
  (open impl: <https://github.com/blackencino/EncinoWaves>)
- GPU Gems ch. 1 (Gerstner equations; 4 geometry + 15 normal-map waves) —
  <https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models>
- Crest (ShapeGerstner 8/octave; Min Spatial Length physics filter;
  CollProviderBakedFFT) — <https://github.com/wave-harmonic/crest>,
  <https://crest.readthedocs.io/en/stable/user/collision-shape-and-buoyancy-physics.html>
- Yuksel, *Wave Particles*, SIGGRAPH 2007 —
  <https://www.cemyuksel.com/research/waveparticles/>
- Jeschke et al., *Water Surface Wavelets*, TOG 2018 (+ Unity port perf) —
  <https://dl.acm.org/doi/10.1145/3197517.3201336>,
  <https://github.com/seandillon92/WaterSurfaceWavelets-Unity>
- WP+FFT hybrid with GPU buoyancy + the "never ambient particles" datapoint,
  2025 — <https://arxiv.org/abs/2511.02852>; Arc Blanc (cascade ocean + CPU
  physics, JCGT 2025) — <https://arxiv.org/abs/2503.03326>
- Shoaling/refraction/breaking formulas (Green's law, γ ≈ 0.78, Miche) —
  <https://geo.libretexts.org/Bookshelves/Oceanography/Coastal_Dynamics_(Bosboom_and_Stive)/05:_Coastal_hydrodynamics/5.02:_Wave_transformation/5.2.5:_Wave_breaking>
- Wave groups (group speed = c/2; bichromatic envelopes) —
  <https://geo.libretexts.org/Bookshelves/Oceanography/Coastal_Dynamics_(Bosboom_and_Stive)/03:_Ocean_waves/3.05:_Wind_wave_generation_and_dispersion/3.5.3:_Wave_groups>
- Browser implementations: dli/waves <https://github.com/dli/waves>;
  Popov72 WebGPU compute-FFT ocean <https://github.com/Popov72/OceanDemo>;
  Tidewater three.js TSL kit (cascaded FFT + Gerstner + CPU buoyancy mirror,
  May 2026) — <https://ilikekillnerds.com/2026/05/21/i-built-tidewater-threejs-ocean-kit/>;
  GodotOceanWaves (TMA + Jacobian foam grow/decay reference architecture) —
  <https://github.com/2Retr0/GodotOceanWaves>

### Internal

- [water-deep-dive.md](./water-deep-dive.md), [water-foam-look-plan.md](./water-foam-look-plan.md)
- [wave-field.ts](../src/engine/sim/water/wave-field.ts), [water.ts](../src/engine/render/water.ts),
  [shore-field.ts](../src/engine/sim/water/shore-field.ts), [hover.ts](../src/game/systems/hover.ts)
- Memories: `project_water_sim_render_sync`, `feedback_steepness_pinch_unused`,
  `project_cel_water` (unlanded — see §4.3), `feedback_playtest_truth`
