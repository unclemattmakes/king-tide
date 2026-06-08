/**
 * Brush-tuning service — live handles the dev "Brush strokes" tuner drives.
 *
 * Mirrors `water-service` / `sky-service`. The terrain shader and the
 * painterly-vinyl materials hold their brush dials in shader UNIFORMS; at track
 * load each registers a small updater handle here. The tuner panel calls
 * `setTerrainBrush` / `setVinylBrush`, which re-dial every registered material
 * live (uniform writes — no shader recompile).
 *
 * Terrain and vinyl are INDEPENDENT: separate handle sets + separate value sets,
 * so terrain stroke values are never coupled to the rocks/props/buildings ones.
 *
 * `getBrushTuning()` returns the current values (seeds the panel + lets the e2e
 * read state). The first material registered after a `clearBrushTargets()`
 * (called per GLB track load) seeds the current values from its build-time
 * config, so the panel opens on the track's actual look.
 */

export type TerrainBrushValues = {
  /** Overall brush strength (default 0.75). */
  brush: number
  /** Stroke size in metres — bigger = sparser, less "straw" (default 4.0). */
  brushScale: number
  /** 0 = uniform, 1 = strokes only on slopes/ridges (default 0.4). */
  brushCurvature: number
}

export type VinylBrushValues = {
  /** Set-piece brush strength on rocks/cliffs/buildings (default 0.7). */
  brush: number
  /** Stroke size as a FRACTION of the (capped) prop size; lower = bigger strokes
   *  (default 0.12). */
  brushScale: number
  /** The brush stops treating a prop as "bigger" past this size in metres — the
   *  main lever against the big-rock straw (default 6). */
  brushPropSizeCap: number
}

export type TerrainBrushHandle = {
  initial: TerrainBrushValues
  set(v: TerrainBrushValues): void
}
export type VinylBrushHandle = {
  initial: VinylBrushValues
  set(v: VinylBrushValues): void
}

export const TERRAIN_BRUSH_DEFAULTS: TerrainBrushValues = {
  brush: 0.75,
  brushScale: 4.0,
  brushCurvature: 0.4,
}
export const VINYL_BRUSH_DEFAULTS: VinylBrushValues = {
  brush: 0.7,
  brushScale: 0.12,
  brushPropSizeCap: 6,
}

const terrainHandles = new Set<TerrainBrushHandle>()
const vinylHandles = new Set<VinylBrushHandle>()
let terrainVals: TerrainBrushValues = { ...TERRAIN_BRUSH_DEFAULTS }
let vinylVals: VinylBrushValues = { ...VINYL_BRUSH_DEFAULTS }
let terrainSeeded = false
let vinylSeeded = false

/** Drop all registered handles — call at the start of a (GLB) track load before
 *  the materials re-register. */
export function clearBrushTargets(): void {
  terrainHandles.clear()
  vinylHandles.clear()
  terrainSeeded = false
  vinylSeeded = false
  terrainVals = { ...TERRAIN_BRUSH_DEFAULTS }
  vinylVals = { ...VINYL_BRUSH_DEFAULTS }
}

export function registerTerrainBrush(h: TerrainBrushHandle): void {
  terrainHandles.add(h)
  if (!terrainSeeded) {
    terrainVals = { ...h.initial }
    terrainSeeded = true
  } else {
    h.set(terrainVals)
  }
}

export function registerVinylBrush(h: VinylBrushHandle): void {
  vinylHandles.add(h)
  if (!vinylSeeded) {
    vinylVals = { ...h.initial }
    vinylSeeded = true
  } else {
    h.set(vinylVals)
  }
}

export function setTerrainBrush(v: Partial<TerrainBrushValues>): void {
  terrainVals = { ...terrainVals, ...v }
  for (const h of terrainHandles) h.set(terrainVals)
}

export function setVinylBrush(v: Partial<VinylBrushValues>): void {
  vinylVals = { ...vinylVals, ...v }
  for (const h of vinylHandles) h.set(vinylVals)
}

export function getBrushTuning(): { terrain: TerrainBrushValues; vinyl: VinylBrushValues } {
  return { terrain: { ...terrainVals }, vinyl: { ...vinylVals } }
}
