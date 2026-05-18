/**
 * Accessibility service — the bridge between `playerSettings`
 * accessibility fields and the live DOM + render systems.
 *
 * Two surfaces:
 *
 *  1. `applyAccessibilityToDom()` — paints data-attrs on `document.body`
 *     so CSS rules in `index.html` can scale text, force opaque HUD
 *     backgrounds, dampen pulse animations, and force-on the
 *     prefers-reduced-motion rule regardless of the OS setting.
 *
 *  2. `onAccessibilityChange(fn)` — hand-rolled pub/sub for HUDs that
 *     paint color directly to canvas (the minimap dots) and so need a
 *     repaint signal when the palette flips mid-session. Mirrors
 *     `mp-status.ts`'s pattern intentionally so the two pub/subs read
 *     the same way to future maintainers.
 *
 * No global state of its own beyond the listener set — the source of
 * truth is `playerSettings`. Setters in `player-settings.ts` call
 * `notifyAccessibilityChange()` after they mutate the live struct.
 */

import { type HudPalette, paletteFor } from '@/engine/accessibility/palettes'
import { playerSettings } from '@/engine/player-settings'

const listeners = new Set<() => void>()

/** Push the live accessibility settings into `document.body` data-attrs.
 *  Safe to call before the DOM is ready (no-ops if `document` / `body`
 *  is missing — happens during early test imports). Idempotent — each
 *  attr is written every call rather than dirty-tracked because the
 *  surface is tiny. */
export function applyAccessibilityToDom(): void {
  if (typeof document === 'undefined' || !document.body) return
  const b = document.body
  b.dataset.cb = playerSettings.colorblindMode
  b.dataset.largeText = playerSettings.largeText ? '1' : '0'
  b.dataset.highContrast = playerSettings.highContrast ? '1' : '0'
  b.dataset.reducedFlash = playerSettings.reducedFlash ? '1' : '0'
  // The override is opt-in: 'on' forces the prefers-reduced-motion CSS
  // rules to apply regardless of the OS setting; 'off' (default) lets
  // the OS-level @media query do its thing without interference.
  b.dataset.reducedMotionOverride = playerSettings.reducedMotion ? 'on' : 'off'
}

/** Snapshot of the live palette for the current mode. Render systems
 *  call this once at paint time + subscribe to `onAccessibilityChange`
 *  to re-call after a mode switch. */
export function currentHudPalette(): HudPalette {
  return paletteFor(playerSettings.colorblindMode)
}

/** Scalar in `[0..1]` multiplied into any camera/HUD shake amount.
 *  Default `1.0` preserves the current feel; `0` disables shake. */
export function currentScreenShakeScalar(): number {
  return playerSettings.screenShakeIntensity
}

/** True when chase-cam roll + anti-grav inversion should be dampened.
 *  Layered on top of the existing `antiGravCameraIntensity` row — this
 *  is the *separate* "I get queasy on the cosmetic camera roll" toggle.
 *  Renderers that already read `antiGravCameraIntensity` can multiply
 *  in `0.5` when this is true. */
export function isMotionSicknessReductionOn(): boolean {
  return playerSettings.motionSicknessReduction
}

/** Subscribe to accessibility changes — fires after each setter in
 *  `player-settings.ts` mutates a field. Returns an unsubscribe fn. */
export function onAccessibilityChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Fired by the accessibility setters in `player-settings.ts` after a
 *  field changes. Internal — consumers use `onAccessibilityChange`. */
export function notifyAccessibilityChange(): void {
  for (const fn of listeners) fn()
}

/** Test-only — drop all listeners. Used by `accessibility.test.ts` so
 *  one test's subscriber doesn't bleed into another's count. */
export function _resetAccessibilityListenersForTest(): void {
  listeners.clear()
}
