# Hoverbike Tauri wrapper

Native desktop + Steam Deck wrapper for the Hoverbike web build. See
[`docs/steam-deck.md`](../docs/steam-deck.md) for the planning doc.

## Prereqs

1. **Rust** (1.78+). `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
2. **Tauri CLI**. `cargo install tauri-cli --version "^2.0" --locked`
3. **System libs** (Linux only). On Ubuntu/Arch/SteamOS:

   ```sh
   sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
   ```

   Steam Deck Desktop Mode has these via `pacman` (`webkit2gtk-4.1`, `gtk3`, etc.).

## Building

From the repo root:

```sh
pnpm build:deck       # web build + AppImage
```

That runs `pnpm build` (Vite → `dist/`), then `cargo tauri build` here,
which writes the AppImage to `src-tauri/target/release/bundle/appimage/`.

For dev (live-reload from the Vite dev server):

```sh
cd src-tauri && cargo tauri dev
```

## Steamworks

Steamworks integration is feature-gated behind the `steam` cargo
feature. Without it (the default), every `steam::*` call is a no-op
stub — the wrapper builds + runs without the SDK installed. Useful for
local iteration before we have an App ID assigned.

To enable Steamworks for a real release:

1. Download the [Steamworks SDK](https://partner.steamgames.com/) and
   extract to a directory.
2. Set `STEAM_SDK_LOCATION=/path/to/sdk` in your shell.
3. Build with the feature on:

   ```sh
   cd src-tauri && cargo tauri build --features steam
   ```

4. For local dev, also place a `steam_appid.txt` in this directory
   with the App ID on a single line (gitignored). At runtime, Steam
   prefers `STEAM_APPID` from the environment.

The integration today is a scaffold: `cmd_record_achievement` and
`cmd_set_rich_presence` are wired as Tauri commands invokable from the
web side via `@tauri-apps/api/core → invoke()`, but the SDK calls
inside them are TODO stubs. See `src/steam.rs`.

## Icons

Replace the placeholders in `icons/` with the real art when v1 lands.
Tauri expects:

- `32x32.png`, `128x128.png`, `128x128@2x.png` (Linux)
- `icon.icns` (macOS)
- `icon.ico` (Windows)

`cargo tauri icon path/to/source.png` generates all sizes from a 1024²
master.

## CI

The `.github/workflows/build-deck.yml` workflow runs on tag pushes
(`v*`) and on manual dispatch — it builds the AppImage on a Linux
runner and uploads it as a release artifact. Steamworks is left off
in CI; flip the workflow's `--features` flag once we have an SDK
checkout in the runner's cache.
