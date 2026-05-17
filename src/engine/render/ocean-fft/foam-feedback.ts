import * as THREE from 'three'
import {
  Fn,
  float,
  instanceIndex,
  max,
  min,
  mix,
  smoothstep,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec4,
} from 'three/tsl'
import { StorageTexture } from 'three/webgpu'
import type { GpuOceanDisplacementHandle } from '@/engine/render/ocean-fft/gpu-bake'

/**
 * A8 — Foam feedback buffer.
 *
 * Per the Sea of Thieves / Horvath research, the single biggest gap
 * between amateur and pro FFT-ocean implementations is foam persistence.
 * Real ocean foam is generated when a wave breaks (J<0 in the
 * Jacobian sense), then LINGERS on the surface for ~1 second, slowly
 * fading. Our prior implementation was stateless: foldFoamFft fired
 * whenever the current-frame Jacobian dropped below 0.5, and vanished
 * the moment the breaking crest moved on.
 *
 * This module maintains a persistent foam intensity buffer in world
 * space, advanced by one TSL compute kernel per frame:
 *
 *   foam_{t+1}(x, z) = max(foam_t(x, z) · decay,  instantFoam(x, z))
 *
 *   instantFoam(x, z) = smoothstep(jHigh, jLow, min(J_cascade_i(x, z)))
 *
 * Reading the previous frame's foam from the SAME storage texture
 * we'll write to next is well-defined per-texel because each thread
 * only ever touches its own texel — there's no cross-texel race. WGSL
 * allows this via `texture_storage_2d<r32float, read_write>`; we use
 * `r32float` precisely because that's the storage-texture format
 * guaranteed to support read_write access on all conformant WebGPU
 * backends.
 *
 * The output texture is world-anchored (NOT camera-anchored) with
 * REPEAT wrap, covering a 200m × 200m tile. Foam stays in WORLD
 * positions as the camera moves, which is the physically correct
 * behavior; the cost is that a wave breaking 200m offshore writes its
 * foam into the same tile slot as one breaking at the bike. With
 * REPEAT wrap that's invisible past the cascade-tile distance where
 * the cascades themselves already cycle.
 *
 * Wave-phase advection (foam should drift with the wave's group
 * velocity, not stay put) is NOT implemented — for v0 we let the
 * multi-cascade Jacobian fan-out + the foam buffer's spatial blur
 * carry the spreading. The decay-driven temporal trail covers the
 * "foam lingers after the breaker passes" feel.
 */

export type FoamFeedbackOpts = {
  /** Cascade displacement handles. The kernel reads each cascade's
   *  Jacobian (the .a channel of the displacement texture) at this
   *  texel's world position and takes the min — any cascade folding
   *  triggers foam. Must be non-empty. */
  cascades: GpuOceanDisplacementHandle[]
  /** World-space extent of one tile of the foam buffer (m). Default
   *  200 — large enough to cover the visible water mesh range with
   *  REPEAT tiling beyond that. */
  tileSize?: number
  /** Resolution per axis. Default 256 — at 200m tile, that's ~0.78m
   *  per texel which is finer than the typical wave-crest width. */
  N?: number
  /** Per-frame multiplicative decay applied to previous foam. 0.92
   *  ≈ 500ms half-life @60fps — long enough to read as "foam
   *  lingering after a wave breaks" but short enough that the buffer
   *  doesn't saturate when small per-texel triggers fire repeatedly.
   *  The decay/trigger pair is jointly tuned: too-slow decay + the
   *  legacy `smoothstep(0.5, 0.0, J)` near-breaking trigger lets
   *  steady-state foam pile up to 1 across most of the surface,
   *  collapsing the visual to "milky water." Use a narrower trigger
   *  AND faster decay than the legacy stateless version. Wired into
   *  the debug menu as the foam-persistence knob. */
  decay?: number
  /** Smoothstep window for J→foam conversion. Foam intensity ramps
   *  from 0 at J ≥ jacobianHigh up to 1 at J ≤ jacobianLow.
   *
   *  Defaults `(0.1, -0.3)` are tighter than the legacy stateless
   *  `(0.5, 0.0)` for a structural reason: in the feedback path the
   *  per-texel trigger is multiplied by 1/(1-decay) at steady state.
   *  A typical-amplitude wave field has many texels lingering at
   *  J ~ 0.3-0.4 (mild fold, not yet breaking) — the legacy trigger
   *  fires at ~0.2 instantaneous, which becomes ~1.0 steady-state and
   *  saturates the buffer. Narrowing the trigger to actually-folding
   *  texels (J near 0 or below) keeps the buffer selectively bright
   *  on real breaking crests instead of smearing across the whole
   *  surface. */
  jacobianHigh?: number
  jacobianLow?: number
}

export type FoamFeedbackHandle = {
  /** R32F storage texture holding the persistent foam intensity in
   *  world space. Sampled by the water fragment shader at
   *  `worldXZ / tileSize` (REPEAT wrap). .r is foam in [0, 1]. */
  foamTexture: THREE.Texture
  /** World-space extent of one full tile (m). Same as the
   *  `tileSize` option. */
  tileSize: number
  /** Dispatch the foam-update kernel for this frame. Call AFTER the
   *  cascade displacement kernels have ticked so the Jacobian
   *  textures are up-to-date for the current frame's wave state. */
  tick(renderer: THREE.WebGLRenderer): Promise<void>
  /** Live setter for the per-frame decay. Range [0, 1] — 0 = no
   *  persistence, 1 = foam never fades. The debug menu wires its
   *  foam-persistence slider here. */
  setDecay(v: number): void
  dispose(): void
}

const DEFAULTS = {
  tileSize: 200,
  N: 256,
  decay: 0.93,
  jacobianHigh: -0.2,
  jacobianLow: -0.8,
}

export function createFoamFeedback(opts: FoamFeedbackOpts): FoamFeedbackHandle {
  if (opts.cascades.length === 0) {
    throw new Error('createFoamFeedback: cascades must be non-empty')
  }
  const tileSize = opts.tileSize ?? DEFAULTS.tileSize
  const N = opts.N ?? DEFAULTS.N
  const decayInit = opts.decay ?? DEFAULTS.decay
  const jHi = opts.jacobianHigh ?? DEFAULTS.jacobianHigh
  const jLo = opts.jacobianLow ?? DEFAULTS.jacobianLow

  // Capture cascade tile sizes + grid Ns at construction. The kernel
  // doesn't take these as TSL inputs — they bake into the compiled
  // shader as constants.
  const cascades = opts.cascades.map((c) => ({
    tex: c.displacementTexture,
    tileSize: c.tileSize,
    N: c.N,
  }))

  // Single R32F read_write storage texture. Per WebGPU spec, r32float
  // is guaranteed to support read_write access on all conformant
  // backends — the only float texel format that does. .r holds foam
  // intensity in [0, 1]; .g/.b/.a are unused (texture storage stores
  // a full vec4 but only .r is sampled by the fragment shader).
  const foamTexture = new StorageTexture(N, N)
  foamTexture.name = 'water:foam-feedback'
  foamTexture.format = THREE.RedFormat
  foamTexture.type = THREE.FloatType
  foamTexture.magFilter = THREE.LinearFilter
  foamTexture.minFilter = THREE.LinearFilter
  foamTexture.wrapS = THREE.RepeatWrapping
  foamTexture.wrapT = THREE.RepeatWrapping
  foamTexture.generateMipmaps = false

  const decayUniform = uniform(decayInit)
  const jHighUniform = uniform(jHi)
  const jLowUniform = uniform(jLo)

  // Kernel: one thread per output texel. Reads previous-frame foam
  // from `foamTexture` itself (read_write storage), samples cascade
  // Jacobians at this texel's world position (integer textureLoad with
  // manual REPEAT wrap), and writes back the time-decayed max.
  const kernel = Fn(() => {
    const px = instanceIndex.mod(N)
    const py = instanceIndex.div(N)
    // World position of texel center. Foam buffer is anchored to
    // world origin: texel (px, py) sits at world XZ
    // ((px+0.5)/N · tileSize, (py+0.5)/N · tileSize). REPEAT wrap
    // tiles this across the whole world plane.
    const u = float(px).add(float(0.5)).div(float(N))
    const v = float(py).add(float(0.5)).div(float(N))
    const worldX = u.mul(float(tileSize))
    const worldZ = v.mul(float(tileSize))

    // Take the MIN Jacobian across cascades. Wherever any cascade is
    // folding (J<0), foam triggers — same semantics as the vertex
    // shader's `min(min(windDisp.a, chopDisp.a), longDisp.a)`.
    //
    // Bilinear-sample each cascade's Jacobian channel manually via 4
    // textureLoad taps + 2D lerp. We can't call `texture()` (the TSL
    // sampled-binding helper) in compute since it needs implicit
    // derivatives only fragments have, and `textureLoad` always
    // delivers nearest-neighbor. Without bilinear smoothing the foam
    // buffer reads RAW per-cascade-texel J extremes (N=32 → ~2-3m
    // per cascade texel of chop) and saturates instantly because
    // many cascade texels carry J ≈ 0.3-0.5 at typical amplitudes.
    // Bilinear averaging matches what the vertex-shader path does
    // when sampling via `texture(cascadeTex, uv)`.
    const jac = float(1).toVar()
    for (const c of cascades) {
      // World XZ → cascade UV → cascade-texel float coords.
      const cu = worldX.div(float(c.tileSize)).fract()
      const cv = worldZ.div(float(c.tileSize)).fract()
      // Texel center alignment: shift by -0.5 so integer + fract
      // corresponds to the box surrounding a sub-texel sample point
      // — matches GPU bilinear conventions. Wrap via mod(N) for
      // REPEAT semantics.
      const txF = cu.mul(float(c.N)).sub(float(0.5))
      const tyF = cv.mul(float(c.N)).sub(float(0.5))
      const tx0 = txF.floor()
      const ty0 = tyF.floor()
      const fu = txF.sub(tx0)
      const fv = tyF.sub(ty0)
      // Wrap to [0, N-1] via mod, accounting for negative tx0
      // (when txF was in [-0.5, 0)). Adding N before mod keeps it
      // positive.
      const tx0w = tx0.add(float(c.N)).mod(float(c.N))
      const ty0w = ty0.add(float(c.N)).mod(float(c.N))
      const tx1w = tx0.add(float(c.N + 1)).mod(float(c.N))
      const ty1w = ty0.add(float(c.N + 1)).mod(float(c.N))
      const ix0 = uint(tx0w)
      const iy0 = uint(ty0w)
      const ix1 = uint(tx1w)
      const iy1 = uint(ty1w)
      // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
      const s00 = textureLoad(c.tex, uvec2(ix0, iy0), 0) as any
      // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
      const s10 = textureLoad(c.tex, uvec2(ix1, iy0), 0) as any
      // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
      const s01 = textureLoad(c.tex, uvec2(ix0, iy1), 0) as any
      // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
      const s11 = textureLoad(c.tex, uvec2(ix1, iy1), 0) as any
      const j0 = mix(s00.a, s10.a, fu)
      const j1 = mix(s01.a, s11.a, fu)
      const jBilinear = mix(j0, j1, fv)
      jac.assign(min(jac, jBilinear))
    }
    // smoothstep(jHigh, jLow, J): saturating ramp. J ≥ jHigh → 0,
    // J ≤ jLow → 1. Note that TSL/three.js evaluates smoothstep in
    // reversed-edge mode when edge0 > edge1 (legacy code in
    // water.ts:foldFoamFft already relies on this), so the kernel
    // passes (jHigh, jLow, J) directly.
    //
    // The trigger is multiplied by `instantScale` before feeding the
    // max-feedback rule. Why scale: with `newFoam = max(prev·decay,
    // instantFoam)` the steady-state in a region where instantFoam
    // fires constantly converges to `instantFoam` itself. Capping the
    // per-frame contribution at ~0.5 means even constantly-folding
    // regions don't saturate the buffer to 1.0 (the SoT visual is
    // "scattered bright breaking foam," not "milky water"). The
    // buffer still reaches ~1.0 transiently when a rare strong fold
    // pulses through, but settles back to `instantScale` afterward.
    // Per-frame instant foam: smoothstep gives 1 only at actually-
    // folding cascade texels (J ≤ jLow). The feedback's
    // `max(prev·decay, instantFoam)` rule means foam intensity
    // converges to `instantFoam` itself in regions where the trigger
    // fires constantly, so we want this signal to be NEAR ZERO at
    // typical wave faces (only catching genuine breakers). With
    // (jHigh, jLow) = (0.0, -0.4), texels with J in [0, 1] return
    // 0 — only crests that pinch hard enough to make J negative
    // contribute.
    const instantFoam = smoothstep(jHighUniform, jLowUniform, jac).clamp(0, 1)

    // Self-read: previous frame's foam at this exact texel.
    // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
    const prevSample = textureLoad(foamTexture, uvec2(px, py), 0) as any
    const prev = prevSample.r
    // Feedback: max(decayed prev, new instant). Stateful temporal
    // trail — foam persists as the wave moves on.
    const next = max(prev.mul(decayUniform), instantFoam).clamp(0, 1)

    textureStore(foamTexture, uvec2(px, py), vec4(next, float(0), float(0), float(0))).toReadWrite()
  })

  // biome-ignore lint/suspicious/noExplicitAny: TSL Fn invocation typing
  const computeNode = (kernel as any)().compute(N * N)

  function tick(renderer: THREE.WebGLRenderer): Promise<void> {
    // biome-ignore lint/suspicious/noExplicitAny: WebGPURenderer cast
    const r = renderer as any
    if (typeof r.computeAsync === 'function') {
      return r.computeAsync(computeNode) as Promise<void>
    }
    return Promise.resolve()
  }

  function setDecay(v: number): void {
    decayUniform.value = Math.max(0, Math.min(1, v))
  }

  function dispose(): void {
    foamTexture.dispose()
  }

  return {
    foamTexture,
    tileSize,
    tick,
    setDecay,
    dispose,
  }
}
