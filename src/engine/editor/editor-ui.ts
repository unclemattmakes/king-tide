/**
 * DOM panel + modal flows for the track editor.
 *
 * Extracted from `track-editor.ts` so the orchestrator stays focused on
 * state, gizmo, and I/O. The panel takes a `getState()` callback so it
 * can re-read the current selection / mode / place-tool on every render
 * without callers having to threading state through. Mutations flow back
 * via the `callbacks` parameter.
 */

import { SurfaceType } from '@/engine/sim/surface-types'
import type { PropManifestEntry } from '@/game/assets/manifest'
import { expandPropLine } from '@/game/tracks/prop-lines'
import { SKY_COLOR_GRADES, SKY_TONE_MAPPINGS, type Track } from '@/game/tracks/types'
import { propSizeHint } from './editor-helpers'

/** Surface tags an author can tag a prop's collider with. Mirrors
 *  `SurfaceType` (src/engine/sim/surface-types.ts) so the dropdown stays in
 *  sync with the runtime grip table. */
const SURFACE_VALUES = Object.values(SurfaceType)

/** Degrees-of-freedom presets for a floating (wave-rider) prop. */
const WAVE_RIDER_DOFS = ['locked', 'yaw'] as const

// ── Types ────────────────────────────────────────────────────────────────

export type GizmoMode = 'translate' | 'rotate' | 'scale'

export type PlaceTool =
  | 'none'
  | 'gate'
  | 'pickup'
  | 'pad'
  | 'antiGrav'
  | 'waveZone'
  | 'spline'
  | 'propLine'
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
  | { kind: 'antiGrav'; index: number }
  | { kind: 'waveZone'; index: number }
  | { kind: 'spline'; splineIndex: number; pointIndex: number }
  | { kind: 'prop'; index: number }
  | { kind: 'propLine'; index: number }
  | { kind: 'propLineAnchor'; lineIndex: number; anchorIndex: number }
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
  if (s.kind === 'antiGrav') return `antigrav:${s.index}`
  if (s.kind === 'waveZone') return `wavezone:${s.index}`
  if (s.kind === 'propLine') return `propline:${s.index}`
  if (s.kind === 'propLineAnchor') return `proplineanchor:${s.lineIndex}:${s.anchorIndex}`
  return `${s.kind}:${s.index}`
}

/** Inverse of `entityKey` — parses an outliner row's data-select string
 *  back into an `EntitySel`. Returns null if the key is unrecognised. */
export function parseEntityKey(k: string): EntitySel {
  if (k === 'start') return { kind: 'start' }
  if (k.startsWith('gate:')) return { kind: 'gate', index: Number(k.slice(5)) }
  if (k.startsWith('pickup:')) return { kind: 'pickup', index: Number(k.slice(7)) }
  if (k.startsWith('pad:')) return { kind: 'pad', index: Number(k.slice(4)) }
  if (k.startsWith('antigrav:')) return { kind: 'antiGrav', index: Number(k.slice(9)) }
  if (k.startsWith('wavezone:')) return { kind: 'waveZone', index: Number(k.slice(9)) }
  if (k.startsWith('proplineanchor:')) {
    const [, li, ai] = k.split(':')
    return { kind: 'propLineAnchor', lineIndex: Number(li), anchorIndex: Number(ai) }
  }
  if (k.startsWith('propline:')) return { kind: 'propLine', index: Number(k.slice(9)) }
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
  /** Bind the player start to the main AI spline at the curve point
   *  nearest the start's current xz position. Sets `start.splineT` and
   *  snaps the start's pose to the curve. No-op when there's no main
   *  spline. */
  onStartBindToSpline(): void
  /** Clear `start.splineT` so the start returns to free placement.
   *  Position and yaw stay where they are. */
  onStartUnbindFromSpline(): void
  /** Live-edit `start.splineT` from the panel slider. Streams every
   *  tick; the receiver coalesces undo across one drag session. */
  onStartSplineTChange(t: number): void
  /** Fires on slider mouseup so the receiver can close out the current
   *  undo coalescing window. */
  onStartSplineTCommit(): void
  /** Typed numeric entry for a scalar on the currently-selected entity.
   *  `field` is a logical path (`pos.x`, `halfWidth`, `size.z`, `yaw`,
   *  `strength`, `heightMult`, …) the receiver maps onto the draft entity.
   *  Commits one undo step per edit and rebuilds helpers. */
  onNumEdit(field: string, value: number): void
  /** Clear an optional numeric field on the selected entity (e.g. a wave
   *  zone's `directionDeg` / `surge*`). Mirrors `onNumEdit` but deletes. */
  onNumClear(field: string): void
  /** Edit a track-level setting: `name` (string), `lapsToFinish` (int),
   *  `gateSpacing` (number), `floatGates` (boolean). */
  onTrackFieldEdit(field: string, value: string | number | boolean): void
  /** Edit a `draft.sky.*` field. `value === null` clears the key (back to
   *  the runtime default). Strings for `tint` / `colorGrade` / `toneMapping`. */
  onSkyEdit(field: string, value: string | number | null): void
  /** Edit a flag on the selected prop: `color` (hex|null), `surface`
   *  (string|null), `waterline` (bool), `waveRider` (bool), `waveRiderDof`
   *  (string), `animated` (bool), `clip` (string|null), `loop` (bool). */
  onPropFlagEdit(field: string, value: string | boolean | null): void
  /** Unbind the selected gate from the AI spline (delete its `splineT`),
   *  mirroring the player-start unbind. */
  onGateUnbindFromSpline(): void
  /** Non-numeric edit on the selected prop-line (or its anchor's line):
   *  `assetId`/`spacingMode`/`surface`/`waveRiderDof` (string), `closed`/
   *  `alignToTangent`/`waterline`/`waveRider`/`seatToTerrain`/`bind` (bool). */
  onPropLineFlag(field: string, value: string | boolean | null): void
  /** Live-edit a spline-bound prop-line's `t0`/`t1` from a panel slider.
   *  Streams every tick; the receiver coalesces undo across one drag. */
  onPropLineBindTChange(which: 't0' | 't1', t: number): void
  /** Fires on slider mouseup so the receiver closes the undo-coalescing window. */
  onPropLineBindTCommit(): void
  /** Append a new anchor to the selected prop-line's curve. */
  onPropLineAddAnchor(): void
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

  // Collapsible-section open state, persisted across the panel's full
  // innerHTML re-renders (a fresh `<details>` would otherwise reset).
  // Both default closed so the panel stays compact — the outliner is the
  // primary surface and must stay reachable on short viewports.
  const sectionOpen: Record<string, boolean> = { track: false, sky: false }

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
    // Master scroll: with the toolbar + collapsible sections + outliner +
    // a tall properties block, total content can exceed the viewport. Let the
    // whole panel scroll so every control (incl. the prop flags + Save) stays
    // reachable on short windows; the outliner / props also scroll internally.
    'overflow-y: auto',
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
           ${placeBtn('waveZone', '+ Wave Zone')}
           ${placeBtn('antiGrav', '+ Anti-Grav')}
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
      skySettingsHtml(),
      `<div id="ed-outliner" style="border-top:1px solid #2a3a4a;padding-top:8px;max-height:42vh;overflow-y:auto;min-height:120px">
         ${outlinerHtml()}
       </div>`,
      `<div id="ed-props" style="border-top:1px solid #2a3a4a;padding-top:8px;font-size:11px;color:#bcd;max-height:38vh;overflow-y:auto">
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
    const laps = draft.lapsToFinish ?? 3
    const spacing = draft.gateSpacing ?? 0
    return `<details ${sectionOpen.track ? 'open' : ''} data-section="track" style="border-top:1px solid #2a3a4a;padding-top:8px">
        <summary style="color:#9bb;cursor:pointer;font-weight:bold">Track settings</summary>
        ${textRow('Name', 'data-trackedit', 'name', draft.name)}
        ${numRow('Laps', 'data-trackedit', 'lapsToFinish', laps, { min: 1, max: 99, step: 1 })}
        ${numRow('Gate spacing', 'data-trackedit', 'gateSpacing', spacing, { min: 0, step: 1 })}
        ${boolRow('Float gates on waves', 'data-trackedit', 'floatGates', draft.floatGates === true)}
        <label style="display:flex;align-items:center;gap:6px;margin-top:3px">
          <span style="width:74px;color:#9bb;flex-shrink:0">Sea level</span>
          <input id="ed-water-height" type="range" min="-50" max="50" step="0.1" value="${h}" style="flex:1" />
          <span id="ed-water-height-val" style="width:48px;text-align:right;color:#cdf">${h.toFixed(1)}m</span>
        </label>
        ${note('⚠ name · laps · gate spacing · float gates · sea level are <b>Blender-owned</b> — a later .blend re-export overwrites them.')}
      </details>`
  }

  function skySettingsHtml(): string {
    const sky = draft.sky ?? {}
    const g = (v: number | undefined, d: number) => (typeof v === 'number' ? v : d)
    return `<details ${sectionOpen.sky ? 'open' : ''} data-section="sky" style="border-top:1px solid #2a3a4a;padding-top:8px">
        <summary style="color:#9bb;cursor:pointer;font-weight:bold">Sky / atmosphere</summary>
        ${colorRow('Tint', 'data-skyedit', 'tint', sky.tint)}
        ${numRow('Cloudiness', 'data-skyedit', 'cloudiness', g(sky.cloudiness, 0.45), { min: 0, max: 1, step: 0.05 })}
        ${numRow('Cloud tower', 'data-skyedit', 'cloudTowering', g(sky.cloudTowering, 0.35), { min: 0, max: 1, step: 0.05 })}
        ${numRow('Sun size', 'data-skyedit', 'sunSize', g(sky.sunSize, 1), { min: 0.25, max: 8, step: 0.1 })}
        ${numRow('Sun intensity', 'data-skyedit', 'sunIntensity', g(sky.sunIntensity, 1), { min: 0, step: 0.05 })}
        ${numRow('Fog near', 'data-skyedit', 'fogNear', g(sky.fogNear, 500), { min: 0, step: 10 })}
        ${numRow('Fog far', 'data-skyedit', 'fogFar', g(sky.fogFar, 2200), { min: 0, step: 10 })}
        ${numRow('Time of day', 'data-skyedit', 'timeOfDay', g(sky.timeOfDay, 0), { min: 0, max: 360, step: 1 })}
        ${numRow('Bloom', 'data-skyedit', 'bloom', g(sky.bloom, 0), { min: 0, max: 2, step: 0.05 })}
        ${numRow('Sea state', 'data-skyedit', 'seaStateBeaufort', g(sky.seaStateBeaufort, 4), { min: 0, max: 12, step: 0.5 })}
        ${selectRow('Colour grade', 'data-skyedit', 'colorGrade', SKY_COLOR_GRADES, sky.colorGrade)}
        ${selectRow('Tone map', 'data-skyedit', 'toneMapping', SKY_TONE_MAPPINGS, sky.toneMapping)}
        ${note('Sea state is THE wave-height dial — it updates the <b>live water</b> here. The rest of the atmosphere (clouds/fog/sun/grade) applies on <b>Play</b>. The whole <b>sky</b> block is Blender-owned.')}
      </details>`
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
      .map((a) => {
        // Wave-rider props get a "(rides waves)" suffix so authors can
        // tell at a glance which placements will bob on the surface
        // instead of standing still. Per-instance archetype overrides
        // aren't authored from the editor — the archetype is asset-
        // level metadata, so the picker just shows the hint.
        const label = a.waveRider
          ? `${escapeHtml(a.displayName)} (rides waves)`
          : escapeHtml(a.displayName)
        return `<option value="${escapeHtml(a.id)}"${a.id === pickedAssetId ? ' selected' : ''}>${label}</option>`
      })
      .join('')
    return `<div style="color:#9bb;margin-top:4px">Assets</div>
       <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
         <select id="ed-asset-pick" style="background:#234;color:#dde;border:1px solid #456;padding:3px 4px;border-radius:3px;font:inherit;flex:1;min-width:0">${opts}</select>
         ${placeBtn('asset', '+ Place')}
         ${placeBtn('propLine', '+ Prop Line')}
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
          label: `start${typeof draft.start.splineT === 'number' ? ' ⚓' : ''}  (${draft.start.position.x.toFixed(0)}, ${draft.start.position.z.toFixed(0)})  yaw ${((draft.start.yaw * 180) / Math.PI).toFixed(0)}°`,
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
        'Prop Lines',
        (draft.propLines ?? []).map((l, i) => {
          const src = l.bind
            ? `⤳ t${(l.bind.t0 ?? 0).toFixed(2)}–${(l.bind.t1 ?? 1).toFixed(2)}`
            : `×${l.anchors.length}a`
          return {
            k: `propline:${i}`,
            label: `${escapeHtml(l.id)}  ${escapeHtml(l.assetId)} ${src}`,
            sel: { kind: 'propLine', index: i } as EntitySel,
          }
        }),
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
    sections.push(
      outlinerSection(
        'Wave Zones',
        draft.waveZones.map((z, i) => ({
          k: `wavezone:${i}`,
          label: `wavezone_${i}  (${z.position.x.toFixed(0)}, ${z.position.z.toFixed(0)})  ×${z.heightMult.toFixed(2)}`,
          sel: { kind: 'waveZone', index: i } as EntitySel,
        })),
      ),
    )
    sections.push(
      outlinerSection(
        'Anti-Grav Zones',
        draft.antiGravZones.map((z, i) => ({
          k: `antigrav:${i}`,
          label: `antigrav_${i}  (${z.position.x.toFixed(0)}, ${z.position.z.toFixed(0)})`,
          sel: { kind: 'antiGrav', index: i } as EntitySel,
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
    if (sel.kind === 'start') return startPropsHtml()
    if (sel.kind === 'prop') return propPropsHtml(sel.index)
    if (sel.kind === 'gate') return gatePropsHtml(sel.index)
    if (sel.kind === 'pickup') {
      const p = draft.pickupSpawns[sel.index]
      if (!p) return '(missing)'
      return `<div><b>pickup_${sel.index}</b></div>${vec3Row('pos', 'data-numedit', 'pos', p)}`
    }
    if (sel.kind === 'pad') return padPropsHtml(sel.index)
    if (sel.kind === 'antiGrav') return antiGravPropsHtml(sel.index)
    if (sel.kind === 'waveZone') return waveZonePropsHtml(sel.index)
    if (sel.kind === 'propLine') return propLinePropsHtml(sel.index)
    if (sel.kind === 'propLineAnchor') {
      const a = draft.propLines?.[sel.lineIndex]?.anchors[sel.anchorIndex]
      if (!a) return '(missing)'
      return `<div><b>${escapeHtml(draft.propLines?.[sel.lineIndex]?.id ?? '')} · anchor ${sel.anchorIndex}</b></div>${vec3Row('pos', 'data-numedit', 'pos', a)}${note('drag to reshape the curve; the instances re-flow live.')}`
    }
    const sp = draft.aiSplines[sel.splineIndex]
    if (!sp) return '(missing)'
    const arr = sp.anchors ?? sp.points
    const p = arr[sel.pointIndex]
    if (!p) return '(missing)'
    const label = sp.anchors ? 'spline anchor' : 'spline pt'
    return `<div><b>${label} ${sel.pointIndex}</b></div>${vec3Row('pos', 'data-numedit', 'pos', p)}`
  }

  function startPropsHtml(): string {
    const hasSpline = draft.aiSplines.some((s) => s.id === 'main')
    const isBound = typeof draft.start.splineT === 'number'
    const rows: string[] = [
      `<div><b>start</b></div>`,
      `<div style="color:#7c9">controls position + facing for the player pole and the 2×4 AI grid</div>`,
    ]
    if (isBound) {
      const t = draft.start.splineT!
      rows.push(
        `<div style="color:#7c9">⚓ bound to main spline @ t=${t.toFixed(3)}</div>`,
        numRow('Height (y)', 'data-numedit', 'pos.y', draft.start.position.y, { step: 0.5 }),
        `<label style="display:flex;align-items:center;gap:6px;margin-top:4px">
           <span style="width:24px;color:#9bb">t</span>
           <input id="ed-start-spline-t" type="range" min="0" max="1" step="0.001" value="${t}" style="flex:1" />
           <span id="ed-start-spline-t-val" style="width:48px;text-align:right;color:#cdf">${t.toFixed(3)}</span>
         </label>`,
        `<button type="button" id="ed-start-unbind" style="background:#234;color:#dde;border:1px solid #456;padding:4px 6px;border-radius:3px;cursor:pointer;font:inherit;margin-top:4px">Unbind from spline</button>`,
      )
    } else {
      rows.push(
        vec3Row('pos', 'data-numedit', 'pos', draft.start.position),
        numRow('Yaw°', 'data-numedit', 'yawDeg', (draft.start.yaw * 180) / Math.PI, { step: 1 }),
      )
      if (hasSpline) {
        rows.push(
          `<button type="button" id="ed-start-bind" style="background:#234;color:#dde;border:1px solid #456;padding:4px 6px;border-radius:3px;cursor:pointer;font:inherit;margin-top:4px">Snap to spline</button>`,
        )
      } else {
        rows.push(
          `<div style="color:#778">no main spline — place spline anchors to enable curve binding</div>`,
        )
      }
    }
    return rows.join('')
  }

  function gatePropsHtml(index: number): string {
    const cp = draft.checkpoints[index]
    if (!cp) return '(missing)'
    const bound = typeof cp.splineT === 'number'
    const rows: string[] = [`<div><b>cp_${String(cp.index).padStart(2, '0')}</b></div>`]
    if (bound) {
      rows.push(
        `<div style="color:#7c9">⚓ bound to spline @ t=${cp.splineT!.toFixed(3)}</div>`,
        numRow('t', 'data-numedit', 'splineT', cp.splineT!, { min: 0, max: 1, step: 0.001 }),
        numRow('Height (y)', 'data-numedit', 'pos.y', cp.position.y, { step: 0.5 }),
      )
    } else {
      rows.push(vec3Row('pos', 'data-numedit', 'pos', cp.position))
    }
    rows.push(
      numRow('Half width', 'data-numedit', 'halfWidth', cp.halfWidth, {
        min: 0.5,
        max: 200,
        step: 0.5,
      }),
      numRow('Height', 'data-numedit', 'height', cp.height, { min: 0.5, max: 50, step: 0.5 }),
    )
    if (bound) {
      rows.push(
        `<button type="button" id="ed-gate-unbind" style="background:#234;color:#dde;border:1px solid #456;padding:4px 6px;border-radius:3px;cursor:pointer;font:inherit;margin-top:4px">Unbind from spline</button>`,
      )
    }
    return rows.join('')
  }

  function padPropsHtml(index: number): string {
    const pad = draft.boostPads[index]
    if (!pad) return '(missing)'
    return [
      `<div><b>pad_${index}</b></div>`,
      vec3Row('pos', 'data-numedit', 'pos', pad.position),
      numRow('Half width', 'data-numedit', 'halfWidth', pad.halfWidth, {
        min: 0.5,
        max: 50,
        step: 0.5,
      }),
      numRow('Half height', 'data-numedit', 'halfHeight', pad.halfHeight, {
        min: 0.5,
        max: 50,
        step: 0.5,
      }),
      numRow('Half depth', 'data-numedit', 'halfDepth', pad.halfDepth, {
        min: 0.5,
        max: 100,
        step: 0.5,
      }),
      numRow('Strength', 'data-numedit', 'strength', pad.strength, { min: 1, max: 5, step: 0.1 }),
      note('strength = top-speed multiplier while the bike is inside the volume.'),
    ].join('')
  }

  function antiGravPropsHtml(index: number): string {
    const z = draft.antiGravZones[index]
    if (!z) return '(missing)'
    return [
      `<div><b>antigrav_${index}</b></div>`,
      vec3Row('pos', 'data-numedit', 'pos', z.position),
      numRow('Half width', 'data-numedit', 'halfWidth', z.halfWidth, {
        min: 0.5,
        max: 200,
        step: 0.5,
      }),
      numRow('Half height', 'data-numedit', 'halfHeight', z.halfHeight, {
        min: 0.5,
        max: 100,
        step: 0.5,
      }),
      numRow('Half depth', 'data-numedit', 'halfDepth', z.halfDepth, {
        min: 0.5,
        max: 400,
        step: 0.5,
      }),
      note(
        'rotate so local +Y matches the road surface normal. (Anti-grav is parked for a future DLC — no shipped track uses it.)',
      ),
    ].join('')
  }

  function waveZonePropsHtml(index: number): string {
    const z = draft.waveZones[index]
    if (!z) return '(missing)'
    const hasDir = typeof z.directionDeg === 'number'
    const hasSurge = typeof z.surgePeriodS === 'number'
    const rows: string[] = [
      `<div><b>wavezone_${index}</b></div>`,
      vec3Row('pos', 'data-numedit', 'pos', z.position),
      numRow('Half width', 'data-numedit', 'halfWidth', z.halfWidth, {
        min: 0.5,
        max: 600,
        step: 1,
      }),
      numRow('Half height', 'data-numedit', 'halfHeight', z.halfHeight, {
        min: 0.5,
        max: 200,
        step: 1,
      }),
      numRow('Half depth', 'data-numedit', 'halfDepth', z.halfDepth, {
        min: 0.5,
        max: 600,
        step: 1,
      }),
      numRow('Height ×', 'data-numedit', 'heightMult', z.heightMult, {
        min: 0.05,
        max: 8,
        step: 0.05,
      }),
      numRow('Freq ×', 'data-numedit', 'freqMult', z.freqMult, { min: 0.1, max: 8, step: 0.05 }),
      numRow('Blend (m)', 'data-numedit', 'blendRadiusM', z.blendRadiusM, {
        min: 0.5,
        max: 200,
        step: 1,
      }),
    ]
    rows.push(
      hasDir
        ? `${numRow('Swell dir°', 'data-numedit', 'directionDeg', z.directionDeg!, { min: -180, max: 180, step: 1 })}<button type="button" data-numclear="directionDeg" style="background:#234;color:#9ab;border:1px solid #456;border-radius:3px;cursor:pointer;font:inherit;padding:1px 6px;margin-top:2px">clear dir (inherit global)</button>`
        : `<button type="button" data-numedit-set="directionDeg" style="background:#234;color:#9ab;border:1px solid #456;border-radius:3px;cursor:pointer;font:inherit;padding:2px 6px;margin-top:3px">+ swell direction override</button>`,
    )
    rows.push(
      hasSurge
        ? [
            numRow('Surge period', 'data-numedit', 'surgePeriodS', z.surgePeriodS!, {
              min: 0.5,
              step: 0.5,
            }),
            numRow('Surge amp', 'data-numedit', 'surgeAmplitude', z.surgeAmplitude ?? 0, {
              step: 0.1,
            }),
            `<button type="button" data-numclear="surge" style="background:#234;color:#9ab;border:1px solid #456;border-radius:3px;cursor:pointer;font:inherit;padding:1px 6px;margin-top:2px">clear surge</button>`,
          ].join('')
        : `<button type="button" data-numedit-set="surge" style="background:#234;color:#9ab;border:1px solid #456;border-radius:3px;cursor:pointer;font:inherit;padding:2px 6px;margin-top:3px">+ periodic surge (tsunami)</button>`,
    )
    rows.push(
      note(
        'Scales global wave amplitude/frequency inside the box (live: buoyancy + water shader + AI). Max 8 zones/track.',
      ),
    )
    return rows.join('')
  }

  function propLinePropsHtml(index: number): string {
    const line = draft.propLines?.[index]
    if (!line) return '(missing)'
    const isCount = (line.spacingMode ?? 'arcLength') === 'count'
    const assetIds = propAssets.map((a) => a.id)
    const mainSpline = draft.aiSplines.find((s) => s.id === 'main')
    const mainPts = mainSpline?.points
    const hasMainSpline = (mainPts?.length ?? 0) >= 2
    const isBound = line.bind != null
    const isSeated = line.seatToTerrain === true
    const rows: string[] = [`<div><b>${escapeHtml(line.id)}</b></div>`]
    rows.push(
      assetIds.length > 0
        ? selectRow('Asset', 'data-proplineflag', 'assetId', assetIds, line.assetId)
        : `<div>asset: <b>${escapeHtml(line.assetId)}</b></div>`,
    )
    // ── Source: anchors (default) vs spline-bind ──
    if (hasMainSpline || isBound) {
      rows.push(boolRow('Bind to spline', 'data-proplineflag', 'bind', isBound))
    }
    if (isBound) {
      const t0 = line.bind?.t0 ?? 0
      const t1 = line.bind?.t1 ?? 1
      rows.push(
        `<label style="display:flex;align-items:center;gap:6px;margin-top:3px">
           <span style="width:24px;color:#9bb">t0</span>
           <input id="ed-propline-t0" type="range" min="0" max="1" step="0.001" value="${t0}" style="flex:1" />
           <span id="ed-propline-t0-val" style="width:42px;text-align:right;color:#cdf">${t0.toFixed(3)}</span>
         </label>`,
        `<label style="display:flex;align-items:center;gap:6px;margin-top:3px">
           <span style="width:24px;color:#9bb">t1</span>
           <input id="ed-propline-t1" type="range" min="0" max="1" step="0.001" value="${t1}" style="flex:1" />
           <span id="ed-propline-t1-val" style="width:42px;text-align:right;color:#cdf">${t1.toFixed(3)}</span>
         </label>`,
      )
    }
    rows.push(
      selectRow(
        'Spacing',
        'data-proplineflag',
        'spacingMode',
        ['arcLength', 'count'],
        line.spacingMode ?? 'arcLength',
      ),
      isCount
        ? numRow('Count', 'data-numedit', 'count', line.count ?? 1, { min: 1, max: 1000, step: 1 })
        : numRow('Spacing m', 'data-numedit', 'spacingM', line.spacingM ?? 6, {
            min: 0.25,
            step: 0.5,
          }),
      numRow('Offset m', 'data-numedit', 'offsetM', line.offsetM ?? 0, { step: 0.5 }),
      numRow(
        isSeated ? 'Height m' : 'Normal m',
        'data-numedit',
        'normalOffsetM',
        line.normalOffsetM ?? 0,
        { step: 0.25 },
      ),
      boolRow('Seat to terrain', 'data-proplineflag', 'seatToTerrain', isSeated),
      numRow('Scale', 'data-numedit', 'scale', line.scale ?? 1, { min: 0.05, step: 0.1 }),
      boolRow(
        'Align to tangent',
        'data-proplineflag',
        'alignToTangent',
        line.alignToTangent !== false,
      ),
      numRow('Yaw°', 'data-numedit', 'yawDeg', line.yawDeg ?? 0, { step: 5 }),
    )
    // Closed-loop is anchor-only — for a bound line the slice decides closedness.
    if (!isBound) {
      rows.push(boolRow('Closed loop', 'data-proplineflag', 'closed', line.closed === true))
    }
    rows.push(
      `<div style="color:#9bb;margin-top:5px">Jitter</div>`,
      numRow('Pos m', 'data-numedit', 'jitter.posM', line.jitter?.posM ?? 0, {
        min: 0,
        step: 0.25,
      }),
      numRow('Yaw°', 'data-numedit', 'jitter.yawDeg', line.jitter?.yawDeg ?? 0, {
        min: 0,
        step: 5,
      }),
      numRow('Scale min', 'data-numedit', 'jitter.scaleMin', line.jitter?.scaleMin ?? 1, {
        min: 0.05,
        step: 0.05,
      }),
      numRow('Scale max', 'data-numedit', 'jitter.scaleMax', line.jitter?.scaleMax ?? 1, {
        min: 0.05,
        step: 0.05,
      }),
      `<div style="color:#9bb;margin-top:5px">Flags</div>`,
      selectRow(
        'Surface',
        'data-proplineflag',
        'surface',
        SURFACE_VALUES,
        line.surface ?? 'default',
      ),
      boolRow('Waterline bands', 'data-proplineflag', 'waterline', line.waterline !== false),
      boolRow('Float on waves', 'data-proplineflag', 'waveRider', line.waveRider != null),
    )
    if (line.waveRider != null) {
      rows.push(
        selectRow(
          '  ↳ DOF',
          'data-proplineflag',
          'waveRiderDof',
          WAVE_RIDER_DOFS,
          line.waveRider.dof ?? 'locked',
        ),
      )
    }
    let count = 0
    try {
      count = expandPropLine(line, { mainSplinePoints: mainPts }).length
    } catch {
      count = 0
    }
    if (!isBound) {
      rows.push(
        `<button type="button" id="ed-propline-add-anchor" style="background:#234;color:#dde;border:1px solid #456;padding:4px 6px;border-radius:3px;cursor:pointer;font:inherit;margin-top:6px">+ anchor</button>`,
      )
    }
    const along = isBound
      ? `the racing line t=${(line.bind?.t0 ?? 0).toFixed(2)}–${(line.bind?.t1 ?? 1).toFixed(2)}`
      : `${line.anchors.length} anchors`
    const shapeHint = isBound
      ? 'Drag the t0/t1 sliders to slide the stretch; Delete removes the line.'
      : 'Drag the amber anchors to shape; Delete removes the line/anchor.'
    const seatHint = isSeated ? ' Seated to terrain (Height m above ground).' : ''
    rows.push(note(`${count} instance(s) along ${along}.${seatHint} ${shapeHint}`))
    return rows.join('')
  }

  function propPropsHtml(index: number): string {
    const p = draft.props[index]
    if (!p) return '(missing)'
    const isAsset = p.type === 'asset'
    const rows: string[] = [
      `<div><b>${PROP_LABELS[p.type]}_${index}</b>${isAsset && p.assetId ? ` <span style="color:#789">${escapeHtml(p.assetId)}</span>` : ''}</div>`,
      vec3Row('pos', 'data-numedit', 'pos', p.position),
      vec3Row(isAsset ? 'scale' : 'size', 'data-numedit', 'size', p.size, isAsset ? 0.05 : 0.25),
      `<div style="color:#7c9">${isAsset ? 'size = uniform-ish scale of the GLB' : escapeHtml(propSizeHint(p.type))}</div>`,
    ]
    // ── Flags ──
    rows.push(
      `<div style="color:#9bb;margin-top:6px;border-top:1px solid #2a3a4a;padding-top:5px">Flags</div>`,
    )
    if (!isAsset) {
      rows.push(colorRow('Colour', 'data-propflag', 'color', p.color))
    }
    rows.push(
      selectRow('Surface', 'data-propflag', 'surface', SURFACE_VALUES, p.surface ?? 'default'),
    )
    rows.push(boolRow('Waterline bands', 'data-propflag', 'waterline', p.waterline !== false))
    rows.push(boolRow('Float on waves', 'data-propflag', 'waveRider', p.waveRider != null))
    if (p.waveRider != null) {
      rows.push(
        selectRow(
          '  ↳ DOF',
          'data-propflag',
          'waveRiderDof',
          WAVE_RIDER_DOFS,
          p.waveRider.dof ?? 'locked',
        ),
      )
    }
    if (isAsset) {
      rows.push(boolRow('Animated', 'data-propflag', 'animated', p.animated === true))
      if (p.animated) {
        rows.push(
          textRow('  ↳ Clip', 'data-propflag', 'clip', p.clip ?? ''),
          boolRow('  ↳ Loop', 'data-propflag', 'loop', p.loop !== false),
        )
      }
    }
    return rows.join('')
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
    panel.querySelector('#ed-start-bind')?.addEventListener('click', () => {
      callbacks.onStartBindToSpline()
    })
    panel.querySelector('#ed-start-unbind')?.addEventListener('click', () => {
      callbacks.onStartUnbindFromSpline()
    })
    const startTSlider = panel.querySelector<HTMLInputElement>('#ed-start-spline-t')
    if (startTSlider) {
      const label = panel.querySelector<HTMLElement>('#ed-start-spline-t-val')
      startTSlider.addEventListener('input', () => {
        const v = parseFloat(startTSlider.value)
        if (Number.isFinite(v)) {
          if (label) label.textContent = v.toFixed(3)
          callbacks.onStartSplineTChange(v)
        }
      })
      startTSlider.addEventListener('change', () => {
        callbacks.onStartSplineTCommit()
      })
    }
    panel.querySelector('#ed-gate-unbind')?.addEventListener('click', () => {
      callbacks.onGateUnbindFromSpline()
    })

    // ── Generic authoring controls (numeric entry / flags / settings) ──
    // Persist collapsible-section open state across full re-renders.
    panel.querySelectorAll<HTMLDetailsElement>('[data-section]').forEach((el) => {
      el.addEventListener('toggle', () => {
        sectionOpen[el.dataset.section as string] = el.open
      })
    })
    // Typed numeric entry on the selected entity — one undo per commit.
    panel.querySelectorAll<HTMLInputElement>('[data-numedit]').forEach((el) => {
      el.addEventListener('change', () => {
        const v = parseFloat(el.value)
        if (Number.isFinite(v)) callbacks.onNumEdit(el.dataset.numedit as string, v)
      })
    })
    // Materialise an optional numeric field at a sane default.
    panel.querySelectorAll<HTMLElement>('[data-numedit-set]').forEach((el) => {
      el.addEventListener('click', () => {
        const f = el.dataset.numeditSet as string
        if (f === 'surge') callbacks.onNumEdit('surgePeriodS', 8)
        else callbacks.onNumEdit(f, 0)
      })
    })
    panel.querySelectorAll<HTMLElement>('[data-numclear]').forEach((el) => {
      el.addEventListener('click', () => callbacks.onNumClear(el.dataset.numclear as string))
    })
    // Track-level settings (name / laps / gateSpacing / floatGates).
    panel.querySelectorAll<HTMLElement>('[data-trackedit]').forEach((el) => {
      const field = el.dataset.trackedit as string
      el.addEventListener('change', () => {
        if (el instanceof HTMLInputElement && el.type === 'checkbox') {
          callbacks.onTrackFieldEdit(field, el.checked)
        } else if (el instanceof HTMLInputElement && el.type === 'number') {
          const v = parseFloat(el.value)
          if (Number.isFinite(v)) callbacks.onTrackFieldEdit(field, v)
        } else if (el instanceof HTMLInputElement) {
          callbacks.onTrackFieldEdit(field, el.value)
        }
      })
    })
    // Sky / atmosphere block.
    panel.querySelectorAll<HTMLElement>('[data-skyedit]').forEach((el) => {
      const field = el.dataset.skyedit as string
      el.addEventListener('change', () => {
        if (el instanceof HTMLSelectElement) {
          callbacks.onSkyEdit(field, el.value)
        } else if (el instanceof HTMLInputElement && el.type === 'number') {
          const v = parseFloat(el.value)
          if (Number.isFinite(v)) callbacks.onSkyEdit(field, v)
        } else if (el instanceof HTMLInputElement) {
          callbacks.onSkyEdit(field, el.value)
        }
      })
    })
    panel.querySelectorAll<HTMLElement>('[data-skyedit-clear]').forEach((el) => {
      el.addEventListener('click', () =>
        callbacks.onSkyEdit(el.dataset.skyeditClear as string, null),
      )
    })
    // Per-prop flags.
    panel.querySelectorAll<HTMLElement>('[data-propflag]').forEach((el) => {
      const field = el.dataset.propflag as string
      el.addEventListener('change', () => {
        if (el instanceof HTMLInputElement && el.type === 'checkbox') {
          callbacks.onPropFlagEdit(field, el.checked)
        } else if (el instanceof HTMLSelectElement) {
          callbacks.onPropFlagEdit(field, el.value)
        } else if (el instanceof HTMLInputElement) {
          callbacks.onPropFlagEdit(field, el.value)
        }
      })
    })
    panel.querySelectorAll<HTMLElement>('[data-propflag-clear]').forEach((el) => {
      el.addEventListener('click', () =>
        callbacks.onPropFlagEdit(el.dataset.propflagClear as string, null),
      )
    })
    // Prop-line flags (asset / spacing mode / surface / dof selects + closed /
    // align / waterline / waveRider checkboxes).
    panel.querySelectorAll<HTMLElement>('[data-proplineflag]').forEach((el) => {
      const field = el.dataset.proplineflag as string
      el.addEventListener('change', () => {
        if (el instanceof HTMLInputElement && el.type === 'checkbox') {
          callbacks.onPropLineFlag(field, el.checked)
        } else if (el instanceof HTMLSelectElement) {
          callbacks.onPropLineFlag(field, el.value)
        }
      })
    })
    panel.querySelector('#ed-propline-add-anchor')?.addEventListener('click', () => {
      callbacks.onPropLineAddAnchor()
    })
    // Spline-bound prop-line t0/t1 sliders (mirror the start-on-spline slider).
    for (const which of ['t0', 't1'] as const) {
      const slider = panel.querySelector<HTMLInputElement>(`#ed-propline-${which}`)
      if (!slider) continue
      const label = panel.querySelector<HTMLElement>(`#ed-propline-${which}-val`)
      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value)
        if (Number.isFinite(v)) {
          if (label) label.textContent = v.toFixed(3)
          callbacks.onPropLineBindTChange(which, v)
        }
      })
      slider.addEventListener('change', () => {
        callbacks.onPropLineBindTCommit()
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

// ── Input-builder helpers ─────────────────────────────────────────────────
//
// Every authoring control routes through one of a small set of `data-*`
// attributes that `wirePanelEvents` listens for. The attribute name selects
// which callback fires; the attribute value is the logical field path.

const INPUT_STYLE =
  'background:#1a2230;color:#cdf;border:1px solid #3a4a5a;border-radius:3px;padding:2px 4px;font:inherit;min-width:0'

/** A single editable number. `attr` is the routing data-attribute name
 *  (e.g. `data-numedit`). Renders nothing fancy — commit fires on change. */
function numInput(
  attr: string,
  field: string,
  value: number,
  opts?: { min?: number; max?: number; step?: number; width?: number },
): string {
  const bits: string[] = [`step="${opts?.step ?? 'any'}"`]
  if (opts?.min !== undefined) bits.push(`min="${opts.min}"`)
  if (opts?.max !== undefined) bits.push(`max="${opts.max}"`)
  const w = opts?.width ?? 60
  return `<input type="number" ${attr}="${escapeHtml(field)}" value="${value}" ${bits.join(
    ' ',
  )} style="${INPUT_STYLE};width:${w}px" />`
}

/** Label + control row. */
function fieldRow(label: string, control: string): string {
  return `<label style="display:flex;align-items:center;gap:6px;margin-top:3px"><span style="width:74px;color:#9bb;flex-shrink:0">${label}</span>${control}</label>`
}

/** A labelled x/y/z triple of number inputs, fields `${prefix}.x` etc. */
function vec3Row(
  label: string,
  attr: string,
  prefix: string,
  v: { x: number; y: number; z: number },
  step = 0.1,
): string {
  const i = (axis: 'x' | 'y' | 'z') =>
    numInput(attr, `${prefix}.${axis}`, Number(v[axis].toFixed(3)), { step, width: 54 })
  return `<label style="display:flex;align-items:center;gap:4px;margin-top:3px"><span style="width:74px;color:#9bb;flex-shrink:0">${label}</span>${i('x')}${i('y')}${i('z')}</label>`
}

/** A bounded number row. */
function numRow(
  label: string,
  attr: string,
  field: string,
  value: number,
  opts?: { min?: number; max?: number; step?: number },
): string {
  return fieldRow(label, numInput(attr, field, Number(value.toFixed(4)), { ...opts, width: 72 }))
}

/** A checkbox row. */
function boolRow(label: string, attr: string, field: string, checked: boolean): string {
  return `<label style="display:flex;align-items:center;gap:6px;margin-top:3px;cursor:pointer"><input type="checkbox" ${attr}="${escapeHtml(
    field,
  )}" ${checked ? 'checked' : ''} /><span style="color:#9bb">${label}</span></label>`
}

/** A <select> row. `value` may be undefined → first option selected. */
function selectRow(
  label: string,
  attr: string,
  field: string,
  options: readonly string[],
  value: string | undefined,
): string {
  const opts = options
    .map(
      (o) =>
        `<option value="${escapeHtml(o)}"${o === value ? ' selected' : ''}>${escapeHtml(o)}</option>`,
    )
    .join('')
  return fieldRow(
    label,
    `<select ${attr}="${escapeHtml(field)}" style="${INPUT_STYLE};flex:1">${opts}</select>`,
  )
}

/** A text-input row. */
function textRow(label: string, attr: string, field: string, value: string): string {
  return fieldRow(
    label,
    `<input type="text" ${attr}="${escapeHtml(field)}" value="${escapeHtml(value)}" style="${INPUT_STYLE};flex:1" />`,
  )
}

/** A colour-picker row with a clear button (clears back to the default). */
function colorRow(label: string, attr: string, field: string, value: string | undefined): string {
  const v = value ?? '#c0a070'
  return `<label style="display:flex;align-items:center;gap:6px;margin-top:3px"><span style="width:74px;color:#9bb;flex-shrink:0">${label}</span><input type="color" ${attr}="${escapeHtml(
    field,
  )}" value="${escapeHtml(v)}" style="width:40px;height:20px;background:#1a2230;border:1px solid #3a4a5a;border-radius:3px" /><button type="button" ${attr}-clear="${escapeHtml(
    field,
  )}" style="background:#234;color:#9ab;border:1px solid #456;border-radius:3px;cursor:pointer;font:inherit;padding:1px 6px">clear</button></label>`
}

/** Small grey caption — used for "applies on Play" / re-export warnings. */
function note(text: string): string {
  return `<div style="color:#7a869a;font-size:10px;line-height:1.35;margin-top:3px">${text}</div>`
}

// ── Local string utils ───────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;'
    if (c === '<') return '&lt;'
    if (c === '>') return '&gt;'
    if (c === '"') return '&quot;'
    return '&#39;'
  })
}
