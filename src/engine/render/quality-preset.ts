/**
 * Quality preset ladder — the "run on various devices" knob.
 *
 * The 2026-06 frame ablation (docs/perf-baseline.md) measured every
 * structural render cost on the iGPU class and proved the game is CPU-bound
 * there at 720p. The dressed tracks now clear 60 fps on that box, but the
 * tiers BELOW it — Safari/Firefox on the WebGL2 fallback (no WebGPU →
 * software-ish path), low-end laptops, phones — need the heavy passes shed.
 * Every lever the ablation found a number for is composed here into three
 * tiers, plus an `auto` that picks one from the device signals at boot.
 *
 * Measured lever values (nitro-deck iGPU, 720p, 8 bikes; perf-baseline.md):
 *   - shadow PASS off (`?shadows=0`): +19–27 fps (the single biggest lever;
 *     it's the depth-map render of terrain + casters, CPU-side)
 *   - post/bloom off (`?post=0`): +24 fps on sandbar (~free on a CPU-wall
 *     track like the dressed city)
 *   - reflection pass off (`?reflect=0`, post-#371-cull): +16 fps sandbar
 *   - MSAA off (`?aa=off`): ~1 ms GPU at 720p (a fill lever — matters more
 *     as resolution climbs / on weak GPUs)
 *   - water mesh 512²→384²: a vertex lever, modest
 *   - shadow map 1024²→512²: ~free on this box but a real win where the
 *     depth pass is fill-bound (high-DPI / weak GPU)
 *
 * Each render read-site keeps its existing `?param` URL override and falls
 * back to the active tier's knob ONLY when the param is absent — so the
 * ablation flags (and `?quality=<tier>`) still win for testing, and the
 * preset is just the default when nothing's forced.
 *
 * Resolution happens once, in `createRenderer` (the first thing that learns
 * the real backend), via `resolveQuality` + `setActiveQuality`. Everything
 * built afterwards (scene shadow map, sky post, water) reads
 * `getActiveQuality()`.
 *
 * NOT in the preset: `pixelRatio` / `framerateCap` — those are independent
 * user sliders (Settings → Video) we don't want a preset to silently stomp.
 * Render scale is the obvious next lever to fold into Low; left out of this
 * slice so the persisted slider stays the source of truth.
 */
import type { RenderBackend } from './renderer'

export type QualityPreset = 'auto' | 'high' | 'medium' | 'low'

/** The four selectable preset values, for Settings validation / UI. */
export const QUALITY_PRESETS: readonly QualityPreset[] = ['auto', 'high', 'medium', 'low']

/** Concrete render knobs a tier resolves to. */
export interface QualityKnobs {
  /** Sun shadow-map pass on at all (`renderer.shadowMap.enabled`). */
  shadows: boolean
  /** Sun shadow-map resolution (square). Ignored when `shadows` is false. */
  shadowMapSize: number
  /** MSAA on the main colour pass. */
  msaa: boolean
  /** Planar water reflection pass (already layer-culled since #371). */
  reflection: boolean
  /** Water mesh subdivisions per side. */
  waterSubdivisions: number
  /** Bloom / post pipeline built at all. */
  bloom: boolean
}

const HIGH: QualityKnobs = {
  shadows: true,
  shadowMapSize: 1024,
  msaa: true,
  reflection: true,
  waterSubdivisions: 512,
  bloom: true,
}

// Medium sheds the cheap-to-lose GPU fill (MSAA, half-res shadow map) but
// keeps the look intact — shadows, reflections, bloom, full water mesh.
const MEDIUM: QualityKnobs = {
  shadows: true,
  shadowMapSize: 512,
  msaa: false,
  reflection: true,
  waterSubdivisions: 512,
  bloom: true,
}

// Low sheds the big structural passes — the whole shadow pass (the measured
// +19–27 fps), the reflection pass, the post/bloom pipeline, MSAA — and
// drops the water mesh density. For devices that otherwise can't hold 60.
const LOW: QualityKnobs = {
  shadows: false,
  shadowMapSize: 512,
  msaa: false,
  reflection: false,
  waterSubdivisions: 384,
  bloom: false,
}

const TIERS: Record<Exclude<QualityPreset, 'auto'>, QualityKnobs> = {
  high: HIGH,
  medium: MEDIUM,
  low: LOW,
}

export interface DeviceContext {
  backend: RenderBackend
  isDeck: boolean
}

/**
 * Pick a concrete tier from device signals when the preset is `auto`.
 * Conservative + reliable signals only:
 *  - WebGL2 backend → the WebGPU probe failed (Safari/Firefox today, or a
 *    blocked adapter): treat as a weak/fallback device → Low.
 *  - Steam Deck → a known fixed mid-tier APU at 1280×800/60 → Medium.
 *  - else (a real WebGPU adapter on desktop/laptop) → High.
 * GPU-string heuristics are deliberately avoided — they're fragile across
 * drivers/translation layers; backend + deck are the signals we trust.
 */
export function autoTier(ctx: DeviceContext): Exclude<QualityPreset, 'auto'> {
  if (ctx.backend === 'webgl2') return 'low'
  if (ctx.isDeck) return 'medium'
  return 'high'
}

/** Resolve a preset (+ device context for `auto`) to a tier name + knobs. */
export function resolveQuality(
  preset: QualityPreset,
  ctx: DeviceContext,
): { tier: Exclude<QualityPreset, 'auto'>; knobs: QualityKnobs } {
  const tier = preset === 'auto' ? autoTier(ctx) : preset
  return { tier, knobs: TIERS[tier] }
}

// ── Active singleton (set once at boot, read by later-constructed systems) ──

let active: QualityKnobs = HIGH
let activeTier: Exclude<QualityPreset, 'auto'> = 'high'

/** Publish the resolved knobs. Called once from `createRenderer`. */
export function setActiveQuality(tier: Exclude<QualityPreset, 'auto'>, knobs: QualityKnobs): void {
  activeTier = tier
  active = knobs
}

/** The knobs in force this session (defaults to High before boot resolves). */
export function getActiveQuality(): QualityKnobs {
  return active
}

/** The tier name in force — for the perf HUD / boot log / Settings echo. */
export function getActiveTier(): Exclude<QualityPreset, 'auto'> {
  return activeTier
}
