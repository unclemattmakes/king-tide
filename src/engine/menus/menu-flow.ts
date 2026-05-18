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
import { installSettingsOverlay } from './settings-overlay'
import {
  buildDevCupTracks,
  type CupEntry,
  DEV_CUP,
  type DevTrackEntry,
  isDevBuild,
  V1_CUPS,
  V1_TRACKS,
  type V1TrackEntry,
} from './tracks-catalog'

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

type Step =
  | 'title'
  | 'mode'
  | 'sp-track'
  | 'sp-cup'
  | 'sp-cup-tracks'
  | 'sp-bike'
  | 'pre-race'
  | 'mp-entry'
  | 'tutorial-intro'
  | 'leaderboard'

const STEPS_SP_RACE: { id: Step; label: string }[] = [
  { id: 'title', label: 'START' },
  { id: 'mode', label: 'MODE' },
  { id: 'sp-track', label: 'TRACK' },
  { id: 'sp-bike', label: 'BIKE' },
]

const STEPS_SP_CUP: { id: Step; label: string }[] = [
  { id: 'title', label: 'START' },
  { id: 'mode', label: 'MODE' },
  { id: 'sp-cup', label: 'CUP' },
  { id: 'sp-cup-tracks', label: 'TRACK' },
  { id: 'sp-bike', label: 'BIKE' },
]

const STEPS_TUTORIAL: { id: Step; label: string }[] = [
  { id: 'title', label: 'START' },
  { id: 'mode', label: 'MODE' },
  { id: 'tutorial-intro', label: 'TUTORIAL' },
]

const STEPS_TT: { id: Step; label: string }[] = [
  { id: 'title', label: 'START' },
  { id: 'mode', label: 'MODE' },
  { id: 'leaderboard', label: 'TIME TRIAL' },
]

const STEPS_MP: { id: Step; label: string }[] = [
  { id: 'title', label: 'START' },
  { id: 'mode', label: 'MODE' },
  { id: 'mp-entry', label: 'ROOM' },
]

/** Mode-tile descriptors for the mode-select screen. Most modes are
 *  disabled in Step 0 with a gate label hinting at when they ship; the
 *  enabled set today is Race + Cup (the latter is the routing path to
 *  the Dev Cup) + Multiplayer (works end-to-end via the existing room
 *  protocol). */
type ModeId = 'race' | 'time-trial' | 'cup' | 'multiplayer' | 'tutorial'
type ModeTile = {
  id: ModeId
  badge: string
  headline: string
  desc: string
  enabled: boolean
  gate?: string
}
/** Two Coming-Soon bike slots padding the picker out to the v1 target
 *  of five. Names are intentionally vague — the actual archetypes will
 *  be designed alongside their tuning. The shape of the picker is
 *  what's locked here, not the identity of the two extra bikes. */
type ComingSoonBike = { id: string; name: string; tagline: string; accent: string; gate: string }
const BIKE_COMING_SOON_SLOTS: ComingSoonBike[] = [
  {
    id: 'tbd-heavy',
    name: 'Heavyweight TBD',
    tagline: 'Punishing wave-pump timing + biggest launch.',
    accent: '#5a78a8',
    gate: 'Variant #4 lands alongside the wave-pump tuning pass.',
  },
  {
    id: 'tbd-light',
    name: 'Lightweight TBD',
    tagline: 'Forgiving wave-pump + further air on small swells.',
    accent: '#d2b6ff',
    gate: 'Variant #5 lands alongside the wave-pump tuning pass.',
  },
]

const MODE_TILES: ModeTile[] = [
  {
    id: 'race',
    badge: 'SOLO',
    headline: 'RACE',
    desc: 'Pick a track, pick a bike, run a quick race against AI. Twelve ship tracks across four cups light up over the next three sprints.',
    enabled: true,
  },
  {
    id: 'time-trial',
    badge: 'CLOCK',
    headline: 'TIME<br />TRIAL',
    desc: 'Solo against the clock with a downloadable best-lap ghost. Ships with the leaderboard backend in M16.',
    enabled: false,
    gate: 'Ships in M16 alongside the leaderboard backend',
  },
  {
    id: 'cup',
    badge: 'CIRCUIT',
    headline: 'CUP',
    desc: 'Four-cup championship: Reef → Open Sea → Continental → Drowned. Each cup unlocks when its tracks ship. Dev Cup holds today’s playtest maps.',
    enabled: true,
  },
  {
    id: 'multiplayer',
    badge: 'ONLINE',
    headline: 'MULTI<br />PLAYER',
    desc: 'Up to eight riders per lobby. Create a room or join by code; everyone votes a track when the lobby fills.',
    enabled: true,
  },
  {
    id: 'tutorial',
    badge: 'LEARN',
    headline: 'TUTORIAL',
    desc: 'Six scripted beats on the Sandbar — throttle, swell pump, drift, pickup, ramp, anti-grav. Skippable for returning players.',
    enabled: false,
    gate: 'Ships with the Sandbar track + tutorial framework — sprint 1 (M13)',
  },
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

  let currentMode: ModeId | null = null
  let currentStep: Step = 'title'
  /** Cup-mode pick. Holds the selected cup so the cup-tracks step
   *  knows which list to render. The dev cup always wins the
   *  enabled-at-step-0 race against the four ship cups. */
  let pickedCup: CupEntry | null = null
  const screens: Partial<Record<Step, HTMLElement>> = {}
  // `commitSpRace` lives inside the Promise executor (it needs `resolve`),
  // but `renderBikeCards` runs in the outer scope — bridge them via a ref.
  let commitSpRaceRef: (() => void) | null = null
  // Build the Dev Cup list once — it only changes when the manifest does,
  // and that's a page-load gate, not a render-time concern.
  const devCupTracks = buildDevCupTracks(opts.manifestTracks)
  const dev = isDevBuild()

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
    const steps = stepsForMode()
    crumbsEl.innerHTML = ''
    steps.forEach((s, i) => {
      if (i > 0) {
        const sep = document.createElement('span')
        sep.className = 'bc-crumb-sep'
        sep.textContent = '·'
        crumbsEl.appendChild(sep)
      }
      const c = document.createElement('span')
      c.className = `bc-crumb${s.id === currentStep ? ' is-current' : ''}`
      c.textContent = s.label
      crumbsEl.appendChild(c)
    })
  }

  function setChyron(tag: string, text: string): void {
    if (chyTag) chyTag.textContent = tag
    if (chyText) chyText.textContent = text
  }

  function stepsForMode(): { id: Step; label: string }[] {
    switch (currentMode) {
      case 'multiplayer':
        return STEPS_MP
      case 'cup':
        return STEPS_SP_CUP
      case 'tutorial':
        return STEPS_TUTORIAL
      case 'time-trial':
        return STEPS_TT
      default:
        return STEPS_SP_RACE
    }
  }

  function updateChyron(step: Step): void {
    switch (step) {
      case 'title':
        setChyron('PRE-SHOW', 'Press start when you’re ready to roll.')
        break
      case 'mode':
        setChyron('FORMAT', 'Pick a format. Disabled tiles light up as their systems land.')
        break
      case 'sp-track':
        setChyron(
          'COURSE',
          'All twelve ship tracks are in production — tiles light up sprint by sprint.',
        )
        break
      case 'sp-cup':
        setChyron(
          'CIRCUIT',
          'Real cups gate on their tracks shipping. Dev Cup is the playtest path.',
        )
        break
      case 'sp-cup-tracks':
        setChyron(
          'TRACK',
          pickedCup?.id === 'dev'
            ? 'Playtest tracks. Procedural built-ins + every GLB the manifest knows about.'
            : 'Cup line-up — tap a card to lock in your venue.',
        )
        break
      case 'sp-bike':
        setChyron('LOADOUT', 'Bars compare top speed, accel, agility, weight, wave-follow.')
        break
      case 'pre-race':
        setChyron('OPTIONS', 'Override laps + AI count, or hit GO for the defaults.')
        break
      case 'mp-entry':
        setChyron('LOBBY', 'Host a new room or punch in a friend’s code.')
        break
      case 'tutorial-intro':
        setChyron('TUTORIAL', 'Tutorial framework ships in sprint 1.')
        break
      case 'leaderboard':
        setChyron('LEADERBOARD', 'Time Trial + leaderboard backend ship in M16.')
        break
    }
  }

  /** Race-mode track-select host. Renders all 12 ship tracks; tiles
   *  for `status === 'ship'` are live, the rest are gated with the
   *  per-track `gateLabel`. The list never contains test tracks — those
   *  live in the Dev Cup so the real race lineup stays uncluttered. */
  function renderV1TrackCards(host: HTMLElement): void {
    host.innerHTML = ''
    for (const t of V1_TRACKS) {
      host.appendChild(buildV1TrackCard(t))
    }
  }

  function buildV1TrackCard(t: V1TrackEntry): HTMLElement {
    const card = document.createElement('button')
    card.type = 'button'
    const disabled = t.status !== 'ship'
    card.disabled = disabled
    card.className = `bc-card${disabled ? ' bc-disabled' : ''}${
      !disabled && t.id === picks.trackId ? ' selected' : ''
    }`
    card.style.setProperty('--accent', t.accent)
    if (disabled) card.dataset.gate = t.gateLabel
    const best = disabled ? null : bestLapFor(t.id, picks.bikeId)
    card.innerHTML = `
      <div class="label">${escapeHtml(cupNameFor(t.cup)).toUpperCase()}</div>
      <div class="name">${escapeHtml(t.name).toUpperCase()}</div>
      <div class="tag">${escapeHtml(t.location)}</div>
      <div class="tag" style="opacity: 0.75; margin-top: -4px;">${escapeHtml(t.setPiece)}</div>
      <div class="record">${
        disabled
          ? `LAP TARGET &middot; ${t.lapTarget}s &middot; ${t.laps} LAPS`
          : best
            ? `BEST LAP &middot; ${best}`
            : 'NO RECORD'
      }</div>
      ${disabled ? `<div class="bc-gate">${escapeHtml(t.gateLabel)}</div>` : ''}
    `
    if (!disabled) {
      card.addEventListener('click', () => {
        picks.trackId = t.id
        showStep('sp-bike')
      })
    }
    return card
  }

  function cupNameFor(id: V1TrackEntry['cup']): string {
    return V1_CUPS.find((c) => c.id === id)?.name ?? id
  }

  /** Cup-select host. Renders the four ship cups plus the Dev Cup
   *  (dev builds only). Real cups stay disabled in Step 0; the Dev
   *  Cup is the playtest entrypoint. */
  function renderCupCards(host: HTMLElement): void {
    host.innerHTML = ''
    for (const c of V1_CUPS) {
      host.appendChild(buildCupCard(c))
    }
    if (dev) {
      host.appendChild(buildCupCard(DEV_CUP))
    }
  }

  function buildCupCard(c: CupEntry): HTMLElement {
    const card = document.createElement('button')
    card.type = 'button'
    const disabled = c.status !== 'ship'
    card.disabled = disabled
    card.className = `bc-card${disabled ? ' bc-disabled' : ''}`
    card.style.setProperty('--accent', c.accent)
    if (disabled) card.dataset.gate = c.gateLabel
    const trackCount =
      c.id === 'dev' ? devCupTracks.length : V1_TRACKS.filter((t) => t.cup === c.id).length
    card.innerHTML = `
      ${c.id === 'dev' ? '<span class="bc-dev-badge">DEV</span>' : ''}
      <div class="label">${c.id === 'dev' ? 'DEV ONLY' : 'CUP'}</div>
      <div class="name">${escapeHtml(c.name).toUpperCase()}</div>
      <div class="tag">${escapeHtml(c.tagline)}</div>
      <div class="record">${trackCount} TRACK${trackCount === 1 ? '' : 'S'}</div>
      ${disabled ? `<div class="bc-gate">${escapeHtml(c.gateLabel)}</div>` : ''}
    `
    if (!disabled) {
      card.addEventListener('click', () => {
        pickedCup = c
        showStep('sp-cup-tracks')
      })
    }
    return card
  }

  /** Render the chosen cup's tracks. Dev Cup pulls from the manifest
   *  loader pipeline; real cups list their disabled v1 tiles. */
  function renderCupTrackCards(host: HTMLElement): void {
    host.innerHTML = ''
    if (!pickedCup) return
    if (pickedCup.id === 'dev') {
      for (const t of devCupTracks) {
        host.appendChild(buildDevTrackCard(t))
      }
      if (devCupTracks.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'bc-card bc-disabled'
        empty.innerHTML =
          '<div class="label">EMPTY</div>' +
          '<div class="name">NO PLAYTEST TRACKS</div>' +
          '<div class="tag">Run <code>pnpm gen:all</code> to build the manifest.</div>'
        host.appendChild(empty)
      }
      return
    }
    const cupId = pickedCup.id
    for (const t of V1_TRACKS.filter((v) => v.cup === cupId)) {
      host.appendChild(buildV1TrackCard(t))
    }
  }

  function buildDevTrackCard(t: DevTrackEntry): HTMLElement {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = `bc-card${t.id === picks.trackId ? ' selected' : ''}`
    card.style.setProperty('--accent', t.accent)
    const best = bestLapFor(t.id, picks.bikeId)
    const sourceChip = t.source === 'procedural' ? 'PROCEDURAL' : 'GLB'
    card.innerHTML = `
      <span class="bc-dev-badge">${sourceChip}</span>
      <div class="label">TEST TRACK</div>
      <div class="name">${escapeHtml(t.name).toUpperCase()}</div>
      <div class="tag">${escapeHtml(t.tagline)}</div>
      <div class="record">${best ? `BEST LAP &middot; ${best}` : 'NO RECORD'}</div>
    `
    card.addEventListener('click', () => {
      picks.trackId = t.id
      showStep('sp-bike')
    })
    return card
  }

  /** Five-slot bike-select grid per the v1 work-breakdown — three
   *  active variants today (cruiser / racer / stunt) plus two "Coming
   *  soon" placeholders. The placeholders inherit the disabled-state
   *  convention so the bike picker reads as part of the same cathedral
   *  as every other screen. */
  function renderBikeCards(host: HTMLElement, showTrackBest: boolean): void {
    host.innerHTML = ''
    for (const b of bikeCards) {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = `bc-card${b.id === picks.bikeId ? ' selected' : ''}`
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
    for (const slot of BIKE_COMING_SOON_SLOTS) {
      host.appendChild(buildComingSoonBikeCard(slot))
    }
  }

  function buildComingSoonBikeCard(slot: ComingSoonBike): HTMLElement {
    const card = document.createElement('button')
    card.type = 'button'
    card.disabled = true
    card.className = 'bc-card bc-disabled'
    card.style.setProperty('--accent', slot.accent)
    card.dataset.gate = slot.gate
    card.innerHTML = `
      <span class="bc-soon">COMING SOON</span>
      <div class="label">BIKE</div>
      <div class="name">${escapeHtml(slot.name)}</div>
      <div class="tag">${escapeHtml(slot.tagline)}</div>
      <div class="bc-gate">${escapeHtml(slot.gate)}</div>
    `
    return card
  }

  function refreshStep(step: Step): void {
    if (step === 'sp-bike') {
      const host = screens['sp-bike']?.querySelector<HTMLElement>('#sp-bike-cards')
      const readout = screens['sp-bike']?.querySelector<HTMLElement>('#bike-track-readout')
      if (host) renderBikeCards(host, true)
      if (readout) {
        const display = displayTrackName(picks.trackId)
        readout.textContent = display.toUpperCase()
      }
    } else if (step === 'sp-track') {
      const host = screens['sp-track']?.querySelector<HTMLElement>('#sp-track-cards')
      if (host) renderV1TrackCards(host)
    } else if (step === 'sp-cup') {
      const host = screens['sp-cup']?.querySelector<HTMLElement>('#sp-cup-cards')
      if (host) renderCupCards(host)
    } else if (step === 'sp-cup-tracks') {
      const host = screens['sp-cup-tracks']?.querySelector<HTMLElement>('#sp-cup-track-cards')
      const cupReadout = screens['sp-cup-tracks']?.querySelector<HTMLElement>('#sp-cup-readout')
      if (host) renderCupTrackCards(host)
      if (cupReadout) cupReadout.textContent = (pickedCup?.name ?? '').toUpperCase()
    }
  }

  function displayTrackName(id: string): string {
    const v1 = V1_TRACKS.find((t) => t.id === id)
    if (v1) return v1.name
    const dev = devCupTracks.find((t) => t.id === id)
    if (dev) return dev.name
    const generic = tracks.find((t) => t.id === id)
    return generic?.name ?? id
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
    else if (currentStep === 'sp-cup') showStep('mode')
    else if (currentStep === 'sp-cup-tracks') showStep('sp-cup')
    else if (currentStep === 'sp-bike')
      showStep(currentMode === 'cup' ? 'sp-cup-tracks' : 'sp-track')
    else if (currentStep === 'pre-race') showStep('sp-bike')
    else if (currentStep === 'mp-entry') showStep('mode')
    else if (currentStep === 'tutorial-intro') showStep('mode')
    else if (currentStep === 'leaderboard') showStep('mode')
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
      root?.classList.remove('show')
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
      const tilesHtml = MODE_TILES.map((m) => {
        const disabled = !m.enabled
        const cls = `bc-mode-card${disabled ? ' bc-disabled' : ''}`
        const gateBlock =
          disabled && m.gate ? `<div class="bc-gate">${escapeHtml(m.gate)}</div>` : ''
        // `data-mode` lets the global click handler route by id, and
        // `disabled` keeps gamepad focus from landing on inert tiles
        // (menu-gamepad filters those out).
        return `
          <button class="${cls}" data-mode="${m.id}" type="button"${disabled ? ' disabled' : ''}${
            disabled ? ` data-gate="${escapeHtml(m.gate ?? '')}"` : ''
          }>
            <span class="badge">${escapeHtml(m.badge)}</span>
            <div class="hd">${m.headline}</div>
            <div class="desc">${escapeHtml(m.desc)}</div>
            ${gateBlock}
            <div class="stripe"></div>
          </button>`
      }).join('')
      el.innerHTML = `
        <div class="bc-section-head">
          <div class="num">01</div>
          <div>
            <div class="title">PICK YOUR FORMAT</div>
            <div class="sub">FIVE MODES &middot; DISABLED TILES LIGHT UP AS SYSTEMS LAND</div>
          </div>
          <div class="meta">
            <div class="sub">CHANNEL</div>
            <div style="font-family: var(--bc-font-display); font-size: 28px;">HBN 1</div>
          </div>
        </div>
        <div class="bc-cards cols-auto" id="mode-cards">${tilesHtml}</div>
        <div class="bc-actions">
          <div class="left">
            <button class="bc-link" id="mode-back" type="button">&larr; BACK</button>
          </div>
          <div class="right">
            <button class="bc-link" id="mode-settings" type="button">SETTINGS &middot;&middot;&middot;</button>
          </div>
        </div>
      `
      el.querySelectorAll<HTMLButtonElement>('.bc-mode-card').forEach((card) => {
        if (card.disabled) return
        card.addEventListener('click', () => {
          const mode = card.dataset.mode as ModeId
          currentMode = mode
          switch (mode) {
            case 'race':
              showStep('sp-track')
              break
            case 'cup':
              showStep('sp-cup')
              break
            case 'multiplayer':
              showStep('mp-entry')
              break
            case 'tutorial':
              showStep('tutorial-intro')
              break
            case 'time-trial':
              showStep('leaderboard')
              break
          }
        })
      })
      el.querySelector('#mode-back')?.addEventListener('click', () => showStep('title'))
      el.querySelector('#mode-settings')?.addEventListener('click', () => {
        installSettingsOverlay().open()
      })
      return el
    }

    function buildSpTrack(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen'
      const devHint = dev
        ? 'Cup &rarr; Dev Cup holds today’s playtest tracks.'
        : 'Ship tracks roll out sprint by sprint.'
      el.innerHTML = `
        <div class="bc-section-head">
          <div class="num">02</div>
          <div>
            <div class="title">SELECT TRACK</div>
            <div class="sub">TWELVE SHIP TRACKS &middot; FOUR CUPS &middot; ${devHint.toUpperCase()}</div>
          </div>
        </div>
        <div class="bc-cards cols-3" id="sp-track-cards"></div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link" id="sp-track-back" type="button">&larr; MODE</button></div>
        </div>
      `
      const host = el.querySelector<HTMLElement>('#sp-track-cards')
      if (host) renderV1TrackCards(host)
      el.querySelector('#sp-track-back')?.addEventListener('click', () => showStep('mode'))
      return el
    }

    /** Cup-select screen — 4 ship cups + Dev Cup (dev builds only). */
    function buildSpCup(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen'
      el.innerHTML = `
        <div class="bc-section-head">
          <div class="num">02</div>
          <div>
            <div class="title">SELECT CUP</div>
            <div class="sub">FOUR-CUP CHAMPIONSHIP &middot; REAL CUPS UNLOCK WHEN THEIR TRACKS SHIP</div>
          </div>
          ${
            dev
              ? `<div class="meta">
                <div class="sub">DEV BUILD</div>
                <div style="font-family: var(--bc-font-display); font-size: 18px; color: #a78bff;">DEV CUP ENABLED</div>
              </div>`
              : ''
          }
        </div>
        <div class="bc-cards cols-3" id="sp-cup-cards"></div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link" id="sp-cup-back" type="button">&larr; MODE</button></div>
        </div>
      `
      const host = el.querySelector<HTMLElement>('#sp-cup-cards')
      if (host) renderCupCards(host)
      el.querySelector('#sp-cup-back')?.addEventListener('click', () => showStep('mode'))
      return el
    }

    /** Track list for the chosen cup. Same shell as race-mode's track
     *  select; data differs per `pickedCup`. */
    function buildSpCupTracks(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen'
      el.innerHTML = `
        <div class="bc-section-head">
          <div class="num">03</div>
          <div>
            <div class="title">CUP LINE-UP</div>
            <div class="sub">PICK A VENUE FROM THE CUP YOU SELECTED</div>
          </div>
          <div class="meta">
            <div class="sub">CUP</div>
            <div id="sp-cup-readout" style="font-family: var(--bc-font-display); font-size: 22px;"></div>
          </div>
        </div>
        <div class="bc-cards cols-3" id="sp-cup-track-cards"></div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link" id="sp-cup-tracks-back" type="button">&larr; CUP</button></div>
        </div>
      `
      const host = el.querySelector<HTMLElement>('#sp-cup-track-cards')
      if (host) renderCupTrackCards(host)
      el.querySelector('#sp-cup-tracks-back')?.addEventListener('click', () => showStep('sp-cup'))
      return el
    }

    /** Tutorial-intro stub. Disabled today; serves as the gate
     *  surface so the menu shape is complete from day one. */
    function buildTutorialIntro(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen'
      el.innerHTML = `
        <div class="bc-section-head">
          <div class="num">02</div>
          <div>
            <div class="title">TUTORIAL</div>
            <div class="sub">SANDBAR &middot; SCRIPTED ONE-LAP TRAINING</div>
          </div>
        </div>
        <div class="bc-card bc-disabled" data-gate="Ships with the Sandbar track in sprint 1 (M13)" style="--accent:#9bdcf2;">
          <div class="label">TRAINING COVE</div>
          <div class="name">SANDBAR</div>
          <div class="tag">Six scripted beats — throttle, swell pump, drift around a buoy, pickup, ramp, anti-grav arch. Auto-skip toggle for returning players.</div>
          <div class="record">~60s &middot; 1 LAP &middot; 80% WATER &middot; INTRO DIFFICULTY</div>
          <div class="bc-gate">Ships with the Sandbar track + tutorial framework — sprint 1 (M13)</div>
        </div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link" id="tut-back" type="button">&larr; MODE</button></div>
        </div>
      `
      el.querySelector('#tut-back')?.addEventListener('click', () => showStep('mode'))
      return el
    }

    /** Leaderboard / Time Trial stub. Empty state until M16. */
    function buildLeaderboard(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen'
      el.innerHTML = `
        <div class="bc-section-head">
          <div class="num">02</div>
          <div>
            <div class="title">TIME TRIAL</div>
            <div class="sub">SOLO VS. CLOCK &middot; GHOST PLAYBACK &middot; ONLINE LEADERBOARD</div>
          </div>
        </div>
        <div class="bc-card bc-disabled" data-gate="Ships in M16 with the leaderboard backend">
          <div class="label">LEADERBOARDS</div>
          <div class="name">EMPTY</div>
          <div class="tag">Once Time Trial ships, this view lists the top times per track with a personal-best banner and a downloadable ghost.</div>
          <div class="bc-gate">Ships in M16 alongside the leaderboard backend</div>
        </div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link" id="lb-back" type="button">&larr; MODE</button></div>
        </div>
      `
      el.querySelector('#lb-back')?.addEventListener('click', () => showStep('mode'))
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
            <div class="sub">THREE LOADOUTS LIVE &middot; TWO MORE COMING WITH WAVE-PUMP TUNING</div>
          </div>
          <div class="meta">
            <div class="sub">RACING AT</div>
            <div id="bike-track-readout" style="font-family: var(--bc-font-display); font-size: 24px;"></div>
          </div>
        </div>
        <div class="bc-cards cols-3" id="sp-bike-cards"></div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link" id="sp-bike-back" type="button">&larr; BACK</button></div>
          <div class="right"><button class="bc-link" id="sp-bike-options" type="button" disabled data-gate="Pre-race overrides ship with the AI / cup wiring (M16)">RACE OPTIONS &middot;&middot;&middot;</button></div>
        </div>
      `
      const host = el.querySelector<HTMLElement>('#sp-bike-cards')
      if (host) renderBikeCards(host, true)
      el.querySelector('#sp-bike-back')?.addEventListener('click', () =>
        showStep(currentMode === 'cup' ? 'sp-cup-tracks' : 'sp-track'),
      )
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
    screens['sp-cup'] = buildSpCup()
    screens['sp-cup-tracks'] = buildSpCupTracks()
    screens['sp-bike'] = buildSpBike()
    screens['mp-entry'] = buildMpEntry()
    screens['tutorial-intro'] = buildTutorialIntro()
    screens.leaderboard = buildLeaderboard()
    for (const s of Object.values(screens)) stage?.appendChild(s!)

    showStep(opts.reason === 'exit-from-race' ? 'mode' : 'title')

    function onKey(e: KeyboardEvent): void {
      // Don't hijack typing into the room-code input.
      const target = e.target as HTMLElement | null
      if (target && target.tagName === 'INPUT') return
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        if (currentStep === 'title') {
          showStep('mode')
          e.preventDefault()
        } else if (currentStep === 'sp-track' || currentStep === 'sp-cup-tracks') {
          showStep('sp-bike')
          e.preventDefault()
        } else if (currentStep === 'sp-bike') {
          commitSpRace()
          e.preventDefault()
        }
      } else if (e.code === 'Escape') {
        gamepadBack()
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
