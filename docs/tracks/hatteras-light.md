# Hatteras Light — parked to the B-list

> **Parked (v2 — no-open-water pass).** Hatteras is a lighthouse alone in
> open Atlantic (80 % open water) — pulled from the ship cups in the
> [no-open-water rework](./README.md) and parked to the
> [B-list](../track-themes.md#b-list--future-content-packs). Its build +
> design below are kept intact for a future content pack; it is simply off
> the cup roster.
>
> Cup: *(parked)* · The cup's emotional payoff: a vertical climb and a cliff
> drop that *lands* every lap.

## Identity

| | |
|---|---|
| **Cup** | Reef |
| **Lap target** | 50 s |
| **Laps** | 3 (~2:30 total) |
| **Water / Land** | 80 / 20 |
| **Anti-grav** | **none** *(was: light — lighthouse corkscrew, ~5 s — cut)* |
| **Verticality** | exterior gallery-spiral ramp + cliff drop |
| **Difficulty** | intro (Reef Cup closer) |

## Location & fiction

Cape Hatteras, North Carolina. The black-and-white spiral lighthouse now
stands a third submerged — the only landmark for kilometers. "Coast Guard
left in '78. Someone keeps the lamp spinning. The Circuit doesn't ask who."

## Layout & beats

Loop with a vertical climb + cliff-drop finish. Reference: MK8 Shy Guy
Falls (vertical column) + Jet Moto Cliffdiver (lap-ending drop).

| t (s) | Beat | Description |
|---|---|---|
| 0–12 | Open Atlantic | Heavy Beaufort 4–5 swell circling the base. First real wave-reading test. |
| 12–20 | Base approach | Wave-pumped lift toward the lighthouse; the ramp entry is staged here. |
| 20–32 | **The Lamp Room (set-piece)** | **Ride the exterior gallery-spiral ramp** up the shaft, past the rotating lamp, launch off the gallery railing. |
| 32–42 | **Cliff drop finale** | Long open-water descent back to sea level. Music swells on the launch. |
| 42–50 | Finish straight | Lower-altitude approach back to start |

Every lap ends with the cliff drop (Jet Moto Cliffdiver lesson) — three
intro tracks, and the third one lands every lap.

## Set-piece — The Lamp Room

The lighthouse is visible from anywhere on the track. You climb it on a
**rideable spiral ramp** — the wrecked exterior cast-iron gallery and
keeper's stair, collapsed into a continuous ~25–30° helical *road* that
wraps the tower 1.5× up to the gallery deck below the lamp. The lamp is
still rotating; you ride past it, then launch off the gallery railing (the
takeoff lip) into the cliff drop. Climb entry at ~40% of lap distance; the
launch at ~64% — the hard-section apex.

## Verticality without anti-grav

**Old:** an `antigrav_curve` Tube — a 60 m anti-grav corkscrew you rode up
the *outside wall* of the shaft (gravity flipped onto the tower face).

**New:** the same silhouette and the same ~50 m climb, but as a
**normal-gravity helix ramp** — primitive #3 in the
[replacement vocabulary](./README.md#replacement-verticality-vocabulary).
You're on a banked *road* spiraling up, never on a wall. The fiction sells
it: the iron gallery and external stair have peeled off the tower into a
ramp. The rotating-lamp timing hazard (Hard: the beacon arm blocks the
launch window 0.6 s every 4 s) is preserved at the launch lip. The
cliff-drop closer is unchanged.

## Hard section / branching / per-lap

- **Hard:** 20–32 s — holding the ramp line under centripetal pull while
  pumping the swell at the base. Late pumpers stall on the climb;
  over-pumpers overshoot the launch.
- **Branching:** inside vs outside the spiral lip (24–28 s — inside faster,
  steeper exit); cliff-drop pump timing (32–42 s — pumping the descent's
  wave train gives a 4–5 % top-speed bonus into the finish).
- **Per-lap:** the lamp rotates continuously and **lamp brightness
  intensifies across laps** (visual climax build; cheap shader uniform).

## Palette & audio

Cool Atlantic grays, white-and-black spiral, foam-green water, low gray
clouds. `cape_town_blue` sky reused (`seaStateBeaufort=5`, the highest in
Reef — Hatteras is the "you're ready for Open Sea" stress test). Ambient
surf + foghorn drones, sparse synth.

## Props — unique to Hatteras Light

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| Lighthouse cylinder | track | Hand-modeled ~60 m tall, ~12 m radius; iconic black/white spiral via 2 material slots (`mat_track_lighthouse_white` + `_black`). Base submerged ~20 m (cap for perf). |
| Lamp room | track | Open ironwork catwalk + glass dome + central lamp + railing; the railing rim is the **launch lip**. |
| `ramp_helix_gallery` | track | **Exterior spiral rideable ramp** wrapping the tower 1.5× to the gallery deck — replaces the cut anti-grav corkscrew. ~25–30° pitch, ~50 m climb, normal gravity. |
| `scatter_rocks` | scatter (`prop_rock`) | ~8 submerged shoal rocks. |
| `emitter_lamp_glare` | emitter (atlas 7) | Parented to the lamp; rotates with it. |
| `emitter_foghorn_mist` | emitter (atlas 1) | Cold-air-on-warm-water at the base. |
| `emitter_atlantic_spray` | emitter (atlas 9) | ~3 empties across the open Atlantic zone. |

> **Retired:** `antigrav_curve_NN` (Tube profile, the lighthouse
> corkscrew) — replaced by `ramp_helix_gallery`. No palms (wrong climate).

## References

- [../track-design-specs.md](../track-design-specs.md) §2.3 — beat timing,
  wave-zone surge config, emitters (anti-grav tube spec there is retired).
