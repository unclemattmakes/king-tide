# Hoverbike — v1 Work Breakdown

> Execution plan companion to [design-targets.md](./design-targets.md) (the
> *what* and *why*) and [track-themes.md](./track-themes.md) (the *world*).
> This doc is the *how*: scaffolding-first phased work, per-domain task
> inventory, and a done-criteria convention that forces every system to
> declare its surface area before shipping.

## Convention — definition of done

A system is "done" when **all three** are true:

1. It **functions correctly** in gameplay.
2. It has a **settings-menu entry** exposing its tunable parameters (where
   applicable).
3. The corresponding **menu/HUD element is enabled** (no longer in the
   disabled-pending state).

This forces every system to declare its player-facing surface area before
it can be marked complete, and means every milestone produces visible payoff
for the player (a button lights up, a slider becomes meaningful, a HUD
widget appears).

Applied concretely (✅ = shipped, ⬜ = pending):

| System | Functional | Settings entry | UI gate cleared |
|---|---|---|---|
| Audio | ✅ four-bus mix (master/music/SFX/ambient) + procedural music bed + ducking | ✅ master / music / SFX / ambient sliders + music-enabled toggle | ✅ settings → audio category enabled |
| Anti-grav | ✅ controller flips, geometry rideable | ✅ gameplay → anti-grav camera intensity (Full/Reduced/Off) | ✅ HUD indicator shown on entry |
| AI | ✅ 3 difficulties baked per-AI + rubber-band gated by toggle | ✅ gameplay → AI difficulty (Casual/Standard/Hard) + rubber-band assist toggle | ✅ both controls active |
| Wave-pump signal | ✅ triggers on successful pump *(heuristic — upgrades when pump physics ship)* | ✅ gameplay → wave-pump prompt intensity (full/subtle/off) | ✅ HUD widget visible |
| Tutorial | ✅ track-agnostic framework — director + script + HUD widget | ✅ gameplay → subtitles toggle + replay tutorial button | ✅ menu mode-tile active |
| Cup mode | ✅ placeholder cup chains 3 dev tracks → points table → cup-results overlay | n/a — reuses existing AI difficulty + rubber-band gameplay rows; ship cups will add their own when they unlock | ✅ Dev Placeholder Cup tile active; ship cups stay gated on their tracks |
| Time Trial | ✅ solo vs clock + best-lap ghost (single-lap slice, looped per lap) | _N/A — mode is its own surface; no per-system tunable yet_ | ✅ menu mode-tile active; finish overlay shows GHOST SAVED on PB |
| Multiplayer | ⬜ room codes route | ⬜ settings → network region / latency display | ⬜ MP menu button active |
| Leaderboard | ⬜ submission works | ⬜ settings → submit times toggle | ⬜ leaderboard view populates |
| Input / controls | ⬜ rebinding works | ⬜ controls → rebind + deadzone + sensitivity | ⬜ input config flow active |

---

## Step 0 — Scaffolding (the empty cathedral)

Build the entire UI flow with every screen present but most content disabled.
Every subsequent feature ends with "and enable button X" as its acceptance
criterion. The game's full shape is visible from day one; progress is legible
as buttons go gray → active.

### Menu surfaces to stub upfront

- Main menu shell with mode-select tiles (Race / Time Trial / Cup /
  Multiplayer / Tutorial — most disabled at first)
- Track-select screen showing all **12** tiles (current ship-quality tracks
  active; the rest gray with name + post-flood landmark hint)
- Bike-select screen with **5** slots (3 active today, 2 "Coming soon")
- Cup-select screen with **4** cup tiles (all disabled initially)
- Pre-race options panel — track preview placeholder, laps override, AI
  count override
- Pause menu — resume, restart, return to menu
- Post-race finish overlay — slots for cup points, time-trial best-lap
  save, leaderboard prompt (all inert until those systems ship)
- Loading screen template — track art placeholder + landmark blurb
- Tutorial intro/skip screen
- Multiplayer lobby + room-code UI (inert; mode button disabled)
- Leaderboard view (empty state)

### Settings menu — all categories present with skeleton controls

The settings menu is the **inventory of every tunable in the game.** All
categories appear from day one; individual controls become active as their
systems land.

- **Audio:** master / music / SFX / ambient sliders
- **Video:** resolution, vsync, framerate cap, render quality, motion-
  sickness reduction
- **Controls:** rebinding, gamepad sensitivity, deadzone
- **Gameplay:** difficulty selector, rubber-band toggle, camera FOV, HUD
  toggles, subtitles, wave-pump prompt intensity, anti-grav camera
  intensity, replay tutorial, leaderboard submission toggle

### HUD scaffolding — stub-then-fill

- Wave-pump indicator widget slot (hidden until system lands)
- Anti-grav entry indicator slot
- Wave-line shimmer overlay slot
- Cup-points banner slot
- 8-bike-grid position list (current 5 expandable to 8)

### Disabled-state visual convention

Single grayed look used across the entire app, with a tooltip on hover that
explains the gate:

- "Available when 5 tracks are complete"
- "Multiplayer ships in M17"
- "Cup mode unlocks once Time Trial is in"

The convention is locked in Step 0 so every later screen reuses it. No
designer should ever invent a second "this thing isn't ready yet" look.

### Outcome

The cathedral exists, mostly empty. A new playthrough sees the full game
shape. Subsequent milestones light it up.

---

## Phased plan

| Step | Milestones | Outcome | Status |
|---|---|---|---|
| **0. Scaffolding** | M11 (pre-foundation) | Full menu flow stubbed; settings categories present; HUD slots reserved; disabled-state convention locked. | ✅ landed |
| **1. Foundation systems** | M11–M12 | Anti-grav, wave-pump signal, tutorial framework, AI difficulty, music integration. Each lights up its settings entry and HUD widget. | ✅ 5/5 — wave-pump signal + AI difficulty/rubber-band + anti-grav surface + tutorial framework + audio mixer/music bed all landed |
| **2. Track production sprint 1** | M13 | Sandbar (tutorial), South Beach, Hatteras, The Maw, Cape Town. Reef Cup + the hero track. Track-select tiles activate one by one. | ⬜ |
| **3. Track production sprint 2** | M14 | Shibuya, Kilauea, Marina Bay, Doge's. Open Sea + Continental cups. | ⬜ |
| **4. Track production sprint 3** | M15 | Aqualand, Angkor, Liberty. Drowned Cup; finale. | ⬜ |
| **5. Audio integration** | M14–M16 (parallel with tracks) | License/commission music per region as tracks land. | ⬜ |
| **6. Modes** | M16 | Time Trial + Cup wiring + leaderboard backend. Mode buttons activate. | 🟡 Time Trial + ghost recording shipped, cup wiring landed via Dev Placeholder Cup; leaderboard backend still pending |
| **7. MP completion** | M10.x → M17 | Room-code finalization, lobby UI, 8-bike stability. | 🟡 in flight (M10.12 lobby + state sync shipped) |
| **8. Polish / QA** | M17–M18 | Perf, accessibility, cross-browser. | ⬜ |
| **9. Pre-launch** | M18 | Trailer, landing, marketing copy, deployment. | ⬜ |

See [implementation-plan.md](./implementation-plan.md) for the canonical
milestone schedule; the steps above slot into it.

## Shipping log

| Date | Step | PR | Notes |
|---|---|---|---|
| 2026-05-17 | Step 0 — Scaffolding | [#110](https://github.com/occ-matt/hoverbike/pull/110) | Full menu cathedral (mode/cup/track/bike/settings/HUD) shipped with disabled-state convention locked. Test maps moved into a dev-only Dev Cup so the four real race cups stay clean. |
| 2026-05-17 | Step 1 — Wave-pump signal | [#111](https://github.com/occ-matt/hoverbike/pull/111) | Heuristic crest-launch detector → HUD widget + audio chord. Gameplay → Wave-pump prompt (Full/Subtle/Off) wired and persisted. Trigger upgrades when pump physics tuning lands; event contract is stable. |
| 2026-05-18 | Step 1 — AI difficulty + rubber-band toggle | _pending PR_ | Three-tier per-AI tuning bundle (top-speed factor / lateral-accel ceiling / curvature lookahead / rubber-band bounds) baked into the controller at spawn time. Rubber-band system gates on the live toggle so flipping it mid-race settles AI back to its baseline rather than snapping. Gameplay → AI difficulty + Rubber-band assist rows lit. |
| 2026-05-18 | Step 1 — Anti-grav HUD + camera intensity | _pending PR_ | Player-facing surface for the already-shipped anti-grav physics + authoring: magenta-glow HUD indicator binds to the reserved `#hud-anti-grav` slot and fades in with `AntiGravOverride.weight`; chase camera grows a `setAntiGravFollow(weight)` blend between yaw-only (default) and full bike-frame follow so loops actually invert the view. Gameplay → Anti-grav camera intensity (Full / Reduced / Off) row lit and scales the camera follow weight, leaving the HUD signal always-on (motion-sickness players still need the affordance). |
| 2026-05-18 | Step 1 — Tutorial framework (track-agnostic) | _pending PR_ | Director (`src/engine/tutorial/`) drives a script of beats — each beat pairs a player-facing prompt (mechanic name + one-line hint) with a `clearWhen` predicate evaluated against per-frame sample. Default 6-beat script clears on throttle / sustained speed / camera-look / wave-pump / anti-grav / finish — no Sandbar dependency, runs on any track. Top-centered yellow HUD chyron flashes green on clears, settles to green "GOOD RIDE" on completion (~2.5s fade). URL param `?tutorial=1` activates it; the menu's Tutorial mode tile + Settings → "Replay tutorial" button both route through `buildReplayTutorialHref`. Subtitles toggle hides the hint line; the chyron itself stays. First clean completion latches `tutorialCompleted=true` so the buttons re-label to "REPLAY". |
| 2026-05-18 | Step 1 — Audio mixer + music bed | _pending PR_ | Four-bus rewrite of `AudioEngine`: `sources → music \| sfx \| ambient → master → destination`, each bus a GainNode driven by `playerSettings.audio<Bus>Volume × BUS_HEADROOM[bus]`. Existing one-shots routed to SFX, water rumble to Ambient, leaving Music as a new procedural pad bed (three-voice sine drone with tremolo LFO — stand-in for the licensed/commissioned drop later in M11–12). New `duckMusic(amount, recoverSeconds)` sidechain helper auto-fires on wave-pump (0.35 + 0.3 × strength dip) and explosion (0.7 dip) so cues cut through. Settings → Audio rows for all four sliders + a "music bed enabled" toggle wired through a new `audio-service` singleton so the overlay can reach the live engine without a prop-drill from `main.ts`. **Closes Foundation Systems at 5/5.** |
| 2026-05-18 | Time Trial mode + ghost recording | _pending PR_ | Mode tile + flow: `?race=1&track=…&bike=…&tt=1` routes through a TT-aware menu (mode tile lit, sp-cup-tracks reused with Dev Cup as the source, sp-bike picker, race start). `spawnBikes` gains `aiCount` (TT passes 0) + `ghostVariant`. `createBike({ ghost: true })` mints a render-only entity (no RigidBody, no Racer/AI/Peer/PickupSlot tags) — bike-render swaps in a translucent cyan material when it sees `GhostTag`. New `src/engine/replay/best-lap-slice.ts` extracts the player's fastest lap from the recording's `lap` events (recorder.recordEvent finally wired in `main.ts`) and re-bases timestamps to t=0. New `src/engine/replay/ghost-state.ts` persists single-lap ghosts to localStorage keyed by (trackId, bikeId). New `src/game/systems/ghost-runner.ts` drives the ghost Transform off the player's current lap time (not wall clock) so the ghost is a real pacing target; seeks to t=0 when the player crosses the line, freezes at end pose when the ghost finishes first. Finish overlay reads as TIME TRIAL with a "★ GHOST SAVED" pill on every new PB; RETRY is the default focus, NEXT hidden. 354/354 unit tests passing (19 new — 7 ghost-state, 6 best-lap-slice, 6 ghost-runner). |
| 2026-05-18 | Step 6 — Cup wiring (placeholder) | _pending PR_ | New dev-only **Dev Placeholder Cup** strings `lagoon → cliffside → big-bay` into a real 3-race championship so cup-mode wiring is exercised before any of the four ship cups have tracks. New `src/engine/cup-progress.ts` owns the sessionStorage-backed cup state (cup id, bike, race lineup, per-race results) plus an MK8 / F1 style point curve (15/12/10/9/8/7/6/5/4/3/2/1). `?cup=<id>` on the race URL toggles cup mode in the game loop; the finish overlay rewrites NEXT to "NEXT RACE (n/m)" mid-cup and "CUP RESULTS →" on the last race, with a compact `CUP STANDING · n/m · X PTS THIS RACE · Y TOTAL` row added to the stat block. New `#cup-results` overlay (CSS + DOM in `index.html`, renderer in `src/engine/render/cup-results-screen.ts`) shows a per-race points table + champion banner. RETRY mid-cup restarts the current race while preserving cup-progress (results swap by trackId, pointer never un-skips); EXIT (finish-screen + pause-menu) always clears cup-progress. Cup-tracks screen split: browse Dev Cup keeps its tile-as-launcher behavior; championship-shaped cups (placeholder + future ship cups, which are pre-wired with `races: shipCupRaces(id)`) render inert preview tiles plus a START CUP CTA. No new settings row — cup mode reuses AI difficulty + rubber-band assist; ship cups will revisit when they unlock. |

---

## Domain inventory

Priority tags (P0/P1/P2) match [design-targets.md](./design-targets.md).

### Tracks (12 total)

Each track needs the full pipeline: layout block-out → set-piece geometry →
environment art → skybox/lighting → AI racing line → spawn/checkpoint/
itembox placement → audio palette → track-specific music. Full content
specs in [track-themes.md](./track-themes.md).

- **Sandbar** — tutorial, new, scripted gate scenarios (P0)
- **South Beach Sunken** — rework Lagoon, ~2× length, Versace seaplane set-piece (P0)
- **Hatteras Light** — rework Cliffside, add anti-grav lighthouse corkscrew (P0)
- **Cape Town Drift** — new, Two Oceans Aquarium wreck (P0)
- **The Maw** — new, wave-mastery hero, all-ocean (P0)
- **Shibuya Submerged** — new, partial anti-grav on Cocoon Tower face (P0)
- **Kilauea Crown** — new, heavy anti-grav caldera loop, lava waterfall (P0)
- **Marina Bay 7** — new, gantry-crane container timer (P1)
- **Doge's Drift** — new, anti-grav up Campanile (P1)
- **Aqualand** — new, 5-lap chaos, tsunami pool-wave timer (P1)
- **Angkor Drowned** — new, heavy anti-grav central spire (P1)
- **Liberty Drowned** — new, finale, broken-torch-arm anti-grav showcase (P1)

### Systems — gameplay

- Wave-pumping HUD signal — boost-bar flash + audio cue on successful pump (P0)
- **Anti-grav system** — controller orientation flip, trigger volumes,
  entry/exit VFX, visual indicator (P0)
- AI difficulty slider (Casual / Standard / Hard) + rubber-band toggle (P0)
- Tutorial framework — scripted prompts, scenario gating, skip toggle (P0)
- Race-line / wave-line guidance — extend existing arrow to surface-shimmer
  over pumpable waves (P0)
- 8-bike grid support — scale current 5 → 8 (P0)
- Ghost recording / playback (for Time Trial) (P1)
- Cup / championship state — points table, race progression, end-of-cup
  summary (P1)
- Music system integration — loading, ducking on wave-pump SFX, finish-
  overlay carry-through (P0)
- Leaderboard backend — single-table KV-backed, anonymous handle entry (P1)
- Photo / replay mode (P1)

### Systems — physics / sim

- Wave physics tuning — make pumping feel rewarding, swell timing legible
- Anti-grav physics (depends on system above)
- Wave-aware AI behavior — when to pump, especially on Hard difficulty
- 8-bike multiplayer state sync polish (M10.x continuation, in flight)

### Assets — bikes

- 2 new bike variants (3 → 5 total)
- Per-variant wave-pump feel tuned (heavy = punishing timing, light =
  forgiving + further launch)
- Bike-select thumbnails / silhouettes

### Assets — environment kits (modular, reusable)

- Drowned-urban — Doge's, Shibuya, Liberty surrounds, Marina Bay
- Drowned-tropical — South Beach, Cape Town, Aqualand
- Volcanic — Kilauea
- Jungle / temple — Angkor
- Coastal — Hatteras, The Maw
- Tutorial — minimal Sandbar set

### Assets — VFX

- Wave-pump particle flash (the signature signal) (P0)
- Anti-grav entry / exit transitions (P0)
- Big-drop landing splash + water displacement
- Lava + steam plumes (Kilauea)
- Lighthouse rotating beam (Hatteras)
- Neon glow + wet-asphalt reflections (Shibuya)
- Crane shadow + container swing (Marina Bay)
- Campanile bell swing + ripple (Doge's)
- Tsunami pool surge (Aqualand)
- Torch flame + copper-oxidation shimmer (Liberty)
- Jungle dappled-light + insect motes (Angkor)
- Versace seaplane ramp + South Beach palm sway

### Assets — audio

- **12 track-specific music pieces** (~3 min each), license-first per
  design-targets (P0)
- Wave-pump SFX with positive-feedback layer (P0)
- Splash SFX bank (impact / glide / spray)
- Per-track ambient beds — gulls, foghorn, neon hum, jungle, traffic, lava
  grumble, crane creak, church bell, pool PA, harbor sloshing, palm rustle
- UI SFX — select / confirm / race-start / position-change stinger /
  finish-line swell
- Race-start countdown
- Tutorial voice prompts or text callouts (optional, captioned per
  accessibility)

### UI — menus

(All present in Step 0 scaffolding; populated as systems land.)

- Main menu shell
- Mode select — Race / Time Trial / Cup / Multiplayer / Tutorial
- Track select with **drowned-world map view** — cup grouping spatially
  placed on a global map (a real differentiator vs. flat grids)
- Bike select
- Settings — audio / video / controls / gameplay sub-pages
- Cup selection screen
- Race options panel — laps override, AI count override

### UI — in-race HUD

- Wave-pump signal indicator (P0)
- Wave-line guidance shimmer overlay (P0)
- Anti-grav entry indicator (P0)
- Lap / position / boost / item slot (exist; polish for 8-bike)
- Minimap — open question; keep, drop, or replace with on-track arrow

### UI — race flow

- Loading screen with track art + landmark blurb
- Pre-race grid scene
- Race-start countdown
- Mid-race pause menu
- Post-race finish overlay (exists; polish)
- Time Trial — best-lap save + ghost prompt (P1)
- Cup mode — inter-race points table (P1)
- Cup mode — cup-complete celebration (P1)

### UI — tutorial

- Scripted prompt component (P0)
- Mechanic-name callouts — "WAVE PUMP — hold X at the swell crest" (P0)
- Skip toggle for returning players (P0)

### UI — multiplayer

- Room creation (host) — generate + display code (P1)
- Room code entry (join)
- Lobby — player list, ready states, AI fill toggle
- Connection / latency indicator
- Disconnect handling

### UI — leaderboards & social

- Time Trial leaderboard view (per track, top-N) (P1)
- Optional handle entry for anonymous leaderboard
- Personal-best banner

### Modes (wiring — systems above provide the parts)

- Race (exists; polish)
- Time Trial w/ ghost (new) (P1)
- Cup / Championship — 4 cups × 2–3 tracks (new) (P1)
- Tutorial — scripted single-track flow (new) (P0)
- Room-code Multiplayer — 4 peers + AI fill to 8 (M10.x → completion) (P1)

### AI

- Difficulty tuning per level (P0)
- Rubber-band coefficient gating per toggle (P0)
- Wave-pumping behavior on swells (P0)
- Anti-grav segment handling — must not fall off (P0)
- 8-bike racing stability — no traffic-jam pile-ups
- Per-track racing line authoring (P0, per track)

### Polish / QA

- Perf pass — 60 fps on M1 + Ryzen 5000 with 8-bike field on wave-heavy
  tracks
- Boot-to-first-race <5 s budget enforcement
- Cross-browser testing (Chrome, Safari, Firefox)
- Input rebinding (keyboard + gamepad)
- Touch overlay for mobile (P2)
- Colorblind mode — wave-pump signal must not rely on color alone
- Motion-sickness mitigation — chase-cam tuning during anti-grav
  inversion
- Subtitles for tutorial prompts
- Per-track asset streaming so the menu loads fast and tracks lazy-fetch

### Pre-launch

- Landing page
- Trailer — lead with The Maw + Liberty Drowned + Shibuya neon
- Screenshots — one per track minimum
- Marketing copy — **avoid "spiritual successor of" framing** (Pacer
  lesson from research)
- Web build deployment pipeline
- Analytics — first-race retention metric (per success metrics in
  design-targets)

---

## References

- [product-plan.md](./product-plan.md) — locked vision and pillars.
- [design-targets.md](./design-targets.md) — numeric targets, P0/P1/P2
  priorities, anti-targets.
- [track-themes.md](./track-themes.md) — 11 ship tracks + tutorial content
  bible, post-flood world frame.
- [implementation-plan.md](./implementation-plan.md) — canonical milestone
  schedule.
- [status.md](./status.md) — live build state.
- [research/overview.md](../research/overview.md) — racing-game research
  synthesis that drove the priority calls in design-targets.
