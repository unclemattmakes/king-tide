# King Tide — Track Themes v1

> **⚠ v2 status (2026-06).** The *themes / lore / set-pieces* below are current,
> but the **v1 lineup framing is historical**: content restarted for v2, so most
> tracks are **greybox** (only **Mayday Bay** + **The Maw** are dressed) and
> `status: 'ship'` means wired/playable, not art-complete. The Reef opener (South
> Beach / Miami) was cut and is being rebuilt as **Mexico City**; **anti-grav
> is cut** (parked for a possible DLC); **wave mastery** is now the motocross
> pitch-the-takeoff/landing model, not press-forward-on-crest. Canonical per-track
> truth lives in [tracks/](./tracks/README.md); current state in
> [status.md](./status.md).

> Content bible for the 11 ship-quality tracks targeted for v1, plus a
> tutorial track. Companion to [design-targets.md](./design-targets.md);
> set within the post-flood world frame locked during track-theme
> brainstorming.
>
> **Implementation specs** (beat-by-beat timing, Blender shopping
> lists, particle / wave / audio configs per track) live in
> [track-design-specs.md](./track-design-specs.md), which is the
> reference the implementer should pick up. The bible below is the
> *what* and *why*; the specs doc is the *how*.
>
> **Cross-game flow analysis** that informed the structural choices
> (cup ordering, single-lap descent format, calm-water track slot,
> per-lap escalation) lives in
> [../research/track-flow-analysis.md](../research/track-flow-analysis.md).
>
> **Locked decisions:**
> - World frame: near-future post-warming. Sea levels up ~5–10 m. Coastal
>   cities partially drowned, inland highlands now islands. Arcade
>   hoverbike racing is the post-collapse spectator sport. *Light lore
>   wrapper, not a story mode.*
> - Every track is a **recognizable real-world place** seen post-flood —
>   no generic biomes.
> - Every track has **at least one named set-piece moment**.
> - Signature skill axis = **wave mastery** (per [design-targets.md](./design-targets.md)).
> - 11 tracks across 4 cups; one tutorial track outside the cup structure.
>   *(Now 12 ship tracks — Golden Gate Drowned was added; see below.)*
> - **Anti-grav is cut from v1** (no-anti-grav reconciliation pass,
>   2026-05-30). No track ships a gravity-flip moment; verticality now
>   comes from terrain, ramps, banked berms, and cliff drops. Cutting the
>   system helps us ship sooner.
>
> **Per-track docs now live in [tracks/](./tracks/README.md)** — one design
> doc per track, each with its unique-prop manifest and (for the eight
> reworked tracks) how terrain/ramps replaced the cut anti-grav moment. That
> folder is **canonical** wherever it disagrees with the per-track stat
> blocks below; this bible remains the reference for lore, palette, and
> audio. The [tracks/README.md](./tracks/README.md) also holds the
> **common-to-all-tracks** prop list.
>
> **v2 — Open Sea Cup → Harbor Cup (no-open-water pass).** The open-water
> **Open Sea Cup** was retired: every track must now combine over-water
> land/props with water (no pure open sea). Its replacement, the **Harbor
> Cup** (drowned harbor cities), runs **Needle Sound (Seattle) → Golden Gate
> Drowned (San Francisco) → Opera Drowned (Sydney)** — Golden Gate moved up
> from Continental, **Shibuya Submerged** backfilled Continental, and the two
> pure-open-water tracks (**The Maw**, **Hatteras Light**) are parked to the
> [B-list](#b-list--future-content-packs). The Tier-2 section, coverage
> matrix, and B-list below are updated to match; the per-track stat blocks
> for the moved/parked tracks carry a banner pointing at the canonical
> [tracks/](./tracks/README.md) docs. Needle Sound + Opera Drowned are fresh
> concepts (greybox-pending).

## Design principles

These shaped every track in this doc; future tracks should hold to them.

1. **Place over biome.** "Drowned Manhattan" beats "City Track."
   Players should be able to point at a screenshot and name where it
   is on Earth.
2. **One hero set-piece per track.** Memorable single image you can
   put on a postcard — the broken torch arm, the lava waterfall, the
   smiling-face towers of Bayon. Everything else is the stage that
   sells the set-piece.
3. **Water everywhere.** The pillar is water + verticality. No track
   is purely land. Even the volcano (Kilauea Crown) ends in the ocean.
4. **Wave physics is the signature, not a mode.** Open-water sections
   are graded by wave-reading. Every track has at least one stretch where
   the swell matters. *(The Maw was the purest test — now parked to the
   B-list in the no-open-water pass; the skill lives across the harbor-city
   open-water stretches.)*
5. **Verticality is terrain, not anti-grav.** *(Revised — anti-grav cut
   from v1.)* Climb and air come from frozen-wave hills, ramps off
   collapsed structures, banked berms (≤45°), and cliff drops — never a
   gravity flip. The set-piece carries the spectacle; the verticality
   gesture is "pump the land like a swell" (see Golden Gate Drowned, the
   model for the whole pass). No surface is ridden inverted.
6. **Visual contrast against the apocalypse.** The world ended; the
   neon is still on. Bright palettes, defiant colors, music with a
   pulse. *The mood is "spectator sport during the collapse,"* not
   "ruin porn." This principle is now fully codified in
   [art-direction.md](./art-direction.md) — post-apocalyptic solarpunk,
   the "clean stylized toy" register, and the built/broken/blooming
   material-state rule. This bible stays the source of truth for per-track
   *palette + lore*; art-direction.md governs *how the look is applied*.
7. **Cup-level escalation.** Each cup runs short → moderate →
   spectacle-closer in lap time and set-piece intensity. The cup's
   third track is its emotional payoff; the first track is its
   handshake. Tracks within a cup are ordered to flow as a
   four-stop journey, not a shuffled set.
8. **Per-lap variation is precious.** Most tracks ship constant
   per-lap behavior — the set-piece does the work of feeling
   fresh. Reserve per-lap structural change to tracks where it's
   the identity (Aqualand's escalating tsunami, Liberty's music
   tiers).

## World frame — quick reference

- **Year:** ~2099. Specifics unimportant; vibe is "the kids born after
  the flood are racing now."
- **Sea level rise:** ~5–10 m above 2026 baseline. Enough to swallow
  coasts, leave high ground.
- **Civilization status:** patchy. Some cities depopulated, some
  defiantly inhabited (Tokyo, Venice). Power infrastructure mixed —
  rooftop solar, generators, microgrids.
- **The Circuit:** the arcade racing league that the player belongs
  to. They take a hoverbike to every drowned landmark on Earth and
  put on a show. Lightly canonical, mostly atmosphere.
- **Visual through-line:** warm sun on cold water; neon at night
  reflected in flooded streets; nature reclaiming infrastructure;
  things that survived alongside things that didn't.

---

# Tutorial track

## Mayday Bay

**Cup:** None (tutorial) | **Lap target:** 60 s scripted | **Laps:** 1
**Water/Land:** 80/20 | **Anti-grav:** none *(was brief intro arch — cut)* | **Difficulty:** intro

A sheltered training cove, fictional. A retrofitted post-flood marina
serving as the Circuit's pilot-training facility — calm water, a
small island, a single ramp, a single sand-dune crest to launch off.
Teaches one mechanic per beat; **pumping is taught in the first 8 seconds** so
the hero mechanic is the first lesson, not the second (Wave Race 64
Sunny Beach reference):

- 0–8 s: **throttle + first swell + pumping prompt** explicit on HUD
- 8–20 s: steering arc across the cove
- 20–32 s: drift around a marker buoy
- 32–42 s: pickup grab + use
- 42–55 s: ramp jump + crest launch (surf a dune crest, land on water)
- 55–60 s: finish straight

Auto-skip toggle for returning players. The track is short, scripted,
and visually low-key on purpose — every other track is a spectacle;
this one is a classroom.

---

# Tier 1 — Reef Cup

Starter tracks. Bright, shallow, instructive. Cup escalates
intro-open-water → calm-skill-check → vertical-spectacle closer.
Players finish all three feeling competent and ready for the showcase
cup.

## 1. Angel Basin *(slug `mexico-city`)*

> *Replaced South Beach Sunken (Miami) in the 2026-06 content pass — the
> Reef opener is now an **inland** drowning, the set's surprise.*

**Cup:** Reef | **Lap target:** 45 s | **Laps:** 3 | **Total race:** ~2:15
**Water/Land:** 65/35 | **Anti-grav:** none | **Difficulty:** intro

**Location:** Drowned Mexico City. The set's inland surprise — a megacity at
2,240 m that *nobody* planned to flood, built on the drained bed of **Lake
Texcoco** (Aztec Tenochtitlán) and sinking for a century. The reborn lake
leaves the Aztec **causeways** as the only land, **Xochimilco's trajinera**
boats floating again, the **Zócalo** cathedral half-sunk beside the
re-emerging **Templo Mayor**, and the gold **Ángel de la Independencia**
standing over the water. Popocatépetl and Iztaccíhuatl on the horizon.

**Layout:** Causeway loop over the new lake — raised Aztec roadways threaded
between drowned landmarks (cathedral, Templo Mayor, Paseo de la Reforma).
Bright, calm water, wide forgiving lines: the handshake track. The "land"
sections are stone causeways you skim across.

**Set-piece — El Ángel:** The golden Ángel de la Independencia stands in the
lake on Paseo de la Reforma; a collapsed section of the **Segundo Piso**
elevated freeway lies fallen across the avenue. You ride *up* its tilted deck
as a ramp and launch off the broken lip, past the gold statue, the lake and
the trajineras spread below and Popocatépetl smoking behind.

**Visual palette:** Rosa mexicano, marigold orange, papel-picado multicolor,
gold, lake teal-green, basalt black, jacaranda purple.

**Audio palette:** Cumbia / sonidero / Latin electronic, mariachi-horn stabs,
marimba.

**Lore tag:** "They drained the lake to build the city. The lake was patient.
The Circuit opens its season on the water that won."

## 2. Container Chaos *(slug `cape-town-drift`)*

**Cup:** Reef | **Lap target:** 48 s | **Laps:** 3 | **Total race:** ~2:24
**Water/Land:** 60/40 | **Anti-grav:** none | **Difficulty:** intro
(calm-water skill check)

**Location:** Drowned V&A Waterfront, Cape Town. Table Mountain still
dominates the skyline, flat-top profile unmistakable. Lower city
streets are submerged; the harbor district is a ruin field of
shipping yards, the aquarium, and the half-tilted Cape Wheel.

**Layout:** Mostly flat-water harbor — **the v1 set's calm-water
skill check.** Outside the breakwater runs at Beaufort 3; inside the
harbor is near-glassy. Pumping doesn't carry you here; racing-line
precision and slalom through wreckage do. A "land" section through
the broken aquarium roof, then back out under the leaning Ferris
wheel. Wide racing lines, forgiving corners.

**Set-piece — Two Oceans Wreck:** The Two Oceans Aquarium's glass
predator tank shattered when the flood came. A great white still
circles inside the broken structure. You race through the broken
roof, past the shark (it's been there for decades, it watches you),
and out the other side. An optional skylight shortcut on top drops
you directly into the predator tank — one-shot-kill rim, expert line
only.

**Visual palette:** Bright Atlantic blue, the mountain's grey-green
flat top, red Cape Wheel struts, oxidized container reds.

**Audio palette:** Afrobeats fusion, marimba over electronic beats.

**Lore tag:** "Table Mountain didn't notice. Everything below it did.
Cape Town's still here — just lower."

## 3. Hatteras Light *(parked → B-list)*

> **Parked (v2 — no-open-water pass):** a lighthouse alone in open Atlantic;
> pulled from the ship cups, kept for a future content pack. Canonical:
> [tracks/hatteras-light.md](./tracks/hatteras-light.md).

**Cup:** *(parked → B-list)* | **Lap target:** 50 s | **Laps:** 3 | **Total race:** ~2:30
**Water/Land:** 80/20 | **Anti-grav:** none *(was light lighthouse climb — reworked as a ramp)*
**Difficulty:** intro (Open Sea opener)

**Location:** Cape Hatteras, North Carolina. The famous black-and-
white spiral lighthouse now stands a third submerged. The Outer Banks
proper are gone; the lighthouse is the only landmark for kilometers.

**Layout:** Loop around the lighthouse base over open Atlantic, with
one circuit up-and-over the lighthouse itself. Wave swell here is
heavier than the calm Reef opener — first real wave-reading test, but still
gentle. **Every lap ends with a cliff drop from the lamp room down
to sea level** (Jet Moto Cliffdiver reference) — the cup closer's
emotional payoff.

**Set-piece — The Lamp Room:** Ride the wrecked exterior gallery-spiral
ramp up the lighthouse (a normal-gravity helix *road*, not a wall),
past the rotating lamp at the top; the music swells as you reach it.
You catch big air off the lamp room's railing into the cliff drop.
*(Reworked from an anti-grav corkscrew — see [tracks/hatteras-light.md](./tracks/hatteras-light.md).)*

**Visual palette:** Cool Atlantic grays, white-and-black lighthouse
spiral, foam-green water, low gray clouds.

**Audio palette:** Ambient surf with foghorn drones, sparse melodic
synth.

**Lore tag:** "Coast Guard left in '78. Someone keeps the lamp
spinning. The Circuit doesn't ask who."

---

# Tier 2 — Harbor Cup

The showcase cup, reworked from the retired Open Sea Cup in the
no-open-water pass: three drowned harbor cities, every metre land or prop
over water — the antithesis of open sea. Cup escalates handshake →
spectacle → postcard-closer. *(Full per-track design lives in
[tracks/](./tracks/README.md); the blocks here are the lore/palette layer.)*

## Needle Sound

**Cup:** Harbor (opener) | **Lap target:** 55 s | **Laps:** 3 | **Total race:** ~2:45
**Water/Land:** 55/45 | **Anti-grav:** none | **Difficulty:** showcase (opener)

**Location:** Drowned Seattle. Puget Sound took the waterfront — Alaskan
Way, the piers, the lower Pike Place market all under Elliott Bay — but the
hills held. The Space Needle stands over the flooded Seattle Center; the
Great Wheel tilts on its drowned pier; WSF ferries swing at anchor; Mount
Rainier owns the eastern horizon (Seattle's Table Mountain).

**Layout:** A *cluttered-harbor* slalom — drowned finger-piers and anchored
ferries threaded tight, never open water — with one short Pike Place hill
crest and the Space Needle big-air. The dense-structure counterweight to
Golden Gate's open terrain.

**Set-piece — The Saucer:** Launch off the tilted Great Wheel gantry / a
beached ferry car-ramp; big air across the drowned Seattle Center, threading
the Space Needle's saucer, Mount Rainier framed dead-centre behind. Normal
gravity — a launch + thread, not a wall-ride.

**Visual palette:** Evergreen + rain-slick slate, Elliott Bay steel
blue-green, ferry green-and-white, Pike Place red neon, Rainier alpenglow.

**Audio palette:** Grunge revival reworked for a racer — driving guitars +
electronic low end, rain + ferry horns. *The Sound.*

**Lore tag:** "The Sound took the waterfront back. The Needle still stands;
the band still plays. Seattle never minded the rain."

## Golden Gate Drowned

*Moved up from Continental in this pass — full stat block later in this doc
and at
[tracks/golden-gate-drowned.md](./tracks/golden-gate-drowned.md).* Drowned
San Francisco: the breathing track — open bay pinching into a tight downtown
canyon, then frozen-wave hills and **The Break** (a steep street plunging
into the bay). Karl the fog rolls in and clears on a world timer. The Harbor
Cup's middle spectacle.

## Opera Drowned

**Cup:** Harbor (closer) | **Lap target:** 60 s | **Laps:** 3 | **Total race:** ~3:00
**Water/Land:** 60/40 | **Anti-grav:** none | **Difficulty:** showcase (closer)

**Location:** Drowned Sydney. The harbour swallowed Circular Quay and the
Opera House forecourt; the sails stand half-submerged, a couple cracked. The
Sydney Harbour Bridge — *the Coathanger* — arches clear over the course, the
last high ground. CBD, Fort Denison, and Luna Park's grinning face complete
the harbour. Permanent golden-hour finale light.

**Layout:** Harbour loop — slalom the half-sunk Opera House sails, bank
around Fort Denison, then ride *up* the Harbour Bridge arch and launch off
the apex into a drop back to the water.

**Set-piece — The Coathanger:** Ride the bridge's steel arch up as a curved
climbing road (the BridgeClimb line) and launch off the apex; the whole
drowned harbour + the gold-lit sails spread below. The cup's postcard
closer. Normal gravity — a rideable incline + apex launch + cliff drop, the
standing-arch answer to Liberty's fallen torch-arm.

**Visual palette:** Sandstone gold, sail-white (bone-cracked), harbour
blue-green, bridge steel silver, ferry green-and-yellow, Luna Park primaries
— all in golden-hour light.

**Audio palette:** The closer goes big — anthemic Aussie pub-rock-meets-
stadium, didgeridoo drone under surf-rock guitars. The harbour-city's
closing party.

**Lore tag:** "Sydney threw the best closing party on Earth and never
stopped. The harbour rose; the sails held; the bridge still arches over the
Circuit's last lap."

---

### Parked / relocated (formerly Open Sea Cup)

The two blocks below are kept for lore reference. **The Maw** is parked to
the [B-list](#b-list--future-content-packs) (100 % open water — the archetype
this pass retired); **Shibuya Submerged** moved to the **Continental Cup**
(it's a land+water city track, so it backfilled the slot Golden Gate
vacated). Canonical homes: [tracks/the-maw.md](./tracks/the-maw.md),
[tracks/shibuya-submerged.md](./tracks/shibuya-submerged.md).

## The Maw *(parked → B-list)*

**Cup:** *(parked → B-list)* | **Lap target:** 60 s | **Laps:** 3 | **Total race:** ~3:00
**Water/Land:** 100/0 | **Anti-grav:** none | **Difficulty:** showcase

**Location:** Big Sur, California — what's left of it. Bixby Bridge
collapsed in the floods; the rock arches and a chunk of the
highway's superstructure form a natural tunnel system. McWay Falls
still pours down from the cliff above and into the new ocean.

**Layout:** All-ocean, no land contact. Race through three rock
arches in series, with the largest ("the Maw" proper) at the
midpoint. **Wave timing = world wave timing.** Whichever way the
swell is rolling when you arrive at the Maw is the way you'll have
to play it. Same lap on different attempts can play very differently.

**Set-piece — The Maw itself:** The largest arch. On the right swell
you're launched through with the crest, hitting the back of the next
wave already up to speed. On the wrong swell, a wall of water hits
the arch as you enter and you eat ocean. This is the moment that
proves wave mastery is the skill the game grades.

**Visual palette:** Golden-hour Pacific. Deep navy ocean, gold rocks,
white foam, dramatic cloud shadows. McWay Falls catching afternoon
light.

**Audio palette:** Cinematic surf-rock. Big strings + drums + reverb.
The music swells with the actual swells.

**Lore tag:** "The bridge fell. The arches stayed. Locals call it the
Maw — the way it eats riders who can't read the sea."

## Shibuya Submerged *(moved → Continental)*

**Cup:** Continental *(moved from Open Sea)* | **Lap target:** 58 s | **Laps:** 3 | **Total race:** ~2:54
**Water/Land:** 50/50 | **Anti-grav:** none *(was Cocoon wall-ride — reworked as a collapsed-lattice ramp)*
**Difficulty:** showcase

**Location:** Drowned Tokyo. Shinjuku skyscraper tops still standing,
**neon still on** — rooftop generators, microgrids, the city refused
to die quietly. Skytree silhouette dominates the backdrop. Tonal
register: Wipeout-bright, not Akira-rainy. *The city as defiant
party, not abandoned ruin.*

**Layout:** Half the track is the network of cables, signage, and
narrow rooftop bridges over what used to be Shibuya Crossing — now a
flooded intersection ten storeys below. The other half threads
between skyscraper tops, with the Cocoon Tower's collapsed diagonal
lattice ridden as a ramp up-and-over to the next rooftop.

**Set-piece — Shibuya Crossing Cables:** Race across the
intersection on a network of toppled neon signage and powerline
cables. The famous five-way scramble is fifteen meters underwater
below you; the neon is reflected up through the water back at you.
Hachiko statue visible underwater, still patient.

**Visual palette:** Hot pink, electric blue, kanji neon reflections
in puddles, wet asphalt on the rooftop sections. Saturated, defiant,
*bright.*

**Audio palette:** City-pop, J-electronic, vocoded hooks. The track
should sound like Tokyo never stopped throwing parties.

**Lore tag:** "Tokyo didn't evacuate. They moved up. The neon's still
on because somebody is still paying the bill."

---

# Tier 3 — Continental Cup

Spectacle cup. Big landmarks, mixed land/water, the postcards. Cup
escalates industrial → elegant → spectacle-descent closer. Casual
lap times sit at the top of the band; the closer breaks the 3-lap
default for a single-lap point-to-point descent.

## 6. Marina Bay 7

**Cup:** Continental | **Lap target:** 55 s | **Laps:** 3 | **Total race:** ~2:45
**Water/Land:** 60/40 | **Anti-grav:** none | **Difficulty:** mid

**Location:** Drowned Singapore megaport, specifically the Tuas
container terminal. Container stacks half-submerged in murky harbor
water; gantry cranes still running on rooftop solar; a beached
supertanker as the centerpiece.

**Layout:** Industrial loop — flooded shipping channel, container-
stack streets, freighter deck, gantry-crane gauntlet, back to start.
Mixed sight-lines, lots of vertical relief from container heights.

**Set-piece — The Gauntlet:** Five gantry cranes on a fixed timer
swing shipping containers across the racing lane at chest-height.
Duck under or eat steel. The timing is generous on Casual difficulty,
tight on Hard. Bonus: jump up onto the beached freighter's deck for
a shortcut that bypasses two of the cranes — but the freighter deck
is anti-pickup territory (no items spawn there).

**Visual palette:** Orange container stacks, gray steel cranes,
dirty harbor brown-green water, oxidized hull reds, sodium-lamp
yellow at night.

**Audio palette:** Industrial techno, mechanical percussion
sampling actual crane sounds.

**Lore tag:** "Singapore's port automated itself in the '40s and
nobody told it to stop. The cranes still load empty containers from
nowhere to nowhere. The Circuit just races around them."

## 7. Doge's Drift

**Cup:** Continental | **Lap target:** 60 s | **Laps:** 3 | **Total race:** ~3:00
**Water/Land:** 70/30 | **Anti-grav:** none *(was Campanile climb — reworked as a toppled-tower ramp)*
**Difficulty:** mid

**Location:** Drowned Venice. Acqua alta finally won. St. Mark's
Campanile still standing tall, Doge's Palace facade half-submerged,
the famous lion-column tops in Piazza San Marco poking out of water.
Murano glassblower furnaces still burning on rooftop islands — the
glass industry refused to die.

**Layout:** Canal racing, except the canals are now just *ocean.*
Race past Doge's Palace, **under the partially-collapsed Rialto
Bridge arch as a low-clearance tunnel** (clip the walls = damage),
through a sequence of facades, then up the toppled Campanile shaft
as a ramp, launching off the belfry stub with the golden St. Mark's
domes below you.

**Set-piece — The Campanile Fall:** The bell-tower has come down (it
famously collapsed once before, in 1902) and lies toppled across the
piazza. Ride *up its fallen brick shaft as a ramp* and launch off the
belfry stub for big air over the basilica domes. The bell still hangs
in the stub at the launch lip; if your lap times out at the right
moment you launch past the swinging bell — on Hard difficulty, the
bell physically blocks the launch window for ~0.4 s of every 3 s.
*(Reworked from an anti-grav climb — see [tracks/doges-drift.md](./tracks/doges-drift.md).)*

**Visual palette:** Ochre and terracotta, mossy green at the
waterline, Adriatic teal, gold Byzantine accents from St. Mark's
domes, the warm orange of glassblower furnace fires.

**Audio palette:** Vivaldi-step — baroque strings sampled and
broken-beat'd. Periodic deep church-bell tones.

**Lore tag:** "Venice was already half-flooded; the rest just took
longer. Murano keeps blowing glass because that's what Murano does."

## Golden Gate Drowned — full detail *(Harbor Cup #2)*

> *Moved to the Harbor Cup in the no-open-water pass; this detailed block is
> filed here from its Continental days. Summary in the Tier 2 — Harbor Cup
> section above; canonical at
> [tracks/golden-gate-drowned.md](./tracks/golden-gate-drowned.md).*

**Cup:** Harbor #2 *(moved up from Continental — after Needle Sound, before
Opera Drowned's closer)* | **Lap target:** 58 s | **Laps:** 3 | **Total race:** ~2:54
**Water/Land:** 55/45 | **Anti-grav:** none (terrain verticality) | **Difficulty:** mid (spectacle)

**Location:** Drowned San Francisco. The Pacific came back through the
Golden Gate and stayed. The low city went under — the Financial
District stands waist-deep, Salesforce Tower and the Transamerica
Pyramid rising straight out of the bay, the streets between them now
flooded canyons. But the hills held: Nob, Russian, Telegraph, the climb
toward Twin Peaks — dry land above the flood. The Golden Gate Bridge is
a silhouette on the fog-bound horizon; Sutro Tower and Coit Tower break
the skyline. And over all of it, *Karl* — the fog tide that pours
through the gate and swallows the towers whole, then peels back.

**Layout:** The track *breathes* — tight urban compressions bracketed by
open water. Open bay (gentle swell, pump rhythm) pinches into a **tight
downtown canyon** threading the drowned skyscraper grid, then the
streets ramp up out of the water onto the hills. **The hills are read
like swell that stopped moving** — you surf up the back of each crest
and launch off the top, the same gesture you use on the bay. The
signature design line: *land as waves frozen in time.* No anti-grav
anywhere — the steep streets and hill crests are the verticality. This
is the first track in the set to make terrain the vertical spectacle.

**Set-piece — The Break:** You crest the steepest street — the classic
San Francisco near-vertical-street postcard — except the bottom is gone,
the road plunging straight down into the drowned bay. The frozen wave
breaking into the real one. Bike airborne over the crest, the fallen
city and skyscraper-tops spread below through the fog, then a big
splashdown at sea level. Terrain-only, and it *lands* every lap.

**The fog (signature):** San Francisco's marine layer rolls in and
clears on a world timer — thick, and the canyon and crests are read by
memory and street-lights; peeled back, and the drowned skyline reveals.
The one true weather mechanic in the set. *Hatteras grades how you read
the sea; Golden Gate grades how you read the fog.* Telegraphed, never
blinding — edge-lights and the predictive wave-line stay visible.

**Visual palette:** International Orange steel on the bridge silhouette,
fog white-grey rolling in volume, bay steel blue-green, warm low sun
breaking through the marine layer. Drowned-tower glass cool; survivor
microgrid lights warm in the canyon.

**Audio palette:** Foghorn drones under Bay-Area hyphy / west-coast
hip-hop. The city moved uphill and kept the party going.

**Lore tag:** "They said the bridge would outlast the city. They were
right — it outlasted the coastline too. Karl rolls in on schedule; the
Circuit races the gate anyway."

## 8. Kilauea Crown

**Cup:** Continental (closer) | **Lap target:** *single-lap point-to-point* | **Laps:** 1 | **Total race:** ~2:30
**Water/Land:** 50/50 | **Anti-grav:** none *(was caldera-rim wall-ride — reworked as a banked terrain road)*
**Difficulty:** mid (spectacle closer)

**Location:** Big Island, Hawaii. Kilauea actively erupting, the
caldera enlarged and reshaped. The mountain is the new high ground;
the lowlands are open ocean now.

**Layout:** **Single-lap descent in three sections** (Mount Wario
reference; the climb-rim-descend topology is naturally non-loopable).
Section 1: climb the windward slope from sea level through old lava
fields. Section 2: ride the caldera rim as a *banked terrain road*
(the rim is banked inward ≤45°, ridden like a velodrome at normal
gravity, the lava lake below, ~60 s of continuous banked cornering).
Section 3: descent down the leeward side, finishing beside a lava
waterfall pouring into the new sea.

**Set-piece — The Black Beach:** The leeward descent ends with a
lava waterfall — molten rock pouring directly into ocean, exploding
into steam. You ride *alongside* the waterfall, not through it. Black
basalt sand, white steam plumes, orange glow under blue sky. The
finish line is at the base.

**Visual palette:** Orange-red lava, black basalt, steam-white,
volcanic-blue lake, lush green windward forest.

**Audio palette:** Tribal percussion layered with synth pads. Big
sub-bass when the volcano grumbles. Music ~2:45 long with a
crescendo aligned to the lava waterfall.

**Lore tag:** "Pele kept building. The mountain's taller now than it
was in '26. The Circuit times its laps to the eruption schedule."

---

# Tier 4 — Drowned Cup

The finale cup. Heaviest atmosphere, longest tracks, the chaos slot,
and the v1 finale.

## 9. Aqualand

**Cup:** Drowned | **Lap target:** 22 s | **Laps:** 5 | **Total race:** ~1:50
**Water/Land:** 75/25 | **Anti-grav:** none *(was bowl-wall — reworked as a banked pool-bowl rim)*
**Difficulty:** chaos

**Location:** Abandoned Florida waterpark, doubly drowned. The pools
and slides that were *designed* to hold water now hold the actual
ocean. Lifeguard towers at angles, faded sun-bleached primary colors,
algae everywhere, locker rooms full of crab nests.

**Layout:** Short loop, Baby-Park style. Lazy river → wave pool →
half-pipe slide → main concourse → back to lazy river. Five laps
because three is over too fast. Constant proximity, constant chaos.

**Set-piece — The Tsunami:** The wave pool. When the park ran, it
generated a "tsunami" surge once per lap. The mechanism still runs.
The surge **escalates with each lap** (Sonic Transformed's Adder's
Lair reference): lap 1 is a splash hazard, lap 2 floods the lower
concourse, lap 3+ washes it out entirely and the banked upper
pool-bowl rim becomes the mandatory line. The lifeguard tower's old
digital countdown sign tracks the next surge.

**Visual palette:** Faded primary colors, sun-bleached plastic,
algae greens, the bright blue of pool tile peeking through grime.

**Audio palette:** Trashy 90s pool-party EDM. Bad Hawaiian-shirt
energy. The PA system still cycles ads for snack-bar specials
nobody can buy.

**Lore tag:** "Aqualand closed in '32. The wave generator was on a
solar circuit. Nobody turned it off. The Circuit thinks this is
hilarious."

## 10. Angkor Drowned

**Cup:** Drowned | **Lap target:** 62 s | **Laps:** 3 | **Total race:** ~3:06
**Water/Land:** 65/35 | **Anti-grav:** none *(was central-spire corkscrew — reworked as temple-stair ramps)*
**Difficulty:** late-mid

**Location:** Angkor Wat complex, Cambodia. The ocean reached this
far inland. Massive temple complex, jungle reclaiming the upper
levels, monkeys still in the towers, moss everywhere. Mossy greens
and warm sandstone gold under shafts of sunlight through the canopy.

**Layout:** Enter through Bayon's smiling-face towers, weave between
Ta Prohm's strangler-fig roots through flooded inner courtyards,
then climb the monumental stepped staircases of Angkor Wat's central
spire (ridden as steep stone ramps), launch off the top, and descend
the outer staircase. Verticality is the structural surprise — this
track *climbs* more than the others do.

**Set-piece — The Smiling Faces:** Bayon temple. Every tower has
four giant serene stone faces carved into it, looking outward in
every direction. You race past sixteen of them in sequence on the
opening straight. They watch you go by. They've been watching for
nine centuries; the flood didn't change that.

**Visual palette:** Mossy stone gray, deep jungle greens, golden
temple sandstone, dappled sunlight through canopy gaps, the warm
ochre of laterite brick.

**Audio palette:** Gamelan and Khmer xylophone over electronic
breaks. Subtle jungle ambience under the music.

**Lore tag:** "Angkor outlasted the Khmer Empire. The Mongols. The
Khmer Rouge. The flood is just the latest thing it'll outlast."

## 11. Liberty Drowned — *FINALE*

**Cup:** Drowned | **Lap target:** 70 s | **Laps:** 3 | **Total race:** ~3:30
**Water/Land:** 80/20 | **Anti-grav:** none *(was torch-arm underside +
crown interior — reworked as a ride-up ramp + spike gates + drop)* | **Difficulty:** finale

**Location:** Drowned Manhattan. The Statue of Liberty half-
submerged — water at her waist. Her torch arm has collapsed forward,
torch resting on Liberty Island's old battlements. Surrounding waters
reveal Lower Manhattan rooftops: Trinity Church spire poking up,
Charging Bull underwater, the Wall Street bull pit a shoal of yellow
cabs. Brooklyn Bridge cables sagging into the harbor. The Planet of
the Apes silhouette, but more of it.

**Layout:** Three-section track. (1) Open harbor with Manhattan
rooftop landmarks as you skim past. (2) Ride *up the top of the
fallen torch arm* — it lies collapsed across the battlements, its
upper surface a rising copper-green ramp — to the flame, and launch
off the fist; the most spectacular continuous stretch in the v1
lineup. (3) Fly the big-air gap between Liberty's broken crown
spikes, past her head. Then back to the harbor for the lap restart.

**Set-piece — The Torch Arm:** The broken arm itself. Copper-green
oxidation, riveted construction, the torch flame still in the
clenched fist at the far end. You ride *up* the fallen arm for
~10 seconds to the torch and launch off the fist — hands-on-handlebars
vertigo, the harbor and Liberty's fingers framing the shot. This is
the postcard moment of v1. *(Reworked from an anti-grav underside ride —
see [tracks/liberty-drowned.md](./tracks/liberty-drowned.md).)*

**Visual palette:** Copper-green oxidation, NYC granite gray,
harbor steel-blue, sunset orange on water. End-of-day finale
lighting always.

**Audio palette:** Hip-hop and orchestral hybrid. Big horn section,
heavy 808s, choral swells. New York stays loud.

**Lore tag:** "She fell forward in '71. Nobody could lift her up
again. The Circuit makes her the last lap of every championship
season because nothing else lands as hard."

---

## Coverage matrix

Tracks listed in cup-play order (each cup escalates short →
moderate → spectacle-closer).

Anti-grav is **none on every track** (cut from v1); the column below is
now the **verticality solution** that replaced it.

| # | Track | Cup | Location | Verticality | Water | Set-piece |
|---|---|---|---|---|---|---|
| — | Mayday Bay | Tutorial | (fictional) | crest launch | 80% | training gates |
| 1 | Angel Basin | Reef | Mexico City | collapsed-freeway ramp | 65% | El Ángel |
| 2 | Container Chaos | Reef | Cape Town | flat / slalom | 60% | Two Oceans Wreck |
| 3 | Needle Sound | Harbor | Seattle | pier/ferry ramps + Needle saucer | 55% | The Saucer |
| 4 | Golden Gate Drowned | Harbor | San Francisco | frozen-wave hills + The Break | 55% | The Break |
| 5 | Opera Drowned | Harbor | Sydney | Harbour Bridge arch + drop | 60% | The Coathanger |
| 6 | Marina Bay 7 | Continental | Singapore | container/deck terrain | 60% | The Gauntlet |
| 7 | Doge's Drift | Continental | Venice | toppled-Campanile ramp | 70% | Campanile Fall |
| 8 | Shibuya Submerged | Continental | Tokyo | Cocoon lattice ramp | 50% | Shibuya Crossing Cables |
| 9 | Kilauea Crown | Continental | Hawaii | banked caldera-rim road | 50% | The Black Beach *(single-lap P2P)* |
| 10 | Aqualand | Drowned | Florida | banked pool-bowl rim | 75% | The Tsunami *(per-lap escalation)* |
| 11 | Angkor Drowned | Drowned | Cambodia | temple-stair ramps | 65% | Smiling Faces |
| 12 | Liberty Drowned | Drowned | NYC | torch ramp + crown gates + drop | 80% | The Torch Arm |
| — | The Maw *(parked → B-list)* | — | Big Sur | wave launch | 100% | The Maw arch |
| — | Hatteras Light *(parked → B-list)* | — | NC outer banks | gallery-spiral ramp + drop | 80% | Lamp Room |

**Geographic spread (active cup roster):** Americas 5 (Mexico City, Seattle, San
Francisco, Florida, NYC), Asia 3 (Tokyo, Singapore, Cambodia), Oceania 1
(Sydney — new with the Harbor Cup, the set's first Oceania track), Europe 1
(Venice), Africa 1 (Cape Town), Hawaii 1 + 1 fictional tutorial. Parked to
the B-list: Big Sur (The Maw), NC Outer Banks (Hatteras Light).

**Anti-grav count:** **0 of 12** — anti-grav is cut from v1. Verticality
is delivered by terrain, ramps, banked berms (≤45°), and cliff drops
(see the verticality column above and the per-track docs in
[tracks/](./tracks/README.md)). The old 2–3-track target is retired.

**Wave-mastery tracks:** All open-water sections (effectively all 12),
graded by wave-reading. With The Maw parked, no single track is a *pure*
open-water test; the skill now lives across the Harbor-Cup harbor stretches
and every track's swell sections. Cape Town remains the calibration
counterweight — the calm-water track where pumping deliberately *doesn't*
carry you, which is what makes pumping legible as a skill everywhere else.

**Casual lap distribution:** 22 s (Aqualand chaos) → 45 → 48 → 55 → 55 →
58 → 58 → 60 → 60 → 62 → 70 s + 1 × ~2:30 single-lap descent (Kilauea).
Weighted to the 45–65 s band per
[design-targets.md](./design-targets.md). *(Open Sea's 50 s Hatteras + 60 s
Maw drop off as they park; Needle Sound 55 + Opera Drowned 60 join.)*

**Format breakdown:** 10 × 3-lap loops + 1 × 5-lap chaos arena (Aqualand) +
1 × single-lap point-to-point descent (Kilauea), plus the 1-lap scripted
tutorial (Mayday Bay). Default is 3 laps; deviations are intentional per the
cup-pacing principle.

## B-list — future content packs

Tracks that survived brainstorm but didn't make the v1 cut. Good
candidates for the v1.1 / first major content drop.

**Parked from v1 in the no-open-water pass** (built/designed; pulled from the
ship cups because they're pure open water — re-home them in an "open sea"
content pack):

- **The Maw** *(parked from v1)* — Big Sur, 100 % open water, the purest
  wave-mastery test and one of the few **art-dressed** tracks. Build + full
  design retained ([tracks/the-maw.md](./tracks/the-maw.md)) — a ready-made
  content-pack headline.
- **Hatteras Light** *(parked from v1)* — Cape Hatteras lighthouse alone in
  open Atlantic (80 % open water). Build + design retained
  ([tracks/hatteras-light.md](./tracks/hatteras-light.md)).

Original brainstorm survivors:

- **Bedruthan Stacks** — Cornish coast, rocky sea-stacks in heavy
  weather. Sister to The Maw with grey-Atlantic palette. Open Sea.
- **Wadi Run** — Saudi desert canyon that flash-floods on lap 2-3.
  Mixed land/water with a literally rising threat. Continental.
- **Erebus Station** — Antarctic research base + frozen tanker hull
  as the set-piece. Ice + water + verticality. Continental.
- **Sagrada Drowned** — Drowned Barcelona finale candidate. Sagrada
  Familia spires still scaffolded, still under construction. Drowned.
- **Halong Bay** — Vietnam, limestone karsts in jade water. Threading
  between vertical pillars. Open Sea.
- **Geyser Plain** — Yellowstone, geysers as timed boost/hazard.
  Continental.
- **Carousel Pier** — Victorian ruined pier (Brighton/Coney Island
  hybrid) with a half-rotted carousel mid-jump. Reef/Drowned.
- **Drowned Bangkok** — Wat Arun and Chao Phraya temple spires above
  flood, floating markets actually floating. Continental.
- **Drowned Amsterdam** — canals that were already canals are now
  just ocean; the city is a grid of rooftops. Reef/Continental.
- **Pyramids Shoal** — Nile drowned to the Pyramids of Giza. Massive
  flat landmarks across shallow water. Continental.

## Implementation notes

**For the track-block-out phase:**
- Match the lap-time targets to the design-targets band; if a block-out
  feels short, lengthen the loop rather than reducing lap count.
- Set-piece geometry should be the first thing built — if the
  set-piece doesn't sell on a screenshot, the rest of the track
  doesn't matter.
- Verticality is terrain now (no anti-grav): author ramps, banked berms
  (≤45°), and hill crests as continuous drivable geometry with a single
  clear entry/exit and a takeoff lip the player can read. The retired
  `antigrav_curve_*` operators are not used on any v1 track.

**For the art pass:**
- Real-world reference photography per track, posted in the track's
  Blender file's notes property.
- Palette swatches locked before texturing begins — the visual
  contrast (warm/cold, neon/decay) is more important than per-asset
  fidelity.
- Distant landmark silhouettes are doing the heavy lifting (Table
  Mountain, Skytree, Liberty herself). Lock those first.

**For the audio pass:**
- One music track per location, ~3 minutes minimum.
- Audio palette notes in each track stat-block are starting points,
  not specs.
- Wave-pump SFX is shared across all tracks; track music ducks for it
  on a successful pump.

## References

- [track-design-specs.md](./track-design-specs.md) — per-track
  beat-by-beat implementation specs, Blender shopping lists,
  particle / wave / audio configs. The authoring reference.
- [../research/track-flow-analysis.md](../research/track-flow-analysis.md)
  — cross-game flow analysis (MK8/World, Wave Race, Jet Moto,
  Sonic Racing). The basis for cup-ordering choices, the calm-water
  slot, single-lap descent format, and per-lap escalation.
- [design-targets.md](./design-targets.md) — numeric targets these
  tracks fulfill (lap times, anti-grav count, set-piece-per-track
  requirement).
- [product-plan.md](./product-plan.md) — locked vision and pillars.
- [implementation-plan.md](./implementation-plan.md) — milestone
  scheduling for when these tracks land.
- [research/overview.md](../research/overview.md) — set-piece tracks
  beat generic loops; named places beat biomes.
- [docs/track-editor-guide.md](./track-editor-guide.md) — authoring
  pipeline for the gameplay-data layer.
- [docs/blender-pipeline-guide.md](./blender-pipeline-guide.md) —
  environment geometry pipeline.
