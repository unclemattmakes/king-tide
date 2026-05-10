# ADR 0004 — Physics: `@dimforge/rapier3d-compat`

**Status:** Accepted

## Context

The hover/race feel depends on a real rigid-body integrator —
spring-driven hover forces, slope-projected momentum, lean-into-turn
weight transfer, and missile/mine impacts all read and write the
physics state every tick. A custom integrator was never realistic
given the timeline.

The choice was effectively between Cannon (older, JS-native) and
Rapier (Rust → WASM). Rapier wins on stability, contact-resolution
quality, and on having a `*-compat` deterministic build that uses
SIMD-free code paths for cross-machine reproducibility — important
for replay parity.

## Decision

Use `@dimforge/rapier3d-compat`. The `compat` build is the
deterministic one; we deliberately do not use the regular `rapier3d`
package even though it's faster, because replay determinism is
load-bearing for the recorder/player flow.

`createPhysicsWorld` in `src/engine/sim/physics/rapier.ts` owns
initialisation (Rapier needs a one-time `await RAPIER.init()`). All
sim systems take a `PhysicsWorld` parameter and access rigid bodies
via `RBHandleStore`, never by holding raw Rapier handles in sim
state.

## Consequences

- **Boot is async.** `boot()` awaits the renderer setup *and* the
  physics world before any sim entity is spawned.
- **Replay can re-derive bike poses from input alone (in theory).**
  In practice the recorder also captures sampled poses for
  resilience; with deterministic Rapier, the captured poses are
  redundant but cheap insurance against drift.
- **Tunneling is handled by CCD on bikes + slab surfaces** (see the
  M9.28 commit). New fast-moving entities should opt into CCD.
- **WASM payload.** Rapier adds ~600 kB to the bundle (most of the
  non-Three weight). Worth it; alternatives don't match the contact
  quality.
