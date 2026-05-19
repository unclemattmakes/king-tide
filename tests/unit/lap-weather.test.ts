import { describe, expect, it } from 'vitest'
import { createLapWeatherSystem } from '../../src/engine/render/lap-weather'
import { createWaveField, defaultWaves } from '../../src/engine/sim/water/wave-field'

function lastDefined(arr: { c?: number; s?: number }[], key: 'c' | 's'): number | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i]![key]
    if (v !== undefined) return v
  }
  return undefined
}

function makeStubs() {
  const skyCalls: { c?: number; s?: number }[] = []
  const sky = {
    setCloudiness: (c: number) => skyCalls.push({ c }),
    setSunIntensity: (s: number) => skyCalls.push({ s }),
  }
  const waveField = createWaveField(defaultWaves())
  return { sky, waveField, skyCalls }
}

describe('lap-weather system', () => {
  it('no-op when schedule is empty or undefined', () => {
    const { sky, waveField } = makeStubs()
    const sys = createLapWeatherSystem({
      schedule: undefined,
      initial: { cloudiness: 0.4, beaufort: 4, sunIntensity: 1 },
      sky,
      waveField,
    })
    const baseAmps = waveField.waves.map((w) => w.amplitude)
    sys.onLapStart(1)
    sys.step(10)
    expect(waveField.waves.map((w) => w.amplitude)).toEqual(baseAmps)
  })

  it('applies entry 0 at construction', () => {
    const { sky, waveField, skyCalls } = makeStubs()
    createLapWeatherSystem({
      schedule: [{ cloudiness: 0.9, beaufort: 8, sunIntensity: 0.5 }],
      initial: { cloudiness: 0.3, beaufort: 4, sunIntensity: 1 },
      sky,
      waveField,
    })
    const cAfter = lastDefined(skyCalls, 'c')
    const sAfter = lastDefined(skyCalls, 's')
    expect(cAfter).toBeCloseTo(0.9, 4)
    expect(sAfter).toBeCloseTo(0.5, 4)
  })

  it('lerps cloudiness across transitionSeconds', () => {
    const { sky, waveField, skyCalls } = makeStubs()
    const sys = createLapWeatherSystem({
      schedule: [
        { cloudiness: 0.2, beaufort: 4, sunIntensity: 1, transitionSeconds: 0 },
        { cloudiness: 0.8, transitionSeconds: 4 },
      ],
      initial: { cloudiness: 0.2, beaufort: 4, sunIntensity: 1 },
      sky,
      waveField,
    })
    skyCalls.length = 0
    sys.onLapStart(1)
    sys.step(2) // halfway
    const cMid = lastDefined(skyCalls, 'c') ?? 0
    // smoothstep(0.5) = 0.5 → 0.2 + 0.6 * 0.5 = 0.5
    expect(cMid).toBeGreaterThan(0.4)
    expect(cMid).toBeLessThan(0.6)
    sys.step(2.5) // overshoot — target reached
    const cEnd = lastDefined(skyCalls, 'c') ?? 0
    expect(cEnd).toBeCloseTo(0.8, 4)
  })

  it('scales wave amplitudes by the lap-target beaufort relative to initial', () => {
    const { sky, waveField } = makeStubs()
    const baseAmps = waveField.waves.map((w) => w.amplitude)
    const sys = createLapWeatherSystem({
      schedule: [
        { beaufort: 4, transitionSeconds: 0 },
        { beaufort: 8, transitionSeconds: 0 },
      ],
      initial: { cloudiness: 0.4, beaufort: 4, sunIntensity: 1 },
      sky,
      waveField,
    })
    sys.onLapStart(1)
    // Beaufort 4 → 1.0, Beaufort 8 → 2.0 (per beaufortToAmplitudeScale)
    const ratio = waveField.waves[0]!.amplitude / baseAmps[0]!
    expect(ratio).toBeCloseTo(2.0, 2)
  })

  it('captures live values on a mid-transition lap kick', () => {
    const { sky, waveField } = makeStubs()
    const sys = createLapWeatherSystem({
      schedule: [
        { cloudiness: 0.0, transitionSeconds: 0 },
        { cloudiness: 1.0, transitionSeconds: 10 },
        { cloudiness: 0.0, transitionSeconds: 10 },
      ],
      initial: { cloudiness: 0.0, beaufort: 4, sunIntensity: 1 },
      sky,
      waveField,
    })
    sys.onLapStart(1)
    sys.step(5) // partway to 1.0
    const cMid = sys.current().cloudiness
    expect(cMid).toBeGreaterThan(0.3)
    expect(cMid).toBeLessThan(0.7)
    sys.onLapStart(2) // ramps from cMid → 0.0 over 10 s
    sys.step(0)
    expect(sys.current().cloudiness).toBeCloseTo(cMid, 4)
    sys.step(20)
    expect(sys.current().cloudiness).toBeCloseTo(0.0, 4)
  })
})
