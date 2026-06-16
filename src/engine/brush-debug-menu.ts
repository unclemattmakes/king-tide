/**
 * Brush-strokes tuner — live-dial the painterly brush look for TERRAIN and for
 * ROCKS/PROPS/BUILDINGS independently. Drives the shader uniforms through
 * brush-tuning-service.ts, so dragging a slider re-paints every affected surface
 * with no recompile.
 *
 * Self-contained (DOM + injected CSS, like camera-tuner.ts): docked left and
 * scene-visible (the scene stays orbitable; only the card takes pointer events),
 * so it sits in the same left gutter as the water / dev-settings tuners — the
 * dev-palette tuner host keeps just one open at a time. Persists to localStorage.
 *
 * Opened from the dev palette's Tuners group. The "Copy" button emits the
 * terrain `terrainShader` block to paste into `public/tracks/<id>.json` plus the
 * rock/prop values (those live as code defaults / VinylSceneOptions today).
 */
import {
  getBrushTuning,
  setTerrainBrush,
  setVinylBrush,
  TERRAIN_BRUSH_DEFAULTS,
  type TerrainBrushValues,
  VINYL_BRUSH_DEFAULTS,
  type VinylBrushValues,
} from './render/brush-tuning-service'

const PANEL_ID = 'brush-debug'
const STYLE_ID = 'brush-debug-style'
const STORAGE_KEY = 'hoverbike.brushTuning.v1'

export type BrushDebugMenu = { open(): void; close(): void; isOpen(): boolean }

type TerrainRow = {
  domain: 'terrain'
  key: keyof TerrainBrushValues
  label: string
  min: number
  max: number
  step: number
  fmt: (n: number) => string
}
type VinylRow = {
  domain: 'vinyl'
  key: keyof VinylBrushValues
  label: string
  min: number
  max: number
  step: number
  fmt: (n: number) => string
}
type Row = TerrainRow | VinylRow

const x2 = (n: number) => n.toFixed(2)
const ROWS: Row[] = [
  // Terrain — its own independent set.
  {
    domain: 'terrain',
    key: 'brushScale',
    label: 'Stroke size',
    min: 1,
    max: 16,
    step: 0.5,
    fmt: (n) => `${n.toFixed(1)} m`,
  },
  {
    domain: 'terrain',
    key: 'brushCurvature',
    label: 'Curvature gate',
    min: 0,
    max: 1,
    step: 0.05,
    fmt: x2,
  },
  { domain: 'terrain', key: 'brush', label: 'Strength', min: 0, max: 1.5, step: 0.05, fmt: x2 },
  // Rocks / props / buildings — separate set (cap is the main anti-straw lever).
  {
    domain: 'vinyl',
    key: 'brushPropSizeCap',
    label: 'Size cap',
    min: 2,
    max: 24,
    step: 1,
    fmt: (n) => `${n.toFixed(0)} m`,
  },
  {
    domain: 'vinyl',
    key: 'brushScale',
    label: 'Stroke size (frac)',
    min: 0.02,
    max: 0.4,
    step: 0.01,
    fmt: x2,
  },
  { domain: 'vinyl', key: 'brush', label: 'Strength', min: 0, max: 1.5, step: 0.05, fmt: x2 },
  // Illustrative (TF2) lighting dials (A1) — apply to every vinyl surface, not
  // just rocks/props; live via setVinylBrush → illustrative-lighting.ts.
  {
    domain: 'vinyl',
    key: 'illum',
    label: 'Illustrative warp',
    min: 0,
    max: 1,
    step: 0.05,
    fmt: x2,
  },
  { domain: 'vinyl', key: 'rimEmissive', label: 'Rim glow', min: 0, max: 1.5, step: 0.05, fmt: x2 },
]

type Persisted = { terrain: TerrainBrushValues; vinyl: VinylBrushValues }

function loadPersisted(): Persisted | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<Persisted>
    if (!p.terrain || !p.vinyl) return null
    return {
      terrain: { ...TERRAIN_BRUSH_DEFAULTS, ...p.terrain },
      vinyl: { ...VINYL_BRUSH_DEFAULTS, ...p.vinyl },
    }
  } catch {
    return null
  }
}
function persist(terrain: TerrainBrushValues, vinyl: VinylBrushValues): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ terrain, vinyl }))
  } catch {
    // private mode — tuning just won't survive a reload.
  }
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    #${PANEL_ID}{position:fixed;inset:0;z-index:65;display:none;pointer-events:none;
      align-items:center;justify-content:flex-start;padding-left:16px;box-sizing:border-box;
      font-family:var(--bc-font-mono,ui-monospace,Consolas,monospace);color:var(--bc-ink,#e8eef2);
      animation:bc-fade var(--t-base,.18s) var(--ease-out,ease)}
    #${PANEL_ID}.show{display:flex}
    #${PANEL_ID} .card{pointer-events:auto;width:360px;max-width:92vw;max-height:90vh;overflow:auto;
      background:rgba(10,20,36,0.95);border:1px solid var(--bc-line,rgba(120,160,190,.3));
      padding:20px 22px}
    #${PANEL_ID} h1{margin:0 0 4px;font-family:var(--bc-font-display,inherit);font-size:20px;
      letter-spacing:.16em;color:#d6b8ff}
    #${PANEL_ID} .sub{font-size:11px;opacity:.7;margin-bottom:8px;line-height:1.4}
    #${PANEL_ID} h2{font:600 10px var(--bc-font-mono,monospace);letter-spacing:.18em;
      color:var(--bc-ink-dim,#8aa0b4);margin:16px 0 6px;padding-bottom:3px;
      border-bottom:1px solid var(--bc-line,rgba(120,160,190,.25));text-transform:uppercase}
    #${PANEL_ID} .row{display:grid;grid-template-columns:128px 1fr 58px;gap:10px;align-items:center;
      padding:4px 0;font-size:12px}
    #${PANEL_ID} .row label{opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #${PANEL_ID} .row input[type=range]{width:100%;accent-color:#b388ff}
    #${PANEL_ID} .row .val{text-align:right;opacity:.9;font-size:11px}
    #${PANEL_ID} .actions{margin-top:18px;display:flex;gap:8px;justify-content:flex-end}
    #${PANEL_ID} button.action{background:rgba(179,136,255,.16);color:#d6b8ff;
      border:1px solid rgba(179,136,255,.45);font:600 11px var(--bc-font-mono,monospace);
      letter-spacing:.12em;padding:7px 14px;cursor:pointer}
    #${PANEL_ID} button.action.secondary{background:rgba(255,255,255,.05);
      color:var(--bc-ink-dim,#8aa0b4);border-color:var(--bc-line,rgba(120,160,190,.3))}
    #${PANEL_ID} button.action:hover{filter:brightness(1.18)}
  `
  document.head.appendChild(style)
}

export function installBrushDebugMenu(): BrushDebugMenu {
  // Idempotent mount (HMR / double-install).
  document.getElementById(PANEL_ID)?.remove()
  injectStyle()

  let terrain: TerrainBrushValues = { ...TERRAIN_BRUSH_DEFAULTS }
  let vinyl: VinylBrushValues = { ...VINYL_BRUSH_DEFAULTS }

  const panel = document.createElement('div')
  panel.id = PANEL_ID
  // Keep arrow-key slider nudges + typing from leaking to the game's input.
  panel.addEventListener('keydown', (e) => e.stopPropagation())
  panel.addEventListener('keyup', (e) => e.stopPropagation())

  const card = document.createElement('div')
  card.className = 'card'
  card.innerHTML =
    '<h1>BRUSH STROKES</h1>' +
    '<div class="sub">Live-tune the painterly brush. Terrain and rocks/props are independent. ' +
    'Saved to this browser. (Stroke counts in the sheet itself need <code>gen:brush-texture</code>.)</div>'
  panel.appendChild(card)

  // Build rows grouped by domain.
  const valEls = new Map<string, HTMLSpanElement>()
  const inputEls = new Map<string, HTMLInputElement>()
  const addGroup = (title: string, rows: Row[]) => {
    const h = document.createElement('h2')
    h.textContent = title
    card.appendChild(h)
    for (const row of rows) {
      const id = `${row.domain}.${row.key}`
      const rowEl = document.createElement('div')
      rowEl.className = 'row'
      const label = document.createElement('label')
      label.textContent = row.label
      const input = document.createElement('input')
      input.type = 'range'
      input.min = String(row.min)
      input.max = String(row.max)
      input.step = String(row.step)
      input.dataset.tool = id
      const val = document.createElement('span')
      val.className = 'val'
      rowEl.append(label, input, val)
      card.appendChild(rowEl)
      valEls.set(id, val)
      inputEls.set(id, input)

      const write = (n: number) => {
        if (row.domain === 'terrain') {
          terrain = { ...terrain, [row.key]: n }
          setTerrainBrush({ [row.key]: n })
        } else {
          vinyl = { ...vinyl, [row.key]: n }
          setVinylBrush({ [row.key]: n })
        }
        val.textContent = row.fmt(n)
      }
      input.addEventListener('input', () => {
        const n = Number.parseFloat(input.value)
        if (Number.isFinite(n)) write(n)
      })
      // Persist on release so dragging doesn't hammer localStorage.
      input.addEventListener('change', () => persist(terrain, vinyl))
    }
  }
  addGroup(
    'Terrain',
    ROWS.filter((r): r is TerrainRow => r.domain === 'terrain'),
  )
  addGroup(
    'Rocks · Props · Buildings',
    ROWS.filter((r): r is VinylRow => r.domain === 'vinyl'),
  )

  const actions = document.createElement('div')
  actions.className = 'actions'
  const mkBtn = (id: string, text: string, secondary: boolean): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.id = id
    b.className = secondary ? 'action secondary' : 'action'
    b.textContent = text
    return b
  }
  const resetBtn = mkBtn('bd-reset', 'RESET', true)
  const copyBtn = mkBtn('bd-copy', 'COPY', true)
  const closeBtn = mkBtn('bd-close', 'DONE', false)
  actions.append(resetBtn, copyBtn, closeBtn)
  card.appendChild(actions)

  function syncSliders(): void {
    for (const row of ROWS) {
      const id = `${row.domain}.${row.key}`
      const cur = row.domain === 'terrain' ? terrain[row.key] : vinyl[row.key]
      const input = inputEls.get(id)
      const val = valEls.get(id)
      if (input) input.value = String(cur)
      if (val) val.textContent = row.fmt(cur)
    }
  }

  function apply(): void {
    setTerrainBrush(terrain)
    setVinylBrush(vinyl)
  }

  resetBtn.addEventListener('click', () => {
    terrain = { ...TERRAIN_BRUSH_DEFAULTS }
    vinyl = { ...VINYL_BRUSH_DEFAULTS }
    apply()
    syncSliders()
    persist(terrain, vinyl)
  })

  copyBtn.addEventListener('click', () => {
    const text = [
      '// public/tracks/<id>.json',
      `"terrainShader": { "brush": ${terrain.brush}, "brushScale": ${terrain.brushScale}, "brushCurvature": ${terrain.brushCurvature} }`,
      '',
      '// rocks/props — VinylSceneOptions (glb-track.ts) or buildVinylMaterial defaults',
      `brush: ${vinyl.brush}, brushScale: ${vinyl.brushScale}, brushPropSizeCap: ${vinyl.brushPropSizeCap}`,
    ].join('\n')
    navigator.clipboard?.writeText(text).then(
      () => {
        const prev = copyBtn.textContent
        copyBtn.textContent = 'COPIED!'
        window.setTimeout(() => {
          copyBtn.textContent = prev
        }, 900)
      },
      () => undefined,
    )
  })

  function open(): void {
    // Seed from persisted tuning, else from the track's current (live) values.
    const persisted = loadPersisted()
    const cur = getBrushTuning()
    terrain = persisted?.terrain ?? cur.terrain
    vinyl = persisted?.vinyl ?? cur.vinyl
    apply()
    syncSliders()
    panel.classList.add('show')
  }
  function close(): void {
    panel.classList.remove('show')
  }

  closeBtn.addEventListener('click', close)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && panel.classList.contains('show')) close()
  })

  document.body.appendChild(panel)

  return { open, close, isOpen: () => panel.classList.contains('show') }
}
