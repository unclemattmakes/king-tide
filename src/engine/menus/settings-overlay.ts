/**
 * Settings overlay — the inventory of every tunable in the game.
 *
 * Step 0 scaffolding ships the full skeleton: four categories (Audio /
 * Video / Controls / Gameplay), every row that v1 expects, with most
 * controls disabled and a per-row gate label indicating which system
 * owns the wiring. Each milestone lights up its row as part of its
 * definition-of-done (see docs/v1-work-breakdown.md).
 *
 * The DOM root lives in `index.html` (`#settings-menu`) so we don't
 * fight the existing `body.menu-active` cascade. The first call to
 * `installSettingsOverlay()` populates the tabs and panes; subsequent
 * `open()` calls just toggle the `.show` class.
 *
 * Lazily imported by the main-menu router + the pause-menu Settings
 * button so the overlay's DOM cost doesn't enter the initial bundle.
 */

import { installMenuGamepad, type MenuGamepad } from '@/engine/input/menu-gamepad'
import {
  type AIDifficulty,
  type AntiGravCameraIntensity,
  playerSettings,
  setAIDifficulty,
  setAntiGravCameraIntensity,
  setRubberBandAssist,
  setWavePumpIntensity,
  type WavePumpIntensity,
} from '@/engine/player-settings'

type Tab = 'audio' | 'video' | 'controls' | 'gameplay'

/** Label↔intensity maps for the wave-pump select. Kept here so the
 *  row spec (which uses string options) and the runtime wiring agree
 *  on the conversion in a single place. */
const WAVE_PUMP_LABEL: Record<WavePumpIntensity, string> = {
  full: 'Full',
  subtle: 'Subtle',
  off: 'Off',
}
const WAVE_PUMP_VALUE: Record<string, WavePumpIntensity> = {
  Full: 'full',
  Subtle: 'subtle',
  Off: 'off',
}

const DIFFICULTY_LABEL: Record<AIDifficulty, string> = {
  casual: 'Casual',
  standard: 'Standard',
  hard: 'Hard',
}
const DIFFICULTY_VALUE: Record<string, AIDifficulty> = {
  Casual: 'casual',
  Standard: 'standard',
  Hard: 'hard',
}

const ANTI_GRAV_CAMERA_LABEL: Record<AntiGravCameraIntensity, string> = {
  full: 'Full',
  reduced: 'Reduced',
  off: 'Off',
}
const ANTI_GRAV_CAMERA_VALUE: Record<string, AntiGravCameraIntensity> = {
  Full: 'full',
  Reduced: 'reduced',
  Off: 'off',
}

type Control =
  | { kind: 'slider'; min: number; max: number; step: number; defaultValue: number }
  | { kind: 'toggle'; defaultValue: boolean }
  | { kind: 'select'; options: string[]; defaultValue: string }
  | { kind: 'button'; label: string }

type RowSpec = {
  id: string
  label: string
  control: Control
  /** Enabled rows are wired to live state where applicable; disabled
   *  rows render with the gate label below the (greyed) control. */
  enabled: boolean
  /** Hover/inline blurb. Required for disabled rows ("ships in M…");
   *  optional context line for enabled ones. */
  gate?: string
}

type TabSpec = {
  id: Tab
  label: string
  description: string
  rows: RowSpec[]
}

/** Single source of truth for the v1 settings inventory. Adding a new
 *  tunable means adding a row here — the visible "this isn't done yet"
 *  surface area is implicit in the gate string. */
const TAB_SPECS: TabSpec[] = [
  {
    id: 'audio',
    label: 'AUDIO',
    description: 'Master mix + per-bus levels. Owned by the audio engine.',
    rows: [
      {
        id: 'audio-master',
        label: 'Master',
        control: { kind: 'slider', min: 0, max: 1, step: 0.05, defaultValue: 0.6 },
        enabled: false,
        gate: 'Per-bus mixer ships with the music integration (M14)',
      },
      {
        id: 'audio-music',
        label: 'Music',
        control: { kind: 'slider', min: 0, max: 1, step: 0.05, defaultValue: 0.7 },
        enabled: false,
        gate: 'Music bus arrives with the track-specific music pieces',
      },
      {
        id: 'audio-sfx',
        label: 'SFX',
        control: { kind: 'slider', min: 0, max: 1, step: 0.05, defaultValue: 0.85 },
        enabled: false,
        gate: 'SFX bus arrives with the audio integration milestone',
      },
      {
        id: 'audio-ambient',
        label: 'Ambient',
        control: { kind: 'slider', min: 0, max: 1, step: 0.05, defaultValue: 0.55 },
        enabled: false,
        gate: 'Per-track ambient beds ship alongside their tracks',
      },
      {
        id: 'audio-mute',
        label: 'Mute all',
        control: { kind: 'toggle', defaultValue: false },
        enabled: false,
        gate: 'In-race mute lives on the [M] keybinding until the mixer lands',
      },
    ],
  },
  {
    id: 'video',
    label: 'VIDEO',
    description: 'Renderer + display options. Mostly browser-managed today.',
    rows: [
      {
        id: 'video-resolution',
        label: 'Resolution',
        control: {
          kind: 'select',
          options: ['Auto', '1920×1080', '2560×1440', '3840×2160'],
          defaultValue: 'Auto',
        },
        enabled: false,
        gate: 'Manual scaler ships with the perf pass (M17)',
      },
      {
        id: 'video-vsync',
        label: 'V-sync',
        control: { kind: 'toggle', defaultValue: true },
        enabled: false,
        gate: 'Browser-managed today; in-engine toggle lands with perf pass',
      },
      {
        id: 'video-framecap',
        label: 'Framerate cap',
        control: {
          kind: 'select',
          options: ['Unlimited', '60', '90', '120', '144'],
          defaultValue: 'Unlimited',
        },
        enabled: false,
        gate: 'Manual cap ships with the perf pass (M17)',
      },
      {
        id: 'video-quality',
        label: 'Render quality',
        control: {
          kind: 'select',
          options: ['Low', 'Medium', 'High', 'Ultra'],
          defaultValue: 'High',
        },
        enabled: false,
        gate: 'Quality presets ship with the perf pass (M17)',
      },
      {
        id: 'video-motion',
        label: 'Motion-sickness reduction',
        control: { kind: 'toggle', defaultValue: false },
        enabled: false,
        gate: 'Tunes chase-cam dampening + anti-grav inversion blend',
      },
    ],
  },
  {
    id: 'controls',
    label: 'CONTROLS',
    description: 'Rebinding + sensitivity. Live-tuning lives in Dev Settings for now.',
    rows: [
      {
        id: 'controls-rebind',
        label: 'Rebind keyboard',
        control: { kind: 'button', label: 'OPEN…' },
        enabled: false,
        gate: 'Rebinding UI lands with the polish/QA pass (M17)',
      },
      {
        id: 'controls-rebind-pad',
        label: 'Rebind gamepad',
        control: { kind: 'button', label: 'OPEN…' },
        enabled: false,
        gate: 'Gamepad rebinding ships alongside keyboard rebinding',
      },
      {
        id: 'controls-sensitivity',
        label: 'Gamepad sensitivity',
        control: { kind: 'slider', min: 0.5, max: 3.0, step: 0.05, defaultValue: 1.0 },
        enabled: false,
        gate: 'Use Dev Settings → Stick yaw range for now',
      },
      {
        id: 'controls-deadzone',
        label: 'Deadzone',
        control: { kind: 'slider', min: 0, max: 0.5, step: 0.01, defaultValue: 0.12 },
        enabled: false,
        gate: 'Use Dev Settings → Stick deadzone for now',
      },
      {
        id: 'controls-invert-y',
        label: 'Invert camera Y',
        control: { kind: 'toggle', defaultValue: false },
        enabled: false,
        gate: 'Mirrors the Dev Settings toggle once the surfaces merge',
      },
    ],
  },
  {
    id: 'gameplay',
    label: 'GAMEPLAY',
    description: 'Difficulty + HUD + assist toggles. Lights up as systems ship.',
    rows: [
      {
        id: 'gp-difficulty',
        label: 'AI difficulty',
        control: {
          kind: 'select',
          options: ['Casual', 'Standard', 'Hard'],
          defaultValue: DIFFICULTY_LABEL[playerSettings.aiDifficulty],
        },
        enabled: true,
        gate: 'Bakes per-AI top speed + cornering at the start of each race.',
      },
      {
        id: 'gp-rubberband',
        label: 'Rubber-band assist',
        control: { kind: 'toggle', defaultValue: playerSettings.rubberBandAssist },
        enabled: true,
        gate: 'When off, AI no longer catches up after falling behind.',
      },
      {
        id: 'gp-fov',
        label: 'Camera FOV',
        control: { kind: 'slider', min: 60, max: 110, step: 1, defaultValue: 78 },
        enabled: false,
        gate: 'FOV slider lands with the polish pass',
      },
      {
        id: 'gp-wave-pump',
        label: 'Wave-pump prompt',
        control: {
          kind: 'select',
          options: ['Full', 'Subtle', 'Off'],
          defaultValue: WAVE_PUMP_LABEL[playerSettings.wavePumpIntensity],
        },
        enabled: true,
        gate: 'Controls the in-race signal that fires on a successful pump.',
      },
      {
        id: 'gp-anti-grav',
        label: 'Anti-grav camera intensity',
        control: {
          kind: 'select',
          options: ['Full', 'Reduced', 'Off'],
          defaultValue: ANTI_GRAV_CAMERA_LABEL[playerSettings.antiGravCameraIntensity],
        },
        enabled: true,
        gate: 'Scales how much the chase camera rolls with the bike on banked walls + loops.',
      },
      {
        id: 'gp-hud-minimap',
        label: 'Show minimap',
        control: { kind: 'toggle', defaultValue: true },
        enabled: false,
        gate: 'Pending the minimap-vs-arrow decision',
      },
      {
        id: 'gp-subtitles',
        label: 'Subtitles for tutorial',
        control: { kind: 'toggle', defaultValue: true },
        enabled: false,
        gate: 'Ships with the tutorial framework',
      },
      {
        id: 'gp-replay-tutorial',
        label: 'Replay tutorial',
        control: { kind: 'button', label: 'RUN AGAIN…' },
        enabled: false,
        gate: 'Available once Sandbar ships',
      },
      {
        id: 'gp-leaderboard-submit',
        label: 'Submit times to leaderboard',
        control: { kind: 'toggle', defaultValue: true },
        enabled: false,
        gate: 'Lights up once the leaderboard backend lands',
      },
    ],
  },
]

export interface SettingsOverlayHandle {
  open(): void
  close(): void
  isOpen(): boolean
  dispose(): void
}

let installed: SettingsOverlayHandle | null = null

/** First call mounts the DOM; subsequent calls return the same handle.
 *  Toggle visibility via `open()` / `close()` on the handle. */
export function installSettingsOverlay(): SettingsOverlayHandle {
  if (installed) return installed

  const root = document.getElementById('settings-menu')
  const tabsEl = document.getElementById('sm-tabs')
  const paneEl = document.getElementById('sm-pane')
  if (!root || !tabsEl || !paneEl) {
    // Defensive — the index.html shell should always carry this DOM,
    // but the early dispatcher branches make pathological cases possible
    // (e.g. ?viewer=… where the menu DOM is irrelevant). Build a no-op
    // handle so the caller doesn't crash.
    const noop: SettingsOverlayHandle = {
      open() {},
      close() {},
      isOpen: () => false,
      dispose() {},
    }
    return noop
  }

  // `root`, `tabsEl`, `paneEl` are null-checked above and captured here
  // as non-null locals so the closures don't need repeated assertions.
  const rootEl = root
  const tabsHost = tabsEl
  const paneHost = paneEl
  let activeTab: Tab = 'audio'
  let gamepad: MenuGamepad | null = null
  let previousFocus: HTMLElement | null = null

  function renderTabs(): void {
    tabsHost.innerHTML = ''
    for (const t of TAB_SPECS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `sm-tab${t.id === activeTab ? ' active' : ''}`
      btn.dataset.tab = t.id
      const enabledCount = t.rows.filter((r) => r.enabled).length
      btn.innerHTML = `${t.label}<span class="count">${enabledCount}/${t.rows.length}</span>`
      btn.addEventListener('click', () => {
        activeTab = t.id
        renderTabs()
        renderPane()
      })
      tabsHost.appendChild(btn)
    }
  }

  function renderPane(): void {
    const tab = TAB_SPECS.find((t) => t.id === activeTab)
    if (!tab) return
    paneHost.innerHTML = `
      <h2 id="sm-title">${escapeHtml(tab.label)}</h2>
      <div class="sm-sub">${escapeHtml(tab.description)}</div>
      <div class="sm-rows" id="sm-rows"></div>
      <div class="sm-actions">
        <button type="button" class="secondary" id="sm-reset">RESET</button>
        <button type="button" id="sm-close">DONE</button>
      </div>
    `
    const rowsHost = paneHost.querySelector<HTMLElement>('#sm-rows')
    if (!rowsHost) return
    for (const row of tab.rows) {
      rowsHost.appendChild(buildRow(row))
    }
    paneHost.querySelector<HTMLButtonElement>('#sm-close')?.addEventListener('click', close)
    // Reset is intentionally inert in Step 0 — none of the rows wire
    // back to persisted state yet. Disabling rather than removing keeps
    // the action chrome visible so it doesn't churn later.
    const reset = paneHost.querySelector<HTMLButtonElement>('#sm-reset')
    if (reset) {
      reset.disabled = true
      reset.title = 'Resets land once individual rows wire to persisted state.'
    }
  }

  function buildRow(spec: RowSpec): HTMLElement {
    const row = document.createElement('div')
    row.className = `sm-row${spec.enabled ? '' : ' disabled'}`
    row.dataset.row = spec.id

    const label = document.createElement('div')
    label.className = 'sm-lbl'
    label.textContent = spec.label.toUpperCase()
    row.appendChild(label)

    const ctrl = document.createElement('div')
    ctrl.className = 'sm-ctrl'
    ctrl.appendChild(buildControlEl(spec))
    if (spec.gate) {
      const gate = document.createElement('span')
      gate.className = 'sm-gate'
      gate.textContent = spec.gate
      ctrl.appendChild(gate)
    }
    row.appendChild(ctrl)
    return row
  }

  function buildControlEl(spec: RowSpec): HTMLElement {
    const c = spec.control
    if (c.kind === 'slider') {
      const range = document.createElement('input')
      range.type = 'range'
      range.min = String(c.min)
      range.max = String(c.max)
      range.step = String(c.step)
      range.value = String(c.defaultValue)
      range.disabled = !spec.enabled
      return range
    }
    if (c.kind === 'toggle') {
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = c.defaultValue
      cb.disabled = !spec.enabled
      if (spec.enabled && spec.id === 'gp-rubberband') {
        cb.addEventListener('change', () => {
          setRubberBandAssist(cb.checked)
        })
      }
      return cb
    }
    if (c.kind === 'select') {
      const sel = document.createElement('select')
      for (const opt of c.options) {
        const o = document.createElement('option')
        o.value = opt
        o.textContent = opt
        if (opt === c.defaultValue) o.selected = true
        sel.appendChild(o)
      }
      sel.disabled = !spec.enabled
      if (spec.enabled && spec.id === 'gp-wave-pump') {
        sel.addEventListener('change', () => {
          const v = WAVE_PUMP_VALUE[sel.value]
          if (v) setWavePumpIntensity(v)
        })
      }
      if (spec.enabled && spec.id === 'gp-difficulty') {
        sel.addEventListener('change', () => {
          const v = DIFFICULTY_VALUE[sel.value]
          if (v) setAIDifficulty(v)
        })
      }
      if (spec.enabled && spec.id === 'gp-anti-grav') {
        sel.addEventListener('change', () => {
          const v = ANTI_GRAV_CAMERA_VALUE[sel.value]
          if (v) setAntiGravCameraIntensity(v)
        })
      }
      return sel
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'sm-btn'
    btn.textContent = c.label
    btn.disabled = !spec.enabled
    return btn
  }

  function open(): void {
    if (rootEl.classList.contains('show')) return
    previousFocus = document.activeElement as HTMLElement | null
    rootEl.classList.add('show')
    rootEl.setAttribute('aria-hidden', 'false')
    document.body.classList.add('settings-active')
    renderTabs()
    renderPane()
    window.addEventListener('keydown', onKey)
    gamepad = installMenuGamepad({
      container: () => rootEl,
      onBack: close,
    })
    gamepad.focusFirst()
  }

  function close(): void {
    if (!rootEl.classList.contains('show')) return
    rootEl.classList.remove('show')
    rootEl.setAttribute('aria-hidden', 'true')
    document.body.classList.remove('settings-active')
    window.removeEventListener('keydown', onKey)
    gamepad?.dispose()
    gamepad = null
    previousFocus?.focus?.()
    previousFocus = null
  }

  function onKey(e: KeyboardEvent): void {
    if (e.code === 'Escape') {
      close()
      e.preventDefault()
    }
  }

  installed = {
    open,
    close,
    isOpen: () => rootEl.classList.contains('show'),
    dispose() {
      close()
      installed = null
    },
  }
  return installed
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
