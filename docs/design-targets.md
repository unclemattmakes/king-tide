# Hoverbike — Design Targets v0.1

> Synthesizes the [research/](../research/) findings against the locked
> vision in [product-plan.md](./product-plan.md) and the current
> [status.md](./status.md) (MVP feature-complete, in M10.x multiplayer
> milestones). Concrete numeric targets and prioritized work for the
> next push toward a public-launchable v1.
>
> **Locked decisions** (from product-plan + this round of strategy):
> - Signature skill axis = **wave mastery** (Wave Race lineage).
> - Track editor stays **author-only** for v1; no community ingest.
> - Pillars from product-plan unchanged: water + verticality + arcade +
>   10-min loop + light combat.

## 1. Research → Hoverbike crosswalk

| Research signal | Our position | Target |
|---|---|---|
| 3-lap default, 2–5 min race | 3 laps × ~25 s/lap = ~75 s on Lagoon | **3 laps × 50–70 s = 2.5–3.5 min** — lengthen tracks ~2× |
| Casual lap 40–90 s | ~25 s on Lagoon, longer on Cliffside | Aim middle of the band; allow short outliers (Baby-Park-style 5–7 lap tracks) |
| Pick ONE signature mechanic | Wave physics + items + boost pads (three axes, no clear hero) | Wave mastery is the hero. Items and pads are seasoning, not graded skills |
| Multi-surface physics (Jet Moto unfulfilled promise) | Water + land + ramps + tunnels built | **Already a differentiator.** Lean into it in marketing copy |
| Field size 8–24 | 4 AI + local player | 8-bike grid by v1 (4 AI → 8 AI, or 4 AI + 4 MP peers) |
| Track count floor = 12 | 4 ship-quality (Lagoon, Cliffside, Oval, Fig-8) | **8 ship-quality tracks for v1**; 12+ for any "1.0" framing |
| Soundtrack is a core system | Procedural SFX only, no music | **License or commission 4–6 tracks** before public launch |
| AI rubber-band is universal #1 complaint | Already on, no toggle | **Rubber-band toggle + 3-step difficulty slider** |
| Tutorialization underbaked everywhere | No tutorial | 60–90 s scripted tutorial track teaching wave-pumping explicitly |
| Track editor = the unclaimed moat | In-app editor + Blender pipeline | Author-only for v1 (per decision); revisit shareable URLs post-launch |
| Don't headline ranked MP | M10.x lobby + state sync in progress | **Room-code MP only** — no ranked, no public matchmaking |
| Set-piece tracks beat generic loops | Lagoon + Cliffside both have hero moments (ramp, mesa drop) | Every v1 track must have ≥1 named set-piece |
| MK8 anti-grav universally loved | TODO per user | Ship **2–3 anti-grav tracks** at v1 |

## 2. The signature axis — wave mastery

This is the single most important decision in the doc and it's now
locked. Wave physics is **the** skill the player is graded on. That
means:

- **Tracks must reward wave-reading.** Open-water sections that are
  faster if you pump (accelerate down the back of a swell, kite up the
  next) and slower if you ignore them. Stunt-mode-style "ocean stretch"
  segments between land sections.
- **Wave pumping needs a HUD signal.** Even a subtle one (boost bar
  ticks, particle flash on a good pump) — research shows tactile
  feedback on the hero mechanic is universally praised when present.
- **Big-drop landings have to read.** Splash, screen-shake, water-
  displacement particles. Cliff drops are already a pillar; the *land*
  is the moment.
- **Buoy rule is NOT being added.** Wave-Race's slalom is iconic but
  the user has built around free-traversal water, not gated lines. The
  signature stays "rip across waves" not "slalom buoys."
- **Items and boost pads stay as seasoning.** They affect outcomes but
  are not what the game grades. This protects the identity from
  drifting into Mario Kart territory.

## 3. Numeric targets

| Target | Current | v1 | Stretch |
|---|---|---|---|
| Tracks (ship-quality) | 4 | **8** | 12 |
| Anti-grav tracks (subset) | 0 | **2** | 4 |
| Casual lap time | ~25 s (Lagoon) | **45–65 s** | 30–90 s range across track set |
| Total race time | ~75 s | **2.5–3.5 min** | 2–5 min range |
| Race default | 3 laps | 3 laps | 3 laps + per-track override |
| Field size | 4 AI + 1 player | **8 bikes** | 12 bikes |
| Music tracks | 0 | **4–6** | 8+ |
| AI difficulty options | Off / on | **3 levels + rubber-band toggle** | Per-class tuning |
| Tutorial | None | **1 scripted track, <90 s** | Per-mechanic drills |
| Modes | Free race | **+Time Trial w/ ghost, +Cup (4-track)** | +Knockout, +Mission |
| Multiplayer | M10.x WIP | **Room codes, 2–4 peers + AI fill to 8** | 8 peers no AI |
| Bike variants | 3 | 3 | 5 |
| 60 fps target | Hit on M1/Ryzen | Hold on M1/Ryzen 1080p | Hold on integrated GPU 1080p |
| Boot-to-race | <5 s broadband | <5 s | <3 s |

## 4. Priorities

### P0 — must ship for v1 public launch

1. **Track length pass.** Extend Lagoon and Cliffside to 45–65 s casual
   laps. Either lengthen the loop or convert to 2-lap longer tracks.
   The current ~25 s lap is below the genre's casual-play band and
   reads as a tech demo, not a race.
2. **4 additional ship-quality tracks.** Target: one all-ocean (wave
   mastery hero), one urban/canyon (set-piece à la Mount Wario),
   one mixed land/water with anti-grav section, one Baby-Park-style
   short multi-lap chaos arena. Reuses existing Blender authoring stack.
3. **Anti-grav system + 2 anti-grav tracks.** Hover controller must
   handle inverted/wall orientation; trigger volumes flip gravity;
   visual indicator on entry. Anti-grav is universally cited as MK8's
   most-loved tactile shift; the user explicitly wants this.
4. **Wave-pumping skill loop made legible.** Pumping already happens
   physically; add a HUD signal so players know it's a graded skill.
   This is what makes "wave mastery as signature axis" real instead of
   wishful framing.
5. **Soundtrack — 4–6 tracks licensed or commissioned.** Universal
   research signal. Procedural SFX is fine; absence of music is a
   "this isn't done" tell at the first 10 seconds of play.
6. **AI difficulty slider + rubber-band toggle.** Three settings
   (Casual / Standard / Hard) + a discrete "AI catch-up: off" option.
   Cap rubber-band acceleration coefficient when on; data is already
   in the AI system.
7. **Tutorial track.** <90 s scripted run teaching: throttle, drift,
   wave pumping (with explicit prompt), pickup use, jump landing,
   anti-grav entry. Auto-skip toggle for returning players.
8. **Race-line / wave-line guidance for new players.** The "Crazy Taxi
   arrow" already exists; extend with subtle on-water shimmer when the
   wave is pumpable. Avoids the Redout 2 onboarding failure mode.

### P1 — strong v1 polish, ship if time

1. **Cup mode (4-track championship)** with points table and end-of-cup
   summary. Reuses existing race + finish-overlay UI.
2. **Time Trial mode with ghost.** Best-lap save already exists; add
   ghost playback + global leaderboard via Vercel KV or similar
   (single endpoint, no account system).
3. **Room-code multiplayer to 8 bikes.** M10.x is already on this path.
   Don't ship public matchmaking. AI fills empty slots.
4. **Two more bike variants** for v1 (5 total). Each variant should
   have a clearly different wave-pumping feel (heavy = punishes pump
   timing harder, light = pumps easier but throws further off-line).
5. **Per-track best-lap leaderboard** (anonymous, single-table).
6. **Photo/replay mode.** Cheap content multiplier; asked-for in
   every research target.

### P2 — deferred (worth doing eventually, not v1-critical)

- Knockout-Tour-style elimination mode (MK World's headline new mode).
  Big design lift; revisit after v1 traction.
- Shareable track URLs (research moat, post-launch decision).
- Mission Mode / scenario challenges (MK8 most-requested feature).
- Touch on-screen controls (input is wired; overlay isn't).
- VR support (recurring Riptide ask, niche).
- Original soundtrack vs. licensed (start licensed, commission once
  the game's identity is locked).
- Career / story framing — research is mixed on whether arcade racers
  benefit. Skip for v1.

## 5. Anti-targets — things we explicitly will *not* do

These are direct lessons from the Pacer / MK World failure modes:

- **No "spiritual successor" marketing copy.** "Inspired by Wave Race
  and Jet Moto" reads better than "spiritual successor to" — Pacer's
  experience says the latter invites a comparison you lose. Frame the
  game as itself.
- **No ranked / competitive matchmaking.** Pacer's MP died in months
  because it was the headline feature. Ship room-code MP for friends,
  not strangers.
- **No grindy unlocks.** Riptide GP3's mobile-IAP DNA is in the
  ancestry; the genre punishes it. Bikes and tracks should be open.
- **No "intermission" route races** between tracks. MK World's biggest
  post-launch criticism. Keep races discrete.
- **No $80 framing.** N/A (web build, no price) but the principle is
  "don't ship thin." 8 hand-crafted tracks > 16 padded ones.
- **No mandatory difficulty walls.** Redout 2's tutorial failures are
  the warning. Every mechanic must be optional flair before it
  becomes a difficulty gate.

## 6. Open questions

These are real forks I don't have enough context to answer; flagging
for decision before the work starts.

1. **Wave-pumping HUD signal — explicit or subtle?** Explicit (bar +
   numeric boost) is legible but visually noisy. Subtle (particle
   flash, audio cue) preserves immersion but new players miss it.
   **Recommend explicit for tutorial + first 30 s of a race, fade to
   subtle after.**

2. **Anti-grav: wall-riding or full inversion?** Wall-riding (MK8
   anti-grav zones, banked extreme cant) is a smaller engineering
   lift. Full inversion (loop-de-loops, ceiling sections) is more
   spectacle but a bigger physics task and motion-sickness risk on
   a chase cam. **Recommend wall-riding only for v1; revisit full
   inversion in v1.x.**

3. **Music budget — license vs commission?** Licensing 6 tracks of
   surf-rock / electronic from a library like Pixabay/Soundstripe
   costs ~$200–500. Commissioning a small composer for 6 originals
   runs $3k–10k. **Recommend license for v1, commission the v1.5
   track that ships with a major content update once the audience
   has a sound preference.**

4. **MP scope — 4 peers + AI fill, or 8 peers + no AI?** Network
   bandwidth research in M10.11 puts 8 peers at ~12 KB/s ingress
   each. **Recommend 4 peers + AI fill to 8 for v1**, simpler to QA,
   matches research finding that small MP scenes outlast big ones.

5. **Track-length retrofit vs. new tracks.** Lengthening Lagoon and
   Cliffside is cheaper than designing four new ones but loses what's
   already proven to feel good. **Recommend new tracks, leave Lagoon
   short as the "tutorial-adjacent" first race.** Baby-Park precedent
   says short tracks have a place.

6. **8-bike grid: 4 AI → 8 AI vs. 4 AI + MP fill?** Spawning 8 AI
   costs perf (waves are already the budget item). MP fill assumes
   peers are present. **Recommend per-track maximum that scales with
   the bike's perf class; default to 6 bikes (1 player + 5 AI) on
   wave-heavy tracks, 8 on land-heavy tracks.**

## 7. Roadmap shape

This is shape, not a schedule — milestones in [implementation-plan.md](./implementation-plan.md)
are how the work actually gets tracked. Rough sequencing:

```
M10.x — multiplayer state sync + room codes        (in flight)
M11   — wave-mastery loop visible (HUD + pump feedback)
M12   — anti-grav system + first anti-grav track
M13   — track length pass (extend existing + 2 new tracks)
M14   — soundtrack integration + audio mixing pass
M15   — AI difficulty slider + tutorial track
M16   — Time Trial + ghost
M17   — Cup mode
M18   — final 2 v1 tracks + polish
v1 launch.
post-v1 — Knockout Tour, shareable tracks, replay mode
```

## 8. Success metrics for v1

- **8 ship-quality tracks** with at least one named set-piece each.
- **2 anti-grav tracks** validated for handling on chase cam.
- **Casual lap time across the set: 30–90 s**, weighted toward 45–65 s.
- **Total race: 2.5–4 min** at default lap count.
- **60 fps at 1080p on M1 and Ryzen 5000**, including wave-heavy tracks
  with 8-bike fields.
- **Boot-to-first-race under 5 s** broadband.
- **Tutorial completion under 90 s** for a non-gamer.
- **First-race retention:** non-gamer plays a second race without
  prompting. (Was in product-plan's success criteria, still open.)
- **Soundtrack present from main menu through finish overlay.**

## References

- Originals: [research/overview.md](../research/overview.md), plus
  [mario-kart-8.md](../research/mario-kart-8.md),
  [mario-kart-world.md](../research/mario-kart-world.md),
  [wave-race.md](../research/wave-race.md),
  [jet-moto.md](../research/jet-moto.md).
- Indie/AA successors: [research/spiritual/overview.md](../research/spiritual/overview.md),
  plus [riptide-gp.md](../research/spiritual/riptide-gp.md),
  [redout-2.md](../research/spiritual/redout-2.md),
  [pacer.md](../research/spiritual/pacer.md),
  [ballisticng.md](../research/spiritual/ballisticng.md).
- Locked vision: [product-plan.md](./product-plan.md).
- Live state: [status.md](./status.md).
