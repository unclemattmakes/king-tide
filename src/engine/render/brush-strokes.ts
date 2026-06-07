/**
 * Shared painterly brush-stroke sampler — the one art-tuned brushwork field,
 * sampled by every surface that wants the impasto read.
 *
 * The sheet (`public/assets/textures/brush_strokes.png`, authored by
 * `tools/blender/build_brush_texture.py`) packs THREE stroke SCALES into its
 * R/G/B channels (coarse / medium / fine). A caller blends the channels by the
 * characteristic size of what it's painting — big props/cliffs lean coarse,
 * small props lean fine — and samples it TRIPLANAR so the strokes read on every
 * face, not just up-facing ones.
 *
 * Factored out of `painterly-vinyl-material.ts` so the vinyl prop/building
 * material and the terrain shader share ONE implementation (mirrors the
 * `waterline.ts` extraction). It's DATA, not albedo — NoColorSpace +
 * RepeatWrapping — so it tiles seamlessly under world/object-space sampling.
 * WebGPU/TSL only. See docs/painterly-vinyl-pipeline.md.
 */
import * as THREE from 'three'
import type Node from 'three/src/nodes/core/Node.js'
import { abs, float, normalize, texture, vec2, vec3 } from 'three/tsl'
import { assetUrl } from '../asset-url'

/** Brush-texture tile size as a fraction of the caller's world scale — sets how
 *  big the sheet's strokes read. Lower = bigger, bolder strokes (fewer repeats);
 *  higher = finer speckle. Tuned with the sparse, high-contrast real-oil sheet so
 *  strokes read as deliberate brushwork at race distance rather than tiny streaks. */
export const BRUSH_TEX_TILE = 0.06

/** The shared brush-stroke sheet, loaded once and sampled by every brush field. */
let sharedBrushTex: THREE.Texture | null = null
export function sharedBrushTexture(): THREE.Texture {
  if (sharedBrushTex) return sharedBrushTex
  try {
    const tex = new THREE.TextureLoader().load(assetUrl('/assets/textures/brush_strokes.png'))
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.colorSpace = THREE.NoColorSpace
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    sharedBrushTex = tex
  } catch {
    // No DOM image support (headless tests / SSR) — fall back to a neutral 1×1
    // mid-grey so material construction never throws; brush streaks read as a
    // no-op (0.5) until a real image-capable context loads the sheet.
    const grey = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1)
    grey.needsUpdate = true
    sharedBrushTex = grey
  }
  return sharedBrushTex
}

/** Normalize a 3-weight mix to sum 1 (falls back to all-medium if degenerate). */
export function normalizeMix(m: [number, number, number]): [number, number, number] {
  const s = m[0] + m[1] + m[2]
  return s > 1e-6 ? [m[0] / s, m[1] / s, m[2] / s] : [0, 1, 0]
}

/** Blend weights for the brush sheet's three packed stroke scales
 *  (R = coarse / G = medium / B = fine) as a function of the painted feature's
 *  size in metres: big features lean to coarse sweeping strokes, small features
 *  to fine dabs. Gaussian kernels in log2(size) centred at 16 m / 4 m / 1 m,
 *  ALWAYS normalized to sum 1 — so the combined height field stays centred on
 *  0.5 and a brush amount of 0 stays a true no-op. A grayscale sheet (R=G=B)
 *  collapses the blend to its old single-field behaviour for free. */
export function brushScaleWeights(featureSize: number): [number, number, number] {
  const lp = Math.log2(Math.min(Math.max(featureSize, 0.25), 64))
  const k = (centre: number) => Math.exp(-(((lp - centre) / 1.4) ** 2))
  return normalizeMix([k(4), k(2), k(0)]) // coarse(16 m) / medium(4 m) / fine(1 m)
}

/**
 * Triplanar brush-stroke height field (~0..1, centred on ~0.5) at a world
 * position. Samples the shared sheet on the three world planes, blends them by
 * the world normal so strokes read on every face, and combines the sheet's
 * three packed stroke SCALES (R/G/B) by `scaleWeights`. One texel fetch per
 * plane.
 *
 * `worldScale` is the stroke frequency in 1/metres (i.e. 1 / stroke-size-metres);
 * the caller picks it so strokes track the size of what's being painted. The
 * returned node is reusable — feed it to both an albedo modulation and the
 * roughness/normal relief so the strokes and their impasto agree.
 */
export function brushHeightTriplanar(
  posWorld: Node<'vec3'>,
  normWorld: Node<'vec3'>,
  worldScale: number,
  scaleWeights: [number, number, number],
): Node<'float'> {
  const nrm = normalize(normWorld)
  const an = vec3(abs(nrm.x), abs(nrm.y), abs(nrm.z))
  const wsum = an.x.add(an.y).add(an.z).add(float(1e-4))
  const tex = sharedBrushTexture()
  const [wCoarse, wMed, wFine] = scaleWeights
  const freq = float(worldScale).mul(float(BRUSH_TEX_TILE))
  const sample = (p: Node<'vec2'>) => {
    const t = texture(tex, p.mul(freq))
    return t.r
      .mul(float(wCoarse))
      .add(t.g.mul(float(wMed)))
      .add(t.b.mul(float(wFine)))
  }
  return sample(vec2(posWorld.z, posWorld.y))
    .mul(an.x)
    .add(sample(vec2(posWorld.x, posWorld.z)).mul(an.y))
    .add(sample(vec2(posWorld.x, posWorld.y)).mul(an.z))
    .div(wsum)
}
