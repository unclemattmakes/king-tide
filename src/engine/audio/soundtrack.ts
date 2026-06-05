/**
 * Soundtrack radio — the licensed-music jukebox that rides the audio
 * engine's music bus. Plays the commissioned tracks (see
 * `soundtrack.generated.ts`, built by `pnpm gen:music`) in a shuffled,
 * gapless-looping rotation across menus and races, EA-Trax style.
 *
 * **Why an <audio> element, not decodeAudioData**
 *
 * The per-track palette loader in [audio.ts](./audio.ts) decodes short
 * loops fully into AudioBuffers. Full songs are 2–4 MB Opus / multiple
 * minutes; decoding one to PCM is ~140 MB of float samples. Instead the
 * jukebox streams via an `HTMLAudioElement` routed through a single
 * `MediaElementAudioSourceNode` into the music bus — progressive download,
 * near-instant start, flat memory. The bus still owns volume + the
 * wave-pump/explosion sidechain duck, so the radio ducks for free.
 *
 * Node ownership stays in `audio.ts` (it owns the AudioContext + bus); this
 * module is the thin controller it instantiates once the context unlocks.
 * The pure list helpers (`makeShuffleOrder`) are exported separately so the
 * rotation logic is unit-testable without a DOM / Web Audio.
 */

import { assetUrl } from '@/engine/asset-url'

/** One licensed track. `file` is a basename under `public/audio/music/`. */
export interface SoundtrackEntry {
  file: string
  artist: string
  title: string
}

/**
 * Fisher–Yates shuffle of `[0, n)`. `rand` is injectable so tests can pin
 * the order; defaults to `Math.random`. Returns a fresh array (never
 * mutates a caller's).
 */
export function makeShuffleOrder(n: number, rand: () => number = Math.random): number[] {
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = order[i]!
    order[i] = order[j]!
    order[j] = tmp
  }
  return order
}

/**
 * Produce the next rotation when the current shuffle is exhausted. Returns
 * a reshuffled order whose first element is guaranteed not to repeat the
 * track that just finished (`lastTrack`), so a wrap never plays the same
 * song twice back-to-back. With <2 tracks the constraint is impossible and
 * is dropped. Pure — `rand` injectable for tests.
 */
export function reshuffleAvoiding(
  n: number,
  lastTrack: number,
  rand: () => number = Math.random,
): number[] {
  if (n <= 1) return makeShuffleOrder(n, rand)
  let order = makeShuffleOrder(n, rand)
  // Bounded retries — with n ≥ 2 a non-repeating first element exists, and
  // the expected number of reshuffles is ~1.
  for (let guard = 0; order[0] === lastTrack && guard < 16; guard++) {
    order = makeShuffleOrder(n, rand)
  }
  return order
}

const MUSIC_BASE_URL = '/audio/music/'

export interface Jukebox {
  /** Replace the rotation. Safe to call before or after playback starts. */
  setPlaylist(tracks: readonly SoundtrackEntry[]): void
  /** Start (first call) or resume (after `pause`) playback, if enabled and
   *  a non-empty playlist is loaded. No-op otherwise. Idempotent. */
  play(): void
  /** Pause without losing position — e.g. while a per-track licensed loop
   *  takes over the music bus. */
  pause(): void
  /** Master on/off, mirrors the music-enabled setting. */
  setEnabled(enabled: boolean): void
  /** Skip to the next shuffled track immediately. */
  next(): void
  /** The entry currently playing, or null before playback / after failure. */
  current(): SoundtrackEntry | null
  /** True when ≥1 track is loaded (i.e. real licensed music is available,
   *  vs. falling back to the procedural pad bed). */
  hasTracks(): boolean
  dispose(): void
}

export interface JukeboxOptions {
  ctx: AudioContext
  /** The music bus to feed (volume + duck live here). */
  destination: AudioNode
  /** Live read of the music-enabled setting. */
  getEnabled: () => boolean
  /** Fired when a new song begins (drives the credit toast). Null on
   *  total failure (every source errored). */
  onSongChange: (entry: SoundtrackEntry | null) => void
  /** Injectable RNG for deterministic tests. */
  rand?: () => number
}

export function createJukebox(opts: JukeboxOptions): Jukebox {
  const { ctx, destination, getEnabled, onSongChange } = opts
  const rand = opts.rand ?? Math.random

  let playlist: readonly SoundtrackEntry[] = []
  let order: number[] = []
  let pos = 0 // index into `order`
  let el: HTMLAudioElement | null = null
  let source: MediaElementAudioSourceNode | null = null
  let started = false
  let currentEntry: SoundtrackEntry | null = null
  let consecutiveErrors = 0

  function ensureElement(): HTMLAudioElement {
    if (el) return el
    el = new Audio()
    // Music streams from a cross-origin CDN (Cloudflare R2) in prod. Without
    // crossOrigin="anonymous", media routed through createMediaElementSource
    // below is tainted and the Web Audio graph outputs silence. Harmless for
    // same-origin dev; requires CORS headers on the asset host.
    el.crossOrigin = 'anonymous'
    el.preload = 'auto'
    el.loop = false // we advance manually so each start fires a credit
    // Same-origin files; routing through Web Audio means the element's
    // output goes only through the graph (bus volume / mute / duck apply).
    source = ctx.createMediaElementSource(el)
    source.connect(destination)
    el.addEventListener('ended', () => advance())
    el.addEventListener('error', () => {
      // Source failed (404, unsupported, decode). Skip on — but if every
      // track fails, stop and signal so the engine can keep the bed.
      consecutiveErrors++
      if (consecutiveErrors >= Math.max(1, playlist.length)) {
        currentEntry = null
        onSongChange(null)
        return
      }
      advance()
    })
    return el
  }

  function loadAndPlay(orderPos: number): void {
    if (playlist.length === 0) return
    pos = ((orderPos % order.length) + order.length) % order.length
    const trackIndex = order[pos]!
    const entry = playlist[trackIndex]!
    const audio = ensureElement()
    audio.src = assetUrl(MUSIC_BASE_URL + entry.file)
    currentEntry = entry
    onSongChange(entry)
    // play() can reject under autoplay policy; we only call it post-gesture,
    // but swallow rejections defensively so a transient block isn't fatal.
    audio.play().catch(() => {})
  }

  function advance(): void {
    if (!getEnabled() || playlist.length === 0) return
    const lastTrack = order[pos]!
    if (pos + 1 >= order.length) {
      order = reshuffleAvoiding(playlist.length, lastTrack, rand)
      loadAndPlay(0)
    } else {
      loadAndPlay(pos + 1)
    }
  }

  return {
    setPlaylist(tracks) {
      playlist = tracks
      order = makeShuffleOrder(playlist.length, rand)
      pos = 0
      consecutiveErrors = 0
    },

    play() {
      if (!getEnabled() || playlist.length === 0) return
      if (!started) {
        started = true
        loadAndPlay(0)
      } else if (el && el.paused) {
        el.play().catch(() => {})
      }
    },

    pause() {
      el?.pause()
    },

    setEnabled(enabled) {
      if (enabled) this.play()
      else this.pause()
    },

    next() {
      if (!started) {
        this.play()
        return
      }
      advance()
    },

    current() {
      return currentEntry
    },

    hasTracks() {
      return playlist.length > 0
    },

    dispose() {
      if (el) {
        el.pause()
        el.removeAttribute('src')
      }
      try {
        source?.disconnect()
      } catch {
        // already disconnected
      }
      el = null
      source = null
      started = false
      currentEntry = null
    },
  }
}
