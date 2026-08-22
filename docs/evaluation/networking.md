# King Tide — Networking Evaluation

> Evaluated 2026-08-22 · full-project review · perspective: Networking (multiplayer/netcode engineer)

## Scope & method

Full read of the netcode stack: `party/relay.ts`, `party/leaderboard.ts`, every
module under `src/engine/net/` (protocol, room, input-frame, transform-snapshot,
host-election, slot-assign, latency, mp-status), the boot wiring
(`src/boot/multiplayer.ts`, `src/boot/game-loop.ts` MP sections,
`src/boot/url-modes.ts` lobby path), the sim-side receivers
(`src/game/systems/apply-snapshot.ts`, `remote-interp.ts`, `race.ts` teleport
guard), the lobby (`src/engine/menus/mp-lobby.ts`, `lobby-pick` references,
`src/engine/render/lobby-overlay.ts` connecting states), and the leaderboard client
(`src/engine/leaderboard/protocol.ts`, `endpoint.ts`). Docs diffed against code:
`docs/m10-11-state-sync.md`, `docs/multiplayer-review.md`,
`docs/leaderboard-backend.md`, `SECURITY.md`, ADRs 0002/0004. Test inventory
inspected (`tests/unit/relay-*`, codec/interp/election suites,
`tests/e2e/m10-11-state-sync.spec.ts`) plus `playwright.config.ts` and
`.github/workflows/ci.yml` to establish what actually runs where. Nothing was
executed against a live relay (no GPU/browser on this machine); all claims are
verified in source unless marked "stated in docs".

## Executive summary

This is an unusually disciplined small-scale netcode stack for a solo/indie
project. The architecture — a stateless PartyKit relay doing slot-stamped JSON
control + format-agnostic binary passthrough, owner-authoritative 20 Hz
transform snapshots, tenure-based host election for AI, snapshot interpolation
at the sim layer — is coherent, the wire formats are tight and documented with
rationale, and the June 2026 hardening pass (`docs/multiplayer-review.md`) is a
model of honest self-review: all 13 of its findings verifiably landed in code,
including the subtle ones (race lock surviving Durable-Object recycles,
deterministic lobby track pick, synchronized start barrier, teleport-guarded
gate crossings). Unit coverage of the net layer is genuinely strong, and the
relay is tested against the real `RelayServer` class, not a mock of it.

The honest ceiling: this is **transform replication over TCP with no shared
clock**, and everything not a transform is per-tab fiction. Combat and pickups
do not exist on the wire — a missile hit on a remote player's kinematic mirror
does nothing on their screen. Race results are computed per-tab from poses
rendered ~100 ms + half-RTT late, so close finishes can disagree about who won.
The interpolator keys on packet *arrival* time with a two-sample buffer, so
jitter degrades as freeze-then-snap rather than gracefully. The snapshot
position format saturates at ±327.67 m and the code's own comment names the
current proof-of-thesis maps (Mexico City, Cape Town) as likely to exceed it —
with only a dev-console warning standing between that and silently pinned
bikes in production. And the two-tab e2e that would catch cross-tab
regressions exists but never runs in CI, while the README still claims it
doesn't exist at all. None of these are architectural mistakes; they are the
known next slices (M10.13–M10.15), and the codebase has left itself clean
seams for all of them. The gap between "works impressively in a two-tab
happy-path" and "holds up with four friends on real Wi-Fi" is where all the
remaining work lives.

## The relay (`party/relay.ts`) — verified in code

**What it is.** A pure relay: binary frames rebroadcast to every other peer
untouched (`onMessage`, relay.ts:242-245); JSON control messages parsed,
slot-stamped server-side so peers can't spoof each other (relay.ts:251-268),
and rebroadcast. Presence state is minimal and deliberate: per-slot ready/picks
for late-join lobby paint, and the race session record.

**The race lock is the standout piece of engineering.** `start-race` sets a
sticky bit + timestamp + track id + expected-cohort count, persisted to room
storage *before* broadcasting (relay.ts:274-293) — because the lobby→race
navigation handoff reliably empties the room and PartyKit/Cloudflare recycles
the server instance on empty, so in-memory state alone never survives into the
race. `onConnect` recovers the record (relay.ts:148-157); an empty room past
the 30 s `RACE_JOIN_GRACE_MS` is treated as abandoned and reset; joins after
the grace are rejected with `race-in-progress` + close 4001 (product rule: no
mid-race joins). The doc admits the original M10.12 late-join replay "had been
silently broken in every real cohort race" until this was understood
(multiplayer-review.md Phase 8.3) — exactly the kind of platform-lifecycle bug
that kills naive Durable-Object designs, found and fixed with a test
(`tests/unit/relay-start-barrier.test.ts` case 6 pins the recycle survival).

**Synchronized start.** The relay holds `race-go` until every expected racer
reports `race-loaded`, or 25 s (`RACE_START_TIMEOUT_MS`, kept inside the join
grace so a go always fires while stragglers can still be admitted —
relay.ts:53-60). Late loaders get a direct solo replay (relay.ts:301-308).
Deliberately no release-on-departure — the comment documents the observed
failure mode (transient close during cold-compile load splitting the start)
that motivated the choice (relay.ts:319-327). Client side, a 15 s failsafe
(`MP_START_FAILSAFE_MS`, game-loop.ts:1031) covers a dead relay, and an
old-relay fallback (`startBarrier` capability flag in `hello`) arms locally.
This is careful, version-skew-tolerant protocol design.

**Host election is tenure-based** (`joinSeq` monotonic per room session,
stamped at connect — relay.ts:118-122, 209-210), fixing the recycled-slot
seizure bug (review finding #5): a rejoiner landing on slot 0 can no longer
teleport the AI field to its local spawn state. `host-election.ts` falls back
to slot order against an old relay. Clean, pure, unit-tested.

**Weaknesses.** (a) No payload size cap or per-connection rate cap on the
binary path — any peer can have the relay amplify arbitrary bytes ×7. This is
an *accepted* posture (SECURITY.md "Out of scope", m10-11-state-sync.md §9),
but the mitigation is ~10 lines and room ids are guessable strings, so it is
cheap griefing surface, not just theoretical DoS. (b) `parseClientControl`
accepts `start-race` without validating `trackId`'s type (relay.ts:86) — a
non-string value would be stored and replayed in every subsequent `hello`.
(c) `peerPicks` are in-memory only, so they are wiped by the same handoff
recycle the race record survives — see "cohort liveries" below.

## The client net layer (`src/engine/net/`) — verified in code

**`room.ts`** wraps partysocket with the two-tier protocol and is the best
kind of boring: reused send buffer, explicit-close flag so teardown doesn't
republish `connecting` (review finding #9, fixed), close-code 4000/4001 as the
reliable rejection contract because the courtesy JSON "can be dropped when the
server's close races its send" (room.ts:307-319 — the kind of detail you only
write down after being burned by it), defensive self-echo drops on both binary
paths, per-slot state fully cleared on close/peer-left so recycled slots can't
inherit stale intents or picks.

**Wire formats.** `input-frame.ts` (11 bytes, tag + tick + slot + quantized
axes) and `transform-snapshot.ts` (8-byte header + 24 bytes/bike: int16 cm
positions, int16 quat with renormalize-on-decode, int16 1/256 m/s velocities)
are documented with quantization rationale, little-endian throughout, reserved
bytes for forward compat, round-trip unit tested. The 60 Hz InputFrame
broadcast was correctly identified as dead relay load post-M10.11 and removed,
with the codec and receive path retained for M10.13 combat events
(room.ts:117-120) — good discipline about keeping the seam without paying for
it.

**RTT.** 1 Hz ping/pong echo (server stateless, client stamps
`performance.now()`), EWMA α=0.25, stale-out to −1 after 6 s
(`latency.ts`) — surfaced in the lobby, the Settings → Network tab, and the
in-race room chip via the `mp-status` pub/sub singleton. Solid for a
"am I lagging?" readout; it is *not* fed back into anything adaptive
(interp delay, start compensation) — see below.

**Interpolation/extrapolation (`remote-interp.ts`).** Two-sample buffer per
kinematic body; render time = `now − 100 ms`; lerp position, shortest-arc
slerp rotation; extrapolation clamped at t = 1.5 then freeze. This eliminates
the 20 Hz teleport-hitch and is fine on a clean LAN. Under real conditions it
has three structural limits, all acknowledged nowhere except partially in
finding #14 ("fixed 100 ms interp delay; `tick` field unused"):

1. **Arrival-time playback amplifies TCP jitter.** WebSocket loss manifests
   as retransmit stalls followed by burst delivery. Buffered snapshots then
   arrive back-to-back with `receivedAt` values microseconds apart, so
   `span ≈ 0 → t = 1` — the interpolator snaps to the latest sample instead
   of replaying the burst over its original timeline. The sender's `tick` is
   already on the wire (snapshot header) and unused.
2. **Two samples is not a jitter buffer.** The 1.5 clamp lets the pose coast
   only half a snapshot interval (~25 ms at the 50 ms cadence) past the
   newest sample, so any arrival gap beyond ~125 ms of wall clock (the
   100 ms delay + that slack) freezes the bike, then it teleports on the
   next arrival. At 200 ms RTT with occasional loss, remote bikes will
   visibly stutter-freeze-snap several times a minute.
3. **The 100 ms delay is fixed**, not derived from observed jitter — too much
   for a wired peer, too little for a bad Wi-Fi one.

**Lag compensation / clock sync: none, and none needed yet.** There is no
hitscan and no server-side rewind to do; the racing sim reads only local +
mirrored poses. But two places already pay for the absence of any clock
model: `race-go` start skew equals one-way relay latency (protocol.ts:133-141
says so explicitly), which systematically hands high-ping players a late
start; and any future combat sync will need at least an RTT/2 offset estimate,
which the 1 Hz ping already provides raw material for.

## Consistency model — what is actually shared, verified in code

| State | Authority | Verified where |
|---|---|---|
| Your bike pose | You (dynamic body, 20 Hz broadcast) | multiplayer.ts:486-535 |
| AI bike poses | Elected host (tenure); receivers drop `bikeKind=1` records from non-authority senders | multiplayer.ts:355-370 |
| Remote player poses | Owner only; `ownerPeerId ≠ senderPeerId` records dropped (spoof filter) | multiplayer.ts:366-370 |
| Lobby ready/picks/track | Relay-stamped, deterministic pick (`lobby-pick`), server `start-race` overrides a locally-armed pick | mp-lobby.ts:193-226 |
| Race start | Relay barrier (`race-go`) | relay.ts:328-344 |
| Lap/checkpoint/standings | **Per-tab**, computed from local (delayed) poses | race.ts; m10-11 §7 decision |
| Finish order / results | **Per-tab** — no finish event exists on the wire; the snapshot `flags` byte is reserved-but-unused | transform-snapshot.ts:72-73 |
| Pickups (boxes, held item) | **Per-tab fiction** — zero net references in `pickup.ts` | verified by grep |
| Combat (mines, missiles, hits) | **Per-tab fiction** — hit effects are local `setLinvel` writes (combat.ts:70), inert on a kinematic mirror and never sent to the owner | verified in code |

So: **yes, two clients can disagree on who won.** Each client sees remote
bikes ~100 ms (interp delay) + ~RTT/2 + up to 50 ms (sampling) behind their
owner's truth — ≈ 4–7 m at race speed on a 100–200 ms connection. In any
finish closer than that, both players' HUDs can show themselves ahead at the
line, and the cup points each tab awards will differ. The m10-11 doc makes
this an explicit, reasonable v1 decision (§7: "standings can momentarily
disagree... converge", M10.15 reserved for host-authoritative race state) —
but "momentarily disagree" understates the finish-line case, where the
disagreement is *permanent per race* because finishing freezes each tab's
local result. The teleport guard (race.ts:48-124, review finding #10) fixes
phantom checkpoint crossings from snapshot sweeps; it does not touch ordering.

And the combat gap is the bigger product problem: the README sells "light
Mario Kart combat" and the lobby flows straight into races with pickups
enabled, but in multiplayer the items are cosmetic against other humans. A
player who lands a homing missile on a rival sees a local hit reaction that
the rival never experiences. M10.13 (owner-authoritative combat events) is the
planned fix and the InputFrame channel is retained for it; until it lands,
shipping pickups in MP rooms is shipping a lie.

## Determinism as a rollback foundation — verified in code + ADRs

The foundations are real: ADR 0004 deliberately pins the slower
`@dimforge/rapier3d-compat` deterministic build over the faster regular
package; ADR 0002's sim/render split keeps the sim Three-free (headless-
steppable); `src/engine/sim/snapshot.ts` produces a canonical sorted hash of
bodies + every sim-carrying component store, used by the `?determinism=1`
harness and `m10-determinism.spec.ts`; `dependency-triage.md` institutionalizes
the harness as the gate for runtime bumps (it caught rapier 0.20 moving the
bike 47 cm). Input is already a compact, tick-stamped, quantized frame whose
local encode→decode round-trip drives the sim (input-frame.ts docs), so
quantization can never cause cross-peer divergence.

But the honest reading — which `snapshot.ts` itself states in an exemplary
comment — is that this is a **desync-detection** apparatus, not a rollback
substrate: "deliberately NOT a rollback restore point — there is no
`restoreSnapshot`". Rollback additionally needs full sim state
save/restore (including Rapier world state, which the compat build does not
serialize cheaply), input-delay scheduling, a shared tick clock, and
per-remote-input prediction. m10-11 §9 lists "Lockstep / rollback — not on
the M10.x roadmap", and that is the right call: for a 2–8 player arcade racer
with no hit-scan, snapshot replication + owner authority is the correct
cost/benefit point, and the determinism investment still pays for itself in
replays, ghosts, and regression triage. Just don't let anyone read
"deterministic build" as "rollback-ready" — it is one prerequisite of five.

## Leaderboard backend (`party/leaderboard.ts`) — verified in code

A single global Durable Object room holding per-track top-25 arrays, an
admin-managed handle blocklist, and a rolling 1000-entry audit log. The
defence stack (HMAC + ±5 min timestamp + nonce ring + per-IP 5 s rate limit +
plausibility floors + a ~80-stem profanity filter + admin moderation CLI) is proportionate, and the
threat-model doc is refreshingly honest that the HMAC secret ships in the
bundle and "reactive removal is where real protection lives"
(leaderboard-backend.md). Two changes since the original design are notably
correct: the server **fails closed** when `LEADERBOARD_HMAC_SECRET` is unset
(503 `unconfigured` instead of falling back to the in-repo dev constant —
leaderboard.ts:141-155), and a client built without the secret disables the
remote board instead of signing into the void (endpoint.ts:60-74). Admin auth
is constant-time compared. Nonce/rate-limit state being in-memory-only is
correctly scoped to its window sizes.

Remaining rough edges: (a) **the cross-language float footgun is documented
but not fixed** — `canonicalSubmitPayload` serializes `bestLap` via JS
`Number.prototype.toString()` (protocol.ts:39-51), so `40.0` signs as `"40"`
and every non-JS client that formats floats naturally gets `401
bad-signature`, an error that points at the key, not the number
(README:190, with an excellent worked Python example in the ops doc). A v2
canonical payload carrying `bestLapMs` as an integer would erase the trap
instead of documenting it. (b) Every submit does a read-modify-write of the
full audit array (leaderboard.ts:489-494) — fine at hobby volume, quadratic-ish
pain if the board ever gets hammered; the doc already flags the roll-over
case. (c) One global DO means one region serves every read worldwide; also
fine for now, and the `room` field is the acknowledged sharding hook.
(d) `recentNonces` eviction is lazy per-submit — bounded by the 5-min window,
OK. Availability posture: reads keep working unconfigured; client falls back
to the localStorage cache when the network bounces. This is a healthy
"be polite to honest players" system that knows what it is.

## Scale & cost posture

Numbers check out and are tiny. Full 8-peer room: seven non-hosts at
32 B × 20 Hz plus one host at 200 B × 20 Hz (8 + 8×24 for 1 player + 7 AI —
the m10-11 revision note corrects the older 4-AI math) ≈ 8.5 KB/s relay
ingress, ×7 fan-out ≈ 60 KB/s egress per room, ~160 msgs/s in / ~1,120 out.
Ping traffic is 1 Hz/peer by design partly for billing reasons
(room.ts:223-227). `MAX_PEERS_PER_ROOM = 8`. Nothing here threatens any
plausible PartyKit/Cloudflare budget; the binding constraint is concurrent
connections, not bytes.

Two real posture risks, neither in the docs: (a) **vendor/platform risk** —
the whole multiplayer + leaderboard stack rides the hosted
`*.partykit.dev` platform (post-Cloudflare-acquisition), with the prod host
hard-coded in three places (`race-boot.ts:320`, `url-modes.ts:310`,
`endpoint.ts:31`). The mitigation is already designed in — the relay is a
pure broadcaster explicitly built to be swappable to "a Node WS server or
mock harness" (relay.ts:4-10) — but nobody has proven the swap. (b) **manual,
untracked worker deploys** — `pnpm party:deploy` is a human action with no CI
hook, so client-vs-relay version skew is a standing operational state. The
protocol handles it unusually well (optional `joinSeq`/`startBarrier` fields
with client fallbacks), and the review's "prod note" flags which features are
inert until deploy; but there is no way to *see* what relay version prod is
running short of behavioral probing.

## Testing reality

**Strong tier — runs in CI on every push** (`check-and-build`): the relay is
unit-tested as the real `RelayServer` class against a hand-rolled fake room
(`relay-ping.test.ts`, `relay-start-barrier.test.ts` — six barrier cases
including storage-recycle survival), codecs round-trip
(`input-frame`, `transform-snapshot`), election (`host-election` incl. tenure
cases), `slot-assign`, `latency`, `remote-interp` (slerp, clamp, lifecycle),
`apply-snapshot`, `lobby-pick` determinism, and the whole leaderboard stack
(`leaderboard-server/-hmac/-core/-profanity/-local`). This is the best
unit-level net coverage I have seen in a project this size.

**Weak tier — never runs anywhere automatically**: the two-tab Playwright
spec (`tests/e2e/m10-11-state-sync.spec.ts`) is genuinely good — own
`partykit dev` sidecar per worker with pid-salted ports and a
stale-relay-proof readiness probe, two *separate browsers* with
non-overlapping windows to defeat Chromium occlusion throttling (a trap that
"cost a day of flake-chasing" and is now documented in the spec header),
covering cohort convergence, role invariants, host handoff, deterministic
track agreement, and the 32 s race-lock wait. But the CI `e2e` job skips
without the never-set R2 secret and would fail on GPU-less runners anyway
(ci.yml:71-135, CLAUDE.md hard rule 1), so this spec runs only when a
developer remembers to run it headed. Worse, **README's Known Issues still
says the two-tab probe "is not yet automated"** (README:189) — stale since
2026-06-09 — so a contributor reading the entry point is actively told the
safety net doesn't exist and won't know to run it. The relay's own P0 history
(the 4-vs-7-AI buffer freeze) is precisely the class of bug only the cross-tab
tier catches.

A cheap upgrade exists: the lobby/lock/barrier tests don't need a GPU or
assets in principle — a raw-WebSocket relay integration suite (the review
already used throwaway raw-WS probes to verify the lock) could run headless in
the unit tier against a `partykit dev` sidecar and put the relay *lifecycle*
under CI, leaving only pose convergence to the headed spec.

## Failure UX

- **Mid-race disconnect: excellent.** `onDisconnected` degrades to solo —
  despawn all remote bikes (no zombie Racers in standings), re-stamp
  `PeerControlled` to `LOCAL_PEER_ID` so controls keep working (finding #4's
  dead-controls bug, fixed), take AI authority in place (kinematic poses held,
  so no teleport), room chip labels "reconnecting…"; reconnect re-converges
  via a fresh hello (multiplayer.ts:445-468). Post-grace reconnects are
  rejected by the race lock and the chip honestly says
  "locked (race in progress) — riding solo" (multiplayer.ts:239-243).
- **Room full / race locked: good.** Close codes are the contract, retries
  stop, the lobby banner survives the state flip back to connecting
  (lobby-overlay.ts:272-282).
- **Relay down / `?room=` without `pnpm party:dev`: weak.** The lobby renders
  "CONNECTING TO THE BROADCAST…" forever while partysocket retries silently —
  no timeout, no "relay unreachable" message, no hint at the dev-mode cause
  (README documents it; the UI doesn't). Esc bails to menu, but nothing tells
  the player to press it. In-race, the 15 s `MP_START_FAILSAFE_MS` at least
  arms the countdown locally after a dead-relay hold.
- **Cohort liveries: known-open.** Lobby picks are keyed by slot in relay
  memory and don't survive the handoff recycle, so `spawnRemoteBike` falls
  back to the default variant — every real cohort race shows your friend on
  the wrong bike (acknowledged open in multiplayer-review.md's verification
  log; fix needs picks in the race storage record or session identity).
- **Minor lobby wrinkle (unlogged, verified in code):** on any lobby
  reconnect, `onConnected` re-ships `sendReady(false, …)` unconditionally
  (mp-lobby.ts:235-238) while `local.ready` may still be `true` — the READY
  button then shows ready while the shipped state is not, requiring a double
  toggle to actually re-ready.

## Top 10 fixes & improvements (ranked)

1. **Widen the snapshot position range before a Reef Cup map outgrows ±327.67 m.**
   The int16×0.01 m format silently clamps in production — remote bikes pin to
   the world boundary — and the encoder's own comment names Mexico City and
   Cape Town as maps that "can exceed this", guarded only by a dev-console
   warning (transform-snapshot.ts:113-131). The proof-of-thesis maps are being
   dressed right now, so this is a fuse already lit. Bump the record to int32
   positions (or per-track origin+scale in the reserved header bytes) behind a
   new tag byte. Player impact: without it, the first oversized dressed track
   makes every remote rider teleport to a far corner and stay there — total
   multiplayer breakage that only manifests in prod on specific tracks.

2. **Decide the multiplayer combat story now: sync items (M10.13) or disable them in rooms.**
   Pickups and weapons are per-tab fiction — a missile hit on a remote
   player's kinematic mirror applies a local `setLinvel` that kinematic bodies
   ignore and the owner never learns about (combat.ts:70; zero net references
   in pickup.ts). The retained InputFrame channel is the designed seam for
   owner-authoritative combat events. Until it lands, gate the pickup spawner
   off when `roomId` is set. Player impact: today "I hit him and nothing
   happened" is the first thing any two humans with items will experience —
   an honesty fix (no items in MP) is one day; the real fix is the single
   biggest outstanding multiplayer feature.

3. **Put finish/lap claims on the wire — stop letting photo finishes disagree.**
   Race state is per-tab, and each tab sees remote bikes ~100 ms + RTT/2 late
   (≈4–7 m at speed), so in any close finish both players can see themselves
   winning, permanently, and cup points diverge (m10-11 §7 decision; no finish
   message exists — the snapshot `flags` byte is reserved-unused). Broadcast
   owner-authoritative lap/finish events (flags bit + a tiny control message)
   and settle standings from owner claims, host tiebreak. Player impact: the
   result screen — the emotional payoff of a race — becomes trustworthy; today
   a 200 ms-RTT close race can literally crown two winners.

4. **Interpolate on the sender-tick timeline with a real jitter buffer and adaptive delay.**
   `remote-interp.ts` keys on packet arrival time with a 2-sample buffer and a
   fixed 100 ms delay; a TCP retransmit stall freezes bikes within ~125 ms
   (the clamp allows only ~25 ms of coast past the newest sample), and the
   burst then arrives with `receivedAt` values microseconds apart, collapsing
   `span → 0` so the pose snaps to newest, discarding the burst's timeline —
   while the header's `tick` field goes unused (finding #14, acknowledged). Keep a 4–8 sample ring indexed by sender tick mapped
   through a smoothed offset, and derive the delay from observed jitter.
   Player impact: on ordinary Wi-Fi / 200 ms connections remote riders go from
   stutter-freeze-teleport to smoothly lagged — the difference between
   "playable with a distant friend" and not.

5. **Fix the stale README claim and give the relay lifecycle a CI-tier test.**
   README Known Issues still says "a two-tab Playwright probe is not yet
   automated" (README:189) — false since 2026-06-09 — so contributors are
   told the safety net doesn't exist; and the real spec never runs in CI (e2e
   job skips without the never-set R2 secret, GPU-less runners fail anyway,
   ci.yml:71-135). Correct the README, document "run
   `E2E_PORT=<N> pnpm e2e m10-11-state-sync` headed for any net change", and
   extract the GPU-free relay behaviors (lock, grace, barrier, recycle) into a
   raw-WebSocket integration suite against a `partykit dev` sidecar that runs
   in `check-and-build`. Player impact: indirect but decisive — the P0 class
   that once froze host tabs currently has no automated tripwire between
   manual playtests.

6. **Time-box the lobby connect and say what's wrong.**
   With the relay down (or `pnpm party:dev` not running in dev), the lobby
   shows "CONNECTING TO THE BROADCAST…" forever while partysocket retries
   silently (lobby-overlay.ts:284-287; no timeout exists on the lobby path —
   the race path has a 15 s failsafe). After ~10 s, flip the banner to
   "CAN'T REACH THE RELAY — check your connection / Esc for menu" (dev builds:
   name `pnpm party:dev`), keep retrying underneath. Player impact: a friend
   clicking a shared room link during an outage currently gets an infinite
   spinner with no explanation and no visible way out — the worst possible
   first multiplayer impression.

7. **Carry lobby picks across the lobby→race handoff.**
   `peerPicks` live in relay instance memory and are wiped by the recycle the
   race record survives, so in every real cohort race remote bikes fall back
   to the default variant (multiplayer-review.md verification log, still open;
   spawnRemoteBike's fallback at multiplayer.ts:177-178). Persist the pick map
   into the `RaceRecord` at `start-race` and replay it in race-session hellos.
   Player impact: your friend's chosen bike and colors are visibly wrong for
   the entire race — a small thing that reads as "multiplayer is half-baked"
   every single session.

8. **Cap binary payload size and per-connection message rate at the relay; validate `start-race.trackId`.**
   The relay rebroadcasts any binary frame of any size ×7 with no cap
   (relay.ts:242-245) — an accepted DoS posture (SECURITY.md §Out-of-scope)
   whose fix is ~10 lines (drop frames > ~1 KB; drop senders exceeding
   ~60 msg/s), and `parseClientControl` accepts a non-string `trackId`
   (relay.ts:86) that would be stored and replayed to every joiner. Player
   impact: room ids are guessable, so one griefer with a 20-line script can
   currently lag or kill every session in a public room; the cap makes that
   attack cost more than it yields.

9. **Make the leaderboard signature language-neutral (canonical v2 with integer `bestLapMs`).**
   The HMAC canonical string formats `bestLap` via JS `Number.toString()`, so
   any non-JS client naturally signs `"40.0"` where JS signs `"40"` and gets
   `401 bad-signature` pointing at the wrong culprit (protocol.ts:39-51;
   README:190 — "bit us while probing from Python"; the ops doc ships a
   workaround `js_num` shim). Add a versioned payload carrying lap time in
   integer milliseconds; accept both during a deprecation window. Player
   impact: unlocks community tooling — Discord bots, speedrun verifiers,
   alternative clients — that today burns an hour each on a documented trap,
   and removes a whole class of "board silently rejects my time" reports.

10. **Spend the RTT you already measure on start fairness.**
    `race-go` skew between peers equals one-way relay latency by design
    (protocol.ts:133-141), so a 150 ms-RTT player begins every race ~75 ms
    behind a 20 ms one — with per-tab standings there is no later correction.
    The 1 Hz EWMA RTT is already at hand: schedule each peer's 3-2-1 at
    `receipt + HOLD − RTT/2` (relay stamps a hold; clients subtract their
    half-RTT), which needs no real clock sync. Player impact: at 28 m/s,
    75 ms is two bike lengths gifted to the low-ping player at every single
    start — the kind of systematic unfairness high-ping players feel but can't
    name, fixed with arithmetic the HUD ping chip is already doing.
