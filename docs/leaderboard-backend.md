# Leaderboard backend

Operational doc for the Time Trial leaderboard. Covers the deployment
pipeline, the moderation CLI, the threat model (and what it doesn't
cover), and how to extend the system. See
[v1-work-breakdown.md](./v1-work-breakdown.md) for the product status
+ definition-of-done convention this slots into.

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────┐
│  Game client (browser)                                            │
│                                                                   │
│  ┌──────────────────────┐    ┌─────────────────────────────────┐  │
│  │ finish overlay       │    │ menu / Leaderboards view        │  │
│  │ - inline initials    │    │ - track list + top-10 table     │  │
│  │ - submit on PB       │    │ - GLOBAL / LOCAL ONLY badge     │  │
│  └──────────┬───────────┘    └────────────────┬────────────────┘  │
│             │                                  │                   │
│             v                                  v                   │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │ src/engine/leaderboard/                                      │   │
│  │   local.ts       — localStorage cache (also the offline    │   │
│  │                    fallback when the network bounces)        │   │
│  │   remote.ts      — fetch wrapper (POST /submit, GET /board) │   │
│  │   endpoint.ts    — host + secret resolver (dev vs prod)     │   │
│  │   core.ts        — pure mergeEntry shared with server        │   │
│  │   hmac.ts        — WebCrypto sign/verify                     │   │
│  │   profanity.ts   — banned-stem list + leetspeak normalize    │   │
│  │   protocol.ts    — wire types + canonical signing payload    │   │
│  └────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
                                │
                  HTTPS         │ POST /submit  (signed)
                                │ GET  /board/:trackId
                                │ DELETE /admin/... (Bearer token)
                                v
┌──────────────────────────────────────────────────────────────────┐
│  PartyKit Party — party/leaderboard.ts                            │
│                                                                   │
│  - one global room (room.id === "global")                          │
│  - Party.Storage (Durable Object KV):                              │
│      track:<id>      → LeaderboardEntry[] (≤25, sorted)            │
│      blocklist       → string[]                                    │
│      audit           → AuditEntry[] (rolling 1000)                 │
│  - in-memory:                                                      │
│      lastSubmitByIp  → rate limit (1 / 5 s)                        │
│      recentNonces    → replay protection (±5 min window)           │
└──────────────────────────────────────────────────────────────────┘
```

Same `mergeEntry` runs on both sides so the local optimistic rank and
the server's authoritative rank agree on identical input. The local
cache is the source of truth for the player's "I just set a PB" pill;
the server reconciles when the round-trip lands.

## Deploying

The leaderboard Party rides on top of the existing PartyKit project
(`hoverbike.occ-matt.partykit.dev`). Adding it didn't change the
multiplayer wiring — relay + leaderboard live side by side under the
same `partykit.json`.

```
# Deploy both Parties (relay + leaderboard).
pnpm party:deploy
```

### Required secrets (PartyKit env vars)

| Name                       | Purpose                                                              |
|----------------------------|----------------------------------------------------------------------|
| `LEADERBOARD_HMAC_SECRET`  | Verifies submit signatures. Must match `VITE_LEADERBOARD_HMAC_SECRET` baked into the client bundle. |
| `LEADERBOARD_ADMIN_TOKEN`  | Bearer token for admin endpoints (wipe / block / audit).             |

Set them once via the PartyKit CLI:

```
pnpm exec partykit env add LEADERBOARD_HMAC_SECRET
pnpm exec partykit env add LEADERBOARD_ADMIN_TOKEN
```

### Required build env (client)

Set in your `.env` / CI build environment before `pnpm build`:

```
VITE_LEADERBOARD_HMAC_SECRET=<must equal LEADERBOARD_HMAC_SECRET>
```

**Both halves are required for the global board to accept anything.**

- **Server without `LEADERBOARD_HMAC_SECRET`** → every submit is refused
  with `503 unconfigured`. Reads (`/board`, `/health`) keep working, so an
  unconfigured deploy still serves whatever it holds. It does *not* fall back
  to the dev secret: that constant lives in the source tree, so falling back
  meant accepting anything from anyone.
- **Client built without `VITE_LEADERBOARD_HMAC_SECRET`** → the remote board
  is disabled for that build and personal bests stay in the local cache (the
  same path as `?leaderboard=local`), with a console warning. It no longer
  signs with the dev constant and submits into the void.
- **Mismatched halves** → `401 bad-signature`, as before.

So a deploy that forgets either half degrades to a local-only leaderboard
rather than a global one that silently accepts forgeries.

### Local dev

```
pnpm party:dev      # PartyKit on localhost:1999
pnpm dev            # Vite on localhost:5173
```

The client auto-points at `localhost:1999` in dev. Use
`?host=<host>` to override (e.g. to test the staging Party from a
local dev build):

```
http://localhost:5173/?leaderboard=local   # bypass remote entirely
http://localhost:5173/?host=hoverbike.occ-matt.partykit.dev
```

## Moderation CLI

A tiny Node wrapper around the admin endpoints. Reads the bearer
token from `LEADERBOARD_ADMIN_TOKEN` (env or `--token=…`).

```
# Skim recent submissions.
pnpm leaderboard:moderate audit --limit 50

# Nuke a handle from every track + block future submissions.
pnpm leaderboard:moderate wipe-handle SLURXYZ

# Remove a single suspicious row (1-indexed rank from the top).
pnpm leaderboard:moderate wipe-entry the-maw 3

# Block a future submission without touching past entries.
pnpm leaderboard:moderate block SOMEHANDLE

# See what's currently blocked.
pnpm leaderboard:moderate blocklist

# Undo a block (mistake, or a test handle).
pnpm leaderboard:moderate unblock TST
```

All commands honour `--host=<host>` (default
`hoverbike.occ-matt.partykit.dev`).

`unblock` only lifts the block — entries removed by `wipe-handle` are
gone and don't come back. It's idempotent: unblocking a handle that
isn't listed prints "was not on the blocklist" and changes nothing, so
a typo reads as a typo rather than a silent success.

### When to reach for which lever

| Symptom                            | Lever                                  |
|------------------------------------|----------------------------------------|
| Offensive handle on the board      | `wipe-handle` (wipe + block)           |
| Implausibly fast time, single row  | `wipe-entry <track> <rank>`            |
| Same player re-creating with leet  | `block` after each `wipe-handle`       |
| "Is this account being abused?"    | `audit --limit 500`                    |
| "What handles are blocked?"        | `blocklist`                            |
| Blocked the wrong handle / a test  | `unblock <HANDLE>`                     |

## Threat model — what's protected, what isn't

| Threat                                  | Defence                                                                                          |
|-----------------------------------------|--------------------------------------------------------------------------------------------------|
| Curl-script spam from a single host     | Per-IP rate limit (1 / 5 s, in-memory)                                                          |
| Replayed captured submission            | Nonce ring (±5 min window) + timestamp check                                                     |
| Forged submission from a random tool    | HMAC signature against `LEADERBOARD_HMAC_SECRET`                                                |
| Offensive handle                        | Profanity filter (client nudge + server reject), reactive `wipe-handle`                          |
| Obvious implausible time (sub-second)   | Per-track plausibility floor (`MIN_LAP_SECONDS_BY_TRACK`)                                       |
| Determined cheater reads the bundle     | **Not protected.** The HMAC secret ships in the client bundle. Use `wipe-entry` / `block`.       |
| Sustained adversary running scripted abuse from many IPs | **Not protected.** No account system, no rate-limit-across-IPs. Reactive moderation only. |

The honest framing: this is a "be polite to honest players" system,
not an anti-cheat. The signature, timestamp, nonce, rate limit, and
filter raise the cost just enough to keep the casual try-once cases
out. Reactive removal is where real protection lives.

If the board sees sustained abuse, the response order is:

1. `audit --limit 1000` to spot the pattern.
2. Wipe + block the offending handles.
3. If a single IP is hammering, hardcode it into a server-side IP
   block list (not yet implemented — extend `LeaderboardServer`
   if needed).
4. Rotate `LEADERBOARD_HMAC_SECRET` so leaked client bundles stop
   working. This invalidates every in-flight client until they pick
   up a new build — only do it if the abuse warrants it.

## Implementation notes

- **Single global room** — the Party id is hard-coded to `global` on
  both sides. If we ever shard by region the `RemoteEndpoint.room`
  field is the hook to use; the server logic doesn't care which room
  it runs in.
- **Pure merge logic** — `core.ts` is the shared `mergeEntry` used by
  the local cache and the server. Both call sites pass `Date.now()`
  for `recordedAt`, but the server's value is the authoritative one
  in the persisted record.
- **Plausibility floors** are hard-coded in `protocol.ts` as a static
  map. When a new v1 track ships, add its floor there. Defaults to
  `DEFAULT_MIN_LAP_SECONDS` (5 s) for unknown tracks.
- **Profanity list** is hand-curated in
  `src/engine/leaderboard/profanity.ts` (~80 entries). Short stems
  use word-boundary matching to avoid the Scunthorpe problem. False
  negatives are expected and intended — the wipe path handles them.
- **Audit log** is bounded at 1000 entries per Party. If the room
  ever sees enough volume that this rolls in <24 h, bump
  `AUDIT_LOG_LIMIT` or move to a streaming sink.

## What the M16 backend swap unlocks (and what's still TODO)

The local-cache fallback + the offline-tolerant UI means the menu
view + finish-overlay banner already do the right thing whether or
not the server is reachable. The remaining open items, in rough
priority order:

1. **Per-bike filter** — global board lumps every bike into one
   ranking. Wave Race had per-bike boards; we should follow once
   five variants ship.
2. **Pagination** — top-10 is plenty for v1; if the global board grows
   past 25 active handles per track, add `?after=<rank>` to
   `GET /board`.
3. **Server-side IP block list** — currently in-memory only. Make
   persistent if sustained abuse warrants.
4. **Ghost upload** — design-targets.md mentions "ghost playback +
   global leaderboard" together. Today only times sync; the ghost
   replay still lives in the player's localStorage. Sharing ghosts
   adds storage cost and a download-on-demand flow; defer until v1
   ships.
