# Asset storage — raw vs. compiled

King Tide's binary assets split into two buckets with different homes. The
goal is a lean git history that still gives every clone the bytes it needs
to **run** the game, without carrying the much larger authoring sources
that only matter when **rebuilding** assets.

| Bucket | Examples | Home | Why |
| --- | --- | --- | --- |
| **Raw / authoring sources** | `tracks-src/*.blend`, `bikes-src/*.blend` | **Google Drive** (off git) | Large (~103 MB) and re-saved constantly; nothing at runtime needs them. |
| **Compiled / exported** | `public/assets/**/*.glb`, hero/thumb `*.jpg`, atlas `*.png`, `public/audio/**/*.opus` | **Cloudflare R2** (off git) | The web build serves these; moved off git-LFS so Vercel deploys don't re-pull ~160 MB per build. Fetched at runtime via `VITE_ASSET_BASE_URL`. |

> The tiny shared kits under `tools/blender/lib/*.blend` (~0.2 MB) stay in
> plain git for now — they're load-bearing build inputs and negligible in
> size. Move them to Drive too if you want a purist split.

## Raw sources → Google Drive for Desktop

The raw `.blend`s are **untracked from git** (`*.blend` is gitignored), and
they live in a folder kept synced to the cloud by **Google Drive for
Desktop** — e.g. `C:\project-content\hoverbike\tracks-src\…`. That app
mirrors the folder automatically, so **every save backs up on its own** —
no `rclone`, no scripts, no commands to remember. A second machine just
installs Google Drive for Desktop and the same folder appears.

> `tracks-src/README.md` and `tracks-src/blender_assets.cats.txt` are small
> and stay tracked in git. Only `*.blend` is ignored.

The AI prop factory (`make-level-props`, see
[ai-prop-pipeline.md](ai-prop-pipeline.md)) follows the same rule: its **raw**
outputs land in the content root, the **compiled** GLB in Cloudflare R2.

| AI prop artifact | Home |
| --- | --- |
| Concept art (SDXL PNGs + contact sheet) | `<content-root>/concept-art/props/<level>/` (Drive) |
| Per-prop authoring `.blend` (one asset per file) | `<content-root>/tracks-src/props/ai/<id>.blend` (Drive) |
| Conditioned, shippable GLB | `public/assets/props/ai/<id>.glb` (R2, gitignored) |
| Per-level manifest (prompts/seeds/params — the reproducibility anchor) | `specs/props/ai/<level>.json` (git) |

The content root defaults to `C:\project-content\hoverbike`; override with
`$KINGTIDE_CONTENT_ROOT`.

### Pointing the addon at your repo (authoring outside the clone)

You author `.blend`s **in the Drive folder**, but exports
(`public/assets/...`, `public/tracks/*.json`, `specs/...`) still have to
land in your repo **clone**. The addon normally finds the clone by walking
up from the open `.blend` — which fails when the `.blend` lives outside it.
Tell it where the clone is, either way works:

- **Add-on preference (recommended):** Blender → *Edit → Preferences →
  Add-ons → "King Tide: Export to Game" → Project root* → set it to your
  clone path (e.g. `C:\dev\hoverbike`). Set once; persists.
- **Env var:** `KINGTIDE_REPO_ROOT=C:\dev\hoverbike` before launching
  Blender (handy for headless / scripted runs).

Resolution order is: env var → preference → walk-up (so leaving both blank
keeps the classic in-repo workflow working unchanged). Either override is
ignored unless it actually points at a clone, so a stale value can't
silently misdirect exports.

Keep the Drive folder's `tracks-src/` / `bikes-src/` subfolder names — the
addon keys its track-vs-bike mode off them, and links sibling libraries
(`props-library.blend`, `landmarks-library.blend`) from the same folder.

## Compiled exports → Cloudflare R2

The compiled runtime assets are **gitignored** (`public/assets/`,
`public/audio/` in [`.gitignore`](../.gitignore)) and served from a public
**Cloudflare R2** bucket — zero egress cost, and Vercel deploys no longer
pull ~160 MB of git-LFS objects per build (the bandwidth blowup that broke
deploys when the free quota ran out).

| | |
| --- | --- |
| Bucket | `hoverbike-content` (account OddballCreatureClub) |
| Public URL | `https://hoverbike-content.mattscott.dev` (R2 custom domain) |
| CORS | `*` GET/HEAD (public, read-only) |
| Mirrors | `public/assets/**` → `…/assets/**`, `public/audio/**` → `…/audio/**` |

The app resolves every asset path through `assetUrl()`
([src/engine/asset-url.ts](../src/engine/asset-url.ts)), which prefixes
`VITE_ASSET_BASE_URL` in prod and is a no-op in dev (local `public/`). Set
`VITE_ASSET_BASE_URL=https://hoverbike-content.mattscott.dev` on Vercel
(Production + Preview); leave it unset locally so `pnpm dev` stays offline.
Gameplay JSON under `public/tracks/*.json` stays in git (small, versioned)
and is **not** routed to R2.

### Syncing with R2 — `pnpm assets:pull` / `assets:push`

Both use [`rclone`](https://rclone.org) against an S3 remote named
`r2-hoverbike`. Configure it once with an R2 API token (*Cloudflare → R2 →
Manage API Tokens → Object Read & Write*, scoped to the bucket):

```ini
# ~/.config/rclone/rclone.conf  (or %APPDATA%\rclone\rclone.conf on Windows)
[r2-hoverbike]
type = s3
provider = Cloudflare
access_key_id = <your R2 access key id>
secret_access_key = <your R2 secret>
endpoint = https://<your-cloudflare-account-id>.r2.cloudflarestorage.com
region = auto
```

- `pnpm assets:pull` — hydrate a fresh clone's `public/assets` + `public/audio`
  from R2 for offline local dev. (A read-only token suffices.)
- `pnpm assets:push` — upload newly exported GLBs/atlases/opus (after a
  `pnpm gen:*` or a Blender re-export) to R2 so prod + previews pick them up.
  **This replaces the old `git add` + commit step for compiled assets.**

> rclone auto-sets sensible content-types (`application/octet-stream` for
> `.glb`, `audio/ogg` for `.opus`); the GLB loader's HEAD check accepts
> octet-stream, so no per-file overrides are needed.

## Migration status

- ✅ Raw `.blend`s untracked from git + `.gitignore`d (Google-Drive-synced).
- ✅ Addon honors a "Project root" override so exports reach the clone.
- ✅ Compiled assets moved off git-LFS → Cloudflare R2 (`hoverbike-content`),
  gitignored, fetched at runtime via `VITE_ASSET_BASE_URL` / `assetUrl()`.
- ✅ `VITE_ASSET_BASE_URL` set on Vercel (Production + Preview).
- ⬜ **You:** configure the `r2-hoverbike` rclone remote (above) on each
  machine that authors assets, so `pnpm assets:push` works after a re-export.
- ⬜ **Optional, coordinated:** reclaim the existing git history (below) —
  the old GLB/blend blobs are still in the pack.

> Compiled assets are still in git *history* (the untrack is forward-only),
> so nothing is lost — recoverable from any prior commit until the optional
> history rewrite. The live bytes are in R2.

## Optional: reclaim existing history

The untrack is forward-only, so the old GLB/JPG/PNG/opus + `.blend` blobs are
still in the `.git` pack (hundreds of MB). To reclaim that space, drop them
from history with [`git filter-repo`](https://github.com/newren/git-filter-repo):

```bash
git filter-repo --invert-paths \
  --path-glob 'public/assets/*' --path-glob 'public/audio/*' \
  --path-glob 'tracks-src/*.blend' --path-glob 'bikes-src/*.blend'
```

This **rewrites history and force-pushes** — it invalidates every existing
clone and open PR. Do it once, deliberately, when no PRs are in flight, and
tell collaborators to re-clone. The live asset bytes are safe in R2 / Drive.
