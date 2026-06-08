/**
 * Dev-tools palette — the registry data model.
 *
 * A single discriminated union describes every dev tool the dock rail and
 * the Ctrl/Cmd+K command bar can launch. Both surfaces consume the same
 * `DevTool[]` and dispatch through `runTool` (registry.ts), so there's one
 * source of truth and zero duplication.
 *
 * This file is pure types — no imports — so it stays trivially shareable
 * and never drags Three / sim code into the type graph.
 */

export type DevToolGroup =
  | 'Scenes' // standalone URL modes — navigating away (a reload)
  | 'Tuners' // docked live-tuning panels (input feel / water / camera)
  | 'Toggles' // in-race debug overlays flipped live via window.__hover
  | 'World' // live scene-state controls (time of day, freeze water) — no reload
  | 'Render' // boot-time render params that genuinely need a reload
  | 'Actions' // one-shot commands

/** The docked live-tuning panels, keyed for single-active coordination. */
export type TunerId = 'devsettings' | 'water' | 'camera' | 'brush'

interface DevToolBase {
  /** Stable, kebab id (e.g. 'toggle.collision'). Also a DOM data-attr hook. */
  id: string
  /** Human label shown in the rail + command bar. */
  label: string
  group: DevToolGroup
  /** Extra space-separated fuzzy-match terms beyond the label. */
  keywords?: string
  /** One-line description — rail tooltip + command-bar subtitle. */
  hint?: string
}

/**
 * Standalone scene / mode reached by a URL param (bypasses or restarts the
 * game boot). Running it rebuilds the current URL — preserving track / bike /
 * dev context — sets `param=value`, and navigates. `confirmInRace` (default
 * true) prompts before abandoning a live race.
 */
export interface SceneTool extends DevToolBase {
  kind: 'scene'
  param: string
  /** Value to set (default '1'). */
  value?: string
  confirmInRace?: boolean
}

/** Open a docked live-tuning panel (routed through the tuner host, which keeps
 *  exactly one panel open at a time). */
export interface PanelTool extends DevToolBase {
  kind: 'panel'
  open: () => void | Promise<void>
  /** Whether the panel is currently open — drives the rail's state dot. */
  isOpen?: () => boolean
}

/** In-race debug overlay flipped live (via window.__hover). No reload. */
export interface ToggleTool extends DevToolBase {
  kind: 'toggle'
  toggle: () => void
  isOn: () => boolean
}

/**
 * Boot-time render/visual param that only takes effect on reload. `flag` mode
 * toggles presence (`?perf`, `?wire`); `value` mode sets a value (`?tod=285`)
 * — with a fixed `value` it acts as a toggle (clears the param when already
 * on), and without one it prompts. `isOn` reflects the current URL so the rail
 * can show which boot config the page is on.
 */
export interface ParamTool extends DevToolBase {
  kind: 'param'
  param: string
  mode: 'flag' | 'value'
  value?: string
  isOn?: () => boolean
  confirmInRace?: boolean
}

/** One-shot command (respawn, copy camera pose, download CSV / bundle, reset). */
export interface ActionTool extends DevToolBase {
  kind: 'action'
  run: () => void | Promise<void>
}

export type DevTool = SceneTool | PanelTool | ToggleTool | ParamTool | ActionTool
