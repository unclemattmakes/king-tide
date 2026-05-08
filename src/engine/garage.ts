import { BIKE_VARIANTS, type BikeVariantId, DEFAULT_BIKE_VARIANT } from '@/game/bikes/variants'
import { clearBestLaps, getBestLap } from './save-state'

/**
 * Garage menu — lightweight DOM overlay for picking your bike, track,
 * and inspecting saved best laps. Hidden by default; opens via the
 * "GARAGE" HUD button. Selecting a combination + RACE updates the URL
 * and reloads, which kicks the boot path off again with the new params.
 *
 * Why reload-on-select instead of a hot-swap: the simulation,
 * track terrain, AI bikes, and audio engine are all bootstrapped at
 * page load. A hot rebuild would mean tearing down five subsystems and
 * standing them back up — a giant refactor for a feature most players
 * use once per session. A page reload is a single line and the game
 * boots in under half a second on modern hardware.
 */

const TRACKS: Array<{ id: string; name: string; tagline: string; accent: number }> = [
  {
    id: 'lagoon',
    name: 'Lagoon Loop',
    tagline: 'Stadium oval with a jump on the right straight.',
    accent: 0x66ddff,
  },
  {
    id: 'cliffside',
    name: 'Cliffside',
    tagline: 'Mesa loop with a 15m cliff drop. The signature moment.',
    accent: 0xc8b07a,
  },
]

export type GarageInstance = {
  open(): void
  close(): void
  isOpen(): boolean
}

export function installGarageMenu(opts: {
  initialTrackId: string
  initialBikeId: BikeVariantId
}): GarageInstance {
  const overlayMaybe = document.getElementById('garage')
  const toggleMaybe = document.getElementById('garage-toggle')
  const bikesElMaybe = document.getElementById('garage-bikes')
  const tracksElMaybe = document.getElementById('garage-tracks')
  const raceBtnMaybe = document.getElementById('garage-race')
  const cancelBtnMaybe = document.getElementById('garage-cancel')
  const clearBtnMaybe = document.getElementById('garage-clear')
  const headerBestMaybe = document.getElementById('garage-best')
  if (
    !overlayMaybe ||
    !toggleMaybe ||
    !bikesElMaybe ||
    !tracksElMaybe ||
    !raceBtnMaybe ||
    !cancelBtnMaybe ||
    !clearBtnMaybe ||
    !headerBestMaybe
  ) {
    return { open() {}, close() {}, isOpen: () => false }
  }
  // Capture as non-null locals so closures don't have to re-narrow.
  const overlay = overlayMaybe
  const toggle = toggleMaybe
  const bikesEl = bikesElMaybe
  const tracksEl = tracksElMaybe
  const raceBtn = raceBtnMaybe
  const cancelBtn = cancelBtnMaybe
  const clearBtn = clearBtnMaybe
  const headerBest = headerBestMaybe

  let pickedBike: BikeVariantId = opts.initialBikeId
  let pickedTrack: string = opts.initialTrackId

  function rebuildBikes() {
    bikesEl.innerHTML = ''
    for (const v of Object.values(BIKE_VARIANTS)) {
      const div = document.createElement('div')
      div.className = `opt ${v.id === pickedBike ? 'selected' : ''}`
      div.style.setProperty('--accent', `#${v.accentColor.toString(16).padStart(6, '0')}`)
      const best = getBestLap({ trackId: pickedTrack, bikeId: v.id })
      div.innerHTML = `
        <div class="name">${v.name}</div>
        <div class="tag">${v.tagline}</div>
        <div class="best">${best != null ? `Best on ${trackName(pickedTrack)}: ${formatLap(best)}` : 'No record yet'}</div>
      `
      div.addEventListener('click', () => {
        pickedBike = v.id
        rebuildBikes()
      })
      bikesEl.appendChild(div)
    }
  }

  function rebuildTracks() {
    tracksEl.innerHTML = ''
    for (const t of TRACKS) {
      const div = document.createElement('div')
      div.className = `opt ${t.id === pickedTrack ? 'selected' : ''}`
      div.style.setProperty('--accent', `#${t.accent.toString(16).padStart(6, '0')}`)
      const best = getBestLap({ trackId: t.id, bikeId: pickedBike })
      div.innerHTML = `
        <div class="name">${t.name}</div>
        <div class="tag">${t.tagline}</div>
        <div class="best">${best != null ? `Best with ${BIKE_VARIANTS[pickedBike].name}: ${formatLap(best)}` : 'No record yet'}</div>
      `
      div.addEventListener('click', () => {
        pickedTrack = t.id
        rebuildBikes() // bike's "best" line depends on selected track
        rebuildTracks()
      })
      tracksEl.appendChild(div)
    }
  }

  function refreshHeaderBest() {
    const best = getBestLap({ trackId: opts.initialTrackId, bikeId: opts.initialBikeId })
    headerBest.textContent = best != null ? ` · ${formatLap(best)}` : ''
  }

  function open() {
    pickedBike = opts.initialBikeId
    pickedTrack = opts.initialTrackId
    rebuildBikes()
    rebuildTracks()
    overlay.classList.add('show')
  }
  function close() {
    overlay.classList.remove('show')
  }

  toggle.addEventListener('click', open)
  cancelBtn.addEventListener('click', close)
  raceBtn.addEventListener('click', () => {
    const url = new URL(window.location.href)
    url.searchParams.set('track', pickedTrack)
    url.searchParams.set('bike', pickedBike)
    window.location.assign(url.toString())
  })
  clearBtn.addEventListener('click', () => {
    clearBestLaps()
    rebuildBikes()
    rebuildTracks()
    refreshHeaderBest()
  })

  refreshHeaderBest()

  return {
    open,
    close,
    isOpen: () => overlay.classList.contains('show'),
  }
}

function trackName(id: string): string {
  return TRACKS.find((t) => t.id === id)?.name ?? id
}

export function formatLap(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  if (m > 0) return `${m}:${s.toFixed(2).padStart(5, '0')}`
  return `${s.toFixed(2)}s`
}

export const KNOWN_TRACK_IDS = TRACKS.map((t) => t.id)
export const ALL_BIKE_IDS: BikeVariantId[] = Object.keys(BIKE_VARIANTS) as BikeVariantId[]
export { DEFAULT_BIKE_VARIANT }
