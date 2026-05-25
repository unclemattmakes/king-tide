# Desktop builds (Linux + Windows)

How Hoverbike ships as a native desktop game across Linux (Steam Deck +
generic desktops) and Windows. macOS is intentionally deferred — we'd
need a Mac for testing before adding the target.

Pairs with [`docs/steam-deck.md`](./steam-deck.md) (Deck-specific
runtime tuning) and [`docs/cross-browser.md`](./cross-browser.md) (web
build compatibility).

## Targets

| Customer platform | Bundle | Build host | What runs |
|---|---|---|---|
| Steam Deck | `Hoverbike_*.AppImage` | `ubuntu-22.04` (CI) or any Linux dev box | Native AppImage — no Proton |
| Linux desktop | `Hoverbike_*.AppImage` + `.deb` | same | Native |
| Windows desktop | `*-setup.exe` (NSIS) + `*.msi` | `windows-latest` (CI) or any Windows dev box | Native WebView2 |
| macOS | — | (not yet) | (not yet) |

Steam routes the right bundle to each customer via per-platform
depots. On the Deck Steam prefers a native Linux depot when one
exists, skipping Proton entirely — better battery + fewer surprises
than Windows-via-Proton.

## Toolchain prerequisites

These apply to **whoever builds** an installer. End users get the
bundle via Steam and need nothing. The CI workflow installs all of
this automatically on a clean runner — local installs are only
needed for iteration outside the CI loop.

### Linux host (Steam Deck Desktop Mode, Ubuntu, Arch, …)

```sh
# Rust + Cargo
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Tauri CLI
cargo install tauri-cli --version "^2.0" --locked

# System libs (Ubuntu/Debian)
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
                 libayatana-appindicator3-dev librsvg2-dev patchelf

# Arch / SteamOS Desktop Mode
sudo pacman -S webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg
```

### Windows host

1. **Rust** — run `rustup-init.exe` from
   [rust-lang.org/tools/install](https://www.rust-lang.org/tools/install).
2. **MSVC build tools** — Visual Studio Build Tools 2022 with the
   C++ workload and the latest Windows SDK. The free Build Tools
   bundle is enough; you don't need a full Visual Studio.
3. **Tauri CLI** — `cargo install tauri-cli --version "^2.0" --locked`.
4. **WebView2** — pre-installed on Windows 10 (1809+) and 11. Tauri's
   NSIS installer bundles a download-bootstrapper for the rare case
   where it's missing.

### Icons

The repo ships **solid-teal placeholder icons** so a fresh checkout
builds end-to-end without art. Regenerate via:

```sh
pnpm gen:icons
```

That writes `src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png` and
a real Windows `icon.ico` (PNG-in-ICO container). Replace with the v1
art via:

```sh
cd src-tauri && cargo tauri icon path/to/master-1024.png
```

`cargo tauri icon` generates Linux PNGs + Windows ICO + macOS ICNS
from a single 1024² master. Use that flow once real art lands.

## Build commands

```sh
# Linux AppImage (run on a Linux host)
pnpm build:deck

# Windows NSIS installer (run on a Windows host)
pnpm build:windows

# Web build only (no native wrapper)
pnpm build
```

Both scripts:

1. Run `pnpm build` so `dist/` is fresh.
2. Probe `cargo tauri --version`. Print friendly install instructions
   and exit `127` if it's missing.
3. Run `cargo tauri build` for the relevant target.
4. Forward extra args — `pnpm build:deck -- --features steam` for the
   Steamworks-enabled Linux build (once an SDK is staged).

Outputs:

```
src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/Hoverbike_*.AppImage
src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb/Hoverbike_*.deb
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Hoverbike_*-setup.exe
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Hoverbike_*.msi
```

### Cross-compile from Linux → Windows?

Technically possible via `mingw-w64` + the `x86_64-pc-windows-gnu`
Rust target, but Tauri 2's NSIS bundler invokes Windows-native tools
that aren't trivial to `wine`-emulate. **Use CI or a Windows host.**

`pnpm build:windows` on Linux bails out with a clear pointer to the
CI workflow. To override and try anyway (errors expected):
`FORCE_CROSS=1 pnpm build:windows`.

## CI workflow

`.github/workflows/build-desktop.yml` — manual dispatch + tag-
triggered. Matrix:

- `ubuntu-22.04` → Linux AppImage + deb
- `windows-latest` → Windows NSIS + msi

On `v*` tag pushes both bundles attach to the GitHub Release. On
manual dispatch they upload as workflow artifacts (30-day retention).

Trigger a release build:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

Or run a one-off via the Actions tab → "build-desktop" → Run
workflow. The `steam_feature` input enables the `steam` cargo
feature for the Linux build (requires `STEAM_SDK_LOCATION` in a
self-hosted runner; current public runners can't link the SDK).

## Steam distribution

The SteamPipe upload layer is scaffolded in [`steam/`](../steam/) and
the manual-dispatch workflow lives at
[`.github/workflows/release-steam.yml`](../.github/workflows/release-steam.yml).
Full recipe in [`steam/README.md`](../steam/README.md); summary here.

1. **Steamworks SDK (optional for upload)** — required only for the
   in-game Steamworks features (achievements, presence). To enable:
   download from the Partner backend, extract to a known path, set
   `STEAM_SDK_LOCATION`, build with `pnpm build:deck -- --features
   steam`. SteamPipe upload itself doesn't need the SDK — `steamcmd`
   is enough.
2. **Get App + depot IDs from the Partner backend.** Once Valve has
   provisioned a Steam App ID, set up two depots (Linux + Windows)
   in the SteamPipe section.
3. **Bake build-account credentials** — see *First-time setup* in
   [`steam/README.md`](../steam/README.md). One interactive
   `steamcmd +login` on a trusted machine produces a `config.vdf` +
   `ssfn` token that CI can reuse non-interactively.
4. **Drop the IDs + credentials into GitHub repo secrets** (or local
   env for a dev-box upload). The `release-steam.yml` workflow's
   `Required repository secrets` block names them.
5. **Trigger the workflow** — Actions tab → release-steam → Run
   workflow. Pick the build-desktop run to ship + a set_live branch
   (blank = upload only, human picks live build via the Steamworks
   web UI). Run with `preview=true` first for a SteamPipe dry-run.
6. **Mark the Linux depot as Steam Deck verified** in the App admin
   so the Deck always picks the native Linux build over Proton. The
   Steamworks docs cover the Verified rating checklist.

For local uploads from a dev box: `pnpm steam:upload` after
`pnpm build:deck` and `pnpm build:windows`. `pnpm steam:dry-run` to
validate the staging + VDF rendering without contacting Steam.

## Local sideload (testing without Steam)

### Linux AppImage on a Deck (Desktop Mode)

```sh
# From your dev box
scp src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/Hoverbike_*.AppImage \
    deck@<deck-ip>:/home/deck/Apps/hoverbike.AppImage

# On the Deck (Desktop Mode terminal)
chmod +x ~/Apps/hoverbike.AppImage
~/Apps/hoverbike.AppImage
```

To exercise Gaming Mode: in Desktop Mode → Steam → Games → "Add a
Non-Steam Game" → browse to the AppImage → Add. Then switch to
Gaming Mode; the shortcut appears in your library.

### Windows .exe

```ps1
# Double-click the NSIS installer or run silently:
.\Hoverbike_0.0.0_x64-setup.exe /S
```

The installer drops shortcuts in the Start menu + Desktop. Uninstall
via Apps & features.

## Troubleshooting

- **`pkg-config exited with status code 1`** (Linux build) — missing
  webkit2gtk dev libs. Install per "Linux host" above.
- **`failed to run custom build command for windows-sys`** — missing
  MSVC Build Tools. Install Visual Studio Build Tools 2022 with the
  C++ workload + Windows SDK.
- **`icon not found: icons/32x32.png`** — run `pnpm gen:icons` from
  a fresh checkout.
- **AppImage size ≈ 100 MB** — expected. The bundle includes
  webkit2gtk + gstreamer plugins so it runs on Decks with different
  libwebkit versions. Strip and re-bundle without gstreamer if size
  matters; see `bundle.linux.appimage.bundleMediaFramework` in
  `tauri.conf.json` (currently `false` — gstreamer plugins not
  bundled).
- **Stuck on `Downloading https://github.com/tauri-apps/binary-
  releases/…`** — Tauri caches AppImage tooling (`linuxdeploy`,
  `AppRun`) on first build. Subsequent builds reuse the cache.
