# Steam Deck — build path + tuning

Live path for shipping Hoverbike to the Steam Deck. The desktop wrapper is
Electron (`electron/`); the runtime profile (framerate cap,
fullscreen-on-launch, pixel ratio, AudioContext resume-after-sleep)
auto-activates when the boot path detects a Deck. Steamworks SDK hookup is a
tracked follow-up (nothing functional shipped in the earlier Tauri shell).

Pairs with [`docs/cross-browser.md`](./cross-browser.md) (the web side)
and the M-series milestones in
[`docs/implementation-plan.md`](./implementation-plan.md).

## Wrapper: Electron

We wrap the existing Vite-built web bundle in
[Electron](https://www.electronjs.org/). This replaced an earlier Tauri 2
attempt. On SteamOS, Tauri's native WebView is WebKitGTK, which (a) couldn't
launch inside the Steam Linux Runtime container — it dynamically links a
sprawl of host libs the container doesn't provide — and (b) had no usable
WebGPU, so the renderer fell back to WebGL2. Electron bundles its own
Chromium, so it runs in the runtime container and gets real WebGPU on the
Deck's RADV/Vulkan stack.

| Property | Electron | Tauri 2 (rejected) |
|---|---|---|
| Runtime | Bundled Chromium (consistent everywhere) | Native WebView (WebKitGTK on SteamOS) |
| WebGPU on Deck | Yes (Vulkan/Dawn) | No — WebGL2 fallback |
| Steam Linux Runtime | Launches (self-contained) | Failed to launch |
| Binary size | ~210 MB tree | ~5–10 MB |
| Steam integration | `steamworks.js` (Node addon) | `steamworks` crate (Rust) |

The size cost is the price of a Chromium that actually runs and renders on
the Deck. Steamworks features (achievements, cloud saves, Rich Presence)
will hook in via `steamworks.js` in the Electron main process — a tracked
follow-up; the old Tauri stubs were never called from the web side.

### Layout

```
electron/
├── main.cjs            # main process: app:// scheme, WebGPU/Vulkan flags,
│                       #   --no-sandbox, Deck UA bridge, window config
└── icons/              # platform icons (png set + .ico)
electron-builder.yml    # packaging: linux `dir` tree + windows nsis
```

`electron/main.cjs` serves `dist/` over a secure custom `app://bundle/`
scheme (so Vite's absolute asset paths resolve and WebGPU gets a secure
context), bakes in `--no-sandbox` (depot files aren't SUID, so the
chrome-sandbox helper can't initialise inside the runtime container), and
appends a `SteamDeck` UA token when Steam launches us with `SteamDeck=1` so
`detectSteamDeck()` fires reliably in a shipped build.

## Steam Deck specifics

### Gaming Mode vs Desktop Mode

The Deck boots into **Gaming Mode** (a SteamOS shell, controller-only,
no keyboard) by default. Most players never leave it. **Desktop Mode**
is a full Plasma desktop reachable via the Steam button → Power → Switch
to Desktop. The game must:

- Boot to full-screen in Gaming Mode with no keyboard prompts.
- Render the title screen at 1280×800 with all interactive elements
  reachable by gamepad (no hidden mouse-only UI).
- Survive being suspended mid-race when the Deck sleeps (see
  *Sleep / resume* below).

### Resolution: 1280×800 (16:10)

The current HUD was sized for 16:9 widescreen; the menu cathedral and
Settings overlay need a sanity check at 800px tall. The dedicated spec
[`tests/e2e/menu-flow-deck-resolution.spec.ts`](../tests/e2e/menu-flow-deck-resolution.spec.ts)
asserts no vertical scroll on the title and mode-select screens at
1280×800 — if you add a new menu screen, extend that spec.

The OLED Deck panel is still 1280×800; only the LCD/OLED distinction
matters for refresh rate.

### Framerate: default 60 fps cap

- LCD Deck = 60 Hz panel.
- OLED Deck = 90 Hz panel.

The Deck profile (`src/engine/steam-deck.ts → applyDeckProfile()`)
defaults to a **60 fps cap** because (a) the LCD model can't display
more, and (b) on the OLED model letting the APU hit 90 fps spikes
package power past 12 W, drains the 50 Wh battery, and pushes thermals
into throttling territory. Players who want 90 Hz can override in
Settings.

### Battery + thermals

Target: **≤ 12 W average package power for 60+ minutes of play**.
That's two full circuit cups on a charge. Practical art-pass guidance:

- Aggressive LOD on track props past 80 m.
- Shadow map at 1024² or lower (currently 2048²).
- No MSAA — rely on FXAA / TAA at 1× pixel ratio.
- Water mesh tessellation halved beyond the bike's current ring (LOD'd).
- Particle counts capped via the framerate cap's downstream knobs (see
  the perf domain, owned by the parallel Accessibility / Perf agent).

These are guidance, not hard limits — final tuning is a profiling pass
on a real Deck once the v1 art lands.

### Input: gamepad-only by default

The Steam Input layer maps Deck buttons to a virtual Xbox 360 pad. Our
existing gamepad code path consumes that pad transparently — no
Deck-specific input code is needed for v1.

The rebind menu (when it lands) should detect Deck and render Deck
button glyphs (A/B/X/Y, L1/L2/R1/R2, the L4/L5/R4/R5 paddles, the two
trackpads) instead of the generic Xbox glyphs. **Deferred** — note as
a follow-up.

### Sleep / resume

The Deck aggressively suspends to save battery. When the OS
suspends/resumes, the browser fires `visibilitychange` events; the rAF
loop naturally stops while the document is hidden. The game-loop
implementation handles this (see the rAF gate in `src/boot/game-loop.ts`).

Confirm before shipping:

- PartyKit WebSocket survives resume (reconnect via `partysocket` on
  socket close — already implemented).
- AudioContext resumes — Web Audio sometimes leaves the context
  `suspended` after a long sleep. The first user gesture after resume
  should re-`audioContext.resume()`. Add a regression test against a
  manual suspend if/when we hit it on-device.
- Rapier sim doesn't accumulate drift from a stale clock — the fixed
  timestep accumulator caps replay frames so a long suspend won't
  unleash 600 s of catch-up sim on resume.

### Audio: pipewire 48 kHz

SteamOS routes Web Audio through pipewire at 48 kHz. The procedural
audio module (`src/engine/audio/audio.ts`) already lets the platform
pick the sample rate, so this is informational — no code change.

## Steam Deck detection

The runtime helper [`src/engine/steam-deck.ts`](../src/engine/steam-deck.ts)
exposes:

```ts
detectSteamDeck(): { isLikelyDeck: boolean; signals: DeckDetectionSignal[] }
applyDeckProfile(): DeckProfile
getDeckProfile(): DeckProfile | null
```

Detection combines three signals — UA string, native viewport, Steam
virtual gamepad id — and returns true if any fire. False positives are
possible (any 1280×800 desktop browser hits the viewport signal); the
caller is expected to gate `applyDeckProfile()` on `isLikelyDeck` only
where the cost of a false positive is small (e.g. defaulting framerate
to 60 fps on a desktop is a survivable mistake; users can override).

`applyDeckProfile()` latches:

- `framerateCap = 60` (writes through `playerSettings.framerateCap` so
  the Settings → Video row shows it on next open; only when the player
  hadn't already chosen a stricter cap)
- `preferGamepadInput = true` (no player-settings counterpart yet —
  future hook for the rebind menu's glyph swap)
- `requestFullscreenOnGesture = true` (writes
  `playerSettings.fullscreenPreferred`; main.ts requests fullscreen on
  the first audio-unlock gesture)

`main.ts` calls `detectSteamDeck()` early in boot (after
`loadPlayerSettings()`) and invokes `applyDeckProfile()` whenever any
detection signal fires. False positives (1280×800 windows on a
desktop) are survivable — players can always flip rows in Settings →
Video to override.

## Build pipeline

The Deck build is part of the broader desktop pipeline. See
[`docs/desktop-builds.md`](./desktop-builds.md) for:

- Toolchain prerequisites (just Node + pnpm; electron-builder fetches
  Chromium).
- The `pnpm build:deck` / `pnpm build:windows` commands and what
  they produce.
- The `.github/workflows/build-desktop.yml` matrix (Linux game tree +
  Windows NSIS in parallel) — manual dispatch + `v*` tag trigger.
- Steam Partner depot layout (Linux + Windows on the same App ID;
  Deck is told to prefer the Linux depot via the Verified flag).
- Sideload instructions for the Linux tree / .exe.

This doc keeps its focus on the **Deck-specific runtime concerns**
(battery, framerate cap, Gaming Mode, sleep/resume); for everything
build-process, go to desktop-builds.md.

## Sideload + Gaming Mode testing

See [`docs/desktop-builds.md` → Local sideload](./desktop-builds.md#local-sideload-testing-without-steam)
for the `scp` + `chmod +x` flow and the "Add a Non-Steam Game"
trick for Gaming Mode coverage.

## Steam Input default config

Ship a default Steam Input config to the Workshop so first-launch Deck
players get sensible bindings without manual setup. The config maps:

- Left stick → steer + throttle (forward / back)
- Right stick → camera orbit
- A → confirm / accept
- B → cancel / back
- R2 → throttle (alternative)
- L2 → brake / reverse
- R1 → fire pickup
- L1 → boost
- View / Menu → pause / Settings

Upload via Big Picture: gear icon → Steam Input → Export → Publish New
Personal Config → "Set as official". This is a Steamworks operation,
done once after first Steam release.

## What's wired today

- **Electron wrapper** (`electron/main.cjs`, `electron-builder.yml`) —
  serves `dist/` over `app://`, enables WebGPU/Vulkan, `--no-sandbox`,
  Deck UA bridge. Steamworks not yet wired (tracked follow-up).
- **`pnpm build:deck` / `pnpm build:windows`** — orchestrators at
  `tools/build-deck.mjs` / `tools/build-windows.mjs`.
- **CI workflow** — `.github/workflows/build-desktop.yml`, manual + tag-
  triggered matrix (Linux game tree + Windows NSIS installer), attaches
  the Linux tarball + installer to GitHub Releases.
- **Boot wiring** — `main.ts` calls `detectSteamDeck()` +
  `applyDeckProfile()`; `playerSettings.framerateCap`,
  `pixelRatio`, `fullscreenPreferred` rows live in Settings → Video.
- **Frame cap** — `src/engine/render/frame-cap.ts` + game-loop gate.
- **AudioContext resume-after-sleep** — `main.ts` listens for
  `visibilitychange` and re-calls `audio.resume()` on `visible`.
- **Deck button glyph pack** — `src/engine/input/deck-glyphs.ts`
  (data only; wiring into the rebind menu is the next follow-up).

## Open follow-ups

- Steamworks SDK integration via `steamworks.js` in the Electron main
  process (achievements, cloud save for best-lap records, Rich
  Presence). Nothing functional shipped before — the old Tauri stubs
  were never called from the web side.
- Rebind menu glyph swap — read `glyphSourceForGamepadId(pad.id)` and
  call `glyphFor(idx, source)` instead of the current standard labels.
- On-device profiling pass once v1 art lands — confirm the ≤ 12 W
  battery target with the framerate cap engaged.
- Steam Input default config — publish via Big Picture once we have a
  Steam App ID.
