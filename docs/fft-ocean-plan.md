# FFT ocean migration plan

Multi-phase migration from the current 6-wave analytic Gerstner sum to a
Tessendorf-style FFT ocean. Staged so each phase ships independently and the
project can be paused or rolled back at any milestone without regressing the
shipping water.

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
| A2 — GPU full-spectrum IFFT (height + dx + dz + slope) | ⬜ todo | Vertex shader samples textures instead of summing analytics. |
| A3 — Jacobian-based foam | ⬜ todo | Replace slope/fold heuristic with `det(I+λ∇D)<0`. |
| A4a — Spectrum-field determinism tests (CPU side) | ✅ done | `wave-field-determinism.test.ts` — 6 tests: cross-build identity, advance-step parity, seed forking, replay rebuild-restore cycle, stateless-sampler check, Gerstner regression. Replay + multiplayer determinism guaranteed on the new path. |
| A4b — CPU sampler matches GPU IFFT at probe points | ⬜ todo | Pending A2 (GPU full-spectrum IFFT). The conversion-parity test already locks down the analytic-shader path. |
| A5 — Tuning + debug menu rewrite | ⬜ todo | Wind speed / direction / fetch / cutoff sliders. Retire swell/chop knobs. |

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

### A2 — GPU-side: FFT-driven vertex displacement

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

## Concrete file inventory

New files (all created during the migration):
- `src/engine/sim/water/phillips.ts` — Phillips spectrum + Gaussian sampling, pure math
- `src/engine/sim/water/spectrum-modes.ts` — top-N mode selection, deterministic sort
- `src/engine/render/ocean-fft/spectrum.ts` — JS-side spectrum upload
- `src/engine/render/ocean-fft/butterfly.ts` — bit-reversal + twiddle precompute
- `src/engine/render/ocean-fft/compute.ts` — TSL compute kernels
- `src/engine/render/ocean-fft/runtime.ts` — public surface for water.ts
- `tests/unit/ocean-fft-spectrum.test.ts`
- `tests/unit/ocean-fft-parity.test.ts`

Modified files:
- `src/engine/render/water.ts` — vertex displacement source swaps from
  Gerstner to FFT-texture samples; foam composition swaps slope^2 for
  Jacobian. URL flag plumbing for `?water=fft`. Wake / shoaling / scene-depth
  paths unchanged.
- `src/engine/sim/water/wave-field.ts` — `Wave[]` → `SpectrumMode[]`,
  sampleHeight/sampleSurface become spectrum sums.
- `src/main.ts` + `src/boot/attract-mode.ts` + `src/boot/calibration-mode.ts`
  — `createWaveField()` call gets seed + wind args sourced from the track's
  `water` config.
- `src/engine/water-debug-menu.ts` — knob set updated.
- `tests/unit/wave-field.test.ts` — assertions adapt from sine-wave-specific
  to spectrum-specific.

## Open questions to revisit before A5

- **Choppiness `λ`**: Gerstner's per-wave Q ranges 0.35-1.0 in the current
  setup. Tessendorf's λ is a global scalar. We may want it animated by per-
  region wind for visual variety (calm bay vs. open sea).
- **Cascade count**: single cascade or three? Three is the textbook answer
  but ~3× the compute cost. Decide after A2 measurements.
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
