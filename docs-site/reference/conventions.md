# Conventions

The load-bearing rules. Future work needs to respect these — most of them have a war story behind them. If something feels weird and you're tempted to "fix" it, read the relevant section first.

## Coordinate convention

**+Z is forward, +Y is up, +X is right** of a forward-facing bike.

The bike mesh has a yellow fin pointing **+Z** (forward) and a red tail light at **−Z** (back) — visual cue that matches the physics.

::: warning Specs are different
The track JSON spec format uses **Blender axes** (X right, Y forward, Z up), not three.js axes. The exporter swaps them at GLB-write time. See [Authoring tracks → Coordinate system](/modding/tracks#coordinate-system).
:::

## Sim / render split — *load-bearing*

**The sim layer cannot import Three.js.** Anything under `src/engine/sim/` or `src/game/systems/` must be Three-free.

Render systems read from the ECS world and write to Three.js objects, **never the other way around**.

This unlocks:
- Headless tests (Vitest can run the sim with no DOM, no GPU)
- Deterministic replays
- Future rollback netcode

If a sim-side file needs to import `three`, you've crossed a layer. Stop and refactor — there's almost always a Three-free way to express what you want.

## bitECS components are tags, data lives in side-tables

bitECS 0.4 doesn't store data on components without observable hooks. Our pattern:

- The **component** (`Transform`, `BikeStats`, etc.) is a unique object reference used for queries.
- The **data** (`TransformData`, etc.) lives in a side-table store keyed by entity id.

```ts
// Component — just a tag for querying
export const Transform = { name: 'Transform' as const }

// Data type
export type TransformData = { position: Vec3; rotation: Quat }

// Store — actual storage
export const TransformStore = createStore<TransformData>('Transform')
```

See [`src/engine/sim/ecs/store.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/engine/sim/ecs/store.ts) for the implementation.

## Sign conventions in `hover.ts` are empirical, NOT standard math

These have all been playtested into the build. **Don't change a sign without playtesting on real hardware.**

| Convention | Implementation | Why it's not what math predicts |
|---|---|---|
| **Yaw torque** | `aTurn = -intent.steer * turnTorque` around **world Y** | The chase camera mirroring inverts what local-up math would predict. M9.4 reverted the M9.3 attempt at bike-local-up and pinned us to world Y. |
| **Lean roll target** | `+intent.steer * LIMIT * speedScale` (positive coefficient) | Same chase-cam mirroring; the math wants negative, the player perception wants positive. Nailed in M9.5b. |
| **Pitch spring** | `aPitch = (currentPitch - targetPitch) * SPRING` (note the order) | `(target - current)` was the wrong sign and produced a backflip when the player pressed E. M9.2. |
| **Q dives, E lifts** | `targetPitch = -intent.pitch * PITCH_LIMIT` | Q at intent=−1 → target +π/6 → fin pointing down. The keyboard.ts comments describe rider body action ("lean back" → Q), not bike pitch. The visual is the source of truth. |

Pitch and roll are **kinematic** in YXZ Euler decomposition — only yaw evolves from physics torques.

## Surface follow is altitude-faded — *load-bearing for "hover" feel*

`stats.surfaceFollow` is the **peak** responsiveness. The actual applied value is `surfaceFollow * altitudeFactor`, where the factor falls linearly from 1.0 at the water surface to 0 at the grounded/airborne boundary.

Pre-M9.22 the bike read every wiggle of the wave normal at all altitudes — read like a jet ski. Now reaction is strongest exactly when the bike is closest to the terrain. If wave riding feels too floaty, widen the fade or raise the per-bike `surfaceFollow`. Don't disable the fade.

Implementation in [`src/game/systems/hover.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/game/systems/hover.ts) inside the `isGrounded` branch.

## Bike wakes are physical, not cosmetic — *load-bearing*

Each bike's trailing wake **displaces the water mesh** AND **contributes to buoyancy**, and it follows the bike's **recorded path** — not a ray from its current heading. The sim owns a per-bike breadcrumb trail ([`engine/sim/water/wake-trail.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/engine/sim/water/wake-trail.ts), `field.trails`); buoyancy evaluates the wake profile along it (`sampleWakeFromTrail`, summed by the samplers in [`wave-field.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/engine/sim/water/wave-field.ts)), and the GPU shader at [`engine/render/water.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/engine/render/water.ts) uploads **the same trail points** each frame and mirrors the same profile — so the ridge a trailing rider feels is exactly the one drawn, through turns, jumps (real gaps) and dissolving stopped wakes.

`wakeUpdateSystem` feeds `field.trails` (and re-derives `field.wakes`, which only drives the at-hull dimple/propwash visuals) once per fixed step **before** `hoverSystem` reads the surface — that's what makes the lead bike's wake felt by trailing buoyancy. The bike's own wake doesn't affect itself at speed (the longitudinal ramp is zero at the live head), but riding back over your own laid trail is a real bump — donut-hopping is physical.

Trails are deterministic (pure functions of sim history at the fixed step) but intentionally **not snapshotted** — after a rollback/replay-seek they self-heal within ~2 s via the gap rules in `feedWakeTrail`.

If you're tweaking the wake constants, change them in **one place** (`wake-trail.ts`; re-exported through `wave-field.ts`) and both the CPU sampler and the shader pick them up via the imported names. Don't fork the values.

## Pitch + throttle on water is intentional — *not a bug*

Holding pitch=−1 (dive) at full throttle plants the bike's nose into wave troughs and submerge-and-bounces, with speed swinging 10 → 25 → 10 m/s as buoyancy kicks back. **This is the desired Wave Race feel.** Diving into a wave should *cost* you. Thrust is already projected to horizontal — the apparent "dive" is the bike's collider being driven through the wave field at speed, not a thrust-direction bug. Don't "fix" it.

## Player and AI share the same `ControlIntent`

Auto-play mode just adds `AITag` to the player so `aiControlSystem` writes their intent. The player intent path (`applyPlayerIntent`) is suppressed while auto-play is on. **Don't fork these paths** — anything that affects player movement should affect AI movement and vice versa.

## Debug API is the testing surface

`window.__hover` is the official surface for:

- Playwright e2e tests (drive the game programmatically)
- Claude / dev-tools inspection (read state, push synthetic input)

Keep it consistent with new features. If you add a new sim concept that's worth testing, expose it on `__hover`. See [Debug API](/reference/debug-api) for the current shape.
