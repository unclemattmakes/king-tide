# Hand-off — finish A9 (real radix-2 FFT in TSL)

## What you're picking up

PR [hoverbike#101](https://github.com/occ-matt/hoverbike/pull/101) on
branch `claude/amazing-morse-be8cc4` lands A8 (foam feedback + advection
+ persistence slider), closes out A5 (wind direction + cutoff sliders),
and sketches A9 (real radix-2 FFT). All landed via Chrome MCP visual
A/B except for one open bug:

**`?water=fft&waves=fft&fftbake=fft` produces visibly lower-amplitude
waves than `&fftbake=ddft` at the same Phillips parameters. The two
paths should be visually identical.**

The pipeline runs cleanly (no console errors, no WebGPU validation
warnings, 257/257 unit tests pass). The math walked through in code
comments is consistent. So the bug is one of: a missing scale factor,
a sign/index mistake in the bit-reverse or butterfly kernels, or
something subtle in how TSL emits the kernel.

## First 10 minutes — orient

```sh
git fetch && git checkout claude/amazing-morse-be8cc4
pnpm install && pnpm dev
```

Open two tabs and ctrl/cmd-click between them:

- `http://localhost:5193/?race=1&track=lagoon&bike=racer&water=fft&waves=fft&fftbake=ddft` — the working direct-DFT path.
- `http://localhost:5193/?race=1&track=lagoon&bike=racer&water=fft&waves=fft&fftbake=fft` — the FFT path, currently buggy.

The FFT path's waves should look identical to the direct DFT path's. They don't — the FFT side reads as lower amplitude.

Read these in order:

1. The header comment of `src/engine/render/ocean-fft/gpu-bake-fft.ts` — names the three candidate root causes in priority order.
2. The math walkthrough in the same file just above `createGpuOceanFftDisplacement`.
3. `src/engine/render/ocean-fft/fft-tsl.ts` — the standalone FFT primitive.
4. `src/engine/sim/water/fft2d-cpu.ts` — the CPU reference oracle (`fft2d(buf, N, -1)`).

## The surest debug path

Texture readback. Write a known complex input into the FFT primitive's `inputTexture`, dispatch the FFT, copy the output texture to a buffer, read it back to CPU, and compare element-by-element to `fft2d-cpu.ts`'s `fft2d(buf, N, -1)` on the same input.

Three.js's `WebGPURenderer` exposes `copyTextureToTexture` for storage-texture copies. For readback to CPU, the typical pattern is:

```js
// Pseudo — verify in three.js source first:
const buffer = renderer.createBuffer({ size, usage: COPY_DST | MAP_READ })
renderer.copyTextureToBuffer(outputTexture, buffer, ...)
await buffer.mapAsync(GPUMapMode.READ)
const data = new Float32Array(buffer.getMappedRange()).slice()
buffer.unmap()
```

If three.js doesn't expose this directly, drop down to the underlying `GPUDevice` via `renderer.getContext().device`.

Test inputs that make bugs obvious:

- **Delta function** at one specific frequency `(kx, ky)` — IFFT output should be a pure complex exponential `e^{+i 2π (kx·x + ky·y) / N}`. Real-part is `cos(2π·...)` — a clean grid of sinusoids.
- **Constant DC** (`F[0,0]=1`, everything else 0) — IFFT output should be `1` everywhere.
- **Random small input** (~256 values) — compare to CPU oracle for arbitrary patterns; this catches subtle bit-reverse or butterfly indexing bugs.

If GPU vs CPU agree on these → the primitive is sound, the bug is in `gpu-bake-fft.ts`'s spectrum-build or unpack kernel.
If GPU vs CPU disagree → bug is in the primitive (`fft-tsl.ts`).

## Candidate root causes (file header priority order)

### (a) Phillips spectrum scaling between N=32 (direct DFT default) and N=64 (FFT minimum)

The FFT primitive requires `log₂N` even, so it can't run at the direct DFT's default N=32. `water.ts` bumps N→64 in the FFT branch. The `amplitude` Phillips parameter is the same for both, but more modes are sampled at N=64.

My analysis: each mode's |h0| should be the same at N=32 and N=64 (Phillips P(k) is continuous, sampled at the same grid spacing dk = 2π/tileSize). The TOTAL variance scales by N² (more modes), so RMS heightfield ~ N · |h0|_rms → should be 2× larger at N=64 than N=32.

But empirically the FFT (N=64) is SMALLER, not 2× larger. Investigate:

1. Does `buildPhillipsSpectrum` apply any N-dependent normalization internally? Read `src/engine/sim/water/phillips.ts`.
2. Sanity check by computing `Σ |h0|²` on CPU for N=32 vs N=64 with same `amplitude`. Should scale ~4×.
3. If the spectra scale correctly per-mode but the heights don't, the bug is downstream of `buildPhillipsSpectrum`.

### (b) Sign or index mistake in ifftshift / centered-wavenumber computation

The spectrum-build kernel does an ifftshift when reading h0: at FFT natural index `(px, py)` it reads h0 at centered index `((px + N/2) mod N, (py + N/2) mod N)`. The signed wavenumber used in the modulation is computed via `select(px < N/2, px, px - N)`.

Math is in the file header — works on paper. But verify in code:

- Print `(px, kxic)` for a few values and check by hand.
- Try replacing the `select` with the arithmetic form `kxic = ((px + N/2) mod N) - N/2`. Avoids any TSL `select`-typing quirks.
- Try removing the ifftshift entirely (read h0 at `(px, py)` directly) and see if output changes — would reveal whether shift is doing what you expect.

### (c) Stage-uniform race or kernel-share issue

12 butterfly dispatches per axis share the same compiled kernel and the same `stageUniform`. Between dispatches I write `stageUniform.value = s` and submit. WebGPU's queue ordering should give each dispatch the right value (writeBuffer commands and dispatch commands serialize in queue order). I verified this against three.js source — `_renderCompute` calls `bindings.updateForCompute` (which queues a writeBuffer) immediately before `backend.compute` (which encodes the dispatch). Should be correct.

But if everything else checks out, this is worth ruling out by baking the stage as a compile-time constant. Generate `log₂N × 2 (axis) × 2 (ping-pong) = 24` butterfly kernels per FFT2D handle, each with the stage hardcoded via `float(stageConstant)`. The startup compile cost is high (~200 kernels for the full 8-FFT pipeline) but it eliminates the shared-uniform concern.

## After the bug is found

1. **Visually verify parity**: `&fftbake=fft` vs `&fftbake=ddft` should look identical on lagoon. Compare via Chrome MCP at the same race time / camera position.
2. **Verify on other tracks** (big-bay, oval, dune-rally) and times of day. A7's visual tune was lagoon-at-sunset only.
3. **Performance check**: A9 should be fast enough at N=64 to stay at 60 fps. Current dispatch count is 8 × 15 + 2 = 122 per FFT cascade per frame. At 1 FFT cascade (cascade 0), that's 122 dispatches × ~10 μs = ~1.2 ms of overhead. Acceptable; matches what the foundation commit's smoke test saw at full fps.
4. **Flip the remaining two cascades to FFT path** — chop (tileSize=22) and long-swell (tileSize=250) cascades in `water.ts` currently stay on direct DFT. Once cascade-0 is verified, change all three to the FFT factory.
5. **Bump N to 128** (the actual win — sub-meter wave detail without the normal-map detail cascade). The FFT primitive's `log₂N` parity check is the only blocker for N=128 (log₂=7 odd); extend `dispatch()` to handle odd parity (~20-line change: add a bit-reverse col variant that reads from pong, write that scaffolding once).

## Batched FFT (perf optimization; do AFTER parity)

`createFft2d` processes only R+G channels per texel. Extending it to also process B+A in parallel halves the dispatch count for the FFT-ocean workload (we have 8 spectra → 4 batched FFTs instead of 8 unbatched).

Mechanically: every `partnerSample.r/.g` access in the butterfly + bit-reverse + scale kernels gets a sibling `partnerSample.b/.a` access doing the same operation. Add a `batched: boolean` option to `createFft2d`. Then `createGpuOceanFftDisplacement` packs pairs of spectra into the same input texture (height + Dx into texture 0 R+G and B+A; Dz + dydx into texture 1; etc.) and reads them back together in the unpack kernel.

Cost is roughly +30 LOC per kernel, halves the dispatch count. Do once parity is in.

## Files touched in this PR

- `src/engine/render/ocean-fft/foam-feedback.ts` (new in A8)
- `src/engine/render/ocean-fft/fft-tsl.ts` (new in A9 foundation)
- `src/engine/render/ocean-fft/gpu-bake-fft.ts` (new in A9 integration — has the open bug)
- `src/engine/render/ocean-fft/gpu-bake.ts` (added `N` to `GpuOceanDisplacementHandle`)
- `src/engine/render/water.ts` (wiring for A8, A8 follow-ups, sliders, A9 smoke test, A9 integration)
- `src/engine/water-debug-menu.ts` (new sliders)
- `src/engine/water-debug-storage.ts` (v3 → v5 schema bumps)
- `docs/fft-ocean-plan.md` (status table updates + A8/A9 walkthroughs)

## URL-flag glossary (already wired)

| Flag | Effect |
|---|---|
| `?water=fft&waves=fft` | Full SoT-style FFT path with A8 foam feedback (default behavior when both flags set) |
| `?foamfb=0` | Disables A8 persistent foam — A/B against pre-A8 stateless foam |
| `?fftverify=1` | A9 smoke test: dispatches the standalone FFT primitive once per frame; output unused |
| `?fftbake=fft` | A9 integration: routes the wind-sea cascade through `createGpuOceanFftDisplacement` instead of `createGpuOceanDisplacement`. **The currently-buggy path.** |
| `?fftbake=ddft` (default) | Direct DFT (the existing working path) |

## Constraints to keep in mind

- **CPU buoyancy stays on top-K analytic of cascade 0 at N=32.** Don't change the field's spectrum without updating the CPU sampler in lockstep (use `applySpectrumParams` in `water.ts`).
- **`?water=v2` must keep working** — that's the shipping default. A6 (retire v2) only after burn-in.
- **Visual A/B is the verifier.** Type-check + tests pass for buggy code too. Use Chrome MCP.

Good luck.
