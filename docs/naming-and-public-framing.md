# Naming + public-repo framing

*Written 2026-09-02, reconciling `project-manager/briefs/king-tide.md` (also
2026-09-02) against this repo's own docs. Canonical answer to three questions:
what is this project called, where does the old name still live and why, and
what does the public repo say about itself.*

The brief is a good document and its direction is right. This file records
where the two sources agreed, where the brief was wrong or already stale, and —
the substantive finding — where its scope was far too small to act on safely.

---

## The name is settled: **King Tide**

Decided **2026-08-16**. Three independent records agree and none dissent:

| Record | Says |
|---|---|
| `src/engine/branding.ts` | `GAME_TITLE = 'KING TIDE'`; "'Hoverbike' was the working title" |
| site repo `CADENCE.md` | "King Tide (was Hoverbike), renamed 2026-08-16: Matt confirmed" |
| GitHub repo description | "King Tide — web-first arcade hover-bike racer…" |

**Do not re-ask this.** The brief is emphatic on the point and it is correct.

`Hoverbike` is *also* still a live proper noun, which the brief did not know:
[open-source-plan.md](open-source-plan.md) locked a decision on 2026-08-12 that
**`unclemattmakes/hoverbike` stays as the private archive repo**, and
`king-tide` is a fresh filtered cut of it. Verified 2026-09-02, unauthenticated:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://api.github.com/repos/unclemattmakes/hoverbike   # 404 (private)
curl -s -o /dev/null -w "%{http_code}\n" https://api.github.com/repos/unclemattmakes/king-tide   # 200 (public)
```

That also explains the drift mechanically: the public repo was cut on
**2026-08-12** and the name was settled on **2026-08-16**. The README froze four
days before the decision.

## What the brief got right, and is now done

- **`README.md` opened `# Hoverbike`.** True. Fixed 2026-09-02 → `# King Tide`.
- **`package.json` name disagreed.** True (`"name": "hoverbike"`). Fixed. Safe:
  the package is `private: true` and the name had exactly one other reference in
  the repo (none functional).
- **Check the two static strings in `index.html`.** Checked — `<title>King Tide</title>`
  (line 27) and the loading-screen `ls-brand` (line 4021) **were already correct**.
  The `branding.ts` sync comment did its job. Nothing to do.
- **Leave `docs/ui-art-direction.md` alone, it is the record of the decision.**
  Right instinct, wrong on the facts as they stood: that section opened
  *"'King Tide' is a placeholder"* and listed **TIDE RIDERS** as lead, which
  reads as an open question, not a record. Kept the pitch and the runners-up
  (the brief is right that they are worth having) and added a decision header
  above them so nobody reads it as live.

## What the brief got wrong

**The GitHub repo description is already correct.** The brief lists it as
remaining work. It reads "King Tide — web-first arcade hover-bike racer. JetMoto
homage with Wave Race water physics. Three.js + WebGPU + Rapier WASM." Verified
2026-09-02 with the `curl` above. Nothing to do.

**"Changing the name is a one-file edit"** — this repo's own claim, in
`ui-art-direction.md`, and the brief inherits its optimism. It is true of the
*wordmark* and false of the *name*. Corrected in place.

## The substantive finding: the rename is not one-directional and not cheap

The brief scopes item 1 as "README title, `package.json` name, docs headings,
and the GitHub description," then frames the work as **"make the repo say King
Tide."** The narrow list is safe. The framing is not — it invites a global
find-and-replace, and that would break live systems.

```sh
git grep -l -i hoverbike -- . ':!pnpm-lock.yaml' | wc -l   # 210 files
```

Those 210 files are **four different things**, and only the first is branding:

### 1. Cosmetic — safe to rename, low value

Prose in docs, comments, `docs/changelog-v1.md` (which is explicitly
v1-historical and arguably should keep the period name). Roughly the long tail.

### 2. Live infrastructure identifiers — renaming is a migration, not an edit

| Identifier | Where | Cost of renaming |
|---|---|---|
| `hoverbike-content` R2 bucket, `hoverbike-content.mattscott.dev` | `.env.example`, `asset-storage.md`, Vercel env | Every asset URL in production. Bucket rename + CDN domain + `VITE_ASSET_BASE_URL` on two Vercel projects, in lockstep. |
| `hoverbike.occ-matt.partykit.dev` | `partykit.json` `"name"`, `race-boot.ts:320`, `url-modes.ts:316`, `leaderboard/endpoint.ts:31` | Deploys to a **new** host. Every client still on the old bundle loses multiplayer *and* leaderboard until it reloads. |
| `hoverbike.*.v1` localStorage keys | `cup-progress.ts`, `leaderboard/local.ts`, `dev-settings.ts`, `camera-tuner.ts`, `brush-debug-menu.ts`, `rider-editor-mode.ts`, `dock-rail.ts` | Silently wipes every existing player's cup progress, local leaderboard and settings. Needs a read-old/write-new migration or it is data loss. |
| `hoverbike_*` Blender custom properties | ~20 files under `tools/blender/kingtide_addon/` (`panel.py` alone has 136) | These keys are **stored inside the `.blend` files** in Google Drive. Renaming the addon without a `.blend` migration silently orphans every authored track's gameplay data. |
| `[r2-hoverbike]` rclone remote | `steam/README.md`, the `RCLONE_CONF_BASE64` CI secret | Breaks `assets:pull` / `assets:push` for every clone and for CI hydration. |

None of these are visible to a player or a visitor. All of them are load-bearing.

### 3. Player-facing — **fixed 2026-09-02**

The brief missed this entirely, and it was the only real bug in the set: the
desktop build shipped under the old name. `branding.ts` cannot catch it because
packaging never imports the app.

| Surface | Was | Now |
|---|---|---|
| `electron-builder.yml` `appId` | `app.hoverbike` | `app.kingtide` |
| `electron-builder.yml` `productName` / `copyright` | `Hoverbike` | `King Tide` |
| `electron-builder.yml` `linux.executableName` | `hoverbike` | `king-tide` |
| `electron/main.cjs` `BrowserWindow.title` | `'Hoverbike'` | `'King Tide'` |
| Steam launch-option env var | `HOVERBIKE_BACKEND` | `KINGTIDE_BACKEND` |
| Launch wrapper | `electron/hoverbike-launch.sh` | `electron/king-tide-launch.sh` |

`productName` is the Windows installer title, the Start Menu shortcut and the
installed app name; `BrowserWindow.title` is the window title bar.

**Why it was safe to do now, and would not have been later.** `appId` is
Windows install/upgrade identity: change it after a public release and every
installed copy is orphaned from updates. `steam/README.md` confirms
`STEAM_APPID` and the depot IDs are still unset, so nothing has ever shipped
under `app.hoverbike`. Same reasoning for the wrapper filename and the env var —
renaming either breaks a Non-Steam Game shortcut or a Steam launch option that
someone has already configured, and nobody has.

**Display name and filenames are deliberately split.** `productName` is
`King Tide` (with the space) because that is what a person reads — installer,
Start Menu shortcut, Add/Remove Programs. Every *filename* derived from it is
pinned separately so nothing on disk carries a space:

| Setting | Value | Produces |
|---|---|---|
| `productName` | `King Tide` | display name only |
| `win.executableName` | `KingTide` | `KingTide.exe` |
| `linux.executableName` | `king-tide` | `king-tide` binary |
| `nsis.artifactName` | `KingTide-${version}-setup.${ext}` | `KingTide-0.0.0-setup.exe` |

Without `win.executableName` the Windows binary is named from `productName` and
comes out as `King Tide.exe` — awkward in the Steamworks launch configuration, in
shell commands and in CI globs. app-builder-lib 26 resolves the exe basename as
`executableName ?? sanitizedProductName` (`appInfo.js:56-57`), and only the Linux
packager reads `linux.executableName` by a separate path
(`platformPackager.js:317`), so the two coexist.

`KingTide.exe` is the string that gets typed into the Steamworks launch
configuration; `steam/README.md` and `steam/depot_windows.vdf` say so.

**Deliberately not renamed:** the CI artifact names in
`.github/workflows/build-desktop.yml` (`hoverbike-linux-tree`,
`hoverbike-windows-tree`, `hoverbike-windows-installer`). `release-steam.yml`
downloads `hoverbike-windows-tree` from a *previously completed* `build-desktop`
run, so renaming both sides in one commit still strands every run that already
exists. Zero player-visible benefit, non-zero breakage — category 2 behaviour in
a category 1 costume. Left alone on purpose; this paragraph is the record.

### 4. Deliberate — must **not** be renamed

`unclemattmakes/hoverbike`, the private archive repo, and every reference to it
in [open-source-plan.md](open-source-plan.md), including the flip runbook that
cuts `king-tide` *from* it. Renaming these would make the provenance record
incoherent.

### Recommendation

Do #1 and #3, skip #2 until there is a reason, never do #4.

The player-facing name is already 100% correct everywhere a player sees it
except the desktop build. Fixing `electron-builder.yml` and the README title
buys the entire visible benefit. The 200-file sweep buys tidiness and costs a
production migration.

**One decision is genuinely Matt's and has a deadline:** `appId: app.hoverbike`
→ `app.kingtide` before the first Steam/installer release, or it is locked in.

## Public + early: the framing the README does not yet state

The brief's item 2 is the one piece of unambiguously new, unambiguously right
work, and this repo has no counter-evidence to offer. The repo is public, it
auto-deploys, and the README's first screen is a v1/v2 correction banner and a
link index. It never says the project is deliberately early, what is worth
trying, or what not to file issues about.

The brief says to draft it and hand it to Matt for voice. Correct — and this
repo should not write it, for a second reason the brief names: the site repo
writes from a harvest interview with Matt, never from a repo, and paraphrasing a
repo into copy has already put wrong facts on the site once.

So the useful output from here is **questions, not prose**. Left for the
interview:

- What should a first-time visitor try first — Mayday Bay time trial, or practice mode?
- What feedback do you actually want right now, and what is noise?
- Is the greybox route-stub state something to apologise for or to show off?
- Does "open, early" mean issues welcome, or read-only-for-now?

**Do not write the launch post here, and do not draft site copy from this repo.**
The launch is scheduled for **Saturday 2026-10-10** and Matt held that date on
2026-09-02 ("let's not launch King Tide until we're ready"), so the
"if the repo goes public sooner" clause in the site's `CADENCE.md` is spent.
The gate is the interview, not the date, and not this README.

## Cold-visitor path (brief item 3)

Verified: six markdown files at repo root (`README`, `CLAUDE`, `CONTRIBUTING`,
`CREDITS`, `SECURITY`, `CONTENT-LICENSE`), plus `docs/`, `docs-site/`,
`making-of/`, `electron/`, `party/`, `steam/`, `research/`, `specs/`. The brief's
description is accurate and its question is fair.

Worth noting in its favour before anyone redesigns anything: the live URL is
line 5 of the README, above the fold, so "play it in one click" already works.
The gap is the one above — nothing tells a visitor what state it is in or what
to do with it.

## Drift found in this repo's own docs while checking

Not from the brief; found in passing and fixed.

- `README.md`'s v2 banner said only **Sandbar** + **The Maw** are dressed. Both
  [CLAUDE.md](../CLAUDE.md) and [status.md](status.md) supersede it: **Mayday
  Bay** (slug `sandbar`), **Angel Basin** (slug `mexico-city`) and **The Maw**,
  with The Maw deliberately parked to the B-list as 100% open water. The README
  was also still using the raw slug as a venue name, which `status.md` item 4
  explicitly warns against. Corrected.
- `ui-art-direction.md` called the shipped name a placeholder. Corrected above.

## Out of scope, and staying that way

Gameplay, physics, feel. The brief is explicit that nothing in it asks for the
game to be more finished, and nothing here does either.
