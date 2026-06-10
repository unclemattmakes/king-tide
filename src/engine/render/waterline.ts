/**
 * Shared world-space-height waterline treatment (the art-direction.md "waterline
 * rule"), driven by `worldY - waterLevel`. Two bands:
 *
 *   - ALGAE: a submerged green TINT below the line — the base albedo multiplied
 *     toward an algae tone, so the prop's own colour + detail still read through
 *     (a tint, not a flat override). Held full-strength right up until the salt
 *     line covers above it, so the algae fades directly INTO the salt with no
 *     dark base rock showing between them (that seam was the "thin dark line" bug).
 *   - SALT line: a bright wet/bleach band at and just above the surface, fading
 *     to dry rock by `tideHeight`.
 *
 * `strength = 0` is a byte-identical no-op. WebGPU/TSL only — composes into any
 * `*NodeMaterial.colorNode`. Shared so terrain and the painterly-vinyl prop
 * material read identical wherever a surface crosses the sea, no per-prop baking
 * (see docs/painterly-vinyl-pipeline.md).
 */
import type Node from 'three/src/nodes/core/Node.js'
import { float, max, mix, positionWorld, smoothstep, vec3 } from 'three/tsl'

export type WaterlinePalette = {
  /** Submerged algae coloration (below the line). */
  under?: [number, number, number]
  /** Salt / wet bleach line (at + just above the line). */
  salt?: [number, number, number]
}

const DEFAULT_UNDER: [number, number, number] = [0.22, 0.45, 0.42]
const DEFAULT_SALT: [number, number, number] = [0.88, 0.88, 0.82]

/**
 * Compose the waterline over `base`.
 *
 * @param base       linear RGB colour node to treat
 * @param waterLevel real sea surface height (world Y)
 * @param strength   overall strength (0 = no-op)
 * @param tideHeight how far ABOVE the line the salt band reaches (m)
 * @param algae      submerged tint depth 0..1 (0 = none, 1 = full algae tone)
 * @param bandScale  multiplies every band height; <1 shrinks the whole waterline
 *                   for small props so it stays a thin line, not a slab. A
 *                   number bakes the thresholds as constants; a float NODE
 *                   (the size-shared vinyl material's per-object read) does
 *                   the same scaling in-shader so one material instance can
 *                   serve meshes of every size
 * @param palette    optional colour overrides
 */
export function applyWaterlineBands(
  base: Node<'vec3'>,
  waterLevel: number,
  strength: number,
  tideHeight = 0.4,
  algae = 0.5,
  bandScale: number | Node<'float'> = 1,
  palette: WaterlinePalette = {},
): Node<'vec3'> {
  const yRel = positionWorld.y.sub(float(waterLevel))
  const wlStr = float(strength)
  // Every metre threshold below scales with bandScale, so the whole band shrinks
  // proportionally on small props (1 = full physical height on big props).
  //
  // ALGAE: fully solid for everything below ~the salt line (yRel < 0.08·bs), THEN
  // fades out. Holding it solid until the salt is opaque above means the
  // algae->salt transition is always fully covered — no dark base seam.
  // SALT line: rises to full at ~0.08·bs (just above the surface), holds as the
  // bright tide line, then fades to dry rock by `tideHeight`·bs.
  let algaeMask: Node<'float'>
  let saltMask: Node<'float'>
  if (typeof bandScale === 'number') {
    const bs = Math.max(bandScale, 0.05)
    const th = Math.max(tideHeight, 0.05) * bs
    algaeMask = smoothstep(float(0.2 * bs), float(0.08 * bs), yRel)
    saltMask = smoothstep(float(-0.1 * bs), float(0.08 * bs), yRel).mul(
      smoothstep(float(th), float(th * 0.45), yRel),
    )
  } else {
    const bs = max(bandScale, float(0.05))
    const th = bs.mul(float(Math.max(tideHeight, 0.05)))
    algaeMask = smoothstep(bs.mul(float(0.2)), bs.mul(float(0.08)), yRel)
    saltMask = smoothstep(bs.mul(float(-0.1)), bs.mul(float(0.08)), yRel).mul(
      smoothstep(th, th.mul(float(0.45)), yRel),
    )
  }

  const a = palette.under ?? DEFAULT_UNDER
  const s = palette.salt ?? DEFAULT_SALT

  // ALGAE is a multiplicative TINT, not a flat override: shade the base toward a
  // green-shifted copy of ITSELF so the prop's own albedo + detail still read
  // through. `algae` 0..1 dials tint depth — 0 = identity (white multiply),
  // 1 = full algae tone. A multiply can only darken / hue-shift, never replace;
  // that's exactly what keeps it a tint instead of the old paint-over.
  const algaeTint = mix(vec3(1, 1, 1), vec3(a[0], a[1], a[2]), float(algae))
  const algaeCol = base.mul(algaeTint)
  // SALT stays a bleach mix-toward — a salt crust genuinely sits ON the surface.
  const saltCol = mix(base, vec3(s[0], s[1], s[2]), float(0.7))

  const withAlgae = mix(base, algaeCol, algaeMask.mul(wlStr)) // tinted underwater
  return mix(withAlgae, saltCol, saltMask.mul(wlStr)) // salt line fades up into dry
}
