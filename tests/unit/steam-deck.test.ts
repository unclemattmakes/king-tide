import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetDeckProfileForTests,
  applyDeckProfile,
  DECK_DEFAULT_FRAMERATE_CAP,
  detectSteamDeck,
  getDeckProfile,
} from '../../src/engine/steam-deck'

// Vitest runs in `environment: 'node'` so `window` / `navigator` aren't
// defined by default — stub them per-test to exercise each detection branch.
type NavMock = {
  userAgent: string
  getGamepads?: () => Array<{ id: string } | null>
}
type WindowMock = {
  innerWidth: number
  innerHeight: number
  devicePixelRatio: number
}

function stubEnv(nav: Partial<NavMock> = {}, win: Partial<WindowMock> = {}): void {
  vi.stubGlobal('navigator', {
    userAgent: '',
    getGamepads: () => [],
    ...nav,
  })
  vi.stubGlobal('window', {
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    ...win,
  })
}

describe('detectSteamDeck', () => {
  beforeEach(() => {
    _resetDeckProfileForTests()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns isLikelyDeck=false on a vanilla desktop UA + 1080p viewport', () => {
    stubEnv(
      { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0' },
      { innerWidth: 1920, innerHeight: 1080 },
    )
    const d = detectSteamDeck()
    expect(d.isLikelyDeck).toBe(false)
    expect(d.signals).toEqual([])
  })

  it('detects the SteamDeck UA token', () => {
    stubEnv(
      {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64; SteamDeck) AppleWebKit/605.1.15',
      },
      { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1 },
    )
    const d = detectSteamDeck()
    expect(d.isLikelyDeck).toBe(true)
    expect(d.signals).toContain('ua')
    expect(d.signals).toContain('viewport')
  })

  it('flags the native Deck panel resolution (1280×800 @ 1×) on a non-Deck UA', () => {
    stubEnv(
      { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' },
      { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1 },
    )
    const d = detectSteamDeck()
    expect(d.isLikelyDeck).toBe(true)
    expect(d.signals).toEqual(['viewport'])
  })

  it('does NOT flag a 1280×800 viewport with devicePixelRatio !== 1 (retina laptop)', () => {
    stubEnv(
      { userAgent: 'Mozilla/5.0 (Macintosh)' },
      { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2 },
    )
    const d = detectSteamDeck()
    expect(d.isLikelyDeck).toBe(false)
  })

  it('detects the Steam virtual gamepad id', () => {
    stubEnv(
      {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
        getGamepads: () => [{ id: 'Steam Virtual Gamepad (Vendor: 28de Product: 11ff)' }],
      },
      { innerWidth: 1920, innerHeight: 1080 },
    )
    const d = detectSteamDeck()
    expect(d.isLikelyDeck).toBe(true)
    expect(d.signals).toEqual(['gamepad'])
  })

  it('tolerates a missing getGamepads API without throwing', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0' })
    vi.stubGlobal('window', { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 })
    const d = detectSteamDeck()
    expect(d.isLikelyDeck).toBe(false)
    expect(d.signals).toEqual([])
  })
})

describe('applyDeckProfile', () => {
  beforeEach(() => {
    _resetDeckProfileForTests()
    // Silence the console.info side-effect during tests.
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('latches the default 60fps cap, gamepad-first input, fullscreen-on-gesture', () => {
    const p = applyDeckProfile()
    expect(p.framerateCap).toBe(DECK_DEFAULT_FRAMERATE_CAP)
    expect(p.framerateCap).toBe(60)
    expect(p.preferGamepadInput).toBe(true)
    expect(p.requestFullscreenOnGesture).toBe(true)
  })

  it('getDeckProfile() returns null until applyDeckProfile() runs', () => {
    expect(getDeckProfile()).toBeNull()
    applyDeckProfile()
    expect(getDeckProfile()).not.toBeNull()
  })
})
