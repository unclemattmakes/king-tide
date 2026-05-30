# Marina Bay 7 — Continental Cup #1

> Cup: Continental · Industrial obstacle racing: timed-hazard gauntlet and
> a high-risk freighter shortcut.

## Identity

| | |
|---|---|
| **Cup** | Continental |
| **Lap target** | 55 s |
| **Laps** | 3 (~2:45 total) |
| **Water / Land** | 60 / 40 |
| **Anti-grav** | **none** *(never used it — unchanged by the pass)* |
| **Verticality** | container stacks + freighter deck (terrain relief) |
| **Difficulty** | mid |

## Location & fiction

Drowned Singapore megaport — the Tuas container terminal. Container stacks
half-submerged in murky harbor water; gantry cranes still running on
rooftop solar; a beached supertanker as the centerpiece. "Singapore's port
automated itself in the '40s and nobody told it to stop."

## Layout & beats

Loop with a timed-hazard gauntlet + high-risk shortcut. Reference: Wave
Race 64 Marine Fortress (one-shot-kill shortcut) + Jet Moto Hammerhead
(collapsed-infrastructure aesthetics).

| t (s) | Beat | Description |
|---|---|---|
| 0–10 | Shipping-channel opener | Murky lane between two half-submerged container stacks |
| 10–22 | Container-stack streets | Two-block grid of orange stacks; tight chicane |
| 22–34 | **The Gauntlet (set-piece)** | Five gantry cranes on fixed timers swing containers across the lane at chest-height. Duck or eat steel. |
| 34–44 | Freighter deck OR around | Jump onto the supertanker deck (shortcut + pickup-denial) or take the longer outside-hull water path |
| 44–55 | Gauntlet finish | Two more cranes (faster timers) back to start |

## Set-piece — The Gauntlet

Five cranes swing shipping containers across the racing lane on a fixed
timer; duck under or eat steel. Visible from the start grid as sodium-yellow
silhouettes, loads swinging in idle pattern even before the race starts.
Plays at 40–62 % of lap distance — the hard-section slot. Skill: reading
crane-swing timing 4–5 s ahead while holding the chicane line.

## Hard section / branching / per-lap

- **Hard:** 22–34 s (the Gauntlet).
- **Branching:** freighter-deck shortcut (34–44, ~3 s, **pickup-denial
  zone** — nothing falls onto a freighter deck); container chicane left vs
  right.
- **Per-lap:** crane timers constant within a race (learnable). On Hard the
  timer phase is randomized per race.

## Palette & audio

Orange container stacks, gray steel cranes, brown-green harbor water,
oxidized hull reds, sodium-lamp yellow at night. `singapore_industrial` sky
*(new preset — see specs §1.5)*. Industrial techno, mechanical percussion
sampling actual crane sounds; **low pump-duck (0.25)**.

## Props — unique to Marina Bay 7

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| Container stacks | track | ~25 hand-placed `prop_container` meshes (collidable scatter isn't wired yet — fall back to manual placement), mixed orientations, some half-submerged. |
| Gantry cranes ×5 | track | Gantry + leg + counterweight, ~40 m each. |
| `crane_NN_swing_load` ×5+ | track (runtime-animated) | Swinging container loads — animated via glTF animation channels on a timer. |
| Beached supertanker | track | ~120 m hull with a flat deck raised ~8 m (the shortcut); wheelhouse decoration on top. |
| `emitter_crane_sodium_lamp_*` | emitter (atlas 7) | Warm-yellow lamp at each crane top (5 instances). |
| `emitter_container_rust` | emitter (atlas 1) | Over 3–4 weathered containers. |
| `emitter_freighter_smoke` | emitter (atlas 1) | At the funnel — the ship still smokes faintly. |

## References

- [../track-design-specs.md](../track-design-specs.md) §2.6.
