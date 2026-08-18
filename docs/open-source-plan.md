# Open-sourcing King Tide — decisions + flip runbook

*Evaluated and decided 2026-08-12 (full three-part audit: secrets sweep,
content-provenance inventory, external-license research). This doc records
the locked decisions, what has already been executed, and the remaining
gates before the public flip. Not legal advice.*

## Decisions (locked 2026-08-12)

| Question | Decision |
|---|---|
| Route | **Open code / separately-licensed content** (id-Software model; the R2 asset split already implements it) |
| Public repo | **Fresh repo [`unclemattmakes/king-tide`](https://github.com/unclemattmakes/king-tide)** with filtered history; `hoverbike` stays as the private archive. Private until ready, then flipped public. |
| Commercial intent | **No Steam sale.** Frees the NC music constraint; content license can be NC. |
| Code license | **MIT** (LICENSE, unchanged) |
| Content license | **CC BY-NC 4.0** for first-party content ([CONTENT-LICENSE.md](../CONTENT-LICENSE.md)) — *revisit in PR review if all-rights-reserved is preferred; nothing is published until the flip, so this is still reversible.* |
| Commit identity | All personal identities unified to **`Uncle Matt Makes <240991658+unclemattmakes@users.noreply.github.com>`** in the filtered history (Claude + dependabot commits kept as-is). Scrubs the personal email from history as a side effect. |
| Hunyuan AI props | **Replace before flip** (territory clause bars EU/UK/KR distribution of outputs). Replacement targets mapped in [reef-cup-prop-replacement-catalog](reef-cup-prop-replacement-catalog.md). |
| Soundtrack | **Keep all 14 FMA tracks** — verified per-track (0 unverified, 0 ND); licenses recorded in the `credits.json` sidecar next to the source mp3s and rendered in-game + in [CREDITS.md](../CREDITS.md). |

## Executed (2026-08-12)

- ✅ **king-tide created + pushed** — filtered history (199 MB pack → **11.3 MB**):
  dropped `public/assets/*` (except `manifest.json`), `public/audio/*`,
  `tracks-src/*.blend`, `bikes-src/*.blend`; mailmap applied; `main` only.
- ✅ **Soundtrack provenance** — all 14 tracks verified (FMA, 2026-08-12):
  1× CC0, 4× CC BY, **6× CC BY-SA**, 2× CC BY-NC, 1× CC BY-NC-SA (= 14),
  **0 ND, 0 unverified**. `credits.json` sidecar written next to the mp3s;
  `tools/convert-music.mjs` merges it into the generated manifest;
  `SoundtrackEntry` carries `license`/`licenseUrl`/`sourceUrl`; credits
  screen renders per-track licenses. Constraints (NC = stay non-commercial;
  SA = no baked-audio trailers) documented in CREDITS.md.
- ✅ **License architecture** — [CONTENT-LICENSE.md](../CONTENT-LICENSE.md) +
  [CREDITS.md](../CREDITS.md) + README License section + CONTRIBUTING
  asset-contribution policy + `package.json` license/repository fields.
- ✅ **Scrub pass** — `.env*` gitignored; Cloudflare account ID redacted
  (asset-storage, disaster-recovery); `C:\Users\<user>` paths genericized
  (make_level_props.py defaults now derive from `~`; ai-prop-pipeline.md);
  dead memory-bank link fixed (v1-asset-pipeline-plan); the personal dev
  hostname → `dev-box` (changelog, perf-baseline, perf-reports); Vercel team
  slug dropped from docs-site/build/platform.md; stale "CC0 placeholder"
  soundtrack claims corrected (README, status, product-plan,
  reef-cup-vertical-slice-status); orphaned `docs/img/` deleted (4.1 MB,
  embedded local paths in the image metadata, referenced by nothing).
  **Note this pass was tip-only** — the pre-scrub values survive in history,
  which is what the cut publishes; the runbook below strips them.

## Remaining gates before the flip

1. ~~**Replace the 13 Hunyuan props**~~ — **DONE (#415).** No track references
   any `ai/*` prop. The GLBs were deleted from R2 and from local disk on
   2026-08-13 (originals preserved out-of-band under the content root's
   `retired/props-ai/`), so the CDN now 404s them.
2. ~~**Verify PartyKit prod env**~~ — **SUPERSEDED 2026-08-17: both variables
   are now set and verified live** (see [Post-flip deployment](#post-flip-deployment-2026-08-17)).
   *Historical note, true when written:* checked 2026-08-13, no variables were
   set, so the deployed board signed and verified with `DEV_HMAC_SECRET`.
   **This does not gate the flip:** that same secret is already a plain
   literal in the deployed production bundle, so publishing the source adds
   no attacker capability. Setting a real `LEADERBOARD_HMAC_SECRET` is ops
   hygiene worth doing, but note it only re-hides a value the next build
   republishes — real leaderboard integrity needs server-side validation, not
   a secret. `LEADERBOARD_ADMIN_TOKEN` being unset is *safe*: the admin gate
   fails closed.
3. ~~**Contributor asset path**~~ — **DONE.** The bucket serves anonymously
   with `Access-Control-Allow-Origin: *` (verified for the manifest, GLBs and
   audio), so no download is needed at all: `.env.example` sets
   `VITE_ASSET_BASE_URL` and the app streams everything at runtime. A local
   `pnpm assets:pull` stays the maintainer path. Deliberately *not* shipping a
   public pull script — the bucket can't be enumerated anonymously, so any
   such script would half-hydrate and be worse than nothing.
4. ~~**Re-cut king-tide from the final hoverbike main** (see runbook), then
   flip visibility.~~ — **DONE.** The repo is public; MIT code / CC BY-NC
   content. Deployment cutover is recorded under
   [Post-flip deployment](#post-flip-deployment-2026-08-17).

> **CI is a real gate again as of 2026-08-13 (#416).** It had been dead at
> setup since June (pnpm/action-setup v6 vs the `packageManager` pin), which
> also hid two asset-contract bugs behind it. `main` is now green on
> `check-and-build`, `docs`, `determinism` and `QA`. That matters for the flip:
> a public repo gets free Actions minutes on standard runners, so the CI the
> project inherits on day one actually works.

## Flip runbook

When the gates above are green:

The cut publishes **all of history**, not just the tip — so a value scrubbed
at the tip is still public unless the filter removes it everywhere. The path
list below therefore strips more than just the big binaries:

```bash
# 1. Fresh filtered cut from the up-to-date archive repo (run from a scratch dir)
git clone --no-local --single-branch --branch main <path-to-hoverbike> king-tide-cut
cd king-tide-cut

# replacements.txt — applied to every blob in history:
#   literal:15b62d20…==><cloudflare-account-id>
#   literal:dev-box==>dev-box
# NB: do NOT add a C:\Users\<name> rule. It is length-changing, and would
# corrupt the marshalled string tables inside any .pyc blob — those are
# removed by path instead (see __pycache__ below).

python -m git_filter_repo --force --invert-paths \
  --path public/audio --path bikes-src \
  --path-regex '^tracks-src/.*\.blend$' \
  --path-regex '^public/assets/(?!manifest\.json$).+' \
  --path docs/img \
  --path tools/blender/__pycache__ \
  --replace-text <replacements.txt> \
  --mailmap <mailmap.txt>   # same 3-line map: occ-matt / mattscott / "Uncle Matt Makes ___" → Uncle Matt Makes
```

Why the two extra `--path` entries — both carry the author's local Windows
path in *binary* metadata, and neither is reachable from the tip, so a
tip-only scrub misses them entirely:

- `docs/img` — 12 Blender-rendered PNG/JPGs whose `tEXt`/JPEG-comment chunks
  embed `C:\Users\<user>\projects\hoverbike\tracks-src\<name>.blend`. Deleted
  from the tip in #414; still the largest surviving blobs in the cut without
  this.
- `tools/blender/__pycache__` — 5 orphaned `.pyc` blobs (added and removed the
  same day in May 2026) whose `co_filename` records a
  `.claude\worktrees\<name>` path.

```bash
# 2. Verify BEFORE pushing — scan every surviving blob, not just the tip
git rev-list --objects --all | cut -d' ' -f1 | sort -u \
  | git cat-file --batch-check='%(objecttype) %(objectname)' \
  | awk '$1=="blob"{print $2}' \
  | while read -r sha; do git cat-file blob "$sha" \
      | grep -aoiE 'C:\\Users\\[A-Za-z0-9._-]+|15b62d20[a-f0-9]+|dev-box' ; done | sort -u
# expect: no output

# 3. Force-push over king-tide main (private, no consumers yet)
git remote add dest https://github.com/unclemattmakes/king-tide.git
git push --force dest main
```

Then, on GitHub (king-tide): flip **visibility → public**, enable secret
scanning + push protection (free on public repos), add branch protection on
`main`, seed topics + good-first-issues. GitHub Actions on standard runners
becomes **free** on the public repo — re-enable CI as a trusted gate and
reword the "don't trust CI" note in CLAUDE.md. Development cuts over to
king-tide as origin; `hoverbike` remains the private pre-filter archive.

Post-flip polish (non-gating): ~~point the README "Live" link at a stable
domain~~ — **DONE (#14)**: README, the VitePress nav and the docs landing page
pointed at the *per-deployment* URL, which sits behind Vercel deployment
protection and served an anonymous visitor a "Login – Vercel" page; they now
point at a stable URL. Superseded by the custom domain below — the links now
point at <https://kingtide.unclemattmakes.com>. Still open: announce with the
making-of site as the centerpiece.

## Post-flip deployment (2026-08-17)

The two items that needed dashboard access. Both are **done and verified live** —
verified by observing the deployed system, not by reading back the config.

### 1. Vercel repointed from `hoverbike` to `king-tide`

Both projects were **repointed, not recreated** (`vercel git connect`), so their
env vars, project IDs and production URLs are unchanged — critically
`VITE_ASSET_BASE_URL`, which is how production loads its art from the CDN.

There are **two** projects, not three — `hoverbike-3mrd` is the docs site, not a
second game project:

| Project | Serves | Root dir | Production URL |
|---|---|---|---|
| `hoverbike` | the game (Vite) | `.` | <https://kingtide.unclemattmakes.com> |
| `hoverbike-3mrd` | the VitePress docs | `docs-site` | <https://hoverbike-3mrd.vercel.app> |

Verified: PR #14 produced preview deployments on **both** projects, merging it to
`main` produced production deployments on **both**, and the live docs site now
serves the updated links (0 occurrences of the old URL, 2 of the new).

### 2. Global leaderboard switched on

`VITE_LEADERBOARD_HMAC_SECRET` is set on the `hoverbike` project, matching
`LEADERBOARD_HMAC_SECRET` on the Party.

- **Production target only.** Preview builds deliberately stay in local-only
  mode rather than writing to the live global board.
- Vercel classified it **Sensitive** (write-only), so it cannot be read back
  with `vercel env pull` — a redacted pull is *not* evidence of a problem.
- Verified in the shipped bundle: the 64-char value is inlined in
  `assets/remote-*.js` as a backtick literal with **no trailing newline**, and
  the `remote board disabled` branch is tree-shaken out (it only survives when
  the var is unset).
- Verified end-to-end against the live Party: a correctly-signed submission was
  accepted (`{"ok":true,"rank":1}`), read back from `GET /board/<id>`, then
  removed via `DELETE /admin/handle/<handle>`, leaving no residue. A throwaway
  `trackId` was used so no real track's board was touched. **This is the only
  check that proves both halves hold the same value** — the bundle check alone
  proves the client has *a* secret, not the *right* one.

Reading the failure modes: wrong client secret → `401 bad-signature`; unset
server secret → `503 unconfigured`; both correct → `200`.

### 3. Custom domain: `kingtide.unclemattmakes.com`

The canonical URL is now <https://kingtide.unclemattmakes.com>, replacing the
`hoverbike.vercel.app` alias (which still works as a Vercel alias). Set up to
match the existing `polyfish.unclemattmakes.com` convention on the same zone:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `kingtide` | `e5fe41961a182595.vercel-dns-016.com` | **DNS only** |

Two things to get right if this is ever redone:

- **The CNAME target is per-domain.** Vercel issues a unique
  `<hash>.vercel-dns-016.com` per domain — read it from the project's Domains
  page, don't copy another domain's. The legacy `cname.vercel-dns.com` and
  `A 76.76.21.21` still work, but the per-domain target is what Vercel now
  recommends and what `polyfish` already uses.
- **The Cloudflare proxy must stay off (grey cloud).** Proxied, Vercel cannot
  complete its `http-01` challenge, so no certificate is issued — and with
  Cloudflare SSL set to Flexible you get a redirect loop instead. The apex and
  `www` on this zone *are* proxied (they point at Pages); the Vercel subdomains
  are the exception.

Verified: `kingtide.unclemattmakes.com` → CNAME → Vercel edge (216.150.x, not
Cloudflare's 104.21/172.67 proxy range); Let's Encrypt cert issued for the exact
CN; `/` and `/making-of/` both 200; `http://` → `https://` 308. Cert issuance
lagged DNS by ~2 minutes — a failed TLS handshake immediately after adding the
record is expected, not a misconfiguration.

The leaderboard needed no change: the Party sends
`access-control-allow-origin: *`, so the new origin submits fine.

## Standing constraints (post-flip)

- **Music**: the 3 NC tracks are valid only while the game is non-commercial;
  the **7** tracks carrying a ShareAlike obligation (6 CC BY-SA + the one
  CC BY-NC-SA) must not be baked into published video trailers unless that
  video ships under the same licence (CC synch clause) — and for the
  BY-NC-SA one, non-commercially. Full table in [CREDITS.md](../CREDITS.md).
- **Midjourney**: crossing $1M yearly revenue would require an MJ Pro/Mega
  seat for asset ownership (not currently relevant — no monetization).
- **AI-raw content** is uncopyrightable (USCO 2025 / *Thaler* cert denied
  2026) — no license can attach to it; CREDITS.md labels it machine-generated.
