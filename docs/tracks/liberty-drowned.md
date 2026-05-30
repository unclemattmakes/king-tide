# Liberty Drowned — Drowned Cup #3 · **FINALE**

> Cup: Drowned (v1 finale) · The last lap of every championship season.
> Nothing else lands as hard.

## Identity

| | |
|---|---|
| **Cup** | Drowned (finale) |
| **Lap target** | 70 s |
| **Laps** | 3 (~3:30 total) |
| **Water / Land** | 80 / 20 |
| **Anti-grav** | **none** *(was: heavy — torch-arm underside + crown interior, ~25 s — cut)* |
| **Verticality** | ride-up the fallen torch arm + crown-spike gates + harbor drop |
| **Difficulty** | finale |

## Location & fiction

Drowned Manhattan. The Statue of Liberty half-submerged — water at her
waist, her torch arm collapsed forward across Liberty Island's old
battlements. Lower Manhattan rooftops break the harbor: Trinity Church
spire, Charging Bull underwater, the Wall Street bull-pit a shoal of yellow
cabs, Brooklyn Bridge cables sagging into the harbor. "She fell forward in
'71. Nobody could lift her up again."

## Layout & beats

3-section loop. Reference: MK8 Big Blue (3-section ribbon) + MK8 Mario
Circuit (wow-factor) + MKW Crown City (multi-route — deferred to v1.1).

| t (s) | Beat | Description |
|---|---|---|
| 0–18 | **Manhattan harbor straight** | Open harbor pass — Trinity spire, Charging Bull underwater, sagging Brooklyn Bridge cables. Skyline framing. |
| 18–35 | **The Torch Arm (set-piece)** | Ride *up the fallen torch arm* to the flame; launch off the fist. ~12 s of vertigo and copper-green oxidation. **The v1 postcard moment.** |
| 35–52 | **Crown gates** | Fly the gap between the crown's broken spikes — a big-air clip-hazard corridor — past Liberty's head. |
| 52–70 | Descent + finish straight | Long descent past her submerged shoulder, across the harbor back to start. Sunset gold. |

## Set-piece — The Torch Arm

The broken arm itself: copper-green oxidation, riveted construction, the
torch flame still lit in the clenched fist. The arm has fallen forward
across the battlements, so its **upper surface is a natural rising
causeway** — you ride *up* it to the torch and launch off the flame, the
harbor and Liberty's fingers framing the shot. Visible from the start grid;
becomes the visual focus at t≈12. Plays at 26–50 % of lap distance —
slightly early, justified because it's the postcard.

## Verticality without anti-grav

The finale carried the most anti-grav in the set; all three pieces are
rebuilt normal-gravity:

| Old (anti-grav) | New (normal gravity) |
|---|---|
| **Torch-arm underside ribbon** — ride the *underside* of the arm, harbor above you through her fingers (gravity flipped). | **Ride the top of the fallen arm** as a rising ramp/causeway (primitive #2) — a triumphant ascent to the torch + launch off the fist. The vertigo and the framing survive; the flip doesn't. |
| **Crown interior tube** — an anti-grav loop *inside* the hollow crown chamber, exit out a window. | **Crown-spike gates** — fly the big-air gap *between* the crown's broken spikes (primitive #5, gated drop). A clip-hazard corridor; miss the gap, clip a spike. |
| **Brooklyn Bridge cable ribbon** — a vertical ribbon wall-ride along a sagging cable. | **Ride the top of a taut cable** as a narrow rail/tightrope (a thin road, normal gravity) — still one of the hardest expert lines in v1. |

This is the clearest demonstration that the postcard survives the cut: the
torch arm reads *better* as a heroic ride-up-and-launch than as an
upside-down underside crawl.

## Hard section / branching / per-lap

- **Hard:** 35–52 s (crown gates) — threading the big-air gap between spikes
  with a tight margin; clip a spike and you crash.
- **Branching:** three torch-arm approaches (over the wrist / through the
  fingers — fastest / under the elbow — safest); **Brooklyn Bridge cable
  tightrope** shortcut (0–18, ~5 s, one of v1's hardest lines); crown gate N
  vs S (N faster but worse finish-straight line).
- **Per-lap:** lap 1 gets a one-time "look up / ride up" HUD cue entering
  the torch arm; laps 2–3 none. **Music builds in three tiers** (lap 1
  opener → lap 2 build → lap 3 climax) — the finale should *land*.

## Palette & audio

Copper-green oxidation, NYC granite gray, harbor steel-blue, sunset orange
on water — end-of-day finale lighting always. `nyc_sunset` sky. Hip-hop +
orchestral hybrid: big horns, heavy 808s, choral swells; **3-tier build**
matching the lap structure, loudest on the torch-arm beat.

## Props — unique to Liberty Drowned

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| Statue of Liberty | track | Hand-modeled assembly: torso + raised arm + head; copper-green oxidation. |
| `ramp_torch_arm` | track | The fallen torch arm as a **rising rideable ramp/causeway** (ride the top) ending at the flame/fist launch lip — replaces the cut underside ribbon. ~80 m. |
| `crown_spike_gates` | track | Liberty's broken crown spikes as a **big-air gate corridor** you fly between — replaces the cut interior anti-grav loop. |
| Brooklyn Bridge | track + decoration | Two tower meshes + sagging cables; one cable flagged `kind=track` as a rideable narrow rail (`rail_bridge_cable`) — the tightrope shortcut, replaces the cable ribbon. |
| `downtown_NN` (submerged) | track | Manhattan rooftop grid under the harbor; X=8 Y=8, building tops at/just under the water. |
| Charging Bull, Trinity spire | decoration | Individual meshes poking through the harbor. |
| Manhattan + Brooklyn horizon ring | bespoke `horizon_ring` | Empire State, Chrysler skyline behind; Brooklyn on the east arc. **Critical — the finale's identity is the skyline behind it.** |
| `emitter_torch_flame` | emitter (atlas 2) | Rising flame at the fist — *still lit.* |
| `emitter_oxidation_shimmer` | emitter (atlas 10) | 4+ spots on the copper surfaces. |
| `emitter_harbor_spray` | emitter (atlas 9) | 3 locations across the harbor straight. |
| `emitter_crown_dust` | emitter (atlas 4) | At the crown — implies it's rarely visited. |
| `emitter_bridge_cable_drip` | emitter (atlas 3) | Seawater dripping off the cables. |

> **Retired:** all three `antigrav_curve_NN` (Ribbon torch underside, Tube
> crown loop, Ribbon bridge cable) — replaced by `ramp_torch_arm`,
> `crown_spike_gates`, and `rail_bridge_cable`. Needs the lap-keyed music
> tier hook (specs §3.8).

## References

- [../track-design-specs.md](../track-design-specs.md) §2.11 (the three
  anti-grav curve specs there are retired).
