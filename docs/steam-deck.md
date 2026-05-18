# Steam Deck — build path + tuning

Documented path for shipping Hoverbike to the Steam Deck. This is a
**planned-path** doc: the wrapper isn't built yet, but the technical
choices are locked in so the v1 art pass can target known constraints.

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

- `framerateCap = 60`
- `preferGamepadInput = true`
- `requestFullscreenOnGesture = true`

The actual wiring (calling `applyDeckProfile()` from main.ts on boot)
is intentionally not part of this PR — wiring lives with the
follow-up that adds the Settings-menu entries for the profile knobs.

## Build script (planned, not implemented)

Future `pnpm build:deck` will run:

```bash
pnpm build                                           # existing Vite build → dist/
cd src-tauri
cargo tauri build --target x86_64-unknown-linux-gnu  # AppImage
# Output: src-tauri/target/release/bundle/appimage/hoverbike_*.AppImage
```

Distribution:

1. **Steam Partner backend**: upload via `steamcmd app_build`.
2. **Direct sideload** (testing): ship the `.AppImage` to the Deck via
   `scp` or USB, `chmod +x`, run from Desktop Mode, then add as a
   Non-Steam game for Gaming Mode coverage.

**This PR documents the path; the script + Tauri scaffolding lands in
a follow-up** (parallel agent is shipping the Accessibility surface;
this slice is documentation + cross-browser e2e).

## Testing on a real Deck

### Sideload via Desktop Mode

```bash
scp src-tauri/target/release/bundle/appimage/hoverbike_*.AppImage \
    deck@<deck-ip>:/home/deck/Apps/hoverbike.AppImage
ssh deck@<deck-ip> 'chmod +x /home/deck/Apps/hoverbike.AppImage'
```

Then on the Deck in Desktop Mode: run the AppImage to smoke-test the
windowed path.

### Add as a Non-Steam game for Gaming Mode

In Desktop Mode → Steam → Games → "Add a Non-Steam Game to My
Library", browse to the AppImage, click *Add Selected Programs*. The
shortcut shows up in the library; launch from Gaming Mode to exercise
the controller-only flow.

### Steam Input default config

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

## Open follow-ups

- Tauri scaffolding (`src-tauri/`, `Cargo.toml`, `tauri.conf.json`).
- `pnpm build:deck` script + GitHub Actions build matrix.
- Steamworks integration (`steam.rs`): achievements, cloud save for
  best-lap records, Rich Presence.
- Deck button glyph pack for the rebind menu.
- On-device profiling pass once v1 art lands — confirm the 12 W target.
- AudioContext resume-after-sleep regression test.
