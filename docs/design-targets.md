# Hoverbike — Design Targets v0.1

> Synthesizes the [research/](../research/) findings against the locked
> vision in [product-plan.md](./product-plan.md) and the current
> [status.md](./status.md) (v1 lineup complete — 12/12 ship tracks; 5/5
> bike variants; gameplay-systems v1 push closing out polish/QA). Concrete
> numeric targets and prioritized work for the next push toward a
> public-launchable v1.
>
> **Locked decisions** (from product-plan + this round of strategy):
> - Signature skill axis = **wave mastery** (Wave Race lineage).
> - **Secondary skill axis = drift mini-turbo** (MK lineage, P0 add
>   during the v1 push). Lateral/spatial complement to wave-pump's
>   vertical/timing axis — drowned-city tracks demand both. See
>   [drift-deep-dive.md](./drift-deep-dive.md). The Wave Mastery framing
>   is preserved: drift owns flat-water + land corners; wave-pump owns
>   open-water sections.
> - Track editor stays **author-only** for v1; no community ingest.
> - Pillars from product-plan unchanged: water + verticality + arcade +
>   10-min loop + light combat.
> - Desktop target shifted from **Tauri** to **Electron** mid-push
>   (Tauri/WebKitGTK couldn't deliver WebGPU on Linux or launch through
>   the Steam Linux Runtime on the Deck — see [desktop-builds.md](./desktop-builds.md)).
> - **Anti-grav cut from the game** (2026-05-30; parked for a possible future
>   DLC — a fun/shippability pandora's box, not a v1-only cut). The "ship 2–3 anti-grav tracks" target below (§1) and the
>   anti-grav rows in the priority tables (§4) are **retired** — the v1
>   target is now **0** anti-grav tracks; verticality is delivered by
>   terrain, ramps, banked berms, and cliff drops. See the per-track docs
>   in [tracks/](./tracks/README.md). Rows below are left as-authored for
>   history; this banner is the source of truth where they conflict.

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
| MK8 anti-grav universally loved | **Cut from v1** (system tax vs ship date) | ~~Ship 2–3 anti-grav tracks~~ → **0**; verticality via terrain/ramps/berms/drops (see [tracks/](./tracks/README.md)) |

## 2. The signature axis — wave mastery (+ drift as the lateral complement)

> **v2 update (2026-06-04) — wave mastery pivoted (the Mario-Kart fork).** The
> graded skill is **no longer** "press forward on the crest for a boost" (the
> Wave-Race pump described below). It is **motocross "master the jump"**: pitch
> the takeoff off a wave crest or ramp, pitch to stick the landing — pitch
> genuinely drives how the bike rides the swell. The pump-on-crest framing, the
> wave-pump HUD chyron, and the wave-line shimmer in this section were built for
> the old model and are now either superseded or pending a refit to the fork. The
> rest of §2 is left as-authored for history; this note is the source of truth
> where they conflict.

This is the single most important decision in the doc and it's now
locked. Wave physics is **the** skill the player is graded on.
**Update (2026-05-26):** drift mini-turbo was added during the v1 push
as the *lateral/spatial* skill complement to wave-pump's
vertical/timing axis — drowned-city tracks ask for both. The framing
holds: wave mastery owns the water sections, drift owns flat-water +
land corners. The wave-line shimmer + post-pump chyron still bracket
the wave-pump *decision*; the drift HUD tier badge + sparks bracket
the drift *charge*. Both close on the player's button release. See
[drift-deep-dive.md](./drift-deep-dive.md) for the lineage and
tradeoff rationale (why drift doesn't dilute the wave-pump identity).

Wave-mastery means:

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
| Tracks (ship-quality) | **12** ✅ (target met at stretch) | 8 | 12 |
| Anti-grav tracks (subset) | **5** ✅ (Hatteras / Kilauea / Shibuya / Angkor / Liberty — target met at stretch) | 2 | 4 |
| Casual lap time | 45–65 s on v1 tracks | 45–65 s | 30–90 s range across track set |
| Total race time | 2.5–3.5 min on v1 tracks | 2.5–3.5 min | 2–5 min range |
| Race default | 3 laps + per-track override | 3 laps | 3 laps + per-track override |
| Field size | **8 bikes** ✅ (state-sync stable; perf at full field is the open work) | 8 bikes | 12 bikes |
| Music tracks | 🟡 procedural pad bed only | **4–6** | 8+ |
| AI difficulty options | **3 levels + rubber-band toggle** ✅ (+ per-difficulty pump + drift tuning) | 3 levels + rubber-band toggle | Per-class tuning |
| Tutorial | ✅ Track-agnostic 6-beat director (THROTTLE → CRUISE → LOOK → WAVE PUMP → DRIFT → ANTI-GRAV → READY); auto-runs on Sandbar | 1 scripted track, <90 s | Per-mechanic drills |
| Modes | ✅ Race / Time Trial + ghost / Cup (4-cup, MK8 points) / Multiplayer / Tutorial | +Time Trial w/ ghost, +Cup (4-track) | +Knockout, +Mission |
| Multiplayer | ✅ Room codes, lobby, sticky raceStarted, 1 Hz ping/pong | Room codes, 2–4 peers + AI fill to 8 | 8 peers no AI |
| Bike variants | **5** ✅ (Cruiser / Racer / Stunt / Scout / Sparrow) | 3 | 5 |
| Drift mini-turbo | ✅ MT/SMT/UMT tiers, inside-drift archetypes, AI drift, Practice Range | — (added during v1 push) | per-bike tier-time tunables |
| Surface registry | ✅ runtime + sync test; 🟡 Blender authoring UI pending | — (added during v1 push) | Volumetric grip painting in editor |
| Desktop targets | ✅ Linux + Windows via Electron (Steam Deck Native + Windows depot); macOS deferred | — | macOS |
| Making-of microsite | ✅ Six chapters at `/making-of/`, demos import real sim | — | Per-chapter playthrough video |
| 60 fps target | 🟡 Holds on M1/Ryzen at solo; perf-budget pass against 8-bike field still pending | Hold on M1/Ryzen 1080p | Hold on integrated GPU 1080p |
| Boot-to-race | <5 s broadband | <5 s | <3 s |

## 4. Priorities

### P0 — must ship for v1 public launch

1. ✅ **Track length pass.** Extended via the v1 sprint — every track
   in the v1 lineup hits the 45–65 s casual-lap target. (Lagoon stays
   as the tutorial-adjacent short loop per the Baby-Park precedent.)
2. ✅ **Ship-quality tracks at v1 scale.** Shipped 12/12 — Reef Cup
   (Sandbar / South Beach Sunken / Hatteras Light / Cape Town Drift),
   Open Sea (The Maw), Continental Cup (Shibuya Submerged / Kilauea
   Crown / Marina Bay 7 / Doge's Drift), Drowned Cup (Aqualand /
   Angkor Drowned / Liberty Drowned). All four cups lit; Drowned Cup
   is the finale.
3. ✅ **Anti-grav system + 2+ anti-grav tracks.** Shipped 5 — Hatteras
   corkscrew, Kilauea caldera-rim ribbon, Shibuya Cocoon Tower wall-ride,
   Angkor central spire helix, Liberty's torch-arm Möbius + crown
   interior. HUD indicator + camera-intensity setting (Full / Reduced
   / Off) live.
4. ⚠️ **Wave-pumping skill loop legible.** *(v1-historical — cut with the
   pump→pitch pivot, §2 banner.)* The post-pump chyron + the predictive 3D
   `wave-line` forward fan **no longer exist in `src/`** — do not cite them
   as shipped. Under the v2 wave-mastery model the *water itself* must
   carry the read-the-swell signal (value ramp / contour foam / whitecaps —
   [water-next-research.md](./water-next-research.md) §5, P1); if a
   guidance accessibility option ever returns it should render ON the
   water surface (sampling the same wave field), not as a HUD fan.
5. 🟡 **Soundtrack.** Procedural pad bed shipped as stand-in on the
   music bus (`audio-service.ts`); licensing or commissioning the
   4–6 tracks is the open item — `setMusicEnabled(false)` is a
   one-liner away from the swap.
6. ✅ **AI difficulty slider + rubber-band toggle.** Casual / Standard
   / Hard; rubber-band assist toggle is read live each tick so flipping
   mid-race settles AI back to its baseline. Per-difficulty pump-firing
   threshold + per-difficulty drift activation (Hard reaches UMT).
7. ✅ **Tutorial.** Track-agnostic 6-beat director: THROTTLE → CRUISE
   → LOOK AROUND → WAVE PUMP → DRIFT → ANTI-GRAV → READY. Activated
   by Tutorial mode tile or Settings → Replay Tutorial. Subtitles
   toggle hides the hint line; the chyron stays.
8. ✅ **Wave-line guidance.** 3D forward-fan shimmer over the
   `sampleSurface().vy` field — markers' size + brightness scale with
   pump-score so the player sees where the next push will pay.
9. ✅ **Drift mini-turbo (added during the v1 push).** Mario-Kart-style
   3-tier mini-turbo with inside/outside-drift archetypes per bike.
   Lateral skill complement to wave-pump's vertical axis. Surface-type
   registry (ice / sand / metal) layers grip variation. AI drift on
   sharp corners (Standard caps at SMT, Hard reaches UMT). Drift
   Practice Range as dev fixture. See
   [drift-deep-dive.md](./drift-deep-dive.md).

### P1 — strong v1 polish, ship if time

1. ✅ **Cup mode (4-track championship)** with points table and end-of-cup
   summary. MK8-style point curve (15/12/10/9/8/7/6/5/4/3/2/1) +
   cup-results screen with champion banner. All four ship cups lit.
2. ✅ **Time Trial mode with ghost** + global leaderboard. Single-lap
   ghost slice loops per lap. HMAC-signed PartyKit `leaderboard` Party
   + moderation CLI; per-track top-25 with profanity / replay-nonce
   gating.
3. ✅ **Room-code multiplayer to 8 bikes.** Lobby with smash-bros pick
   + ready states + 1 Hz ping/pong latency display + sticky raceStarted
   bit for late joiners. State-sync stable; perf at full field still
   pending.
4. ✅ **Two more bike variants** — Scout (heavyweight, soft hover spring
   → punishing wave-pump timing + biggest launch) + Sparrow (lightweight,
   stiffest spring + highest surfaceFollow → forgiving + further launch).
5. ✅ **Per-track best-lap leaderboard** + global submission with HMAC
   sig + moderation CLI.
6. ⬜ **Photo/replay mode.** Recorder + pose-replay infrastructure
   in place (powers Time Trial ghosts); a viewer scene is the open
   work.

### P2 — deferred (worth doing eventually, not v1-critical)

- Knockout-Tour-style elimination mode (MK World's headline new mode).
  Big design lift; revisit after v1 traction.
- Shareable track URLs (research moat, post-launch decision).
- Mission Mode / scenario challenges (MK8 most-requested feature).
- ✅ Touch on-screen controls (mobile MENU button + touch HUD shipped
  during Polish/QA — see status.md).
- VR support (recurring Riptide ask, niche).
- Original soundtrack vs. licensed (start licensed, commission once
  the game's identity is locked).
- Career / story framing — research is mixed on whether arcade racers
  benefit. Skip for v1.
- 🆕 **Rider customization (player-facing).** Editor (`?rideredit=1`)
  ships with primitive shapes + colours + seated-pose tools; pulling it
  into the main menu as a Garage feature is post-launch polish.
- 🆕 **Surface-type Blender authoring UI.** Runtime + tests live; the
  addon panel write-out is the remaining sliver.

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
are how the work actually gets tracked. Original sequencing (what actually
shipped where the original plan didn't anticipate is marked in the second
column):

```
M10.x — multiplayer state sync + room codes        ✅ landed
M11   — wave-mastery loop visible (HUD + pump feedback)
                                                   ✅ Foundation Systems 5/5
M12   — anti-grav system + first anti-grav track
                                                   ✅ HUD + camera + 5 tracks
M13   — track length pass (extend existing + 2 new tracks)
                                                   ✅ Reef Cup (Sprint 1)
M14   — soundtrack integration + audio mixing pass
                                                   🟡 mixer + procedural bed;
                                                       licensed music pending
M15   — AI difficulty slider + tutorial track
                                                   ✅ both shipped + DRIFT beat
M16   — Time Trial + ghost                         ✅ + leaderboard
M17   — Cup mode                                   ✅ all 4 cups lit
M18   — final 2 v1 tracks + polish                 ✅ 12/12 ship tracks
                                                       + electron port
                                                       + making-of microsite
                                                       + drift / tricks / tuck
                                                       + surface registry
v1 launch.                                         (current target)
post-v1 — Knockout Tour, shareable tracks, replay mode
```

Unplanned-but-landed (rolled in during M14–M18):
- **Drift mini-turbo** (gameplay-mechanic add) — see drift-deep-dive.md.
- **Surface-type registry** (drift's content layer).
- **Tuck sweet-spot** + **Tricks rework**.
- **Electron desktop wrapper** replacing Tauri (Steam Deck blocker).
- **Six-chapter making-of microsite** (marketing surface, also drove the
  pure-leaf extraction of `tuck-curve.ts` + `drift-tiers.ts`).
- **Rider editor** (`?rideredit=1`).

## 8. Success metrics for v1

- ✅ **12 ship-quality tracks** with at least one named set-piece each.
  (Target was 8 — overshot to the stretch goal.)
- ✅ **5 anti-grav tracks** validated for handling on chase cam (Hatteras,
  Kilauea, Shibuya, Angkor, Liberty). (Target was 2; stretch goal was 4 —
  overshot.)
- ✅ **Casual lap time across the set: 30–90 s**, weighted toward 45–65 s.
- ✅ **Total race: 2.5–4 min** at default lap count.
- 🟡 **60 fps at 1080p on M1 and Ryzen 5000** with 8-bike fields on
  wave-heavy tracks — perf-budget pass still pending against the full
  field.
- ✅ **Boot-to-first-race under 5 s** broadband.
- 🟡 **Tutorial completion under 90 s** for a non-gamer — untested with
  a real non-gamer.
- ⬜ **First-race retention:** non-gamer plays a second race without
  prompting.
- 🟡 **Soundtrack present from main menu through finish overlay** —
  procedural pad bed ships today; licensed/commissioned drops still
  pending.
- ✅ **Drift skill loop legible.** Tier-up HUD + colored sparks + bell
  pitch + camera roll all give the same payoff signal.

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
