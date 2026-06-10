/**
 * Storage + apply helpers for water debug tuning. Split out from
 * `water-debug-menu.ts` so the boot path can apply persisted tuning
 * eagerly without pulling the full slider DOM build into the main
 * bundle. The menu UI dynamic-imports `water-debug-menu` lazily on
 * first toggle-button click.
 */

import type { WaterDebugDefaults, WaterMesh } from './render/water'

// v10 bump: adds the whitecap-coverage knobs (whitecapHeight, whitecapSlope,
// whitecapMode) from the foam-coverage pass. Old v1–v9 entries are silently
// merged onto defaults by the per-key tolerant loader below — unknown keys
// are ignored, missing keys fall back to the (new) defaults, so a returning
// user keeps their other tuning and picks up the new foam baseline.
//
// No key bump for the foam-v3 curvature rework: it ADDS whitecapCurvature +
// whitecapLeadBias (missing-key → new default via the loader) and leaves the
// now-legacy height/slope/mode keys in place (they load but no longer affect
// the wave whitecap), so v10 stays compatible and returning users pick up the
// curvature whitecap automatically.
//
// No key bump for the P0.3 bearing demotion either: `waveBearing` was REMOVED
// from the settings shape (the swell bearing is per-track authoring now —
// `water.swellBearingDeg` — and the menu slider is a live, non-persisted
// override; see water-next-research.md §4.5). A stale `waveBearing` in an old
// v10 entry is simply ignored by the per-key loader below, which is the
// point: a bearing dialed on one track must never silently re-aim every
// other track's swell on that machine.
//
// No key bump for the P1 readability layers either: rampStrength/rampSteps/
// rampPosterize/contourStrength/contourSpacing/contourRelief are ADDED keys
// (missing-key -> new default via the loader), so returning users pick up the
// readability defaults and keep their other tuning.
//
// v9 bump (prior): dropped the spectrum/FFT-only knobs (choppiness,
// seaStateIntensity, windSpeed, windDirection, windCutoff, foamPersistence)
// along with the FFT path itself.
export const WATER_DEBUG_STORAGE_KEY = 'hoverbike.waterDebug.v10'

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
  bodyAbsorption: number
  sunDiscStrength: number
  sunStreakStrength: number
  streakElongation: number
  shoreWaveStrength: number
  pinchDirection: number
  whitecapCurvature: number
  whitecapLeadBias: number
  whitecapHeight: number
  whitecapSlope: number
  whitecapMode: number
  foamWarmth: number
  foamStreak: number
  foamBrush: number
  rampStrength: number
  rampSteps: number
  rampPosterize: number
  contourStrength: number
  contourSpacing: number
  contourRelief: number
  contourBreakup: number
  wireframe: boolean
  colorize: boolean
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
    bodyAbsorption: d.bodyAbsorption,
    sunDiscStrength: d.sunDiscStrength,
    sunStreakStrength: d.sunStreakStrength,
    streakElongation: d.streakElongation,
    shoreWaveStrength: d.shoreWaveStrength,
    pinchDirection: d.pinchDirection,
    whitecapCurvature: d.whitecapCurvature,
    whitecapLeadBias: d.whitecapLeadBias,
    whitecapHeight: d.whitecapHeight,
    whitecapSlope: d.whitecapSlope,
    whitecapMode: d.whitecapMode,
    foamWarmth: d.foamWarmth,
    foamStreak: d.foamStreak,
    foamBrush: d.foamBrush,
    rampStrength: d.rampStrength,
    rampSteps: d.rampSteps,
    rampPosterize: d.rampPosterize,
    contourStrength: d.contourStrength,
    contourSpacing: d.contourSpacing,
    contourRelief: d.contourRelief,
    contourBreakup: d.contourBreakup,
    wireframe: d.wireframe,
    colorize: d.colorize,
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
    if (k === 'wireframe' || k === 'colorize') {
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
  water.debug.setBodyAbsorption(s.bodyAbsorption)
  water.debug.setSunDiscStrength(s.sunDiscStrength)
  water.debug.setSunStreakStrength(s.sunStreakStrength)
  water.debug.setStreakElongation(s.streakElongation)
  water.debug.setShoreWaveStrength(s.shoreWaveStrength)
  water.debug.setPinchDirection(s.pinchDirection)
  water.debug.setWhitecapCurvature(s.whitecapCurvature)
  water.debug.setWhitecapLeadBias(s.whitecapLeadBias)
  water.debug.setWhitecapHeight(s.whitecapHeight)
  water.debug.setWhitecapSlope(s.whitecapSlope)
  water.debug.setWhitecapMode(s.whitecapMode)
  water.debug.setFoamWarmth(s.foamWarmth)
  water.debug.setFoamStreak(s.foamStreak)
  water.debug.setFoamBrush(s.foamBrush)
  water.debug.setRampStrength(s.rampStrength)
  water.debug.setRampSteps(s.rampSteps)
  water.debug.setRampPosterize(s.rampPosterize)
  water.debug.setContourStrength(s.contourStrength)
  water.debug.setContourSpacing(s.contourSpacing)
  water.debug.setContourRelief(s.contourRelief)
  water.debug.setContourBreakup(s.contourBreakup)
  water.debug.setWireframe(s.wireframe)
  water.debug.setColorize(s.colorize)
}

/**
 * Eager boot-time helper: load any persisted water tuning and apply it
 * to the visible water mesh so the page opens in the visual state the
 * user last left. No DOM, no slider build — safe for the main bundle.
 */
export function applyStoredWaterTuning(water: WaterMesh): void {
  applyWaterSettings(water, loadStoredWaterSettings(water.debug.defaults))
}
