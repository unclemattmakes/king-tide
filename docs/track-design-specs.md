# King Tide — Track Design Specs v1

> **⚠ Partly superseded (2026-05-30, no-anti-grav reconciliation pass).**
> Anti-grav is **cut from v1.** Every `antigrav_curve_*` object and
> "anti-grav" beat in the per-track specs below (§2.0, §2.3, §2.5, §2.7,
> §2.8, §2.9, §2.10, §2.11) is **retired** and replaced by a
> normal-gravity terrain/ramp solution. The replacements — and each
> track's unique + common prop manifest — live in the canonical per-track
> docs under [tracks/](./tracks/README.md). This doc remains authoritative
> for everything else (beat timing, wave-zone tuning, particle/audio
> configs, hero-camera framing). When the prose here says "anti-grav,"
> read the matching `tracks/<id>.md` for what ships instead.
>
> **Lineup/cup structure: defer to [tracks/README.md](./tracks/README.md)
> (the Harbor Cup).** This doc's cup groupings — the §1.3 reordering, the
> §1.1 single-lap reformat, and the per-track `Cup:` lines — predate the
> Harbor Cup restructure and no longer reflect the shipping cup layout;
> read `tracks/README.md` for which tracks sit in which cup. The
> beat/timing, wave-zone, particle, audio, and camera content here is
> unaffected and still authoritative.
>
> Implementation companion to [track-themes.md](./track-themes.md) (the
> content bible) and [../research/track-flow-analysis.md](../research/track-flow-analysis.md)
> (the cross-game flow analysis). This doc takes each v1 track from
> "we know what it is" to "we know exactly how to author it" — beat
> structure with second-by-second timing, set-piece staging rules,
> per-lap differentiation, branching paths, and a full Blender object
> shopping list keyed to the addon vocabulary in
> [blender-pipeline-guide.md](./blender-pipeline-guide.md).
>
> **Audience:** the author/Claude that will block out tracks in Blender.
> Each per-track spec is meant to be picked up and executed without
> needing to interpret the content bible — every knob, kind, and asset
> name uses the same vocabulary the addon's UI exposes.
>
> **Conventions in this doc:**
> - Times are in **seconds from lap start** at casual pace.
> - "**Beat**" = a structurally distinct phase of the lap that the
>   player should perceive as a section. Most tracks have 3 beats; some
>   have 4 (descent tracks, finale).
> - "**Set-piece**" = the named single moment the track is remembered
>   for. Every track has exactly one. Other dramatic features are
>   *flourishes*, not set-pieces — they shouldn't compete for the
>   memory slot.
> - "**Hard section**" = the highest-skill stretch. Genre-loved tracks
>   put this at 55–75% of lap distance, per the flow analysis. Each
>   spec calls out where in the lap it sits.
> - Object names follow `blender-pipeline-guide.md` conventions exactly
>   (`cp_NN`, `boost_NN`, `wave_zone_NN`, `emitter_NN`, `antigrav_NN`,
>   `scatter_<zone>`, `downtown_NN`, etc.). Use the addon's *Add*
>   menu / sub-panel for each — don't hand-create empties when an
>   operator exists.

---

## 1. Mix refinements (changes from track-themes.md v1)

Five structural refinements come out of the flow-analysis pass.
Each is small in absolute scope but disproportionate in payoff per
the genre-pattern findings. The implementer should treat these as
authoritative — track-themes.md will be updated to match.

### 1.1 Convert Kilauea Crown to single-lap point-to-point

**What changes:** Kilauea is reformatted from 3 × 65 s loop to a
**1-lap, ~2:30 total descent** following the Mount Wario template.
The climb-rim-descend topology is naturally non-repeating; lapping
it three times forces an awkward teleport from the lava-lake finish
back to sea level for the next climb.

**Why:** The flow analysis identifies Mount Wario as the genre's
strongest case for breaking the 3-lap default. King Tide's "drowned
landmark" framing makes the descent-as-finish reading universally
legible (we go *down* to the new sea level). Volcanic erupting
mountain is the most spectacular cup-closer geometry in the v1 set.

**Cup impact:** Continental Cup reorders so Kilauea is the closer
(see §1.3 below).

### 1.2 Designate Cape Town as the calm-water skill check

**What changes:** Cape Town's harbor interior runs at **Beaufort
1–2** (glassy / near-glassy), with rougher Beaufort 3–4 only outside
the harbor mouth. Wave pumping is downgraded as a contributing skill
here; slalom-precision and racing-line memorization are upgraded.

**Why:** The Drake Lake principle from the flow analysis — without
one calm-water track in the set, players never learn what
wave-mastery is *contributing* on the other tracks because they have
nothing to compare it to. Cape Town's harbor framing makes calm
water diegetic; we don't have to invent why the water is flat.

### 1.3 Cup-level reordering

**Reef Cup:** South Beach Sunken → Cape Town Drift → Hatteras Light
*(was: South Beach → Hatteras → Cape Town)*

> South Beach is the purest intro (open water + ramp + first
> pumping). Cape Town adds the calm-water skill check in the middle
> slot. Hatteras closes with the cup's most intense set-piece
> (vertical column + cliff drop). Lap times escalate naturally:
> 45 → 48 → 50 s.

**Continental Cup:** Marina Bay 7 → Doge's Drift → Kilauea Crown
*(was: Kilauea → Marina Bay → Doge's)*

> Marina Bay opens the cup with industrial obstacle racing
> (mid-difficulty, 55 s loop). Doge's middles with the elegant
> Campanile climb spectacle (60 s loop). Kilauea closes with the
> single-lap point-to-point descent (2:30 total) — the spectacle
> closer slot.

**Open Sea Cup** and **Drowned Cup** keep their orders. (Maw →
Shibuya already runs skill → spectacle; Aqualand → Angkor → Liberty
already runs chaos → atmosphere → finale.)

### 1.4 Aqualand Tsunami goes per-lap, not fixed-timer

**What changes:** Instead of a fixed 30-second timer driving the
wave-pool surge, the Tsunami **escalates per lap**:

| Lap | Surge amplitude | Lower-concourse state |
|---|---|---|
| 1 | 1.5 m | Mostly dry; viable path. Splash hazards only. |
| 2 | 3.0 m | Partially flooded; risky path, takes spike-damage on water contact. |
| 3 | 5.0 m | Wave wall washes out the lower concourse mid-lap. Upper-bowl anti-grav becomes mandatory. |
| 4 | 5.0 m | Peak surge sustained. |
| 5 | 5.0 m | Peak surge sustained. |

**Why:** Adder's Lair principle — per-lap escalation built into the
topology gives lap 3 (and 4, 5) a different *physical track*, not
just smarter AI. This is the v1 set's "destructible layout"
representative. Cheap to implement on top of the existing
`wave_zone_NN` `surge_period_s` / `surge_amplitude` extras — drive
the amplitude from a lap counter.

### 1.5 Two new sky color-grade presets

**What changes:** Add two new presets to `SKY_GRADE_TABLE` in
[sky.ts](../src/engine/render/sky.ts) (and mirror in
`SKY_COLOR_GRADES` in `tools/blender/kingtide_addon/sky_preset.py`
+ `src/game/tracks/types.ts`):

- **`singapore_industrial`** — warm container orange lift + steel-gray
  cool shadows + sodium-yellow tint. For Marina Bay 7.
- **`angkor_jungle`** — mossy-green tint, dappled-warmth bias, lower
  saturation. For Angkor Drowned.

**Why:** Currently 8 bundled grades cover Miami, Tokyo, Big Sur,
Venice, NYC, Cape Town, Kilauea, and neutral. Marina Bay and Angkor
have no fit. New entries are cheap (one row each in the LUT) and
prevent two tracks from defaulting to `neutral` and reading flat.

---

## 2. Per-track implementation specs

Each spec is structured identically:

1. **Identity** — cup, lap target, laps, total race, water/land,
   anti-grav, difficulty.
2. **Topology & reference** — shape from §2 of the flow analysis +
   the explicit reference track.
3. **Beat structure** — 3 to 4 beats with seconds-from-lap-start
   timing at casual pace.
4. **Set-piece staging** — first visible at, telegraphed how, lap
   on which it pays off.
5. **Hard section** — lap-distance percentage and what the skill is.
6. **Branching / shortcuts** — risk/reward options per lap.
7. **Per-lap differentiation** — what changes between laps (if
   anything beyond AI/items).
8. **Blender shopping list** — every authored object kind by name
   + count + notes.
9. **Sky preset** — preset name + tuned knobs.
10. **Wave zones** — every `wave_zone_NN` with its tuning.
11. **Particle emitters** — every `emitter_NN` with atlas cell and
    config tweaks.
12. **Audio block** — full JSON for `audio` block in `<id>.json`.
13. **Hero camera framing** — where to park `camera_hero` and what
    it should frame.

Names assume the slugified track ids: `sandbar`, `mexico-city`,
`cape-town-drift`, `hatteras-light`, `the-maw`, `shibuya-submerged`,
`marina-bay-7`, `doges-drift`, `kilauea-crown`, `aqualand`,
`angkor-drowned`, `liberty-drowned`.

---

### 2.0 Mayday Bay (tutorial)

**Identity** — Cup: none · Lap: 60 s scripted · Laps: 1 · Total: 60 s ·
Water/Land: 80/20 · Anti-grav: brief · Difficulty: intro

**Topology & reference** — Simple loop. Reference: **Wave Race 64
Sunny Beach.** The lesson: teach the hero mechanic in the first 8
seconds, with the first swell on the start straight.

**Beat structure:**

| t (s) | Beat | Purpose |
|---|---|---|
| 0–8 | Start swell | **Throttle + first pump** with explicit HUD prompt |
| 8–20 | Steering arc | Wide left-handed bend to teach steering |
| 20–32 | Drift marker | Drift around a marker buoy (drift prompt) |
| 32–42 | Pickup + jump | Grab pickup, use, then ramp jump w/ landing prompt |
| 42–55 | Anti-grav arch | Single arch up-and-over; gravity flip prompt |
| 55–60 | Finish straight | Return to start position |

> Change from track-themes.md: the first swell is moved from t=10–25
> to t=0–8. Pumping is the *first* lesson, not the second. Wave Race
> 64 ships its hero mechanic as level 1, second 1. So do we.

**Set-piece staging:** None — tutorial is deliberately low-key.
The pumping HUD prompt is the focal moment; everything else stages
*around it* rather than competing.

**Hard section:** None.

**Branching:** None.

**Per-lap:** N/A (single lap, scripted).

**Blender shopping list:**

- `terrain_island` via *Add Island Terrain* — 1 central peak at
  20 m, set base radius 80 m. Small training cove.
- `road_curve_main` — none. Use water surface.
- `ai_spline_main` — 8 CPs traced around the cove, hugging the
  inside of the swell.
- `cp_00`..`cp_05` — 6 checkpoints at beat boundaries (0/8/20/32/42/55).
- `start_00`, `start_01` — at t≈0 on the spline (use *Snap Starts to Spline*).
- `pickup_main` — at t=0.55 on the spline (pre-jump beat).
- 1 × `boost_NN` — single tutorial boost on the start swell to
  demonstrate the boost-pad mechanic.
- 1 × `antigrav_curve_NN` — Tube profile, radius 8 m, 8 m arc span
  for the brief arch.
- 1 × `wave_zone_NN` — covers the start straight only; height_mult
  1.3, freq_mult 0.8 (longer rolling swell that's clearly pumpable),
  blend_radius 12 m. **No surge.**
- `scatter_palms` Empty with GN modifier — sparse palm scatter
  along the cove edge (~12 instances).
- Tutorial sign empties (decoration kind) at each beat boundary —
  these are arrows the runtime tutorial system anchors HUD prompts to.

**Sky preset:** `miami_pastel`. `cloudiness=0.2`, `sunIntensity=1.0`,
`fogNear=200`, `fogFar=800`, `seaStateBeaufort=2`, `timeOfDay=120`
(mid-morning).

**Wave zones:**

```json
"waveZones": [
  { "name": "wave_zone_intro", "halfWidth": 30, "halfDepth": 30,
    "heightMult": 1.3, "freqMult": 0.8, "blendRadius": 12 }
]
```

**Particle emitters:**

- `emitter_pump_hint` — atlas_cell 0 (soft spark), emit_rate 8,
  lifetime 1.0, parked at the first wave crest. Visual hint
  "something interesting happens here" before the player arrives.
- `emitter_gulls` — atlas_cell 5 (gull silhouette), emit_rate 1,
  lifetime 8, gravity 0, max_particles 6. Ambient.

**Audio:**

```json
"audio": {
  "music": "sandbar-training-loop.opus",
  "ambient": ["gulls.opus", "surf-light.opus"],
  "ambientGains": [0.5, 0.6],
  "music3dEffects": { "duckOnPump": 0.5 }
}
```

> Stronger pump-duck (0.5 vs default 0.35) — the audio swap on a
> successful pump must be unmistakable when the game is *teaching*
> the mechanic.

**Hero camera:** Low-angle wide shot from the cove's far end looking
back at the start grid with the first swell about to crest into
frame. Sun at golden-hour angle, lens flare bias on.

---

### 2.1 Mexico City (Reef Cup #1)

> *Replaced South Beach Sunken (Miami) in the 2026-06 content pass. Built
> the **current way** — empty scene → track shape → blockin terrain +
> landmarks → progressive dressing — **not** the retired per-track seed
> script. Status: concept locked, geometry pending. Workflow references:
> Mayday Bay (furthest along), Cape Town Drift (mid blockin→props swap).*

**Identity** — Cup: Reef · Lap: 45 s · Laps: 3 · Total: ~2:15 ·
Water/Land: 65/35 · Anti-grav: none · Difficulty: intro

**Topology & reference** — Causeway loop over a calm lake. Reference:
**Wave Race 64 Sunny Beach** (bright friendly opener) + a Mario-Kart
city-grid causeway thread. The lake is calm — pumping is gentle; this is
the handshake.

**Beat structure:**

| t (s) | Beat | Description |
|---|---|---|
| 0–10 | Calzada start | Causeway straight, drowned Centro Histórico facades either side, calm lake |
| 10–20 | Zócalo lagoon | Weave the half-sunk cathedral + Templo Mayor steps; trajineras fanned across the water |
| 20–28 | Reforma run-up | Speed line down Paseo de la Reforma toward the gold Ángel |
| 28–36 | **El Ángel (set-piece)** | Ride *up* the collapsed Segundo Piso freeway deck; launch past the golden statue |
| 36–45 | Chapultepec turn / finish | Bank through drowned Chapultepec park back to the causeway start |

**Set-piece staging:** The gold Ángel reads as a distant gleam across the
lake from the start grid; the collapsed Segundo Piso deck is the obvious
ramp on the Reforma run-up. Ramp at ~62–80% of lap distance — squarely the
hardest-section slot.

**Hard section:** 28–36 s (El Ángel approach). The skill is **timing the
launch off the broken freeway lip** — beginner-forgiving, as befits the
opener.

**Branching:**

- **Trajinera-raft line** (10–20 beat) — skip across the moored Xochimilco
  boats spanning the Zócalo lagoon. Saves ~1.5 s, costs the cathedral-gap
  angle into the Reforma run-up.
- The freeway ramp is bypassable on Casual — skim around at water level.
  Pro line *always* takes the ramp.

**Per-lap:** No structural changes between laps. The lake stays calm. (This
is the simplest track; per-lap variation belongs on deeper tracks.)

**Blender shopping list:** *(author in an empty scene, current workflow)*

- Terrain: **Aztec causeway clusters** (`mat_track_road`) — raised stone
  roadways ~12 m wide, lifted to sit just above the lake surface.
  `kind=track`. The loop's spine — the only "land."
- 1 × **collapsed Segundo Piso freeway deck** as the El Ángel ramp — single
  `kind=track` mesh; tilted deck = run-up, broken lip = takeoff lip.
- **Templo Mayor pyramid steps** — stepped stone mass (`kind=track`) at the
  Zócalo, skimmed past.
- **Catedral Metropolitana** — half-sunk + tilted; lower mass `kind=track`,
  towers `kind=decoration`.
- `ai_spline_main` — ~16 CPs through the full loop incl. the ramp launch +
  landing.
- `cp_00`..`cp_07` — 8 checkpoints at beat boundaries (×3 lap structure).
- 2 × `boost_NN` — one on the Calzada start straight, one on the Reforma
  run-up.
- `start_00`, `start_01` — at t≈0.95 on the spline (just before the finish
  line so lap 1 timer starts clean).
- 2 × `pickup_*` — one on the Zócalo lagoon, one on the Reforma straight.
- **No anti-grav** (per intro-tier identity).
- 1 × `wave_zone_lake`: covers the whole loop. halfWidth large, heightMult
  0.6, freqMult 1.0, blendRadius 25. A calm high-altitude lake — gentle
  swell so the open stretches still pump, but nothing punishing.
- `scatter_jacaranda` GN scatter — jacaranda + ahuehuete cypress on the
  causeway edges (replaces the tropical-palm scatter).
- `scatter_rocks` GN scatter — submerged rubble + chinampa debris under the
  water line (~30 instances of `prop_rock`).
- **Decoration meshes:** the **Ángel de la Independencia** column (gold, no
  collision), **trajinera** boats (colourful, fanned across the lagoon),
  drowned colonial facades, papel-picado banner strings. All
  `kind=decoration`.
- **Horizon ring (bespoke):** Popocatépetl + Iztaccíhuatl twin-volcano
  silhouette (one smoking) — the track's distant identity; **lock early.**

**Sky preset:** `mexico_city_rosa`. `cloudiness=0.22`, `sunIntensity=1.1`,
`fogNear=180`, `fogFar=700`, `timeOfDay=300` (late afternoon — warm
rosa-mexicano light over the lake), `seaStateBeaufort=2`.

**Wave zones:** (see Blender shopping list above)

**Particle emitters:**

- `emitter_papel_picado` — atlas_cell 6 (leaf/paper), emit_rate 1.5,
  lifetime 6, gravity -0.2, parked over the Zócalo. Drifting cut-paper
  colour.
- `emitter_lake_birds` — atlas_cell 5, emit_rate 0.5, lifetime 12,
  max_particles 8. Ambient (inland-lake waterbirds; the gull emitter
  re-skinned).
- `emitter_jacaranda_fall` — atlas_cell 6 (leaf), emit_rate 1, lifetime 6,
  gravity -0.3, parked under the jacaranda clusters (instance multiple
  times). Purple petal drift.
- `emitter_explosion` — for crash VFX; required by the runtime.
  atlas_cell 1 (smoke).

**Audio:**

```json
"audio": {
  "music": "mexico-city-cumbia.opus",
  "ambient": ["lake-birds.opus", "city-distant.opus", "marimba-busker.opus"],
  "ambientGains": [0.4, 0.5, 0.25],
  "music3dEffects": { "duckOnPump": 0.35 }
}
```

**Hero camera:** Low across the lake, looking down the Reforma run-up with
the gold Ángel in the right third of frame, the collapsed freeway ramp
leading the eye, Popocatépetl smoking in the back. 50 mm lens, slight Dutch
tilt (3°) for the postcard.

---

### 2.2 Cape Town Drift (Reef Cup #2 — was #3)

**Identity** — Cup: Reef · Lap: 48 s · Laps: 3 · Total: ~2:24 ·
Water/Land: 60/40 · Anti-grav: none · Difficulty: intro (calm-water skill)

**Topology & reference** — Loop with central tunnel section.
Reference: **Wave Race 64 Drake Lake** (calm-water skill check) +
**Marine Fortress** (one-shot-kill tunnel option).

> **Mix refinement:** This is the v1 set's calm-water track. Wave
> pumping is downgraded — the harbor interior runs at Beaufort 1–2.
> Slalom-precision through wreckage is upgraded. This is what makes
> pumping legible *as a skill* on the other ten tracks.

**Beat structure:**

| t (s) | Beat | Description |
|---|---|---|
| 0–10 | Harbor mouth | Outside the breakwater; Beaufort 3 chop. Brief opener at the wider sea state. |
| 10–22 | **Glass harbor slalom** | Beaufort 1 interior; weave between half-sunk containers and a tipped ferry. Pumping no longer pays — racing line does. |
| 22–32 | **Two Oceans Wreck (set-piece)** | Through the broken aquarium's roof, past the watching great white in the cracked tank, out through the seaward wall. Optional one-shot-kill skylight shortcut on top. |
| 32–42 | Cape Wheel underpass | Under the leaning Ferris wheel's bottom arc (anti-grav-adjacent feel without actual gravity flip — bike just pitches up to clear). |
| 42–48 | Finish straight | Past the waterfront market remnants back to start. |

**Set-piece staging:** Two Oceans Wreck's iconic shark is **visible
through the broken aquarium glass from the harbor mouth** beat 1 —
even before you enter the building, you can see the silhouette
circling inside. Plays at 45–67% of lap distance. The shark itself
is decoration (no collision); the broken aquarium structure is
`kind=track`.

**Hard section:** 10–22 s (glass harbor slalom). Skill: **reading
the slack-water line** without the swell to push you. Hitting half-
submerged debris on calm water at speed is uniquely punishing
because you can't blame the wave.

**Branching:**

- **Aquarium skylight shortcut** (22–32 beat): pop up onto the
  aquarium roof and drop through a skylight directly into the
  predator tank, then out the seaward wall. Saves ~2 s. The
  skylight rim is `kind=track` with a sharp top edge — clip it,
  total bike. **This is the v1 set's "Marine Fortress tunnel" —
  high-risk expert line.**
- **Cape Wheel inside** vs **outside** (32–42 beat): inside the
  wheel arc is tighter and faster; outside is wider and safer.

**Per-lap:** No structural changes. (Tide constant; weather constant.)

**Blender shopping list:**

- Terrain: **breakwater wall** (1 elongated mesh, `kind=track`)
  forming the harbor boundary; **half-sunk container stack** (~6
  meshes, mixed orientations); **broken aquarium structure**
  (concrete shell with the roof opening + seaward wall opening,
  one `kind=track` mesh with the shark visible inside via a
  decoration mesh).
- 1 × **tipped ferry** static mesh (`kind=decoration`) emerging
  from the harbor mouth.
- 1 × **Cape Wheel** structure (one large `kind=track` curved
  arc for the bottom that the bike passes under, decoration mesh
  for the upper struts/cars).
- `road_curve_main` — short slab section across the waterfront
  market (lap finish straight). Slab thickness 0.6.
- `ai_spline_main` — 18 CPs. **AI should take the inside/safe
  line** at every branch; pros take the shortcuts.
- `cp_00`..`cp_06` — 7 checkpoints at beat boundaries.
- 1 × `boost_NN` — on the finish straight (compensates for the
  calm-water section's lack of pumping rhythm).
- `start_00`, `start_01` — at t≈0.97 on the spline.
- 2 × `pickup_*` — one in the harbor slalom (between containers),
  one after the aquarium exit.
- 2 × `wave_zone_NN`:
  - `wave_zone_harbor_mouth`: covers the outside-the-breakwater
    section. halfWidth 30, halfDepth 25, heightMult 1.1,
    freqMult 1.0, blendRadius 18. direction_deg 270 (Atlantic
    swell from the west).
  - `wave_zone_harbor_glass`: covers the interior harbor.
    halfWidth 60, halfDepth 45, heightMult **0.2**, freqMult
    1.5, blendRadius 25. **The defining wave zone of this
    track** — near-glass calm.
- `scatter_rocks` — coral debris under harbor water (~25 instances).
- **Distant landmark:** **Table Mountain horizon ring** — author a
  bespoke `horizon_ring` mesh via *Add Horizon Ring*. Pull verts
  to form the flat-topped silhouette behind the harbor. Lock this
  early; it's 30% of the track's identity.

**Sky preset:** `cape_town_blue`. `cloudiness=0.4` (typical Atlantic
overcast), `sunIntensity=0.85`, `fogNear=150`, `fogFar=650`,
`timeOfDay=180` (midday), `seaStateBeaufort=2`.

> Lower `seaStateBeaufort` than other tracks reinforces the calm
> identity at the global wave amplitude level. The harbor interior
> zone pushes it lower still.

**Wave zones:** (see Blender shopping list above)

**Particle emitters:**

- `emitter_shark_water` — atlas_cell 3 (foam droplet), emit_rate 0.5,
  lifetime 3, parked above the broken aquarium tank where the shark
  surfaces. Implies the shark is breathing/moving.
- `emitter_container_rust` — atlas_cell 1 (smoke puff), emit_rate 0.3,
  lifetime 4, parked over the container stack. Implies wet decay.
- `emitter_gulls` — atlas_cell 5, emit_rate 1.5, lifetime 10,
  max_particles 12. Heavier than South Beach — this is a working
  harbor.
- `emitter_explosion` — required.

**Audio:**

```json
"audio": {
  "music": "cape-town-afrobeat-electronic.opus",
  "ambient": ["gulls.opus", "surf-light.opus", "harbor-creak.opus"],
  "ambientGains": [0.7, 0.3, 0.4],
  "music3dEffects": { "duckOnPump": 0.20 }
}
```

> **`duckOnPump=0.20`** (well below default 0.35) — pumping doesn't
> happen much here, so when it does it shouldn't dominate the mix.

**Hero camera:** Eye-level looking through the broken aquarium roof
opening, shark silhouette circling in the foreground tank, harbor
visible through the seaward-wall opening past it. Table Mountain
just visible behind the harbor. 35 mm lens (wider — sells the
"two oceans" through-line composition).

---

### 2.3 Hatteras Light (Reef Cup #3 — was #2)

**Identity** — Cup: Reef · Lap: 50 s · Laps: 3 · Total: ~2:30 ·
Water/Land: 80/20 · Anti-grav: light (lighthouse climb, ~5 s) ·
Difficulty: intro (cup closer)

**Topology & reference** — Loop with vertical column + cliff-drop
finish. Reference: **MK8 Shy Guy Falls** (vertical column climb) +
**Jet Moto Cliffdiver** (lap ending on a drop).

**Beat structure:**

| t (s) | Beat | Description |
|---|---|---|
| 0–12 | Open Atlantic | Heavy Beaufort 4–5 swell circling the lighthouse base. First real wave-reading test. |
| 12–20 | Base approach | Wave-pumped lift toward the lighthouse base; the corkscrew entry is staged here. |
| 20–32 | **The Lamp Room (set-piece)** | Anti-grav corkscrew up the lighthouse shaft, exit through the open lamp room at the top, ramp off the railing. |
| 32–42 | **Cliff drop finale** | Long open-water descent back to sea level — the lap's *closer flourish*. Music swells on lamp exit. |
| 42–50 | Finish straight | Lower-altitude approach back to start. |

> **Mix refinement:** Every lap ends with the cliff drop (Jet Moto
> Cliffdiver lesson). Music swells on lamp-room exit. This is the
> Reef Cup closer's emotional payoff — three intro tracks, and the
> third one *lands* every lap.

**Set-piece staging:** Lighthouse is visible from anywhere on the
track — it's the only landmark for kilometers. From the start grid
it sits in the center of frame. The corkscrew entry is at 40% of
lap distance; the lamp room exit at ~64% — right at the hardest-
section apex. Lap-1 visibility is automatic; you can see the lamp
*rotating* before you've moved.

**Hard section:** 20–32 s (the corkscrew + lamp exit). Skill:
**holding the anti-grav line under the centripetal pull** of the
corkscrew while pumping the wave that approaches the base. Late
pumpers stall in the corkscrew; over-pumpers over-shoot the lamp.

**Branching:**

- **Outside vs inside the corkscrew lip** (24–28 s): the inside
  line is faster but exits at a steeper drop angle; the outside is
  safer but adds ~0.5 s.
- **Cliff-drop pump timing** (32–42 s): pumping into the descent's
  wave train gives a 4–5% top-speed bonus for the finish straight.
  Most casuals coast it.

**Per-lap:** **Lamp rotates** continuously; passing through the
lamp room is timing-dependent — on Hard difficulty the rotating
beacon arm physically blocks the exit window for 0.6 s every 4 s.
Lamp brightness intensifies across laps (visual climax build).

**Blender shopping list:**

- Terrain: **lighthouse cylinder** as a single hand-modeled mesh
  (`kind=track`) with the iconic black-and-white spiral painted via
  vertex color or a 2-material slot setup (`mat_track_lighthouse_white`
  + `mat_track_lighthouse_black`). Roughly 60 m tall, ~12 m radius,
  base submerged ~20 m below sea level (cap that part for
  performance).
- **Lamp room** as a separate `kind=track` mesh — open ironwork
  catwalk + glass dome + central lamp + railing. The railing's
  outer rim is the ramp lip.
- 1 × `antigrav_curve_NN` — **Tube** profile, radius 6 m, 60 m
  arc going up the lighthouse exterior in a single corkscrew turn.
  `samples=72` for smooth corkscrew. The tube wraps the lighthouse
  cylinder 1.5×.
- 1 × `tunnel_curve_main` — not used here (the anti-grav tube
  replaces it).
- `ai_spline_main` — 22 CPs. Include the vertical climb explicitly
  — the spline can climb in 3D, it's not constrained to the water
  surface.
- `cp_00`..`cp_07` — 8 checkpoints at beat boundaries.
- 3 × `boost_NN`:
  - Start of Atlantic straight (rhythm anchor)
  - Top of corkscrew (rewards committing to the climb)
  - Cliff-drop entry (rewards pumping into the descent)
- `start_00`, `start_01` — at t≈0.96 on the spline.
- 2 × `pickup_*` — one on the open Atlantic, one mid-corkscrew
  (the pickup *is* a commitment lock — once you grab it, you're
  in the corkscrew).
- 2 × `wave_zone_NN`:
  - `wave_zone_atlantic_open`: covers the full surrounding ocean.
    halfWidth 80, halfDepth 80, heightMult 1.5, freqMult 0.9,
    blendRadius 30. direction_deg 0 (north-bound Atlantic swell).
    **Optional surge** with surge_period_s=8, surge_amplitude=1.0
    for periodic big-swell pulses.
  - `wave_zone_lighthouse_lee`: smaller zone on the downwind side
    of the lighthouse where the structure breaks up the chop.
    halfWidth 25, halfDepth 25, heightMult 0.7, blendRadius 15.
- `scatter_rocks` — minimal, ~8 submerged shoal rocks.
- **No downtown.** No palms (wrong climate).
- **Horizon ring:** procedural fallback is fine — Cape Hatteras is
  the only landmark, and it's *in* the scene.

**Sky preset:** `cape_town_blue` (reuse — fits cool Atlantic gray).
`cloudiness=0.6` (low gray clouds per the bible), `sunIntensity=0.7`,
`fogNear=120`, `fogFar=550`, `timeOfDay=240` (overcast late afternoon),
`seaStateBeaufort=5`.

> `seaStateBeaufort=5` is the highest in the Reef Cup — Hatteras is
> the cup's "you're ready for Open Sea Cup now" stress test on
> pumping skill.

**Wave zones:** (see Blender shopping list above)

**Particle emitters:**

- `emitter_lamp_glare` — atlas_cell 7 (neon glare), emit_rate 4,
  lifetime 1, parked at the lamp center. Rotates with the lamp
  (parent the empty to the lamp mesh).
- `emitter_foghorn_mist` — atlas_cell 1 (smoke puff), emit_rate 0.5,
  lifetime 5, parked at the lighthouse base. Implies cold air on
  warm water.
- `emitter_atlantic_spray` — atlas_cell 9 (water spray), emit_rate 6,
  lifetime 2, gravity -2, scattered across the open Atlantic zone
  (~3 emitter empties).
- `emitter_gulls` — atlas_cell 5, emit_rate 0.5, max_particles 5.
- `emitter_explosion` — required.

**Audio:**

```json
"audio": {
  "music": "hatteras-ambient-synth-foghorn.opus",
  "ambient": ["foghorn.opus", "surf-heavy.opus", "wind-low.opus"],
  "ambientGains": [0.3, 0.7, 0.5],
  "music3dEffects": { "duckOnPump": 0.40 }
}
```

**Hero camera:** Slightly elevated, looking up at the lighthouse
with the corkscrew anti-grav tube visible wrapping the structure;
storm clouds behind; spray plume at the base. 35 mm lens, slight
upward tilt to emphasize verticality.

---

### 2.4 The Maw (Open Sea Cup #1)

**Identity** — Cup: Open Sea · Lap: 60 s · Laps: 3 · Total: ~3:00 ·
Water/Land: 100/0 · Anti-grav: none · Difficulty: showcase

**Topology & reference** — Loop, sparse, ocean-arena. Reference:
**Wave Race 64 Glacier Coast / Southern Island.** The wave *is*
the track.

**Beat structure:**

| t (s) | Beat | Description |
|---|---|---|
| 0–15 | Open Pacific opener | No structure other than swell. Pumping pays for ~5 s top-speed gain. |
| 15–28 | **First arch + small Maw** | Two smaller rock arches in series; either-or path choice on the second. |
| 28–42 | **The Maw (set-piece)** | The largest arch. Swell-timed launch through with crest = ~10% top-speed bonus into next beat. |
| 42–52 | Inner channel | Calmer in the lee of the arches. Brief recovery beat. |
| 52–60 | Finish straight + McWay drift | Pass alongside McWay Falls' downward spray; finish line. |

**Set-piece staging:** The Maw is **visible from the start grid**
in the middle distance — silhouetted golden rock arch against deep
navy Pacific. As you approach it the apparent size dominates the
frame at t=22+. Plays at 47–70% of lap distance. The swell pattern
that determines whether the Maw launches you or eats you is **legible
4–6 seconds in advance** — players who learn the wave-reading skill
can predict the launch.

**Hard section:** 28–42 s (the Maw itself). Skill: **wave timing.**
The wave field is the puzzle; nothing else matters.

**Branching:**

- **Second smaller arch left vs right** (15–28 beat): the right
  side is tighter but the swell direction means it usually launches
  faster.
- **Inside vs outside the Maw arch column** (28–42): mostly cosmetic
  — both work, both legible.

**Per-lap:** **Wave timing changes the lap.** The same checkpoint
hit at the same time of day produces a different Maw experience
depending on the rolling swell phase. Lap 1 and lap 3 will feel
materially different. This is *intentional* — the lesson of the
track is "no two runs are the same; learn to read it."

**Blender shopping list:**

- Terrain: **3 rock arches** as hand-modeled `kind=track` meshes
  with thick volumes (≥4 m wall thickness). The Maw is the
  centerpiece — ~50 m arch span, ~30 m arch height, rough
  weathered surfaces.
- **McWay Falls cliff** — a single tall `kind=track` mesh on the
  east edge. Waterfall is **decoration** with a water-stream emitter.
- 1 × **bridge remnant** — collapsed Bixby Bridge concrete remnant
  as a single `kind=track` mesh forming a small jump halfway
  through the open Pacific opener. (Diegetic + functional —
  rewards pumpers who hit the swell rhythm + clear the remnant.)
- `road_curve_main` — none. All-water.
- `ai_spline_main` — 24 CPs. The AI should take a competent line
  *but never the optimal wave-timed one* (per design-targets §1 —
  AI rubber-band toggle); the Maw's mastery is a player advantage.
- `cp_00`..`cp_07` — 8 checkpoints. Cp under the Maw arch must be
  large (`half_width=20`) because the Maw entrance is wide.
- 2 × `boost_NN`:
  - Mid-Maw arch (rewards committing to the high-risk wave timing)
  - Inner channel exit (compensates for the calm recovery beat)
- `start_00`, `start_01` — at t≈0.95 on the spline.
- 2 × `pickup_*` — one in the first-arch sequence, one in the
  inner channel.
- 3 × `wave_zone_NN`:
  - `wave_zone_open_pacific`: covers most of the loop. halfWidth
    120, halfDepth 120, heightMult 1.6, freqMult 0.85,
    blendRadius 40. direction_deg 270 (Pacific westerly swell).
    **Surge: period_s=7, amplitude=2.0** — periodic big-set pulse
    that's the source of the Maw timing puzzle.
  - `wave_zone_maw_throat`: smaller zone *inside* the largest arch.
    halfWidth 25, halfDepth 25, heightMult **2.2**, freqMult 0.7,
    blendRadius 15. Larger amplitude inside the arch — the wave is
    funneled by the geometry. **Surge inherits** from open Pacific
    (same period_s).
  - `wave_zone_inner_lee`: behind the arches. halfWidth 30,
    halfDepth 30, heightMult 0.5, blendRadius 18.
- `scatter_rocks` — sea stacks scattered between the arches (~15
  instances, larger-than-default Size).
- **Horizon ring:** procedural fallback — Pacific horizon is empty
  by design.

**Sky preset:** `big_sur_golden`. `cloudiness=0.3` (dramatic
cumulus per the bible), `sunIntensity=1.2`, `fogNear=200`,
`fogFar=900`, `timeOfDay=300` (late afternoon golden hour),
`seaStateBeaufort=5`.

**Wave zones:** (see Blender shopping list above) — **the most
tuned wave-zone config in the v1 set; this is the track that
proves wave mastery is the signature.**

**Particle emitters:**

- `emitter_mcway_falls` — atlas_cell 9 (water spray), emit_rate 30,
  lifetime 3, gravity -4, size_start 0.6 size_end 1.5. Parked at
  the top of McWay Falls; the stream is a column of falling spray.
- `emitter_maw_spray` — atlas_cell 9, emit_rate 12, lifetime 2,
  parked at the Maw arch entrance crown. Fires harder on big swells
  (use `triggerBurst` from sim code on surge peaks).
- `emitter_arch_haze` — atlas_cell 4 (dust mote / haze), emit_rate
  3, lifetime 6, parked in the middle of the Maw arch interior.
  Sun-haze sells the volume.
- `emitter_explosion` — required.

**Audio:**

```json
"audio": {
  "music": "the-maw-cinematic-surf.opus",
  "ambient": ["surf-heavy.opus", "wind-low.opus", "mcway-falls-distant.opus"],
  "ambientGains": [0.6, 0.4, 0.5],
  "music3dEffects": { "duckOnPump": 0.45 }
}
```

> **`duckOnPump=0.45`** (highest in v1 set) — pumping is the *whole
> point of this track*. The audio should respond hard.

**Hero camera:** Low across the water, looking through the Maw
arch toward the open Pacific with a swell about to fill the arch
frame. McWay Falls on the right edge. Sunset gold lighting. 50 mm
lens, square horizon (no Dutch).

---

### 2.5 Shibuya Submerged (Open Sea Cup #2)

**Identity** — Cup: Open Sea · Lap: 58 s · Laps: 3 · Total: ~2:54 ·
Water/Land: 50/50 · Anti-grav: medium (Cocoon Tower face, ~10 s) ·
Difficulty: showcase

**Topology & reference** — Loop with branching shortcuts + vertical
anti-grav wall. Reference: **MK8 Cloudtop Cruise** (weather/music
synced beat structure) + **MKW Great ? Block Ruins** (multiple
discreet shortcuts).

**Beat structure:**

| t (s) | Beat | Description |
|---|---|---|
| 0–10 | Rooftop-bridge launch | Start on a wide rooftop, drop into a cable network across the famous crossing |
| 10–22 | **Shibuya Crossing Cables (set-piece)** | Race across powerline cables + toppled neon signage over the 15 m-underwater intersection. Hachiko statue visible underwater. |
| 22–34 | **Cocoon Tower face (anti-grav)** | Wall-ride one face of the Cocoon Tower (Mode Gakuen). Music shifts to a higher BPM here. |
| 34–46 | Skyscraper canyon | Threading between Shinjuku skyscraper tops; choose between rooftop-bridge path and water-channel path |
| 46–58 | Finish straight | Wide rooftop loop back to start grid |

**Set-piece staging:** The crossing is **visible from the start
grid** — the cable network and the underwater neon reflections are
in the foreground. Plays at 17–38% of lap distance (early), which
breaks the 55–75% rule deliberately: the set-piece is what hooks
the player on lap 1, and Shibuya's purpose is the postcard. The
Cocoon Tower anti-grav at 38–59% is the *secondary* hero moment
in the hard-section slot.

**Hard section:** 22–34 s (the Cocoon wall-ride). Skill:
**maintaining anti-grav line at speed on a flat vertical surface
with neon signage as obstacles.** The wall isn't just decorative
— window-ledge protrusions force a snaking line.

**Branching:**

- **Cables vs rooftop bridge** (10–22 beat): the rooftop bridge
  goes around the crossing; the cables go *across*. Cables are
  faster but you fall if you mistime a jump between cable strands.
  Three cables, two gaps.
- **Anti-grav vs ground path** (22–34): you can skip the Cocoon
  wall-ride and go around the tower at street level (now water
  level). Slower by ~3 s but doesn't require the anti-grav skill.
- **Rooftop bridge vs water channel** (34–46): standard branching
  choice between the two skyscraper-canyon paths.

**Per-lap:** **Neon glare intensifies** across laps — lap 3's
glare emitter rate doubles, lighting the underwater intersection
more brightly. (Visual escalation only; no gameplay change.)

**Blender shopping list:**

- **`downtown_NN`** via *Add Downtown* — but **invert the metaphor:**
  the building tops are the racing surface. Set X=4, Y=4, Block 40,
  Street 10, Min h 60, Max h 110, Conform to terrain OFF (we'll
  place this on a flat underwater plinth). After generation, raise
  the whole downtown empty so building tops are at sea level
  (rooftops just above the water plane).
- **Terrain plinth** — single large flat mesh under the buildings,
  ~25 m below sea level (the flooded street level).
- **Cable network mesh** — three parallel cables modeled as long
  thin `kind=track` cylinders, ~30 m spans across the crossing,
  with toppled neon-signage flat planks (`kind=track`) bridging
  some of the gaps. The cables themselves need ~0.6 m collider
  thickness so the bike doesn't slip off lateral edges.
- **Cocoon Tower face** — single flat vertical `kind=track` mesh,
  ~80 m tall × 30 m wide, with window-ledge protrusion meshes
  jutting ~2 m proud.
- **Hachiko statue** — `kind=decoration` mesh on the seafloor
  under the crossing, visible through the water shader.
- 1 × `antigrav_curve_NN` — **Banked strip** profile, width 12 m,
  thickness 0.4 m. Author the curve with `tilt = ±π/2` on every
  control point to set the strip vertical. ~80 m length up the
  Cocoon face.
- `road_curve_main` — short rooftop-bridge slab on the 34–46 beat
  branch. Slab thickness 0.6, banking via Tilt at the corner.
- `ai_spline_main` — 22 CPs. AI takes the rooftop bridge + ground
  path (safe routes); pro shortcuts are player-only.
- `cp_00`..`cp_07` — 8 checkpoints.
- 4 × `boost_NN`:
  - On the cable network (rewards committing)
  - At the top of the Cocoon wall-ride exit
  - On the rooftop-bridge branch
  - On the finish straight
- `start_00`, `start_01` — at t≈0.96.
- 3 × `pickup_*` — one per major beat (crossing, Cocoon, canyon).
- 2 × `wave_zone_NN`:
  - `wave_zone_streets_flooded`: at street level (the bike rarely
    touches this but the rendered water under the cables does).
    halfWidth 60, halfDepth 60, heightMult 0.3, freqMult 1.8,
    blendRadius 25. (Calm — sheltered between buildings.)
  - `wave_zone_open_skyline`: at the skyscraper-canyon water-channel
    branch. halfWidth 25, halfDepth 30, heightMult 1.2, freqMult
    1.1, blendRadius 18.
- **Horizon ring:** **bespoke authored.** Pull Skytree silhouette
  into the back, with Mt. Fuji distant on a clear face. This is the
  only Shibuya track in the v1 set; the horizon has to *say* Tokyo.

**Sky preset:** `tokyo_neon`. `cloudiness=0.5`, `sunIntensity=0.5`
(night-ish; the neon is the light source), `fogNear=80`, `fogFar=350`,
`timeOfDay=0` (midnight is t=0 in the cycle — adjust to match the
preset's night bias), `seaStateBeaufort=2`. **`bloom=1.6`** if/when
bloom pass lands.

**Wave zones:** (see Blender shopping list above)

**Particle emitters:**

- `emitter_neon_glare_*` — atlas_cell 7, emit_rate 8, lifetime 1.5,
  size_start 0.8 size_end 1.4. Parked at 6+ neon signage locations.
  This is the postcard atmosphere.
- `emitter_crossing_reflections` — atlas_cell 10 (glow halo),
  emit_rate 3, lifetime 4, parked above the water surface of the
  flooded crossing. Reflects upward toward the cables.
- `emitter_skyscraper_haze` — atlas_cell 4 (dust mote), emit_rate
  1, lifetime 10, parked at high altitude over the buildings.
- `emitter_cocoon_window_light` — atlas_cell 0 (soft spark),
  emit_rate 2, lifetime 0.8, parked at random window-ledge
  protrusions. Implies the building still has power.
- `emitter_explosion` — required.

**Audio:**

```json
"audio": {
  "music": "shibuya-city-pop-vocoder.opus",
  "ambient": ["neon-hum.opus", "harbor-creak.opus", "wind-mid.opus"],
  "ambientGains": [0.7, 0.3, 0.3],
  "music3dEffects": { "duckOnPump": 0.30 }
}
```

> The Cocoon Tower beat (22–34 s) needs a **music BPM/intensity
> shift** in the .opus track — coordinate with composer to put a
> drop at t=22 of the loop. This is the Cloudtop Cruise lesson:
> the music sells the section break.

**Hero camera:** Low above the cable network at lap-1 start
position, looking across the crossing toward the Cocoon Tower with
neon glare flares filling the upper third. Skytree silhouette top
right. 35 mm lens, slight upward tilt.

---

### 2.6 Marina Bay 7 (Continental Cup #1 — was #2)

**Identity** — Cup: Continental · Lap: 55 s · Laps: 3 · Total: ~2:45 ·
Water/Land: 60/40 · Anti-grav: none · Difficulty: mid

**Topology & reference** — Loop with timed-hazard gauntlet +
high-risk shortcut. Reference: **Wave Race 64 Marine Fortress**
(one-shot-kill shortcut option) + **Jet Moto Hammerhead**
(collapsed-infrastructure track aesthetics).

**Beat structure:**

| t (s) | Beat | Description |
|---|---|---|
| 0–10 | Shipping-channel opener | Murky water lane between two half-submerged container stacks |
| 10–22 | Container-stack streets | Two-block grid of half-submerged orange container stacks; tight chicane line |
| 22–34 | **The Gauntlet (set-piece)** | Five gantry cranes on fixed timers swing shipping containers across the lane at chest-height. Duck or eat steel. |
| 34–44 | Freighter deck OR around | Either jump up onto the beached supertanker's deck (shortcut + pickup denial zone) or take the longer outside-the-hull water path. |
| 44–55 | Gantry-crane gauntlet finish | Two more cranes (faster timers) + back to start |

**Set-piece staging:** The Gauntlet's cranes are visible from the
start grid as **sodium-yellow silhouettes** against the night sky;
their container loads swing in idle pattern even before the race
starts. Plays at 40–62% of lap distance — right in the hardest-
section slot.

**Hard section:** 22–34 s (the Gauntlet). Skill: **reading the
crane-swing timing 4–5 seconds in advance** while maintaining
racing line through the container chicane.

**Branching:**

- **Freighter deck shortcut** (34–44 beat): jump up onto the
  beached supertanker. Saves ~3 s. **Pickup denial zone** — no
  items spawn on the deck, so committing to the shortcut costs
  pickup opportunities. (Diegetic: nothing falls onto a freighter
  deck.)
- **Container chicane left vs right** (10–22): the right-side line
  is faster but exits at a worse angle for the Gauntlet entry.

**Per-lap:** Crane timers stay constant within a race (predictable
on lap 3 once you've learned them on lap 1). On Hard difficulty,
the timer phase is randomized per race (you can't memorize across
sessions).

**Blender shopping list:**

- **Container stacks** — author as instanced library prop
  (`scatter_containers` empty with GN scatter from a `prop_container`
  library prop). ~80 containers, mixed orientations, some
  half-submerged. `kind=track` on the parent so the prototype is
  collidable. (Caveat from blender-pipeline-guide: collidable
  scatter isn't wired yet — fall back to manually-placed `kind=track`
  containers, ~25 hand-placed.)
- **5 gantry cranes** — single hand-modeled `kind=track` mesh per
  crane (gantry + leg + counterweight, ~40 m tall each). The
  containers swinging from the cranes are **runtime-animated** —
  author as `kind=track` child meshes named `crane_NN_swing_load`
  that the sim layer can move on a timer. (This is new behavior;
  flag for impl Claude to add a simple `kind=swinging_hazard` or
  similar runtime hook, or animate via Blender animation curves
  exported through glTF animation channels — Three.js loader
  supports glTF animations natively.)
- **Beached supertanker** — single large `kind=track` hull mesh
  (~120 m long), with a flat deck surface raised ~8 m above sea
  level. Wheelhouse decoration mesh on top.
- `road_curve_main` — none. Bike races on water + container tops
  + freighter deck.
- `ai_spline_main` — 20 CPs. **AI takes the longer outside route**
  past the freighter (the shortcut requires jump-up commit).
- `cp_00`..`cp_07` — 8 checkpoints.
- 3 × `boost_NN`:
  - Shipping channel opener (rhythm)
  - Inside the freighter deck shortcut (rewards committing)
  - Final gauntlet exit
- `start_00`, `start_01` — at t≈0.96.
- 2 × `pickup_*` — one in container chicane, one on outside route
  past freighter. **Zero pickups on the freighter deck** (diegetic
  rule).
- 1 × `wave_zone_NN`:
  - `wave_zone_harbor`: covers the full harbor. halfWidth 100,
    halfDepth 80, heightMult 0.5, freqMult 1.4, blendRadius 25.
    Slack inner-harbor water with surface chop.
- **Horizon ring:** procedural fallback OK; Singapore skyline is
  decoration via crane silhouettes already.

**Sky preset:** `singapore_industrial` *(new preset — see §1.5)*.
`cloudiness=0.6`, `sunIntensity=0.6` (sodium-lamp night), `fogNear=80`,
`fogFar=400`, `timeOfDay=60` (early night), `seaStateBeaufort=3`.

**Wave zones:** (see Blender shopping list above)

**Particle emitters:**

- `emitter_crane_sodium_lamp_*` — atlas_cell 7 (neon glare),
  emit_rate 1, lifetime 8, color_start warm-yellow. Parked at
  each crane's top lamp (5 instances).
- `emitter_container_rust` — atlas_cell 1 (smoke puff), emit_rate
  0.3, lifetime 6. Parked above 3–4 weathered containers.
- `emitter_freighter_smoke` — atlas_cell 1, emit_rate 1.5, lifetime
  8, gravity 0.5 (rising). Parked at the freighter's funnel — the
  ship is still smoking, faintly.
- `emitter_explosion` — required.

**Audio:**

```json
"audio": {
  "music": "marina-bay-industrial-techno.opus",
  "ambient": ["crane-creak.opus", "harbor-low-hum.opus", "metal-clang.opus"],
  "ambientGains": [0.4, 0.5, 0.3],
  "music3dEffects": { "duckOnPump": 0.25 }
}
```

> Implement `crane-creak.opus` as a 3D-positioned ambient under
> each crane mesh (if/when 3D ambient audio lands; for now use
> single layer).

**Hero camera:** Looking down a container chicane toward the
Gauntlet with one crane's load mid-swing in frame, sodium-yellow
lamp glare bouncing off wet steel, freighter hull silhouette in
the back. 35 mm lens, level horizon.

---

### 2.7 Doge's Drift (Continental Cup #2 — was #3)

**Identity** — Cup: Continental · Lap: 60 s · Laps: 3 · Total: ~3:00 ·
Water/Land: 70/30 · Anti-grav: medium (Campanile climb, ~10 s) ·
Difficulty: mid

**Topology & reference** — Loop with arch tunnel + vertical column
climb. Reference: **MK8 Shy Guy Falls** (column climb) + **Wave
Race 64 Twilight City** (urban canal racing pattern) + **Marine
Fortress** (clearance-critical tunnel).

**Beat structure:**

| t (s) | Beat | Description |
|---|---|---|
| 0–12 | Doge's Palace facade | Open-water straight past the half-submerged Doge's Palace, lion columns visible |
| 12–22 | **Rialto tunnel** | Through the partially-collapsed Rialto Bridge arch as a low-clearance tunnel. Walls damage on contact. |
| 22–34 | Murano furnace stretch | Past the glassblower-furnace rooftop islands; jet of warm orange light, brief mid-lap calm |
| 34–48 | **Campanile Climb (set-piece)** | Anti-grav up the brick shaft, exit through the open arched belfry with St. Mark's domes below |
| 48–60 | Descent + finish straight | Long glide down past the basilica back to start |

**Set-piece staging:** Campanile is **visible from the start grid**
— it's the tallest structure in flooded Venice. The bell occasionally
visible swinging through the open belfry arches even before you
approach. Plays at 57–80% — late in the lap, in the hardest-section
slot. The descent after (48–60) is the lap's recovery exhale (Cloudtop
Cruise pattern).

**Hard section:** 34–48 s (Campanile Climb). Skill: **maintaining
anti-grav line in a narrow shaft + timing the belfry exit window
around the swinging bell.** On Hard, the bell is in the exit window
for ~0.4 s of every 3 s — clip it, total spin.

**Branching:**

- **Rialto tunnel center vs side** (12–22 beat): the center has
  more vertical clearance but no boost pad; the sides are tighter
  but have boost pads on each.
- **Around the Campanile vs through it** (34–48): you can skip the
  anti-grav climb and circle the base. Slower by ~4 s.

**Per-lap:** **Bell swing phase persists across laps** — once you've
learned the timing on lap 1, lap 2 is a known quantity. (The bell
*reads as a hazard* lap 1, *as a metronome* by lap 3.) Hard
difficulty randomizes phase per race.

**Blender shopping list:**

- **Doge's Palace facade** — `kind=track` hand-modeled mesh of
  the iconic arched colonnade, lower half submerged. ~50 m
  building width.
- **Lion columns** — two `kind=decoration` Venetian lion-column
  meshes poking above water in Piazza San Marco.
- **Rialto Bridge arch** — single `kind=track` mesh; the bridge's
  central arch is the tunnel. Walls have collision; ceiling
  clearance is ~6 m (use the **Tunnel tool**: `tunnel_curve_main`
  + Build Tunnel, radius 4, wall 1, end_extend 6).
- **Campanile** — single tall `kind=track` cylindrical mesh, ~95 m
  tall, square cross-section (~12 m × 12 m). Brick texture.
  Belfry as `kind=track` arched-opening structure at top.
- **Bell** — `kind=track` mesh inside the belfry; runtime-animated
  swing via glTF animation channel (analogous to Marina Bay 7
  crane loads).
- **St. Mark's basilica domes** — `kind=decoration` cluster of
  Byzantine dome meshes below the Campanile, visible from the
  belfry exit.
- **Murano furnace rooftops** — 3 small `kind=track` plinth meshes
  with glowing furnace decoration meshes on top.
- 1 × `antigrav_curve_NN` — **Tube** profile, radius 5 m, ~80 m
  vertical run up the Campanile shaft. Tube exits horizontally
  through the belfry arch (rotate the final CP's tangent).
- `road_curve_main` — none.
- `ai_spline_main` — 22 CPs.
- `cp_00`..`cp_07` — 8 checkpoints.
- 3 × `boost_NN`:
  - On the Doge's Palace facade straight
  - At the top of the Campanile climb (rewards committing)
  - On the descent / finish straight
- `start_00`, `start_01` — at t≈0.96.
- 3 × `pickup_*` — one per major beat (Rialto, Murano, Campanile).
- 1 × `wave_zone_NN`:
  - `wave_zone_lagoon`: covers the full Venice lagoon. halfWidth
    100, halfDepth 100, heightMult 0.7, freqMult 1.2, blendRadius
    30. Calm Adriatic; no surge.
- **Horizon ring:** **bespoke authored.** Pull the Dolomites
  silhouette into the back-north (Venice's actual far horizon).

**Sky preset:** `venice_warm`. `cloudiness=0.3`, `sunIntensity=1.0`,
`fogNear=200`, `fogFar=750`, `timeOfDay=270` (mid-afternoon — Venetian
light is warmest then), `seaStateBeaufort=2`.

**Wave zones:** (see Blender shopping list above)

**Particle emitters:**

- `emitter_murano_furnace_*` — atlas_cell 2 (ember), emit_rate 6,
  lifetime 1.5, gravity 1 (rising), color_start warm-orange.
  Parked at each Murano rooftop (3 instances).
- `emitter_bell_ripple` — atlas_cell 10 (glow halo), emit_rate 0,
  lifetime 2. Triggered via `triggerBurst` on every bell-swing
  apex from sim code.
- `emitter_basilica_dust` — atlas_cell 4 (dust mote), emit_rate 0.5,
  lifetime 8, gravity 0. Parked above the basilica domes.
- `emitter_palace_moss` — atlas_cell 4, emit_rate 1, lifetime 6,
  gravity -0.5 (slow falling). Parked along the waterline of the
  Doge's Palace facade. Implies algae and waterborne decay.
- `emitter_explosion` — required.

**Audio:**

```json
"audio": {
  "music": "doges-vivaldi-broken-beat.opus",
  "ambient": ["water-lapping.opus", "distant-church-bell.opus", "gulls.opus"],
  "ambientGains": [0.6, 0.3, 0.4],
  "music3dEffects": { "duckOnPump": 0.30 }
}
```

> The music should contain a baroque-strings motif that swells on
> the Campanile climb (t=34–48 of the loop). Bell hit SFX is
> separate from `distant-church-bell.opus` — that ambient is the
> "every minute" toll; the *swinging bell hazard* triggers a louder
> 3D-positional bell SFX.

**Hero camera:** Eye-level looking up at the Campanile with the
anti-grav corkscrew tube visible wrapping the brick shaft, belfry
arches with bell mid-swing at top of frame, basilica domes in
foreground at base, warm Venetian light. 35 mm lens.

---

### 2.8 Kilauea Crown (Continental Cup #3 — single-lap descent)

**Identity** — Cup: Continental · **1 lap × ~2:30 total** ·
Water/Land: 50/50 · Anti-grav: heavy (caldera rim, ~30 s) ·
Difficulty: mid (cup spectacle closer)

> **Major refinement from track-themes.md:** Format changed from
> 3 × 65 s loop to **single-lap point-to-point descent**. Mount
> Wario reference. See §1.1 for rationale.

**Topology & reference** — Single-lap point-to-point descent.
Reference: **MK8 Mount Wario** (3-section descent, naturally
escalating, single-lap epic).

**Beat structure (3 sections, no laps):**

| t (s) | Section | Description |
|---|---|---|
| 0–45 | **Section 1 — Windward climb** | Start at sea level on a black-sand beach on the windward side. Climb through old lava fields, sparse rainforest. Boost-pads on the steepest pitches. Open to the wind. |
| 45–105 | **Section 2 — Caldera rim (anti-grav)** | Wall-rides on the inside of the caldera bowl (banked anti-grav strip). Lava lake visible 200 m below; heat haze on the air. Continuous anti-grav for ~60 s. |
| 105–150 | **Section 3 — Leeward descent + Black Beach (set-piece)** | Steep descent on a single rideable ridge. Final 30 s: ride *alongside* the lava waterfall pouring into the new sea. Finish line at the black-sand beach. |

**Set-piece staging:** The volcano is **visible from the start
grid** dominating the skyline — you can see it the whole way up.
The lava waterfall isn't visible until ~95 s in (caldera rim
section's east face exposes it). The Black Beach finish lands at
~135 s, sea-level, immediate-after-waterfall.

**Hard section:** 60–95 s (mid-caldera rim, after the entry's
adrenaline rush and before the descent's payoff). Skill:
**holding banked anti-grav line under continuous lateral g-force**
with the lava lake as the failure consequence.

**Branching:**

- **Windward climb left ridge vs right ridge** (0–45): two roughly
  equivalent paths up; ridge choice is line/scenery preference.
- **Caldera rim inside vs outside path** (45–105): inside is faster
  (steeper bank), outside is safer.
- **Leeward descent waterfall side vs back side** (105–150):
  waterfall side has the visual spectacle but the heat-haze
  obscures view; back side is faster but skips the set-piece.
  **Pros take waterfall side every time** — the time penalty is
  ~1.5 s and the set-piece is the whole point.

**Per-lap:** **No laps.** This is the per-lap differentiation —
the entire format is the differentiation.

**Blender shopping list:**

- **`terrain_island`** via *Add Island Terrain* — one tall central
  peak with crater. Base radius 800 m, top height 600 m. Crater
  flag on. Then **manually flatten** the caldera rim into a
  drivable banked bowl (use *Apply Terrain Modifiers* then sculpt).
- **Old lava field meshes** — `kind=track` flat shelf meshes
  scattered across the windward slope. Provide the actual drivable
  road surface; the procedural terrain provides the backdrop
  silhouette.
- `road_curve_main` — **two** road curves (one per ridge) on the
  windward climb. *Build Road*, width 12, slab 0.8, blend 8.
  Snap to terrain.
- **Lava waterfall** — single `kind=track` mesh forming the ridge
  the bike rides alongside; the lava itself is `kind=decoration`
  (orange-emissive surface) with a heat-haze emitter. The flowing
  lava is shader-animated (panning UV).
- **Black Beach finish** — flat `kind=track` plinth at sea level
  on the leeward base.
- 1 × `antigrav_curve_NN` — **Banked strip** profile, width 14 m,
  thickness 0.5. Author the curve as a full circle following the
  caldera rim. Use *Anti-Grav preset operators* to set each CP
  to Bank L at the appropriate tilt — caldera bowl walls are
  ~70° from horizontal, so tilt ≈ -1.2 rad on every CP.
- `ai_spline_main` — 36 CPs (this is a longer track — more CPs
  for spline smoothness on the long climb + caldera).
- `cp_00`..`cp_11` — 12 checkpoints. **No lap-closing CP** —
  the finish line is `cp_11` and the race ends. The runtime needs
  a `singleLap: true` flag on this track's JSON (flag for impl
  Claude: add this if not already supported, or model the track
  as 1 lap with `cp_last` as the finish).
- `start_00`..`start_07` — full 8-bike grid on the Black Beach...
  wait, the start is at the sea-level windward beach (the climb
  starts here). Grid all 8 starts at the windward beach.
- 5 × `boost_NN`:
  - Windward steep pitch 1 (40% of climb)
  - Windward steep pitch 2 (80% of climb)
  - Caldera rim entry (rewards committing)
  - Caldera rim mid (sustains the wall-ride speed)
  - Leeward waterfall-side descent (rewards the spectacle line)
- 4 × `pickup_*` — one per major section + one at the rim entry.
- 1 × `wave_zone_NN`:
  - `wave_zone_pacific_open`: ocean surrounding the island.
    halfWidth 400, halfDepth 400, heightMult 1.4, freqMult 0.9,
    blendRadius 50. (The bike only touches this at the very
    start and very end, but the *visible* ocean from the climb
    needs to look right.)
- `scatter_palms` — sparse, only at sea level (~20 instances,
  windward beach).
- `scatter_rocks` — heavy on the windward slope (~80 instances of
  `prop_rock` with darker tint).
- **Horizon ring:** **bespoke authored.** From the caldera rim
  you can see far — author Maui silhouette to the north, Mauna
  Kea to the west.

**Sky preset:** `kilauea_volcanic`. `cloudiness=0.4` (volcanic
plume bias), `sunIntensity=1.0`, `fogNear=150`, `fogFar=900`,
`timeOfDay=210` (mid-afternoon — lava reads orange against blue
sky), `seaStateBeaufort=4`.

**Wave zones:** (see Blender shopping list above)

**Particle emitters:**

- `emitter_lava_waterfall_*` — atlas_cell 2 (ember) at high rate
  (~20/s, lifetime 2, gravity 4 — falling), plus atlas_cell 1
  (smoke puff) at higher rate where the lava hits the ocean
  (steam explosion, gravity -2). Multiple emitter empties along
  the waterfall length (5+).
- `emitter_caldera_haze` — atlas_cell 4, emit_rate 8, lifetime 6,
  parked above the caldera. Heat shimmer.
- `emitter_ash_drift` — atlas_cell 8 (ash), emit_rate 4, lifetime
  10, gravity -0.2 (slow falling). Scattered across upper slopes.
- `emitter_steam_explosion` — atlas_cell 1, parked at the lava-
  meets-ocean point. Triggered burst on every "big steam blast"
  beat from sim audio cue (use the runtime music timing if
  possible to sync visual + audio).
- `emitter_explosion` — required.

**Audio:**

```json
"audio": {
  "music": "kilauea-tribal-synth-subbass.opus",
  "ambient": ["volcano-rumble.opus", "wind-high.opus", "lava-bubble.opus"],
  "ambientGains": [0.5, 0.4, 0.3],
  "music3dEffects": { "duckOnPump": 0.35 }
}
```

> Music should be ~2:45 in length (matches single-lap duration with
> finish-line cushion) and should have a clear **Section 3
> crescendo** at t≈2:00 of the track — the music payoff aligned
> with the lava-waterfall set-piece.

**Hero camera:** Mid-elevation on the leeward slope, looking down
the waterfall ridge toward the Black Beach finish line, lava flow
diagonal across frame, steam plume in middle distance, deep ocean
behind. 50 mm lens, dramatic golden lighting on the lava + cool
shadow on the ocean.

---

### 2.9 Aqualand (Drowned Cup #1)

**Identity** — Cup: Drowned · Lap: 22 s · Laps: 5 · Total: ~1:50 ·
Water/Land: 75/25 · Anti-grav: light (one bowl wall, escalates to
mandatory on lap 3+) · Difficulty: chaos

**Topology & reference** — Short loop, multi-lap chaos arena, with
**per-lap escalating surge**. Reference: **Sonic Transformed
Adder's Lair** (destructible-per-lap layout) + **MK Baby Park**
(chaos format).

**Beat structure (per lap, ~22 s):**

| t (s) | Beat | Description |
|---|---|---|
| 0–6 | Lazy river opener | Race down the still-running lazy-river current; tight curves through fiberglass tube tunnels |
| 6–11 | **Wave-pool tsunami zone (set-piece)** | The wave pool. Surge amplitude is the lap-dependent hazard. |
| 11–17 | Half-pipe slide | Drop down a half-pipe water-slide structure; brief drop-induced speed |
| 17–22 | Main concourse → back to start | Past the old lifeguard tower with the digital countdown; back to start |

**Set-piece staging:** The wave pool's tsunami structure is
**visible from the start grid** with the lifeguard tower's countdown
sign actively displaying the next surge's ETA. Plays at 27–50% of
lap distance per lap (every lap).

**Hard section:** 6–11 s (wave pool). Skill changes per lap:
- Lap 1: line through the low concourse around the wave pool.
- Lap 2: timing the lower-path entry to avoid splash damage.
- Lap 3+: **wall-riding the bowl rim** as the lower path is
  unusable.

**Branching:**

- **Lower concourse vs upper bowl wall** (6–11 beat): lower is
  faster but lap-dependent on safety. Upper is the safe route.
- The half-pipe slide can be entered at the top (drop) or
  bypassed via the concourse edge.

**Per-lap (the big one):**

| Lap | Tsunami amplitude | Lower concourse | AI behavior |
|---|---|---|---|
| 1 | 1.5 m | Open; splash hazards only | AI takes lower |
| 2 | 3.0 m | Partly flooded; damage on water contact | AI takes mixed |
| 3 | 5.0 m | Washed out mid-lap; upper bowl wall mandatory | AI takes upper |
| 4 | 5.0 m | Same as lap 3 | AI takes upper |
| 5 | 5.0 m | Same as lap 3 (chaos peak) | AI takes upper |

**Implementation:** Drive the `wave_zone_tsunami`'s `surge_amplitude`
from the current lap counter. The sim layer reads lap from the
race state machine; the wave-field's `sampleZoneFactors` already
respects per-zone surge — just expose `surge_amplitude` as a
runtime-mutable field instead of load-time-only. Flag for impl
Claude: this is a new runtime hook; if it's not already supported,
the simplest version is a discrete per-lap surge value array on
the wave zone (`surge_amplitude_per_lap: [1.5, 3.0, 5.0, 5.0, 5.0]`).

**Blender shopping list:**

- **Lazy river tube** — `kind=track` curved tube (use the **Tunnel
  tool**: `tunnel_curve_main`, radius 5, wall 0.5, end_extend 3 —
  draw the curve as a U-shape forming the lazy river footprint).
- **Wave pool** — large rectangular `kind=track` plinth at sea
  level forming the pool bowl. Pool walls as 4 surrounding
  `kind=track` walls, ~3 m tall.
- **Half-pipe water slide** — single curved `kind=track` mesh,
  ~20 m long, ~6 m drop. Smooth interior.
- **Lifeguard tower** — `kind=decoration` mesh with a small
  emissive plane for the digital countdown sign (animated UV in
  the shader for the actual count).
- **Locker rooms + snack bar** — small decoration meshes scattered
  around the concourse for atmosphere.
- 1 × `antigrav_curve_NN` — **Banked strip** profile, width 8,
  thickness 0.3. Author as a half-arc around the wave-pool's upper
  rim. Tilt = -π/2 (full wall). Only used lap 3+ on the racing
  line but always present.
- `road_curve_main` — **concourse loop** road curve. Width 6 m,
  slab 0.4, blend 4. Snap to terrain (where the pool bowl
  geometry is).
- `ai_spline_main` — **two splines** here would be ideal (one for
  lap 1–2, one for lap 3+) but the runtime supports only `main`.
  Compromise: spline takes the upper bowl path (safer line) every
  lap; the AI looks "smart" by not getting destroyed on lap 3+,
  but loses lap-1 speed to compensate. AI difficulty toggle
  controls how often AI takes the (manually-marked) lower-path
  branch on early laps.
- `cp_00`..`cp_04` — 5 checkpoints per lap (track is short).
- 4 × `boost_NN`:
  - Lazy river entrance (rhythm)
  - Wave pool exit (rewards survival)
  - Half-pipe bottom (rewards the drop commitment)
  - Concourse straight (chaos catch-up boost)
- `start_00`..`start_07` — 8-bike grid on the concourse start
  line, tight spacing (~3 m apart) for chaos.
- 1 × `pickup_*` placed densely — **3 pickups** spread (chaos arena
  pickup rate should be higher than other tracks).
- 1 × `wave_zone_NN`:
  - `wave_zone_tsunami`: covers the wave pool only. halfWidth 25,
    halfDepth 15, heightMult 1.5, freqMult 1.2, blendRadius 8.
    **`surge_period_s=22`** (one surge per lap), **`surge_amplitude`
    driven per-lap** as above (initial value 1.5).
- `scatter_palms` — faded sun-bleached palms (~10 instances) on
  the concourse periphery.
- **Horizon ring:** procedural fallback — Florida horizon is empty.

**Sky preset:** `miami_pastel` (faded version). `cloudiness=0.3`,
`sunIntensity=1.2`, `fogNear=120`, `fogFar=500`, `timeOfDay=240`
(late afternoon), `seaStateBeaufort=2`.

**Wave zones:** (see Blender shopping list above)

**Particle emitters:**

- `emitter_pool_chlorine` — atlas_cell 4 (dust mote), emit_rate 0.3,
  lifetime 12, parked above the wave pool. Implies (decayed) pool
  chemistry.
- `emitter_tsunami_spray` — atlas_cell 3 (foam droplet) + atlas_cell
  9 (water spray) in two emitter empties at the wave pool's bowl
  rim. **Burst-triggered every surge crest** via sim hook.
- `emitter_palm_decay` — atlas_cell 6 (leaf), emit_rate 0.5,
  lifetime 8, gravity -1. Parked at each palm.
- `emitter_explosion` — required.

**Audio:**

```json
"audio": {
  "music": "aqualand-trashy-edm.opus",
  "ambient": ["pool-pump.opus", "pa-system-loop.opus", "water-lapping.opus"],
  "ambientGains": [0.4, 0.3, 0.5],
  "music3dEffects": { "duckOnPump": 0.25 }
}
```

> `pa-system-loop.opus` is the diegetic PA cycling abandoned
> snack-bar ads — author this as ~30 seconds of garbled muzak +
> intermittent voice clips ("two-for-one churros at the Snack
> Shack"). Atmosphere is the whole identity here.

**Hero camera:** Mid-elevation looking down across the wave pool
toward the half-pipe and concourse, faded primary colors, sun-
bleached palm in the foreground, lifeguard tower countdown sign
visible in the back. 35 mm lens.

---

### 2.10 Angkor Drowned (Drowned Cup #2)

**Identity** — Cup: Drowned · Lap: 62 s · Laps: 3 · Total: ~3:06 ·
Water/Land: 65/35 · Anti-grav: heavy (central spire climb, ~15 s) ·
Difficulty: late-mid

**Topology & reference** — Loop with vertical spire climb and
high-risk root tunnel. Reference: **MK8 Cloudtop Cruise** (canopy
"weather window" feel) + **Dragon Driftway** (environment-as-track
verticality) + **Marine Fortress** (root tunnel as one-shot-kill
shortcut).

**Beat structure:**

| t (s) | Beat | Description |
|---|---|---|
| 0–14 | **Bayon faces straight (set-piece)** | Past 16 of Bayon's smiling-face towers in sequence on the opening straight. Wide approach, low chop. |
| 14–28 | Ta Prohm root weave | Strangler-fig roots arch across the path; tight chicane line through living wood. Hidden root-tunnel shortcut. |
| 28–40 | Inner courtyards | Flooded inner court of Angkor Wat; bisected path around the central pond. Visual breather. |
| 40–55 | **Central spire climb** | Anti-grav corkscrew up the central spire of Angkor Wat. Music swells. |
| 55–62 | Descent + finish straight | Long glide down the outer staircase back to the Bayon approach. |

**Set-piece staging:** Bayon's smiling faces are **visible from
the start grid** — you race past sixteen of them in the first
14 seconds. This is the unusual case where the set-piece is at
0–22% of lap distance, not 55–75%. Justified because the **central
spire climb** at 65–89% is the *secondary* skill apex in the
hardest-section slot; the Bayon faces are the *emotional* anchor
that frames the whole lap.

**Hard section:** 40–55 s (central spire climb). Skill: **maintaining
anti-grav line on a corkscrew while jungle canopy occludes
visibility intermittently.**

**Branching:**

- **Root tunnel shortcut** (14–28 beat): a tight tunnel through
  the strangler-fig roots. Saves ~3 s; one-shot-kill walls (roots
  with collision). This is the v1 set's secondary high-risk
  expert line (after Cape Town's skylight).
- **Around the pond left vs right** (28–40): cosmetic line choice
  with marginal time differences.

**Per-lap:**
- **Lap 1:** Birds startle and burst from the Bayon faces as you
  pass — `triggerBurst('emitter_birds_startle', 40)`.
- **Lap 2–3:** No bird bursts (the flock has fled).

(Small but legible visual differentiation; cheap to implement.)

**Blender shopping list:**

- **Bayon face towers** — author 4 large `kind=track` tower meshes
  (each with 4 faces on its sides). Place along the opening
  straight so the bike passes 16 faces total on the way through.
- **Ta Prohm root arches** — 5 large `kind=track` arched-root
  meshes spanning the path. Form a natural chicane.
- **Angkor Wat central spire** — single tall `kind=track` mesh
  (~75 m tall, 4-sided stepped pyramid silhouette). This is the
  vertical-column slot.
- **Inner courtyards** — flat `kind=track` plinth meshes (the
  flooded inner court floors).
- 1 × `antigrav_curve_NN` — **Tube** profile, radius 6, ~85 m
  vertical run wrapping the spire 1.25× turns. Exit on the
  north-facing side at the top for the descent line.
- 1 × `tunnel_curve_main` — **the root tunnel** via the Tunnel
  tool. Curve threading through the strangler-fig roots. Radius
  3.5 (tight!), wall 0.8, end_extend 2.
- `road_curve_main` — short slab section on the descent finish
  straight. Width 10, slab 0.6, blend 6.
- `ai_spline_main` — 26 CPs. AI takes the *long* path around the
  pond and the *outside* spire approach (safe lines).
- `cp_00`..`cp_09` — 10 checkpoints.
- 3 × `boost_NN`:
  - Mid Bayon-faces straight (rhythm)
  - Top of spire climb (rewards committing)
  - Descent / finish straight
- `start_00`..`start_07` — 8-bike grid on the Bayon-approach
  straight.
- 3 × `pickup_*` — one per beat (Bayon, root weave, spire).
- 2 × `wave_zone_NN`:
  - `wave_zone_outer_moat`: covers the outer moat. halfWidth 60,
    halfDepth 60, heightMult 0.4, freqMult 1.2, blendRadius 20.
    Calm inland water; minor chop.
  - `wave_zone_inner_court`: smaller zone in the central pond.
    halfWidth 20, halfDepth 20, heightMult 0.2, blendRadius 8.
    Near-glass.
- `scatter_palms` — sparse, primarily on the temple periphery
  (~25 instances).
- `scatter_rocks` — heavy mossy-stone rubble (~60 instances of
  `prop_rock` with mossy-green tint).
- **Horizon ring:** **bespoke authored.** Jungle silhouette
  (low-density layered tree-line shape) wrapping the back third.
  Mount Phnom Bok visible in distance.

**Sky preset:** `angkor_jungle` *(new preset — see §1.5)*.
`cloudiness=0.4` (dappled canopy bias), `sunIntensity=0.85` (forest
filtered), `fogNear=80` (jungle haze close-in), `fogFar=550`,
`timeOfDay=180` (midday — sunlight through canopy), `seaStateBeaufort=2`.

**Wave zones:** (see Blender shopping list above)

**Particle emitters:**

- `emitter_jungle_motes` — atlas_cell 4 (dust mote), emit_rate 4,
  lifetime 12, gravity -0.1, parked at 3+ locations across the
  jungle areas. Sun-through-canopy haze is 50% of the visual
  identity.
- `emitter_birds_startle` — atlas_cell 5 (gull silhouette, reuse
  for now), emit_rate 0, lifetime 5, max_particles 40. Parked at
  the Bayon approach. **Lap-1 burst-triggered** (see per-lap above).
- `emitter_temple_dust` — atlas_cell 4, emit_rate 0.5, lifetime 6,
  gravity -0.3, parked at the spire base. Ancient-stone weathering.
- `emitter_explosion` — required.

**Audio:**

```json
"audio": {
  "music": "angkor-gamelan-electronic.opus",
  "ambient": ["jungle-cicadas.opus", "water-lapping.opus", "monkey-distant.opus"],
  "ambientGains": [0.5, 0.4, 0.2],
  "music3dEffects": { "duckOnPump": 0.30 }
}
```

> Music should have a **gentle pulse build** that crescendos on the
> spire climb (t=40–55 of the loop). Khmer xylophone over electronic
> breaks.

**Hero camera:** Eye-level looking down the Bayon-faces opening
straight with multiple smiling faces visible left and right,
dappled sunlight through canopy gaps, the central spire visible
in middle distance, monkey silhouette decoration in a tree
branch in foreground. 35 mm lens.

---

### 2.11 Liberty Drowned (Drowned Cup #3 — FINALE)

**Identity** — Cup: Drowned · Lap: 70 s · Laps: 3 · Total: ~3:30 ·
Water/Land: 80/20 · Anti-grav: heavy (torch arm + crown interior,
~25 s) · Difficulty: finale

**Topology & reference** — 3-section loop with the v1 set's
**Möbius-equivalent set-piece** (torch arm underside ride).
Reference: **MK8 Big Blue** (3-section ribbon, vertical anti-grav
ribbon) + **MK8 Mario Circuit** (Möbius wow factor) + **MK World
Crown City** (multi-route via different harbor approaches per cup
entry — *deferred to v1.1, keep single layout for v1*).

**Beat structure:**

| t (s) | Beat | Description |
|---|---|---|
| 0–18 | **Manhattan harbor straight** | Open harbor pass with Trinity Church spire poking up, Charging Bull underwater, Brooklyn Bridge cables sagging. Skyline framing. |
| 18–35 | **Torch arm (set-piece — Möbius slot)** | Anti-grav up the underside of the broken torch arm. ~12 s of hands-on-handlebars vertigo; harbor visible *above* through Liberty's fingers. **The v1 postcard moment.** |
| 35–52 | **Crown interior** | Drop through Liberty's crown window, anti-grav loop *inside* the crown chamber, exit out a different window facing the next beat. |
| 52–70 | Descent + finish straight | Long descent past Liberty's submerged shoulder, across the harbor back to start grid. Sunset gold lighting. |

**Set-piece staging:** Liberty is **visible from the start grid**
dominating the skyline — half-submerged, torch arm collapsed
forward across the battlements. The torch arm itself becomes the
visual focus at t=12+. Set-piece plays at 26–50% of lap distance
(slightly early, like Shibuya — justified by being the postcard).
The crown interior at 50–74% is in the hardest-section slot.

**Hard section:** 35–52 s (crown interior). Skill: **anti-grav
loop inside an enclosed space with limited visibility and a
window-aligned exit window.** The exit window is the only way out;
miss it, you crash into the crown's interior wall.

**Branching:**

- **Three torch-arm approaches** (15–18 s into the set-piece):
  high approach (over the wrist), mid approach (through the
  fingers — fastest), low approach (under the elbow — safest).
  Light Crown City reference in miniature.
- **Brooklyn Bridge cable tightrope shortcut** (0–18 beat): a
  very narrow ribbon-anti-grav surface along one of the sagging
  cables. Saves ~5 s; one of the hardest expert lines in v1.
- **Crown exit window N vs S** (35–52): two windows exit toward
  different paths into the descent; N is slightly faster but
  drops you on a worse line for the finish straight.

**Per-lap:**
- **Lap 1:** First-time players get a subtle "look up" HUD
  prompt as they enter the torch arm beat (one-time tutorial cue
  for the postcard moment).
- **Lap 2–3:** No prompt. The view is yours.
- **Music** builds in three distinct tiers: lap 1 (opener), lap 2
  (build), lap 3 (climax). Coordinate with composer.

**Blender shopping list:**

- **Statue of Liberty** — single large hand-modeled `kind=track`
  mesh assembly (or a small set: torso + raised arm + head +
  collapsed-torch-arm). Torch arm is a *separate* `kind=track`
  mesh laid across Liberty Island's old battlements. Copper-green
  oxidation texture.
- **Liberty's crown** — `kind=track` hollow interior shell with
  window openings. The interior is the anti-grav loop chamber.
- **Manhattan rooftops** — use **`downtown_NN`** via *Add Downtown*
  with X=8, Y=8, Block 35, Street 6, Min h 30, Max h 70, Conform
  to terrain on. Place under the harbor as a submerged grid —
  building tops visible just under or at the water surface.
  (Charging Bull, Trinity spire as individual `kind=decoration`
  meshes poking through.)
- **Brooklyn Bridge** — two `kind=track` tower meshes + sagging
  cable meshes between them. The cables can be optionally
  `kind=track` (for the tightrope shortcut) — flag specific cables
  as `kind=track`, others as `kind=decoration`.
- 3 × `antigrav_curve_NN`:
  - **Torch arm underside** — **Ribbon** profile, width 14,
    thickness 0.3. The curve runs along the *underside* of the
    torch arm (sweep the ribbon hanging upside-down per the addon
    docs). ~80 m length.
  - **Crown interior loop** — **Tube** profile, radius 7. Curve
    forms a vertical loop inside the crown chamber.
  - **Brooklyn Bridge cable** — **Ribbon** profile, width 3
    (narrow!), thickness 0.2. ~150 m along one sagging cable.
- `road_curve_main` — short slab on the finish straight, width 12,
  slab 0.6, blend 8.
- `ai_spline_main` — 30 CPs. AI takes the mid-finger torch
  approach, the safer S crown window, no Brooklyn Bridge.
- `cp_00`..`cp_11` — 12 checkpoints.
- 4 × `boost_NN`:
  - Harbor straight (rhythm anchor)
  - Torch arm exit (rewards committing to the set-piece)
  - Crown exit (rewards finding the right window)
  - Finish straight (closer rhythm)
- `start_00`..`start_07` — 8-bike grid on the harbor straight,
  Liberty in mid-distance.
- 4 × `pickup_*` — one per major beat.
- 3 × `wave_zone_NN`:
  - `wave_zone_harbor_open`: covers the full NY harbor.
    halfWidth 200, halfDepth 200, heightMult 1.3, freqMult 1.0,
    blendRadius 40. direction_deg 180 (NYC south-southwest swell).
    **Surge: period_s=10, amplitude=1.5** for harbor swell pulses.
  - `wave_zone_battery_shallow`: by Liberty Island's submerged
    base. halfWidth 60, halfDepth 60, heightMult 0.8, blendRadius
    20. (Shallower water = shorter waves.)
  - `wave_zone_brooklyn_bridge`: under the bridge cables.
    halfWidth 50, halfDepth 20, heightMult 1.6, freqMult 0.8,
    blendRadius 15. Big swell here is what makes the cable
    tightrope feel risky.
- `scatter_rocks` — minimal; this is open water.
- **No palms.** No jungle scatter.
- **Horizon ring:** **bespoke authored.** Pull Manhattan skyline
  silhouette into the back (Empire State, Chrysler, etc.).
  Brooklyn skyline on the east-facing arc. This is critical —
  the finale's identity comes from the skyline behind it.

**Sky preset:** `nyc_sunset`. `cloudiness=0.35`, `sunIntensity=1.1`,
`fogNear=180`, `fogFar=900`, `timeOfDay=320` (sunset gold), 
`seaStateBeaufort=4`.

**Wave zones:** (see Blender shopping list above)

**Particle emitters:**

- `emitter_torch_flame` — atlas_cell 2 (ember), emit_rate 30,
  lifetime 1.5, gravity 1 (rising), color_start orange-yellow,
  parked at the torch flame at the end of the arm. The flame is
  *still lit*.
- `emitter_oxidation_shimmer` — atlas_cell 10 (glow halo),
  emit_rate 1, lifetime 8, parked at 4+ locations on Liberty's
  copper surfaces. Subtle.
- `emitter_harbor_spray` — atlas_cell 9 (water spray), emit_rate
  8, lifetime 2, gravity -1, parked at 3 locations across the
  harbor straight.
- `emitter_crown_dust` — atlas_cell 4, emit_rate 2, lifetime 6,
  parked inside the crown chamber. Implies the interior is rarely
  visited.
- `emitter_bridge_cable_drip` — atlas_cell 3 (foam droplet),
  emit_rate 0.5, lifetime 3, gravity -3, parked above the bridge
  cables. Implies the cables drip seawater.
- `emitter_explosion` — required.

**Audio:**

```json
"audio": {
  "music": "liberty-hiphop-orchestral.opus",
  "ambient": ["harbor-creak.opus", "wind-mid.opus", "distant-traffic-decay.opus"],
  "ambientGains": [0.5, 0.4, 0.2],
  "music3dEffects": { "duckOnPump": 0.40 }
}
```

> Music structure: **3-tier build** matching lap structure. Lap 1
> establishes (mid-tempo hip-hop + horns). Lap 2 builds (full
> orchestra layered). Lap 3 climaxes (choral swell + heavy 808s)
> with the loudest moment on the torch arm beat. The finale should
> *land*.

**Hero camera:** Mid-elevation, looking up at the torch arm with
the underside anti-grav ribbon visible curving along it, copper-
green oxidation prominent, Liberty's hand and fingers framing the
shot, sunset sky filling the upper third, harbor visible at
bottom. 35 mm lens. **This is the postcard frame for the entire
game's marketing** — author it like a movie poster.

---

### 2.12 Golden Gate Drowned (Continental Cup — NEW; terrain verticality, no anti-grav)

> **New track** added 2026-05-29. The first track to deliver verticality
> through **terrain** (hills + a street-to-bay drop) instead of anti-grav,
> per the project decision to retire anti-grav from races. Final cup
> ordering / renumber lands in the anti-grav reconciliation pass; spec'd
> here as a mid-difficulty Continental spectacle.

**Identity** — Cup: Continental · Lap: 58 s · Laps: 3 · Total: ~2:54 ·
Water/Land: 55/45 · Anti-grav: **none** · Verticality: terrain (hills +
street-to-bay drop) · Difficulty: mid (spectacle).

**Topology & reference** — Loop alternating tight urban canyon ↔ open bay
↔ hill-surf, with a terrain cliff-drop finish. Reference: **Wave Race**
(the hills are authored and ridden as frozen swell) + **Jet Moto
Cliffdiver** (the lap-ending drop into water) + **MK8 urban tracks** (the
tight drowned-grid canyon). Design soul: *land as waves frozen in time* —
the hover physics treat a hill crest like a swell crest.

**Beat structure:**

| t (s) | Beat | Description |
|---|---|---|
| 0–14 | Open bay / drowned FiDi | Wide open water, gentle Beaufort-3 swell — pump rhythm. The drowned Financial District rises ahead: Salesforce Tower, Transamerica, generic FiDi towers standing in the bay. Fog state established here. |
| 14–28 | **Downtown canyon (tight)** | Thread the flooded skyscraper grid — narrow walled "street canals," tight technical line, clip the walls = damage. The bay pinches to an urban slot. |
| 28–44 | **The hills (frozen waves)** | Streets ramp up out of the water onto Nob/Russian Hill. Surf a run of 3–4 steep hill crests, catching air off each, the drowned city falling away below. The lap's hard-section apex. |
| 44–52 | **The Break (set-piece)** | Crest the steepest street; the road plunges straight down into the drowned bay. Big terrain drop + splashdown. Music swells on the crest. |
| 52–58 | Bay return | Low open-water run back to the start; Alcatraz and the Golden Gate silhouette in the fog. |

**Set-piece staging:** The downtown towers (dead ahead) and the Golden
Gate silhouette (NW horizon) are visible from the start grid. The Break
sits at ~80% of lap distance — the descent is the closer flourish; the
hard skill stretch is the hills + canyon that precede it (the hills span
~48–76%, inside the genre's 55–75% hard-section window). On lap 1 the
crest-and-plunge is fully telegraphed — you see the street end in open
water before you commit.

**Hard section:** 14–44 s (canyon + hills, ~24–76% of lap). Skills:
**threading the tight canyon line** under fog, then **carrying speed over
the hill crests without bottoming the troughs** — pumping the land the
way you pump swell. Over-commit a crest and you overshoot the next
trough; under-commit and you stall the climb.

**Branching:**
- **Canyon line (16–26 s):** an inside slot between two towers is shorter
  but tighter (clip risk); the outer flooded avenue is wider, +0.4 s.
- **Hill crest pump timing (28–44 s):** pumping each crest like a swell
  banks a 3–5% speed carry into The Break; coasting the crests is safe
  but slower.
- **The Break entry (44 s):** a steep direct plunge vs a shallower
  side-street descent (safer landing, ~0.5 s slower).

**Per-lap:** **Fog tide** — fog density swells and clears on a world timer
(not lap-keyed; same world-time read as the Maw's swell). One full
roll-in/clear cycle ≈ every ~18 s so each lap sees both states. Otherwise
constant per-lap (structural per-lap change is reserved; the fog flourish
carries the variation). Optional: survivor microgrid lights in the canyon
brighten as the fog thickens.

**Blender shopping list:**
- Terrain: **hill landmass** as the primary `kind=track` terrain —
  authored as a *frozen-swell heightfield* (displace a base plane with a
  swell-profile noise so the hills literally share the bay's waveform).
  Hills rise ~+40–70 m above sea level (z=0); the windward face ramps from
  the waterline so streets climb out of the bay. Bake biome/AO/path attrs
  (`kingtide.bake_terrain_attrs`).
- **Drowned street grid** worked into the terrain — flooded canyon floors
  at / just below z=0 between the downtown towers.
- **Downtown towers** as `kind=track` meshes standing in the bay:
  Salesforce Tower (tapered round top), Transamerica Pyramid
  (unmistakable silhouette), Coit Tower (on its hill), + 6–10 generic FiDi
  boxes. Lower floors capped below the waterline for perf. Shared
  `downtown_NN` instance kit where towers repeat.
- **Sutro Tower** + **Golden Gate Bridge** as distant silhouette meshes on
  / near the horizon ring (camera-locked) — not raced surfaces.
- **Alcatraz** as a low `kind=track` island in the bay (turn landmark).
- `ai_spline_main` — ~26 CPs; climbs the hills explicitly in 3D and drops
  through The Break.
- `cp_00`..`cp_08` — 9 checkpoints at beat boundaries (canyon entry,
  mid-canyon, hill base, each major crest, The Break, bay return). Each
  needs its `index` prop.
- **No `antigrav_curve_*` / `tunnel_curve_*`.** Verticality is terrain.
- 4 × `boost_NN`: open-bay rhythm anchor; canyon exit / hill base (rewards
  committing to the climb); top of the final crest (rewards the pump
  line); Break-exit splashdown (carries speed to the finish).
- `start_00`..`start_03` — at t≈0.96 on the spline (Continental grid).
- 3 × `pickup_*` — open bay, mid-canyon, hill approach.
- 3 × `wave_zone_NN`:
  - `wave_zone_bay_open`: full surrounding bay. halfWidth 120, halfDepth
    120, heightMult 1.0, freqMult 0.9, blendRadius 35, direction_deg 80
    (Pacific swell east-bound through the gate).
  - `wave_zone_downtown_lee`: the flooded canyon, sheltered by towers.
    halfWidth 40, halfDepth 40, heightMult 0.4, freqMult 1.2, blendRadius
    15.
  - `wave_zone_break_splash`: small zone at The Break's splashdown for a
    punchy landing wave. halfWidth 20, halfDepth 20, heightMult 1.3,
    blendRadius 10.
- `scatter_debris` — floating cars, kelp, dock wreckage along the canyon
  edges and shoals (height/biome-gated, `HV_Scatter*` modifier).
- `scatter_rooftop` — survivor microgrid clutter on the hill streets
  (warm-light props).

**Sky preset:** new `golden_gate_fog` grade (warm sun through cool marine
layer) — *or* reuse `cape_town_blue` with a warmer tint as the fallback.
`cloudiness=0.5`, `sunIntensity=0.8`, `timeOfDay=300` (late-afternoon
golden hour), `seaStateBeaufort=3` (gentle — the challenge is fog +
terrain, not swell). **Fog is animated** (the signature): oscillate
`fogNear` 150↔40 and `fogFar` 700↔250 on the ~18 s world timer. Needs the
runtime fog-tide hook (see §3.8); static heavy fog (`fogNear=70`,
`fogFar=350`) is the safe fallback if the hook slips.

**Wave zones:** (see Blender shopping list above)

**Particle emitters:**
- `emitter_fog_bank` — atlas_cell 1 (smoke/mist), emit_rate 8, lifetime 8,
  large soft sprites drifting east through the gate. The signature
  emitter; ~3 empties across the strait mouth. Ties to the fog tide.
- `emitter_bay_spray` — atlas_cell 9 (water spray), emit_rate 5, lifetime
  2, gravity -2, ~3 empties across the open bay + one at The Break
  splashdown.
- `emitter_canyon_steam` — atlas_cell 1, emit_rate 1, lifetime 4, parked
  at a survivor microgrid vent in the canyon (warm-lit).
- `emitter_gulls` — atlas_cell 5, emit_rate 0.5, max_particles 6.
- `emitter_explosion` — required.

**Audio:**

```json
"audio": {
  "music": "golden-gate-hyphy-foghorn.opus",
  "ambient": ["foghorn-distant.opus", "bay-swell.opus", "city-wind.opus"],
  "ambientGains": [0.4, 0.6, 0.4],
  "music3dEffects": { "duckOnPump": 0.35 }
}
```

**Hero camera:** Low, looking up the steepest street at the crest of The
Break, the road falling away into the drowned bay below, downtown
tower-tops and the Golden Gate silhouette through fog behind, warm sun
breaking the marine layer. 28 mm lens for the vertigo, slight downward
tilt at the crest to read the plunge.

---

## 3. Cross-cutting implementation rules

Picked up while writing the per-track specs; should be applied
across the v1 set.

### 3.1 Set-piece visibility checklist

Every v1 track must satisfy:

- [ ] Set-piece visible from start grid (or by t=4 s of lap 1).
- [ ] Set-piece visually telegraphed (light, particle, music, or
      framing) at least 2 s before the player arrives.
- [ ] Set-piece plays out in a defined section of the lap with
      clear entry and exit beats.
- [ ] Set-piece survives 3 laps without losing meaning (every
      track does because of pacing, not because the set-piece
      itself is dynamic; per-lap differentiation is bonus).

Add this checklist to the DoD convention in
[v1-work-breakdown.md](./v1-work-breakdown.md).

### 3.2 Music ↔ set-piece sync

Every track's music asset (`.opus`) should have:

- **A motif aligned to the set-piece beat** (a swell, a drop, a
  vocal hook). Coordinate timing with the lap target so the motif
  hits when the player reaches the set-piece on lap 1.
- **A 3-lap structure** when possible — lap 1 establishes, lap 2
  builds, lap 3 climaxes. Loops can fade between layers based on
  lap count if the composer supports it. (Liberty Drowned is the
  must-have for this; others are nice-to-have.)
- **Ducking via `music3dEffects.duckOnPump`** tuned per track:
  - High pump duck (0.40–0.50) for wave-mastery tracks (Maw,
    Hatteras, Liberty, Mayday Bay).
  - Standard (0.30–0.35) for mixed-skill tracks.
  - Low (0.20–0.25) for calm-water or chaos tracks (Cape Town,
    Aqualand, Marina Bay 7).

### 3.3 Wave zone authoring conventions

- **Every track has at least one `wave_zone_NN`.** Even calm-water
  tracks — a `heightMult: 0.2` zone reads as deliberate calm, not
  as broken physics.
- **Use 2–3 zones per track** to differentiate beats. Open-water
  beats get higher heightMult; sheltered/lee beats get lower.
- **Surge fields are reserved for the Maw, Hatteras, Aqualand, and
  Liberty.** Other tracks have constant amplitudes. (Surge is
  expensive both to author and to learn-as-player; restrict to
  tracks where the surge *is the point*.)
- **`direction_deg` should be set explicitly** on every track with
  a defining swell direction (Hatteras = 0 / north; Maw = 270 /
  west; Liberty = 180 / south-southwest; etc.). Default-inheriting
  the global bearing leaves tracks feeling generic.

### 3.4 Hero camera framing rules

Every track's `camera_hero` should:

- Frame the **set-piece** prominently — usually as 30–50% of the
  composition.
- Frame at least one **distant landmark silhouette** as horizon
  anchor — the silhouette is what makes the location identifiable
  in the loading-screen tile.
- Use **35 mm or 50 mm** lens (35 wider for postcard composition,
  50 for portrait/dramatic).
- Use the **track's sky preset's golden-hour-equivalent timeOfDay**
  (most are between 270–320 in the day cycle).
- Sit at **eye-level or slightly elevated** — never bird's-eye
  unless the track is genuinely viewed from above (none are).

### 3.5 Branching path conventions

- **AI follows the safe / outside line every time.** Pros take the
  inside / shortcut lines. This way, AI play feels competent but
  is *beatable through skill*, not just lucky items.
- **Mark expert lines diegetically** — a darker pool tile, a
  visible cable strand, a missing barrier. Not via UI markers.
- **One "high-risk one-shot-kill" shortcut per cup** is the right
  density. Currently:
  - Reef Cup: Cape Town aquarium skylight (one-shot-kill)
  - Open Sea Cup: none — Maw is the skill test itself
  - Continental Cup: Doge's Rialto arch (damage, not death)
  - Drowned Cup: Angkor root tunnel + Liberty Brooklyn cable
    (both one-shot-kill — the finale cup gets the highest density)

### 3.6 Per-lap differentiation budget

Most tracks should *not* have per-lap layout changes (it raises
testing surface significantly). Reserve to:

- **Aqualand:** mandatory (per-lap surge escalation is the track's
  identity).
- **Liberty Drowned:** music tier escalation (cheap; composer-side).
- **Angkor Drowned:** bird burst lap 1 only (cheap; one emitter
  trigger).
- **Hatteras Light:** lamp brightness escalates across laps (cheap;
  shader uniform).

All other tracks ship with constant per-lap behavior. The set-piece
itself does the work of feeling fresh on lap 3.

### 3.7 Sky preset additions needed before v1

Two new presets to add to `SKY_GRADE_TABLE` /  `SKY_COLOR_GRADES`:

1. **`singapore_industrial`** for Marina Bay 7 — warm container
   orange lift + steel-gray cool shadows + sodium-yellow tint.
2. **`angkor_jungle`** for Angkor Drowned — mossy-green tint,
   dappled-warmth bias, lower saturation, slightly raised fog at
   close range.

Implementation: add tint/saturation/contrast triples to both
`sky.ts` `SKY_GRADE_TABLE` and the addon's `SKY_COLOR_GRADES`
list. Single PR, no other gameplay touch.

### 3.8 Runtime hooks needed before v1

Three small runtime additions surfaced by these specs. Order by
ease of implementation:

1. **`surge_amplitude_per_lap` array on wave zones** — for
   Aqualand's per-lap escalation. Backwards-compatible
   (`surge_amplitude` scalar still works). Wave-field code reads
   the array if present and uses the current-lap index.
2. **Single-lap race mode** — for Kilauea Crown. Add `singleLap:
   true` to track JSON; race controller treats first finish-line
   cross as the end.
3. **Lap-keyed emitter bursts** — for Angkor birds, Liberty music
   tiers, Hatteras lamp brightness. Generic "on lap N start" hook
   that fires registered callbacks. Cheapest implementation: a
   `triggerOnLap` array in JSON pointing at emitter / shader /
   music actions.

Flag for impl Claude: these are the only new runtime features
required by the v1 track set. Everything else uses existing
machinery.

---

## 4. Per-track summary table

Use this as a reference when scheduling Blender authoring work.
"Stage" reflects *implementation order* — start with tracks that
exercise the most-shared geometry vocabulary, finish with the
heaviest set-pieces.

| Track | Stage | Topology | Reference | Anti-grav | Wave zones | Emitters | New runtime hook |
|---|---|---|---|---|---|---|---|
| Mayday Bay | 1 (template) | Loop simple | WR64 Sunny Beach | 1 brief tube | 1 | 2 | — |
| South Beach Sunken | 2 | Loop | WR64 Sunset Bay | none | 2 | 4 | — |
| Cape Town Drift | 3 | Loop + tunnel | WR64 Drake Lake | none | 2 | 4 | — |
| Hatteras Light | 4 | Loop + column | MK8 Shy Guy Falls / Cliffdiver | 1 tube | 2 (surge) | 5 | lap-keyed lamp shader |
| The Maw | 5 | Open arena | WR64 Glacier Coast | none | 3 (surge) | 4 | — |
| Marina Bay 7 | 6 | Loop + hazard timing | WR64 Marine Fortress | none | 1 | 4 | swinging crane animation |
| Doge's Drift | 7 | Loop + tunnel + column | MK8 Shy Guy Falls + WR64 Twilight City | 1 tube | 1 | 5 | swinging bell animation |
| Shibuya Submerged | 8 | Loop + wall + branching | MK8 Cloudtop + MKW ? Block Ruins | 1 banked-strip | 2 | 5 | — |
| Angkor Drowned | 9 | Loop + column + risky tunnel | MK8 Cloudtop + Dragon Driftway + Marine Fortress | 1 tube | 2 | 4 | lap-1 bird burst |
| Aqualand | 10 | Short loop + per-lap surge | Adder's Lair + Baby Park | 1 banked-strip | 1 (per-lap surge) | 4 | per-lap surge array |
| Kilauea Crown | 11 | Single-lap descent | MK8 Mount Wario | 1 long banked-strip | 1 | 5 | single-lap race mode |
| Liberty Drowned | 12 (finale) | Loop + Möbius + column + chained AG | MK8 Big Blue + Mario Circuit + MKW Crown City | 3 (ribbon + tube + ribbon) | 3 (surge) | 6 | lap-keyed music tiers |

**Total new runtime hooks:** 4 small features (cranes / bell are
the same hook — glTF animation channel passthrough; the others
are the three from §3.8). Implementation is small relative to the
content payoff.

## References

- [track-themes.md](./track-themes.md) — content bible: lore,
  palette, set-piece names.
- [../research/track-flow-analysis.md](../research/track-flow-analysis.md)
  — per-track flow analysis the refinements in §1 come from.
- [blender-pipeline-guide.md](./blender-pipeline-guide.md) —
  authoring vocabulary; every object kind / addon panel / preset
  name in this doc is sourced from here.
- [vertex-attribute-spec.md](./vertex-attribute-spec.md) — vertex
  channel contract for terrain shaders.
- [design-targets.md](./design-targets.md) — numeric targets these
  tracks fulfill.
- [v1-work-breakdown.md](./v1-work-breakdown.md) — definition-of-
  done convention; add the set-piece checklist (§3.1) here.
