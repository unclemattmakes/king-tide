# ADR 0005 — Drift: Mario-Kart-style mini-turbo, sim-side

**Status:** Accepted

## Context

The signature mechanic, "wave mastery," is the trick-hop system —
vertical/timing skill that pays off on wave crests. Tracks include long
land/flat-water sections (drowned urban canyons, ramp networks) where
wave-pump is silent. Without a second skill, those sections reduce to
"hold throttle and steer" with no skill expression.

Mario Kart's mini-turbo drift is the natural fit: a **lateral/spatial**
skill that complements wave-pump without diluting it. See
[drift-deep-dive.md](../drift-deep-dive.md) for the full research.

## Decision

Add a Mario-Kart-style time-based mini-turbo system as a sim-side ECS
system:

- New `DriftState` component on every bike, with state-machine fields
  (`driftDir`, `chargeS`, `highestTier`, etc).
- New `driftSystem(sim, phys)` runs every fixed tick after
  `trickHopSystem`, reading `intent.trickLeft/Right`, `intent.steer`,
  `intent.brake`, and `HoverState.isGrounded`.
- Drift activates when grounded + a trick button held + steer committed
  in the matching direction. On release with charge ≥ tier 1, fires a
  `BoostEffect` — the same one-shot multiplier path used by boost pads.
- Physics modulation lives in `hover.ts`'s ground branch: lateral drag
  scaled to 35%, yaw replaced by a drift-direction bias + reduced player
  authority.
- Two tiers (blue MT, orange SMT) with charge thresholds at 0.6 s and
  1.4 s. Purple UMT deferred to a follow-up milestone.
- Anti-snake: minimum 0.6 s hold before charge begins; 0.25 s cooldown
  between release and next activation.

The render-side game-feel layer (camera tilt, colored sparks at the rear
hover probes, skid audio) reads `DriftState` each frame and is gated by
the new `playerSettings.driftIntensity` — same `full / subtle / off`
pattern as `wavePumpIntensity`.

## Consequences

- **Drift coexists with wave-pump cleanly.** Drift only activates while
  grounded; the airborne trick window stays the trick system's
  exclusive territory. A flat-ground tap of Z/C still fires the existing
  small hop — the hop IS the drift initiator, matching MK's design.
- **Boost meter unaffected.** Drift fires its own `BoostEffect`,
  independent from the trick-charged `BoostMeter`. The two paths stack
  multiplicatively (intended — chain trick boost into drift boost).
- **Sim layer pure.** `driftSystem` reads ECS components only. The
  player setting `driftIntensity` is read in the render layer and on
  intent generation; the sim has no UI dependency. Multiplayer
  deterministic.
- **Pure-helper extraction lets tests pin tuning.** `tierFor`,
  `driftBoostParams`, `shouldStartDrift`, `shouldEndDrift` are exported
  pure functions — `tests/unit/drift.test.ts` locks the charge curve
  and state transitions without spinning up Rapier.
- **AI doesn't drift yet.** `aiControlSystem` doesn't set the trick
  buttons; AI ride lines stay at full grip. Closing this gap (M9.42+)
  will need an AI drift-line picker.
- **Bike archetypes (inside vs outside drift) deferred.** All bikes use
  the outward-drift defaults for now. The `BikeStatsData.driftStyle`
  field is the planned extension point.
