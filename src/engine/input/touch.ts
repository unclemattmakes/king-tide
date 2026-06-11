import { devSettings } from '../dev-settings'
import { emptyIntent, type Intent } from './intent'

/**
 * Virtual joystick + face buttons for mobile players.
 *
 * Layout: a thumb-stick anchored bottom-left drives steer (X) and pitch
 * (Y, inverted to match flight-stick / gamepad: stick UP = nose-down dive,
 * stick DOWN = nose-up lift). A column of BOOST / FIRE / BRAKE / THRUST
 * pads sits bottom-right; THRUST is the dedicated forward gas pedal so
 * the stick stays free for steering and pitch.
 *
 * Self-contained: injects its own DOM + CSS into <body> when installed and
 * stays inert (zeroed intent) on non-touch devices, so desktop users don't
 * see overlay controls.
 */
const STICK_RANGE_PX = 50 // max knob travel from center
const DEADZONE = 0.08

type ButtonKey = 'fire' | 'boost' | 'brake' | 'thrust'

let installed = false
let stickX = 0
let stickY = 0
const pressed = new Set<ButtonKey>()

let stickEl: HTMLDivElement | null = null
let knobEl: HTMLDivElement | null = null
let stickTouchId: number | null = null
let stickOriginX = 0
let stickOriginY = 0

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Touch stick share the same deadzone-rescale + curve shape as the gamepad
 * so the bike responds identically across input devices. Deadzone here is a
 * hardcoded fraction of the virtual stick radius (the touch UI has its own
 * tuning baked into the SVG); curve reads from `devSettings.stickCurve`.
 */
function shapeTouchAxis(v: number, deadzone: number = DEADZONE): number {
  const mag = Math.abs(v)
  if (mag < deadzone) return 0
  const t = Math.min((mag - deadzone) / (1 - deadzone), 1)
  return Math.sign(v) * t ** devSettings.stickCurve
}

/** Pitch axis wants a wider deadzone than steer. Mirrors the gamepad
 *  `PITCH_DEADZONE_FLOOR` rationale: small accidental Y deflections
 *  while steering shouldn't read as pitch commands. */
const TOUCH_PITCH_DEADZONE = 0.28

/** Coarse pointer (phone/tablet) or explicit `?touch=1` URL flag for testing. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.location?.search?.includes('touch=1')) return true
  } catch {
    /* ignore */
  }
  if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
    return true
  }
  if ('ontouchstart' in window) return true
  return (navigator?.maxTouchPoints ?? 0) > 0
}

/** True after `installTouch` has injected the overlay. */
export function isTouchEnabled(): boolean {
  return installed
}

/**
 * Pure conversion from raw stick + button state to an Intent. Exposed so
 * unit tests can pin the mapping without touching the DOM.
 */
export function computeTouchIntent(
  rawStickX: number,
  rawStickY: number,
  buttons: { fire: boolean; boost: boolean; brake: boolean; thrust: boolean },
): Intent {
  const intent = emptyIntent()
  const sx = shapeTouchAxis(clamp(rawStickX, -1, 1))
  const sy = shapeTouchAxis(clamp(rawStickY, -1, 1), TOUCH_PITCH_DEADZONE)
  intent.steer = sx
  // Stick Y → pitch, inverted to match the "flight stick" / gamepad convention:
  // push the stick UP (away from the player, toward the top of the screen)
  // → negative pitch → nose DOWN / dive. Pull DOWN → positive pitch → lift.
  // Mirrors the gamepad mapping where pushing the left stick forward dives
  // (gamepad axes[1] = -1 forward → intent.pitch = -1).
  // `0 - sy` instead of `-sy` to preserve +0 (the unary minus would flip
  // a deadzoned 0 into -0 and break Object.is-based test equality).
  intent.pitch = 0 - sy
  intent.throttle = buttons.thrust ? 1 : 0
  intent.brake = buttons.brake ? 1 : 0
  intent.fire = buttons.fire
  intent.boost = buttons.boost
  return intent
}

export function touchIntent(): Intent {
  return computeTouchIntent(stickX, stickY, {
    fire: pressed.has('fire'),
    boost: pressed.has('boost'),
    brake: pressed.has('brake'),
    thrust: pressed.has('thrust'),
  })
}

/**
 * Custom event dispatched on `window` when the player taps the on-screen
 * AUTO button — mirrors the keyboard `T` autopilot toggle. Decoupled via an
 * event (like {@link TOUCH_MENU_EVENT}) so this module doesn't import the
 * controls/sim layer.
 */
export const TOUCH_AUTOPILOT_EVENT = 'hb:touch-autopilot'

/**
 * Custom event the controls layer dispatches on `window` whenever auto-play
 * flips on/off from ANY source (touch AUTO button, keyboard `T`/`F1`, or the
 * `__hover.toggleAutoPlay()` console hook). The touch overlay listens so the
 * AUTO button's lit state stays in sync with the real autopilot state.
 * `detail.on` carries the new boolean.
 */
export const AUTOPILOT_STATE_EVENT = 'hb:autoplay-changed'

/** Max gap between two taps to count as a double-tap throttle lock. */
export const THROTTLE_DOUBLE_TAP_MS = 300

export interface ThrottleLockState {
  /** Throttle is latched on; releases no longer cut it. */
  locked: boolean
  /** `performance.now()` of the previous press, for double-tap timing. */
  lastPressMs: number
}

/**
 * Pure state transition for a THRUST button press, factored out so the
 * double-tap-to-lock behaviour can be unit-tested without the DOM.
 *
 *  - Tap while locked → unlock (throttle cuts on release as normal).
 *  - Second tap within {@link THROTTLE_DOUBLE_TAP_MS} → latch throttle on.
 *  - Otherwise → a normal momentary press, arming the double-tap window.
 *
 * `throttleOn` is whether the press itself should hold throttle; the release
 * handler keeps it held only while `locked`.
 */
export function throttlePressTransition(
  state: ThrottleLockState,
  nowMs: number,
): ThrottleLockState & { throttleOn: boolean } {
  if (state.locked) {
    // Any tap while latched disengages the lock; throttle falls on release.
    return { locked: false, lastPressMs: 0, throttleOn: false }
  }
  if (nowMs - state.lastPressMs <= THROTTLE_DOUBLE_TAP_MS) {
    // Second quick tap latches throttle on.
    return { locked: true, lastPressMs: 0, throttleOn: true }
  }
  // First / lone tap: normal momentary throttle, arm the double-tap timer.
  return { locked: false, lastPressMs: nowMs, throttleOn: true }
}

const STYLE = `
#touch-ui { position: fixed; inset: 0; pointer-events: none; z-index: 100;
  touch-action: none; -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent; }
/* When a full-screen overlay (cold-boot menu, pause, finish, cup results,
   settings) is up, suppress the in-race touch UI so the joystick / buttons
   don't sit on top of menu cards. */
body.menu-active #touch-ui,
body.paused-for-menu #touch-ui,
body.touch-ui-hidden #touch-ui { display: none; }
#touch-ui .stick {
  position: absolute; bottom: max(28px, env(safe-area-inset-bottom));
  left: max(28px, env(safe-area-inset-left));
  width: 140px; height: 140px; border-radius: 50%;
  background: rgba(255,255,255,0.06);
  border: 2px solid rgba(255,255,255,0.22);
  pointer-events: auto; touch-action: none;
}
#touch-ui .knob {
  position: absolute; top: 50%; left: 50%; width: 60px; height: 60px;
  margin: -30px 0 0 -30px; border-radius: 50%;
  background: rgba(255,204,102,0.55);
  border: 2px solid rgba(255,255,255,0.6);
  transform: translate(0px, 0px);
  pointer-events: none;
}
#touch-ui .buttons {
  position: absolute; bottom: max(28px, env(safe-area-inset-bottom));
  right: max(28px, env(safe-area-inset-right));
  display: flex; flex-direction: column; gap: 12px; align-items: flex-end;
  pointer-events: none;
}
#touch-ui .btn {
  width: 76px; height: 76px; border-radius: 50%;
  background: rgba(255,255,255,0.10);
  border: 2px solid rgba(255,255,255,0.30);
  color: #fff; font: bold 12px ui-monospace, monospace; letter-spacing: 1px;
  display: flex; align-items: center; justify-content: center;
  pointer-events: auto; touch-action: none; user-select: none;
}
#touch-ui .btn.fire { background: rgba(255,80,80,0.32); border-color: rgba(255,140,140,0.7); }
#touch-ui .btn.boost { background: rgba(80,160,255,0.32); border-color: rgba(140,200,255,0.7); }
#touch-ui .btn.brake { background: rgba(255,180,40,0.30); border-color: rgba(255,220,120,0.7); }
#touch-ui .btn.thrust { background: rgba(120,220,120,0.34); border-color: rgba(180,255,180,0.75); }
#touch-ui .btn.active { background: rgba(255,255,255,0.45); }
/* THRUST latched on via double-tap — a steady ring + lit fill so the player
   can see at a glance the gas is held hands-free. */
#touch-ui .btn.thrust.locked {
  background: rgba(120,220,120,0.6);
  border-color: rgba(210,255,210,0.95);
  box-shadow: 0 0 0 3px rgba(180,255,180,0.55), inset 0 0 10px rgba(255,255,255,0.35);
}
/* MENU button — anchored top-left, well clear of the centered race timer
   and bottom-corner stick / button column. Players tap it to open the
   pause overlay (same as keyboard Esc / gamepad Start). */
#touch-ui .menu-btn {
  position: absolute; top: max(10px, env(safe-area-inset-top));
  left: max(10px, env(safe-area-inset-left));
  min-width: 56px; height: 40px; padding: 0 12px;
  border-radius: 22px;
  background: rgba(7, 30, 38, 0.78);
  border: 1px solid rgba(255,255,255,0.28);
  color: #fff5e1;
  font: 800 12px Nunito, system-ui, sans-serif; letter-spacing: 1px;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  pointer-events: auto; touch-action: manipulation; user-select: none;
  -webkit-tap-highlight-color: transparent;
}
#touch-ui .menu-btn .glyph {
  display: inline-flex; flex-direction: column; gap: 3px;
}
#touch-ui .menu-btn .glyph span {
  display: block; width: 14px; height: 2px;
  background: currentColor; border-radius: 1px;
}
#touch-ui .menu-btn.active { background: rgba(77,214,255,0.22); border-color: rgba(77,214,255,0.7); }
/* AUTO button — top-right mirror of MENU. Tap toggles autopilot (same as the
   keyboard T binding); the lit engaged state tracks the live autopilot
   state via AUTOPILOT_STATE_EVENT. */
#touch-ui .auto-btn {
  position: absolute; top: max(10px, env(safe-area-inset-top));
  right: max(10px, env(safe-area-inset-right));
  min-width: 56px; height: 40px; padding: 0 14px;
  border-radius: 22px;
  background: rgba(7, 30, 38, 0.78);
  border: 1px solid rgba(255,255,255,0.28);
  color: #fff5e1;
  font: 800 12px Nunito, system-ui, sans-serif; letter-spacing: 1px;
  display: flex; align-items: center; justify-content: center;
  pointer-events: auto; touch-action: manipulation; user-select: none;
  -webkit-tap-highlight-color: transparent;
}
#touch-ui .auto-btn.pressing { background: rgba(77,214,255,0.22); border-color: rgba(77,214,255,0.7); }
/* Engaged: lit amber pill so an active autopilot is unmistakable. */
#touch-ui .auto-btn.engaged {
  background: rgba(255,196,77,0.30);
  border-color: rgba(255,210,120,0.95);
  color: #fff4dd;
  box-shadow: 0 0 0 2px rgba(255,200,90,0.45), inset 0 0 8px rgba(255,210,120,0.3);
}
`

function updateStickFromPoint(clientX: number, clientY: number) {
  const dx = clientX - stickOriginX
  const dy = clientY - stickOriginY
  const len = Math.hypot(dx, dy)
  let nx: number
  let ny: number
  if (len > STICK_RANGE_PX) {
    nx = (dx / len) * STICK_RANGE_PX
    ny = (dy / len) * STICK_RANGE_PX
  } else {
    nx = dx
    ny = dy
  }
  stickX = nx / STICK_RANGE_PX
  // Screen Y grows downward; flip so positive stickY = stick pushed UP.
  // computeTouchIntent then inverts again (stick up → pitch -1 = dive)
  // to match the gamepad/flight-stick convention.
  stickY = -ny / STICK_RANGE_PX
  if (knobEl) knobEl.style.transform = `translate(${nx}px, ${ny}px)`
}

function resetStick() {
  stickX = 0
  stickY = 0
  stickTouchId = null
  if (knobEl) knobEl.style.transform = 'translate(0px, 0px)'
}

function installStickHandlers(stick: HTMLDivElement) {
  stick.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault()
      if (stickTouchId !== null) return
      const t = e.changedTouches[0]
      if (!t) return
      const rect = stick.getBoundingClientRect()
      stickOriginX = rect.left + rect.width / 2
      stickOriginY = rect.top + rect.height / 2
      stickTouchId = t.identifier
      updateStickFromPoint(t.clientX, t.clientY)
    },
    { passive: false },
  )
  window.addEventListener(
    'touchmove',
    (e) => {
      if (stickTouchId === null) return
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === stickTouchId) {
          updateStickFromPoint(t.clientX, t.clientY)
          e.preventDefault()
          return
        }
      }
    },
    { passive: false },
  )
  const endTouch = (e: TouchEvent) => {
    if (stickTouchId === null) return
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === stickTouchId) {
        resetStick()
        return
      }
    }
  }
  window.addEventListener('touchend', endTouch)
  window.addEventListener('touchcancel', endTouch)
  window.addEventListener('blur', resetStick)
}

/**
 * Build a face button. Passing `lockable` (used for THRUST) enables
 * double-tap-to-latch: two quick taps hold throttle on hands-free, and a
 * single tap while latched releases it. The lit `.locked` class shows the
 * latched state. Non-lockable buttons are plain momentary holds.
 */
function makeButton(cls: string, label: string, key: ButtonKey, lockable = false): HTMLDivElement {
  const b = document.createElement('div')
  b.className = `btn ${cls}`
  b.textContent = label
  let lock: ThrottleLockState = { locked: false, lastPressMs: 0 }
  const press = (e: Event) => {
    e.preventDefault()
    if (lockable) {
      const next = throttlePressTransition(lock, performance.now())
      lock = { locked: next.locked, lastPressMs: next.lastPressMs }
      if (next.throttleOn) {
        pressed.add(key)
        b.classList.add('active')
      } else {
        pressed.delete(key)
        b.classList.remove('active')
      }
      b.classList.toggle('locked', lock.locked)
      return
    }
    pressed.add(key)
    b.classList.add('active')
  }
  const release = () => {
    // A latched throttle ignores releases — it's held until the next tap.
    if (lockable && lock.locked) return
    pressed.delete(key)
    b.classList.remove('active')
  }
  b.addEventListener('touchstart', press, { passive: false })
  b.addEventListener('touchend', release)
  b.addEventListener('touchcancel', release)
  // Mouse fallback so desktop devtools "device emulation" can drive the UI.
  b.addEventListener('mousedown', press)
  window.addEventListener('mouseup', release)
  return b
}

/**
 * Custom event dispatched on `window` when the player taps the on-screen
 * MENU button. Whoever owns the pause-menu state (`installControls`) wires
 * the listener — kept decoupled so this module doesn't import controls/sim.
 */
export const TOUCH_MENU_EVENT = 'hb:touch-menu'

function makeMenuButton(): HTMLDivElement {
  const b = document.createElement('div')
  b.className = 'menu-btn'
  b.setAttribute('role', 'button')
  b.setAttribute('aria-label', 'Open pause menu')
  const glyph = document.createElement('span')
  glyph.className = 'glyph'
  glyph.innerHTML = '<span></span><span></span><span></span>'
  const label = document.createElement('span')
  label.textContent = 'MENU'
  b.appendChild(glyph)
  b.appendChild(label)
  let pressed = false
  const press = (e: Event) => {
    e.preventDefault()
    pressed = true
    b.classList.add('active')
  }
  const release = (e: Event) => {
    if (!pressed) return
    pressed = false
    b.classList.remove('active')
    // Only fire on a clean release over the button. `touchend` always
    // counts (the OS already handles cancel separately); for mouse we
    // gate on the original element so a drag-off doesn't accidentally
    // open the menu.
    if (e.type === 'touchend' || e.type === 'mouseup') {
      window.dispatchEvent(new CustomEvent(TOUCH_MENU_EVENT))
    }
  }
  const cancel = () => {
    pressed = false
    b.classList.remove('active')
  }
  b.addEventListener('touchstart', press, { passive: false })
  b.addEventListener('touchend', release)
  b.addEventListener('touchcancel', cancel)
  b.addEventListener('mousedown', press)
  b.addEventListener('mouseup', release)
  b.addEventListener('mouseleave', cancel)
  return b
}

/**
 * AUTO button — anchored top-right, mirroring the MENU button at top-left and
 * well clear of the bottom-corner stick / face-button column so it isn't
 * brushed mid-race. A tap toggles autopilot, same as the keyboard `T` binding;
 * the lit `.engaged` state is driven by {@link AUTOPILOT_STATE_EVENT} so it
 * tracks the real autopilot state no matter how it was toggled.
 */
function makeAutopilotButton(): HTMLDivElement {
  const b = document.createElement('div')
  b.className = 'auto-btn'
  b.setAttribute('role', 'button')
  b.setAttribute('aria-label', 'Toggle autopilot')
  b.setAttribute('aria-pressed', 'false')
  b.textContent = 'AUTO'
  let pressing = false
  const press = (e: Event) => {
    e.preventDefault()
    pressing = true
    b.classList.add('pressing')
  }
  const release = (e: Event) => {
    if (!pressing) return
    pressing = false
    b.classList.remove('pressing')
    // Fire only on a clean release over the button (mirrors makeMenuButton):
    // touchend always counts; for mouse we gate so a drag-off doesn't toggle.
    if (e.type === 'touchend' || e.type === 'mouseup') {
      window.dispatchEvent(new CustomEvent(TOUCH_AUTOPILOT_EVENT))
    }
  }
  const cancel = () => {
    pressing = false
    b.classList.remove('pressing')
  }
  b.addEventListener('touchstart', press, { passive: false })
  b.addEventListener('touchend', release)
  b.addEventListener('touchcancel', cancel)
  b.addEventListener('mousedown', press)
  b.addEventListener('mouseup', release)
  b.addEventListener('mouseleave', cancel)
  // Keep the lit state in sync with the real autopilot state (also toggled by
  // keyboard `T` / console hook), not just our own taps.
  window.addEventListener(AUTOPILOT_STATE_EVENT, (e) => {
    const on = Boolean((e as CustomEvent<{ on?: boolean }>).detail?.on)
    b.classList.toggle('engaged', on)
    b.setAttribute('aria-pressed', String(on))
  })
  return b
}

export function installTouch(): void {
  if (installed) return
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (!isTouchDevice()) return
  installed = true

  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)

  const ui = document.createElement('div')
  ui.id = 'touch-ui'

  stickEl = document.createElement('div')
  stickEl.className = 'stick'
  knobEl = document.createElement('div')
  knobEl.className = 'knob'
  stickEl.appendChild(knobEl)
  ui.appendChild(stickEl)

  const buttons = document.createElement('div')
  buttons.className = 'buttons'
  buttons.appendChild(makeButton('boost', 'BOOST', 'boost'))
  buttons.appendChild(makeButton('fire', 'FIRE', 'fire'))
  buttons.appendChild(makeButton('brake', 'BRAKE', 'brake'))
  // THRUST is lockable: double-tap latches throttle on, tap again releases.
  buttons.appendChild(makeButton('thrust', 'THRUST', 'thrust', true))
  ui.appendChild(buttons)

  ui.appendChild(makeMenuButton())
  ui.appendChild(makeAutopilotButton())

  document.body.appendChild(ui)
  installStickHandlers(stickEl)
}
