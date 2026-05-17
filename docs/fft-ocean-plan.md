# FFT ocean migration plan

Multi-phase migration from the current 6-wave analytic Gerstner sum to a
Tessendorf-style FFT ocean. Staged so each phase ships independently and the
project can be paused or rolled back at any milestone without regressing the
shipping water.

## Resuming this work

`?water=fft&waves=fft` on the lagoon track at sunset now reads as
recognizably SoT-flavored ocean: 3 FFT cascades (swell + chop + long
swell) with cross wind directions, Mitsuyasu directional spread,
Hasselmann frequency-dependent spread, choppiness peak-mask SSS,
fibrous Jacobian foam, **and persistent foam trails behind passing
crests (Phase A8)**. Phase A2 + A3 + A7 + A8 all done, A5 mostly
done. The A7 section below has the technique-by-technique
walkthrough for the SoT visual polish; the A8 section covers the
foam-feedback buffer. Commit history `git log --oneline
origin/main..HEAD` reads as a phase-by-phase history of the work.

To pick up:
1. `git pull` — branch head has everything.
2. `pnpm install && pnpm dev` — local dev server.
3. **Eyeball it first.** Open
   `http://localhost:5192/?race=1&track=lagoon&bike=racer&water=fft&waves=fft`
   in one tab and `?water=v2` in another, cmd/ctrl-click between
   them. The FFT path should read clearly as ocean now — clean
   cyan-green water with persistent foam trails behind breaking
   crests — not "sand" or "venetian blinds" (those were earlier
   failure modes; the commit history captures the fixes if you're
   curious).
   - **A/B the foam-feedback feature**: same URL with `&foamfb=0`
     turns off A8 and falls back to the stateless `smoothstep(0.5,
     0.0, J)` foam from A3. Toggle and watch the trails appear
     under high cascades.
4. Read the **Current status** table — `✅ done` rows say what
   landed and where; `🟡 partial` rows say what's still open;
   `⬜ todo` are blank slates. Each row names the file(s).
5. The **highest-leverage remaining work** (in rough rank order):
   - **Real radix-2 FFT** in TSL. Replaces the O(N⁴) direct DFT
     in `gpu-bake.ts`. Required if N≥128 per cascade is wanted.
     Roughly the same effort as A8 was.
   - **Wind direction + cutoff sliders** in the water-debug menu.
     Same orchestration pattern as the already-landed wind-speed
     slider (`applySpectrumParams` in `water.ts`). ~30 min.
   - **Per-track sea-state schema**: tracks currently use
     `defaultSpectrumParams()` everywhere; adding optional
     `water.wind { speed, dirX, dirZ }` per track would let lagoon
     read calmer than big-bay etc. ~45 min.
6. **Open questions** (later in this doc) are decisions deferred
   to a future tuning pass — none block forward progress.

URL flags to A/B-test in dev:

| URL | What it activates |
| --- | --- |
| `?water=v2` (or no flag) | Default: 6-wave Gerstner + procedural detail cascade. The shipping look. |
| `?water=fft` | Detail cascade is a Phillips-spectrum IFFT bake (C2/C3). WebGPU runs the live GPU compute kernel; WebGL2 falls back to a static CPU bake. Big-wave silhouette unchanged unless `?waves=fft` is also set. |
| `?waves=fft` | A1b: big-wave field is a top-K Phillips spectrum sum on the analytic path. CPU buoyancy and GPU shader both read the same modes, kept locked by `spectrumModesToGerstnerShape`. |
| `?water=fft&waves=fft` | **The full SoT-style path** (A2 + A3 + A7). Three FFT cascades (wind sea + chop + long swell) drive vertex displacement; Jacobian alpha drives foam; choppiness peak-mask drives SSS color. Mitsuyasu cos²ˢ(α/2) directional spread + Hasselmann frequency-dependent `s` schedule. CPU buoyancy stays on top-K analytic of cascade 0 only (~5% gap from full-grid). **This is what to look at for the current state of the migration.** |
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
| A5 — Tuning + debug menu rewrite | 🟡 partial | **Sliders landed:** Choppiness (λ), Sea state (renderScale), and Wind speed sliders. Choppiness + Sea state live-mutate the GPU kernel's uniforms via `gpuDisplacementHandle.setChoppiness` / `setRenderScale`. Wind speed kicks off a live spectrum rebuild via `applySpectrumParams` in `water.ts` — `buildPhillipsSpectrum` (CPU) + `selectTopKModes` + `gpuDisplacementHandle.uploadSpectrum(grid)`. Persisted to `hoverbike.waterDebug.v3` localStorage. **Visual tune landed:** initial calibration pass (windSpeed=11, amplitude=1e-6, windDir=(0.6,0.8), choppiness=0.7) — superseded by the A7 cascade tune (see below). **Stability fix:** the `waves=fft` analytic path freezes if `topK` is bumped past ~64 — `gerstnerHeight` / `gerstnerDisp` unroll over `waveConsts.length` and `foamAccumulator` re-invokes them at 4 past time samples, making the shader exceed driver-compile budgets. Kept `topK = 32`. The FFT-path's `foamAccumulator` is now also short-circuited (Jacobian + slope foam carry the work), which makes future topK bumps safer. **Still open:** wind DIRECTION + small-wavelength cutoff sliders — same orchestration pattern as wind speed (`applySpectrumParams` in `water.ts:1991-ish`). Swell/chop sliders are retained (they still drive the Gerstner amplitudes; no-op on spectrum). |
| A6 — Retire `?water=v2` after burn-in | ⬜ todo | Unchanged from the original plan. Burn-in `?water=fft&waves=fft` as the dev default for ~2 weeks; flip default and remove Gerstner code once nothing's hitting `?water=v2`. A6 only makes sense after the A7 polish has been tested across all tracks at all times of day. |
| A7 — SoT visual quality polish (cascades + spread + SSS + foam) | ✅ done | New phase added after A2/A3 because the basic FFT path read as "single dominant sine wave" (Phillips' even `cos²` directional factor) rather than ocean. Research summary: SoT SIGGRAPH 2018 + Horvath 2015. Eight commits, all visually A/B-verified via Chrome MCP on the lagoon track at sunset. See **Phase A7** section below for the technique-by-technique walkthrough. Headline changes: **(1)** Phillips `cos²` directional factor replaced with Mitsuyasu `cos²ˢ(α/2)` one-sided lobe — fixed the "standing sine waves" look at root. **(2)** Three FFT cascades (wind sea, chop, long swell) with non-commensurate tile sizes (90 / 22 / 250 m) and CROSS wind directions — multi-scale wave fronts crossing each other = chaotic-natural ocean. **(3)** Hasselmann frequency-dependent `s` schedule — high-k modes get wider spread, kills the residual "comb" pattern from constant-`s` chop. **(4)** Choppiness peak-mask SSS color blend — bright SoT-green crests glow against deep navy troughs via the Tessendorf `|λ·Dx,Dz|` magnitude gate, exactly the recipe SoT documents. **(5)** Foam fiber noise breakup + brighter emissive. Now reads as ocean. |
| A8 — Foam feedback buffer (persistent trails) | ✅ done | `ocean-fft/foam-feedback.ts` — A TSL compute kernel maintains a world-space R32F storage texture (256×256 over a 200 m tile, REPEAT-wrapped) using a `max(prev·decay, instantFoam)` update per texel. `instantFoam` is `smoothstep(jHigh, jLow, min(J_cascade_i))` with bilinear sampling across each cascade's `.a` channel; defaults `(jHigh, jLow) = (-0.2, -0.8)` and `decay = 0.93` (~700 ms half-life). Why those values: with the legacy `(0.5, 0.0)` near-breaking trigger, the per-frame max-feedback converges to ≈1 wherever the cascade Jacobian dips below 0.5 — saturating the buffer into a milky surface. Tightening the trigger to only "actually folding" texels (J ≤ -0.2 .. -0.8) keeps foam concentrated at real wave breaks, and the decay makes those breaks LEAVE TRAILS for ~700 ms instead of vanishing the moment the crest moves on. Single read-write storage texture (per-texel self-update is race-free — each compute thread only touches its own texel; r32float is the WebGPU-guaranteed read_write format). Bilinear sampling of cascade `.a` is done manually with 4 textureLoad taps + 2D lerp since `texture()` would need implicit derivatives unavailable in compute. The kernel ticks AFTER all three cascade displacement kernels each frame so it reads fresh Jacobians. Wired into the FFT path's `foldFoamFft` in `water.ts`; on the non-FFT or non-WebGPU paths the legacy stateless smoothstep stays in place (handle is `null`). **URL escape hatch**: `?foamfb=0` disables the feedback handle for A/B comparison against the pre-A8 stateless look. **Validation done**: Chrome MCP A/B on the lagoon track at sunset palette confirms (a) clean cyan-green water with persistent foam trails behind passing crests when enabled, (b) faster-fading stateless foam when `?foamfb=0`, (c) the non-FFT `?water=v2` path is unaffected, (d) 257/257 unit tests still pass, (e) typecheck clean. **Open follow-ups**: visual tune on remaining tracks (dune-rally, oval, the desert+water mix in big-bay). The A8 trigger thresholds may need per-track adjustment if some tracks have markedly different sea state. Wave advection — foam should drift with the wave's group velocity rather than stay anchored — is NOT implemented; the multi-cascade Jacobian fan-out + the buffer's spatial blur carry the spreading for v0. |

URL flags: see the table at the top. `?water=v2` is the current shipping
default; flip to `?water=fft&waves=fft` to see the full SoT-style FFT path.
A6 will retire `?water=v2` after burn-in. **A8 escape hatch**: append
`&foamfb=0` to the URL to disable the persistent foam feedback for A/B
comparison against the pre-A8 stateless `foldFoamFft`.

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

### A7 — SoT visual quality polish

Phase added after a Chrome MCP visual A/B compared
`?water=fft&waves=fft` to `?water=v2` and found the FFT path read as
"sand-colored sine waves in one direction" rather than ocean. Did
research on Sea of Thieves' published FFT-ocean techniques
(SIGGRAPH 2018 + Horvath 2015 + GDC 2019 Atlas/WaveWorks 2.0) and
landed eight commits implementing the highest-leverage canonical
techniques. Together they take the FFT path from broken-looking to
recognizably SoT-flavored.

**1. Mitsuyasu / Hasselmann directional spread** (`phillips.ts`)

The biggest visible improvement. Phillips' `|k̂·ŵ|² = cos²(α)` is
even — it gives waves running AGAINST the wind the same energy as
waves running WITH it, and at constant exponent 2 the lobe is too
narrow at high k. Replaced with `cos²ˢ(α/2) = ((1+k̂·ŵ)/2)^s`,
which is one-sided (zero at θ_w+π) and tunable.

New optional `PhillipsParams.directionalSpread` (default 1
preserves the legacy fixture-style tests). `defaultSpectrumParams`
sets it to **4** (Horvath-recommended range for visible
directional swell while not pure-isotropic).

**2. Hasselmann frequency-dependent `s` schedule** (`phillips.ts`)

Even with `s=4` at all k, high-k waves at N=64 produced a visible
"comb" of parallel narrow stripes (= more modes = more aligned
energy at fine scales). The Hasselmann schedule varies `s` with k:

```
k ≤ k_peak:  s = directionalSpread          (narrow swell)
k >  k_peak:  s = directionalSpread · (k_peak/k)^0.8   (widening chop)
```

`k_peak = g/V²` (deep-water fully-developed sea). Exponent 0.8
(vs canonical 2.5) keeps mid-k somewhat aligned for the SoT-style
"wind-driven sea" character — pure Hasselmann collapses to
isotropic too fast for arcade visuals. Sub-peak branch left at
constant `s` so the swell silhouette stays narrow.

**3. Three-cascade FFT with cross wind directions** (`water.ts`)

Per the Horvath 2015 / SoT cascade architecture, the visible
ocean is a sum of FFT cascades at different tile sizes covering
different wavelength bands. Three independent
`createGpuOceanDisplacement` handles:

| Cascade | tileSize | windSpeed | amplitude | windDir | spread | choppiness | role |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 wind sea | 90 m | 11 m/s | 1e-6 | (0.6, 0.8) | 4 | 0.7 | CPU buoyancy source; main silhouette |
| 1 chop | 22 m | 6 m/s | 2.5e-6 | (0.8, -0.6) | 1 | 0.4 | Fine ripple riding on swell, perpendicular to swell |
| 2 long swell | 250 m | 16 m/s | 1e-7 | (0.3, 0.95) | 6 | 0.3 | Slow horizon-rolling silhouette |

Tile sizes (90, 22, 250) are non-commensurate (irrational ratios)
so the cascades never re-align at the same world points — the
Horvath fix for "I can see the tile." Different seeds
(0x515a / 0x0CEA / 0x5EA1) so spectra are statistically
independent. Different wind directions per cascade so the
visible wave fronts CROSS each other (real ocean = local wind +
distant storm swell + local chop, all from different directions).

Vertex shader sums height + slope + Dx/Dz across all 3 cascades
and takes `min(J_swell, J_chop, J_long)` for the foam signal.
CPU buoyancy stays on cascade 0 only — cascade 1+2 are
visuals-only (bounded contribution to total height).

**4. SoT three-color albedo with peak-mask SSS** (`water.ts`)

Direct quote from SoT SIGGRAPH 2018: "the wave peak mask is
generated from the FFT choppiness vertex offsets — where the
choppiness offset is greater, this corresponds to wave peaks,
which show more sub-surface due to shorter distance traveled by
light through the water."

Implemented the recipe verbatim:
- `peakMaskFrag = varying(length(λ·Dx, λ·Dz))` — forwarded from
  vertex stage where we already have the displacement vec.
- Saturate `peakMask / 0.35` to map normal pinch magnitude to
  `[0, 1]`.
- Two-step albedo:
  1. `mix(deepColor, scatterColor, heightScatter)` — legacy
     cyan-green height-driven blend.
  2. `mix(step1, sssColor, peakMask · (sunBackscatter+0.35))`
     — the SoT yellow-green SSS layered on top, gated by the
     pinch mask × ambient-floored sun backlight.

Three colors instead of two:
- `deepColor = (0.01, 0.09, 0.20)` navy
- `scatterColor = (0.18, 0.78, 0.78)` cyan-green
- `sssColor = (0.20, 0.95, 0.50)` iconic SoT bright-green

**5. Jacobian foam fiber breakup** (`water.ts`)

Jacobian-driven foam from `smoothstep(0.5, 0.0, J)` produced
smooth airbrushed-white blobs. SoT blends artist-authored foam
textures on top to break the look up. Cheaper alternative landed
here: reuse the existing turbulent foam noise (~3m wavelength,
already computed for wake foam) as a multiplicative `[0.6, 1.0]`
disruption on the wave foam mask. Result: visible fibrous foam
texture without speckle.

Also bumped `foamEmissive` lift from 0.28 → 0.5 so foam pops
visibly against the warm sunset haze.

**6. FFT-path foam-accumulator short-circuit** (`water.ts`)

Defensive change: the legacy `foamAccumulator` re-invokes
`gerstnerHeight`/`gerstnerDisp` at 4 past time samples,
unrolling over `waveConsts.length` (= top-K Phillips modes
converted to Gerstner shape). With `topK = 32` this is 128
unrolled trig pairs per vertex per past sample = 512 per vertex.
At top-K bumped to 128 to tighten CPU-vs-GPU buoyancy parity,
the shader exceeds driver compile budgets and TDRs.

The FFT path doesn't need the accumulator anyway — the Jacobian
foam path + pixelFoam mix cover the role. Short-circuited on
`useGpuDisplacement`. Makes future topK bumps safe.

**Commits (most recent first)**:

- `b09d452` feat(water): Hasselmann frequency-dependent directional spread
- `7c23ead` polish(water): brighter foam emissive + iconic SoT green SSS
- `05e1417` feat(water): foam fiber noise breaks up Jacobian-foam smoothness
- `d714341` polish(water): cross-direction cascades + tuned foam + SSS balance
- `62e857c` feat(water): third cascade + distinct SoT subsurface color
- `66d0145` feat(water): two-cascade FFT (swell + chop) per Sea of Thieves
- `d89809e` feat(water): SoT-style choppiness peak-mask drives scatter color
- `b812ffb` feat(water): Mitsuyasu directional spread replaces Phillips cos²

**Validation done**: Chrome MCP visual A/B vs `?water=v2` on lagoon
at sunset palette after each commit. 257/257 unit tests pass.
Typecheck clean throughout. FPS 80–100 held with all three
cascades dispatching per frame.

**Validation still pending**:
- Visual A/B at midday palette (sun overhead, blue sky) — sunset
  is the harshest lighting palette but day/dawn/dusk should also
  read OK.
- Visual check on the other tracks (big-bay, oval, dune-rally) —
  only lagoon was used for tuning.
- Buoyancy feel pass — bike-on-water physics with the new
  3-cascade spectrum. May need amplitude retune if buoyancy
  reads as too soft / too aggressive.

### A8 — Foam feedback buffer (persistent trails)

Per the SoT research summary, this was THE single biggest gap
between amateur and pro FFT ocean implementations. Foam in real
ocean PERSISTS — it's generated when a wave breaks and lingers
on the surface for ~1 second, slowly fading. Pre-A8 our foam
was stateless: it fired when J<0 NOW and vanished when the wave
moved on, so trailing crest foam was missing entirely. This phase
fills that gap.

**Shape of what landed**

New module `src/engine/render/ocean-fft/foam-feedback.ts` exports
`createFoamFeedback({ cascades })` returning a handle with a
`foamTexture`, a `tileSize`, and `tick(renderer)`/`setDecay`/
`dispose` methods. Internally:

- **Single read-write R32F storage texture** at 256×256 covering a
  200 m world tile, REPEAT-wrapped. Chose r32float specifically
  because that's the float format WebGPU guarantees `read_write`
  storage access on — per-texel self-update is race-free since
  each compute thread only touches its own texel. No ping-pong
  needed.
- **TSL compute kernel** dispatched after the three cascade
  displacement kernels each frame. Per output texel:
  - Compute world position from texel coord (texel center at
    `((px+0.5)/N · tileSize, (py+0.5)/N · tileSize)`, REPEAT wrap
    handles `worldXZ > tileSize`).
  - Manually-bilinear sample each cascade's displacement-texture
    `.a` channel (4 textureLoad taps + 2D lerp). Has to be done
    by hand because TSL `texture()` would need implicit
    derivatives unavailable in compute, and raw nearest sampling
    by-itself caught per-cascade-texel J extremes that saturated
    the buffer.
  - Take `min` for the combined Jacobian across cascades.
  - `instantFoam = smoothstep(jHigh, jLow, J).clamp(0, 1)` with
    `(jHigh, jLow) = (-0.2, -0.8)` — only fires on
    actually-folding cascade texels. Tighter than the legacy
    `(0.5, 0.0)` near-breaking trigger for a structural reason:
    in a max-feedback rule, instantFoam in regions of constant
    trigger converges directly to the per-frame contribution, so
    a 0.2 instantaneous trigger across the whole surface →
    milky-water saturation. Tightening makes foam concentrated
    at actual breaks.
  - `prev = textureLoad(foamTex, texel)` — self-read from the
    same texture.
  - `newFoam = max(prev · decay, instantFoam).clamp(0, 1)` with
    `decay = 0.93` (≈700 ms half-life at 60 fps).
  - `textureStore(foamTex, texel, newFoam).toReadWrite()`.
- **Fragment shader** in `water.ts` samples
  `texture(foamTexture, worldXZ / tileSize) * foamFiber` to
  produce `foldFoamFft`. Falls back to the legacy stateless
  `smoothstep(0.5, 0.0, jacobianFrag)` when the foam-feedback
  handle is null (non-WebGPU / non-spectrum / `?foamfb=0`).
- **URL escape hatch**: `?foamfb=0` disables the handle so the
  rest of the FFT path falls back to the stateless A3 foam.
  Useful for A/B comparison.

**Visual A/B (Chrome MCP)**

On lagoon at sunset palette, with the feedback enabled:
- Clean cyan-green water in troughs and on calm patches.
- Foam concentrated at actual wave-crest breaks.
- **Trails** visible behind passing crests — exactly the SoT-
  style "wave broke here, foam lingers ~1 s" look.

With `?foamfb=0` for comparison:
- Foam still appears at breaking crests but vanishes immediately
  as crests move on. No trails.

The non-FFT `?water=v2` path is untouched (foam-feedback handle
is `null` since it requires cascade handles).

**Open follow-ups**

- **Per-track sea-state**: A8 thresholds were tuned on lagoon
  alone. Tracks with markedly different cascade choppiness (e.g.
  big-bay's open water if its terrain decoration changes the
  visible-foam framing) may need their own
  `(jHigh, jLow, decay)` triple. Recommend exposing these as
  uniforms on the handle (`setJacobianThresholds`,
  `setDecay`) once the schema for per-track water params lands.
- **Wave advection**: foam should drift with the wave's group
  velocity rather than stay anchored. NOT implemented for v0;
  the multi-cascade Jacobian fan-out + the buffer's spatial blur
  carry the spreading. Implementing it would mean adding an
  advection offset to the texel's read coord (`prev = sample
  foamTex at texel - groupVel · dt`).
- **Larger foam tile**: 200 m may be too small for tracks where
  the camera traverses long distances — visible REPEAT tiling
  could become an issue. Bumping to 400 m or 500 m quadruples
  cost (linear in texel count) but the kernel is already
  sub-millisecond.

### A9 — Real radix-2 FFT in TSL

Replaces the O(N⁴) direct DFT in `gpu-bake.ts`. Current direct
DFT is fine at N=32 (1M ops/frame/cascade × 3 cascades = 3M
ops, well under 1 ms). N=64 was tried and reverted (caused
visible comb pattern from too-aligned high-k modes — A7's
Hasselmann freq-dep spread later addressed the math but the
direct DFT cost at N=64 is still 16× higher and starts to
matter on low-end GPUs).

If the team wants N≥128 per cascade (= sub-meter detail without
relying on the normal-map detail cascade), the direct DFT is no
longer viable — real FFT is O(N²·logN) for the 2D pass and
becomes the standard solution at that scale. SoT, Encino,
WaveWorks all use N=256 or 512 per cascade with real FFT.

**Implementation sketch** (~60 min):
- Radix-2 Cooley-Tukey, two passes (rows then columns).
- Each pass: log₂N butterfly stages.
- Ping-pong between two storage textures across stages.
- Bit-reversal permutation at start (or end).
- Standard reference: jbouny/fft-ocean implements this in WebGL2
  RTT; gasgiant/FFT-Ocean / rtryan98 ocean-rendering writeups
  for WebGPU compute versions.

Reference `src/engine/sim/water/fft2d-cpu.ts` already has a
CPU radix-2 implementation that can serve as the oracle.

## Code map — what's actually wired up

Sim-side (pure-math, no Three.js):
- `src/engine/sim/water/phillips.ts` — Phillips spectrum on an N×N grid, mulberry32 PRNG, Box-Muller, `sampleSpectrumHeight` (analytic full-grid sum).
- `src/engine/sim/water/fft2d-cpu.ts` — radix-2 Cooley-Tukey FFT in 1D + 2D + `fftshift`/`ifftshift`. Reference oracle for any future GPU IFFT and powers the C2 boot-time bake.
- `src/engine/sim/water/spectrum-modes.ts` — top-K mode selection (`selectTopKModes`) + analytic samplers (`sampleSpectrumHeightFromModes`, `sampleSpectrumSurfaceFromModes`).
- `src/engine/sim/water/spectrum-to-gerstner.ts` — the bridge: converts top-K spectrum modes into Gerstner-shape so the existing GPU shader's unrolled iteration walks them without modification. Sign-convention derivation in the module head.
- `src/engine/sim/water/wave-field.ts` — discriminated `WaveFieldState = GerstnerWaveField | SpectrumWaveField`. Factories: `createWaveField(waves)` (Gerstner), `createSpectrumWaveField(params, opts)` (spectrum), `defaultSpectrumParams()`. Samplers branch on `field.kind`.

Render-side (Three.js):
- `src/engine/render/ocean-fft/cpu-bake.ts` — one-shot Phillips→IFFT→slope-texture bake at boot. Drop-in replacement for the procedural `buildWaveDetailNormalTexture`. Used as the WebGL2 fallback when `?water=fft` is active.
- `src/engine/render/ocean-fft/gpu-bake.ts` — two TSL compute-pipeline factories:
  - `createGpuOceanFft` — detail-cascade slope kernel. N=64, short-wavelength Phillips tune (tileSize=12m). Output RGBA8 storage texture sampled by the detail-cascade UVs in the fragment shader. (C3)
  - `createGpuOceanDisplacement` — full-spectrum vertex-displacement kernel. Each instance reads its own PhillipsParams + choppiness + renderScale and produces two RGBA32F storage textures: `displacementTexture` = (height, λ·Dx, λ·Dz, Jacobian) and `slopeTexture` = (∂h/∂x, ∂h/∂z, 0, 0). Three instances are created per scene by water.ts (A7 cascades). The handle now exposes `N` alongside `tileSize` so downstream consumers like the A8 foam-feedback kernel can do their own bilinear sampling without threading the value through their own opts.
- `src/engine/render/ocean-fft/foam-feedback.ts` (A8) — `createFoamFeedback({ cascades })` builds a single read_write R32F storage texture and a TSL compute kernel. Per frame, the kernel updates each foam texel via `max(prev·decay, smoothstep(jHigh, jLow, min(J_cascade_i)))` with manually-bilinear sampling of each cascade's `.a` Jacobian. The output texture is world-anchored (NOT camera-anchored), REPEAT-wrapped at 200 m, and sampled by the fragment shader as the persistent `foldFoamFft` source. Wired only when all three cascades are present + on WebGPU; falls back to legacy stateless smoothstep otherwise. `?foamfb=0` URL flag forces the fallback for A/B comparison.
- `src/engine/render/water.ts` — main shader + cascade orchestration:
  - **Detail-texture provider**: procedural / CPU-bake / GPU-compute, branched on `?water=fft` + backend.
  - **Big-wave displacement source**: 3-cascade FFT sum (A7) when `?water=fft` + spectrum field + WebGPU, else analytic Gerstner. The three displacement handles are `gpuDisplacementHandle` (wind sea, spectrumParams), `gpuChopHandle` (chop, tileSize=22), `gpuSwellHandle` (long swell, tileSize=250). Vertex shader sums height/slope/Dx/Dz across them and takes `min(J)` for foam.
  - **Foam feedback handle** (A8): `foamFeedbackHandle` constructed alongside the cascades. The fragment shader's `foldFoamFft` samples its `foamTexture` at `positionWorld.xz / tileSize` when present, falling back to the legacy stateless smoothstep otherwise. Ticked after all three cascade kernels each frame so it reads fresh Jacobians.
  - **`useGpuDisplacement`** flag controls the vertex-stage texture-sum path.
  - **Three-color albedo blend** (A7): deep → scatter → SSS with peak-mask gate. SSS layer fires on choppiness magnitude × sun-backlight.
  - **`applySpectrumParams`** orchestrator for live wind-speed scrubbing — rebuilds CPU `field.spectrum` (top-K) + GPU `gpuDisplacementHandle.uploadSpectrum(grid)` in lockstep. Currently only wired to wind-speed slider; wind-direction + cutoff are the obvious next slider expansions.
  - Wake, shoaling, scene-depth foam, planar reflection, sparkle — all untouched and equally happy on either FFT or Gerstner path; they consume the `(y, dy/dx, dy/dz)` triple regardless of source.

URL-flag plumbing:
- `?water=v2/fft/classic/wire` parsed in `water.ts` near the top of `createWaterMesh`.
- `?waves=fft` parsed in `main.ts` (line ~121), drives factory choice.
- `?foamfb=0` parsed in `water.ts` next to the foam-feedback construction site — disables the A8 persistent-foam handle.

Tests (32 files total, 257 tests passing as of A7):
- `tests/unit/phillips.test.ts` — 12 tests on the spectrum + PRNG + Box-Muller.
- `tests/unit/fft2d-cpu.test.ts` — 7 tests on the 2D FFT (round-trip, delta-function, naive-DFT cross-check, fftshift).
- `tests/unit/ocean-fft-parity.test.ts` — analytic sampler ≡ IFFT at every grid point at t=0 and t>0. Load-bearing for the Phase A2 cutover.
- `tests/unit/spectrum-modes.test.ts` — 8 tests on mode selection + analytic sum + variance-capture floor.
- `tests/unit/spectrum-to-gerstner.test.ts` — 4 tests confirming the conversion is mathematically exact across a 9×9×5 probe cube.
- `tests/unit/wave-field-spectrum.test.ts` — 8 tests on the public sim surface with `kind: 'spectrum'`.
- `tests/unit/wave-field-determinism.test.ts` — 7 tests pinning down replay + multiplayer determinism on the spectrum path; the 7th is the A4b probe (top-K analytic converges to full-grid at topK=N², variance-capture floor at default topK).
- Existing `tests/unit/wave-field.test.ts` (Gerstner path) still passes unchanged.

Files still imagined but not built (A9 territory):
- A real radix-2 FFT in TSL (replaces the O(N⁴) direct DFT in `gpu-bake.ts`). A9. Required if N≥128 per cascade is wanted. Reference CPU radix-2 already exists in `src/engine/sim/water/fft2d-cpu.ts`.
- `src/engine/water-debug-menu.ts` wind-direction + cutoff sliders. Wind-speed already has the `applySpectrumParams` orchestration; the missing sliders reuse the same path with different param keys. A foam-persistence (decay) slider on the same menu is the obvious A8 extension once a per-track sea-state schema lands.
- Per-track `water.wind { speed, dirX, dirZ, fetch }` schema. Currently all tracks use `defaultSpectrumParams()`. Adding per-track override would let lagoon read calmer than dune-rally or wherever, and would also be the natural home for per-track A8 foam thresholds.

## Open questions to revisit later

- **Choppiness `λ`** per-cascade vs global. A7 currently sets λ per cascade
  (wind sea 0.7, chop 0.4, long swell 0.3). Works visually. A future
  per-track sea state might want a global multiplier that scales all
  three.
- **Cascade count**: answered by A7 — three cascades land cleanly and
  perf-fine on the test rig. SoT uses 3–4. A fourth (high-frequency
  ripple band) could let us drop the legacy detail-cascade procedural
  noise entirely, but the current "3 displacement cascades + 1
  detail-normal cascade" stack is already 4 effective cascades.
- **Track-data schema**: tracks currently store `water.height` only. Add
  optional `water.wind { speed, dirX, dirZ }` for per-track sea state, or
  keep wind as a global default? The A5 wind-speed slider hints at
  per-session adjustment; per-track would let lagoon read calmer than
  open-ocean tracks.
- **Mobile / WebGL2 fallback**: WebGL2 backend has NO FFT compute path
  at all (the kernel needs WebGPU compute shaders). On WebGL2, the
  FFT path falls back to analytic Gerstner + the static C2 CPU-bake
  detail texture. Acceptable for now since most modern browsers have
  WebGPU; telemetry-driven decision before A6 retires `?water=v2`.
- **Track variety**: A7 visual tune was done on the lagoon track at
  sunset palette. Should re-verify on big-bay (open-ocean horizon),
  oval-loop (closed circuit), and at midday / dawn / dusk palettes.
  No code changes expected — just visual sanity checks.

## Reference implementations

- Tessendorf 2001 — [Simulating Ocean Water](https://people.computing.clemson.edu/~jtessen/reports/papers_files/coursenotes2004.pdf) — foundational paper for the FFT-ocean approach.
- Ang et al. SIGGRAPH 2018 — [The Technical Art of Sea of Thieves](https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf) — canonical for the SoT-style techniques A7 implements (peak-mask SSS, three-color albedo, artist-textured foam).
- Horvath 2015 — [Empirical Directional Wave Spectra for Computer Graphics](https://dl.acm.org/doi/10.1145/2791261.2791267) — Mitsuyasu / Hasselmann directional spread, TMA spectrum, multi-cascade architecture. Single most cited modern source.
- [Ocean Rendering Part 1 — Robert Ryan, 2025](https://rtryan98.github.io/2025/10/04/ocean-rendering-part-1.html) — modern practitioner walkthrough; 4-cascade TMA+Donelan-Banner setup.
- [GodotOceanWaves — 2Retr0](https://github.com/2Retr0/GodotOceanWaves) — open-source TMA+Hasselmann reference. Limits cascades to 4.
- [EncinoWaves — Christopher Horvath](https://github.com/blackencino/EncinoWaves) — reference implementation of Horvath's paper.
- [GDC 2019 — Wakes, Explosions and Lighting](https://gdcvault.com/play/1025819/Advanced-Graphics-Techniques-Tutorial-Wakes) — Atlas / WaveWorks 2.0 cascade architecture + GPU foam.
- [Karis 2013 — area specular](https://blog.selfshadow.com/publications/s2013-shading-course/karis/s2013_pbs_epic_notes_v2.pdf) — cited by SoT for the sun-highlight envelope on water. We don't implement this yet; would tighten the specular at low sun elevation.
- [jbouny/fft-ocean](https://github.com/jbouny/fft-ocean) — WebGL2 RTT-based; the closest open-source reference for the radix-2 FFT pipeline (A9 deferred work).
- [tessarakkt/godot4-oceanfft](https://github.com/tessarakkt/godot4-oceanfft) — best reference for the dual-side CPU buoyancy + GPU IFFT pattern
- [Barth Cave — Ocean Simulation with FFT and WebGPU](https://barthpaleologue.github.io/Blog/posts/ocean-simulation-webgpu/)
