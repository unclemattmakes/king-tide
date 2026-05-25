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
| `depot_linux.vdf` | Linux depot template (Electron game tree). |
| `depot_windows.vdf` | Windows depot template (Electron game tree). |
| `.gitignore` | Excludes `content/` (staged bundles), `output/` (steamcmd logs), `.rendered/` (env-substituted VDFs), `cache/` (reused downloads), and any local `config.vdf` / `ssfn*` credentials. |

The `.vdf` files use `${...}` placeholders that
[`tools/steam-upload.mjs`](../tools/steam-upload.mjs) substitutes at
upload time from env vars — so the real App ID and depot IDs live in
secrets, not in the repo.

## Required environment variables

The upload script + CI workflow both consume the same set:

| Var | When required | What | Where to get it |
|---|---|---|---|
| `STEAM_APPID` | always | Numeric Steam App ID | Steamworks Partner backend → your app → top of the dashboard |
| `STEAM_DEPOT_LINUX` | uploading Linux | Linux depot ID | Steamworks → Application → SteamPipe → Depots. Usually `APPID+1`. |
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

The script auto-discovers the electron-builder unpacked trees at
`dist-electron/linux-unpacked/` and `dist-electron/win-unpacked/`.
Override via `LINUX_BUNDLE_DIR=path/to/tree/` and
`WINDOWS_BUNDLE_DIR=path/to/tree/` if you've moved them. Set the
launch executable for each platform in the Steamworks backend
(`hoverbike` on Linux, `Hoverbike.exe` on Windows).

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

- Downloads the game trees from the chosen build-desktop run (the
  Linux tree is tarred to preserve the binary's +x bit).
- Installs steamcmd on the runner.
- Stages the Steam Guard credentials from secrets.
- Runs `tools/steam-upload.mjs`.
- Uploads steam/output as a workflow artifact for log diffing.

> **No WebView2 runtime needed.** Electron bundles its own Chromium, so
> the old WebView2 Evergreen bootstrapper + Steam install-script (which
> needed Valve approval) are gone — the Windows depot is just the
> self-contained game tree.

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
- **Linux build won't launch from Steam** — the `hoverbike` binary
  lost its +x bit in transit (preserved via `tar` in CI / `cpSync`
  locally), or the launch option isn't set to run under the Steam
  Linux Runtime. See `docs/desktop-builds.md` troubleshooting.
