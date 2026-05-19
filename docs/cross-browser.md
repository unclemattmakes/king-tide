# Cross-browser support

Practical reference for what works where, how to run the multi-browser
e2e suite, and the platform gaps we know about. Pairs with
[`docs/steam-deck.md`](./steam-deck.md) for the desktop-wrapper story.

## Support matrix

| Browser | Tier | Platform | Notes |
|---|---|---|---|
| Chrome / Chromium | 1 | Linux, macOS, Windows | Primary dev target. Real GPU through ANGLE. WebGPU on by default. |
| Edge | 1 | Windows, macOS | Same renderer as Chrome; presumed parity, not separately tested. |
| Firefox | 1 | Linux, macOS, Windows | WebGL2 fallback path. WebGPU is shipping in stable as of 2026; we still default to WebGL2 there until the node-material WGSL fallback lands. |
| Safari | 2 | macOS 14+, iPadOS 17+, iOS 18.2+ | WebGPU lit up in iOS 18.2 / Safari 18.2 (Dec 2024). Touch overlay is the only mobile-tested input path; see "Mobile + touch" below. |
| Mobile Chrome (Android) | 3 | Android 13+ | Touch overlay works; performance is highly device-dependent. Not in the regular test rotation. |
| WebKitGTK (Steam Deck) | 2 | SteamOS | The Tauri 2 wrapper target — see [`docs/steam-deck.md`](./steam-deck.md). Software WebGL in Playwright, real GPU on-device. |

Tier 1 = green CI required before merge. Tier 2 = manual smoke on each
release. Tier 3 = best-effort, no commitment.

## Running cross-browser e2e

The Playwright config gates the extra browsers behind `E2E_BROWSERS` —
unset means Chromium-only so the day-to-day `pnpm e2e` stays fast.

```bash
# Default — Chromium only.
pnpm e2e

# All three browsers (slow; ~3× wall time).
E2E_BROWSERS=all pnpm e2e

# Subset.
E2E_BROWSERS=chromium,firefox pnpm e2e
E2E_BROWSERS=webkit pnpm e2e
```

Headed vs headless is a separate axis controlled by `E2E_HEADLESS=1`.
Locally the suite runs headed so Chromium has a real GPU; CI flips
to headless on a display-less runner.

### Installing browser binaries

Playwright bundles its own Chromium / Firefox / WebKit builds. You
need them locally before the cross-browser run will work:

```bash
pnpm e2e:install            # only pulls Chromium (current default)
pnpm exec playwright install firefox webkit  # for cross-browser
```

CI installs all three when `E2E_BROWSERS=all` is set.

## Known platform gaps

### WebKit on Linux uses software WebGL

WebKitGTK in Playwright has no real GPU passthrough — its WebGL pipeline
runs through llvmpipe. The water shader is too heavy for single-digit fps;
specs that depend on physics-driven motion (`m2-water.spec.ts`) carry a
`test.skip(browserName === 'webkit' && platform === 'linux', …)` guard.

`m9-audio.spec.ts` has the same guard for a different reason: WebKit's
AudioContext stays suspended under the test harness's synthetic user
gesture, so the M-key mute toggle never observes audio state changes.

**To run real WebKit coverage on those specs**, run the suite on macOS
where WebKit has actual GPU + audio. The Playwright projects are
platform-agnostic; only the skip predicates fire on Linux.

### Firefox WebGPU is opt-in until further notice

Firefox shipped WebGPU in stable in 2026 but our node-material water
shader has a WGSL path the Firefox compiler hasn't fully validated
against. The renderer auto-selects WebGL2 on Firefox by checking
`navigator.gpu.requestAdapter()` first; if that returns null we drop
to the WebGL2 backend transparently. See
[`src/engine/render/renderer.ts`](../src/engine/render/renderer.ts).

To force-test WebGPU on Firefox, set `dom.webgpu.enabled=true` in
`about:config` and reload — the renderer will pick the WebGPU path
if the adapter resolves.

### Safari WebGPU needs iOS 18.2+ / macOS Sonoma+

Earlier iOS/macOS Safari falls back to WebGL2. On `?backend=` — there
isn't one; the renderer is auto-selecting. If you need to force a
backend for debugging, edit `renderer.ts` locally; we don't ship a
URL toggle because the only legitimate cross-backend reason is
performance comparison, which is better done in a profile build.

## WebGPU vs WebGL2 fallback

The renderer always instantiates `WebGPURenderer` from `three/webgpu`,
which internally falls back to WebGL2 if `forceWebGL: true` is set.
We probe `navigator.gpu.requestAdapter()` first so the HUD reports
the *actual* backend (the WebGPURenderer's silent fallback would
otherwise mask which path is live).

Backend selection lives in
[`src/engine/render/renderer.ts`](../src/engine/render/renderer.ts).
The current HUD chip `#hud-backend` reads `webgpu` or `webgl2`.

The TSL node-material pipeline (used for the Gerstner water shader)
compiles to WGSL on WebGPU and GLSL on WebGL2 — both paths exercise
the same scene graph. Visual parity is good enough for shipping; the
WebGL2 path is ~10–15% slower on the GPU-water portion.

## Mobile + touch

The touch overlay is P2 in `docs/design-targets.md` (when that file
lands). Today the only test coverage for the touch input layer is
[`tests/unit/touch-intent.test.ts`](../tests/unit/touch-intent.test.ts),
which exercises the intent-from-touch math (deadzones, octants, dual
thumb-stick translation). Mobile Safari + Chrome Android render the
game fine at low quality settings, but we don't run e2e against them —
the cross-browser smoke (`tests/e2e/cross-browser-smoke.spec.ts`)
only covers desktop viewports.

## Testing Safari without a Mac

Short answer: you can't. Playwright's WebKit on Linux uses WebKitGTK,
which is the engine used by Steam Deck's WebKit + the Linux Tauri
wrapper — *not* the Safari you find on macOS / iOS. Behaviour overlaps
heavily but isn't identical, especially around media + audio.

For real Safari coverage:
- macOS: `E2E_BROWSERS=webkit pnpm e2e` on a Mac — the GPU-heavy skip
  predicates only fire on Linux, so the full suite runs.
- iOS / iPadOS: manual smoke on a real device against the deployed
  build. There's no automated path yet.

## Bug triage

When a bug only repros in a particular browser, file it with:

1. **Browser + version**: e.g. "Firefox 142.0.1 on macOS 14.5".
2. **GPU info**: paste from `chrome://gpu/` (Chromium),
   `about:support` → Graphics (Firefox), or
   *Apple → About This Mac → Displays* (Safari).
3. **Playwright trace**: if it reproduces in e2e, attach the
   `playwright-report/` `trace.zip`. Run with `--trace=on` to force
   capture on every test.
4. **HUD backend chip** + **devicePixelRatio** + **viewport size** —
   readable from the HUD or `window.devicePixelRatio` /
   `innerWidth × innerHeight`. The backend chip distinguishes a
   WebGPU regression from a WebGL2 regression.

For visual diffs, screenshot all three browsers side-by-side and
attach. The cross-browser smoke test stashes a per-browser screenshot
in its trace; pull those for a known-good baseline.

## CI policy

- `pnpm e2e` (Chromium-only) runs on every PR. Required.
- `E2E_BROWSERS=all pnpm e2e` runs nightly. Failures open a Slack
  alert but don't block PR merges — the cross-browser surface is
  noisier than the Chromium one and we treat regressions as
  follow-up tickets, not merge blockers.
