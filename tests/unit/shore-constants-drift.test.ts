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

// The shore constants that must be shared CPU↔GPU. (SHORE_WAVE_STRENGTH_DEFAULT
// is a render-only default, not part of the shared math, so it's excluded.)
const SHARED = [
  'SHORE_AMP',
  'SHORE_BAND_DEPTH',
  'SHORE_DEPTH_CAP',
  'SHORE_K',
  'SHORE_OMEGA',
  'SHORE_PHASE',
] as const

describe('shore-wave constants single source (wave-field.ts ↔ water.ts)', () => {
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
