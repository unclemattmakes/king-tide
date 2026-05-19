# Hoverbike — Product Plan v0.1

> Web-first arcade hover-bike racer. JetMoto homage with Wave Race water physics and light Mario Kart combat.
>
> **Status (2026-05-07):** MVP scope is feature-complete. Live build at the Vercel URL in [README](../README.md) / [status.md](./status.md). Remaining work is asset-pipeline polish and post-MVP items (multiplayer, career, mobile, original soundtrack).

## Vision

A web-first arcade racer in the spirit of **JetMoto**. Hover bikes that surf wave-driven oceans, launch off cliffs, and rip across hilly land courses. **Wave Race**-style water physics meets **Mario Kart**-style item combat. Three.js + WebGPU + Rapier WASM, runs in any modern browser, gamepad-first.

## Design pillars

1. **Wave-Race water is the centerpiece.** Buoyancy, swell, wake, getting *thrown* by a wave — the signature feel.
2. **Verticality is the second pillar.** Tracks climb, dive off cliffs, splash into ocean. Drop transitions are dramatic.
3. **Arcade, not sim.** Generous handling, big drifts, exaggerated speed, forgiving boundaries.
4. **Ten-minute fun loop.** Pick bike → race → rematch in under 30 seconds. No menus to fight.
5. **Light combat seasoning.** Pickups matter, but physics-mastery and racing line decide most races.

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

- Multiplayer (architecturally allowed via Rapier determinism — not built)
- Career mode / unlocks
- ~~Save state~~ — landed (best-lap times per (track, bike) in localStorage)
- Mobile / touch (touch *input* is wired but no on-screen control overlay)
- Original soundtrack (no music yet — engine + ambient + SFX only)
- Track editor
- Final art direction (programmer-art placeholders throughout; the physics + feel are the focus)

## Tech decisions (locked)

| Area | Choice | Reason |
|---|---|---|
| Renderer | Three.js, WebGPU-first w/ WebGL2 fallback | Wider audience, future-proof |
| Physics | Rapier (WASM) for solids, custom Gerstner-wave water | Deterministic build keeps rollback netcode possible later |
| Tracks | Blender → glTF, with metadata layers (water volume, checkpoints, AI splines) | Standard pipeline, fast iteration |
| Architecture | ECS (bitECS or similar) | Scales as bikes/projectiles/AI grow |
| Input | Gamepad-first, keyboard fallback | Arcade racing wants analog sticks/triggers |
| Audio | Library SFX + royalty-free music | Engineering effort goes into dynamic engine sound + mixing |
| Distribution | Static build, self-hosted (Cloudflare Pages / Vercel) | Free, simple, shareable URL |

## Success criteria

- ✅ Wave physics feel "Wave-Race-y" — pumping waves, launches, hard landings all readable. (Surface alignment + per-bike `surfaceFollow` make different bikes ride waves visibly differently.)
- ✅ Cliff-to-water transitions feel dramatic, not janky. (Cliffside's 15m drop ships in M9.13.)
- 🟡 AI keeps the pack tight every race. (AI completes <50% of laps cleanly through the corners — a known polish item; works fine on straights, hits the apex hard.)
- ✅ Boots in <5s on broadband, holds 60 FPS on M1/Ryzen-class at 1080p
- 🟡 A non-gamer friend finishes a race without instruction. (Untested with a real non-gamer; HUD + direction arrow + trail visuals are designed for it.)

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
