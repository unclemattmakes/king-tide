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
function shapeTouchAxis(v: number): number {
  const mag = Math.abs(v)
  if (mag < DEADZONE) return 0
  const t = Math.min((mag - DEADZONE) / (1 - DEADZONE), 1)
  return Math.sign(v) * t ** devSettings.stickCurve
}

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
  const sy = shapeTouchAxis(clamp(rawStickY, -1, 1))
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

const STYLE = `
#touch-ui { position: fixed; inset: 0; pointer-events: none; z-index: 100;
  touch-action: none; -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent; }
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

function makeButton(cls: string, label: string, key: ButtonKey): HTMLDivElement {
  const b = document.createElement('div')
  b.className = `btn ${cls}`
  b.textContent = label
  const press = (e: Event) => {
    e.preventDefault()
    pressed.add(key)
    b.classList.add('active')
  }
  const release = () => {
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
  buttons.appendChild(makeButton('thrust', 'THRUST', 'thrust'))
  ui.appendChild(buttons)

  document.body.appendChild(ui)
  installStickHandlers(stickEl)
}
