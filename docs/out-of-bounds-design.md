# Out of bounds — design + plan

> So racers don't joyride to the moon. A two-phase boundary: a Battlefield-style
> **return-to-course** warning with autopilot grace, escalating to an
> **AirJaws great white** that breaches from the depths and takes the bike.
> Inspired by Jak & Daxter's out-of-bounds fish. Driven from
> [matt's brief](#) — decisions locked below.

This doc is the **plan first** deliverable. Delivery order: **plan → Phase 1 →
Phase 2**. It captures the locked decisions, the leash math, the escalation
state machine, the systems we reuse, and the per-phase task breakdown.

## Pillar fit

The boundary is *part of* the wave-mastery fantasy, not a nag. Wandering off the
swell-lines into dead open water (or rocketing skyward off a launch) should feel
risky — and the consequence is a spectacle, not a fade-to-black. The shark is a
set-piece in the post-flood world the [product plan](./product-plan.md) sets up.

## Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | What counts as out of bounds | **Leash only.** Distance from the racing line. No altitude ceiling / depth floor as separate rules. |
| 2 | Default leash distance | **1.5× the buoy placement distance.** The `waveRiderBuoys` are the first *soft wall* (the channel walls — see the [art-pass playbook §4](./track-art-pass-playbook.md)). |
| 3 | When the lethal phase triggers | **Either one:** the Phase-1 grace timer expires while still out, **OR** the bike crosses a harder outer edge. |
| 4 | Grace / near-miss | If the player is on the verge of returning safely, give grace — the attack reads as a **near-miss** (shark breaches and *just* misses), they keep racing. |
| 5 | Adjustable timing | The delay between going out and the attack is **tunable** (one place in code + a player-facing Settings option). |
| 6 | Scope of v1 | **Single-player Race + Time Trial.** Multiplayer (lockstep determinism) and the tutorial are explicitly deferred — see [Modes](#modes--determinism). |

## The leash (detection)

Measured in the **sim layer** (deterministic, no Three.js), per fixed tick, for
the player's bike only.

**Corridor half-width (per track, computed once at load):**

1. The racing line is `track.aiSplines[].find(s => s.id === 'main')` (fall back to
   `aiSplines[0]`), already a dense loop-closed polyline in `points[]`.
2. The buoys arrive as ordinary props: `json-loader.ts` synthesises each
   `waveRiderBuoys` entry into `track.props` with `assetId === 'buoy'`.
3. `corridorHalfWidth = median( dist(buoy, nearest AI-line point) )` over all
   `'buoy'` props. (~42 m on Sandbar per the playbook.) Median, not mean, so a
   stray decorative buoy doesn't skew the wall.
4. **Fallback** when a track has no buoys: `DEFAULT_CORRIDOR_HALF_WIDTH_M = 45`.

**Leash distance** = bike's **3D** distance to the nearest sample on the AI line.
3D (not just XZ) is deliberate: it means a vertical joyride ("to the moon")
trips the same single rule, while legit vertical track features stay safe because
the line itself climbs there (helix climbs, banked walls, ramps) — the nearest
line sample is close when you're on the intended vertical path.

| Edge | Threshold | Behaviour |
|---|---|---|
| **Soft wall** | `SOFT_LEASH_MULT (1.5) × corridorHalfWidth` | Enter Phase 1 (warn + autopilot + forfeit). |
| **Hard wall** | `HARD_LEASH_MULT (2.5) × corridorHalfWidth` | Immediately arm the lethal phase (decision #3 "either"). |

Re-entry hysteresis: you're "back in bounds" only once distance drops below
`0.92 × soft` so you don't flicker on the line.

Nearest-line lookup reuses the cached spline search (`findClosestIndexLooped`,
`spline-query.ts`) the same way `ai-control.ts` does, with a per-track `WeakMap`
cache for the corridor width (mirrors the existing `SPLINE_INDEX` cache).

## Escalation state machine

One small component, `OutOfBounds`, on the player entity. Phases advance in the
sim system; the render/loop layer only *reflects* state (popup) and *reacts*
(autopilot, cutscene).

```
IN_BOUNDS
   │  dist > soft
   ▼
WARN ──────────────── dist < re-entry  ──────────────▶ IN_BOUNDS (credit already forfeited)
   │  (Phase 1: popup + countdown, autopilot engaged, race credit forfeited)
   │
   │  timer hits 0  (still out)   ─┐
   │  OR dist > hard              ─┴─▶ BRACE
   ▼
BRACE  (short "incoming" beat; re-evaluate recovery each tick)
   │            ┌─ recovering fast / back inside soft ─▶ NEAR_MISS ─▶ IN_BOUNDS
   │  beat ends ┤
   │            └─ still out / not recovering         ─▶ HIT
   ▼
HIT  → ragdoll eject + shark takes bike → death-cam → RESPAWN (back on the line)
```

- **Forfeit on WARN entry.** Per decision #2 in the brief: breaking the soft wall
  costs you race credit immediately (`Racer.forfeited = true`). Getting back in
  bounds clears the warning but *not* the forfeit — the run no longer counts.
- **Recovering test (drives the near-miss).** During BRACE: recovering if the
  leash distance is shrinking at ≥ `NEAR_MISS_MIN_INWARD_SPEED` (m/s) **and**
  projected back inside the soft wall within `NEAR_MISS_LOOKAHEAD_S`, or already
  inside. Recovering ⇒ NEAR_MISS (spectacle, survive). Otherwise ⇒ HIT.

## Phase 1 — warning + autopilot + no credit

- **Detection + state**: `src/game/systems/out-of-bounds.ts` (new sim system),
  wired into `sim-step.ts` right after `syncFromPhysics` (post-step bike pose).
- **Warning popup + countdown**: `src/engine/render/oob-hud.ts` drives a new
  `#hud-oob` slot — "⚠ RETURN TO COURSE" + a count-down ring, mirroring the
  wall-clock-anchored race-start countdown in `race-hud.ts`. Render-only, reads
  the `OutOfBounds` component. `pointer-events:none` (informational, no focus
  trap → satisfies the input-navigability convention without adding a control).
- **Autopilot handoff**: reuse the existing test-mode seam. The loop calls the
  same `applyAutoPlayTag(true)` (`main.ts:1055`) on WARN entry — `sim-step.ts:114`
  already routes control to `aiControlSystem` when `autoPlay` is set, steering the
  player's bike back to the racing line. *Touch any control* (non-zero
  throttle/steer/pitch/brake) → `applyAutoPlayTag(false)`, manual control returns;
  the countdown keeps running until you're back in bounds.
- **No race credit**: add `forfeited: boolean` to `RacerData`; the finish path
  records a DNF (null position/time) when set — `cup-progress.ts` and
  `cup-results-screen.ts` already render **"DNF"**, so this plugs straight in.
  Time Trial: a forfeited run is not saved as a lap/ghost.

## Phase 2 — the great white

- **Trigger**: BRACE → HIT, from the same sim system (timer-expiry or hard-wall).
- **Ragdoll eject**: reuse `launchRider()` (`rider-crash.ts`) — export it / add a
  thin trigger so the chomp ejects the 10-bone rider ragdoll with the somersault.
- **The shark (procedural placeholder)**: `src/engine/render/shark.ts` builds a
  stylised great white from primitives in the "clean stylized toy" register
  ([art-direction.md](./art-direction.md)) — elongated body, dorsal + pectoral
  fins, tail, gaping jaw. A scripted **breach arc**: rises from below the
  waterline (`track.water.height`), opens the jaw around the bike at the apex,
  arcs over, crashes back with a big splash. Art-upgradeable later via the GLB
  prop pipeline (see [follow-ups](#follow-ups)).
- **Death-cam**: `src/engine/render/oob-death-cam.ts` modelled on `race-intro.ts`
  (`tick(dt)` / `isActive()` owning the camera, then handing back to the chase
  rig) — a brief over-shoulder → breach → tumble sequence.
- **Splash + audio**: reuse the FX foam/bubble pools for the breach spray; an
  audio breach/chomp cue wired like the existing explosion sidechain.
- **Respawn**: snap the bike to the nearest AI-line point (not the start line) at
  a safe height, facing the spline tangent; `resetRiderForBike()` re-attaches the
  rider (same call `respawnPlayer()` uses, `controls.ts:265`). Still forfeited.
- **Near-miss variant**: breach + camera shake + spray, **no** chomp/ragdoll/
  respawn — the shark crashes back just behind you and you race on.

## Tuning + settings

All timing/threshold constants live in one module,
`src/game/systems/oob-tuning.ts`, so the feel is adjustable from one place:

```
SOFT_LEASH_MULT = 1.5          HARD_LEASH_MULT = 2.5
DEFAULT_CORRIDOR_HALF_WIDTH_M = 45
WARN_GRACE_S = 5.0             BRACE_S = 1.5
NEAR_MISS_MIN_INWARD_SPEED = 8 NEAR_MISS_LOOKAHEAD_S = 1.2
REENTRY_FRAC = 0.92
```

Player-facing (definition-of-done: every system gets a Settings entry, navigable
by keyboard/controller/touch):

- **Settings → Gameplay → "Out of bounds"**: `Off` / `Autopilot` (Phase 1 only,
  never lethal) / `Shark` (full). Default **Shark**.
- **Settings → Gameplay → "OOB grace timer"**: `Short (3 s)` / `Normal (5 s)` /
  `Long (8 s)`. Default **Normal**. This is decision #5's adjustable timing,
  overriding `WARN_GRACE_S`.

## Reused seams (no new invention)

| Need | Reuse | Where |
|---|---|---|
| Autopilot drive | `inputs.autoPlay` gate → `aiControlSystem` | `sim-step.ts:114`, `applyAutoPlayTag` `main.ts:1055` |
| Rider ragdoll | `launchRider()` | `rider-crash.ts:120` |
| Rider re-attach | `resetRiderForBike()` | `controls.ts:265` |
| No credit / DNF | null result → "DNF" | `cup-progress.ts`, `cup-results-screen.ts` |
| Countdown UI | wall-clock-anchored countdown | `race-hud.ts` |
| Cinematic camera | director `tick`/`isActive` | `race-intro.ts` |
| Nearest line point | `findClosestIndexLooped` | `spline-query.ts` |
| Splash FX | pooled foam/bubble emitters | `engine/render/fx/index.ts` |

## Modes & determinism

- **In scope**: single-player Race + Time Trial, player bike only.
- **Deferred**: multiplayer (the autopilot tag-swap + cutscene aren't lockstep-
  safe yet), tutorial (scripted flow), attract mode (AI stays on the line).
- Detection lives in the deterministic sim; the autopilot tag-swap, popup, and
  cutscene are single-player loop/render orchestration. AI opponents are never
  leashed — only the player.

## Files

**New**: `src/game/systems/out-of-bounds.ts`, `src/game/systems/oob-tuning.ts`,
`src/game/components/out-of-bounds.ts`, `src/engine/render/oob-hud.ts`,
`src/engine/render/shark.ts`, `src/engine/render/oob-death-cam.ts`,
`tests/unit/out-of-bounds.test.ts`.

**Changed**: `src/game/sim-step.ts` (call the system), `src/game/components/race.ts`
(`forfeited`), the finish/result path (forfeit → DNF), `src/boot/game-loop.ts`
(poll state → autopilot/popup/cutscene), `src/engine/player-settings.ts` +
`src/engine/menus/settings-overlay.ts` (two settings), `index.html` (the
`#hud-oob` slot + CSS), and `docs/status.md` on completion.

## Testing

- Unit: corridor-half-width from buoys (median, fallback), leash thresholds,
  soft/hard transitions, re-entry hysteresis, forfeit set/sticky, the recovering
  / near-miss predicate. All pure-sim, no browser.
- Manual/e2e via the debug API: drive the player far off-line, confirm popup +
  autopilot + forfeit; let the timer expire for the breach; recover late for the
  near-miss.

## Follow-ups

- Replace the procedural shark with a sculpted GLB via the prop pipeline
  ([asset-pipeline-guide.md](./asset-pipeline-guide.md)) + a real breach audio
  asset.
- Multiplayer-safe boundary (deterministic, peer-agreed) once netcode lands.
- Optional per-track leash override field on the `Track` type if any track wants
  a tighter/looser channel than `1.5×` buoys.
