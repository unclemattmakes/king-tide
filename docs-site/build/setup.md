# Setup

Quick start for getting the game running locally.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | Required by the build + Blender wrapper. |
| pnpm | ≥ 10 | The project's package manager. `corepack enable` is the easiest install. |
| Blender | ≥ 5.1 | Only needed if you want to (re)build the asset GLBs from spec. The committed GLBs let you skip this for game-only work. |
| A modern browser | Chrome / Edge ≥ 121, Firefox ≥ 124, Safari ≥ 17.4 | WebGPU recommended; WebGL2 is the fallback. |

See [Platform & browser support](/build/platform) for the full compatibility matrix.

## First run

```bash
pnpm install
pnpm dev          # http://localhost:5191 — auto-falls-through to 5192+ if 5191 is busy
```

That's it. The dev server hot-reloads on save and watches `specs/` to rebuild GLBs in the background (more in [Modding overview](/modding/overview)).

## Common scripts

```bash
pnpm dev               # Vite dev server on :5191
pnpm build             # Production build → dist/
pnpm preview           # Serve the production build locally
pnpm typecheck         # tsc --noEmit
pnpm test              # Vitest unit (sim layer only — no Three.js)
pnpm e2e               # Playwright (real Vite + real WebGPU/WebGL2)
pnpm e2e:install       # One-time: download Chromium for Playwright

pnpm gen:bikes         # Build all bike GLBs from specs/bikes/
pnpm gen:props         # Build all prop GLBs from specs/props/
pnpm gen:tracks        # Build all track GLBs + gameplay JSON from specs/tracks/
pnpm gen:all           # All of the above + manifest
pnpm gen:manifest      # Rewrite public/assets/manifest.json only
```

## Production build

```bash
pnpm build
pnpm preview           # smoke-test the dist/ bundle locally
```

`main` auto-deploys to Vercel. There is **no preview-deploy gate** — if a build is half-broken, the live site goes down with it. Run `pnpm build && pnpm preview` before pushing anything risky.

## Troubleshooting

**Port 5191 already in use.** Vite is configured with fall-through; it will use 5192, 5193, etc. The actual port is printed on dev-server start.

**WebGPU adapter missing.** The renderer probes for a real adapter and falls back to WebGL2 silently. To force one or the other for debugging, see [URL parameters](/reference/url-params).

**Stale state after a big code change.** Vite HMR can leak data into the bitECS stores. Hard-reload (Ctrl+F5) clears it.

**E2E tests are slow / flaky.** They run **headed** by default — the GPU water shader tanks under headless WebGL2's SwiftShader. Set `E2E_HEADLESS=1` if you don't have a display (e.g. CI).

**Blender not found by `pnpm gen:*`.** `tools/blender/run.mjs` checks `$BLENDER_EXE`, then `PATH`, then OS-default install paths. Set `BLENDER_EXE` if your install lives elsewhere.
