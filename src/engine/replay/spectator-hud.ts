import type { ReplayFile } from './format'
import type { ReplayPlayer } from './player'
import type { SpectatorCamera, SpectatorCameraMode } from './spectator-camera'

/**
 * Playback HUD for replay mode. Sits across the bottom of the screen with
 * play/pause, scrub, speed, bike picker and camera-mode toggle. The DOM
 * is created on demand the first time `installSpectatorHud` is called so
 * the HUD doesn't bloat the initial HTML for normal-race sessions.
 *
 * Hidden when no replay is active.
 */
export type SpectatorHud = {
  show(): void
  hide(): void
  /** Push the latest player state into the UI (called every frame). */
  refresh(): void
}

export type SpectatorHudOpts = {
  replay: ReplayFile
  player: ReplayPlayer
  camera: SpectatorCamera
  /** Currently followed bike slot (0-based). */
  getFollowedSlot: () => number
  setFollowedSlot: (slot: number) => void
  /** Returns the live race-time of the bike at `slot` per the replay's race events. */
  exit: () => void
}

export function installSpectatorHud(opts: SpectatorHudOpts): SpectatorHud {
  const root = ensureRoot()
  root.innerHTML = ''

  const card = document.createElement('div')
  card.className = 'replay-card'
  root.appendChild(card)

  // Header row: track + recording date + finish info
  const header = document.createElement('div')
  header.className = 'replay-header'
  const m = opts.replay.meta
  const recorded = formatDate(m.recordedAt)
  const finishStr =
    m.finishPosition !== null && m.finishTime !== null
      ? ` · finish ${ordinal(m.finishPosition)} ${formatTime(m.finishTime)}`
      : ''
  header.innerHTML = `
    <span class="replay-title">REPLAY</span>
    <span class="replay-meta">${escapeHtml(m.trackName)} · ${recorded}${finishStr}</span>
    <button class="replay-exit" id="replay-exit">EXIT</button>
  `
  card.appendChild(header)

  // Scrub bar
  const scrubRow = document.createElement('div')
  scrubRow.className = 'replay-scrub-row'
  scrubRow.innerHTML = `
    <button class="replay-btn" id="replay-playpause" title="Play / Pause (Space)">▶</button>
    <span class="replay-time" id="replay-time">0:00</span>
    <input type="range" class="replay-scrub" id="replay-scrub" min="0" max="1000" step="1" value="0" />
    <span class="replay-time" id="replay-duration">${formatTime(m.durationSeconds)}</span>
  `
  card.appendChild(scrubRow)

  // Controls row: speed + camera mode
  const ctlRow = document.createElement('div')
  ctlRow.className = 'replay-ctl-row'
  ctlRow.innerHTML = `
    <div class="replay-group">
      <span class="replay-label">SPEED</span>
      <button class="replay-pill" data-speed="0.25">0.25×</button>
      <button class="replay-pill" data-speed="0.5">0.5×</button>
      <button class="replay-pill selected" data-speed="1">1×</button>
      <button class="replay-pill" data-speed="2">2×</button>
      <button class="replay-pill" data-speed="4">4×</button>
    </div>
    <div class="replay-group">
      <span class="replay-label">CAMERA</span>
      <button class="replay-pill selected" data-cam="chase">Chase</button>
      <button class="replay-pill" data-cam="orbit">Free Orbit</button>
    </div>
    <div class="replay-group" id="replay-bikes-group">
      <span class="replay-label">FOLLOW</span>
    </div>
  `
  card.appendChild(ctlRow)

  // Build per-bike pills.
  const bikesGroup = ctlRow.querySelector<HTMLDivElement>('#replay-bikes-group')!
  for (const b of opts.replay.bikes) {
    const pill = document.createElement('button')
    pill.className = `replay-pill ${b.slot === opts.getFollowedSlot() ? 'selected' : ''}`
    pill.dataset.slot = String(b.slot)
    pill.style.setProperty('--bike-color', `#${b.bodyColor.toString(16).padStart(6, '0')}`)
    const label = b.isPlayer ? `★ ${b.displayName}` : b.displayName
    pill.textContent = label
    bikesGroup.appendChild(pill)
  }

  const playBtn = card.querySelector<HTMLButtonElement>('#replay-playpause')!
  const scrub = card.querySelector<HTMLInputElement>('#replay-scrub')!
  const timeEl = card.querySelector<HTMLSpanElement>('#replay-time')!
  const exitBtn = card.querySelector<HTMLButtonElement>('#replay-exit')!

  // Hint row
  const hint = document.createElement('div')
  hint.className = 'replay-hint'
  hint.textContent =
    'Space play/pause · ←/→ scrub 5s · 1-9 follow bike · F orbit camera · drag/scroll in orbit mode'
  card.appendChild(hint)

  let scrubbing = false

  scrub.addEventListener('input', () => {
    scrubbing = true
    const t = (Number(scrub.value) / 1000) * opts.player.duration
    opts.player.seek(t)
  })
  scrub.addEventListener('change', () => {
    scrubbing = false
  })
  playBtn.addEventListener('click', () => {
    opts.player.paused = !opts.player.paused
  })
  exitBtn.addEventListener('click', () => opts.exit())

  for (const btn of ctlRow.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
    btn.addEventListener('click', () => {
      opts.player.speed = Number(btn.dataset.speed)
      for (const b of ctlRow.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
        b.classList.toggle('selected', b === btn)
      }
    })
  }
  for (const btn of ctlRow.querySelectorAll<HTMLButtonElement>('[data-cam]')) {
    btn.addEventListener('click', () => {
      const m = btn.dataset.cam as SpectatorCameraMode
      opts.camera.setMode(m)
      if (m === 'orbit') opts.camera.resetOrbit()
      for (const b of ctlRow.querySelectorAll<HTMLButtonElement>('[data-cam]')) {
        b.classList.toggle('selected', b === btn)
      }
    })
  }
  for (const btn of bikesGroup.querySelectorAll<HTMLButtonElement>('[data-slot]')) {
    btn.addEventListener('click', () => {
      opts.setFollowedSlot(Number(btn.dataset.slot))
      for (const b of bikesGroup.querySelectorAll<HTMLButtonElement>('[data-slot]')) {
        b.classList.toggle('selected', b === btn)
      }
    })
  }

  function refresh() {
    if (root.style.display === 'none') return
    playBtn.textContent = opts.player.paused ? '▶' : '⏸'
    timeEl.textContent = formatTime(opts.player.time)
    if (!scrubbing) {
      const v = opts.player.duration > 0 ? (opts.player.time / opts.player.duration) * 1000 : 0
      scrub.value = String(Math.round(v))
    }
    // Sync camera-mode selection (in case it changed via keyboard).
    for (const b of ctlRow.querySelectorAll<HTMLButtonElement>('[data-cam]')) {
      b.classList.toggle('selected', (b.dataset.cam as SpectatorCameraMode) === opts.camera.mode)
    }
    // Sync bike-pill selection.
    const slot = opts.getFollowedSlot()
    for (const b of bikesGroup.querySelectorAll<HTMLButtonElement>('[data-slot]')) {
      b.classList.toggle('selected', Number(b.dataset.slot) === slot)
    }
  }

  return {
    show() {
      root.style.display = 'flex'
    },
    hide() {
      root.style.display = 'none'
    },
    refresh,
  }
}

function ensureRoot(): HTMLDivElement {
  let el = document.getElementById('replay-hud') as HTMLDivElement | null
  if (el) return el
  el = document.createElement('div')
  el.id = 'replay-hud'
  document.body.appendChild(el)
  ensureStyles()
  return el
}

function ensureStyles(): void {
  if (document.getElementById('replay-hud-styles')) return
  const style = document.createElement('style')
  style.id = 'replay-hud-styles'
  style.textContent = `
    #replay-hud {
      position: fixed; left: 0; right: 0; bottom: 0;
      display: flex; justify-content: center;
      pointer-events: none; z-index: 12;
      font-family: ui-monospace, monospace;
    }
    #replay-hud .replay-card {
      pointer-events: auto;
      background: rgba(10,15,25,0.88);
      border: 1px solid rgba(120,180,255,0.35);
      border-bottom: none;
      border-radius: 8px 8px 0 0;
      padding: 10px 14px; margin: 0 8px;
      color: #ddd; min-width: min(720px, 96vw); max-width: 96vw;
    }
    #replay-hud .replay-header {
      display: flex; align-items: center; gap: 10px;
      font-size: 11px; letter-spacing: 1px;
      margin-bottom: 8px;
    }
    #replay-hud .replay-title { color: #88ccff; font-weight: bold; letter-spacing: 3px; }
    #replay-hud .replay-meta { opacity: 0.8; flex: 1; }
    #replay-hud .replay-exit {
      background: transparent; color: #ff8888;
      border: 1px solid rgba(255,120,120,0.5); border-radius: 3px;
      font: bold 10px ui-monospace, monospace; letter-spacing: 1px;
      padding: 3px 10px; cursor: pointer;
    }
    #replay-hud .replay-exit:hover { background: rgba(255,120,120,0.15); }
    #replay-hud .replay-scrub-row {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 8px;
    }
    #replay-hud .replay-btn {
      background: rgba(120,180,255,0.15); color: #88ccff;
      border: 1px solid rgba(120,180,255,0.45); border-radius: 3px;
      font: bold 14px ui-monospace, monospace;
      width: 32px; height: 28px; cursor: pointer;
    }
    #replay-hud .replay-btn:hover { background: rgba(120,180,255,0.3); }
    #replay-hud .replay-time {
      font-size: 11px; opacity: 0.8;
      font-variant-numeric: tabular-nums;
      min-width: 44px; text-align: center;
    }
    #replay-hud .replay-scrub {
      flex: 1; accent-color: #88ccff;
    }
    #replay-hud .replay-ctl-row {
      display: flex; flex-wrap: wrap; gap: 12px 18px;
      font-size: 11px;
    }
    #replay-hud .replay-group { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
    #replay-hud .replay-label {
      opacity: 0.55; letter-spacing: 1.5px; margin-right: 4px;
    }
    #replay-hud .replay-pill {
      background: rgba(255,255,255,0.05); color: #ccc;
      border: 1px solid rgba(255,255,255,0.18); border-radius: 3px;
      font: 10px ui-monospace, monospace; letter-spacing: 0.5px;
      padding: 3px 8px; cursor: pointer;
      border-left: 3px solid var(--bike-color, transparent);
    }
    #replay-hud .replay-pill:hover { background: rgba(255,255,255,0.1); }
    #replay-hud .replay-pill.selected {
      background: rgba(120,180,255,0.18);
      color: #88ccff;
      border-color: rgba(120,180,255,0.5);
    }
    #replay-hud .replay-hint {
      margin-top: 8px;
      font-size: 10px; opacity: 0.55; text-align: center;
    }
  `
  document.head.appendChild(style)
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  if (m > 0) return `${m}:${s.toFixed(1).padStart(4, '0')}`
  return `${s.toFixed(1)}s`
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}
