/**
 * M10.4 — client side of the PartyKit relay.
 *
 * Wraps `partysocket`'s reconnecting WebSocket with the two-tier protocol
 * (binary InputFrames + JSON control messages) and surfaces:
 *  - the local peer's assigned slot, once the server's hello arrives
 *  - a callback for remote InputFrames
 *  - peer presence (join/leave events)
 *  - a `sendFrame(frame)` method that no-ops until the connection is ready
 *
 * Designed so single-player code paths don't care this exists — the room
 * is only constructed when `?room=<id>` is present on the URL.
 *
 * @see party/relay.ts — server
 * @see ./protocol.ts — control-message shapes
 * @see ./input-frame.ts — binary frame codec
 */
import PartySocket from 'partysocket'

import {
  decodeInputFrame,
  encodeInputFrame,
  INPUT_FRAME_BYTES,
  type InputFrame,
} from './input-frame'
import type { ServerControlMessage } from './protocol'

export type NetRoomConfig = {
  /** PartyKit host. In dev: 'localhost:1999'. In prod: '<project>.<user>.partykit.dev'. */
  host: string
  /** Room identifier. All peers in the same room id see each other's frames. */
  roomId: string
  /** Called when a remote peer's InputFrame arrives. */
  onRemoteFrame?: (frame: InputFrame) => void
  /** Called when another peer joins the room (after we did). */
  onPeerJoined?: (peerId: number) => void
  /** Called when another peer leaves. */
  onPeerLeft?: (peerId: number) => void
  /** Called when the server assigns us our slot. */
  onConnected?: (myPeerId: number, otherPeers: readonly number[]) => void
  /** Called when the server reports the room is full. */
  onRoomFull?: () => void
}

export type NetRoom = {
  /** Our peer slot, or -1 before the server's hello message arrives. */
  readonly peerId: number
  /** True once we have a slot and the socket is OPEN. Frames sent before
   *  this point are silently dropped — `simulateStep` keeps stepping
   *  locally so the loop never blocks on the network. */
  readonly ready: boolean
  /** Slots currently held by remote peers. Live — mutated on join/leave. */
  readonly remotePeers: readonly number[]
  sendFrame(frame: InputFrame): void
  close(): void
}

/**
 * Hand-coded WebSocket layout matcher for control messages. We don't pull
 * in a schema validator at the client — the payloads are tiny and the
 * server-side type is the single source of truth. Anything we don't
 * recognise is logged and dropped.
 */
function parseControl(text: string): ServerControlMessage | null {
  try {
    const obj = JSON.parse(text)
    if (obj && typeof obj === 'object' && typeof obj.type === 'string') {
      return obj as ServerControlMessage
    }
  } catch {
    // fall through
  }
  return null
}

export function createNetRoom(cfg: NetRoomConfig): NetRoom {
  // Reusable encode buffer — one alloc instead of N/tick. Note we DON'T
  // share the buffer with main.ts's sim-loop view; that one is decoded
  // back into an Intent the moment after it's written, so it's free
  // again. This one is held for the duration of the send().
  const sendBuf = new Uint8Array(INPUT_FRAME_BYTES)

  let myPeerId = -1
  let socketOpen = false
  const remotePeers = new Set<number>()

  const socket = new PartySocket({
    host: cfg.host,
    room: cfg.roomId,
  })
  socket.binaryType = 'arraybuffer'

  socket.addEventListener('open', () => {
    socketOpen = true
  })
  socket.addEventListener('close', () => {
    socketOpen = false
    myPeerId = -1
    remotePeers.clear()
  })

  socket.addEventListener('message', (event: MessageEvent) => {
    const data = event.data
    if (typeof data === 'string') {
      const msg = parseControl(data)
      if (!msg) return
      switch (msg.type) {
        case 'hello':
          myPeerId = msg.peerId
          remotePeers.clear()
          for (const p of msg.otherPeers) remotePeers.add(p)
          cfg.onConnected?.(msg.peerId, [...remotePeers])
          break
        case 'peer-joined':
          remotePeers.add(msg.peerId)
          cfg.onPeerJoined?.(msg.peerId)
          break
        case 'peer-left':
          remotePeers.delete(msg.peerId)
          cfg.onPeerLeft?.(msg.peerId)
          break
        case 'room-full':
          cfg.onRoomFull?.()
          break
      }
      return
    }
    if (data instanceof ArrayBuffer) {
      cfg.onRemoteFrame?.(decodeInputFrame(data))
    }
  })

  function ready(): boolean {
    return socketOpen && myPeerId >= 0
  }

  return {
    get peerId() {
      return myPeerId
    },
    get ready() {
      return ready()
    },
    get remotePeers() {
      return [...remotePeers]
    },
    sendFrame(frame: InputFrame) {
      if (!ready()) return
      const encoded = encodeInputFrame(frame)
      sendBuf.set(encoded)
      // partysocket's send accepts ArrayBuffer/Uint8Array directly.
      socket.send(sendBuf)
    },
    close() {
      socket.close()
    },
  }
}
