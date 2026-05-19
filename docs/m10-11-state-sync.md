# M10.11 — Multiplayer state sync (host-elected AI + transform snapshots)

> **Status: shipped.** Retained as the design rationale for the live
> system. The runtime references it from `party/relay.ts`,
> `src/engine/net/host-election.ts`, `src/game/systems/apply-snapshot.ts`,
> `src/boot/multiplayer.ts`, and `SECURITY.md` (§9 — the accepted
> stateless-relay DoS posture). For the live state of multiplayer (RTT
> telemetry, lobby, reconnect labelling) see [`status.md`](./status.md).

Prereq: M10.10.1 (commit 5f2191b — local bike's `PeerControlled.peerId` patched in `onConnected`).

## 1. Problem & goal

What works today (M10.4–M10.10):

- PartyKit relay at `party/relay.ts:38` is a stateless 1-WS-per-peer broadcaster.
- 60 Hz binary `InputFrame` (10 bytes, see `src/engine/net/input-frame.ts:11-19`) flows peer → relay → other peers.
- Each tab runs a complete sim: physics, AI (`aiControlSystem`), wave field, race system, standings.
- Remote-peer bikes are spawned with `PeerControlled { peerId }` (`src/main.ts:364`) and driven by `applyPeerInputs` feeding the peer's last-known `Intent` into the local sim via `applyPeerInputs` (`src/game/systems/input-apply.ts:34`).
- AI bikes (`NUM_AI = 4`) spawn locally in every tab via `src/boot/spawn-bikes.ts:101`.

What doesn't work:

- **AI divergence.** Each tab simulates AI independently at its own rAF cadence. Floating-point math is deterministic per fixed step, but the number of fixed steps each tab manages to fit per real-time second varies with frame rate, GC pauses, etc. Within ~3 s the AI bikes are visibly in different places on different tabs.
- **Remote player drift.** A remote peer's bike is driven entirely by replaying the last-received `Intent`. If frames are missed, packets reordered, or the local sim falls a few ticks behind the broadcaster, the receiver's simulated bike diverges from the source-of-truth bike on the owner's tab. Observed in playtest: tab 1's player at z=+103, tab 2's view of it stuck at spawn.

**Goal**: every peer sees the same world — same AI positions, same remote player positions — without changes to the single-player code path and without changing the server contract (`party/relay.ts` stays a stateless broadcaster).

## 2. Decision — hybrid (b) + (a-lite) + per-bike owner broadcast

Chosen approach:

1. **Host election** for AI. Lowest-slot connected peer is the AI host. Only the host runs `aiControlSystem`; non-hosts gate it off. The host broadcasts each AI bike's transform at 20 Hz; non-hosts apply the received transforms to kinematic-position rigid bodies.
2. **Per-owner player-bike broadcast.** Every peer also broadcasts its OWN player bike transform at 20 Hz. Remote peers stop input-replaying remote bikes for motion and instead snap to the received transform each time one arrives.
3. **No relay changes.** The new snapshot message rides the same WebSocket; binary messages are dispatched by a 1-byte type tag at byte 0.

Race state stays per-tab — each peer computes standings from the synced transforms it sees.

### Why not (c) server-authoritative sim

- Rapier physics in PartyKit means bundling Rapier WASM into the worker, building a sim entry without Three.js, and recreating waveField + track loading there. Several days of work, plus we lose the "single sim runs in the browser" property that the determinism harness depends on.
- The stated preference is to keep the server stateless.

### Why not pure (a) late-joiner snapshot only

- A one-shot snapshot fixes the "I joined and the bikes are at spawn" problem but does nothing for AI divergence — the next 60 s still has 4 independent AI sims. We need ongoing sync.

### Why per-owner broadcast for player bikes (not also through the host)

- Latency: player → host → broadcast → me adds a hop. Player → broadcast → me is one hop.
- The owner is the source of truth for their own bike's physics. We don't want the host overwriting the owner's local pose with a stale value.
- Symmetric: every client has exactly one bike it broadcasts (its own player). If it's also the AI host it additionally broadcasts the AI bikes. No special-case "if I'm host I broadcast everyone."

## 3. Wire format — `TransformSnapshot`

Two binary message types now share the WebSocket. We tag with byte 0:

```
0x01 = InputFrame  (existing, payload shifted by +1 to make room for tag)
0x02 = TransformSnapshot
```

### 3a. Existing InputFrame — wrapping change

The current `InputFrame` is 10 bytes with `tick` at offset 0. We prepend a `0x01` tag byte:

- New wire size: `INPUT_FRAME_WIRE_BYTES = 11`. Payload offset is now 1.
- Existing constant stays: `INPUT_FRAME_BYTES = 10` (the payload portion, unchanged).
- `encodeInputFrameInto(view, offset, frame)` writes `0x01` at `offset+0`, then the existing fields at `offset+1..+10`.
- `decodeInputFrameFrom(view, offset)` reads `offset+0`, asserts `0x01`, then decodes the existing fields from `offset+1`.

Local-only wire break — no observable behavior change. The party server is a dumb relay.

### 3b. TransformSnapshot record layout

One snapshot carries N bikes from a single broadcaster. Variable-length header + repeated bike records:

```
header (8 bytes):
  offset | bytes | field
  -------+-------+-------------------------------------------
    0    |   1   | tag = 0x02
    1    |   1   | senderPeerId   uint8
    2    |   2   | reserved       uint16 LE (0)
    4    |   4   | tick           uint32 LE (sender's simTick at capture)

bike record (24 bytes, repeated):
  offset | bytes | field
  -------+-------+-------------------------------------------
    0    |   1   | ownerPeerId    uint8     // peer that owns this bike
    1    |   1   | bikeKind       uint8     // 0 = player, 1 = AI
    2    |   1   | bikeIndex      uint8     // for AI: 0..NUM_AI-1; for player: 0
    3    |   1   | flags          uint8     // reserved (future: finished, etc.)
    4    |   6   | position       int16×3   // meters × 100, clamped ±327.67m
   10    |   8   | rotation       int16×4   // quaternion × 32767 (signed)
   18    |   6   | velocity       int16×3   // m/s × 256, clamped ±127.99
```

Total: `8 + 24 × N` bytes per snapshot.

**Quantization rationale**:

- Position: int16 × 0.01 m → 1 cm steps over a ±327.67 m world. Lagoon and Cliffside both fit inside ±150 m. Plenty of headroom.
- Rotation: int16 × 1/32767 per quat component. ~3·10⁻⁵ rad worst case, way below visual threshold. Receivers renormalize after decode to recover unit norm.
- Velocity: int16 / 256 → ~4 mm/s steps, ±127.99 m/s. Top speed is ~28 m/s so we never saturate. Included so receivers can blend / extrapolate between snapshots without a first-difference compute, and so chase-cam smoothing has a real velocity for remote bikes.

### 3c. Who broadcasts what

| Broadcaster | Records included | Cadence |
|---|---|---|
| Every peer | their own player bike (`bikeKind=0, bikeIndex=0`) | 20 Hz |
| AI host (lowest slot only) | all NUM_AI bikes (`bikeKind=1, bikeIndex=0..N-1`) | 20 Hz |

For simplicity, the AI host combines its own player + the AI bikes into one 5-bike snapshot per tick (128 bytes); non-hosts send 1-bike snapshots (32 bytes).

### 3d. Bandwidth budget (worst case: 8-peer room with one AI host)

- Each non-host peer egress: 32 B × 20 Hz = 640 B/s.
- AI host egress: 128 B × 20 Hz = 2.56 KB/s.
- Per-peer ingress: 7 × 32 B × 20 Hz + 1 × 128 B × 20 Hz ≈ 7 KB/s, plus InputFrames ~5 KB/s. Total ~12 KB/s.

Well under any reasonable WS budget.

### 3e. Single-player and single-peer rooms

A solo peer in a room (or single-player with no room) sends no snapshots — there's no audience. The send is gated on `net?.ready && net.remotePeers.length > 0`.

## 4. Host election

### Rule

The AI host is the connected peer with the **lowest slot id**, including ourselves. Computed locally each time the peer set changes. Slot 0 is host whenever it's present; if slot 0 leaves, slot 1 becomes host; and so on. This works because:

- Every peer sees the same connected-slot set (the relay tells everyone about joins/leaves).
- `assignLowestFreeSlot` (`src/engine/net/slot-assign.ts:17`) makes recycled slots dense.
- No tie-breakers needed.

### Where election happens

A small pure helper at `src/engine/net/host-election.ts`:

```ts
export function isHostFor(myPeerId: number, remotePeers: readonly number[]): boolean {
  if (myPeerId < 0) return true // not in a room: always "host" (single-player)
  for (const p of remotePeers) if (p < myPeerId) return false
  return true
}
```

Called from `main.ts` whenever `net.remotePeers` changes (in the `onConnected`, `onPeerJoined`, `onPeerLeft` callbacks) and during sim setup. The result drives `applyHostRole(...)` which flips AI bike body types + AITag.

### Edge cases

- **Boot before connect**: `net == null` or `net.ready === false` → treat as host. Single-player path is preserved.
- **AI host leaves mid-race**: the next-lowest peer's `isHostFor` flips to true on `onPeerLeft`. They immediately flip AI bikes back to dynamic + add AITag/AIController. There's a ~50 ms window where the kinematic body just coasts; acceptable for v1.
- **Host promotion mid-race**: re-derive AI state via `defaultAIController(splineId)` — the closest-point search re-acquires in <1 tick.

## 5. Owner-side broadcast & receiver-side apply

### 5a. Owner-side broadcast

`src/main.ts`, inside the fixed-step loop right after `simulateStep`:

```ts
const SNAPSHOT_HZ = 20
const SNAPSHOT_TICKS = Math.round(60 / SNAPSHOT_HZ) // 3
if (simTick % SNAPSHOT_TICKS === 0 && net?.ready && net.remotePeers.length > 0) {
  const iAmHost = isHostFor(net.peerId, net.remotePeers)
  const records = iAmHost ? [playerEid, ...aiEids] : [playerEid]
  // build + send snapshot
}
```

The build helper reads each bike's `RBHandle`, fetches the Rapier rigid body, reads `translation()` / `rotation()` / `linvel()`, quantizes, writes via the new codec.

### 5b. Receiver-side apply: kinematic for AI, set-directly for remote players

On snapshot arrival:

- **AI bikes on non-host**: bodies are `KinematicPositionBased`. Apply via `rb.setNextKinematicTranslation` + `rb.setNextKinematicRotation`. Kinematic bodies skip gravity / hover; physics doesn't touch them.
- **Remote player bikes**: bodies are also `KinematicPositionBased`. Same applies — set kinematic next-pose. The local human's bike stays Dynamic (owner of canonical pose).

Body-type transitions happen at:

1. Spawn — `spawnRemoteBike` creates the body Dynamic, then `applyHostRole` after net connect flips it Kinematic. AI bikes in `spawnBikes` stay Dynamic; `applyHostRole` flips them Kinematic on non-host tabs.
2. Host changeover — `applyHostRole(iAmHost)` flips all AI bikes appropriately.

The flips happen between fixed steps, not inside `simulateStep` — safer for Rapier.

### 5c. Dropping input-replay for remote bikes

`spawnRemoteBike` (`src/main.ts:364`) currently adds `PeerControlled`. We **stop adding it**. Only the local player bike carries `PeerControlled`. Consequences:

- `applyPeerInputs` (`src/game/systems/input-apply.ts:34`) queries `[PeerControlled, ControlIntent]` — naturally skips remote bikes.
- Remote bikes are pose-driven (kinematic) rather than input-driven.
- The local human's bike keeps `PeerControlled { peerId: myPeerId }` for `applyPeerInputs` to drive it.

M10.10.1's peerId patch in `onConnected` stays — now it's the only `PeerControlled` write site after spawn.

### 5d. NetRoom API additions

`src/engine/net/room.ts`:

```ts
sendBinary(buf: Uint8Array): void                              // raw snapshot send
onSnapshot?: (snapshot: TransformSnapshot) => void             // new config callback
```

Receive dispatch on byte 0:

```ts
if (data instanceof ArrayBuffer) {
  const view = new DataView(data)
  const tag = view.getUint8(0)
  if (tag === 0x01) {
    const frame = decodeInputFrameFrom(view, 0)
    // existing path
  } else if (tag === 0x02) {
    const snap = decodeTransformSnapshotFrom(view, 0, data.byteLength)
    cfg.onSnapshot?.(snap)
  }
}
```

`sendFrame` continues to take a `frame: InputFrame` and prefixes the tag internally. Callers don't change.

## 6. AI gating on non-host tabs

`simulateStep` (`src/game/sim-step.ts`) calls `aiControlSystem`, `aiCombatSystem`, `rubberBandSystem` — all gate on `AITag` in their queries. Removing `AITag` from AI bikes on non-host gates the **whole AI pipeline** at the query level, no system code changes needed.

We add a `runAI` boolean to `StepInputs` for safety and clarity (some systems may grow non-tag dependencies later):

```ts
export type StepInputs = {
  peerInputs: ReadonlyMap<number, Intent>
  locked: boolean
  autoPlay: boolean
  waveTimeScale: number
  /** Run aiControlSystem (and friends) this tick. Default true.
   *  Set false on non-host multiplayer peers. */
  runAI?: boolean
}
```

In `simulateStep`: `if (!inputs.locked && (inputs.runAI ?? true)) aiControlSystem(...)` (and similarly for ai-combat / rubber-band).

### Hover system early-out for kinematic bodies

`hoverSystem` calls `rb.setRotation()` (line 321) and `rb.setAngvel()` (line 342) — surface-alignment correction. On a kinematic body those writes would either no-op or fight our `setNextKinematicTranslation`. We add a per-bike early-out:

```ts
const rb = phys.world.getRigidBody(handle.handle)
if (!rb) continue
if (rb.bodyType() !== phys.rapier.RigidBodyType.Dynamic) continue
// ...existing hover logic
```

Same early-out anywhere else we read+write a rigid body that might be kinematic.

### applyHostRole helper

Lives in `main.ts` (close to its callers):

```ts
function applyHostRole(iAmHost: boolean): void {
  // For each AI bike eid:
  //  - host: ensure AITag is attached + body is Dynamic
  //  - non-host: ensure AITag detached + body is KinematicPositionBased
  // For each remote-peer bike eid: ensure body is KinematicPositionBased.
  // The local player's own bike: always Dynamic, always PeerControlled.
}
```

Invoked from `onConnected`, `onPeerJoined`, `onPeerLeft`.

## 7. Race state — leave it per-tab

The race system tracks checkpoint crossings via signed distance to gate planes (`src/game/systems/race.ts`), keyed by `prevSigned` per eid. It reads `rb.translation()` each tick.

Once transforms are synced via 20 Hz snapshots, both peers see roughly the same `rb.translation()` for every bike. Standings can momentarily disagree (latency × velocity ≈ 1.4 m at 50 ms × 28 m/s) but converge.

**Decision: per-tab race state stays.** A future M10.15 can do host-authoritative race state if disagreements bug us.

**Risk**: a 50 ms snapshot gap could look like a teleport across a gate plane, falsely triggering `prevSigned < 0 && signed >= 0`. Mitigation: in `applySnapshot`, if the position jump from previous frame exceeds (e.g.) 5 m, also update the race system's per-eid `prevSigned` cache to the new signed distance, so the false crossing doesn't fire. Tracked in §11.

## 8. Determinism harness compatibility

The Playwright determinism probe calls `simulateStep` directly via `__hover.determinism.run(intents, ticks)` (`src/debug.ts:275`). `?determinism=1` doesn't connect to a room, so:

- `net == null` → no snapshot send, no snapshot receive.
- `isHostFor(-1, [])` → true → `runAI: true` → AI runs as today.

Make `runAI` default to `true` in `simulateStep` (`inputs.runAI ?? true`) so existing call sites stay bit-identical. Harness output unchanged.

## 9. Out of scope (next slices)

- **M10.12** — Render-side smoothing (one-pole filter between snapshot and Three.js mesh).
- **M10.13** — Owner-authoritative combat (fire/hit events).
- **M10.14** — Snapshot interpolation / extrapolation using the velocity field.
- **M10.15** — Host-authoritative race state.
- **M10.16** — Late-joiner snapshot rebroadcast (today they wait <50 ms for the next regular snapshot; this slice formalizes it).
- **Anti-cheat / server validation** — none today; any peer can broadcast arbitrary positions.
- **Lockstep / rollback** — not on the M10.x roadmap.

## 10. Concrete file changes

### New files

- `src/engine/net/host-election.ts` — `isHostFor(myPeerId, remotePeers): boolean`. ~10 lines + tsdoc.
- `src/engine/net/transform-snapshot.ts` — types + codec. ~150 LOC.
- `src/game/systems/apply-snapshot.ts` — `applySnapshot(sim, phys, snapshot, lookup)`. ~60 LOC.
- `tests/unit/transform-snapshot.test.ts` — round-trip, clamping, quantization bounds.
- `tests/unit/host-election.test.ts` — lowest-slot wins, gaps tolerated, empty case.
- `tests/unit/apply-snapshot.test.ts` — sim-side, no Three.js.
- `tests/e2e/m10-11-state-sync.spec.ts` — two-tab convergence test.

### Modified files

- `src/engine/net/input-frame.ts` — bump wire size to 11; tag byte at offset 0. Update tsdoc.
- `src/engine/net/room.ts` — byte-0 dispatch, `sendBinary`, `onSnapshot`.
- `src/main.ts` — snapshot broadcast hook; snapshot receive callback wires to `applySnapshot`; `applyHostRole` toggles body types + `AITag` on host changeover; `spawnRemoteBike` stops adding `PeerControlled`.
- `src/game/sim-step.ts` — `runAI?: boolean` field (default true) gates AI systems.
- `src/game/systems/hover.ts` — early-out for non-Dynamic bodies.
- `src/debug.ts` — extend `netProbe` with `snapshotsReceived(): number` (e2e wait point); harness unaffected.
- `docs/status.md` — add M10.10.1 + M10.11 note.

## 11. Risks & playtest watchlist

| Risk | How it manifests | Mitigation |
|---|---|---|
| Host change races a snapshot the new host hasn't yet sent | 50 ms gap where AI bikes coast | Acceptable for v1. Kinematic body holds its last pose. |
| Snapshot teleport breaks `prevSigned` in race system | False checkpoint cross on snap | Update race-system per-eid cache when snapshot jump > 5 m. |
| Body type flip mid-physics-step | Rapier asserts | Always flip between fixed steps, never inside `simulateStep`. |
| Tag-byte mismatch with old build at prod URL | Old client decodes wrong tag | Acceptable; prod serves a single build. |
| Bike-bike collision (future M10.13) clips through kinematic AI on non-host | Visual clipping | Out of scope here. Note. |
| Race standings show momentary disagreement (~1.4 m × leader velocity) | Position toast briefly different | Acceptable; converges. |

What to look for during playtest:

1. AI bikes in the same place on both tabs (within ~0.5 m).
2. Remote player bike position matches the source-of-truth tab within ~0.5 m at steady state.
3. No console errors when peer 0 closes their tab — peer 1 becomes host smoothly.
4. Lap counts on both tabs agree at the finish line.
5. Local player feels responsive — same as M10.10.1 single-player feel.

## 12. Implementation order

1. New modules: `transform-snapshot.ts` + `host-election.ts` (with unit tests). Pure, no game-state coupling.
2. Tag byte on `input-frame.ts` (with updated round-trip test).
3. `room.ts` dispatch + `sendBinary` + `onSnapshot`.
4. `sim-step.ts` `runAI` field.
5. `apply-snapshot.ts` (with unit test).
6. `hover.ts` kinematic early-out.
7. `main.ts` wiring — `applyHostRole`, snapshot send, snapshot receive, drop `PeerControlled` from remote bikes.
8. `e2e` test.
9. Manual playtest in Chrome (two tabs).
