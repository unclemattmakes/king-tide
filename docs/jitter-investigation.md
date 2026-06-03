# Racer jitter — investigation, telemetry, and fix

> **Status:** root-caused, **fixed**, and instrumented. Render interpolation
> (P0) + camera-on-the-same-clock (P1) are implemented; the hover-spring
> tuning (P2) was investigated headlessly and found **unnecessary** (the
> spring is under-damped but provably non-ringing — see "P2"). The
> `?jitter=1` telemetry stays in as a regression instrument. See "The fix"
> below.

## Symptom

Racers — **especially the player** — look jittery / stuttery, while the
**camera motion is smooth**. AI racers show it intermittently. Remote
(multiplayer) bikes do not.

## Root cause

A fixed-timestep simulation is being **sampled by a variable-rate render
loop with no interpolation**, and the camera is the only thing that smooths
the result.

1. **Physics is a fixed 60 Hz accumulator.** `FIXED_DT = 1/60`
   ([`engine/sim/physics/rapier.ts`](../src/engine/sim/physics/rapier.ts):25);
   the loop in [`boot/game-loop.ts`](../src/boot/game-loop.ts) does
   `physAccum += dt; while (physAccum >= fixedDt) { simulateStep(); physAccum -= fixedDt }`.
   Depending on how render-frame time lands against the 16.67 ms step, a
   frame runs **0, 1, or 2+** steps, and a leftover `physAccum` remainder is
   kept but **never used**.

2. **Local bikes snap to the latest physics transform — no interpolation.**
   `simulateStep` → [`syncFromPhysics`](../src/game/systems/sync-from-physics.ts)
   writes each body's Rapier pose into `TransformStore`. The bike render
   system reads it and assigns it straight to the mesh:
   `mesh.position.set(t.x, t.y, t.z)`
   ([`engine/render/render-systems.ts`](../src/engine/render/render-systems.ts):134-135).
   `bikeRender()` runs every render frame
   ([`boot/game-loop.ts`](../src/boot/game-loop.ts):1461). So the mesh is a
   **zero-order hold** on a 60 Hz signal: it freezes on a 0-step frame, then
   jumps a double-step on a 2-step frame. That quantisation is the jitter.

3. **The camera low-pass-filters the same signal, so it glides.** The chase
   camera reads the player's *raw* Rapier pose each frame
   ([`boot/game-loop.ts`](../src/boot/game-loop.ts):966-982) and runs it
   through exponential smoothing every frame —
   `camera.position.lerp(goalPos, 1 - exp(-dt * 6))`
   ([`engine/render/camera.ts`](../src/engine/render/camera.ts):155-157).
   A low-pass filter over a quantised input produces a smooth output.

**Net:** smooth (filtered) camera + stair-stepped (unfiltered) bike. And
because the camera *follows* the bike while smoothing differently, the
bike's quantisation is shown against a smooth reference frame, which makes
it **more** visible, not less.

### Why "especially the player"

The player bike is screen-centred and the camera is locked to it, so its
per-frame quantisation reads most clearly against the smooth viewport. AI
bikes use the identical snap-to-transform path, so they stair-step too, but
only *look* jittery when they're moving relative to your smoothed view
(off-centre, smaller, partially occluded → "sometimes"). **Remote** bikes
are kinematic and already interpolated between 20 Hz snapshots in
[`remote-interp.ts`](../src/game/systems/remote-interp.ts), which is why
they're smooth.

### A possible secondary contributor

If the **hover spring** is underdamped, the body genuinely oscillates
(vertical bounce / pitch ring) at the physics rate. The camera low-passes
that away too, so it would present with the *same* "camera smooth, bike
shaky" signature. The telemetry below separates the two: a render-sampling
artifact shows up as ragged step cadence with smooth underlying sim motion;
real ringing shows up as high per-tick motion even at a steady cadence.

## Telemetry: `?jitter=1`

Add `?jitter=1` to the URL (works in dev **and** on a prod/Vercel build,
like the determinism harness). Implemented in
[`engine/jitter-telemetry.ts`](../src/engine/jitter-telemetry.ts), wired in
[`boot/game-loop.ts`](../src/boot/game-loop.ts); off by default → zero
hot-path cost.

It records two streams for the player body — one per **sim tick** (inside
the accumulator loop) and one per **render frame** (after it drains) — and
prints a summary to the console every 2 s. Read it live with
`window.__hoverJitter()` (or `window.__hover.jitter()` in dev/test).

| Field | Meaning | What a problem looks like |
|---|---|---|
| `zeroStepFrac` | fraction of frames that ran **0** sim steps (bike frozen that frame) | high (≫ 0) |
| `multiStepFrac` | fraction of frames that ran **≥2** steps (bike double-jumped) | high (≫ 0) |
| `meanAlpha` | mean leftover `physAccum / fixedDt` — the interpolation factor **currently discarded** | ~0.5, i.e. the bike renders ~half a step stale on average |
| `renderJerkMean` | ‖2nd difference‖ of the **rendered** position per frame (m) — on-screen smoothness | high |
| `simJerkMean` | ‖2nd difference‖ of the **per-tick sim** position (m) — ground-truth motion | compare to render |
| `vertReversalsPerSec` | vertical-velocity sign flips/sec — hover-spring ringing detector | > 8 ⇒ ringing |
| `stepsHistogram` | frames bucketed by step count | spread across 0/1/2 instead of all-1 |
| `verdict` | plain-language reading of the above | — |

**Interpreting it:**

- `renderJerkMean ≫ simJerkMean` **and** ragged cadence
  (`zeroStepFrac + multiStepFrac` large) ⇒ **render-sampling stutter**. The
  sim motion is smooth; the render is throwing away `meanAlpha` of a step
  every frame. → Fix with render interpolation (P0).
- `vertReversalsPerSec` high / `simJerkMean` elevated even at a steady
  1-step cadence ⇒ **sim-side ringing**. Interpolation will smooth the look
  but won't remove the bounce. → Tune the hover spring (P2).

Both can be true at once; the `verdict` string calls out each. Note the
off-cadence ratio is *inherent* to a fixed step sampled by a variable render
loop — it stays "ragged" even after interpolation hides it, so the verdict
keys on **render-jerk vs sim-jerk** (rendered path rougher than the sim ⇒
artifact) rather than cadence alone. Post-fix the verdict reads "cadence
ragged … interpolation is absorbing it, motion reads smooth."

## The fix

### P0 — Render interpolation for local bikes (implemented)

Textbook fixed-timestep state interpolation ("Fix Your Timestep"), done as a
**single pass over the shared render-read store** so it covers the bike mesh,
rider bones, shield, wave-riders and every bike-attached FX emitter with no
per-system change.

- **Two tick-history stores** —
  [`TickTransformStore` + `PrevTickTransformStore`](../src/game/components/index.ts)
  (render-only, no tags, not in any snapshot). `syncFromPhysics` shifts the
  previous committed pose into `PrevTick` before stamping the new one, so
  after the accumulator drains they bracket render time.
  ([`sync-from-physics.ts`](../src/game/systems/sync-from-physics.ts))
- **One interpolation pass** —
  [`interpolateRenderTransforms(alpha)`](../src/game/systems/interpolate-transforms.ts),
  called each render frame after the accumulator loop with
  `alpha = physAccum / fixedDt` (the fraction that used to be discarded). It
  writes `TransformStore` (the pose every render system already reads) to
  `lerp/slerp(prev, cur, alpha)`. On a 0-step frame the bike keeps gliding as
  `alpha` grows; on a 2-step frame it no longer jumps. Cost: ≤ one tick
  (~16.7 ms) of added visual latency — standard, and far less than the jitter
  it removes.
- **Why `TransformStore` stays the read store:** an audit confirmed *no sim
  system reads it* — it's a pure render mirror. `syncFromPhysics` still writes
  it (so editor/turntable modes that don't run the pass are unchanged); the
  pass overwrites it on rendered frames. The bike mesh, rider, shield, FX and
  wave-riders all become smooth for free.
- **Teleport guard:** the pass snaps (doesn't smear) when a prev→cur gap
  exceeds `TELEPORT_SNAP_DIST` (5 m — well above real per-tick travel,
  far below any jump). This handles respawn, multiplayer position
  corrections, and recycled entity slots at race start *without* hooking each
  path. Bikes also seed their tick history at spawn
  ([`entities/bike.ts`](../src/game/entities/bike.ts)).
- **Ghosts / replay bikes** have no tick history (no `RBHandle`; they drive
  `TransformStore` directly each frame), so the pass skips them and their
  writes stand.

**Determinism / replay / multiplayer safety:** interpolation is
**render-only** and never written back to sim state — same contract as
`remote-interp.ts`. The determinism snapshot + replay recorder sample the
Rapier bodies, not these stores, so there's no determinism impact (the
`m10-determinism` + `apply-snapshot` suites stay green). Remote kinematic
bikes are already smoothed at the sim layer; the render pass adds harmless
sub-tick smoothing and small (<5 m) snapshot corrections still interpolate.

### P1 — Camera on the bike's clock (implemented)

The chase camera (+ direction arrow + `playerSnapshot` + minimap dots) now
read the player's **interpolated** `TransformStore` pose instead of the raw
`rb.translation()` ([`boot/game-loop.ts`](../src/boot/game-loop.ts)), so the
camera and bike share one clock — no residual camera-vs-bike shimmer.
Velocity still comes straight from the rigid body (no interpolation needed).

### P2 — Hover-spring tuning: investigated, **not needed**

Ran a headless probe (the sim is Three-free) driving each bike over flat
water, throttle, and gentle waves for ~8 s, feeding per-tick body-Y into the
jitter telemetry. The vertical spring-damper is
`ζ = hoverDamp / (2·√hoverSpring)`:

| variant | hoverSpring | hoverDamp | ζ | regime |
|---|---|---|---|---|
| racer (default) | 34 | 8.5 | **0.73** | under-damped, lively |
| sparrow | 38 | 5.5 | **0.45** | most under-damped |
| scout | 22 | 10 | **1.07** | ~critically damped |

Several bikes are formally under-damped (ζ<1) — but **under-damped ≠
ringing**: the `−hoverDamp·vy` term always removes energy, so every config
(including a synthetic ζ=0.27) settles to a ±2.5 cm band within ~3 s and
never sustains. The large excursions on waves are the bike *faithfully
tracking the swell* (the wave-mastery feel), not ringing about equilibrium.
So the on-screen jitter was *entirely* the render-sampling artifact; **no
change to `hover.ts` / `variants.ts` is warranted** and none was made.

### Still nice-to-have (not done)

- Surface `steps/frame` + off-cadence % as a perf-HUD row
  ([`engine/render/perf-hud.ts`](../src/engine/render/perf-hud.ts)) so the
  cadence is visible without the console.
- The **frame cap** ([`frame-cap.ts`](../src/engine/render/frame-cap.ts))
  that doesn't divide the display refresh evenly compounds the beat;
  interpolation now makes any cap safe.
