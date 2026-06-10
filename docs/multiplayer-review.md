# Multiplayer code review — 2026-06-09

> **Status: living document.** Findings from a full read of the netcode stack
> (`src/engine/net/*`, `party/relay.ts`, `src/boot/multiplayer.ts`,
> `src/engine/menus/mp-lobby.ts`, `src/game/systems/apply-snapshot.ts` /
> `remote-interp.ts`, the game-loop wiring, and the net unit tests), checked
> against the design intent in [m10-11-state-sync.md](./m10-11-state-sync.md).
> The improvement plan at the bottom is updated in place as items land.

## Verdict

The architecture is sound and unusually well documented: stateless relay,
owner-authoritative 20 Hz transform snapshots, host-elected AI, snapshot
interpolation at the sim layer, render interpolation on top. The codecs are
tight, allocation-conscious, and unit-tested. **But one regression currently
breaks multiplayer outright** (the snapshot send buffer was sized for 4 AI and
the grid is now 7), and a handful of lifecycle edges — lobby race start,
reconnect, mid-race host takeover — have real bugs that will bite the moment
two humans use this for more than a happy-path session. A focused improvement
pass is warranted; it is mostly small, surgical changes.

## What's done well (keep doing this)

- **Layering.** Codecs (`input-frame.ts`, `transform-snapshot.ts`) are pure and
  round-trip tested; the relay is genuinely format-agnostic (binary passthrough,
  slot-stamped JSON control); sim stays Three-free; remote smoothing is split
  correctly between sim-layer snapshot interp (`remote-interp.ts`) and the
  render-side fixed-timestep interpolation. Swapping the transport later won't
  touch game code.
- **Wire format discipline.** 1-byte tag dispatch, documented quantization with
  rationale, quaternion renormalize on decode, reserved bytes for forward
  compat, little-endian throughout. Bandwidth budget worked out in the doc.
- **Hot-path hygiene.** Reused send buffers, scratch snapshot literal, no
  per-tick allocations in the broadcast pump; last-write-wins intent buffer.
- **Defensive filters.** Self-echo drops on both binary paths, server-side slot
  stamping so control messages can't spoof peers, unknown-tag warn-and-drop.
- **Lifecycle awareness.** OOB system opts out in multiplayer; pause doesn't
  gate the sim in a room; determinism harness preserved via `runAI ?? true`;
  ready/picks replayed to late joiners in `hello`; render despawn frees
  instanced slots correctly.
- **Docs.** `m10-11-state-sync.md` is a model design doc (options considered,
  risks table, playtest watchlist). This review found drift, but only because
  the doc was precise enough to diff against.

## Findings

| # | Sev | Finding | Where |
|---|-----|---------|-------|
| 1 | **P0** | Host snapshot buffer sized for 4 AI; grid is now 7 → `DataView` RangeError in the sim loop → **host tab freezes the moment a second player joins** (rAF chain dies; `requestAnimationFrame(frame)` is at the end of `frame()`) | [multiplayer.ts:50](../src/boot/multiplayer.ts), [spawn-bikes.ts:29](../src/boot/spawn-bikes.ts), [game-loop.ts:1994](../src/boot/game-loop.ts) |
| 2 | **P1** | Lobby race-start split-brain: track pick is per-client `Math.random`, and a peer **arms with its own pick before processing the other peer's `start-race`** (the `ready` and `start-race` messages arrive back-to-back; `tryStartRace` runs synchronously in the `ready` handler). Two peers in one room can navigate to **different tracks** whenever votes differ. The server's sticky `raceTrackId` doesn't save us: it excludes the sender from the rebroadcast, and receivers ignore it once `raceArmed` | [mp-lobby.ts:172-192](../src/engine/menus/mp-lobby.ts), [lobby-overlay.ts:337](../src/engine/render/lobby-overlay.ts), [relay.ts:144-155](../party/relay.ts) |
| 3 | **P1** | Reconnect spawns duplicate remote bikes: `onConnected` fires again after a partysocket auto-reconnect and `spawnRemoteBike` has no existence check; old kinematic, `Racer`-tagged bikes are orphaned (overwritten in `remoteEids`), freeze on track, and pollute standings forever | [multiplayer.ts:300-315](../src/boot/multiplayer.ts) |
| 4 | **P1** | Player loses control during a disconnect: on socket close `myPeerId` → −1, the loop stamps frames with `LOCAL_PEER_ID = 0`, but the player bike's `PeerControlled.peerId` still holds the old slot → `applyPeerInputs` feeds it `emptyIntent()` until reconnect. No disconnect callback exists for the boot layer to react | [room.ts:232-245](../src/engine/net/room.ts), [game-loop.ts:1074](../src/boot/game-loop.ts), [input-apply.ts:89](../src/game/systems/input-apply.ts) |
| 5 | **P1** | Mid-race joiner can seize AI hostship and teleport the AI field to spawn: slots recycle lowest-free, so if slot 0 ever left, the next joiner gets slot 0 and instantly wins lowest-slot election — with its AI bikes sitting at the start line. (Promotion on host *leave* is fine: survivors' kinematic AI poses are current.) Needs tenure-based election (relay join counter), not slot-based | [host-election.ts:15](../src/engine/net/host-election.ts), [slot-assign.ts:17](../src/engine/net/slot-assign.ts), [relay.ts:80-110](../party/relay.ts) |
| 6 | P2 | No AI-authority filter on receive: any peer's `bikeKind=1` records are applied on non-hosts. During handoff windows two hosts can broadcast simultaneously (flicker between divergent AI states); also trivially spoofable | [multiplayer.ts:265-298](../src/boot/multiplayer.ts) |
| 7 | P2 | No sender-ownership check on player records: a peer can broadcast `bikeKind=0` records with another peer's `ownerPeerId` and drive that bike on everyone's screen. One-line filter (`ownerPeerId === senderPeerId`) | [multiplayer.ts:236-246](../src/boot/multiplayer.ts) |
| 8 | P2 | 60 Hz InputFrame broadcast is dead traffic since M10.11: remote bikes no longer carry `PeerControlled`, so relayed intents drive nothing. ~3.4k relayed msgs/s in an 8-peer room vs ~160 for snapshots — pure relay load + per-message overhead for zero gameplay effect (only a debug probe reads them) | [game-loop.ts:1081](../src/boot/game-loop.ts), [m10-11-state-sync.md §5c](./m10-11-state-sync.md) |
| 9 | P2 | After an explicit `NetRoom.close()` the async socket `close` event re-publishes mp-status as `connecting`/`reconnecting`, overwriting `closed` — Settings → Network can show "connecting" forever | [room.ts:232-245,448-455](../src/engine/net/room.ts) |
| 10 | P2 | The §11 race-system mitigation ("update `prevSigned` when a snapshot jump > 5 m") was never implemented — a snapshot catch-up sweep across a gate plane can falsely score a checkpoint for a remote bike (per-tab standings only, converges, but visible) | [race.ts:60-65](../src/game/systems/race.ts), [m10-11-state-sync.md §11](./m10-11-state-sync.md) |
| 11 | P3 | `remote-interp.ts` (slerp, extrapolation clamp, buffer slide, lifecycle) has no unit tests — the only net-adjacent module without them | [remote-interp.ts](../src/game/systems/remote-interp.ts) |
| 12 | P3 | Comment/doc drift: `MAX_EXTRAPOLATE_T` comment says "0.5" for a 1.5 constant; `LATENCY_STALE_MS` comment says 4× cadence but is 6×; `MAX_SNAPSHOT_BIKES` says "four AI"; design doc still says `NUM_AI = 4` and bandwidth math assumes 4 AI | [remote-interp.ts:32-36](../src/game/systems/remote-interp.ts), [latency.ts:22-26](../src/engine/net/latency.ts) |
| 13 | P3 | Two-tab e2e still deferred (acknowledged in status.md). Everything cross-tab is manual; the P0 above is exactly the class of regression it would have caught | [status.md "Multiplayer e2e coverage"](./status.md) |
| 14 | — | Accepted/known: relay has no payload validation or size cap (SECURITY.md §9 accepted posture); per-tab race state; no combat sync (M10.13); fixed 100 ms interp delay (adaptive delay is a future nicety); `tick` field unused by the interpolator (wall-clock playback) | — |

### Notes on #2 (worth the detail, it's subtle)

Sequence with peers A and B, both voting different tracks: A toggles the last
ready → A's `tryStartRace` arms locally with `pickRandomTrack(votes)` (its own
`Math.random`) and sends `start-race(X)`. B receives A's `ready` first,
synchronously runs `tryStartRace` → arms with **its own** random pick Y and
sends `start-race(Y)`. Both ignore the other's `start-race` (`raceArmed`
guard). Server keeps X (first wins) but never tells B (sender excluded, and B
wouldn't listen). A loads track X, B loads track Y, same room → permanent
cross-track "ghost" desync. Fix is two independent layers: make the pick
deterministic (seeded by room id + sorted votes, so all peers compute the same
winner regardless of message order), and let a server `start-race` carrying a
different `trackId` override a locally-armed pick during the 1.4 s banner
window.

## Improvement plan

Phased so each lands independently with local verification
(`pnpm typecheck` / `test` / `lint` / `build`). Checked off as implemented.

### Phase 1 — P0 crash

- [x] **1.1** Size the snapshot send buffer from the live roster
  (`1 + aiEids.length`) instead of the stale `MAX_SNAPSHOT_BIKES` constant;
  fix the stale comment. Sizing from the actual roster kills the
  drifting-constant class of bug, not just this instance.

### Phase 2 — lobby start integrity (#2)

- [x] **2.1** New pure module `src/engine/menus/lobby-pick.ts`:
  FNV-1a string hash + deterministic track pick over `(peerId, trackId)` votes
  sorted by slot, seeded with `roomId` — every peer computes the same winner.
  Unit tests: order-independence, seed sensitivity, empty/partial votes.
- [x] **2.2** `mp-lobby.ts`: use the deterministic pick; restructure arming so
  the navigated-to track lives in one place (`armedTrackId`) and a server
  `start-race` with a different track **overrides** it before the navigation
  timer fires (banner re-renders). Removes the split-brain even against an
  old relay.

### Phase 3 — disconnect/reconnect lifecycle (#3, #4, #9)

- [ ] **3.1** `room.ts`: new `onDisconnected` config callback (fires only when
  a previously-established session drops, not on first-connect retries);
  explicit-close flag so `close()` publishes `closed` and suppresses both the
  callback and the bogus `connecting` re-publish.
- [ ] **3.2** `multiplayer.ts`: on `onDisconnected` — despawn all remote bikes
  (kills zombies + makes reconnect re-spawn clean), restamp the local bike's
  `PeerControlled` to `LOCAL_PEER_ID` (input keeps flowing solo), and
  `applyHostRole(true)` (AI resumes locally from current poses — graceful solo
  degradation mid-gap). `onConnected` already re-stamps slot + re-spawns from
  `hello`, so reconnect converges.

### Phase 4 — host-election tenure (#5) + snapshot authority (#6, #7)

- [ ] **4.1** `relay.ts` + `protocol.ts`: per-connection monotonic `joinSeq`
  (room-instance counter), carried in `hello` (self + per-peer map) and
  `peer-joined`. Optional fields — old clients ignore them; new clients fall
  back to slot election when absent (old relay), so deploy order is safe.
- [ ] **4.2** `host-election.ts`: seat-based election (`lowest joinSeq wins,
  tie → lowest slot, missing seqs → slot order`), keeping `isHostFor` for the
  no-seq fallback. `room.ts` tracks seats; `multiplayer.ts` + mp-status use
  them. Unit tests for seq priority / tie / fallback / mixed.
- [ ] **4.3** `multiplayer.ts` receive filters: drop `bikeKind=0` records whose
  `ownerPeerId ≠ senderPeerId`; drop `bikeKind=1` records from any sender that
  isn't the locally-computed AI authority.
- [ ] **4.4** Note in the doc + status.md: relay change requires
  `pnpm party:deploy` to take effect in prod (client is fallback-safe either
  way).

### Phase 5 — wire efficiency (#8)

- [ ] **5.1** Stop broadcasting InputFrames (keep the codec, the local
  encode→decode feel-parity round-trip, and the receive path for
  cross-version tolerance). Comment explains M10.13 will reintroduce intent
  traffic deliberately as events.

### Phase 6 — race-state guard (#10)

- [ ] **6.1** `race.ts`: per-eid previous-position memory; a > 5 m per-tick
  jump updates `prevSigned` without testing the crossing (teleport ≠ gate
  cross). Also covers OOB/respawn warps in single-player. Unit-tested.

### Phase 7 — tests + drift (#11, #12, #13)

- [ ] **7.1** `tests/unit/remote-interp.test.ts`: buffer seed/slide, interp
  midpoint, extrapolation clamp at `MAX_EXTRAPOLATE_T`, dynamic-body skip,
  clear/reset lifecycle, shortest-arc slerp (q vs −q).
- [ ] **7.2** Fix comment drift (`MAX_EXTRAPOLATE_T`, `LATENCY_STALE_MS`);
  add a dated revision note to `m10-11-state-sync.md` (NUM_AI=7 bandwidth,
  input-frame send removal, tenure election); status.md entry pointing here.
- [ ] **7.3** *(deferred, unchanged)* Two-tab Playwright spec — needs a
  `partykit dev` sidecar in the e2e harness; tracked in status.md as before.
  This review re-affirms it's the right next investment after this pass.

## Verification log

- 2026-06-09 — Phases 1–2: `pnpm typecheck` clean; `lobby-pick.test.ts`
  9/9 green. (`pickRandomTrack` removed from lobby-overlay; logic now lives
  in `lobby-pick.ts`.)
