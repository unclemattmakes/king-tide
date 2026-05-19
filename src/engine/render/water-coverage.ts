import { sampleTerrainHeightAtXZ, type TerrainHeightmap } from '@/engine/render/terrain-heightmap'
import type { Track } from '@/game/tracks/types'

/**
 * Wave-mastery is the v1 signature pillar; tracks lose their reason
 * to exist when most of the race is dry. Walk the main AI spline,
 * sample the terrain heightmap at each anchor's XZ, and report how
 * many points sit over open water (terrain Y under the waterline)
 * vs over land.
 *
 * The threshold (40% water) is the v1 design-targets minimum — any
 * track below that is a polish item: the spline needs reshaping so
 * the racing line actually crosses the wet stretches, or the terrain
 * needs dropping where the spline runs.
 *
 * Render-only diagnostic; never touches sim state. Called once at
 * boot after the terrain heightmap is built.
 */
export type WaterCoverageReport = {
  total: number
  water: number
  land: number
  outside: number
  pct: number
  thresholdPct: number
  meetsThreshold: boolean
}

export const WATER_COVERAGE_THRESHOLD = 0.4

export function reportWaterCoverage(
  track: Track,
  heightmap: TerrainHeightmap | null,
): WaterCoverageReport | null {
  if (!heightmap) return null
  const spline = track.aiSplines.find((s) => s.id === 'main') ?? track.aiSplines[0]
  if (!spline || spline.points.length < 2) return null
  const waterY = track.water?.height ?? 0

  let water = 0
  let land = 0
  let outside = 0
  for (const p of spline.points) {
    const h = sampleTerrainHeightAtXZ(heightmap, p.x, p.z)
    if (h === null) {
      // No terrain → open ocean → counts as water for the coverage
      // metric (the bike will be riding the wave field there).
      outside++
      water++
      continue
    }
    if (h <= waterY) water++
    else land++
  }
  const total = spline.points.length
  const pct = total > 0 ? water / total : 0
  return {
    total,
    water,
    land,
    outside,
    pct,
    thresholdPct: WATER_COVERAGE_THRESHOLD,
    meetsThreshold: pct >= WATER_COVERAGE_THRESHOLD,
  }
}

/**
 * Log the coverage report in a single line. Errors below threshold,
 * info otherwise. Kept separate from the calculator so tests can
 * assert behaviour without console noise.
 */
export function logWaterCoverage(trackId: string, report: WaterCoverageReport): void {
  const pctStr = (report.pct * 100).toFixed(0)
  const thresholdStr = (report.thresholdPct * 100).toFixed(0)
  const tail = `(${report.water}/${report.total} spline anchors over water; ${report.land} land, ${report.outside} open-ocean)`
  if (report.meetsThreshold) {
    // eslint-disable-next-line no-console
    console.info(`[water-coverage] ${trackId}: ${pctStr}% water ≥ ${thresholdStr}% target ${tail}`)
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `[water-coverage] ${trackId}: ${pctStr}% water < ${thresholdStr}% target — race spline is too land-heavy ${tail}`,
    )
  }
}
