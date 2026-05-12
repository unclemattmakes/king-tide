/**
 * Multiplayer lobby overlay — broadcast-styled (8 slots + per-slot
 * loadout pills + per-player bike/track pickers + a smash-bros-style
 * random pick when everyone's ready).
 *
 * The overlay is its own DOM panel, z-indexed above the canvas, that
 * lives next to `#menu`. Visibility is gated by `raceHud.armCountdown()`:
 * once the host's pick lands and the room transitions out of the lobby,
 * the caller calls `hide()` and the rest of the session is canvas-only.
 *
 * Per-slot data flows in via `render(view)`:
 *   - peerId, ready, picked bike, picked track, isYou
 *   - capacity (always MAX_PEERS_PER_ROOM = 8) — empty slots dim
 *
 * Pickers are rendered when the local peer has a slot. Caller wires
 * their `onPickBike` / `onPickTrack` callbacks to ship a ready=false
 * (or ready=true) message with the new pick.
 */

import { MAX_PEERS_PER_ROOM } from '../net/protocol'

export type LobbyPeerView = {
  peerId: number
  ready: boolean
  isYou: boolean
  /** Display label for the bike (uppercase). `null` if not picked yet. */
  bikeLabel: string | null
  /** Display label for the track (uppercase). `null` if not picked yet. */
  trackLabel: string | null
  /** Hex color for the bike accent stripe — `null` when no pick. */
  bikeAccent?: string | null
}

export type LobbyView = {
  peers: LobbyPeerView[]
  /** Local human's last-known ready state — drives the toggle button's
   *  label + style. Trust this. */
  localReady: boolean
  /** True while the socket hasn't yet delivered `hello`. */
  connecting: boolean
  /** Local picks (used to drive the picker side panel). */
  localBike: { id: string; label: string; accent: string }
  localTrack: { id: string; label: string }
  /** Catalogues the local picker cycles through. */
  bikeOptions: { id: string; label: string; accent: string }[]
  trackOptions: { id: string; label: string }[]
  /** Most-recent "pick rolled" banner, e.g. when the smash-bros choice
   *  has been made. Null hides the banner. */
  pickBanner?: { winnerLabel: string; subtitle: string } | null | undefined
  /** Room code shown in the side panel + the copy hint. */
  roomId: string
}

export type LobbyOverlay = {
  render(view: LobbyView): void
  hide(): void
  isShown(): boolean
  /** Wire-up for the side panel buttons. Reassigning is safe at any
   *  time; render() re-binds via late-binding closures. */
  onToggleReady: () => void
  onPickBike: (bikeId: string) => void
  onPickTrack: (trackId: string) => void
}

export type LobbyOverlayOpts = {
  roomId: string
  onToggleReady?: () => void
  onPickBike?: (bikeId: string) => void
  onPickTrack?: (trackId: string) => void
}

const NOOP = (): void => {
  /* placeholder */
}

export function installLobbyOverlay(opts: LobbyOverlayOpts): LobbyOverlay {
  const overlay = document.createElement('div')
  overlay.id = 'lobby-overlay'
  overlay.innerHTML = `
    <div class="lobby-bg"></div>
    <header class="bc-header">
      <div class="bc-brand">
        <span class="bar"></span>
        <span class="name">HOVERBIKE</span>
        <span class="live">LIVE</span>
      </div>
      <nav class="bc-crumbs">
        <span class="bc-crumb">MODE</span>
        <span class="bc-crumb-sep">·</span>
        <span class="bc-crumb is-current">LOBBY</span>
      </nav>
      <div class="bc-clock"></div>
    </header>
    <div class="bc-stage">
      <section class="bc-screen show" style="width: 100%;">
        <div class="bc-section-head">
          <div class="num">L</div>
          <div>
            <div class="title">PRE-RACE LOBBY</div>
            <div class="sub" id="lobby-sub">UP TO 8 RIDERS &middot; PICK + READY UP</div>
          </div>
          <div class="meta">
            <div class="sub">ROOM</div>
            <div style="font-family: var(--bc-font-display); font-size: 24px; color: var(--bc-yellow);" id="lobby-room-id"></div>
          </div>
        </div>

        <div class="bc-lobby-pickbanner" id="lobby-banner"></div>

        <div class="bc-lobby">
          <div class="bc-slot-grid" id="lobby-slots"></div>

          <aside class="bc-lobby-side">
            <h3>YOUR LOADOUT</h3>
            <div class="sub">Cycle picks &middot; nudges everyone&rsquo;s lobby instantly</div>
            <div class="bc-pick" id="pick-bike">
              <span class="label">BIKE</span>
              <span class="value" id="pick-bike-val">—</span>
              <span class="nav">
                <button type="button" data-dir="-1" data-which="bike">&lt;</button>
                <button type="button" data-dir="+1" data-which="bike">&gt;</button>
              </span>
            </div>
            <div class="bc-pick" id="pick-track">
              <span class="label">VOTE</span>
              <span class="value" id="pick-track-val">—</span>
              <span class="nav">
                <button type="button" data-dir="-1" data-which="track">&lt;</button>
                <button type="button" data-dir="+1" data-which="track">&gt;</button>
              </span>
            </div>
            <div class="bc-lobby-room" id="lobby-room-info">
              <span>SHARE THIS URL TO INVITE:</span>
              <span class="copy-hint">click to copy</span>
            </div>
            <button class="bc-btn primary" id="lobby-ready" type="button" style="width: 100%; text-align: center;">CLICK WHEN READY</button>
            <div class="sub" style="text-align: center;">[ENTER] toggle ready</div>
          </aside>
        </div>
      </section>
    </div>
    <footer class="bc-chyron">
      <div class="tag">LIVE</div>
      <div class="text" id="lobby-chyron">Pick a bike, vote a track, hit ready. Once everyone&rsquo;s in we roll for the venue.</div>
      <div class="keys">
        <span class="bc-key">ENTER</span><span>ready</span>
        <span class="bc-key">←/→</span><span>cycle picks</span>
      </div>
    </footer>
  `
  document.body.appendChild(overlay)

  // Scoped layout styles — the broadcast tokens come from index.html.
  const style = document.createElement('style')
  style.textContent = `
    #lobby-overlay {
      position: fixed; inset: 0; z-index: 50;
      display: flex; flex-direction: column;
      color: var(--bc-ink);
      font-family: var(--bc-font-sans);
      background:
        radial-gradient(ellipse 90% 60% at 50% -10%, rgba(0, 212, 255, 0.18), transparent 55%),
        radial-gradient(ellipse 60% 50% at 100% 100%, rgba(255, 90, 31, 0.10), transparent 60%),
        linear-gradient(180deg, var(--bc-navy) 0%, #050a14 100%);
      overflow: hidden;
    }
    #lobby-overlay.hidden { display: none; }
    #lobby-overlay::before {
      content: ''; position: absolute; inset: 0;
      background: repeating-linear-gradient(180deg,
        transparent 0, transparent 2px,
        rgba(255, 255, 255, 0.025) 2px, rgba(255, 255, 255, 0.025) 3px);
      pointer-events: none; z-index: 1;
    }
    #lobby-overlay::after {
      content: ''; position: absolute; inset: 0;
      background: radial-gradient(ellipse at center, transparent 38%, rgba(0, 0, 0, 0.75) 100%);
      pointer-events: none; z-index: 1;
    }
    #lobby-overlay > * { position: relative; z-index: 2; }
  `
  document.head.appendChild(style)

  const slotsEl = overlay.querySelector<HTMLElement>('#lobby-slots')!
  const roomIdEl = overlay.querySelector<HTMLElement>('#lobby-room-id')!
  const roomInfoEl = overlay.querySelector<HTMLElement>('#lobby-room-info')!
  const readyBtn = overlay.querySelector<HTMLButtonElement>('#lobby-ready')!
  const bikeValEl = overlay.querySelector<HTMLElement>('#pick-bike-val')!
  const trackValEl = overlay.querySelector<HTMLElement>('#pick-track-val')!
  const bannerEl = overlay.querySelector<HTMLElement>('#lobby-banner')!
  const subEl = overlay.querySelector<HTMLElement>('#lobby-sub')!
  const navBtns = overlay.querySelectorAll<HTMLButtonElement>('.bc-pick .nav button')

  roomIdEl.textContent = opts.roomId

  let shown = true
  const handlers = {
    toggleReady: opts.onToggleReady ?? NOOP,
    pickBike: (opts.onPickBike ?? NOOP) as (id: string) => void,
    pickTrack: (opts.onPickTrack ?? NOOP) as (id: string) => void,
  }

  let lastView: LobbyView | null = null

  readyBtn.addEventListener('click', () => handlers.toggleReady())
  navBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!lastView) return
      const which = btn.dataset.which as 'bike' | 'track'
      const dir = Number(btn.dataset.dir) || 1
      const list = which === 'bike' ? lastView.bikeOptions : lastView.trackOptions
      if (list.length === 0) return
      const currentId = which === 'bike' ? lastView.localBike.id : lastView.localTrack.id
      const idx = Math.max(
        0,
        list.findIndex((o) => o.id === currentId),
      )
      const next = list[(idx + dir + list.length) % list.length]
      if (!next) return
      if (which === 'bike') handlers.pickBike(next.id)
      else handlers.pickTrack(next.id)
    })
  })

  // Click the room info pill to copy the share URL to clipboard.
  roomInfoEl.addEventListener('click', () => {
    void navigator.clipboard?.writeText(window.location.href)
    roomInfoEl.classList.add('copied')
    setTimeout(() => roomInfoEl.classList.remove('copied'), 1200)
  })

  function buildSlot(view: LobbyView, peerSlot: number): HTMLElement {
    const peer = view.peers.find((p) => p.peerId === peerSlot)
    const el = document.createElement('div')
    el.className = 'bc-slot'
    if (peer) {
      el.classList.add('filled')
      if (peer.ready) el.classList.add('ready')
      if (peer.isYou) el.classList.add('you')
    }
    const bike = peer?.bikeLabel ?? '—'
    const track = peer?.trackLabel ?? '—'
    const accent = peer?.bikeAccent ?? 'var(--bc-line)'
    el.style.setProperty('--slot-accent', accent)
    el.innerHTML = `
      <div class="slot-id">P${peerSlot + 1}${peer?.isYou ? ' &middot; YOU' : ''}</div>
      <div class="slot-name">${peer ? `RIDER ${peerSlot + 1}` : 'OPEN'}</div>
      <div class="slot-pick">BIKE &middot; <b>${escapeHtml(bike)}</b></div>
      <div class="slot-pick">VOTE &middot; <b>${escapeHtml(track)}</b></div>
      <div class="slot-ready">${peer ? (peer.ready ? 'READY' : 'PICKING…') : ''}</div>
    `
    return el
  }

  function render(view: LobbyView): void {
    if (!shown) return
    lastView = view
    roomIdEl.textContent = view.roomId

    if (view.connecting) {
      subEl.textContent = 'CONNECTING TO THE BROADCAST…'
      slotsEl.innerHTML = ''
      readyBtn.disabled = true
      readyBtn.textContent = 'CONNECTING…'
      bikeValEl.textContent = '—'
      trackValEl.textContent = '—'
      return
    }
    readyBtn.disabled = false
    subEl.textContent = `${view.peers.length} OF ${MAX_PEERS_PER_ROOM} CONNECTED · PICK + READY UP`

    slotsEl.innerHTML = ''
    for (let i = 0; i < MAX_PEERS_PER_ROOM; i++) {
      slotsEl.appendChild(buildSlot(view, i))
    }

    bikeValEl.textContent = view.localBike.label.toUpperCase()
    trackValEl.textContent = view.localTrack.label.toUpperCase()
    bikeValEl.style.color = view.localBike.accent
    readyBtn.textContent = view.localReady ? "I'M READY ✓" : 'CLICK WHEN READY'
    readyBtn.classList.toggle('primary', !view.localReady)

    if (view.pickBanner) {
      bannerEl.classList.add('show')
      bannerEl.innerHTML = `THE BOOTH HAS SPOKEN — <b>${escapeHtml(view.pickBanner.winnerLabel.toUpperCase())}</b> &middot; ${escapeHtml(view.pickBanner.subtitle)}`
    } else {
      bannerEl.classList.remove('show')
      bannerEl.textContent = ''
    }
  }

  function hide(): void {
    if (!shown) return
    shown = false
    overlay.classList.add('hidden')
  }

  return {
    render,
    hide,
    isShown: () => shown,
    set onToggleReady(fn: () => void) {
      handlers.toggleReady = fn
    },
    get onToggleReady() {
      return handlers.toggleReady
    },
    set onPickBike(fn: (id: string) => void) {
      handlers.pickBike = fn
    },
    get onPickBike() {
      return handlers.pickBike
    },
    set onPickTrack(fn: (id: string) => void) {
      handlers.pickTrack = fn
    },
    get onPickTrack() {
      return handlers.pickTrack
    },
  }
}

/** Smash-Bros-style track pick: collect each peer's pick, then sample
 *  one weighted by how many peers voted for it. Ties are broken
 *  uniformly random (a single random index over the flattened votes
 *  produces the right distribution naturally). If nobody picked, the
 *  caller's fallback is used. */
export function pickRandomTrack(
  picks: ReadonlyArray<string | undefined>,
  fallback: string,
  rng: () => number = Math.random,
): string {
  const votes = picks.filter((p): p is string => typeof p === 'string' && p.length > 0)
  if (votes.length === 0) return fallback
  const idx = Math.floor(rng() * votes.length)
  return votes[idx] ?? fallback
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
