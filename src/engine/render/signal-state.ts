/**
 * Style-as-legibility signal STATE — the render-side bridge between gameplay
 * events (read from the ECS) and the additive rim that paints them
 * (illustrative-lighting.ts `buildIllustrativeRim`). This is the "B1 → B5"
 * slice of docs/painterly-legibility-plan.md: the reserved signal COLOURS live
 * in signal-colors.ts (the locked vocabulary); this module decides WHEN each
 * bike wears one and how strong, and holds it where the render systems can read
 * it back per frame.
 *
 * ── The master flag (the one switch that keeps the shipped look frozen) ───────
 * EVERY visible signal is gated behind `signalsEnabled`, which DEFAULTS OFF.
 * With it off, the per-bike signal store stays empty / zero-strength, the rim
 * uniforms never leave 0, and the frame is byte-identical to today — the same
 * way the water-readability layers ship default-off awaiting a playtest
 * (water-next-research §5). The owner flips it on for a playtest via a hook
 * (see `parseSignalsFlag`); nothing turns on by itself.
 *
 * ── Why a per-eid store and not direct uniform writes ─────────────────────────
 * The producer of the drift/charge signal is the FX system (fx/index.ts), which
 * already iterates every bike entity with its `DriftStateStore` read-only. The
 * consumer is the bike render layer: the player bike on the per-clone path
 * (its vinyl material carries a per-OBJECT rim uniform) and the AI/peer bikes on
 * the instanced path (a per-INSTANCE rim attribute — instanced-bikes.ts). The
 * two systems are constructed independently in the boot files and share no
 * handle, and the authoritative entity→render-instance mapping lives inside
 * `createBikeRenderSystem` (render-systems.ts). So the decoupled seam is: FX
 * WRITES a per-eid signal here; the render layer READS it back keyed by the eid
 * it already owns. No system reaches into another's internals, and the sim layer
 * is never touched (this module is render-only — importing THREE for `Color` is
 * fine; do NOT import it from `src/engine/sim/**` or `src/game/systems/**`).
 *
 * Pure data + a boolean. Side-effect-free on import.
 */
import * as THREE from 'three'
import { CHARGE_LADDER, linear, type SignalState } from './signal-colors'

// ── Master flag ──────────────────────────────────────────────────────────────

/** Module-private master switch. DEFAULT OFF so the shipped look is unchanged
 *  until the owner enables signals in a playtest. */
let enabled = false

/** Is the style-as-legibility signal system on? Every consumer checks this and
 *  treats "off" as "no signal" (zero strength), so off == today's look exactly. */
export function signalsEnabled(): boolean {
  return enabled
}

/**
 * Toggle the whole signal system. The producer (FX) and consumers (bike rim)
 * read {@link signalsEnabled} each frame, so flipping this live takes effect on
 * the next tick — and flipping it OFF lets the consumers clear themselves back
 * to zero strength (today's look) without a reload.
 */
export function setSignalsEnabled(on: boolean): void {
  enabled = on
}

/**
 * Boot hook for the URL-param surface (`?signals=1`). Kept here — not in
 * url-modes.ts — so this slice owns its own flag parsing; url-modes.ts only has
 * to forward the query string (the one-line wiring is reported as a deferred
 * follow-up, since url-modes.ts is being edited elsewhere). Accepts `1`/`true`/`on`
 * (case-insensitive) as on, `0`/`false`/`off` as an explicit off; anything else
 * leaves the current value. Returns the resulting state for logging.
 */
export function parseSignalsFlag(search: string | URLSearchParams): boolean {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const raw = params.get('signals')
  if (raw !== null) {
    const v = raw.trim().toLowerCase()
    if (v === '' || v === '1' || v === 'true' || v === 'on') enabled = true
    else if (v === '0' || v === 'false' || v === 'off') enabled = false
  }
  return enabled
}

// ── Per-bike signal store ─────────────────────────────────────────────────────

/** One bike's current rim signal: a linear-RGB colour + an additive strength
 *  (0 = no rim). Strength 0 is the canonical "no signal" state — a consumer that
 *  reads strength 0 must leave the rim exactly as the unsignalled material.
 *  Mutable so a producer can own one per eid and refill it each frame (via the
 *  `fill*` helpers) without allocating; the store keeps it by reference. */
export interface BikeRimSignal {
  /** Linear-space rim colour (feed straight into the additive-rim `uColor`
   *  uniform / the per-instance rim attribute — see the colour-space contract in
   *  signal-colors.ts). Mutated in place by the `fill*` helpers (never reassigned). */
  color: THREE.Color
  /** Additive rim strength. 0 = off. Typical signalled range ~0.3–1.2; the
   *  consumer clamps as needed. */
  strength: number
}

/** Per-eid signal map. Sparse: an absent eid means "no signal" (the consumer
 *  uses {@link NO_SIGNAL}). Cleared keys (despawn) are pruned by the producer. */
const bikeSignals = new Map<number, BikeRimSignal>()

/** The canonical "no signal" value a consumer falls back to for an unsignalled
 *  (or master-flag-off) bike. Strength 0 ⇒ the rim stays at the material's
 *  default (off), so the look is unchanged. Colour is irrelevant at strength 0
 *  but kept black so a careless `color.mul(strength)` is also zero. */
export const NO_SIGNAL: Readonly<BikeRimSignal> = Object.freeze({
  // A real (frozen) black THREE.Color; consumers branch on `strength > 0` before
  // touching the colour, but a real Color makes a careless `.clone()` / uniform
  // copy safe too. Frozen so it can never be mutated through a stale reference.
  color: Object.freeze(new THREE.Color(0, 0, 0)),
  strength: 0,
})

/**
 * Record bike `eid`'s current rim signal (called by the FX producer each frame).
 * No-op when the master flag is off — so the store stays empty and every
 * consumer reads {@link NO_SIGNAL}, keeping the frame byte-identical to today.
 * Stores the passed object by reference; the producer owns reusable instances.
 */
export function setBikeSignal(eid: number, signal: BikeRimSignal): void {
  if (!enabled) return
  bikeSignals.set(eid, signal)
}

/** Clear bike `eid`'s signal (despawn, or it stopped signalling this frame). */
export function clearBikeSignal(eid: number): void {
  bikeSignals.delete(eid)
}

/** Read bike `eid`'s current rim signal, or {@link NO_SIGNAL} when it has none
 *  (or the master flag is off). Never returns null, so consumers branch only on
 *  `strength > 0`. */
export function getBikeSignal(eid: number): Readonly<BikeRimSignal> {
  if (!enabled) return NO_SIGNAL
  return bikeSignals.get(eid) ?? NO_SIGNAL
}

/** Drop every stored signal — call when a race tears down so eids don't leak
 *  across sessions. (Cheap; the map is small.) */
export function clearAllBikeSignals(): void {
  bikeSignals.clear()
}

// ── Signal computation (the gameplay-state → colour mapping) ──────────────────

/**
 * Tunables for the drift/charge ladder rim (B5). The LADDER COLOUR is the primary
 * cue — it steps blue → orange → violet as the mini-turbo tier climbs, mirroring
 * the coloured drift sparks (fx/index.ts) but on the silhouette so it reads in
 * peripheral view. Strength ramps up over the first moments of a drift (so a bike
 * that just started drifting glows softer than one mid-charge) then holds near
 * full while the colour does the talking. `DriftState.chargeS` is CUMULATIVE
 * across the whole drift (not reset per tier), so the ramp saturates early and the
 * tier colour carries the rest. All playtest-tunable; the vocabulary (the ladder
 * colours) is locked in signal-colors.ts.
 */
export const CHARGE_RIM_TUNING = {
  /** Rim strength the instant a drift starts charging (tier 1, chargeS ≈ 0). */
  baseStrength: 0.45,
  /** Extra strength added as the drift charges, on top of `baseStrength`. */
  rampStrength: 0.35,
  /** Charge seconds (cumulative) over which `rampStrength` fills in — kept short
   *  so the rim reaches near-full early and the moving signal is then the tier
   *  COLOUR, not a slow brightness creep. */
  rampSeconds: 0.6,
  /** Peak (top-rung / maxCharge / UMT) gets a flat bonus so "full — release now"
   *  is the brightest the bike ever rims. */
  peakBonus: 0.25,
} as const

/** Allocate a zeroed, mutable per-eid signal a producer can own and refill each
 *  frame (so the per-frame loop allocates nothing). Colour starts black /
 *  strength 0 = no signal. */
export function makeRimSignal(): BikeRimSignal {
  return { color: new THREE.Color(0, 0, 0), strength: 0 }
}

/**
 * Fill `out` from a bike's drift/charge state and return whether it's signalling.
 * `highestTier` is `DriftState.highestTier` (0 = none, 1 = blue MT, 2 = orange
 * SMT, 3 = violet UMT) and picks the ladder COLOUR; `chargeS` is the live
 * (cumulative) `DriftState.chargeS`, used to ramp the rim STRENGTH up early in the
 * drift (see CHARGE_RIM_TUNING). Returns `false` (leaving `out` untouched) when
 * the bike isn't charging — the caller then clears that eid's signal.
 *
 * Writes into the caller-owned `out` (no shared scratch), so a producer can call
 * this once per eid in a frame without aliasing. The ladder→colour mapping lives
 * only here, so every surface that shows the charge tier stays consistent.
 */
export function fillChargeRimSignal(
  out: BikeRimSignal,
  highestTier: number,
  chargeS: number,
): boolean {
  if (highestTier <= 0) return false
  // Ladder rungs are 1-indexed by tier; clamp to the top rung so a tier beyond
  // the ladder (defensive) still reads as max.
  const rung = Math.min(highestTier, CHARGE_LADDER.length) - 1
  const token = CHARGE_LADDER[rung]
  if (!token) return false
  const { baseStrength, rampStrength, rampSeconds, peakBonus } = CHARGE_RIM_TUNING
  const ramp = rampSeconds > 0 ? Math.min(1, Math.max(0, chargeS) / rampSeconds) : 1
  const isPeak = rung >= CHARGE_LADDER.length - 1
  out.color.copy(token.color)
  out.strength = baseStrength + rampStrength * ramp + (isPeak ? peakBonus : 0)
  return true
}

/**
 * Fill `out` from a discrete signal STATE (boost/pickup/hazard/…) at a given
 * strength — the general path for the non-drift signals (e.g. the rival/draft
 * hook). Writes into the caller-owned `out`; kept here so every "state → rim"
 * decision lives in one module.
 */
export function fillStateRimSignal(out: BikeRimSignal, state: SignalState, strength: number): void {
  out.color.copy(linear(state))
  out.strength = Math.max(0, strength)
}

// ── Rival / slipstream hook (B1) — PLUMBING ONLY, awaiting a sim state ─────────

/**
 * Drafting role between the local player and a rival, from the PLAYER's point of
 * view — the two halves of the TF2 "assess the threat" rim:
 *  - `inDraftOf`: you are sitting in this rival's slipstream (good for you — close
 *    the gap). Rims the rival CYAN (the `boost` go-signal).
 *  - `draftingYou`: this rival is sitting in YOUR slipstream (they're gaining —
 *    a threat). Rims the rival WARM (the `hazard` brake/telegraph signal).
 */
export type DraftRole = 'inDraftOf' | 'draftingYou'

/** Map a draft role to its reserved signal hue (B1's cyan/warm pair). */
const DRAFT_ROLE_STATE: Record<DraftRole, SignalState> = {
  inDraftOf: 'boost', // cyan — you're drafting them
  draftingYou: 'hazard', // warm — they're drafting you
}

/** Default rim strength for the rival hook (playtest-tunable). */
export const RIVAL_RIM_STRENGTH = 0.7

/**
 * Fill `out` for a rival's draft role (B1's cyan/warm pair) — the MULTI-RIVAL-safe
 * way to produce the draft rim. Writes the role's reserved hue + strength into the
 * caller-owned `out` and returns it, so a producer that owns ONE `BikeRimSignal`
 * PER EID can resolve every rival in a frame without aliasing. Pure: touches only
 * `out` (no shared scratch, no store write — the caller publishes via
 * {@link setBikeSignal}), so it's also unaffected by the master flag (the caller
 * gates). The role→colour mapping lives here so every surface agrees.
 *
 * Prefer this over {@link signalRivalDraft} whenever more than one rival can be
 * lit in the same frame: `signalRivalDraft` shares a single module scratch and
 * stores it BY REFERENCE, so calling it for several rivals in one frame aliases
 * them all to the last rival's colour. This helper has no such hazard.
 */
export function fillDraftRimSignal(
  out: BikeRimSignal,
  role: DraftRole,
  strength = RIVAL_RIM_STRENGTH,
): BikeRimSignal {
  fillStateRimSignal(out, DRAFT_ROLE_STATE[role], strength)
  return out
}

/** Reusable signal for the single-rival hook below (a multi-rival driver owns its
 *  own per-eid set via {@link fillDraftRimSignal} instead — see its note). */
const rivalScratch: BikeRimSignal = { color: new THREE.Color(0, 0, 0), strength: 0 }

/**
 * HOOK (plumbing): rim rival bike `eid` for the given draft role — the SINGLE-rival
 * convenience built on {@link fillDraftRimSignal}. The colour mapping + publish are
 * done; the caller supplies the draft relationship.
 *
 * ⚠️ SINGLE-RIVAL ONLY. This shares one module scratch and stores it BY REFERENCE,
 * so calling it for MULTIPLE rivals in the same frame aliases them all to the last
 * rival's colour. A multi-rival producer (e.g. the render-side draft detector in
 * fx/index.ts, which lights at most one "you're drafting them" + one "they're
 * drafting you" each frame) must instead own a `BikeRimSignal` per eid and fill it
 * with {@link fillDraftRimSignal}, then publish via {@link setBikeSignal}.
 *
 * No-op while the master flag is off. Kept for a dev harness / single-rival caller.
 */
export function signalRivalDraft(
  eid: number,
  role: DraftRole,
  strength = RIVAL_RIM_STRENGTH,
): void {
  if (!enabled) return
  setBikeSignal(eid, fillDraftRimSignal(rivalScratch, role, strength))
}

// ── Boot auto-init (browser only) ─────────────────────────────────────────────

// Auto-parse `?signals=1` from the URL on first import so the flag works in a
// playtest WITHOUT any url-modes.ts wiring (that one-liner is a REPORTED
// follow-up, not a blocker — this module is imported eagerly by the FX +
// pickup-render systems, so the parse runs at boot). Safe re: sim determinism —
// this flag only affects the RENDER layer (the additive rim + the pickup glow),
// never the sim, so unlike the sim feel-flags it doesn't need a fixed set order
// from main.ts. A dev console hook (`window.__signals`) flips it live, no reload.
if (typeof window !== 'undefined') {
  try {
    parseSignalsFlag(window.location.search)
  } catch {
    // Non-browser / odd location — ignore; stays default-off.
  }
  if (import.meta.env.DEV) {
    ;(
      window as unknown as {
        __signals?: {
          enable: () => void
          disable: () => void
          isEnabled: () => boolean
          get: (eid: number) => Readonly<BikeRimSignal>
        }
      }
    ).__signals = {
      enable: () => setSignalsEnabled(true),
      disable: () => setSignalsEnabled(false),
      isEnabled: signalsEnabled,
      get: getBikeSignal,
    }
  }
}
