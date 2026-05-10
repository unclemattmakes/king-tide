# ADR 0003 — Renderer: Three.js, WebGPU-first with WebGL2 fallback

**Status:** Accepted

## Context

The visual target — Gerstner-wave water with planar reflections,
bike-driven wake displacement, foam accumulation, particle FX,
shadow-casting bikes / props / terrain — needs a renderer that
supports modern shader authoring without forcing us to write the
full pipeline by hand.

The two realistic options were a hand-rolled WebGL2/WebGPU
pipeline, or Three.js. A hand-rolled stack would give tighter
control over every draw call but is months of plumbing before we
can iterate on visuals. Three's TSL (Three Shader Language, the
node-graph shader system) lets us write the water shader once and
have it compile down to either WebGPU or WebGL2 GLSL, which is the
critical capability for water + wake here.

## Decision

Use Three.js (currently 0.184) as the renderer. Default to the
WebGPU backend; fall back to WebGL2 when WebGPU is unavailable.
The `createRenderer` factory in `src/engine/render/renderer.ts`
encapsulates the backend probe and exposes which one was picked
via the HUD's `backend` pill.

Water uses TSL nodes so the same shader runs on both backends.
Effects that genuinely need the WebGPU path (compute-style work)
should gate on `backend === 'webgpu'` and provide a graceful
degradation, not refuse to run on WebGL2.

## Consequences

- **Shaders are TSL-first.** Adding a new effect means working in
  the node graph, not raw GLSL. See `src/engine/render/water.ts` and
  `src/engine/render/fx/` for examples.
- **Bundle size is dominated by Three.** ~1 MB minified, ~250 kB
  gzipped, before our own code. This is the main reason the
  unconditional debug-UI imports were called out in the May 2026
  code review and lazy-loaded in PR #40.
- **Cross-backend testing is on the human.** Vitest runs sim-only;
  Playwright e2e tests run against a real dev server, so they catch
  WebGPU / WebGL2 mismatches in practice but not in CI hardware
  variety.
- **Three version pinned.** Major-version Three upgrades have
  historically broken the TSL surface. Treat upgrades as a
  scheduled change, not an opportunistic one.
