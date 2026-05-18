import { describe, expect, it } from 'vitest'
import { __test__, containsProfanity, leetNormalize } from '../../src/engine/leaderboard/profanity'

describe('leetNormalize', () => {
  it('uppercases', () => {
    expect(leetNormalize('hello')).toBe('HELLO')
  })
  it('substitutes digit lookalikes', () => {
    expect(leetNormalize('h3ll0')).toBe('HELLO')
    expect(leetNormalize('5h17')).toBe('SHIT')
  })
  it('substitutes symbol lookalikes', () => {
    expect(leetNormalize('@$$')).toBe('ASS')
    expect(leetNormalize('!t')).toBe('IT')
  })
  it('returns empty string for non-strings', () => {
    expect(leetNormalize(123 as unknown as string)).toBe('')
  })
})

describe('containsProfanity', () => {
  it('flags simple slurs', () => {
    expect(containsProfanity('FUCKER')).toBe(true)
    expect(containsProfanity('SHIT')).toBe(true)
    expect(containsProfanity('BITCH')).toBe(true)
  })

  it('catches leetspeak evasions', () => {
    expect(containsProfanity('5H17')).toBe(true)
    expect(containsProfanity('F4G')).toBe(true)
    expect(containsProfanity('FUCK')).toBe(true)
  })

  it('treats short stems as bounded — avoids Scunthorpe', () => {
    // ASS is a short stem; should NOT match these substrings.
    expect(containsProfanity('CLASSIC')).toBe(false)
    expect(containsProfanity('BASS')).toBe(false)
    expect(containsProfanity('PASS')).toBe(false)
    expect(containsProfanity('GLASS')).toBe(false)
    // But these should still match as bounded forms.
    expect(containsProfanity('ASS')).toBe(true)
    expect(containsProfanity('ASS_HOLE')).toBe(true) // underscore = non-letter boundary
    expect(containsProfanity('JACK-ASS')).toBe(true)
  })

  it("doesn't flag innocent racers", () => {
    expect(containsProfanity('RACER')).toBe(false)
    expect(containsProfanity('SPEEDY')).toBe(false)
    expect(containsProfanity('WAVE')).toBe(false)
    expect(containsProfanity('Z9-PRO')).toBe(false)
  })

  it('handles empty + edge inputs', () => {
    expect(containsProfanity('')).toBe(false)
    expect(containsProfanity('A')).toBe(false)
    expect(containsProfanity('123')).toBe(false)
  })

  it('every long stem self-flags', () => {
    // Sanity check — every entry in the list must be detected by the
    // function. Catches typos in the stems list.
    for (const stem of __test__.LONG_STEMS) {
      expect(containsProfanity(stem)).toBe(true)
    }
    for (const stem of __test__.SHORT_STEMS) {
      expect(containsProfanity(stem)).toBe(true)
    }
  })
})
