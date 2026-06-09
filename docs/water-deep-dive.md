# Water — research notes + roadmap

Reference for the SoT-style ocean upgrade. Original research compiled 2026-05-09; first wave of changes shipped as M9.29 (see [status.md](./status.md)).

> **Forward-looking companion:** [water-next-research.md](./water-next-research.md)
> (2026-06-09) — investigation of readability/nuance/repetition + the roadmap
> for what comes after this doc's pipeline, including known sim↔render truth
> gaps (wave zones aren't rendered; pinch distrust) and the phased plan.

## Current state (M9.29 → M9.39)

Render: horizontal-displacement Gerstner (per-wave Q + global scale uniform, with chop amplitudes bumped 30% in M9.34 for more dramatic short-wavelength pinching), **sub-Gerstner detail-normal cascades (M9.39 — two world-XZ-aligned samples of a procedural 256² wave-detail normal map at 6 m and 1.5 m tile sizes; hardware mipmap filtering provides distance AA, and their slopes add to the analytic Gerstner gradient before the normal is built so the fine chop SoT achieves with FFT is filled in without explosive vertex counts)**, **Toksvig-style specular AA (M9.39 — fwidth of the per-pixel normal drives a roughness boost up to +0.18 so wave crests at glancing screen angles widen the specular lobe instead of pin-pricking single-pixel glints)**, two-color scatter blend (deep teal ↔ cyan-green, view + sun-direction modulated, with sun-glow emissive on backlit crests, sun direction now animated by the day-night cycle), stateless foam accumulator (lingering whitecaps via 4 time-shifted Gerstner samples, no render targets needed), depth-buffer shoreline foam with lapping noise scroll (water/land intersection breathes ±0.4m), richer bike foam pass (speed-modulated hull ring + stern propwash + bow spray + V-wake, all noise-modulated for turbulent edges), noise-modulated roughness for SoT-style "wandering glints", planar reflection via TSL `reflector()` node (M9.38 — Fresnel-mixed into base color, wave-normal-distorted UV including detail-cascade slopes so close-range reflections ripple with the chop, replaces the prior fresnelEmissive sky tint), existing analytic normal + wake-displacement V-stripe with transverse scallops (M9.35).

Sim: vertical-only Gerstner (unchanged at the formulation level, with new bumped chop amplitudes in M9.34), multi-probe buoyancy (4 sample points around the bike's footprint, pitch/roll from differential heights), wake transverse modulation mirrored on the CPU sampler so trailing riders feel the same scallops they see (M9.35), **shore-aligned waves mirrored on the CPU sampler so the near-shore breakers are rideable, not just rendered (see "Shoreline transition" below)**, unchanged underwater dive + buoyancy + asymmetric drag.

Lighting: directional sun light animated on a 360s loop (M9.34 — elevation 30..70°, azimuth full rotation). Position synced to the water shader's `sunDirUniform` each frame via `waterMesh.setSunDirection`.

Sim: vertical-only Gerstner (unchanged — the simpler formulation with no inverse solve required), multi-probe buoyancy (4 sample points around the bike's footprint, pitch/roll from differential heights), unchanged underwater dive + buoyancy + asymmetric drag.

Debug knobs: `?wire=1` (wireframe), `?steep=N` (0..1.5 steepness override), `?reflect=0` (disable planar reflection for perf tests), `?aa=off` (drop MSAA so the WebGPU scene-depth copy can run and shoreline foam fires from screen-space depth), `__waterSteepness(n)` and `__waterDetail(n)` console hooks. The full FFT path and the `?water=classic` A/B fallback were removed when we settled on analytic Gerstner + SoT-style fragment shading as the only path.

## Why these particular changes

The reference is Sea of Thieves. Rare's published pipeline (SIGGRAPH 2018 *The Technical Art of Sea of Thieves*) uses **FFT** wave displacement, a hand-authored stylized BRDF (deliberately not PBR), Jacobian-based foam accumulation, SSR-with-cubemap fallback, and multi-probe ship buoyancy. We mirrored the *visual character* of each piece using the cheaper Gerstner cousin where possible:

| SoT technique | Our equivalent | Why |
|---|---|---|
| FFT wave displacement | Sum of 6 Gerstner waves with horizontal term + two procedural detail-normal cascades (6 m / 1.5 m, M9.39) | FFT in the browser means RTT ping-pongs; Gerstner with horizontal gets ~90% of the silhouette at a tenth of the WebGL complexity (Atlas talk + Tardif walkthrough confirm this trade). The detail-normal cascades fill in the sub-meter chop that Gerstner can't reach without an explosive vertex count — sampled from a baked, mip-chained 256² normal map at world-XZ scales, with hardware filtering providing distance AA the FFT path would still need a custom blur for |
| Stylized two-color BRDF | Two-color scatter blend (height + view) | Same perceptual effect (deep ↔ scatter), driven by the same physical intuition (sub-surface scattering brightens crest backs at grazing angles) |
| FFT Jacobian whitecaps | Gerstner `qSum` (Σ Q·k·A·sin) + slope | Mathematically the closed-form analogue of the FFT Jacobian for Gerstner; fires on the same physical condition (surface approaching fold-back) |
| Multi-probe ship buoyancy | 4-probe hoverbike (bow/stern/port/starboard) | Same approach, smaller footprint matching the bike's scale |
| Noise-disrupted specular | Noise-modulated roughness | Same effect (highlights break into wandering glints), just realized via PBR roughness rather than a custom specular lobe |
| SSR + cubemap blended by Fresnel | Planar reflection via TSL `reflector()` (M9.38) | Mirror-camera + half-res render target gives accurate reflections of the (mostly horizontal) scene at a fraction of SSR's cost. SoT uses SSR primarily for off-water reflection of nearby ships' hulls; for an arcade racer where bikes hover ON the water and most reflected content is sky + horizon, the planar approximation reads identically |

## Shoreline transition (shore-aligned waves)

The terrain heightmap's original job was purely *subtractive*: shoal the ambient
swell to zero in the last ~3 m of depth (`shoalFactor` in the vertex shader) so
crests stop clipping up through the seabed. That kept the geometry clean but left
the most interesting water — the surf zone — flat and dead. Every shoreline
reference game (Black Flag, the UE water system, the canonical "distance-to-shore
field" technique) does the opposite near the coast: it *transforms* the swell
into coast-parallel breakers instead of just killing it.

We add that as a second wave train on top of the (still-damped) ambient swell:

- **Shore field bake.** `buildShoreField` (`src/engine/sim/water/shore-field.ts`,
  pure / no Three.js) runs in the same pass that builds the terrain heightmap and
  produces three per-cell arrays over the *same* AABB: `dist` (distance-to-shore
  via a deterministic 2-pass anisotropic chamfer transform, lightly blurred),
  `nrmX/nrmZ` (the unit OFFSHORE normal = `normalize(∇dist)`), and `depth`
  (`waterLevel − terrainY`). It returns `null` when there's no coastline.
- **One source of truth.** The bake is attached to the `TerrainHeightmap` object.
  `water.ts` packs it into an `RGBA16F` texture (allocate-once + copy-in, exactly
  like the heightmap) for the GPU; `setShoreField` hands the *same arrays* to the
  CPU wave field for buoyancy. One deterministic bake → CPU, GPU, and every
  multiplayer peer evaluate the identical field (only `waveField.time` is
  snapshotted, so the static field has to reproduce bit-for-bit).
- **The wave.** Crests run parallel to the coast and march shoreward:
  `phase = SHORE_K·dist + SHORE_OMEGA·t`. Amplitude peaks in the surf band and is
  **capped by the water column** (`min(SHORE_AMP, SHORE_DEPTH_CAP·depth)`), so a
  trough can never breach the seabed (`SHORE_DEPTH_CAP ≤ 1` guarantees it). The
  term is a pure vertical displacement (no horizontal pinch), evaluated identically
  by `computeShore` in `wave-field.ts` and the TSL shader — the `SHORE_*` constants
  are a single export enforced by `tests/unit/shore-constants-drift.test.ts`.
- **Foam re-sync.** The existing depth-driven `shorelineSurf` breaker foam now
  takes its crest signal from `max(ambientHeight, shoreHeight)`, so the surf line
  breaks in step with the shoreward-marching shore waves.
- **Swash run-up.** The screen-space `intersectionFoam` band's reach up the beach
  is modulated by `shoreHeightFrag` (the signed shore-wave height varying): an
  incoming crest pushes the foam edge — both the wide band and the bright
  waterline lip — further up the sand, and the trough lets it slide back. Because
  `shoreHeightFrag` is already scaled by `shoreWaveStrength` and gated to 0 without
  a shore field, the swash is a clean no-op on open water.
- **Wet sand.** The terrain shader's existing wet-band darken (`terrain-shader.ts`)
  was anchored to world y=0; it's now anchored to the real `waterLevel` (threaded
  from `track.water.height` into `TerrainShaderConfig`), so the damp-sand band and
  the underwater refraction tint sit at the actual shoreline on raised/sunken-water
  tracks. Combined with the swash foam washing over it, the beach reads as
  wave-washed without per-fragment state.
- **A/B + tuning.** `shoreWaveStrength` (water debug menu, default 1, `0` =
  byte-identical legacy) scales the whole thing on both CPU and GPU from one
  scalar, same discipline as `waveBearing`.

Known follow-ups (deliberately out of scope): the CPU buoyancy sampler still does
**not** apply the ambient `shoalFactor` (only the GPU does), so near-shore the bike
feels full-amplitude ambient swell beneath the shore breakers — a pre-existing
CPU/GPU mismatch this change doesn't widen but doesn't fix. A *stateful* drying
wet-sand trail (dark sand left behind a receding swash that slowly fades) is the
natural next step — see [Possible next wins](#stateful-drying-wet-sand-trail) below
for an implementation recipe.

## Key sources

- [Ang et al. — *The Technical Art of Sea of Thieves*, SIGGRAPH 2018 (PDF)](https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf)
- [Mihelich/Tcheblokov — *Wakes, Explosions and Lighting: Interactive Water Simulation in Atlas*, GDC 2019 (PDF)](https://gpuopen.com/download/gdc-2019-agtd6-interactive-water-simulation-in-atlas.pdf) — most detailed published cousin of SoT's pipeline; especially the multi-probe buoyancy + ship-wake-into-wave-field loop
- [Tessendorf — *Simulating Ocean Water* (2004 course notes)](https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2004.pdf) — FFT bible incl. the Jacobian whitecap test we approximate with `qSum`
- GPU Gems Ch.1, *Effective Water Simulation from Physical Models* — equations 9 + 13, our Gerstner displacement and normal formulae
- [Alex Tardif — *Water Walkthrough*](https://alextardif.com/Water.html) — SoT-inspired stylized pipeline
- [Rare — *Inn-side Story #3: Engineering Great Water* (YouTube)](https://www.youtube.com/watch?v=9nxlmCq4220)

## What's left, prioritized

### Possible next wins

#### Stateful drying wet-sand trail

The shipped wet sand is a *static* band: it darkens terrain within `wetBand` of the
waterline regardless of whether a wave just washed over it. The next step is a
**drying trail** — sand stays dark where the swash recently reached, then fades back
to dry over a few seconds, so each receding wave leaves a visible wet tongue up the
beach. This is the one genuinely *stateful* piece of the shoreline (wetness has to
persist after the foam recedes), which is why it was deferred. Two ways to build it:

**Option A — stateless analytic accumulator (recommended; matches the codebase ethos).**
The swash run-up is a deterministic function of `(x, z, t)` — exactly the property the
foam accumulator already exploits (`foamAccumulator` in [water.ts](../src/engine/render/water.ts),
"did this point have a crest 0.5 s ago?" = evaluate the wave at `t − 0.5`). Reuse that
trick in the **terrain** shader:

1. Give `buildTerrainMaterial` ([terrain-shader.ts](../src/engine/render/terrain-shader.ts))
   access to the shore field. It already has the static `waterLevel`; add (a) a
   per-frame `time` uniform, (b) a `waterLevel` *uniform* (not the load-time const), and
   (c) the baked shore-field texture + its bounds uniforms + the shared `SHORE_*`
   constants. Terrain can sample the **same** `TerrainHeightmap.shoreField` the water
   shader uses — no new bake.
2. Define the instantaneous swash waterline as `swashY(x,z,t) = waterLevel +
   runUp(x,z,t)`, where `runUp` is the shore-wave crest envelope (the same
   `shoreHeight` signal, clamped to ≥ 0 so only the up-rush wets sand). The shipped
   `SWASH_REACH` lift in `intersectionFoam` is the visual analogue — reuse the same
   amplitude so foam and wet line agree.
3. Accumulate wetness as a time-decayed max over N past samples (mirror
   `foamAccumulator`'s `NUM_SAMPLES`/`DECAY_RATE` loop):
   `wetness = max_i [ exp(−i·dt·k) · smoothstep(fragmentY + ε, fragmentY − ε,
   swashY(x,z, t − i·dt)) ]`. A fragment is wet if the swash line was *above* its
   height at any recent time; the `exp` decay is the drying. `k ≈ 0.3–0.7 /s` gives a
   2–3 s dry-back; `N ≈ 6–8` samples over `dt ≈ 0.3 s` covers it.
4. Feed `wetness` into the existing wet-band mix (extend the `withWet` line) — darken
   + desaturate harder than the static band, and optionally bump roughness down (wet
   sand is shinier).

This stays render-target-free and deterministic (so it's replay/netcode-safe even if
wetness ever nudged gameplay), at the cost of N extra shore-field taps + trig per
terrain fragment **near the shore only** — gate the whole block on `abs(yRelWater) <
wetBand + maxRunUp` so inland fragments early-out.

*Boot-order note:* the terrain material is built in `loadGlbTrackVisuals`
([track-loader.ts](../src/boot/track-loader.ts)) *before* the water mesh exists, so don't
try to borrow the water mesh's uniforms. Instead hand the terrain material its own
`time`/`waterLevel` uniforms + a texture built from `TerrainHeightmap.shoreField`, and
drive `time`/`waterLevel` each frame from `main.ts` (a `setTime`/`setWaterLevel` setter
on the returned material handle, the same shape as `waterMesh.setSunDirection`).

**Option B — top-down wetness render target (heavier, more flexible).** An ortho
"wetness map" over the track AABB: each frame decay the whole buffer toward dry
(`*= ~0.99`) and splat the current swash-covered footprint as wet, then terrain samples
it by world XZ. Handles wetness from *arbitrary* sources (bike spray throwing water onto
sand, rain) that the analytic path can't, but breaks the no-RTT ethos, adds a ping-pong
target + splat pass, and is only worth it once you want those extra sources. Wetness is
purely cosmetic, so the buffer's non-determinism across machines is a non-issue. Build
this only if Option A's analytic swash proves too limiting.

### Heavier lifts (defer until needed)

- **[L] FFT migration.** Only worth it if we ever want crest-folding-with-overhang, multi-cascade scale separation (200m swell + 50m chop + 10m ripple as separate cascades genuinely solved on the GPU rather than approximated with detail-normal textures), or genuine Jacobian-folding foam. None of which we need for an arcade racer — the stateless foam accumulator (M9.31) closes most of the perceptual gap with FFT-based foam already, and the detail-normal cascades (M9.39) close the rest of the silhouette gap at the cost of FFT's analytic-displacement accuracy (which buoyancy doesn't care about anyway).
- **[L] True SSR (instead of the M9.38 planar reflector).** SSR walks rays through the scene depth buffer and would catch reflections of off-plane geometry (e.g. a bike hopping a wave casts the underside of the chassis onto the water beneath it). Our planar reflector treats the water as a flat mirror at y = 0 and renders the scene from the mirrored camera — for an arcade racer where bikes hover at small Δy above the surface, the difference is invisible. SSR also breaks at screen edges where the rays leave the framebuffer. Only worth it if reflection accuracy ever becomes a notable tell.

## Breaking-crest spray (particle layer)

The water *sheet* shades whitecaps + crest-foam beautifully on the GPU, but
shading alone reads as a rubber sheet because nothing ever leaves the surface
— every spray particle used to be keyed off a *bike* (foam wake, splash, plunge
bubbles) or a *scripted* surge zone, so crests broke silently and flatly
wherever the player wasn't. The breaking-crest spray layer closes that gap with
three additive pieces, all gated by the **Settings → Video → "Wave spray"** knob
(`waveSprayIntensity`, full / subtle / off → scalar 1 / 0.5 / 0 in
`WAVE_SPRAY_SCALAR`):

1. **Ambient crest poofs** — [`wave-crest-spray.ts`](../src/engine/render/wave-crest-spray.ts)
   is a pure, Three-free driver (mirrors `surge-spray.ts`) that sweeps a
   **world-anchored** lattice around the camera each frame, reads a
   breaking-foam likelihood at each cell via the injected probe (which folds the
   wave field's slope + crest-height through `breakingFoam`, matching the GPU
   `heightWhitecap · slopeWhitecap` recipe), and fires a one-off burst the moment
   a crest breaks over a cell (rising-edge + re-arm hysteresis, so exactly one
   poof per crest per spot). The lattice is anchored to a fixed world grid so a
   crest sweeping through world space drives each point's foam up→down; cells
   that leave the window as the camera travels are pruned. Render-only (never
   touches the sim), so it isn't netcode-deterministic and doesn't need to be.
   Emits into the new `crestSpray` pool in [`fx/index.ts`](../src/engine/render/fx/index.ts)
   (negative-gravity droplets that arc up off the break and fall back, drifting
   downwind along the dominant swell direction).
2. **Wave-aware bow spray** — also in `fx/index.ts`: when a bike drives INTO a
   rising wave face (forward speed projected onto the local up-slope = vertical
   "closing rate"), it throws a sheet off the nose, scaled by how hard it's
   climbing. Pumping into a crest is now visibly rewarded; skimming a flat sea
   throws nothing.
3. **Crest-mist ribbon** — a cheap GPU emissive haze (`crestMistStrengthUniform`
   in `water.ts`) lofted on steep breaking crests, weighted toward grazing view
   angles + distance so it fills the far field where the discrete sprites read
   too sparse. Tinted halfway to the horizon haze so it reads atmospheric. Set
   live via `water-service.applyWaveSprayIntensity`.

## Tuning knobs at a glance

| What | Where | Default | Range |
|---|---|---|---|
| Wave-spray intensity | `waveSprayIntensity` (Settings → Video → "Wave spray") | full | full / subtle / off — gates all three spray pieces below |
| Crest-spray lattice | `radius` / `spacing` in `wave-crest-spray.ts` | 72 m / 9 m | window half-extent + cell pitch; cost ∝ (2·radius/spacing)² `sampleSurface` calls/frame |
| Crest-spray thresholds | `fireThreshold` / `rearmThreshold` / `breakingFoam` gates | 0.55 / 0.3; slope 0.32–0.72, crest 0.28–0.78 m | raise fire to poof only on the biggest breaks; widen the `breakingFoam` gates to match the GPU whitecap look |
| Crest-spray burst cap | `maxFiresPerTick` in `wave-crest-spray.ts` | 14 | ceiling on cells firing per frame so a swell breaking across the whole window can't dump the pool in one frame |
| Bow-spray closing rate | `BOW_SPRAY_MIN_CLOSING` / `_FULL_CLOSING` in `fx/index.ts` | 1.3 / 6.0 m/s | vertical climb-into-face rate at which the nose sheet starts / saturates |
| Crest-mist ribbon | `crestMistStrengthUniform` (`water-service`) + grazing/dist gates | 1.0; grazing pow-3, dist smoothstep(25,140) | 0 = off (whitecaps still draw); raise for a thicker far-field haze |
| Per-wave steepness | `Q_BASE_DEFAULTS` in `water.ts` | `[0.35, 0.35, 0.85, 0.95, 1.0, 1.0]` | 0..1 per wave |
| Global steepness | `steepnessUniform` (URL `?steep=N`, console `__waterSteepness(n)`) | 0.7 | 0..1.5; >1 risks fold loops |
| Probe footprint | `PROBE_HALF_LENGTH`, `PROBE_HALF_WIDTH` in `hover.ts` | 0.8m × 0.4m | match bike visual scale |
| Surface follow | `BikeStats.surfaceFollow` × altitude factor | per-bike-stat × 0.37 at nominal hover | see status.md M9.22 |
| Foam slope threshold | `smoothstep(0.4, 0.9, slopeMag)` in `water.ts` | 0.4..0.9 | raise to suppress chop foam |
| Foam fold threshold | `smoothstep(0.12, 0.35, qSumFrag)` in `water.ts` | 0.12..0.35 | raise to suppress all foam past sharp ridges |
| Roughness sparkle range | `mix(0.18, 0.04, broadMask)` in `water.ts` | 0.18 → 0.04 | widen for more dramatic glints |
| Shoreline foam range | `FOAM_INTERSECTION_RANGE` in `water.ts` | 1.5m | depth below water at which shoreline foam fades to 0 |
| Hull-ring speed boost | `1 + speedGate · 0.6` in bike foam | 1.0 → 1.6× | bumps ring brightness at race speeds |
| Bow-spray half-angle | `splashHalfAngle` in bike foam | 0.35 (tan) | lower = sharper moustache, higher = wider arc |
| Foam turbulence range | `mix(0.5, 1.0, foamNoiseSmooth)` | 0.5..1.0 | lower bound = more dramatic patchiness |
| Shoreline lapping range | `foamNoiseRaw - 0.5 ·  0.8` offset | ±0.4m | breathes the foam edge in/out for the surf-lapping effect |
| Sun cycle period | `SUN_CYCLE_SECONDS` in `main.ts` | 360s | smaller = more visible mid-race drift; larger = cinematic |
| Sun elevation range | `50 ± 20` degrees in main.ts | 30..70° | low = warmer/longer "sunset" feel; high = brighter overhead |
| Chop amplitudes | `defaultWaves()` chop entries | 0.22 / 0.16 / 0.10 / 0.06 | scale up for stormier, down for calmer racing surface. Tightened in May-2026 along with the swell directions to give the bike a coherent swell train to ride instead of confused seas |
| Wake scallop wavelength | `WAKE_TRANS_K` | 0.7 rad/m (~9m) | smaller K = longer scallops, larger K = tighter ripple. Watch the unit-test sample point (sin(K·10) > 0 at t=0 keeps tests passing) |
| Wake scallop drift speed | `WAKE_TRANS_OMEGA` | 1.0 rad/s (~6.3s period) | how fast the scallop pattern scrolls backward in the bike's frame |
| Wake scallop strength | `WAKE_TRANS_AMP` | 0.3 | wake amplitude varies between (1−amp)× and (1+amp)× along each scallop period; >0.3 risks unit-test threshold |
| Reflection resolution | `resolutionScale` arg to `reflector(...)` | 0.5 | half-res reflection target. Drop to 0.33 if reflection cost ever shows up in profiling; raise to 1.0 for crisp mirror at the cost of one more render pass at full res |
| Reflection strength cap | `fresnel.mul(0.85)` in water.ts | 0.85 | maximum reflectivity at grazing angles. Lower for milder mirror (more deep/scatter color showing through); higher for chrome-like glaze |
| Reflection distortion | `0.02 + 0.6 / (camDist + 2)` | gentle close, mirror-flat at horizon | base 0.02 sets minimum distortion; the inverse-distance term makes near samples distort while horizon stays mirror-clear |
| Detail-cascade tile sizes | `DETAIL_A_TILE`, `DETAIL_B_TILE` in `water.ts` | 6 m / 1.5 m | world-XZ wavelength of each cascade. Tighten (smaller) for sharper micro-chop; widen for larger, gentler ripples |
| Detail-cascade slope scales | `DETAIL_A_SCALE`, `DETAIL_B_SCALE` in `water.ts` | 3.0 / 0.9 | multiplied by the decoded (±0.5) packed slope and divided by tile size to produce world-space dy/dx. Peak contribution ≈ `0.5 · SCALE / TILE`; combined across both cascades should stay well under the analytic Gerstner peaks (~1.0) to keep big-wave silhouettes intact |
| Detail-cascade strength | `detailStrengthUniform` (debug menu slider, console `__waterDetail(n)`) | 0.5 | global multiplier on both cascades. 0 = bypass detail entirely (analytic-Gerstner only, for A/B); 1 = punchy chop; 2 = overdriven for tuning. Affects only visuals, not buoyancy — the CPU sampler doesn't know about detail normals |
| Analytic-slope flatten window | `smoothstep(25, 140, camDist)` in `water.ts` | (25, 140) m | distance-fades the analytic Gerstner slopes toward zero to suppress sub-pixel specular glints. Detail cascades are NOT included — their mip filtering already handles LOD. Pull narrower (e.g. 20, 110) if horizon water still aliases on a particular monitor |
| Toksvig roughness boost | `smoothstep(0.05, 0.5, length(fwidth(normalNode))).mul(0.18)` in `water.ts` | up to +0.18 | screen-space normal-variance specular AA. Raises roughness where the per-pixel normal swings fast, widening the lobe to defeat single-pixel highlight flicker. Higher cap = more aggressive AA at the cost of crispness; lower = sharper highlights with more risk of sparkle aliasing on grazing wave crests |
| Shore-wave strength | `shoreWaveStrengthUniform` (debug menu "Shore waves", console value mirrored to `field.shoreWaveStrength`) | 1.0 | 0..2. 0 = off (byte-identical legacy damped shore); 1 = default breakers; 2 = exaggerated surf. Affects buoyancy (rideable) |
| Shore-wave wavelength | `SHORE_WAVELENGTH` in `wave-field.ts` | 9 m | crest-to-crest of the coast-parallel breakers. Shorter = tighter, more frequent surf lines |
| Shore-wave speed | `SHORE_SPEED` in `wave-field.ts` | 3.5 m/s | shoreward phase speed (`SHORE_OMEGA = SHORE_K·SHORE_SPEED`). Faster = quicker-arriving sets |
| Shore-wave peak amplitude | `SHORE_AMP` in `wave-field.ts` | 0.7 m | amplitude ceiling before the per-sample depth cap. The actual crest is `min(SHORE_AMP, SHORE_DEPTH_CAP·depth)` |
| Shore-wave band depth | `SHORE_BAND_DEPTH` in `wave-field.ts` | 4.5 m | water depth at which the shore wave has faded to zero. Beyond this it's open water |
| Shore-wave depth cap | `SHORE_DEPTH_CAP` in `wave-field.ts` | 0.5 | amplitude ≤ `SHORE_DEPTH_CAP · depth`. Must be ≤ 1 (no seabed breach); 0.5 leaves headroom for the ambient swell's own trough |
