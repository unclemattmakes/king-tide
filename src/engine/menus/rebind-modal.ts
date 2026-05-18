/**
 * Rebind modal — keyboard + gamepad action remapping.
 *
 * Opened from Settings → Controls → "Rebind keyboard" / "Rebind
 * gamepad". The modal lists one row per rebindable action: action
 * label, the current primary-binding chip, and (keyboard only) a
 * read-only secondary-hint chip. Clicking the chip enters capture
 * mode — the next key / button press becomes the new primary, with
 * swap semantics that keep every action reachable.
 *
 * Persistence flows through `playerSettings`: `setKeyboardBindings` /
 * `setGamepadBindings` write the live table + persist to localStorage.
 *
 * Gamepad capture polls `navigator.getGamepads()` on rAF and ignores
 * LT/RT (analog triggers) — those drive throttle / brake and would
 * otherwise capture every time the player squeezed the trigger.
 *
 * Escape closes whichever surface is in front: capture if active, else
 * the modal itself.
 */

import {
  assignGamepadBinding,
  assignKeyboardPrimary,
  cloneGamepadBindings,
  cloneKeyboardBindings,
  formatGamepadButton,
  formatKeyCode,
  GAMEPAD_ACTION_LABEL,
  GAMEPAD_ACTIONS,
  type GamepadAction,
  type GamepadBindings,
  KEYBOARD_ACTION_LABEL,
  KEYBOARD_ACTIONS,
  type KeyboardAction,
  type KeyboardBindings,
} from '@/engine/input/bindings'
import { pollGamepadButtonPress } from '@/engine/input/gamepad'
import {
  playerSettings,
  resetGamepadBindings,
  resetKeyboardBindings,
  setGamepadBindings,
  setKeyboardBindings,
} from '@/engine/player-settings'

export type RebindMode = 'keyboard' | 'gamepad'

export interface RebindModalHandle {
  open(mode: RebindMode): void
  close(): void
  isOpen(): boolean
}

let installed: RebindModalHandle | null = null

export function installRebindModal(): RebindModalHandle {
  if (installed) return installed

  const root = document.getElementById('rebind-menu')
  if (!root) {
    const noop: RebindModalHandle = {
      open() {},
      close() {},
      isOpen: () => false,
    }
    return noop
  }
  const rootEl = root
  const _titleEl = rootEl.querySelector<HTMLElement>('#rb-title')
  const _subEl = rootEl.querySelector<HTMLElement>('#rb-sub')
  const _listEl = rootEl.querySelector<HTMLElement>('#rb-list')
  const _hintEl = rootEl.querySelector<HTMLElement>('#rb-hint')
  const _resetBtn = rootEl.querySelector<HTMLButtonElement>('#rb-reset')
  const _doneBtn = rootEl.querySelector<HTMLButtonElement>('#rb-done')
  if (!_titleEl || !_subEl || !_listEl || !_hintEl || !_resetBtn || !_doneBtn) {
    const noop: RebindModalHandle = { open() {}, close() {}, isOpen: () => false }
    return noop
  }
  // Captured as non-nullable locals so the closures below don't need
  // repeated null assertions.
  const titleEl: HTMLElement = _titleEl
  const subEl: HTMLElement = _subEl
  const listEl: HTMLElement = _listEl
  const hintEl: HTMLElement = _hintEl
  const resetBtn: HTMLButtonElement = _resetBtn
  const doneBtn: HTMLButtonElement = _doneBtn

  let mode: RebindMode = 'keyboard'
  let capturing: { kind: 'keyboard'; action: KeyboardAction } | {
    kind: 'gamepad'
    action: GamepadAction
  } | null = null
  let gamepadPollHandle: number | null = null
  let previousFocus: HTMLElement | null = null
  let previousPressed: Set<number> = new Set()

  function renderHeader(): void {
    if (mode === 'keyboard') {
      titleEl.textContent = 'REBIND KEYBOARD'
      subEl.textContent = 'Click a key chip to assign a new binding. Secondary keys stay at defaults.'
    } else {
      titleEl.textContent = 'REBIND GAMEPAD'
      subEl.textContent = 'Click a button chip then press the new button. LT / RT (triggers) are reserved.'
    }
  }

  function renderHint(): void {
    if (!capturing) {
      hintEl.classList.remove('show')
      hintEl.textContent = ''
      return
    }
    if (capturing.kind === 'keyboard') {
      hintEl.textContent = `Press a key for ${KEYBOARD_ACTION_LABEL[capturing.action]}… (Esc to cancel)`
    } else {
      hintEl.textContent = `Press a button for ${GAMEPAD_ACTION_LABEL[capturing.action]}… (Esc to cancel)`
    }
    hintEl.classList.add('show')
  }

  function renderList(): void {
    listEl.innerHTML = ''
    if (mode === 'keyboard') {
      const bindings = playerSettings.keyboardBindings
      for (const action of KEYBOARD_ACTIONS) {
        listEl.appendChild(buildKeyboardRow(action, bindings))
      }
    } else {
      const bindings = playerSettings.gamepadBindings
      for (const action of GAMEPAD_ACTIONS) {
        listEl.appendChild(buildGamepadRow(action, bindings))
      }
    }
  }

  function buildKeyboardRow(action: KeyboardAction, bindings: KeyboardBindings): HTMLElement {
    const row = document.createElement('div')
    row.className = 'rb-row'
    row.dataset.action = action

    const lbl = document.createElement('div')
    lbl.className = 'rb-lbl'
    lbl.textContent = KEYBOARD_ACTION_LABEL[action]
    row.appendChild(lbl)

    const ctrl = document.createElement('div')
    ctrl.className = 'rb-ctrl'
    const primaryChip = document.createElement('button')
    primaryChip.type = 'button'
    primaryChip.className = 'rb-chip'
    primaryChip.textContent = formatKeyCode(bindings[action].primary)
    if (capturing?.kind === 'keyboard' && capturing.action === action) {
      primaryChip.classList.add('listening')
      primaryChip.textContent = 'PRESS A KEY…'
    }
    primaryChip.addEventListener('click', () => {
      beginCapture({ kind: 'keyboard', action })
    })
    ctrl.appendChild(primaryChip)

    const secondary = bindings[action].secondary
    const secChip = document.createElement('span')
    secChip.className = 'rb-chip secondary'
    secChip.textContent = secondary !== null ? `also: ${formatKeyCode(secondary)}` : ''
    if (secondary !== null) ctrl.appendChild(secChip)
    row.appendChild(ctrl)

    return row
  }

  function buildGamepadRow(action: GamepadAction, bindings: GamepadBindings): HTMLElement {
    const row = document.createElement('div')
    row.className = 'rb-row'
    row.dataset.action = action

    const lbl = document.createElement('div')
    lbl.className = 'rb-lbl'
    lbl.textContent = GAMEPAD_ACTION_LABEL[action]
    row.appendChild(lbl)

    const ctrl = document.createElement('div')
    ctrl.className = 'rb-ctrl'
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'rb-chip'
    chip.textContent = formatGamepadButton(bindings[action])
    if (capturing?.kind === 'gamepad' && capturing.action === action) {
      chip.classList.add('listening')
      chip.textContent = 'PRESS A BUTTON…'
    }
    chip.addEventListener('click', () => {
      beginCapture({ kind: 'gamepad', action })
    })
    ctrl.appendChild(chip)
    row.appendChild(ctrl)
    return row
  }

  function beginCapture(c: typeof capturing): void {
    capturing = c
    if (c?.kind === 'gamepad') {
      previousPressed = currentlyPressedButtons()
      startGamepadPoll()
    }
    renderList()
    renderHint()
  }

  function cancelCapture(): void {
    if (!capturing) return
    capturing = null
    stopGamepadPoll()
    renderList()
    renderHint()
  }

  function commitKeyboardCapture(code: string): void {
    if (!capturing || capturing.kind !== 'keyboard') return
    const next = assignKeyboardPrimary(playerSettings.keyboardBindings, capturing.action, code)
    setKeyboardBindings(next)
    capturing = null
    renderList()
    renderHint()
  }

  function commitGamepadCapture(index: number): void {
    if (!capturing || capturing.kind !== 'gamepad') return
    const next = assignGamepadBinding(playerSettings.gamepadBindings, capturing.action, index)
    setGamepadBindings(next)
    capturing = null
    stopGamepadPoll()
    renderList()
    renderHint()
  }

  function onKey(e: KeyboardEvent): void {
    if (!rootEl.classList.contains('show')) return
    if (e.code === 'Escape') {
      if (capturing) cancelCapture()
      else close()
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (capturing && capturing.kind === 'keyboard') {
      // Skip pure modifier "phantom" presses — players holding shift to
      // capture a different action shouldn't capture shift itself unless
      // they release-and-press. Allow shift/ctrl/alt/meta after a short
      // settle by treating all keys uniformly.
      commitKeyboardCapture(e.code)
      e.preventDefault()
      e.stopPropagation()
    }
  }

  function currentlyPressedButtons(): Set<number> {
    const out = new Set<number>()
    const pads = navigator.getGamepads?.() ?? []
    for (const pad of pads) {
      if (!pad) continue
      for (let i = 0; i < pad.buttons.length; i++) {
        if (i === 6 || i === 7) continue // skip analog triggers
        if (pad.buttons[i]?.pressed) out.add(i)
      }
    }
    return out
  }

  function startGamepadPoll(): void {
    if (gamepadPollHandle !== null) return
    const tick = () => {
      if (!capturing || capturing.kind !== 'gamepad') {
        gamepadPollHandle = null
        return
      }
      // Only capture buttons that weren't already pressed when capture
      // started — guards against "double-press" if the player held LB
      // through the click-into-capture flow.
      const fresh = pollGamepadButtonPress()
      if (fresh !== null && !previousPressed.has(fresh)) {
        commitGamepadCapture(fresh)
        return
      }
      // Re-derive previousPressed every frame so once a button is
      // released it becomes "fresh" again.
      previousPressed = currentlyPressedButtons()
      gamepadPollHandle = requestAnimationFrame(tick)
    }
    gamepadPollHandle = requestAnimationFrame(tick)
  }

  function stopGamepadPoll(): void {
    if (gamepadPollHandle !== null) {
      cancelAnimationFrame(gamepadPollHandle)
      gamepadPollHandle = null
    }
  }

  function open(nextMode: RebindMode): void {
    mode = nextMode
    capturing = null
    if (rootEl.classList.contains('show')) {
      renderHeader()
      renderList()
      renderHint()
      return
    }
    previousFocus = document.activeElement as HTMLElement | null
    rootEl.classList.add('show')
    rootEl.setAttribute('aria-hidden', 'false')
    renderHeader()
    renderList()
    renderHint()
    window.addEventListener('keydown', onKey, true)
  }

  function close(): void {
    if (!rootEl.classList.contains('show')) return
    cancelCapture()
    rootEl.classList.remove('show')
    rootEl.setAttribute('aria-hidden', 'true')
    window.removeEventListener('keydown', onKey, true)
    previousFocus?.focus?.()
    previousFocus = null
  }

  resetBtn.addEventListener('click', () => {
    if (mode === 'keyboard') {
      resetKeyboardBindings()
      // Touch live ref so any cached closure picks up the swap.
      cloneKeyboardBindings(playerSettings.keyboardBindings)
    } else {
      resetGamepadBindings()
      cloneGamepadBindings(playerSettings.gamepadBindings)
    }
    cancelCapture()
    renderList()
  })
  doneBtn.addEventListener('click', close)

  installed = {
    open,
    close,
    isOpen: () => rootEl.classList.contains('show'),
  }
  return installed
}
