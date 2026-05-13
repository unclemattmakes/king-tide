/**
 * DOM panel + modal flows for the track editor.
 *
 * Extracted from `track-editor.ts` so the orchestrator stays focused on
 * state, gizmo, and I/O. The panel takes a `getState()` callback so it
 * can re-read the current selection / mode / place-tool on every render
 * without callers having to threading state through. Mutations flow back
 * via the `callbacks` parameter.
 */

import type { PropManifestEntry } from '@/game/assets/manifest'
import type { Track } from '@/game/tracks/types'
import { propSizeHint } from './editor-helpers'

// ── Types ────────────────────────────────────────────────────────────────

export type GizmoMode = 'translate' | 'rotate' | 'scale'

export type PlaceTool =
  | 'none'
  | 'gate'
  | 'pickup'
  | 'pad'
  | 'spline'
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'pipe'
  | 'halfpipe'
  | 'asset'

export type EntitySel =
  | { kind: 'gate'; index: number }
  | { kind: 'pickup'; index: number }
  | { kind: 'pad'; index: number }
  | { kind: 'spline'; splineIndex: number; pointIndex: number }
  | { kind: 'prop'; index: number }
  | { kind: 'start' }
  | null

export const PROP_PLACE_TOOLS: PlaceTool[] = ['box', 'sphere', 'cylinder', 'pipe', 'halfpipe']

export const PROP_LABELS: Record<string, string> = {
  box: 'Box',
  sphere: 'Sphere',
  cylinder: 'Cylinder',
  pipe: 'Pipe',
  halfpipe: 'Half Pipe',
  asset: 'Asset',
}

// ── Entity-key string helpers ────────────────────────────────────────────

/** Stable string key for a selection — used as the helpers-map key and as
 *  the outliner row's `data-select` attribute. */
export function entityKey(s: NonNullable<EntitySel>): string {
  if (s.kind === 'spline') return `spline:${s.splineIndex}:${s.pointIndex}`
  if (s.kind === 'start') return 'start'
  return `${s.kind}:${s.index}`
}

/** Inverse of `entityKey` — parses an outliner row's data-select string
 *  back into an `EntitySel`. Returns null if the key is unrecognised. */
export function parseEntityKey(k: string): EntitySel {
  if (k === 'start') return { kind: 'start' }
  if (k.startsWith('gate:')) return { kind: 'gate', index: Number(k.slice(5)) }
  if (k.startsWith('pickup:')) return { kind: 'pickup', index: Number(k.slice(7)) }
  if (k.startsWith('pad:')) return { kind: 'pad', index: Number(k.slice(4)) }
  if (k.startsWith('prop:')) return { kind: 'prop', index: Number(k.slice(5)) }
  if (k.startsWith('spline:')) {
    const [, si, pi] = k.split(':')
    return { kind: 'spline', splineIndex: Number(si), pointIndex: Number(pi) }
  }
  return null
}

// ── Panel factory ────────────────────────────────────────────────────────

export type EditorPanelState = {
  sel: EntitySel
  mode: GizmoMode
  placeTool: PlaceTool
  pickedAssetId: string
}

export type EditorPanelCallbacks = {
  onPlaceTool(t: PlaceTool): void
  onMode(m: GizmoMode): void
  onSelect(sel: EntitySel): void
  onAssetPick(id: string): void
  onSave(): void
  onPlay(): void
  onOpen(): void
  onNew(): void
  /** Resample the main AI spline at the track's gateSpacing and write
   *  gate positions back into the draft. One-shot — after running, gates
   *  remain individually editable. */
  onAutoPlaceGates(): void
  /** Live-edit the track's mean sea level (`track.water.height`). The
   *  panel sends every slider tick; the receiver decides whether to
   *  push an undo entry or coalesce. */
  onWaterHeightChange(heightM: number): void
  /** Fires on slider mouseup (commit) so the receiver knows the drag
   *  session is over and the next change should push a fresh undo
   *  snapshot. */
  onWaterHeightCommit(): void
  /** Whether the currently-selected entity supports a given gizmo mode.
   *  Used to disable / grey out mode buttons that wouldn't apply. */
  selSupportsMode(m: GizmoMode): boolean
}

export type EditorPanelHandle = {
  /** Full re-render of the panel (HTML + event wiring). Call after any
   *  state change that affects the outliner or selection markers. */
  render(): void
  /** Cheap re-render of just the selected-properties block — used during
   *  high-frequency gizmo drags to avoid re-wiring the whole panel. */
  renderLight(): void
  setStatus(msg: string, color?: string): void
  dispose(): void
}

export function createEditorPanel(opts: {
  draft: Track
  propAssets: PropManifestEntry[]
  getState: () => EditorPanelState
  callbacks: EditorPanelCallbacks
}): EditorPanelHandle {
  const { draft, propAssets, getState, callbacks } = opts

  const panel = document.createElement('div')
  panel.id = 'editor-panel'
  panel.style.cssText = [
    'position: fixed',
    'top: 10px',
    'left: 10px',
    'background: rgba(20,24,30,0.94)',
    'color: #d8e6f0',
    'font: 12px ui-monospace, Menlo, Consolas, monospace',
    'padding: 10px 12px',
    'border: 1px solid #2a3a4a',
    'border-radius: 6px',
    'width: 280px',
    'max-height: calc(100vh - 20px)',
    'display: flex',
    'flex-direction: column',
    'gap: 8px',
    'z-index: 30',
    'pointer-events: auto',
  ].join(';')
  document.body.appendChild(panel)
  // Block pointer events from reaching the renderer when over the panel.
  panel.addEventListener('pointerdown', (e) => e.stopPropagation())
  panel.addEventListener('wheel', (e) => e.stopPropagation())

  function render(): void {
    panel.innerHTML = panelHtml()
    wirePanelEvents()
  }

  function renderLight(): void {
    const propsEl = panel.querySelector('#ed-props')
    if (propsEl) propsEl.innerHTML = selectedPropsHtml()
  }

  function setStatus(msg: string, color?: string): void {
    const status = panel.querySelector<HTMLElement>('#ed-status')
    if (!status) return
    status.textContent = msg
    if (color) status.style.color = color
  }

  function dispose(): void {
    panel.remove()
  }

  // ── HTML builders ──────────────────────────────────────────────────────

  function panelHtml(): string {
    return [
      `<div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
         <div style="font-weight:bold;color:#7fc7ff;font-size:13px">EDITOR · ${escapeHtml(draft.id)}</div>
       </div>`,
      `<div style="display:flex;gap:4px">
         <button type="button" id="ed-open" style="flex:1;background:#234;color:#dde;border:1px solid #456;padding:4px 6px;border-radius:3px;cursor:pointer;font:inherit">Open…</button>
         <button type="button" id="ed-new" style="flex:1;background:#234;color:#dde;border:1px solid #456;padding:4px 6px;border-radius:3px;cursor:pointer;font:inherit">New…</button>
       </div>`,
      `<div style="display:flex;flex-direction:column;gap:6px">
         <div style="color:#9bb">Place</div>
         <div style="display:flex;flex-wrap:wrap;gap:4px">
           ${placeBtn('gate', '+ Gate')}
           ${placeBtn('pickup', '+ Pickup')}
           ${placeBtn('pad', '+ Boost')}
           ${placeBtn('spline', '+ Spline pt')}
         </div>
         <div style="color:#9bb;margin-top:4px">Shapes</div>
         <div style="display:flex;flex-wrap:wrap;gap:4px">
           ${placeBtn('box', '+ Box')}
           ${placeBtn('sphere', '+ Sphere')}
           ${placeBtn('cylinder', '+ Cylinder')}
           ${placeBtn('pipe', '+ Pipe')}
           ${placeBtn('halfpipe', '+ Half Pipe')}
         </div>
         ${assetSectionHtml()}
       </div>`,
      `<div style="display:flex;flex-direction:column;gap:6px">
         <div style="color:#9bb">Mode (W / E / R)</div>
         <div style="display:flex;flex-wrap:wrap;gap:4px">
           ${modeBtn('translate', 'Move')}
           ${modeBtn('rotate', 'Rotate')}
           ${modeBtn('scale', 'Scale')}
         </div>
       </div>`,
      `<div style="display:flex;flex-direction:column;gap:6px">
         <div style="color:#9bb">Spline tools</div>
         <button type="button" id="ed-auto-gates" style="background:#234;color:#dde;border:1px solid #456;padding:4px 6px;border-radius:3px;cursor:pointer;font:inherit;text-align:left">Auto-place gates from spline</button>
       </div>`,
      trackSettingsHtml(),
      `<div id="ed-outliner" style="border-top:1px solid #2a3a4a;padding-top:8px;flex:1;overflow-y:auto;min-height:140px">
         ${outlinerHtml()}
       </div>`,
      `<div id="ed-props" style="border-top:1px solid #2a3a4a;padding-top:8px;font-size:11px;color:#bcd">
         ${selectedPropsHtml()}
       </div>`,
      `<div style="display:flex;gap:6px;border-top:1px solid #2a3a4a;padding-top:8px">
         <button type="button" id="ed-save" style="flex:1;background:#284;color:#dfd;border:1px solid #4a6;padding:6px 10px;border-radius:3px;cursor:pointer">Save</button>
         <button type="button" id="ed-play" style="flex:1;background:#246;color:#dde;border:1px solid #468;padding:6px 10px;border-radius:3px;cursor:pointer">Play</button>
       </div>`,
      `<div id="ed-status" style="color:#7a8;min-height:14px;font-size:11px"></div>`,
      `<div style="color:#778;font-size:10px;line-height:1.4">
        Click in outliner to select · drag gizmo to manipulate<br/>
        L-drag: orbit · R-drag: pan · wheel: zoom<br/>
        Delete = remove · Ctrl+Z = undo · Ctrl+S = save
       </div>`,
    ].join('')
  }

  function trackSettingsHtml(): string {
    const h = draft.water?.height ?? 0
    return `<div style="display:flex;flex-direction:column;gap:4px">
        <div style="color:#9bb">Track settings</div>
        <label style="display:flex;align-items:center;gap:6px">
          <span style="width:70px">Sea level</span>
          <input id="ed-water-height" type="range" min="-50" max="50" step="0.1" value="${h}" style="flex:1" />
          <span id="ed-water-height-val" style="width:48px;text-align:right;color:#cdf">${h.toFixed(1)}m</span>
        </label>
      </div>`
  }

  function placeBtn(t: PlaceTool, label: string): string {
    const on = t === getState().placeTool
    return `<button type="button" data-place="${t}" style="background:${on ? '#a73' : '#234'};color:${on ? '#fff' : '#dde'};border:1px solid ${on ? '#fc8' : '#456'};padding:4px 6px;border-radius:3px;cursor:pointer;font:inherit">${label}</button>`
  }

  function assetSectionHtml(): string {
    const { pickedAssetId } = getState()
    if (propAssets.length === 0) {
      return `<div style="color:#778;font-size:10px;margin-top:4px">No prop assets — run <code>pnpm gen:props</code></div>`
    }
    const opts = propAssets
      .map(
        (a) =>
          `<option value="${escapeHtml(a.id)}"${a.id === pickedAssetId ? ' selected' : ''}>${escapeHtml(a.displayName)}</option>`,
      )
      .join('')
    return `<div style="color:#9bb;margin-top:4px">Assets</div>
       <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
         <select id="ed-asset-pick" style="background:#234;color:#dde;border:1px solid #456;padding:3px 4px;border-radius:3px;font:inherit;flex:1;min-width:0">${opts}</select>
         ${placeBtn('asset', '+ Place')}
       </div>`
  }

  function modeBtn(m: GizmoMode, label: string): string {
    const { mode } = getState()
    const on = m === mode
    const allowed = callbacks.selSupportsMode(m)
    return `<button type="button" data-mode="${m}" ${allowed ? '' : 'disabled'} style="background:${on ? '#356' : '#234'};color:#dde;border:1px solid ${on ? '#7af' : '#456'};padding:4px 6px;border-radius:3px;cursor:pointer;font:inherit;${allowed ? '' : 'opacity:0.4;cursor:not-allowed'}">${label}</button>`
  }

  function outlinerHtml(): string {
    const sections: string[] = []
    sections.push(
      outlinerSection('Start', [
        {
          k: 'start',
          label: `start  (${draft.start.position.x.toFixed(0)}, ${draft.start.position.z.toFixed(0)})  yaw ${((draft.start.yaw * 180) / Math.PI).toFixed(0)}°`,
          sel: { kind: 'start' } as EntitySel,
        },
      ]),
    )
    sections.push(
      outlinerSection(
        'Shapes',
        draft.props.map((p, i) => ({
          k: `prop:${i}`,
          label: `${PROP_LABELS[p.type]}_${i}  (${p.position.x.toFixed(0)}, ${p.position.z.toFixed(0)})`,
          sel: { kind: 'prop', index: i } as EntitySel,
        })),
      ),
    )
    sections.push(
      outlinerSection(
        'Checkpoints',
        draft.checkpoints.map((cp, i) => ({
          k: `gate:${i}`,
          label: `cp_${String(cp.index).padStart(2, '0')}  (${cp.position.x.toFixed(0)}, ${cp.position.z.toFixed(0)})`,
          sel: { kind: 'gate', index: i } as EntitySel,
        })),
      ),
    )
    sections.push(
      outlinerSection(
        'Pickups',
        draft.pickupSpawns.map((p, i) => ({
          k: `pickup:${i}`,
          label: `pickup_${i}  (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`,
          sel: { kind: 'pickup', index: i } as EntitySel,
        })),
      ),
    )
    sections.push(
      outlinerSection(
        'Boost Pads',
        draft.boostPads.map((p, i) => ({
          k: `pad:${i}`,
          label: `pad_${i}  (${p.position.x.toFixed(0)}, ${p.position.z.toFixed(0)})`,
          sel: { kind: 'pad', index: i } as EntitySel,
        })),
      ),
    )
    const main = draft.aiSplines.find((s) => s.id === 'main')
    if (main) {
      const arr = main.anchors ?? main.points
      const isAnchored = !!main.anchors
      const title = isAnchored ? 'Spline anchors' : 'Spline pts'
      const labelPrefix = isAnchored ? 'anchor' : 'pt'
      sections.push(
        outlinerSection(
          title,
          arr.map((p, i) => ({
            k: `spline:0:${i}`,
            label: `${labelPrefix}_${String(i).padStart(2, '0')}  (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`,
            sel: { kind: 'spline', splineIndex: 0, pointIndex: i } as EntitySel,
          })),
        ),
      )
    }
    return sections.join('')
  }

  function outlinerSection(
    title: string,
    items: { k: string; label: string; sel: EntitySel }[],
  ): string {
    const { sel } = getState()
    const rows = items
      .map((it) => {
        const selected = sel != null && entityKey(sel) === it.k
        const bg = selected ? '#356' : 'transparent'
        const color = selected ? '#fff' : '#bcd'
        return `<div data-select="${it.k}" style="padding:2px 6px;cursor:pointer;border-radius:2px;background:${bg};color:${color}">${escapeHtml(it.label)}</div>`
      })
      .join('')
    return `<div style="margin-bottom:6px">
      <div style="color:#9bb;margin-bottom:2px;font-weight:bold">${title} (${items.length})</div>
      ${rows || '<div style="color:#566;font-size:11px;padding-left:6px">(none)</div>'}
    </div>`
  }

  function selectedPropsHtml(): string {
    const { sel } = getState()
    if (!sel) return '<span style="color:#566">No selection</span>'
    if (sel.kind === 'start') {
      return [
        `<div><b>start</b></div>`,
        `<div>pos: ${fmtVec(draft.start.position)}</div>`,
        `<div>yaw: ${((draft.start.yaw * 180) / Math.PI).toFixed(1)}°</div>`,
        `<div style="color:#7c9">controls position + facing for the player and the AI grid</div>`,
      ].join('')
    }
    if (sel.kind === 'prop') {
      const p = draft.props[sel.index]
      if (!p) return '(missing)'
      return [
        `<div><b>${PROP_LABELS[p.type]}_${sel.index}</b></div>`,
        `<div>pos: ${fmtVec(p.position)}</div>`,
        `<div>size: ${fmtVec(p.size)}</div>`,
        `<div style="color:#7c9">${propSizeHint(p.type)}</div>`,
      ].join('')
    }
    if (sel.kind === 'gate') {
      const cp = draft.checkpoints[sel.index]
      if (!cp) return '(missing)'
      const bound =
        typeof cp.splineT === 'number'
          ? `<div style="color:#7c9">⚓ bound to spline @ t=${cp.splineT.toFixed(3)}</div>`
          : ''
      return [
        `<div><b>cp_${String(cp.index).padStart(2, '0')}</b></div>`,
        `<div>pos: ${fmtVec(cp.position)}</div>`,
        `<div>halfWidth: ${cp.halfWidth.toFixed(2)} · height: ${cp.height.toFixed(2)}</div>`,
        bound,
      ].join('')
    }
    if (sel.kind === 'pickup') {
      const p = draft.pickupSpawns[sel.index]
      if (!p) return '(missing)'
      return `<div><b>pickup_${sel.index}</b></div><div>pos: ${fmtVec(p)}</div>`
    }
    if (sel.kind === 'pad') {
      const pad = draft.boostPads[sel.index]
      if (!pad) return '(missing)'
      return [
        `<div><b>pad_${sel.index}</b></div>`,
        `<div>pos: ${fmtVec(pad.position)}</div>`,
        `<div>halfWidth: ${pad.halfWidth.toFixed(2)} · halfDepth: ${pad.halfDepth.toFixed(2)} · strength: ${pad.strength.toFixed(2)}</div>`,
      ].join('')
    }
    const sp = draft.aiSplines[sel.splineIndex]
    if (!sp) return '(missing)'
    const arr = sp.anchors ?? sp.points
    const p = arr[sel.pointIndex]
    if (!p) return '(missing)'
    const label = sp.anchors ? 'spline anchor' : 'spline pt'
    return `<div><b>${label} ${sel.pointIndex}</b></div><div>pos: ${fmtVec(p)}</div>`
  }

  // ── Event wiring ───────────────────────────────────────────────────────

  function wirePanelEvents(): void {
    panel.querySelectorAll<HTMLElement>('[data-place]').forEach((el) => {
      el.addEventListener('click', () => {
        callbacks.onPlaceTool(el.dataset.place as PlaceTool)
      })
    })
    panel.querySelectorAll<HTMLElement>('[data-mode]').forEach((el) => {
      el.addEventListener('click', () => {
        callbacks.onMode(el.dataset.mode as GizmoMode)
      })
    })
    panel.querySelectorAll<HTMLElement>('[data-select]').forEach((el) => {
      el.addEventListener('click', () => {
        callbacks.onSelect(parseEntityKey(el.dataset.select as string))
      })
    })
    const assetSelect = panel.querySelector<HTMLSelectElement>('#ed-asset-pick')
    if (assetSelect) {
      assetSelect.addEventListener('change', () => {
        callbacks.onAssetPick(assetSelect.value)
      })
    }
    panel.querySelector('#ed-save')?.addEventListener('click', callbacks.onSave)
    panel.querySelector('#ed-play')?.addEventListener('click', callbacks.onPlay)
    panel.querySelector('#ed-open')?.addEventListener('click', callbacks.onOpen)
    panel.querySelector('#ed-new')?.addEventListener('click', callbacks.onNew)
    panel.querySelector('#ed-auto-gates')?.addEventListener('click', callbacks.onAutoPlaceGates)
    const waterSlider = panel.querySelector<HTMLInputElement>('#ed-water-height')
    if (waterSlider) {
      const label = panel.querySelector<HTMLElement>('#ed-water-height-val')
      waterSlider.addEventListener('input', () => {
        const v = parseFloat(waterSlider.value)
        if (Number.isFinite(v)) {
          if (label) label.textContent = `${v.toFixed(1)}m`
          callbacks.onWaterHeightChange(v)
        }
      })
      waterSlider.addEventListener('change', () => {
        callbacks.onWaterHeightCommit()
      })
    }
  }

  return { render, renderLight, setStatus, dispose }
}

// ── Track-picker / new-track flows ───────────────────────────────────────

/**
 * Fetch /__editor/list-tracks and present a modal listing every track
 * the editor can open. Clicking a row navigates (full reload — the
 * editor doesn't support in-place swap).
 *
 * Calls `setStatus` for "Loading tracks…" / error feedback. Calls
 * `confirmDiscard` before navigating away from a dirty draft.
 */
export async function openTrackPickerFlow(opts: {
  currentTrackId: string
  confirmDiscard: (action: string) => boolean
  setStatus: (msg: string, color?: string) => void
}): Promise<void> {
  opts.setStatus('Loading tracks…', '#7a8')
  let tracks: { id: string; kind: 'json' | 'glb-only'; hasGlb: boolean }[]
  try {
    const res = await fetch('/__editor/list-tracks')
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const body = (await res.json()) as {
      tracks?: { id: string; kind: 'json' | 'glb-only'; hasGlb: boolean }[]
    }
    tracks = Array.isArray(body.tracks) ? body.tracks : []
  } catch (e) {
    opts.setStatus(`Open failed: ${(e as Error).message}`, '#f88')
    return
  }
  opts.setStatus('')
  showTrackPickerModal(tracks, opts.currentTrackId, opts.confirmDiscard)
}

function showTrackPickerModal(
  tracks: { id: string; kind: 'json' | 'glb-only'; hasGlb: boolean }[],
  currentTrackId: string,
  confirmDiscard: (action: string) => boolean,
): void {
  const overlay = document.createElement('div')
  overlay.style.cssText = [
    'position: fixed',
    'inset: 0',
    'background: rgba(0,0,0,0.5)',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'z-index: 200',
    'pointer-events: auto',
  ].join(';')

  const dialog = document.createElement('div')
  dialog.style.cssText = [
    'background: #1a2028',
    'color: #d8e6f0',
    'font: 12px ui-monospace, Menlo, Consolas, monospace',
    'border: 1px solid #345',
    'border-radius: 8px',
    'padding: 14px 16px',
    'min-width: 320px',
    'max-height: 70vh',
    'display: flex',
    'flex-direction: column',
    'gap: 10px',
  ].join(';')

  const title = document.createElement('div')
  title.style.cssText = 'font-weight:bold;font-size:14px;color:#7fc7ff'
  title.textContent = 'Open Track'
  dialog.appendChild(title)

  if (tracks.length === 0) {
    const empty = document.createElement('div')
    empty.style.cssText = 'color:#aab;padding:8px 0'
    empty.textContent =
      'No tracks found. Create one in Blender (Export to Game) or click New… to start a draft.'
    dialog.appendChild(empty)
  } else {
    const list = document.createElement('div')
    list.style.cssText =
      'display:flex;flex-direction:column;gap:2px;overflow-y:auto;max-height:50vh;border:1px solid #345;border-radius:4px;padding:4px;background:#101418'
    for (const t of tracks) {
      const row = document.createElement('div')
      const isCurrent = t.id === currentTrackId
      row.style.cssText = [
        'padding: 6px 10px',
        'cursor: pointer',
        'border-radius: 3px',
        isCurrent ? 'background:#356;color:#fff' : 'color:#cde',
        'display: flex',
        'justify-content: space-between',
        'gap: 8px',
      ].join(';')
      const tag = t.kind === 'json' ? (t.hasGlb ? 'JSON + GLB' : 'JSON') : 'GLB only'
      row.innerHTML = `
        <span>${escapeHtml(t.id)}${isCurrent ? '  <span style="color:#7fc">(current)</span>' : ''}</span>
        <span style="color:#789;font-size:11px">${tag}</span>
      `
      row.addEventListener('mouseenter', () => {
        if (!isCurrent) row.style.background = '#234'
      })
      row.addEventListener('mouseleave', () => {
        if (!isCurrent) row.style.background = ''
      })
      row.addEventListener('click', () => {
        if (t.id === currentTrackId) {
          close()
          return
        }
        if (!confirmDiscard(`Open "${t.id}"`)) return
        const url = new URL(window.location.href)
        url.searchParams.set('track', t.id)
        url.searchParams.set('edit', '1')
        window.location.href = url.toString()
      })
      list.appendChild(row)
    }
    dialog.appendChild(list)
  }

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;gap:6px;justify-content:flex-end'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.style.cssText =
    'background:#234;color:#dde;border:1px solid #456;padding:5px 12px;border-radius:3px;cursor:pointer;font:inherit'
  cancelBtn.addEventListener('click', () => close())
  btnRow.appendChild(cancelBtn)
  dialog.appendChild(btnRow)

  function close(): void {
    overlay.remove()
    window.removeEventListener('keydown', onModalKey)
  }
  function onModalKey(e: KeyboardEvent): void {
    if (e.code === 'Escape') {
      e.preventDefault()
      close()
    }
  }
  window.addEventListener('keydown', onModalKey)

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
}

export function promptNewTrackFlow(opts: {
  currentTrackId: string
  confirmDiscard: (action: string) => boolean
}): void {
  const raw = window.prompt('New track id (lowercase letters, digits, dashes):', 'untitled')
  if (raw == null) return
  const id = raw.trim()
  if (!/^[a-z0-9-]+$/.test(id)) {
    window.alert('Track id must match /^[a-z0-9-]+$/. Try again.')
    return
  }
  if (id === opts.currentTrackId) {
    window.alert('That is the current track.')
    return
  }
  if (!opts.confirmDiscard(`Open new draft "${id}"`)) return
  const url = new URL(window.location.href)
  url.searchParams.set('track', id)
  url.searchParams.set('edit', '1')
  window.location.href = url.toString()
}

// ── Local string utils ───────────────────────────────────────────────────

function fmtVec(v: { x: number; y: number; z: number }): string {
  return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;'
    if (c === '<') return '&lt;'
    if (c === '>') return '&gt;'
    if (c === '"') return '&quot;'
    return '&#39;'
  })
}
