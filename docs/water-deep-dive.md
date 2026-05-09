# Water — research notes + roadmap

Reference for the SoT-style ocean upgrade. Original research compiled 2026-05-09; first wave of changes shipped as M9.29 (see [status.md](./status.md)).

## Current state (M9.29 → M9.34)

Render: horizontal-displacement Gerstner (per-wave Q + global scale uniform, with chop amplitudes bumped 30% in M9.34 for more dramatic short-wavelength pinching), two-color scatter blend (deep teal ↔ cyan-green, view + sun-direction modulated, with sun-glow emissive on backlit crests, sun direction now animated by the day-night cycle), stateless foam accumulator (lingering whitecaps via 4 time-shifted Gerstner samples, no render targets needed), depth-buffer shoreline foam with lapping noise scroll (water/land intersection breathes ±0.4m), richer bike foam pass (speed-modulated hull ring + stern propwash + bow spray + V-wake, all noise-modulated for turbulent edges), noise-modulated roughness for SoT-style "wandering glints", existing analytic normal + Fresnel sky-tint emissive + wake-displacement V-stripe.

Sim: vertical-only Gerstner (unchanged at the formulation level, with new bumped chop amplitudes in M9.34), multi-probe buoyancy (4 sample points around the bike's footprint, pitch/roll from differential heights), unchanged underwater dive + buoyancy + asymmetric drag.

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

## Key sources

- [Ang et al. — *The Technical Art of Sea of Thieves*, SIGGRAPH 2018 (PDF)](https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf)
- [Mihelich/Tcheblokov — *Wakes, Explosions and Lighting: Interactive Water Simulation in Atlas*, GDC 2019 (PDF)](https://gpuopen.com/download/gdc-2019-agtd6-interactive-water-simulation-in-atlas.pdf) — most detailed published cousin of SoT's pipeline; especially the multi-probe buoyancy + ship-wake-into-wave-field loop
- [Tessendorf — *Simulating Ocean Water* (2004 course notes)](https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2004.pdf) — FFT bible incl. the Jacobian whitecap test we approximate with `qSum`
- GPU Gems Ch.1, *Effective Water Simulation from Physical Models* — equations 9 + 13, our Gerstner displacement and normal formulae
- [Alex Tardif — *Water Walkthrough*](https://alextardif.com/Water.html) — SoT-inspired stylized pipeline
- [Rare — *Inn-side Story #3: Engineering Great Water* (YouTube)](https://www.youtube.com/watch?v=9nxlmCq4220)

## What's left, prioritized

### Possible next wins

- **[M] Wake transverse waves.** Real ship wakes have transverse oscillating ridges following the boat (the "scallops" in addition to the diverging V). Could add `sin(K · behind − ω · t)` modulation to the wake displacement function in `wave-field.ts` — but watch the existing wake unit tests (they assert a positive ridge at the V edge, so any longitudinal modulation that can be negative would need to stay above floor).

### Heavier lifts (defer until needed)

- **[L] SSR (or planar bike reflection).** Real screen-space reflections in a TSL node material are non-trivial; planar reflection of just the bikes onto the water plane is much cheaper and gives 80% of the perceptual gain. SoT uses SSR + cubemap blended by Fresnel. Biggest "AAA water" tell, but most expensive to land.
- **[L] FFT migration.** Only worth it if we ever want crest-folding-with-overhang, multi-cascade scale separation (200m swell + 50m chop + 10m ripple as separate cascades), or genuine Jacobian-folding foam. None of which we need for an arcade racer — and the stateless foam accumulator (M9.31) closes most of the perceptual gap with FFT-based foam already.

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
