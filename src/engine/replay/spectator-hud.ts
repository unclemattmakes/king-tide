import type { ReplayFile } from './format'
import type { ReplayPlayer } from './player'
import type { SpectatorCamera, SpectatorCameraMode } from './spectator-camera'

/**
 * Playback HUD for replay mode.
 *
 * Broadcast layout — a top lower-third strip (venue + recording time + the
 * currently followed rider + camera shot label) and a bottom scrub bar
 * with play/pause, speed, camera mode (AUTO / CHASE / FREE), and a row of
 * rider pills. AUTO is the default — the broadcast director cycles
 * cinematic shots over the field so the replay reads like a TV broadcast.
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
  exit: () => void
}

export function installSpectatorHud(opts: SpectatorHudOpts): SpectatorHud {
  ensureStyles()
  const root = ensureRoot()
  root.innerHTML = ''

  const m = opts.replay.meta
  const recorded = formatDate(m.recordedAt)

  // ── Top lower-third strip — venue + livery + shot label ──────────────
  const upper = document.createElement('div')
  upper.id = 'replay-upper'
  upper.innerHTML = `
    <div class="rb-strip">
      <div class="rb-tag">LIVE REPLAY</div>
      <div class="rb-venue">
        <div class="rb-lbl">VENUE</div>
        <div class="rb-val" id="rb-venue">${escapeHtml(m.trackName.toUpperCase())}</div>
      </div>
      <div class="rb-rider">
        <div class="rb-lbl">FOLLOWING</div>
        <div class="rb-val" id="rb-rider">—</div>
      </div>
      <div class="rb-shot">
        <div class="rb-lbl">CAMERA</div>
        <div class="rb-val" id="rb-shot">AUTO</div>
      </div>
      <div class="rb-meta">
        <div class="rb-lbl">RECORDED</div>
        <div class="rb-val" id="rb-recorded">${escapeHtml(recorded)}</div>
      </div>
      <button class="rb-exit" id="replay-exit" type="button">EXIT</button>
    </div>
  `
  root.appendChild(upper)

  // ── Bottom control bar ──────────────────────────────────────────────
  const lower = document.createElement('div')
  lower.id = 'replay-lower'
  lower.innerHTML = `
    <div class="rb-card">
      <div class="rb-scrub-row">
        <button class="rb-btn" id="replay-playpause" title="Play / Pause (Space)">▶</button>
        <span class="rb-time" id="replay-time">0:00</span>
        <input type="range" class="rb-scrub" id="replay-scrub" min="0" max="1000" step="1" value="0" />
        <span class="rb-time" id="replay-duration">${formatTime(m.durationSeconds)}</span>
      </div>
      <div class="rb-ctl-row">
        <div class="rb-group">
          <span class="rb-grp-lbl">CAMERA</span>
          <button class="rb-pill selected" data-cam="auto">AUTO</button>
          <button class="rb-pill" data-cam="chase">CHASE</button>
          <button class="rb-pill" data-cam="orbit">FREE</button>
          <button class="rb-pill rb-cut" id="rb-cut" title="Cut to a fresh shot (C)">CUT</button>
        </div>
        <div class="rb-group">
          <span class="rb-grp-lbl">SPEED</span>
          <button class="rb-pill" data-speed="0.25">0.25×</button>
          <button class="rb-pill" data-speed="0.5">0.5×</button>
          <button class="rb-pill selected" data-speed="1">1×</button>
          <button class="rb-pill" data-speed="2">2×</button>
          <button class="rb-pill" data-speed="4">4×</button>
        </div>
        <div class="rb-group" id="replay-bikes-group">
          <span class="rb-grp-lbl">FOLLOW</span>
        </div>
      </div>
      <div class="rb-hint">
        Space play/pause · ←/→ scrub 5s · 1-9 follow bike · F free camera · C broadcast cut
      </div>
    </div>
  `
  root.appendChild(lower)

  // ── Per-bike pills ──────────────────────────────────────────────────
  const bikesGroup = lower.querySelector<HTMLDivElement>('#replay-bikes-group')!
  for (const b of opts.replay.bikes) {
    const pill = document.createElement('button')
    pill.className = `rb-pill ${b.slot === opts.getFollowedSlot() ? 'selected' : ''}`
    pill.type = 'button'
    pill.dataset.slot = String(b.slot)
    pill.style.setProperty('--bike-color', `#${b.bodyColor.toString(16).padStart(6, '0')}`)
    pill.textContent = b.isPlayer ? `★ ${b.displayName}` : b.displayName
    bikesGroup.appendChild(pill)
  }

  // ── Wire-up ─────────────────────────────────────────────────────────
  const playBtn = lower.querySelector<HTMLButtonElement>('#replay-playpause')!
  const scrub = lower.querySelector<HTMLInputElement>('#replay-scrub')!
  const timeEl = lower.querySelector<HTMLSpanElement>('#replay-time')!
  const exitBtn = upper.querySelector<HTMLButtonElement>('#replay-exit')!
  const cutBtn = lower.querySelector<HTMLButtonElement>('#rb-cut')!
  const riderEl = upper.querySelector<HTMLElement>('#rb-rider')!
  const shotEl = upper.querySelector<HTMLElement>('#rb-shot')!

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
  cutBtn.addEventListener('click', () => opts.camera.cutAuto())

  for (const btn of lower.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
    btn.addEventListener('click', () => {
      opts.player.speed = Number(btn.dataset.speed)
      for (const b of lower.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
        b.classList.toggle('selected', b === btn)
      }
    })
  }
  for (const btn of lower.querySelectorAll<HTMLButtonElement>('[data-cam]')) {
    btn.addEventListener('click', () => {
      const next = btn.dataset.cam as SpectatorCameraMode
      opts.camera.setMode(next)
      if (next === 'orbit') opts.camera.resetOrbit()
      for (const b of lower.querySelectorAll<HTMLButtonElement>('[data-cam]')) {
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

  function riderLabelForSlot(slot: number): string {
    const b = opts.replay.bikes[slot]
    if (!b) return '—'
    return b.displayName.toUpperCase()
  }

  function refresh() {
    if (root.style.display === 'none') return
    playBtn.textContent = opts.player.paused ? '▶' : '⏸'
    timeEl.textContent = formatTime(opts.player.time)
    if (!scrubbing) {
      const v = opts.player.duration > 0 ? (opts.player.time / opts.player.duration) * 1000 : 0
      scrub.value = String(Math.round(v))
    }
    for (const b of lower.querySelectorAll<HTMLButtonElement>('[data-cam]')) {
      b.classList.toggle('selected', (b.dataset.cam as SpectatorCameraMode) === opts.camera.mode)
    }
    const slot = opts.getFollowedSlot()
    for (const b of bikesGroup.querySelectorAll<HTMLButtonElement>('[data-slot]')) {
      b.classList.toggle('selected', Number(b.dataset.slot) === slot)
    }

    if (opts.camera.mode === 'auto') {
      const focusId = opts.camera.getAutoFocusId()
      if (focusId !== null) {
        riderEl.textContent = riderLabelForSlot(focusId)
      }
      const shot = opts.camera.getAutoShotLabel()
      shotEl.textContent = shot ? `AUTO · ${shot.toUpperCase()}` : 'AUTO'
    } else {
      riderEl.textContent = riderLabelForSlot(slot)
      shotEl.textContent = opts.camera.mode.toUpperCase()
    }
  }

  return {
    show() {
      root.style.display = 'block'
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
  return el
}

function ensureStyles(): void {
  if (document.getElementById('replay-hud-styles')) return
  const style = document.createElement('style')
  style.id = 'replay-hud-styles'
  style.textContent = `
    #replay-hud {
      position: fixed; inset: 0; pointer-events: none; z-index: 22;
      font-family: var(--bc-font-sans, system-ui);
    }
    #replay-hud > * { pointer-events: auto; }

    /* ── Upper lower-third ── */
    #replay-upper {
      position: absolute; top: 0; left: 0; right: 0;
      padding: 14px 18px 0;
      animation: bc-slide-in-down 520ms var(--ease-out, ease-out) 80ms backwards;
    }
    #replay-hud .rb-strip {
      display: flex; align-items: stretch; gap: 0;
      background: linear-gradient(180deg, rgba(10,20,36,0.92), rgba(5,10,20,0.92));
      border: 1px solid var(--bc-line, rgba(255,255,255,0.08));
      border-top: 2px solid var(--bc-cyan, #4dd6ff);
      box-shadow: 0 6px 20px rgba(0,0,0,0.45);
    }
    #replay-hud .rb-tag {
      display: flex; align-items: center;
      padding: 14px 22px;
      font-family: var(--bc-font-display, sans-serif);
      font-size: 14px; letter-spacing: 0.26em;
      background: var(--bc-cyan, #4dd6ff); color: var(--bc-navy, #050a14);
    }
    #replay-hud .rb-venue, #replay-hud .rb-rider,
    #replay-hud .rb-shot, #replay-hud .rb-meta {
      padding: 10px 22px;
      border-left: 1px solid var(--bc-line, rgba(255,255,255,0.08));
      display: flex; flex-direction: column; justify-content: center;
      min-width: 0; flex: 1;
    }
    #replay-hud .rb-lbl {
      font-family: var(--bc-font-display, sans-serif);
      font-size: 10px; letter-spacing: 0.28em;
      color: var(--bc-ink-faint, rgba(255,255,255,0.55));
    }
    #replay-hud .rb-val {
      font-family: var(--bc-font-display, sans-serif);
      font-size: 18px; letter-spacing: 0.06em;
      color: var(--bc-ink, #f4f8ff);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      margin-top: 2px;
    }
    #replay-hud .rb-rider .rb-val { color: var(--bc-yellow, #ffd54a); }
    #replay-hud .rb-shot .rb-val { color: var(--bc-cyan, #4dd6ff); }
    #replay-hud .rb-exit {
      background: transparent; color: var(--bc-red, #ff3a5e);
      border: 0;
      border-left: 1px solid var(--bc-line, rgba(255,255,255,0.08));
      font: 600 11px var(--bc-font-mono, monospace); letter-spacing: 0.22em;
      padding: 0 22px; cursor: pointer;
      transition: background 180ms ease-out, color 180ms ease-out;
    }
    #replay-hud .rb-exit:hover {
      background: rgba(255, 58, 94, 0.12);
      color: var(--bc-red, #ff3a5e);
    }

    /* ── Lower control card ── */
    #replay-lower {
      position: absolute; left: 0; right: 0; bottom: 0;
      display: flex; justify-content: center;
      padding: 0 18px 18px;
      animation: bc-slide-in-up 520ms var(--ease-out, ease-out) 120ms backwards;
    }
    #replay-hud .rb-card {
      width: min(900px, 100%);
      background: linear-gradient(180deg, rgba(10,20,36,0.92), rgba(5,10,20,0.92));
      border: 1px solid var(--bc-line, rgba(255,255,255,0.08));
      border-bottom: 2px solid var(--bc-cyan, #4dd6ff);
      padding: 14px 18px 10px;
      color: var(--bc-ink, #f4f8ff);
      box-shadow: 0 -8px 28px rgba(0,0,0,0.5);
    }
    #replay-hud .rb-scrub-row {
      display: flex; align-items: center; gap: 12px;
      margin-bottom: 12px;
    }
    #replay-hud .rb-btn {
      background: var(--bc-cyan, #4dd6ff); color: var(--bc-navy, #050a14);
      border: 0;
      font: 600 14px var(--bc-font-mono, monospace);
      width: 36px; height: 30px; cursor: pointer;
      transition: filter 180ms ease-out;
    }
    #replay-hud .rb-btn:hover { filter: brightness(1.12); }
    #replay-hud .rb-time {
      font: 600 11px var(--bc-font-mono, monospace);
      color: var(--bc-ink-dim, rgba(255,255,255,0.65));
      font-variant-numeric: tabular-nums;
      min-width: 48px; text-align: center;
      letter-spacing: 0.06em;
    }
    #replay-hud .rb-scrub { flex: 1; accent-color: var(--bc-cyan, #4dd6ff); }

    #replay-hud .rb-ctl-row {
      display: flex; flex-wrap: wrap; gap: 14px 20px;
      align-items: center;
    }
    #replay-hud .rb-group {
      display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
    }
    #replay-hud .rb-grp-lbl {
      font-family: var(--bc-font-display, sans-serif);
      font-size: 10px; letter-spacing: 0.26em;
      color: var(--bc-ink-faint, rgba(255,255,255,0.55));
      margin-right: 6px;
    }
    #replay-hud .rb-pill {
      background: rgba(255,255,255,0.04);
      color: var(--bc-ink-dim, rgba(255,255,255,0.65));
      border: 1px solid var(--bc-line, rgba(255,255,255,0.08));
      font: 600 10px var(--bc-font-mono, monospace); letter-spacing: 0.14em;
      padding: 5px 10px; cursor: pointer;
      border-left: 3px solid var(--bike-color, transparent);
      transition: background 180ms ease-out, color 180ms ease-out, border-color 180ms ease-out;
    }
    #replay-hud .rb-pill:hover {
      background: rgba(255,255,255,0.08);
      color: var(--bc-ink, #f4f8ff);
    }
    #replay-hud .rb-pill.selected {
      background: var(--bc-cyan, #4dd6ff);
      color: var(--bc-navy, #050a14);
      border-color: var(--bc-cyan, #4dd6ff);
    }
    #replay-hud .rb-cut {
      background: rgba(255, 213, 74, 0.16); color: var(--bc-yellow, #ffd54a);
      border-color: rgba(255, 213, 74, 0.45);
      border-left-color: rgba(255, 213, 74, 0.45);
      margin-left: 4px;
    }
    #replay-hud .rb-cut:hover {
      background: rgba(255, 213, 74, 0.26);
      color: var(--bc-yellow, #ffd54a);
    }
    #replay-hud .rb-hint {
      margin-top: 8px;
      font: 10px var(--bc-font-mono, monospace);
      color: var(--bc-ink-faint, rgba(255,255,255,0.5));
      text-align: center; letter-spacing: 0.1em;
    }

    /* ── Mobile (≤720px) ── */
    @media (max-width: 720px) {
      #replay-upper { padding: 10px 10px 0; }
      #replay-hud .rb-tag { font-size: 12px; padding: 10px 14px; letter-spacing: 0.22em; }
      #replay-hud .rb-venue, #replay-hud .rb-meta { display: none; }
      #replay-hud .rb-rider, #replay-hud .rb-shot { padding: 8px 12px; }
      #replay-hud .rb-val { font-size: 14px; }
      #replay-hud .rb-exit { padding: 0 14px; font-size: 10px; letter-spacing: 0.18em; }

      #replay-lower { padding: 0 10px 12px; }
      #replay-hud .rb-card { padding: 12px 14px 8px; }
      #replay-hud .rb-scrub-row { gap: 8px; margin-bottom: 10px; }
      #replay-hud .rb-btn { width: 32px; height: 28px; font-size: 13px; }
      #replay-hud .rb-time { font-size: 10px; min-width: 40px; }
      #replay-hud .rb-ctl-row { gap: 10px 14px; }
      #replay-hud .rb-pill { font-size: 10px; padding: 6px 10px; }
      #replay-hud .rb-hint { font-size: 9px; letter-spacing: 0.08em; }
    }

    @media (hover: none) and (pointer: coarse) {
      #replay-hud .rb-pill { min-height: 32px; }
      #replay-hud .rb-btn { min-height: 36px; }
    }
  `
  document.head.appendChild(style)
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
