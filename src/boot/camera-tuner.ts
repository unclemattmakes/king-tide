/**
 * In-game chase-camera tuner — a dev overlay gated by `?camtune=1`.
 *
 * Drops a small panel of sliders (offset, look-ahead, orbit pivot, follow
 * damping, FOV) over the running game. The chase camera re-reads
 * `CHASE_CAM_TUNING` every frame ([camera.ts](../engine/render/camera.ts)),
 * so dragging a slider re-frames the live view immediately — drive a lap,
 * dial it in, then read the values straight off the panel.
 *
 * Workflow for the "apply the delta everywhere" pass:
 *   1. `?camtune=1`, find a look you like (it persists across reloads via
 *      localStorage, so you can iterate freely).
 *   2. Hit **Copy Δ** — that's `tuned − shipped baseline`, the exact delta to
 *      propagate to the other bike-framing cameras (broadcast, spectator
 *      orbit, intro). Paste it back and I'll bake it in.
 *   3. **Copy values** gives the absolute numbers to paste into
 *      `CHASE_CAM_TUNING`'s defaults so the tuned look ships.
 *
 * Dev-only: never created unless the URL param is present (wired in main.ts).
 * Mutates only the shared tuning object + `camera.fov`; touches no sim state.
 */
import type * as THREE from 'three'
import { CHASE_CAM_BASELINE, CHASE_CAM_TUNING, type ChaseCamTuning } from '@/engine/render/camera'

const STORAGE_KEY = 'hoverbike.cameraTuning.v1'
const PANEL_ID = 'camtune-panel'
const STYLE_ID = 'camtune-style'

type TuningKey = keyof ChaseCamTuning
type FieldKey = TuningKey | 'fov'

type FieldSpec = {
  key: FieldKey
  label: string
  min: number
  max: number
  step: number
}

/** Slider ranges, chosen wide enough to explore but not so wide the step is
 *  useless. Z offset is negative (behind the bike); look Z is forward. */
const FIELDS: FieldSpec[] = [
  { key: 'offsetX', label: 'offset X', min: -10, max: 10, step: 0.1 },
  { key: 'offsetY', label: 'offset Y (height)', min: 0, max: 15, step: 0.1 },
  { key: 'offsetZ', label: 'offset Z (behind)', min: -25, max: 0, step: 0.1 },
  { key: 'lookX', label: 'look X', min: -10, max: 10, step: 0.1 },
  { key: 'lookY', label: 'look Y', min: -5, max: 10, step: 0.1 },
  { key: 'lookZ', label: 'look Z (ahead)', min: 0, max: 30, step: 0.5 },
  { key: 'orbitPivotForward', label: 'orbit pivot (fwd)', min: 0, max: 15, step: 0.5 },
  { key: 'damping', label: 'follow damping', min: 1, max: 20, step: 0.5 },
  { key: 'fov', label: 'FOV', min: 30, max: 100, step: 1 },
]

export type CameraTuner = { dispose(): void }

/** Round to 2dp and strip trailing zeros — keeps the read-out tidy. */
function fmt(n: number): string {
  return Number.parseFloat(n.toFixed(2)).toString()
}

/** Signed format for deltas (+1.5 / -0.3 / 0). */
function fmtSigned(n: number): string {
  const r = Number.parseFloat(n.toFixed(2))
  return r > 0 ? `+${r}` : r.toString()
}

export function createCameraTuner(camera: THREE.PerspectiveCamera): CameraTuner {
  if (typeof document === 'undefined') return { dispose() {} }

  // Idempotent mount — drop any prior panel/style first so a double-create
  // (HMR re-run, or a caller wiring it twice) leaves exactly one panel.
  document.getElementById(PANEL_ID)?.remove()
  document.getElementById(STYLE_ID)?.remove()

  // Shipped FOV baseline (captured before any persisted override is applied),
  // so the delta read-out reports FOV drift too.
  const baselineFov = camera.fov

  function getVal(key: FieldKey): number {
    return key === 'fov' ? camera.fov : CHASE_CAM_TUNING[key]
  }
  function setVal(key: FieldKey, v: number): void {
    if (key === 'fov') {
      camera.fov = v
      camera.updateProjectionMatrix()
    } else {
      CHASE_CAM_TUNING[key] = v
    }
  }
  function baselineVal(key: FieldKey): number {
    return key === 'fov' ? baselineFov : CHASE_CAM_BASELINE[key]
  }

  function persist(): void {
    try {
      const data: Record<string, number> = {}
      for (const f of FIELDS) data[f.key] = getVal(f.key)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      // localStorage blocked (private mode) — tuning just won't persist.
    }
  }
  function loadPersisted(): void {
    let raw: string | null = null
    try {
      raw = window.localStorage.getItem(STORAGE_KEY)
    } catch {
      return
    }
    if (!raw) return
    try {
      const data = JSON.parse(raw) as Record<string, number>
      for (const f of FIELDS) {
        if (typeof data[f.key] === 'number') setVal(f.key, data[f.key] as number)
      }
    } catch {
      // corrupt blob — ignore, fall back to defaults.
    }
  }

  // Restore a previously dialed-in look before building the rows so the
  // sliders render at the persisted positions.
  loadPersisted()

  // ---- read-out builders -------------------------------------------------
  function valuesText(): string {
    return [
      `offset (x,y,z): ${fmt(getVal('offsetX'))}, ${fmt(getVal('offsetY'))}, ${fmt(getVal('offsetZ'))}`,
      `look   (x,y,z): ${fmt(getVal('lookX'))}, ${fmt(getVal('lookY'))}, ${fmt(getVal('lookZ'))}`,
      `orbitPivotForward: ${fmt(getVal('orbitPivotForward'))}`,
      `damping: ${fmt(getVal('damping'))}`,
      `fov: ${fmt(getVal('fov'))}`,
    ].join('\n')
  }
  function deltaText(): string {
    const d = (k: FieldKey) => fmtSigned(getVal(k) - baselineVal(k))
    return [
      'Δ from shipped baseline:',
      `offset: ${d('offsetX')}, ${d('offsetY')}, ${d('offsetZ')}`,
      `look:   ${d('lookX')}, ${d('lookY')}, ${d('lookZ')}`,
      `orbitPivotForward: ${d('orbitPivotForward')}`,
      `damping: ${d('damping')}`,
      `fov: ${d('fov')}`,
    ].join('\n')
  }

  // ---- DOM ---------------------------------------------------------------
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    #${PANEL_ID}{position:fixed;top:8px;left:8px;z-index:99999;width:264px;
      font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#e8eef2;
      background:rgba(12,16,20,.86);border:1px solid rgba(120,160,190,.35);
      border-radius:8px;padding:8px 9px;backdrop-filter:blur(3px);
      box-shadow:0 4px 18px rgba(0,0,0,.45);user-select:none}
    #${PANEL_ID} h4{margin:0 0 6px;font-size:11px;letter-spacing:.04em;
      display:flex;justify-content:space-between;align-items:center;
      text-transform:uppercase;color:#9fd0e8}
    #${PANEL_ID} .ct-row{display:grid;grid-template-columns:84px 1fr 46px;
      gap:5px;align-items:center;margin:2px 0}
    #${PANEL_ID} .ct-row label{color:#aebac4;white-space:nowrap;overflow:hidden;
      text-overflow:ellipsis}
    #${PANEL_ID} input[type=range]{width:100%;accent-color:#54b9e6}
    #${PANEL_ID} input[type=number]{width:100%;background:rgba(0,0,0,.35);
      color:#e8eef2;border:1px solid rgba(120,160,190,.3);border-radius:4px;
      padding:1px 3px;font:inherit}
    #${PANEL_ID} .ct-btns{display:flex;gap:5px;margin-top:7px;flex-wrap:wrap}
    #${PANEL_ID} button{flex:1;cursor:pointer;background:rgba(54,120,160,.32);
      color:#e8eef2;border:1px solid rgba(120,160,190,.4);border-radius:5px;
      padding:4px 6px;font:inherit;min-width:64px}
    #${PANEL_ID} button:hover{background:rgba(72,150,196,.5)}
    #${PANEL_ID} pre{margin:7px 0 0;padding:6px;font-size:10px;
      background:rgba(0,0,0,.4);border-radius:5px;white-space:pre-wrap;
      color:#bfe6c8;max-height:128px;overflow:auto}
    #${PANEL_ID}.ct-collapsed .ct-body{display:none}
  `
  document.head.appendChild(style)

  const panel = document.createElement('div')
  panel.id = PANEL_ID
  // Keep keystrokes typed into the panel's number inputs (and arrow-key slider
  // nudges) from leaking through to the game's global control listeners — you
  // shouldn't drive the bike while typing a camera value.
  panel.addEventListener('keydown', (e) => e.stopPropagation())
  panel.addEventListener('keyup', (e) => e.stopPropagation())

  const head = document.createElement('h4')
  head.innerHTML = '<span>chase cam · ?camtune</span>'
  const collapseBtn = document.createElement('span')
  collapseBtn.textContent = '–'
  collapseBtn.style.cursor = 'pointer'
  collapseBtn.style.padding = '0 4px'
  collapseBtn.title = 'collapse'
  collapseBtn.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('ct-collapsed')
    collapseBtn.textContent = collapsed ? '+' : '–'
  })
  head.appendChild(collapseBtn)
  panel.appendChild(head)

  const body = document.createElement('div')
  body.className = 'ct-body'
  panel.appendChild(body)

  // Per-field controls + a way to refresh them all (after reset / load).
  const syncFns: Array<() => void> = []
  let readout: HTMLPreElement

  function refreshReadout(): void {
    readout.textContent = `${valuesText()}\n\n${deltaText()}`
  }

  for (const f of FIELDS) {
    const row = document.createElement('div')
    row.className = 'ct-row'

    const label = document.createElement('label')
    label.textContent = f.label
    label.title = f.label

    const range = document.createElement('input')
    range.type = 'range'
    range.min = String(f.min)
    range.max = String(f.max)
    range.step = String(f.step)

    const num = document.createElement('input')
    num.type = 'number'
    num.min = String(f.min)
    num.max = String(f.max)
    num.step = String(f.step)

    const apply = (raw: number, from: 'range' | 'num'): void => {
      if (Number.isNaN(raw)) return
      setVal(f.key, raw)
      if (from !== 'range') range.value = String(raw)
      if (from !== 'num') num.value = fmt(raw)
      persist()
      refreshReadout()
    }
    range.addEventListener('input', () => apply(Number.parseFloat(range.value), 'range'))
    num.addEventListener('input', () => apply(Number.parseFloat(num.value), 'num'))

    const sync = (): void => {
      const v = getVal(f.key)
      range.value = String(v)
      num.value = fmt(v)
    }
    sync()
    syncFns.push(sync)

    row.append(label, range, num)
    body.appendChild(row)
  }

  const btns = document.createElement('div')
  btns.className = 'ct-btns'
  const mkBtn = (text: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = text
    b.addEventListener('click', onClick)
    return b
  }
  const flash = (b: HTMLButtonElement, msg: string): void => {
    const prev = b.textContent
    b.textContent = msg
    window.setTimeout(() => {
      b.textContent = prev
    }, 900)
  }
  const copy = (b: HTMLButtonElement, text: string): void => {
    navigator.clipboard?.writeText(text).then(
      () => flash(b, 'copied!'),
      () => flash(b, 'copy failed'),
    )
  }
  const copyValsBtn = mkBtn('Copy values', () => copy(copyValsBtn, valuesText()))
  const copyDeltaBtn = mkBtn('Copy Δ', () => copy(copyDeltaBtn, deltaText()))
  const resetBtn = mkBtn('Reset', () => {
    for (const f of FIELDS) setVal(f.key, baselineVal(f.key))
    for (const s of syncFns) s()
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore — nothing persisted.
    }
    refreshReadout()
  })
  btns.append(copyValsBtn, copyDeltaBtn, resetBtn)
  body.appendChild(btns)

  readout = document.createElement('pre')
  body.appendChild(readout)
  refreshReadout()

  document.body.appendChild(panel)

  return {
    dispose() {
      panel.remove()
      style.remove()
    },
  }
}
