# FFT ocean migration plan

Multi-phase migration from the current 6-wave analytic Gerstner sum to a
Tessendorf-style FFT ocean. Staged so each phase ships independently and the
project can be paused or rolled back at any milestone without regressing the
shipping water.

## Resuming this work

This branch was developed in a remote container with no browser-automation
MCP attached, so visual A/B validation has been deferred to the local
operator. Latest checkpoint: phase **A2** (full-spectrum GPU IFFT for
vertex displacement). Pull the branch and you have everything Phase C +
A1 + A2 + A4a produced.

To pick up:
1. `git checkout claude/fft-ocean-waves && git pull` — get to the head.
2. `pnpm install && pnpm dev` — local dev server. The water shader path
   responds to URL flags (see below) so A/B is `cmd/ctrl+click` between
   tabs.
3. Read the **Current status** table below — done columns describe what
   exists in the code, todo columns describe what's pending. Each ✅ row
   names the file(s) that landed.
4. **Validation gates not yet exercised** are flagged inline: search the
   table for "Validation". Each ⬜ row's "Notes" column describes the
   intended deliverable + main risks.
5. The most natural next step is **finishing A5** (debug menu). The
   choppiness λ and sea-state intensity sliders landed and live-tune
   the displacement kernel via uniform writes. Wind speed / direction /
   cutoff sliders are still open — they need a live spectrum rebuild
   on slider drag-end (CPU `buildPhillipsSpectrum` + GPU `spectrumTex`
   data upload + `selectTopKModes` for the CPU sampler). After that
   the natural follow-on is the visual tune itself: find the spectrum
   params that make `?water=fft&waves=fft` read as clearly better
   than the v2 Gerstner default. The FFT path currently shows visible
   horizontal banding from the N=32 grid; bumping N or adding a
   second cascade may also be part of that tune.
6. **Open questions** (later in this doc) are decisions deferred to the
   tuning pass — none block forward progress, all benefit from at least
   one round of in-browser eyeballing first.

URL flags to A/B-test in dev:

| URL | What it activates |
| --- | --- |
| `?water=v2` (or no flag) | Default: 6-wave Gerstner + procedural detail cascade. |
| `?water=fft` | C2/C3: detail cascade is a Phillips-spectrum IFFT bake. WebGPU runs the live GPU compute kernel; WebGL2 falls back to a static CPU bake. |
| `?waves=fft` | A1b: big-wave field is a top-32 Phillips spectrum sum (instead of 6-wave Gerstner). CPU buoyancy and GPU shader both read the same modes, kept locked by `spectrumModesToGerstnerShape`. |
| `?water=fft&waves=fft` | Both layers on Phillips, GPU vertex displacement reads the full-spectrum IFFT texture (A2 path). No top-K truncation; the full N² Phillips grid contributes to the visible silhouette. Buoyancy still uses the top-K analytic sum so the disagreement is bounded by the truncation residual. |
| `?water=classic` | Pre-existing legacy heightfield. Untouched by this migration. |

## Current status

**Branch**: `claude/fft-ocean-waves`

| Phase | State | Notes |
| --- | --- | --- |
| 0 — Plan + branch | ✅ done | This document. |
| C1a — Phillips spectrum module (pure JS) | ✅ done | `phillips.ts` + seeded PRNG + 12 unit tests. |
| C1b — Reference 2D IFFT (pure JS) | ✅ done | `fft2d-cpu.ts` + 7 round-trip tests + cross-validation parity test. |
| C2 — Wire CPU-baked spectrum into water.ts via `?water=fft` | ✅ done | `ocean-fft/cpu-bake.ts` builds a drop-in detail texture from the Phillips spectrum. Branched in `getWaveDetailNormalTexture(mode)`. |
| C3 — Port to TSL GPU compute (animated IFFT each frame) | ✅ done | `ocean-fft/gpu-bake.ts` — direct inverse DFT in a single TSL compute kernel at N=64. Dispatched from `mesh.onBeforeRender`. Active on `?water=fft` + WebGPU backend. WebGL2 fallback uses the C2 static bake. **Validation next: in-browser A/B (animation visible vs C2 static).** |
| A1a — Top-K mode selection + analytic samplers (additive) | ✅ done | `spectrum-modes.ts` — `selectTopKModes`, `sampleSpectrumHeightFromModes`, `sampleSpectrumSurfaceFromModes`. 8 unit tests including FD-gradient + variance-capture checks. **No consumer wiring yet — purely additive scaffolding.** |
| A1b — Discriminated WaveFieldState + spectrum factory (opt-in `?waves=fft`) | ✅ done | `WaveFieldState = GerstnerWaveField \| SpectrumWaveField`. `createSpectrumWaveField` builds top-K Phillips modes; `sampleHeight`/`sampleSurface` branch on `field.kind`. GPU shader path converts spectrum → Gerstner-shape via `spectrum-to-gerstner.ts` (parity-tested) so the existing unrolled shader iteration works unchanged. Default stays on Gerstner — `?waves=fft` activates. Debug menu swell/chop scales no-op in spectrum mode (Phase A5 replaces with wind knobs). **Validation next: in-browser A/B against Gerstner default.** |
| A2 — GPU full-spectrum IFFT (height + dx + dz + slope) | ✅ done | `createGpuOceanDisplacement` in `ocean-fft/gpu-bake.ts` runs a per-frame direct-IDFT compute kernel over the full Phillips spectrum (built from `field.spectrumParams` — same array the CPU buoyancy sampler reads). Writes two RGBA32F storage textures: `displacementTexture` = (height, λ·Dx, λ·Dz, Jacobian) and `slopeTexture` = (∂h/∂x, ∂h/∂z, _, _). Vertex shader in `water.ts` branches on `useGpuDisplacement` (`?water=fft` + WebGPU + spectrum field): trades the analytic Gerstner sum for one sample of each texture, gets the full N² spectrum back at the cost of two `textureSample` calls per vertex. Choppiness λ defaults to 0.5 (mid-Tessendorf). Wake / shoaling / scene-depth / bike-contrib paths untouched — all read worldX/worldZ + read the height/slope triple downstream, indifferent to the source. CPU buoyancy stays on top-K analytic. **Calibration retuned:** earlier in the A2 work the visual A/B turned up a pre-existing spectrum-amplitude mistake — `defaultSpectrumParams.amplitude = 1.5` produced 50–100 m wave heights on the full grid and was visibly broken on the A1b path too. Recalibrated to `amplitude = 1.6e-6` (Tessendorf-realistic for the (tileSize=90, windSpeed=9.5) tune) so both A1b (top-K) and A2 (full grid) render in arcade range. `renderScale` opt on the displacement kernel kept as a tuning knob (defaults to `1.0`). |
| A3 — Jacobian-based foam | ✅ done | `water.ts` captures `displacementTexture.a` at the vertex texture-sample site, forwards via `jacobianFrag` varying, and the fragment foam mixer adds `foldFoamFft = smoothstep(0.6, -0.2, jacobianFrag)` as a max term alongside `pixelFoam` and `foamAccumFrag`. Gated on `useGpuDisplacement` so the analytic path pays nothing for the unused varying. At the current spectrum calibration (amplitude=1.6e-6, λ=0.5) the partials stay small and J stays near 1, so the Jacobian foam contributes little visually — the plumbing is in place for when A5's sea-state slider lets the user dial choppiness up to a regime where actual J<0 happens. Slope-based `pixelFoam` still carries whitecap foam on non-breaking waves; the Jacobian foam is additive (max), not replacing. **Validation next: in-browser A/B with `?water=fft&waves=fft` at the default and at amplitude×100 to see the Jacobian foam fire on near-breaking crests.** |
| A4a — Spectrum-field determinism tests (CPU side) | ✅ done | `wave-field-determinism.test.ts` — 6 tests: cross-build identity, advance-step parity, seed forking, replay rebuild-restore cycle, stateless-sampler check, Gerstner regression. Replay + multiplayer determinism guaranteed on the new path. |
| A4b — CPU sampler matches GPU IFFT at probe points | ✅ done | New 7th test in `wave-field-determinism.test.ts`: "top-K analytic sum converges to the full grid when topK = N²" — locks down sign convention + factor-of-2 conjugate handling that the GPU kernel relies on, and asserts the default top-K captures a meaningful variance fraction. Tests pass at 257/257. |
| A5 — Tuning + debug menu rewrite | 🟡 partial | **Landed:** Choppiness (λ) and Sea state (renderScale) sliders, both live-mutating the GPU displacement kernel's uniforms via `gpuDisplacementHandle.setChoppiness` / `setRenderScale`. Persisted to `hoverbike.waterDebug.v2` localStorage (old `v1` key auto-merges onto defaults). Visual A/B confirmed both knobs visibly affect the FFT-path surface in real time. **Still open:** wind speed / direction / fetch / cutoff sliders — these require a live spectrum rebuild (CPU `buildPhillipsSpectrum` + GPU `spectrumTex.image.data.set` + `selectTopKModes` for the CPU sampler) on each slider drag-end. Achievable but heavier plumbing than the constant-uniform knobs A5-partial shipped with. Swell/chop sliders are retained (they still work on the analytic Gerstner path; no-op on spectrum). |

URL flags: `?water=v2` (current Gerstner — default until A5 ships), `?water=fft`
(new path, opt-in during dev), `?water=classic` (legacy heightfield, untouched).

## Context the plan assumes

- **Architecture rule** (`CLAUDE.md`): sim layer must not import Three.js. The
  CPU spectrum sampler lives in `src/engine/sim/water/` and stays pure-math.
- **Determinism**: replay + multiplayer require the sim to produce identical
  numbers from identical inputs. The CPU spectrum is seeded from a known PRNG;
  both CPU and GPU consume the same `h0(k)` array.
- **Backend split**: `createRenderer` uses `WebGPURenderer`, falls back to
  WebGL2 internally. TSL compute requires WebGPU. On the WebGL2 fallback the
  FFT pipeline cannot run — we keep the existing Gerstner material as a
  compile-time fallback. Detect via the existing `RenderBackend` enum.
- **What stays untouched**: wake system, shoreline shoaling (just landed on
  main), scene-depth foam, planar reflection, sub-Gerstner detail cascade is
  REPLACED, foam accumulator stays (operates on FFT slopes instead of Gerstner
  slopes), bike dimples + wake contribs unchanged.
- **Three.js version**: r184. `three/tsl` exposes `compute()`, `computeKernel()`,
  storage textures, atomic ops. WGSL compute is mature.

## Phase C — FFT replaces the detail cascade (LOW RISK)

Goal: prove out the TSL compute pipeline, the Phillips spectrum, and the IFFT
math by using them ONLY for the high-frequency surface detail. Buoyancy and the
big-wave silhouette stay on the existing 6-wave Gerstner — zero risk to game
feel.

### C1 — Scaffold: one-shot compute, write to storage texture

**Files to create**:
- `src/engine/render/ocean-fft/spectrum.ts` — pure JS. Generates the Phillips
  spectrum `h0(k)` for an N×N grid from `{ N, tileSize, windSpeed, windDir,
  gravity, fetch, lowCutoff, highCutoff, seed }`. Returns `Float32Array` of
  size `N*N*2` (interleaved complex). Deterministic via mulberry32 PRNG.
- `src/engine/render/ocean-fft/butterfly.ts` — pure JS. Precomputes the
  butterfly indices + twiddle factors for a radix-2 Cooley-Tukey IFFT at
  size N. Returns log2(N) "stages" of (in, out, twiddle) tables packed into a
  `Float32Array` storage texture. Stock Tessendorf reference layout.
- `src/engine/render/ocean-fft/compute.ts` — TSL compute kernels:
  - `spectrumAnimateKernel`: takes h0(k) + time, writes `h(k,t)` (complex).
  - `butterflyKernel`: one IFFT stage; called log2(N) times alternating
    input/output buffers. Vertical pass then horizontal pass (or transpose
    between passes).
  - `permuteKernel`: bit-reversal permutation + sign flip + scaling.
- `src/engine/render/ocean-fft/runtime.ts` — public surface. Exposes:
  ```ts
  type OceanFftHandle = {
    /** RGBA storage texture, R = height, GBA = dx/dz/jacobian (filled in
     *  later phases; just slopes for C1). */
    outputTexture: THREE.Texture
    /** Drive the spectrum forward by `time` seconds and run the IFFT. */
    tick(time: number, renderer: THREE.WebGPURenderer): Promise<void>
    dispose(): void
  }
  function createOceanFft(opts: SpectrumOpts): OceanFftHandle
  ```

**Files to modify**: none in C1. Build it standalone with a unit test (see
validation).

**Validation gate**:
- Add `tests/unit/ocean-fft-spectrum.test.ts` — checks Phillips amplitudes
  match analytic values for a known wind setting.
- Add a dev page `index-ocean-fft.html` (or a URL flag `?water=fft-debug`)
  that renders the IFFT output texture as a quad on screen. By eye: the
  texture animates smoothly, no NaN flickering, statistically uniform
  spectrum. Save a screenshot to `docs/fft-c1.png` once it looks right.

**Rollback**: nothing wired into water.ts yet — phase C1 lands as pure
addition. Reverting the branch unblocks main with no risk.

### C2 — Wire FFT output as the detail-normal source

**Touch points in `water.ts`**:
- Replace `getWaveDetailNormalTexture()` call (line 936) with a call that
  reads the FFT slope channels (the GB of the output RGBA storage texture).
  Same tile-size + scroll math otherwise — the FFT becomes a higher-quality
  detail texture but consumed identically.
- Add a small constructor parameter `opts.useFft?: boolean` (default false)
  so `?water=fft` opts in. Default stays on the procedural detail texture so
  the existing tuning isn't disturbed.
- Add a per-frame `oceanFft.tick(field.time, renderer)` call from
  `mesh.onBeforeRender` (right next to the scene-depth copy that's already
  there).

**WebGL2 fallback**: the FFT runtime checks `renderer.isWebGPURenderer` and
no-ops if false. The detail texture path stays bound to the procedural texture
so WebGL2 users see the existing look.

**Validation gate**:
- A/B screenshots: same camera position, `?water=v2` vs `?water=fft`. Detail
  should read as visibly less "noisy stipple" and more "ocean ripple." Save
  to `docs/fft-c2.png`.
- Frame-time delta < 1ms on a modern dGPU at default 256² FFT.
- Unit tests still pass (only render changed).

### C3 — Decide whether to animate

C2 ships with the FFT recomputed each frame so the surface naturally animates.
If frame budget is tight, an alternative is a one-shot bake at boot + the
existing warp-and-scroll motion — same as the current procedural texture. We
decide based on the C2 cost measurement.

## Phase A — Full FFT ocean (HIGHER RISK)

Goal: retire the 6-wave Gerstner. Both CPU and GPU read the same Tessendorf
spectrum. Buoyancy stays deterministic and Three-free.

### A1 — Sim-side spectrum + analytic sampler

**`src/engine/sim/water/wave-field.ts`** — significant rewrite:
- Replace `Wave[]` with `SpectrumMode[]` (top-N retained from the full Phillips
  grid):
  ```ts
  type SpectrumMode = {
    kx: number    // rad/m
    kz: number    // rad/m
    omega: number // rad/s, = sqrt(g * |k|)
    /** Initial complex amplitude from Phillips × Gaussian, split into the
     *  cosine + sine components that the analytic sampler needs at runtime. */
    aRe: number
    aIm: number
  }
  ```
- New `WaveFieldState`:
  ```ts
  type WaveFieldState = {
    spectrum: SpectrumMode[]   // top-N modes, sorted by energy
    wakes: WakeSource[]        // unchanged
    time: number
    baseY: number
  }
  ```
- New `sampleHeight(field, x, z)` sums the spectrum at point `(x, z, t)`:
  ```ts
  for each mode m:
    phase = m.kx*x + m.kz*z - m.omega*t
    y += m.aRe*cos(phase) - m.aIm*sin(phase)
  ```
  N = 128 modes by default — calibrated against the Phillips energy
  distribution so the top-128 captures ~95% of the height variance for
  default wind. Configurable.
- `sampleSurface` mirrors with derivatives.
- New `createWaveField({ seed, wind, tileSize, gridSize, topN })` that runs
  `buildSpectrum()` + sorts by `|amplitude|`, keeps top-N.

**`src/engine/sim/water/phillips.ts`** (new) — pure-math spectrum builder.
Shared between sim and render (Three-free since it's pure math). The render
side imports the same module to build its full spectrum for the GPU IFFT.

**Determinism**: `mulberry32(seed)` generates Gaussian pairs via Box-Muller for
each k. Both CPU (sim) and GPU (render) consume the same h0 array. The
mode-selection sort is deterministic (stable + total ordering on energy then
on k).

**Wake unchanged**. Wake math is independent of the ambient spectrum.

### A2 — GPU-side: FFT-driven vertex displacement (✅ landed)

Status as shipped: `createGpuOceanDisplacement(opts)` in `gpu-bake.ts`
allocates two RGBA32F storage textures + a TSL compute kernel. The
kernel evaluates the inverse DFT directly over the full N² Phillips
grid (no real FFT — keeps the pipeline pure-direct since N=32 default
puts the cost well under 1 ms). Per output texel it accumulates 7
quantities: height, Dx, Dz (displacement triple), ∂h/∂x, ∂h/∂z
(slopes), and the three Jacobian partials (Dxx, Dxz, Dzz). After the
mode-sum loop, the Jacobian collapses to a scalar via
`(1+λ·Dxx)(1+λ·Dzz) − λ²·Dxz²` and writes to alpha.

The vertex shader's `useGpuDisplacement` branch swaps the analytic
Gerstner sum for one `texture(displacementTex, …)` plus one
`texture(slopeTex, …)` per vertex; `worldXZ.div(tileSize)` is the UV
and REPEAT wrapping handles the `.fract()`. Tile size matches
`field.spectrumParams.tileSize` so a full repeat is rare in the
visible mesh.

Original plan text (kept for reference; matches what shipped except
for the "single texture" framing — A2 lands with two textures since
the vertex shader needs both the displacement triple and the height
slopes):

**`water.ts`** changes:
- Replace `gerstnerHeight` / `gerstnerDisp` Fn calls with texture samples
  against the FFT runtime's output:
  - R channel = height
  - G channel = dx (horizontal displacement, X)
  - B channel = dz (horizontal displacement, Z)
  - A channel = Jacobian (folding signal for foam)
- Position node becomes:
  ```ts
  const oceanSample = texture(fftOutput, worldXZ.div(tileSize).fract())
  positionNode = vec3(
    positionLocal.x + oceanSample.g,
    oceanSample.r + bikeContrib.x,
    positionLocal.z + oceanSample.b,
  )
  ```
- Slope (for normals + foam) read from a separate FFT-output texture filled
  by a `slopeKernel` that runs alongside the height IFFT. Standard trick:
  multiply the spectrum by `(i·kx, i·kz)` before IFFT.
- The shoaling attenuation from this branch's predecessor wraps these samples
  the same way it wraps Gerstner today — multiply by `shoalFactor`.

**Tiling**: FFT output naturally tiles. For visible repetition, the canonical
fix is multiple cascades at different tile sizes (e.g., 256m + 64m + 16m).
A1 ships single-cascade; if repetition reads as too obvious, add cascades in
A5. Likely fine for arcade since the water mesh moves with the camera and the
horizon read is hazed by aerial perspective.

### A3 — Jacobian foam

The IFFT pipeline produces partials `∂Dx/∂x, ∂Dx/∂z, ∂Dz/∂x, ∂Dz/∂z` as a
free side product (same IFFT, different spectral multipliers). The Jacobian
`J = (1+λ·∂Dx/∂x)(1+λ·∂Dz/∂z) - λ²·∂Dx/∂z·∂Dz/∂x` tells us where the surface
folds. `J<0` ≡ wave breaking ≡ foam.

**Replaces** the existing `foamAccumulator` (water.ts:795-882) and pixel-foam
`slope^2 + fold^2` heuristic with a single sample of the Jacobian map.
The temporal-trail mechanic from foamAccumulator survives — it's wrapped
around the Jacobian signal instead of slope^2.

### A4 — Determinism + multiplayer parity tests

**`tests/unit/ocean-fft-parity.test.ts`** (new):
- For a fixed seed, evaluate `sampleHeight(field, x, z)` at a grid of points.
- Compare against an independent reference (Float64 spectrum sum from
  `phillips.ts` at the same points).
- Max delta must be below FP32 noise floor (~1e-5 at our amplitudes).

**`tests/unit/sim-determinism.test.ts`** (existing) — re-run with the new
spectrum to confirm replay still records and replays bit-identically.

### A5 — Debug menu rewrite

`src/engine/water-debug-menu.ts` knobs change:
- Remove: swell scale, chop scale, steepness (the old Gerstner ones).
- Add: wind speed (m/s), wind direction (deg), wind alignment (cos^N
  directional spread), spectrum cutoff (small-wavelength clip), choppiness λ
  (horizontal-displacement multiplier).
- Keep: detail strength (now controls the high-frequency cascade), foam
  intensity, reflection strength, sparkle params, time scale.

Live updates: changing wind regenerates the spectrum on CPU + uploads new
h0 to the GPU. ~1ms operation, fine to do interactively.

### A6 — Retire `?water=v2` after burn-in

After ~2 weeks of `?water=fft` on dev builds without regressions, flip the
default. Keep `?water=v2` reachable for one more release as an A/B escape
hatch; remove the Gerstner code once nothing's hitting that flag.

## Code map — what's actually wired up

Sim-side (pure-math, no Three.js):
- `src/engine/sim/water/phillips.ts` — Phillips spectrum on an N×N grid, mulberry32 PRNG, Box-Muller, `sampleSpectrumHeight` (analytic full-grid sum).
- `src/engine/sim/water/fft2d-cpu.ts` — radix-2 Cooley-Tukey FFT in 1D + 2D + `fftshift`/`ifftshift`. Reference oracle for any future GPU IFFT and powers the C2 boot-time bake.
- `src/engine/sim/water/spectrum-modes.ts` — top-K mode selection (`selectTopKModes`) + analytic samplers (`sampleSpectrumHeightFromModes`, `sampleSpectrumSurfaceFromModes`).
- `src/engine/sim/water/spectrum-to-gerstner.ts` — the bridge: converts top-K spectrum modes into Gerstner-shape so the existing GPU shader's unrolled iteration walks them without modification. Sign-convention derivation in the module head.
- `src/engine/sim/water/wave-field.ts` — discriminated `WaveFieldState = GerstnerWaveField | SpectrumWaveField`. Factories: `createWaveField(waves)` (Gerstner), `createSpectrumWaveField(params, opts)` (spectrum), `defaultSpectrumParams()`. Samplers branch on `field.kind`.

Render-side (Three.js):
- `src/engine/render/ocean-fft/cpu-bake.ts` — one-shot Phillips→IFFT→slope-texture bake at boot. Drop-in replacement for the procedural `buildWaveDetailNormalTexture`. Used as the WebGL2 fallback when `?water=fft` is active.
- `src/engine/render/ocean-fft/gpu-bake.ts` — two TSL compute pipelines:
  - `createGpuOceanFft` — detail-cascade slope kernel. N=64, short-wavelength Phillips tune (tileSize=12m). Output RGBA8 storage texture sampled by the detail-cascade UVs in the fragment shader. (C3)
  - `createGpuOceanDisplacement` — full-spectrum vertex-displacement kernel. Reads `field.spectrumParams` (matches CPU top-K sampler). Outputs two RGBA32F storage textures: `displacementTexture` = (height, λ·Dx, λ·Dz, Jacobian) and `slopeTexture` = (∂h/∂x, ∂h/∂z, 0, 0). Active on WebGPU + spectrum field + `?water=fft`. (A2)
- `src/engine/render/water.ts` — branches: detail-texture provider (procedural / CPU-bake / GPU-compute) and big-wave displacement source (analytic Gerstner sum vs GPU displacement texture). `useGpuDisplacement` flag controls the vertex-stage texture sample. Wake, shoaling, scene-depth foam, planar reflection, sparkle — all untouched and equally happy on either path; they consume the `(y, dy/dx, dy/dz)` triple regardless of source.

URL-flag plumbing:
- `?water=v2/fft/classic/wire` parsed in `water.ts` near the top of `createWaterMesh`.
- `?waves=fft` parsed in `main.ts` (line ~121), drives factory choice.

Tests (32 files total, 257 tests passing as of A2):
- `tests/unit/phillips.test.ts` — 12 tests on the spectrum + PRNG + Box-Muller.
- `tests/unit/fft2d-cpu.test.ts` — 7 tests on the 2D FFT (round-trip, delta-function, naive-DFT cross-check, fftshift).
- `tests/unit/ocean-fft-parity.test.ts` — analytic sampler ≡ IFFT at every grid point at t=0 and t>0. Load-bearing for the Phase A2 cutover.
- `tests/unit/spectrum-modes.test.ts` — 8 tests on mode selection + analytic sum + variance-capture floor.
- `tests/unit/spectrum-to-gerstner.test.ts` — 4 tests confirming the conversion is mathematically exact across a 9×9×5 probe cube.
- `tests/unit/wave-field-spectrum.test.ts` — 8 tests on the public sim surface with `kind: 'spectrum'`.
- `tests/unit/wave-field-determinism.test.ts` — 7 tests pinning down replay + multiplayer determinism on the spectrum path; the 7th is the A4b probe (top-K analytic converges to full-grid at topK=N², variance-capture floor at default topK).
- Existing `tests/unit/wave-field.test.ts` (Gerstner path) still passes unchanged.

Files still imagined but not built (A3/A5 territory):
- A real radix-2 FFT in TSL (replaces the O(N⁴) direct DFT in `gpu-bake.ts` if N≥128 is needed). Currently both kernels are O(N⁴); at the default N=32 (displacement) and N=64 (detail), this is well under 1 ms each. If a cascade count > 1 lands in A5, revisit then.
- `src/engine/water-debug-menu.ts` rewrite — currently the swell/chop sliders are no-ops in spectrum mode. A5 replaces them with wind / cutoff / choppiness-λ knobs. Choppiness wants a live slider since the A2 kernel exposes `choppinessUniform` as the natural binding point.

## Open questions to revisit before A5

- **Choppiness `λ`**: Gerstner's per-wave Q ranges 0.35-1.0 in the current
  setup. Tessendorf's λ is a global scalar. We may want it animated by per-
  region wind for visual variety (calm bay vs. open sea).
- **Cascade count**: single cascade or three? Three is the textbook answer
  but ~3× the compute cost. A2 lands with TWO independent kernels (the
  detail-cascade `createGpuOceanFft` at N=64, tileSize=12m, and the
  vertex-displacement `createGpuOceanDisplacement` at the field's
  spectrum params — N=32, tileSize=90m at defaults). That's effectively
  a two-cascade setup already; A5 may decide to merge them or add a
  mid-frequency third.
- **Track-data schema**: tracks currently store `water.height`. Add optional
  `water.wind { speed, dirX, dirZ }` for per-track sea state, or keep wind
  as a global default for now? Lean toward per-track for variety.
- **Mobile / WebGL2 fallback**: if the WebGL2 fallback (no compute) catches
  many real users, we keep `?water=v2` reachable indefinitely. Confirm with
  telemetry before retiring it in A6.

## Reference implementations

- Tessendorf 2001 — [Simulating Ocean Water](https://people.computing.clemson.edu/~jtessen/reports/papers_files/coursenotes2004.pdf)
- [jbouny/fft-ocean](https://github.com/jbouny/fft-ocean) — WebGL2 RTT-based, the closest open-source reference for this stack
- [tessarakkt/godot4-oceanfft](https://github.com/tessarakkt/godot4-oceanfft) — best reference for the dual-side CPU buoyancy + GPU IFFT pattern
- [Barth Cave — Ocean Simulation with FFT and WebGPU](https://barthpaleologue.github.io/Blog/posts/ocean-simulation-webgpu/)
