/**
 * M10.12 — multiplayer lobby overlay.
 *
 * Full-screen DOM panel shown while a `?room=<id>` peer is waiting for
 * everyone (themselves included) to ready up. Once `raceHud.armCountdown()`
 * fires — locally on "all ready" or remotely on a server `start-race`
 * broadcast — the overlay hides for the rest of the session.
 *
 * The overlay is a sibling of the canvas, z-indexed above the HUD. It
 * captures pointer input on its button + receives Enter as a global
 * keybind through a callback the caller registers.
 *
 * Pure-DOM, no Three.js — keeps the bundle small and lets us toggle
 * visibility without re-render churn.
 */

export type LobbyPeerView = {
  peerId: number
  ready: boolean
  isYou: boolean
}

export type LobbyView = {
  peers: LobbyPeerView[]
  /** Local human's last-known ready state — drives the toggle button's
   *  label + style. May briefly differ from `peers.find(isYou).ready`
   *  during a pre-`hello` window; trust this. */
  localReady: boolean
  /** True while the socket hasn't yet delivered `hello`. The overlay
   *  shows "connecting…" instead of the peer list during this window. */
  connecting: boolean
}

export type LobbyOverlay = {
  /** Repaint the overlay. Cheap — string interpolation + classList. */
  render(view: LobbyView): void
  /** Hide the overlay permanently (countdown armed). Idempotent. */
  hide(): void
  /** Internal — read by callers that bind keys. Returns true if the
   *  overlay is currently displayed. */
  isShown(): boolean
  /** Called by the caller's input handler when the user activates the
   *  toggle (Enter key or button click). The handler is also invoked
   *  by the overlay's internal button click; pass it on the way in so
   *  there's one source of truth. */
  readonly onToggle: () => void
}

export type LobbyOverlayOpts = {
  roomId: string
  /** Called when the user clicks the "READY" / "NOT READY" button OR
   *  presses Enter while the overlay is shown. Caller flips local
   *  ready state + sends to relay. */
  onToggle: () => void
}

export function installLobbyOverlay(opts: LobbyOverlayOpts | { roomId: string }): LobbyOverlay {
  // Support a partial opts (just roomId) for callers that wire the
  // onToggle separately after construction. Default to a no-op.
  const onToggle = 'onToggle' in opts && typeof opts.onToggle === 'function'
    ? opts.onToggle
    : (): void => {
        /* caller hasn't wired yet */
      }

  const overlay = document.createElement('div')
  overlay.id = 'lobby-overlay'
  overlay.innerHTML = `
    <div class="lobby-card">
      <div class="lobby-title">LOBBY</div>
      <div class="lobby-room">room: <b class="lobby-room-id"></b></div>
      <div class="lobby-peers"></div>
      <button type="button" class="lobby-button"></button>
      <div class="lobby-hint">press <b>Enter</b> to toggle ready</div>
    </div>
  `
  document.body.appendChild(overlay)

  // Scoped styles. Inline so the overlay is self-contained.
  const style = document.createElement('style')
  style.textContent = `
    #lobby-overlay {
      position: fixed; inset: 0; z-index: 50;
      display: flex; align-items: center; justify-content: center;
      background: rgba(8, 16, 24, 0.72);
      font-family: ui-sans-serif, system-ui, sans-serif;
      color: #eaf2ff;
      pointer-events: auto;
    }
    #lobby-overlay.hidden { display: none; }
    #lobby-overlay .lobby-card {
      min-width: 340px; max-width: 480px;
      background: #0c1a2a; border: 1px solid #2a4a6a;
      border-radius: 12px; padding: 24px 28px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      text-align: center;
    }
    #lobby-overlay .lobby-title {
      font-size: 22px; letter-spacing: 0.18em; font-weight: 700;
      color: #6cf; margin-bottom: 6px;
    }
    #lobby-overlay .lobby-room {
      font-size: 13px; opacity: 0.7; margin-bottom: 18px;
    }
    #lobby-overlay .lobby-room-id { color: #9ec0e0; }
    #lobby-overlay .lobby-peers {
      display: flex; flex-direction: column; gap: 6px;
      margin-bottom: 20px; min-height: 28px;
    }
    #lobby-overlay .lobby-peer {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 12px; border-radius: 6px;
      background: rgba(255,255,255,0.04);
      font-size: 14px;
    }
    #lobby-overlay .lobby-peer.you { background: rgba(108, 204, 255, 0.12); }
    #lobby-overlay .lobby-peer .status {
      font-weight: 600; letter-spacing: 0.05em;
    }
    #lobby-overlay .lobby-peer .status.ready { color: #6cf08c; }
    #lobby-overlay .lobby-peer .status.not-ready { color: #f0a36c; }
    #lobby-overlay .lobby-connecting {
      font-size: 14px; opacity: 0.7; padding: 12px;
    }
    #lobby-overlay .lobby-button {
      width: 100%;
      padding: 12px 18px;
      font-size: 16px; font-weight: 700; letter-spacing: 0.1em;
      border: 0; border-radius: 8px; cursor: pointer;
      background: #1c4a78; color: #fff;
      transition: background 0.15s ease;
    }
    #lobby-overlay .lobby-button:hover { background: #2a6098; }
    #lobby-overlay .lobby-button.ready { background: #2a8c4a; }
    #lobby-overlay .lobby-button.ready:hover { background: #36a85a; }
    #lobby-overlay .lobby-hint {
      margin-top: 10px; font-size: 12px; opacity: 0.55;
    }
  `
  document.head.appendChild(style)

  const roomIdEl = overlay.querySelector('.lobby-room-id') as HTMLElement
  const peersEl = overlay.querySelector('.lobby-peers') as HTMLElement
  const buttonEl = overlay.querySelector('.lobby-button') as HTMLButtonElement

  roomIdEl.textContent = opts.roomId

  let shown = true
  let lastOnToggle = onToggle
  buttonEl.addEventListener('click', () => lastOnToggle())

  function render(view: LobbyView): void {
    if (!shown) return
    if (view.connecting) {
      peersEl.innerHTML = `<div class="lobby-connecting">connecting…</div>`
      buttonEl.disabled = true
      buttonEl.textContent = '…'
      buttonEl.classList.remove('ready')
      return
    }
    buttonEl.disabled = false
    if (view.peers.length === 0) {
      peersEl.innerHTML = `<div class="lobby-connecting">waiting for slot assignment…</div>`
    } else {
      peersEl.innerHTML = view.peers
        .map(
          (p) => `
        <div class="lobby-peer ${p.isYou ? 'you' : ''}">
          <span>P${p.peerId}${p.isYou ? ' (you)' : ''}</span>
          <span class="status ${p.ready ? 'ready' : 'not-ready'}">
            ${p.ready ? 'READY' : 'NOT READY'}
          </span>
        </div>`,
        )
        .join('')
    }
    buttonEl.textContent = view.localReady ? "I'M READY ✓" : 'CLICK WHEN READY'
    buttonEl.classList.toggle('ready', view.localReady)
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
    get onToggle() {
      return lastOnToggle
    },
    // Allow late-binding the toggle callback. The caller assigns
    // `overlay.onToggle = realFn` once it's constructed.
    set onToggle(fn: () => void) {
      lastOnToggle = fn
    },
  } as LobbyOverlay & { onToggle: () => void }
}
