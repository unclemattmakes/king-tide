# Hoverbike

Web-first arcade hover-bike racer. JetMoto homage with Wave Race water physics and light Mario Kart combat. Three.js + WebGPU + Rapier WASM, gamepad-first.

- [Product plan](docs/product-plan.md)
- [Implementation plan](docs/implementation-plan.md)
- [Blender track conventions](docs/blender-conventions.md)

## Develop

```bash
pnpm install
pnpm dev          # http://localhost:5191
pnpm test         # unit (Vitest)
pnpm e2e          # end-to-end (Playwright)
pnpm typecheck
pnpm lint
```

## Status

M0 — boot scaffolding. Renderer + gamepad + debug API + smoke test.
