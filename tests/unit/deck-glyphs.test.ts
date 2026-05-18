import { describe, expect, it } from 'vitest'
import { glyphFor, glyphSourceForGamepadId } from '@/engine/input/deck-glyphs'

describe('glyphFor', () => {
  it('returns standard Xbox labels by default', () => {
    expect(glyphFor(0)).toBe('A')
    expect(glyphFor(1)).toBe('B')
    expect(glyphFor(2)).toBe('X')
    expect(glyphFor(3)).toBe('Y')
    expect(glyphFor(7)).toBe('RT')
  })

  it('returns Deck-native labels when source is deck', () => {
    expect(glyphFor(0, 'deck')).toBe('A')
    expect(glyphFor(6, 'deck')).toBe('L2')
    expect(glyphFor(8, 'deck')).toBe('View')
    expect(glyphFor(9, 'deck')).toBe('Menu')
    expect(glyphFor(16, 'deck')).toBe('Steam')
  })

  it('returns PlayStation glyphs for face buttons', () => {
    expect(glyphFor(0, 'ps')).toBe('✕')
    expect(glyphFor(1, 'ps')).toBe('●')
    expect(glyphFor(2, 'ps')).toBe('■')
    expect(glyphFor(3, 'ps')).toBe('▲')
  })

  it('returns Switch labels with A/B swap', () => {
    // Switch swaps A↔B vs the W3C standard mapping.
    expect(glyphFor(0, 'switch')).toBe('B')
    expect(glyphFor(1, 'switch')).toBe('A')
    expect(glyphFor(2, 'switch')).toBe('Y')
    expect(glyphFor(3, 'switch')).toBe('X')
    expect(glyphFor(6, 'switch')).toBe('ZL')
  })

  it('falls back to "Button N" for unknown indices', () => {
    expect(glyphFor(99)).toBe('Button 99')
    expect(glyphFor(42, 'deck')).toBe('Button 42')
  })
})

describe('glyphSourceForGamepadId', () => {
  it('detects Steam Deck virtual gamepad ids', () => {
    expect(glyphSourceForGamepadId('Steam Virtual Gamepad')).toBe('deck')
    expect(glyphSourceForGamepadId('steam deck controller')).toBe('deck')
  })

  it('detects DualSense / DualShock', () => {
    expect(glyphSourceForGamepadId('Sony DualSense Wireless Controller')).toBe('ps')
    expect(glyphSourceForGamepadId('PlayStation DualShock 4')).toBe('ps')
  })

  it('detects Switch Pro controllers', () => {
    expect(glyphSourceForGamepadId('Nintendo Pro Controller')).toBe('switch')
    expect(glyphSourceForGamepadId('Pro Controller (Vendor: 057e Product: 2009)')).toBe('switch')
  })

  it('falls through to standard for Xbox + unknown pads', () => {
    expect(glyphSourceForGamepadId('Xbox 360 Controller')).toBe('standard')
    expect(glyphSourceForGamepadId('Xbox Wireless Controller (Vendor: 045e)')).toBe('standard')
    expect(glyphSourceForGamepadId('Some Generic USB Joystick')).toBe('standard')
    expect(glyphSourceForGamepadId('')).toBe('standard')
  })
})
