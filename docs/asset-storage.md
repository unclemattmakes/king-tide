# Asset storage — raw vs. compiled

Hoverbike's binary assets split into two buckets with different homes. The
goal is a lean git history that still gives every clone the bytes it needs
to **run** the game, without carrying the much larger authoring sources
that only matter when **rebuilding** assets.

| Bucket | Examples | Home | Why |
| --- | --- | --- | --- |
| **Raw / authoring sources** | `tracks-src/*.blend`, `bikes-src/*.blend` | **Google Drive** (off git) | Large (~103 MB) and re-saved constantly; nothing at runtime needs them. |
| **Compiled / exported** | `public/assets/**/*.glb`, hero/thumb `*.jpg`, atlas `*.png` | **git, via Git LFS** | The web build + Vercel serve these; they must be in a clone, but they re-export often so LFS keeps the pack lean. |

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

### Pointing the addon at your repo (authoring outside the clone)

You author `.blend`s **in the Drive folder**, but exports
(`public/assets/...`, `public/tracks/*.json`, `specs/...`) still have to
land in your repo **clone**. The addon normally finds the clone by walking
up from the open `.blend` — which fails when the `.blend` lives outside it.
Tell it where the clone is, either way works:

- **Add-on preference (recommended):** Blender → *Edit → Preferences →
  Add-ons → "Hoverbike: Export to Game" → Project root* → set it to your
  clone path (e.g. `C:\dev\hoverbike`). Set once; persists.
- **Env var:** `HOVERBIKE_REPO_ROOT=C:\dev\hoverbike` before launching
  Blender (handy for headless / scripted runs).

Resolution order is: env var → preference → walk-up (so leaving both blank
keeps the classic in-repo workflow working unchanged). Either override is
ignored unless it actually points at a clone, so a stale value can't
silently misdirect exports.

Keep the Drive folder's `tracks-src/` / `bikes-src/` subfolder names — the
addon keys its track-vs-bike mode off them, and links sibling libraries
(`props-library.blend`, `landmarks-library.blend`) from the same folder.

## Compiled exports → Git LFS

Tracked in [`.gitattributes`](../.gitattributes):

```
public/assets/**/*.glb   filter=lfs diff=lfs merge=lfs -text
public/assets/**/*.jpg   filter=lfs diff=lfs merge=lfs -text
public/assets/**/*.jpeg  filter=lfs diff=lfs merge=lfs -text
public/assets/**/*.png   filter=lfs diff=lfs merge=lfs -text
```

This is **forward-only**: assets committed *after* this lands become LFS
pointers; the GLBs already in history stay as ordinary blobs (see the
history-rewrite note below).

### Prerequisites — do these before relying on LFS

1. **Install the LFS client everywhere these assets are checked out:**
   ```bash
   git lfs install      # once per machine; also on any CI runner
   ```
   Without it, LFS-tracked files arrive as small pointer text files and the
   game fails to load its GLBs.
2. **Enable LFS on Vercel.** In the Vercel project: *Settings → Git → "Git
   LFS"* must be on, or the build checks out pointer files and every GLB
   404s. Verify a preview deploy renders a track before trusting it.
3. **Mind the GitHub LFS quota.** Free tier is 1 GB storage + 1 GB/month
   bandwidth, then paid data packs. ~240 MB of GLBs re-versioned over time
   plus Vercel pulling them per build will cross 1 GB — budget for a pack,
   or move compiled assets to an R2/S3 + CDN fetch later if bandwidth bites.

## Migration status

- ✅ Raw `.blend`s untracked from git + `.gitignore`d.
- ✅ Sources live in the Google-Drive-synced folder (auto-backup on save).
- ✅ Addon honors a "Project root" override so exports reach the clone.
- ✅ Compiled exports tracked via Git LFS (`.gitattributes`).
- ⬜ **You:** set the addon's *Project root* to your clone, then reload the
  addon (`F3 → Reload Scripts`) and confirm a track export still writes
  into `public/assets/tracks/`.
- ⬜ **You:** `git lfs install` on each machine + enable Git LFS on Vercel
  (see the LFS prerequisites above) before regenerating any GLB.
- ⬜ **Optional, coordinated:** reclaim the existing ~127 MB history (below).

> The raw `.blend`s are still in git *history* (the untrack is forward-only),
> so nothing is lost — they're recoverable from any prior commit until the
> optional history rewrite.

## Optional: reclaim existing history

The forward-only setup does **not** shrink the current ~127 MB `.git` — the
old GLB/blend blobs are still in the pack. To reclaim that space:

```bash
git lfs migrate import --include="public/assets/**/*.glb,public/assets/**/*.jpg,public/assets/**/*.png"
# and/or git filter-repo to drop tracks-src/*.blend from history entirely
```

This **rewrites history and force-pushes** — it invalidates every existing
clone and open PR. Do it once, deliberately, when no PRs are in flight, and
tell collaborators to re-clone.
