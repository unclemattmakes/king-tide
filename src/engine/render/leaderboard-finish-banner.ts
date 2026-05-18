/**
 * Finish-overlay leaderboard banner. Lives inside the existing
 * `#finish-best` element so it inherits the same animation + layout
 * as the race / PB / GHOST SAVED pills, but owns its own lifecycle:
 *
 *   1. Render the static line — race time + PB.
 *   2. If TT PB + submit-toggle on:
 *        a. No handle yet → render an inline "ENTER YOUR INITIALS"
 *           form, focus its input, wait for SAVE / Enter / SKIP.
 *        b. Handle set    → submit local immediately, render the
 *           rank pill, fire remote in background, upgrade the pill
 *           on response.
 *   3. If TT PB but submit-toggle off → just GHOST SAVED, no pill.
 *
 * The remote round-trip is fire-and-forget from the player's POV: a
 * `SUBMITTING…` indicator becomes the real rank when the response
 * lands, or a `LOCAL ONLY` badge if the network bounced. Failure is
 * recoverable — the local cache already has the entry, and the next
 * time the menu opens it'll re-attempt.
 *
 * @see src/engine/leaderboard/remote.ts     — fetch wrapper
 * @see src/engine/leaderboard/local.ts      — cache the player sees first
 * @see src/engine/leaderboard/endpoint.ts   — host/secret resolver
 */

import { formatLap } from '@/engine/garage'
import { normalizeHandle } from '@/engine/leaderboard/core'
import { getEndpoint, isRemoteEnabled } from '@/engine/leaderboard/endpoint'
import { type SubmitResult, submitEntry as submitLocal } from '@/engine/leaderboard/local'
import { type SubmitNetworkResult, submitRemote } from '@/engine/leaderboard/remote'
import { playerSettings, setLeaderboardHandle } from '@/engine/player-settings'

export type FinishBannerOpts = {
  host: HTMLElement
  trackId: string
  bikeId: string
  bestLapThisRace: number | null
  bestLapAllTime: number | null
  /** Best-lap seconds from the slice that was just persisted as the
   *  new ghost — non-null means "we set a TT PB this race, submit it".
   *  Null in non-TT modes or when the player didn't beat their stored
   *  ghost. */
  ttPbBestLap: number | null
}

const PROFANITY_MESSAGE = "That name can't go on the board — try another."
const NETWORK_FALLBACK_LABEL = 'LOCAL ONLY'
const SUBMITTING_LABEL = 'SUBMITTING…'

/** Render the banner into `host` and wire any async state. Idempotent
 *  re-renders are safe — call again on the same host with new state to
 *  refresh. */
export function renderLeaderboardFinishBanner(opts: FinishBannerOpts): void {
  const { host, trackId, bikeId, bestLapThisRace, bestLapAllTime, ttPbBestLap } = opts
  const parts: string[] = []
  if (bestLapThisRace !== null) {
    parts.push(`${formatLap(bestLapThisRace)} (race)`)
  }
  if (bestLapAllTime !== null) {
    parts.push(`<span class="best">${formatLap(bestLapAllTime)} (PB)</span>`)
  }
  if (ttPbBestLap === null) {
    host.innerHTML = parts.length ? parts.join(' · ') : '—'
    return
  }

  parts.push('<span class="best">★ GHOST SAVED</span>')

  if (!playerSettings.leaderboardSubmit) {
    host.innerHTML = parts.join(' · ')
    return
  }

  const slotHtml = '<span id="finish-leaderboard-slot" class="finish-lb-slot"></span>'
  host.innerHTML = `${parts.join(' · ')} · ${slotHtml}`
  const slot = host.querySelector<HTMLElement>('#finish-leaderboard-slot')
  if (!slot) return

  if (playerSettings.leaderboardHandle) {
    submitAndShowPill(slot, {
      trackId,
      bikeId,
      bestLap: ttPbBestLap,
      handle: playerSettings.leaderboardHandle,
    })
    return
  }

  renderInitialsPrompt(slot, {
    trackId,
    bikeId,
    bestLap: ttPbBestLap,
  })
}

type SubmissionCtx = {
  trackId: string
  bikeId: string
  bestLap: number
  handle: string
}

function renderInitialsPrompt(slot: HTMLElement, ctx: Omit<SubmissionCtx, 'handle'>): void {
  slot.innerHTML = `
    <span class="finish-lb-prompt">
      <span class="lbl">ENTER INITIALS</span>
      <input
        id="finish-lb-input"
        type="text"
        maxlength="12"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
      />
      <button type="button" id="finish-lb-save">SAVE</button>
      <button type="button" id="finish-lb-skip" class="finish-lb-skip">SKIP</button>
    </span>
    <span class="finish-lb-error" id="finish-lb-error" hidden></span>
  `
  const input = slot.querySelector<HTMLInputElement>('#finish-lb-input')
  const saveBtn = slot.querySelector<HTMLButtonElement>('#finish-lb-save')
  const skipBtn = slot.querySelector<HTMLButtonElement>('#finish-lb-skip')
  const errEl = slot.querySelector<HTMLElement>('#finish-lb-error')
  if (!input || !saveBtn || !skipBtn || !errEl) return

  // The form takes focus so the player can just type their initials
  // and hit Enter without reaching for the mouse.
  setTimeout(() => input.focus(), 0)

  const commit = (): void => {
    const normalized = normalizeHandle(input.value)
    if (!normalized) {
      input.focus()
      return
    }
    if (typeof window !== 'undefined') {
      // Re-use the profanity stem list from the shared module for the
      // client-side gentle nudge. Import lazily so the stem list
      // doesn't bloat the early-finish-overlay code path.
      import('@/engine/leaderboard/profanity').then(({ containsProfanity }) => {
        if (containsProfanity(normalized)) {
          showError(errEl, PROFANITY_MESSAGE)
          input.focus()
          return
        }
        setLeaderboardHandle(normalized)
        submitAndShowPill(slot, { ...ctx, handle: normalized })
      })
    } else {
      setLeaderboardHandle(normalized)
      submitAndShowPill(slot, { ...ctx, handle: normalized })
    }
  }

  saveBtn.addEventListener('click', commit)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      skipBtn.click()
    }
  })
  skipBtn.addEventListener('click', () => {
    // Skip path — submit anonymously as 'YOU'. Player can still set
    // a real handle later via Settings.
    submitAndShowPill(slot, { ...ctx, handle: 'YOU' })
  })
}

function showError(el: HTMLElement, msg: string): void {
  el.textContent = msg
  el.hidden = false
}

function submitAndShowPill(slot: HTMLElement, ctx: SubmissionCtx): void {
  const localRes = submitLocal({
    trackId: ctx.trackId,
    handle: ctx.handle,
    bikeId: ctx.bikeId,
    bestLap: ctx.bestLap,
  })
  // Optimistic local pill — show this immediately. The remote response
  // either confirms or upgrades it; failure leaves it visible with a
  // LOCAL ONLY annotation.
  renderPill(slot, ctx.handle, localRes.rank, 'submitting')
  if (!isRemoteEnabled()) {
    renderPill(slot, ctx.handle, localRes.rank, 'local-only')
    return
  }
  void submitRemoteAndRefresh(slot, ctx, localRes)
}

async function submitRemoteAndRefresh(
  slot: HTMLElement,
  ctx: SubmissionCtx,
  localRes: SubmitResult,
): Promise<void> {
  const endpoint = getEndpoint()
  let net: SubmitNetworkResult
  try {
    net = await submitRemote(
      {
        trackId: ctx.trackId,
        handle: ctx.handle,
        bikeId: ctx.bikeId,
        bestLap: ctx.bestLap,
      },
      endpoint,
    )
  } catch {
    renderPill(slot, ctx.handle, localRes.rank, 'local-only')
    return
  }
  if (!net.ok) {
    renderPill(slot, ctx.handle, localRes.rank, 'local-only')
    return
  }
  const res = net.response
  if (!res.ok) {
    if (res.error === 'profanity' || res.error === 'blocked-handle') {
      // Server rejected the handle even though our local filter cleared
      // it — surface the same nudge as the inline form did so the
      // player knows their entry didn't land globally.
      renderPill(slot, ctx.handle, localRes.rank, 'rejected', res.error)
      return
    }
    renderPill(slot, ctx.handle, localRes.rank, 'local-only', res.error)
    return
  }
  renderPill(slot, ctx.handle, res.rank, 'global')
}

type PillState = 'submitting' | 'global' | 'local-only' | 'rejected'

function renderPill(
  slot: HTMLElement,
  handle: string,
  rank: number | null,
  state: PillState,
  detail?: string,
): void {
  const safeHandle = handle.replace(/[^A-Z0-9_-]/g, '') || 'YOU'
  const rankLabel = rank !== null ? `#${rank}` : '#—'
  if (state === 'submitting') {
    slot.innerHTML = `<span class="best">★ ${rankLabel} LOCAL · ${SUBMITTING_LABEL}</span>`
    return
  }
  if (state === 'global') {
    slot.innerHTML = `<span class="best">${rankLabel} ON BOARD · ${safeHandle}</span>`
    return
  }
  if (state === 'rejected') {
    const reason = detail === 'profanity' ? 'NAME BLOCKED' : 'HANDLE BLOCKED'
    slot.innerHTML = `<span class="finish-lb-warn">${reason} · NOT ON GLOBAL BOARD</span>`
    return
  }
  // local-only fallback — keep the local rank visible with a badge so
  // the player isn't left wondering whether the submit landed.
  slot.innerHTML = `<span class="best">${rankLabel} · ${safeHandle} <span class="finish-lb-badge">${NETWORK_FALLBACK_LABEL}</span></span>`
}
