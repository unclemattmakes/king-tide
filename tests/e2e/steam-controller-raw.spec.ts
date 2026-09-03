/**
 * 2026 Steam Controller (raw layout) — end-to-end input verification.
 *
 * On Linux/SteamOS browsers the 2026 Steam Controller (and the Steam
 * Deck's built-in pad in Desktop Mode) reaches the Gamepad API with
 * `mapping: ""` in raw hid-steam order: A on button 3, Menu/Start on 12,
 * D-pad on 16–19, analog triggers on axes 8/9, and the left touchpad
 * click squatting on button 0 where the old code read A. Before the
 * pad-profiles normalization layer, that meant steering worked but
 * throttle and every button were dead.
 *
 * This spec injects a synthetic raw pad (exact fixture layout derived in
 * src/engine/input/pad-profiles.ts) via addInitScript and drives the
 * REAL input path — navigator.getGamepads → pad-profiles → gamepadIntent
 * → merged player intent → sim — in a real headed browser. The only
 * override use is a boot-time pulse to skip the pre-race phase
 * (`bootRacing`); every assertion runs with the override nulled, so if
 * the remap regresses, the bike stops moving.
 */
import { waitFullyBooted } from './helpers/boot'
import { expect, test } from './helpers/console-errors'

// Raw indices per the hid-steam capability set (see pad-profiles.ts).
const RAW = {
  BTN_LPAD_CLICK: 0,
  BTN_A: 3,
  BTN_MENU: 12,
  AXIS_LX: 0,
  AXIS_RT: 8,
  AXIS_LT: 9,
} as const

declare global {
  interface Window {
    __fakePad: {
      set(buttons: Partial<Record<number, boolean>>, axes?: Partial<Record<number, number>>): void
      reset(): void
    }
  }
}

/** Boot into a live (unlocked) race. Setting a non-null intent override
 *  fast-forwards the cinematic intro + 3/2/1 (debug.ts wires
 *  `setIntentOverride` → `skipCountdown`); nulling it immediately hands
 *  control back, so — unlike override-driven specs — input here still
 *  flows through the REAL gamepad path. */
async function bootRacing(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/?autostart=1')
  await waitFullyBooted(page, { timeout: 20_000 })
  await page.evaluate(() => {
    const idle = {
      throttle: 0,
      steer: 0,
      brake: 0,
      fire: false,
      boost: false,
      pitch: 0,
      trickLeft: false,
      trickRight: false,
    }
    window.__hover!.setIntentOverride(idle)
    window.__hover!.setIntentOverride(null)
  })
}

/** Install a fake 2026 Steam Controller before any app code runs. */
async function withRawSteamPad(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const pad = {
      id: 'Steam Controller (Vendor: 28de Product: 1302)',
      index: 0,
      mapping: '',
      connected: true,
      timestamp: 1,
      axes: [0, 0, 0, 0, 0, 0, 0, 0, -1, -1] as number[],
      buttons: Array.from({ length: 24 }, () => ({
        pressed: false,
        touched: false,
        value: 0,
      })),
      vibrationActuator: null,
      hapticActuators: [],
    }
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => [pad],
    })
    window.__fakePad = {
      set(buttons, axes = {}) {
        for (const [k, v] of Object.entries(buttons)) {
          pad.buttons[Number(k)] = { pressed: !!v, touched: !!v, value: v ? 1 : 0 }
        }
        for (const [k, v] of Object.entries(axes)) {
          pad.axes[Number(k)] = v ?? 0
        }
        pad.timestamp = performance.now()
      },
      reset() {
        pad.buttons = pad.buttons.map(() => ({ pressed: false, touched: false, value: 0 }))
        pad.axes = [0, 0, 0, 0, 0, 0, 0, 0, -1, -1]
        pad.timestamp = performance.now()
      },
    }
  })
}

test.describe('2026 Steam Controller raw layout', () => {
  test('is recognized, throttles from the raw trigger axis, and moves the bike', async ({
    page,
    consoleErrors,
  }) => {
    await withRawSteamPad(page)
    await bootRacing(page)

    // The runtime recognized the pad as a raw Steam layout.
    const snapshot = await page.evaluate(() => window.__hover!.gamepads())
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]?.layout).toBe('steam-raw')

    const initial = await page.evaluate(() => window.__hover!.player()!)

    // Full right-trigger pull on the RAW axis (8; rest −1 → pulled +1).
    await page.evaluate(({ AXIS_RT }) => window.__fakePad.set({}, { [AXIS_RT]: 1 }), RAW)

    // The merged player intent must read ~full throttle…
    await page.waitForFunction(() => (window.__hover?.intent().throttle ?? 0) > 0.9, undefined, {
      timeout: 3000,
    })
    // …and the bike must actually accelerate away from spawn.
    await page.waitForFunction(
      (start) => {
        const p = window.__hover?.player()
        return !!p && p.speed > 10 && Math.abs(p.position.z - start.z) > 5
      },
      initial.position,
      { timeout: 5000 },
    )

    consoleErrors.assertNone()
  })

  test('face buttons land on standard slots: raw A throttles, the touchpad click does not', async ({
    page,
    consoleErrors,
  }) => {
    await withRawSteamPad(page)
    await bootRacing(page)

    // The pre-fix trap: raw button 0 is the left touchpad click. Reading
    // it as A gave phantom throttle on pad clicks — and worse, real A
    // presses (raw 3) did nothing. Hold the click: no throttle.
    await page.evaluate(
      ({ BTN_LPAD_CLICK }) => window.__fakePad.set({ [BTN_LPAD_CLICK]: true }),
      RAW,
    )
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => window.__hover!.intent().throttle)).toBe(0)

    // Real A (raw 3) → full throttle.
    await page.evaluate(({ BTN_A }) => {
      window.__fakePad.reset()
      window.__fakePad.set({ [BTN_A]: true })
    }, RAW)
    await page.waitForFunction(() => (window.__hover?.intent().throttle ?? 0) === 1, undefined, {
      timeout: 3000,
    })

    consoleErrors.assertNone()
  })

  test('steers from the left stick and brakes/reverses from the raw left-trigger axis', async ({
    page,
    consoleErrors,
  }) => {
    await withRawSteamPad(page)
    await bootRacing(page)

    await page.evaluate(
      ({ AXIS_LX, AXIS_LT }) => window.__fakePad.set({}, { [AXIS_LX]: 1, [AXIS_LT]: 1 }),
      RAW,
    )
    await page.waitForFunction(
      () => {
        const i = window.__hover?.intent()
        return !!i && i.steer > 0.5 && i.brake > 0.9 && i.throttle < -0.9
      },
      undefined,
      { timeout: 3000 },
    )

    consoleErrors.assertNone()
  })

  test('raw Menu button (12) opens the pause menu as Start', async ({ page, consoleErrors }) => {
    await withRawSteamPad(page)
    await bootRacing(page)

    await page.evaluate(({ BTN_MENU }) => window.__fakePad.set({ [BTN_MENU]: true }), RAW)
    await expect(page.locator('#pause-menu')).toHaveClass(/show/, { timeout: 3000 })

    consoleErrors.assertNone()
  })
})
