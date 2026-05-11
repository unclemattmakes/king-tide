import type { Vec3 } from '@/engine/sim/physics/vec'
import type { Track } from '@/game/tracks/types'

/**
 * Arcade-racer HUD: countdown-to-start, lap/race timers, checkpoint gap
 * toast, and a minimap with live racer dots. Owns the DOM nodes injected
 * into #app, and is driven once per render frame by `tick()`.
 *
 * The countdown gates simulation through `isLocked()`: while the banner
 * shows "3 / 2 / 1" the player intent and AI control are suppressed and
 * the race system is not stepped, so race time only starts ticking on
 * "GO!". This keeps lap timing and rubber-banding intact regardless of
 * how long the page took to settle into a steady-state frame rate.
 *
 * Gap-to-leader is computed against a per-checkpoint race-time table
 * shared across all racers — the first racer to cross gate N seeds the
 * "leader time" for that gate; everyone else's crossing reports a
 * positive delta. The player always sees their own delta to the field.
 */
export interface RaceHud {
  tick(input: RaceHudInput): void
  /** True while the start countdown is still showing 3/2/1 (or pre-roll). */
  isLocked(): boolean
  /** Called by the race system's onCheckpoint listener for any racer.
   *  Records the earliest race-time at which the Nth crossing was made;
   *  player reports (separate call) are compared against this table.
   *  Uses `checkpointsCrossed` (cumulative count) rather than the gate
   *  index so the comparison is correct across laps. */
  recordRacerCheckpoint(eid: number, checkpointsCrossed: number, raceTime: number): void
  /** Called when the player crosses a gate. Triggers the +/- toast if
   *  someone else has reached the same crossing-count before. */
  reportPlayerCheckpoint(checkpointsCrossed: number, playerTime: number): void
  /** Fast-forward the countdown to "GO!" — used by debug / e2e paths
   *  that want to script bike movement without waiting for 3-2-1. */
  skipCountdown(): void
  /** Reset gate-time table + countdown (used on respawn / replay). */
  reset(): void
}

export interface RaceHudInput {
  dt: number
  /** Wall-clock seconds since "GO!" (countdown excluded). 0 while locked. */
  raceTime: number
  lap: number
  lapsToFinish: number
  finished: boolean
  /** Seconds since start of the current lap. */
  currentLapTime: number
  lastLapTime: number | null
  bestLapTime: number | null
  /** All bikes' world positions for the minimap. Player is drawn last
   *  with the accent ring. */
  bikes: ReadonlyArray<MinimapDot>
  /** Index of the next gate the player must cross. Drawn highlighted on
   *  the minimap so the player can see where to head. */
  playerNextCheckpoint: number
  /** 1-N rank of the player. */
  playerPosition: number
  totalRacers: number
}

export interface MinimapDot {
  x: number
  z: number
  isPlayer: boolean
  /** When set, overrides the default opponent color. */
  color?: string
  /** When true, draw a slightly larger highlighted dot — used for the
   *  current race leader. */
  isLeader?: boolean
}

const COUNTDOWN_PREROLL = 0.4
const COUNTDOWN_TICK_SECONDS = 0.85
const COUNTDOWN_GO_SECONDS = 1.0
const COUNTDOWN_TOTAL = COUNTDOWN_PREROLL + COUNTDOWN_TICK_SECONDS * 3 + COUNTDOWN_GO_SECONDS

export interface RaceHudOptions {
  track: Track
  onCountdownTick?: (number: 3 | 2 | 1 | 0) => void
}

export function createRaceHud(opts: RaceHudOptions): RaceHud {
  const banner = ensureElement('race-banner', 'div')
  const timerCard = ensureElement('race-timer', 'div')
  const gapToast = ensureElement('race-gap', 'div')
  const minimap = ensureElement('race-minimap', 'canvas') as HTMLCanvasElement
  const minimapCtx = minimap.getContext('2d')

  banner.innerHTML = `
    <div class="race-banner-text" id="race-banner-text"></div>
  `
  timerCard.innerHTML = `
    <div class="race-timer-row">
      <div class="race-timer-label">RACE</div>
      <div class="race-timer-value" id="race-time-value">0:00.00</div>
    </div>
    <div class="race-timer-row">
      <div class="race-timer-label">LAP <span id="race-lap-label">1/3</span></div>
      <div class="race-timer-value race-timer-current" id="race-laptime-value">0:00.00</div>
    </div>
    <div class="race-timer-meta">
      <span id="race-position">P1/5</span>
      <span id="race-laptime-extra"></span>
    </div>
  `

  minimap.width = 180
  minimap.height = 180

  const bannerText = document.getElementById('race-banner-text') as HTMLElement
  const timeValue = document.getElementById('race-time-value') as HTMLElement
  const lapLabel = document.getElementById('race-lap-label') as HTMLElement
  const lapTimeValue = document.getElementById('race-laptime-value') as HTMLElement
  const lapTimeExtra = document.getElementById('race-laptime-extra') as HTMLElement
  const positionEl = document.getElementById('race-position') as HTMLElement

  // ---- Countdown state -----------------------------------------------------
  // Anchored on a wall-clock timestamp captured on the first tick so the
  // countdown phases out at real-time pace regardless of frame jitter,
  // first-paint stalls, or short tab-focus drops. Earlier versions
  // accumulated `dt` and lost time on heavy first frames, which read as
  // "the countdown didn't run".
  let countdownStartMs = -1
  let countdownDone = false
  let lastTickValue: 3 | 2 | 1 | 0 | -1 = -1

  // ---- Gap toast state -----------------------------------------------------
  let gapVisibleFor = 0 // seconds remaining

  // ---- Per-crossing leader times -------------------------------------------
  // Keyed by `checkpointsCrossed` (1, 2, 3, ...). The first racer to
  // reach the Nth crossing seeds the leader time at that progress
  // marker; everyone else's report computes a positive delta against it.
  const bestCrossingTime = new Map<number, number>()

  // ---- Minimap precomputation ----------------------------------------------
  // Build a flattened polyline from the main AI spline (canonical racing
  // line). Compute bounds once, including all checkpoints, to set the
  // minimap world->canvas transform.
  const splinePoints: Vec3[] =
    (opts.track.aiSplines.find((s) => s.id === 'main') ?? opts.track.aiSplines[0])?.points ?? []

  const allPoints: Vec3[] = [
    ...splinePoints,
    ...opts.track.checkpoints.map((cp) => cp.position),
    opts.track.start.position,
  ]
  let mapMinX = Infinity
  let mapMaxX = -Infinity
  let mapMinZ = Infinity
  let mapMaxZ = -Infinity
  for (const p of allPoints) {
    if (p.x < mapMinX) mapMinX = p.x
    if (p.x > mapMaxX) mapMaxX = p.x
    if (p.z < mapMinZ) mapMinZ = p.z
    if (p.z > mapMaxZ) mapMaxZ = p.z
  }
  if (!Number.isFinite(mapMinX)) {
    mapMinX = -50
    mapMaxX = 50
    mapMinZ = -50
    mapMaxZ = 50
  }
  // Pad bounds so dots near edges don't clip.
  const padX = (mapMaxX - mapMinX) * 0.08 + 4
  const padZ = (mapMaxZ - mapMinZ) * 0.08 + 4
  mapMinX -= padX
  mapMaxX += padX
  mapMinZ -= padZ
  mapMaxZ += padZ

  function worldToCanvas(x: number, z: number): { cx: number; cy: number } {
    const w = minimap.width
    const h = minimap.height
    const tx = (x - mapMinX) / (mapMaxX - mapMinX)
    // True top-down projection (looking down -Y): +Z maps to bottom of the
    // canvas. Flipping Z to put "north up" inverts handedness and makes the
    // race read counter-clockwise even though it runs clockwise in-world.
    const tz = (z - mapMinZ) / (mapMaxZ - mapMinZ)
    return { cx: tx * w, cy: tz * h }
  }

  function tickCountdown(): void {
    if (countdownDone) return
    if (countdownStartMs < 0) countdownStartMs = performance.now()
    const countdownElapsed = (performance.now() - countdownStartMs) / 1000

    if (countdownElapsed >= COUNTDOWN_TOTAL) {
      banner.classList.remove('show', 'flash-go', 'pop')
      bannerText.textContent = ''
      countdownDone = true
      return
    }

    // Decide which "phase" we're in.
    // [0, preroll)                               → blank (settle)
    // [preroll, preroll + 1*tick)                → "3"
    // [preroll + 1*tick, preroll + 2*tick)       → "2"
    // [preroll + 2*tick, preroll + 3*tick)       → "1"
    // [preroll + 3*tick, total)                  → "GO!"
    const t = countdownElapsed - COUNTDOWN_PREROLL
    let value: 3 | 2 | 1 | 0 | -1 = -1
    if (countdownElapsed < COUNTDOWN_PREROLL) {
      value = -1
    } else if (t < COUNTDOWN_TICK_SECONDS) {
      value = 3
    } else if (t < COUNTDOWN_TICK_SECONDS * 2) {
      value = 2
    } else if (t < COUNTDOWN_TICK_SECONDS * 3) {
      value = 1
    } else {
      value = 0
    }

    if (value !== lastTickValue) {
      lastTickValue = value
      if (value === -1) {
        banner.classList.remove('show', 'flash-go')
        bannerText.textContent = ''
      } else if (value === 0) {
        banner.classList.add('show', 'flash-go')
        bannerText.textContent = 'GO!'
      } else {
        banner.classList.add('show')
        banner.classList.remove('flash-go')
        bannerText.textContent = String(value)
      }
      if (value === 3 || value === 2 || value === 1 || value === 0) {
        opts.onCountdownTick?.(value)
      }
    }

    // Re-trigger the css "pop" animation each phase change by toggling
    // the `pop` class for one frame after a value change.
    if (value !== -1) {
      // The class is added when value changes; we strip it on next dt
      // so re-adding restarts the animation.
      banner.classList.remove('pop')
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      void banner.offsetWidth
      banner.classList.add('pop')
    }
  }

  function tick(input: RaceHudInput): void {
    tickCountdown()

    // ---- Timer card -------------------------------------------------------
    timeValue.textContent = formatTime(input.raceTime)
    lapTimeValue.textContent = formatTime(input.currentLapTime)
    lapLabel.textContent = `${Math.min(input.lap, input.lapsToFinish)}/${input.lapsToFinish}`
    positionEl.textContent =
      input.totalRacers > 0 ? `P${input.playerPosition}/${input.totalRacers}` : ''
    {
      const parts: string[] = []
      if (input.lastLapTime !== null) parts.push(`Last ${formatTime(input.lastLapTime)}`)
      if (input.bestLapTime !== null) parts.push(`Best ${formatTime(input.bestLapTime)}`)
      lapTimeExtra.textContent = parts.join(' · ')
    }

    if (input.finished) {
      timerCard.classList.add('finished')
    } else {
      timerCard.classList.remove('finished')
    }

    // ---- Gap toast --------------------------------------------------------
    if (gapVisibleFor > 0) {
      gapVisibleFor -= input.dt
      if (gapVisibleFor <= 0) {
        gapToast.classList.remove('show', 'gap-ahead', 'gap-behind')
      }
    }

    // ---- Minimap ----------------------------------------------------------
    drawMinimap(input)
  }

  function drawMinimap(input: RaceHudInput): void {
    if (!minimapCtx) return
    const ctx = minimapCtx
    const w = minimap.width
    const h = minimap.height

    ctx.clearRect(0, 0, w, h)

    // Background
    ctx.fillStyle = 'rgba(8, 14, 24, 0.78)'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1)

    // Track line (the main AI spline) drawn as a thick translucent ribbon.
    if (splinePoints.length > 1) {
      ctx.strokeStyle = 'rgba(180, 220, 255, 0.55)'
      ctx.lineWidth = 6
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      const first = worldToCanvas(splinePoints[0]!.x, splinePoints[0]!.z)
      ctx.moveTo(first.cx, first.cy)
      for (let i = 1; i < splinePoints.length; i++) {
        const p = splinePoints[i]!
        const c = worldToCanvas(p.x, p.z)
        ctx.lineTo(c.cx, c.cy)
      }
      // Close the loop
      ctx.lineTo(first.cx, first.cy)
      ctx.stroke()

      // Inner stripe for contrast
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // Start/finish gate marker (cp 0) — checkered swatch.
    const cp0 = opts.track.checkpoints[0]
    if (cp0) {
      const c = worldToCanvas(cp0.position.x, cp0.position.z)
      const size = 6
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(c.cx - size, c.cy - size, size * 2, size * 2)
      ctx.fillStyle = '#000000'
      ctx.fillRect(c.cx - size, c.cy - size, size, size)
      ctx.fillRect(c.cx, c.cy, size, size)
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'
      ctx.lineWidth = 1
      ctx.strokeRect(c.cx - size, c.cy - size, size * 2, size * 2)
    }

    // Next-checkpoint highlight for the player.
    const nextCp = opts.track.checkpoints[input.playerNextCheckpoint]
    if (nextCp && !input.finished) {
      const c = worldToCanvas(nextCp.position.x, nextCp.position.z)
      ctx.strokeStyle = '#ff9933'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(c.cx, c.cy, 8, 0, Math.PI * 2)
      ctx.stroke()
    }

    // Bikes — opponents first, then leader, then player so player draws on top.
    const sorted = [...input.bikes].sort((a, b) => {
      const ap = a.isPlayer ? 2 : a.isLeader ? 1 : 0
      const bp = b.isPlayer ? 2 : b.isLeader ? 1 : 0
      return ap - bp
    })
    for (const dot of sorted) {
      const c = worldToCanvas(dot.x, dot.z)
      const r = dot.isPlayer ? 4.5 : dot.isLeader ? 4 : 3.2
      ctx.fillStyle = dot.isPlayer ? '#ffcc66' : dot.isLeader ? '#ff5577' : (dot.color ?? '#88aaff')
      ctx.beginPath()
      ctx.arc(c.cx, c.cy, r, 0, Math.PI * 2)
      ctx.fill()
      if (dot.isPlayer) {
        ctx.strokeStyle = '#000'
        ctx.lineWidth = 1.4
        ctx.stroke()
      }
    }
  }

  function recordRacerCheckpoint(_eid: number, checkpointsCrossed: number, raceTime: number): void {
    if (checkpointsCrossed <= 0) return
    const prev = bestCrossingTime.get(checkpointsCrossed)
    if (prev === undefined || raceTime < prev) {
      bestCrossingTime.set(checkpointsCrossed, raceTime)
    }
  }

  function reportPlayerCheckpoint(checkpointsCrossed: number, playerTime: number): void {
    if (checkpointsCrossed <= 0) return
    const leaderTime = bestCrossingTime.get(checkpointsCrossed)
    if (leaderTime === undefined) return
    if (leaderTime === playerTime) return // player just recorded themselves as leader
    const delta = playerTime - leaderTime
    showGap(delta)
  }

  function showGap(deltaSeconds: number): void {
    const ahead = deltaSeconds < 0
    const abs = Math.abs(deltaSeconds)
    const sign = ahead ? '-' : '+'
    gapToast.textContent = `${sign}${abs.toFixed(2)}s`
    gapToast.classList.remove('gap-ahead', 'gap-behind')
    gapToast.classList.add('show', ahead ? 'gap-ahead' : 'gap-behind')
    gapVisibleFor = 1.6
  }

  function reset(): void {
    countdownStartMs = -1
    countdownDone = false
    lastTickValue = -1
    gapVisibleFor = 0
    bestCrossingTime.clear()
  }

  function skipCountdown(): void {
    // Drop the anchor far enough in the past that the next tickCountdown
    // call observes "elapsed >= total" and shuts the banner down.
    countdownStartMs = performance.now() - COUNTDOWN_TOTAL * 1000 - 1
    countdownDone = true
    banner.classList.remove('show', 'flash-go', 'pop')
    bannerText.textContent = ''
  }

  return {
    tick,
    isLocked: () => {
      if (countdownDone) return false
      if (countdownStartMs < 0) return true
      const elapsed = (performance.now() - countdownStartMs) / 1000
      return elapsed < COUNTDOWN_PREROLL + COUNTDOWN_TICK_SECONDS * 3
    },
    recordRacerCheckpoint,
    reportPlayerCheckpoint,
    skipCountdown,
    reset,
  }
}

function ensureElement<T extends HTMLElement>(id: string, tag: string): T {
  const existing = document.getElementById(id)
  if (existing) return existing as T
  const el = document.createElement(tag) as T
  el.id = id
  document.body.appendChild(el)
  return el
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.00'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}
