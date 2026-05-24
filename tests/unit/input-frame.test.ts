/**
 * M10.4 — InputFrame wire format round-trip tests.
 * M10.11 — wire size grew from 10 → 11 bytes (1-byte tag at offset 0).
 *
 * The codec is the contract between the local input layer and the future
 * PartyKit relay. Any precision loss or layout drift here would manifest
 * as desync the moment a second peer joins, so we lean hard on round-trip
 * invariants: encode → decode must reproduce the input within the wire
 * format's documented precision (1/127 for signed axes, 1/255 for brake).
 */
import { describe, expect, it } from 'vitest'
import type { Intent } from '../../src/engine/input/intent'
import { emptyIntent } from '../../src/engine/input/intent'
import {
  decodeInputFrame,
  decodeInputFrameFrom,
  encodeInputFrame,
  encodeInputFrameInto,
  INPUT_FRAME_BYTES,
  INPUT_FRAME_WIRE_BYTES,
  type InputFrame,
} from '../../src/engine/net/input-frame'

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return { ...emptyIntent(), ...overrides }
}

function expectIntentClose(actual: Intent, expected: Intent): void {
  expect(actual.throttle).toBeCloseTo(expected.throttle, 2)
  expect(actual.steer).toBeCloseTo(expected.steer, 2)
  expect(actual.brake).toBeCloseTo(expected.brake, 2)
  expect(actual.pitch).toBeCloseTo(expected.pitch, 2)
  expect(actual.fire).toBe(expected.fire)
  expect(actual.boost).toBe(expected.boost)
  expect(actual.tuck).toBe(expected.tuck)
}

describe('InputFrame codec', () => {
  it('encodes to a fixed 11-byte buffer (tag + 10-byte payload)', () => {
    const buf = encodeInputFrame({ tick: 0, peerId: 0, intent: emptyIntent() })
    expect(buf.byteLength).toBe(INPUT_FRAME_WIRE_BYTES)
    expect(INPUT_FRAME_WIRE_BYTES).toBe(11)
    expect(INPUT_FRAME_BYTES).toBe(10)
    // Tag byte is 0x01 at offset 0.
    expect(buf[0]).toBe(0x01)
  })

  it('round-trips an empty frame', () => {
    const frame: InputFrame = { tick: 0, peerId: 0, intent: emptyIntent() }
    const decoded = decodeInputFrame(encodeInputFrame(frame))
    expect(decoded.tick).toBe(0)
    expect(decoded.peerId).toBe(0)
    expectIntentClose(decoded.intent, frame.intent)
  })

  it('round-trips a fully saturated frame', () => {
    const frame: InputFrame = {
      tick: 12345,
      peerId: 3,
      intent: {
        throttle: 1,
        steer: -1,
        brake: 1,
        fire: true,
        boost: true,
        pitch: -1,
        trickLeft: true,
        trickRight: true,
        tuck: true,
      },
    }
    const decoded = decodeInputFrame(encodeInputFrame(frame))
    expect(decoded.tick).toBe(12345)
    expect(decoded.peerId).toBe(3)
    expectIntentClose(decoded.intent, frame.intent)
  })

  it('preserves the tick across encode/decode', () => {
    for (const tick of [0, 1, 60, 3600, 100_000, 0xffffffff]) {
      const frame: InputFrame = { tick, peerId: 0, intent: emptyIntent() }
      expect(decodeInputFrame(encodeInputFrame(frame)).tick).toBe(tick >>> 0)
    }
  })

  it('preserves the peerId across encode/decode', () => {
    for (const peerId of [0, 1, 7, 127, 255]) {
      const frame: InputFrame = { tick: 0, peerId, intent: emptyIntent() }
      expect(decodeInputFrame(encodeInputFrame(frame)).peerId).toBe(peerId)
    }
  })

  it('quantizes axes to <1.5% of full range', () => {
    // 1/127 ≈ 0.0079, so 0.01 is the tightest tolerance the codec promises.
    const cases = [-0.97, -0.5, -0.123, 0, 0.001, 0.5, 0.97]
    for (const v of cases) {
      const frame: InputFrame = {
        tick: 0,
        peerId: 0,
        intent: makeIntent({ throttle: v, steer: v, pitch: v }),
      }
      const out = decodeInputFrame(encodeInputFrame(frame)).intent
      expect(out.throttle).toBeCloseTo(v, 1)
      expect(out.steer).toBeCloseTo(v, 1)
      expect(out.pitch).toBeCloseTo(v, 1)
    }
  })

  it('preserves the tuck flag independently of other booleans', () => {
    for (const tuck of [false, true]) {
      const frame: InputFrame = { tick: 0, peerId: 0, intent: makeIntent({ tuck }) }
      const out = decodeInputFrame(encodeInputFrame(frame)).intent
      expect(out.tuck).toBe(tuck)
      // Tuck bit must not bleed into adjacent flags.
      expect(out.fire).toBe(false)
      expect(out.boost).toBe(false)
      expect(out.trickLeft).toBe(false)
      expect(out.trickRight).toBe(false)
    }
  })

  it('preserves fire and boost independently', () => {
    const cases: Array<[boolean, boolean]> = [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ]
    for (const [fire, boost] of cases) {
      const frame: InputFrame = { tick: 0, peerId: 0, intent: makeIntent({ fire, boost }) }
      const out = decodeInputFrame(encodeInputFrame(frame)).intent
      expect(out.fire).toBe(fire)
      expect(out.boost).toBe(boost)
    }
  })

  it('clamps out-of-range axes back into [-1, 1]', () => {
    const frame: InputFrame = {
      tick: 0,
      peerId: 0,
      intent: {
        throttle: 5,
        steer: -7,
        brake: 99,
        fire: false,
        boost: false,
        pitch: -3,
        trickLeft: false,
        trickRight: false,
        tuck: false,
      },
    }
    const out = decodeInputFrame(encodeInputFrame(frame)).intent
    expect(out.throttle).toBe(1)
    expect(out.steer).toBe(-1)
    expect(out.brake).toBe(1)
    expect(out.pitch).toBe(-1)
  })

  it('writes little-endian — tag at byte 0, tick LSB at byte 1', () => {
    // tick = 0x04030201 → bytes [tag, 0x01, 0x02, 0x03, 0x04, ...]
    const buf = encodeInputFrame({ tick: 0x04030201, peerId: 0, intent: emptyIntent() })
    expect(buf[0]).toBe(0x01) // tag
    expect(buf[1]).toBe(0x01)
    expect(buf[2]).toBe(0x02)
    expect(buf[3]).toBe(0x03)
    expect(buf[4]).toBe(0x04)
  })

  it('encodes/decodes multiple frames in one buffer via into/from helpers', () => {
    const N = 4
    const buf = new ArrayBuffer(INPUT_FRAME_WIRE_BYTES * N)
    const view = new DataView(buf)
    const frames: InputFrame[] = Array.from({ length: N }, (_, i) => ({
      tick: 1000 + i,
      peerId: i,
      intent: makeIntent({ throttle: i * 0.25 - 0.5, fire: i % 2 === 0 }),
    }))
    for (let i = 0; i < N; i++) {
      encodeInputFrameInto(view, i * INPUT_FRAME_WIRE_BYTES, frames[i]!)
    }
    for (let i = 0; i < N; i++) {
      const decoded = decodeInputFrameFrom(view, i * INPUT_FRAME_WIRE_BYTES)
      expect(decoded.tick).toBe(frames[i]!.tick)
      expect(decoded.peerId).toBe(frames[i]!.peerId)
      expectIntentClose(decoded.intent, frames[i]!.intent)
    }
  })

  it('decodes from a Uint8Array slice (byteOffset > 0)', () => {
    // Common when reading frames out of a larger network message.
    const wrapper = new Uint8Array(INPUT_FRAME_WIRE_BYTES + 4)
    const inner = wrapper.subarray(4)
    const original: InputFrame = {
      tick: 42,
      peerId: 1,
      intent: makeIntent({ throttle: 0.5, fire: true }),
    }
    const encoded = encodeInputFrame(original)
    inner.set(encoded)
    const decoded = decodeInputFrame(inner)
    expect(decoded.tick).toBe(42)
    expect(decoded.peerId).toBe(1)
    expectIntentClose(decoded.intent, original.intent)
  })

  it('throws when decoding a buffer whose first byte is not the InputFrame tag', () => {
    const buf = new Uint8Array(INPUT_FRAME_WIRE_BYTES)
    // Build a valid-looking payload but with the wrong tag (e.g. 0x02 = snapshot).
    const valid = encodeInputFrame({ tick: 7, peerId: 2, intent: emptyIntent() })
    buf.set(valid)
    buf[0] = 0x02
    expect(() => decodeInputFrame(buf)).toThrow(/bad tag/i)

    // Also test a totally bogus tag byte.
    buf[0] = 0xff
    expect(() => decodeInputFrame(buf)).toThrow(/bad tag/i)
  })
})
