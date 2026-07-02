/**
 * Track-GLB material dedupe (tools/optimize-track-glb-materials.mjs) — the
 * content-side half of the scenery-warm collapse. Covers:
 *
 *  - GLB container round-trip (chunk alignment, JSON + BIN recovery).
 *  - Family merge: materials identical up to baseColorFactor.rgb (and
 *    runtime-ignored metallic/roughness/KHR specular) collapse onto ONE white
 *    canonical stamped with the `vinylTintAttribute` extras marker, and every
 *    rewritten primitive gains a `_VINYLTINT` float VEC3 accessor carrying its
 *    original material's linear rgb.
 *  - Split rules: doubleSided / emissive / alpha differences keep materials
 *    apart; primitives on non-decoration nodes are never rewritten (and keep
 *    their original material alive through the prune).
 *  - Untouched geometry bytes: the original BIN chunk is byte-identical as a
 *    prefix of the output BIN.
 *  - Idempotency: a second run over the output changes nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  buildGlb,
  dedupeTrackGlbMaterials,
  estimateWarmGroups,
  type GltfJson,
  parseGlb,
  TINT_ATTRIBUTE,
  TINT_EXTRA_KEY,
  validateGlb,
} from '../../tools/optimize-track-glb-materials.mjs'

/** 3 verts × vec3 float — one shared POSITION accessor for every prim. */
function fixture(): { json: GltfJson; bin: Buffer } {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const bin = Buffer.from(positions.buffer.slice(0))
  const mat = (name: string, rgb: [number, number, number], extra?: Record<string, unknown>) => ({
    name,
    doubleSided: true,
    pbrMetallicRoughness: { baseColorFactor: [...rgb, 1] },
    ...extra,
  })
  const json: GltfJson = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length, target: 34962 }],
    accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    materials: [
      // 0/1: same family — metallic/roughness/specular spreads are runtime-ignored.
      mat('mat_a_red', [0.8, 0.1, 0.2], {
        pbrMetallicRoughness: {
          baseColorFactor: [0.8, 0.1, 0.2, 1],
          metallicFactor: 0,
          roughnessFactor: 0.6,
        },
        extensions: { KHR_materials_specular: { specularFactor: 0.3 } },
      }),
      mat('mat_b_blue', [0.1, 0.2, 0.8], {
        pbrMetallicRoughness: {
          baseColorFactor: [0.1, 0.2, 0.8, 1],
          metallicFactor: 0.35,
          roughnessFactor: 0.45,
        },
      }),
      // 2: single-sided → different family (stays untouched as a singleton).
      { name: 'mat_c_green', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.8, 0.2, 1] } },
      // 3: emissive → different family.
      mat('mat_d_lamp', [0.8, 0.1, 0.2], { emissiveFactor: [1, 0.5, 0] }),
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
      { primitives: [{ attributes: { POSITION: 0 }, material: 1 }] },
      { primitives: [{ attributes: { POSITION: 0 }, material: 2 }] },
      { primitives: [{ attributes: { POSITION: 0 }, material: 3 }] },
      // Same material as mesh 0, on a `kind=track` landmark hull — track IS in
      // the allowlist (hulls take the runtime vinyl look), so it merges too.
      { primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
      // Same material as mesh 1, on a `kind=water` node — never rewritten,
      // which also keeps mat_b referenced through the prune.
      { primitives: [{ attributes: { POSITION: 0 }, material: 1 }] },
    ],
    nodes: [
      { name: 'LMd_x_wall', mesh: 0, extras: { kind: 'decoration' } },
      { name: 'LMd_x_roof', mesh: 1, extras: { kind: 'decoration' } },
      { name: 'LMd_y_door', mesh: 2, extras: { kind: 'decoration' } },
      { name: 'LMd_y_lamp', mesh: 3, extras: { kind: 'decoration' } },
      { name: 'LM_hull', mesh: 4, extras: { kind: 'track' } },
      { name: 'HV_water', mesh: 5, extras: { kind: 'water' } },
    ],
    scenes: [{ nodes: [0, 1, 2, 3, 4, 5] }],
  }
  return { json, bin }
}

describe('GLB container', () => {
  it('round-trips JSON + BIN through buildGlb/parseGlb with 4-byte alignment', () => {
    const { json, bin } = fixture()
    const glb = buildGlb(json, bin)
    expect(glb.length % 4).toBe(0)
    const back = parseGlb(glb)
    expect(back.json).toEqual(json)
    expect(back.bin).not.toBeNull()
    expect(Buffer.compare((back.bin ?? Buffer.alloc(0)).subarray(0, bin.length), bin)).toBe(0)
  })
})

describe('dedupeTrackGlbMaterials', () => {
  it('merges the baseColor-only family onto one white marked canonical', () => {
    const { json, bin } = fixture()
    const { json: out, bin: outBin, report } = dedupeTrackGlbMaterials(json, bin)

    expect(report.families).toHaveLength(1)
    expect(report.primsTinted).toBe(3) // 2 decoration + 1 track hull
    // mat_a pruned (decoration + hull both remapped); mat_b survives via the
    // water prim, which is outside the kind allowlist.
    const names = (out.materials ?? []).map((m) => m.name)
    expect(names).not.toContain('mat_a_red')
    expect(names).toContain('mat_b_blue')
    expect(names).toContain('mat_c_green')
    expect(names).toContain('mat_d_lamp')
    const canon = (out.materials ?? []).find((m) => m.name === 'mat_deco_tint_0')
    expect(canon).toBeDefined()
    expect(canon?.extras?.[TINT_EXTRA_KEY]).toBe(TINT_ATTRIBUTE)
    expect((canon?.pbrMetallicRoughness as { baseColorFactor: number[] }).baseColorFactor).toEqual([
      1, 1, 1, 1,
    ])
    // Coalesced runtime-ignored spreads are reported, not silent.
    expect(report.warnings.join('\n')).toMatch(/metallicFactor/)
    expect(report.warnings.join('\n')).toMatch(/roughnessFactor/)

    // Both decoration prims now point at the canonical and carry the tint attr
    // with their ORIGINAL colours.
    const canonIdx = (out.materials ?? []).findIndex((m) => m.name === 'mat_deco_tint_0')
    const readTint = (meshIdx: number): number[] => {
      const prim = out.meshes?.[meshIdx]?.primitives?.[0]
      expect(prim?.material).toBe(canonIdx)
      const acc = out.accessors?.[prim?.attributes?.[TINT_ATTRIBUTE] ?? -1]
      expect(acc?.type).toBe('VEC3')
      expect(acc?.componentType).toBe(5126)
      expect(acc?.count).toBe(3)
      const bv = out.bufferViews?.[acc?.bufferView ?? -1]
      const base = (bv?.byteOffset ?? 0) + (acc?.byteOffset ?? 0)
      return [...new Float32Array(outBin.buffer, outBin.byteOffset + base, 9)].slice(0, 3)
    }
    expect(readTint(0).map((x) => +x.toFixed(4))).toEqual([0.8, 0.1, 0.2])
    expect(readTint(1).map((x) => +x.toFixed(4))).toEqual([0.1, 0.2, 0.8])
    // The track hull merges like decoration, keeping mat_a's colour.
    expect(readTint(4).map((x) => +x.toFixed(4))).toEqual([0.8, 0.1, 0.2])

    // Water prim untouched; singleton families untouched (no tint attr).
    const waterPrim = out.meshes?.[5]?.primitives?.[0]
    expect(out.materials?.[waterPrim?.material ?? -1]?.name).toBe('mat_b_blue')
    expect(waterPrim?.attributes?.[TINT_ATTRIBUTE]).toBeUndefined()
    expect(out.meshes?.[2]?.primitives?.[0]?.attributes?.[TINT_ATTRIBUTE]).toBeUndefined()

    // Original geometry bytes are a byte-identical prefix of the output BIN.
    expect(Buffer.compare(outBin.subarray(0, bin.length), bin)).toBe(0)

    // Serialized output passes structural validation.
    validateGlb(buildGlb(out, outBin))
  })

  it('collapses the estimated decoration warm-groups', () => {
    const { json, bin } = fixture()
    const before = estimateWarmGroups(json)
    const { json: out } = dedupeTrackGlbMaterials(json, bin)
    const after = estimateWarmGroups(out)
    expect(before).toBe(4) // a, b, c, d each their own group (water excluded)
    expect(after).toBe(3) // {a,b} merged; c, d stay
  })

  it('is idempotent — a second run over its own output is a no-op', () => {
    const { json, bin } = fixture()
    const first = dedupeTrackGlbMaterials(json, bin)
    const second = dedupeTrackGlbMaterials(first.json, first.bin)
    expect(second.report.primsTinted).toBe(0)
    expect(second.report.families).toHaveLength(0)
    expect(second.json).toEqual(first.json)
    expect(second.bin.length).toBe(first.bin.length)
  })

  it('never rewrites a mesh shared with a non-allowlisted kind', () => {
    const { json, bin } = fixture()
    // Point a water-kind node at decoration mesh 0 AND at hull mesh 4 — both
    // meshes are now shared with an untouchable kind, so mat_a's prims all
    // drop out and only mesh 1 (mat_b) remains: no ≥2 family, nothing merges.
    json.nodes?.push({ name: 'shared_a', mesh: 0, extras: { kind: 'water' } })
    json.nodes?.push({ name: 'shared_b', mesh: 4, extras: { kind: 'water' } })
    const { json: out, report } = dedupeTrackGlbMaterials(json, bin)
    expect(report.primsTinted).toBe(0)
    expect(out.meshes?.[0]?.primitives?.[0]?.attributes?.[TINT_ATTRIBUTE]).toBeUndefined()
    expect(out.materials?.map((m) => m.name)).toContain('mat_a_red')
    expect(out.materials?.map((m) => m.name)).toContain('mat_b_blue')
  })
})
