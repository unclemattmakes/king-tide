/**
 * The reserved gameplay-signal colour vocabulary — the single source of truth
 * for "spend the contrast/saturation budget on gameplay events."
 *
 * The legibility thesis (docs/painterly-legibility-plan.md, Part 5 → Track B →
 * B0): hold the world in a muted teal/sky band so the brightest, most-saturated
 * thing on screen is ALWAYS a gameplay event, then spend that reserved eye-grab
 * on a small, SACRED token set the player learns to parse at 40 m/s. This module
 * is that reserved palette in code. Later slices — rim-as-signal (B1), event
 * juice (B2), the flow-ribbon racing line (B3), the drift/charge ladder (B5),
 * and the HUD — all import these tokens rather than hard-coding hexes, so a
 * signal reads identically wherever it surfaces.
 *
 * THREE RULES THIS FILE ENCODES:
 *
 *  1. FORBID THESE EXACT HUES IN ENVIRONMENT ART. The grade (A2) + art review
 *     reserve this end of the saturation range for signals; props, terrain, sky,
 *     and water must stay out of these hues at this saturation (the muted
 *     world-band hexes live in art-direction.md "Appendix — palette families",
 *     deliberately desaturated relative to these). A boost cyan in a building
 *     albedo would read as a gameplay lie.
 *
 *  2. PRIMARY OPPOSITION IS BLUE/ORANGE, NOT RED/GREEN. Red/green is the most
 *     common colour-vision deficiency (deuteranopia/protanopia), so the load-
 *     bearing axis of the drift/charge ladder runs blue → orange → violet, and
 *     the green racing line is never the SOLE cue against a red hazard — see
 *     rule 3. (docs/painterly-legibility-plan.md Part 6.)
 *
 *  3. EVERY SIGNAL IS DOUBLE-CODED — colour + shape + motion — so it survives
 *     grayscale, colourblindness, AND peripheral vision (where colour acuity
 *     collapses but motion does not). Colour alone is never the channel. The
 *     `shape` and `motion` fields are the *intended* form for the consuming
 *     slice (particle silhouette, rim falloff, ribbon flow) — this module names
 *     them so the vocabulary stays coherent; it does not render them.
 *
 * COLOUR-SPACE CONTRACT (read before wiring a uniform):
 *  - `color` is a `THREE.Color`. Under three's default colour management the
 *    constructor reads the hex as sRGB and stores LINEAR working values in
 *    `.r/.g/.b`. That is exactly what an emissive / additive-rim / TSL colour
 *    node wants — feed `state.color` straight in, no conversion. The instances
 *    are FROZEN; clone before mutating (`state.color.clone()`).
 *  - `srgbHex` is the same colour as a `#rrggbb` sRGB string, for HUD/CSS/DOM
 *    (the "Regatta" painted UI, debug overlays) where sRGB is the right space.
 *  - `linear()` returns a fresh mutable `THREE.Color` if a consumer needs to
 *    tweak intensity per-instance without touching the shared frozen one.
 *
 * Render-layer module: importing THREE for `Color` is fine here. Do NOT import
 * this from the sim layer (`src/engine/sim/**`, `src/game/systems/**`) — signal
 * COLOUR is a render concern; signal STATE lives in the ECS stores the render
 * systems read. Pure + side-effect-free on import.
 */
import * as THREE from 'three'

/**
 * The reserved gameplay-signal states. Add a value here only with art-review
 * sign-off — every key burns a slice of the (small, finite) eye-grab budget,
 * and each must stay distinguishable by shape + motion, not just hue.
 */
export type SignalState = 'boost' | 'pickup' | 'hazard' | 'racingLineIdeal' | 'maxCharge'

/**
 * Intended silhouette for a signal — the form a consumer should give the
 * particle / rim falloff / ribbon so the signal survives grayscale. Naming the
 * shape keeps the vocabulary coherent across slices; this module does not draw.
 */
export type SignalShape = 'chevron' | 'ringBurst' | 'angular' | 'flowRibbon' | 'denseSparks'

/**
 * Intended motion for a signal — peripheral vision reads motion long after it
 * stops resolving colour, so motion is a first-class channel, not flavour.
 */
export type SignalMotion = 'lungeStreak' | 'pulse' | 'telegraph' | 'scrollForward' | 'glowRamp'

/** One double-coded token: a colour bound to its intended shape + motion. */
export interface SignalToken {
  /** Linear-space `THREE.Color` (sRGB hex in, linear working values out) — feed
   *  straight into emissive / additive-rim / TSL colour uniforms. FROZEN. */
  readonly color: THREE.Color
  /** Same colour as an sRGB `#rrggbb` string — for HUD/CSS/DOM. */
  readonly srgbHex: string
  /** Intended particle / rim / ribbon silhouette (double-coding). */
  readonly shape: SignalShape
  /** Intended motion behaviour (double-coding, peripheral-safe). */
  readonly motion: SignalMotion
  /** One-line note on the gameplay event this fires for. */
  readonly meaning: string
}

/** A token spec without the derived `THREE.Color` — the human-tunable source. */
type SignalSpec = Omit<SignalToken, 'color'>

/**
 * The declarative source of truth, one spec per state. sRGB hexes are saturated
 * and mutually distinct against the muted teal/sky world band, chosen so the
 * blue/orange axis carries the heaviest gameplay load (header rule 2). These are
 * PLAYTEST-VALIDATABLE starting values — the vocabulary (the keys + the shape/
 * motion coding) is locked; the exact hexes are tunable by eye.
 */
const SIGNAL_SPECS: Record<SignalState, SignalSpec> = {
  // Go / accelerate. Cool end of the blue/orange axis — "lunge."
  boost: {
    srgbHex: '#19E0FF',
    shape: 'chevron',
    motion: 'lungeStreak',
    meaning: 'boost pad hit / go — accelerate',
  },
  // Collectible. Off-axis magenta so a pickup never collides with the boost cyan
  // or the warm hazard/charge family.
  pickup: {
    srgbHex: '#FF2BD6',
    shape: 'ringBurst',
    motion: 'pulse',
    meaning: 'collectible available / collected',
  },
  // Danger / brake. Warm end of the blue/orange axis (red-leaning amber) — the
  // half of the primary opposition that stays deficiency-safe vs the boost cyan.
  hazard: {
    srgbHex: '#FF5A2A',
    shape: 'angular',
    motion: 'telegraph',
    meaning: 'hazard armed / brake / collision telegraph',
  },
  // Ideal racing/wave line. Green is reserved for "good path"; paired with
  // forward-scrolling flow so it never relies on hue alone against the hazard.
  racingLineIdeal: {
    srgbHex: '#2EE66B',
    shape: 'flowRibbon',
    motion: 'scrollForward',
    meaning: 'on the ideal racing / wave line',
  },
  // Peak drift/charge. Violet caps the blue→orange→violet ladder (below) and
  // sits clearly off both the cyan and the warm hazard.
  maxCharge: {
    srgbHex: '#A24BFF',
    shape: 'denseSparks',
    motion: 'glowRamp',
    meaning: 'drift / charge meter full — release for max payoff',
  },
}

/** Build a frozen token from a spec — derives the linear colour from the hex. */
function makeToken(spec: SignalSpec): SignalToken {
  return Object.freeze({
    // sRGB hex in → LINEAR working values in `.r/.g/.b` (header colour-space
    // contract); `srgbHex` round-trips back via `.getHexString()`.
    color: Object.freeze(new THREE.Color(spec.srgbHex)),
    srgbHex: spec.srgbHex,
    shape: spec.shape,
    motion: spec.motion,
    meaning: spec.meaning,
  })
}

/**
 * THE LOCKED VOCABULARY. The sacred token set every legibility slice imports.
 * Frozen so a consumer can't accidentally mutate a shared signal colour; clone
 * (`.color.clone()` or `linear(state)`) before per-instance tweaks.
 */
export const SIGNAL_COLORS: Readonly<Record<SignalState, SignalToken>> = Object.freeze({
  boost: makeToken(SIGNAL_SPECS.boost),
  pickup: makeToken(SIGNAL_SPECS.pickup),
  hazard: makeToken(SIGNAL_SPECS.hazard),
  racingLineIdeal: makeToken(SIGNAL_SPECS.racingLineIdeal),
  maxCharge: makeToken(SIGNAL_SPECS.maxCharge),
})

/**
 * The drift / charge ladder, in ascending order. Mario-Kart mini-turbo grammar
 * mapped onto the deficiency-safe **blue → orange → violet** axis (NOT
 * red/green): a low charge reads blue, mid reads warm, full reads violet — and
 * the consuming slice (B5) MUST also ramp spark DENSITY so the stage reads in
 * peripheral view and in grayscale. `maxCharge` is the shared top rung, so the
 * "full" payoff colour matches everywhere it surfaces (bike rim, HUD, burst).
 */
export const CHARGE_LADDER: readonly SignalToken[] = Object.freeze([
  Object.freeze({
    color: Object.freeze(new THREE.Color('#2A7BFF')),
    srgbHex: '#2A7BFF',
    shape: 'denseSparks',
    motion: 'glowRamp',
    meaning: 'drift charging — stage 1 (blue)',
  }),
  Object.freeze({
    color: Object.freeze(new THREE.Color('#FF8A2A')),
    srgbHex: '#FF8A2A',
    shape: 'denseSparks',
    motion: 'glowRamp',
    meaning: 'drift charging — stage 2 (orange)',
  }),
  // Top rung is the shared maxCharge token so "full" is identical everywhere.
  SIGNAL_COLORS.maxCharge,
] as const)

/**
 * A fresh, MUTABLE linear-space `THREE.Color` for a signal state — use when a
 * consumer needs to scale intensity / lerp per instance without disturbing the
 * frozen shared token (e.g. driving a per-bike `rimColor` uniform that pulses).
 */
export function linear(state: SignalState): THREE.Color {
  return SIGNAL_COLORS[state].color.clone()
}
