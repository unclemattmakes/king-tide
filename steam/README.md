# Steam — SteamPipe upload layer

Everything needed to push a Hoverbike build to Steam via Valve's
SteamPipe content system. See
[`docs/desktop-builds.md`](../docs/desktop-builds.md) for the full
desktop pipeline this slots into; this folder just owns the
"installer → Steam depot" step at the end.

## What's in this folder

| File | Purpose |
|---|---|
| `app_build.vdf` | Top-level SteamPipe script template. References the per-platform depot scripts; lists buildoutput/contentroot paths. |
| `depot_linux.vdf` | Linux AppImage depot template. |
| `depot_windows.vdf` | Windows installed-tree depot template. |
| `installscript.vdf` | Steam install script — runs the WebView2 Evergreen bootstrapper on first install of the Windows depot. **Requires Valve approval before it'll execute on customer machines** (see "WebView2 install script" below). |
| `.gitignore` | Excludes `content/` (staged bundles), `output/` (steamcmd logs), `.rendered/` (env-substituted VDFs), `cache/` (WebView2 bootstrapper etc.), and any local `config.vdf` / `ssfn*` credentials. |

The `.vdf` files use `${...}` placeholders that
[`tools/steam-upload.mjs`](../tools/steam-upload.mjs) substitutes at
upload time from env vars — so the real App ID and depot IDs live in
secrets, not in the repo.

## Required environment variables

The upload script + CI workflow both consume the same set:

| Var | When required | What | Where to get it |
|---|---|---|---|
| `STEAM_APPID` | always | Numeric Steam App ID | Steamworks Partner backend → your app → top of the dashboard |
| `STEAM_DEPOT_LINUX` | uploading Linux | Linux AppImage depot ID | Steamworks → Application → SteamPipe → Depots. Usually `APPID+1`. |
| `STEAM_DEPOT_WINDOWS` | uploading Windows | Windows depot ID | Same place; usually `APPID+2`. |
| `STEAM_USERNAME` | always (for upload) | Build account username | A dedicated Steam account with **Edit App Metadata + Publish Builds** permission on this app. NOT your personal account. |

Single-platform uploads (`--platform=linux` or `--platform=windows`)
only need the matching depot ID — the other one can stay unset.

Plus one of:

- `STEAM_PASSWORD` + Steam Guard prompt (interactive only) — for local
  dev box uploads on a fresh machine.
- A **pre-baked `config.vdf` + `ssfn` token** (CI + repeat uploads) —
  recipe below.

## First-time setup — bake Steam Guard credentials

Steam's build account is gated behind Steam Guard (2FA), and `steamcmd`
can't accept the 2FA code via a CLI flag. The workaround is to log in
once interactively on a trusted machine and then copy the credential
files into CI secrets.

1. **Install `steamcmd`** on a trusted Linux machine (your laptop is
   fine):

   ```sh
   # Debian/Ubuntu
   sudo apt install steamcmd
   # Or grab the tarball:
   curl -sSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar -xz
   ```

2. **Log in once interactively.** Use the build account, not your
   personal one. It'll email/Mobile-Authenticator-prompt you for the
   Steam Guard code:

   ```sh
   steamcmd +login <build_username>
   # enter Steam Guard code at prompt
   Steam> quit
   ```

3. **Find the credential files** under `~/Steam/config/`:

   ```sh
   ls -la ~/Steam/config/config.vdf ~/Steam/ssfn*
   ```

   You'll see `config.vdf` plus an `ssfn` file with a long numeric name
   (e.g. `ssfn8231047219874012345`). Both files together let steamcmd
   re-authenticate without a fresh Steam Guard prompt.

4. **Base64-encode them for GitHub secrets:**

   ```sh
   base64 -w0 ~/Steam/config/config.vdf > /tmp/config.b64
   base64 -w0 ~/Steam/ssfn8231047219874012345 > /tmp/ssfn.b64
   ```

5. **Add to GitHub repo secrets** (Settings → Secrets and variables →
   Actions):

   - `STEAM_CONFIG_VDF` ← contents of `/tmp/config.b64`
   - `STEAM_SSFN` ← contents of `/tmp/ssfn.b64`
   - `STEAM_SSFN_NAME` ← the filename (e.g. `ssfn8231047219874012345`)
   - `STEAM_USERNAME` ← the build account username
   - `STEAM_APPID`, `STEAM_DEPOT_LINUX`, `STEAM_DEPOT_WINDOWS`

   Wipe the `/tmp/*.b64` files when done.

6. **Add a GitHub Environment** called `steam-release` with required
   reviewers (so a human always approves Steam uploads). The release
   workflow uses `environment: steam-release`.

## Local upload (dev box)

After running `pnpm build:deck` (Linux) and `pnpm build:windows`
(Windows host or CI), from the repo root:

```sh
# Dry-run first — stages content + renders VDFs, doesn't call steamcmd.
STEAM_APPID=3000000 \
STEAM_DEPOT_LINUX=3000001 \
STEAM_DEPOT_WINDOWS=3000002 \
STEAM_USERNAME=hoverbike_build \
pnpm steam:dry-run

# Real upload — interactive Steam Guard prompt on first run.
STEAM_APPID=… STEAM_DEPOT_LINUX=… STEAM_DEPOT_WINDOWS=… STEAM_USERNAME=… \
STEAM_PASSWORD=… \
pnpm steam:upload

# Upload only one platform (useful when iterating per-OS):
pnpm steam:upload -- --platform=linux

# Push to a non-default branch live after upload:
STEAM_SET_LIVE=beta pnpm steam:upload
```

The script auto-discovers bundles at the standard Tauri output paths.
Override via `LINUX_BUNDLE=path/to/foo.AppImage` and
`WINDOWS_BUNDLE_DIR=path/to/tree/` if you've moved them.

## CI upload (release-steam.yml)

The [`release-steam.yml`](../.github/workflows/release-steam.yml)
workflow is manual-dispatch only. Trigger from the Actions tab:

1. Pick a `build-desktop` run ID (or leave blank to grab the latest
   successful run on the default branch).
2. Pick a `set_live` branch (or leave blank to upload without making
   the build live).
3. Pick `platforms` — both, linux only, or windows only.
4. Pick `preview` — `true` for a dry-run that validates the upload
   against Steam but doesn't actually push bytes.

The workflow:

- Downloads the bundles from the chosen build-desktop run.
- Extracts the NSIS installer payload (Steam wants the installed
  tree, not the installer itself).
- Installs steamcmd on the runner.
- Stages the Steam Guard credentials from secrets.
- Runs `tools/steam-upload.mjs`.
- Uploads steam/output as a workflow artifact for log diffing.

## WebView2 install script

Tauri's WebView backend (WRY) needs the **Microsoft Edge WebView2
Evergreen Runtime** to render. Most modern Windows installs already
have it (Edge ships it, Windows 11 includes it OOTB), but a sizeable
chunk of Windows 10 boxes don't — players on those machines see:

> Could not find the WebView2 runtime

when launching from Steam. Tauri's NSIS installer ships a small
download-bootstrapper that handles this, but **Steam bypasses NSIS
entirely** — it just copies the depot files to the install dir — so
the bootstrapper never runs. Hence the install script.

How the layer works:

1. `tools/steam-upload.mjs` downloads `MicrosoftEdgeWebview2Setup.exe`
   from Microsoft's official redirector (cached locally in
   `steam/cache/`), then stages it into the Windows depot alongside
   `installscript.vdf`.
2. On first install, Steam reads `installscript.vdf`, checks the
   `HasRunKey` registry value (`HKLM\SOFTWARE\WOW6432Node\Microsoft\
   EdgeUpdate\ClientState\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`),
   and skips the bootstrapper if WebView2 is already there.
3. Otherwise it runs `MicrosoftEdgeWebview2Setup.exe /silent /install`
   which downloads + installs the Evergreen Runtime invisibly.

**Valve has to approve the script before it executes on customers.**
Install scripts run executables, which is sensitive, so Valve gates
them behind a manual review. The approval flow is documented at
[partner.steamgames.com/doc/sdk/installscripts](https://partner.steamgames.com/doc/sdk/installscripts) —
the short version:

1. Upload a build containing the script (a non-default branch like
   `beta` is fine — it just needs to be visible in your depot).
2. File a request via the Steamworks support channel referenced on
   that docs page, with your App ID + the contents of
   `installscript.vdf` + a note that you're bootstrapping WebView2
   for a Tauri / WRY game.
3. Wait for Valve to whitelist the script (typically a few business
   days).

Until then, the file is in the depot but inert. Players still hit
the "WebView2 runtime not found" error in that window. Workaround
for early playtest: point testers at the NSIS installer download
(GitHub release artifact) which has its own bootstrapper.

## When the App ID arrives

Today the `STEAM_APPID` / depot IDs are unset — the code is ready to
roll once Valve hands you an App ID. Drop the IDs into the repo
secrets, run a `STEAM_PREVIEW=true` dry-run first to confirm the VDFs
render correctly, then a real upload. The first real build will show
up under the App's "Builds" tab in the Steamworks backend; from
there a human picks a branch to set live.

## Troubleshooting

- **`Failed to find SteamCMD`** — set `STEAM_CMD=/path/to/steamcmd`
  or install via your package manager (`apt install steamcmd`).
- **`Two-factor code required`** — pre-baked `config.vdf` is missing
  or expired. Re-bake per the "First-time setup" recipe.
- **`No DRM Wrapping for AppID … on Linux`** — only fires if you
  asked for DRM via the Steamworks backend. Hoverbike doesn't use
  it today; ignore.
- **`No connection to Steam`** — runner can't reach Steam's CDN.
  Usually transient; retry.
- **NSIS payload missing `hoverbike.exe`** — the installer layout
  changed (Tauri NSIS template revision). Re-extract a known-good
  installer locally with `7z x Hoverbike_*-setup.exe` and check
  whether the inner `app-64.7z` still exists. Adjust the workflow's
  extract step if needed.
