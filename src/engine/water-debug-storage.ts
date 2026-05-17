/**
 * Storage + apply helpers for water debug tuning. Split out from
 * `water-debug-menu.ts` so the boot path can apply persisted tuning
 * eagerly without pulling the full slider DOM build into the main
 * bundle. The menu UI dynamic-imports `water-debug-menu` lazily on
 * first toggle-button click.
 */

import type { WaterDebugDefaults, WaterMesh } from './render/water'

// v5 bump: adds `foamPersistence` alongside the v4 wind-direction +
// wind-cutoff keys. Old v1–v4 entries are silently merged onto
// defaults by the per-key tolerant loader below.
export const WATER_DEBUG_STORAGE_KEY = 'hoverbike.waterDebug.v5'

export type WaterDebugSettings = {
  steepness: number
  swellScale: number
  chopScale: number
  timeScale: number
  reflectionStrength: number
  sunGlow: number
  roughBase: number
  roughSparkle: number
  detailStrength: number
  choppiness: number
  seaStateIntensity: number
  windSpeed: number
  windDirection: number
  windCutoff: number
  foamPersistence: number
  wireframe: boolean
}

export function defaultsToSettings(d: WaterDebugDefaults): WaterDebugSettings {
  return {
    steepness: d.steepness,
    swellScale: d.swellScale,
    chopScale: d.chopScale,
    timeScale: d.timeScale,
    reflectionStrength: d.reflectionStrength,
    sunGlow: d.sunGlow,
    roughBase: d.roughBase,
    roughSparkle: d.roughSparkle,
    detailStrength: d.detailStrength,
    choppiness: d.choppiness,
    seaStateIntensity: d.seaStateIntensity,
    windSpeed: d.windSpeed,
    windDirection: d.windDirection,
    windCutoff: d.windCutoff,
    foamPersistence: d.foamPersistence,
    wireframe: d.wireframe,
  }
}

export function loadStoredWaterSettings(defaults: WaterDebugDefaults): WaterDebugSettings {
  const base = defaultsToSettings(defaults)
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(WATER_DEBUG_STORAGE_KEY)
  } catch {
    return base
  }
  if (!raw) return base
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return base
  }
  if (!parsed || typeof parsed !== 'object') return base
  const p = parsed as Record<string, unknown>
  for (const k of Object.keys(base) as Array<keyof WaterDebugSettings>) {
    const v = p[k]
    if (k === 'wireframe') {
      if (typeof v === 'boolean') base[k] = v
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      ;(base as unknown as Record<string, number>)[k] = v
    }
  }
  return base
}

export function persistWaterSettings(s: WaterDebugSettings): void {
  try {
    window.localStorage.setItem(WATER_DEBUG_STORAGE_KEY, JSON.stringify(s))
  } catch {
    // ignore — settings still take effect for this session.
  }
}

export function applyWaterSettings(water: WaterMesh, s: WaterDebugSettings): void {
  water.debug.setSteepness(s.steepness)
  water.debug.setSwellScale(s.swellScale)
  water.debug.setChopScale(s.chopScale)
  water.debug.setTimeScale(s.timeScale)
  water.debug.setReflectionStrength(s.reflectionStrength)
  water.debug.setSunGlow(s.sunGlow)
  water.debug.setRoughBase(s.roughBase)
  water.debug.setRoughSparkle(s.roughSparkle)
  water.debug.setDetailStrength(s.detailStrength)
  water.debug.setChoppiness(s.choppiness)
  water.debug.setSeaStateIntensity(s.seaStateIntensity)
  water.debug.setWindSpeed(s.windSpeed)
  water.debug.setWindDirection(s.windDirection)
  water.debug.setWindCutoff(s.windCutoff)
  water.debug.setFoamPersistence(s.foamPersistence)
  water.debug.setWireframe(s.wireframe)
}

/**
 * Eager boot-time helper: load any persisted water tuning and apply it
 * to the visible water mesh so the page opens in the visual state the
 * user last left. No DOM, no slider build — safe for the main bundle.
 */
export function applyStoredWaterTuning(water: WaterMesh): void {
  applyWaterSettings(water, loadStoredWaterSettings(water.debug.defaults))
}
