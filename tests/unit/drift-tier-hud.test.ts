// @vitest-environment jsdom
/**
 * Drift-tier HUD badge — covers the slot wiring + tier color/label
 * transitions + the `playerSettings.driftIntensity = 'off'` opt-out.
 *
 * The HUD module is mostly a CSS-driven view (the actual color tokens
 * live in index.html style block), so the tests focus on what the
 * module IS responsible for: setting the right `data-active`,
 * `data-tier`, `data-tierup` attributes and the label text content
 * each `update()` call.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PLAYER_SETTINGS, playerSettings } from '../../src/engine/player-settings'
import { createDriftTierHud } from '../../src/engine/render/drift-tier-hud'

function installSlot(): HTMLElement {
  const el = document.createElement('div')
  el.id = 'hud-drift'
  el.setAttribute('hidden', '')
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
  playerSettings.driftIntensity = DEFAULT_PLAYER_SETTINGS.driftIntensity
})

describe('createDriftTierHud — missing slot', () => {
  it('returns a no-op interface when the slot is absent', () => {
    const hud = createDriftTierHud()
    // Must not throw.
    expect(() => hud.update(-1, 2)).not.toThrow()
    expect(() => hud.dispose()).not.toThrow()
  })
})

describe('createDriftTierHud — slot present', () => {
  let slot: HTMLElement
  beforeEach(() => {
    slot = installSlot()
  })

  it('reveals the slot and seeds the ring + label markup', () => {
    createDriftTierHud()
    expect(slot.hasAttribute('hidden')).toBe(false)
    expect(slot.querySelector('.df-ring')).not.toBeNull()
    expect(slot.querySelector('.df-label')).not.toBeNull()
  })

  it('marks the badge active and sets tier 1 on the first MT charge', () => {
    const hud = createDriftTierHud()
    hud.update(-1, 1)
    expect(slot.getAttribute('data-active')).toBe('1')
    expect(slot.getAttribute('data-tier')).toBe('1')
    expect(slot.querySelector('.df-label')!.textContent).toBe('MT')
  })

  it('switches label + tier when charge climbs to SMT', () => {
    const hud = createDriftTierHud()
    hud.update(1, 1)
    hud.update(1, 2)
    expect(slot.getAttribute('data-tier')).toBe('2')
    expect(slot.querySelector('.df-label')!.textContent).toBe('SMT')
  })

  it('switches label to UMT at tier 3', () => {
    const hud = createDriftTierHud()
    hud.update(1, 3)
    expect(slot.getAttribute('data-tier')).toBe('3')
    expect(slot.querySelector('.df-label')!.textContent).toBe('UMT')
  })

  it('fires the tier-up flash attribute on each upgrade', () => {
    const hud = createDriftTierHud()
    hud.update(1, 1) // first tier — counts as a flash (0 → 1)
    expect(slot.getAttribute('data-tierup')).toBe('1')
    // Clear the attribute by waiting longer than the flash window.
    slot.removeAttribute('data-tierup')
    hud.update(1, 2)
    expect(slot.getAttribute('data-tierup')).toBe('1')
  })

  it('does NOT re-fire the flash when tier holds steady frame-over-frame', () => {
    const hud = createDriftTierHud()
    hud.update(1, 2)
    slot.removeAttribute('data-tierup')
    hud.update(1, 2)
    expect(slot.getAttribute('data-tierup')).toBeNull()
  })

  it('clears active when the drift ends (driftDir = 0)', () => {
    const hud = createDriftTierHud()
    hud.update(1, 2)
    expect(slot.getAttribute('data-active')).toBe('1')
    hud.update(0, 0)
    expect(slot.getAttribute('data-active')).toBeNull()
  })

  it("respects playerSettings.driftIntensity = 'off' — badge never activates", () => {
    playerSettings.driftIntensity = 'off'
    const hud = createDriftTierHud()
    hud.update(1, 2)
    expect(slot.getAttribute('data-active')).toBeNull()
  })

  it("still renders the badge under 'subtle' intensity (it's the readable surface, not the flash)", () => {
    playerSettings.driftIntensity = 'subtle'
    const hud = createDriftTierHud()
    hud.update(1, 1)
    expect(slot.getAttribute('data-active')).toBe('1')
  })

  it('re-fires the flash on the FIRST tier-up of a new drift after a release', () => {
    const hud = createDriftTierHud()
    hud.update(1, 2)
    slot.removeAttribute('data-tierup')
    // Drift ends — prevTier should reset internally so the next
    // drift's first tier-up still flashes.
    hud.update(0, 0)
    hud.update(-1, 1) // new drift in the other direction, climbs to MT
    expect(slot.getAttribute('data-tierup')).toBe('1')
  })

  it('clamps an out-of-range tier defensively', () => {
    const hud = createDriftTierHud()
    hud.update(1, 99)
    expect(slot.getAttribute('data-tier')).toBe('3')
    hud.update(1, -5)
    // Drift still active so the badge stays visible; tier clamps to 0.
    expect(slot.getAttribute('data-tier')).toBe('0')
  })

  it('dispose() hides the slot and clears every data attribute', () => {
    const hud = createDriftTierHud()
    hud.update(1, 2)
    hud.dispose()
    expect(slot.hasAttribute('hidden')).toBe(true)
    expect(slot.getAttribute('data-active')).toBeNull()
    expect(slot.getAttribute('data-tier')).toBeNull()
    expect(slot.getAttribute('data-tierup')).toBeNull()
  })
})
