# Hoverbike — Track Themes v1

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
   are graded by wave-reading. The Maw is the purest test; every other
   track has at least one stretch where the swell matters.
5. **Anti-grav is spectacle, not a system tax.** Used where it sells a
   set-piece — climbing a lighthouse, racing the underside of the
   Statue of Liberty's broken torch. Not sprinkled for novelty.
6. **Visual contrast against the apocalypse.** The world ended; the
   neon is still on. Bright palettes, defiant colors, music with a
   pulse. *The mood is "spectator sport during the collapse,"* not
   "ruin porn."
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

## Sandbar

**Cup:** None (tutorial) | **Lap target:** 60 s scripted | **Laps:** 1
**Water/Land:** 80/20 | **Anti-grav:** brief intro segment | **Difficulty:** intro

A sheltered training cove, fictional. A retrofitted post-flood marina
serving as the Circuit's pilot-training facility — calm water, a
small island, a single ramp, a single anti-grav arch. Teaches one
mechanic per beat; **pumping is taught in the first 8 seconds** so
the hero mechanic is the first lesson, not the second (Wave Race 64
Sunny Beach reference):

- 0–8 s: **throttle + first swell + pumping prompt** explicit on HUD
- 8–20 s: steering arc across the cove
- 20–32 s: drift around a marker buoy
- 32–42 s: pickup grab + use
- 42–55 s: ramp jump + anti-grav arch entry/exit
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

## 1. South Beach Sunken

**Cup:** Reef | **Lap target:** 45 s | **Laps:** 3 | **Total race:** ~2:15
**Water/Land:** 70/30 | **Anti-grav:** none | **Difficulty:** intro

**Location:** Drowned Miami Beach. Ocean Drive underwater, Art Deco
hotel rooftops poking through as a chain of pastel islands. Palms
still standing on rooftop "islands" — locals kept them alive.

**Layout:** Loop around three rooftop clusters, with a flooded Ocean
Drive stretch on one side and an open-bay stretch on the other.
Gentle swell. The "land" sections are flat hotel roofs you skim
across.

**Set-piece — Versace Steps:** Casa Casuarina's famous front
steps emerge from the water; a half-buried seaplane sits across them
as a natural ramp. You launch off the wing for a big-air boost into
the next lagoon.

**Visual palette:** Pastel pink, turquoise, neon mint. Art Deco
geometry. Palm silhouettes against pink sky.

**Audio palette:** Vaporwave, Miami synth-funk, distant gulls.

**Lore tag:** "South Beach kept the lights on. They held a permanent
spring break on the roofs. The Circuit comes through twice a season."

## 2. Cape Town Drift

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

## 3. Hatteras Light

**Cup:** Reef | **Lap target:** 50 s | **Laps:** 3 | **Total race:** ~2:30
**Water/Land:** 80/20 | **Anti-grav:** light (lighthouse climb, ~5 s)
**Difficulty:** intro (Reef Cup closer)

**Location:** Cape Hatteras, North Carolina. The famous black-and-
white spiral lighthouse now stands a third submerged. The Outer Banks
proper are gone; the lighthouse is the only landmark for kilometers.

**Layout:** Loop around the lighthouse base over open Atlantic, with
one circuit up-and-over the lighthouse itself. Wave swell here is
heavier than South Beach — first real wave-reading test, but still
gentle. **Every lap ends with a cliff drop from the lamp room down
to sea level** (Jet Moto Cliffdiver reference) — the cup closer's
emotional payoff.

**Set-piece — The Lamp Room:** Anti-grav corkscrew up the lighthouse
shaft, exiting through the open lamp room at the top. The lamp is
still rotating; the music swells as you exit. You catch big air off
the lamp room's railing on the way down.

**Visual palette:** Cool Atlantic grays, white-and-black lighthouse
spiral, foam-green water, low gray clouds.

**Audio palette:** Ambient surf with foghorn drones, sparse melodic
synth.

**Lore tag:** "Coast Guard left in '78. Someone keeps the lamp
spinning. The Circuit doesn't ask who."

---

# Tier 2 — Open Sea Cup

The showcase cup. Two hero tracks; deliberately kept lean. The Maw is
the purest test of the signature mechanic; Shibuya is the postcard
that gets put on the trailer.

## 4. The Maw

**Cup:** Open Sea | **Lap target:** 60 s | **Laps:** 3 | **Total race:** ~3:00
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

## 5. Shibuya Submerged

**Cup:** Open Sea | **Lap target:** 58 s | **Laps:** 3 | **Total race:** ~2:54
**Water/Land:** 50/50 | **Anti-grav:** medium (Cocoon Tower, ~10 s)
**Difficulty:** showcase

**Location:** Drowned Tokyo. Shinjuku skyscraper tops still standing,
**neon still on** — rooftop generators, microgrids, the city refused
to die quietly. Skytree silhouette dominates the backdrop. Tonal
register: Wipeout-bright, not Akira-rainy. *The city as defiant
party, not abandoned ruin.*

**Layout:** Half the track is the network of cables, signage, and
narrow rooftop bridges over what used to be Shibuya Crossing — now a
flooded intersection ten storeys below. The other half threads
between skyscraper tops, with one face of the Cocoon Tower as the
anti-grav segment.

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
**Water/Land:** 70/30 | **Anti-grav:** medium (Campanile climb, ~10 s)
**Difficulty:** mid

**Location:** Drowned Venice. Acqua alta finally won. St. Mark's
Campanile still standing tall, Doge's Palace facade half-submerged,
the famous lion-column tops in Piazza San Marco poking out of water.
Murano glassblower furnaces still burning on rooftop islands — the
glass industry refused to die.

**Layout:** Canal racing, except the canals are now just *ocean.*
Race past Doge's Palace, **under the partially-collapsed Rialto
Bridge arch as a low-clearance tunnel** (clip the walls = damage),
through a sequence of facades, then anti-grav climb up the Campanile
exiting through the belfry with the golden St. Mark's domes below
you.

**Set-piece — The Campanile Climb:** Anti-grav up the brick shaft
of the Campanile (which has somehow survived since 1912 even through
this), exit out the open arched belfry with a panoramic view of
drowned Venice. The bell still rings on the hour; if your lap times
out at the right moment, you ride past the swinging bell — on Hard
difficulty, the bell physically blocks the exit window for ~0.4 s
of every 3 s.

**Visual palette:** Ochre and terracotta, mossy green at the
waterline, Adriatic teal, gold Byzantine accents from St. Mark's
domes, the warm orange of glassblower furnace fires.

**Audio palette:** Vivaldi-step — baroque strings sampled and
broken-beat'd. Periodic deep church-bell tones.

**Lore tag:** "Venice was already half-flooded; the rest just took
longer. Murano keeps blowing glass because that's what Murano does."

## 12. Golden Gate Drowned

**Cup:** Continental *(new content addition; final cup order set in the
anti-grav reconciliation pass)* | **Lap target:** 58 s | **Laps:** 3 | **Total race:** ~2:54
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
**Water/Land:** 50/50 | **Anti-grav:** heavy (caldera rim, ~60 s)
**Difficulty:** mid (spectacle closer)

**Location:** Big Island, Hawaii. Kilauea actively erupting, the
caldera enlarged and reshaped. The mountain is the new high ground;
the lowlands are open ocean now.

**Layout:** **Single-lap descent in three sections** (Mount Wario
reference; the climb-rim-descend topology is naturally non-loopable).
Section 1: climb the windward slope from sea level through old lava
fields. Section 2: anti-grav around the caldera rim (the rim is
*banked* inward, you ride the inside of the bowl, ~60 s of continuous
wall-ride). Section 3: descent down the leeward side, finishing
beside a lava waterfall pouring into the new sea.

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
**Water/Land:** 75/25 | **Anti-grav:** light (one bowl wall, optional)
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
concourse, lap 3+ washes it out entirely and the upper bowl-wall
anti-grav becomes mandatory. The lifeguard tower's old digital
countdown sign tracks the next surge.

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
**Water/Land:** 65/35 | **Anti-grav:** heavy (central spire climb, ~15 s)
**Difficulty:** late-mid

**Location:** Angkor Wat complex, Cambodia. The ocean reached this
far inland. Massive temple complex, jungle reclaiming the upper
levels, monkeys still in the towers, moss everywhere. Mossy greens
and warm sandstone gold under shafts of sunlight through the canopy.

**Layout:** Enter through Bayon's smiling-face towers, weave between
Ta Prohm's strangler-fig roots through flooded inner courtyards,
then anti-grav climb up the central spire of Angkor Wat itself.
Verticality is the structural surprise — this track *climbs* more
than the others do.

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
**Water/Land:** 80/20 | **Anti-grav:** heavy (torch arm + crown
interior, ~25 s) | **Difficulty:** finale

**Location:** Drowned Manhattan. The Statue of Liberty half-
submerged — water at her waist. Her torch arm has collapsed forward,
torch resting on Liberty Island's old battlements. Surrounding waters
reveal Lower Manhattan rooftops: Trinity Church spire poking up,
Charging Bull underwater, the Wall Street bull pit a shoal of yellow
cabs. Brooklyn Bridge cables sagging into the harbor. The Planet of
the Apes silhouette, but more of it.

**Layout:** Three-section track. (1) Open harbor with Manhattan
rooftop landmarks as you skim past. (2) Anti-grav climb up the
underside of the broken torch arm — long single piece of geometry,
copper-green oxidized metal, the most spectacular continuous
anti-grav stretch in the v1 lineup. (3) Anti-grav loop through
the inside of Liberty's crown, exiting out a window. Then back to
the harbor for the lap restart.

**Set-piece — The Torch Arm:** The broken arm itself. Copper-green
oxidation, riveted construction, the torch flame still in the
clenched fist at the far end. You ride the underside on anti-grav
for ~10 seconds, hands-on-handlebars vertigo, harbor visible *above*
you through Liberty's fingers. This is the postcard moment of v1.

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

| # | Track | Cup | Location | Anti-grav | Water | Set-piece |
|---|---|---|---|---|---|---|
| — | Sandbar | Tutorial | (fictional) | brief | 80% | training gates |
| 1 | South Beach Sunken | Reef | Miami | none | 70% | Versace Steps |
| 2 | Cape Town Drift | Reef | Cape Town | none | 60% | Two Oceans Wreck |
| 3 | Hatteras Light | Reef | NC outer banks | light | 80% | Lamp Room |
| 4 | The Maw | Open Sea | Big Sur | none | 100% | The Maw arch |
| 5 | Shibuya Submerged | Open Sea | Tokyo | medium | 50% | Shibuya Crossing Cables |
| 6 | Marina Bay 7 | Continental | Singapore | none | 60% | The Gauntlet |
| 7 | Doge's Drift | Continental | Venice | medium | 70% | Campanile Climb |
| 8 | Kilauea Crown | Continental | Hawaii | heavy | 50% | The Black Beach *(single-lap P2P)* |
| 9 | Aqualand | Drowned | Florida | light | 75% | The Tsunami *(per-lap escalation)* |
| 10 | Angkor Drowned | Drowned | Cambodia | heavy | 65% | Smiling Faces |
| 11 | Liberty Drowned | Drowned | NYC | heavy | 80% | The Torch Arm |

**Geographic spread:** Americas 5 (Miami, NC, Big Sur, Florida, NYC),
Asia 3 (Tokyo, Singapore, Cambodia), Europe 1 (Venice), Africa 1
(Cape Town), Hawaii 1 + 1 fictional tutorial.

**Anti-grav count:** 7 of 11 ship tracks have anti-grav (light to
heavy). Exceeds the 2-track v1 target with significant margin.

**Wave-mastery tracks:** All open-water sections (effectively all 11),
with The Maw as the purest test. Cape Town is the calibration
counterweight — the calm-water track where pumping deliberately
*doesn't* carry you, which is what makes pumping legible as a skill
on the other ten.

**Casual lap distribution:** 22 s (Aqualand chaos) → 45 s → 48 → 50 →
55 → 58 → 60 → 60 → 62 → 70 s + 1 × ~2:30 single-lap descent
(Kilauea). Weighted to the 45–65 s band per
[design-targets.md](./design-targets.md).

**Format breakdown:** 10 × 3-lap loops + 1 × 5-lap chaos arena
(Aqualand) + 1 × single-lap point-to-point descent (Kilauea).
Default is 3 laps; deviations are intentional per the cup-pacing
principle.

## B-list — future content packs

Tracks that survived brainstorm but didn't make the v1 cut. Good
candidates for the v1.1 / first major content drop.

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
- Anti-grav segments should be authored as continuous geometry, not
  individual gravity triggers — the controller flip needs a single
  clear entry and exit.

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
