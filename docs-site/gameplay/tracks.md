# Tracks & races

## Shipped tracks

The named city tracks — every one a post-flood city, real or fictional — are the
playable lineup:

| Track | URL | Notes |
|---|---|---|
| Mayday Bay | `?track=sandbar` | Tutorial lagoon; Reef Cup opener. **Art-dressed.** (Slug stays `sandbar`; display name is Mayday Bay.) |
| Mexico City | `?track=mexico-city` | Reef Cup round 2. Greybox route-stub. |
| Cape Town Drift | `?track=cape-town-drift` | Reef Cup finale. Greybox route-stub. |
| The Maw | `?track=the-maw` | Figure-8 slalom. **Art-dressed.** |
| Shibuya Submerged | `?track=shibuya-submerged` | Greybox route-stub. |
| Liberty Drowned | `?track=liberty-drowned` | Greybox route-stub. |
| Kilauea Crown | `?track=kilauea-crown` | Greybox route-stub. |
| Marina Bay 7 | `?track=marina-bay-7` | Greybox route-stub. |
| Doge's Drift | `?track=doges-drift` | Greybox route-stub. |
| Aqualand | `?track=aqualand` | Greybox route-stub. |
| Angkor Drowned | `?track=angkor-drowned` | Greybox route-stub. |
| Hatteras Light | `?track=hatteras-light` | Greybox route-stub. |
| Golden Gate Drowned | `?track=golden-gate-drowned` | Greybox route-stub. |

::: warning Only two are art-complete
`status: 'ship'` means **wired and playable, not art-complete.** Only **Mayday Bay**
and **The Maw** are dressed; the rest are greybox route-stubs awaiting the v2 art
pass. The current proof-of-thesis is the **Reef Cup** (Mayday Bay → Mexico City →
Cape Town Drift) — see [`docs/tracks/README.md`](https://github.com/unclemattmakes/king-tide/blob/main/docs/tracks/README.md) for the canonical lineup.
:::

A handful of **procedural dev tracks** also ship for engine and physics work — they're
built in code, not authored as city levels:

| Track | URL | Notes |
|---|---|---|
| Lagoon Loop | `/` (default) or `?track=lagoon` | Stadium loop with a jump ramp on the right straight. Exercises raycast-vs-static-collider, surface alignment on a slope, and water re-acquisition on landing. |
| Cliffside | `?track=cliffside` | Mesa with a climb ramp on one side and a JetMoto-style cliff drop on the other. Doubles as the Blender-export reference layout. |
| Calibration | `?track=calibration` | Spec → GLB pipeline test. Round-trips through `tools/blender/build_track.py`. Useful as a clean reference scene. |
| Test Ring | `?track=test-ring` | Tiny diagonal-octagon for quick physics smoke tests. |

`?track=` and `?bike=` compose: `http://localhost:5191/?track=cliffside&bike=stunt` is "the most fun config" per the README.

## Race rules

- **3 laps to finish** by default (`lapsToFinish` in track JSON).
- **Checkpoint enforcement**: a checkpoint is only counted when crossed in order, in the **forward** direction — driving backwards through a gate is ignored.
- The **direction arrow** (Crazy Taxi style) above the player points to the next checkpoint. A **sky beacon** marks the gate itself.
- Crossing the start line after the final lap triggers the **finish overlay** — best lap, total time, and a Restart (`R`) prompt.
- **Best lap** is saved to localStorage per `(track, bike)` pair. View / clear it from the Garage menu.
- **Boost pads** are live gameplay: driving over a pad's volume applies a forward boost (`boostPads` in track JSON). Place them in Blender or the in-app editor.

## AI racers

The grid is 8 bikes: you plus **seven AI opponents**. They:

- Follow a **smooth-arc racing spline** (`buildStadiumAISpline`) through the corners with per-bike line offsets so they hold parallel lines instead of converging into a pile-up.
- Scan ~1.5 s of upcoming spline, derive an implied corner radius, and cap target speed at `√(latAccel × radius)`. Brake fires when current speed exceeds that target.
- **Rubber-band** to the leader — top speed adjusts to gap so the pack stays tight.
- **Fire their own pickups** via `aiCombatSystem` (see [Pickups & combat](/gameplay/pickups#ai-pickup-usage)).

::: warning Cliffside AI is rough
The climb ramp + cliff drop create a dead-end the AI can't recover from once it lands off-mesa. The bottom half of the track is fine. This is a level-design limitation, not a controller bug — see [`status.md`](https://github.com/unclemattmakes/king-tide/blob/main/docs/status.md) and the README's *Known issues*.
:::

## Auto-play mode

Press `T` or `F1` to toggle auto-play — the AI takes over the player bike. Useful for:

- Testing physics or input changes without holding a controller
- Demoing without a controller plugged in
- Sanity-checking that an AI spline actually completes a lap

Player and AI share the same `ControlIntent` plumbing — auto-play just adds `AITag` to the player so `aiControlSystem` writes their intent. Player intent is suppressed while auto-play is on.

## Spawning

The player spawns on the racing line at the start gate, facing forward. `Backspace` respawns at start with zero velocity (snap teleport, no fade). Useful when you've yeeted yourself off the world.

## Track data format

Two flavors of track exist:

- **Procedural** (`lagoon`, `cliffside`) — built in code, in [`src/game/tracks/lagoon-loop.ts`](https://github.com/unclemattmakes/king-tide/blob/main/src/game/tracks/lagoon-loop.ts) and [`cliffside.ts`](https://github.com/unclemattmakes/king-tide/blob/main/src/game/tracks/cliffside.ts). Not editable in the in-app editor.
- **JSON-driven** (`calibration`, `test-ring`, `lagoon-edit`, anything you author) — gameplay data lives in `public/tracks/<id>.json`, optionally referencing a Blender-built `environmentGlb`.

For authoring, see [Modding → Tracks](/modding/tracks).
