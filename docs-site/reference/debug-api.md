# Debug API

`window.__hover` is the dev-only API for driving + inspecting the running game. Available on `pnpm dev` and during Playwright runs (`MODE === 'test'`); stripped from production builds.

```ts
// Type lives in src/debug.ts
declare global {
  interface Window {
    __hover?: HoverDebug
  }
}
```

Use it from the browser DevTools console, from a Playwright spec via `page.evaluate(() => window.__hover!.player())`, or from the Claude Preview MCP.

## Lifecycle

| Property | Notes |
|---|---|
| `__hover.ready` | `true` once boot completes (renderer up, world built, player spawned). Most other accessors return `null` / safe defaults until then. |

## Renderer / loop

| Method | Returns | Notes |
|---|---|---|
| `backend()` | `'webgpu'` \| `'webgl2'` | Which renderer was selected at boot. |
| `fps()` | number | Smoothed framerate. |
| `frame()` | number | Total frames since boot. Useful as a deterministic time axis in tests. |

## Input

| Method | Notes |
|---|---|
| `gamepads()` | Snapshot of every connected pad: `{ axes, buttons, mapping, … }` per index. |
| `intent()` | The current merged player intent. `{ throttle, steer, brake, fire, boost, pitch }`. |
| `setIntentOverride(intent \| null)` | Pin the player's intent. Bypasses keyboard / gamepad until you pass `null`. The canonical way for tests to "drive" the bike. |

## Player state

| Method | Returns | Notes |
|---|---|---|
| `playerEid()` | number \| null | ECS entity id of the player bike. |
| `player()` | `{ position, velocity, groundDistance, isGrounded, speed }` \| null | Per-frame snapshot. |
| `race()` | `{ lap, lapsToFinish, nextCheckpoint, checkpointsCrossed, totalCheckpoints, finished, raceTime }` \| null | Race progress. |
| `standings()` | `Standing[]` | Rank ordering (player + AI). |

## All bikes

| Method | Returns | Notes |
|---|---|---|
| `bikes()` | `BikeDebugSnapshot[]` | Every bike's `pos`, `vel`, `rot` (quaternion), `angvel`, `intent`, `held` pickup. Critical for AI debugging. |

## Pickups

| Method | Notes |
|---|---|
| `heldPickup()` | The player's held pickup type, or `null`. |
| `setHeldPickup(type \| null)` | Force the player's held pickup. For deterministic e2e tests. |
| `setBikeHeldPickup(eid, type \| null)` | Same, but for any bike — for AI-fires-pickup tests. |

## Combat

| Method | Notes |
|---|---|
| `combat()` | `{ shieldRemaining, stunRemaining }` for the player. |
| `combatEntityCounts()` | `{ mines, missiles }` — count of live mine + missile entities, regardless of render. |

## Auto-play

| Method | Notes |
|---|---|
| `toggleAutoPlay()` | Flip auto-play on / off. Returns the new state. |
| `isAutoPlay()` | Current auto-play state. |

## Patterns

### Probe the player from the console

```js
window.__hover.player()
// → { eid: 42, position: { x: 0, y: 1.2, z: -120 }, velocity: { ... }, speed: 24.3, ... }
```

### Drive the bike in a test

```ts
await page.evaluate(() => {
  window.__hover!.setIntentOverride({
    throttle: 1, steer: 0, brake: 0, fire: false, boost: false, pitch: 0,
  })
})
await page.waitForTimeout(2000)
const player = await page.evaluate(() => window.__hover!.player())
expect(player!.speed).toBeGreaterThan(20)
```

### Deterministic pickup test

```ts
await page.evaluate(() => window.__hover!.setHeldPickup('missile'))
await page.evaluate(() => window.__hover!.setIntentOverride({
  throttle: 1, steer: 0, brake: 0, fire: true, boost: false, pitch: 0,
}))
await page.waitForTimeout(100)
const counts = await page.evaluate(() => window.__hover!.combatEntityCounts())
expect(counts.missiles).toBe(1)
```

## Why this exists

Two reasons:

1. **e2e tests need a deterministic surface.** The intent override + entity inspection lets Playwright drive scenarios without timing flake.
2. **Inspection from outside the page.** Claude (via the Claude Preview MCP) can `preview_eval` against `window.__hover` to read state without screenshots, which is essential for debugging "why did the bike just do that" questions during dev.

Source: [`src/debug.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/debug.ts).
