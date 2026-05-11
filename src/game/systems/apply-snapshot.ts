/**
 * M10.11 — sim-side receiver for `TransformSnapshot` messages.
 *
 * Applies each record in an inbound snapshot to its matching local rigid
 * body, overwriting position / rotation / velocity. This is the partner of
 * the broadcast hook in `main.ts`: owners broadcast at 20 Hz, every other
 * peer (re)builds their world from those snapshots.
 *
 * Two body-type paths:
 *
 *  - **Kinematic** (AI bikes on non-host, remote-peer bikes everywhere):
 *    `setNextKinematicTranslation` / `setNextKinematicRotation`. These
 *    enqueue the target pose for the next physics step so Rapier's
 *    kinematic interpolation stays coherent with our snapshot cadence.
 *    Kinematic bodies don't read linear velocity, so the velocity field is
 *    ignored on this path.
 *  - **Dynamic** (rare on the receive side — only if a body hasn't been
 *    flipped to kinematic yet, e.g. during a host changeover): the
 *    "respawn" pattern from `main.ts:respawnPlayer` — `setTranslation`,
 *    `setRotation`, `setLinvel`. We also zero `angvel` because the
 *    snapshot omits angular velocity (see §3b) and a stale angular impulse
 *    would fight the new orientation.
 *
 * Skips silently when:
 *
 *  - the lookup returns `null` (snapshot record for a peer we don't know
 *    about yet, e.g. AI snapshot before our local AI bikes have spawned);
 *  - the eid resolved by lookup has no `RBHandle` component;
 *  - `phys.world.getRigidBody(handle)` returns null (body destroyed).
 *
 * @see docs/m10-11-state-sync.md §5b
 * @see docs/m10-11-state-sync.md §11 (future: update race-system prevSigned cache)
 */
import type { BikeSnapshotRecord, TransformSnapshot } from '@/engine/net/transform-snapshot'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { RBHandleStore } from '@/game/components'

/**
 * Resolves a record from a `TransformSnapshot` to a local entity id, or
 * `null` if the record doesn't map to anything in this client's world.
 *
 * Callers in `main.ts` construct this closure once per sim/asset boot and
 * reuse it for every snapshot — it captures the local player eid, the
 * AI eid array, and the `peerId → remoteBikeEid` map.
 */
export type SnapshotEidLookup = (record: BikeSnapshotRecord) => number | null

/**
 * Apply each record in `snapshot` to the matching local rigid body. See
 * the module doc for the kinematic vs dynamic dispatch and the silent-skip
 * conditions.
 *
 * `sim` is unused in this initial implementation — only `RBHandleStore`
 * and `phys.world` are needed. It stays in the signature so future logic
 * (writing back to `Transform` component, syncing the race system's
 * `prevSigned` cache per §11) can land without a call-site change.
 */
export function applySnapshot(
  sim: SimWorld,
  phys: PhysicsWorld,
  snapshot: TransformSnapshot,
  lookup: SnapshotEidLookup,
): void {
  void sim // reserved for future use; see tsdoc

  const Dynamic = phys.rapier.RigidBodyType.Dynamic

  for (const record of snapshot.bikes) {
    const eid = lookup(record)
    if (eid === null) continue

    const rbHandle = RBHandleStore.get(eid)
    if (!rbHandle) continue

    const rb = phys.world.getRigidBody(rbHandle.handle)
    if (!rb) continue

    if (rb.bodyType() === Dynamic) {
      // Dynamic path — the "respawn" pattern from main.ts:respawnPlayer.
      // Wake the body (wakeUp=true) so it doesn't stay asleep after the
      // pose change.
      rb.setTranslation(record.position, true)
      rb.setRotation(record.rotation, true)
      rb.setLinvel(record.velocity, true)
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
    } else {
      // Kinematic path — enqueue next-step pose. Kinematic bodies don't
      // consume linear/angular velocity, so we skip those writes.
      rb.setNextKinematicTranslation(record.position)
      rb.setNextKinematicRotation(record.rotation)
    }
  }
}
