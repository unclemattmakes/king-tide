# Platform & browser support

## Target

**Web-first.** A single static bundle that runs in the browser. Hosted on Vercel; pushes to `main` auto-deploy. No native client today.

## Renderer

The game probes for a real **WebGPU** adapter on boot and uses it if present. Otherwise it falls back to **WebGL2**. There's no software-renderer fallback for the user — if neither pipeline is available, the boot fails loudly.

| Pipeline | Used when | Notes |
|---|---|---|
| WebGPU | adapter present | Preferred. The GPU water shader (Gerstner + dimple + bike-wake displacement) only really shines here. |
| WebGL2 | no WebGPU adapter | Works. The TSL water shader still runs; expect lower fps under heavy chop on integrated GPUs. |

The renderer choice is set once at boot. If you want to force a path for debugging, see [URL parameters](/reference/url-params).

## Browser compatibility

| Browser | WebGPU status | Verdict |
|---|---|---|
| Chrome / Edge ≥ 121 | enabled by default on Win/Mac/Linux | ✅ best experience |
| Firefox ≥ 141 (or Nightly with `dom.webgpu.enabled`) | enabled on supported builds; falls back otherwise | ✅ |
| Safari ≥ 17.4 (Tahoe / iOS 18) | enabled by default | ✅ |
| Older versions of any of the above | WebGL2 fallback | ✅ — slightly slower |
| Browsers without WebGL2 (very old IE-era engines) | unsupported | ❌ |

## Hardware

- **Desktop / laptop GPU** is the assumed baseline. Anything that runs WebGPU comfortably (≈ 2018+ discrete GPU or 2020+ integrated) hits 60 fps.
- **Mobile** runs but isn't tuned. iOS Safari ≥ 17.4 and recent Android Chrome both load; touch input has no on-screen overlay yet (see [Controls — Touch](/build/controls#touch)).

## Inputs

| Class | Status |
|---|---|
| Keyboard | ✅ supported |
| Gamepad (Standard mapping — Xbox, PS4/5, generic XInput) | ✅ supported, recommended |
| Mouse | ✅ camera orbit only |
| Touch | ⚠️ wired (axes merge into the input stream) but no on-screen UI |

The Gamepad API is read every frame from `navigator.getGamepads()`. Plug a controller in **before** the page loads or after — both work; first input from a stick or trigger latches it as the primary input.

## Testing surfaces

| Layer | Tool | Notes |
|---|---|---|
| Unit | Vitest | Sim layer only — must not import Three.js. |
| End-to-end | Playwright | Runs against a real Vite dev server with real WebGPU / WebGL2. **Headed by default** — the GPU water shader tanks under headless WebGL2's SwiftShader. Set `E2E_HEADLESS=1` for CI. |

## Hosting

Vercel push-to-deploy from `main`. Cloudflare CDN is ready but not yet attached to a custom domain.
