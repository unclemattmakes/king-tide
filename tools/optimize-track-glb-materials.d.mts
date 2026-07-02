// Hand-maintained types for optimize-track-glb-materials.mjs (the unit test
// imports the pure helpers) — same pattern as tools/qa/matrix.d.mts.

/** Minimal glTF JSON tree shape this tool reads/writes. */
export type GltfJson = {
  buffers?: Array<{ byteLength: number }>
  bufferViews?: Array<{
    buffer: number
    byteOffset?: number
    byteLength: number
    byteStride?: number
    target?: number
  }>
  accessors?: Array<{
    bufferView?: number
    byteOffset?: number
    componentType: number
    count: number
    type: string
  }>
  materials?: Array<Record<string, unknown> & { name?: string; extras?: Record<string, unknown> }>
  meshes?: Array<{
    primitives?: Array<{
      attributes?: Record<string, number>
      indices?: number
      material?: number
      mode?: number
    }>
  }>
  nodes?: Array<{ name?: string; mesh?: number; extras?: { kind?: string } }>
  [k: string]: unknown
}

export type DedupeReport = {
  materialsBefore: number
  materialsAfter: number
  families: Array<{
    canonical: string
    members: Array<{ name: string; tint: [number, number, number] }>
    primCount: number
  }>
  primsTinted: number
  tintBytes: number
  warnings: string[]
}

export declare const TINT_ATTRIBUTE: '_VINYLTINT'
export declare const TINT_EXTRA_KEY: 'vinylTintAttribute'

export declare function parseGlb(buf: Buffer): { json: GltfJson; bin: Buffer | null }
export declare function buildGlb(json: GltfJson, bin: Buffer | null): Buffer
export declare function familyKey(mat: Record<string, unknown>): string
export declare function dedupeTrackGlbMaterials(
  json: GltfJson,
  bin: Buffer | null,
): { json: GltfJson; bin: Buffer; report: DedupeReport }
export declare function validateGlb(buf: Buffer): GltfJson
export declare function estimateWarmGroups(json: GltfJson): number
