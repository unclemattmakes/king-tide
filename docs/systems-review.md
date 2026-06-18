# Game-systems review — recommendations for improvement

> **What this is.** A deep read of how the gameplay/simulation systems are
> implemented (`src/game/systems/`, `src/game/components/`, `src/engine/sim/`,
> the sim↔render seam, the fixed-step loop, and the netcode), with prioritized,
> concrete recommendations. Snapshot date **2026-06-18**, against
> `claude/game-systems-review-ax01to` (tip = water-perf-retire-overlays, #381).
>
> **Stance.** The codebase is healthy: the sim/render split is genuinely
> respected, the seeded-RNG discipline is real, the comments encode hard-won
> tuning rationale, and there's a substantial test suite (124 unit + 61 e2e).
> Nothing here is a rewrite. These are debt-paydown and guardrail moves, ordered
> so the cheap-but-high-leverage ones come first.

---

## TL;DR — the five things worth doing first

1. **Make the determinism rules mechanical, not social.** Add lint/test guards
   that ban `three`, `Math.random`, `Date.now`, `performance.now`, and live
   `devSettings` imports inside `src/engine/sim/**` and `src/game/systems/**`.
   The rules are currently honored by convention only — one stray import passes
   `typecheck`/`lint`/`test`/`build`. (§1)
2. **Fix the live standings tie-break bug** — verified, ships today, causes HUD
   position flicker when bikes are abreast. (§2.1)
3. **Stop `devSettings` leaking into the sim.** `hover.ts` shapes physics from a
   mutable, localStorage-backed, dev-palette-tunable singleton read every tick —
   a silent desync source the moment lockstep MP lands. (§1.2)
4. **Add `destroyEntity()` + a store registry.** `removeEntity` leaves every
   Map-backed Store entry orphaned → memory growth across a race **and** a
   stale-data hazard under bitECS entity-id recycling. (§3.1)
5. **Break up the three worst god-files** — `hover.ts` (2.3k LOC),
   `game-loop.ts` (`frame()` alone ~990 LOC), `rider-pose.ts` (891 LOC) — along
   the module seams their own `HoverFrame`/helper structure already implies. (§4)

---

## 1. Determinism & the multiplayer goal (highest stakes)

Lockstep + eventual rollback are stated goals (implementation-plan.md, ADR
0004 "deterministic Rapier build"). The *intent* is strong and mostly upheld —
but the guarantees are conventions, and a few real holes will bite when MP
combat/rollback work resumes.

### 1.1 The rules are enforced socially, not mechanically — add cheap guards
There is **no automated guard** for any of the load-bearing sim-purity rules:

- No `from 'three'` ban under `src/engine/sim/**` / `src/game/systems/**`
  (CLAUDE.md hard rule 3 / ADR 0002). The boundary currently *holds* — zero real
  Three imports in those dirs — but nothing stops a regression.
- No ban on `Math.random` / `Date.now` / `performance.now` in those layers
  (`world.ts:5-8`, `rng.ts:4` state the rule forcefully; only the seeded-RNG
  self-test exists, which checks the PRNG, not call sites).

**Do:** add a Biome `noRestrictedImports`/`noRestrictedGlobals` block (or a
~15-line glob-and-grep unit test) scoped to those two dir globs. Cheapest
possible insurance; turns three "hard rules" into mechanical guarantees.
Note `clock.ts` lives under `src/engine/sim/time/` yet reads `performance.now()`
— it's correctly render-only today, but its location invites a future sim
import; consider relocating it out of the `sim/` namespace.

### 1.2 `devSettings` is a live, mutable sim input that isn't in world state
`hover.ts` reads `devSettings.hoverProbeHalfLength/SpeedScale/Lift/HalfWidth`
(`hover.ts:726-758, 1008, 2184`) and `input-apply.ts:124` reads
`steerReleaseTightness` — all from a localStorage-backed, dev-palette-tunable
singleton (`dev-settings.ts:1-9`, "read every tick … apply live"). `hover.ts` is
*the* physics-shaping system, so these are non-deterministic sim inputs that are
neither part of `SimWorld` nor in the snapshot. Two peers with different settings
(or one dragging a slider mid-race) desync silently — and `simulateStep`'s
docstring (`sim-step.ts:91-95`) explicitly *claims* purity w.r.t.
`(sim, phys, waveField, track, inputs)`.

**Do:** fold the sim-affecting subset into `StepInputs`, or freeze them into the
world at race start so they ride the snapshot/seed. Keep only render/camera/
keyboard-feel knobs live. Minimum bar: include them in `captureSnapshot` so
divergence is at least *detectable*.

### 1.3 The determinism snapshot covers physics + RNG but not gameplay state
`captureSnapshot` (`snapshot.ts:42-84`) serializes Rapier pose/velocity +
`rng.state()` + `waveField.time`. It captures **no** Store: `HoverState`,
`TrickState`, `DriftState`, `BoostMeter`, `BoostEffect`, `Stun`, pickup timers,
`Racer` progress — all of which carry state across ticks (cooldowns, drift tier,
dive-hold timers, lap counts). `input-apply.ts`'s `smoothed`/`rawSteer` maps
(`:47-56`) are likewise carry-over state held outside the snapshot.

This is **fine as a desync-detection hash** (its M10.2 purpose) but
**insufficient for rollback** — you can't restore-and-resim from it, and there's
no `restoreSnapshot` counterpart. **Do:** decide explicitly. If rollback is real,
the snapshot must serialize all sim-carrying Stores (trivial once §3.1 lands) and
gain a restore path. If only lockstep+detection is near-term, *document* that
rollback is out of scope so the gap is intentional, not latent.

### 1.4 Query iteration order isn't stable — tie-breaks that depend on it can desync
`snapshot.ts:51-52` already sorts eids before hashing, correctly acknowledging
that bitECS query order is archetype/recycle order, **not** eid order. But
systems iterate raw `query(...)` order and make order-dependent decisions:

- `pickMissileTarget` (`combat.ts:201-222`) — strict `dist < bestDist`, so a
  distance tie is won by whoever is first in query order.
- `pickupSystem` (`pickup.ts:64-80`) — `break`s on the first in-range bike.

If query order diverges between peers (very plausible after asymmetric
spawn/despawn histories, or host-vs-client AI handling), these desync. **Do:**
for any sim system whose outcome depends on iteration order or resolves ties,
sort by eid first (as the snapshot does) or break ties explicitly by eid;
document "never depend on raw query order in sim."

---

## 2. Concrete correctness bugs (independent of MP)

### 2.1 Live standings tie-break is a no-op *(verified)*
`computeStandings` breaks progress ties by `raceTime`, earlier = better
(`standings.ts:33-36`). But `race.ts:49-50` advances `raceTime += dt` for **every**
racer **every tick, before** the `finished` guard — so all un-finished racers
share essentially identical `raceTime`. The tie-break only ever discriminates
*finished* racers. Two bikes on the same checkpoint get an arbitrary,
frame-unstable order → visible HUD position flicker when abreast.
**Do:** stamp a per-checkpoint `lastCheckpointTime` at crossing (`race.ts`) and
tie-break on that (earlier arrival at the shared progress = ahead). While there,
extract the `lap*N + nextCheckpoint` progress expression — it's duplicated in
`standings.ts:30` and `rubber-band.ts:38-40` — into one `raceProgress(racer, track)`.

### 2.2 Missile/mine can home on / be immune-to a *recycled* entity
`missileSystem` stores `targetEid`/`ownerEid` at launch and never re-validates
liveness (`combat.ts:240, 283`). Under bitECS id recycling (see §3.1), a freed
target id can resolve to a *different* bike's rigid-body handle → missile homes
on the wrong bike, or self-immunity protects the wrong owner. **Do:** guard the
handle lookup with a `BikeTag`/liveness check and clear `targetEid` to `-1` on
failure.

### 2.3 Lap-finish counting is correct but fragile and untested
`race.ts:119-134` finishes when `lap > lapsToFinish`, relying on
`wasFirstCrossing = checkpointsCrossed === 0` — which only holds if the first
scored crossing is checkpoint 0 (true only for the current spawn-behind-the-line
convention). A track whose start line isn't cp 0, or a spawn that crosses cp 1
first, silently breaks lap counting. There is **no** unit test on the
lap/finish path (only teleport-guard is covered). `checkpointsCrossed` is also
near-dead state — written but read only for this one flag, while standings/
rubber-band derive progress differently. **Do:** add a finish-line integration
test; derive `wasFirstCrossing` from an explicit invariant; consider retiring
`checkpointsCrossed`.

### 2.4 Effect components are zeroed but never removed (slow accumulation)
`applyHitReaction` sets shield `remaining: 0` without removing the component
(`combat.ts:65-69`); `shieldTickSystem` then ticks a dead shield forever. Same
acknowledged pattern for `BoostEffect` (`pickup.ts:138-145`). Cheap per-tick, but
they accumulate on every bike over a session. **Do:** remove on expiry (and roll
this into the §3.1 cleanup sweep).

---

## 3. Entity lifecycle & the data layer

### 3.1 `removeEntity` leaks every Map-backed Store — add `destroyEntity` + registry
`createStore` backs each component with a plain `Map<number,T>` (`store.ts:19-40`).
Entities are destroyed via bitECS `removeEntity` (`combat.ts:145,235,313`,
`multiplayer.ts:226`, replay drivers) which clears tag membership but **never
touches the Stores**. There is no `destroyEntity` helper and no store registry.
Two consequences:

- **Memory growth** across a race — combat entities spawn/despawn constantly and
  leave `MineState`/`MissileState`/`RBHandle`/`Stun`/… entries behind.
- **Correctness under id recycling** — bitECS 0.4 recycles ids; a new entity on a
  reused id finds a *stale* Store entry from the previous tenant. The team has
  already been bitten (`bike.ts:102-103` defensively deletes tick history for
  recycled slots), but combat factories only `set` the stores they know about.

**Do:** `createStore(name)` self-registers into a module-level list; a single
`destroyEntity(sim, eid)` iterates the registry calling `.delete(eid)` before
`removeEntity`. This also makes the §1.3 snapshot-all-stores work trivial.

### 3.2 bitECS-as-tags / data-in-Maps is the right call at this scale — but stop re-allocating in hot loops
The ADR-0001 decision (tags in bitECS, data in side-table Maps) is defensible and
worth keeping for N≈8 bikes + transient projectiles — cache locality is moot at
this scale, and the rich/optional/string fields (`BikeStatsData.driftStyle`,
`variantId`) are ergonomic. But two caveats:

- The SoA benefit is fully forfeited, and several hot-path systems **re-`set`
  whole fresh objects per tick**: `syncFromPhysics` allocates *three* transform
  objects per body per tick (`sync-from-physics.ts:26-35`), `race.ts:49-50` and
  pickup timers re-`set` objects, while other systems correctly mutate-in-place.
  That's avoidable steady-state GC on the fixed-step path. **Do:** mutate Store
  entries in place in the hot loops.
- `store.ts`'s header sells this as "Faster, simpler" — it's *simpler*, not faster
  than SoA. **Do:** relabel it a deliberate small-N choice so a future scale-up
  (crowds, dense projectiles) knows to revisit.

---

## 4. God-files — split along seams that already exist

| File | LOC | Worst hotspot |
|---|---|---|
| `engine/render/water.ts` | 5838 | (render; out of this review's core scope but flagged) |
| `boot/game-loop.ts` | 2518 | `frame()` ≈ 990 LOC; `GameLoopOpts` ≈ 50 fields |
| `game/systems/hover.ts` | 2271 | `applyGroundBranch` ≈ 420 LOC |
| `boot/race-boot.ts` | 2038 | boot orchestration |
| `engine/render/fx/index.ts` | 1844 | FX registry |
| `game/systems/rider-pose.ts` | 891 | `riderPoseSystem` + `solveArmIK` |

These are not blobs — they're well-commented and partly decomposed — but they
own too many concerns each. Concrete seams:

- **`hover.ts`** — the `HoverFrame`/`Footprint` bundles make the split
  mechanical: `hover-probe.ts` (ray/footprint/scratch), `hover-spring.ts`
  (spring + buoyancy), `hover-attitude.ts` (pitch PD + player pitch + air roll),
  `hover-drive.ts` (the `applyGroundBranch` brake/thrust/slope/drift/drag split),
  `hover-tuning.ts` (constants). Keep `hover.ts` as the orchestrator. The two
  dev-flagged wave prototypes (`hover.ts:1615-1668`) should move behind their flag
  into one `applyWaveFeelPrototypes` so they ship or get deleted as a unit.
- **`game-loop.ts`** — `frame()` interleaves input sampling, the fixed-step
  accumulator (which is *correct* — clamps dt, drains on pause, computes
  `renderAlpha` after drain), OOB autopilot/respawn (~200 LOC), ~85 LOC of replay
  missile/explosion bookkeeping, audio dispatch, and every HUD tick. Extract
  `createReplayCapture(...)`, `createOobController(...)`, and the audio-event
  dispatcher into ticker objects built from `opts` — each then unit-testable
  without booting the whole loop.
- **`rider-pose.ts`** — split out `rider-pose-math.ts` (the hand-rolled
  quat/vec lib, which is *duplicated* in `wave-rider.ts:89-116` and
  `rider-crash.ts:181-183`), `rider-pose-tuning.ts` (the ~75-const table), and
  `rider-ik.ts` (`solveArmIK` + `walkChain`). Removes ~400 LOC from the system.

---

## 5. Tuning constants — centralize and make per-variant

The good pattern already exists: `wave-rider.ts`'s per-archetype
`WAVE_RIDER_TUNING` + `deriveWaveRiderTuning`, and `drift-tiers.ts`/`tuck-curve.ts`
(pure, exported, co-located constants). The problem is it isn't applied uniformly:

- **`hover.ts`** has ~40 constants inline in function bodies (`BUOYANCY_PER_M`,
  `GROUNDED_PITCH_P/D`, `CLIMB_ASSIST_FRAC`, `REDIRECT_RATE`, the roll-PD block…)
  *alongside* a well-documented exported block at the top. The buoyancy pair is
  declared **twice** in one function (`hover.ts:971-979` and `:1047-1048`) and the
  grounded-pitch coefficient `7` appears **three** times — genuine drift bugs
  waiting to happen. **Do:** hoist into the module constant block / a
  `HoverTuning` object.
- **Trick + crash feel is global, not per-bike.** `BikeStatsData` already carries
  `topSpeed`/`boostMul`/`surfaceFollow`/`driftStyle`, yet `trick-hop.ts`
  (`HOP_VELOCITY_SMALL`, slope-min, reward floor) and `rider-crash.ts`
  (`CRASH_DV_THRESHOLD` — whose comment even hardcodes "Top speed is 28 m/s" while
  `stats.topSpeed` is right there) are module globals, so every variant
  tricks/crashes identically. **Do:** fold these into `BikeStatsData` or a sibling
  per-variant record following the `WAVE_RIDER_TUNING` model.
- **AI steering gains aren't data-driven.** `KP=0.85`, `KD=0.45`, `blendT=0.55`
  are module constants (`ai-control.ts:247-248,210`), not on the difficulty-tuned
  `AIController` like every other AI knob — so all difficulties steer with
  identical responsiveness and an over-correcting Hard AI can't be softened.

### 5.1 `RIDER_POSE_TUNING` mutability is a latent determinism landmine
It's a single exported **mutable** object the calibration scene rebinds live, read
every tick (`rider-pose.ts:129`). Rider pose is render-side today so it likely
doesn't enter the snapshot — but if any pose value ever feeds gameplay, or two
bikes need different rider tuning, it breaks. **Do:** make production tuning
per-entity (a `tuning` ref on `RiderData`); keep the global as a dev override only.

---

## 6. State-machine modeling & duplication

### 6.1 `TrickState` is a boolean tangle — model it as explicit phases
`TrickStateData` (`components/index.ts:271-350`) encodes one airborne lifecycle as
**9 booleans/counters** (`hopLockoutActive`, `hopLockoutAirborneSeen`,
`trickWindowOpen`, `trickFiredThisAirborne`, `bufferedPress*`, `prev*Down`, …).
`trickHopSystem` is then ~200 LOC of nested conditionals reconstructing implicit
states and guarding against invalid combinations (e.g. `trickWindowOpen` while
`hopLockoutActive`). Contrast `DriftState`, which does it right: `driftDir ∈
{-1,0,1}` is the explicit state and `shouldStartDrift`/`shouldEndDrift` are pure,
tested transition functions. **Do:** give trick an explicit
`phase: 'grounded' | 'buffered' | 'airborne'` (+ a separate `hopLockout`
sub-state) and collapse the redundant booleans. Highest clarity ROI in the feel
cluster.

### 6.2 Extract the repeated idioms
- **Edge-detect / cooldown / one-shot-flag** is copy-pasted across `trick-hop`,
  `drift`, `boost-meter`, `hover` (and `drift.ts:162-163`'s `prevLeftDown/Right`
  are written-but-never-read — dead). A tiny `sim/edge.ts` with `risingEdge(curr,
  prev)` + `tickDown(value, dt)` removes the duplication.
- **Proximity scans** — `pickMissileTarget`, missile hit, mine proximity, and
  `isChaserBehind` each re-implement "for each bike, fetch body, delta, dist,
  forward-dot" (`combat.ts:154-292`, `ai-combat.ts:108-123`), *inconsistently*
  (some use 3D `Math.hypot`, some `distanceSquared`). Extract
  `forEachBikeInRange(phys, origin, maxDist, fn)` + a `bikeBody(phys, eid)`
  accessor; also unifies the `quatRotate(q,{0,0,1})` forward-vector pattern that
  recurs in 6+ places.
- **Quaternion/vector math** is hand-rolled in `rider-pose.ts`, `wave-rider.ts`,
  and `rider-crash.ts` independently. Promote to a shared `sim/physics/quat.ts`
  (folds into the §4 `rider-pose-math.ts` split).

### 6.3 Combat is coupled to pickup types by parallel `switch`es — use a registry
Adding a 5th pickup means editing `pickupUseSystem` (`pickup.ts:100-127`),
`shouldAIFire` (`ai-combat.ts:57-72`, which has no exhaustiveness `default`), and
the per-type precompute (`ai-combat.ts:87-89`), plus the union — with effect
params scattered across two files. **Do:** a `Record<PickupType, { use(sim,phys,
eid), aiShouldFire(ctx) }>` registry co-locating effect params + AI heuristic per
type.

---

## 7. AI cornering — the "uneven" the docs flag

Root causes in `ai-control.ts`, each independently fixable and testable:

- **Curvature is averaged, not peaked** — `curvature = totalBend / scannedDist`
  (`:262`). A window with one sharp kink + a long straight averages to a gentle
  radius, so the AI under-brakes for the kink, enters hot, and saws the wheel.
  Use a windowed **max** local curvature for braking.
- **Steering gain is speed-independent** — `steer = -angle*KP + angvel.y*KD`
  (`:250`) has no speed term: twitchy at 28 m/s, lazy at 8. Add a `1/(1+speed*k)`
  taper.
- **PD gains aren't per-difficulty** (see §5) — promote `KP/KD/blendT` onto
  `AIController`.
- **`lineOffset` has no boundary awareness** — an AI on a wide offset line near a
  tight buoy corridor doesn't know it's drifting toward the leash.

---

## 8. Testing gaps

Coverage of the *pure leaves* is strong (`drift`, `tuck-sweet-spot`,
`slope-momentum`, `drift-yaw`, `shouldAIFire`, `decideAIDrift`, `out-of-bounds`,
`trick-hop` state machine via a Rapier mock). The gaps cluster where the
highest-impact untested logic lives:

| Area | Status |
|---|---|
| `computeStandings` sort/tie-break | ❌ — would have caught §2.1 |
| Lap-count / finish-line path | ❌ — only teleport-guard covered (§2.3) |
| Missile homing / mine proximity / `applyHitReaction` | ❌ |
| `solveArmIK`, `walkChain`, `quatFromTo`/`quatPYR` | ❌ — pure & trivially testable |
| `boostMeterSystem` activate/drain edge | ❌ |

Most of these become free once the relevant logic is extracted into pure helpers
(§4, §6). The `applyPlayerPitchTorque` test (drives a mock `rb`) already proves
sim phase functions can be tested cheaply — extend that pattern.

---

## Suggested sequencing

**Wave 1 — cheap, high-leverage, low-risk (days):**
1. Lint/test guards for `three` + `Math.random`/`Date.now`/`performance.now` in
   sim layers (§1.1).
2. Fix standings tie-break + add its test (§2.1).
3. `destroyEntity` + store registry; fix effect-component cleanup (§3.1, §2.4).
4. Missile/mine liveness guards (§2.2).
5. Extract `sim/edge.ts`, `raceProgress()`, `forEachBikeInRange`/`bikeBody`
   (§6.2) — removes duplication and de-risks later edits.

**Wave 2 — structural, medium-risk (a week+ each):**
6. Get `devSettings` out of the sim path (§1.2); decide & document the
   snapshot/rollback scope (§1.3).
7. Split `hover.ts` and `rider-pose.ts` along their existing seams; pull all
   tuning into `*-tuning` modules (§4, §5).
8. Re-model `TrickState` as explicit phases (§6.1).
9. Pickup registry (§6.3); per-difficulty AI gains + peak-curvature braking (§7).

**Wave 3 — when MP combat/rollback resumes:**
10. Snapshot all sim-carrying Stores + `restoreSnapshot` (§1.3); eid-sorted
    tie-breaks everywhere order matters (§1.4); widen/guard the ±327 m snapshot
    position clamp before larger v2 tracks go multiplayer; design combat events
    as authoritative result-broadcasts, not re-simulated intents.

---

*Method: five focused subsystem reads (hover; ECS/sim-step core; combat/AI/race;
rider-pose/trick/drift feel; sim↔render boundary + netcode) plus direct
verification of the standings bug and the file-size/tech-debt metrics. No
behavioral changes were made — this document is the deliverable.*
