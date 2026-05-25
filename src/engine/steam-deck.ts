/**
 * Steam Deck detection + profile defaults.
 *
 * We can't ask the browser "are you running on a Deck?" directly — there's
 * no single canonical signal — so we combine three weak heuristics. The
 * detection is best-effort; the caller decides whether to act on it
 * (currently main.ts wires `applyDeckProfile()` only when `isLikelyDeck`).
 *
 * See docs/steam-deck.md for the full wrapper plan (Electron + Steamworks).
 */

export type DeckDetectionSignal = 'ua' | 'viewport' | 'gamepad'

export type DeckDetection = {
  isLikelyDeck: boolean
  signals: DeckDetectionSignal[]
}

// Default framerate cap applied to the Deck profile. The LCD model is
// 60 Hz; OLED is 90 Hz but spiking the APU to 90 fps drains the battery
// and pushes thermals. Default 60; users can override in Settings.
export const DECK_DEFAULT_FRAMERATE_CAP = 60

// Steam Input layer reports the virtual controller with one of these
// id substrings depending on Steam version + Big Picture mode. Match
// any of them.
const DECK_GAMEPAD_ID_PATTERNS = [/steam virtual gamepad/i, /steam controller/i, /steam deck/i]

/**
 * Check whether the current environment looks like a Steam Deck.
 * Returns the booleanised answer + the signals that fired, for logging.
 *
 * Heuristic stack (any single signal flips `isLikelyDeck` to true):
 *   1. UA contains "SteamDeck" — Gaming Mode's bundled browser sets this,
 *      Desktop Mode's Firefox does not. The Electron wrapper also appends
 *      this token when Steam launches us on Deck hardware (SteamDeck=1),
 *      so this is the reliable signal in a shipped desktop build.
 *   2. Viewport is exactly 1280×800 AND devicePixelRatio is 1 — the Deck's
 *      native panel resolution. Fragile (any 1280×800 window matches) but
 *      a useful tiebreaker on Deck-only builds.
 *   3. A gamepad is connected whose id matches the Steam virtual pad —
 *      this is the only signal that works in Desktop Mode + a third-party
 *      browser, but it's also the noisiest (any Steam Input remap on a
 *      desktop will match too).
 */
export function detectSteamDeck(): DeckDetection {
  const signals: DeckDetectionSignal[] = []

  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent ?? ''
    if (/steamdeck/i.test(ua)) signals.push('ua')
  }

  if (typeof window !== 'undefined') {
    const w = window.innerWidth
    const h = window.innerHeight
    const dpr = window.devicePixelRatio
    if (w === 1280 && h === 800 && dpr === 1) signals.push('viewport')
  }

  if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
    try {
      const pads = navigator.getGamepads()
      for (const pad of pads) {
        if (!pad) continue
        if (DECK_GAMEPAD_ID_PATTERNS.some((re) => re.test(pad.id))) {
          signals.push('gamepad')
          break
        }
      }
    } catch {
      // Some browsers throw if the page is not visible or permissions block
      // the API — treat as "no gamepad signal" rather than failing detection.
    }
  }

  return { isLikelyDeck: signals.length > 0, signals }
}

export type DeckProfile = {
  framerateCap: number
  preferGamepadInput: boolean
  requestFullscreenOnGesture: boolean
}

let activeProfile: DeckProfile | null = null

/**
 * Latch the Deck profile defaults. The caller (main.ts) is responsible
 * for invoking this once at boot if `detectSteamDeck().isLikelyDeck` —
 * we don't auto-run because the detection has false-positive paths
 * (any 1280×800 desktop browser will trip the viewport heuristic).
 *
 * Mutates `playerSettings` so the persisted profile sticks across
 * sessions (and so the Settings → Video rows reflect the active values
 * on first paint). User overrides via the Settings overlay are
 * preserved — we only write profile values when the player hasn't
 * already chosen something stricter. Specifically:
 *
 *   - `framerateCap`: respect any non-zero existing value (a player
 *     who set 30 fps for battery doesn't get bumped to 60 just because
 *     detection re-ran on a reload).
 *   - `fullscreenPreferred`: profile force-flips ON because Gaming
 *     Mode is broken without it. A Desktop-Mode user who flipped it
 *     OFF will see it return after a detection retrigger; that's a
 *     known edge case documented in `docs/steam-deck.md`.
 *
 * `preferGamepadInput` has no player-settings counterpart yet — it's
 * a future hook for the rebind menu's button-glyph swap.
 */
export function applyDeckProfile(): DeckProfile {
  const profile: DeckProfile = {
    framerateCap: DECK_DEFAULT_FRAMERATE_CAP,
    preferGamepadInput: true,
    requestFullscreenOnGesture: true,
  }
  activeProfile = profile

  // Push profile values into playerSettings via the setters so the
  // persisted blob reflects the Deck baseline and the Settings overlay
  // paints them correctly on next open. Lazy import to keep this module
  // dependency-light for the unit-test path that exercises detection
  // without spinning up the full settings store.
  void import('./player-settings').then(
    ({ playerSettings, setFramerateCap, setFullscreenPreferred }) => {
      if (playerSettings.framerateCap === 0) {
        setFramerateCap(profile.framerateCap)
      }
      if (!playerSettings.fullscreenPreferred) {
        setFullscreenPreferred(true)
      }
    },
  )

  // eslint-disable-next-line no-console
  console.info('[steam-deck] applied deck profile', profile)
  return profile
}

/** Returns the active profile if `applyDeckProfile()` ran, else null. */
export function getDeckProfile(): DeckProfile | null {
  return activeProfile
}

/** Test-only: clear the latched profile between cases. */
export function _resetDeckProfileForTests(): void {
  activeProfile = null
}
