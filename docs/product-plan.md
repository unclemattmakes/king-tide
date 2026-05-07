# Hoverbike — Product Plan v0.1

> Web-first arcade hover-bike racer. JetMoto homage with Wave Race water physics and light Mario Kart combat.

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

## MVP — "Playable Demo"

**Done when:** a stranger lands on the page, races AI on a water+land+verticality course, uses 1-2 weapons, finishes 3 laps, and wants a rematch.

### In scope

- 1-2 hand-authored tracks (Blender → glTF), each with water + land + verticality
- 2-3 hover bikes with distinct stat tradeoffs (top speed / handling / accel)
- 5-7 rubber-banded AI opponents per race
- Single 3-lap race mode
- 4 pickups: homing missile, mine, boost, shield
- Gerstner-wave water with buoyancy & wake; raycast hover controller on land
- Gamepad-first input, keyboard fallback
- Library SFX + royalty-free music; engine SFX, weapon SFX, ambient
- WebGPU-first renderer with WebGL2 fallback

### Out of scope (v1)

- Multiplayer (architecturally allowed via Rapier determinism — not built)
- Career mode, unlocks, save state
- Mobile / touch
- Original soundtrack
- Track editor
- Final art direction (placeholders until physics feels right)

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

- Wave physics feel "Wave-Race-y" — pumping waves, launches, hard landings all readable
- Cliff-to-water transitions feel dramatic, not janky
- AI keeps the pack tight every race
- Boots in <5s on broadband, holds 60 FPS on M1/Ryzen-class at 1080p
- A non-gamer friend finishes a race without instruction

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
