# Water — research notes + roadmap

Reference for the SoT-style ocean upgrade. Original research compiled 2026-05-09; first wave of changes shipped as M9.29 (see [status.md](./status.md)).

## Current state (M9.29 → M9.38)

Render: horizontal-displacement Gerstner (per-wave Q + global scale uniform, with chop amplitudes bumped 30% in M9.34 for more dramatic short-wavelength pinching), two-color scatter blend (deep teal ↔ cyan-green, view + sun-direction modulated, with sun-glow emissive on backlit crests, sun direction now animated by the day-night cycle), stateless foam accumulator (lingering whitecaps via 4 time-shifted Gerstner samples, no render targets needed), depth-buffer shoreline foam with lapping noise scroll (water/land intersection breathes ±0.4m), richer bike foam pass (speed-modulated hull ring + stern propwash + bow spray + V-wake, all noise-modulated for turbulent edges), noise-modulated roughness for SoT-style "wandering glints", planar reflection via TSL `reflector()` node (M9.38 — Fresnel-mixed into base color, wave-normal-distorted UV, replaces the prior fresnelEmissive sky tint), existing analytic normal + wake-displacement V-stripe with transverse scallops (M9.35).

Sim: vertical-only Gerstner (unchanged at the formulation level, with new bumped chop amplitudes in M9.34), multi-probe buoyancy (4 sample points around the bike's footprint, pitch/roll from differential heights), wake transverse modulation mirrored on the CPU sampler so trailing riders feel the same scallops they see (M9.35), unchanged underwater dive + buoyancy + asymmetric drag.

Lighting: directional sun light animated on a 360s loop (M9.34 — elevation 30..70°, azimuth full rotation). Position synced to the water shader's `sunDirUniform` each frame via `waterMesh.setSunDirection`.

Sim: vertical-only Gerstner (unchanged — the simpler formulation with no inverse solve required), multi-probe buoyancy (4 sample points around the bike's footprint, pitch/roll from differential heights), unchanged underwater dive + buoyancy + asymmetric drag.

Debug knobs: `?water=classic` (full upgrade off — original colors, vertical-only Gerstner, original roughness, original foam, no sun-glow, no foam history), `?wire=1` (orthogonal wireframe), `?steep=N` (0..1.5), `__waterSteepness(n)` console hook.

## Why these particular changes

The reference is Sea of Thieves. Rare's published pipeline (SIGGRAPH 2018 *The Technical Art of Sea of Thieves*) uses **FFT** wave displacement, a hand-authored stylized BRDF (deliberately not PBR), Jacobian-based foam accumulation, SSR-with-cubemap fallback, and multi-probe ship buoyancy. We mirrored the *visual character* of each piece using the cheaper Gerstner cousin where possible:

| SoT technique | Our equivalent | Why |
|---|---|---|
| FFT wave displacement | Sum of 6 Gerstner waves with horizontal term | FFT in the browser means RTT ping-pongs; Gerstner with horizontal gets ~90% of the silhouette at a tenth of the WebGL complexity (Atlas talk + Tardif walkthrough confirm this trade) |
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

- **[L] FFT migration.** Only worth it if we ever want crest-folding-with-overhang, multi-cascade scale separation (200m swell + 50m chop + 10m ripple as separate cascades), or genuine Jacobian-folding foam. None of which we need for an arcade racer — and the stateless foam accumulator (M9.31) closes most of the perceptual gap with FFT-based foam already.
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
| Chop amplitudes | `defaultWaves()` chop entries | 0.65 / 0.44 / 0.29 / 0.16 | scale up for stormier, down for calmer racing surface |
| Wake scallop wavelength | `WAKE_TRANS_K` | 0.7 rad/m (~9m) | smaller K = longer scallops, larger K = tighter ripple. Watch the unit-test sample point (sin(K·10) > 0 at t=0 keeps tests passing) |
| Wake scallop drift speed | `WAKE_TRANS_OMEGA` | 1.0 rad/s (~6.3s period) | how fast the scallop pattern scrolls backward in the bike's frame |
| Wake scallop strength | `WAKE_TRANS_AMP` | 0.3 | wake amplitude varies between (1−amp)× and (1+amp)× along each scallop period; >0.3 risks unit-test threshold |
| Reflection resolution | `resolutionScale` arg to `reflector(...)` | 0.5 | half-res reflection target. Drop to 0.33 if reflection cost ever shows up in profiling; raise to 1.0 for crisp mirror at the cost of one more render pass at full res |
| Reflection strength cap | `fresnel.mul(0.85)` in water.ts | 0.85 | maximum reflectivity at grazing angles. Lower for milder mirror (more deep/scatter color showing through); higher for chrome-like glaze |
| Reflection distortion | `0.02 + 0.6 / (camDist + 2)` | gentle close, mirror-flat at horizon | base 0.02 sets minimum distortion; the inverse-distance term makes near samples distort while horizon stays mirror-clear |
