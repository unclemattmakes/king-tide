/**
 * Cup-results overlay — the championship summary screen, shown over
 * the finish screen after the last race in a cup. Populates the
 * `#cup-results` DOM (defined in index.html) with a per-race points
 * table and a champion banner, then wires its BACK TO MENU button to
 * the caller's callback.
 *
 * Single-player only for v1. The "champion" today is just the player;
 * once cup-mode supports per-AI standings the champion line will
 * surface the actual top-of-table rider.
 */

import {
  CUP_POINTS,
  type CupProgress,
  pointsForPosition,
  totalCupPoints,
} from '@/engine/cup-progress'
import { V1_CUPS } from '@/engine/menus/tracks-catalog'

// Track name lookup is best-effort — the placeholder cup races use the
// procedural / GLB ids ("lagoon", "cliffside", "big-bay") which aren't
// in `V1_TRACKS`. For those, we humanize the id directly. Keeping the
// lookup module-local sidesteps an import from `catalog.ts`'s
// manifest-aware path; the overlay never needs the manifest itself.
const DEV_TRACK_DISPLAY: Record<string, string> = {
  lagoon: 'Lagoon Loop',
  cliffside: 'Cliffside',
}

function displayTrackName(id: string): string {
  if (DEV_TRACK_DISPLAY[id]) return DEV_TRACK_DISPLAY[id] as string
  // Humanize kebab-case ids: "big-bay" → "Big Bay".
  return id
    .split('-')
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
}

function displayCupName(cupId: string): string {
  if (cupId === 'dev-placeholder') return 'Dev Placeholder Cup'
  if (cupId === 'dev') return 'Dev Cup'
  return V1_CUPS.find((c) => c.id === cupId)?.name ?? cupId
}

function ordinalSuffix(n: number): string {
  if (n <= 0) return '—'
  if (n === 1) return '1st'
  if (n === 2) return '2nd'
  if (n === 3) return '3rd'
  return `${n}th`
}

export type CupResultsOpts = {
  progress: CupProgress
  /** Wired to the overlay's BACK TO MENU button. The caller owns the
   *  navigation + cup-progress cleanup so the screen itself stays
   *  side-effect-free at render time. */
  onBackToMenu: () => void
}

/** Populate + show the cup-results overlay. Safe to call after the
 *  last race in a cup; idempotent (re-rendering replaces the contents
 *  in-place rather than stacking). */
export function showCupResultsOverlay(opts: CupResultsOpts): void {
  const root = document.getElementById('cup-results')
  if (!root) {
    // Headless / stripped test page — fall back to the menu jump so
    // the user isn't stranded.
    opts.onBackToMenu()
    return
  }
  const title = document.getElementById('cup-results-title')
  const sub = document.getElementById('cup-results-sub')
  const ribbon = document.getElementById('cup-results-ribbon')
  const standings = document.getElementById('cup-results-standings')
  const championWho = document.getElementById('cup-results-champion-who')
  const menuBtn = document.getElementById('cup-results-menu') as HTMLButtonElement | null

  const { progress } = opts
  const totalPoints = totalCupPoints(progress)

  if (ribbon) ribbon.textContent = 'CHAMPIONSHIP'
  if (title) title.textContent = 'CUP COMPLETE'
  if (sub) {
    const name = displayCupName(progress.cupId).toUpperCase()
    sub.textContent = `${name} · ${progress.races.length} RACES`
  }

  if (standings) {
    const rows: string[] = []
    rows.push(`
      <div class="row head">
        <div class="pos">#</div>
        <div>VENUE</div>
        <div class="pts-this">FINISH</div>
        <div class="pts">PTS</div>
      </div>
    `)
    for (let i = 0; i < progress.races.length; i++) {
      const trackId = progress.races[i] ?? ''
      const result = progress.results[trackId]
      const venue = displayTrackName(trackId)
      const finishLabel = result?.position
        ? `${ordinalSuffix(result.position)}/${result.totalRacers}`
        : 'DNF'
      const points = pointsForPosition(result?.position ?? null)
      rows.push(`
        <div class="row">
          <div class="pos">${i + 1}</div>
          <div>${escapeHtml(venue)}</div>
          <div class="pts-this">${escapeHtml(finishLabel)}</div>
          <div class="pts">${points}</div>
        </div>
      `)
    }
    rows.push(`
      <div class="row" style="border-bottom: none; padding-top: 12px;">
        <div></div>
        <div style="font-family: var(--bc-font-display); letter-spacing: 0.18em;">TOTAL</div>
        <div></div>
        <div class="pts" style="font-size: 18px;">${totalPoints}</div>
      </div>
    `)
    standings.innerHTML = rows.join('')
  }

  if (championWho) {
    // Single-player only — the player IS the championship leader by
    // definition. The points readout makes the result legible even
    // without per-AI standings.
    championWho.textContent = `YOU · ${totalPoints} PTS`
    // Suffix the line with the max possible points so the player
    // can see their proximity to a clean sweep.
    const maxPossible = progress.races.length * (CUP_POINTS[1] ?? 0)
    championWho.textContent = `YOU · ${totalPoints}/${maxPossible} PTS`
  }

  if (menuBtn) {
    menuBtn.onclick = () => opts.onBackToMenu()
    menuBtn.focus({ preventScroll: true })
  }

  root.classList.add('show')

  // ESC also returns to menu — matches the finish-screen affordance
  // and keeps keyboard players from being trapped.
  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault()
      window.removeEventListener('keydown', onKey)
      opts.onBackToMenu()
    }
  }
  window.addEventListener('keydown', onKey)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
