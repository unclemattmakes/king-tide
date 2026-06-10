import type { TrackManifestEntry } from '@/game/assets/manifest'
import { BIKE_VARIANTS, type BikeVariantId, DEFAULT_BIKE_VARIANT } from '@/game/bikes/variants'
import { installMenuGamepad, type MenuGamepad } from '../input/menu-gamepad'
import { createNetRoom } from '../net/room'
import { installLobbyOverlay, type LobbyView } from '../render/lobby-overlay'
import { buildTrackList } from './catalog'
import { deterministicTrackPick, type TrackVote } from './lobby-pick'

/**
 * Multiplayer lobby phase — runs AFTER the menu and BEFORE the race.
 *
 * The lobby connects to the relay, paints the broadcast-styled
 * `LobbyOverlay`, and manages each player's bike + track pick. When
 * every peer has readied up, the local client picks a track using a
 * smash-bros-style random over the votes and broadcasts `start-race`
 * with the chosen track. Every peer (including us) then navigates to
 * `?room=X&track=Y&bike=Z&race=1`, which the rest of boot() picks up
 * to load the actual race environment.
 *
 * Late joiners: if the server's `hello` arrives with `raceStarted=true`
 * we skip the lobby UI entirely and navigate straight into the race
 * using the server-supplied `raceTrackId` (so the field shares the
 * same environment).
 *
 * Quitting back to the menu: ESC from the lobby resolves with a bare
 * URL — boot then re-shows the menu.
 */

export type MpLobbyOpts = {
  roomId: string
  netHost: string
  manifestTracks?: TrackManifestEntry[]
  /** Pre-fill local picks from URL params (e.g. carried over from the
   *  menu flow). */
  initialBikeId?: BikeVariantId
  initialTrackId?: string
}

export type MpLobbyResult = { href: string }

const ALL_BIKES = Object.values(BIKE_VARIANTS).map((v) => ({
  id: v.id,
  label: v.name,
  accent: `#${v.accentColor.toString(16).padStart(6, '0')}`,
}))

export function runMpLobby(opts: MpLobbyOpts): Promise<MpLobbyResult> {
  const tracks = buildTrackList(opts.manifestTracks)
  const trackOptions = tracks.map((t) => ({ id: t.id, label: t.name }))

  const lobby = installLobbyOverlay({ roomId: opts.roomId })

  const local = {
    bikeId: (opts.initialBikeId ?? DEFAULT_BIKE_VARIANT) as BikeVariantId,
    trackId: opts.initialTrackId ?? tracks[0]?.id ?? 'lagoon',
    ready: false,
  }

  let pickBanner: LobbyView['pickBanner'] = null
  let raceArmed = false
  /** Track we'll navigate to when the banner timer fires. Mutable after
   *  arming: a relay `start-race` carrying a different winner (another
   *  peer armed first — its pick is the sticky one the server replays)
   *  overrides this until the navigation actually happens. */
  let armedTrackId: string | null = null
  let gamepad: MenuGamepad | null = null

  return new Promise<MpLobbyResult>((resolve) => {
    function finish(href: string): void {
      window.removeEventListener('keydown', onKey)
      window.clearInterval(latencyRefresh)
      gamepad?.dispose()
      gamepad = null
      lobby.hide()
      net.close()
      resolve({ href })
    }

    /** Leave the lobby and re-enter the menu (Esc / controller B). */
    function bailToMenu(): void {
      const url = new URL(window.location.href)
      url.search = ''
      finish(url.toString())
    }

    function bikeMeta(id: string | undefined) {
      const found = ALL_BIKES.find((b) => b.id === id)
      return found ?? { id: local.bikeId, label: 'PICKING…', accent: '#888' }
    }
    function trackMeta(id: string | undefined) {
      const found = trackOptions.find((t) => t.id === id)
      return found ?? { id: id ?? local.trackId, label: 'PICKING…' }
    }

    function buildView(): LobbyView {
      const peers: LobbyView['peers'] = []
      const ready = net.latestPeerReady
      const picks = net.latestPeerPicks
      for (const [peerId, isReady] of ready) {
        const p = picks.get(peerId)
        const bike = bikeMeta(p?.selectedBikeId)
        const track = trackMeta(p?.selectedTrackId)
        peers.push({
          peerId,
          ready: isReady,
          isYou: peerId === net.peerId,
          bikeLabel: p?.selectedBikeId ? bike.label : null,
          trackLabel: p?.selectedTrackId ? track.label : null,
          bikeAccent: p?.selectedBikeId ? bike.accent : null,
        })
      }
      peers.sort((a, b) => a.peerId - b.peerId)
      return {
        peers,
        localReady: local.ready,
        connecting: !net.ready,
        localBike: bikeMeta(local.bikeId),
        localTrack: trackMeta(local.trackId),
        bikeOptions: ALL_BIKES,
        trackOptions,
        pickBanner,
        roomId: opts.roomId,
        latencyMs: net.latencyMs,
      }
    }

    function refresh(): void {
      lobby.render(buildView())
    }

    // Latency is updated by the room's 1 Hz ping loop independent of
    // any lobby event — refresh on the same cadence so the readout
    // moves even when nobody else is doing anything. Cheap; the render
    // path is innerHTML on a handful of slots.
    const latencyRefresh = window.setInterval(refresh, 1000)

    function shipReady(): void {
      net.sendReady(local.ready, {
        selectedBikeId: local.bikeId,
        selectedTrackId: local.trackId,
      })
      refresh()
      tryStartRace()
    }

    function toggleReady(): void {
      if (raceArmed) return
      local.ready = !local.ready
      shipReady()
    }

    function pickBike(id: string): void {
      if (!(id in BIKE_VARIANTS)) return
      local.bikeId = id as BikeVariantId
      // Re-ship the latest ready state so other peers see the pick
      // change immediately. A bare pick-change without re-readying
      // would leave us out of sync until they next toggled — annoying.
      shipReady()
    }
    function pickTrack(id: string): void {
      if (!trackOptions.some((t) => t.id === id)) return
      local.trackId = id
      shipReady()
    }

    function buildRaceHref(trackId: string): string {
      const url = new URL(window.location.href)
      // An explicit `?host=` override (custom relay — e2e sidecars, a
      // localhost relay against a prod build) must survive into the
      // race URL, or the race tab silently reconnects to the DEFAULT
      // relay and the room's peers/lock state diverge from the lobby's.
      const hostOverride = url.searchParams.get('host')
      url.search = ''
      url.searchParams.set('room', opts.roomId)
      url.searchParams.set('track', trackId)
      url.searchParams.set('bike', local.bikeId)
      url.searchParams.set('race', '1')
      if (hostOverride) url.searchParams.set('host', hostOverride)
      return url.toString()
    }

    /** Arm the start banner + navigation timer for `trackId`.
     *
     *  More than one client can arm at effectively the same moment: the
     *  final `ready` toggle and the toggler's `start-race` arrive
     *  back-to-back, and a receiver runs `tryStartRace` inside its
     *  `ready` handler — before it processes the queued `start-race`.
     *  The deterministic pick makes simultaneous arms agree; this
     *  function adds the backstop: a relay `start-race` (`source:
     *  'server'`) with a different winner overrides the local pick up
     *  until navigation fires, so even disagreeing clients converge on
     *  the relay's sticky first-wins track. */
    function armRace(trackId: string, source: 'local' | 'server'): void {
      if (raceArmed && (source === 'local' || trackId === armedTrackId)) return
      const firstArm = !raceArmed
      raceArmed = true
      armedTrackId = trackId
      const winnerLabel = trackOptions.find((t) => t.id === trackId)?.label ?? trackId
      pickBanner = { winnerLabel, subtitle: 'Lights out in 3…' }
      refresh()
      if (firstArm) {
        // Brief banner pause so players see the pick, then navigate to
        // whatever `armedTrackId` holds by the time the timer fires.
        window.setTimeout(() => finish(buildRaceHref(armedTrackId ?? trackId)), 1400)
      }
    }

    /** When the local view sees everyone ready, pick the winning track
     *  (deterministic smash-bros random — same answer on every client,
     *  see lobby-pick.ts) and signal the relay. Idempotent. */
    function tryStartRace(): void {
      if (raceArmed) return
      if (!net.ready) return
      const ready = net.latestPeerReady
      if (ready.size === 0) return
      for (const v of ready.values()) if (!v) return
      // All ready — pick a track from the votes.
      const picks = net.latestPeerPicks
      const votes: TrackVote[] = []
      for (const peerId of ready.keys()) {
        votes.push({ peerId, trackId: picks.get(peerId)?.selectedTrackId })
      }
      const chosen = deterministicTrackPick(votes, opts.roomId, local.trackId)
      net.sendStartRace(chosen)
      armRace(chosen, 'local')
    }

    const net = createNetRoom({
      host: opts.netHost,
      roomId: opts.roomId,
      onConnected: (_peerId, _others, raceStarted) => {
        // Push our initial picks once we know our slot so the lobby UI
        // on other peers shows our loadout without waiting for a ready
        // toggle.
        net.sendReady(false, {
          selectedBikeId: local.bikeId,
          selectedTrackId: local.trackId,
        })
        refresh()
        // Joining within the race-start grace window (the cohort is
        // still loading in): `raceStarted` rides the hello and the room
        // fires onStartRace with the server-stamped track right after
        // this callback — navigation is handled there, and we make the
        // shared countdown. Post-grace arrivals never get here — the
        // relay rejects them and onRaceInProgress shows the lock notice.
        void raceStarted
      },
      onPeerJoined: () => refresh(),
      onPeerLeft: () => {
        refresh()
        tryStartRace()
      },
      onPeerReady: () => {
        refresh()
        tryStartRace()
      },
      onStartRace: (trackId) => {
        // Relay-delivered start (another peer armed, or the sticky
        // raceStarted replay for late joiners). Server's track wins —
        // including over a locally-armed pick that hasn't navigated yet.
        armRace(trackId ?? armedTrackId ?? local.trackId, 'server')
      },
      onRoomFull: () => {
        pickBanner = { winnerLabel: 'ROOM FULL', subtitle: 'Try another code.', plain: true }
        refresh()
      },
      onRaceInProgress: () => {
        // No mid-race joins (product rule, 2026-06-09): the room locked
        // when its race started. The room has already closed itself —
        // leave the player in the lobby shell with the notice; Esc / B
        // still bails to the menu.
        pickBanner = {
          winnerLabel: 'RACE IN PROGRESS',
          subtitle: 'This room is mid-race. Try again when the race ends.',
          plain: true,
        }
        refresh()
      },
    })

    lobby.onToggleReady = toggleReady
    lobby.onPickBike = pickBike
    lobby.onPickTrack = pickTrack

    refresh()

    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null
      if (target && target.tagName === 'INPUT') return
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        toggleReady()
        e.preventDefault()
      } else if (e.code === 'Escape') {
        // Bail back to the menu.
        bailToMenu()
        e.preventDefault()
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        const dir = e.code === 'ArrowLeft' ? -1 : 1
        const list = trackOptions
        if (list.length === 0) return
        const idx = Math.max(
          0,
          list.findIndex((o) => o.id === local.trackId),
        )
        const next = list[(idx + dir + list.length) % list.length]
        if (next) pickTrack(next.id)
        e.preventDefault()
      } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        const dir = e.code === 'ArrowUp' ? -1 : 1
        const list = ALL_BIKES
        const idx = Math.max(
          0,
          list.findIndex((o) => o.id === local.bikeId),
        )
        const next = list[(idx + dir + list.length) % list.length]
        if (next) pickBike(next.id)
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)

    // Controller navigation: the on-screen pick (< / >) and READY
    // controls are real buttons, so the shared spatial-focus poller
    // drives them — d-pad to move, A to cycle a pick / toggle ready, B
    // to bail. This is the only poller on the lobby page (the menu flow
    // has already navigated away), so no gating is needed.
    gamepad = installMenuGamepad({
      container: () => document.getElementById('lobby-overlay'),
      onBack: bailToMenu,
    })
    gamepad.focusFirst()
  })
}
