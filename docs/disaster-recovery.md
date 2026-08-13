# Disaster recovery — external single points of failure

Two stores live **outside git** and have no second copy by default. If either
goes away, the game won't load (R2) or every level/bike source is gone
(Drive). This is the runbook for both. Keep it short; the full storage
conventions are in [asset-storage.md](asset-storage.md).

| SPOF | What it holds | Bus factor | First move if it's gone |
| --- | --- | --- | --- |
| **Cloudflare R2** `hoverbike-content` | compiled runtime assets (GLB / atlas / thumb / `.opus`) | 1 bucket | repoint `VITE_ASSET_BASE_URL` to a mirror, or rehydrate from git history |
| **Google Drive** content folder | raw `*.blend` level + bike sources | 1 drive | restore from an offsite copy |

---

## 1. Cloudflare R2 — the runtime asset bucket

The web build fetches every GLB / texture / `.opus` from R2 at runtime via
`assetUrl()` ([src/engine/asset-url.ts](../src/engine/asset-url.ts)), which
prefixes `VITE_ASSET_BASE_URL`.

| | |
| --- | --- |
| Bucket | `hoverbike-content` (account OddballCreatureClub) |
| Public URL | `https://hoverbike-content.mattscott.dev` (R2 custom domain) |
| S3 endpoint | `https://<account-id>.r2.cloudflarestorage.com` (account ID: Cloudflare dashboard → R2) |
| rclone remote | `r2-hoverbike` (S3, provider Cloudflare — see asset-storage.md for the conf block) |
| Layout | `public/assets/**` → `assets/**`, `public/audio/**` → `audio/**` |

### Symptoms

- Deployed game boots to the loading screen but assets 404 (network tab full
  of red on `hoverbike-content.mattscott.dev/...`).
- `pnpm assets:pull` on a fresh clone fails.

Local `pnpm dev` is **unaffected** — `VITE_ASSET_BASE_URL` is unset locally,
so dev serves from the on-disk `public/`. A hydrated clone (132 GLBs +
`manifest.json` present) is itself a usable cold backup of the live bytes.

### Recover

1. **Repoint to a mirror (fastest).** If you have a mirror bucket (below) on
   a public domain, change `VITE_ASSET_BASE_URL` on Vercel (Production +
   Preview) to that domain and redeploy. The app is a no-op in dev and only
   reads this one env var in prod, so no code change is needed.

2. **Rehydrate R2 from a local clone.** Any hydrated clone has the full
   `public/assets` + `public/audio` tree. Recreate the bucket (or a new one),
   point the `r2-hoverbike` rclone remote at it, and push:

   ```bash
   pnpm assets:push        # rclone sync public/assets + public/audio → r2-hoverbike
   ```

   Then repoint the custom domain (Cloudflare → R2 → bucket → Settings →
   Custom Domains) or update `VITE_ASSET_BASE_URL` to the new public URL.

3. **Last resort — pull bytes out of git history.** The migration to R2 was
   **forward-only**: the pre-migration GLB / JPG / PNG / `.opus` blobs are
   still in the `.git` pack (until the optional history rewrite in
   asset-storage.md is ever run). Check out an old commit (or
   `git cat-file`/`git checkout <sha> -- public/assets public/audio`) to
   recover a known-good snapshot, then `pnpm assets:push` it. Newer assets
   added after the untrack won't be there — only a hydrated clone or a mirror
   has those.

### Prevent — scheduled mirror to a second bucket

Mirror R2 to an independent S3/B2 bucket so a Cloudflare-side loss isn't fatal.
Configure a second rclone remote (e.g. `b2-hoverbike` against Backblaze B2, or
a second-account S3) and run on a schedule:

```bash
# nightly: mirror the live bucket to an offsite copy
rclone sync r2-hoverbike:hoverbike-content b2-hoverbike:hoverbike-content-mirror \
  --fast-list --transfers 16
```

Wire it to cron / Task Scheduler / a CI nightly. `rclone sync` is one-way
(mirror tracks source, including deletes) — point it **from** the live bucket
**to** the mirror, never the reverse, or a bad sync wipes your backup.

---

## 2. Google Drive — the raw `.blend` source folder

Every level and bike authoring source (`tracks-src/*.blend`,
`bikes-src/*.blend`, AI-prop `.blend`s, concept art) lives only in the
Google-Drive-synced content root (default `C:\project-content\hoverbike`,
override `$HOVERBIKE_CONTENT_ROOT`). These are **gitignored** — git has none
of them. Drive for Desktop auto-syncs on save, so it's a live backup, but it's
**one account**: lose the account (or a sync deletes-propagate accident) and
every source is gone. Compiled GLBs in R2 are *not* re-authorable — they're
exports, not sources.

### Recover

- **Account intact, local copy lost:** reinstall Google Drive for Desktop and
  sign in; the folder reappears. Re-point the addon at your clone (add-on
  pref "Project root" or `HOVERBIKE_REPO_ROOT`) per asset-storage.md.
- **Files deleted in Drive:** Google Drive Trash holds deletions ~30 days;
  restore from there, or from the offsite copy below.
- **No copy anywhere:** the shipped R2 GLBs are the only recoverable artifact
  of authored geometry — a track's exported `.glb` can be re-imported as a
  rough starting point, but hand-authored edits and modifier stacks are lost.
  Avoid getting here.

### Prevent — periodic offsite copy

Drive-for-Desktop is sync, **not** backup (deletes propagate). Take a periodic
independent snapshot of the content root to a second location — an external
drive or a second cloud — on a schedule:

```bash
# weekly: snapshot the raw sources offsite (adjust paths/remote to taste)
rclone copy "C:/project-content/hoverbike" offsite:hoverbike-sources \
  --backup-dir "offsite:hoverbike-sources-history/$(date +%F)" \
  --fast-list
```

Use `rclone copy` (not `sync`) with `--backup-dir` so deleted/overwritten
files are versioned into a dated history folder rather than discarded — that's
the property that protects you from an accidental delete propagating.

---

## Quick checklist

- [ ] Second rclone remote configured (`b2-hoverbike` or equivalent).
- [ ] Nightly `rclone sync` R2 → mirror bucket scheduled.
- [ ] Weekly `rclone copy` content root → offsite, with `--backup-dir`.
- [ ] You know how to flip `VITE_ASSET_BASE_URL` on Vercel and redeploy.
- [ ] At least one fully-hydrated clone exists on a machine you control.
