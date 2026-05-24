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

### Charge tiers — two tiers (purple UMT deferred)

| Tier | Color | Charge time | Boost mult | Duration |
|---|---|---|---|---|
| 0 | none | < 0.6 s | — | — |
| 1 (MT) | blue | 0.6–1.4 s | 1.30× | 0.8 s |
| 2 (SMT) | orange | ≥ 1.4 s | 1.55× | 1.4 s |

Tuning targets a clear "this paid off" feel without breaking topSpeed
balance. `topSpeed × 1.55 = ~43.4 m/s`, comparable to a mid-strength
boost pad.

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
- **Yaw**: replace base steer torque with `driftDir × 0.7 × turnTorque`
  (constant bias) + `steer × 0.4 × turnTorque` (reduced player
  authority). Result:
  - No steer → bike turns at 0.7× nominal in the drift direction.
  - Steer into drift (committed) → 1.1× — tightens the line.
  - Counter-steer → 0.3× — opens the line without canceling.
- **Forward thrust** unaffected — drift doesn't kill speed (matches MK feel).

### Game feel — render layer

- **Camera roll** of ~5° toward the drift direction, eased over ~150 ms.
- **Particle sparks** from rear hover probes — white at tier 0, blue at
  tier 1, orange at tier 2. Uses the existing 16-cell atlas.
- **HUD** — boost-meter widget already exists; drift-charge could be a
  thin secondary ring later (deferred).

### Anti-snake

- **Minimum hold time** (0.6 s) before charge begins — straight-line
  presses give no payoff.
- **Cooldown** (0.25 s) between release and next drift activation.
- **Counter-steer** doesn't cancel but doesn't charge either — discourages
  wiggle-snake (which doesn't work here anyway given the time-based
  charging).

### Bike archetypes (Phase 3, deferred)

Add `driftStyle?: 'outward' | 'inward'` to `BikeStatsData`:
- **Outward** (Cruiser, Racer, Scout): MK-default, hugs the apex.
- **Inward** (Sparrow, Stunt): sport-bike feel — tighter initial cut,
  wider overall arc. +20 % initial yaw spike, −20 % sustained yaw.

Phase 3 work; not in initial M9.41 cut.

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
| Tier 1 boost multiplier | `DRIFT_BOOST_MUL_T1` | 1.30 | 1.15–1.45 |
| Tier 2 boost multiplier | `DRIFT_BOOST_MUL_T2` | 1.55 | 1.40–1.75 |
| Tier 1 boost duration | `DRIFT_BOOST_DURATION_T1` | 0.8 s | 0.5–1.2 s |
| Tier 2 boost duration | `DRIFT_BOOST_DURATION_T2` | 1.4 s | 1.0–1.8 s |
| Lateral-drag scale while drifting | `DRIFT_LATERAL_DRAG_SCALE` | 0.35 | 0.2–0.6 — lower = more slide |
| Drift yaw bias (× turnTorque) | `DRIFT_YAW_BIAS_FRAC` | 0.7 | 0.5–0.9 |
| Player steer authority while drifting | `DRIFT_STEER_FRAC` | 0.4 | 0.2–0.6 |
| Ungrounded-cancel timeout | `UNGROUNDED_CANCEL_S` | 0.3 s | — |
| Steer-commit threshold | `STEER_COMMIT_THRESHOLD` | 0.1 | — |
| Drift cooldown after release | `DRIFT_COOLDOWN_S` | 0.25 s | — |
| Camera roll on drift (render) | `DRIFT_CAMERA_ROLL_RAD` | 5° | 0–10° |

## Open questions / follow-ups

1. **AI drift.** `aiControlSystem` doesn't set `trickLeft/Right` today.
   AI bikes won't benefit from drift — gap closes when AI gets a drift
   path follower. (Deferred to M9.42+.)
2. **Tutorial integration.** A "DRIFT THROUGH THE CORNER" beat should
   land in the tutorial track director. (Deferred.)
3. **Surface-aware drift.** Currently uniform on land + water. Could
   make water-drift slipper / land-drift grippier. Deferred until the
   surface-type tagging system exists.
4. **Inside-drift archetype.** Sparrow + Stunt as sport-bike variants.
   Phase 3, not in initial cut.
5. **UMT (purple) third tier.** Only enable once base tuning settles
   from playtest data.

## References

- [Drift — Super Mario Wiki](https://www.mariowiki.com/Drift)
- [Mini-Turbo — Mario Kart Racing Wiki](https://mariokart.fandom.com/wiki/Mini-Turbo)
- [Mario Kart 8 Deluxe Drifting Guide — Nintendo Life](https://www.nintendolife.com/guides/mario-kart-8-deluxe-drifting-guide-how-to-drift-slipstream-and-boost)
- [Everything you need to know about drifting in MK8DX — vikemk.com](https://vikemk.com/drifting-guide)
- [How Drifting Works — CBR](https://www.cbr.com/mario-kart-8-drifting-win/)
- [ComicBook.com — Mario Kart drifting evolution](https://comicbook.com/gaming/feature/mario-kart-drifting-evolution/)
