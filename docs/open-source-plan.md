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
2. ~~**Verify PartyKit prod env**~~ — **CHECKED 2026-08-13: no variables are
   set**, so the deployed board signs and verifies with `DEV_HMAC_SECRET`.
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
4. **Re-cut king-tide from the final hoverbike main** (see runbook), then
   flip visibility. ← the only remaining gate.

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

Post-flip polish (non-gating): point the README "Live" link at a stable
domain; announce with the making-of site as the centerpiece.

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
