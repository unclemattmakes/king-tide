# King Tide — Security Evaluation
> Evaluated 2026-08-22 · full-project review · perspective: Security

## Scope & method

Read from source, not run (no GPU/browser here; unit tests are sim-only). Opened:
the leaderboard Party (`party/leaderboard.ts`) + its shared crypto/protocol
(`src/engine/leaderboard/{hmac,protocol,core,endpoint,remote,local}.ts`) and the
moderation CLI (`tools/leaderboard-moderate.mjs`); the multiplayer relay
(`party/relay.ts`), wire codecs (`src/engine/net/{input-frame,transform-snapshot,
protocol,host-election,room}.ts`) and the client apply path
(`src/boot/multiplayer.ts`); the dev track-write middleware in `vite.config.ts`;
every HTML sink (`grep innerHTML/insertAdjacentHTML` across `src/`, then the
handle/name render paths in `menu-flow.ts`, `lobby-overlay.ts`,
`leaderboard-finish-banner.ts`, `spectator-hud.ts`); Electron hardening
(`electron/main.cjs`); all four workflows in `.github/workflows/`; `package.json`
overrides; `.env.example`, `.gitignore`, `tools/steam-upload.mjs`, `SECURITY.md`,
`docs/leaderboard-backend.md`, `docs/maintainer-workflow.md`. Ran a tracked-file
secret scan (clean apart from the intentional dev constant).

## Executive summary

For a hobby web game this codebase is **unusually honest about its own security
posture** — the leaderboard threat model in `party/leaderboard.ts` and
`docs/leaderboard-backend.md` names exactly what it does and does not defend, and
`SECURITY.md` scopes the relay's DoS/spoofing gaps out loud rather than pretending
they're solved. That candour is the strongest thing here and it is worth
preserving. The single load-bearing weakness is the one the docs already admit:
the leaderboard HMAC secret is **baked into the shipped client bundle**
(`VITE_LEADERBOARD_HMAC_SECRET`), so the "signed submission" scheme is a speed
bump, not authentication — any player can extract the key and forge scores inside
the plausibility band. That's acceptable *only* because reactive moderation
(`wipe`/`block`/`audit`) is the real defence and the stakes are cosmetic. The
multiplayer binary channel is **unauthenticated at the slot level**: the relay
stamps slots onto JSON control messages (so ready/start-race can't be spoofed) but
rebroadcasts input frames and transform snapshots verbatim, and the client's
ownership/AI-authority guards key on a *self-declared* `senderPeerId` — so a
hostile peer can impersonate the AI host or another rider's bike. The XSS surface
is genuinely well-contained: player-controlled strings are normalized to
`[A-Z0-9_-]` and escaped through `escapeHtml` at every sink I checked. The dev
track-writer is correctly `apply: 'serve'` (never in prod) with a strict id regex
plus a redundant traversal guard. The sharpest *real-world* blast radius actually
sits in CI: **no workflow declares `permissions:`**, and the Steam-release job
handles Steam Guard credentials while calling third-party actions pinned to
mutable tags — a supply-chain path that reaches players' machines. Electron is
mostly sane (context isolation on, `app://` traversal-guarded) but disables the
sandbox and installs no navigation/window-open restrictions. Nothing here is a
critical, remotely-exploitable, unattended hole; the profile is "casual-game
integrity gaps plus a couple of CI-hardening misses," and the fixes are cheap.

---

## Domain analysis

### 1. Leaderboard integrity — the HMAC secret ships to the client

`docs/leaderboard-backend.md` (the "Required secrets" table) and
`src/engine/leaderboard/endpoint.ts:57` are explicit: the production client is
built with `VITE_LEADERBOARD_HMAC_SECRET`, which Vite inlines into the JS bundle
served to every browser. `signPayload` (`hmac.ts:56`) keys HMAC-SHA256 with that
constant. **A secret that ships to every client is not a secret.** Anyone can open
DevTools, pull the string, and produce valid signatures for arbitrary submissions.

What that buys an attacker, concretely, against the real server
(`handleSubmit`, `party/leaderboard.ts:232`):

- Forge any `bestLap` **within the plausibility band** — `≥ MIN_LAP_SECONDS_BY_TRACK[track]`
  (e.g. 24 s for `sandbar`) and `≤ 1800 s` (`protocol.ts:100-124`). So "impossible
  1-second lap" is blocked, but "suspiciously-but-plausibly fast" is fully
  forgeable, which is the version that actually poisons a board.
- Any handle that clears the ~70-stem profanity list (`profanity.ts`).
- One submit / 5 s / IP (`RATE_LIMIT_WINDOW_MS`), evadable across IPs.

The defences that *do* hold are correctly built: the nonce ring + `±5 min`
timestamp window (`recentNonces`, `SUBMIT_TS_WINDOW_MS`) stop naive replay; the
server **fails closed** when `LEADERBOARD_HMAC_SECRET` is unset (`hmacSecret`
returns `null` → `503 unconfigured`, `leaderboard.ts:251`) rather than falling
back to the dev constant — a genuinely good call, and the docstring explains why.
Admin auth is a real bearer token compared in constant time
(`constantTimeEquals`, `leaderboard.ts:132`).

**Severity: medium**, and it is *by design* — the code, the docstring threat
model, and the ops doc all say "this is a be-polite-to-honest-players system, not
anti-cheat; reactive removal is where real protection lives." I agree with that
framing for this game. The honest recommendation is not "add real crypto" (there's
no account system to anchor it to) but: keep the plausibility floors tight and
per-track, keep `audit`/`wipe`/`block` as the front line, and — if you ever want
to raise the bar cheaply — have the server hand out a short-lived per-session token
(GET before POST) so a forger has to at least round-trip the live server instead of
minting offline. Do **not** advertise the board as tamper-proof anywhere in UI.

### 2. Multiplayer relay — slots are authenticated on JSON, not on binary

`party/relay.ts` is a deliberate stateless rebroadcaster, and for **control
messages** it does the right thing: `onMessage` stamps the sender's assigned slot
before broadcasting `ready`/`start-race` (`relay.ts:254-268`, comment: "peers
can't spoof another peer's ready state"). But the binary branch is one line:

```
if (typeof message !== 'string') { this.room.broadcast(message, [sender.id]); return }
```

Binary frames — `InputFrame` (tag `0x01`) and `TransformSnapshot` (tag `0x02`) —
are relayed **verbatim**, and their peer-id fields (`peerId`, `senderPeerId`,
`ownerPeerId`) are written by the sending client, never validated against the
connection's real slot. The client tries to compensate in `multiplayer.ts`:
player records are dropped when `record.ownerPeerId !== snap.senderPeerId`
(`:366`) and AI records are accepted only from `snap.senderPeerId === aiAuthority`
(`:365`, whose own comment admits "any peer could spoof the AI field"). The
problem is that **both checks trust the same self-declared `senderPeerId`**. A
hostile peer simply sets `senderPeerId` to the AI-authority slot and streams a
forged AI field, or sets `senderPeerId`+`ownerPeerId` to a victim's slot and
teleports their bike. `room.ts:451,460` drops only *self*-echoes (`!== myPeerId`),
which doesn't help. `SECURITY.md` scopes "cheating via crafted TransformSnapshot"
out, but the *mechanism* — the relay not stamping the binary channel — is the fix
and it's small: the relay already knows `sender.state.slot`; write it into a
trusted header byte on every binary frame and have receivers key their
ownership/authority checks on that byte, not on the payload. That converts the
client's existing guards from "honour system" to "enforced." **Severity: medium**
(casual share-link co-play, no ranked stakes; blast radius capped at 8 peers and a
mid-race join lock), but it is real griefing, not theoretical.

Room access is unauthenticated and guessable: `?room=<id>` with human-chosen ids
(`?room=test` in the README). Anyone who knows or guesses the id joins the lobby
and, combined with the above, can grief. The 8-peer cap (`assignLowestFreeSlot`,
`MAX_PEERS_PER_ROOM`) and the `RACE_JOIN_GRACE_MS` lock bound the damage. **Low-medium.**

Message flooding / oversized payloads: `SECURITY.md` accepts relay DoS explicitly.
There is no per-connection rate limit or max frame size on the relay; a peer can
spam broadcasts. Fine to accept for now, but worth a size clamp (snapshots have a
known max: `SNAPSHOT_HEADER_BYTES + 8 × SNAPSHOT_BIKE_BYTES`) so a single 10 MB
frame can't fan out to the room.

### 3. Client-side trust — times, ghosts, localStorage

There is **no client-side anti-cheat and the code doesn't pretend otherwise**.
Best laps + ghosts live in `localStorage` (`local.ts` `STORAGE_KEY`,
`ghost-state.ts`), fully player-editable. That only matters at the moment a local
PB is submitted to the global board, where it collapses into finding #1 (the
signature is forgeable regardless of how the number was obtained). The local cache
degrades safely: `loadStore` swallows parse errors and returns `{}` (`local.ts:37`).
Nothing reads a localStorage value back into a dangerous sink. This is the correct
posture for an arcade racer; no change needed beyond not over-claiming.

### 4. Dev-only track-write middleware — correctly fenced, one caveat

`trackEditorSavePlugin` in `vite.config.ts` is `apply: 'serve'` (line 24), so it is
**absent from `vite build`** — verified; it cannot reach a production deploy. The
write path (`:65-106`) validates `id` against `^[a-z0-9-]+$` (no dots, no slashes →
no traversal), requires the body to be a JSON object, and adds a redundant
`target.startsWith(TRACKS_DIR + path.sep)` belt-and-braces check before writing.
That is solid defense-in-depth. The one residual: the Vite dev server binds
localhost by default, but a maintainer who runs `vite --host` (or `pnpm dev --host`)
exposes `POST /__editor/save-track` to the LAN, letting anyone on the network write
arbitrary JSON into `public/tracks/*.json` (served as static content). It can't
write `.html` or escape the dir, so it's not RCE, but it is unauthenticated file
write. **Low.** Worth a one-line note in the editor docs: don't `--host` the dev
server on an untrusted network.

### 5. XSS surface — well-contained

99 `innerHTML` occurrences across 34 files, but the ones fed **network- or
player-controlled** strings are consistently guarded:

- Leaderboard handles are normalized to `[A-Z0-9_-]`, ≤12 chars
  (`normalizeHandle`, `core.ts:102`) **and** escaped at render
  (`menu-flow.ts:1383` `escapeHtml(entry.handle)`; the finish banner additionally
  re-strips with `handle.replace(/[^A-Z0-9_-]/g,'')`, `leaderboard-finish-banner.ts:244`).
  A `<`/`>` literally cannot survive both filters.
- Lobby peer picks + labels are escaped (`lobby-overlay.ts:257-258, 278`).
- Replay metadata — which loads from a downloadable `.replay` JSON file, i.e.
  an untrusted-import path — escapes `trackName`/`recordedAt`
  (`spectator-hud.ts:47,59`).

I found **no** path where an attacker-controlled string reaches HTML unescaped.
Two hygiene notes, both low: (a) `escapeHtml` is copy-pasted in six files
(`menu-flow`, `settings-overlay`, `spectator-hud`, `lobby-overlay`, `editor-ui`,
`cup-results-screen`) — drift risk; promote one shared util. (b) A handful of attribute interpolations are unescaped
because the data is build-time-static — the credits license link
`\`<a href="${url}">\`` (`menu-flow.ts:1570`, `url` from the generated
`soundtrack.generated` module) and the dev prop-viewer's `${id}`
(`prop-viewer.ts:218`). Neither is user-reachable today, but escaping the `href`
attribute is a free defense-in-depth if the credits list ever becomes data-driven.

### 6. Electron hardening — sane core, missing guardrails

Good: content loads over a custom `app://` scheme with a traversal-guarded handler
(`main.cjs:137-146`, `resolved.startsWith(DIST + path.sep)` else 403); no
`nodeIntegration: true`, no preload, no `@electron/remote`, so context isolation is
on by default (Electron 42) and the renderer has no Node bridge; `shell.openExternal`
is never called with dynamic input (it isn't imported at all).

Gaps: `webPreferences: { sandbox: false }` (`:127`) disables the renderer sandbox —
justified for the Steam Linux Runtime (the `--no-sandbox` comment explains the
chrome-sandbox setuid problem), but it widens the surface. There is **no
`setWindowOpenHandler` and no `will-navigate` handler**, so nothing stops the page
from navigating away from `app://` or spawning a native `BrowserWindow` — the
credits screen's `target="_blank"` links (`menu-flow.ts:1570`) would open in an
Electron window rather than the OS browser. `autoplay-policy` is relaxed and
`enable-unsafe-webgpu` is set on Linux (both explained, both fine for trusted local
content). **Severity: medium** for the desktop target. Fix is a few lines at
window creation: `setWindowOpenHandler(() => ({ action: 'deny' }))` and route real
external links through `shell.openExternal` behind an `https:`-only allowlist; add a
`will-navigate` guard that blocks any URL whose origin isn't `app://bundle`.

### 7. Supply chain & CI — the biggest real-world blast radius

**No workflow declares `permissions:`** (`ci.yml`, `qa.yml`, `build-desktop.yml`,
`release-steam.yml` — grep returns nothing). Every job therefore runs `GITHUB_TOKEN`
at the repository/org default, which on many repos is still `read/write` on
`contents`. `release-steam.yml` is the one that matters: it stages Steam Guard
credentials (`STEAM_CONFIG_VDF`, `STEAM_SSFN`) and pushes a build that reaches
players' machines. If any action in that job (or a transitive dep) were
compromised, an over-broad token plus credential env is the exfiltration path.
**Fix:** add top-level `permissions: contents: read` to all four workflows and
elevate per-job only where needed (`build-desktop`'s release step needs
`contents: write`). **Severity: medium.**

**Third-party actions are pinned to mutable tags, not commit SHAs:**
`AnimMouse/setup-rclone@v1` (runs in the jobs that stage the R2 asset credential,
`RCLONE_CONF_BASE64` — CI only pulls with it, and whether the baked token is
write-capable depends on how the operator scoped it), `softprops/action-gh-release@v3`,
`pnpm/action-setup@v6`, and first-party `actions/*@v7/@v8`. A tag can be repointed
at malicious code upstream; the rclone/steam jobs are exactly where that would
hurt. **Fix:** SHA-pin at least the non-`actions/*` third-party actions
(`setup-rclone`, `action-gh-release`). Dependabot is already configured for
`github-actions` (monthly), so pins will keep moving. **Severity: low-medium.**

Dependency pinning is otherwise healthy: `package.json` `pnpm.overrides` force
CVE-fixed floors for `esbuild ≥0.25.0`, `undici ≥6.24.0`, `vite ≥6.4.2`,
`ws ≥8.20.1`, `miniflare>undici ^7.29.0`. Runtime deps are current (three 0.184,
rapier-compat 0.19, vite 8, electron 42). `docs/dependency-triage.md` correctly
warns that a green `pnpm verify` is **not** sufficient for a runtime bump and points
at the determinism harness — good governance for a physics game.

### 8. Secrets hygiene — clean

`.gitignore` blocks `.env`/`.env.*` (keeping `!.env.example`), `public/assets/*`,
audio, `dist-electron/`. `.env.example` carries no live secret — only the public
asset CDN URL and a commented-out, empty `VITE_LEADERBOARD_HMAC_SECRET`. The only
secret literal in the tree is `DEV_HMAC_SECRET = 'hoverbike-dev-secret-do-not-ship'`
(`hmac.ts:108`), deliberately worthless and gated to `import.meta.env.DEV` so Vite
tree-shakes it out of prod. `tools/steam-upload.mjs` reads all Steam creds from env,
never logs the password (masks it in the echo, `:229`), and CI stages Guard tokens
from base64 secrets with `chmod 600`. My tracked-file scan for AWS/GitHub/Slack/PEM
patterns came back empty. Minor note: the leaderboard audit log persists raw client
IPs (`clientIp`, `leaderboard.ts:110`) in Durable-Object storage (rolling 1000) —
mild PII retention; fine for moderation, worth a line in a privacy note if the game
ever collects consent. Also `x-forwarded-for` is honoured when `cf-connecting-ip`
is absent (`:113`), and XFF is client-spoofable — behind Cloudflare `cf-connecting-ip`
is always present so the rate-limit/audit key is trustworthy in production, but if
the Party is ever hit directly the per-IP limit and audit attribution can be
poisoned. **Low.**

### 9. Disclosure policy & process

`SECURITY.md` is short but **adequate and honest** for the scope: private advisory
channel + email, a realistic 7-day hobby-project response target, and an in/out-of-
scope list that correctly flags the dev middleware, relay DoS, and crafted-snapshot
cheating. Process risks it doesn't cover, from `docs/maintainer-workflow.md`:
`enforce_admins` is **off** on `main` (a maintainer can bypass branch protection),
the `pnpm verify` pre-push hook is **opt-in and off by default**, and a push to
`main` is a direct production deploy of both Vercel projects **and** the PartyKit
relay with no staging step. These are documented tradeoffs, not bugs, but they mean
an unverified or malicious direct push to `main` deploys straight to players. For a
solo maintainer that's a reasonable posture; the moment a second person gets write
access, turning on `enforce_admins` is the right move (the doc says as much).

---

## Top 10 fixes & improvements (ranked)

1. **Stop implying the global leaderboard is tamper-proof; keep reactive moderation as the real line.**
   The HMAC secret ships in the client bundle (`VITE_LEADERBOARD_HMAC_SECRET` →
   `hmac.ts:56`), so any player can forge signed submissions inside the plausibility
   band. This is by design and documented, but the review-level fact is that the
   board has no cryptographic integrity. Keep `MIN_LAP_SECONDS_BY_TRACK` floors
   tight, keep `audit`/`wipe`/`block` sharp, and never label the board "verified" in
   UI. Player impact: without vigilance, fake-but-plausible times crowd the top-25,
   and the one competitive system in the game stops meaning anything.

2. **Add `permissions: contents: read` to every workflow; elevate per-job.**
   None of the four workflows scope `GITHUB_TOKEN`, so each runs at the repo default
   while `release-steam.yml` handles Steam Guard credentials and ships a build to
   players. An over-broad token in a credentialed job is the worst-case supply-chain
   exposure here. Player impact: this is the one path where a CI compromise could put
   a malicious desktop build in front of Steam players — worth closing even though
   exploitation needs an upstream break.

3. **SHA-pin third-party GitHub Actions (`setup-rclone`, `action-gh-release`).**
   They're pinned to mutable tags (`@v1`, `@v3`); a repointed tag runs attacker code
   in jobs that hold the R2 asset credential and the release path. Pin to full commit
   SHAs and let Dependabot bump them. Player impact: same release-integrity chain as
   #2 — protects the artifacts players actually download.

4. **Stamp the real slot onto binary frames at the relay; make client authority checks trust it.**
   `party/relay.ts` rebroadcasts input frames and transform snapshots verbatim, and
   `multiplayer.ts` keys ownership (`:366`) and AI-authority (`:365`) on a
   self-declared `senderPeerId`. A hostile peer can impersonate the AI host or
   another rider's bike. The relay already knows `sender.state.slot` — write it into a
   trusted header byte and validate against it. Player impact: closes the door on
   griefers teleporting the field or hijacking the AI in shared-link races.

5. **Lock down Electron navigation and window-open; reconsider the sandbox.**
   `electron/main.cjs` sets `sandbox: false` and installs no `setWindowOpenHandler`
   or `will-navigate` guard, so the app can navigate off `app://` or spawn native
   windows (the credits `target="_blank"` links would). Deny window-open, route real
   external links through `shell.openExternal` behind an `https:` allowlist, and
   block navigation whose origin isn't `app://bundle`. Player impact: hardens the
   desktop build so a future content bug can't turn the game window into an
   uncontrolled browser on the player's machine.

6. **Clamp binary frame size and add a light per-connection rate limit on the relay.**
   `SECURITY.md` accepts relay DoS, but a single oversized broadcast fans out to the
   whole room. Snapshots have a known maximum size (`SNAPSHOT_HEADER_BYTES + 8 ×
   SNAPSHOT_BIKE_BYTES`); reject anything larger and cap frames/sec per socket.
   Player impact: one bad actor can't lag-bomb or disconnect everyone else mid-race.

7. **Treat room ids as capabilities, or accept they're guessable — document it.**
   `?room=test`-style ids are unauthenticated; anyone who guesses one joins the lobby
   and (with #4 unfixed) can grief. Either generate high-entropy default room codes
   for the "invite a friend" flow or state plainly that room ids are shareable
   secrets. Player impact: keeps a stranger from wandering into a private race.

8. **Consolidate `escapeHtml` into one shared util and escape the credits `href`.**
   Six copies of the escaper invite drift, and the credits license link interpolates
   `${url}` into an `href` unescaped (safe today only because the data is static).
   One util + attribute-escaping is cheap defense-in-depth against a future
   data-driven credits list. Player impact: none today; it's insurance that a later
   feature can't reopen an XSS hole in a menu everyone sees.

9. **Prefer `cf-connecting-ip` strictly; don't trust `x-forwarded-for` for rate-limit/audit.**
   XFF is client-spoofable (`leaderboard.ts:113`); behind Cloudflare it's moot, but a
   direct hit to the Party lets an attacker forge the rate-limit/audit key. Drop the
   XFF fallback (or only honour it from known proxy ranges), and note the raw-IP
   retention in the audit log. Player impact: keeps the per-IP submit limit and the
   moderation trail honest, so abuse can actually be traced and throttled.

10. **Turn on `enforce_admins` when a second maintainer arrives; keep the pre-push hook and no-staging risk visible.**
    A push to `main` deploys the client and the relay to production with no staging,
    branch protection is admin-bypassable, and the verifying hook is off by default
    (`docs/maintainer-workflow.md`). Reasonable for a solo maintainer; the moment
    write access widens, require PRs. Player impact: prevents an unverified or hostile
    direct push from shipping a broken or malicious build straight to the live site.
