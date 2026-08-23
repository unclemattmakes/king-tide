> ⚠️ **READ FIRST — v2 status boundary (2026-06-04).** This file is the
> read-first **current state**; the running changelog is archived in
> [changelog-v1.md](changelog-v1.md), where everything is **v1-historical**.
> Since v1 we restarted content for **v2**, and three things in that archive no
> longer reflect reality:
>
> 1. **Anti-grav is cut** (parked for a possible future DLC). No shipped track
>    places anti-grav zones — every `antiGravZones` is empty. Entries that brag
>    about shipping anti-grav segments (Liberty / Angkor / Kilauea) are
>    v1-historical and were already untrue against the reset v2 track data.
> 2. **Content is mostly greybox for v2.** Only **Mayday Bay** (slug `sandbar`)
>    and **The Maw** are art-dressed; the other tracks were intentionally reset
>    to greybox route-stubs (PR #285) for the v2 art pass. "v1 lineup complete"
>    is a v1 statement, not a v2 one. *(South Beach Sunken / Miami was cut in the
>    2026-06 content pass; the Reef opener **Angel Basin** (slug `mexico-city`)
>    — a drowned highland capital on a returned lake bed — was rebuilt via the
>    Texcoco art pass and now ships, so the Reef Cup is ungated as of
>    2026-06-10.)*
> 3. **The soundtrack is 14 verified Creative-Commons tracks** (Free Music
>    Archive; mix of CC0 / CC BY / CC BY-SA / CC BY-NC — per-track licenses,
>    links and constraints in [CREDITS.md](../CREDITS.md)). Older entries
>    calling them "commissioned" / "licensed" / "CC0 placeholder" are stale.
>    The NC tracks are fine while the game is non-commercial; the SA tracks
>    must not be baked into published trailer videos.
>
> 4. **Venues are fictional cities, and display names diverge from slugs.**
>    The Reef Cup reads **Mayday Bay → Angel Basin → Container Chaos**; the
>    slugs behind them are `sandbar`, `mexico-city`, `cape-town-drift`. Real
>    place-names survive in the art docs as *reference* only. The shipping
>    menus also show **one cup** — `VISIBLE_CUPS` in
>    [tracks-catalog.ts](../src/engine/menus/tracks-catalog.ts) filters the
>    still-intact four-cup catalogue down to Reef (2026-08-20).
>
> Wave mastery has also pivoted to a motocross pitch-the-takeoff/landing model
> (the Mario-Kart fork), away from the press-forward-on-crest pump described
> below. See [CLAUDE.md](../CLAUDE.md) and [product-plan.md](./product-plan.md).

> **Where we are now (2026-06).** Racing mechanics are **in** and in
> **precision-tuning** — wave-mastery pitch model, drift mini-turbo, tricks, tuck,
> hover, AI; the remaining work is feel/legibility, not net-new systems. The
> Blender level tooling is **in** and ready for real level work (terrain,
> road/ramp/tunnel, downtown, wave zones, scatter, export). The current
> proof-of-thesis is making **shippable versions of the Reef Cup maps** —
> **Mayday Bay → Mexico City → Cape Town Drift** (see
> [reef-cup-vertical-slice-status.md](./reef-cup-vertical-slice-status.md)).
> Verify with **headed Playwright on your own dev server** (focused test scenes as
> needed), **not** the in-app preview — see CLAUDE.md hard rule 2.

> **Last updated: 2026-08-22** — **Evaluation top-10 implementation pass.**
> The six-perspective evaluation (PR #32,
> [evaluation/summary.md](evaluation/summary.md)) landed a player-impact
> top 10; this pass implements the code-tractable items:
> **(1) Practice mode** — a 4th PRACTICE tile (pre-focused with a NEW HERE?
> badge until `tutorialCompleted`), the reworked practice screen offering
> First Run + the new **practice lagoon** (`practice-lagoon`, JSON+primitive
> asset-light venue: stations in ride order — throttle/cruise straight, heavy
> swell LAUNCH lane, TRICK table, TUCK rollers, 345 m SMT drift sweep), an
> 8-beat station script via the new `script-catalog` (per-track scripts;
> sandbar First Run unchanged), new `notifyTuck`/best-launch-quality director
> channels. Doubles as the standing hard-rule-2 dev-test venue
> (`tests/e2e/practice-lagoon.spec.ts` runs unhydrated).
> **(2) Jump economy + takeoff sign fix** — the takeoff grader's ideal was
> `+0.24` rad, which in the `asin(-fwd.y)` convention is 14° **nose-down**;
> it now grades the true nose-up pop, and the landing edge pays a combined
> landing-dominant jump score (perfect jump 0.75 meter, out-earning one SMT)
> plus a clean-jump auto-vent burst — the hero skill finally out-pays drift
> per event. **Needs a headed feel pass** (numbers chosen against
> drift-tiers math, not playtested).
> **(3) AI wave mastery** — rivals shape takeoffs into the pop band
> (closed-loop), pitch landings toward the surface tangent
> (`decideAILandingPitch`), and vent the meter on straights
> (`decideAIVent`); Casual stays out, Standard demonstrates, Hard is the
> role model.
> **(4) Audio pass** — positional one-shots (distance gain + pan; AI
> ordnance no longer full-volume from anywhere), 2-voice rival engine pool,
> dedicated countdown ladder, position-aware finish stinger + podium cup
> fanfare (the `?podium` scene now installs the radio), boost ignition
> voice (wave-mastery chord reserved for graded reads), master limiter,
> shared noise buffer, and two-pass −14 LUFS loudnorm in `gen:music`
> (local opus regenerated; **`pnpm assets:push` after a listen is
> pending**).
> **(5) Multiplayer honesty** — snapshot positions widened to int32 behind
> tag `0x03` (±327.67 m fuse defused; legacy 0x02 still decodes), **no
> pickups in MP rooms** until M10.13 puts combat on the wire, lobby
> connect time-boxed at 10 s with a can't-reach-the-relay explainer, README
> two-tab-probe claim corrected.
> **(6) Trust + CI** — venue-card laps now pinned to track JSON
> (sandbar said 1, ran 3), Liberty's anti-grav copy replaced + tested
> against, track-themes real-world-place lock marked superseded;
> workflows run least-privilege `GITHUB_TOKEN` and third-party actions
> are SHA-pinned. Not attempted (not code-tractable from here): Container
> Chaos terrain/art + track data (needs the Blender re-grade first),
> rider/bike asset re-author, contrast-budget authoring (needs an eyeball
> pass).

> **2026-08-21** — **Menu backdrop: Mayday Bay at low tide,
> and a loading indicator instead of a concept-art plate.** The cold-boot
> menu / lobby backdrop ran the procedural `lagoon` dev fixture and papered
> over the attract boot with a painted AI concept-art plate
> (`/assets/ui/title-backdrop.jpg` + `body.backdrop-plate`) — which filled the
> backdrop and so read as the *finished* menu rather than a menu still
> loading. The plate is gone; in its place a corner chip ("LOADING VENUE",
> the boot screen's compositor-thread sweep so it keeps moving through a
> shader-compile stall) is up while the attract track loads and comes down
> when the feed goes live **or** when the attract boot gives up — new
> `AttractHandle.isFailed()`, so a machine that can never show the feed isn't
> left spinning. The backdrop venue is now **Mayday Bay** (`sandbar`), and
> attract mode applies that venue's authored water the way race-boot does
> (committed `water.look` at track scope — not the machine-wide lab store —
> plus bearing / set envelope / spectrum / wave zones / stamps / shore field;
> the track now loads *before* the water mesh so a per-track wave bank can
> land first). Two deliberate menu-only departures live in the new pure
> [attract-backdrop.ts](../src/boot/attract-backdrop.ts): the tide is **held
> at low water** (phase 0.75, clock never advanced — the exposed-sandbar read)
> and the sea state has a **Beaufort 4 floor**, which the cove's 0.5×
> wave-zone halves back to a slight chop so the backdrop isn't glass.
> Gates green (typecheck / lint / 1447 unit tests (+7 new) / build); the
> indicator lifecycle is covered by a new asset-independent e2e spec and was
> driven headless here. _Not verified: the look itself — this ran in a remote
> container with no GPU and an unhydrated `public/assets`, so the low-tide
> silhouette and the chop want a **headed** eyeball on a pulled clone._
>
> ---
>
> **2026-08-19** — **First-session funnel + wave-mastery
> feedback pass ([PR #25](https://github.com/unclemattmakes/king-tide/pull/25),
> branch `claude/playtest-fixes`).** A three-hat playtest of the live build
> (PM / art director / first-time customer) produced a prioritized card; this
> pass executed it. Shipped: the Tutorial's First Run now teaches on **Mayday
> Bay** (was the greybox `lagoon` dev fixture) with a 2-bike casual escort, no
> placement board, and beats that celebrate only performed actions; the
> **wave-mastery loop is finally graded** — new `launch-grade.ts` sim system
> scores takeoff pitch + landing/surface match on the airborne edges, pays the
> boost meter (clean landing ≈ one trick), flashes a two-word verdict chyron,
> and the tutorial's new LAUNCH → LAND beats clear on those verdicts (E/Q
> named on screen at last); **respawn is a first-class rebindable action**
> (default Backspace — it was a hardcoded, invisible listener) that snaps to
> the nearest racing-line point, plus `stuck-rescue.ts` auto-rescue after
> ~2.5 s wedged or rider-ragdolled, and a fixed latent bug where any teleport
> instantly re-ejected the rider (crash-tracker Δv); menus take **arrow/WASD
> spatial navigation** + clickable breadcrumbs; playable greybox venues badge
> **"EARLY ROUTE · ART PASS COMING"**; Mayday Bay's intro plate now agrees
> with its card (**Reef Cup**, was "Tutorial Cup" — cross-catalog consistency
> test added); the **phantom ambience 404s are gone** (the opus files never
> existed — seed-script placeholders; refs removed, validator + a new QA
> asset-404 gate prevent recurrence); thruster/spray luminance capped under
> the contrast budget (signal FX untouched — wants a headed eyeball tune);
> lagoon ships an explicit sky (black-void fix); minimap YOU dot is
> unmistakable; boot time is now a per-cell QA budget that reaches
> qa-report.md; the standing-rider bug is code-guarded (its root causes are
> **asset** defects: four `Ride_*` clips are byte-copies of the chair-sit
> idle, and stunt's `socket_seat` is ~0.95 m too high — .blend re-author is
> the follow-up). Verified: typecheck / lint / 1440 unit tests (+9 new) /
> build / docs build green; headed Playwright on the affected specs
> (`boot.spec`'s 8 s ready tripwire fails locally on main too — ~9 s with
> CDN-served assets — pre-existing, left alone). **Corrected findings:** the
> start countdown already existed (hold-the-grid + F1 lights, May) — the
> playtest misread it through automation latency; and **The Maw's absence
> from the venue card is deliberate** (B-list parking, docs/tracks/the-maw.md)
> — CLAUDE.md now says so. _Deliberately not shipped: the warm-restart
> orchestrator (full seam list added to boot-overhaul-plan.md — a missed
> store means corrupted restarts; needs its own e2e), camera-fade through
> occluding props (needs a per-instance fade design vs. the instanced vinyl),
> and leaderboard seeding (production write — a human's call)._
>
> ---
>
> **2026-06-21** — **Levels: static collision is now clipped to
> the playable corridor (stop colliding out-of-bounds terrain).** Most of a
> dressed map's terrain is out of bounds — the OOB system leashes the bike to
> the racing line and kills it past 2.5× the corridor half-width, yet
> `attachTrackColliders` was building a Rapier trimesh for the WHOLE island
> (seabed + far hills the bike dies before touching), paying collider build +
> memory + the both-windings double for all of it. The loader now derives a
> corridor from the racing line + the OOB **hard-leash** and passes it to
> `attachTrackColliders`: per mesh, triangles whose nearest point is beyond
> `hard-leash + 60 m` (floored at 150 m) from the line are dropped, and a mesh
> entirely out of bounds gets **no collider**. Safe by construction — the
> cutoff is always strictly past the lethal wall, and the keep test is
> conservative by each triangle's longest edge, so it can never drop a triangle
> with any point inside the cutoff (proven headlessly: a Rapier ray cast down
> from every point within the hard leash still hits ground; far-OOB casts
> correctly miss). Visuals + the water heightmap are untouched (they read the
> render meshes, not the collider). New pure module
> [collision-corridor.ts](../src/engine/render/collision-corridor.ts) +
> [tests/unit/collision-corridor.test.ts](../tests/unit/collision-corridor.test.ts);
> `?clipcollision=0` restores collide-everything. Procedural tracks (lagoon,
> cliffside) and any lineless track are unaffected. Gates green
> (typecheck/test/lint/build); the load-time/memory **magnitude** wants a
> headed run on pulled assets to quantify (the safety property is the part
> proven here). Branch `claude/level-design-perf-ifx6t6`.
>
> _Investigated but **not** done, with reasons: a shadow "corridor" gate is
> redundant — the sun shadow is a ±90 m orthographic follow-box on the player
> ([scene.ts](../src/engine/render/scene.ts)), so three already frustum-culls
> far casters; the lap-1 compile-stream levers already shipped (async warm +
> `sizePerObject` vinyl sharing); props are already instanced entities, not
> level geo; and camera-based section streaming isn't justified by the measured
> profile (CPU/shadow-caster-bound, not draw-bound — see perf-baseline)._

---

Older v1 changelog archived in [changelog-v1.md](changelog-v1.md).
