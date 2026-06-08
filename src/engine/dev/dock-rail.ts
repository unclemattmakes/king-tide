/**
 * Dev-tools palette — the dock rail.
 *
 * An always-visible, collapsible launcher pinned to the right edge (dev
 * builds only). Every registry entry is a clickable row grouped by category;
 * toggle / panel / param rows carry a state dot reflecting live on/off state.
 * Collapses to a thin "DEV" tab (state persisted to localStorage).
 *
 * Self-contained: builds its own DOM + injects its own `<style>`, and is
 * idempotent under Vite HMR (remove-by-id then rebuild) — same pattern as
 * camera-tuner.ts. State is read by polling (`refresh` every 500ms while
 * expanded, plus immediately after a click) because F2/F3/F4/`` ` `` flip
 * the same toggles from outside the rail and there's no change event to
 * subscribe to.
 */

import { runTool, toolHasState, toolIsOn } from './registry'
import type { DevTool, DevToolGroup } from './registry-types'

const DOCK_ID = 'dev-dock'
const STYLE_ID = 'dev-dock-style'
const COLLAPSE_KEY = 'hoverbike.devDock.collapsed.v1'

const GROUP_ORDER: DevToolGroup[] = ['Scenes', 'Tuners', 'Toggles', 'World', 'Render', 'Actions']

export type DockRail = { destroy(): void }

/** Rows that navigate away / reload when run (get a ↗ marker). */
function navigates(tool: DevTool): boolean {
  return tool.kind === 'scene' || tool.kind === 'param'
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    #${DOCK_ID}{position:fixed;top:54px;right:0;z-index:60;display:flex;
      align-items:flex-start;font:11px/1.35 var(--bc-font-mono,ui-monospace,Consolas,monospace);
      color:var(--bc-ink,#e8eef2);user-select:none}
    #${DOCK_ID} .dd-tab{writing-mode:vertical-rl;cursor:pointer;padding:12px 5px;
      letter-spacing:.22em;text-transform:uppercase;font-weight:600;font-size:10px;
      color:var(--bc-cyan,#4dd6ff);background:rgba(5,10,20,.82);
      border:1px solid var(--bc-line,rgba(120,160,190,.3));border-right:none;
      border-radius:4px 0 0 4px;align-self:stretch}
    #${DOCK_ID} .dd-tab:hover{background:rgba(15,25,45,.9)}
    #${DOCK_ID} .dd-panel{width:218px;max-height:calc(100vh - 66px);overflow-y:auto;
      background:rgba(5,10,20,.85);backdrop-filter:blur(3px);
      border:1px solid var(--bc-line,rgba(120,160,190,.3));
      box-shadow:-4px 4px 22px rgba(0,0,0,.45)}
    #${DOCK_ID}.dd-collapsed .dd-panel{display:none}
    #${DOCK_ID} .dd-head{display:flex;justify-content:space-between;align-items:center;
      padding:7px 9px;border-bottom:1px solid var(--bc-line,rgba(120,160,190,.25));
      position:sticky;top:0;background:rgba(5,10,20,.95);z-index:1}
    #${DOCK_ID} .dd-head b{font-size:10px;letter-spacing:.14em;color:var(--bc-cyan,#4dd6ff);
      text-transform:uppercase;font-weight:700}
    #${DOCK_ID} .dd-head .dd-kbd{font-size:9px;opacity:.6;letter-spacing:.05em}
    #${DOCK_ID} .dd-group{padding:4px 0}
    #${DOCK_ID} h4{margin:0;padding:7px 9px 3px;font-size:9px;letter-spacing:.18em;
      text-transform:uppercase;color:var(--bc-ink-dim,#8aa0b4);opacity:.85;font-weight:600}
    #${DOCK_ID} .dd-row{display:grid;grid-template-columns:9px 1fr auto;gap:7px;
      align-items:center;width:100%;text-align:left;cursor:pointer;
      padding:4px 9px;background:none;border:none;color:inherit;font:inherit}
    #${DOCK_ID} .dd-row:hover{background:rgba(77,214,255,.12)}
    #${DOCK_ID} .dd-dot{width:7px;height:7px;border-radius:50%;
      border:1px solid var(--bc-line,rgba(120,160,190,.5));background:transparent}
    #${DOCK_ID} .dd-row.dd-on .dd-dot{background:var(--bc-cyan,#4dd6ff);
      border-color:var(--bc-cyan,#4dd6ff);box-shadow:0 0 6px rgba(77,214,255,.7)}
    #${DOCK_ID} .dd-row.dd-on .dd-label{color:var(--bc-cyan,#4dd6ff)}
    #${DOCK_ID} .dd-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${DOCK_ID} .dd-mark{opacity:.4;font-size:11px}
  `
  document.head.appendChild(style)
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}
function writeCollapsed(v: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0')
  } catch {
    // private mode — non-fatal, just won't persist.
  }
}

export function installDockRail(tools: DevTool[]): DockRail {
  // HMR / double-mount guard.
  document.getElementById(DOCK_ID)?.remove()
  injectStyle()

  const dock = document.createElement('aside')
  dock.id = DOCK_ID

  const tab = document.createElement('button')
  tab.type = 'button'
  tab.className = 'dd-tab'
  tab.textContent = 'Dev Tools'
  tab.title = 'Toggle the dev dock (Ctrl/⌘K to search)'
  dock.appendChild(tab)

  const panel = document.createElement('div')
  panel.className = 'dd-panel'
  dock.appendChild(panel)

  const head = document.createElement('div')
  head.className = 'dd-head'
  head.innerHTML = '<b>Dev Tools</b><span class="dd-kbd">⌘/Ctrl K</span>'
  panel.appendChild(head)

  // Track row → tool so refresh() can re-read live state.
  const stateRows: Array<{ el: HTMLElement; tool: DevTool }> = []

  for (const group of GROUP_ORDER) {
    const inGroup = tools.filter((t) => t.group === group)
    if (inGroup.length === 0) continue

    const section = document.createElement('section')
    section.className = 'dd-group'
    const h4 = document.createElement('h4')
    h4.textContent = group
    section.appendChild(h4)

    for (const tool of inGroup) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'dd-row'
      row.dataset.tool = tool.id
      if (tool.hint) row.title = `${tool.label} — ${tool.hint}`

      const dot = document.createElement('span')
      dot.className = 'dd-dot'
      if (!toolHasState(tool)) dot.style.visibility = 'hidden'
      row.appendChild(dot)

      const label = document.createElement('span')
      label.className = 'dd-label'
      label.textContent = tool.label
      row.appendChild(label)

      const mark = document.createElement('span')
      mark.className = 'dd-mark'
      mark.textContent = navigates(tool) ? '↗' : ''
      row.appendChild(mark)

      row.addEventListener('click', () => {
        runTool(tool)
        refresh()
      })

      if (toolHasState(tool)) stateRows.push({ el: row, tool })
      section.appendChild(row)
    }
    panel.appendChild(section)
  }

  function refresh(): void {
    for (const { el, tool } of stateRows) {
      const on = toolIsOn(tool)
      el.classList.toggle('dd-on', on)
      el.setAttribute('aria-pressed', String(on))
    }
  }

  // ---- collapse + polling ----
  let pollTimer: number | null = null
  function startPolling(): void {
    if (pollTimer === null) pollTimer = window.setInterval(refresh, 500)
  }
  function stopPolling(): void {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
  }
  function applyCollapsed(collapsed: boolean): void {
    dock.classList.toggle('dd-collapsed', collapsed)
    if (collapsed) stopPolling()
    else {
      refresh()
      startPolling()
    }
  }

  tab.addEventListener('click', () => {
    const collapsed = !dock.classList.contains('dd-collapsed')
    writeCollapsed(collapsed)
    applyCollapsed(collapsed)
  })

  document.body.appendChild(dock)
  applyCollapsed(readCollapsed())

  return {
    destroy() {
      stopPolling()
      dock.remove()
      document.getElementById(STYLE_ID)?.remove()
    },
  }
}
