# Pickups & combat

Pickup boxes are scattered around each track. Drive through one to grab whatever's in it — there's a single slot per bike. `Space` (or `A` / `X` on a gamepad) fires it. Picking up a new type while holding one **replaces** the held pickup.

## The four pickup types

| Pickup | Color | Effect |
|---|---|---|
| **Boost** | yellow / orange | Speed multiplier. Throttle is multiplied by `boostMul` (default 1.6) for a few seconds. |
| **Shield** | blue | 6 s bubble. Absorbs **one** mine or missile hit, then consumes itself. Doesn't block ramming. |
| **Mine** | red | Drops behind you with a 0.6 s arming delay. Proximity trigger spinouts the victim. |
| **Homing missile** | white | Acquires the nearest bike inside a forward cone (≤ 80 m, `dot ≥ 0.3`). Turn rate capped at 2.4 rad/s. 5 s self-destruct if it doesn't hit. |

Implementation: [`src/game/components/pickup.ts`](https://github.com/unclemattmakes/king-tide/blob/main/src/game/components/pickup.ts) + [`src/game/components/combat.ts`](https://github.com/unclemattmakes/king-tide/blob/main/src/game/components/combat.ts).

## The pool

Each pickup box draws from a **weighted pool**:

```ts
const POOL: PickupType[] = ['boost', 'boost', 'missile', 'mine', 'shield']
```

Boost is over-represented (2× weight) because it's the safe baseline — the offensive pickups are higher-stakes, so they should feel more like a treat than a default. Tune the ratio in [`pickup-spawn.ts`](https://github.com/unclemattmakes/king-tide/blob/main/src/game/entities/pickup-spawn.ts) if combat starts dominating racing.

## Hit reaction

Whether it's a mine or a missile, the victim gets the same shared response:

- **Linear-velocity damp** × 0.55
- **Yaw spinout** of ±12 rad/s (random sign)
- **`Stun` component** for 1 s — `stunOverrideSystem` zeroes throttle / steer / brake / pitch on the victim until it expires
- **Fire and Boost** are *not* zeroed during stun — you can still pop a held pickup in self-defense

## AI pickup usage

The four AI bikes fire their pickups via `aiCombatSystem`. Decision logic is in the pure helper `shouldAIFire(held, throttle, |steer|, hasChaser, hasMissileTarget)`:

| Pickup | Fires when |
|---|---|
| **Boost** | `throttle > 0.85` (clean straight, never burns it scaled-down mid-corner) |
| **Shield** | held — sitting on it can't help |
| **Mine** | a non-self bike is within 12 m and behind us (`dot < -0.4`), OR mid-corner (`|steer| > 0.4`) to hazard the racing line |
| **Missile** | `throttle > 0.8` AND `pickMissileTarget()` finds a bike in our forward cone |

Twelve unit tests cover the gates — see `tests/unit/m9-ai-combat.test.ts`.

## Pickup respawn

When a player or AI grabs a box, it goes inactive for a few seconds before the next type is rolled. Spawn state is per-spawn-point (`PickupSpawnState`), not per-track, so respawn windows are independent.

## Where pickup boxes live

In a track JSON file, the `pickups` array is just a list of world-space `[x, y, z]` triples:

```json
{
  "pickups": [
    [14, 14, 1.0],
    [-14, -14, 1.0]
  ]
}
```

In the in-app editor, `+ Pickup` arms the place tool — the next ground click drops one. See [Modding → Tracks](/modding/tracks).
