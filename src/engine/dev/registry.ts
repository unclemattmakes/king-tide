/**
 * Dev-tools palette — the dispatcher + URL helpers.
 *
 * `runTool` is the single entry point both the dock rail and the command
 * bar call. It switches on `tool.kind` (exhaustively — adding a kind without
 * a case is a compile error). Scene / param tools rebuild the current URL,
 * preserving the deep-link context (track / bike / dev / room / cup…), and
 * navigate; a live unfinished race prompts for confirmation first.
 */

import type { DevTool, ParamTool } from './registry-types'

/**
 * Rebuild a URL applying a set of query-param mutations. A `null` value
 * deletes the key; any string sets it. `href` defaults to the live location
 * but is injectable so the helper is unit-testable under Vitest's node env
 * (no `window`). Everything not named in `mutations` is preserved verbatim.
 */
export function buildUrl(
  mutations: Record<string, string | null>,
  href: string = window.location.href,
): string {
  const url = new URL(href)
  for (const [key, value] of Object.entries(mutations)) {
    if (value === null) url.searchParams.delete(key)
    else url.searchParams.set(key, value)
  }
  return url.toString()
}

/** True when a live, unfinished race loop is running — a scene/param reload
 *  would lose it, so callers confirm first. Keys off `__hover.ready`, the
 *  same signal the e2e boot helper waits on. */
function raceInProgress(): boolean {
  const hover = window.__hover
  if (!hover?.ready) return false
  return hover.race()?.finished !== true
}

/** Confirm before navigating away from a live race. */
function confirmLeave(message: string): boolean {
  if (!raceInProgress()) return true
  return window.confirm(message)
}

function navigateWithParam(param: string, value: string, confirmInRace: boolean): void {
  if (confirmInRace && !confirmLeave(`Leave the current race to launch ?${param}=${value}?`)) return
  window.location.assign(buildUrl({ [param]: value }))
}

function toggleUrlFlag(param: string, confirmInRace: boolean): void {
  const has = new URLSearchParams(window.location.search).has(param)
  if (confirmInRace && !confirmLeave(`Reload with ?${param} ${has ? 'removed' : 'added'}?`)) return
  window.location.assign(buildUrl({ [param]: has ? null : '' }))
}

function runParam(tool: ParamTool): void {
  const confirmInRace = tool.confirmInRace ?? true
  if (tool.mode === 'flag') {
    toggleUrlFlag(tool.param, confirmInRace)
    return
  }
  // Value mode. A fixed-value param with `isOn` toggles: clear it when on.
  if (tool.value !== undefined && tool.isOn?.()) {
    if (confirmInRace && !confirmLeave(`Reload without ?${tool.param}?`)) return
    window.location.assign(buildUrl({ [tool.param]: null }))
    return
  }
  let value = tool.value
  if (value === undefined) {
    const entered = window.prompt(`Value for ?${tool.param}=`, '')
    if (entered === null || entered.trim() === '') return
    value = entered.trim()
  }
  navigateWithParam(tool.param, value, confirmInRace)
}

/** Whether a tool exposes an on/off state (drives the rail + command-bar dot). */
export function toolHasState(tool: DevTool): boolean {
  return (
    tool.kind === 'toggle' ||
    tool.kind === 'panel' ||
    (tool.kind === 'param' && tool.isOn !== undefined)
  )
}

/** Current on/off state of a tool (false for stateless kinds). */
export function toolIsOn(tool: DevTool): boolean {
  if (tool.kind === 'toggle') return tool.isOn()
  if (tool.kind === 'panel') return tool.isOpen?.() ?? false
  if (tool.kind === 'param') return tool.isOn?.() ?? false
  return false
}

/** Dispatch a dev tool. The only invocation path for the dock + command bar. */
export function runTool(tool: DevTool): void {
  switch (tool.kind) {
    case 'toggle':
      tool.toggle()
      return
    case 'action':
      void tool.run()
      return
    case 'panel':
      void tool.open()
      return
    case 'scene':
      navigateWithParam(tool.param, tool.value ?? '1', tool.confirmInRace ?? true)
      return
    case 'param':
      runParam(tool)
      return
  }
}
