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
import { installRebindModal } from '@/engine/menus/rebind-modal'
import {
  getMpStatus,
  type MpConnectionState,
  type MpStatus,
  onMpStatusChange,
} from '@/engine/net/mp-status'
import {
  type AIDifficulty,
  type AntiGravCameraIntensity,
  type ColorblindMode,
  type EmissiveLandmarksIntensity,
  type PreLapIntroMode,
  playerSettings,
  setAIDifficulty,
  setAnimatedLandmarks,
  setAntiGravCameraIntensity,
  setAudioBusVolume,
  setAudioMusicEnabled,
  setColorblindMode,
  setEmissiveLandmarks,
  setFramerateCap,
  setFullscreenPreferred,
  setGamepadDeadzone,
  setGamepadSensitivity,
  setHighContrast,
  setInvertCameraY,
  setLargeText,
  setLeaderboardHandle,
  setLeaderboardSubmit,
  setMotionSicknessReduction,
  setPixelRatio,
  setPreLapIntro,
  setReducedFlash,
  setReducedMotion,
  setRubberBandAssist,
  setScreenShakeIntensity,
  setSubtitlesAlwaysOn,
  setTutorialSubtitles,
  setWavePumpIntensity,
  type WavePumpIntensity,
} from '@/engine/player-settings'
import {
  FRAMERATE_CAP_LABELS,
  framerateCapFromLabel,
  framerateCapToLabel,
} from '@/engine/render/frame-cap'
import { buildReplayTutorialHref } from '@/engine/tutorial/tutorial-launch'

type Tab = 'audio' | 'video' | 'controls' | 'gameplay' | 'accessibility' | 'network'

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

const EMISSIVE_LANDMARKS_LABEL: Record<EmissiveLandmarksIntensity, string> = {
  full: 'Full',
  reduced: 'Reduced',
  off: 'Off',
}
const EMISSIVE_LANDMARKS_VALUE: Record<string, EmissiveLandmarksIntensity> = {
  Full: 'full',
  Reduced: 'reduced',
  Off: 'off',
}

const PRE_LAP_INTRO_LABEL: Record<PreLapIntroMode, string> = {
  full: 'Full',
  short: 'Short',
  off: 'Off',
}
const PRE_LAP_INTRO_VALUE: Record<string, PreLapIntroMode> = {
  Full: 'full',
  Short: 'short',
  Off: 'off',
}

const COLORBLIND_LABEL: Record<ColorblindMode, string> = {
  off: 'Off',
  deuteranopia: 'Deuteranopia',
  protanopia: 'Protanopia',
  tritanopia: 'Tritanopia',
}
const COLORBLIND_VALUE: Record<string, ColorblindMode> = {
  Off: 'off',
  Deuteranopia: 'deuteranopia',
  Protanopia: 'protanopia',
  Tritanopia: 'tritanopia',
}

type Control =
  | { kind: 'slider'; min: number; max: number; step: number; defaultValue: number }
  | { kind: 'toggle'; defaultValue: boolean }
  | { kind: 'select'; options: string[]; defaultValue: string }
  | { kind: 'button'; label: string }
  | { kind: 'text'; defaultValue: string; placeholder: string; maxLength: number }
  /** Live read-only display. The Network tab uses these for region +
   *  latency rows that re-render on `mp-status` notifications instead of
   *  on user input. */
  | { kind: 'readout'; defaultValue: string }

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
        control: {
          kind: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          defaultValue: playerSettings.audioMasterVolume,
        },
        enabled: true,
        gate: 'Scales every bus uniformly. Mute toggle below cuts to 0.',
      },
      {
        id: 'audio-music',
        label: 'Music',
        control: {
          kind: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          defaultValue: playerSettings.audioMusicVolume,
        },
        enabled: true,
        gate: 'Procedural bed today; ducks on wave-pump + explosion.',
      },
      {
        id: 'audio-sfx',
        label: 'SFX',
        control: {
          kind: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          defaultValue: playerSettings.audioSfxVolume,
        },
        enabled: true,
        gate: 'Engine, wind, pickups, weapons, wave-pump chime, gate dings.',
      },
      {
        id: 'audio-ambient',
        label: 'Ambient',
        control: {
          kind: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          defaultValue: playerSettings.audioAmbientVolume,
        },
        enabled: true,
        gate: 'Environmental beds — currently the looping water rumble.',
      },
      {
        id: 'audio-music-on',
        label: 'Music bed enabled',
        control: { kind: 'toggle', defaultValue: playerSettings.audioMusicEnabled },
        enabled: true,
        gate: 'Disable to silence the music bed entirely (keeps the bus routed).',
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
          options: [...FRAMERATE_CAP_LABELS],
          defaultValue: framerateCapToLabel(playerSettings.framerateCap),
        },
        enabled: true,
        gate: 'Gates the render half of the rAF loop (sim still steps at 60 Hz). 60 fps is the Steam Deck default.',
      },
      {
        id: 'video-pixel-ratio',
        label: 'Render scale',
        control: {
          kind: 'slider',
          min: 0.5,
          max: 1.0,
          step: 0.05,
          defaultValue: playerSettings.pixelRatio,
        },
        enabled: true,
        gate: 'Fraction of native pixels rendered. 0.75 ≈ 56% pixel count for a free GPU win.',
      },
      {
        id: 'video-fullscreen',
        label: 'Fullscreen on launch',
        control: { kind: 'toggle', defaultValue: playerSettings.fullscreenPreferred },
        enabled: true,
        gate: 'Requests fullscreen on first user gesture. Auto-on under the Steam Deck profile.',
      },
      {
        id: 'video-animated-landmarks',
        label: 'Animated landmarks',
        control: { kind: 'toggle', defaultValue: playerSettings.animatedLandmarks },
        enabled: true,
        gate: "Swings Marina Bay 7 gantry cranes + Doge's Drift Campanile bell. Off pins them to authored rest poses.",
      },
      {
        id: 'video-emissive-landmarks',
        label: 'Emissive landmarks',
        control: {
          kind: 'select',
          options: ['Full', 'Reduced', 'Off'],
          defaultValue: EMISSIVE_LANDMARKS_LABEL[playerSettings.emissiveLandmarks],
        },
        enabled: true,
        gate: "Hot-core glow for Kilauea's lava waterfall + future emissive landmarks. Reduced halves the glow for bloom-sensitive setups.",
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
    description: 'Rebind keys + tune stick feel. Persists across sessions.',
    rows: [
      {
        id: 'controls-rebind',
        label: 'Rebind keyboard',
        control: { kind: 'button', label: 'OPEN…' },
        enabled: true,
        gate: 'Swap-on-rebind keeps every action reachable.',
      },
      {
        id: 'controls-rebind-pad',
        label: 'Rebind gamepad',
        control: { kind: 'button', label: 'OPEN…' },
        enabled: true,
        gate: 'Fire + boost only — sticks + triggers stay on the standard mapping.',
      },
      {
        id: 'controls-sensitivity',
        label: 'Gamepad sensitivity',
        control: {
          kind: 'slider',
          min: 0.5,
          max: 3.0,
          step: 0.05,
          defaultValue: playerSettings.gamepadSensitivity,
        },
        enabled: true,
        gate: 'Output multiplier — clamped at full deflection, so >1 just saturates earlier.',
      },
      {
        id: 'controls-deadzone',
        label: 'Deadzone',
        control: {
          kind: 'slider',
          min: 0,
          max: 0.5,
          step: 0.01,
          defaultValue: playerSettings.gamepadDeadzone,
        },
        enabled: true,
        gate: 'Left-stick magnitude below which steer / pitch read as zero.',
      },
      {
        id: 'controls-invert-y',
        label: 'Invert camera Y',
        control: { kind: 'toggle', defaultValue: playerSettings.invertCameraY },
        enabled: true,
        gate: 'When on, push the stick / mouse up to look DOWN (flight-stick).',
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
        id: 'gp-pre-lap-intro',
        label: 'Pre-lap intro',
        control: {
          kind: 'select',
          options: ['Full', 'Short', 'Off'],
          defaultValue: PRE_LAP_INTRO_LABEL[playerSettings.preLapIntro],
        },
        enabled: true,
        gate: 'Cinematic establishing shots + F1 start-lights before the race begins. Single-player only.',
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
        control: { kind: 'toggle', defaultValue: playerSettings.tutorialSubtitles },
        enabled: true,
        gate: 'Tutorial HUD shows the title chyron either way — this toggles the hint line.',
      },
      {
        id: 'gp-replay-tutorial',
        label: 'Replay tutorial',
        control: {
          kind: 'button',
          label: playerSettings.tutorialCompleted ? 'REPLAY…' : 'RUN…',
        },
        enabled: true,
        gate: 'Loads the current track with the tutorial framework armed.',
      },
      {
        id: 'gp-leaderboard-submit',
        label: 'Submit times to leaderboard',
        control: { kind: 'toggle', defaultValue: playerSettings.leaderboardSubmit },
        enabled: true,
        gate: 'On — a TT personal best writes an entry to the local board. Off — ghosts still save but the board is bypassed.',
      },
      {
        id: 'gp-leaderboard-handle',
        label: 'Leaderboard handle',
        control: {
          kind: 'text',
          defaultValue: playerSettings.leaderboardHandle,
          placeholder: 'YOU',
          maxLength: 12,
        },
        enabled: true,
        gate: 'Up to 12 chars · letters / digits / - _ · empty falls back to "YOU".',
      },
    ],
  },
  {
    id: 'accessibility',
    label: 'ACCESSIBILITY',
    description:
      'Color, motion, and HUD options that make the game playable for more bodies. Lights up as systems land.',
    rows: [
      {
        id: 'a11y-colorblind',
        label: 'Colorblind mode',
        control: {
          kind: 'select',
          options: ['Off', 'Deuteranopia', 'Protanopia', 'Tritanopia'],
          defaultValue: COLORBLIND_LABEL[playerSettings.colorblindMode],
        },
        enabled: true,
        gate: 'Swaps the HUD palette to a safe-for-mode color set. Affects minimap dots + HUD accents.',
      },
      {
        id: 'a11y-reduced-flash',
        label: 'Reduced flash',
        control: { kind: 'toggle', defaultValue: playerSettings.reducedFlash },
        enabled: true,
        gate: 'Dampens wave-pump bar pulse, lap-flash, countdown pop.',
      },
      {
        id: 'a11y-large-text',
        label: 'Larger text',
        control: { kind: 'toggle', defaultValue: playerSettings.largeText },
        enabled: true,
        gate: 'Scales HUD font sizes 1.25×.',
      },
      {
        id: 'a11y-high-contrast',
        label: 'High contrast',
        control: { kind: 'toggle', defaultValue: playerSettings.highContrast },
        enabled: true,
        gate: 'Solid HUD backgrounds + white text for max legibility.',
      },
      {
        id: 'a11y-reduced-motion',
        label: 'Reduced motion (override)',
        control: { kind: 'toggle', defaultValue: playerSettings.reducedMotion },
        enabled: true,
        gate: 'Forces UI animation off regardless of OS setting.',
      },
      {
        id: 'a11y-motion-sickness',
        label: 'Motion-sickness reduction',
        control: { kind: 'toggle', defaultValue: playerSettings.motionSicknessReduction },
        enabled: true,
        gate: 'Dampens chase-cam roll + anti-grav inversion intensity.',
      },
      {
        id: 'a11y-screen-shake',
        label: 'Screen-shake intensity',
        control: {
          kind: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          defaultValue: playerSettings.screenShakeIntensity,
        },
        enabled: true,
        gate: 'Scales any camera/HUD shake. 0 = none.',
      },
      {
        id: 'a11y-subtitles-always',
        label: 'Subtitles always on',
        control: { kind: 'toggle', defaultValue: playerSettings.subtitlesAlwaysOn },
        enabled: true,
        gate: 'Keeps the tutorial subtitle line visible during captioned cues.',
      },
    ],
  },
  {
    id: 'network',
    label: 'NETWORK',
    description: 'Multiplayer connection status. Read-only; values update live.',
    rows: [
      {
        id: 'net-region',
        label: 'Region',
        control: { kind: 'readout', defaultValue: '—' },
        enabled: true,
        gate: 'PartyKit auto-routes to the nearest Cloudflare edge. No manual region picker.',
      },
      {
        id: 'net-endpoint',
        label: 'Endpoint',
        control: { kind: 'readout', defaultValue: '—' },
        enabled: true,
        gate: 'PartyKit host this build talks to. Override per session with ?host=<h>.',
      },
      {
        id: 'net-status',
        label: 'Connection',
        control: { kind: 'readout', defaultValue: 'OFFLINE' },
        enabled: true,
        gate: 'Live socket state — connecting · connected · reconnecting · closed.',
      },
      {
        id: 'net-room',
        label: 'Room',
        control: { kind: 'readout', defaultValue: '—' },
        enabled: true,
        gate: 'Active `?room=<id>` and your assigned peer slot (P0..P7).',
      },
      {
        id: 'net-latency',
        label: 'Latency',
        control: { kind: 'readout', defaultValue: '—' },
        enabled: true,
        gate: 'Smoothed round-trip to the relay (1 Hz ping). Stale-resets after 6 s of silence.',
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
  /** Live un-subscribe for the mp-status pub/sub. Set when the Network
   *  tab paints; cleared in `close()` or on a tab switch. */
  let mpStatusUnsub: (() => void) | null = null

  function renderTabs(): void {
    tabsHost.innerHTML = ''
    for (const t of TAB_SPECS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `sm-tab${t.id === activeTab ? ' active' : ''}`
      btn.dataset.tab = t.id
      btn.textContent = t.label
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
    // Tab switch — drop any prior live subscription so we don't keep
    // pumping updates into stale DOM. Re-subscribed below for Network.
    if (mpStatusUnsub) {
      mpStatusUnsub()
      mpStatusUnsub = null
    }
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
    if (tab.id === 'network') {
      paintNetworkReadouts(getMpStatus())
      mpStatusUnsub = onMpStatusChange(paintNetworkReadouts)
    }
  }

  /** Update the Network tab's read-only rows from the current
   *  `MpStatus`. Called on first paint + on every `mp-status` change
   *  while the tab is open. Idempotent. */
  function paintNetworkReadouts(s: MpStatus): void {
    if (activeTab !== 'network') return
    const region = formatRegion(s)
    const endpoint = s.host ?? '—'
    const status = formatConnectionState(s.state)
    const room = formatRoomReadout(s)
    const latency = formatLatency(s.latencyMs)
    setReadoutText('net-region', region)
    setReadoutText('net-endpoint', endpoint)
    setReadoutText('net-status', status)
    setReadoutText('net-room', room)
    setReadoutText('net-latency', latency)
  }

  function setReadoutText(rowId: string, value: string): void {
    const el = paneHost.querySelector<HTMLElement>(`.sm-row[data-row="${rowId}"] .sm-readout`)
    if (el) el.textContent = value
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
    if (c.kind === 'readout') return buildReadoutEl(spec)
    if (c.kind === 'slider') {
      const range = document.createElement('input')
      range.type = 'range'
      range.min = String(c.min)
      range.max = String(c.max)
      range.step = String(c.step)
      range.value = String(c.defaultValue)
      range.disabled = !spec.enabled
      if (spec.enabled && spec.id === 'audio-master') {
        range.addEventListener('input', () => setAudioBusVolume('master', Number(range.value)))
      }
      if (spec.enabled && spec.id === 'audio-music') {
        range.addEventListener('input', () => setAudioBusVolume('music', Number(range.value)))
      }
      if (spec.enabled && spec.id === 'audio-sfx') {
        range.addEventListener('input', () => setAudioBusVolume('sfx', Number(range.value)))
      }
      if (spec.enabled && spec.id === 'audio-ambient') {
        range.addEventListener('input', () => setAudioBusVolume('ambient', Number(range.value)))
      }
      if (spec.enabled && spec.id === 'controls-sensitivity') {
        range.addEventListener('input', () => setGamepadSensitivity(Number(range.value)))
      }
      if (spec.enabled && spec.id === 'controls-deadzone') {
        range.addEventListener('input', () => setGamepadDeadzone(Number(range.value)))
      }
      if (spec.enabled && spec.id === 'a11y-screen-shake') {
        range.addEventListener('input', () => setScreenShakeIntensity(Number(range.value)))
      }
      if (spec.enabled && spec.id === 'video-pixel-ratio') {
        range.addEventListener('input', () => setPixelRatio(Number(range.value)))
      }
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
      if (spec.enabled && spec.id === 'gp-subtitles') {
        cb.addEventListener('change', () => {
          setTutorialSubtitles(cb.checked)
        })
      }
      if (spec.enabled && spec.id === 'audio-music-on') {
        cb.addEventListener('change', () => {
          setAudioMusicEnabled(cb.checked)
        })
      }
      if (spec.enabled && spec.id === 'controls-invert-y') {
        cb.addEventListener('change', () => {
          setInvertCameraY(cb.checked)
        })
      }
      if (spec.enabled && spec.id === 'gp-leaderboard-submit') {
        cb.addEventListener('change', () => {
          setLeaderboardSubmit(cb.checked)
        })
      }
      if (spec.enabled && spec.id === 'a11y-reduced-flash') {
        cb.addEventListener('change', () => {
          setReducedFlash(cb.checked)
        })
      }
      if (spec.enabled && spec.id === 'a11y-large-text') {
        cb.addEventListener('change', () => {
          setLargeText(cb.checked)
        })
      }
      if (spec.enabled && spec.id === 'a11y-high-contrast') {
        cb.addEventListener('change', () => {
          setHighContrast(cb.checked)
        })
      }
      if (spec.enabled && spec.id === 'a11y-reduced-motion') {
        cb.addEventListener('change', () => {
          setReducedMotion(cb.checked)
        })
      }
      if (spec.enabled && spec.id === 'a11y-motion-sickness') {
        cb.addEventListener('change', () => {
          setMotionSicknessReduction(cb.checked)
        })
      }
      if (spec.enabled && spec.id === 'a11y-subtitles-always') {
        cb.addEventListener('change', () => {
          setSubtitlesAlwaysOn(cb.checked)
        })
      }
      if (spec.enabled && spec.id === 'video-fullscreen') {
        cb.addEventListener('change', () => {
          setFullscreenPreferred(cb.checked)
        })
      }
      if (spec.enabled && spec.id === 'video-animated-landmarks') {
        cb.addEventListener('change', () => {
          setAnimatedLandmarks(cb.checked)
        })
      }
      return cb
    }
    if (c.kind === 'text') {
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'sm-text'
      input.value = c.defaultValue
      input.placeholder = c.placeholder
      input.maxLength = c.maxLength
      input.autocomplete = 'off'
      input.autocapitalize = 'characters'
      input.spellcheck = false
      input.disabled = !spec.enabled
      if (spec.enabled && spec.id === 'gp-leaderboard-handle') {
        const commit = () => {
          setLeaderboardHandle(input.value)
          // Reflect the normalized value back so the player sees what
          // got stored (lowercase / forbidden chars stripped).
          input.value = playerSettings.leaderboardHandle
        }
        input.addEventListener('change', commit)
        input.addEventListener('blur', commit)
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            commit()
            input.blur()
            e.preventDefault()
          }
        })
      }
      return input
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
      if (spec.enabled && spec.id === 'gp-pre-lap-intro') {
        sel.addEventListener('change', () => {
          const v = PRE_LAP_INTRO_VALUE[sel.value]
          if (v) setPreLapIntro(v)
        })
      }
      if (spec.enabled && spec.id === 'a11y-colorblind') {
        sel.addEventListener('change', () => {
          const v = COLORBLIND_VALUE[sel.value]
          if (v) setColorblindMode(v)
        })
      }
      if (spec.enabled && spec.id === 'video-emissive-landmarks') {
        sel.addEventListener('change', () => {
          const v = EMISSIVE_LANDMARKS_VALUE[sel.value]
          if (v) setEmissiveLandmarks(v)
        })
      }
      if (spec.enabled && spec.id === 'video-framecap') {
        sel.addEventListener('change', () => {
          setFramerateCap(framerateCapFromLabel(sel.value))
        })
      }
      return sel
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'sm-btn'
    btn.textContent = c.label
    btn.disabled = !spec.enabled
    if (spec.enabled && spec.id === 'gp-replay-tutorial') {
      btn.addEventListener('click', () => {
        // Build a tutorial-mode URL preserving the player's current
        // track/bike picks (best-effort — falls back to manifest first
        // track if no race is in progress). The page reload is
        // intentional: routes through the same boot flow as the
        // menu's track-pick path.
        window.location.assign(buildReplayTutorialHref())
      })
    }
    if (spec.enabled && spec.id === 'controls-rebind') {
      btn.addEventListener('click', () => {
        installRebindModal().open('keyboard')
      })
    }
    if (spec.enabled && spec.id === 'controls-rebind-pad') {
      btn.addEventListener('click', () => {
        installRebindModal().open('gamepad')
      })
    }
    return btn
  }

  function buildReadoutEl(spec: RowSpec): HTMLElement {
    const el = document.createElement('span')
    el.className = 'sm-readout'
    el.textContent = spec.control.kind === 'readout' ? spec.control.defaultValue : '—'
    return el
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
    if (mpStatusUnsub) {
      mpStatusUnsub()
      mpStatusUnsub = null
    }
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

function formatRegion(s: MpStatus): string {
  if (!s.host) return '—'
  // PartyKit runs on Cloudflare workers — the actual edge isn't exposed
  // over the protocol. Surfacing the host endpoint family + "Auto" is
  // honest about that without inventing a region the server doesn't
  // really pick. Localhost reads as DEV so a misconfigured prod build
  // can't masquerade as a live one.
  if (s.host === 'localhost:1999' || s.host.startsWith('127.')) return 'DEV (LOCAL)'
  return 'AUTO · CLOUDFLARE EDGE'
}

function formatConnectionState(state: MpConnectionState): string {
  switch (state) {
    case 'idle':
      return 'OFFLINE'
    case 'connecting':
      return 'CONNECTING…'
    case 'reconnecting':
      return 'RECONNECTING…'
    case 'connected':
      return 'CONNECTED'
    case 'closed':
      return 'CLOSED'
  }
}

function formatRoomReadout(s: MpStatus): string {
  if (!s.roomId) return '—'
  if (s.peerId < 0) return s.roomId
  const hostMark = s.isHost ? ' · HOST' : ''
  return `${s.roomId} · P${s.peerId}${hostMark}`
}

export function formatLatency(latencyMs: number): string {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return '—'
  return `${Math.round(latencyMs)} MS`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
