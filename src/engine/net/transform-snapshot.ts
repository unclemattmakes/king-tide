/**
 * M10.11 — transform snapshot wire format.
 *
 * Two binary message types now share the WebSocket. Byte 0 is a message tag
 * that the receiver uses to demultiplex. The existing `InputFrame` payload
 * carries tag `0x01`; this codec defines tag `0x02`, a `TransformSnapshot`
 * carrying one or more bike poses (position, rotation, velocity) from a
 * single broadcasting peer.
 *
 *   header (8 bytes):
 *     offset | bytes | field
 *     -------+-------+-------------------------------------------
 *       0    |   1   | tag            uint8  = 0x02
 *       1    |   1   | senderPeerId   uint8
 *       2    |   2   | reserved       uint16 LE (0)
 *       4    |   4   | tick           uint32 LE (sender's simTick at capture)
 *
 *   bike record (24 bytes, repeated N times):
 *     offset | bytes | field
 *     -------+-------+-------------------------------------------
 *       0    |   1   | ownerPeerId    uint8     // peer that owns this bike
 *       1    |   1   | bikeKind       uint8     // 0 = player, 1 = AI
 *       2    |   1   | bikeIndex      uint8     // for AI: 0..NUM_AI-1; for player: 0
 *       3    |   1   | flags          uint8     // reserved
 *       4    |   6   | position       int16×3   // meters × 100, clamped ±327.67 m
 *      10    |   8   | rotation       int16×4   // quaternion × 32767 (signed)
 *      18    |   6   | velocity       int16×3   // m/s × 256, clamped ±127.99
 *
 * Total wire size: `SNAPSHOT_HEADER_BYTES + bikeCount × SNAPSHOT_BIKE_BYTES`.
 *
 * Quantization rationale:
 *
 *  - Position: int16 × 0.01 m → 1 cm steps over a ±327.67 m world. Both
 *    Lagoon and Cliffside fit inside ±150 m with headroom.
 *  - Rotation: int16 × 1/32767 per quat component. Worst-case angular
 *    error is well below the visual threshold. Receivers renormalize after
 *    decode so unit-norm is recovered after the per-component round.
 *  - Velocity: int16 / 256 → ~4 mm/s steps, ±127.99 m/s. Top bike speed is
 *    ~28 m/s so we never saturate. Included so receivers can blend /
 *    extrapolate between snapshots without a first-difference compute.
 *
 * All multi-byte fields are little-endian. The `reserved` header bytes
 * write 0; decoders skip them without assertion for forwards compat. The
 * tag byte is asserted on decode — a wrong tag throws.
 *
 * The codec lives in `engine/net/` alongside `input-frame.ts`: both are
 * transport concerns shared by `room.ts` and the sim's broadcast hook.
 */

/** Message tag for an `InputFrame` payload (see `input-frame.ts`). */
export const MESSAGE_TAG_INPUT_FRAME = 0x01

/** Message tag for a `TransformSnapshot` payload (this module). */
export const MESSAGE_TAG_TRANSFORM_SNAPSHOT = 0x02

/** Fixed snapshot header size. */
export const SNAPSHOT_HEADER_BYTES = 8

/** Fixed per-bike record size. */
export const SNAPSHOT_BIKE_BYTES = 24

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
  /** World-space position in meters. Clamped to ±327.67 m. */
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
// clamp ranges: int16 covers [-32768, +32767], rounded values must fit.
const POS_SCALE = 100 // m → centimeters
const POS_MAX = 327.67 // = 32767 / 100
const ROT_SCALE = 32767 // quaternion component (already unit-norm)
const VEL_SCALE = 256 // m/s → 1/256 m/s
const VEL_MAX = 127.99 // = 32767 / 256 ≈ 127.996, rounded down for safety

/** Quantize a position component (m) to int16. */
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

  // Records.
  let p = offset + SNAPSHOT_HEADER_BYTES
  for (let i = 0; i < bikeCount; i++) {
    const r = snapshot.bikes[i]!
    view.setUint8(p + 0, r.ownerPeerId & 0xff)
    view.setUint8(p + 1, r.bikeKind & 0xff)
    view.setUint8(p + 2, r.bikeIndex & 0xff)
    view.setUint8(p + 3, r.flags & 0xff)

    view.setInt16(p + 4, encPos(r.position.x), true)
    view.setInt16(p + 6, encPos(r.position.y), true)
    view.setInt16(p + 8, encPos(r.position.z), true)

    view.setInt16(p + 10, encRot(r.rotation.x), true)
    view.setInt16(p + 12, encRot(r.rotation.y), true)
    view.setInt16(p + 14, encRot(r.rotation.z), true)
    view.setInt16(p + 16, encRot(r.rotation.w), true)

    view.setInt16(p + 18, encVel(r.velocity.x), true)
    view.setInt16(p + 20, encVel(r.velocity.y), true)
    view.setInt16(p + 22, encVel(r.velocity.z), true)

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
 * count is derived as `(byteLength - SNAPSHOT_HEADER_BYTES) / SNAPSHOT_BIKE_BYTES`.
 * Quaternions are renormalized post-decode to recover unit norm.
 *
 * Throws if the tag byte at `offset+0` is not `MESSAGE_TAG_TRANSFORM_SNAPSHOT`.
 */
export function decodeTransformSnapshotFrom(
  view: DataView,
  offset: number,
  byteLength: number,
): TransformSnapshot {
  const tag = view.getUint8(offset + 0)
  if (tag !== MESSAGE_TAG_TRANSFORM_SNAPSHOT) {
    const hex = tag.toString(16).padStart(2, '0')
    throw new Error(`bad tag: expected 0x02, got 0x${hex}`)
  }

  const senderPeerId = view.getUint8(offset + 1)
  // bytes 2..3 reserved — skip without asserting (forwards compat).
  const tick = view.getUint32(offset + 4, true)

  const bikeCount = (byteLength - SNAPSHOT_HEADER_BYTES) / SNAPSHOT_BIKE_BYTES
  const bikes: BikeSnapshotRecord[] = []

  let p = offset + SNAPSHOT_HEADER_BYTES
  for (let i = 0; i < bikeCount; i++) {
    const ownerPeerId = view.getUint8(p + 0)
    const bikeKindRaw = view.getUint8(p + 1)
    const bikeIndex = view.getUint8(p + 2)
    const flags = view.getUint8(p + 3)

    const px = view.getInt16(p + 4, true) / POS_SCALE
    const py = view.getInt16(p + 6, true) / POS_SCALE
    const pz = view.getInt16(p + 8, true) / POS_SCALE

    let rx = view.getInt16(p + 10, true) / ROT_SCALE
    let ry = view.getInt16(p + 12, true) / ROT_SCALE
    let rz = view.getInt16(p + 14, true) / ROT_SCALE
    let rw = view.getInt16(p + 16, true) / ROT_SCALE

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

    const vx = view.getInt16(p + 18, true) / VEL_SCALE
    const vy = view.getInt16(p + 20, true) / VEL_SCALE
    const vz = view.getInt16(p + 22, true) / VEL_SCALE

    bikes.push({
      ownerPeerId,
      bikeKind: (bikeKindRaw === 1 ? 1 : 0) as SnapshotBikeKind,
      bikeIndex,
      flags,
      position: { x: px, y: py, z: pz },
      rotation: { x: rx, y: ry, z: rz, w: rw },
      velocity: { x: vx, y: vy, z: vz },
    })

    p += SNAPSHOT_BIKE_BYTES
  }

  return { senderPeerId, tick, bikes }
}
