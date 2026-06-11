/**
 * Cup-results overlay — the championship standings panel. Populates the
 * `#cup-results` DOM (defined in index.html) with the full-field table
 * (every rival ranked by accumulated points) and the player's trophy,
 * then wires its BACK TO MENU button to the caller's callback.
 *
 * Used two ways:
 *   - As the data panel that slides in over the 3D podium ceremony
 *     (`podium-mode.ts`) once the trophy lift finishes.
 *   - Standalone fallback when the renderer can't stand up a 3D scene.
 *
 * Full-field (v2): standings come from `cupStandings()`, so the champion
 * line surfaces the actual top-of-table rider — which may be an AI — and
 * the player's medal reflects their real overall placement.
 */

import {
  type CupProgress,
  type CupStandingRow,
  cupStandings,
  type TrophyTier,
  trophyForRank,
} from '@/engine/cup-progress'
import { V1_CUPS } from '@/engine/menus/tracks-catalog'

function displayCupName(cupId: string): string {
  if (cupId === 'dev-placeholder') return 'Dev Placeholder Cup'
  if (cupId === 'dev') return 'Dev Cup'
  return V1_CUPS.find((c) => c.id === cupId)?.name ?? cupId
}

const TROPHY_HEX: Record<'gold' | 'silver' | 'bronze', string> = {
  gold: '#ffd27a',
  silver: '#cbd5e1',
  bronze: '#cd7f32',
}

const TROPHY_LABEL: Record<'gold' | 'silver' | 'bronze', string> = {
  gold: 'GOLD TROPHY',
  silver: 'SILVER TROPHY',
  bronze: 'BRONZE TROPHY',
}

/** Headline reflecting the player's overall placement. */
function titleForTrophy(trophy: TrophyTier): string {
  if (trophy === 'gold') return 'CHAMPION'
  if (trophy === 'silver') return 'RUNNER-UP'
  if (trophy === 'bronze') return 'PODIUM FINISH'
  return 'CUP COMPLETE'
}

function medalSwatch(rank: number): string {
  if (rank === 1) return TROPHY_HEX.gold
  if (rank === 2) return TROPHY_HEX.silver
  if (rank === 3) return TROPHY_HEX.bronze
  return ''
}

function hexColor(c: number): string {
  return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`
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
 *  in-place rather than stacking). Returns a dispose() that detaches the
 *  key listener so a host (the podium) can clean up. */
export function showCupResultsOverlay(opts: CupResultsOpts): () => void {
  const root = document.getElementById('cup-results')
  if (!root) {
    // Headless / stripped test page — fall back to the menu jump so
    // the user isn't stranded.
    opts.onBackToMenu()
    return () => {}
  }
  const title = document.getElementById('cup-results-title')
  const sub = document.getElementById('cup-results-sub')
  const ribbon = document.getElementById('cup-results-ribbon')
  const standingsEl = document.getElementById('cup-results-standings')
  const championLbl = document.querySelector<HTMLElement>('#cup-results-champion .lbl')
  const championWho = document.getElementById('cup-results-champion-who')
  const menuBtn = document.getElementById('cup-results-menu') as HTMLButtonElement | null

  const { progress } = opts
  const standings = cupStandings(progress)
  const player = standings.find((r) => r.identity.isPlayer) ?? null
  const champion = standings[0] ?? null
  const trophy = player ? trophyForRank(player.rank) : null

  if (ribbon) ribbon.textContent = 'CHAMPIONSHIP'
  if (title) title.textContent = titleForTrophy(trophy)
  if (sub) {
    const name = displayCupName(progress.cupId).toUpperCase()
    sub.textContent = `${name} · ${progress.races.length} RACES`
  }

  if (standingsEl) {
    standingsEl.innerHTML = renderStandingsRows(standings)
  }

  if (championWho && champion) {
    if (championLbl) championLbl.textContent = champion.identity.isPlayer ? 'YOU WON' : 'CHAMPION'
    // The trophy line reads from the player's perspective: their medal +
    // their placement, with the actual champion named when it isn't them.
    if (trophy) {
      championWho.innerHTML =
        `<span style="color:${TROPHY_HEX[trophy]}">${TROPHY_LABEL[trophy]}</span>` +
        ` · ${escapeHtml(champion.identity.name)} · ${champion.totalPoints} PTS`
    } else if (player) {
      championWho.textContent = `${escapeHtml(champion.identity.name)} · ${champion.totalPoints} PTS · YOU ${ordinal(player.rank)}`
    } else {
      championWho.textContent = `${escapeHtml(champion.identity.name)} · ${champion.totalPoints} PTS`
    }
  }

  if (menuBtn) {
    menuBtn.onclick = () => opts.onBackToMenu()
    menuBtn.focus({ preventScroll: true })
  }

  root.classList.add('show')

  // ESC / Enter also returns to menu — matches the finish-screen
  // affordance and keeps keyboard players from being trapped.
  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault()
      window.removeEventListener('keydown', onKey)
      opts.onBackToMenu()
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}

function renderStandingsRows(standings: CupStandingRow[]): string {
  const rows: string[] = [
    `<div class="row head">
      <div class="pos">#</div>
      <div>RACER</div>
      <div class="pts-this">WINS</div>
      <div class="pts">PTS</div>
    </div>`,
  ]
  for (const row of standings) {
    const swatch = medalSwatch(row.rank)
    const posCell = swatch
      ? `<div class="pos" style="color:${swatch}">${row.rank}</div>`
      : `<div class="pos">${row.rank}</div>`
    rows.push(`
      <div class="row${row.identity.isPlayer ? ' me' : ''}">
        ${posCell}
        <div class="who"><span class="dot" style="background:${hexColor(row.identity.bodyColor)}"></span>${escapeHtml(row.identity.name)}</div>
        <div class="pts-this">${row.wins}</div>
        <div class="pts">${row.totalPoints}</div>
      </div>
    `)
  }
  return rows.join('')
}

function ordinal(n: number): string {
  if (n <= 0) return '—'
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}TH`
  switch (n % 10) {
    case 1:
      return `${n}ST`
    case 2:
      return `${n}ND`
    case 3:
      return `${n}RD`
    default:
      return `${n}TH`
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
