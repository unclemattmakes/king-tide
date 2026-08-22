# King Tide — Full Project Evaluation: Summary

> Evaluated 2026-08-22 · six independent perspectives, each adversarially fact-checked
> against the codebase before publication.

This is the roll-up of a full-project evaluation performed from six perspectives,
each written as its own document:

| Perspective | Document | One-line verdict |
|---|---|---|
| Engineering | [engineering.md](engineering.md) | Unusually strong architecture, mechanically enforced; the biggest gates are paper |
| Game Design | [game-design.md](game-design.md) | Coherent hero-mechanic vision; discovery, demonstration, and reward aren't connected to it yet |
| Art | [art.md](art.md) | The painterly-vinyl direction is real in-engine; the proof-of-thesis cup is 2-of-3 dressed and the legibility layer is built-but-off |
| Audio | [audio.md](audio.md) | Excellent plumbing, milestone-sketch soundscape; one licensing landmine |
| Networking | [networking.md](networking.md) | Disciplined transform replication; combat, finishes, and jitter behavior are not on the wire |
| Security | [security.md](security.md) | Honest, proportionate posture; integrity gaps are documented by design, CI hardening is the cheapest real win |

## Method

Each perspective was evaluated by a dedicated reviewer with full repo access, briefed
on the project's known documentation traps (assets live in R2, not git; v1-historical
docs describe cut features; only `check-and-build` + `docs` gate in CI; `status: 'ship'`
means wired, not art-complete). Every document was then passed to an independent
adversarial fact-checker that re-verified the concrete claims — file paths, line
references, counts, feature states — against the source and corrected the document in
place before it was accepted. Across the six documents, roughly 240 claims were
spot-checked and 38 corrections applied. The Engineering review also ran the local
gates on this machine: `pnpm typecheck` clean, `pnpm lint` exit 0 (1,358 warnings),
`pnpm test` 1451/1451 passing (6 asset-dependent tests correctly skipping unhydrated).

Each document ends with that perspective's **top 10 fixes ranked by importance**. This
summary ends with a **cross-perspective top 10 ranked by impact to the player**.

## The verdict in one paragraph

King Tide is a real game with a defended identity, built on foundations most solo
projects never reach: a mechanically-enforced Three-free deterministic sim, maximal-strict
TypeScript with zero suppressions across ~93.5k lines, design docs the code actually
obeys, an art direction that exists as shipped runtime code rather than moodboards, and
a multiplayer stack whose review findings verifiably got fixed. The consistent failure
mode — visible from every single perspective — is the **last mile**: systems get built
to a high standard and then aren't connected to the player. The tutorial exists but is
unreachable from the menu; the AI is graded on a mechanic it never performs; the
signature skill pays worse than its alternative; the legibility grade and signal layer
are implemented and enabled nowhere; the ambience system, coverage tooling, song-skip,
and two-tab e2e all exist with zero callers. The work ahead is less about building new
systems than about flipping the switches on the ones already built — and finishing the
one track (Container Chaos) that currently breaks the mode the whole v2 bet is about.

## What each perspective found

### Engineering — [engineering.md](engineering.md)

The documented architecture is real and enforced by tests, not convention: a
sim-purity-guard bans Three imports, `Math.random`, wall clocks, and mutable-settings
singletons from the sim layer, and it passes. The determinism design (seeded RNG, sorted
store serialization, golden-compare harness) is excellent — but its only physics-level
enforcement lives in e2e specs that CI has never run and cannot run (no GPU on GitHub
runners; the R2 hydration secret has never been set), while a maintainer push to `main`
can bypass every check and is simultaneously a production deploy. Code-health risk is
concentrated: `water.ts` is a 5,838-line god-module holding 55 of the repo's 73
`as any` escapes, and the boot monoliths (`game-loop.ts` 2,615 / `race-boot.ts` 2,118
lines) are where recent playtest bugs actually landed yet have near-zero direct tests.
**Their #1:** stand up a Node-side determinism golden in Vitest — real Rapier WASM
already runs in unit tests and the golden track is procedural, so the project's biggest
paper gate could become a real PR gate in about a day.

### Game Design — [game-design.md](game-design.md)

One defended hero mechanic (motocross-style wave mastery), written anti-targets the
code obeys, and secondary systems (three-tier drift, slope-aware tuck, geometric trick
windows) that match their design docs with rare fidelity. Four gaps undercut it: the
tutorial became unreachable from the normal menu flow on 2026-08-21 with no first-run
funnel; the AI still performs the cut v1 pump and never pitches landings or spends its
boost meter, so rivals never model the signature skill; the reward economy lets a free
drift out-earn a perfect graded jump; and the proof-of-thesis cup fails its own 8-bike
completion gate on Container Chaos, whose track data also ships zero pickups, pads, and
wave zones. **Their #1:** reopen a discoverable path to the tutorial for new players.

### Art — [art.md](art.md)

The painterly-vinyl bible is implemented as a shipped runtime layer — TF2 warp-ramp
lighting on by default, shared vinyl material with scanned-oil brushwork, world-space
waterline bands, a "Regatta" UI matching its doc hex-for-hex — with exemplary
AI-content licensing hygiene. Content honesty is enforced in data (dressed/greybox
badges, `VISIBLE_CUPS` filtered to Reef). The gaps: the Reef Cup closer still reads
generic greybox (Table Mountain off-palette, Cape Wheel behind the start line, summit
terrain stalling the AI field), the contrast-budget grade and the entire
style-as-legibility signal layer are built but enabled nowhere players see them, and the
look has zero automated regression coverage — it rests on one person's eyeball on one
Windows machine that also holds all external art sources. **Their #1:** finish Cape Town
Drift — identity landmarks on the sightline, summit re-graded, art pass to dressed.

### Audio — [audio.md](audio.md)

The plumbing is excellent: a correct four-bus mixer, sidechain ducking the streamed
soundtrack inherits for free, a memory-smart jukebox with per-venue playlists, and
unusually thorough autoplay/unlock handling. The soundscape is milestone-sketch quality:
every SFX is a single-oscillator or filtered-noise stub, all five bikes share one engine
voice, there is zero positional audio (an AI mine 300 m away plays at full volume;
rival engines are silent), and the finish line, results, menus, and crashes are mute.
The soundtrack ships without loudness normalization, and one FMA track ("Hawaii 5-0")
likely covers a copyrighted composition the CC license cannot clear. **Their #1:**
loudness-normalize the soundtrack in the convert pipeline — the cheapest change with
the biggest audible payoff.

### Networking — [networking.md](networking.md)

An unusually disciplined transform-replication stack: stateless slot-stamped relay,
storage-backed race lock that survives Durable-Object recycles, owner-authoritative
20 Hz quantized snapshots, tenure-based host election — all round-trip unit tested. The
ceiling is what is *not* on the wire: combat and pickups are per-tab fiction ("I hit
him and nothing happened" is the first thing two humans with items experience), race
results are computed per-tab so close finishes can permanently disagree, the
arrival-time interpolator degrades to freeze-then-snap under real jitter, and the
±327.67 m snapshot position format is a lit fuse against the very maps being dressed
now. **Their #1:** widen the snapshot position range before a Reef Cup map outgrows it.

### Security — [security.md](security.md)

Modest but honest: the leaderboard threat model names its own gaps. The one
load-bearing weakness is by design — the HMAC secret ships in the client bundle, so
"signed" score submissions are forgeable within plausibility bounds, with reactive
moderation as the real defence. A hostile multiplayer peer can impersonate the AI host
or another rider (binary frames trust a self-declared sender id). XSS surface is
well-contained; the dev track-writer is correctly build-excluded; secrets hygiene is
clean. The sharpest real-world exposure is CI: no workflow scopes `GITHUB_TOKEN`, and
the Steam-release job holds credentials while running mutable-tag third-party actions.
**Their #1:** stop implying the global leaderboard is tamper-proof; keep reactive
moderation sharp.

## Cross-cutting themes

Five patterns showed up independently in multiple reviews:

1. **Built-but-unwired.** The tutorial (unreachable), the AI's boost meter (never
   spent), `sky.scenicGrade` (authored nowhere), the `?signals=1` legibility layer
   (default off), the per-venue `AudioConfig` ambience system (zero content),
   `nextSong()` (zero callers), coverage reporting (never run), the two-tab e2e (never
   in CI). The project's discipline in building infrastructure is not yet matched by a
   discipline of *shipping* it.
2. **The paper-gate problem.** Engineering, Art, Audio, and Networking each
   independently concluded that the thing players actually experience — sim feel, the
   look, audible output, cross-tab sync — has no automated regression net, because the
   suites that would catch it need a GPU or bytes CI doesn't have. Every perspective
   converged on cheap partial fixes: a Node-side determinism golden, a screenshot-diff
   baseline, an AnalyserNode silence watchdog, a GPU-free relay integration suite.
3. **The hero mechanic isn't yet the center of the experience.** Wave mastery is
   undiscoverable (tutorial hidden), undemonstrated (AI never does it), under-rewarded
   (pays worse than drift), under-showcased (no swell-forward stretch in the visible
   lineup), and acoustically diluted (its chord fires for free boost pads). Five
   different top-10 items from three perspectives are really one theme.
4. **Trust surfaces drifting stale.** Venue cards promising the wrong lap count or a
   cut set-piece, README claiming the two-tab probe doesn't exist (it has since June),
   v1-register art docs seeding wrong concept passes, "2 of 3 dressed" following every
   trailer. Small individually; collectively the exact "stale promise" class the
   project's own playtest called its biggest trust break.
5. **Solo-maintainer single points of failure.** A zero-check push path that is also a
   production deploy; every art source resolving to one Windows box; an unexecuted
   disaster-recovery checklist; `enforce_admins` off. All reasonable for one person —
   all worth one hardening pass before a second contributor or a bigger audience arrives.

## Overall top 10 — ranked by impact to the player

Picked from the six perspectives' sixty ranked items, ordered by how much each one
changes what a player actually experiences (severity × how many players hit it × how
often). Attribution notes the source perspective and that document's own rank.

1. **Reopen a discoverable path to the tutorial** *(Game Design #1).* Since the
   2026-08-21 menu rework, a new player's first minute is an ungraded race with a
   signature mechanic the code itself treats as undiscoverable — the tutorial hides
   behind Settings → "Replay tutorial" and a URL param, and `tutorialCompleted` gates
   nothing. Every single new player hits this, in the minute that decides whether they
   stay. Route first boot into First Run or add a one-time "NEW HERE?" card.

2. **Finish Container Chaos end-to-end — un-jam the field, fill the data, land the
   identity** *(Game Design #3 and #7 + Art #1 — one venue, one work package).* The
   closer of the proof-of-thesis cup currently: stalls the 8-bike AI field at the
   Table Mountain summit (the field-completion spec is `test.fixme`'d pending a terrain
   re-grade), ships **zero** pickups, boost pads, and wave zones (versus 4/1/1 and
   9/3/1 on its siblings), and reads "generic bright ocean" with its landmarks
   off-palette or behind the start line. Every Cup-mode player ends their championship
   on the track that breaks the fantasy three different ways.

3. **Rebalance the skill economy so wave mastery out-earns drift** *(Game Design #4).*
   A free UMT pays 1.95× automatically; a perfect launch+landing pays roughly a third
   of that after an extra button press, and the graded takeoff pays nothing. Players
   optimize what pays — today the game's stated hero skill is its worst-paying skill,
   so lap times are won on corners, not waves. This one change re-aims the entire loop.

4. **Teach the AI the signature loop it's graded on** *(Game Design #2).* Rivals still
   perform the cut v1 pump, never pitch a landing, and never spend the boost meter the
   launch-grade system pays them. Players learn kart mechanics by watching rivals;
   until the AI demonstrates wave mastery, the hero mechanic reads as optional flair
   even on Hard — and fix #3's rebalanced reward has no on-screen role model.

5. **Give opponents acoustic presence — distance-attenuated SFX and rival engine
   voices** *(Audio #2).* No panner or distance gain exists anywhere in `src/`: a mine
   300 m away detonates at full volume with zero direction, and a rival on your tail is
   silent. Racing blind behind you is a core arcade sensation the game simply doesn't
   have, in every race, for every player.

6. **Decide the multiplayer combat story now — sync items or disable them in rooms**
   *(Networking #2).* Pickups and weapons are per-tab fiction; a missile hit on a
   remote rider applies a local impulse their kinematic mirror ignores and the owner
   never learns about. "I hit him and nothing happened" is the first thing any two
   humans with items experience. The honest fix (no items in multiplayer rooms) is a
   day; the real fix is the biggest outstanding multiplayer feature.

7. **Fix the rider and bike character assets** *(Art #5).* Four riding animations are
   byte-copies of a chair-sit idle and one bike seats the rider a metre high; runtime
   guards hide only the worst of it. This defect sits at the centre of the frame in
   every race, every replay, every podium — the single most-seen asset problem in the
   game.

8. **Widen the snapshot position range before a dressed map outgrows ±327.67 m**
   *(Networking #1).* The int16 format silently clamps in production — remote bikes pin
   to the world boundary — and the encoder's own comment names Mexico City and Cape
   Town as maps that can exceed it, guarded only by a dev-console warning. The maps
   are being dressed right now; when the fuse burns down, multiplayer breaks totally
   on exactly the tracks the game is betting on.

9. **Loudness-normalize the soundtrack** *(Audio #1).* Fourteen tracks from ten
   artists ship at whatever master FMA had; players ride the volume slider between
   songs and the carefully-tuned duck depths mean something different under every
   track. A two-pass loudnorm in `tools/convert-music.mjs` plus one re-run of
   `pnpm gen:music` fixes every session of every player at near-zero cost.

10. **Score the finish** *(Audio #3).* The emotional peak of every race — the finish
    line, the results screen, the podium — is currently the least-scored moment in the
    game: the final lap ends on the same arpeggio as lap 2 and the results screen is
    mute. A position-aware stinger and a real countdown give every race an ending
    players can feel.

### Near misses

Five items that just missed the cut, kept here because they head their own documents'
lists: the **Node-side determinism golden** (Engineering #1 — the highest-leverage
*protective* fix on the board: it keeps a rapier-0.20-class feel regression from ever
reaching players, about a day of work); **owner-authoritative finish claims**
(Networking #3 — a 200 ms close race can currently crown two winners);
**leaderboard integrity honesty** (Security #1 — the top-25 is forgeable by design;
keep moderation sharp and never label it "verified"); the **lobby connect time-box**
(Networking #6 — a shared room link during a relay outage is an infinite spinner);
and **authoring the contrast budget** (Art #2 — the legibility keystone is wired,
validated, and used by zero tracks; two JSON lines per track from being real).

## Reading order suggestion

For the maintainer: [game-design.md](game-design.md) and [art.md](art.md) first (they
describe the next month of content work), then [networking.md](networking.md) before
any multiplayer push, [audio.md](audio.md) before the first trailer (item #5 there is
a licensing gate, not a polish item), [engineering.md](engineering.md) for the CI/test
investments that make the rest safe, and [security.md](security.md) before widening
write access or going commercial.
