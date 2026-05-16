import type { TrackManifestEntry } from '@/game/assets/manifest'
import { type BikeVariantId, DEFAULT_BIKE_VARIANT } from '@/game/bikes/variants'
import { installMenuGamepad } from '../input/menu-gamepad'
import {
  type BikeCard,
  bestLapFor,
  buildBikeCards,
  buildTrackList,
  type TrackEntry,
} from './catalog'

/**
 * Cold-boot menu flow — sports-broadcast styled multi-screen router.
 *
 * Screens are populated into `#menu-stage` as siblings; `.show` toggles
 * which one is visible. The router holds the user's current picks
 * (track + bike) and forwards to the appropriate commit:
 *
 *   - SINGLEPLAYER → assemble URL → `window.location.assign(?race=1&track=…&bike=…)`
 *   - MULTIPLAYER  → room entry → `?room=<id>` (lobby takes over)
 *
 * The reload-to-race pattern keeps boot() simple: it only branches on
 * URL params, just like the existing garage flow did.
 */

export type MenuFlowResult = {
  /** Final destination — what the caller should navigate to. */
  href: string
}

export type MenuFlowOpts = {
  manifestTracks?: TrackManifestEntry[]
  /** Pre-fill picks (e.g. from a Back-to-Menu after a race). */
  initialTrackId?: string
  initialBikeId?: BikeVariantId
  /** "exit" arrives from a finish-screen EXIT click — show a banner. */
  reason?: 'cold' | 'exit-from-race'
}

type Step = 'title' | 'mode' | 'sp-track' | 'sp-bike' | 'mp-entry'

const STEPS_SP: { id: Step; label: string }[] = [
  { id: 'title', label: 'START' },
  { id: 'mode', label: 'MODE' },
  { id: 'sp-track', label: 'TRACK' },
  { id: 'sp-bike', label: 'BIKE' },
]

const STEPS_MP: { id: Step; label: string }[] = [
  { id: 'title', label: 'START' },
  { id: 'mode', label: 'MODE' },
  { id: 'mp-entry', label: 'ROOM' },
]

export function runMenuFlow(opts: MenuFlowOpts): Promise<MenuFlowResult> {
  const root = document.getElementById('menu') as HTMLElement | null
  const stage = document.getElementById('menu-stage') as HTMLElement | null
  const crumbsEl = document.getElementById('menu-crumbs') as HTMLElement | null
  const clockEl = document.getElementById('menu-clock') as HTMLElement | null
  const chyTag = document.getElementById('menu-chyron-tag') as HTMLElement | null
  const chyText = document.getElementById('menu-chyron-text') as HTMLElement | null
  if (!root || !stage || !crumbsEl) {
    return Promise.reject(new Error('[menu] DOM missing'))
  }
  document.body.classList.add('menu-active')
  root.classList.add('show')

  const tracks = buildTrackList(opts.manifestTracks)
  const bikeCards = buildBikeCards()

  const picks = {
    trackId: opts.initialTrackId ?? tracks[0]?.id ?? 'lagoon',
    bikeId: (opts.initialBikeId ?? DEFAULT_BIKE_VARIANT) as BikeVariantId,
  }

  let currentMode: 'sp' | 'mp' | null = null
  let currentStep: Step = 'title'
  const screens: Partial<Record<Step, HTMLElement>> = {}
  // `commitSpRace` lives inside the Promise executor (it needs `resolve`),
  // but `renderBikeCards` runs in the outer scope — bridge them via a ref.
  let commitSpRaceRef: (() => void) | null = null

  function updateClock(): void {
    if (!clockEl) return
    const now = new Date()
    const h = now.getHours().toString().padStart(2, '0')
    const m = now.getMinutes().toString().padStart(2, '0')
    clockEl.textContent = `${h}:${m} BROADCAST`
  }
  updateClock()
  const clockInterval = window.setInterval(updateClock, 30_000)

  function renderCrumbs(): void {
    if (!crumbsEl) return
    const steps = currentMode === 'mp' ? STEPS_MP : STEPS_SP
    crumbsEl.innerHTML = ''
    steps.forEach((s, i) => {
      if (i > 0) {
        const sep = document.createElement('span')
        sep.className = 'bc-crumb-sep'
        sep.textContent = '·'
        crumbsEl.appendChild(sep)
      }
      const c = document.createElement('span')
      c.className = 'bc-crumb' + (s.id === currentStep ? ' is-current' : '')
      c.textContent = s.label
      crumbsEl.appendChild(c)
    })
  }

  function setChyron(tag: string, text: string): void {
    if (chyTag) chyTag.textContent = tag
    if (chyText) chyText.textContent = text
  }

  function updateChyron(step: Step): void {
    switch (step) {
      case 'title':
        setChyron('PRE-SHOW', 'Press start when you’re ready to roll.')
        break
      case 'mode':
        setChyron('FORMAT', 'Solo qualifier or full lobby? Pick your weapon.')
        break
      case 'sp-track':
        setChyron('COURSE', 'Tap a card to lock in your venue.')
        break
      case 'sp-bike':
        setChyron('LOADOUT', 'Bars compare top speed, accel, agility, weight, wave-follow.')
        break
      case 'mp-entry':
        setChyron('LOBBY', 'Host a new room or punch in a friend’s code.')
        break
    }
  }

  function renderTrackCards(host: HTMLElement): void {
    host.innerHTML = ''
    for (const t of tracks) {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'bc-card' + (t.id === picks.trackId ? ' selected' : '')
      card.style.setProperty('--accent', t.accent)
      const best = bestLapFor(t.id, picks.bikeId)
      card.innerHTML = `
        <div class="label">TRACK</div>
        <div class="name">${escapeHtml(t.name).toUpperCase()}</div>
        <div class="tag">${escapeHtml(t.tagline)}</div>
        <div class="record">${best ? `BEST LAP &middot; ${best}` : 'NO RECORD'}</div>
      `
      // Clicking a card commits the pick and advances — no separate
      // confirm button. Tapping the same selection again is a no-op
      // from the user's perspective (we just re-advance).
      card.addEventListener('click', () => {
        picks.trackId = t.id
        showStep('sp-bike')
      })
      host.appendChild(card)
    }
  }

  function renderBikeCards(host: HTMLElement, showTrackBest: boolean): void {
    host.innerHTML = ''
    for (const b of bikeCards) {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'bc-card' + (b.id === picks.bikeId ? ' selected' : '')
      card.style.setProperty('--accent', b.accent)
      const best = showTrackBest ? bestLapFor(picks.trackId, b.id) : null
      const bars = b.bars
        .map(
          (s: BikeCard['bars'][number]) => `
            <div class="stat-row">
              <span class="lbl">${s.label}</span>
              <div class="bar"><i style="width: ${(s.value * 100).toFixed(0)}%"></i></div>
              <span class="val">${s.raw}</span>
            </div>`,
        )
        .join('')
      card.innerHTML = `
        <div class="label">BIKE</div>
        <div class="name">${escapeHtml(b.name)}</div>
        <div class="tag">${escapeHtml(b.tagline)}</div>
        <div class="stats">${bars}</div>
        ${best ? `<div class="record">BEST LAP &middot; ${best}</div>` : ''}
      `
      // Clicking a bike commits the loadout and launches the race
      // immediately — no separate "lights out" confirm button.
      card.addEventListener('click', () => {
        picks.bikeId = b.id
        commitSpRaceRef?.()
      })
      host.appendChild(card)
    }
  }

  function refreshStep(step: Step): void {
    if (step === 'sp-bike') {
      const host = screens['sp-bike']?.querySelector<HTMLElement>('#sp-bike-cards')
      const readout = screens['sp-bike']?.querySelector<HTMLElement>('#bike-track-readout')
      if (host) renderBikeCards(host, true)
      if (readout) {
        const cur = tracks.find((t) => t.id === picks.trackId)
        readout.textContent = (cur?.name ?? picks.trackId).toUpperCase()
      }
    } else if (step === 'sp-track') {
      const host = screens['sp-track']?.querySelector<HTMLElement>('#sp-track-cards')
      if (host) renderTrackCards(host)
    }
  }

  function showStep(step: Step): void {
    currentStep = step
    refreshStep(step)
    for (const k of Object.keys(screens) as Step[]) {
      screens[k]?.classList.toggle('show', k === step)
    }
    renderCrumbs()
    updateChyron(step)
    // Hand focus to the new screen so keyboard/gamepad have a clear
    // anchor. focusFirst prefers `.selected` then `.primary` then the
    // first focusable, which lines up nicely with what a user expects
    // when they land on each screen.
    gamepadNav.focusFirst()
  }

  function gamepadBack(): void {
    if (currentStep === 'mode') showStep('title')
    else if (currentStep === 'sp-track') showStep('mode')
    else if (currentStep === 'sp-bike') showStep('sp-track')
    else if (currentStep === 'mp-entry') showStep('mode')
  }

  const gamepadNav = installMenuGamepad({
    container: () => screens[currentStep] ?? null,
    onBack: gamepadBack,
  })

  return new Promise<MenuFlowResult>((resolve) => {
    function teardown(): void {
      window.clearInterval(clockInterval)
      window.removeEventListener('keydown', onKey)
      gamepadNav.dispose()
      root!.classList.remove('show')
      document.body.classList.remove('menu-active')
    }
    function finish(href: string): void {
      teardown()
      resolve({ href })
    }
    function commitSpRace(): void {
      const url = new URL(window.location.href)
      url.search = ''
      url.searchParams.set('race', '1')
      url.searchParams.set('track', picks.trackId)
      url.searchParams.set('bike', picks.bikeId)
      finish(url.toString())
    }
    commitSpRaceRef = commitSpRace

    function buildTitle(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen bc-title'
      const headline = opts.reason === 'exit-from-race' ? 'BACK TO THE BOOTH' : 'TONIGHT’S CARD'
      const recap = readLastRaceRecap()
      // Stash the most recently-watched track/bike back into the picks
      // so the next race defaults to whatever the player just exited.
      if (recap) {
        if (recap.trackId) picks.trackId = recap.trackId
        if (recap.bikeId && recap.bikeId in { cruiser: 1, racer: 1, stunt: 1 }) {
          picks.bikeId = recap.bikeId as BikeVariantId
        }
      }
      const recapHtml = recap ? renderRecapHtml(recap) : ''
      el.innerHTML = `
        <span class="word">HOVER</span>
        <span class="word alt">BIKE</span>
        <div class="tagline">${escapeHtml(headline)}</div>
        ${recapHtml}
        <div class="cta">
          <button class="bc-btn primary" id="title-start" type="button">PRESS START</button>
          <div class="cta-blink">[ ENTER / CLICK TO BEGIN ]</div>
        </div>
      `
      el.querySelector<HTMLButtonElement>('#title-start')?.addEventListener('click', () =>
        showStep('mode'),
      )
      return el
    }

    function buildMode(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen'
      el.innerHTML = `
        <div class="bc-section-head">
          <div class="num">01</div>
          <div>
            <div class="title">PICK YOUR FORMAT</div>
            <div class="sub">SINGLE-PLAYER &middot; UP TO 8 ONLINE</div>
          </div>
          <div class="meta">
            <div class="sub">CHANNEL</div>
            <div style="font-family: var(--bc-font-display); font-size: 28px;">HBN 1</div>
          </div>
        </div>
        <div class="bc-cards cols-2">
          <button class="bc-mode-card" data-mode="sp" type="button">
            <span class="badge">SOLO</span>
            <div class="hd">SINGLE<br />PLAYER</div>
            <div class="desc">Quick race against four AI riders. Countdown, four laps, personal-best ledger, replay download afterwards.</div>
            <div class="stripe"></div>
          </button>
          <button class="bc-mode-card" data-mode="mp" type="button">
            <span class="badge">ONLINE</span>
            <div class="hd">MULTI<br />PLAYER</div>
            <div class="desc">Up to eight riders per lobby. Each player picks a bike and votes a track; the room rolls the dice when everyone’s ready.</div>
            <div class="stripe"></div>
          </button>
        </div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link" id="mode-back" type="button">&larr; BACK</button></div>
        </div>
      `
      el.querySelectorAll<HTMLButtonElement>('.bc-mode-card').forEach((card) => {
        card.addEventListener('click', () => {
          const mode = card.dataset.mode as 'sp' | 'mp'
          currentMode = mode
          if (mode === 'sp') showStep('sp-track')
          else showStep('mp-entry')
        })
      })
      el.querySelector('#mode-back')?.addEventListener('click', () => showStep('title'))
      return el
    }

    function buildSpTrack(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen'
      el.innerHTML = `
        <div class="bc-section-head">
          <div class="num">02</div>
          <div>
            <div class="title">SELECT TRACK</div>
            <div class="sub">TONIGHT’S COURSES &middot; ${tracks.length} ON THE CARD</div>
          </div>
        </div>
        <div class="bc-cards cols-3" id="sp-track-cards"></div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link" id="sp-track-back" type="button">&larr; MODE</button></div>
        </div>
      `
      const host = el.querySelector<HTMLElement>('#sp-track-cards')!
      renderTrackCards(host)
      el.querySelector('#sp-track-back')?.addEventListener('click', () => showStep('mode'))
      return el
    }

    function buildSpBike(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen'
      el.innerHTML = `
        <div class="bc-section-head">
          <div class="num">03</div>
          <div>
            <div class="title">SELECT BIKE</div>
            <div class="sub">THREE LOADOUTS &middot; PICK YOUR PROFILE</div>
          </div>
          <div class="meta">
            <div class="sub">RACING AT</div>
            <div id="bike-track-readout" style="font-family: var(--bc-font-display); font-size: 24px;"></div>
          </div>
        </div>
        <div class="bc-cards cols-3" id="sp-bike-cards"></div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link" id="sp-bike-back" type="button">&larr; TRACK</button></div>
        </div>
      `
      const host = el.querySelector<HTMLElement>('#sp-bike-cards')!
      renderBikeCards(host, true)
      el.querySelector('#sp-bike-back')?.addEventListener('click', () => showStep('sp-track'))
      return el
    }

    function buildMpEntry(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen'
      el.innerHTML = `
        <div class="bc-section-head">
          <div class="num">02</div>
          <div>
            <div class="title">ENTER A ROOM</div>
            <div class="sub">CREATE A NEW LOBBY OR JOIN ONE BY CODE</div>
          </div>
        </div>
        <div class="bc-cards cols-2" style="margin-bottom: 22px;">
          <button class="bc-mode-card" data-action="create" type="button">
            <span class="badge">HOST</span>
            <div class="hd">CREATE<br />LOBBY</div>
            <div class="desc">Spin up a new room code. Share the URL with up to seven friends.</div>
            <div class="stripe"></div>
          </button>
          <div class="bc-mode-card" data-action="join">
            <span class="badge" style="background: var(--bc-yellow); color: var(--bc-navy);">JOIN</span>
            <div class="hd">JOIN<br />LOBBY</div>
            <div class="bc-form" style="margin-top: 10px;">
              <label for="mp-room-code">ROOM CODE</label>
              <input id="mp-room-code" type="text" maxlength="64" placeholder="e.g. RACE-1234" autocapitalize="characters" autocomplete="off" spellcheck="false" />
              <div class="hint">Codes are case-insensitive. Paste a full URL too — we’ll find the code.</div>
            </div>
            <div style="margin-top: 14px; display: flex; gap: 10px;">
              <button class="bc-btn primary" id="mp-room-join" type="button">JOIN &rarr;</button>
            </div>
          </div>
        </div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link" id="mp-back" type="button">&larr; MODE</button></div>
        </div>
      `
      el.querySelector<HTMLButtonElement>('[data-action="create"]')?.addEventListener(
        'click',
        () => {
          const roomId = generateRoomCode()
          finish(buildRoomUrl(roomId))
        },
      )
      const codeInput = el.querySelector<HTMLInputElement>('#mp-room-code')
      const joinBtn = el.querySelector<HTMLButtonElement>('#mp-room-join')
      function attemptJoin(): void {
        const raw = codeInput?.value ?? ''
        const cleaned = extractRoomCode(raw)
        if (!cleaned) {
          codeInput?.focus()
          return
        }
        finish(buildRoomUrl(cleaned))
      }
      joinBtn?.addEventListener('click', attemptJoin)
      codeInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          attemptJoin()
          e.preventDefault()
        }
      })
      el.querySelector('#mp-back')?.addEventListener('click', () => showStep('mode'))
      return el
    }

    screens.title = buildTitle()
    screens.mode = buildMode()
    screens['sp-track'] = buildSpTrack()
    screens['sp-bike'] = buildSpBike()
    screens['mp-entry'] = buildMpEntry()
    for (const s of Object.values(screens)) stage!.appendChild(s!)

    showStep(opts.reason === 'exit-from-race' ? 'mode' : 'title')

    function onKey(e: KeyboardEvent): void {
      // Don't hijack typing into the room-code input.
      const target = e.target as HTMLElement | null
      if (target && target.tagName === 'INPUT') return
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        if (currentStep === 'title') {
          showStep('mode')
          e.preventDefault()
        } else if (currentStep === 'sp-track') {
          showStep('sp-bike')
          e.preventDefault()
        } else if (currentStep === 'sp-bike') {
          commitSpRace()
          e.preventDefault()
        }
      } else if (e.code === 'Escape') {
        if (currentStep === 'mode') showStep('title')
        else if (currentStep === 'sp-track') showStep('mode')
        else if (currentStep === 'sp-bike') showStep('sp-track')
        else if (currentStep === 'mp-entry') showStep('mode')
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
  })
}

/** Compact six-character room code. Avoids ambiguous glyphs (O/0, I/1)
 *  so codes shared verbally don't trip over font-rendering. */
export function generateRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

/** Pull a code out of a free-form text input. Accepts a bare code, a
 *  full URL with `?room=…`, or surrounding whitespace. Returns null
 *  when the input has nothing usable. */
export function extractRoomCode(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    const room = url.searchParams.get('room')
    if (room) return room.trim().toUpperCase()
  } catch {
    // not a URL — fall through to bare-code handling.
  }
  const cleaned = trimmed.replace(/[^A-Za-z0-9-]/g, '').toUpperCase()
  return cleaned.length >= 3 ? cleaned : null
}

function buildRoomUrl(roomId: string): string {
  const url = new URL(window.location.href)
  url.search = ''
  url.searchParams.set('room', roomId)
  return url.toString()
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Last-race recap stashed by main.ts when the player hits EXIT TO
 *  MENU on the finish screen. Lives in sessionStorage so it survives
 *  the URL navigation but doesn't outlive the tab. */
type LastRaceRecap = {
  trackId: string
  trackName: string
  bikeId: string
  bikeName: string
  position: number | null
  totalRacers: number
  time: number
  bestLap: number | null
  wonRace: boolean
  finishedAt: number
}

function readLastRaceRecap(): LastRaceRecap | null {
  try {
    const raw = sessionStorage.getItem('hover-last-race')
    if (!raw) return null
    // Clear after read — the recap is a one-shot post-race banner, not
    // a persistent leaderboard. The full best-lap ledger lives in
    // localStorage via the save-state module.
    sessionStorage.removeItem('hover-last-race')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof parsed.trackId === 'string') {
      return parsed as LastRaceRecap
    }
  } catch {
    /* corrupt blob — ignore */
  }
  return null
}

function formatRecapTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  if (m > 0) return `${m}:${s.toFixed(2).padStart(5, '0')}`
  return `${s.toFixed(2)}s`
}

function renderRecapHtml(r: LastRaceRecap): string {
  const place =
    r.position === null
      ? '—'
      : r.position === 1
        ? '1ST'
        : r.position === 2
          ? '2ND'
          : r.position === 3
            ? '3RD'
            : `${r.position}TH`
  const placeColor = r.wonRace ? 'var(--bc-yellow)' : 'var(--bc-cyan)'
  const best = r.bestLap != null ? formatRecapTime(r.bestLap) : '—'
  return `
    <div class="bc-recap">
      <div class="bc-recap-tag">LAST RACE</div>
      <div class="bc-recap-grid">
        <div>
          <div class="bc-recap-lbl">FINISH</div>
          <div class="bc-recap-val" style="color: ${placeColor};">${escapeHtml(place)}<span class="of">/${r.totalRacers}</span></div>
        </div>
        <div>
          <div class="bc-recap-lbl">TIME</div>
          <div class="bc-recap-val">${escapeHtml(formatRecapTime(r.time))}</div>
        </div>
        <div>
          <div class="bc-recap-lbl">BEST LAP</div>
          <div class="bc-recap-val" style="color: var(--bc-yellow);">${escapeHtml(best)}</div>
        </div>
        <div>
          <div class="bc-recap-lbl">VENUE</div>
          <div class="bc-recap-val small">${escapeHtml(r.trackName.toUpperCase())} &middot; ${escapeHtml(r.bikeName.toUpperCase())}</div>
        </div>
      </div>
    </div>
  `
}

// Suppress "imported but unused" if TrackEntry is only used as a value
// reference inside template strings (TS keeps it because the export
// landed in catalog.ts and downstream code may want the type).
export type { TrackEntry }
