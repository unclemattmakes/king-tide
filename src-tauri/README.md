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
pnpm build:deck       # web build + Linux AppImage + .deb (run on Linux)
pnpm build:windows    # web build + Windows NSIS .exe + .msi (run on Windows)
```

Each runs `pnpm build` (Vite → `dist/`), then `cargo tauri build` here for
the relevant target. Linux bundles land in
`src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/{appimage,deb}/`;
Windows installers in
`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/{nsis,msi}/`.

Windows installers must be built on a Windows host (or CI on
`windows-latest`) — Tauri's NSIS bundler invokes Windows-native tools.
`pnpm build:windows` bails out with a pointer to CI when run on
Linux/macOS. See [`docs/desktop-builds.md`](../docs/desktop-builds.md).

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

The repo ships **solid-teal placeholder icons** (PNGs at 32 / 128 /
256 / 512 px plus a real Windows `icon.ico`) so `cargo tauri build`
succeeds end-to-end before the v1 art lands. Generate via:

```sh
pnpm gen:icons               # writes src-tauri/icons/*.png + icon.ico
```

When the real art arrives, drop a 1024² master and run:

```sh
cd src-tauri && cargo tauri icon path/to/master.png
```

That generates all four PNG sizes for Linux plus the `icon.ico`
(Windows) container; pass `--icns` once a macOS target is added.
`tauri.conf.json` currently bundles Linux (`appimage`, `deb`) and
Windows (`nsis`, `msi`) targets.

## CI

The `.github/workflows/build-desktop.yml` workflow runs on tag pushes
(`v*`) and on manual dispatch — a matrix that builds the Linux AppImage
on `ubuntu-22.04` and the Windows NSIS `.exe` + `.msi` on
`windows-latest`, uploading both as artifacts (and attaching them to the
GitHub Release on `v*` tags). Steamworks is left off in CI; flip the
workflow's `steam_feature` input once we have an SDK checkout in the
runner's cache.
