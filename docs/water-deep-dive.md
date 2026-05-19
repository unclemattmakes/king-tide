# Water — research notes + roadmap

Reference for the SoT-style ocean upgrade. Original research compiled 2026-05-09; first wave of changes shipped as M9.29 (see [status.md](./status.md)).

## Current state (M9.29 → M9.39)

Render: horizontal-displacement Gerstner (per-wave Q + global scale uniform, with chop amplitudes bumped 30% in M9.34 for more dramatic short-wavelength pinching), **sub-Gerstner detail-normal cascades (M9.39 — two world-XZ-aligned samples of a procedural 256² wave-detail normal map at 6 m and 1.5 m tile sizes; hardware mipmap filtering provides distance AA, and their slopes add to the analytic Gerstner gradient before the normal is built so the fine chop SoT achieves with FFT is filled in without explosive vertex counts)**, **Toksvig-style specular AA (M9.39 — fwidth of the per-pixel normal drives a roughness boost up to +0.18 so wave crests at glancing screen angles widen the specular lobe instead of pin-pricking single-pixel glints)**, two-color scatter blend (deep teal ↔ cyan-green, view + sun-direction modulated, with sun-glow emissive on backlit crests, sun direction now animated by the day-night cycle), stateless foam accumulator (lingering whitecaps via 4 time-shifted Gerstner samples, no render targets needed), depth-buffer shoreline foam with lapping noise scroll (water/land intersection breathes ±0.4m), richer bike foam pass (speed-modulated hull ring + stern propwash + bow spray + V-wake, all noise-modulated for turbulent edges), noise-modulated roughness for SoT-style "wandering glints", planar reflection via TSL `reflector()` node (M9.38 — Fresnel-mixed into base color, wave-normal-distorted UV including detail-cascade slopes so close-range reflections ripple with the chop, replaces the prior fresnelEmissive sky tint), existing analytic normal + wake-displacement V-stripe with transverse scallops (M9.35).

Sim: vertical-only Gerstner (unchanged at the formulation level, with new bumped chop amplitudes in M9.34), multi-probe buoyancy (4 sample points around the bike's footprint, pitch/roll from differential heights), wake transverse modulation mirrored on the CPU sampler so trailing riders feel the same scallops they see (M9.35), unchanged underwater dive + buoyancy + asymmetric drag.

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

## Key sources

- [Ang et al. — *The Technical Art of Sea of Thieves*, SIGGRAPH 2018 (PDF)](https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf)
- [Mihelich/Tcheblokov — *Wakes, Explosions and Lighting: Interactive Water Simulation in Atlas*, GDC 2019 (PDF)](https://gpuopen.com/download/gdc-2019-agtd6-interactive-water-simulation-in-atlas.pdf) — most detailed published cousin of SoT's pipeline; especially the multi-probe buoyancy + ship-wake-into-wave-field loop
- [Tessendorf — *Simulating Ocean Water* (2004 course notes)](https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2004.pdf) — FFT bible incl. the Jacobian whitecap test we approximate with `qSum`
- GPU Gems Ch.1, *Effective Water Simulation from Physical Models* — equations 9 + 13, our Gerstner displacement and normal formulae
- [Alex Tardif — *Water Walkthrough*](https://alextardif.com/Water.html) — SoT-inspired stylized pipeline
- [Rare — *Inn-side Story #3: Engineering Great Water* (YouTube)](https://www.youtube.com/watch?v=9nxlmCq4220)

## What's left, prioritized

### Possible next wins


### Heavier lifts (defer until needed)

- **[L] FFT migration.** Only worth it if we ever want crest-folding-with-overhang, multi-cascade scale separation (200m swell + 50m chop + 10m ripple as separate cascades genuinely solved on the GPU rather than approximated with detail-normal textures), or genuine Jacobian-folding foam. None of which we need for an arcade racer — the stateless foam accumulator (M9.31) closes most of the perceptual gap with FFT-based foam already, and the detail-normal cascades (M9.39) close the rest of the silhouette gap at the cost of FFT's analytic-displacement accuracy (which buoyancy doesn't care about anyway).
- **[L] True SSR (instead of the M9.38 planar reflector).** SSR walks rays through the scene depth buffer and would catch reflections of off-plane geometry (e.g. a bike hopping a wave casts the underside of the chassis onto the water beneath it). Our planar reflector treats the water as a flat mirror at y = 0 and renders the scene from the mirrored camera — for an arcade racer where bikes hover at small Δy above the surface, the difference is invisible. SSR also breaks at screen edges where the rays leave the framebuffer. Only worth it if reflection accuracy ever becomes a notable tell.

## Tuning knobs at a glance

| What | Where | Default | Range |
|---|---|---|---|
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
