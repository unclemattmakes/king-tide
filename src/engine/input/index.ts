import { gamepadIntent, snapshotGamepads } from './gamepad'
import { emptyIntent, type Intent } from './intent'
import { installKeyboard, keyboardIntent } from './keyboard'

export { emptyIntent, type Intent, snapshotGamepads }

export function installInput(): void {
  installKeyboard()
}

export function readPlayerIntent(): Intent {
  const pads = snapshotGamepads()
  if (pads.length > 0) return gamepadIntent()
  return keyboardIntent()
}

export function inputSourceLabel(): string {
  const pads = snapshotGamepads()
  if (pads.length > 0) return `gamepad (${pads[0]!.id.slice(0, 32)})`
  return 'keyboard'
}
