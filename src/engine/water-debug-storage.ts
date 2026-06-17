/**
 * Storage + apply helpers for water debug tuning. Split out from
 * `water-debug-menu.ts` so the boot path can apply persisted tuning
 * eagerly without pulling the full slider DOM build into the main
 * bundle. The menu UI dynamic-imports `water-debug-menu` lazily on
 * first toggle-button click.
 *
 * Persistence is SCOPED (water-defaults pass, 2026-06-14):
 *   - GLOBAL scope (the lab, wave-rider, any scene with no track): the
 *     painterly look persists to one machine-wide key, exactly as before.
 *   - TRACK scope (in a level): the shipped baseline is the constructor
 *     defaults; a track's committed `water.look` (JSON) overrides that
 *     sparsely, and your in-progress edits persist per track slug
 *     (`hoverbike.waterDebug.track.<slug>.v1`). The global machine key is
 *     NOT applied in a track — so what you tune against is what ships, not
 *     another track's leftover look. Export (menu) emits the diff-from-
 *     defaults as the track's `water.look` block.
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
// readability defaults and keep their other tuning. (`riseStroke`, the
// crest-perpendicular rising-face strokes, is likewise an ADDED key ->
// default 0.5, so returning users pick it up at baseline.)
//
// No key bump for the trail-wake rework either: wakeStrength is an ADDED key
// (missing-key -> default 1.0), so returning users get the trailing wake at
// baseline strength automatically.
//
// No key bump for P4.1 either: splashRings is an ADDED key (missing-key
// -> default 1.0), so returning users get landing event waves at baseline.
//
// No key bump for the waterline contact pass either: contactFoam is an ADDED
// key (missing-key -> default 1.0), so returning users get obstacle foam
// collars at baseline and keep their other tuning.
//
// No key bump for the contour-slide pass either: contourCoherence +
// contourGate are ADDED keys (missing-key -> defaults 0 / 0 = the legacy
// look), so returning users see no change until they reach for the new
// `?waterlab` knobs. contourCalmAtRest is likewise an ADDED key but its
// default is 1 — Matt's call: the slide reads worst when the observer is
// still (standing riders / the intro flyby), so at-rest lines pin to the
// primary swell by default and the authored liveliness returns at speed.
//
// No key bump for shoaling v2 (P3.1) either: shoalSurf is an ADDED key
// (missing-key -> default 1.0 = full surf), so returning users pick up the
// depth-driven surf automatically; its 0-endpoint is the exact legacy
// kill-switch for A/B.
//
// No key bump for the P2.3 anti-repetition kit either: foamWarp + langmuir
// are ADDED keys (missing-key -> defaults 1.0 / 0.6), so returning users
// pick up the tangential foam warp + Langmuir lanes at baseline and keep
// their other tuning. (The hex-tiled sampling itself is structural — a
// `?hextile=0` boot flag, not a stored knob.)
//
// v9 bump (prior): dropped the spectrum/FFT-only knobs (choppiness,
// seaStateIntensity, windSpeed, windDirection, windCutoff, foamPersistence)
// along with the FFT path itself.
export const WATER_DEBUG_STORAGE_KEY = 'hoverbike.waterDebug.v10'

/** Per-track working-override store version (sparse look deltas, machine-local). */
const WATER_TRACK_STORAGE_VERSION = 'v1'

export type WaterDebugSettings = {
  steepness: number
  swellScale: number
  chopScale: number
  timeScale: number
  reflectionStrength: number
  reflRoughness: number
  sunGlow: number
  roughBase: number
  roughSparkle: number
  detailStrength: number
  paintNormal: number
  bodyAbsorption: number
  sunDiscStrength: number
  sunStreakStrength: number
  streakElongation: number
  shoreWaveStrength: number
  shoalSurf: number
  splashRings: number
  contactFoam: number
  pinchDirection: number
  whitecapCurvature: number
  whitecapLeadBias: number
  whitecapHeight: number
  whitecapSlope: number
  whitecapMode: number
  foamWarmth: number
  foamStreak: number
  foamBrush: number
  foamWarp: number
  wakeStrength: number
  rampStrength: number
  rampSteps: number
  rampPosterize: number
  contourStrength: number
  contourSpacing: number
  contourRelief: number
  contourCoherence: number
  contourCalmAtRest: number
  contourGate: number
  wireframe: boolean
  colorize: boolean
}

/** The numeric look/shape knobs — everything in WaterDebugSettings except the
 *  two boolean debug-view toggles. These are the keys eligible for a per-track
 *  `water.look` override and the ones the export/diff helpers operate on. */
export type WaterLookKey = Exclude<keyof WaterDebugSettings, 'wireframe' | 'colorize'>

/** Single source of truth for key → WaterMesh setter. Used by applyWaterSettings,
 *  applyLookOverrides, and the menu's live drag-apply so they can never drift. */
export const WATER_SETTERS: Record<WaterLookKey, (water: WaterMesh, v: number) => void> = {
  steepness: (w, v) => w.debug.setSteepness(v),
  swellScale: (w, v) => w.debug.setSwellScale(v),
  chopScale: (w, v) => w.debug.setChopScale(v),
  timeScale: (w, v) => w.debug.setTimeScale(v),
  reflectionStrength: (w, v) => w.debug.setReflectionStrength(v),
  reflRoughness: (w, v) => w.debug.setReflRoughness(v),
  sunGlow: (w, v) => w.debug.setSunGlow(v),
  roughBase: (w, v) => w.debug.setRoughBase(v),
  roughSparkle: (w, v) => w.debug.setRoughSparkle(v),
  detailStrength: (w, v) => w.debug.setDetailStrength(v),
  paintNormal: (w, v) => w.debug.setPaintNormal(v),
  bodyAbsorption: (w, v) => w.debug.setBodyAbsorption(v),
  sunDiscStrength: (w, v) => w.debug.setSunDiscStrength(v),
  sunStreakStrength: (w, v) => w.debug.setSunStreakStrength(v),
  streakElongation: (w, v) => w.debug.setStreakElongation(v),
  shoreWaveStrength: (w, v) => w.debug.setShoreWaveStrength(v),
  shoalSurf: (w, v) => w.debug.setShoalSurf(v),
  splashRings: (w, v) => w.debug.setSplashRings(v),
  contactFoam: (w, v) => w.debug.setContactFoam(v),
  pinchDirection: (w, v) => w.debug.setPinchDirection(v),
  whitecapCurvature: (w, v) => w.debug.setWhitecapCurvature(v),
  whitecapLeadBias: (w, v) => w.debug.setWhitecapLeadBias(v),
  whitecapHeight: (w, v) => w.debug.setWhitecapHeight(v),
  whitecapSlope: (w, v) => w.debug.setWhitecapSlope(v),
  whitecapMode: (w, v) => w.debug.setWhitecapMode(v),
  foamWarmth: (w, v) => w.debug.setFoamWarmth(v),
  foamStreak: (w, v) => w.debug.setFoamStreak(v),
  foamBrush: (w, v) => w.debug.setFoamBrush(v),
  foamWarp: (w, v) => w.debug.setFoamWarp(v),
  wakeStrength: (w, v) => w.debug.setWakeStrength(v),
  rampStrength: (w, v) => w.debug.setRampStrength(v),
  rampSteps: (w, v) => w.debug.setRampSteps(v),
  rampPosterize: (w, v) => w.debug.setRampPosterize(v),
  contourStrength: (w, v) => w.debug.setContourStrength(v),
  contourSpacing: (w, v) => w.debug.setContourSpacing(v),
  contourRelief: (w, v) => w.debug.setContourRelief(v),
  contourCoherence: (w, v) => w.debug.setContourCoherence(v),
  contourCalmAtRest: (w, v) => w.debug.setContourCalmAtRest(v),
  contourGate: (w, v) => w.debug.setContourGate(v),
}

/** All look keys, in setter-declaration order. The JSON loader validates a
 *  track's `water.look` against this set; the menu/export iterate it. */
export const WATER_LOOK_KEYS = Object.keys(WATER_SETTERS) as WaterLookKey[]

const WATER_LOOK_KEY_SET = new Set<string>(WATER_LOOK_KEYS)

/** Is `k` a recognised look key? (Runtime guard for untrusted JSON.) */
export function isWaterLookKey(k: string): k is WaterLookKey {
  return WATER_LOOK_KEY_SET.has(k)
}

/** Sparse map of look-knob overrides — a track's `water.look` block, or a
 *  machine-local per-slug working store. Absent keys inherit the baseline. */
export type WaterLookOverrides = Partial<Record<WaterLookKey, number>>

export function defaultsToSettings(d: WaterDebugDefaults): WaterDebugSettings {
  return {
    steepness: d.steepness,
    swellScale: d.swellScale,
    chopScale: d.chopScale,
    timeScale: d.timeScale,
    reflectionStrength: d.reflectionStrength,
    reflRoughness: d.reflRoughness,
    sunGlow: d.sunGlow,
    roughBase: d.roughBase,
    roughSparkle: d.roughSparkle,
    detailStrength: d.detailStrength,
    paintNormal: d.paintNormal,
    bodyAbsorption: d.bodyAbsorption,
    sunDiscStrength: d.sunDiscStrength,
    sunStreakStrength: d.sunStreakStrength,
    streakElongation: d.streakElongation,
    shoreWaveStrength: d.shoreWaveStrength,
    shoalSurf: d.shoalSurf,
    splashRings: d.splashRings,
    contactFoam: d.contactFoam,
    pinchDirection: d.pinchDirection,
    whitecapCurvature: d.whitecapCurvature,
    whitecapLeadBias: d.whitecapLeadBias,
    whitecapHeight: d.whitecapHeight,
    whitecapSlope: d.whitecapSlope,
    whitecapMode: d.whitecapMode,
    foamWarmth: d.foamWarmth,
    foamStreak: d.foamStreak,
    foamBrush: d.foamBrush,
    foamWarp: d.foamWarp,
    wakeStrength: d.wakeStrength,
    rampStrength: d.rampStrength,
    rampSteps: d.rampSteps,
    rampPosterize: d.rampPosterize,
    contourStrength: d.contourStrength,
    contourSpacing: d.contourSpacing,
    contourRelief: d.contourRelief,
    contourCoherence: d.contourCoherence,
    contourCalmAtRest: d.contourCalmAtRest,
    contourGate: d.contourGate,
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
  for (const k of WATER_LOOK_KEYS) WATER_SETTERS[k](water, s[k])
  water.debug.setWireframe(s.wireframe)
  water.debug.setColorize(s.colorize)
}

/**
 * Eager boot-time helper: load any persisted GLOBAL water tuning and apply
 * it to the visible water mesh so the page opens in the visual state the
 * user last left. No DOM, no slider build — safe for the main bundle. Used
 * by the lab / wave-rider (global scope); tracks use the override path below.
 */
export function applyStoredWaterTuning(water: WaterMesh): void {
  applyWaterSettings(water, loadStoredWaterSettings(water.debug.defaults))
}

// ---- sparse look overrides (per-track committed JSON + working store) -------

/** Apply a sparse look-override map onto the mesh — only the keys present,
 *  validated against the known look set so a stray JSON key can't throw. */
export function applyLookOverrides(
  water: WaterMesh,
  o: WaterLookOverrides | null | undefined,
): void {
  if (!o) return
  for (const k of WATER_LOOK_KEYS) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) WATER_SETTERS[k](water, v)
  }
}

/** Sparse diff of `settings` against a baseline — the keys that differ. EXPORT
 *  diffs against the shipped defaults (→ a `water.look` block that layers on
 *  the global look); the per-slug working store diffs against the track's
 *  shipped look (defaults + committed) so it only shadows what you changed.
 *  Float-tolerant. */
export function diffLook(
  settings: WaterDebugSettings,
  base: WaterDebugSettings,
): WaterLookOverrides {
  const out: WaterLookOverrides = {}
  for (const k of WATER_LOOK_KEYS) {
    if (Math.abs(settings[k] - base[k]) > 1e-4) out[k] = settings[k]
  }
  return out
}

// ---- per-track working override store (machine-local, survives reload) ------

function trackStorageKey(slug: string): string {
  return `hoverbike.waterDebug.track.${slug}.${WATER_TRACK_STORAGE_VERSION}`
}

/** Load a track's machine-local working overrides (sparse). */
export function loadTrackOverrides(slug: string): WaterLookOverrides {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(trackStorageKey(slug))
  } catch {
    return {}
  }
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const p = parsed as Record<string, unknown>
  const out: WaterLookOverrides = {}
  for (const k of WATER_LOOK_KEYS) {
    const v = p[k]
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

/** Persist a track's working overrides (sparse). */
export function persistTrackOverrides(slug: string, o: WaterLookOverrides): void {
  try {
    window.localStorage.setItem(trackStorageKey(slug), JSON.stringify(o))
  } catch {
    // ignore — overrides still take effect for this session.
  }
}

/** Drop a track's working overrides (the per-scope RESET). */
export function clearTrackOverrides(slug: string): void {
  try {
    window.localStorage.removeItem(trackStorageKey(slug))
  } catch {
    // ignore.
  }
}

// ---- water-tuning scope service --------------------------------------------
//
// The water debug menu (lazily installed by the tuner host / boot) reads this
// to decide where edits persist, what RESET restores, and whether EXPORT is a
// track block. Boot sets it: a track sets `{ kind: 'track', slug, committed }`
// (committed = the JSON `water.look`), the lab / wave-rider leave it `global`.

export type WaterTuningScope =
  | { kind: 'global' }
  | { kind: 'track'; slug: string; committed: WaterLookOverrides }

let currentScope: WaterTuningScope = { kind: 'global' }

export function setWaterTuningScope(scope: WaterTuningScope): void {
  currentScope = scope
}

export function getWaterTuningScope(): WaterTuningScope {
  return currentScope
}
