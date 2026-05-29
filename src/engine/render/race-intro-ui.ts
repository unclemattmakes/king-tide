/**
 * Broadcast-style overlay shown during the cinematic race intro.
 *
 * Three beat panels driven by the race-intro director's progress:
 *
 *   - **Title card** (top-center) — cup chip, track name, location, lore.
 *     Anchors the aerial shot. Collapses to a compact header during the
 *     descent shot so the start grid is unobscured.
 *   - **Conditions strip** (bottom-left) — laps · time of day · weather ·
 *     set-piece. The "post-flood arcade broadcast" caption stack.
 *   - **Racer roster** (bottom-right) — 8-line slot list with bike colour
 *     swatches. Slides in during the skim shot.
 *
 * Lifecycle mirrors `start-lights.ts`:
 *
 *   const ui = createRaceIntroUi({...})
 *   ui.tick(elapsedSec)   // every frame while the director is active
 *   ui.skipFade()         // optional — speeds the outro on skip()
 *   ui.hide()             // tear down once the director reports done
 *
 * The overlay updates by writing CSS data attributes (no per-frame DOM
 * thrash). All transitions live in `index.html`'s stylesheet alongside
 * the existing #race-intro-skip rules. The skip prompt itself stays where
 * it is — this overlay sits behind it.
 */

import type { TrackTheme } from '@/game/tracks/theme-catalog'

export type RaceIntroUiRacer = {
  /** Grid slot. 0 = player pole position, 1..7 = AI. */
  slot: number
  /** Display name — call-sign for AI, variant name (or player handle) for slot 0. */
  name: string
  /** Bike variant label shown small under the call-sign (e.g. "Cruiser"). */
  variantName: string
  /** CSS hex string ("#ff7733") used for the color swatch chip. */
  bodyColorHex: string
  /** True for the local human player. Highlighted in the roster. */
  isPlayer: boolean
}

export type RaceIntroUiOpts = {
  /** Title-card track name. */
  trackName: string
  /** Theme block — provides location, cup, set-piece, lore, palette, labels. */
  theme: TrackTheme
  /** Laps for the race. Shown in the conditions strip. */
  lapsToFinish: number
  /** Roster, ordered slot 0..N. The UI sorts player to top. */
  racers: readonly RaceIntroUiRacer[]
  /** Total intro duration (sum of shot lengths). The UI maps `tick()`'s
   *  elapsed value into [0..1] to drive the stage transitions. */
  totalDurationSec: number
  /** Variant: 'full' mirrors the 3-shot intro layout; 'short' shows
   *  only the title card briefly. */
  variant: 'full' | 'short'
  /** Override for the root element id (test injection). */
  rootId?: string
}

export interface RaceIntroUi {
  /** Drive the overlay by elapsed director time. Called every frame
   *  while the director's `isActive()` is true. */
  tick(elapsedSec: number): void
  /** Tear down + fade. Called once `isActive()` flips false. */
  hide(): void
  /** When the player presses Skip mid-intro, flip straight to the
   *  collapsed (post-descent) stage so the elements don't linger
   *  past the GO! moment. */
  skipFade(): void
  /** Test-only — returns the current stage index + visibility. */
  state(): { stage: 0 | 1 | 2; visible: boolean }
}

const DEFAULT_ROOT_ID = 'race-intro-ui'

export function createRaceIntroUi(opts: RaceIntroUiOpts): RaceIntroUi {
  const root = buildRoot(opts.rootId ?? DEFAULT_ROOT_ID, opts)
  let stage: 0 | 1 | 2 = 0
  let visible = true
  let skipped = false

  function setStage(next: 0 | 1 | 2): void {
    if (next === stage) return
    stage = next
    root.setAttribute('data-stage', String(stage))
  }

  // Initial classes — slide everything in on the first paint via CSS.
  root.classList.add('riu-active')
  root.setAttribute('data-stage', '0')
  root.setAttribute('data-variant', opts.variant)

  return {
    tick(elapsedSec: number): void {
      if (!visible) return
      if (skipped) {
        setStage(2)
        return
      }
      if (opts.variant === 'short') {
        // Single-shot mode — stay on stage 0 until 75% through, then drop
        // to the compact stage so the brief overlay doesn't sit on top of
        // the start grid.
        const t = elapsedSec / Math.max(0.001, opts.totalDurationSec)
        setStage(t < 0.75 ? 0 : 2)
        return
      }
      const t = elapsedSec / Math.max(0.001, opts.totalDurationSec)
      // Three equal beats. The CSS picks up via [data-stage] and runs the
      // slide/fade transitions for each panel independently.
      if (t < 0.34) setStage(0)
      else if (t < 0.7) setStage(1)
      else setStage(2)
    },
    hide(): void {
      if (!visible) return
      visible = false
      root.classList.remove('riu-active')
      root.classList.add('riu-leaving')
      // Remove after the fade-out completes. Matches the 320 ms transition
      // duration used by #race-intro-skip in index.html.
      window.setTimeout(() => {
        root.parentElement?.removeChild(root)
      }, 360)
    },
    skipFade(): void {
      if (skipped) return
      skipped = true
      setStage(2)
    },
    state(): { stage: 0 | 1 | 2; visible: boolean } {
      return { stage, visible }
    },
  }
}

// ──────────────────────────── DOM build ────────────────────────────

function buildRoot(rootId: string, opts: RaceIntroUiOpts): HTMLElement {
  // Re-use a stray previous root if the player back-out + restart cycle
  // landed us in a state where the prior intro's hide() animation hadn't
  // finished. Empty + repopulate so the new race's data wins.
  let root = document.getElementById(rootId)
  if (root) {
    root.innerHTML = ''
    root.className = ''
  } else {
    root = document.createElement('div')
    root.id = rootId
    document.body.appendChild(root)
  }

  // Title card (top-center).
  const titleCard = document.createElement('div')
  titleCard.className = 'riu-title'
  const cupChip = document.createElement('div')
  cupChip.className = 'riu-cup'
  cupChip.textContent = `${opts.theme.cup.toUpperCase()} CUP`
  const trackName = document.createElement('div')
  trackName.className = 'riu-track'
  trackName.textContent = opts.trackName.toUpperCase()
  const location = document.createElement('div')
  location.className = 'riu-location'
  location.textContent = opts.theme.location
  const lore = document.createElement('div')
  lore.className = 'riu-lore'
  lore.textContent = opts.theme.lore
  titleCard.appendChild(cupChip)
  titleCard.appendChild(trackName)
  titleCard.appendChild(location)
  if (opts.theme.lore) titleCard.appendChild(lore)

  // Conditions strip (bottom-left).
  const conditions = document.createElement('div')
  conditions.className = 'riu-conditions'
  appendCondition(conditions, 'LAPS', `${opts.lapsToFinish}`)
  appendCondition(conditions, 'TIME', opts.theme.timeLabel)
  appendCondition(conditions, 'CONDITIONS', opts.theme.weatherLabel)
  if (opts.theme.setPiece && opts.theme.setPiece !== '—') {
    appendCondition(conditions, 'SET-PIECE', opts.theme.setPiece)
  }
  if (opts.theme.palette && opts.theme.palette !== '—') {
    appendCondition(conditions, 'PALETTE', opts.theme.palette)
  }

  // Racer roster (bottom-right).
  const roster = document.createElement('div')
  roster.className = 'riu-roster'
  const rosterHeader = document.createElement('div')
  rosterHeader.className = 'riu-roster-header'
  rosterHeader.textContent = 'TODAY ON THE CIRCUIT'
  roster.appendChild(rosterHeader)
  const rosterList = document.createElement('ul')
  rosterList.className = 'riu-roster-list'
  // Player first regardless of slot order (visual prominence) — the
  // remaining AI bikes follow in slot order.
  const sorted = [...opts.racers].sort((a, b) => {
    if (a.isPlayer && !b.isPlayer) return -1
    if (b.isPlayer && !a.isPlayer) return 1
    return a.slot - b.slot
  })
  for (const r of sorted) {
    const li = document.createElement('li')
    li.className = `riu-roster-row${r.isPlayer ? ' riu-roster-player' : ''}`
    const swatch = document.createElement('span')
    swatch.className = 'riu-swatch'
    swatch.style.background = r.bodyColorHex
    const slotNum = document.createElement('span')
    slotNum.className = 'riu-slot'
    slotNum.textContent = String(r.slot + 1).padStart(2, '0')
    const name = document.createElement('span')
    name.className = 'riu-name'
    name.textContent = r.name
    const variant = document.createElement('span')
    variant.className = 'riu-variant'
    variant.textContent = r.isPlayer ? 'YOU' : r.variantName.toUpperCase()
    li.appendChild(slotNum)
    li.appendChild(swatch)
    li.appendChild(name)
    li.appendChild(variant)
    rosterList.appendChild(li)
  }
  roster.appendChild(rosterList)

  root.appendChild(titleCard)
  root.appendChild(conditions)
  root.appendChild(roster)
  return root
}

function appendCondition(parent: HTMLElement, label: string, value: string): void {
  const row = document.createElement('div')
  row.className = 'riu-cond-row'
  const lab = document.createElement('span')
  lab.className = 'riu-cond-label'
  lab.textContent = label
  const val = document.createElement('span')
  val.className = 'riu-cond-value'
  val.textContent = value
  row.appendChild(lab)
  row.appendChild(val)
  parent.appendChild(row)
}
