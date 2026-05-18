import type { TrackManifestEntry } from '@/game/assets/manifest'
import { BIKE_VARIANTS, type BikeVariantId, DEFAULT_BIKE_VARIANT } from '@/game/bikes/variants'
import { createNetRoom } from '../net/room'
import { installLobbyOverlay, type LobbyView, pickRandomTrack } from '../render/lobby-overlay'
import { buildTrackList } from './catalog'

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

  return new Promise<MpLobbyResult>((resolve) => {
    function finish(href: string): void {
      window.removeEventListener('keydown', onKey)
      window.clearInterval(latencyRefresh)
      lobby.hide()
      net.close()
      resolve({ href })
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
      url.search = ''
      url.searchParams.set('room', opts.roomId)
      url.searchParams.set('track', trackId)
      url.searchParams.set('bike', local.bikeId)
      url.searchParams.set('race', '1')
      return url.toString()
    }

    /** When the local view sees everyone ready, pick the winning track
     *  (smash-bros) and signal the relay. Idempotent. */
    function tryStartRace(): void {
      if (raceArmed) return
      if (!net.ready) return
      const ready = net.latestPeerReady
      if (ready.size === 0) return
      for (const v of ready.values()) if (!v) return
      // All ready — pick a track from the votes.
      const picks = net.latestPeerPicks
      const votes: (string | undefined)[] = []
      for (const peerId of ready.keys()) {
        votes.push(picks.get(peerId)?.selectedTrackId)
      }
      const chosen = pickRandomTrack(votes, local.trackId)
      raceArmed = true
      const winnerLabel = trackOptions.find((t) => t.id === chosen)?.label ?? chosen
      pickBanner = { winnerLabel, subtitle: 'Lights out in 3…' }
      refresh()
      net.sendStartRace(chosen)
      // Brief banner pause so players see the pick, then navigate.
      window.setTimeout(() => finish(buildRaceHref(chosen)), 1400)
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
        // If we joined a race already in progress, the server stamps
        // the chosen track in `hello`; skip the lobby UI entirely.
        if (raceStarted) {
          // onStartRace fires from the room with the trackId — handle
          // there to avoid duplicating navigation logic.
        }
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
        if (raceArmed) return
        raceArmed = true
        const chosen = trackId ?? local.trackId
        const winnerLabel = trackOptions.find((t) => t.id === chosen)?.label ?? chosen
        pickBanner = { winnerLabel, subtitle: 'Lights out in 3…' }
        refresh()
        window.setTimeout(() => finish(buildRaceHref(chosen)), 1400)
      },
      onRoomFull: () => {
        pickBanner = { winnerLabel: 'ROOM FULL', subtitle: 'Try another code.' }
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
        const url = new URL(window.location.href)
        url.search = ''
        finish(url.toString())
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
  })
}
