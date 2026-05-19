/**
 * M10.4 — input wire format. (M10.11: tag byte prepended.)
 *
 * `InputFrame` is the on-the-wire representation of one peer's controls for
 * one sim tick. Encoded as a fixed 11-byte little-endian record so a 60 Hz
 * peer streams ~660 B/s — well inside any browser-to-PartyKit budget — and
 * the layout is trivially deterministic across machines (no JSON number
 * formatting, no struct padding).
 *
 * Byte 0 carries a 1-byte type tag so this codec can share a WebSocket with
 * other binary message types (see `transform-snapshot.ts` for the second
 * type at `0x02`). The remaining 10 bytes (payload) are the original M10.4
 * layout, shifted by +1.
 *
 *   offset | bytes | field
 *   -------+-------+-----------------------------------------
 *     0    |   1   | tag            uint8  = 0x01 (MESSAGE_TAG_INPUT_FRAME)
 *     1    |   4   | tick           uint32 LE
 *     5    |   1   | peerId         uint8
 *     6    |   1   | flags          uint8  (bit 0 = fire, bit 1 = boost,
 *                                            bit 2 = trickLeft, bit 3 = trickRight)
 *     7    |   1   | throttle       int8   (value / 127)
 *     8    |   1   | steer          int8   (value / 127)
 *     9    |   1   | brake          uint8  (value / 255)
 *    10    |   1   | pitch          int8   (value / 127)
 *
 * The codec lives in `engine/net/` rather than `engine/input/` because it
 * is a transport concern: the sim still consumes `Intent` (see
 * `sim-step.ts`), and the wire layer is responsible for getting an Intent
 * across the network with the metadata (tick, peer id) the receiver needs
 * to schedule it correctly.
 *
 * Quantization note: int8/uint8 quantization caps axis precision at ~1/127
 * (≈0.008 step). Keyboard smoothing and joystick deadzones swamp that, so
 * round-tripping locally produces controls that feel identical. Crucially,
 * in lockstep multiplayer **the local peer also drives its sim from the
 * decoded frame**, so any quantization loss is identical on both sides and
 * cannot cause divergence.
 */

import type { Intent } from '@/engine/input/intent'

import { MESSAGE_TAG_INPUT_FRAME } from './transform-snapshot'

export type InputFrame = {
  /** Sim tick this input applies to. uint32 wraps after ~828 days at 60 Hz. */
  tick: number
  /** Peer slot, 0..255. By convention slot 0 is the room host. */
  peerId: number
  intent: Intent
}

/** Payload size (without the 1-byte tag). Useful for batching N payloads. */
export const INPUT_FRAME_BYTES = 10

/** Full on-the-wire size including the 1-byte type tag at offset 0. */
export const INPUT_FRAME_WIRE_BYTES = 11

const FLAG_FIRE = 1 << 0
const FLAG_BOOST = 1 << 1
const FLAG_TRICK_LEFT = 1 << 2
const FLAG_TRICK_RIGHT = 1 << 3

/** Clamp `v` into [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

/** Encode an axis in [-1, 1] as int8 with rounding (not truncation). */
function encAxis(v: number): number {
  return Math.round(clamp(v, -1, 1) * 127)
}

/** Encode a unit-positive value in [0, 1] as uint8. */
function encUnit(v: number): number {
  return Math.round(clamp(v, 0, 1) * 255)
}

/**
 * Encode a frame into a fresh 11-byte buffer (tag + payload). Callers that
 * need to avoid per-tick allocations can use {@link encodeInputFrameInto}
 * with a reusable DataView.
 */
export function encodeInputFrame(frame: InputFrame): Uint8Array {
  const buf = new Uint8Array(INPUT_FRAME_WIRE_BYTES)
  encodeInputFrameInto(new DataView(buf.buffer), 0, frame)
  return buf
}

/** Encode into an existing buffer at `offset`. No bounds checks — caller's job. */
export function encodeInputFrameInto(view: DataView, offset: number, frame: InputFrame): void {
  const { intent } = frame
  let flags = 0
  if (intent.fire) flags |= FLAG_FIRE
  if (intent.boost) flags |= FLAG_BOOST
  if (intent.trickLeft) flags |= FLAG_TRICK_LEFT
  if (intent.trickRight) flags |= FLAG_TRICK_RIGHT

  view.setUint8(offset + 0, MESSAGE_TAG_INPUT_FRAME)
  view.setUint32(offset + 1, frame.tick >>> 0, true)
  view.setUint8(offset + 5, frame.peerId & 0xff)
  view.setUint8(offset + 6, flags)
  view.setInt8(offset + 7, encAxis(intent.throttle))
  view.setInt8(offset + 8, encAxis(intent.steer))
  view.setUint8(offset + 9, encUnit(intent.brake))
  view.setInt8(offset + 10, encAxis(intent.pitch))
}

/** Decode a frame from a buffer view. Accepts Uint8Array or ArrayBuffer. */
export function decodeInputFrame(src: Uint8Array | ArrayBuffer): InputFrame {
  const view =
    src instanceof Uint8Array
      ? new DataView(src.buffer, src.byteOffset, src.byteLength)
      : new DataView(src)
  return decodeInputFrameFrom(view, 0)
}

/** Decode from an existing view at `offset`. No bounds checks. */
export function decodeInputFrameFrom(view: DataView, offset: number): InputFrame {
  const tag = view.getUint8(offset + 0)
  if (tag !== MESSAGE_TAG_INPUT_FRAME) {
    throw new Error(`InputFrame: bad tag (got 0x${tag.toString(16)})`)
  }
  const tick = view.getUint32(offset + 1, true)
  const peerId = view.getUint8(offset + 5)
  const flags = view.getUint8(offset + 6)
  const throttle = view.getInt8(offset + 7) / 127
  const steer = view.getInt8(offset + 8) / 127
  const brake = view.getUint8(offset + 9) / 255
  const pitch = view.getInt8(offset + 10) / 127

  return {
    tick,
    peerId,
    intent: {
      throttle: clamp(throttle, -1, 1),
      steer: clamp(steer, -1, 1),
      brake: clamp(brake, 0, 1),
      fire: (flags & FLAG_FIRE) !== 0,
      boost: (flags & FLAG_BOOST) !== 0,
      pitch: clamp(pitch, -1, 1),
      trickLeft: (flags & FLAG_TRICK_LEFT) !== 0,
      trickRight: (flags & FLAG_TRICK_RIGHT) !== 0,
    },
  }
}
