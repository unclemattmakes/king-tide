# Opera Drowned — Harbor Cup #3 (spectacle closer)

> Cup: Harbor · The cup's emotional payoff: ride the Sydney Harbour Bridge's
> arch up and launch off the apex over the half-sunk Opera House sails, in
> permanent golden-hour light.

## Identity

| | |
|---|---|
| **Cup** | Harbor (closer) |
| **Lap target** | 60 s |
| **Laps** | 3 (~3:00 total) |
| **Water / Land** | 60 / 40 |
| **Anti-grav** | **none** (designed terrain/ramp-first) |
| **Verticality** | the Harbour Bridge arch (rideable incline + apex launch) + a drop to the harbour |
| **Difficulty** | showcase (cup closer — the postcard payoff) |
| **Status** | concept — greybox/build pending |

## Location & fiction

Drowned Sydney. The Tasman rose and Sydney Harbour swallowed Circular Quay,
the Opera House forecourt, and the Rocks. The Opera House sails stand
half-submerged — the white shells rising straight from the water, a couple
cracked, the most recognizable roofline on Earth now a reef of concrete
sails. The Sydney Harbour Bridge — *the Coathanger* — still arches clear
over the course, its steel span the one bit of high, dry ground left. The
CBD rises behind (Sydney Tower's golden turret on its needle); Fort Denison
pokes up mid-harbour; Luna Park's giant grinning face leers half-drowned on
the north shore. Golden-hour light always — the cup's payoff, like Liberty's
end-of-day finale. "Sydney threw the best closing party on Earth and never
stopped. The harbour rose; the sails held; the bridge still arches over the
Circuit's last lap."

## Layout & beats

A harbour loop that climbs the bridge arch and drops back to the water — the
cup's biggest postcard. Reference: the Liberty torch-ramp (ride a famous
structure up + launch) reworked as a curved bridge-arch incline; MK8 bridge
tracks; golden-hour finale lighting.

| t (s) | Beat | Description |
|---|---|---|
| 0–12 | Circular Quay start | Beaufort-4 harbour chop; pump rhythm past the drowned ferry wharves. The sails + the bridge ahead, gold-lit. |
| 12–26 | **The Sails** | Thread between the half-sunk Opera House shells — narrow, structure-dense slalom; the famous roofline at eye level. |
| 26–40 | Fort Denison turn | Bank around Fort Denison (a banked harbour-island turn, ≤45°), lining up the bridge pylon. |
| 40–52 | **The Coathanger (set-piece)** | Ride *up* the Harbour Bridge's steel arch — a curved climbing road (the BridgeClimb line) — and launch off the apex, the whole drowned harbour + sails spread below in gold. |
| 52–60 | The drop + finish | Big drop off the arch back to the water; splashdown + finish at the Quay. |

## Set-piece — The Coathanger

The Sydney Harbour Bridge still arches over the harbour, the one piece of
high ground left. You ride *up the curve of its steel arch* as a climbing
road — the BridgeClimb line made drivable — and launch off the apex. At the
top the whole drowned harbour opens below: the Opera House sails catching
gold light, Fort Denison, the CBD, the Heads in the distance. The postcard
that closes the cup. Normal gravity throughout — the arch is a convex
rideable incline, the apex a launch lip, the far side a cliff-drop back to
the water. The biggest continuous spectacle stretch in the Harbor Cup, and
it *lands* every lap. Sits at ~85 % of lap distance — the closer flourish
before the splashdown finish.

## Verticality without anti-grav

Opera Drowned never specced anti-grav. The Coathanger is built from the
[replacement vocabulary](./README.md#replacement-verticality-vocabulary)
primitives **#3 (rideable incline / helix ramp** — the bridge arch as a
curved climbing *road*, not a wall) and **#5 (cliff drop** — the launch off
the apex back to the harbour), with a **#4 banked island-turn** at Fort
Denison. It is the cup's answer to **Liberty's torch-arm** — ride a
world-famous structure up to a launch — but where Liberty rides a *fallen*
arm flat, Opera rides a *standing* arch's curve. The arch's own slope keeps
the climb under the no-wall-ride rule; the apex reads as a takeoff lip 4–6 s
out.

## Hard section / branching / per-lap

- **Hard:** 40–52 s (the arch + apex launch) — carrying enough speed up the
  arch's curve to clear the drop cleanly without over-committing the apex.
- **Branching:** inside the sails vs. the outer harbour lane (the Sails
  slalom); the high apex launch vs. a lower mid-arch exit (lower is safer,
  slower, skips the postcard air); steep harbour-side plunge vs. a shallower
  pylon-stair descent at the drop.
- **Per-lap:** constant. Golden-hour light + the bridge spectacle carry it;
  per-lap structural change is reserved for the identity tracks (Aqualand /
  Liberty), not a closer that leans on its set-piece.

## Palette & audio

Sydney sandstone gold (the Rocks, the pylons), Opera House sail-white
(bone-cracked at the broken shells), harbour deep blue-green, Harbour Bridge
steel silver-grey, the ferries' green-and-yellow, Luna Park's garish
carnival primaries as a pop of chaos — all under always-golden-hour finale
light (warm low sun, long shadows off the sails). New `sydney_gold` sky
grade (or `liberty_sunset` warmed as fallback). Audio: the cup closer, so it
goes big — anthemic Aussie pub-rock-meets-stadium, a didgeridoo drone under
the low end and surf-rock guitars on top; the harbour-city throwing its
closing party. Crescendo aligned to the arch launch.

## Props — unique to Opera Drowned

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| Opera House sails | track | The hero roofline — half-sunk concrete shells, a couple cracked; the Sails slalom corridor. Shared `sail_NN` kit. |
| Sydney Harbour Bridge | track (incline + drop) | "The Coathanger" — the steel arch ridden up as a curved climbing road to the apex launch; the set-piece. Pylons cap below the waterline. |
| Fort Denison | track (terrain) | Mid-harbour island — the banked turn (≤45°) before the bridge approach. |
| CBD + Sydney Tower | decoration (silhouette) | Skyline break behind the bridge (camera-locked); Sydney Tower's golden turret the landmark. |
| Luna Park face | decoration | The giant grinning entrance half-drowned on the north shore — the visual gag (Aqualand-energy chaos pop). |
| Drowned ferry wharves | track | Circular Quay wharves — the start + slalom near the Quay. |
| `scatter_debris` | scatter | Floating ferry wreckage, pontoons, harbour junk along the edges (height/biome-gated). |
| `emitter_harbour_spray` | emitter (atlas 9) | Across the harbour chop + one at the arch-drop splashdown. |
| `emitter_gold_haze` | emitter (atlas 4) | Golden-hour sun-haze off the water — sells the finale light + the arch volume. |

## References

- Reworks the [liberty-drowned.md](./liberty-drowned.md) torch-ramp language
  (ride a famous structure up + launch) as a bridge-arch incline; golden-hour
  finale lighting per the cup-closer principle.
- New v2 concept from the Harbor-Cup rework; this doc is the spec until the
  build pass. No `track-design-specs.md` §ref yet.
