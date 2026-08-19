/**
 * Per-slot rider palette — the deterministic jersey/suit colour keyed by racer
 * grid slot that makes an 8-bike field read as distinct riders instead of clones
 * of the bright-yellow mannequin (rider-mannequin.ts consumes this).
 *
 * These guard the mapping only (pure data), not the renderer:
 *   1. Determinism — same slot → same colour.
 *   2. Distinctness — the seven AI slots are all different, and different enough
 *      to read apart (not near-duplicate hues).
 *   3. The player slot (0, and anything ≤ 0) is UNTOUCHED — null, so the
 *      consumer keeps the shipped mannequin look for the local human.
 */
import { describe, expect, it } from 'vitest'
import { RIDER_SUIT_PALETTE, riderPaletteForSlot } from '@/engine/render/rider-palette'

/** Squared distance between two 0xRRGGBB colours in raw RGB byte space — a
 *  cheap "are these visibly different" proxy for the test. */
function colorDistSq(a: number, b: number): number {
  const dr = ((a >> 16) & 0xff) - ((b >> 16) & 0xff)
  const dg = ((a >> 8) & 0xff) - ((b >> 8) & 0xff)
  const db = (a & 0xff) - (b & 0xff)
  return dr * dr + dg * dg + db * db
}

describe('riderPaletteForSlot', () => {
  it('returns null for the player pole (slot 0) and any non-positive/invalid slot', () => {
    expect(riderPaletteForSlot(0)).toBeNull()
    expect(riderPaletteForSlot(-1)).toBeNull()
    expect(riderPaletteForSlot(Number.NaN)).toBeNull()
    expect(riderPaletteForSlot(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('is deterministic — the same slot always maps to the same triple', () => {
    for (let slot = 1; slot <= 7; slot++) {
      expect(riderPaletteForSlot(slot)).toEqual(riderPaletteForSlot(slot))
    }
  })

  it('gives every one of the seven AI grid slots a colour', () => {
    for (let slot = 1; slot <= 7; slot++) {
      const p = riderPaletteForSlot(slot)
      expect(p).not.toBeNull()
      expect(p?.suit).toBeTypeOf('number')
      expect(p?.trim).toBeTypeOf('number')
      expect(p?.helmet).toBeTypeOf('number')
    }
  })

  it('maps the seven AI slots onto the seven distinct table entries in order', () => {
    for (let slot = 1; slot <= RIDER_SUIT_PALETTE.length; slot++) {
      expect(riderPaletteForSlot(slot)).toBe(RIDER_SUIT_PALETTE[slot - 1])
    }
  })

  it('produces distinct suit colours across slots 1..7 — no two riders alike', () => {
    const suits = Array.from({ length: 7 }, (_, i) => riderPaletteForSlot(i + 1)!.suit)
    expect(new Set(suits).size).toBe(7)
    // And distinct enough to tell apart at a glance: every pair separated well
    // past a trivial delta (guards against two near-identical hues sneaking in).
    for (let i = 0; i < suits.length; i++) {
      for (let j = i + 1; j < suits.length; j++) {
        expect(colorDistSq(suits[i]!, suits[j]!)).toBeGreaterThan(30 * 30)
      }
    }
  })

  it('none of the AI suits is the loud caution-tape yellow the old riders wore', () => {
    // The old uniform mannequin read as a saturated ~0xE0C020 yellow. Guard that
    // no AI suit is a high-sat yellow (R≈G both high, B low) — the one warm-neutral
    // slot is a muted cream/mustard, which this still admits.
    for (let slot = 1; slot <= 7; slot++) {
      const suit = riderPaletteForSlot(slot)!.suit
      const r = (suit >> 16) & 0xff
      const g = (suit >> 8) & 0xff
      const b = suit & 0xff
      const loudYellow = r > 0xcc && g > 0xb0 && b < 0x60 && Math.abs(r - g) < 0x30
      expect(loudYellow).toBe(false)
    }
  })

  it('wraps if the field ever exceeds seven (mirrors aiColors slot % length)', () => {
    expect(riderPaletteForSlot(8)).toBe(riderPaletteForSlot(1))
    expect(riderPaletteForSlot(9)).toBe(riderPaletteForSlot(2))
  })

  it('floors fractional slots to the same entry as their integer part', () => {
    expect(riderPaletteForSlot(3.9)).toBe(riderPaletteForSlot(3))
  })
})
