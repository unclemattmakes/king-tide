import {
  currentHudPalette,
  onAccessibilityChange,
} from '@/engine/accessibility/accessibility-service'
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
  /** M10.12 lobby — when the HUD is constructed with `deferStart: true`,
   *  the countdown does NOT auto-start on first tick. Call this once the
   *  lobby gate is cleared (e.g. all peers ready) to begin 3-2-1-GO.
   *  No-op if the countdown is already running / done, or if the HUD
   *  was built without `deferStart`. */
  armCountdown(): void
  /** M10.12 lobby — true if the HUD is in deferred-start mode AND
   *  hasn't been armed yet. While this is true, `isLocked()` also
   *  returns true. The lobby UI uses this to decide visibility. */
  isWaitingForLobby(): boolean
  /** While the start is deferred (multiplayer's synchronized-start
   *  barrier), show a small holding message in the countdown banner
   *  (e.g. "WAITING FOR RIDERS…"). Cleared automatically when the
   *  countdown arms or is skipped; no-op once the hold has released. */
  setHoldBanner(text: string | null): void
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
  /** M10.12 lobby — when true, the countdown does NOT auto-start on
   *  first tick. Stays gated (and `isLocked()` returns true) until the
   *  caller invokes `armCountdown()`. Used by multiplayer rooms; single-
   *  player leaves this off so the existing immediate-start behavior is
   *  preserved. Also used by the pre-lap intro to hold the countdown
   *  while the cinematic shots play. */
  deferStart?: boolean
  /** When true, suppresses the giant 3/2/1/GO banner text. The
   *  `onCountdownTick` callback still fires so an external overlay
   *  (e.g. the F1 start-lights row) can drive the visual instead. */
  hideCountdownBanner?: boolean
}

export function createRaceHud(opts: RaceHudOptions): RaceHud {
  const banner = ensureElement('race-banner', 'div')
  const timerCard = ensureElement('race-timer', 'div')
  const posBadge = ensureElement('race-position-badge', 'div')
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
      <div class="race-timer-label">LAP</div>
      <div class="race-timer-value race-timer-current" id="race-laptime-value">0:00.00</div>
    </div>
    <div class="race-timer-meta">
      <span id="race-laptime-extra"></span>
    </div>
  `
  // Position badge — the HUD hero (docs/ui-art-direction.md). Big painted
  // ordinal + field size, lap chip beneath. The board hides in solo time
  // trial (no field to place in) while the lap chip stays.
  posBadge.innerHTML = `
    <div class="rp-board" id="rp-board">
      <span class="rp-num" id="rp-num">1</span>
      <span class="rp-suffix" id="rp-suf">st</span>
      <span class="rp-total" id="rp-total">/8</span>
    </div>
    <div class="rp-lap" id="rp-lap">LAP <b>1/3</b></div>
  `

  minimap.width = 180
  minimap.height = 180

  const bannerText = document.getElementById('race-banner-text') as HTMLElement
  const timeValue = document.getElementById('race-time-value') as HTMLElement
  const lapTimeValue = document.getElementById('race-laptime-value') as HTMLElement
  const lapTimeExtra = document.getElementById('race-laptime-extra') as HTMLElement
  const rpBoard = document.getElementById('rp-board') as HTMLElement
  const rpNum = document.getElementById('rp-num') as HTMLElement
  const rpSuf = document.getElementById('rp-suf') as HTMLElement
  const rpTotal = document.getElementById('rp-total') as HTMLElement
  const rpLap = document.getElementById('rp-lap') as HTMLElement

  // ---- Countdown state -----------------------------------------------------
  // Anchored on a wall-clock timestamp captured on the first tick so the
  // countdown phases out at real-time pace regardless of frame jitter,
  // first-paint stalls, or short tab-focus drops. Earlier versions
  // accumulated `dt` and lost time on heavy first frames, which read as
  // "the countdown didn't run".
  let countdownStartMs = -1
  let countdownDone = false
  let lastTickValue: 3 | 2 | 1 | 0 | -1 = -1
  // M10.12 lobby — when true, the countdown is held until `armCountdown`
  // is called. Defaults to false so single-player + e2e harness still
  // auto-start.
  let waitingForLobby = opts.deferStart === true

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

  // Reused scratch to avoid allocating `{ cx, cy }` per call inside the
  // per-frame minimap loop.
  const worldToCanvasOut = { cx: 0, cy: 0 }
  function worldToCanvas(x: number, z: number): { cx: number; cy: number } {
    const w = minimap.width
    const h = minimap.height
    const tx = (x - mapMinX) / (mapMaxX - mapMinX)
    // True top-down projection (looking down -Y): +Z maps to bottom of the
    // canvas. Flipping Z to put "north up" inverts handedness and makes the
    // race read counter-clockwise even though it runs clockwise in-world.
    const tz = (z - mapMinZ) / (mapMaxZ - mapMinZ)
    worldToCanvasOut.cx = tx * w
    worldToCanvasOut.cy = tz * h
    return worldToCanvasOut
  }

  // ---- Static minimap layer (background + spline + start gate) -------------
  // Baked once at HUD construction. The spline never moves and neither does
  // the start gate, so redrawing them every rAF (~1–3 ms of canvas-2D stroke
  // work on integrated GPUs) is wasted. Per-frame we blit this cache and
  // draw only the dynamic overlay (next-CP highlight + bike dots).
  //
  // Re-baked on `onAccessibilityChange` because the spline color reads
  // from the live palette (currently a thin alpha over the `info` hue);
  // a mid-session colorblind-mode flip must repaint the cached layer.
  const staticLayer = document.createElement('canvas')
  staticLayer.width = minimap.width
  staticLayer.height = minimap.height
  bakeStaticMinimapLayer()
  // Subscribe once at construction so a palette flip mid-session
  // repaints the cached minimap layer. The HUD doesn't expose a
  // dispose path today, so the closure leaks across HUD recreations
  // (one new subscriber per race — bounded by session length). When
  // the HUD grows a `dispose()`, the returned unsub fn can be called
  // from it; held in `_a11yUnsub` to make the intent legible.
  const _a11yUnsub: () => void = onAccessibilityChange(() => {
    bakeStaticMinimapLayer()
  })
  void _a11yUnsub

  function bakeStaticMinimapLayer(): void {
    const ctx = staticLayer.getContext('2d')
    if (!ctx) return
    const w = staticLayer.width
    const h = staticLayer.height
    const palette = currentHudPalette()

    // Painted chart: deep-water fill (the rounded porthole frame is CSS
    // on the canvas element), sand-cream route with the palette's info
    // hue inside it so colorblind swaps still land.
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(7, 32, 40, 0.84)'
    ctx.fillRect(0, 0, w, h)

    if (splinePoints.length > 1) {
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      const first = worldToCanvas(splinePoints[0]!.x, splinePoints[0]!.z)
      ctx.moveTo(first.cx, first.cy)
      // Cache the first point — worldToCanvas reuses its return object so
      // we can't keep a reference to the result across calls.
      const firstCx = first.cx
      const firstCy = first.cy
      for (let i = 1; i < splinePoints.length; i++) {
        const p = splinePoints[i]!
        const c = worldToCanvas(p.x, p.z)
        ctx.lineTo(c.cx, c.cy)
      }
      ctx.lineTo(firstCx, firstCy)
      // Sand-cream causeway…
      ctx.strokeStyle = 'rgba(255, 245, 225, 0.5)'
      ctx.lineWidth = 7
      ctx.stroke()
      // …with the lane hint painted down its middle. The `info` palette
      // slot shifts under colorblind modes, so the meaningful hue still
      // resolves.
      ctx.strokeStyle = applyAlpha(palette.info, 0.85)
      ctx.lineWidth = 2.5
      ctx.stroke()
    }

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
  }

  function tickCountdown(): void {
    if (countdownDone) return
    // M10.12 lobby — hold the countdown gate. While waiting, the banner
    // stays whatever the lobby UI sets it to (we don't clobber it here);
    // `isLocked()` returns true; the sim doesn't advance the race.
    if (waitingForLobby) return
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
      if (opts.hideCountdownBanner) {
        // External overlay (e.g. start-lights) owns the visual — keep
        // the banner blank but still pump the callback so the overlay
        // gets its 3/2/1/GO ticks.
        banner.classList.remove('show', 'flash-go', 'pop')
        bannerText.textContent = ''
      } else if (value === -1) {
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
    // the `pop` class for one frame after a value change. Skipped when
    // the banner is suppressed — the start-lights overlay drives its
    // own animations.
    if (value !== -1 && !opts.hideCountdownBanner) {
      // The class is added when value changes; we strip it on next dt
      // so re-adding restarts the animation.
      banner.classList.remove('pop')
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      void banner.offsetWidth
      banner.classList.add('pop')
    }
  }

  // ---- HUD text dirty-flag state -------------------------------------------
  // Every text field is skipped when the input value hasn't changed since the
  // last tick. Race / lap time advance most frames so they update most frames,
  // but lap chip / position badge / lap-extra change only on lap crossings —
  // those saved DOM writes are the main win. Using NaN as the sentinel
  // guarantees the first tick always writes.
  let lastRaceTime = Number.NaN
  let lastLapTimeNum = Number.NaN
  let lastLapKey = -1 // lap * 1000 + lapsToFinish
  let lastPositionKey = -1 // playerPosition * 1000 + totalRacers
  let lastPosition = -1 // previous playerPosition, for gain/lose flashes
  let badgeFlashTimer: ReturnType<typeof setTimeout> | null = null
  let lastExtraLast: number | null | undefined
  let lastExtraBest: number | null | undefined
  let lastFinished: boolean | undefined

  /** Pop the position board and tint it mint (gained places) or hazard
   *  (lost places) for a beat. Purely cosmetic — a rapid re-pass just
   *  restarts the flash. */
  function flashBoard(direction: 'gain' | 'lose'): void {
    rpBoard.classList.remove('pop', 'gain', 'lose')
    // Force a reflow so re-adding `pop` restarts the CSS animation.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    void rpBoard.offsetWidth
    rpBoard.classList.add('pop', direction)
    if (badgeFlashTimer !== null) clearTimeout(badgeFlashTimer)
    badgeFlashTimer = setTimeout(() => {
      rpBoard.classList.remove('pop', 'gain', 'lose')
      badgeFlashTimer = null
    }, 700)
  }

  const ORDINAL_SUFFIX = ['th', 'st', 'nd', 'rd'] as const
  function ordinalSuffix(n: number): string {
    const tens = n % 100
    if (tens >= 11 && tens <= 13) return 'th'
    return ORDINAL_SUFFIX[n % 10] ?? 'th'
  }

  function tick(input: RaceHudInput): void {
    tickCountdown()

    // ---- Timer card -------------------------------------------------------
    if (input.raceTime !== lastRaceTime) {
      timeValue.textContent = formatTime(input.raceTime)
      lastRaceTime = input.raceTime
    }
    if (input.currentLapTime !== lastLapTimeNum) {
      lapTimeValue.textContent = formatTime(input.currentLapTime)
      lastLapTimeNum = input.currentLapTime
    }

    // ---- Position badge + lap chip ----------------------------------------
    posBadge.classList.add('show')
    const lapShown = Math.min(input.lap, input.lapsToFinish)
    const lapKey = lapShown * 1000 + input.lapsToFinish
    if (lapKey !== lastLapKey) {
      rpLap.innerHTML = `LAP <b>${lapShown}/${input.lapsToFinish}</b>`
      rpLap.classList.toggle('final', lapShown === input.lapsToFinish && input.lapsToFinish > 1)
      lastLapKey = lapKey
    }
    const posKey = input.totalRacers > 0 ? input.playerPosition * 1000 + input.totalRacers : 0
    if (posKey !== lastPositionKey) {
      // Solo time trial has no field to place in — hide the board, keep
      // the lap chip.
      rpBoard.style.display = input.totalRacers > 1 ? '' : 'none'
      if (input.totalRacers > 1) {
        rpNum.textContent = String(input.playerPosition)
        rpSuf.textContent = ordinalSuffix(input.playerPosition)
        rpTotal.textContent = `/${input.totalRacers}`
        if (lastPosition > 0 && input.playerPosition !== lastPosition) {
          flashBoard(input.playerPosition < lastPosition ? 'gain' : 'lose')
        }
      }
      lastPosition = input.playerPosition
      lastPositionKey = posKey
    }
    if (input.lastLapTime !== lastExtraLast || input.bestLapTime !== lastExtraBest) {
      // Only allocate the parts array + join when the values actually
      // changed (lap crossings + best-PB updates).
      const last = input.lastLapTime !== null ? `Last ${formatTime(input.lastLapTime)}` : null
      const best = input.bestLapTime !== null ? `Best ${formatTime(input.bestLapTime)}` : null
      lapTimeExtra.textContent =
        last !== null && best !== null
          ? `${last} · ${best}`
          : last !== null
            ? last
            : best !== null
              ? best
              : ''
      lastExtraLast = input.lastLapTime
      lastExtraBest = input.bestLapTime
    }

    if (input.finished !== lastFinished) {
      if (input.finished) {
        timerCard.classList.add('finished')
      } else {
        timerCard.classList.remove('finished')
      }
      lastFinished = input.finished
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
    const palette = currentHudPalette()

    // Static layer (background + spline + start gate) is baked once at
    // construction; one blit replaces a fresh polyline stroke per frame.
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(staticLayer, 0, 0)

    // Next-checkpoint highlight for the player.
    const nextCp = opts.track.checkpoints[input.playerNextCheckpoint]
    if (nextCp && !input.finished) {
      const c = worldToCanvas(nextCp.position.x, nextCp.position.z)
      ctx.strokeStyle = palette.warning
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(c.cx, c.cy, 8, 0, Math.PI * 2)
      ctx.stroke()
    }

    // Bikes — drawn in three passes so the player ends up on top of the
    // leader, and the leader on top of regular opponents, without paying
    // the per-frame allocation + sort cost of a spread-and-sort.
    for (const dot of input.bikes) {
      if (dot.isPlayer || dot.isLeader) continue
      drawMinimapDot(ctx, dot)
    }
    for (const dot of input.bikes) {
      if (dot.isPlayer || !dot.isLeader) continue
      drawMinimapDot(ctx, dot)
    }
    for (const dot of input.bikes) {
      if (!dot.isPlayer) continue
      drawMinimapDot(ctx, dot)
    }
  }

  function drawMinimapDot(ctx: CanvasRenderingContext2D, dot: MinimapDot): void {
    const c = worldToCanvas(dot.x, dot.z)
    const r = dot.isPlayer ? 5 : dot.isLeader ? 4 : 3.2
    const palette = currentHudPalette()
    ctx.fillStyle = dot.isPlayer
      ? palette.player
      : dot.isLeader
        ? palette.leader
        : (dot.color ?? palette.opponent)
    ctx.beginPath()
    ctx.arc(c.cx, c.cy, r, 0, Math.PI * 2)
    ctx.fill()
    // Vinyl-pin read: a dark seat ring on everyone so dots hold up over
    // the light route stroke, plus a cream cap ring on the player.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)'
    ctx.lineWidth = 1
    ctx.stroke()
    if (dot.isPlayer) {
      ctx.strokeStyle = 'rgba(255, 245, 225, 0.95)'
      ctx.lineWidth = 2
      ctx.stroke()
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
    // Forget the previous placing so a respawn/replay doesn't flash a
    // phantom gain/lose on its first tick.
    lastPosition = -1
  }

  /** Drop any hold-banner styling/text (see setHoldBanner). */
  function clearHoldBanner(): void {
    banner.classList.remove('show', 'flash-go', 'pop')
    bannerText.textContent = ''
    bannerText.style.fontSize = ''
    bannerText.style.opacity = ''
  }

  function skipCountdown(): void {
    // Skip implies arming, so lobby holds also release.
    waitingForLobby = false
    // Drop the anchor far enough in the past that the next tickCountdown
    // call observes "elapsed >= total" and shuts the banner down.
    countdownStartMs = performance.now() - COUNTDOWN_TOTAL * 1000 - 1
    countdownDone = true
    clearHoldBanner()
  }

  function armCountdown(): void {
    if (!waitingForLobby) return
    waitingForLobby = false
    // Clear the hold banner ("WAITING FOR RIDERS…") so the preroll
    // starts from a blank slate; tickCountdown owns the text from here.
    clearHoldBanner()
    // Re-anchor as if the first tick is happening right now so the
    // preroll + 3-2-1 plays out from a clean wall clock — no time lost
    // to however long the lobby took to clear.
    countdownStartMs = -1
  }

  function setHoldBanner(text: string | null): void {
    if (!waitingForLobby) return
    if (text) {
      banner.classList.add('show')
      bannerText.textContent = text
      // The banner is sized for a giant "3"/"GO!" glyph — a sentence at
      // that size overflows the screen. Inline-shrink while holding;
      // armCountdown / skipCountdown reset the style.
      bannerText.style.fontSize = '26px'
      bannerText.style.opacity = '0.85'
    } else {
      clearHoldBanner()
    }
  }

  return {
    tick,
    isLocked: () => {
      if (waitingForLobby) return true
      if (countdownDone) return false
      if (countdownStartMs < 0) return true
      const elapsed = (performance.now() - countdownStartMs) / 1000
      return elapsed < COUNTDOWN_PREROLL + COUNTDOWN_TICK_SECONDS * 3
    },
    recordRacerCheckpoint,
    reportPlayerCheckpoint,
    skipCountdown,
    reset,
    armCountdown,
    isWaitingForLobby: () => waitingForLobby,
    setHoldBanner,
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

/** Apply an alpha channel to a `#rrggbb` palette color so canvas
 *  strokes can keep their existing translucent look across colorblind
 *  palette swaps. Falls through to the input unchanged for non-hex
 *  inputs (rgba(), named colors) so callers can't crash the HUD by
 *  feeding an unexpected swatch. */
function applyAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith('#') || (hex.length !== 7 && hex.length !== 4)) return hex
  const v = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex
  const r = parseInt(v.slice(1, 3), 16)
  const g = parseInt(v.slice(3, 5), 16)
  const b = parseInt(v.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
