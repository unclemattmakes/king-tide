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
  1× CC0, 4× CC BY, 5× CC BY-SA, 2× CC BY-NC, 1× CC BY-NC-SA, **0 ND,
  0 unverified**. `credits.json` sidecar written next to the mp3s;
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
  dead memory-bank link fixed (v1-asset-pipeline-plan); `dev-box`
  hostname → `dev-box` (changelog, perf-baseline, perf-reports); Vercel team
  slug dropped (docs-site platform.md); stale "CC0 placeholder" soundtrack
  claims corrected (README, status, product-plan, changelog,
  reef-cup-vertical-slice-status); orphaned `docs/img/` deleted (4.1 MB,
  embedded local paths in PNG metadata, referenced by nothing).

## Remaining gates before the flip

1. ~~**Replace the 13 Hunyuan props**~~ — **DONE (#415, merged 2026-08-13).**
   No track references any `ai/*` prop; the four live placements went to CC0
   equivalents at height parity and `cc0/anchor` was reconditioned upright.
   **One step left:** the GLBs are still *fetchable* on R2 even though nothing
   loads them — `rclone delete r2-hoverbike:hoverbike-content/assets/props/ai`
   (plus the local `public/assets/props/ai/` dir) closes the distribution
   surface. Deliberately left as a manual call because bucket deletes don't
   undo.
2. **Verify PartyKit prod env** — `LEADERBOARD_HMAC_SECRET` and
   `LEADERBOARD_ADMIN_TOKEN` must be set on the deployed project
   (`pnpm exec partykit env list`); the HMAC path fails *open* to the dev
   fallback secret.
3. **Contributor asset path** — the R2 bucket is public-read; add a tokenless
   pull (plain HTTPS off `https://hoverbike-content.mattscott.dev`) or
   document running with
   `VITE_ASSET_BASE_URL=https://hoverbike-content.mattscott.dev` so a fresh
   clone runs with zero credentials.
4. **Re-cut king-tide from the final hoverbike main** (see runbook), then
   flip visibility.

> **CI is a real gate again as of 2026-08-13 (#416).** It had been dead at
> setup since June (pnpm/action-setup v6 vs the `packageManager` pin), which
> also hid two asset-contract bugs behind it. `main` is now green on
> `check-and-build`, `docs`, `determinism` and `QA`. That matters for the flip:
> a public repo gets free Actions minutes on standard runners, so the CI the
> project inherits on day one actually works.

## Flip runbook

When the gates above are green:

```bash
# 1. Fresh filtered cut from the up-to-date archive repo (run from a scratch dir)
git clone --no-local --single-branch --branch main <path-to-hoverbike> king-tide-cut
cd king-tide-cut
python -m git_filter_repo --force --invert-paths \
  --path public/audio --path bikes-src \
  --path-regex '^tracks-src/.*\.blend$' \
  --path-regex '^public/assets/(?!manifest\.json$).+' \
  --mailmap <mailmap.txt>   # same 3-line map: occ-matt / mattscott / "Uncle Matt Makes ___" → Uncle Matt Makes

# 2. Force-push over king-tide main (private, no consumers yet)
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
  the 6 SA tracks must not be baked into published video trailers (CC synch
  clause). Full table in [CREDITS.md](../CREDITS.md).
- **Midjourney**: crossing $1M yearly revenue would require an MJ Pro/Mega
  seat for asset ownership (not currently relevant — no monetization).
- **AI-raw content** is uncopyrightable (USCO 2025 / *Thaler* cert denied
  2026) — no license can attach to it; CREDITS.md labels it machine-generated.
