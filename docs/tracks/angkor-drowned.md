# Angkor Drowned — Drowned Cup #2

> Cup: Drowned · Atmosphere and verticality: the smiling faces of Bayon and
> a climb up the temple stairs.

## Identity

| | |
|---|---|
| **Cup** | Drowned |
| **Lap target** | 62 s |
| **Laps** | 3 (~3:06 total) |
| **Water / Land** | 65 / 35 |
| **Anti-grav** | **none** *(was: heavy — central-spire corkscrew, ~15 s — cut)* |
| **Verticality** | monumental temple-stair ramps |
| **Difficulty** | late-mid |

## Location & fiction

Angkor Wat complex, Cambodia. The ocean reached this far inland. Massive
temple, jungle reclaiming the upper levels, monkeys still in the towers,
moss everywhere. "Angkor outlasted the Khmer Empire. The Mongols. The Khmer
Rouge. The flood is just the latest thing it'll outlast."

## Layout & beats

Loop with a vertical climb + high-risk root tunnel. Reference: MK8 Cloudtop
Cruise (canopy "weather window") + Dragon Driftway (environment-as-track) +
Marine Fortress (root tunnel shortcut).

| t (s) | Beat | Description |
|---|---|---|
| 0–14 | **Bayon faces straight (set-piece)** | Past 16 of Bayon's smiling-face towers in sequence. Wide approach, low chop. |
| 14–28 | Ta Prohm root weave | Strangler-fig roots arch across the path; tight chicane. Hidden root-tunnel shortcut. |
| 28–40 | Inner courtyards | Flooded inner court; bisected path around the central pond. Visual breather. |
| 40–55 | **Temple-stair climb** | Ride up the monumental stepped staircases of the central spire. Music swells. |
| 55–62 | Descent + finish straight | Glide down the outer staircase back to the Bayon approach |

## Set-piece — The Smiling Faces

Bayon temple. Every tower has four giant serene stone faces looking outward;
you race past sixteen of them in sequence on the opening straight. They've
been watching for nine centuries; the flood didn't change that. Visible from
the start grid — the set-piece is at 0–22 % of lap distance (early), framing
the whole lap emotionally while the spire climb at 65–89 % carries the skill.

## Verticality without anti-grav

**Old:** an `antigrav_curve` Tube — an ~85 m anti-grav corkscrew wrapping
the central spire 1.25×, gravity flipped onto the tower.

**New: ride the temple stairs.** Angkor's central spire is a stepped
pyramid, and its real monumental staircases are famously *steep* — perfect
as a **ramp series** (primitive #2/#3 in the
[replacement vocabulary](./README.md#replacement-verticality-vocabulary)).
You climb the spire on its own stone stairs at normal gravity, launch off
the top, then descend the outer staircase (that descent was already in the
layout). The stepped-pyramid geometry *is* the verticality — no gravity
flip, and arguably more characterful than the tube it replaces. Jungle
canopy still intermittently occludes the climb for the skill challenge.

## Hard section / branching / per-lap

- **Hard:** 40–55 s (temple-stair climb) — holding the line up the steep
  stepped ramp while the canopy occludes visibility intermittently.
- **Branching:** **root tunnel shortcut** (14–28, ~3 s, one-shot-kill root
  walls — a high-risk expert line); around the pond left vs right (cosmetic).
- **Per-lap:** lap 1, birds startle and burst from the Bayon faces
  (`triggerBurst('emitter_birds_startle', 40)`); laps 2–3, no burst (the
  flock has fled). Cheap, legible.

## Palette & audio

Mossy stone gray, deep jungle greens, golden sandstone, dappled sunlight,
ochre laterite. `angkor_jungle` sky *(new preset — see specs §1.5)*.
Gamelan + Khmer xylophone over electronic breaks, jungle ambience; gentle
pulse build crescendoing on the climb.

## Props — unique to Angkor Drowned

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| Bayon face towers ×4 | track | Each carries 4 faces; placed so the bike passes 16 faces total on the opening straight. |
| Ta Prohm root arches ×5 | track | Large arched-root meshes spanning the path — the chicane. |
| Angkor Wat central spire | track | ~75 m, 4-sided stepped pyramid; the **stair ramps** for the climb are part of this mesh — replaces the cut corkscrew. |
| `ramp_temple_stairs` | track | The rideable stepped staircases up the spire (and the outer descent staircase). |
| Inner-court plinths | track | Flooded inner-court floors. |
| Root tunnel | track (tunnel) | `tunnel_curve_main`, radius 3.5 (tight!), one-shot-kill walls — the shortcut. |
| `road_curve_main` | track | Short descent-finish slab, width 10. |
| Monkey silhouette | decoration | In a tree branch in the hero-camera foreground. |
| Jungle horizon ring | bespoke `horizon_ring` | Layered tree-line silhouette + Mount Phnom Bok in the distance. |
| `scatter_palms` | scatter (`prop_palm`) | ~25, temple periphery. |
| `scatter_rocks` | scatter (`prop_rock`) | Heavy mossy-stone rubble (~60, mossy-green tint). |
| `emitter_jungle_motes` | emitter (atlas 4) | Sun-through-canopy haze at 3+ locations — 50 % of the visual identity. |
| `emitter_birds_startle` | emitter (atlas 5) | At the Bayon approach; lap-1 burst-triggered. |
| `emitter_temple_dust` | emitter (atlas 4) | Ancient-stone weathering at the spire base. |

> **Retired:** `antigrav_curve_NN` (Tube profile, spire corkscrew) —
> replaced by `ramp_temple_stairs`.

## References

- [../track-design-specs.md](../track-design-specs.md) §2.10 (anti-grav tube
  spec there is retired).
