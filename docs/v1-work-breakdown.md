# Hoverbike — v1 Work Breakdown

> Execution plan companion to [design-targets.md](./design-targets.md) (the
> *what* and *why*) and [track-themes.md](./track-themes.md) (the *world*).
> This doc is the *how*: scaffolding-first phased work, per-domain task
> inventory, and a done-criteria convention that forces every system to
> declare its surface area before shipping.

## Convention — definition of done

A system is "done" when **all four** are true:

1. It **functions correctly** in gameplay.
2. It has a **settings-menu entry** exposing its tunable parameters (where
   applicable).
3. The corresponding **menu/HUD element is enabled** (no longer in the
   disabled-pending state).
4. Any **interactive surface it adds is navigable by keyboard, controller,
   and touch** — not just mouse. See the
   [input-navigability convention](#convention--input-navigability) below.

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
| Wave-line shimmer | ✅ 3D forward-looking glow markers over rising swell ahead of the player; scored from `sampleSurface().vy` | ✅ gameplay → wave-line guidance (Full / Subtle / Off) | ✅ HUD pip visible + 3D shimmer in-world |
| Tutorial | ✅ track-agnostic framework — director + script + HUD widget | ✅ gameplay → subtitles toggle + replay tutorial button | ✅ menu mode-tile active |
| Cup mode | ✅ placeholder cup chains 3 dev tracks → points table → cup-results overlay; same wiring runs all four ship cups now that every v1 track is `status: 'ship'` | n/a — reuses existing AI difficulty + rubber-band gameplay rows | ✅ all four ship cups (Reef / Open Sea / Continental / Drowned) tiles active; Dev Placeholder Cup retained as the wiring fixture |
| Time Trial | ✅ solo vs clock + best-lap ghost (single-lap slice, looped per lap) | _N/A — mode is its own surface; no per-system tunable yet_ | ✅ menu mode-tile active; finish overlay shows GHOST SAVED on PB |
| Multiplayer | ✅ room-code route end-to-end — `/?room=<id>` opens lobby (per-peer bike/track picks, ready toggles, smash-bros track vote, sticky raceStarted bit for late joiners) → race; PartyKit relay broadcasts InputFrames + TransformSnapshots + lobby control messages | ✅ Settings → Network tab — region (AUTO · CLOUDFLARE EDGE / DEV (LOCAL)) + endpoint + live connection state + room + smoothed RTT latency readout (1 Hz ping/pong) | ✅ MP mode tile lit; in-race `#hud-room` chip shows room id + peer slot + host mark + live ping; lobby header shows live PING; reconnecting state distinguished from initial connecting |
| Leaderboard | ✅ TT PB → local cache + HMAC-signed POST to PartyKit `leaderboard` Party (deduped by handle; profanity / plausibility / rate-limit / replay-nonce gated) | ✅ gameplay → submit-times toggle + leaderboard-handle text row; inline initials prompt on first PB | ✅ menu → LEADERBOARDS opens two-pane track list + top-10 table; GLOBAL / LOCAL ONLY badge per track; admin moderation via `pnpm leaderboard:moderate` |
| Input / controls | ✅ keyboard rebind (swap semantics) + gamepad fire/boost rebind | ✅ controls → rebind keyboard / rebind gamepad / sensitivity / deadzone / invert-Y | ✅ all five Controls rows lit |
| Accessibility | ✅ colorblind palette / reduced flash / large text / high contrast / motion-sickness reduction / screen-shake intensity / subtitles always on | ✅ Accessibility tab with 8 rows lit | ✅ Settings → Accessibility category visible |
| Drift mini-turbo | ✅ MK-style mini-turbo: hold Z/LB or C/RB + steer into corner → tier 1/2/3 charge (0.6 / 1.4 / 2.4 s) → release fires 1.45× / 1.75× / 1.95× boost. Lateral drag drops to 35%, auto-turn-in bias + counter-steer authority shape the arc. Inside-drift archetypes (Sparrow, Stunt) get a 250 ms initial-cut spike. AI hits SMT on Standard / UMT on Hard. | ✅ gameplay → "Drift assist" (Full / Subtle / Off) gates sparks + audio + HUD + camera roll | ✅ HUD tier badge alongside boost meter; colored sparks at outside-rear corner; DRIFT tutorial beat between WAVE PUMP and ANTI-GRAV |
| Tricks (geometric pop) | ✅ window arms when nose lifts off terrain (lip / ramp crest / sandbar / ledge / embankment) while base stays grounded — replaces the old vertical-velocity gate. Per-end contact flags + 200 ms pre-press buffer let the press land even if it's mashed before the pop. | n/a — no per-system tunable beyond the gameplay/audio mixes | ✅ trick prompt + trick effect on press |
| Tuck sweet-spot | ✅ snowboarder nose-down sweet spot folded into the existing pitch-down (no dedicated button). Sweet spot at lean = 0.8 of full deflection caps top-speed ×1.15 + drag ×0.5; over-tuck inverts the factor + drops ride height (belly scrape). | ✅ gameplay → "Tuck slipstream VFX" (Full / Subtle / Off) + "Tuck meter" toggle | ✅ `#hud-tuck` meter + cyan slipstream particle pool |
| Surface-type registry | ✅ per-collider lateral-grip multiplier — default 1.0, asphalt 1.0, metal 1.25, sand 0.70, ice 0.35, water 1.0 (neutral — water owns its own feel). Authored via JSON `Prop.surface` + GLB `surface` userData. Affects both normal driving and drift so each surface feels coherent. | n/a — surface choice is per-collider authoring | 🟡 runtime + sync test in place; Blender authoring UI is the remaining follow-up |
| Desktop builds | ✅ Electron wrapper bundles its own Chromium (real WebGPU inside the Steam Linux Runtime, where the prior Tauri/WebKitGTK shell was stuck on WebGL2). `pnpm build:deck` (Linux tree) + `pnpm build:windows` (NSIS installer + tree). Steam-Deck-specific patches: launch wrapper, `--no-zygote`, Vulkan/ANGLE flags gated to Linux. | n/a — non-gameplay system | ✅ Perf HUD surfaces render backend + GPU driver + Deck-profile status |
| Making-of microsite | ✅ Six-chapter Vite multi-page bundle at `/making-of/` — Wave Field, Buoyancy, Tuning the Feel, The Drift, Sim vs Render, Porting to Steam. Demos import the real sim (`tuck-curve.ts`, `drift-tiers.ts`) so they can't drift from shipped code. | n/a | ✅ main menu → PICK YOUR FORMAT → MAKING OF |

---

## Convention — input navigability

Every interactive surface — menu screen, overlay, modal, results card —
must be reachable **and** operable by **keyboard, controller, and touch**
before it counts as done. "It works with a mouse" is not done. This is the
input-side mirror of the disabled-state and definition-of-done conventions:
locked once so no new screen reinvents (or silently drops) it. The recurring
regression this prevents shipped in [PR #200](https://github.com/occ-matt/hoverbike/pull/200)
(post-race + stacked overlays un-navigable on a pad).

**Controller.** Gamepad menu nav comes from one place:
`installMenuGamepad({ container, isActive?, onBack? })` in
[src/engine/input/menu-gamepad.ts](../src/engine/input/menu-gamepad.ts) —
it polls the pad and translates d-pad → focus move, A → click, B → `onBack`.
A surface is pad-navigable **only if a poller's `container()` resolves to
its DOM.** A new overlay with no poller is a dead end on a controller (the
bug class that started this convention).

Two pitfalls, both regression-pinned in
[tests/unit/menu-gamepad.test.ts](../tests/unit/menu-gamepad.test.ts):

1. **Two live pollers fight.** When overlay B opens *over* layer A and both
   keep polling the same pad, they tug-of-war over focus — the A press never
   lands a clean click and the d-pad can't advance. The layer underneath must
   **park** while a higher overlay is up: gate its `isActive` with
   `isAnyOverlayShown('settings-menu', 'rebind-menu', …)`. For an overlay
   that stacks over another (cup-results over finish), prefer **one** poller
   whose `container()` returns whichever is on top — never a second poller.
2. **The touch overlay overlaps.** The in-race touch UI (`#touch-ui`, z-index
   100, [src/engine/input/touch.ts](../src/engine/input/touch.ts)) sits above
   every menu card. Any surface that can appear **during or after a race**
   must drop it by adding a body class — `menu-active`, `paused-for-menu`, or
   `touch-ui-hidden` — or the joystick / face buttons intercept taps meant for
   its buttons.

Checklist for a new interactive surface:

- [ ] An `installMenuGamepad` poller targets it (or an existing topmost-container
      poller already covers it).
- [ ] If it stacks over a poller-bearing layer, that layer parks via
      `isActive` / `isAnyOverlayShown`, or the two share one topmost-container
      poller.
- [ ] Esc/keyboard and gamepad B both have a back/exit path.
- [ ] If it can show during/after a race, it sets a touch-hiding body class.
- [ ] Walk it on a real controller and a touch device (the manual
      navigability rows in [qa-playbook.md](./qa-playbook.md)).

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
| **1+. Feel pass** | M11–M18 (rolling) | Gameplay-mechanic additions that extend the foundation: drift mini-turbo, geometric pop-based tricks, tuck sweet-spot, per-collider surface registry, hover polish (dive/release-kick + spring curves + yaw-coupling fix). Each follows the same definition-of-done convention. | ✅ drift + tricks + tuck + hover polish all live; surface registry runtime in place (Blender authoring UI pending). |
| **2. Track production sprint 1** | M13 | Reef Cup — Sandbar (tutorial), South Beach, Hatteras, Cape Town. Track-select tiles activate one by one. | ✅ 4/4 — Sandbar / South Beach Sunken / Hatteras Light / Cape Town Drift all build + export end-to-end via `pnpm seed:track-<id>` (GLB + JSON + hero/thumb JPGs shipped); all four flipped to `status: 'ship'`. The Maw (originally penciled here as the hero track) moved to Sprint 2 with the rest of the Open Sea set. |
| **3. Track production sprint 2** | M14 | The Maw + Shibuya, Kilauea, Marina Bay, Doge's. Open Sea + Continental cups. | ✅ 5/5 — Phase D Sprint 2 shipped The Maw / Shibuya Submerged / Kilauea Crown / Marina Bay 7 / Doge's Drift end-to-end; all five `status: 'ship'`; both cup tiles lit. Authored by five parallel agents in worktrees, integrated sequentially. |
| **4. Track production sprint 3** | M15 | Aqualand, Angkor, Liberty. Drowned Cup; finale. | ✅ 3/3 — Phase E Sprint 3 shipped Aqualand / Angkor Drowned / Liberty Drowned. **v1 lineup complete (12/12 tracks `status: 'ship'`).** Drowned Cup tile lit; Liberty's silhouette under `nyc_sunset` is v1's last shot. |
| **5. Audio integration** | M14–M16 (parallel with tracks) | License/commission music per region as tracks land. | 🟡 procedural pad bed shipped on the music bus in Foundation Systems (intentional stand-in; `setMusicEnabled(false)` is a one-liner away from a swap). Licensed/commissioned per-region drops still pending. |
| **6. Modes** | M16 | Time Trial + Cup wiring + leaderboard backend. Mode buttons activate. | ✅ Time Trial + ghost recording, cup wiring (Dev Placeholder Cup), leaderboard local+global w/ HMAC-signed PartyKit Party + moderation CLI |
| **7. MP completion** | M10.x → M17 | Room-code finalization, lobby UI, 8-bike stability. | ✅ Room codes, lobby with picks + ready, smash-bros pick, lobby latency readout, sticky race-started for late joiners, Settings → Network tab, in-race HUD chip with live ping + reconnect labelling, mp-status pub/sub. Stability work continues per the 8-bike target (M10.13+). |
| **8. Polish / QA** | M17–M18 | Perf, accessibility, cross-browser. | 🟡 QA tooling (`pnpm qa` orchestrator + matrix + soak + bug-bundle + playbook + non-blocking CI), Perf HUD + perf-recorder + render-backend + GPU-driver + Deck-profile diagnostics, Accessibility tab (8 rows lit incl. colorblind palettes + reduced flash + screen-shake), cross-browser Playwright projects (chromium/firefox/webkit gated by `E2E_BROWSERS`), Steam Deck profile + Electron desktop wrapper (Linux tree + Windows NSIS, real WebGPU on Deck — replaced an earlier Tauri/WebKitGTK shell that couldn't launch inside the Steam Linux Runtime), input-navigability convention locked (post-race + stacked overlays controller/touch-navigable, PR #200), water LOD + cross-fade + Gerstner skirt + reflection fixes, mobile MENU button + touch HUD, six-chapter making-of microsite. Perf-budget pass against the 60 fps / 8-bike target, colorblind palette playtest, and per-track asset streaming still pending. |
| **9. Pre-launch** | M18 | Trailer, landing, marketing copy, deployment. | ⬜ |

See [implementation-plan.md](./implementation-plan.md) for the canonical
milestone schedule; the steps above slot into it.

## Shipping log

| Date | Step | PR | Notes |
|---|---|---|---|
| 2026-05-28 | Hover yaw-coupling fix — no nose pull along lateral slopes | [#221](https://github.com/occ-matt/hoverbike/pull/221) | The bike's yaw response had a sneaky term that coupled to the lateral-slope component of the ground normal — cornering across a bank dragged the nose along the slope direction, so a hairpin on Cape Town Drift's harbour bank felt like the wheel was sliding off the apex even when the rider was holding a clean line. Commit `20a5547` kills the coupling outright; yaw is now decoupled from the lateral roll target. Independent of the M9.4 kinematic roll lock (that fix kept roll from accumulating from misaligned-axis math; this one stops yaw from being pulled by a real ground-normal component). |
| 2026-05-27 | Blender scatter — `EXT_mesh_gpu_instancing` end-to-end | [#220](https://github.com/occ-matt/hoverbike/pull/220) | The scatter pipeline was emitting palm/rock empties at export but not actually packing the per-instance transforms into the glTF extension, so the runtime was loading empty placeholders. Fix lands the extension write-out so an Angkor jungle now ships a couple hundred ferns per zone instead of nothing. Companion fix: stamp `is_modifier=True` on modifier-level Geometry Nodes groups so the scatter modifier finds them on .blend open (#222). |
| 2026-05-27 | Rider editor — primitives + colours + seated pose | [#217](https://github.com/occ-matt/hoverbike/pull/217) | `?rideredit=1` opens a turntable scene where each rider bone can be reshaped (capsule / box / sphere / cylinder / cone), recoloured, and the seated pose adjusted (per-joint angles + seat rotation). Live preview, Load / Save / Export. Persistence in localStorage. The shipped defaults read from [rider-appearance.ts](../src/engine/render/rider-appearance.ts); the in-race [rider-pose.ts](../src/game/systems/rider-pose.ts) reads the same `RIDER_POSE_TUNING` object the editor writes, so a pose change is one reload away from the racing rider. New `rider-mesh.ts` builds any primitive from a height/radius extent; head box keeps a visor. Sister fix [#218] auto-upgrades `mat_terrain_main` on .blend open so legacy worlds pick up the latest terrain shader without manual material work. |
| 2026-05-26 | Steam Deck — Linux Steam depot dropped, Windows-only depot | [#210](https://github.com/occ-matt/hoverbike/pull/210) | The Linux Steam depot was duplicating work — Proton plays the Windows build on the Deck just fine and the Tauri→Electron port already routed Linux + Windows hosts through a single build script. Dropping the Linux depot collapses the upload to a single SteamPipe pass and means the Deck always gets the same binary Windows users do, eliminating one cross-platform skew vector. |
| 2026-05-26 | Steam Deck — Linux Runtime survival kit | _multiple commits_ | The Tauri/WebKitGTK shell didn't even launch inside the Steam Linux Runtime on the Deck. The Electron port (#205) fixed the WebGPU-in-WebKitGTK problem but introduced its own runtime-container issues: a `--no-zygote` flag is now required to clear the sniper namespace crash (5a49c24); `--enable-unsafe-webgpu` + `--use-angle=vulkan` must be gated to Linux only (Windows-on-Proton black-screens with the ANGLE/Vulkan flag — d9ca85e, 6ea4743, 9ce0874, 8b3cefe); bundled `libwayland-*` had to be stripped from the AppImage (Wayland EGL abort — 6f36a06); a launch wrapper script (`electron/hoverbike-launch.sh` — dbf20f4) sets up the runtime so all of the above can compose. The perf HUD now surfaces backend + GPU + Deck-profile so triage doesn't need a console (b1a77c0). |
| 2026-05-26 | Electron desktop wrapper — replaces Tauri | [#205](https://github.com/occ-matt/hoverbike/pull/205) | The Tauri/WebKitGTK shell never got out of WebGL2 fallback on Linux (WebKitGTK doesn't ship WebGPU), and worse, it didn't launch inside the Steam Linux Runtime on the Deck at all — Steam refused to route to it. The Electron port bundles its own Chromium so the game runs in the runtime container and gets *real* WebGPU. Build path: `pnpm build:deck` (Linux tree, any Linux host or WSL), `pnpm build:windows` (NSIS installer + tree, Windows host or Linux/WSL with wine for the stamp), `pnpm electron:run` (quick local). Outputs `dist-electron/linux-unpacked/` (Linux game tree, binary: `hoverbike`), `dist-electron/win-unpacked/` (Windows tree, `Hoverbike.exe`), and `dist-electron/Hoverbike-<version>-setup.exe` (NSIS installer). The `src-tauri/` tree is gone; `tauri.conf.json` + Cargo bits don't bake into the wrapper anymore. macOS deliberately deferred (would need a Mac for testing). Full doc in [`docs/desktop-builds.md`](./desktop-builds.md). |
| 2026-05-26 | Making-of microsite — six chapters | _multiple PRs (85e622a / f33dbb9 / 0aadf85 / 4583b7a / f045096 / bbc3c9e)_ | Six illustrated chapters with playable Three.js demos that import the *real* sim modules so they can't drift from shipped code. Chapters: Wave Mastery (the Gerstner field), Hover & Buoyancy (the four-probe footprint), Tuning the Feel (the tuck sweet-spot curve — drove the [tuck-curve.ts](../src/game/systems/tuck-curve.ts) pure-leaf extraction), The Drift (Mario-Kart-tier thresholds + boost multipliers — drove the [drift-tiers.ts](../src/game/systems/drift-tiers.ts) extraction), Sim vs Render (a two-clocks interpolation demo), Porting to Steam (the Tauri → Electron port, with a live WebGPU/WebGL2 capability probe + the launch-through-Steam ordeal). Ships at `/making-of/` from the same Vite multi-page build and is linked from the main menu (PICK YOUR FORMAT → MAKING OF). Chapter pages live in `/making-of/<chapter>/` with each chapter's interactive demo importing from `src/game/systems/<system>.ts` directly. |
| 2026-05-26 | Drift mini-turbo — Mario-Kart-style with three tiers, archetypes, AI, tutorial, practice range | _multiple commits — 621f3c7, 8eefcab, c7dae86, f63d567, 3135b64, 9d566e9, f87407e, d4e3661, f338f5b, f02efe9, 59042e9_ | Hold Z (or LB) + steer left = drift left; hold C (or RB) + steer right = drift right; release fires the tier 1/2/3 mini-turbo (blue MT / orange SMT / purple UMT). Charge thresholds 0.6 / 1.4 / 2.4 s and boost multipliers 1.45× / 1.75× / 1.95× in pure-leaf [drift-tiers.ts](../src/game/systems/drift-tiers.ts). The drift system in [drift.ts](../src/game/systems/drift.ts) overloads the existing trick buttons (the small hop on a flat-ground press *is* the drift initiator tell — MK convention). Lateral drag drops to 35%, auto-turn-in bias (`DRIFT_YAW_BIAS_FRAC = 0.45`) + full-authority counter-steer (`DRIFT_STEER_FRAC = 0.65`) shape the arc — steering INTO the drift tightens, counter-steer OPENS. Low-speed bias taper (`DRIFT_YAW_SPEED_REF = 8 m/s`) kills the auto-rotate floor so a bleed-out drift doesn't spin 180°. Inside-drift archetypes (`driftStyle: 'inward'` — Sparrow, Stunt) get a 250 ms initial-cut spike (×1.2) then a wider tail (×0.8). HUD tier badge + colored sparks at the outside-rear corner + skid-loop + per-tier release whoosh + rider bank + 5/7/9° camera roll by tier + speed-lines on release. AI fires `decideAIDrift` on sharp upcoming corners (Standard caps at SMT on ≥ 0.033 1/m curvature, Hard reaches UMT on ≥ 0.020 1/m; Casual disabled). Tutorial gains a DRIFT beat between WAVE PUMP and ANTI-GRAV. **Drift Practice Range** dev track ([public/tracks/drift-test.json](../public/tracks/drift-test.json), `?track=drift-test`, surfaced in the Dev Cup picker) walks every tier through symmetric corners + a boost-pad merge + ICE/SAND patches. Settings → Gameplay → "Drift assist" (Full / Subtle / Off) gates sparks + audio + HUD + camera roll; the boost itself always fires so a frame-dropped whoosh never costs you the mini-turbo. Full design + tuning in [docs/drift-deep-dive.md](./drift-deep-dive.md). |
| 2026-05-26 | Surface-type registry — per-collider lateral grip | _commit 1f17f7a_ | New [`engine/sim/surface-types.ts`](../src/engine/sim/surface-types.ts) tags each static collider with a `SurfaceType` (default / asphalt / metal / sand / ice / water). The lateral-grip multiplier (default 1.0, asphalt 1.0, metal 1.25, sand 0.70, ice 0.35, water 1.0 — neutral, water owns its feel via the `isWater` branch in `hover.ts`) applies to BOTH normal driving and drift, so each surface feels coherent regardless of input. Authoring: JSON `Prop.surface` for prop colliders (props.ts tags at creation), GLB track meshes carry an optional `surface` userData extra (glb-track.ts validates against the enum, unknown values silently ignored). The hover center probe reads `hit.collider.handle` each tick, looks up the type, writes `HoverState.surfaceType`; the ground branch multiplies lateral drag by `surfaceGripMul(surfaceType)`. **Design guard:** every untagged collider stays byte-identical to pre-registry behaviour, so existing tracks read the same. The Drift Practice Range demonstrates: ICE on the west SMT sweep (extra-loose), SAND on the south ramp straight. Blender authoring UI for the GLB `surface` extra is the remaining follow-up. |
| 2026-05-25 | Tricks — geometric pop-based window | _commits f00b359, 24c7de8, 6e02ff0, 6eb75db_ | Replaces the old vertical-velocity gate. The window in [trick-hop.ts](../src/game/systems/trick-hop.ts) arms by the bike's *pose*, not by vy: the moment the bike leaves its planted stance — nose lifting off a lip / ramp crest while the base is still down, a clean takeoff, OR riding a meaningful slope at speed (a kicker up a ramp / sandbar, or a drop off a ledge / embankment) — the window opens and stays open the whole airtime. The bow/stern hover probes' chatter-debounced per-end contact flags (`HoverState.noseGrounded` / `baseGrounded`) make the pop a first-class signal so lips and crests register before the center probe would. Eligibility still requires the launch be surface-driven (not the bike's own courtesy hop — `hopLockoutActive`) and ridden with intent (speed ≥ `MIN_SPEED_FRAC` × top-speed, throttle ≥ `MIN_THROTTLE`); flat ground naturally rejects parked / coasting tricks. A 200 ms pre-press buffer holds a button mashed *before* the bike's nose pops so the press still lands when the window actually opens. Why geometry beats the old vy gate: lips, humps, and ramp crests pop the nose long before the *center* probe registers `isGrounded` false, so the old model simply never opened on most terrain features. |
| 2026-05-24 | Hover polish — dive kick, release kick, spring curves, climb-assist gate | _multiple commits — 916fa6e, 6bd1276, a6430fb, 2796372, ce61e54, cf11928, a445272, b62fc48, 72a5a21_ | A held nose-down lean (`intent.pitch < 0`) now follows a rate-limited dive-then-level curve in [hover.ts](../src/game/systems/hover.ts) (cf11928) — pitch climbs to a dive limit then settles back, so a deep tuck on water no longer flips the bike. On release, a brief `dive-kick` boost on the bow spring leads the recovery (b62fc48, a445272). Stern spring's boost-on-rise mirrors the bow curve so launches feel symmetric (ce61e54). Bow spring stiffness curve is soft at the top and stiff past 1.0 at the bottom (2796372). Air branch reverts to pure free physics — no PD (a6430fb). Initial pitch clamp + ride height drop (916fa6e, 6bd1276) kill water flips. Climb-assist (the small upward force that helps a forward-throttling bike crest a ramp) is now gated on forward throttle so coasting bikes don't ride uphill (72a5a21). |
| 2026-05-24 | Tuck sweet-spot — snowboarder lean folded into nose-down pitch | _commits d8ceb35, 17cc698, 0ccbc73, 24d454a_ | Snowboarder's downhill duck collapsed into the existing nose-down gesture (no dedicated button). `tuckFactor()` in [tuck-curve.ts](../src/game/systems/tuck-curve.ts) ramps 0→1 to `TUCK_SWEET_SPOT = 0.8`, then winds back through zero to `TUCK_SCRAPE_FLOOR = -0.5` at full deflection (where the dive-aid's ride-height drop has the belly already skimming the deck). Signed factor interpolates `tuckSpeedBoost` (cap ×1.15) and `tuckDragMul` (drag ×0.5) off 1.0 — feathered lean is fastest, burying inverts both. Grounded / over-water only (airborne pitch stays a free dive). VFX: cyan `tuckStream` slipstream pool ([fx/index.ts](../src/engine/render/fx/index.ts)) scales with positive factor (0ccbc73). Meter: `#hud-tuck` accuracy gauge ([tuck-hud.ts](../src/engine/render/tuck-hud.ts)) shows bar fill + sweet-spot notch + status word (`LEAN IN` / `SWEET!` / `EASE OFF` / `SCRAPING`) + live cap-bonus % (24d454a). Settings → Gameplay → "Tuck slipstream VFX" + "Tuck meter" gates both. |
| 2026-05-24 | Water LOD + cross-fade + Gerstner skirt | _commits 66fbb61, a18d97c, 4a19747, 2dbd15d, bb479bb, ca36d11, e809fa8, 6399851_ | The center water mesh now ships in two halves — inner detail + outer LOD tile — that cross-fade across their shared boundary so the seam doesn't read as a hard line (a18d97c). Far-rim skirt rides the Gerstner wave field instead of being a flat ring at z=0 (4a19747), so distant horizon water carries the same swell as foreground. Material fixes shipped alongside: outer + skirt sample a shared planar-reflection RT (bb479bb / 6399851 — no more two RTs fighting), reflection contribution fades to zero past 500 m (e809fa8), Fresnel sky tint picked up at grazing (2dbd15d), haze caps + Fresnel coefficient reconciled (ca36d11). Test track at [`public/tracks/water-test.json`](../public/tracks/water-test.json) has LOD markers + a colorize toggle (66fbb61). |
| 2026-05-25 | Step 8 — Controller/touch navigability for post-race + stacked overlays | [#200](https://github.com/occ-matt/hoverbike/pull/200) | Closes a recurring nav-gap class and locks the new [input-navigability convention](#convention--input-navigability) so future UI can't reopen it. The finish overlay + cup-results screen had **no** `installMenuGamepad` poller — a controller could only Start-to-exit, and the in-race touch UI (z-index 100) sat over the results buttons and ate taps. Root cause of the wider bug: a base-layer poller that keeps polling while an overlay opens on top tug-of-wars over focus (proved in the new harness), which silently broke controller nav for Settings-over-menu, Settings-over-pause, and Rebind-over-Settings; the Rebind modal and the multiplayer lobby had no poller at all. Fixes in [controls.ts](../src/boot/controls.ts) (one topmost-container poller for finish/cup-results gated on `finishShown`; `body.touch-ui-hidden` on finish), new `isAnyOverlayShown()` helper in [menu-gamepad.ts](../src/engine/input/menu-gamepad.ts) with base pollers ([menu-flow.ts](../src/engine/menus/menu-flow.ts), pause) parking while settings/rebind is up, the settings poller parking under rebind ([settings-overlay.ts](../src/engine/menus/settings-overlay.ts)), the rebind modal getting its own poller parked during button-capture ([rebind-modal.ts](../src/engine/menus/rebind-modal.ts)), and the MP lobby getting its own ([mp-lobby.ts](../src/engine/menus/mp-lobby.ts)). New `tests/unit/menu-gamepad.test.ts` (11 cases) pins the poller behaviour, the two-poller fight, and the gated-base fix; 829 unit tests green. Dev-only slider menus (dev-settings, water-debug) deliberately out of scope. |
| 2026-05-24 | Tuck — sweet-spot nose-down lean + slipstream VFX | _pending PR_ | Snowboarder's downhill duck, folded into the existing nose-down (pitch-forward) gesture rather than a dedicated button. `tuckFactor()` in [src/game/systems/hover.ts](../src/game/systems/hover.ts) maps the lean to a signed factor — ramps 0→1 to `TUCK_SWEET_SPOT = 0.8`, then winds back through zero to `TUCK_SCRAPE_FLOOR = -0.5` at full deflection (where the dive-aid's ride-height drop already has the belly skimming). The factor interpolates `tuckSpeedBoost` (cap ×1.15) and `tuckDragMul` (drag ×0.5) off 1.0, so a feathered lean down a slope/wave face is fastest and burying the nose inverts both into a scrape penalty. Grounded/over-water only. VFX: a `tuckStream` additive-cyan particle pool in [src/engine/render/fx/index.ts](../src/engine/render/fx/index.ts) sheds slipstream streaks whose rate + size scale with the positive tuck factor — denser the closer you ride the sweet spot, gone on an over-tuck. **Settings → Gameplay → "Tuck slipstream VFX"** (Full / Subtle / Off, `playerSettings.tuckVfxIntensity`) is the global cap, clearing the definition-of-done UI gate. A `#hud-tuck` accuracy meter ([src/engine/render/tuck-hud.ts](../src/engine/render/tuck-hud.ts)) makes the otherwise-invisible curve legible — bar fill = lean, notch = sweet spot, colour + word (`LEAN IN`/`SWEET!`/`EASE OFF`/`SCRAPING`) + live cap-% report quality — toggled by **Settings → Gameplay → "Tuck meter"** (`playerSettings.tuckMeter`, default on). New unit suite `tests/unit/tuck-sweet-spot.test.ts` pins the curve; 704 unit tests green. |
| 2026-05-19 | Step 8 — QA tooling (matrix + soak + bug bundle + playbook) | _pending PR_ | First sweep of QA-manager-grade tooling lands on top of the existing perf-recorder + cross-browser scaffolding. New `src/engine/qa/console-trap.ts` installs an install-once, ring-buffer-backed proxy over `console.error` / `console.warn` + `window.error` + `unhandledrejection` so every QA gate ("no console errors during this window") reads from one source. New `src/engine/qa/bug-bundle.ts` assembles a JSON repro bundle from the trap + perf + race + sanitized settings + net status (leaderboard handle masked to length only); `__hover.qa.downloadBundle()` triggers a download via the existing Blob+anchor pattern, `copyBundle()` ships it to the clipboard. Wired through `__hover.qa` debug surface in `src/debug.ts` (dev/test only — production exposes nothing). `installConsoleTrap()` fires at the top of `boot()` in `src/main.ts` so viewer / edit / menu shells all get errors captured. New `tools/qa/matrix.mjs` is the single source of truth for which (track × bike) cells the QA pass exercises — procedural tracks × 3 bikes (6 cells) + 9 v1 ship tracks at default bike (Reef + Open Sea + Continental cups; Drowned cup tracks left as `enabled: false` markers so a future enable flips them). New `tools/qa/runner.mjs` (`pnpm qa`) orchestrates typecheck / lint / unit / track-lint / Playwright matrix, optional `--soak`; emits Markdown + JSON to `qa-report/`. New `tools/qa/report.mjs` renders the Markdown (Shippability ✅/❌, per-step summary, log-tail under `<details>` for failures). New `tests/e2e/helpers/console-errors.ts` reusable Playwright fixture (`import { test } from './helpers/console-errors'`) so future specs drop the ad-hoc `page.on('pageerror', …)` pattern. New `tests/e2e/qa-track-matrix.spec.ts` parameterises over `enabledCells()` — boots `?autostart=1&track=…&bike=…`, drives 5s autoplay, asserts fps ≥ 30 / p95 ≤ 50ms / finite bike position / no console errors; gated on `QA_MATRIX=1` so `pnpm e2e` stays fast. New `tests/e2e/qa-soak.spec.ts` runs 60s autoplay (override via `QA_SOAK_SECONDS`) with a Chromium-only `performance.memory` heap-leak gate (end/mid ratio < 1.5) + hitch-fraction ceiling (< 5%). New `.github/workflows/qa.yml` runs `pnpm qa` non-blocking on push/PR, posts the report to the GitHub Step Summary, uploads `qa-report/` as an artifact; nightly cron runs `--soak` on main. New `.github/ISSUE_TEMPLATE/qa.yml` (QA report template — source dropdown, repro steps, bundle paste, severity dropdown, commit URL). New [docs/qa-playbook.md](./qa-playbook.md) is the convention doc — gate list, shippability semantics, matrix maintenance, bundle workflow, manual playtest checklist, roadmap. 624/624 unit tests passing across 66 files (3 new test files: `console-trap.test.ts` 9 cases, `bug-bundle.test.ts` 6 cases, `qa-matrix.test.ts` 5 cases). |
| 2026-05-19 | Step 4 — All four ship cups unlocked + TT venue picker | _pending PR_ | With every v1 track now `status: 'ship'`, the four real race cups (Reef / Open Sea / Continental / Drowned) flip from gated to live in `tracks-catalog.ts`; cup-tracks screen renders championship START CUP CTAs for each. Time Trial venue picker now lists every shipped v1 track (previously dev-cup-only), so the TT loop has its full v1 surface. Closes the Cup-mode convention row's UI-gate line from "Dev Placeholder Cup tile active; ship cups stay gated" to "all four cups tile active". |
| 2026-05-18 | Step 4 — Phase E Sprint 3 (Drowned Cup) — v1 lineup complete | _pending PR_ | Three Drowned Cup tracks build + export end-to-end: `pnpm seed:track-aqualand`, `pnpm seed:track-angkor-drowned`, `pnpm seed:track-liberty-drowned`. **Aqualand** is the special-case bespoke track (no biome template — pool basin + lazy-river curbs + half-pipe slide + lifeguard towers + main concourse as inline `bmesh` primitives), gameplay hero is the Tsunami wave zone (`surgePeriodS=30`, `surgeAmplitude=4.0` — the wave-mastery pillar's most explicit appearance in v1). **Angkor Drowned** layers a library-linked `tower_cylinder_spiral` + 16 `carved_face_block` instances + jungle dressing onto template-alpine, with a `PROFILE_TUBE` helix anti-grav climb around the central spire. **Liberty Drowned** is the v1 finale — template-downtown (nyc) with a hand-blocked low-poly Liberty silhouette (~121 v / 156 f) inline via `bmesh`, library-linked `drowned_facade_nyc` Manhattan rooftops + stretched `arch_ruin` reading as sagging Brooklyn Bridge, and **both anti-grav segments shipped**: the torch-arm Möbius via `PROFILE_BANKED_STRIP` with `bp.tilt` 0 → π for the half-twist, and the crown interior via a closed cyclic `PROFILE_TUBE` loop. All 3 lint clean (0 errors / 0 warnings — cleanest sprint yet). All flipped to `status: 'ship'`; Drowned Cup unlocks via existing `shipCupRaces('drowned')`. Authored by three parallel agents in worktrees, integrated sequentially. **v1 track lineup is now complete: 12/12 tracks `status: 'ship'`.** |
| 2026-05-18 | Step 3 — Phase D Sprint 2 (Open Sea + Continental Cups) | _pending PR_ | Five tracks build + export end-to-end: `pnpm seed:track-the-maw`, `pnpm seed:track-shibuya-submerged`, `pnpm seed:track-kilauea-crown`, `pnpm seed:track-marina-bay-7`, `pnpm seed:track-doges-drift`. Each seed mirrors the Reef Cup pattern: load template → reshape spline → build road → augment with library-linked landmarks + wave zones + (optional) anti-grav curve + pickups + boost pads + camera_hero → re-export GLB/JSON. Hero set-pieces materialised: **The Maw**'s 3 arches over open Pacific with the directional-swell wave zone at the centre; **Shibuya**'s Cocoon Tower wall-ride; **Kilauea**'s banked caldera-rim anti-grav ribbon + library-linked lava waterfall (later upgraded to a runtime emissive shader); **Marina Bay 7**'s 5-crane gauntlet with out-of-phase swing periods + beached supertanker deck shortcut; **Doge's**' Campanile climb + Rialto under-thread + swinging bell. All 5 pass `pnpm gen:tracks:validate` lint (0 errors); 4 carry advisory spline-clip warnings against downtown-template building footprints (polish item for the art-tuning pass). All flipped to `status: 'ship'`. Authored by five parallel agents in worktrees, integrated sequentially because the local Blender install is single-tenant. Follow-up `Phase D Sprint 2 polish` pass swept sky stamping + lint cleanups. |
| 2026-05-18 | Step 2 — Reef Cup track production (4/4) | _pending PR_ | Sandbar (tutorial), South Beach Sunken, Hatteras Light, Cape Town Drift all build + export end-to-end via `pnpm seed:track-<id>`. Each seed runs the spec-driven `build_track_from_spec` framework (template-island base + reshaped AI spline + road + curbs + terrain conform + lint), then a per-track augment pass that drops landmark instances (linked from the new `landmarks-library.blend`), wave-zone empties, anti-grav curve sweep where applicable (Hatteras helical corkscrew), camera_hero, pickup spawns, boost pads — finally re-exporting the GLB. Materialises `tracks-src/<id>.blend` (~4.5 MB), `public/assets/tracks/<id>.glb` (~8.5 MB), `public/tracks/<id>.json` (gameplay + sky + audio + wave-zone blocks), `public/assets/tracks/<id>-hero.jpg` (1280×720 EEVEE), `public/assets/tracks/<id>-thumb.jpg` (320×180). All four flipped to `status: 'ship'`; Reef Cup tile lit. The Maw (originally penciled here as Sprint 1's hero) moved to Sprint 2 with the Open Sea set. |
| 2026-05-18 | v1 asset-pipeline foundation (Phase A 9/10 + Phase B 7/7) | _pending PR_ | Per-track horizon (Blender-authorable ring or procedural seeded fallback), wave-zone authoring (OBB-scoped Gerstner amplitude/freq + surge timer + direction override + soft-blend, soft-max overlap), anti-grav ribbon tool (curve-driven tube/ribbon/banked-strip sweeps with parallel-transport frames + auto-generated entry/exit zones), particle emitter + 1024² procedural sprite atlas (16 cells, WebGPU-safe SpriteNodeMaterial + InstancedMesh, one pool per atlas cell), path-worn vertex bake (distance-to-spline → COLOR_0.B, auto-fires on export), per-track sky/grade preset (8 LUT presets + bloom stub + Beaufort-driven sea state), track-hero EEVEE render (1280×720 hero + 320×180 tile JPGs on every export), audio palette schema (per-track music + ambient[] + duck-on-pump multiplier, real fetch+decode with graceful 404 fallback), CI track lint (`pnpm gen:tracks:validate` — surfaced 4 pre-existing authoring bugs to fix). Deferred: gap #7 AI pump-hint binding (waits on wave-pump physics tuning). Phase B hero-landmark library extended with 7 archetypes → 18 collections (`tower_cylinder_spiral`, `arch_ruin`, `drowned_facade` × 4 styles, `glass_tank_broken`, `mechanical_rig`, `carved_face_block`, `lava_river_strip`); covers 10 of 11 v1 set-pieces (Liberty herself stays hand-modelled). 549/549 vitest passing; 94 declared / 100 registered addon classes. |
| 2026-05-17 | Step 0 — Scaffolding | [#110](https://github.com/occ-matt/hoverbike/pull/110) | Full menu cathedral (mode/cup/track/bike/settings/HUD) shipped with disabled-state convention locked. Test maps moved into a dev-only Dev Cup so the four real race cups stay clean. |
| 2026-05-17 | Step 1 — Wave-pump signal | [#111](https://github.com/occ-matt/hoverbike/pull/111) | Heuristic crest-launch detector → HUD widget + audio chord. Gameplay → Wave-pump prompt (Full/Subtle/Off) wired and persisted. Trigger upgrades when pump physics tuning lands; event contract is stable. |
| 2026-05-18 | Step 1 — AI difficulty + rubber-band toggle | _pending PR_ | Three-tier per-AI tuning bundle (top-speed factor / lateral-accel ceiling / curvature lookahead / rubber-band bounds) baked into the controller at spawn time. Rubber-band system gates on the live toggle so flipping it mid-race settles AI back to its baseline rather than snapping. Gameplay → AI difficulty + Rubber-band assist rows lit. |
| 2026-05-18 | Step 1 — Anti-grav HUD + camera intensity | _pending PR_ | Player-facing surface for the already-shipped anti-grav physics + authoring: magenta-glow HUD indicator binds to the reserved `#hud-anti-grav` slot and fades in with `AntiGravOverride.weight`; chase camera grows a `setAntiGravFollow(weight)` blend between yaw-only (default) and full bike-frame follow so loops actually invert the view. Gameplay → Anti-grav camera intensity (Full / Reduced / Off) row lit and scales the camera follow weight, leaving the HUD signal always-on (motion-sickness players still need the affordance). |
| 2026-05-18 | Step 1 — Tutorial framework (track-agnostic) | _pending PR_ | Director (`src/engine/tutorial/`) drives a script of beats — each beat pairs a player-facing prompt (mechanic name + one-line hint) with a `clearWhen` predicate evaluated against per-frame sample. Default 6-beat script clears on throttle / sustained speed / camera-look / wave-pump / anti-grav / finish — no Sandbar dependency, runs on any track. Top-centered yellow HUD chyron flashes green on clears, settles to green "GOOD RIDE" on completion (~2.5s fade). URL param `?tutorial=1` activates it; the menu's Tutorial mode tile + Settings → "Replay tutorial" button both route through `buildReplayTutorialHref`. Subtitles toggle hides the hint line; the chyron itself stays. First clean completion latches `tutorialCompleted=true` so the buttons re-label to "REPLAY". |
| 2026-05-18 | Step 1 — Audio mixer + music bed | _pending PR_ | Four-bus rewrite of `AudioEngine`: `sources → music \| sfx \| ambient → master → destination`, each bus a GainNode driven by `playerSettings.audio<Bus>Volume × BUS_HEADROOM[bus]`. Existing one-shots routed to SFX, water rumble to Ambient, leaving Music as a new procedural pad bed (three-voice sine drone with tremolo LFO — stand-in for the licensed/commissioned drop later in M11–12). New `duckMusic(amount, recoverSeconds)` sidechain helper auto-fires on wave-pump (0.35 + 0.3 × strength dip) and explosion (0.7 dip) so cues cut through. Settings → Audio rows for all four sliders + a "music bed enabled" toggle wired through a new `audio-service` singleton so the overlay can reach the live engine without a prop-drill from `main.ts`. **Closes Foundation Systems at 5/5.** |
| 2026-05-18 | Time Trial mode + ghost recording | _pending PR_ | Mode tile + flow: `?race=1&track=…&bike=…&tt=1` routes through a TT-aware menu (mode tile lit, sp-cup-tracks reused with Dev Cup as the source, sp-bike picker, race start). `spawnBikes` gains `aiCount` (TT passes 0) + `ghostVariant`. `createBike({ ghost: true })` mints a render-only entity (no RigidBody, no Racer/AI/Peer/PickupSlot tags) — bike-render swaps in a translucent cyan material when it sees `GhostTag`. New `src/engine/replay/best-lap-slice.ts` extracts the player's fastest lap from the recording's `lap` events (recorder.recordEvent finally wired in `main.ts`) and re-bases timestamps to t=0. New `src/engine/replay/ghost-state.ts` persists single-lap ghosts to localStorage keyed by (trackId, bikeId). New `src/game/systems/ghost-runner.ts` drives the ghost Transform off the player's current lap time (not wall clock) so the ghost is a real pacing target; seeks to t=0 when the player crosses the line, freezes at end pose when the ghost finishes first. Finish overlay reads as TIME TRIAL with a "★ GHOST SAVED" pill on every new PB; RETRY is the default focus, NEXT hidden. 354/354 unit tests passing (19 new — 7 ghost-state, 6 best-lap-slice, 6 ghost-runner). |
| 2026-05-18 | Step 6 — Leaderboard (local board) | _pending PR_ | Local-first Time Trial leaderboard so the third Modes row goes ✅ before the M16 backend lands. New `src/engine/leaderboard-state.ts` owns the localStorage-backed per-track top-N (≤25 entries) sorted by best lap ascending, deduped by handle so each racer occupies exactly one slot per track. `playerSettings` gains `leaderboardSubmit` (Gameplay → "Submit times to leaderboard" toggle, now lit) and `leaderboardHandle` (new Settings text row, normalized to `[A-Z0-9_-]`, ≤12 chars; empty falls back to `YOU` at submit time). TT finish path in `game-loop.ts` now writes the new ghost AND submits the lap to the per-track board iff the submit toggle is on, with a `#N ON BOARD · HANDLE` pill alongside the GHOST SAVED line. New menu screen activated from `mode-screen → LEADERBOARDS …`: two-pane track list (V1 ship tracks + procedural/manifest tracks, dev cup tracks on dev builds) + top-10 table with the player's row highlighted; CLEAR LOCAL TIMES wipes the store. Backend swap (M16) only needs to replace `loadStore`/`saveStore` — the `LeaderboardEntry` shape and the submit/read API stay stable. 386/386 unit tests passing (16 new — `normalizeHandle` + sort/dedupe/truncate/clear). |
| 2026-05-18 | Step 6 — Leaderboard (global backend) | _pending PR_ | Promotes the local-only board to a real global leaderboard on a new PartyKit Party (`party/leaderboard.ts`, registered alongside the relay in `partykit.json`). One `global` room owns per-track top-25 entries in `Party.Storage`; client side `leaderboard/` subfolder gains `core.ts` (pure `mergeEntry` shared with the server), `protocol.ts` (wire types + canonical signing payload), `hmac.ts` (WebCrypto sign/verify), `profanity.ts` (~80-entry stem list + leetspeak normalizer), `endpoint.ts` (dev/prod host + secret resolver), `remote.ts` (signed fetch wrapper with 3.5 s timeout). Finish-overlay banner extracted into `src/engine/render/leaderboard-finish-banner.ts`: on first TT PB the GHOST SAVED line grows an inline `ENTER INITIALS [____] SAVE / SKIP` form (Enter commits, Esc skips → 'YOU'); subsequent PBs submit silently; the pill flows `SUBMITTING…` → `#N ON BOARD · HANDLE` (or `LOCAL ONLY` on network failure). Menu Leaderboards view now fetches the global top-10 in the background per track-selection with a `GLOBAL BOARD` / `LOCAL ONLY` source badge, falling back to the cache when offline. Submission threat model: HMAC sig (deters scripted curl) + ±5 min ts window + nonce ring (replay protection) + per-IP rate limit (1/5 s) + per-track plausibility floor + profanity filter + handle blocklist + rolling 1000-entry audit log. Admin endpoints (`DELETE /admin/handle/:h`, `DELETE /admin/entry/:t/:r`, `POST /admin/block`, `GET /admin/audit`) gated by `LEADERBOARD_ADMIN_TOKEN` bearer; new `pnpm leaderboard:moderate` CLI (`tools/leaderboard-moderate.mjs`) wraps them. `LEADERBOARD_HMAC_SECRET` (PartyKit env) + `VITE_LEADERBOARD_HMAC_SECRET` (build env) must match; dev fallback in `hmac.ts` so local dev works without setup but a misconfigured prod fails closed. New ops doc at [`docs/leaderboard-backend.md`](./leaderboard-backend.md). 428/428 unit tests passing (42 new — core merge, profanity filter incl. Scunthorpe avoidance, HMAC sign/verify, server submit+admin happy paths and rejections). |
| 2026-05-18 | Step 6 — Cup wiring (placeholder) | _pending PR_ | New dev-only **Dev Placeholder Cup** strings `lagoon → cliffside → big-bay` into a real 3-race championship so cup-mode wiring is exercised before any of the four ship cups have tracks. New `src/engine/cup-progress.ts` owns the sessionStorage-backed cup state (cup id, bike, race lineup, per-race results) plus an MK8 / F1 style point curve (15/12/10/9/8/7/6/5/4/3/2/1). `?cup=<id>` on the race URL toggles cup mode in the game loop; the finish overlay rewrites NEXT to "NEXT RACE (n/m)" mid-cup and "CUP RESULTS →" on the last race, with a compact `CUP STANDING · n/m · X PTS THIS RACE · Y TOTAL` row added to the stat block. New `#cup-results` overlay (CSS + DOM in `index.html`, renderer in `src/engine/render/cup-results-screen.ts`) shows a per-race points table + champion banner. RETRY mid-cup restarts the current race while preserving cup-progress (results swap by trackId, pointer never un-skips); EXIT (finish-screen + pause-menu) always clears cup-progress. Cup-tracks screen split: browse Dev Cup keeps its tile-as-launcher behavior; championship-shaped cups (placeholder + future ship cups, which are pre-wired with `races: shipCupRaces(id)`) render inert preview tiles plus a START CUP CTA. No new settings row — cup mode reuses AI difficulty + rubber-band assist; ship cups will revisit when they unlock. |
| 2026-05-18 | Input / controls — rebind + sensitivity + deadzone + invert-Y | _pending PR_ | Closes the Input / controls row in the convention table. New `src/engine/input/bindings.ts` owns the action set (8 keyboard actions + 2 gamepad action buttons), default tables, **swap-on-rebind semantics** (binding K to A swaps K's old holder onto A's old primary so no action goes unreachable), and a tolerant `parse*Bindings` for persisted blobs. `playerSettings` grows five fields — `keyboardBindings`, `gamepadBindings`, `gamepadSensitivity`, `gamepadDeadzone`, `invertCameraY` — and a matching setter / reset for each; the migrated `gamepadDeadzone` + `cameraInvertY` are dropped from `devSettings` (and from `dev-settings-menu` + `index.html`) since the Controls tab subsumes them. `keyboard.ts` now reads action state through the live binding table (corrects the `pitchUp = E`, `pitchDown = Q` convention per status M9.18); `gamepad.ts` reads the player-facing deadzone + applies `gamepadSensitivity` as a clamped output multiplier; `camera-look.ts` reads `invertCameraY` directly. New `src/engine/menus/rebind-modal.ts` + `#rebind-menu` DOM in `index.html`: per-action chip → click to enter capture → next keydown (or `pollGamepadButtonPress` for gamepad, with LT/RT skipped) commits via `assignKeyboardPrimary` / `assignGamepadBinding`. Esc cancels capture; second Esc closes the modal. Reset-to-defaults works per-tab. **Settings → Controls now has all five rows lit** (rebind keyboard / rebind gamepad / gamepad sensitivity / deadzone / invert camera Y). 399/399 unit tests passing (29 new in `tests/unit/input-bindings.test.ts` — swap semantics, secondary collisions, no-input mutation, persistence round-trip, parse tolerance, label formatting). |
| 2026-05-18 | Wave-line shimmer overlay (forward signal) | _pending PR_ | Closes the wave-mastery pillar's predictive half — pairs with the after-the-fact wave-pump signal already shipped. The render-side shimmer is a pool of additive-blended discs that hover on the water surface in a forward fan from the bike. New `src/engine/render/wave-line-scoring.ts` (pure math) lays out a `samplesAlong × samplesAcross` grid (default 7×3, 6–36 m, ±12.6°) along the player's XZ heading and exposes `scorePumpability(vy, ceiling=6)` — the same `vy` ceiling the wave-pump detector uses so the predictive and the after-the-fact signals saturate on the same swells. New `src/engine/render/wave-line-shimmer.ts` (Three.js) owns the discs: one shared geometry + material + procedural radial-gradient texture, per-marker pulse phase pre-seeded so the field shimmers like a moving wave, dispose closes geometry/material/texture cleanly. Each tick samples `sampleSurface(waveField, x, z)` per marker (CPU surface field already used by buoyancy — render-only, never writes sim state), hides any score below 0.12 to keep flat-water lulls clean, and exposes `currentMaxScore()` for the HUD pip. New `src/engine/render/wave-line-hud.ts` adds a small `WAVE LINE` chip to the reserved `#hud-wave-line` slot — visible whenever Full is selected, only on a lock (score ≥ 0.55) when Subtle is selected; turns yellow on lock. New Gameplay → "Wave-line guidance" select (Full / Subtle / Off) persists via `playerSettings.waveLineIntensity`. Game-loop wires both surfaces alongside the direction arrow, hiding while paused/finished. 430/430 unit tests passing (15 new — score saturation/floor, fan layout / range / lateral bounds, degenerate-heading buffer stability, persistence round-trip + unknown-string rejection). |
| 2026-05-18 | Step 8 — Steam Deck integration (live) | _pending PR_ | Promotes the "documented path" from the previous Step 8 PR to an actually-wired integration. Boot path in `src/main.ts` now calls `detectSteamDeck()` immediately after `loadPlayerSettings()` and invokes `applyDeckProfile()` when any signal fires (UA / 1280×800 viewport / Steam virtual gamepad); the profile mutates `playerSettings.framerateCap` and `playerSettings.fullscreenPreferred` through the canonical setters so the persisted blob reflects the Deck baseline. A user override (`framerateCap=30` set explicitly) is preserved across detection retriggers — the profile only writes when the value was at default. New `src/engine/render/frame-cap.ts` (pure module — `shouldRenderFrame(now, lastRendered, capFps)` with a 0.5 ms slack so 60-fps cap on a 60 Hz panel doesn't stutter every ~5 frames; label↔number helpers for the Settings select). Wired into `src/boot/game-loop.ts`'s rAF loop: the fixed-step sim accumulator still runs every tick (determinism preserved), but the `renderer.render()` + `framesThisSecond` increment now gate behind `shouldRenderFrame`. New `src/engine/render/renderer-service.ts` singleton mirrors `audio-service.ts`'s pattern so `setPixelRatio` writes can reach the live renderer from the Settings overlay without prop-drilling. Three new player-settings fields (`framerateCap`, `pixelRatio`, `fullscreenPreferred`) with tolerant load branches + clamped setters; setting `pixelRatio` lazy-imports `renderer-service` to re-apply on the fly. **Settings → Video** grows three live rows (Framerate cap select, Render scale slider, Fullscreen-on-launch toggle); 'Resolution' + 'Render quality' stay gated for the perf-presets follow-up. `main.ts` grows two listeners on the existing audio-unlock gesture: (a) opportunistic `documentElement.requestFullscreen()` when `playerSettings.fullscreenPreferred` and not already fullscreen — failures swallowed since users can F11, (b) `visibilitychange → audio.resume()` so the AudioContext recovers after Deck sleep (Chromium leaves it `suspended` after long sleeps). Renderer singleton registration + pixel-ratio re-apply happen after `createRenderer()` for the same persisted-state-wins-on-boot pattern. **`src-tauri/` scaffold** lands as a full Tauri 2 layout — `Cargo.toml` (Tauri 2 deps + optional `steamworks` crate feature-gated behind `steam`), `tauri.conf.json` (productName Hoverbike, identifier `app.hoverbike`, 1280×800 default window, AppImage + deb targets), `src/main.rs` (Tauri Builder with shell plugin + steam command handlers), `src/steam.rs` (feature-gated stubs for `init`, `cmd_record_achievement`, `cmd_set_rich_presence` — no-ops without the feature, ready for SDK wire-up when an App ID exists), `build.rs`, `capabilities/default.json`, `.gitignore`, and a `README.md` documenting Rust + Tauri CLI install. **`pnpm build:deck`** orchestrator at `tools/build-deck.mjs` — runs `pnpm build` then probes for `cargo tauri --version`; if absent prints install instructions + exits 127, otherwise runs `cargo tauri build --target x86_64-unknown-linux-gnu` and forwards extra args (`pnpm build:deck -- --features steam` once SDK lands). New `.github/workflows/build-deck.yml` — manual + tag-triggered Linux runner, installs Rust + Tauri CLI + webkit2gtk system libs, builds AppImage, attaches to GitHub Release on `v*` tags. New `src/engine/input/deck-glyphs.ts` — pure data: 4 platform glyph tables (standard / deck / ps / switch) + `glyphSourceForGamepadId()` heuristic. Not yet wired into the rebind menu (next follow-up). Root `.gitignore` grows entries for `src-tauri/target/`, `src-tauri/gen/`, `src-tauri/steam_appid.txt`. `docs/steam-deck.md` rewritten from "planned path" to "live path" with the new "What's wired today" section enumerating what shipped vs the trimmed-down follow-up list. 25 new unit tests (14 frame-cap, 2 applyDeckProfile→playerSettings mutation, 9 deck-glyphs); 546/546 tests passing, typecheck clean. |
| 2026-05-18 | Step 8 — Cross-browser + Steam Deck path | _pending PR_ | Cross-browser e2e + a documented path to Steam Deck packaging. `playwright.config.ts` grows three projects (chromium / firefox / webkit) gated by `E2E_BROWSERS` — default stays chromium-only so `pnpm e2e` keeps the same fast loop; `E2E_BROWSERS=all pnpm e2e` runs the full matrix. WebKit on Linux uses software WebGL only (no real GPU through WebKitGTK in Playwright), so the three GPU-heavy specs (`m2-water`, `m9-cliffside`, `m9-audio`) carry a `test.skip(browserName === 'webkit' && platform === 'linux')` guard with a pointer to run them on macOS WebKit for real coverage. New `tests/e2e/cross-browser-smoke.spec.ts` is a tiny GPU-free smoke that runs on every browser project (boots the menu, asserts title + mode-select tile visibility, screenshot). New `tests/e2e/menu-flow-deck-resolution.spec.ts` boots at the Deck's native 1280×800 viewport and asserts the menu cathedral + Settings overlay don't overflow vertically. New `docs/cross-browser.md` (~160 lines) documents the tier matrix (Chrome/Edge T1, Firefox T1, Safari T2, mobile later), how to run cross-browser e2e, platform gaps (WebGPU shipping on Chrome/Edge/Firefox; Safari iOS 18.2+; WebKit-Linux software-GL only), and the bug-triage workflow. New `docs/steam-deck.md` (~230 lines) lays out the Tauri 2 wrapper plan (5–10 MB binary, native WebKitGTK, Steamworks SDK integration via `cargo`'s `steamworks` crate), the Gaming-Mode-vs-Desktop layout (1280×800, 60Hz default cap, gamepad-only by default), thermals/battery target (≤ 12W avg for 60+ min), the `pnpm build:deck` script roadmap (`pnpm build` → `cargo tauri build` → AppImage → Steam Partner backend), and on-device testing instructions. New `src/engine/steam-deck.ts` ships `detectSteamDeck()` (UA / viewport / gamepad heuristics, three independent signals) + `applyDeckProfile()` (60fps default cap, gamepad-first input, fullscreen-on-gesture); not wired into `main.ts` yet — first call lands in the follow-up that adds the packaging pipeline. 8 new tests in `tests/unit/steam-deck.test.ts` cover both functions with `vi.stubGlobal` mocks. README grows a "Build targets" bullet linking to both docs. |
| 2026-05-18 | Step 8 — Accessibility settings + new tab | _pending PR_ | Closes the **Accessibility** row in the v1 work-breakdown convention table — adds the full surface area (colorblind palettes, reduced flash, larger text, high contrast, reduced-motion OS override, motion-sickness reduction, screen-shake intensity, subtitles always on) before the art lands so HUDs that pick up the palette can ship into a non-empty system. New `src/engine/accessibility/palettes.ts` ships three hand-picked safe palettes — deuteranopia / protanopia / tritanopia — each keyed by gameplay-meaningful slot (`player`, `leader`, `opponent`, `warning`, `success`, `info`, `danger`) and tuned so the previously-red↔green pairs (warning↔success on the next-CP ring + lap-PB pill, leader↔opponent on the minimap) collapse onto axes the named deficiency CAN resolve (yellow↔blue for deut/protan, red↔cyan for tritan). New `src/engine/accessibility/accessibility-service.ts` bridges the player-settings struct to the DOM (writes `body[data-cb|large-text|high-contrast|reduced-flash|reduced-motion-override]` for the CSS surface) and to canvas-painting HUDs via a hand-rolled `onAccessibilityChange` pub/sub mirroring `mp-status.ts`'s pattern; `currentHudPalette()` is the per-paint resolver. `playerSettings` grows eight fields with matching tolerant load branches + setter helpers (`setColorblindMode`, `setReducedFlash`, `setLargeText`, `setHighContrast`, `setReducedMotion`, `setMotionSicknessReduction`, `setScreenShakeIntensity`, `setSubtitlesAlwaysOn`); each setter calls `applyAccessibilityToDom` + `notifyAccessibilityChange` via a lazy import so the player-settings module stays cheap to import from early-boot paths. Storage key bumped to `hoverbike.playerSettings.v2` — old v1 blobs fall through to defaults (intent signaled for future archeology). Settings overlay grows an **ACCESSIBILITY** tab between Gameplay and Network with all eight rows lit — colorblind mode select / reduced-flash toggle / large-text toggle / high-contrast toggle / reduced-motion override toggle / motion-sickness reduction toggle / screen-shake slider (0..1, step 0.05) / subtitles-always-on toggle. `index.html` grows three CSS blocks: (a) `body[data-large-text=1]` selectors scaling HUD font sizes 1.25×, (b) `body[data-high-contrast=1]` forcing opaque HUD shells + white text, (c) `body[data-reduced-flash=1]` killing pulse animations, (d) `body[data-reduced-motion-override=on]` mirroring the existing `prefers-reduced-motion` rule so an opt-in toggle works regardless of OS preference, plus per-mode color-variable swaps on `.wp-shell` + `.wl-shell` so the CSS-driven HUD chyrons participate in the palette swap. `race-hud.ts` minimap drawing now reads from `currentHudPalette()` for player / leader / opponent dots, the next-CP ring (warning), and the spline (info, alpha-applied); the baked static-layer canvas re-bakes on `onAccessibilityChange` so a mid-session mode flip repaints without a HUD recreation. New `tests/unit/accessibility.test.ts` (12 cases, jsdom-environment annotated — adds `jsdom` as a devDep) covers palette identity for 'off', warning↔success + leader↔opponent channel-distance floors per mode, `currentHudPalette()` tracking the live mode, localStorage round-trip + clamp + invalid-value fall-through, setter→listener notify + unsubscribe, and `applyAccessibilityToDom()` writing the full attr set. |
| 2026-05-18 | Step 7 — Multiplayer (convention row closed) | _pending PR_ | Closes the **Multiplayer** row in the v1 work-breakdown convention table. New `src/engine/net/latency.ts` (pure math — EWMA RTT smoothing with `LATENCY_STALE_MS=6000` stale-out so a silent channel drops back to `—` instead of pinning the last reading) + new ping/pong control messages (`{type:'ping', t}` C→S → `{type:'pong', t}` S→C, stateless echo) extend the protocol; relay.ts grows a four-line ping branch that doesn't touch the room's sticky `raceStarted` bit. `createNetRoom` runs a 1 Hz ping loop from `hello` onward, feeds RTT through the smoother, and exposes `latencyMs` + `everConnected`. New `src/engine/net/mp-status.ts` pub/sub publishes a single `MpStatus` snapshot consumed by every player-facing surface — Settings → Network tab, the lobby header, and the in-race HUD chip — so each refresh is one publish, not three coordinating polls. Settings overlay grows a **NETWORK** tab with five read-only rows: Region (AUTO · CLOUDFLARE EDGE / DEV (LOCAL)), Endpoint (`hoverbike.occ-matt.partykit.dev` or override), Connection (OFFLINE/CONNECTING…/CONNECTED/RECONNECTING…/CLOSED), Room (`<id> · P<n> · HOST?`), Latency (`NN MS` or `—`). The Settings tab subscribes to mp-status while open and tears the listener down on close. Lobby header gets a live PING badge alongside the room code; HUD `#hud-room` chip appends ` | NNms` while connected and distinguishes `connecting…` vs `reconnecting…` (partysocket auto-reconnects on its own; the chip names the difference). 491/491 unit tests passing (19 new — 8 EWMA / stale-out, 7 mp-status pub/sub, 4 relay ping echo + malformed-payload rejection + unassigned-sender drop). |

---

## Domain inventory

Priority tags (P0/P1/P2) match [design-targets.md](./design-targets.md).

### Tracks (12 total)

Each track needs the full pipeline: layout block-out → set-piece geometry →
environment art → skybox/lighting → AI racing line → spawn/checkpoint/
itembox placement → audio palette → track-specific music. Full content
specs in [track-themes.md](./track-themes.md).

- **Sandbar** — tutorial, new, scripted gate scenarios (P0)
- **Texcoco Rising** — Reef opener (drowned Mexico City), causeway loop, El Ángel collapsed-freeway set-piece (P0). *Replaced South Beach Sunken / Miami in the 2026-06 content pass; rebuilt from scratch.*
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

- ✅ Wave-pumping HUD signal — boost-bar flash + audio cue on successful pump (P0)
- ✅ **Anti-grav system** — controller orientation flip, trigger volumes,
  entry/exit VFX, visual indicator (P0)
- ✅ AI difficulty slider (Casual / Standard / Hard) + rubber-band toggle (P0)
- ✅ Tutorial framework — scripted prompts, scenario gating, skip toggle (P0)
- ✅ Race-line / wave-line guidance — `WAVE LINE` HUD pip + 3D forward-fan
  shimmer over pumpable waves (P0)
- 🟡 8-bike grid support — scale current 5 → 8. Lobby + state-sync already
  accommodate 8 slots; gameplay perf gating at full field is the open work. (P0)
- ✅ Ghost recording / playback (for Time Trial) (P1)
- ✅ Cup / championship state — points table, race progression, end-of-cup
  summary (P1)
- 🟡 Music system integration — procedural pad bed shipped, licensed/commissioned
  per-region drops still pending (P0)
- ✅ Leaderboard backend — HMAC-signed PartyKit Party, moderation CLI,
  per-track top-N (P1)
- ⬜ Photo / replay mode (P1)
- ✅ **Drift mini-turbo** — MK-style mini-turbo (MT/SMT/UMT tiers), inside-drift
  archetypes (Sparrow / Stunt), AI drift on sharp corners, HUD tier badge,
  colored sparks, skid audio. Lateral skill axis complementing wave-mastery's
  vertical/timing axis. **[Added during the v1 push, not in the original P0 set
  — see [docs/drift-deep-dive.md](./drift-deep-dive.md).]**
- ✅ **Tricks (geometric pop)** — pop-based trick window that arms off lips,
  ramp crests, sandbars, ledges, embankments via per-end hover contact flags.
  Replaces the old vy gate. **[Added during the v1 push.]**
- ✅ **Tuck sweet-spot** — snowboarder's nose-down sweet spot folded into the
  existing pitch-down gesture (no dedicated button). HUD meter + slipstream
  VFX + per-bike `tuckSpeedBoost` / `tuckDragMul`. **[Added during the v1 push.]**
- ✅ **Surface-type registry** — per-collider lateral-grip multiplier
  (`default` 1.0 / `metal` 1.25 / `sand` 0.70 / `ice` 0.35). Affects both
  normal driving and drift so each surface feels coherent. 🟡 Blender authoring
  UI is the remaining follow-up. **[Added during the v1 push.]**

### Systems — physics / sim

- Wave physics tuning — make pumping feel rewarding, swell timing legible
- Anti-grav physics (depends on system above)
- Wave-aware AI behavior — when to pump, especially on Hard difficulty
- 8-bike multiplayer state sync polish (M10.x continuation, in flight)

### Assets — bikes

- ✅ 2 new bike variants (3 → 5 total) — Scout (heavyweight) + Sparrow (lightweight)
- ✅ Per-variant wave-pump feel tuned (Scout: soft hover spring → punishing
  pump timing + biggest launch; Sparrow: stiff spring + high surfaceFollow →
  forgiving + further launch)
- ✅ Per-variant **drift archetype** (`driftStyle`) — Sparrow + Stunt are
  inside-drift (sport-bike: tighter initial cut, wider tail), others
  outside-drift (default: stable flat-bias arc)
- ✅ Bike-select thumbnails — `pnpm gen:bike-thumbs` produces 480×270 JPGs
  per variant via a Playwright viewer route
- 🟡 **Rider editor** (`?rideredit=1`) — primitives + colours + seated pose,
  Load / Save / Export. v1-launch use is configuring shipped defaults;
  player-level rider customization is a post-launch stretch.

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

- **QA tooling** — `pnpm qa` orchestrator + report, parameterised track ×
  bike matrix, stability soak, console-error fixture, in-session bug-repro
  bundle (`__hover.qa.downloadBundle()`), QA playbook + issue template,
  non-blocking CI workflow. See [docs/qa-playbook.md](./qa-playbook.md).
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
