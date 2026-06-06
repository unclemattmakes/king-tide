import { assetUrl } from '@/engine/asset-url'
import { SOUNDTRACK } from '@/engine/audio/soundtrack.generated'
import { buildCupRoster, startCup } from '@/engine/cup-progress'
import { formatLap } from '@/engine/garage'
import { getEndpoint, isRemoteEnabled } from '@/engine/leaderboard/endpoint'
import {
  clearLeaderboards,
  getEntries,
  getEntryCounts,
  type LeaderboardEntry,
  setCachedEntries,
} from '@/engine/leaderboard/local'
import { fetchBoard } from '@/engine/leaderboard/remote'
import { playerSettings } from '@/engine/player-settings'
import type { TrackManifestEntry } from '@/game/assets/manifest'
import { type BikeVariantId, DEFAULT_BIKE_VARIANT } from '@/game/bikes/variants'
import { installMenuGamepad, isAnyOverlayShown } from '../input/menu-gamepad'
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
  DEV_PLACEHOLDER_CUP,
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
  | 'credits'

const STEPS_SP_RACE: { id: Step; label: string }[] = [
  { id: 'title', label: 'START' },
  { id: 'mode', label: 'MODE' },
  { id: 'sp-track', label: 'TRACK' },
  { id: 'sp-bike', label: 'BIKE' },
]

/** Championship cup flow — the lineup-preview step (sp-cup-tracks) is
 *  skipped, so the breadcrumbs go MODE → CUP → BIKE. */
const STEPS_SP_CUP_CHAMPIONSHIP: { id: Step; label: string }[] = [
  { id: 'title', label: 'START' },
  { id: 'mode', label: 'MODE' },
  { id: 'sp-cup', label: 'CUP' },
  { id: 'sp-bike', label: 'BIKE' },
]

/** Dev Cup (browse-shaped) — user picks a single track on sp-cup-tracks. */
const STEPS_SP_CUP_BROWSE: { id: Step; label: string }[] = [
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
  { id: 'sp-cup-tracks', label: 'TRACK' },
  { id: 'sp-bike', label: 'BIKE' },
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
/** Coming-Soon bike slots — empty now that Phase F of
 *  `docs/v1-asset-pipeline-plan.md` filled the heavy + light archetypes
 *  (Scout + Sparrow). Kept as a typed list so a future "5 → 8" expansion
 *  has the same scaffolding to plug into. */
type ComingSoonBike = { id: string; name: string; tagline: string; accent: string; gate: string }
const BIKE_COMING_SOON_SLOTS: ComingSoonBike[] = []

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
    desc: 'Solo against the clock with a saved best-lap ghost. Set a new PB and your ghost overwrites itself for next time.',
    enabled: true,
  },
  {
    id: 'cup',
    badge: 'CIRCUIT',
    headline: 'CUP',
    desc: 'Four-cup championship: Reef → Harbor → Continental → Drowned. Each cup unlocks when its tracks ship. Dev Cup holds today’s playtest maps.',
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
    desc: 'Seven scripted beats — throttle, cruise, look around, wave pump, drift, anti-grav, finish. Skippable for returning players via Settings → Subtitles.',
    enabled: true,
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
  // Cup-mode commit lives alongside — the bike-select grid forwards to
  // it when `currentMode === 'cup'` so the lineup commit also passes
  // through the same render code.
  let commitSpCupRef: (() => void) | null = null
  // Build the Dev Cup list once — it only changes when the manifest does,
  // and that's a page-load gate, not a render-time concern.
  const devCupTracks = buildDevCupTracks(opts.manifestTracks)
  const dev = isDevBuild()

  function updateClock(): void {
    if (!clockEl) return
    const now = new Date()
    const h = now.getHours().toString().padStart(2, '0')
    const m = now.getMinutes().toString().padStart(2, '0')
    clockEl.textContent = `${h}:${m}`
  }
  updateClock()
  const clockInterval = window.setInterval(updateClock, 30_000)

  // Edge-fade indicator. Touch users have no native cue that the bike
  // / track list scrolls below the fold — the persistent scrollbar
  // helps, but a soft fade at the bottom edge of the stage reads as
  // "more cards here" without crowding the visual. `--bc-fade-top` /
  // `--bc-fade-bot` set on .bc-stage are picked up by its mask-image
  // gradient. Re-runs cheap and on every signal — scroll, screen
  // switch (via showStep below), DOM resize, viewport resize.
  const FADE_PX = 38
  function refreshStageFade(): void {
    if (!stage) return
    const max = stage.scrollHeight - stage.clientHeight
    const top = stage.scrollTop
    // Tolerance — sub-pixel rounding shouldn't read as "more above".
    const hasTop = max > 1 && top > 2
    const hasBot = max > 1 && top < max - 2
    stage.style.setProperty('--bc-fade-top', `${hasTop ? FADE_PX : 0}px`)
    stage.style.setProperty('--bc-fade-bot', `${hasBot ? FADE_PX : 0}px`)
  }
  stage.addEventListener('scroll', refreshStageFade, { passive: true })
  const stageResizeObs =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refreshStageFade) : null
  stageResizeObs?.observe(stage)
  window.addEventListener('resize', refreshStageFade)
  refreshStageFade()

  // Idle-fade for the bottom chyron's input legend (`.keys`) — Apple-
  // sport restraint: the legend reads as helpful for the first beat
  // after you arrive on a screen, then quietly fades when you've
  // settled in. Any pointer / key activity brings it back. The
  // `.bc-chyron.idle .keys { opacity: 0 }` rule does the work; we just
  // toggle the class.
  const chyronEl = document.querySelector<HTMLElement>('.bc-chyron')
  let idleTimer = 0
  function markActive(): void {
    if (!chyronEl) return
    chyronEl.classList.remove('idle')
    if (idleTimer) window.clearTimeout(idleTimer)
    idleTimer = window.setTimeout(() => chyronEl.classList.add('idle'), 3500)
  }
  if (chyronEl) {
    markActive()
    window.addEventListener('keydown', markActive)
    window.addEventListener('pointermove', markActive)
    window.addEventListener('pointerdown', markActive)
  }

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
        // Until a cup is picked, default to the championship crumb path —
        // the four ship cups + the placeholder are all championship-shaped;
        // the Dev Cup browse path swaps in once that tile is clicked.
        return (pickedCup?.races.length ?? 1) > 0 ? STEPS_SP_CUP_CHAMPIONSHIP : STEPS_SP_CUP_BROWSE
      case 'tutorial':
        return STEPS_TUTORIAL
      case 'time-trial':
        return STEPS_TT
      default:
        return STEPS_SP_RACE
    }
  }

  function updateChyron(step: Step): void {
    // Apple-sport restraint: drop the per-screen orange eyebrow chip
    // (PRE-SHOW / FORMAT / COURSE / LOADOUT / OPTIONS …). The text line
    // alone carries the meaning; the tag was 8 different framings for
    // the same UI slot. Pass empty `tag` so the `.tag:empty { display:
    // none; }` rule collapses the column.
    switch (step) {
      case 'title':
        setChyron('', '')
        break
      case 'mode':
        setChyron('', 'Pick a format. Disabled tiles light up as their systems land.')
        break
      case 'sp-track':
        setChyron('', 'All twelve ship tracks are in production — tiles light up sprint by sprint.')
        break
      case 'sp-cup':
        setChyron('', 'Real cups gate on their tracks shipping. Dev Cup is the playtest path.')
        break
      case 'sp-cup-tracks':
        setChyron(
          '',
          currentMode === 'time-trial'
            ? 'Solo against the clock. Your best lap saves as a translucent ghost — race it next time.'
            : pickedCup?.id === 'dev'
              ? 'Playtest tracks. Procedural built-ins + every GLB the manifest knows about.'
              : (pickedCup?.races.length ?? 0) > 0
                ? 'Championship lineup. START CUP to lock in the whole bill.'
                : 'Cup line-up — tap a card to lock in your venue.',
        )
        break
      case 'sp-bike':
        setChyron('', 'Compare top speed, accel, agility, weight and wave-follow.')
        break
      case 'pre-race':
        setChyron('', 'Override laps + AI count, or hit GO for the defaults.')
        break
      case 'mp-entry':
        setChyron('', 'Host a new room or punch in a friend’s code.')
        break
      case 'tutorial-intro':
        setChyron('', 'Tutorial framework ships in sprint 1.')
        break
      case 'leaderboard':
        setChyron('', 'Time Trial + leaderboard backend ship in M16.')
        break
      case 'credits':
        setChyron('', 'The artists, musicians and toolmakers behind Hoverbike.')
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
    card.className = `bc-card bc-card-thumb${disabled ? ' bc-disabled' : ''}${
      !disabled && t.id === picks.trackId ? ' selected' : ''
    }`
    card.style.setProperty('--accent', t.accent)
    if (disabled) card.dataset.gate = t.gateLabel
    const best = disabled ? null : bestLapFor(t.id, picks.bikeId)
    // Shipped tracks have a 320×180 thumb JPG in /public/assets/tracks/
    // generated by the per-track Blender seed. Pending tracks fall back
    // to an accent-tinted placeholder block.
    const thumbHtml = disabled
      ? `<div class="thumb thumb-pending" style="background: linear-gradient(135deg, ${t.accent}26, transparent 70%)"></div>`
      : `<div class="thumb" style="background-image: url('${assetUrl(`/assets/tracks/${t.id}-thumb.jpg`)}')"></div>`
    card.innerHTML = `
      ${thumbHtml}
      <div class="body">
        <div class="label">${escapeHtml(cupNameFor(t.cup)).toUpperCase()}</div>
        <div class="name">${escapeHtml(t.name).toUpperCase()}</div>
        <div class="tag">${escapeHtml(t.location)}</div>
        <div class="record">${
          disabled
            ? `LAP TARGET &middot; ${t.lapTarget}s &middot; ${t.laps} LAPS`
            : best
              ? `BEST LAP &middot; ${best}`
              : ' '
        }</div>
      </div>
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

  /** Cup-select host. Renders the four ship cups plus the Dev cups
   *  (dev builds only). Real cups stay disabled in Step 0; the Dev
   *  Cup is the browse entrypoint; the Dev Placeholder Cup is the
   *  championship wiring proof. */
  function renderCupCards(host: HTMLElement): void {
    host.innerHTML = ''
    for (const c of V1_CUPS) {
      host.appendChild(buildCupCard(c))
    }
    if (dev) {
      host.appendChild(buildCupCard(DEV_PLACEHOLDER_CUP))
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
    const isDevCup = c.id === 'dev' || c.id === 'dev-placeholder'
    const trackCount =
      c.id === 'dev'
        ? devCupTracks.length
        : c.races.length > 0
          ? c.races.length
          : V1_TRACKS.filter((t) => t.cup === c.id).length
    const labelText =
      c.id === 'dev'
        ? 'DEV ONLY · BROWSE'
        : c.id === 'dev-placeholder'
          ? 'DEV ONLY · CHAMPIONSHIP'
          : 'CUP'
    card.innerHTML = `
      ${isDevCup ? '<span class="bc-dev-badge">DEV</span>' : ''}
      <div class="label">${labelText}</div>
      <div class="name">${escapeHtml(c.name).toUpperCase()}</div>
      <div class="tag">${escapeHtml(c.tagline)}</div>
      <div class="record">${trackCount} TRACK${trackCount === 1 ? '' : 'S'}</div>
      ${disabled ? `<div class="bc-gate">${escapeHtml(c.gateLabel)}</div>` : ''}
    `
    if (!disabled) {
      card.addEventListener('click', () => {
        pickedCup = c
        if (c.races.length > 0) {
          // Championship cups commit as a single unit — skip the inert
          // lineup-preview screen and land on bike-select directly. The
          // first race seeds picks.trackId so the bike screen has a
          // meaningful readout to render.
          picks.trackId = c.races[0] ?? picks.trackId
          showStep('sp-bike')
        } else {
          // Browse-shaped cups (Dev Cup) still use sp-cup-tracks as the
          // track picker — the player picks one of the tiles to launch a
          // single race.
          showStep('sp-cup-tracks')
        }
      })
    }
    return card
  }

  /** Render the chosen cup's tracks. Behaviour splits by cup shape:
   *
   *  - Browse cups (Dev Cup, `races: []`): tile-per-track grid; click
   *    a tile to lock in a single one-off race against it.
   *  - Championship cups (placeholder cup + ship cups when they
   *    unlock): inert preview tiles showing the lineup in order, plus
   *    a single START CUP CTA at the bottom that commits the cup. */
  function renderCupTrackCards(host: HTMLElement): void {
    host.innerHTML = ''
    if (currentMode === 'time-trial') {
      // TT picks a single venue from the full ship roster. Every
      // status:'ship' v1 track is fair game; on dev builds we also
      // surface the dev tracks below so playtesters can run TT against
      // procedurals + freshly-baked GLBs without leaving the menu.
      for (const t of V1_TRACKS) {
        if (t.status !== 'ship') continue
        host.appendChild(buildV1TrackCard(t))
      }
      if (dev) {
        for (const t of devCupTracks) {
          host.appendChild(buildDevTrackCard(t))
        }
      }
      return
    }
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
    // Championship preview path. Render each race in lineup order as
    // an inert preview tile so the player can scan the full bill
    // before committing.
    for (let i = 0; i < pickedCup.races.length; i++) {
      const id = pickedCup.races[i] ?? ''
      host.appendChild(buildChampionshipPreviewTile(i + 1, id))
    }
  }

  /** One stop in the cup-lineup preview. Inert by design — the cup
   *  commits as a single unit via the START CUP CTA below the grid,
   *  not by clicking individual races. */
  function buildChampionshipPreviewTile(raceNumber: number, trackId: string): HTMLElement {
    const card = document.createElement('div')
    card.className = 'bc-card'
    card.style.setProperty('--accent', pickedCup?.accent ?? '#88aabb')
    const v1 = V1_TRACKS.find((t) => t.id === trackId)
    const devEntry = devCupTracks.find((t) => t.id === trackId)
    const name = v1?.name ?? devEntry?.name ?? trackId
    const tagline = v1?.location ?? devEntry?.tagline ?? 'Track tile pending its catalogue entry.'
    const setPiece = v1?.setPiece ?? ''
    card.innerHTML = `
      <div class="label">RACE ${raceNumber}</div>
      <div class="name">${escapeHtml(name).toUpperCase()}</div>
      <div class="tag">${escapeHtml(tagline)}</div>
      ${setPiece ? `<div class="tag" style="opacity: 0.75; margin-top: -4px;">${escapeHtml(setPiece)}</div>` : ''}
    `
    return card
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
      card.className = `bc-card bc-card-thumb${b.id === picks.bikeId ? ' selected' : ''}`
      card.style.setProperty('--accent', b.accent)
      const best = showTrackBest ? bestLapFor(picks.trackId, b.id) : null
      const bars = b.bars
        .map(
          (s: BikeCard['bars'][number]) => `
            <div class="stat-row">
              <span class="lbl">${s.label}</span>
              <div class="bar"><i style="width: ${(s.value * 100).toFixed(0)}%"></i></div>
            </div>`,
        )
        .join('')
      card.innerHTML = `
        <div class="thumb" style="background-image: url('${assetUrl(`/assets/bikes/${b.id}-thumb.jpg`)}')"></div>
        <div class="body">
          <div class="label">BIKE</div>
          <div class="name">${escapeHtml(b.name)}</div>
          <div class="tag">${escapeHtml(b.tagline)}</div>
          <div class="stats">${bars}</div>
          ${best ? `<div class="record">BEST LAP &middot; ${best}</div>` : ''}
        </div>
      `
      // Clicking a bike commits the loadout and launches the race
      // immediately — no separate "lights out" confirm button. In
      // cup mode the same click commits the whole championship via
      // `commitSpCup`, which seeds cup-progress + stamps `?cup=` on
      // the race URL.
      card.addEventListener('click', () => {
        picks.bikeId = b.id
        if (currentMode === 'cup' && (pickedCup?.races.length ?? 0) > 0) {
          commitSpCupRef?.()
        } else {
          commitSpRaceRef?.()
        }
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
      const cupReadoutLabel =
        screens['sp-cup-tracks']?.querySelector<HTMLElement>('#sp-cup-readout-label')
      const startBtn = screens['sp-cup-tracks']?.querySelector<HTMLButtonElement>('#sp-cup-start')
      const subEl = screens['sp-cup-tracks']?.querySelector<HTMLElement>('#sp-cup-tracks-sub')
      const backBtn = screens['sp-cup-tracks']?.querySelector<HTMLElement>('#sp-cup-tracks-back')
      if (host) renderCupTrackCards(host)
      if (cupReadout) {
        cupReadout.textContent =
          currentMode === 'time-trial' ? 'TIME TRIAL' : (pickedCup?.name ?? '').toUpperCase()
      }
      if (cupReadoutLabel)
        cupReadoutLabel.textContent = currentMode === 'time-trial' ? 'MODE' : 'CUP'
      if (backBtn) backBtn.innerHTML = currentMode === 'time-trial' ? '&larr; BACK' : '&larr; CUP'
      // Championship-shaped cups (placeholder + future ship cups) get a
      // single START CUP CTA; browse Dev Cup keeps its tile-as-launcher
      // behaviour and hides the CTA. TT reuses this screen as a venue
      // picker (no cup bound); the START CUP CTA stays hidden there
      // because TT is a single-track flow.
      const isChampionship = currentMode === 'cup' && (pickedCup?.races.length ?? 0) > 0
      if (startBtn) startBtn.style.display = isChampionship ? 'inline-block' : 'none'
      if (subEl) {
        if (currentMode === 'time-trial') {
          subEl.textContent = 'PICK A TRACK TO TIME-TRIAL — YOUR BEST LAP SAVES AS A GHOST'
        } else if (isChampionship) {
          subEl.textContent = `${pickedCup?.races.length ?? 0}-RACE CHAMPIONSHIP · LOCK IN A BIKE NEXT`
        } else {
          subEl.textContent = 'PICK A VENUE FROM THE CUP YOU SELECTED'
        }
      }
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
    // The new screen has different content height than the old one;
    // refresh the scroll-overflow fade on the next frame once layout
    // has settled. (The ResizeObserver only fires on the observed
    // element's box-size changing, not on children swapping.)
    requestAnimationFrame(refreshStageFade)
  }

  /** Where the bike-select screen rewinds to. Championship cups skip the
   *  lineup-preview step on the way in, so back from bike-select returns
   *  to the cup picker. Dev cup + Time Trial still pick a track on
   *  sp-cup-tracks, so back lands there. Race mode rewinds to sp-track. */
  function bikeBackStep(): Step {
    if (currentMode === 'cup' && (pickedCup?.races.length ?? 0) > 0) return 'sp-cup'
    if (currentMode === 'cup' || currentMode === 'time-trial') return 'sp-cup-tracks'
    return 'sp-track'
  }

  function gamepadBack(): void {
    if (currentStep === 'mode') showStep('title')
    else if (currentStep === 'sp-track') showStep('mode')
    else if (currentStep === 'sp-cup') showStep('mode')
    else if (currentStep === 'sp-cup-tracks')
      // TT mode skipped the cup-select step on the way in; backing out
      // returns to the mode picker rather than a cup screen the user
      // never saw.
      showStep(currentMode === 'time-trial' ? 'mode' : 'sp-cup')
    else if (currentStep === 'sp-bike') showStep(bikeBackStep())
    else if (currentStep === 'pre-race') showStep('sp-bike')
    else if (currentStep === 'mp-entry') showStep('mode')
    else if (currentStep === 'tutorial-intro') showStep('mode')
    else if (currentStep === 'leaderboard') showStep('mode')
    else if (currentStep === 'credits') showStep('mode')
  }

  const gamepadNav = installMenuGamepad({
    container: () => screens[currentStep] ?? null,
    onBack: gamepadBack,
    // Park while the Settings overlay or Rebind modal sits on top — they
    // run their own pollers and a second live one fights them for focus.
    isActive: () => !isAnyOverlayShown('settings-menu', 'rebind-menu'),
  })

  return new Promise<MenuFlowResult>((resolve) => {
    function teardown(): void {
      window.clearInterval(clockInterval)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', markActive)
      window.removeEventListener('pointermove', markActive)
      window.removeEventListener('pointerdown', markActive)
      window.removeEventListener('resize', refreshStageFade)
      stage?.removeEventListener('scroll', refreshStageFade)
      stageResizeObs?.disconnect()
      if (idleTimer) window.clearTimeout(idleTimer)
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
      if (currentMode === 'time-trial') url.searchParams.set('tt', '1')
      finish(url.toString())
    }
    commitSpRaceRef = commitSpRace

    /** Lock in the chosen cup and launch its first race. Seeds the
     *  cup-progress store with the full race lineup so the post-race
     *  NEXT button can read it back across the page reload. The URL
     *  carries `?cup=<cupId>` alongside the usual race params; the
     *  game-loop branches its finish-screen handling on that param. */
    function commitSpCup(): void {
      if (!pickedCup || pickedCup.races.length === 0) {
        // Defensive — cup-mode commits go through the START CUP
        // button, which is only rendered for championship-shaped cups.
        // Fall back to the single-race path so we don't dead-end the
        // player if state got tangled.
        commitSpRace()
        return
      }
      startCup({
        cupId: pickedCup.id,
        bikeId: picks.bikeId,
        races: pickedCup.races,
        // Seed a stable rival field so the same opponents — names, bikes,
        // liveries — ride every race in the championship (MK8-style).
        roster: buildCupRoster({ cupId: pickedCup.id, bikeId: picks.bikeId }),
      })
      const firstTrack = pickedCup.races[0] ?? picks.trackId
      const url = new URL(window.location.href)
      url.search = ''
      url.searchParams.set('race', '1')
      url.searchParams.set('cup', pickedCup.id)
      url.searchParams.set('track', firstTrack)
      url.searchParams.set('bike', picks.bikeId)
      finish(url.toString())
    }
    commitSpCupRef = commitSpCup

    function buildTitle(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen bc-title'
      // Tagline is now contextual — quiet on cold-boot (the wordmark
      // alone is the title), a soft anchor when bouncing back from a
      // race so the player understands where they are.
      const recap = readLastRaceRecap()
      const taglineHtml =
        opts.reason === 'exit-from-race' ? `<div class="tagline">Back to the booth</div>` : ''
      // Stash the most recently-watched track/bike back into the picks
      // so the next race defaults to whatever the player just exited.
      if (recap) {
        if (recap.trackId) picks.trackId = recap.trackId
        if (recap.bikeId && recap.bikeId in { cruiser: 1, racer: 1, stunt: 1 }) {
          picks.bikeId = recap.bikeId as BikeVariantId
        }
      }
      const recapHtml = recap ? renderRecapHtml(recap) : ''
      // The whole title surface advances on click, but the CTA is also a
      // real <button> so keyboard focus + gamepad A (which clicks the
      // active focusable, see menu-gamepad.ts) both reach the same path.
      el.innerHTML = `
        <span class="word">HOVERBIKE</span>
        ${taglineHtml}
        ${recapHtml}
        <div class="cta">
          <button class="cta-blink primary" id="title-start" type="button">
            Press any key or button to begin
          </button>
        </div>
      `
      el.addEventListener('click', () => showStep('mode'))
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
        <div class="bc-cards cols-5" id="mode-cards">${tilesHtml}</div>
        <div class="bc-actions">
          <div class="left">
            <button class="bc-link" id="mode-back" type="button">&larr; BACK</button>
          </div>
          <div class="right">
            <button class="bc-link" id="mode-leaderboards" type="button">LEADERBOARDS &middot;&middot;&middot;</button>
            <button class="bc-link" id="mode-credits" type="button">CREDITS &middot;&middot;&middot;</button>
            <button class="bc-link" id="mode-making-of" type="button">MAKING OF &middot;&middot;&middot;</button>
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
              // TT reuses the cup-tracks screen as the venue picker,
              // but it isn't bound to any cup — `renderCupTrackCards`
              // branches on `currentMode === 'time-trial'` and lists
              // every shipped v1 track (plus dev tracks on dev builds).
              pickedCup = null
              showStep('sp-cup-tracks')
              break
          }
        })
      })
      el.querySelector('#mode-back')?.addEventListener('click', () => showStep('title'))
      el.querySelector('#mode-credits')?.addEventListener('click', () => showStep('credits'))
      el.querySelector('#mode-making-of')?.addEventListener('click', () => {
        // The making-of microsite ships alongside the game at /making-of/.
        // Open it in a new tab so the menu stays put underneath.
        window.open('/making-of/', '_blank', 'noopener')
      })
      el.querySelector('#mode-settings')?.addEventListener('click', () => {
        installSettingsOverlay().open()
      })
      el.querySelector('#mode-leaderboards')?.addEventListener('click', () => {
        // Re-mount on each open so freshly-set TT times appear without
        // a full menu reload. Cheap — the screen is read-only over
        // localStorage data.
        const fresh = buildLeaderboard()
        const existing = screens.leaderboard
        existing?.parentElement?.replaceChild(fresh, existing)
        screens.leaderboard = fresh
        showStep('leaderboard')
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
     *  select; data + footer-CTA differ per `pickedCup`. */
    function buildSpCupTracks(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen'
      el.innerHTML = `
        <div class="bc-section-head">
          <div class="num">03</div>
          <div>
            <div class="title">CUP LINE-UP</div>
            <div class="sub" id="sp-cup-tracks-sub">PICK A VENUE FROM THE CUP YOU SELECTED</div>
          </div>
          <div class="meta">
            <div class="sub" id="sp-cup-readout-label">CUP</div>
            <div id="sp-cup-readout" style="font-family: var(--bc-font-display); font-size: 22px;"></div>
          </div>
        </div>
        <div class="bc-cards cols-3" id="sp-cup-track-cards"></div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link" id="sp-cup-tracks-back" type="button">&larr; CUP</button></div>
          <div class="right"><button class="bc-btn primary" id="sp-cup-start" type="button" style="display:none;">START CUP &rarr;</button></div>
        </div>
      `
      const host = el.querySelector<HTMLElement>('#sp-cup-track-cards')
      if (host) renderCupTrackCards(host)
      // TT skipped the cup-select screen on the way in; back drops to
      // the mode picker instead of a cup-select the player never saw.
      el.querySelector('#sp-cup-tracks-back')?.addEventListener('click', () =>
        showStep(currentMode === 'time-trial' ? 'mode' : 'sp-cup'),
      )
      el.querySelector('#sp-cup-start')?.addEventListener('click', () => showStep('sp-bike'))
      return el
    }

    /** Tutorial-intro screen. Two cards:
     *
     *  - **START** — kicks off the framework on the current track pick
     *    via `?race=1&tutorial=1`. Always enabled.
     *  - **SANDBAR** — scripted-scenario placeholder, still gated on
     *    the Sandbar track shipping (M13). */
    function buildTutorialIntro(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen'
      const completed = playerSettings.tutorialCompleted
      const ctaLabel = completed ? 'REPLAY TUTORIAL' : 'START TUTORIAL'
      el.innerHTML = `
        <div class="bc-section-head">
          <div class="num">02</div>
          <div>
            <div class="title">TUTORIAL</div>
            <div class="sub">SCRIPTED PROMPTS &middot; ANY TRACK &middot; SKIPPABLE</div>
          </div>
        </div>
        <div class="bc-cards cols-2">
          <div class="bc-card" id="tut-start" role="button" tabindex="0" style="--accent:#ffd54a; cursor: pointer;">
            <div class="label">FRAMEWORK</div>
            <div class="name">FIRST RUN</div>
            <div class="tag">Seven beats — throttle, cruise, look around, wave pump, drift, anti-grav, finish. Runs on any track. Subtitles toggle in Settings.</div>
            <div class="record">~90s &middot; INTRO DIFFICULTY</div>
            <div class="record" style="color: var(--bc-yellow); margin-top: 6px;">${escapeHtml(ctaLabel)} &rarr;</div>
          </div>
          <div class="bc-card bc-disabled" data-gate="Ships with the Sandbar track in sprint 1 (M13)" style="--accent:#9bdcf2;">
            <div class="label">TRAINING COVE</div>
            <div class="name">SANDBAR</div>
            <div class="tag">Track-specific scripted scenarios — drift around a buoy, pickup gate, ramp run, anti-grav arch.</div>
            <div class="record">~60s &middot; 1 LAP &middot; SANDBAR-ONLY</div>
            <div class="bc-gate">Ships with the Sandbar track — sprint 1 (M13)</div>
          </div>
        </div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link" id="tut-back" type="button">&larr; MODE</button></div>
        </div>
      `
      el.querySelector('#tut-back')?.addEventListener('click', () => showStep('mode'))
      const launchTutorial = (): void => {
        // Reuse the singleplayer commit path so picks → URL handling
        // stays in one place; just stamp the tutorial flag on top.
        const url = new URL(window.location.href)
        url.search = ''
        url.searchParams.set('race', '1')
        url.searchParams.set('track', picks.trackId)
        url.searchParams.set('bike', picks.bikeId)
        url.searchParams.set('tutorial', '1')
        finish(url.toString())
      }
      const startCard = el.querySelector<HTMLElement>('#tut-start')
      startCard?.addEventListener('click', launchTutorial)
      startCard?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          launchTutorial()
        }
      })
      return el
    }

    /** Leaderboards screen — Time Trial top-N per track. Default view
     *  is GLOBAL (the remote board from the leaderboard Party); on
     *  fetch failure the badge flips to LOCAL ONLY and the cached
     *  store is shown instead. Two-pane: a vertical track list on the
     *  left, the selected track's top-10 table on the right. Player
     *  rows are highlighted by handle match against
     *  `playerSettings.leaderboardHandle` ('YOU' fallback for
     *  unhandled players). */
    function buildLeaderboard(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen'
      const tracks = buildLeaderboardTrackList(opts.manifestTracks, dev)
      const counts = getEntryCounts()
      // Prefer a track with entries when picking the initial selection
      // — otherwise the right pane reads as empty even when other
      // tracks have times.
      const initialId = tracks.find((t) => (counts[t.id] ?? 0) > 0)?.id ?? tracks[0]?.id ?? 'lagoon'
      let selectedId = initialId
      // Per-track view source — flips to 'local' on fetch failure so
      // the badge tells the player whether they're looking at the
      // global board or the offline cache.
      const viewSource: Record<string, 'global' | 'local' | 'loading'> = {}
      // Fetched entries by trackId — used by `renderBoard` to display
      // the global view when available, falling back to the local
      // cache when missing.
      const remoteEntries: Record<string, LeaderboardEntry[]> = {}
      const remoteOn = isRemoteEnabled()
      el.innerHTML = `
        <div class="bc-section-head">
          <div class="num">02</div>
          <div>
            <div class="title">LEADERBOARDS</div>
            <div class="sub">TIME TRIAL TOP TIMES &middot; ANONYMOUS HANDLES &middot; <span id="lb-source-badge">${remoteOn ? 'GLOBAL BOARD' : 'LOCAL CACHE ONLY'}</span></div>
          </div>
          <div class="meta">
            <div class="sub">HANDLE</div>
            <div id="lb-handle" style="font-family: var(--bc-font-display); font-size: 22px;"></div>
          </div>
        </div>
        <div class="bc-leaderboard">
          <div class="bc-lb-tracks" id="lb-tracks"></div>
          <div class="bc-lb-board" id="lb-board"></div>
        </div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link" id="lb-back" type="button">&larr; MODE</button></div>
          <div class="right">
            <button class="bc-link" id="lb-settings" type="button">CHANGE HANDLE &middot;&middot;&middot;</button>
            <button class="bc-link" id="lb-clear" type="button">CLEAR LOCAL TIMES</button>
          </div>
        </div>
      `
      const tracksHost = el.querySelector<HTMLElement>('#lb-tracks')
      const boardHost = el.querySelector<HTMLElement>('#lb-board')
      const handleEl = el.querySelector<HTMLElement>('#lb-handle')
      const renderHandle = (): void => {
        if (handleEl) handleEl.textContent = playerSettings.leaderboardHandle || 'YOU (default)'
      }
      const renderTracks = (): void => {
        if (!tracksHost) return
        tracksHost.innerHTML = ''
        const liveCounts = getEntryCounts()
        for (const t of tracks) {
          const row = document.createElement('button')
          row.type = 'button'
          row.className = `bc-lb-track${t.id === selectedId ? ' selected' : ''}`
          row.dataset.trackId = t.id
          const count = liveCounts[t.id] ?? 0
          const top = count > 0 ? (getEntries(t.id, 1)[0] ?? null) : null
          const topLine = top
            ? `#1 &middot; ${escapeHtml(formatLap(top.bestLap))} &middot; ${escapeHtml(top.handle)}`
            : 'NO ENTRIES'
          row.innerHTML = `
            <span class="bc-lb-track-accent" style="--accent:${t.accent}"></span>
            <div class="bc-lb-track-body">
              <div class="bc-lb-track-name">${escapeHtml(t.name).toUpperCase()}</div>
              <div class="bc-lb-track-meta">${topLine}</div>
            </div>
            <div class="bc-lb-track-count">${count}</div>
          `
          row.addEventListener('click', () => {
            selectedId = t.id
            renderTracks()
            renderBoard()
            void refreshRemote(t.id)
          })
          tracksHost.appendChild(row)
        }
        if (tracks.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'bc-lb-empty'
          empty.textContent = 'No tracks available. Run pnpm gen:all to build the manifest.'
          tracksHost.appendChild(empty)
        }
      }
      const sourceLabel = (id: string): string => {
        const s = viewSource[id]
        if (s === 'global') return 'GLOBAL BOARD'
        if (s === 'loading') return 'LOADING…'
        return remoteOn ? 'LOCAL ONLY · NETWORK UNAVAILABLE' : 'LOCAL CACHE ONLY'
      }
      const renderBoard = (): void => {
        if (!boardHost) return
        const selectedTrack = tracks.find((t) => t.id === selectedId)
        const useRemote =
          viewSource[selectedId] === 'global' && remoteEntries[selectedId] !== undefined
        const entries = useRemote
          ? (remoteEntries[selectedId] ?? []).slice(0, 10)
          : getEntries(selectedId, 10)
        const ownHandle = (playerSettings.leaderboardHandle || 'YOU').toUpperCase()
        boardHost.innerHTML = ''
        const head = document.createElement('div')
        head.className = 'bc-lb-board-head'
        head.innerHTML = `
          <div class="bc-lb-board-title">${escapeHtml((selectedTrack?.name ?? selectedId).toUpperCase())}</div>
          <div class="bc-lb-board-sub">${
            entries.length > 0
              ? `${entries.length} ENTR${entries.length === 1 ? 'Y' : 'IES'} &middot; FASTEST LAP WINS &middot; <span class="bc-lb-source">${sourceLabel(selectedId)}</span>`
              : `NO ENTRIES YET &middot; <span class="bc-lb-source">${sourceLabel(selectedId)}</span>`
          }</div>
        `
        boardHost.appendChild(head)
        if (entries.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'bc-lb-empty'
          empty.innerHTML =
            'No times yet. Pick this track in <b>Time Trial</b> and set a personal best — your handle lands here automatically.'
          boardHost.appendChild(empty)
          return
        }
        const table = document.createElement('div')
        table.className = 'bc-lb-table'
        table.innerHTML = `
          <div class="bc-lb-row head">
            <div class="rk">#</div><div class="hd">HANDLE</div><div class="tm">BEST LAP</div><div class="bk">BIKE</div>
          </div>
        `
        entries.forEach((entry, i) => {
          const row = document.createElement('div')
          row.className = `bc-lb-row${entry.handle === ownHandle ? ' you' : ''}`
          row.innerHTML = `
            <div class="rk">${i + 1}</div>
            <div class="hd">${escapeHtml(entry.handle)}</div>
            <div class="tm">${escapeHtml(formatLap(entry.bestLap))}</div>
            <div class="bk">${escapeHtml(entry.bikeId.toUpperCase())}</div>
          `
          table.appendChild(row)
        })
        boardHost.appendChild(table)
      }
      /** Fire the GET /board fetch for the selected track. Idempotent
       *  per track id — if we already have a fresh global view, skip.
       *  Updates `remoteEntries` + `viewSource` and re-renders on
       *  completion (or failure → falls back to LOCAL). */
      const refreshRemote = async (id: string): Promise<void> => {
        if (!remoteOn) return
        if (viewSource[id] === 'global') return
        viewSource[id] = 'loading'
        if (id === selectedId) renderBoard()
        const res = await fetchBoard(id, getEndpoint())
        if (res.ok) {
          remoteEntries[id] = res.board.entries
          viewSource[id] = 'global'
          // Mirror the global view into the local cache so the next
          // cold boot already has the right snapshot to paint with.
          setCachedEntries(id, res.board.entries)
        } else {
          viewSource[id] = 'local'
        }
        if (id === selectedId) {
          renderBoard()
          renderTracks()
        }
      }
      renderHandle()
      renderTracks()
      renderBoard()
      // Kick the initial global fetch in the background.
      void refreshRemote(selectedId)
      el.querySelector('#lb-back')?.addEventListener('click', () => showStep('mode'))
      el.querySelector('#lb-settings')?.addEventListener('click', () => {
        installSettingsOverlay().open()
        // Re-render once the overlay closes so a handle change reflects
        // immediately. Settings overlay doesn't expose an `onClose` —
        // poll once via the visibility change instead.
        const root = document.getElementById('settings-menu')
        if (!root) return
        const obs = new MutationObserver(() => {
          if (!root.classList.contains('show')) {
            renderHandle()
            renderTracks()
            renderBoard()
            obs.disconnect()
          }
        })
        obs.observe(root, { attributes: true, attributeFilter: ['class'] })
      })
      el.querySelector('#lb-clear')?.addEventListener('click', () => {
        if (
          typeof window !== 'undefined' &&
          !window.confirm('Wipe all local leaderboard entries? This cannot be undone.')
        )
          return
        clearLeaderboards()
        renderTracks()
        renderBoard()
      })
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
            <div class="sub">Five archetypes &middot; pick the one that fits your line</div>
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
      el.querySelector('#sp-bike-back')?.addEventListener('click', () => showStep(bikeBackStep()))
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

    /** Credits screen — read-only third-party attribution for assets that
     *  ship in the game. Three groups today: the Blender Studio brush
     *  textures (CC BY 4.0 — attribution is *required*), the soundtrack
     *  artists (driven off the generated `SOUNDTRACK` manifest so the list
     *  can never drift from what actually plays), and Quaternius (CC0 props
     *  — no attribution required, credited as a courtesy). Reached from the
     *  mode-screen footer; it scrolls inside `#menu-stage` and inherits
     *  keyboard / controller / touch nav from the menu-flow poller (the
     *  BACK link + the external `<a>`s are all focusables). */
    function buildCredits(): HTMLElement {
      const el = document.createElement('section')
      el.className = 'bc-screen'
      const tracks = SOUNDTRACK.map(
        (t) =>
          `<li><span class="bc-credit-title">${escapeHtml(t.title)}</span><span class="bc-credit-by">${escapeHtml(t.artist)}</span></li>`,
      ).join('')
      el.innerHTML = `
        <div class="bc-section-head">
          <div>
            <div class="title">CREDITS</div>
            <div class="sub">THE ARTISTS, MUSICIANS &amp; TOOLMAKERS BEHIND HOVERBIKE</div>
          </div>
        </div>
        <div class="bc-credits">
          <section class="bc-credit-group">
            <h3>BRUSH TEXTURES</h3>
            <p>Hoverbike&rsquo;s hand-painted surfaces build on the <b>Brushstroke
              Tools</b> oil-paint brush styles by <b>Simon Thommes / Blender Studio</b>
              (Project Gold), &copy; Blender Foundation &mdash; licensed under
              <b>CC&nbsp;BY&nbsp;4.0</b>. Modified for this game: the scanned brush maps
              were sliced, recentred and baked into a single tiling brush-stroke texture.</p>
            <div class="bc-credit-links">
              <a href="https://studio.blender.org/tools/addons/brushstroke_tools" target="_blank" rel="noopener">studio.blender.org</a>
              <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>
            </div>
          </section>
          <section class="bc-credit-group">
            <h3>MUSIC</h3>
            <p>Soundtrack by these independent artists &mdash; each track remains
              &copy; its creator, used with thanks.</p>
            <ul class="bc-credit-tracks">${tracks}</ul>
          </section>
          <section class="bc-credit-group">
            <h3>3D PROPS</h3>
            <p>Environment and prop models by <b>Quaternius</b>, released into the public
              domain (<b>CC0</b>). No attribution is required &mdash; we credit them here
              with gratitude.</p>
            <div class="bc-credit-links">
              <a href="https://quaternius.com" target="_blank" rel="noopener">quaternius.com</a>
            </div>
          </section>
        </div>
        <div class="bc-actions">
          <div class="left"><button class="bc-link primary" id="credits-back" type="button">&larr; MODE</button></div>
        </div>
      `
      el.querySelector('#credits-back')?.addEventListener('click', () => showStep('mode'))
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
    screens.credits = buildCredits()
    for (const s of Object.values(screens)) stage?.appendChild(s!)

    showStep(opts.reason === 'exit-from-race' ? 'mode' : 'title')

    function onKey(e: KeyboardEvent): void {
      // Don't hijack typing into the room-code input.
      const target = e.target as HTMLElement | null
      if (target && target.tagName === 'INPUT') return
      // Title screen is ambient — any meaningful key advances. Skip
      // modifier-only events (Shift/Ctrl/Alt/Meta on their own) and
      // Escape (which goes to gamepadBack below).
      if (
        currentStep === 'title' &&
        e.code !== 'Escape' &&
        ![
          'ShiftLeft',
          'ShiftRight',
          'ControlLeft',
          'ControlRight',
          'AltLeft',
          'AltRight',
          'MetaLeft',
          'MetaRight',
        ].includes(e.code)
      ) {
        showStep('mode')
        e.preventDefault()
        return
      }
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        if (currentStep === 'title') {
          showStep('mode')
          e.preventDefault()
        } else if (currentStep === 'sp-track' || currentStep === 'sp-cup-tracks') {
          showStep('sp-bike')
          e.preventDefault()
        } else if (currentStep === 'sp-bike') {
          if (currentMode === 'cup' && (pickedCup?.races.length ?? 0) > 0) {
            commitSpCup()
          } else {
            commitSpRace()
          }
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

/** Tracks shown in the Leaderboards screen. Combines:
 *
 *  - All v1 ship tracks (so the player can scan the full slate even
 *    before each track ships — empty boards read as "race when this
 *    lands"). Each row carries the v1 accent so the visual identity
 *    matches the track-select tile.
 *  - Procedural + manifest tracks (lagoon, cliffside, every GLB) so
 *    times set on today's playable maps actually have a home. Dev-only
 *    tracks only appear on dev builds, matching the cup-select gating.
 */
type LeaderboardTrackEntry = { id: string; name: string; accent: string }
function buildLeaderboardTrackList(
  manifest: TrackManifestEntry[] | undefined,
  showDev: boolean,
): LeaderboardTrackEntry[] {
  const seen = new Set<string>()
  const out: LeaderboardTrackEntry[] = []
  for (const t of V1_TRACKS) {
    seen.add(t.id)
    out.push({ id: t.id, name: t.name, accent: t.accent })
  }
  if (showDev) {
    const dev = buildDevCupTracks(manifest)
    for (const t of dev) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      out.push({ id: t.id, name: t.name, accent: t.accent })
    }
  } else {
    // Even on production builds the procedural tracks ship today —
    // the player can set times on them, so they belong on the board.
    for (const t of buildTrackList(manifest)) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      out.push({ id: t.id, name: t.name, accent: t.accent })
    }
  }
  return out
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
