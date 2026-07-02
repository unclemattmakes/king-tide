#!/usr/bin/env node
// optimize-track-glb-materials.mjs — collapse a track OR prop GLB's
// near-duplicate flat-colour materials into per-vertex-tinted shared materials
// (the Mexico City content diet, part 2 — the boot-time half).
//
// Why: three's WebGPU pipeline cache keys per material INSTANCE, so the
// progressive scenery warm (src/boot/progressive-warm.ts) pays ~one pipeline
// compile (~180 ms on the dev box) per distinct vinyl material × vertex
// layout. A "model-everything" art pass authors dozens of flat-colour
// materials that the runtime look flattens anyway: the painterly-vinyl twin
// (src/engine/render/painterly-vinyl-material.ts) keeps ONLY
// map/normal/emissive/alpha/side/opacity + baseColor from the source material
// and forces its own matte metalness/roughness — so materials that differ
// solely in baseColorFactor (or in runtime-ignored knobs like
// metallic/roughness/KHR_materials_specular) compile identical-but-for-tint
// pipelines. Mexico City ships 39 such materials ≈ 39 warm groups ≈ 7 s of
// loading screen.
//
// Prop GLBs (tools/blender/build_prop.py output: a `kind=prop` root empty over
// an untagged visual mesh + `kind=collider` empties) get the same treatment —
// auto-detected per file (see detectGlbMode), with a prop-shaped eligibility
// mirror: their consumer is `createPropsMesh` (src/engine/render/props-mesh.ts),
// which vinyl-converts EVERY visual sub-mesh and honours the same
// `extras.vinylTintAttribute` marker, so the allowlist becomes "untagged (+
// decoration) nodes" and collider empties fall out naturally. Two prop lanes
// render the RAW GLB material and would show the canonical's white instead of
// the baked tint, so files headed for them are refused wholesale:
// wave-riders (`wave_rider_archetype` root extras → wave-rider-render) and
// animated props (GLB ships animation clips → animated-props). Skinned
// primitives are likewise never rewritten. A multi-material single-family prop
// (mxc/trajinera: 9 flat colours) collapses to ONE material; single-material
// props are naturally untouched (no ≥2 family).
//
// What it does, per eligible primitive whose material is in a
// mergeable family (≥2 materials identical up to baseColorFactor.rgb and
// runtime-ignored params):
//
//   - bakes the material's linear baseColorFactor.rgb into a new per-vertex
//     `_VINYLTINT` float VEC3 attribute (constant across the primitive), and
//   - repoints the primitive at ONE white canonical material per family,
//     stamped with `extras.vinylTintAttribute = "_VINYLTINT"` — the marker
//     `applyVinylMaterialToScene` reads (GLTFLoader copies material extras to
//     material.userData) to build the vinyl twin with
//     `tintAttribute: '_vinyltint'`, so albedo = tint attribute instead of the
//     flat material colour. One material ⇒ one pipeline-group ⇒ one compile.
//
// The tint deliberately does NOT ride COLOR_0 — its channels are a reserved
// parameter contract (R sway / G AO / B phase / A edge-wear convexity, see
// docs/vertex-attribute-spec.md) and the vinyl shader ignores COLOR_0.rgb for
// albedo on purpose.
//
// Untouched, by construction:
//   - primitives on nodes outside the kind allowlist (`decoration` detail
//     pieces + `track` landmark hulls/ramps — both take the runtime vinyl
//     look; colliders / water / horizon / decals never do). This tool is the
//     glTF-level sibling of the Blender join pass in
//     tools/blender/optimize_track_glb.py: joins happen there, material
//     dedupe here, so the merged geometry bytes round-trip untouched;
//   - materials another look-pass owns by name (mat_terrain*/mat_foliage_*/
//     mat_lava*/mat_vinyl*);
//   - materials that differ in anything the runtime honours: textures,
//     alphaMode/cutoff, doubleSided, emissive (incl.
//     KHR_materials_emissive_strength), baseColorFactor alpha, or unknown
//     extensions. Those keep their own material (and their own warm group).
//
// Families ARE allowed to span differing metallicFactor / roughnessFactor /
// metallicRoughness+occlusion textures / KHR_materials_specular / ior — the
// vinyl twin provably never reads them (COPIED_PROPS + forced matte finish).
// Every coalesced spread is printed so a future look change that starts
// honouring them knows what was flattened.
//
// Idempotent: re-running on its own output is a no-op (families collapse to
// single members; existing _VINYLTINT accessors are never overwritten).
//
// Usage:
//   node tools/optimize-track-glb-materials.mjs <in.glb> [out.glb] [--dry-run]
//   (track or prop GLB — the mode is auto-detected and printed)
//
// In-place (out omitted or equal to in) writes a `<in>.pre-mat-dedupe.bak`
// backup first — kept, never overwritten, so the true original survives
// repeated runs. `--dry-run` prints the plan + report and writes nothing.
//
// Zero runtime deps — plain Node ESM, exports pure helpers for the unit test
// (tests/unit/optimize-track-glb-materials.test.ts).

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// ── GLB container ───────────────────────────────────────────────────────────

const GLB_MAGIC = 0x46546c67 // 'glTF'
const CHUNK_JSON = 0x4e4f534a // 'JSON'
const CHUNK_BIN = 0x004e4942 // 'BIN\0'

/** Parse a GLB buffer into its glTF JSON tree + BIN chunk (or null). */
export function parseGlb(buf) {
  if (buf.length < 12 || buf.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error('not a GLB (bad magic)')
  }
  const declaredLen = buf.readUInt32LE(8)
  if (declaredLen > buf.length) throw new Error('truncated GLB')
  let off = 12
  let json = null
  let bin = null
  while (off + 8 <= declaredLen) {
    const len = buf.readUInt32LE(off)
    const type = buf.readUInt32LE(off + 4)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === CHUNK_JSON) json = JSON.parse(body.toString('utf8'))
    else if (type === CHUNK_BIN) bin = body
    off += 8 + len + ((4 - (len % 4)) % 4)
  }
  if (!json) throw new Error('GLB has no JSON chunk')
  return { json, bin }
}

/** Serialize a glTF JSON tree + BIN buffer back into a spec-aligned GLB. */
export function buildGlb(json, bin) {
  const jsonBody = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPad = (4 - (jsonBody.length % 4)) % 4
  const binPad = bin ? (4 - (bin.length % 4)) % 4 : 0
  const total = 12 + 8 + jsonBody.length + jsonPad + (bin ? 8 + bin.length + binPad : 0)
  const out = Buffer.alloc(total)
  out.writeUInt32LE(GLB_MAGIC, 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  let off = 12
  out.writeUInt32LE(jsonBody.length + jsonPad, off)
  out.writeUInt32LE(CHUNK_JSON, off + 4)
  jsonBody.copy(out, off + 8)
  out.fill(0x20, off + 8 + jsonBody.length, off + 8 + jsonBody.length + jsonPad)
  off += 8 + jsonBody.length + jsonPad
  if (bin) {
    out.writeUInt32LE(bin.length + binPad, off)
    out.writeUInt32LE(CHUNK_BIN, off + 4)
    bin.copy(out, off + 8)
    // trailing binPad bytes stay zero from alloc
  }
  return out
}

// ── Eligibility + family keys ───────────────────────────────────────────────

/** The glTF attribute the tint bakes into. GLTFLoader lowercases custom
 *  attribute names, so the runtime reads it as `_vinyltint`. */
export const TINT_ATTRIBUTE = '_VINYLTINT'
/** Material-extras marker the runtime look pass keys on. */
export const TINT_EXTRA_KEY = 'vinylTintAttribute'

/** Sentinel for a node that carries no `extras.kind`. */
const NO_KIND = '(none)'

/** Node kinds whose primitives may be rewritten, per file mode (values from
 *  ExportedKind, src/engine/asset-kinds.ts). Deliberately ALLOWLISTS, not the
 *  inverse of the runtime's skip sets. Extend deliberately if a new kind
 *  should join the collapse.
 *
 *  - `track`: `decoration` detail pieces and `track` landmark hulls/ramps are
 *    the two kinds shipped track GLBs carry that provably take the runtime
 *    vinyl look (gameplay reads their GEOMETRY — heightmap, colliders — never
 *    their materials; the terrain mesh is excluded twice over, by its
 *    `terrain` node name and its owned `mat_terrain*` material).
 *  - `prop`: the build_prop.py contract parents ONE untagged visual mesh
 *    under the `kind=prop` root empty — `createPropsMesh` vinyl-converts
 *    every non-collider sub-mesh, so untagged is the eligible shape
 *    (`decoration` allowed too for hand-assembled multi-part props).
 *    `kind=collider` empties carry no mesh and fall out via the allowlist
 *    either way. */
const MERGEABLE_KINDS_BY_MODE = {
  track: new Set(['decoration', 'track']),
  prop: new Set([NO_KIND, 'decoration']),
}

/** Kinds only a TRACK GLB carries — used to auto-detect the file mode. */
const TRACKISH_KINDS = new Set([
  'track',
  'decoration',
  'water',
  'ai_spline',
  'checkpoint',
  'horizon',
])

/**
 * Auto-detect whether a GLB is a prop file (build_prop.py: a `kind=prop` root
 * empty, no track-structural kinds) or a track file (everything else,
 * including kind-less files — where the track allowlist merges nothing).
 * A file carrying BOTH is outside either contract — refuse loudly rather
 * than guess.
 */
export function detectGlbMode(json) {
  let prop = false
  let trackish = false
  for (const n of json.nodes ?? []) {
    const k = n.extras?.kind
    if (k === 'prop') prop = true
    else if (TRACKISH_KINDS.has(k)) trackish = true
  }
  if (prop && trackish) {
    throw new Error('GLB carries both prop and track kinds — not a shape this tool supports')
  }
  return prop ? 'prop' : 'track'
}

/** Materials another runtime look-pass owns by name — never touched
 *  (mirrors ownedByAnotherPass in painterly-vinyl-material.ts). */
const OWNED_MATERIAL = /^mat_terrain|^mat_foliage_|^mat_lava|^mat_vinyl/

function texRef(t, extraKeys = []) {
  if (!t) return null
  const out = { index: t.index, texCoord: t.texCoord ?? 0 }
  for (const k of extraKeys) if (t[k] !== undefined) out[k] = t[k]
  return out
}

/**
 * Family key: everything the RUNTIME vinyl twin honours, except
 * baseColorFactor.rgb (which the tint attribute carries). Two materials with
 * equal keys render identically under the vinyl look once tint is
 * per-vertex. Runtime-ignored params (metallic/roughness/mr-texture/
 * occlusion/KHR specular+ior) are deliberately absent — see header.
 */
export function familyKey(mat) {
  const pbr = mat.pbrMetallicRoughness ?? {}
  const bcf = pbr.baseColorFactor ?? [1, 1, 1, 1]
  const ext = { ...(mat.extensions ?? {}) }
  delete ext.KHR_materials_specular
  delete ext.KHR_materials_ior
  return JSON.stringify({
    baseAlpha: bcf[3] ?? 1, // → material.opacity at runtime
    alphaMode: mat.alphaMode ?? 'OPAQUE',
    alphaCutoff: mat.alphaCutoff,
    doubleSided: !!mat.doubleSided,
    emissiveFactor: mat.emissiveFactor ?? [0, 0, 0],
    baseColorTexture: texRef(pbr.baseColorTexture),
    normalTexture: texRef(mat.normalTexture, ['scale']),
    emissiveTexture: texRef(mat.emissiveTexture),
    extensions: ext,
  })
}

/** Linear-space rgb the tint attribute carries for a material. */
function tintOf(mat) {
  const bcf = mat.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1]
  return [bcf[0] ?? 1, bcf[1] ?? 1, bcf[2] ?? 1]
}

// ── The pass ────────────────────────────────────────────────────────────────

/**
 * Rewrite `json`/`bin` in place-ish (returns fresh json + bin buffers):
 * family-merge eligible materials, bake `_VINYLTINT`, prune unused
 * materials. Returns { json, bin, report }. `mode` picks the eligibility
 * mirror (see MERGEABLE_KINDS_BY_MODE); omitted → auto-detected.
 */
export function dedupeTrackGlbMaterials(json, bin, mode = detectGlbMode(json)) {
  const gltf = structuredClone(json)
  if (!gltf.accessors) gltf.accessors = []
  if (!gltf.bufferViews) gltf.bufferViews = []
  const materials = gltf.materials ?? []
  const meshes = gltf.meshes ?? []
  const nodes = gltf.nodes ?? []
  const accessors = gltf.accessors
  const bufferViews = gltf.bufferViews
  const mergeableKinds = MERGEABLE_KINDS_BY_MODE[mode]
  if (!mergeableKinds) throw new Error(`unknown mode "${mode}"`)

  if ((gltf.buffers ?? []).length > 1) {
    throw new Error('multi-buffer glTF not supported (GLB tracks are single-buffer)')
  }

  const report = {
    materialsBefore: materials.length,
    materialsAfter: materials.length,
    families: [],
    primsTinted: 0,
    tintBytes: 0,
    warnings: [],
  }

  // Prop files whose materials feed a RAW-material render lane must not be
  // rewritten at all — those lanes never read the tint marker, so a white
  // canonical would render white (see header): wave-riders
  // (wave-rider-render instances mesh.material as-is) and animated props
  // (animated-props shares the loader cache's materials untouched, and a
  // clip-carrying GLB can be placed animated per-placement).
  if (mode === 'prop') {
    const waveRider = nodes.some(
      (n) => n.extras?.kind === 'prop' && n.extras?.wave_rider_archetype !== undefined,
    )
    const animated = (gltf.animations ?? []).length > 0
    if (waveRider || animated) {
      report.warnings.push(
        `prop GLB skipped: ${waveRider ? 'wave-rider' : 'animated'} props render raw materials (no tint lane)`,
      )
      return { json: gltf, bin: bin ?? Buffer.alloc(0), report }
    }
  }

  // A mesh is eligible only when EVERY node that instances it is in the
  // mode's allowlist (touching a shared mesh would restyle the other user too).
  const meshKinds = new Map() // meshIdx -> Set(kind)
  const meshNodeNames = new Map()
  for (const n of nodes) {
    if (n.mesh === undefined) continue
    if (!meshKinds.has(n.mesh)) {
      meshKinds.set(n.mesh, new Set())
      meshNodeNames.set(n.mesh, [])
    }
    meshKinds.get(n.mesh).add(n.extras?.kind ?? NO_KIND)
    meshNodeNames.get(n.mesh).push(n.name ?? '')
  }
  const meshEligible = (mi) => {
    const kinds = meshKinds.get(mi)
    if (!kinds || kinds.size === 0) return false // unreferenced mesh — leave alone
    for (const k of kinds) if (!mergeableKinds.has(k)) return false
    // Mirror the runtime's terrain-name guard (it skips obj.name 'terrain*').
    for (const nm of meshNodeNames.get(mi)) if (/^terrain/.test(nm)) return false
    return true
  }

  // Collect eligible prims per material.
  const eligiblePrimsByMat = new Map() // matIdx -> [{prim, meshIdx}]
  for (let mi = 0; mi < meshes.length; mi++) {
    if (!meshEligible(mi)) continue
    for (const prim of meshes[mi].primitives ?? []) {
      if (prim.material === undefined) continue
      if (prim.attributes?.POSITION === undefined) continue
      // Skinned prims are hosted by lanes that render/clone the raw material
      // (animated-props / skeleton clones) — never rewrite them.
      if (prim.attributes.JOINTS_0 !== undefined) continue
      const mat = materials[prim.material]
      if (!mat || OWNED_MATERIAL.test(mat.name ?? '')) continue
      if (!eligiblePrimsByMat.has(prim.material)) eligiblePrimsByMat.set(prim.material, [])
      eligiblePrimsByMat.get(prim.material).push({ prim, meshIdx: mi })
    }
  }

  // Group those materials into families.
  const families = new Map() // key -> [matIdx]
  for (const matIdx of eligiblePrimsByMat.keys()) {
    const key = familyKey(materials[matIdx])
    if (!families.has(key)) families.set(key, [])
    families.get(key).push(matIdx)
  }

  // Bake: one canonical white material per multi-member family.
  const canonPrefix = mode === 'prop' ? 'mat_prop_tint_' : 'mat_deco_tint_'
  const tintBlobs = []
  let tintCursor = 0
  const remap = new Map() // old matIdx -> canonical matIdx (only for merged)
  for (const [, members] of families) {
    if (members.length < 2) continue
    const canonIdx = materials.length
    const first = structuredClone(materials[members[0]])
    first.name = `${canonPrefix}${report.families.length}`
    first.pbrMetallicRoughness = {
      ...(first.pbrMetallicRoughness ?? {}),
      baseColorFactor: [1, 1, 1, first.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1],
    }
    first.extras = { ...(first.extras ?? {}), [TINT_EXTRA_KEY]: TINT_ATTRIBUTE }
    materials.push(first)

    const fam = { canonical: first.name, members: [], primCount: 0 }
    const spreads = { metallicFactor: new Set(), roughnessFactor: new Set(), specular: new Set() }
    for (const matIdx of members) {
      const m = materials[matIdx]
      remap.set(matIdx, canonIdx)
      fam.members.push({ name: m.name ?? `#${matIdx}`, tint: tintOf(m) })
      const pbr = m.pbrMetallicRoughness ?? {}
      spreads.metallicFactor.add(pbr.metallicFactor ?? 1)
      spreads.roughnessFactor.add(pbr.roughnessFactor ?? 1)
      spreads.specular.add(JSON.stringify(m.extensions?.KHR_materials_specular ?? null))
    }
    for (const [k, set] of Object.entries(spreads)) {
      if (set.size > 1) {
        report.warnings.push(
          `family ${first.name}: coalesced ${k} spread {${[...set].join(', ')}} — runtime-ignored by the vinyl look`,
        )
      }
    }
    report.families.push(fam)

    // Per-prim constant tint accessor.
    for (const matIdx of members) {
      const rgb = tintOf(materials[matIdx])
      for (const { prim } of eligiblePrimsByMat.get(matIdx)) {
        prim.material = canonIdx
        fam.primCount++
        report.primsTinted++
        if (prim.attributes[TINT_ATTRIBUTE] !== undefined) continue // idempotent re-run
        const count = accessors[prim.attributes.POSITION].count
        const data = new Float32Array(count * 3)
        for (let i = 0; i < count; i++) {
          data[i * 3] = rgb[0]
          data[i * 3 + 1] = rgb[1]
          data[i * 3 + 2] = rgb[2]
        }
        const blob = Buffer.from(data.buffer)
        prim.attributes[TINT_ATTRIBUTE] = accessors.length
        accessors.push({
          bufferView: -1, // patched below once the bufferView index exists
          byteOffset: tintCursor,
          componentType: 5126, // FLOAT
          count,
          type: 'VEC3',
        })
        tintBlobs.push(blob)
        tintCursor += blob.length
      }
    }
  }

  let outBin = bin ?? Buffer.alloc(0)
  if (tintBlobs.length > 0) {
    const basePad = (4 - (outBin.length % 4)) % 4
    const tintData = Buffer.concat(tintBlobs)
    const bvIdx = bufferViews.length
    bufferViews.push({
      buffer: 0,
      byteOffset: outBin.length + basePad,
      byteLength: tintData.length,
      target: 34962, // ARRAY_BUFFER
    })
    for (const a of accessors) if (a.bufferView === -1) a.bufferView = bvIdx
    outBin = Buffer.concat([outBin, Buffer.alloc(basePad), tintData])
    if (gltf.buffers?.[0]) gltf.buffers[0].byteLength = outBin.length
    report.tintBytes = tintData.length
  }

  // Prune materials no primitive references any more, remapping indices.
  const used = new Set()
  for (const mesh of meshes) {
    for (const prim of mesh.primitives ?? []) {
      if (prim.material !== undefined) used.add(prim.material)
    }
  }
  const indexMap = new Map()
  const kept = []
  materials.forEach((m, i) => {
    if (used.has(i)) {
      indexMap.set(i, kept.length)
      kept.push(m)
    }
  })
  for (const mesh of meshes) {
    for (const prim of mesh.primitives ?? []) {
      if (prim.material !== undefined) prim.material = indexMap.get(prim.material)
    }
  }
  gltf.materials = kept
  report.materialsAfter = kept.length

  return { json: gltf, bin: outBin, report }
}

// ── Post-write validation + warm-group estimate ─────────────────────────────

/** Structural sanity over a serialized GLB — throws on the first violation. */
export function validateGlb(buf) {
  const { json, bin } = parseGlb(buf)
  const accessors = json.accessors ?? []
  const bufferViews = json.bufferViews ?? []
  const materials = json.materials ?? []
  const compBytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
  const compCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }
  for (const [ai, a] of accessors.entries()) {
    if (a.bufferView === undefined) continue
    const bv = bufferViews[a.bufferView]
    if (!bv) throw new Error(`accessor ${ai}: dangling bufferView`)
    const elem = compBytes[a.componentType] * compCount[a.type]
    const span = (a.byteOffset ?? 0) + (bv.byteStride ?? elem) * (a.count - 1) + elem
    if (span > bv.byteLength) throw new Error(`accessor ${ai}: overruns bufferView`)
    if ((bv.byteOffset ?? 0) + bv.byteLength > (bin?.length ?? 0)) {
      throw new Error(`bufferView ${a.bufferView}: overruns BIN chunk`)
    }
  }
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      if (prim.material !== undefined && !materials[prim.material]) {
        throw new Error(`primitive references missing material ${prim.material}`)
      }
      const pos = prim.attributes?.POSITION
      const tint = prim.attributes?.[TINT_ATTRIBUTE]
      if (tint !== undefined && accessors[tint].count !== accessors[pos].count) {
        throw new Error('tint/position count mismatch')
      }
    }
  }
  return json
}

/**
 * Estimate the progressive-warm pipeline-group count over eligible prims:
 * unique (material, attribute-set ∪ COLOR_0, indexed-ness). The runtime
 * stamps a neutral COLOR_0 on every vinyl mesh that lacks one
 * (ensureNeutralVertexColor), so it's folded into the layout here.
 */
export function estimateWarmGroups(json, mode = detectGlbMode(json)) {
  const mergeableKinds = MERGEABLE_KINDS_BY_MODE[mode]
  if (!mergeableKinds) throw new Error(`unknown mode "${mode}"`)
  const groups = new Set()
  const kinds = new Map()
  for (const n of json.nodes ?? []) {
    if (n.mesh === undefined) continue
    if (!kinds.has(n.mesh)) kinds.set(n.mesh, new Set())
    kinds.get(n.mesh).add(n.extras?.kind ?? NO_KIND)
  }
  json.meshes?.forEach((mesh, mi) => {
    const ks = kinds.get(mi)
    if (!ks || [...ks].some((k) => !mergeableKinds.has(k))) return
    for (const prim of mesh.primitives ?? []) {
      if (prim.material === undefined) continue
      const mat = json.materials?.[prim.material]
      if (!mat || OWNED_MATERIAL.test(mat.name ?? '')) continue
      const attrs = new Set(Object.keys(prim.attributes ?? {}))
      attrs.add('COLOR_0')
      groups.add(
        `${prim.material}|${[...attrs].sort().join(',')}|${prim.indices !== undefined ? 1 : 0}`,
      )
    }
  })
  return groups.size
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')))
  const src = args[0]
  if (!src) {
    console.error(
      'usage: node tools/optimize-track-glb-materials.mjs <in.glb> [out.glb] [--dry-run]',
    )
    process.exit(2)
  }
  const dst = resolve(args[1] ?? src)
  const srcAbs = resolve(src)
  const dryRun = flags.has('--dry-run')

  const input = readFileSync(srcAbs)
  const { json, bin } = parseGlb(input)
  const mode = detectGlbMode(json)
  console.log(`[mat-dedupe] mode: ${mode}`)
  const groupsBefore = estimateWarmGroups(json, mode)
  const { json: outJson, bin: outBin, report } = dedupeTrackGlbMaterials(json, bin, mode)
  const groupsAfter = estimateWarmGroups(outJson, mode)

  for (const fam of report.families) {
    console.log(
      `family ${fam.canonical} — ${fam.members.length} materials, ${fam.primCount} prims:`,
    )
    for (const m of fam.members) {
      console.log(`  - ${m.name} tint=[${m.tint.map((x) => x.toFixed(4)).join(', ')}]`)
    }
  }
  for (const w of report.warnings) console.log(`WARN ${w}`)
  console.log(
    `[mat-dedupe] materials ${report.materialsBefore} -> ${report.materialsAfter} · ` +
      `${report.primsTinted} prims tinted (+${(report.tintBytes / 1024).toFixed(1)} KiB) · ` +
      `estimated eligible warm-groups ${groupsBefore} -> ${groupsAfter}`,
  )

  if (dryRun) {
    console.log('[mat-dedupe] --dry-run: nothing written')
    return
  }
  if (report.primsTinted === 0) {
    console.log('[mat-dedupe] nothing to merge — output not written')
    return
  }

  const out = buildGlb(outJson, outBin)
  validateGlb(out)
  if (dst === srcAbs) {
    const bak = `${srcAbs}.pre-mat-dedupe.bak`
    if (!existsSync(bak)) {
      copyFileSync(srcAbs, bak)
      console.log(`[mat-dedupe] backup: ${bak}`)
    } else {
      console.log(`[mat-dedupe] backup already exists (kept): ${bak}`)
    }
  }
  writeFileSync(dst, out)
  console.log(`[mat-dedupe] wrote ${dst} (${(out.length / 1024 / 1024).toFixed(2)} MB)`)
}

// Run main() only when invoked as a script (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
