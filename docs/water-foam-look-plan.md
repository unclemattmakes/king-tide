# Water foam — concept-art gap + plan

> **Status: IMPLEMENTED (2026-06-06).** All three steps landed and verified on a
> real GPU (headed Chromium via `pnpm gen:track-shots`) against the concept
> frames. See [§9 Implemented](#9--implemented-2026-06-06) for the landed
> defaults, the new live-tunable debug knobs, and the verification harness. The
> findings + plan below are kept for the rationale — §4 (root cause) still
> explains *why* the whitecap gate was retuned.
>
> Companion to [water-deep-dive.md](./water-deep-dive.md) (the full technical
> reference for the water shader) and [art-direction.md](./art-direction.md)
> (the "warm sun on cold water" / painterly-vinyl register this serves).

## 1. The target look (from the concept frames)

The "wave mastery" concept art shares a consistent water signature:

- **Cool teal/turquoise water body** — our base coloration is already in this
  family.
- **Foam everywhere it matters** — heavy foam streaking down the wave faces and
  rimming the crests/peaks, plus dense warm spray off the bike. The foam is the
  dominant visual, not a garnish.
- **Foam is tinted by the light, and the tint varies** — pink/magenta/coral/gold
  where the sunset rakes it, white-hot in the breaking core, cooler in shadow. It
  is **not** a uniform sky-coloured wash.
- **Foam is directional and painterly** — long flow-aligned brushstrokes down the
  face and along the crest line, not round bubble clusters.
- **Warm reflections on the cool surface** between the foam (the "warm-on-cold"
  master contrast), and **bloom** lifting the bright warm crests so they glow.

Honest caveat: the most saturated frame is essentially a 2-D illustration, and
[art-direction.md](./art-direction.md) itself flags that wide painterly framings
"drift to flat 2-D illustration — fine for mood, not the render target." Chase the
**spirit** (warm light-tinted foam, painterly streaks, warm-on-cold, glow) while
holding the 40 m/s / 60 fps readability contract.

## 2. How the water works today

Core shader: [`src/engine/render/water.ts`](../src/engine/render/water.ts) — a
~3,200-line TSL `MeshStandardNodeMaterial` (Sea-of-Thieves-derived). CPU buoyancy
mirror in [`src/engine/sim/water/wave-field.ts`](../src/engine/sim/water/wave-field.ts).

- **Body colour** is a three-colour scatter blend, all cool teal/cyan: deep
  `vec3(0.02, 0.22, 0.32)` → scatter `vec3(0.22, 0.85, 0.92)` → SSS
  `vec3(0.35, 0.95, 0.85)` (`water.ts:1560-1585`).
- **Foam** is assembled from five sources — accumulated whitecaps, pixel-slope,
  height-whitecap, per-bike wake/bow/propwash, and shoreline surf — all masked by
  **one isotropic round-bubble Worley texture** (`water.ts:443-520`).
- **Foam colour is near-white `vec3(0.97, 0.99, 1.0)`** in both albedo
  (`water.ts:2194`, composited last at `2297-2300`) and emissive
  (`water.ts:2380`). Foam is **deliberately excluded** from reflection and
  sky-tint (`water.ts:2257-2261`).
- **Airborne spray particles are also cool-white**: crest-spray is
  `makeRadialTexture([225, 240, 255])`, bubbles "pale cyan-white"
  (`fx/index.ts:465, 588`).
- The **warm sunset colour already exists in the shader** as `horizonHazeUniform`,
  fed each tick from the sky palette (sunset horizon `0xc26840`, golden `0xf5b070`
  — both warm; `sky.ts:266-278`). The **crest-mist ribbon already tints 50 %
  toward it** (`water.ts:2399`) — proof the warm colour is available and the
  technique works; the main foam just doesn't use it.

## 3. The gap (what the in-game screenshot reveals)

The shipped water reads **flat, pale, and nearly foamless** — smooth rolling
swells, a few small white wisps, mostly a uniform mid-cyan. That is the opposite
of the concept's foam-dense, tonally-rich surf.

**Key correction from the screenshot:** a code-only read suggests "the foam is
white, just re-tint it." The visual truth is **there is almost no foam to tint.**
Re-colouring and streaking foam that isn't being generated buys nothing. Coverage
is the prerequisite, not the finishing touch.

## 4. Root cause — the sea is below every richness threshold

`heightFrag` is the wave height **in metres** (`water.ts:1311`). The
height-driven whitecap gate is:

```
heightWhitecap = smoothstep(1.0, 2.0, heightFrag)   // water.ts:1947
slopeWhitecap  = smoothstep(0.3, 0.7, pixelSlope)    // water.ts:1948
whitecapFoam   = heightWhitecap * slopeWhitecap * foamFiber   // AND-gate, :1949
```

The default 6-wave field sums to a **peak of ~1.4 m** (0.5+0.35+0.22+0.16+0.1+0.06)
with typical crests well under 1 m (`wave-field.ts` `defaultWaves()`). So a normal
crest scores `smoothstep(1.0, 2.0, ~0.5) = 0`, and **full** whitecap needs a 2 m
crest — taller than the tallest wave the field can produce. The whitecap gate
sits **above where the water actually lives.** Combined with the AND-gate against
slope, crest foam essentially never fires. (The slope-driven accumulator and
`pixelFoam` use steep power curves — `pow(...,2)` / `pow(...,3)`, `water.ts:1278,1910`
— so they also stay near zero on gentle swell.)

**The unifying insight:** the same thing causes the *flat colour*. Nearly every
"richness" signal is height/slope-gated and the calm default sea never reaches
any of them at once:

| Signal | Gate | Source |
|---|---|---|
| Whitecap foam | `smoothstep(1.0, 2.0, height)` × slope | `water.ts:1947-1949` |
| Deep→scatter colour blend | `heightNorm = smoothstep(-2, 2, height)` | `water.ts:1548` |
| Crest scatter / sun-glow | `heightFactor = smoothstep(-1.5, 1.5, height)` | `water.ts:1549, 1789` |
| Sparkle | `smoothstep(0.7, 0.95, heightNorm)` | `water.ts:2340` |

At RMS ≈ ±0.5 m, all of these sit in their dead band → uniform pale cyan, smooth
crests, no foam, no sparkle. **Lifting the effective wave energy *or* normalizing
these thresholds to where the waves live raises foam, colour contrast, sparkle,
and sun-glint together** — one high-leverage move. Prefer doing it **shader-side**
(pull the thresholds down) over cranking amplitude, because amplitude also drives
buoyancy/gameplay (`wave-field.ts`) and changes how the bike rides.

> Part of the calm look may also be a deliberately gentle track (the screenshot
> looks like the Sandbar tutorial). Test an energetic zone too (The Maw has 17
> wave zones). But the whitecap gate is mistuned high **regardless** of track.

## 5. The plan (re-ordered after the screenshot)

Coverage moved from "do last, gently" to **first** — it's the prerequisite.

### Step 1 — Make foam appear (coverage), live-tunable

- Add water-debug sliders for the **whitecap height threshold**, **slope
  threshold**, and an **AND/OR toggle** (`water.ts:1947-1949`; wire through the
  debug menu + `water-debug-storage.ts`, current store version `v9`).
- Lower/normalize the height gate so it fires on real crests (candidate: drive it
  off `heightNorm`, or `smoothstep(0.3, 0.9, heightFrag)`), and try **slope OR
  height** instead of the strict product so faces foam from steepness alone.
- **Keep** the distance-based foam-noise antialiasing (`water.ts:1932`) and the
  sparkle distance fades — these exist to stop far-field foam becoming TV-static.
  Loosening coverage without them re-introduces the speckle the current tuning was
  fighting. The slider lets us find the balance on a real track.
- Sanity-check the surf still reads as *surf*, not soap — far-field especially.

### Step 2 — Light-driven, varied foam tint (+ bloom)

- Tint foam by **actual light**, not a flat sky multiply: warm where the sun
  rakes/backscatters (reuse the `sunBackscatter` / `heightFactor` terms already in
  the shader, `water.ts:1707, 1789`), a **protected white-hot core** in the
  breaking centre, cooler/pink in shadow, broken up with noise so it varies. The
  crest-mist's `mix(foamColor, horizonHazeUniform, 0.5)` (`water.ts:2399`) is the
  starting pattern — generalize it, don't make it uniform.
- Apply the same warm tint to the **spray particles** (`fx/index.ts:465, 588`) at
  emit time so airborne spray catches the sunset too.
- Bloom is already wired (`post-pipeline.ts`); author the warm foam emissive
  (`water.ts:2380`) to glow through it. Watch ACES + bloom blowout on the warm
  sunset grades (per art-direction.md).

### Step 3 — Directional / painterly foam streaks (faces + peaks)

- Replace/augment the isotropic Worley bubble texture (`water.ts:443-520`) with an
  **anisotropic, flow-aligned** pattern sampled along the wave-slope / down-face
  direction — and a **crest-line** variant so the peaks get rimmed foam (the user
  called the peaks out specifically). The temporal accumulator
  (`water.ts:1254-1292`) already gives trails; this adds the spatial brushstroke.

## 6. Risks / cautions

- **Speckle vs glassy is a dial.** We're far on the glassy side now; don't
  overshoot into uniform foam/TV-static. Keep the distance AA; judge on screen.
- **Buoyancy coupling.** Don't change wave amplitude/steepness to chase foam
  without checking the ride — prefer shader-side threshold changes. If amplitude
  does change, the CPU `wave-field.ts` sampler must stay in lockstep (it already
  mirrors the GPU; see the `?water` debug notes in water-deep-dive.md).
- **Perf contract.** 40 m/s / 60 fps on M1 / Ryzen 5000. The streak texture is a
  texture swap (cheap); avoid per-pixel multi-octave foam noise.
- **Don't chase the 2-D-illustration frame literally** (§1 caveat).

## 7. Verification protocol (local instance)

1. Run the app locally (WebGPU, real GPU) — see [run] / [verify] skills and
   `docs/water-deep-dive.md` for the `?reflect`, `?steep`, `?aa`, `?detail` URL
   knobs and the in-game water debug menu.
2. Screenshot **before** on a calm track (Sandbar) and an energetic zone (The Maw)
   at a **sunset/golden** sky grade.
3. Apply Step 1, scrub the new sliders, screenshot **after**; compare foam
   coverage to the concept frames.
4. Then Step 2 (tint + bloom) and Step 3 (streaks), screenshotting each.
5. Land the chosen slider values as the new defaults + a `seed`/JSON-expressible
   tune so a re-seed doesn't lose them.

## 8. Key code references

| What | Where |
|---|---|
| Whitecap gate (the smoking gun) | `water.ts:1947-1949` |
| `heightFrag` = metres | `water.ts:1311` |
| Other height/slope-gated richness signals | `water.ts:1548-1549, 2340` |
| Body scatter colours | `water.ts:1560-1585` |
| Isotropic bubble texture | `water.ts:443-520` |
| Foam colour (white) + albedo composite | `water.ts:2194, 2297-2300` |
| Foam emissive (white) | `water.ts:2380` |
| Foam excluded from reflection/tint by design | `water.ts:2257-2261` |
| Crest-mist already tints toward warm horizon | `water.ts:2399` |
| Warm `horizonHazeUniform` source (sky palette) | `sky.ts:266-278`, `water.ts:3111` |
| Spray particles (cool-white) | `fx/index.ts:465, 588` |
| Default wave field (~1.4 m peak) | `wave-field.ts` `defaultWaves()` |
| Crest-spray fire/rearm thresholds | `wave-crest-spray.ts:83-84` |
| Live tuning knobs / persistence | `water-debug-menu.ts`, `water-debug-storage.ts` (`v9`) |

## 9 · Implemented (2026-06-06)

Landed on a real-GPU screenshot pass. Line numbers in §8 above are from the
pre-implementation read and have shifted; search by symbol.

### Step 1 — coverage (the prerequisite)

The whitecap gate is now `mix(h·s, max(h,s), mode)` with both thresholds and the
AND↔OR blend exposed as uniforms, lowered off their legacy values so real crests
fire. Shipped defaults (constants in `water.ts`, captured into
`water.debug.defaults` → inherently re-seed-safe; no per-track JSON):

| Knob | Default | Was | Effect |
|---|---|---|---|
| `whitecapHeight` | **0.55 m** | 1.0 (effectively) | crest height where foam begins |
| `whitecapSlope` | **0.30** | 0.3 (but AND-locked) | face steepness where foam begins |
| `whitecapMode` | **0.35** | 0 (strict AND) | 0 = AND (tall×steep) … 1 = OR |

The distance-faded `foamFiber` noise still breaks coverage into bubbly splotches,
so the calm sea (Sandbar) stays mostly glassy while energetic zones (The Maw)
foam — per-track wave energy drives coverage for free.

### Step 2 — light-driven warm tint + spray tint + bloom

Foam albedo + emissive now warm toward a saturated coral where the **low sun
rakes** it (`sunBackscatter`), gated by **sky warmth** (`horizonHaze.r − .b`) so
it self-disables at midday; the warm emissive blooms on sun-struck crests.
Airborne spray (wake foam, plunge bubbles, crest spray) is tinted once at boot
from the frozen sky warmth via `fx.setSprayTint()` so it catches the sunset too
instead of staying cool-white. Knob: `foamWarmth` (default **1.0**, 0 = flat
white).

### Step 3 — directional / painterly streaks

Foam is combed into **flow-aligned brushstrokes** down the wave faces (stripes
oriented by the per-fragment surface gradient), only on real faces (the
orientation goes noisy at crests/troughs, which leaves crest foam reading as
caps) and faded at distance. Knob: `foamStreak` (default **1.0**, 0 = isotropic
bubbles only).

### Plumbing + tooling

- **5 new live knobs** in the water debug menu + `water.debug` setters
  (`setWhitecapHeight/Slope/Mode`, `setFoamWarmth`, `setFoamStreak`); persistence
  bumped **`v9` → `v10`** (per-key tolerant loader merges old entries onto new
  defaults, so returning users keep their tuning and pick up the foam baseline).
- **`window.__hover.waterDebug()`** exposes the live `WaterMesh.debug` surface so
  the screenshot harness can scrub foam uniforms in a single boot.
- **`?tod=<seconds>`** boot override of the track's frozen time-of-day, for
  screenshotting any track at a sunset grade (e.g. `?tod=285`) without editing
  its JSON.
- **`tests/e2e/foam-sweep.spec.ts`** — gated (`FOAM_SWEEP=1`) real-GPU sweep that
  freezes one wave + parks a camera and grids the foam knobs (coverage / warmth /
  streak / before-after modes) for apples-to-apples tuning.
- Verified locally: `pnpm typecheck`, `pnpm test` (1038), `pnpm build` all green
  (lint: the pass's files are error-clean; repo has unrelated pre-existing lint
  errors).

## 10 · Playtest rework (2026-06-06) — supersedes §9 where they differ

Playtest on the **shallow, pale tracks at a hazy grade** (Sandbar / South Beach /
Cape Town — *not* the deep-teal sunset Maw §9 was tuned on) rejected the first
pass: the foam read as a **uniform milky sheet** indistinct from light shallow
water, and the streaks didn't read at all. Three fixes, all verified on those
energetic maps:

1. **Killed the wash — strength-aware bubble floor.** The smoking gun was the
   foam-bubble blend's flat **0.35 floor**: every foam pixel painted ≥35 % white,
   so the broad thin whitecap turned into a flat sheet. Now the floor is
   `mix(0.05, 0.6, foamMaskRaw)` — thin foam drops to 0.05 (discrete bubbles over
   clean water), strong foam (wake / breaking crest) keeps 0.6 (solid). This is
   the real wash-killer.
2. **Concentrated coverage + binary "shrink-not-fade" edge.** Thresholds raised
   (height **0.65**, slope **0.36**, mode **0.25**) + a `pow(1.6)` gate sharpen,
   so foam fires on genuine breaking crests, clean teal between. Per the user's
   read that concept foam is *binary on/off and shrinks in area, not fades in
   opacity*, the final foam alpha is a **near-binary threshold** (`smoothstep`
   around 0.2, ramp widened with distance for AA) — so as a crest passes its peak
   the foam patch shrinks instead of dissolving to haze.
3. **Streaks = authored brushstroke sheet (Blender Brushstroke Tools).** The
   procedural sine-stripes are gone. A flow-stroke sheet
   (`public/assets/textures/foam_streaks.png`, built by
   `tools/blender/build_foam_streaks.py` / `pnpm gen:foam-streaks`) is composited
   from the **Brushstroke Tools addon's** bundled oil-stroke libraries
   (`streaky_dashes` + `feathery`) into tapered strokes along +U. The shader
   samples it with U mapped to the surface-gradient (down-face) direction and
   gates it by the crest/steep-face signal (`max(whitecapGate, steepFace)`), so
   strokes comb down breaking faces and trace the wave shape — not across flat
   water. `foamStreak` knob still scales it.

   > **Licence (resolved).** The addon *code* is GPL-3.0, but the brush-style
   > *assets* are **CC BY 4.0** (Simon Thommes / Blender Studio, Project Gold) —
   > so the baked sheet ships **with attribution**, alongside the prop brush
   > sheet that draws from the same source (#312–#314). The credit lives on the
   > in-game credits screen (`menu-flow.ts` → BRUSH TEXTURES). `foam_streaks.png`
   > is gitignored + R2-served like `brush_strokes.png`; a fresh clone rebuilds
   > it with `pnpm gen:foam-streaks` (Blender + the addon) or degrades to no
   > streaks (the shader's 1×1-black fallback). See
   > `reference_blender_brushstroke_tools` in memory.

Re-verified: `pnpm typecheck`, `pnpm test` (1038), `pnpm build` green; foam reads
as concentrated bubbly foam + flow-aligned brushstrokes with clean teal between
on South Beach / Cape Town / The Maw real-GPU captures.

## 11 · Crest-placement rework (2026-06-06) — supersedes §9–§10 on whitecap placement

Playtest read: foam was painting the **rising face** of the wave, not the
**crest** — "gentle shadows and white foam UNDER where the whitecaps should be."
Root cause (the §10 gate was still slope-weighted): for a wave, **slope is max
mid-face and ≈0 at the crest**, while **height is max at the crest**. Every
slope-driven foam term therefore peaks *below* the crest:

- the whitecap gate's dominant term was the AND `heightWhitecap × slopeWhitecap`,
  whose product peaks on the upper face (≈ kx=π/4), not the peak;
- `pixelFoam` (`pow(pixelSlope, 3)`) is pure slope → paints the face;
- the vertex foam accumulator's `slopeFoam` is pure slope → trailing face foam.

Fixes (all in `water.ts`, all fragment/vertex visual — buoyancy untouched):

1. **Height-led whitecap gate.** `whitecapGate = pow(mix(heightWhitecap,
   max(heightWhitecap, slopeWhitecap), whitecapMode), 1.6)`. At `whitecapMode 0`
   the cap is **pure height** → foam sits ON the crest; raising `whitecapMode`
   OR-blends slope back in to also foam steep breaking faces, but never relocates
   the cap off the crest. Default `whitecapMode` **0.25 → 0.0**.
2. **Downweighted the slope-face foam** so it can't out-vote the crest cap in the
   `max()`: `pixelFoam ×0.3`, accumulator `slopeFoam ×0.45` (crest-aligned
   `foldFoam` kept at full weight for the trail).
3. **Tighter height ramp + lower start** for a solid cap on real crests:
   `WHITECAP_HEIGHT_BAND 0.7 → 0.4`, `whitecapHeight 0.65 → 0.5` (so gentler
   crests still cap now that placement is crest-concentrated rather than broad).
4. **Foam-bubble texture = solid overlapping discs.** `buildFoamBubbleTexture`
   rewritten from the bright-center two-octave Worley "fizz of tiny rings" to
   flat-filled white circles (one jittered disc per cell, unioned via `max` so
   neighbours overlap into chunky clusters; 8² + 14² discs, thin AA rim). Per the
   user's ask: "solid white circles that can overlap (at least for now)."

Verified on real WebGPU (headed Chrome, `?track=the-maw`, posed free-camera over
**deep open ocean** — see note below — across gentle → energetic swell, frozen
via `waterDebug().setTimeScale(0)`): foam now reads as solid white caps on the
crest tips with clean teal in the troughs/faces, built from overlapping solid
circles. `pnpm typecheck` / `pnpm test` (1044) / `pnpm build` green.

> **Verification note — deep-water test bed.** Shallow water (the foam-test /
> Sandbar / Maw *start* areas) drowns wave-crest foam in shoaling + surf/
> intersection foam, so it's useless for judging whitecaps. The camera-pose
> override (`window.__hover.setCameraPose({pos,target})`) is applied **before**
> the water mesh's per-frame `tick(camera.xz)` (game-loop.ts), so the water
> re-centers on a posed camera — park it far from any island (e.g. `z≈2000` on
> The Maw) for full-amplitude open-ocean swell with no shoaling/surf foam, then
> `setSwellScale`/`setSteepness` + `setTimeScale(0)` to freeze a crest for study.

## 12 · Curvature + leading-edge whitecap (2026-06-06) — supersedes §11's placement

Playtest of §11: the height-led cap read as **wide white bars** straddling the
crest — because height is a poor *placement* signal (the whole top of a swell
clears any height threshold, so foam covers a broad symmetric band). Matt asked
for **curvature-based** foam **biased to the leading (front) edge** of the wave.
That's the physically-correct FFT-ocean model (foam where the surface *folds*,
spilling down the breaking front). Implemented:

1. **Analytic crest signals** (`gerstnerCrestSignals`, a sibling of
   `gerstnerHeight` reusing the same per-wave sin/cos — nearly free, and
   **steepness-independent**, which matters because the Gerstner pinch is
   effectively unused — its sim↔render phase drifts, so visuals must not lean on
   it; see `feedback_steepness_pinch_unused` in memory):
   - **crest curvature** = `Σ A·k²·sin φ` — the negative Laplacian of the height
     field, most positive at sharp crests, ≤0 in troughs. Forwarded as a
     varying, clamped ≥0 in the fragment, gained by `whitecapCurvature`. Sharply
     peaked at the crest → foam is a thin line ON the crest, not a band.
   - **∂h/∂t** = `−Σ A·ω·cos φ` — vertical surface velocity; >0 where the water
     is rising = the **leading/front face** of an advancing crest.
2. **New gate** = `pow(curvCoverage × leadBias, 1.4)`, where `leadBias =
   mix(1, smoothstep(−ref, +ref, ∂h/∂t), whitecapLeadBias)` → ~0 trailing face,
   ~0.5 crest, ~1 leading face. So `whitecapLeadBias` cuts the trailing half of
   the old bar and pushes the cap onto the front — the "breaking forward" look.
3. **Knobs** (replace the height/slope/mode sliders in the water debug menu):
   `whitecapCurvature` (gain, default **4** — higher = more coverage / gentler
   crests foam; lower = only the sharpest breakers) and `whitecapLeadBias`
   (default **1** = front-only … 0 = symmetric). The legacy height/slope/mode
   uniforms + setters + storage keys are **retained** (no store bump; per-key
   loader gives the two new keys their defaults) but no longer feed the wave
   whitecap — safe to retire in a follow-up cleanup.

**Characteristic to know:** pure curvature means **long gentle swells foam very
little** (low k² → low curvature) — the foam comes from the sharper chop and
from where chop rides up onto swell crests (constructive, sharpest combined
crests). That's physically right (gentle swells don't whitecap), but it means
`chopScale 0` ≈ foamless; crank `whitecapCurvature` for more coverage.

**Leading-edge direction** is derived to point at the front (∂h/∂t > 0 ahead of
an advancing crest); the derivation is internally consistent with the phase
`gerstnerHeight` uses, but per the sign-convention history it should be eyeballed
in motion and flipped (negate the `dhdt` accumulation, or swap the `leadBiasRaw`
smoothstep bounds) if foam reads as a *trailing* wake instead.

Verified on real WebGPU (deep-ocean test bed, gentle → energetic swell): foam
reads as crest-following, forward-loaded caps with a crisp bright leading edge —
no wide bars. `pnpm typecheck` / `pnpm test` (1044) / `pnpm build` green; water.ts
lint error-clean (pre-existing `noNonNullAssertion` warnings only).

## 13 · Oil-stroke foam textures (2026-06-09) — supersedes §10.3 and §11.4

Playtest verdict on the §11 "solid overlapping discs": not a fan of the
texture — foam read as rows of white dots ("bubble wrap"), and the ask was an
**oil-paint brush-stroke** read, like the bikes' engine-trail ribbons
(`engine-trail.ts`: tapered band + bristle grain). Two findings and a rework:

1. **The §10.3 Brushstroke-Tools streak sheet had been silently absent from
   dev playtests.** `foam_streaks.png` is R2-served with a silent-404 →
   1×1-black no-op fallback; in dev (no `VITE_ASSET_BASE_URL`) assets resolve
   to local `public/`, and a clone that never ran `assets:pull` after the
   sheet was pushed simply never loaded it. Every dev playtest of §10–§12 was
   judging disc-bubbles with **zero** streak layer. Lesson recorded: a look
   feature must not live or die on optional asset hydration.
2. **Both foam textures are now procedural oil strokes, generated in-code**
   ([oil-stroke-texture.ts](../src/engine/render/oil-stroke-texture.ts)):
   deterministic seeded rasterizer that stamps tapered, bristle-split,
   edge-jittered strokes (blunt pressed head → ragged lifted-off tips, union
   via max, per-stroke paint strength 0.7–1.0 so dimmer strokes surface only
   in stronger foam). Two sheets: a 512² **mass** sheet (chunky dabs, two size
   classes — replaces the disc-bubble sheet as the break-up pattern every foam
   source inherits) and a 1024² **streak** sheet (long thin combing strokes —
   replaces the R2 PNG in the §10.3 down-face streak layer, same gating).
   Build cost ~0.1 s once, lazy. `tools/blender/build_foam_streaks.py` +
   `pnpm gen:foam-streaks` are deleted; the R2 `foam_streaks.png` object is
   orphaned (nothing reads it). The credits screen's Brushstroke-Tools CC-BY
   entry now covers only the prop/terrain vinyl sheet (`brush_strokes.png`),
   which still derives from those maps.
3. **Strokes run parallel to the crest lines** (playtest-corrected: the first
   cut combed them along the swell's *travel* direction and read exactly 90°
   wrong). The mass pattern samples a crest-aligned frame — world XZ rotated
   by `waveBearingDegUniform`, texture U = the wave-front axis, the travel
   coordinate drifting slowly so paint rides with the waves, 5 m tile —
   constant per track, so no per-fragment rotation warping/seams. The §10.3
   streak layer is the on-face variant of the same language: U = the *local*
   cross-slope (crest-line) direction, down-face coordinate scrolled so the
   stroke bands slide down breaking faces. New live knob **`foamBrush`**
   (water debug menu, persisted per-key, default **1**): 0 = legacy disc
   bubbles ↔ 1 = oil strokes, so the A/B is one slider drag.

Verified on real WebGPU via the new `FOAM_SWEEP_BRUSH=1` grid (discs ↔
strokes × streak off/on/strong, The Maw at sunset, elevated + race-height
poses — captures in `artifacts/foam-brush-v2*/`): crest caps and fringes read
as combed tapered strokes along the swell, solid cores stay solid, far field
mushes gracefully into streaking lanes. Unit-pinned in
`tests/unit/oil-stroke-texture.test.ts` (determinism, range, coverage band,
+U anisotropy).
