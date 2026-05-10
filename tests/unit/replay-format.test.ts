import { describe, expect, it } from 'vitest'
import {
  parseReplay,
  REPLAY_VERSION,
  ReplayParseError,
  serializeReplay,
} from '../../src/engine/replay/format'
import { createReplayRecorder } from '../../src/engine/replay/recorder'

function makeBikes(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    slot: i,
    isPlayer: i === 0,
    variantId: 'racer',
    displayName: `Bike ${i}`,
    bodyColor: 0x336699,
  }))
}

describe('replay format', () => {
  it('round-trips an empty recording', () => {
    const recorder = createReplayRecorder({
      trackId: 'lagoon',
      trackName: 'Lagoon Loop',
      bikes: makeBikes(2),
    })
    const file = recorder.finalize({ finishPosition: null, finishTime: null, bestLap: null })
    const out = parseReplay(serializeReplay(file))
    expect(out.version).toBe(REPLAY_VERSION)
    expect(out.bikes).toHaveLength(2)
    expect(out.frames).toHaveLength(0)
  })

  it('round-trips frames with quantized values', () => {
    const recorder = createReplayRecorder({
      trackId: 'lagoon',
      trackName: 'Lagoon Loop',
      bikes: makeBikes(1),
      sampleRateHz: 60,
    })
    // Two samples > 16ms apart at 60Hz.
    recorder.sample(0, [1.234567, 2, 3, 0, 0, 0, 1])
    recorder.sample(0.02, [1.5, 2, 3, 0, 0, 0, 1])
    const file = recorder.finalize({
      finishPosition: 1,
      finishTime: 90.5,
      bestLap: 30.123,
    })
    const out = parseReplay(serializeReplay(file))
    expect(out.frames).toHaveLength(2)
    expect(out.frames[0]!.bikes[0]).toBeCloseTo(1.2346, 4)
    expect(out.frames[1]!.bikes[0]).toBe(1.5)
    expect(out.meta.finishPosition).toBe(1)
  })

  it('rejects mismatched version', () => {
    const recorder = createReplayRecorder({
      trackId: 'lagoon',
      trackName: 'Lagoon',
      bikes: makeBikes(1),
    })
    const file = recorder.finalize({ finishPosition: null, finishTime: null, bestLap: null })
    const tampered = serializeReplay(file).replace(`"version":${REPLAY_VERSION}`, '"version":99')
    expect(() => parseReplay(tampered)).toThrow(ReplayParseError)
  })

  it('rejects frames with wrong float count', () => {
    const recorder = createReplayRecorder({
      trackId: 'lagoon',
      trackName: 'Lagoon',
      bikes: makeBikes(2),
    })
    recorder.sample(0, [1, 2, 3, 0, 0, 0, 1, 4, 5, 6, 0, 0, 0, 1])
    const file = recorder.finalize({ finishPosition: null, finishTime: null, bestLap: null })
    // Truncate one float in frame 0 — should fail validation.
    file.frames[0]!.bikes.pop()
    expect(() => parseReplay(serializeReplay(file))).toThrow(ReplayParseError)
  })

  it('rejects malformed JSON', () => {
    expect(() => parseReplay('not json')).toThrow(ReplayParseError)
    expect(() => parseReplay('null')).toThrow(ReplayParseError)
  })

  it('rate-limits samples per the configured rate', () => {
    const recorder = createReplayRecorder({
      trackId: 'lagoon',
      trackName: 'Lagoon',
      bikes: makeBikes(1),
      sampleRateHz: 30,
    })
    // 5 calls within ~33ms — should accept the first only.
    recorder.sample(0, [0, 0, 0, 0, 0, 0, 1])
    recorder.sample(0.005, [0, 0, 0, 0, 0, 0, 1])
    recorder.sample(0.01, [0, 0, 0, 0, 0, 0, 1])
    recorder.sample(0.02, [0, 0, 0, 0, 0, 0, 1])
    recorder.sample(0.05, [0, 0, 0, 0, 0, 0, 1]) // > 1/30s — accepted
    expect(recorder.frameCount()).toBe(2)
  })

  it('throws when sample size mismatches bike count', () => {
    const recorder = createReplayRecorder({
      trackId: 'lagoon',
      trackName: 'Lagoon',
      bikes: makeBikes(2),
    })
    expect(() => recorder.sample(0, [1, 2, 3])).toThrow()
  })
})
