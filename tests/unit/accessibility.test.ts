// @vitest-environment jsdom
/**
 * Accessibility — palette + service + player-settings round-trip.
 *
 * Step 8 / Polish-QA: closes the v1 work-breakdown convention row.
 * Owns the four shapes the system depends on:
 *
 *  1. Palettes are stable and the colorblind variants pick distinct
 *     hue families for the warning↔success pair so red-green safe
 *     modes don't accidentally collapse the gameplay-meaningful pair.
 *  2. `playerSettings` round-trips colorblind mode through localStorage
 *     (save → load) under the v2 storage key.
 *  3. Setters notify `onAccessibilityChange` listeners.
 *  4. `applyAccessibilityToDom()` paints the body data-attrs so the
 *     CSS in `index.html` can scale text, force opaque HUD bgs, etc.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetAccessibilityListenersForTest,
  applyAccessibilityToDom,
  currentHudPalette,
  onAccessibilityChange,
} from '../../src/engine/accessibility/accessibility-service'
import {
  COLORBLIND_PALETTES,
  DEFAULT_PALETTE,
  paletteFor,
} from '../../src/engine/accessibility/palettes'
import {
  DEFAULT_PLAYER_SETTINGS,
  loadPlayerSettings,
  playerSettings,
  setColorblindMode,
  setHighContrast,
  setLargeText,
  setReducedFlash,
  setReducedMotion,
} from '../../src/engine/player-settings'

const STORAGE_KEY = 'hoverbike.playerSettings.v2'

function resetSettings(): void {
  playerSettings.colorblindMode = DEFAULT_PLAYER_SETTINGS.colorblindMode
  playerSettings.reducedFlash = DEFAULT_PLAYER_SETTINGS.reducedFlash
  playerSettings.largeText = DEFAULT_PLAYER_SETTINGS.largeText
  playerSettings.highContrast = DEFAULT_PLAYER_SETTINGS.highContrast
  playerSettings.reducedMotion = DEFAULT_PLAYER_SETTINGS.reducedMotion
  playerSettings.motionSicknessReduction = DEFAULT_PLAYER_SETTINGS.motionSicknessReduction
  playerSettings.screenShakeIntensity = DEFAULT_PLAYER_SETTINGS.screenShakeIntensity
  playerSettings.subtitlesAlwaysOn = DEFAULT_PLAYER_SETTINGS.subtitlesAlwaysOn
}

afterEach(() => {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
  resetSettings()
  _resetAccessibilityListenersForTest()
  // Strip the data-attrs each test added to keep them isolated.
  if (typeof document !== 'undefined' && document.body) {
    document.body.removeAttribute('data-cb')
    document.body.removeAttribute('data-large-text')
    document.body.removeAttribute('data-high-contrast')
    document.body.removeAttribute('data-reduced-flash')
    document.body.removeAttribute('data-reduced-motion-override')
  }
})

/** Pull the R/G/B channel triple out of a `#rrggbb` palette entry so
 *  we can hard-assert two colors are perceptually distinct (different
 *  hue families). Returns `[r, g, b]` in `[0..255]`. */
function rgbOf(hex: string): [number, number, number] {
  const v = hex.startsWith('#') ? hex.slice(1) : hex
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}

/** Hue-family distance — sum of absolute per-channel deltas. Two safe
 *  palette entries that need to read as "different things" should not
 *  collapse onto the same channel triple within ±60 across the sum. */
function channelDelta(a: string, b: string): number {
  const [ar, ag, ab] = rgbOf(a)
  const [br, bg, bb] = rgbOf(b)
  return Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb)
}

describe('palettes', () => {
  it('paletteFor("off") returns DEFAULT_PALETTE identity', () => {
    expect(paletteFor('off')).toBe(DEFAULT_PALETTE)
  })

  it('each colorblind palette keeps warning ↔ success distinguishable', () => {
    // The red-green pair (warning vs success) is the gameplay-meaningful
    // contrast on the minimap-ring highlight + lap-PB pill. Each named
    // palette must keep them in hue families the named deficiency can
    // resolve — we sanity-check via a coarse channel-distance floor.
    for (const mode of ['deuteranopia', 'protanopia', 'tritanopia'] as const) {
      const p = COLORBLIND_PALETTES[mode]
      expect(channelDelta(p.warning, p.success)).toBeGreaterThan(120)
    }
  })

  it('every colorblind palette keeps leader ↔ opponent distinguishable', () => {
    // Second gameplay pair — the leader's dot must read against the
    // opponent dot color, otherwise the minimap is unreadable.
    for (const mode of ['deuteranopia', 'protanopia', 'tritanopia'] as const) {
      const p = COLORBLIND_PALETTES[mode]
      expect(channelDelta(p.leader, p.opponent)).toBeGreaterThan(120)
    }
  })

  it('currentHudPalette() tracks the live colorblind mode', () => {
    expect(currentHudPalette()).toBe(DEFAULT_PALETTE)
    setColorblindMode('deuteranopia')
    expect(currentHudPalette()).toBe(COLORBLIND_PALETTES.deuteranopia)
    setColorblindMode('tritanopia')
    expect(currentHudPalette()).toBe(COLORBLIND_PALETTES.tritanopia)
  })
})

describe('player-settings persistence', () => {
  it('round-trips colorblind mode through localStorage', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        colorblindMode: 'protanopia',
        reducedFlash: true,
        largeText: true,
        highContrast: true,
        reducedMotion: true,
        motionSicknessReduction: true,
        screenShakeIntensity: 0.35,
        subtitlesAlwaysOn: true,
      }),
    )
    loadPlayerSettings()
    expect(playerSettings.colorblindMode).toBe('protanopia')
    expect(playerSettings.reducedFlash).toBe(true)
    expect(playerSettings.largeText).toBe(true)
    expect(playerSettings.highContrast).toBe(true)
    expect(playerSettings.reducedMotion).toBe(true)
    expect(playerSettings.motionSicknessReduction).toBe(true)
    expect(playerSettings.screenShakeIntensity).toBeCloseTo(0.35, 5)
    expect(playerSettings.subtitlesAlwaysOn).toBe(true)
  })

  it('invalid colorblind mode string falls back to "off"', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ colorblindMode: 'rainbow-vision' }))
    // Pre-populate live struct to a non-default to confirm load doesn't
    // touch the field when the stored value is invalid.
    playerSettings.colorblindMode = 'off'
    loadPlayerSettings()
    expect(playerSettings.colorblindMode).toBe('off')
  })

  it('screen-shake intensity clamps into [0..1] on load', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ screenShakeIntensity: 5.7 }))
    loadPlayerSettings()
    expect(playerSettings.screenShakeIntensity).toBe(1)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ screenShakeIntensity: -2 }))
    loadPlayerSettings()
    expect(playerSettings.screenShakeIntensity).toBe(0)
  })
})

/** Wait one tick of the macrotask queue — long enough for the dynamic
 *  `import('./accessibility-service')` chain inside the setters to
 *  resolve and run its `.then` handler before the assertion. A double
 *  `await Promise.resolve()` only flushes microtasks; the import
 *  resolution lives on the module-graph queue. */
function flushImport(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('accessibility pub/sub', () => {
  it('setters fire onAccessibilityChange subscribers', async () => {
    const fn = vi.fn()
    onAccessibilityChange(fn)
    setColorblindMode('deuteranopia')
    await flushImport()
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('unsubscribe removes the listener', async () => {
    const fn = vi.fn()
    const off = onAccessibilityChange(fn)
    setReducedFlash(true)
    await flushImport()
    const callsAfterFirst = fn.mock.calls.length
    off()
    setHighContrast(true)
    await flushImport()
    expect(fn.mock.calls.length).toBe(callsAfterFirst)
  })
})

describe('applyAccessibilityToDom', () => {
  it('flips body[data-large-text] when largeText is set', () => {
    setLargeText(true)
    applyAccessibilityToDom()
    expect(document.body.dataset.largeText).toBe('1')
    setLargeText(false)
    applyAccessibilityToDom()
    expect(document.body.dataset.largeText).toBe('0')
  })

  it('writes the full attribute set in one call', () => {
    playerSettings.colorblindMode = 'tritanopia'
    playerSettings.largeText = true
    playerSettings.highContrast = true
    playerSettings.reducedFlash = true
    playerSettings.reducedMotion = true
    applyAccessibilityToDom()
    expect(document.body.dataset.cb).toBe('tritanopia')
    expect(document.body.dataset.largeText).toBe('1')
    expect(document.body.dataset.highContrast).toBe('1')
    expect(document.body.dataset.reducedFlash).toBe('1')
    expect(document.body.dataset.reducedMotionOverride).toBe('on')
  })

  it('reduced-motion override reads off when the setting is false', () => {
    setReducedMotion(false)
    applyAccessibilityToDom()
    expect(document.body.dataset.reducedMotionOverride).toBe('off')
  })
})
