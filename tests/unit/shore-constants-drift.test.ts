import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import * as waveField from '../../src/engine/sim/water/wave-field'

/**
 * The shore-wave math is evaluated twice — once on the CPU (`computeShore` in
 * wave-field.ts, the buoyancy source of truth) and once in the TSL water shader
 * (render/water.ts). They MUST use identical constants or buoyancy and visuals
 * desync near the coast. There's no way to run the GPU path in node, so instead
 * of comparing outputs we enforce a single source of truth structurally: the
 * shader must IMPORT these constants from wave-field.ts, never re-declare them.
 *
 * Mirrors the spirit of `asset-kinds.test.ts` (two files kept in sync), but
 * stronger: a shared import can't drift, so we assert the import exists and that
 * no local re-declaration shadows it.
 */

const WATER_TS = resolve(__dirname, '../../src/engine/render/water.ts')

// The shore + shoaling constants that must be shared CPU↔GPU.
// (SHORE_WAVE_STRENGTH_DEFAULT is a render-only default, not part of the shared
// math, so it's excluded.) SHOAL_FADE_DEPTH drives the shallow-water amplitude
// fade applied to BOTH the GPU vertex shader and the CPU buoyancy sampler — if
// they drift, the rider sinks below the seabed in the shallows.
// MAX_WAVE_ZONES sizes the shader's fixed zone uniform arrays AND the CPU-side
// truncation in `setWaveZones` — if they drift, a zone past the smaller cap is
// felt by buoyancy but never drawn (or vice versa), which is the exact desync
// the wave-zone GPU port exists to close.
const SHARED = [
  'MAX_WAVE_ZONES',
  'SHOAL_FADE_DEPTH',
  // Shoaling v2 (P3.1): the Green's-law gain + depth-limited break cap are
  // evaluated per vertex on the GPU and per sample in `shoalAttenuation` —
  // a drifted constant moves the break line on one side only.
  'SHOAL_BREAK_GAMMA',
  'SHOAL_GAIN_MAX',
  'SHOAL_GREEN_REF_DEPTH',
  'SHOAL_HEFF_MIN',
  'SHORE_AMP',
  'SHORE_BAND_DEPTH',
  'SHORE_DEPTH_CAP',
  'SHORE_K',
  'SHORE_OMEGA',
  'SHORE_PHASE',
  // Shore-wave v2: swell drive + breaker-forward asymmetry.
  'SHORE_SWELL_DRIVE_REF',
  'SHORE_SWELL_DRIVE_MIN',
  'SHORE_SWELL_DRIVE_MAX',
  'SHORE_ASYM',
  'SHORE_ASYM_PHASE',
  // Authored wave stamps (P3.2): the pulse waveform + caps are evaluated
  // per vertex on the GPU and per sample in computeStamps.
  'MAX_WAVE_STAMPS',
  'STAMP_DEPTH_CAP',
  'STAMP_END_FEATHER_M',
  'STAMP_RELEASE_RATIO',
] as const

describe('shore + shoaling + wave-zone constants single source (wave-field.ts ↔ water.ts)', () => {
  const src = readFileSync(WATER_TS, 'utf-8')

  it('wave-field.ts exports every shared constant as a finite number', () => {
    for (const name of SHARED) {
      const v = (waveField as unknown as Record<string, unknown>)[name]
      expect(typeof v, `${name} must be exported from wave-field.ts`).toBe('number')
      expect(Number.isFinite(v as number)).toBe(true)
    }
  })

  it('water.ts imports the shared constants from wave-field', () => {
    const m = src.match(
      /import\s*\{([\s\S]*?)\}\s*from\s*['"]@\/engine\/sim\/water\/wave-field['"]/,
    )
    expect(m, 'water.ts must import from @/engine/sim/water/wave-field').not.toBeNull()
    const specifiers = m![1]!
    for (const name of SHARED) {
      expect(
        new RegExp(`\\b${name}\\b`).test(specifiers),
        `water.ts must import ${name} from wave-field (single source of truth)`,
      ).toBe(true)
    }
  })

  it('water.ts does not re-declare the shared constants', () => {
    for (const name of SHARED) {
      expect(
        new RegExp(`(const|let|var)\\s+${name}\\b`).test(src),
        `water.ts must not re-declare ${name} — import it from wave-field instead`,
      ).toBe(false)
    }
  })
})
