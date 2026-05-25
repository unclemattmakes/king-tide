# Desktop builds (Linux + Windows)

How Hoverbike ships as a native desktop game across Linux (Steam Deck +
generic desktops) and Windows. macOS is intentionally deferred — we'd
need a Mac for testing before adding the target.

The desktop wrapper is **Electron** (it replaced an earlier Tauri/WebKitGTK
shell that couldn't launch inside the Steam Linux Runtime on the Deck and
only ever got a WebGL2 fallback). Electron bundles its own Chromium, so the
game runs in the runtime container and gets real WebGPU, and there's no Rust
or system-webkit toolchain to install.

Pairs with [`docs/steam-deck.md`](./steam-deck.md) (Deck-specific
runtime tuning) and [`docs/cross-browser.md`](./cross-browser.md) (web
build compatibility).

## Targets

| Customer platform | Bundle | Build host | What runs |
|---|---|---|---|
| Steam Deck | `linux-unpacked/` game tree | any Linux box / WSL / CI | Native — no Proton |
| Linux desktop | `linux-unpacked/` game tree | same | Native |
| Windows desktop | `*-setup.exe` (NSIS) + `win-unpacked/` tree | `windows-latest` (CI) or any Windows box | Native Chromium |
| macOS | — | (not yet) | (not yet) |

Steam routes the right bundle to each customer via per-platform
depots. The depots ship the **unpacked game tree** (Chromium bundled),
not a self-mounting AppImage — AppImages need FUSE, which the Steam
Linux Runtime container frequently lacks. On the Deck, Steam prefers a
native Linux depot when one exists, skipping Proton entirely.

## Toolchain prerequisites

These apply to **whoever builds** a bundle. End users get the game via
Steam and need nothing. A clean checkout needs only Node + pnpm;
electron-builder downloads the matching Electron (Chromium) binary on
first build and caches it.

### Linux host (Steam Deck Desktop Mode, Ubuntu, Arch, WSL, …)

Nothing beyond Node + pnpm. Electron is self-contained — no webkit2gtk,
gtk3, or Rust. `pnpm install` fetches the Electron binary (allowed via
`pnpm.onlyBuiltDependencies` in `package.json`).

### Windows host

Nothing beyond Node + pnpm for the NSIS installer. (Building the Windows
installer *from Linux/WSL* additionally needs `wine`, which
electron-builder shells out to for stamping the `.exe` — see
*Cross-compile* below.)

### Icons

The repo ships **solid-teal placeholder icons** so a fresh checkout
builds end-to-end without art. Regenerate via:

```sh
pnpm gen:icons
```

That writes `electron/icons/{32x32,128x128,128x128@2x,icon}.png` and a
real Windows `icon.ico` (PNG-in-ICO container). electron-builder reads
`electron/icons/icon.png` (Linux) and `electron/icons/icon.ico`
(Windows). Replace with the v1 art when it lands.

## Build commands

```sh
# Linux game tree (run on any Linux host / WSL)
pnpm build:deck

# Windows installer + tree (Windows host; or Linux/WSL with wine for the tree)
pnpm build:windows

# Quick local run of the packaged shell (builds web + launches Electron)
pnpm electron:run

# Web build only (no native wrapper)
pnpm build
```

Both build scripts run `pnpm build` (fresh `dist/`) then invoke
electron-builder. Pass-through flags reach electron-builder, e.g.
`pnpm build:deck -- --publish never`.

Outputs:

```
dist-electron/linux-unpacked/            # Linux game tree (binary: hoverbike)
dist-electron/win-unpacked/              # Windows game tree (Hoverbike.exe)
dist-electron/Hoverbike-<version>-setup.exe   # Windows NSIS installer
```

### Cross-compile from Linux → Windows?

`pnpm build:windows` on a Windows host builds the NSIS installer + the
`win-unpacked/` tree. On Linux/WSL it builds the `win-unpacked/` tree
only (enough for the Steam Windows depot) and skips the installer —
electron-builder still needs `wine` to stamp the `.exe`, so install
`wine` or use a Windows host / CI for the full installer.

## CI workflow

`.github/workflows/build-desktop.yml` — manual dispatch + tag-
triggered. Matrix:

- `ubuntu-22.04` → Linux game tree (tarred so the `hoverbike` binary
  keeps its `+x` bit through the artifact round-trip)
- `windows-latest` → Windows NSIS installer + `win-unpacked/` tree

On `v*` tag pushes the Linux tarball + Windows installer attach to the
GitHub Release. On manual dispatch everything uploads as workflow
artifacts (30-day retention).

Trigger a release build:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

Or run a one-off via the Actions tab → "build-desktop" → Run workflow.

## Steam distribution

The SteamPipe upload layer lives in [`steam/`](../steam/) and the
manual-dispatch workflow at
[`.github/workflows/release-steam.yml`](../.github/workflows/release-steam.yml).
Full recipe in [`steam/README.md`](../steam/README.md); summary here.

1. **Get App + depot IDs from the Partner backend.** Set up two depots
   (Linux + Windows) in the SteamPipe section.
2. **Set the launch executables in the Steamworks backend** — Linux
   launch option → `hoverbike`, Windows → `Hoverbike.exe`. The depot
   VDFs only map files; the launch binary is App config. On the Deck,
   run the Linux launch option under the **Steam Linux Runtime**.
3. **Bake build-account credentials** — see *First-time setup* in
   [`steam/README.md`](../steam/README.md).
4. **Drop the IDs + credentials into GitHub repo secrets** (or local
   env for a dev-box upload).
5. **Trigger the workflow** — Actions tab → release-steam → Run
   workflow. Run with `preview=true` first for a SteamPipe dry-run.
6. **Mark the Linux depot as Steam Deck verified** in the App admin so
   the Deck always picks the native Linux build over Proton.

For local uploads from a dev box: `pnpm steam:upload` after
`pnpm build:deck` and `pnpm build:windows`. `pnpm steam:dry-run` to
validate staging + VDF rendering without contacting Steam.

> **Steamworks SDK (achievements, rich presence)** is **not yet wired** —
> the old Tauri shell had stub commands the web side never called, so
> nothing functional was lost in the migration. Integrating
> [`steamworks.js`](https://github.com/ceifa/steamworks.js) in the main
> process is the tracked follow-up.

## Local sideload (testing without Steam)

### Linux tree on a Deck (Desktop Mode)

```sh
# From your build box — copy the whole tree (scp -r / rsync / USB)
scp -r dist-electron/linux-unpacked deck@<deck-ip>:/home/deck/Apps/hoverbike

# On the Deck (Desktop Mode terminal) — preserve / restore the +x bit
chmod +x ~/Apps/hoverbike/hoverbike
~/Apps/hoverbike/hoverbike
```

To exercise the Steam path: Desktop Mode → Steam → Games → "Add a
Non-Steam Game" → type the path to the `hoverbike` binary → Add. In its
**Properties → Compatibility**, force **"Steam Linux Runtime"** (this
reproduces the pressure-vessel container a real depot launch uses), then
launch from Steam. `--no-sandbox` is baked into the wrapper, so the
chrome-sandbox SUID requirement won't block launch on a copied/depot
tree.

### Windows .exe

```ps1
# Double-click the NSIS installer or run silently:
.\Hoverbike-0.0.0-setup.exe /S
```

The installer drops shortcuts in the Start menu + Desktop. Uninstall
via Apps & features.

## Troubleshooting

- **Steam says "running" but no window (Linux)** — almost always the
  chrome-sandbox or the Steam Overlay. `--no-sandbox` is baked into
  `electron/main.cjs`; if you still see it, disable the Steam Overlay
  for the shortcut. Capture Chromium's stderr by launching the binary
  with `--enable-logging=stderr` from a wrapper script.
- **Tree won't launch after copy / unzip** — the `hoverbike` binary
  lost its `+x` bit (plain zips strip it). `chmod +x hoverbike`, or
  transport via `tar`/`rsync`, which preserve modes.
- **`icon not found`** — run `pnpm gen:icons` from a fresh checkout.
- **WebGPU not active (HUD shows `webgl2`)** — the Deck's Vulkan/RADV
  stack must be reachable. The wrapper enables Vulkan + WebGPU
  explicitly; an older Electron whose bundled Dawn can't parse Three.js's
  WGSL will spam shader-compile errors — keep Electron current.
- **Windows installer build fails on Linux** — install `wine`, or build
  on a Windows host / CI. The `win-unpacked/` tree (what Steam ships)
  builds without the installer step.
</content>
