# Sandbar — Tutorial

> Cup: none (tutorial) · The classroom. Every other track is a spectacle;
> this one teaches one mechanic per beat.

## Identity

| | |
|---|---|
| **Cup** | None (tutorial) |
| **Lap target** | 60 s scripted |
| **Laps** | 1 |
| **Water / Land** | 80 / 20 |
| **Anti-grav** | **none** *(was: brief intro arch — cut)* |
| **Verticality** | a single crest-launch (frozen-wave sand dune) |
| **Difficulty** | intro |

## Location & fiction

A sheltered training cove — fictional. A retrofitted post-flood marina
serving as the Circuit's pilot-training facility: calm water, a small
island, a single ramp. Short, scripted, visually low-key on purpose.

## Layout & beats

Teaches one mechanic per beat; **pumping is taught in the first 8 seconds**
so the hero mechanic is the first lesson, not the second (Wave Race 64
Sunny Beach lineage).

| t (s) | Beat | Lesson |
|---|---|---|
| 0–8 | Start swell | **Throttle + first pump**, explicit HUD prompt |
| 8–20 | Steering arc | Wide left-hand bend |
| 20–32 | Drift marker | Drift around a marker buoy |
| 32–42 | Pickup + jump | Grab pickup, use, ramp jump w/ landing prompt |
| 42–55 | **Crest launch** | Surf up a sand-dune crest and launch — the "pump the land like a wave" lesson |
| 55–60 | Finish straight | Return to start |

Auto-skip toggle for returning players.

## Set-piece

None — the tutorial is deliberately low-key. The **pumping HUD prompt** is
the focal moment; everything stages around it.

## Verticality without anti-grav

The old 42–55 s beat was a brief anti-grav arch (the intro to the gravity
flip). With anti-grav cut, that beat becomes the **crest launch**: a
frozen-wave sand dune you surf up and launch off, landing back on water.
This teaches the exact transfer skill the reworked set uses everywhere —
*a hill crest is read like a swell crest.* It replaces a one-off system
lesson (gravity flip) with a lesson that pays off on ten other tracks.

> Removes the **`ANTI-GRAV`** beat from the tutorial director's
> sequence (THROTTLE → CRUISE → LOOK → WAVE PUMP → DRIFT → ~~ANTI-GRAV~~ →
> READY). The freed slot can fold into READY or add a second crest rep.

## Hard section / branching / per-lap

None — single scripted lap, no branches.

## Palette & audio

`miami_pastel` sky, mid-morning. Vaporwave-lite training loop; **stronger
pump-duck (0.5)** so the audio swap on a successful pump is unmistakable
while the game is *teaching* the mechanic.

## Props — unique to Sandbar

*(Common gameplay/system + dressing props are in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| `terrain_island` | terrain | Single central peak ~20 m, base radius 80 m — the cove's small island. |
| `marker_buoy` | decoration | Drift target for the 20–32 s beat. |
| `ramp_jump` | track | Training ramp for the 32–42 s jump lesson. |
| `crest_berm` | track / terrain | **Frozen-wave sand-dune crest** for the 42–55 s launch — replaces the cut anti-grav arch. |
| Tutorial sign empties | decoration | Arrow empties at each beat boundary; the runtime tutorial anchors HUD prompts to them. |
| `scatter_palms` | scatter (`prop_palm`) | Sparse cove-edge palms (~12). |
| `pilot_shack` | decoration | The marina's **pilot-school shack** — a solid corrugated-roof cabin with painted plank walls, the built hero of the cove. AI-lane prop. See [sandbar-art-target.md](./sandbar-art-target.md) §Marina hub. |
| `marina_dock` | decoration | The stilt timber **dock/pier** the shack sits on, reaching into the cove. Procedural (spanning) — thin planks + pilings fragment in image-to-3D. |
| `dock_piling` | decoration | Mooring **pilings / bollards** along the dock edge and cove shallows. Procedural (thin). |
| `emitter_pump_hint` | emitter (atlas 0) | Parked on the first wave crest — "something happens here" before the player arrives. |
| `emitter_gulls` | emitter (atlas 5) | Sparse gull flock over the cove — a few moving things to sell "alive". |

> **Retired:** `antigrav_curve_NN` (the brief intro tube) — gone.

## References

- [sandbar-art-target.md](./sandbar-art-target.md) — **near-shipping visual
  build-target** from the Midjourney concept pass (per-beat build actions,
  palette, waterline trio, build order). Layout stays as authored; this is the
  *look* to build toward.
- [../track-design-specs.md](../track-design-specs.md) §2.0 — beat timing,
  wave-zone, emitter, audio, camera configs.
- [../track-themes.md](../track-themes.md) — tutorial framing.
