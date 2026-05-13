---
layout: home

hero:
  name: Hoverbike
  text: Developer & modder docs
  tagline: Web-first arcade hover-bike racer. Three.js + WebGPU + Rapier WASM. JetMoto homage with Wave Race water and light Mario Kart combat.
  actions:
    - theme: brand
      text: Build & run
      link: /build/setup
    - theme: alt
      text: Modding pipeline
      link: /modding/overview
    - theme: alt
      text: Live build
      link: https://hoverbike-ciaqaossl-oddballcreatureclubs-projects.vercel.app

features:
  - title: Build & Run
    details: Spin up the dev server, learn the controls, and check what browsers and inputs are supported.
    link: /build/setup
    linkText: Get started
  - title: Gameplay
    details: Bike stats, pickup behavior, race rules — what each archetype actually does on the track.
    link: /gameplay/bikes
    linkText: Bike stats
  - title: Modding
    details: Author bikes, props, and tracks from JSON specs. Headless Blender builds the GLBs; the runtime auto-loads them.
    link: /modding/overview
    linkText: Pipeline overview
  - title: Contributing
    details: Architecture rules, testing strategy, and the PR workflow for hacking on the engine itself.
    link: /contributing/
    linkText: Start here
  - title: Reference
    details: Coordinate conventions, the window.__hover debug API, and the URL parameters the game accepts.
    link: /reference/conventions
    linkText: Conventions
---

## What this site is

This is the **dev + modder-facing** documentation. If you're trying to:

- **Run the game locally** or wire up a controller → start in [Build & Run](/build/setup).
- **Make a new bike, prop, or track** → [Modding](/modding/overview).
- **Hack on the engine itself** → [Contributing](/contributing/).
- **Look up a number** (top speed, hover height, pickup behavior) → [Gameplay](/gameplay/bikes).
- **Read the deep design docs** → in-repo [`docs/`](https://github.com/occ-matt/hoverbike/tree/main/docs) plan files (`status.md`, `implementation-plan.md`, `product-plan.md`, ADRs). This site links to them where relevant; it does not duplicate them.

## Project at a glance

| | |
|---|---|
| Repo | [occ-matt/hoverbike](https://github.com/occ-matt/hoverbike) (private) |
| Live build | [hoverbike-…vercel.app](https://hoverbike-ciaqaossl-oddballcreatureclubs-projects.vercel.app) — pushes to `main` auto-deploy |
| Stack | TypeScript · Vite 8 · Three.js (WebGPU + WebGL2) · Rapier WASM · bitECS 0.4 |
| Tooling | pnpm 10 · Vitest · Playwright · Biome 2 · Blender 5.1 (headless) |
| Hosting | Vercel |
