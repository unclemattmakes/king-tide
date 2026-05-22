/**
 * Pitch-axis deadzone is wider than the steer deadzone — see
 * `PITCH_DEADZONE_FLOOR` in `src/engine/input/gamepad.ts`. Players hold
 * the left stick fwd-diagonally to "go and turn"; a small Y component
 * reads as a real dive command unless we clamp it to zero, which causes
 * the bow to plow on land and forward-flips in water. This test pins
 * the asymmetry so a future tightening of `gamepadDeadzone` (or a
 * refactor of the shape pipeline) can't quietly re-open the
 * accidental-dive failure.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { gamepadIntent } from '@/engine/input/gamepad'
import { playerSettings } from '@/engine/player-settings'

type MockGamepad = {
  axes: [number, number, number, number]
  buttons: { pressed: boolean; value: number }[]
}

function installMockPad(axes: [number, number, number, number]): void {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
  const pad: MockGamepad = { axes, buttons }
  ;(navigator as unknown as { getGamepads: () => MockGamepad[] }).getGamepads = () => [pad]
}

function clearMockPad(): void {
  ;(navigator as unknown as { getGamepads: () => MockGamepad[] }).getGamepads = () => []
}

describe('gamepad pitch deadzone', () => {
  const originalDeadzone = playerSettings.gamepadDeadzone

  afterEach(() => {
    clearMockPad()
    playerSettings.gamepadDeadzone = originalDeadzone
  })

  it('rejects small Y deflections (0.20) that would otherwise read as pitch', () => {
    // Fwd-diagonal: full steer, gentle stick-forward tilt. The X axis
    // (steer) clears its 0.12 deadzone easily; Y (pitch) must NOT, even
    // though 0.20 > steerDeadzone, because the pitch floor is wider.
    installMockPad([0.6, -0.2, 0, 0])
    const i = gamepadIntent()
    expect(i.steer).toBeGreaterThan(0)
    expect(i.pitch).toBe(0)
  })

  it('passes deliberate pitch input (full forward stick) through unchanged', () => {
    installMockPad([0, -1, 0, 0])
    const i = gamepadIntent()
    expect(i.pitch).toBeLessThan(-0.99)
  })

  it('passes deliberate pitch input (full back stick) through unchanged', () => {
    installMockPad([0, 1, 0, 0])
    const i = gamepadIntent()
    expect(i.pitch).toBeGreaterThan(0.99)
  })

  it('keeps the pitch floor independent of the steer deadzone slider', () => {
    // Driving `gamepadDeadzone` to 0 (slider all the way down) should
    // not collapse the pitch floor — small Y deflections still read 0.
    playerSettings.gamepadDeadzone = 0
    installMockPad([0, -0.2, 0, 0])
    const i = gamepadIntent()
    expect(i.pitch).toBe(0)
  })

  it('honours a player deadzone larger than the pitch floor', () => {
    // If the player has raised gamepadDeadzone past the pitch floor,
    // the slider wins — `pitchDeadzone()` is the MAX of the two.
    playerSettings.gamepadDeadzone = 0.4
    installMockPad([0, -0.35, 0, 0])
    const i = gamepadIntent()
    expect(i.pitch).toBe(0)
  })
})
