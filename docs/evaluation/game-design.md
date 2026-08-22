# King Tide — Game Design Evaluation

> Evaluated 2026-08-22 · full-project review · perspective: Game Design
> (senior racing-game designer). Code claims verified in source; doc claims
> cited as docs. Assets are not in git (expected); nothing here judges the
> absent binaries.

## Scope & method

Read the orientation set (CLAUDE.md, README.md, docs/status.md banner), the
design canon (product-plan, design-targets, drift-deep-dive, out-of-bounds-design,
playtest-wave-mastery-legibility, painterly-legibility-plan, track-themes,
docs/tracks/ incl. the three Reef Cup docs + the-maw, reef-cup-vertical-slice-status,
v1-work-breakdown), and then the implementations they describe:
`src/game/systems/` (launch-grade, drift + drift-tiers, tuck-curve + hover-drive,
trick-hop, hover-attitude, boost-meter, rubber-band, ai-control, ai-combat,
out-of-bounds, pickup-registry), `src/game/ai/` (difficulty, pump-hints),
`src/engine/tutorial/`, `src/engine/menus/` (menu-flow, tracks-catalog,
settings surface via player-settings), `src/game/bikes/variants.ts`,
`src/game/entities/pickup-spawn.ts`, the three Reef Cup track JSONs under
`public/tracks/`, `tests/e2e/field-completion.spec.ts`, and git history for the
2026-08-21 menu revision (commit 0f32d1f). No GPU on this machine — nothing
headed was run; judgments are from source, data, tests, and docs.

## Executive summary

This is a rare thing: a hobby-scale arcade racer with a genuinely coherent,
*disciplined* design identity. The vision docs pick one hero mechanic and defend
it in writing (design-targets §2, §5's anti-targets), the code follows the docs
with unusual fidelity (the pump→pitch pivot is propagated through sim, tutorial,
HUD, and doc banners), and the secondary systems — the MK8DX-faithful three-tier
drift, the slope-aware tuck sweet-spot, the geometric trick window — are among
the best-reasoned mechanic implementations I've reviewed at this scale. The
current focus (three shippable Reef Cup maps) is the right proof-of-thesis. But
the review found four real design-level problems, all fixable: (1) the tutorial
became unreachable from the normal menu flow on 2026-08-21, leaving a game whose
signature skill is admittedly "undiscoverable" ungated *and* untaught for new
players; (2) the AI still performs the *cut* v1 wave-pump, never pitches a
landing, and never spends the boost meter the grading system pays it — the hero
mechanic is never modeled by rivals; (3) the reward economy lets the secondary
mechanic (drift, 1.95×/2.3 s free) out-earn the signature one (a *perfect*
landing pays half a meter that still needs a separate button at 1.6×), and the
graded takeoff pays nothing at all; and (4) the proof-of-thesis cup itself
cannot pass its own 8-bike completion gate on Container Chaos (a `test.fixme`),
whose track data also ships zero pickups, zero boost pads, and zero wave zones.
The bones are excellent. The connective tissue between "the mechanic exists" and
"a stranger discovers, learns, and is rewarded for it" is where the design work
now lives — which is exactly what the project's own playtest card says, unrun.

## 1. Vision & coherence — is there a reason to exist?

**Yes, and it is written down.** "JetMoto homage with Wave Race water physics
and light Mario Kart combat" (README.md:3) occupies a genuinely unclaimed slot —
the research crosswalk (design-targets §1) even identifies multi-surface physics
as "Jet Moto's unfulfilled promise" and claims it deliberately. Three things make
this more than a mood board:

- **One hero mechanic, defended.** "Pick ONE signature mechanic … Wave mastery
  is the hero. Items and pads are seasoning, not graded skills"
  (design-targets.md:38, §2). The buoy-slalom rejection ("the signature stays
  'rip across waves' not 'slalom buoys'", design-targets.md:85-88) is the kind
  of negative decision most projects never record.
- **Anti-targets that the code obeys.** No ranked MP (room codes only —
  verified: `party/relay.ts` lobby, no matchmaking), no grindy unlocks (all
  bikes/tracks open — verified: no unlock gate anywhere in `menu-flow.ts`), no
  mandatory difficulty walls (every tutorial beat has a `clearAfterSeconds`
  escape hatch that advances with a *neutral* flash, tutorial-script.ts:24-32 —
  celebration reserved for performed actions). This discipline is the project's
  strongest design asset.
- **The v2 pivot was propagated, not papered over.** The pump→pitch pivot
  (motocross master-the-jump) is consistently reflected in `launch-grade.ts`,
  the tutorial's LAUNCH→LAND beats, the tuck's slope-aware notch, and honest
  "v1-historical" banners across the docs. Design docs that admit what no
  longer exists (design-targets.md:134-141: "the chyron + wave-line fan **no
  longer exist in src/** — do not cite them as shipped") are a credibility
  signal.

The Reef Cup proof-of-thesis (CLAUDE.md "Current direction") is the correct
strategic bet: mechanics are in precision-tuning, tooling is done, so the open
question is *content* — can one cup of three maps be brought to shippable? My
one structural criticism of the bet is in §5: as composed, the visible lineup
under-tests the thesis mechanic itself.

## 2. The signature mechanic — wave mastery as implemented

### What is genuinely strong

`launch-grade.ts` is the right minimal system, well built: it grades the takeoff
pitch against a motocross pop band (ideal +0.24 rad ≈ 14°, tolerance 0.3 rad;
launch-grade.ts:59-63), grades the landing as pitch-vs-surface-tangent using the
*same* extraction the hover PD uses ("level with the surface means one thing
everywhere", launch-grade.ts:85-89), gates landings on credible air
(MIN_AIRTIME_SEC 0.45), pays the boost meter, and fires deterministic one-shot
edges consumed render-side — player and AI alike, so replays and lockstep stay
consistent. The supporting cast is equally thoughtful:

- **Tuck** (`tuck-curve.ts` + hover-drive.ts:259-277): a sweet-spot curve that
  goes *negative* past the notch (belly-scrape penalty), with the notch sliding
  toward the feathered end on anticipated downslopes so "the rewarded lean
  always matches the pitch the slope actually leaves room for" — pure motocross
  "match the terrain," and the pitch gesture stays one control with no new
  button. This is sophisticated feel design.
- **Tricks** (`trick-hop.ts`): the geometric pop window (per-end contact flags
  instead of a vy gate) plus the 200 ms pre-press buffer whose expiry *honors*
  the press if the climb context is still credible — "the prompt that elicited
  the press never lies" (trick-hop.ts:57-65). That sentence is a design
  principle worth framing.
- **Physics that reward pitch for real.** Air control is free physics plus
  arcade aids (hover-attitude.ts:234-337); pitch-vectored thrust means nose-up
  extends air and nose-down dives, so the graded gesture is also a genuine
  physical control, not a QTE.

### The economy problem — the hero is out-earned by the sidekick

Verified numbers, all from source:

| Action | Payoff | Friction |
|---|---|---|
| Drift UMT release | **1.95× for 2.3 s**, applied automatically (drift-tiers.ts:33,41) | hold ~2.4 s through a sweep |
| Drift SMT release | 1.75× for 1.6 s, automatic | hold ~1.4 s |
| **Perfect launch+landing** | **0.5 boost-meter charge** → ~1.5 s of held boost at the default **1.6×** `boostMul` — and only after a *separate* boost press (boost-meter.ts:41-45, launch-grade.ts:69-74) | read swell, pitch takeoff, pitch landing |
| Graded takeoff (the "CLEAN LAUNCH" verdict) | **nothing** — `takeoffQuality` is stored and chyroned but never converts to reward; the landing payout reads landing quality only (launch-grade.ts:150-168) | — |

So the signature skill's best-case return is smaller, slower, and
higher-friction than the secondary mechanic's, and half of the signature skill
(the takeoff) is graded cosmetically. drift-deep-dive.md itself names the risk:
"drift dilutes wave-pump identity if it dominates charging." On the current
numbers, on any track with corners, it will. The fix is cheap and local: blend
`takeoffQuality` into the landing payout (a *jump* score, motocross-style), and
either raise the clean-jump payout above one SMT-equivalent or auto-vent a short
burst on a clean landing so the reward is felt without the extra button. This
is precisely the kind of question the unrun playtest card exists to settle —
but the asymmetry is visible in the constants today.

### Legibility — feedback exists, foresight doesn't

The loop's *retrospective* channel is good: two-word verdict chyron, meter pay,
tutorial beats keyed to verdicts. The *prospective* channel — "point at the
swell you're going to launch off, ~2 s ahead" — is the acknowledged open gap:
the water itself must carry the read, the old HUD fan is gone by design, and
the project files the remaining forward-read work as P1
(design-targets.md:134-147), and the water-surface overlays built for it were dialled
to a whisper or removed for noise/perf (painterly-legibility-plan.md, 2026-06-16
update). `playtest-wave-mastery-legibility.md` is an excellent, focused
instrument — five scored questions mapping directly to work aims — and as far as
this repo shows, **it has never been run**. Until Q1–Q3 are scored, every water
knob turned for "legibility" is aimed blind. The painterly-legibility plan's
contrast-budget thesis (the brightest, most saturated thing on screen is always
a gameplay event) is the right foundation; the reserved signal-color vocabulary
exists in code (`signal-colors.ts`, `signal-state.ts`) but ships default-off.

## 3. The secondary axes — drift, tuck, tricks

The drift system deserves specific praise: three tiers with MK8DX parity, an
anti-snake floor + cooldown, counter-steer that pauses-but-doesn't-cancel,
inside/outside archetypes as a per-variant knob, a surface-grip registry whose
`default` is a byte-identical 1.0 (a real design guard — drift-deep-dive.md
§Surface-aware), a dedicated practice range with a unit test pinning its station
geometry, and a doc that records the entire lineage and every tuning knob with
ranges. AI drift mirrors the player state machine through a pure, unit-tested
helper (`decideAIDrift`, ai-control.ts:54-86). The division of labor is clean
and stated: wave mastery owns water, drift owns corners, tuck owns descents,
tricks own airtime — each pays into a distinct channel (meter vs BoostEffect vs
speed-cap) so they stack without one invalidating another. The only cross-axis
issue is the economy skew in §2.

## 4. Difficulty & AI

**The tuning architecture is right.** Casual/Standard/Hard are data-driven
bundles (difficulty.ts) covering speed, cornering plan, rubber-band bounds,
pump thresholds, drift ceilings, and steering gains; Casual's `Infinity`
short-circuits are elegant; the rubber-band modulates around the per-difficulty
*baseline* so a boosted Casual AI stays visibly slower than Standard
(rubber-band.ts:66-73), and its asymmetric saturation (leaders feel the brake
faster than chasers feel the boost) is the correct MK-style shape. The assist
toggle settles smoothly mid-race rather than snapping — a small thing playtests
notice.

**But the AI does not play the signature mechanic.** Verified in
`ai-control.ts`:

- Its "wave" action is the **cut v1 pump**: a 0.1 s pitch-up burst when surface
  vy rises inside a heavy wave zone (ai-control.ts:315-356, pump-hints.ts) —
  not a shaped takeoff into the 14° pop band, and not tied to any jump.
- It **never pitches a landing**. Airborne, its `intent.pitch` is 0 outside the
  burst window, and air has no pitch PD by design (hover-attitude.ts), so AI
  landing quality is whatever angular momentum it carried off the lip.
- It **never spends the boost meter** `launchGradeSystem` pays it —
  `boost: false` every tick (ai-control.ts:371-384). Hard AI's speed comes from
  `topSpeedFactor: 1.04` instead.

Design consequences: the player never *sees* a rival pop a crest and stomp a
landing (observational teaching — how kart players actually learn drift — is
lost); "Hard AI" difficulty is a stat cheat rather than demonstrated mastery of
the game's own hero skill; and the meter charge accruing on AI is dead state.
The AI drift, by contrast, does model the secondary mechanic honestly (Standard
caps SMT, Hard reaches UMT) — which makes drift, again, the mechanic the game
*shows*, and wave mastery the one it merely mentions.

**The jam issue is honestly guarded but unresolved where it matters most.**
`field-completion.spec.ts` runs the 8-bike no-jam gate by default for the three
Reef tracks — exactly the right guard — but `cape-town-drift` is `test.fixme`:
the field stalls at cp9 (Table Mountain summit), the fix needs a terrain
re-grade, and "cape's content-root .blend is currently a 2-point-spline stub
that can't export a terrain pass" (field-completion.spec.ts:54-70). One third of
the proof-of-thesis cup cannot currently pass the cup's own definition of done
(reef-cup-vertical-slice-status.md criterion 1).

## 5. Track & content design

**The documentation layer is exceptional.** Per-track docs with second-by-second
beats, one named set-piece each, a hard-section slot at ~62–80% of lap distance,
branch lines with quantified costs (mexico-city.md:82-89), and a
"verticality without anti-grav" section per reworked track mapping each cut
moment to one of six normal-gravity primitives (tracks/README.md:44-70). Two
structural calls show real genre literacy:

- **The no-open-water pass** — every track must combine over-water land/props
  with water, retiring the Open Sea Cup and parking The Maw/Hatteras to a
  B-list. Right call: pure open water gives the eye no speed references and the
  swell no silhouettes to read against.
- **The calm-water skill check** — Container Chaos is explicitly the Drake Lake
  slot: "This track exists so pumping is legible as a skill on the other ten"
  (cape-town-drift.md:63-68). Designing a track whose job is contrast is
  varsity-level cup composition.

**But the visible lineup under-tests the thesis.** With `VISIBLE_CUPS = ['reef']`
(tracks-catalog.ts:250), the shipping game is: a classroom (Mayday Bay, one
crest launch, Beaufort ~1), a calm-lake handshake opener (Angel Basin — the
set-piece is a *ramp* launch), and a deliberately-no-swell skill check
(Container Chaos). The wave-mastery showcase environments — The Maw's big open
swell, the Harbor Cup's open-water stretches that the-maw.md says inherited its
role — are parked or pending. The contrast track ships; the thing it contrasts
*against* doesn't. Until a swell-forward venue is visible, the proof-of-thesis
mostly proves drift, precision, and ramps.

**Data drift, verified in the track JSONs and catalog:**

- `public/tracks/cape-town-drift.json`: **0 pickupSpawns, 0 boostPads, 0
  waveZones** (sandbar has 4 spawns/1 pad; mexico-city 9/3). A third of the cup
  ships with no item game at all — nothing in its design doc says "no items."
- `public/tracks/sandbar.json` has `lapsToFinish: 3` while the venue card
  promises `laps: 1` (tracks-catalog.ts:63-67) and its design doc says "60 s
  scripted, 1 lap." `track.lapsToFinish` is what race completion actually
  checks (race.ts:186), so the card understates the commitment 3×.
- `tracks-catalog.ts:227` still ships Liberty's set-piece as "The Torch Arm
  **anti-grav showcase**" — v1-historical copy in live catalog data, hidden
  today only because the Drowned Cup isn't in `VISIBLE_CUPS`. A landmine for
  the day that cup unlocks.
- track-themes.md's locked decision "Every track is a recognizable real-world
  place — no generic biomes" (track-themes.md:34-35) is now contradicted by the
  2026-08-20 fictional-city pivot (Angel Basin / Container Chaos / Mayday Bay);
  the bible's v2 banner doesn't flag that particular lock as superseded.

## 6. Modes, onboarding & the first run

**Mode structure is rich for the scope and mostly excellent.** Single Race,
Time Trial with a self-overwriting per-(track,bike) ghost + HMAC-signed global
top-25 with a moderation CLI, Cup with the MK8 points curve (`cup-progress.ts`)
and 7-AI fields, room-code multiplayer with sticky race-start for late joiners,
and a tutorial director. Time Trial correctly spawns zero AI
(race-boot.ts:931); the tutorial caps its escort at 2 casual bikes
(race-boot.ts:937) — "a coached first run is an escort ride, not a pack that
laps the student" (spawn-bikes.ts:58-61). The 10-minute-loop pillar is honored:
finish → NEXT RACE drops straight back in.

**The first-run funnel is broken, and recently.** Commit 0f32d1f (2026-08-21)
removed the TUTORIAL tile from mode-select. The tutorial now exists only behind
Settings → "Replay tutorial" and `?tutorial=1` (menu-flow.ts:154-166) — and
there is **no first-run detection**: `tutorialCompleted` is read only to pick
CTA labels — on the now-unreachable tutorial screen (menu-flow.ts:1185) and on
the Settings row (settings-overlay.ts:650) — never to route anyone. So two
days after PR #25 invested a whole pass in the First Run (Mayday Bay venue,
performed-actions-only celebrations, LAUNCH/LAND beats named E/Q on screen —
status.md 2026-08-19), a brand-new player's realistic path is Title → SINGLE
RACE → a mechanic the launch-grade header itself calls "undiscoverable" without
teaching (launch-grade.ts:6-9). It also leaves design-targets P0 #7 stale — its
✅ records activation "by Tutorial mode tile or Settings → Replay Tutorial",
and the tile half no longer exists — and quietly abandons the "non-gamer
finishes a race without instruction" success criterion. The menu trim itself was good
(SP/MP title fork, venue lists cut to the three real maps plus one dev sample);
dropping the tutorial's only discoverable door was the one wrong cut. Minimum
fix: first boot with `tutorialCompleted === false` routes the SINGLE PLAYER
commit through First Run, or surfaces a one-time "NEW HERE? → FIRST RUN" card.

## 7. Pickups & combat balance

Four items, one registry (`pickup-registry.ts`) co-locating effect + AI
heuristic + spatial-precompute flags — adding a fifth item is one entry, which
is the right shape for future balance work. The pool is deliberately
boost-weighted (`['boost','boost','missile','mine','shield']`,
pickup-spawn.ts:12-15) with the comment "tune the ratio if combat starts
dominating racing" — faithful to the "seasoning" pillar. AI fire heuristics are
sensible and honest about their simplicity (ai-combat.ts:20-36). Two balance
observations: the boost *item* (1.6×/1.8 s) is strictly weaker than a free UMT
drift (1.95×/2.3 s), which is philosophically correct (skill > luck) but worth
knowing; and item distribution is position-blind — comeback is carried entirely
by the rubber-band, not MK-style item weighting. Defensible, but it means
turning the rubber-band off removes *all* comeback mechanics at once; a light
position bias on the pool would decouple those levers.

## 8. Failure, boundaries & recovery

The out-of-bounds design is pillar-aligned spectacle — warn → autopilot →
shark, with a near-miss grace path when the player is recovering
(out-of-bounds-design.md state machine) — and it shipped with a player-facing
intensity setting ('off'/'autopilot'/'shark', settings-overlay.ts:618). The
2026-08-19 respawn work (rebindable respawn, `stuck-rescue.ts` auto-rescue
after ~2.5 s wedged) closed the classic "softlocked in a corner" trust-killer.
One design tension: **forfeit-on-WARN is a DNF** — first soft-wall crossing
permanently voids the run's placement, ghost, and leaderboard eligibility
(game-loop.ts:2191-2212). For Time Trial that's correct anti-shortcut hygiene.
For a casual 3-lap race against AI it converts one exploratory mistake into
"this race no longer counts," with laps still to drive — friction against
pillar 3's "forgiving boundaries." Recommend scoping the DNF to TT/leaderboard
and letting Race mode pay in time (the autopilot detour already costs seconds).

## 9. Progression & retention

The no-grindy-unlocks anti-target is honored: everything is open. Retention
therefore rests on ghosts, the global top-25, and cup points — a thin but
honest set. What's missing is cheap and on-theme: the catalog already carries a
per-venue `lapTarget` (tracks-catalog.ts:36) that is never graded against —
bronze/silver/gold vs. target per (track,bike) would give the three-map game a
reason for run four, with zero new content. Similarly, launch-grade already
fires a per-jump clean/ok/sloppy verdict (`verdictFor` over the one-shot edges
the HUD consumes) — nothing tallies them per race yet, but a small counter plus
a post-race "jump report" line would make the signature skill visible in the
results screen where players decide whether to rematch. Neither violates the anti-target — they're mirrors,
not treadmills.

## 10. Accessibility & input navigability as design

This is a strength worth naming. The settings surface covers colorblind
palettes (3), reduced flash, large text, high contrast, motion-sickness
reduction, screen-shake intensity, subtitles-always-on
(player-settings.ts:220-253), plus per-mechanic VFX intensity (drift, tuck,
wave FX) that the *reward logic explicitly ignores* — the drift tutorial beat
clears "regardless of driftIntensity … a player with visuals off still
graduates" (drift-deep-dive.md §Tutorial integration), and sim-side boosts are
never gated on a frame-dropped effect. The input-navigability convention
(v1-work-breakdown.md §Convention) — every surface operable by keyboard,
controller, *and* touch, with a shipped checklist and a named regression (PR
#200) it prevents — is the kind of institutionalized lesson most teams never
write down. The 2026-08-19 arrow/WASD spatial menu nav closed the remaining gap.

## Top 10 fixes & improvements (ranked)

1. **Reopen a discoverable path to the tutorial for new players.** The
   TUTORIAL tile was removed from mode-select on 2026-08-21 (commit 0f32d1f);
   the tutorial now hides behind Settings → "Replay tutorial" and `?tutorial=1`,
   and `tutorialCompleted` gates nothing (menu-flow.ts:154-166, 1185). Route
   first boot into First Run or add a one-time "NEW HERE?" card on the title/mode
   screen. Without it, a new player's first minute is an ungraded race with a
   signature mechanic the code itself calls undiscoverable — the single biggest
   threat to "a stranger wants a rematch."

2. **Teach the AI the v2 signature loop it grades them on.** AI still runs the
   cut v1 pump (vy-triggered pitch burst, ai-control.ts:315-356), never pitches
   a landing, and never spends the boost meter launchGradeSystem pays it
   (`boost: false`, ai-control.ts:371-384). Add an airborne pitch-to-tangent
   controller + meter-venting on Standard/Hard. Players learn kart mechanics by
   watching rivals; today rivals demonstrate drift but not wave mastery, so the
   hero mechanic reads as optional flair even at Hard.

3. **Unblock Container Chaos's 8-bike field (the `test.fixme`).** The
   proof-of-thesis cup fails its own slice-complete gate on track 3: the AI
   field stalls at cp9 on the Table Mountain summit, and the content-root
   .blend is a 2-point-spline stub that can't export a terrain re-grade
   (field-completion.spec.ts:54-70). Until this is fixed, Cup mode — the mode
   the whole v2 bet is about — cannot deliver a full-field championship, and
   players meet a half-empty or jammed race on the cup's closer.

4. **Rebalance the skill economy so wave mastery out-earns drift.** A free UMT
   pays 1.95×/2.3 s automatically; a *perfect* launch+landing pays 0.5 meter →
   ~1.5 s at 1.6× after a separate button press, and the graded takeoff pays
   nothing (drift-tiers.ts:26-41, launch-grade.ts:69-74,150-168). Fold
   `takeoffQuality` into a combined jump payout and lift the clean-jump reward
   above SMT-equivalent. Players optimize what pays; today the game's stated
   hero skill is its worst-paying skill, so lap times will be won on corners,
   not waves.

5. **Run the wave-mastery legibility playtest card and act on Q1.** The card
   (playtest-wave-mastery-legibility.md) is precisely the right instrument —
   five scored questions with a result→work-aim table — and there's no evidence
   it has ever been executed; meanwhile the forward water read remains the
   acknowledged open work (filed P1 in design-targets §4) and all shipped
   feedback is retrospective (chyron after the jump). One
   headed hour answers whether players can *see the next launch coming* — the
   difference between a mechanic that feels like skill and one that feels like
   luck.

6. **Put one swell-forward stretch into the visible lineup.** With
   `VISIBLE_CUPS = ['reef']` the shipping game is a classroom, a calm-lake
   opener, and a deliberately-no-swell skill check; the wave showcases (The
   Maw, Harbor Cup open-water stretches) are parked or pending. Add a heavy
   wave-zone stretch to a Reef track's back half or fast-track one Harbor
   venue. Container Chaos's calm-water contrast currently has nothing visible
   to contrast against — players can finish the whole shipped game without ever
   needing the signature mechanic.

7. **Finish Container Chaos's gameplay data.** Its JSON ships 0 pickupSpawns,
   0 boostPads, 0 waveZones (vs sandbar's 4/1/1 and mexico-city's 9/3/1) —
   verified in `public/tracks/cape-town-drift.json`. Even as the precision
   track, zero items on one third of the cup silently deletes the "light Mario
   Kart combat" pillar there and makes Cup races feel inconsistent
   race-to-race; if item-free is intentional, the design doc should say so.

8. **Scope the out-of-bounds forfeit to Time Trial/leaderboard, not Race
   placement.** First soft-wall contact currently DNFs the whole run — no
   position, no ghost, no board (game-loop.ts:2191-2212) — which is right for
   record integrity but harsh against pillar 3's "forgiving boundaries" in a
   casual AI race. Let Race mode pay in time (autopilot detour) and reserve the
   DNF for records; a curious player who clips the boundary on lap 1 shouldn't
   be racing two dead laps.

9. **Reconcile catalog/data drift before more cups unlock.** Sandbar's card
   says 1 lap but `lapsToFinish: 3` drives the race; Liberty's live catalog
   set-piece still reads "anti-grav showcase" (tracks-catalog.ts:227) despite
   the cut; track-themes' locked "recognizable real-world place" rule
   contradicts the fictional-city pivot. Each is small; together they're the
   exact class of stale-promise the 2026-08-19 pass called "the playtest's
   biggest trust break" (card promises vs what loads).

10. **Add zero-treadmill retention mirrors: lap-target medals + a post-race
    jump report.** Grade PBs against the already-shipped per-venue `lapTarget`
    (bronze/silver/gold per track×bike) and tally the per-jump clean/ok/sloppy
    launch-grade verdicts — fired per event today, counted nowhere — into a
    results-screen jump report. No unlocks, so the anti-target
    stands — but a three-map game needs a reason for the fourth run, and
    making the signature skill visible in results is the cheapest one that
    also reinforces fix #4's economy.
