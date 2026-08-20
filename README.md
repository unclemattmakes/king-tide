# Hoverbike

Web-first arcade hover-bike racer. JetMoto homage with Wave Race water physics and light Mario Kart combat. Three.js + WebGPU + Rapier WASM, gamepad-first.

**Live:** [kingtide.unclemattmakes.com](https://kingtide.unclemattmakes.com) — every push to `main` auto-deploys.

> **⚠ v2 status (2026-06).** "What's playable" below is the **v1** lineup;
> content restarted for **v2** since. Net corrections: `status: 'ship'` means
> wired/playable, **not** art-complete (only **Sandbar** + **The Maw** are
> dressed — the rest are greybox route-stubs); **anti-grav is cut** (parked for a
> possible DLC — no shipped track places zones, and the tutorial's `ANTI-GRAV`
> beat is parked with it); **wave mastery** is now a motocross *master-the-jump*
> model (pitch the takeoff/landing), not the press-forward-on-crest pump; the
> soundtrack is **14 verified Creative-Commons tracks** (FMA; per-track
> licenses + links in [CREDITS.md](CREDITS.md)). See
> [docs/status.md](docs/status.md) and [docs/product-plan.md](docs/product-plan.md).

- [Status](docs/status.md) — current state, controls, known issues, roadmap
- [Product plan](docs/product-plan.md) — vision + MVP scope
- [Implementation plan](docs/implementation-plan.md) — architecture + milestones
- [Architecture decisions](docs/adr/README.md) — ECS, sim/render split, WebGPU, Rapier
- [**Making a level**](docs/level-making.md) — **start here to build a track**: reading order, the pipeline end-to-end, the Blender↔editor export contract
- [In-app track editor](docs/track-editor-guide.md) — authoring gameplay data
- [Blender pipeline](docs/blender-pipeline-guide.md) — authoring environment geometry
- [Dev + modder docs site](docs-site/) — VitePress site (`pnpm docs:dev`), published at [kingtide-docs.unclemattmakes.com](https://kingtide-docs.unclemattmakes.com) — covering build, gameplay, asset pipeline, and reference
- [Making-of site](making-of/) — illustrated build log with playable 3D demos of the systems (wave field, buoyancy, feel tuning, drift, sim/render split, the Steam port). Ships with the game at `/making-of/`; reachable from the main menu and at [localhost:5191/making-of/](http://localhost:5191/making-of/) under `pnpm dev`
- [Contributing](CONTRIBUTING.md) — workflow, conventions, testing expectations
- [Cross-browser support](docs/cross-browser.md) — tier matrix + how to run `E2E_BROWSERS=all pnpm e2e`
- [Steam Deck tuning](docs/steam-deck.md) — Deck-specific runtime concerns (battery, framerate cap, Gaming Mode, profile detection)
- [Desktop builds](docs/desktop-builds.md) — Electron Linux + Windows pipeline, toolchain setup, CI matrix, Steam distribution

## Build targets

- **Web** — Chrome / Edge (tier 1), Firefox (tier 1), Safari iOS 18.2+ / macOS Sonoma+ (tier 2). See [`docs/cross-browser.md`](docs/cross-browser.md).
- **Linux** — Electron game tree via `pnpm build:deck`. Native execution on Steam Deck (no Proton), real Chromium WebGPU. See [`docs/desktop-builds.md`](docs/desktop-builds.md).
- **Windows** — Electron + NSIS `.exe` installer via `pnpm build:windows`. Bundled Chromium — no WebView2 dependency. See [`docs/desktop-builds.md`](docs/desktop-builds.md).
- **macOS** — deferred (no test hardware).

## What's playable

> The list below is the live **v2** state. A track's `status: 'ship'` means it is
> **wired + playable**, *not* art-complete — only **Mayday Bay** (the tutorial
> lagoon, slug `sandbar`) and **The Maw** are art-dressed; the rest are greybox
> route-stubs awaiting the v2 art pass.

- **Menu flow** — title → mode-select (Race / Time Trial / Cup / Multiplayer / Tutorial) → track / cup / lobby → bike-select → race. Full Settings overlay across Audio / Video / Controls / Gameplay / Accessibility / Network tabs.
- **Reef Cup — the v2 proof-of-thesis** — the current focus is shipping the three Reef Cup maps end to end: **Mayday Bay → Angel Basin → Container Chaos** (slugs `sandbar`, `mexico-city`, `cape-town-drift` — every venue is a fictional city, so display names and slugs diverge). Mayday Bay + The Maw are dressed; the rest are greybox route-stubs. Verify against this lineup with headed Playwright, not the in-app preview. See [`docs/track-themes.md`](docs/track-themes.md) for the content bible and [`docs/tracks/`](docs/tracks/README.md) for per-track design docs.
- **Multiple cups planned** — the eventual structure groups the city maps into cups; treat any "Reef → Harbor → Continental → Drowned" framing in older docs as **aspirational / future scope**, not the shipped set.
- **Five bike variants** — Cruiser / Racer / Stunt / Scout / Sparrow, one balanced class with distinct stat tradeoffs (`?bike=<id>`). Sparrow + Stunt are inside-drift archetypes (sport-bike feel — tighter initial cut, wider tail); the others are outside-drift (default stable arc).
- **Four pickups** — boost, shield, mine, homing missile (random pool)
- **AI opponents** with Casual / Standard / Hard difficulty + rubber-band toggle. AI hits the wave-pump where the wave zones tell it to (Standard at vy ≥ 1.5, Hard at vy ≥ 0.6) and drifts the sharp corners (Standard caps at SMT, Hard reaches UMT).
- **3-lap races + Cup mode** — championship with MK8-style points + cup-results screen
- **Time Trial mode** with self-overwriting best-lap ghost per (track, bike); **global leaderboard** via PartyKit Party with HMAC-signed submissions + per-track top-25 + moderation CLI
- **Wave-mastery loop** — the signature mechanic: a motocross *master-the-jump* model (pitch the takeoff/landing over the wave), **not** a press-forward-on-crest pump. The loop is graded live: `launchGradeSystem` scores the takeoff pitch at the pop and the nose-vs-surface match at touchdown, pays the boost meter (a clean landing ≈ one trick), and announces the verdict on a two-word HUD chyron (CLEAN LAUNCH / STOMPED IT / CASED IT — honors the wave-FX intensity setting).
- **Drift mini-turbo** — Mario-Kart-style 3-tier mini-turbo: hold Z (or LB) + steer left, or hold C (or RB) + steer right; release fires the tier 1/2/3 boost (blue MT / orange SMT / purple UMT). Surface-type registry (ice / sand / metal / default) layers grip variation. **Drift Practice Range** dev track (`?track=drift-test`) walks every tier. Full design + tuning in [`docs/drift-deep-dive.md`](docs/drift-deep-dive.md).
- **Tricks** — geometric pop-based window that arms off lips / ramp crests / sandbars / ledges / embankments via per-end hover contact flags. 200 ms pre-press buffer holds a button mashed mid-climb.
- **Tuck sweet-spot** — snowboarder's nose-down sweet spot folded into the existing pitch-down gesture (no dedicated button); `#hud-tuck` accuracy meter + cyan slipstream VFX scale with sweet-spot proximity.
- **Multiplayer** — `?room=<id>` lobby with smash-bros pick + ready states + sticky raceStarted bit for late joiners; host-elected AI sync, 20 Hz transform snapshots, live RTT readout, in-race HUD chip with peer slot + ping
- **Best-lap save state** per (track, bike) in localStorage + ghost replay
- **Tutorial framework** — track-agnostic beat director, seven beats: THROTTLE → CRUISE → LOOK → **LAUNCH → LAND** (the wave-mastery pair, teaching E/Q pitch off the launch-grade verdicts) → DRIFT → READY (`?tutorial=1`). First Run defaults to **Mayday Bay** with a 2-bike casual escort and no placement board; beats celebrate only performed actions (a timed-out beat advances with a neutral flash). *(Anti-grav is cut from races — parked for a possible future DLC — so there is no anti-grav tutorial beat.)*
- **Procedural audio** — four-bus mixer (master / music / sfx / ambient) + sidechain duck on pump/explosion + drift skid loop + per-tier release whoosh + procedural music pad bed (fallback under the CC-licensed FMA soundtrack — see [CREDITS.md](CREDITS.md))
- **Accessibility** — colorblind palettes (deuteranopia / protanopia / tritanopia), reduced flash, large text, high contrast, motion-sickness reduction, screen-shake intensity, subtitles always on
- **Rider editor** — `?rideredit=1` opens a turntable where each rider bone can be reshaped (primitives + colours + seated pose). Load / Save / Export.
- **In-app track editor** — `?edit=1` opens a TransformControls editor over the JSON track snapshot; gates / pickups / boost pads / spline points placeable + drag-manipulable; Save writes back via a dev-only Vite middleware

## Develop

Prerequisites: **Node ≥ 20**, **pnpm ≥ 10** (`engines` in `package.json`). A
WebGPU-capable browser (recent Chrome / Edge) gives the best feel; Firefox
runs the WebGL2 fallback.

**First, get the assets.** The compiled content — track/bike/prop GLBs,
textures, the soundtrack — is not in this repo; it's served from a public CDN
(see [docs/asset-storage.md](docs/asset-storage.md)). Copy the example env and
the app streams it all at runtime:

```bash
cp .env.example .env      # sets VITE_ASSET_BASE_URL to the public asset CDN
```

Skip this and the app boots to **"Boot failed"** — it'll be looking for assets
in a `public/` directory that a fresh clone doesn't have. (Maintainers with
bucket credentials can `pnpm assets:pull` for a local copy instead.)

```bash
pnpm install
pnpm dev          # http://localhost:5191
pnpm typecheck
pnpm lint                          # biome check .
pnpm format                        # biome format --write .
pnpm test         # unit (Vitest), sim layer only

pnpm e2e:install  # one-time: pulls Playwright Chromium
pnpm e2e          # end-to-end (Playwright, real Vite + WebGPU/WebGL2)

pnpm docs:dev     # http://localhost:5173 — VitePress dev/modder docs site
pnpm docs:build   # → docs-site/.vitepress/dist
```

Try `pnpm dev` then open http://localhost:5191/?track=sandbar&bike=stunt for a quick spin on Mayday Bay (the tutorial lagoon).

### Multiplayer dev

Multiplayer rides on a PartyKit relay (`party/relay.ts`). For local
two-tab testing, run the relay alongside the dev server:

```bash
pnpm party:dev    # PartyKit on http://127.0.0.1:1999
pnpm dev          # in another terminal
```

Open two tabs at `http://localhost:5191/?room=test` and the lobby will
match-make them. Without `pnpm party:dev`, `?room=` will fail to
connect — single-player works fine without it.

### Asset pipeline (optional)

Authoring bikes, props, or tracks needs **Blender 5.1**. Linux / macOS /
Windows are all fine; set `BLENDER_EXE` if Blender isn't on your `PATH`.
See [`docs/blender-pipeline-guide.md`](docs/blender-pipeline-guide.md) and
[`docs/asset-pipeline-guide.md`](docs/asset-pipeline-guide.md).

```bash
pnpm gen:bikes    # build bike GLBs from specs/bikes/*.json
pnpm gen:props    # build prop GLBs from specs/props/*.json
pnpm gen:tracks   # build track GLBs from specs/tracks/*.json
pnpm gen:all      # all of the above + manifest
```

You don't need Blender to work on code — only to author assets.

### Troubleshooting

- **bitECS schema changes**: hard-reload (Ctrl/Cmd+Shift+R) — stale
  bitECS state in the page can cause cryptic errors.
- **WebGPU not available**: Firefox runs the WebGL2 fallback automatically;
  on Chrome, check `chrome://gpu/` if performance is unexpectedly bad.
- **`pnpm e2e` is slow / flaky**: it needs a real GPU. Headless software
  rendering throttles the water shader. Locally, the suite runs headed by
  default for that reason — see [`playwright.config.ts`](playwright.config.ts).

## Deploy

The repo backs **two** Vercel projects, both pointing at the same GitHub repo, both auto-deploying on push to `main`.

| Project | Root Directory | Build settings | Notes |
|---|---|---|---|
| **Game** | `.` (repo root) | defaults — `pnpm build` → `dist/` | The existing live build. |
| **Docs** | `docs-site` | comes from [`docs-site/vercel.json`](docs-site/vercel.json) | VitePress build. Configures `installCommand`, `buildCommand`, `outputDirectory` itself. |

### One-time setup for the docs project

In the Vercel dashboard (team `oddballcreatureclubs-projects`):

1. **Add New → Project**, import the `unclemattmakes/king-tide` repo.
2. In the import screen, set **Root Directory** to `docs-site`. Leave Framework Preset as auto-detect (it will pick VitePress from `vercel.json`).
3. The dashboard's Build Command, Output Directory, and Install Command are overridden by `docs-site/vercel.json` — leave them at defaults.
4. **Deploy.** First build runs `cd .. && pnpm install --frozen-lockfile` then `cd .. && pnpm docs:build`, output reads from `docs-site/.vitepress/dist`.

After that, every push to `main` triggers a docs rebuild alongside the game rebuild. The docs project gets its own `*.vercel.app` URL; assign a custom domain (e.g. `docs.<yourdomain>`) when ready.

### Why two projects, not one?

Vercel projects bind to a single Build Command + Output Directory. The game and the docs have different ones, so they live in separate projects. They share the repo, the lockfile, and the `node_modules` install — `cd ..` in the docs `vercel.json` reaches up to the workspace root.

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict, exactOptionalPropertyTypes) |
| Build | Vite |
| Renderer | Three.js, WebGPU-first with WebGL2 fallback |
| Physics | `@dimforge/rapier3d-compat` (deterministic build) |
| ECS | bitECS 0.4 with side-table data stores |
| Audio | Web Audio API, procedurally synthesised (no SFX assets) |
| Test | Vitest (unit, sim-only) + Playwright (e2e via real dev server) |
| Lint/format | Biome |
| Hosting | Vercel push-to-deploy |

## Architecture rule

**Sim layer cannot import Three.js.** Anything under `src/engine/sim/` or `src/game/systems/` must be Three-free. Render systems read from the ECS world and write to Three.js objects, never the other way around. This unlocks headless tests, deterministic replays, and future rollback netcode.

See [`docs/adr/`](docs/adr/README.md) for the full set of architecture decisions.

## Known issues

- **AI on vertical/elevated terrain** — AI racers can jam where the race line climbs sharply or hugs raised terrain (gates floating above the surface, crosswise gate facing). Fixes are per-track level-design work; the full 8-bike field is now guarded for the Reef Cup tracks by `tests/e2e/field-completion.spec.ts` (runs by default). Player-only races and human multiplayer are unaffected.
- **Multiplayer e2e coverage** — M10.11 transform-snapshot sync is covered by unit tests + manual playtest; a two-tab Playwright probe is not yet automated. Bugs that only manifest cross-tab need to be reproduced manually.
- **Leaderboard submits signed outside JS fail as `bad-signature`** — the HMAC covers a canonical string built with JavaScript's `Number.prototype.toString()`, so `40.0` serialises as `"40"`, not `"40.0"`. A client in another language that formats floats its own way produces a valid-looking signature the server rejects, and the error names the signature rather than the number. Bit us while probing from Python. Full rules + a worked example in [`docs/leaderboard-backend.md`](docs/leaderboard-backend.md#signing-a-submission).

## License

Split licensing — see [NOTICE](NOTICE) for the one-page summary.

- **Code** — [MIT](LICENSE).
- **Game content** — art, tracks, audio, and everything served from the asset
  CDN (`public/assets/`, `public/audio/`, at any git revision) is **not** under
  the MIT code license; see [CONTENT-LICENSE.md](CONTENT-LICENSE.md). Third-party
  and AI-generated content is itemised in [CREDITS.md](CREDITS.md).
- **Name & logo** — "King Tide" (and the working title "Hoverbike") identify this
  project and aren't licensed for reuse; forks should ship under their own name.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for workflow, branch conventions, commit style, testing expectations, and architecture rules contributors must respect. Security issues: [`SECURITY.md`](SECURITY.md).
