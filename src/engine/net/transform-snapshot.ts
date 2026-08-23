/**
 * M10.11 — transform snapshot wire format.
 *
 * Binary message types share the WebSocket. Byte 0 is a message tag that the
 * receiver uses to demultiplex. The `InputFrame` payload carries tag `0x01`;
 * this codec defines the `TransformSnapshot` carrying one or more bike poses
 * (position, rotation, velocity) from a single broadcasting peer — tag `0x03`
 * (the current wide-position format) plus decode-only support for the retired
 * tag `0x02` (int16 positions, ±327.67 m — a range the dressed v2 maps
 * outgrow; evaluation networking #1).
 *
 *   header (8 bytes, both tags):
 *     offset | bytes | field
 *     -------+-------+-------------------------------------------
 *       0    |   1   | tag            uint8  = 0x03 (encode) | 0x02 (legacy decode)
 *       1    |   1   | senderPeerId   uint8
 *       2    |   2   | reserved       uint16 LE (0)
 *       4    |   4   | tick           uint32 LE (sender's simTick at capture)
 *
 *   bike record, tag 0x03 (30 bytes, repeated N times):
 *     offset | bytes | field
 *     -------+-------+-------------------------------------------
 *       0    |   1   | ownerPeerId    uint8     // peer that owns this bike
 *       1    |   1   | bikeKind       uint8     // 0 = player, 1 = AI
 *       2    |   1   | bikeIndex      uint8     // for AI: 0..NUM_AI-1; for player: 0
 *       3    |   1   | flags          uint8     // reserved
 *       4    |  12   | position       int32×3   // meters × 100
 *      16    |   8   | rotation       int16×4   // quaternion × 32767 (signed)
 *      24    |   6   | velocity       int16×3   // m/s × 256, clamped ±127.99
 *
 *   bike record, legacy tag 0x02 (24 bytes): same fields with int16×3
 *   position at offset 4 (meters × 100, saturating at ±327.67 m), rotation
 *   at offset 10, velocity at offset 18.
 *
 * Total wire size: `SNAPSHOT_HEADER_BYTES + bikeCount × SNAPSHOT_BIKE_BYTES`
 * (per-tag record size — the count is derived from the byte length, which is
 * why a record-size change REQUIRES a fresh tag).
 *
 * Quantization rationale:
 *
 *  - Position: int32 × 0.01 m → 1 cm steps over ±21,474 km — no shipping
 *    track can saturate it. The retired int16 range fit the ±150 m launch
 *    tracks but silently clamped on larger dressed maps (Mexico City, Cape
 *    Town), pinning remote bikes to the world edge in production with only
 *    a DEV-console warning standing in the way. 6 extra bytes/bike ≈ +25%
 *    snapshot bandwidth on a stream measured in single-digit KB/s.
 *  - Rotation: int16 × 1/32767 per quat component. Worst-case angular
 *    error is well below the visual threshold. Receivers renormalize after
 *    decode so unit-norm is recovered after the per-component round.
 *  - Velocity: int16 / 256 → ~4 mm/s steps, ±127.99 m/s. Top bike speed is
 *    ~28 m/s so we never saturate. Included so receivers can blend /
 *    extrapolate between snapshots without a first-difference compute.
 *
 * Version-skew story: the relay is a format-agnostic passthrough, so no
 * relay change is involved, and the compat is ONE-directional. A current
 * client still decodes inbound 0x02, so it sees a stale tab's bikes
 * normally; the stale tab, running the old build, drops every 0x03 frame
 * through its unknown-tag arm — the new peer's mirror stays frozen at
 * spawn on the stale side until that tab reloads. Acceptable because the
 * skew window is one page reload wide (clients ship together in one
 * bundle) and the failure is visible + self-describing, not a crash.
 *
 * All multi-byte fields are little-endian. The `reserved` header bytes
 * write 0; decoders skip them without assertion for forwards compat. The
 * tag byte is asserted on decode — an unknown tag throws.
 *
 * The codec lives in `engine/net/` alongside `input-frame.ts`: both are
 * transport concerns shared by `room.ts` and the sim's broadcast hook.
 */

/** Message tag for an `InputFrame` payload (see `input-frame.ts`). */
export const MESSAGE_TAG_INPUT_FRAME = 0x01

/** Legacy `TransformSnapshot` tag (int16 positions). Decode-only. */
export const MESSAGE_TAG_TRANSFORM_SNAPSHOT_V1 = 0x02

/** Message tag for a `TransformSnapshot` payload (int32 positions). */
export const MESSAGE_TAG_TRANSFORM_SNAPSHOT = 0x03

/** Fixed snapshot header size. */
export const SNAPSHOT_HEADER_BYTES = 8

/** Fixed per-bike record size (tag 0x03). */
export const SNAPSHOT_BIKE_BYTES = 30

/** Per-bike record size of the retired int16-position format (tag 0x02). */
export const SNAPSHOT_BIKE_BYTES_V1 = 24

/** Bike kind discriminator: 0 = player-controlled, 1 = AI. */
export type SnapshotBikeKind = 0 | 1

export type BikeSnapshotRecord = {
  /** Peer slot that owns this bike. 0..255. */
  ownerPeerId: number
  /** 0 = player bike, 1 = AI bike. */
  bikeKind: SnapshotBikeKind
  /** For AI: AI slot (0..NUM_AI-1). For player bikes: always 0. */
  bikeIndex: number
  /** Reserved flags byte (future: finished, etc.). 0..255. */
  flags: number
  /** World-space position in meters (int32 × 0.01 m on the wire — no
   *  reachable clamp; the retired 0x02 format saturated at ±327.67 m). */
  position: { x: number; y: number; z: number }
  /** World-space orientation as a quaternion. Renormalized after decode. */
  rotation: { x: number; y: number; z: number; w: number }
  /** Linear velocity in m/s. Clamped to ±127.99 m/s. */
  velocity: { x: number; y: number; z: number }
}

export type TransformSnapshot = {
  /** Peer slot that sent this snapshot. 0..255. */
  senderPeerId: number
  /** Sender's simTick at capture. uint32. */
  tick: number
  /** One record per bike included in this snapshot. */
  bikes: BikeSnapshotRecord[]
}

/** Compute the wire size for a snapshot carrying `bikeCount` bike records. */
export function snapshotByteLength(bikeCount: number): number {
  return SNAPSHOT_HEADER_BYTES + bikeCount * SNAPSHOT_BIKE_BYTES
}

/** Clamp `v` into [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

// Quantization scales. Picked so the integer range exactly covers the doc'd
// clamp ranges; rounded values must fit the target width.
const POS_SCALE = 100 // m → centimeters
const POS_MAX = 21_474_836.47 // = 2^31-1 / 100 — unreachable by any real track
const POS_MAX_V1 = 327.67 // = 32767 / 100 (legacy decode only)
const ROT_SCALE = 32767 // quaternion component (already unit-norm)
const VEL_SCALE = 256 // m/s → 1/256 m/s
const VEL_MAX = 127.99 // = 32767 / 256 ≈ 127.996, rounded down for safety

/** Quantize a position component (m) to int32. The clamp is a pure
 *  safety net — ±21,474 km cannot be reached by track geometry, so the
 *  old "remote bikes pin to the world edge" failure mode is gone. */
function encPos(v: number): number {
  return Math.round(clamp(v, -POS_MAX, POS_MAX) * POS_SCALE)
}

/** Quantize a quaternion component to int16. Caller normalizes upstream. */
function encRot(v: number): number {
  return Math.round(clamp(v, -1, 1) * ROT_SCALE)
}

/** Quantize a velocity component (m/s) to int16. */
function encVel(v: number): number {
  return Math.round(clamp(v, -VEL_MAX, VEL_MAX) * VEL_SCALE)
}

/**
 * Encode a snapshot into a fresh buffer of exactly `snapshotByteLength(N)`
 * bytes. Callers in the hot path should use {@link encodeTransformSnapshotInto}
 * with a reusable DataView instead.
 */
export function encodeTransformSnapshot(snapshot: TransformSnapshot): Uint8Array {
  const buf = new Uint8Array(snapshotByteLength(snapshot.bikes.length))
  encodeTransformSnapshotInto(new DataView(buf.buffer), 0, snapshot)
  return buf
}

/**
 * Encode a snapshot into an existing buffer at `offset`. Returns the number
 * of bytes written (`= snapshotByteLength(snapshot.bikes.length)`). No
 * bounds checking — caller is responsible for sizing `view`.
 */
export function encodeTransformSnapshotInto(
  view: DataView,
  offset: number,
  snapshot: TransformSnapshot,
): number {
  const bikeCount = snapshot.bikes.length

  // Header.
  view.setUint8(offset + 0, MESSAGE_TAG_TRANSFORM_SNAPSHOT)
  view.setUint8(offset + 1, snapshot.senderPeerId & 0xff)
  view.setUint16(offset + 2, 0, true) // reserved
  view.setUint32(offset + 4, snapshot.tick >>> 0, true)

  // Records (tag 0x03 layout — int32 positions).
  let p = offset + SNAPSHOT_HEADER_BYTES
  for (let i = 0; i < bikeCount; i++) {
    const r = snapshot.bikes[i]!
    view.setUint8(p + 0, r.ownerPeerId & 0xff)
    view.setUint8(p + 1, r.bikeKind & 0xff)
    view.setUint8(p + 2, r.bikeIndex & 0xff)
    view.setUint8(p + 3, r.flags & 0xff)

    view.setInt32(p + 4, encPos(r.position.x), true)
    view.setInt32(p + 8, encPos(r.position.y), true)
    view.setInt32(p + 12, encPos(r.position.z), true)

    view.setInt16(p + 16, encRot(r.rotation.x), true)
    view.setInt16(p + 18, encRot(r.rotation.y), true)
    view.setInt16(p + 20, encRot(r.rotation.z), true)
    view.setInt16(p + 22, encRot(r.rotation.w), true)

    view.setInt16(p + 24, encVel(r.velocity.x), true)
    view.setInt16(p + 26, encVel(r.velocity.y), true)
    view.setInt16(p + 28, encVel(r.velocity.z), true)

    p += SNAPSHOT_BIKE_BYTES
  }

  return SNAPSHOT_HEADER_BYTES + bikeCount * SNAPSHOT_BIKE_BYTES
}

/**
 * Decode a snapshot from a buffer. Accepts a `Uint8Array` (including a slice
 * with `byteOffset > 0`) or a raw `ArrayBuffer`.
 */
export function decodeTransformSnapshot(src: Uint8Array | ArrayBuffer): TransformSnapshot {
  if (src instanceof Uint8Array) {
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength)
    return decodeTransformSnapshotFrom(view, 0, src.byteLength)
  }
  return decodeTransformSnapshotFrom(new DataView(src), 0, src.byteLength)
}

/**
 * Decode a snapshot from an existing view at `offset`. `byteLength` is the
 * number of payload bytes available starting at `offset`; the bike record
 * count is derived from the per-tag record size. Quaternions are
 * renormalized post-decode to recover unit norm.
 *
 * Accepts tag `0x03` (int32 positions) and the retired `0x02` (int16
 * positions — a stale pre-widening tab in the same room). Any other tag
 * throws.
 */
export function decodeTransformSnapshotFrom(
  view: DataView,
  offset: number,
  byteLength: number,
): TransformSnapshot {
  const tag = view.getUint8(offset + 0)
  const legacy = tag === MESSAGE_TAG_TRANSFORM_SNAPSHOT_V1
  if (!legacy && tag !== MESSAGE_TAG_TRANSFORM_SNAPSHOT) {
    const hex = tag.toString(16).padStart(2, '0')
    throw new Error(`bad tag: expected 0x03 (or legacy 0x02), got 0x${hex}`)
  }

  const senderPeerId = view.getUint8(offset + 1)
  // bytes 2..3 reserved — skip without asserting (forwards compat).
  const tick = view.getUint32(offset + 4, true)

  const recordBytes = legacy ? SNAPSHOT_BIKE_BYTES_V1 : SNAPSHOT_BIKE_BYTES
  // Floor: a truncated/garbled frame whose payload isn't a whole
  // number of records must decode the complete records and drop the
  // tail — a fractional count would run one extra iteration and read
  // past `byteLength`, throwing a RangeError inside the socket's
  // message handler.
  const bikeCount = Math.floor((byteLength - SNAPSHOT_HEADER_BYTES) / recordBytes)
  const bikes: BikeSnapshotRecord[] = []

  let p = offset + SNAPSHOT_HEADER_BYTES
  for (let i = 0; i < bikeCount; i++) {
    const ownerPeerId = view.getUint8(p + 0)
    const bikeKindRaw = view.getUint8(p + 1)
    const bikeIndex = view.getUint8(p + 2)
    const flags = view.getUint8(p + 3)

    let px: number
    let py: number
    let pz: number
    let q = p // cursor for the post-position fields
    if (legacy) {
      px = view.getInt16(p + 4, true) / POS_SCALE
      py = view.getInt16(p + 6, true) / POS_SCALE
      pz = view.getInt16(p + 8, true) / POS_SCALE
      q = p + 10
    } else {
      px = view.getInt32(p + 4, true) / POS_SCALE
      py = view.getInt32(p + 8, true) / POS_SCALE
      pz = view.getInt32(p + 12, true) / POS_SCALE
      q = p + 16
    }

    let rx = view.getInt16(q + 0, true) / ROT_SCALE
    let ry = view.getInt16(q + 2, true) / ROT_SCALE
    let rz = view.getInt16(q + 4, true) / ROT_SCALE
    let rw = view.getInt16(q + 6, true) / ROT_SCALE

    // Renormalize the quaternion: per-component rounding leaves the vector
    // slightly off-unit. Fall back to identity for the degenerate
    // all-zeros case (shouldn't happen but cheap to guard).
    const n = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw)
    if (n > 0) {
      const inv = 1 / n
      rx *= inv
      ry *= inv
      rz *= inv
      rw *= inv
    } else {
      rx = 0
      ry = 0
      rz = 0
      rw = 1
    }

    const vx = view.getInt16(q + 8, true) / VEL_SCALE
    const vy = view.getInt16(q + 10, true) / VEL_SCALE
    const vz = view.getInt16(q + 12, true) / VEL_SCALE

    bikes.push({
      ownerPeerId,
      bikeKind: (bikeKindRaw === 1 ? 1 : 0) as SnapshotBikeKind,
      bikeIndex,
      flags,
      position: { x: px, y: py, z: pz },
      rotation: { x: rx, y: ry, z: rz, w: rw },
      velocity: { x: vx, y: vy, z: vz },
    })

    p += recordBytes
  }

  return { senderPeerId, tick, bikes }
}
