/**
 * M10.11 — TransformSnapshot wire format round-trip tests.
 *
 * The codec is the contract between an owner-peer's broadcast hook and every
 * other tab's `applySnapshot`. Quantization is lossy by design (int32 cm
 * positions / 1/32767 quat / 1/256 m/s), so the tests assert recovery within
 * the documented tolerances rather than bit-exact equality. Wide-range
 * positions, legacy 0x02 decode, tag-byte mismatch, and post-decode
 * renormalization are pinned because each one is a real failure mode that
 * would corrupt a remote bike's pose silently.
 */
import { describe, expect, it } from 'vitest'
import {
  type BikeSnapshotRecord,
  decodeTransformSnapshot,
  decodeTransformSnapshotFrom,
  encodeTransformSnapshot,
  encodeTransformSnapshotInto,
  MESSAGE_TAG_INPUT_FRAME,
  MESSAGE_TAG_TRANSFORM_SNAPSHOT,
  MESSAGE_TAG_TRANSFORM_SNAPSHOT_V1,
  SNAPSHOT_BIKE_BYTES,
  SNAPSHOT_BIKE_BYTES_V1,
  SNAPSHOT_HEADER_BYTES,
  snapshotByteLength,
  type TransformSnapshot,
} from '../../src/engine/net/transform-snapshot'

/** Tolerances baked into the wire format. See `transform-snapshot.ts` doc. */
const TOL_POSITION_M = 0.01 // 1 cm per component
const TOL_QUAT_COMPONENT = 5e-5 // 1/32767 ≈ 3e-5; pad for renormalize drift
const TOL_VELOCITY_MPS = 0.005 // 5 mm/s per component

function normalizeQuat(q: { x: number; y: number; z: number; w: number }): {
  x: number
  y: number
  z: number
  w: number
} {
  const n = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w)
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n }
}

function expectRecordClose(actual: BikeSnapshotRecord, expected: BikeSnapshotRecord): void {
  expect(actual.ownerPeerId).toBe(expected.ownerPeerId)
  expect(actual.bikeKind).toBe(expected.bikeKind)
  expect(actual.bikeIndex).toBe(expected.bikeIndex)
  expect(actual.flags).toBe(expected.flags)

  expect(Math.abs(actual.position.x - expected.position.x)).toBeLessThanOrEqual(TOL_POSITION_M)
  expect(Math.abs(actual.position.y - expected.position.y)).toBeLessThanOrEqual(TOL_POSITION_M)
  expect(Math.abs(actual.position.z - expected.position.z)).toBeLessThanOrEqual(TOL_POSITION_M)

  // The sender's quaternion is rendered unit-norm before encoding by our
  // expectations; the receiver renormalizes post-decode. Compare normalized.
  const eq = normalizeQuat(expected.rotation)
  expect(Math.abs(actual.rotation.x - eq.x)).toBeLessThanOrEqual(TOL_QUAT_COMPONENT)
  expect(Math.abs(actual.rotation.y - eq.y)).toBeLessThanOrEqual(TOL_QUAT_COMPONENT)
  expect(Math.abs(actual.rotation.z - eq.z)).toBeLessThanOrEqual(TOL_QUAT_COMPONENT)
  expect(Math.abs(actual.rotation.w - eq.w)).toBeLessThanOrEqual(TOL_QUAT_COMPONENT)

  expect(Math.abs(actual.velocity.x - expected.velocity.x)).toBeLessThanOrEqual(TOL_VELOCITY_MPS)
  expect(Math.abs(actual.velocity.y - expected.velocity.y)).toBeLessThanOrEqual(TOL_VELOCITY_MPS)
  expect(Math.abs(actual.velocity.z - expected.velocity.z)).toBeLessThanOrEqual(TOL_VELOCITY_MPS)
}

describe('TransformSnapshot codec', () => {
  it('exports the documented message tag constants', () => {
    expect(MESSAGE_TAG_INPUT_FRAME).toBe(0x01)
    expect(MESSAGE_TAG_TRANSFORM_SNAPSHOT_V1).toBe(0x02)
    expect(MESSAGE_TAG_TRANSFORM_SNAPSHOT).toBe(0x03)
    expect(SNAPSHOT_HEADER_BYTES).toBe(8)
    expect(SNAPSHOT_BIKE_BYTES).toBe(30)
    expect(SNAPSHOT_BIKE_BYTES_V1).toBe(24)
  })

  it('snapshotByteLength returns 8 + 30*N for N in 0..8', () => {
    for (let n = 0; n <= 8; n++) {
      expect(snapshotByteLength(n)).toBe(8 + 30 * n)
    }
  })

  it('round-trips a 1-bike snapshot within quantization tolerances', () => {
    // Build a unit-norm quaternion for a realistic ~30° yaw rotation.
    const rot = normalizeQuat({ x: 0, y: Math.sin(Math.PI / 12), z: 0, w: Math.cos(Math.PI / 12) })
    const snap: TransformSnapshot = {
      senderPeerId: 3,
      tick: 12345,
      bikes: [
        {
          ownerPeerId: 3,
          bikeKind: 0,
          bikeIndex: 0,
          flags: 0,
          position: { x: 12.34, y: -1.5, z: 87.91 },
          rotation: rot,
          velocity: { x: 4.5, y: 0.1, z: -22.7 },
        },
      ],
    }
    const buf = encodeTransformSnapshot(snap)
    expect(buf.byteLength).toBe(snapshotByteLength(1))

    const decoded = decodeTransformSnapshot(buf)
    expect(decoded.senderPeerId).toBe(snap.senderPeerId)
    expect(decoded.tick).toBe(snap.tick)
    expect(decoded.bikes).toHaveLength(1)
    expectRecordClose(decoded.bikes[0]!, snap.bikes[0]!)
  })

  it('round-trips a 5-bike snapshot (player + 4 AI)', () => {
    const records: BikeSnapshotRecord[] = []
    for (let i = 0; i < 5; i++) {
      // Spread realistic poses around the world for each bike.
      const angle = (i / 5) * Math.PI
      records.push({
        ownerPeerId: i === 0 ? 1 : 1, // host broadcasts its own player + 4 AI under its peerId
        bikeKind: i === 0 ? 0 : 1,
        bikeIndex: i === 0 ? 0 : i - 1,
        flags: 0,
        position: { x: 20 * i - 40, y: 1.2 + 0.1 * i, z: -30 + 5 * i },
        rotation: normalizeQuat({ x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) }),
        velocity: { x: -1 + 0.5 * i, y: 0, z: 18 + 0.2 * i },
      })
    }
    const snap: TransformSnapshot = { senderPeerId: 1, tick: 999, bikes: records }

    const buf = encodeTransformSnapshot(snap)
    expect(buf.byteLength).toBe(snapshotByteLength(5))

    const decoded = decodeTransformSnapshot(buf)
    expect(decoded.senderPeerId).toBe(1)
    expect(decoded.tick).toBe(999)
    expect(decoded.bikes).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expectRecordClose(decoded.bikes[i]!, records[i]!)
    }
  })

  it('round-trips positions far beyond the retired ±327.67 m int16 range', () => {
    // The whole point of tag 0x03 (evaluation networking #1): a dressed
    // Mexico City / Cape Town coordinate must survive the wire instead of
    // silently pinning to the old world edge.
    const snap: TransformSnapshot = {
      senderPeerId: 0,
      tick: 0,
      bikes: [
        {
          ownerPeerId: 0,
          bikeKind: 0,
          bikeIndex: 0,
          flags: 0,
          position: { x: 10_000.25, y: -10_000.5, z: 500.75 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          velocity: { x: 0, y: 0, z: 0 },
        },
      ],
    }
    const decoded = decodeTransformSnapshot(encodeTransformSnapshot(snap))
    expect(decoded.bikes[0]!.position.x).toBeCloseTo(10_000.25, 2)
    expect(decoded.bikes[0]!.position.y).toBeCloseTo(-10_000.5, 2)
    expect(decoded.bikes[0]!.position.z).toBeCloseTo(500.75, 2)
  })

  it('still decodes a legacy 0x02 frame from a stale pre-widening tab', () => {
    // Hand-build a legacy 24-byte-record frame: header + one bike at
    // (100.5, 1.5, -200.25), identity rotation, velocity (0, 0, 12).
    const buf = new Uint8Array(SNAPSHOT_HEADER_BYTES + SNAPSHOT_BIKE_BYTES_V1)
    const view = new DataView(buf.buffer)
    view.setUint8(0, MESSAGE_TAG_TRANSFORM_SNAPSHOT_V1)
    view.setUint8(1, 4) // senderPeerId
    view.setUint16(2, 0, true)
    view.setUint32(4, 777, true)
    view.setUint8(8, 4) // ownerPeerId
    view.setUint8(9, 0) // bikeKind player
    view.setUint8(10, 0) // bikeIndex
    view.setUint8(11, 0) // flags
    view.setInt16(12, 100.5 * 100, true)
    view.setInt16(14, 1.5 * 100, true)
    view.setInt16(16, -200.25 * 100, true)
    view.setInt16(18, 0, true) // qx
    view.setInt16(20, 0, true) // qy
    view.setInt16(22, 0, true) // qz
    view.setInt16(24, 32767, true) // qw
    view.setInt16(26, 0, true) // vx
    view.setInt16(28, 0, true) // vy
    view.setInt16(30, 12 * 256, true) // vz

    const decoded = decodeTransformSnapshot(buf)
    expect(decoded.senderPeerId).toBe(4)
    expect(decoded.tick).toBe(777)
    expect(decoded.bikes).toHaveLength(1)
    const bike = decoded.bikes[0]!
    expect(bike.position.x).toBeCloseTo(100.5, 2)
    expect(bike.position.y).toBeCloseTo(1.5, 2)
    expect(bike.position.z).toBeCloseTo(-200.25, 2)
    expect(bike.rotation.w).toBeCloseTo(1, 4)
    expect(bike.velocity.z).toBeCloseTo(12, 2)
  })

  it('renormalizes a non-unit quaternion on decode', () => {
    // {1,0,0,0.5} has length sqrt(1.25) ≈ 1.118 — clearly not unit norm.
    // Encoder clamps each component into [-1, 1] before quantizing, then
    // the decoder renormalizes whatever it reads, so the decoded quat
    // *should* be exactly unit-norm regardless of the input magnitude.
    const snap: TransformSnapshot = {
      senderPeerId: 0,
      tick: 0,
      bikes: [
        {
          ownerPeerId: 0,
          bikeKind: 0,
          bikeIndex: 0,
          flags: 0,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 1, y: 0, z: 0, w: 0.5 },
          velocity: { x: 0, y: 0, z: 0 },
        },
      ],
    }
    const decoded = decodeTransformSnapshot(encodeTransformSnapshot(snap))
    const q = decoded.bikes[0]!.rotation
    const norm = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w)
    expect(norm).toBeCloseTo(1, 5)
  })

  it('throws a clear error when the tag byte is wrong', () => {
    const snap: TransformSnapshot = {
      senderPeerId: 0,
      tick: 0,
      bikes: [
        {
          ownerPeerId: 0,
          bikeKind: 0,
          bikeIndex: 0,
          flags: 0,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          velocity: { x: 0, y: 0, z: 0 },
        },
      ],
    }
    const buf = encodeTransformSnapshot(snap)
    buf[0] = 0x01 // mimic an InputFrame tag landing in the snapshot decoder
    expect(() => decodeTransformSnapshot(buf)).toThrow(/bad tag: expected 0x03 .*got 0x01/)
  })

  it('encodes into / decodes from a shared buffer at non-zero offset', () => {
    // Common when a snapshot is embedded inside a larger network message.
    const PREFIX = 7
    const N = 2
    const total = PREFIX + snapshotByteLength(N)
    const buf = new ArrayBuffer(total)
    const view = new DataView(buf)
    const snap: TransformSnapshot = {
      senderPeerId: 2,
      tick: 42,
      bikes: [
        {
          ownerPeerId: 2,
          bikeKind: 0,
          bikeIndex: 0,
          flags: 0,
          position: { x: 1, y: 2, z: 3 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          velocity: { x: 0.5, y: 0, z: -0.5 },
        },
        {
          ownerPeerId: 2,
          bikeKind: 1,
          bikeIndex: 0,
          flags: 0,
          position: { x: -10, y: 1.5, z: 8 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          velocity: { x: 0, y: 0, z: 12 },
        },
      ],
    }
    const written = encodeTransformSnapshotInto(view, PREFIX, snap)
    expect(written).toBe(snapshotByteLength(N))

    const decoded = decodeTransformSnapshotFrom(view, PREFIX, snapshotByteLength(N))
    expect(decoded.senderPeerId).toBe(snap.senderPeerId)
    expect(decoded.tick).toBe(snap.tick)
    expect(decoded.bikes).toHaveLength(N)
    for (let i = 0; i < N; i++) {
      expectRecordClose(decoded.bikes[i]!, snap.bikes[i]!)
    }
  })
})
