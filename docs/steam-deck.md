# Steam Deck — build path + tuning

Live path for shipping Hoverbike to the Steam Deck. The Tauri 2 wrapper
scaffold is in `src-tauri/`; the runtime profile (framerate cap,
fullscreen-on-launch, pixel ratio, AudioContext resume-after-sleep)
auto-activates when the boot path detects a Deck. The Steamworks SDK
hookup is feature-gated and stubbed until we have an App ID.

Pairs with [`docs/cross-browser.md`](./cross-browser.md) (the web side)
and the M-series milestones in
[`docs/implementation-plan.md`](./implementation-plan.md).

## Wrapper: Tauri 2

We wrap the existing Vite-built web bundle in
[Tauri 2](https://v2.tauri.app/). Why Tauri over Electron / NW.js:

| Property | Tauri 2 | Electron |
|---|---|---|
| Binary size | ~5–10 MB | ~150 MB |
| Runtime | Native WebView (WebKitGTK on SteamOS) | Bundled Chromium per app |
| Update channel | Single AppImage / Steam delta | Full re-download |
| Steam integration | [`steamworks` crate](https://crates.io/crates/steamworks) (Rust) | `node-steam` (Node addon) |
| Build complexity | `cargo tauri build` calls `pnpm build` | Custom multi-step packaging |

The Rust core lets us link the Steamworks SDK directly for achievements,
cloud saves, Rich Presence, and (later) Workshop track sharing without
shimming through Node.

### Target layout

```
src-tauri/
├── Cargo.toml
├── tauri.conf.json
├── src/
│   ├── main.rs           # Tauri app entry
│   └── steam.rs          # Steamworks integration (achievements, presence)
├── icons/
│   └── ...               # platform icons (16/32/128/256, .ico, .icns)
└── build.rs              # links steam_api.so/.dll at build time
```

The `tauri.conf.json` `build.beforeBuildCommand` runs `pnpm build`; Tauri
then picks up the static bundle from `dist/` and packages it.

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

- Toolchain prerequisites (Rust, Tauri CLI, system libs).
- The `pnpm build:deck` / `pnpm build:windows` commands and what
  they produce.
- The `.github/workflows/build-desktop.yml` matrix (Linux AppImage +
  Windows NSIS in parallel) — manual dispatch + `v*` tag trigger.
- Steam Partner depot layout (Linux + Windows on the same App ID;
  Deck is told to prefer the Linux depot via the Verified flag).
- Sideload instructions for AppImage / .exe.

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

- **Tauri 2 scaffold** (`src-tauri/`) — `Cargo.toml`, `tauri.conf.json`,
  `src/main.rs`, `src/steam.rs` (feature-gated Steamworks stubs),
  `build.rs`, capabilities, `.gitignore`. Steamworks is OFF by default;
  build with `--features steam` once an SDK is on disk.
- **`pnpm build:deck`** — orchestrator at `tools/build-deck.mjs`.
- **CI workflow** — `.github/workflows/build-deck.yml`, manual + tag-
  triggered, attaches AppImage to GitHub Releases.
- **Boot wiring** — `main.ts` calls `detectSteamDeck()` +
  `applyDeckProfile()`; `playerSettings.framerateCap`,
  `pixelRatio`, `fullscreenPreferred` rows live in Settings → Video.
- **Frame cap** — `src/engine/render/frame-cap.ts` + game-loop gate.
- **AudioContext resume-after-sleep** — `main.ts` listens for
  `visibilitychange` and re-calls `audio.resume()` on `visible`.
- **Deck button glyph pack** — `src/engine/input/deck-glyphs.ts`
  (data only; wiring into the rebind menu is the next follow-up).

## Open follow-ups

- Steamworks SDK integration in `steam.rs` (achievements, cloud save
  for best-lap records, Rich Presence). The Tauri commands are wired;
  the SDK calls inside them are TODO stubs.
- Rebind menu glyph swap — read `glyphSourceForGamepadId(pad.id)` and
  call `glyphFor(idx, source)` instead of the current standard labels.
- On-device profiling pass once v1 art lands — confirm the ≤ 12 W
  battery target with the framerate cap engaged.
- `release-steam.yml` workflow for `steamcmd app_build` uploads.
- Steam Input default config — publish via Big Picture once we have a
  Steam App ID.
