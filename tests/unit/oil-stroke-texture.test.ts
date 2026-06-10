import { describe, expect, it } from 'vitest'
import {
  FOAM_STROKE_MASS_SPEC,
  FOAM_STROKE_STREAK_SPEC,
  packSheetRGBA8,
  rasterizeOilStrokeSheet,
} from '@/engine/render/oil-stroke-texture'

/**
 * The oil-stroke foam sheets are procedural so the water's foam look is
 * identical on every machine with no asset hydration (the R2-served
 * `foam_streaks.png` they replace silently 404'd into a no-op on unhydrated
 * clones). These tests pin the properties the shader relies on; the look
 * itself is judged by eye (foam-sweep captures).
 */
describe('oil-stroke foam sheets', () => {
  it('is deterministic — same spec, same bytes', () => {
    const a = rasterizeOilStrokeSheet(FOAM_STROKE_MASS_SPEC)
    const b = rasterizeOilStrokeSheet(FOAM_STROKE_MASS_SPEC)
    expect(a).toEqual(b)
  })

  for (const [name, spec] of [
    ['mass', FOAM_STROKE_MASS_SPEC],
    ['streak', FOAM_STROKE_STREAK_SPEC],
  ] as const) {
    it(`${name} sheet stays in range with sane stroke coverage`, () => {
      const grid = rasterizeOilStrokeSheet(spec)
      expect(grid.length).toBe(spec.size * spec.size)
      let sum = 0
      let lo = Number.POSITIVE_INFINITY
      let hi = Number.NEGATIVE_INFINITY
      for (const v of grid) {
        sum += v
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      expect(lo).toBeGreaterThanOrEqual(0)
      expect(hi).toBeLessThanOrEqual(1)
      // Strokes over clean water — neither empty nor a wash. The break-up
      // pattern's role (water.ts foam-mask block) needs visible gaps AND
      // visible paint; drifting outside this band is a look regression even
      // if nothing crashes.
      const mean = sum / grid.length
      expect(mean).toBeGreaterThan(0.05)
      expect(mean).toBeLessThan(0.6)
    })

    it(`${name} sheet strokes run along +U (anisotropic)`, () => {
      // Strokes lie along the U/x axis, so adjacent-texel differences must be
      // markedly smaller along rows than along columns. This is the property
      // the shader's crest-aligned UV mapping depends on — if a refactor
      // accidentally rotated the sheet, foam strokes would run along the
      // swell's travel direction instead of along the crest lines (the exact
      // 90° error the first cut shipped with).
      const grid = rasterizeOilStrokeSheet(spec)
      const n = spec.size
      let du = 0
      let dv = 0
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const v = grid[y * n + x]!
          du += Math.abs(grid[y * n + ((x + 1) % n)]! - v)
          dv += Math.abs(grid[((y + 1) % n) * n + x]! - v)
        }
      }
      expect(du).toBeGreaterThan(0)
      expect(dv / du).toBeGreaterThan(1.5)
    })
  }

  it('packs to RGBA8 with opaque alpha and grayscale channels', () => {
    const rgba = packSheetRGBA8(Float32Array.from([0, 0.5, 1, 2, -1]))
    expect(Array.from(rgba.slice(0, 4))).toEqual([0, 0, 0, 255])
    expect(Array.from(rgba.slice(4, 8))).toEqual([128, 128, 128, 255])
    expect(Array.from(rgba.slice(8, 12))).toEqual([255, 255, 255, 255])
    // Out-of-range inputs clamp instead of wrapping.
    expect(rgba[12]).toBe(255)
    expect(rgba[16]).toBe(0)
  })
})
