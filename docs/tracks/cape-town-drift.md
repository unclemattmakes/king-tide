# Container Chaos — Reef Cup #2

> Cup: Reef · The set's calm-water skill check — the Drake Lake of the v1
> lineup.

> **Renamed 2026-08-20 — Container Chaos.** Every King Tide venue is now a fictional
> city, so this track's player-facing name is **Container Chaos**. The slug stays
> `cape-town-drift` (GLB, track JSON, R2 asset keys, Blender seed and the saved
> best-lap ledger all key off it), and the real-world references below stay
> as *art reference* — they're where the look comes from, not what the venue
> is called in game.

## Identity

| | |
|---|---|
| **Cup** | Reef |
| **Lap target** | 48 s |
| **Laps** | 3 (~2:24 total) |
| **Water / Land** | 60 / 40 |
| **Anti-grav** | **none** *(never used it — unchanged by the pass)* |
| **Verticality** | minimal (flat-water slalom track) |
| **Difficulty** | intro (calm-water skill check) |

## Location & fiction

Drowned V&A Waterfront, Cape Town. Table Mountain still dominates the
skyline, flat-top profile unmistakable. Lower streets submerged; the
harbor is a ruin field of shipping yards, the aquarium, and the
half-tilted Cape Wheel. "Table Mountain didn't notice. Everything below it
did."

## Layout & beats

Loop with a central tunnel-feel section. Reference: Wave Race 64 Drake Lake
(calm-water skill) + Marine Fortress (one-shot-kill option).

| t (s) | Beat | Description |
|---|---|---|
| 0–10 | Harbor mouth | Outside the breakwater; Beaufort 3 chop |
| 10–22 | **Glass harbor slalom** | Beaufort 1 interior; weave half-sunk containers + a tipped ferry. Pumping no longer pays — racing line does. |
| 22–32 | **Two Oceans Wreck (set-piece)** | Through the broken aquarium roof, past the watching great white, out the seaward wall |
| 32–42 | Cape Wheel underpass | Under the leaning Ferris wheel's bottom arc (bike pitches up to clear — no gravity flip) |
| 42–48 | Finish straight | Past waterfront market remnants back to start |

## Set-piece — Two Oceans Wreck

The aquarium's predator tank shattered when the flood came; a great white
still circles inside. You race through the broken roof, past the shark, and
out the other side. The shark silhouette is visible through the broken
glass from the harbor mouth (beat 1). Plays at 45–67% of lap distance. The
shark is decoration (no collision); the aquarium shell is `kind=track`.

## Hard section / branching / per-lap

- **Hard:** 10–22 s (glass slalom) — reading the slack-water line with no
  swell to push you. Hitting debris on calm water is uniquely punishing.
- **Branching:** **aquarium skylight shortcut** — drop through a skylight
  straight into the predator tank (~2 s; one-shot-kill rim — the cup's
  high-risk expert line); Cape Wheel inside vs outside arc.
- **Per-lap:** none. Tide + weather constant.

## Calm-water role

This track exists so pumping is **legible as a skill** on the other ten.
The harbor interior runs at Beaufort 1–2; the global `seaStateBeaufort` is
the lowest in the Reef Cup and the harbor zone pushes it lower still.
Nothing here needs verticality — the challenge is precision, not air.

## Palette & audio

Bright Atlantic blue, grey-green flat-top mountain, red Cape Wheel struts,
oxidized container reds. `cape_town_blue` sky. Afrobeats fusion, marimba
over electronic; **low pump-duck (0.20)** since pumping rarely happens here.

## Props — unique to Cape Town Drift

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| Breakwater wall | track | Single elongated mesh forming the harbor boundary. |
| Half-sunk container stack | track | ~6 meshes, mixed orientations. |
| Broken aquarium structure | track | Concrete shell with roof + seaward-wall openings; the **skylight rim** (one-shot-kill shortcut) is a sharp top edge on this mesh. |
| Great white shark | decoration | Circles inside the tank; no collision. |
| Tipped ferry | decoration | Emerging from the harbor mouth. |
| Cape Wheel | track + decoration | Lower arc `kind=track` (bike passes under); upper struts/cars decoration. |
| `road_curve_main` | track | Short waterfront-market slab (finish straight). |
| Table Mountain horizon ring | bespoke `horizon_ring` | Flat-topped silhouette — **30% of the track's identity; lock early.** |
| `scatter_rocks` | scatter (`prop_rock`) | ~25 coral/debris in the harbor. |
| `emitter_shark_water` | emitter (atlas 3) | Foam over the tank — implies the shark is breathing. |
| `emitter_container_rust` | emitter (atlas 1) | Wet-decay over the container stack. |

## References

- [../track-design-specs.md](../track-design-specs.md) §2.2.
