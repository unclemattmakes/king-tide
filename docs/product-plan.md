# Hoverbike — Product Plan v0.1

> Web-first arcade hover-bike racer. JetMoto homage with Wave Race water physics and light Mario Kart combat.
>
> **Status (v2, 2026-06-04):** Blew past v1 and **restarted content for v2.** Most tracks are now intentionally **greybox** (only Mayday Bay / The Maw are dressed; the Reef opener South Beach / Miami was cut and is being rebuilt as **Mexico City**); `status: 'ship'` means wired/playable, not art-complete. **Wave mastery pivoted** to a motocross pitch-the-takeoff/landing model (the Mario-Kart fork), away from press-forward-on-crest. **Anti-grav cut** (parked for a possible future DLC). The shipping soundtrack is **14 verified Creative-Commons FMA tracks** (per-track licenses in [CREDITS.md](../CREDITS.md)). Real remaining work: wave-mastery skill legibility, the v2 environment-art pass, and a 60 fps @ 8-bike perf pass measured on target hardware.
>
> **Status (v1, 2026-05-28):** v1 lineup complete — 12/12 ship-quality tracks across four cups, 5/5 bike variants, all foundation systems shipped, drift mini-turbo + tricks + tuck + surface registry added during the push. Live build at the Vercel URL in [README](../README.md) / [status.md](./status.md). Desktop wrapper is **Electron** (replaced an earlier Tauri shell — see [desktop-builds.md](./desktop-builds.md)); Linux + Windows depots, real WebGPU on Steam Deck. Remaining work is licensed soundtrack + 60fps@8-bike perf-budget pass + pre-launch polish.

## Vision

A web-first arcade racer in the spirit of **JetMoto**. Hover bikes that surf wave-driven oceans, launch off cliffs, and rip across hilly land courses. **Wave Race**-style water physics meets **Mario Kart**-style item combat *and* mini-turbo drift. Three.js + WebGPU + Rapier WASM, runs in any modern browser, gamepad-first. Also ships as a native Electron desktop build for Steam (Deck-native + Windows).

## Design pillars

1. **Wave-Race water is the centerpiece.** Buoyancy, swell, wake, getting *thrown* by a wave — the signature feel. *(v2 skill framing: the graded mechanic is motocross-style **mastering the jump** — pitch the takeoff off a crest, pitch the landing — not the old press-forward-on-crest pump.)*
2. **Verticality is the second pillar.** Tracks climb, dive off cliffs, splash into ocean. Drop transitions are dramatic.
3. **Arcade, not sim.** Generous handling, big drifts (literal — see Mario-Kart-style mini-turbo), exaggerated speed, forgiving boundaries.
4. **Ten-minute fun loop.** Pick bike → race → rematch in under 30 seconds. No menus to fight.
5. **Light combat seasoning.** Pickups matter, but physics-mastery (wave-pump + drift) and racing line decide most races.
6. **Larger-than-life scale.** Landmarks, hazards, and props are authored *bigger than life* so they read at race pace (40 m/s) and silhouette against the sky. Real-world dimensions are a floor, not a ceiling — oversize sea-stacks, monuments, and set-pieces ~2–4× past realism so they register at speed and feel monumental. Pairs with "silhouette before surface" + "reads at 40 m/s" in [props-production-plan.md](props-production-plan.md).

## Target player

Casual-to-mid-core, plays desktop with a gamepad, remembers PS1/N64 arcade racers, wants short sessions — not a 40-hour career.

## MVP — "Playable Demo" — ✅ achieved

**Done when:** a stranger lands on the page, races AI on a water+land+verticality course, uses 1-2 weapons, finishes 3 laps, and wants a rematch.

### In scope

- ✅ 2 tracks (Lagoon Loop + Cliffside). Both procedural; the Blender → glTF pipeline is wired and Cliffside doubles as the reference layout. The v1 production lineup (11 ship tracks + tutorial) is now complete — see [`track-themes.md`](./track-themes.md) and [`v1-asset-pipeline-plan.md`](./v1-asset-pipeline-plan.md).
- ✅ 3 hover bikes with distinct stat tradeoffs — Cruiser / Racer / Stunt
- ✅ 4 rubber-banded AI opponents per race
- ✅ Single 3-lap race mode with finish overlay + best-lap save
- ✅ 4 pickups: homing missile, mine, boost, shield. AI fires its own.
- ✅ Gerstner-wave water with buoyancy + surface alignment; raycast hover controller for static colliders (island, mesa, ramps)
- ✅ Gamepad-first input, keyboard fallback (smoothed). Touch input wired but no on-screen controls yet.
- ✅ Procedural audio: speed-mapped engine, water ambient, pickup chime, weapon SFX, gate / lap cues. (Took the procedural path instead of library SFX — keeps the build asset-free.)
- ✅ WebGPU-first renderer with WebGL2 fallback (auto-detected)

### Out of scope (v1)

- ~~Multiplayer~~ — landed (room-code MP, lobby with ready states + smash-bros pick, 8-bike slots, 20 Hz transform snapshots over PartyKit relay)
- Career mode / unlocks
- ~~Save state~~ — landed (best-lap times per (track, bike) in localStorage, Time Trial ghosts, leaderboard handles, accessibility prefs, control rebinds)
- ~~Mobile / touch~~ — partly landed (touch HUD overlay + mobile MENU button shipped during Polish/QA; v1 web build is touch-aware)
- Original soundtrack (procedural pad bed shipped as stand-in — licensed/commissioned drops still pending)
- Track editor (in-app editor still author-only)
- Final art direction (programmer-art placeholders throughout; the physics + feel are the focus)
- Photo / replay viewer (recorder + pose-replay infra is in place — drives the TT ghost — but a viewer scene isn't shipped)

## Tech decisions (locked)

| Area | Choice | Reason |
|---|---|---|
| Renderer | Three.js, WebGPU-first w/ WebGL2 fallback | Wider audience, future-proof |
| Physics | Rapier (WASM) for solids, custom Gerstner-wave water | Deterministic build keeps rollback netcode possible later |
| Tracks | Blender → glTF, with metadata layers (water volume, checkpoints, AI splines, wave zones, anti-grav curves, scatter zones) | Standard pipeline, fast iteration |
| Architecture | ECS (bitECS or similar) | Scales as bikes/projectiles/AI grow |
| Input | Gamepad-first, keyboard fallback | Arcade racing wants analog sticks/triggers |
| Audio | Procedural Web Audio (engine, ambient, SFX) + four-bus mixer + procedural music bed (licensed drops pending) | Engineering effort goes into dynamic engine sound + mixing |
| Distribution — web | Static build, push-to-deploy Vercel | Free, simple, shareable URL |
| Distribution — desktop | **Electron** wrapper, Linux + Windows depots on Steam (Tauri shelved 2026-05-26 — see [desktop-builds.md](./desktop-builds.md)) | Bundles its own Chromium → real WebGPU inside the Steam Linux Runtime container, including on Steam Deck. macOS deferred. |
| Multiplayer | PartyKit relay (`hoverbike.occ-matt.partykit.dev`) — InputFrames at 60 Hz, TransformSnapshots at 20 Hz | 8 peers, room codes, no public matchmaking, no ranked |

## Success criteria

- 🟡 Wave physics feel great — launches + hard landings read well. **v2 reframes the graded skill** as motocross pitch-mastery of takeoffs/landings (the Mario-Kart fork), not the press-forward pump; pitch already affects swell interaction, but making it legible + graded (and refitting the wave-pump signal + wave-line shimmer, which were built for the old model) is open work.
- ✅ Cliff-to-water transitions feel dramatic, not janky. (Cliffside's 15m drop ships in M9.13; The Maw's open-ocean leaps tested in v1 Sprint 2.)
- ✅ **Drift mini-turbo (added v1 push).** Lateral skill axis pays off with a clear tier-up signal + colored sparks + bell pitch + camera roll. Drift Practice Range is the dev fixture, ICE/SAND patches demonstrate the surface registry.
- 🟡 AI keeps the pack tight every race. (Per-difficulty pump-firing + drift activation help; per-track racing-line authoring still uneven.)
- ✅ Boots in <5s on broadband, holds 60 FPS on M1/Ryzen-class at 1080p solo. 🟡 8-bike full-field perf-budget pass still pending.
- 🟡 A non-gamer friend finishes a race without instruction. (Untested with a real non-gamer; HUD + direction arrow + trail visuals + tutorial 6-beat director are designed for it.)
- ✅ Real WebGPU on Steam Deck (Electron wrapper bundles its own Chromium → not held back by Deck's WebKitGTK).

## Top risks

1. **Wave field ↔ Rapier integration.** Custom wave field driving rigid body buoyancy is the riskiest novel piece. Prototype early.
2. **WebGPU/WebGL2 parity.** Some effects (compute-driven wake, etc.) need degraded fallback paths.
3. **AI on water.** Splines must handle vertically-shifting positions, unlike road racers.
4. **Cliff drops + chase cam = motion sickness risk.** Camera model needs early testing.

## Deferred to implementation plan

- Camera model (chase / cinematic / hybrid)
- Track length & lap-time target
- Specific bike stat ranges & weapon balance numbers
- File/module layout, ECS schema, build tooling
