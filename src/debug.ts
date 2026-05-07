import { type Intent, snapshotGamepads } from './engine/input'
import type { RenderBackend } from './engine/render/renderer'

/**
 * Dev-only debug API. Lets Playwright (and Claude in a Chrome session) drive the game
 * programmatically: query state, push synthetic input, etc.
 *
 * Grows with each milestone. M0 surface is intentionally minimal.
 */
export type HoverDebug = {
  ready: boolean
  backend(): RenderBackend
  fps(): number
  frame(): number
  gamepads(): ReturnType<typeof snapshotGamepads>
  /** Last intent observed by the input system. */
  intent(): Intent
  /** Force an intent for testing. Set to null to release. */
  setIntentOverride(i: Intent | null): void
}

declare global {
  interface Window {
    __hover?: HoverDebug
  }
}

type Mut = {
  ready: boolean
  backend: RenderBackend
  fps: number
  frame: number
  intent: Intent
  intentOverride: Intent | null
}

export function installDebugApi(state: Mut): HoverDebug {
  const api: HoverDebug = {
    get ready() {
      return state.ready
    },
    backend: () => state.backend,
    fps: () => state.fps,
    frame: () => state.frame,
    gamepads: () => snapshotGamepads(),
    intent: () => ({ ...state.intent }),
    setIntentOverride: (i) => {
      state.intentOverride = i
    },
  }
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    window.__hover = api
  }
  return api
}
