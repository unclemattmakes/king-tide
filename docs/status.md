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
>    2026-06 content pass; the Reef opener **Mexico City** (slug `mexico-city`)
>    — drowned, on the old Lake Texcoco bed — was rebuilt via the Texcoco art
>    pass and now ships, so the Reef Cup is ungated as of 2026-06-10.)*
> 3. **The soundtrack is 14 verified Creative-Commons tracks** (Free Music
>    Archive; mix of CC0 / CC BY / CC BY-SA / CC BY-NC — per-track licenses,
>    links and constraints in [CREDITS.md](../CREDITS.md)). Older entries
>    calling them "commissioned" / "licensed" / "CC0 placeholder" are stale.
>    The NC tracks are fine while the game is non-commercial; the SA tracks
>    must not be baked into published trailer videos.
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

> **Last updated: 2026-06-21** — **Levels: static collision is now clipped to
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
