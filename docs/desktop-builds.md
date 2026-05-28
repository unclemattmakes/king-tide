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

**Steam ships the Windows build only** — the Deck runs it via Proton, which
sidesteps the entire native-Linux-runtime gauntlet (see the gotchas section
below). The native Linux tree still builds (`pnpm build:deck`) for direct /
non-Steam distribution, but it is not uploaded to Steam.

1. **Get the App ID + a Windows depot from the Partner backend** in the
   SteamPipe section.
2. **Set the Windows launch executable** in the Steamworks backend to
   `Hoverbike.exe`. (The depot VDF only maps files; the launch binary is App
   config.)
3. **Bake build-account credentials** — see *First-time setup* in
   [`steam/README.md`](../steam/README.md).
4. **Drop the IDs + credentials into GitHub repo secrets** (or local
   env for a dev-box upload).
5. **Trigger the workflow** — Actions tab → release-steam → Run
   workflow. Run with `preview=true` first for a SteamPipe dry-run.

For local uploads from a dev box: `pnpm steam:upload` after
`pnpm build:windows`. `pnpm steam:dry-run` to validate staging + VDF
rendering without contacting Steam.

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
Non-Steam Game" → type the path to **`hoverbike-launch.sh`** (the wrapper,
not the bare binary) → Add. In its **Properties → Compatibility**, force
**"Steam Linux Runtime"** (this reproduces the pressure-vessel container a
real depot launch uses), then launch from Steam. The wrapper handles the
overlay + libcups issues covered next; `--no-sandbox` is also baked into the
app itself.

### Windows .exe

```ps1
# Double-click the NSIS installer or run silently:
.\Hoverbike-0.0.0-setup.exe /S
```

The installer drops shortcuts in the Start menu + Desktop. Uninstall
via Apps & features.

## Steam Deck / Linux runtime gotchas

Wrapping a Chromium app (Electron) for the **Steam Linux Runtime** (sniper —
the `pressure-vessel` container Steam launches games inside) hits a known set
of issues. These are the ones we hit on-device and how the build handles
them. The references at the bottom are the canonical write-ups.

### The launch wrapper (`hoverbike-launch.sh`)
Steam launches **`hoverbike-launch.sh`**, not `hoverbike` directly.
`tools/build-deck.mjs` drops it (plus an `extra-lib/` dir) into the tree
after electron-builder runs. Before exec'ing the binary it (1) strips the
crashing Steam overlay from `LD_PRELOAD` and (2) prepends `extra-lib/` to
`LD_LIBRARY_PATH`. Both are explained below.

### 1. The Steam overlay segfaults Electron on load
The overlay is `LD_PRELOAD`-injected as `gameoverlayrenderer.so`. With this
Electron build its injector **crashes during library init (SIGSEGV) — in
both Desktop *and* Gaming Mode** (confirmed via `coredumpctl info hoverbike`:
the faulting frames are inside `gameoverlayrenderer.so`, called from
`ld-linux` while it runs the preloaded lib's constructor). Critically, the
per-game **"Enable the Steam Overlay" toggle does *not* stop the preload** —
Steam still passes `--ld-preload=…/gameoverlayrenderer.so` to pressure-vessel.
So the wrapper removes it from `LD_PRELOAD` before launch. Cost: the in-game
overlay (Shift+Tab) is unavailable — but it barely works with Electron on
Linux anyway, and this is the difference between *launches* and *crashes*.

### 2. The runtime is missing libcups
Electron's Chromium `dlopen()`s `libcups.so.2` (printing support), but the
Steam Linux Runtime doesn't ship it, so Electron dies with
`libcups.so.2: cannot open shared object file`. `build:deck` copies the build
host's `libcups.so.2` into `extra-lib/`, and the wrapper adds that dir to
`LD_LIBRARY_PATH`. If you hit a glibc symbol-version error inside sniper,
source the lib from a glibc-2.31-era base (Debian 11); Ubuntu 22.04's copy
usually loads fine.

### 3. The sandbox + zygote can't initialise → `--no-sandbox --no-zygote`
Two layers here, both fatal inside the runtime:
- Depot files aren't setuid-root, so `chrome-sandbox` can't init → silent
  immediate exit. Fixed by `--no-sandbox`.
- With the sandbox off, Chromium's **zygote** still tries to set up
  namespaces via `clone()`, which pressure-vessel's seccomp/namespace
  sandbox rejects with `EINVAL` →
  `FATAL ... zygote_host_impl_linux.cc Check failed: . : Invalid argument (22)`.
  This *looks* like a hang ("running", no window) because SteamOS spends a
  while dumping the core. Fixed by `--no-zygote` (drops the fork-from-zygote
  model; only valid alongside `--no-sandbox`).

Both are baked into `electron/main.cjs` (`appendSwitch`) and passed again on
the command line by the wrapper (more reliable, since the zygote spins up very
early).

### 4. Steam Input / gamepad
Steam Input is unreliable with Electron 27+. The game reads the raw Gamepad
API (`navigator.getGamepads()` via `detectSteamDeck()`), so it doesn't rely
on Steam Input — if controllers misbehave, disable Steam Input for the title.

### 5. WebGPU enablement is Linux-only — Windows-on-Proton must fall back to WebGL2
`electron/main.cjs` sets `--enable-unsafe-webgpu` + `--enable-features=Vulkan`
**only on Linux**. The rationale per platform:

- **Linux desktop (X11, direct launch — non-Steam)** — WebGPU/Dawn rides plain
  Vulkan and renders correctly. Native Linux launched *via the Steam Linux
  Runtime* on the Deck is shelved (the SLR container made every step painful
  for not much win); this path is for direct desktop users.
- **Real Windows** — Chromium ships WebGPU on by default for D3D12 on
  allow-listed drivers. Setting `--enable-unsafe-webgpu` would *override* the
  driver-safety check; we don't, so Chromium picks the safe default.
- **Windows-on-Proton (Deck via Proton Experimental — the shipping path)** —
  Chromium's GPU blocklist correctly flags VKD3D-Proton's D3D12 as unsafe.
  With `--enable-unsafe-webgpu` the page initialises WebGPU anyway and Three's
  render path produces a silent black frame (similar to the bloom cache-key
  bug in `post-pipeline.ts`). Without it, WebGPU stays off → WebGL2 fallback
  → 3D renders. **This is the current shipping behaviour.**

There **was** a Wayland wrinkle (relevant only to native Linux on the Deck, now
shelved): inside the Steam Linux Runtime, Chromium's Wayland backend can't
present native Vulkan (`'--ozone-platform=wayland' is not compatible with
Vulkan`), and forcing `--ozone-platform=x11` doesn't launch in the container.
The attempted fix — `--use-angle=vulkan` + `VulkanFromANGLE,DefaultANGLEVulkan`
— was **never confirmed to work and black-screened the normal render path**, so
it was removed.

The active backend is logged at boot:
`[render] backend: webgpu|webgl2 (override=…)?`. When WebGPU is active, the
adapter's vendor / architecture / device / description is logged too —
distinguishes a native Chromium adapter from VKD3D-Proton.

### 6. Backend override via Steam launch options (`HOVERBIKE_BACKEND`)
For diagnosing the active render path without rebuilding, set in
**Steamworks → Properties → Set Launch Options** (or the game's Properties on
the Deck):

```
HOVERBIKE_BACKEND=webgl2 %command%   # force WebGL2 even when WebGPU is available
HOVERBIKE_BACKEND=webgpu %command%   # force WebGPU adapter probe (falls back if unavailable)
HOVERBIKE_BACKEND=auto   %command%   # default — probe + pick
```

`electron/main.cjs` reads the env var and appends `?backend=…` to the page URL;
the renderer (`src/engine/render/renderer.ts`) respects the override. Proton
bridges Linux env vars into the Wine process, so this works for the Windows
depot on the Deck too.

> **Shipping option — Windows build via Proton.** Native Linux through the
> Steam runtime is the painful path. The Windows build under Proton sidesteps
> all of it — no overlay/sandbox/zygote/Wayland issues, since Proton gives
> Chromium a Windows-shaped environment. It launches reliably on the Deck;
> rendering currently goes through Chromium's WebGL2 fallback per gotcha #5.

References: Valve [steam-runtime #579](https://github.com/ValveSoftware/steam-runtime/issues/579)
(libcups), [steamworks.js #195](https://github.com/ceifa/steamworks.js/issues/195)
(overlay), [gpuweb/gpuweb #5022](https://github.com/gpuweb/gpuweb/issues/5022)
(WebGPU/Vulkan flags), and the Schemescape "browser game to Steam on Linux" series.

## Troubleshooting

- **Steam says "running" but never shows a window (Linux)** — it's almost
  always a crash that SteamOS is slowly core-dumping, not a true hang. Run
  `coredumpctl info hoverbike` and read the top frames / the log:
  - frames in `gameoverlayrenderer.so` → the Steam overlay; launch via
    `hoverbike-launch.sh` (strips the overlay preload).
  - `FATAL ... zygote_host_impl_linux.cc ... Invalid argument (22)` → the
    zygote namespace failure; needs `--no-zygote` (the wrapper + app set it).
  - `chrome-sandbox` errors → `--no-sandbox` missing.
- **`libcups.so.2: cannot open shared object file`** — the runtime's missing
  libcups; rebuild with `build:deck` (which bundles it into `extra-lib/`) and
  launch via the wrapper.
- **Tree won't launch after copy / unzip** — the `hoverbike` binary lost its
  `+x` bit (plain zips strip it). `chmod +x hoverbike`, or transport via
  `tar`/`rsync`, which preserve modes.
- **`icon not found`** — run `pnpm gen:icons` from a fresh checkout.
- **Black screen on 3D scenes on the Deck (Windows depot via Proton)** —
  WebGPU was force-enabled cross-platform with `--enable-unsafe-webgpu`,
  initialised over VKD3D-Proton's D3D12, then silently produced a black frame.
  The fix is gotcha #5: gate `--enable-unsafe-webgpu` to Linux only so
  Chromium's blocklist picks WebGL2 on Windows-via-Proton. To confirm the
  active backend, check the boot log for `[render] backend: …`, or set
  `HOVERBIKE_BACKEND=webgl2` in Steam launch options to force the fallback
  (gotcha #6).
- **Black screen / WebGPU not active on Linux** — don't add
  `--use-angle=vulkan` or `VulkanFromANGLE`/`DefaultANGLEVulkan`; those
  black-screen the normal render path (gotcha #5). Linux wants plain
  `--enable-features=Vulkan`. Also: an older Electron whose bundled Dawn can't
  parse Three.js's WGSL will spam shader-compile errors — keep Electron
  current.
- **Windows installer build fails on Linux** — install `wine`, or build on a
  Windows host / CI. The `win-unpacked/` tree (what Steam ships) builds
  without the installer step.
