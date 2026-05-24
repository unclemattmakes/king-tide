# Drift — research + design + implementation plan

Reference for the Mario Kart-style mini-turbo drift mechanic added in
M9.41+. Drift complements the existing wave-pump (vertical/timing) skill
with a lateral/spatial skill so every track section has a charging
option — wave-pump owns water sections, drift owns flat-water and land
corners.

## Mario Kart drift lineage (1992 → present)

| Title | Year | What it added |
|---|---|---|
| Super Mario Kart | 1992 | Drift existed only as a way to **not spin out** in corners. No boost reward. |
| Mario Kart 64 | 1996 | **Mini-turbo**: hold drift, wiggle stick left/right, smoke goes yellow → orange/red, release for a small boost. |
| Double Dash / DS | 2003/2005 | Wiggle technique refined; **"snaking"** emerged — chaining alternating mini-turbos on straights. Created a competitive-vs-casual rift. |
| Wii | 2008 | **Pivot point.** Switched from wiggle to time-based charging — hold the drift, sparks appear after a threshold, release for boost. Snaking died. Also added **inside-drift bikes** (sport bikes that drift toward the apex with a tight initial cut but wider overall arc). |
| Mario Kart 7 | 2011 | Added trick-hops as a separate mechanic layered on top of drift. |
| Mario Kart 8 / Deluxe | 2014/2017 | Two-tier mini-turbo: **blue (MT) → orange (SMT)**. Deluxe added **purple Ultra Mini-Turbo (UMT)** as a third tier. |
| Mario Kart World | 2024 | Made drift effectively mandatory — game pace assumes constant drift-charging. |

### Persistent design principles

1. **Hop initiates the drift.** Visual + audio cue, clear commitment moment.
2. **Time-based charging beat wiggle.** Accessibility win; lower floor, same ceiling.
3. **Color-coded progression** (blue → orange → purple). Players read charge state without looking at a meter.
4. **Risk/reward**: drift = tighter corners but committed direction. You can't redirect easily mid-slide.
5. **Vehicle archetypes** (inside vs. outside drift). Bike personality without per-bike physics rewrites.
6. **Camera tilt + skid audio.** Sells the slide more than the physics do.
7. **Anti-snake mechanics** (minimum hold time, cooldown). Required to prevent straightaway abuse.

## Hoverbike fit — the tension

The signature mechanic is *already* called "wave mastery" but it's the
**trick-hop** system (vertical/timing). MK drift is **lateral/spatial**.
These don't conflict — they complement.

| Skill axis | Mechanic | Where it shines |
|---|---|---|
| Vertical / timing | Wave-pump trick | Wave-heavy water sections |
| Lateral / spatial | Drift mini-turbo | Tight urban canyons, dry-land switchbacks |

The risk: drift dilutes wave-pump identity if it dominates charging.
The opportunity: drift becomes the "land equivalent" of wave-pumping,
so drowned-city tracks (mixed terrain) demand both skills.

## Design decisions

### Input — overload Z/C (trickLeft / trickRight)

- **Tap Z/C** → existing trick / small hop (unchanged).
- **Hold Z/C while grounded + steering** → drift in that direction.
- **Release** → fire mini-turbo if charged.

This mirrors Mario Kart's hop-initiates-drift convention. The small hop
that fires on a flat-ground press *is* the drift initiator's visible
tell — same as MK's hop. On wave crests, the press is buffered as a
trick by `trickHopSystem`; drift never activates mid-air, so wave-pump
keeps its priority.

**Cancel conditions** (any one):
- Button released.
- Ungrounded for > 300 ms.
- Brake held > 0.5.

### Direction commit

- Hold Z (trickLeft) + steer left → drift left.
- Hold C (trickRight) + steer right → drift right.
- Steer must be **committed** (|steer| ≥ 0.1, sign matching button).
- Charge ticks only while committed; counter-steer pauses (but doesn't
  cancel) the charge.

### Charge tiers — three tiers (MT8DX parity)

| Tier | Color | Charge time | Boost mult | Duration |
|---|---|---|---|---|
| 0 | none | < 0.6 s | — | — |
| 1 (MT) | blue | 0.6–1.4 s | 1.30× | 0.8 s |
| 2 (SMT) | orange | 1.4–2.4 s | 1.55× | 1.4 s |
| 3 (UMT) | purple | ≥ 2.4 s | 1.80× | 2.0 s |

Tuning targets a clear "this paid off" feel without breaking topSpeed
balance. `topSpeed × 1.55 = ~43.4 m/s`, comparable to a mid-strength
boost pad. The UMT tier is only reachable on long sweeping corners
(the SE→SW→NW arc on the Drift Practice Range, for instance) — a
casual hold lands on SMT.

### Boost delivery

Release fires a `BoostEffect` (the same one-shot path boost pads use).
Reasons:
- Independent from the trick-charged `BoostMeter` — drift doesn't
  dilute the wave-pump reward.
- Already wired into `hover.ts` via `getCurrentBoostMultiplier`.
- Stacks multiplicatively with the boost meter (intentional — chain a
  trick boost into a drift boost for the speedrun reward).

### Physics during drift

In `applyGroundBranch`:
- **Lateral drag** scaled to 35 % of base — visible slide.
- **Yaw**: replace base steer torque with a speed-tapered auto-turn-in
  bias + a full-authority counter-steer term (`driftYawFraction`, a
  pure exported helper). At full speed:
  - No steer → `0.45×` turnTorque in the drift direction (~28 m radius
    at 20 m/s — a WIDE arc, not a spiral).
  - Steer into drift → up to `~0.9×` — tightens the line.
  - Counter-steer (hold away) → `~0×` or slightly negative — opens the
    drift to a wide / straight line. **This is the knob that makes it
    feel like MK** rather than a fixed inward spiral.
  - The bias tapers to 0 below `DRIFT_YAW_SPEED_REF` (8 m/s) so a drift
    that has bled speed stops auto-rotating (no low-speed 180 spin-out);
    counter-steer keeps full authority at any speed.
- **Forward thrust** unaffected — drift doesn't kill speed (matches MK feel).

### Game feel — render layer

- **Camera roll** of ~5° / 7° / 9° toward the drift direction (tier 1
  / 2 / 3), eased over ~150 ms.
- **Drift sparks** from the outside-rear corner of the bike — three
  layered pools in `src/engine/render/fx/index.ts`:
  - blue (MT) — fires whenever `highestTier >= 1`
  - orange (SMT) — added on top once `highestTier >= 2`
  - purple (UMT) — added on top once `highestTier >= 3`
- **HUD tier badge** — small circular indicator at the bottom-left,
  next to the boost meter. Color + label switches by tier (blue MT
  / orange SMT / purple UMT). Tier-up pulse on each upgrade. Source:
  `src/engine/render/drift-tier-hud.ts`. Always visible during drift
  unless `playerSettings.driftIntensity === 'off'`.
- **Skid audio** — continuous tyre-scrape loop (`audio.driftSkid`),
  a band-passed noise layer at ~2.6 kHz whose level + brightness
  scale with speed while drifting. Plus a one-shot release whoosh
  (`audio.driftBoost`) whose bell pitch climbs with tier (A5 / C#6
  / E6 across MT / SMT / UMT). Both gated by `driftIntensity`
  (off = silent, subtle = half-level skid). The boost reward itself
  is applied in the sim, so a frame-dropped whoosh never costs the
  player the actual mini-turbo.

### Anti-snake

- **Minimum hold time** (0.6 s) before charge begins — straight-line
  presses give no payoff.
- **Cooldown** (0.25 s) between release and next drift activation.
- **Counter-steer** doesn't cancel but doesn't charge either — discourages
  wiggle-snake (which doesn't work here anyway given the time-based
  charging).

### Bike archetypes — inside vs outside drift

`BikeStatsData.driftStyle` is the per-variant knob:

- **Outward** (Cruiser, Racer, Scout — `driftStyle` undefined): MK-
  default, hugs the apex with a stable flat-bias arc.
- **Inward** (Sparrow, Stunt): sport-bike feel — tighter initial cut,
  wider overall arc. +20 % yaw bias spike for the first
  `INWARD_INITIAL_WINDOW_S` (250 ms), then −20 % for the rest of the
  drift. Combined with the Sparrow's 5.5 turnTorque (vs the 4.0
  default), the initial cut is dramatic.

Tuning constants live in `hover.ts` (`INWARD_INITIAL_BIAS_MUL`,
`INWARD_TAIL_BIAS_MUL`, `INWARD_INITIAL_WINDOW_S`). Variants in
`src/game/bikes/variants.ts` opt in via `driftStyle: 'inward'`.

## Implementation map

| File | Change |
|---|---|
| `src/game/components/index.ts` | Add `DriftState` component + store |
| `src/game/entities/bike.ts` | Initialize `DriftState` in `createBike` |
| `src/game/systems/drift.ts` | New file: pure helpers + `driftSystem` |
| `src/game/sim-step.ts` | Wire `driftSystem` after `trickHopSystem` |
| `src/game/systems/hover.ts` | Read `DriftState` in ground branch; modulate lateral drag + yaw |
| `src/engine/player-settings.ts` | Add `driftIntensity: 'full' \| 'subtle' \| 'off'` |
| `src/engine/menus/settings-overlay.ts` | Add a "Drift assist" row in Gameplay |
| `tests/unit/drift.test.ts` | Pure-helper unit tests |
| `docs/adr/0005-drift-mechanic.md` | Short architectural record |

## Tuning knobs at a glance

| What | Where | Default | Range |
|---|---|---|---|
| Tier 1 charge threshold | `TIER_1_THRESHOLD_S` in `drift.ts` | 0.6 s | 0.3–1.0 s — lower = easier MTs |
| Tier 2 charge threshold | `TIER_2_THRESHOLD_S` | 1.4 s | 1.0–2.0 s |
| Tier 3 (UMT) charge threshold | `TIER_3_THRESHOLD_S` | 2.4 s | 2.0–3.0 s |
| Tier 1 boost multiplier | `DRIFT_BOOST_MUL_T1` | 1.30 | 1.15–1.45 |
| Tier 2 boost multiplier | `DRIFT_BOOST_MUL_T2` | 1.55 | 1.40–1.75 |
| Tier 3 boost multiplier | `DRIFT_BOOST_MUL_T3` | 1.80 | 1.65–1.95 |
| Tier 1 boost duration | `DRIFT_BOOST_DURATION_T1` | 0.8 s | 0.5–1.2 s |
| Tier 2 boost duration | `DRIFT_BOOST_DURATION_T2` | 1.4 s | 1.0–1.8 s |
| Tier 3 boost duration | `DRIFT_BOOST_DURATION_T3` | 2.0 s | 1.6–2.5 s |
| Lateral-drag scale while drifting | `DRIFT_LATERAL_DRAG_SCALE` in `hover.ts` | 0.35 | 0.2–0.6 — lower = more slide |
| Drift auto-turn-in bias (× turnTorque) | `DRIFT_YAW_BIAS_FRAC` | 0.45 | 0.3–0.6 — higher = tighter default arc |
| Counter-steer authority while drifting | `DRIFT_STEER_FRAC` | 0.65 | 0.5–0.9 — must be ≳ bias/0.7 so full counter-steer opens the drift |
| Low-speed bias taper knee | `DRIFT_YAW_SPEED_REF` | 8 m/s | below this the auto-turn-in fades → no 180 spin-out |
| Inward-drift spike window | `INWARD_INITIAL_WINDOW_S` | 0.25 s | 0.15–0.40 s |
| Inward-drift spike scale | `INWARD_INITIAL_BIAS_MUL` | 1.2 | 1.1–1.4 |
| Inward-drift tail scale | `INWARD_TAIL_BIAS_MUL` | 0.8 | 0.6–0.9 |
| Ungrounded-cancel timeout | `UNGROUNDED_CANCEL_S` | 0.3 s | — |
| Steer-commit threshold | `STEER_COMMIT_THRESHOLD` | 0.1 | — |
| Drift cooldown after release | `DRIFT_COOLDOWN_S` | 0.25 s | — |
| Camera roll on drift, T1/T2/T3 | `game-loop.ts` | 5° / 7° / 9° | 0–12° |
| Drift spark rate (blue MT) | `DRIFT_SPARK_RATE_T1` in `fx/index.ts` | 70 /s | 40–120 /s |
| Drift spark rate (orange SMT) | `DRIFT_SPARK_RATE_T2` | 110 /s | 60–150 /s |
| Drift spark rate (purple UMT) | `DRIFT_SPARK_RATE_T3` | 90 /s | 60–130 /s |
| Per-surface lateral grip | `SURFACE_PROFILES` in `surface-types.ts` | 1.0 default | ice 0.35 → metal 1.25 |

## Validating the implementation — the Drift Practice Range

`public/tracks/drift-test.json` is a flat-surface dev diagnostic that
exercises every drift behavior on one closed loop. It's surfaced in
the Dev Cup picker as **"Drift Practice Range"** (dev builds) and
loadable in any build via `?track=drift-test`.

Stations, driving CCW from start:

| Station | Where | What it tests |
|---|---|---|
| 1 | North straight (long) | Hold Z/C while driving straight — drift must NOT activate (steer-commit gate) |
| 2 | NE corner (red cones) | Hold C + steer right → blue MT in ~0.6 s; release for boost |
| 3 | Boost pad on E straight | Drift release + pad merge — multiplier maxes, duration extends |
| 4 | SE corner (red cones) | Same as NE — symmetry check |
| 5 | South straight (ramp) | Drift into the ramp — ungrounded for >300 ms cancels the drift |
| 6 | SW corner (red cones) | Repeat blue MT right |
| 7 | West straight + NW sweep (green cones) | Long enough to charge the orange SMT tier (~1.4 s hold) |

`tests/unit/drift-test-track.test.ts` pins the layout geometry so an
inadvertent JSON edit can't silently break a station.

## AI drift

`aiControlSystem` now activates drift on sharp upcoming corners. The
state machine lives in `decideAIDrift` (pure helper) and the tuning
is baked from `DIFFICULTY_TUNING`:

| Difficulty | Trigger curvature (1/m) | Min speed (m/s) | Max hold (s) | Tier ceiling |
|---|---|---|---|---|
| Casual | ∞ (disabled) | ∞ | 0 | — |
| Standard | 0.033 (~30 m radius) | 14 | 1.6 | orange SMT |
| Hard | 0.020 (~50 m radius) | 10 | 2.5 | purple UMT |

The AI's `decideAIDrift` mirrors the player-side `driftSystem`
activation rules — same `sign(steer)` commit gate, same cancel
conditions. So the player and AI charge the same tier curve on the
same corners.

Activation: AI enters drift when the upcoming-corner curvature exceeds
the per-difficulty threshold, the bike is moving fast enough, the
already-computed PD steer is committed past ±0.3, and the post-release
cooldown has elapsed. The drift direction matches `sign(steer)` so the
trick button matches whichever way the bike is already turning — the
player-side `driftSystem`'s `Math.sign(intent.steer) === dir`
activation gate passes on the very next tick.

Cancel: corner widens below 60% of trigger threshold, steer flips
opposite the drift direction (line re-acquired), speed drops below
70% of trigger threshold, or hold exceeds the per-difficulty max. On
release, a 350 ms cooldown prevents immediate re-trigger.

## Tutorial integration

The default tutorial script (`tutorial-script.ts`) now includes a
**DRIFT** beat between WAVE PUMP and ANTI-GRAV: "Hold Z / C through a
corner while steering, then release for a boost." It clears on the
first charged release (`driftTierThisBeat >= 1`), with a 25 s
`clearAfterSeconds` escape hatch so a flat track with no real corner
still advances.

The director gained a `notifyDrift(tier)` out-of-band signal (parallel
to `notifyPumpEvent` / `notifyOrbitTouch`) that keeps the max tier seen
this beat. The game-loop fires it on `DriftState.releasedThisTick`,
regardless of `driftIntensity` — the beat is about learning the
mechanic, so a player with visuals off still graduates it.

## Surface-aware drift

A per-collider surface-type registry (`engine/sim/surface-types.ts`)
lets a track mix materials. Each `SurfaceType` carries a
`lateralGripMul` that scales the bike's lateral drag in BOTH normal
driving and drift, so a surface feels coherent (ice is slippery
whether or not you're sliding):

| Surface | Grip × | Feel |
|---|---|---|
| `default` / `asphalt` | 1.00 | baseline (every untagged collider) |
| `metal` | 1.25 | clingy — tight, snappy drifts |
| `sand` | 0.70 | washes out — wide, hard-to-hold drifts |
| `ice` | 0.35 | very slick — long, loose drifts |
| `water` | 1.00 | neutral (water's lateral feel is the `isWater` path in hover.ts) |

**Design guard:** `default` is a perfect 1.0 everywhere, so every
existing track (none tag surfaces) is byte-identical to pre-surface
behaviour. Only explicitly-tagged patches change feel.

**Flow:** `PhysicsWorld.surfaces` (a `SurfaceRegistry`) maps collider
handle → type, tagged at collider creation:
- `Prop.surface` (JSON authoring) → `props.ts` tags the prop collider
- GLB track meshes → `glb-track.ts` reads an optional `surface`
  userData extra (validated, unknown ignored)

The hover center probe reads `hit.collider.handle` each tick, looks up
the type, and writes `HoverState.surfaceType`. The ground branch
multiplies lateral drag by `surfaceGripMul(surfaceType)`.

The **Drift Practice Range** demonstrates it: an ICE patch on the
west straight (the SMT sweep — extra-loose) and a SAND patch on the
south ramp straight.

**Blender authoring** for the GLB `surface` extra (addon UI + a
Python `SurfaceType` mirror + an asset-kinds-style sync test) is the
remaining follow-up — the runtime path already honours the extra, so
it's purely an authoring-tooling task.

## Open questions / follow-ups

1. **Blender `surface` authoring UI.** The runtime reads a `surface`
   userData extra off GLB track meshes already; the Blender addon
   needs a panel to write it (+ a Python `SurfaceType` mirror and the
   parse-both-sides sync test, matching the `ExportedKind` pattern).

## References

- [Drift — Super Mario Wiki](https://www.mariowiki.com/Drift)
- [Mini-Turbo — Mario Kart Racing Wiki](https://mariokart.fandom.com/wiki/Mini-Turbo)
- [Mario Kart 8 Deluxe Drifting Guide — Nintendo Life](https://www.nintendolife.com/guides/mario-kart-8-deluxe-drifting-guide-how-to-drift-slipstream-and-boost)
- [Everything you need to know about drifting in MK8DX — vikemk.com](https://vikemk.com/drifting-guide)
- [How Drifting Works — CBR](https://www.cbr.com/mario-kart-8-drifting-win/)
- [ComicBook.com — Mario Kart drifting evolution](https://comicbook.com/gaming/feature/mario-kart-drifting-evolution/)
