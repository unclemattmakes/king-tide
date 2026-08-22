/**
 * Procedural audio for the hoverbike. Web Audio API directly; no asset
 * pipeline, no library — every sound is synthesised from oscillators and
 * filtered noise so the build stays bundler-friendly and we can iterate
 * tunings in code.
 *
 * **Bus layout**
 *
 *   sources → music | sfx | ambient → master → destination
 *
 * The four-bus split mirrors the player-facing Settings → Audio sliders
 * (master / music / SFX / ambient + mute). Per-bus gains are signed
 * 0..1 and stored on `playerSettings.audio*Volume`, persisted via the
 * usual `savePlayerSettings()` path. Routing each one-shot through its
 * proper bus is the difference between "sliders that do nothing" and
 * "sliders that actually shape the mix".
 *
 * **Music + ducking**
 *
 * The licensed soundtrack radio (the jukebox in `soundtrack.ts`) rides
 * the music bus and is the default music source once real tracks are
 * loaded via `setSoundtrack`. A subtle procedural pad bed stays wired
 * as the no-assets fallback (and for headless/test paths) — it's
 * silenced whenever the jukebox or a per-track licensed loop owns the
 * bus. The `duckMusic` helper briefly dips the whole music bus on big
 * SFX (wave-pump chime, explosion) so the cue cuts through; because the
 * jukebox feeds the same bus, it ducks for free.
 *
 * Continuous layers (engine + wind + water ambient) are looping nodes
 * built once on first unlock; one-shots (pickup chimes, weapon SFX,
 * explosions) are short-lived nodes that schedule their own envelopes
 * and self-disconnect.
 *
 * Browser AudioContext requires a user gesture before producing sound,
 * so the context is created lazily on `resume()` (called from a keydown
 * / pointerdown listener). Until then every method is a safe no-op.
 * That same property keeps headless test environments quiet without
 * crashing.
 */

import { assetUrl } from '@/engine/asset-url'
import { playerSettings } from '@/engine/player-settings'
import type { AudioConfig } from '@/game/tracks/types'
import { createJukebox, type Jukebox, type SoundtrackEntry } from './soundtrack'

export type PickupSoundType = 'boost' | 'shield' | 'missile' | 'mine'
export type AudioBus = 'master' | 'music' | 'sfx' | 'ambient'

/** Spatial placement for a one-shot: `gain` ∈ [0,1] distance
 *  attenuation, `pan` ∈ [-1,1] stereo position. Omitted = at the
 *  listener, full volume, centered (the pre-spatial behavior). */
export type SpatialCue = { gain: number; pan: number }

/** Within this distance (m) of the listener a one-shot plays at full
 *  volume. The listener is the CHASE CAMERA, which trails the player's
 *  bike by ~4-12 m — without the plateau, the player's own ordnance
 *  (and a mine at their wheel) would be quietly attenuated by their
 *  own camera rig. */
export const SPATIAL_NEAR_FULL_M = 12

/** Falloff scale (m) past the near-field: gain halves REF meters
 *  beyond `SPATIAL_NEAR_FULL_M`. At 300 m an AI mine is a distant
 *  ~12% thump instead of a full-volume bang. */
export const SPATIAL_REF_DISTANCE_M = 40

/** Pan authority — full hard-pan sounds broken on headphones, so the
 *  lateral component maps onto ±0.8. */
const SPATIAL_PAN_MAX = 0.8

/**
 * Pure spatializer: distance gain + stereo pan for an emitter heard
 * from a listener with the given right-vector (camera right, world
 * space). Kept Three-free (plain vectors) so the render loop can feed
 * it camera state and unit tests can pin the math.
 */
export function spatialCueFor(
  emitter: { x: number; y: number; z: number },
  listener: { x: number; y: number; z: number },
  listenerRight: { x: number; y: number; z: number },
  refDistance = SPATIAL_REF_DISTANCE_M,
): SpatialCue {
  const dx = emitter.x - listener.x
  const dy = emitter.y - listener.y
  const dz = emitter.z - listener.z
  const dist = Math.hypot(dx, dy, dz)
  const gain = 1 / (1 + Math.max(0, dist - SPATIAL_NEAR_FULL_M) / refDistance)
  if (dist < 0.001) return { gain: 1, pan: 0 }
  const lateral = (dx * listenerRight.x + dy * listenerRight.y + dz * listenerRight.z) / dist
  const pan = Math.max(-1, Math.min(1, lateral)) * SPATIAL_PAN_MAX
  return { gain, pan }
}

/** One rival engine voice's per-frame drive values. `pitch01` is the
 *  rival's speed as a fraction of top speed. `snap` marks a slot whose
 *  occupant changed this frame: the voice re-seats at the new values
 *  (quick fade-in from silence) instead of gliding one engine tone
 *  between two unrelated bikes' pan/pitch. */
export type RivalEngineDrive = { gain: number; pan: number; pitch01: number; snap?: boolean }

export interface AudioEngine {
  /** Resume the AudioContext, creating it on first call. Call from a
   *  user-gesture listener. Safe to call repeatedly. */
  resume(): Promise<void>
  /** True once the AudioContext exists AND is actually running —
   *  autoplay policy can leave a freshly-created context `suspended`
   *  until a gesture, and one-shots scheduled against a suspended
   *  context pile up at a frozen clock and play as a garbled cluster
   *  whenever it later resumes. Gate ceremony cues on this. */
  isUnlocked(): boolean
  setMuted(muted: boolean): void
  isMuted(): boolean
  /** Set a per-bus linear volume ∈ [0,1]. The bus stays at this value
   *  until set again; called by the Settings overlay slider. Tracks
   *  `playerSettings.audio<Bus>Volume` for persistence. */
  setBusVolume(bus: AudioBus, volume: number): void
  /** Enable / disable the music layer. Pauses / resumes the soundtrack
   *  radio and silences the fallback pad bed; the bus stays routed
   *  either way. */
  setMusicEnabled(enabled: boolean): void
  /** Ducks the music bus down by `amount` ∈ [0,1] for `recoverSeconds`,
   *  then ramps back to the current bus level. Used by wave-pump +
   *  explosion to let the cue cut through. */
  duckMusic(amount: number, recoverSeconds: number): void
  /** Continuous: drives engine pitch + wind volume from the player bike
   *  speed. Call once per render frame. */
  tickEngine(speed: number): void
  /** Continuous: drives the drift-skid scrape loop's level. Caller
   *  passes 0..1 every render frame — typically `0` when the bike
   *  isn't drifting and `speed / topSpeed` while a drift is active.
   *  Internally smoothed via `setTargetAtTime` so toggling on/off
   *  fades instead of clicking. */
  driftSkid(intensity: number): void
  /** One-shot: fires when a player drift releases with a charged
   *  mini-turbo. `tier` (1/2/3) drives the bell pitch + whoosh
   *  brightness so blue MT, orange SMT, and purple UMT each read
   *  as distinct payoffs. */
  driftBoost(tier: number): void
  /** A bike (any bike) just put a pickup into its slot. */
  pickupCollect(): void
  /** A bike (any bike) just consumed its slot. `type` selects the SFX.
   *  `spatial` places the one-shot in the stereo field with distance
   *  attenuation — pass it for world-emitted ordnance (AI mines,
   *  missiles) so a spawn 300 m away reads as a distant thump with a
   *  direction instead of a full-volume bang. */
  pickupFire(type: PickupSoundType, spatial?: SpatialCue): void
  /** A new explosion entity just spawned (mine or missile detonation).
   *  `spatial` attenuates + pans it, and scales the music duck the
   *  same way — a far-off detonation shouldn't dip the soundtrack. */
  explosion(spatial?: SpatialCue): void
  /** Continuous: drives the rival engine voice pool (the nearest 2
   *  opponents) — per-voice gain/pan/pitch each render frame. Pass an
   *  empty array (or fewer entries than voices) to fade unused voices
   *  out. A rival on your tail finally *sounds* like one. */
  tickRivalEngines(rivals: readonly RivalEngineDrive[]): void
  /** The player just crossed a checkpoint (any but the lap-completion one). */
  gateCleared(): void
  /** The player just completed a lap. */
  lapCompleted(): void
  /** Pre-race countdown tick (3/2/1) and GO (0) — a dedicated rising
   *  beep ladder in the race-structure (C-major) family instead of the
   *  recycled gate ding. */
  countdownTick(n: number): void
  /** Score the finish — the emotional peak of the race, previously
   *  mute. `kind` picks the shape: 'win' full fanfare, 'podium' bright
   *  triad, 'finish' modest resolve, 'dnf' low neutral. Fired when the
   *  results screen reveals. */
  finishStinger(kind: 'win' | 'podium' | 'finish' | 'dnf'): void
  /** Cup ceremony fanfare — the podium scene's big brass moment. */
  cupFanfare(): void
  /** Boost ignition — meter vents and pad hits. Its own voice in the
   *  drift-whoosh family, so the wave-mastery chord (`wavePump`) stays
   *  reserved for graded launches/landings/tricks: the signature sound
   *  means "you read the water", never "you touched a pad". `charge`
   *  0..1 scales punch (pads pass 1). */
  boostIgnite(charge: number): void
  /** The player just completed a wave pump. `strength` is 0..1 — the
   *  audio engine scales the cue's gain + adds an upper-octave layer
   *  on strong pumps so a clean crest launch reads louder + brighter
   *  than a marginal one. The positive-feedback layer (per the v1
   *  work-breakdown) is the chord shape itself: stacked perfect 5th +
   *  octave rather than a single ping. `perfect` upgrades the cue
   *  with a brighter top-octave + a higher noise sweep so the
   *  trick tier reads at a glance. */
  wavePump(strength: number, perfect?: boolean): void
  /** Apply a per-track audio palette. Called once at boot after
   *  the AudioEngine + Track are both available; replaces any
   *  previously-set track audio (stop+release of prior music/ambient
   *  layers). Pass `undefined` to clear back to the procedural pad
   *  bed + ambient water rumble only. Audio files load lazily;
   *  missing files (404) warn and fall back gracefully. */
  setTrackAudio(config: AudioConfig | undefined): void
  /** Provide the licensed soundtrack rotation (the shuffle radio that
   *  plays across menus + races). Once ≥1 track loads the radio
   *  supersedes the procedural pad bed; an empty list keeps the bed as
   *  the fallback. Safe to call before the AudioContext exists — it's
   *  buffered and applied on first unlock. */
  setSoundtrack(tracks: readonly SoundtrackEntry[]): void
  /** Subscribe to soundtrack song changes — fires when each song begins,
   *  driving the now-playing credit toast. Fires with `null` on total
   *  playback failure (every source errored). Single subscriber; the
   *  latest call wins. */
  onSongChange(cb: (entry: SoundtrackEntry | null) => void): void
  /** Skip to the next song in the soundtrack rotation. */
  nextSong(): void
}

/** Per-bus headroom — the bus's slider value is multiplied by this
 *  scalar before being applied to the GainNode. Keeps a sane mix
 *  ceiling at slider=1.0 instead of pinning to 0dB and clipping. */
const BUS_HEADROOM: Readonly<Record<AudioBus, number>> = Object.freeze({
  master: 0.6,
  music: 0.45,
  sfx: 1.0,
  ambient: 0.6,
})

const TOP_SPEED_FOR_AUDIO = 28 // matches BikeStats.topSpeed roughly

/** Rival engine voices in the pool (nearest-N opponents get one each).
 *  Exported so the game-loop's slot pool sizes itself from the same
 *  number — bumping the pool here grows both sides together. */
export const RIVAL_ENGINE_VOICES = 2

type RivalVoice = {
  osc: OscillatorNode
  panner: StereoPannerNode
  gain: GainNode
  /** True once silence has been commanded — skips re-scheduling zero
   *  every frame in rival-less modes. */
  silenced: boolean
}

export function createAudioEngine(): AudioEngine {
  let ctx: AudioContext | null = null
  let masterGain: GainNode | null = null
  let musicBus: GainNode | null = null
  let sfxBus: GainNode | null = null
  let ambientBus: GainNode | null = null
  let muted = false
  let musicEnabled = true
  const rivalVoices: RivalVoice[] = []
  // Active music-duck bookkeeping for the keep-the-deeper rule in
  // duckMusicInternal.
  let activeDuckAmount = 0
  let activeDuckUntil = 0

  // Music bed nodes — held so setMusicEnabled can stop/restart them and
  // so a future licensed-music swap can disconnect just these.
  let musicBedNodes: { osc: OscillatorNode; lfo: OscillatorNode }[] = []
  let musicBedGain: GainNode | null = null

  // Continuous layers, set up once on first unlock.
  let engineOsc: OscillatorNode | null = null
  let engineSubOsc: OscillatorNode | null = null
  let engineFilter: BiquadFilterNode | null = null
  let engineGain: GainNode | null = null
  let windFilter: BiquadFilterNode | null = null
  let windGain: GainNode | null = null
  // Drift-skid continuous layer: filtered noise band-passed in the
  // ~2.6 kHz range for a "scraping" character. Per-frame intensity
  // (0..1) is multiplied into `driftSkidGain` via setTargetAtTime
  // so the loop fades cleanly when drift starts / ends. Started
  // once on first unlock; intensity 0 = effectively muted.
  let driftSkidFilter: BiquadFilterNode | null = null
  let driftSkidGain: GainNode | null = null

  // Per-track audio palette state. Held so the boot wiring can swap
  // tracks at runtime (track-change, return-to-menu, replays) without
  // leaking nodes. `pendingTrackAudio` is set when setTrackAudio runs
  // before the AudioContext exists — we apply it once the user
  // gesture unlocks the engine.
  let trackMusic: { source: AudioBufferSourceNode; gain: GainNode } | null = null
  let trackAmbient: { source: AudioBufferSourceNode; gain: GainNode }[] = []
  let trackAudioConfig: AudioConfig | undefined
  let pendingTrackAudio: { config: AudioConfig | undefined } | null = null
  const decodedAudioCache = new Map<string, AudioBuffer | null>()

  // Soundtrack radio — the licensed-music jukebox on the music bus.
  // `jukebox` is created on first unlock (it needs the AudioContext);
  // `soundtrack` holds the playlist set before that. `trackMusicActive`
  // is true while a per-track licensed loop owns the music bus, so the
  // jukebox stays paused and doesn't double up. `songChangeCb` drives
  // the now-playing credit toast.
  let jukebox: Jukebox | null = null
  let soundtrack: readonly SoundtrackEntry[] = []
  let trackMusicActive = false
  let songChangeCb: ((entry: SoundtrackEntry | null) => void) | null = null

  function busLevel(bus: AudioBus): number {
    const v =
      bus === 'master'
        ? playerSettings.audioMasterVolume
        : bus === 'music'
          ? playerSettings.audioMusicVolume
          : bus === 'sfx'
            ? playerSettings.audioSfxVolume
            : playerSettings.audioAmbientVolume
    return Math.max(0, Math.min(1, v)) * BUS_HEADROOM[bus]
  }

  function ensureContext(): AudioContext | null {
    if (ctx) return ctx
    try {
      const Ctx =
        (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return null
      ctx = new Ctx()
    } catch {
      return null
    }

    // Bus layout — sources go to one of music/sfx/ambient, which all
    // feed master, which feeds a safety limiter, which feeds
    // destination. Each bus is read from
    // `playerSettings.audio<Bus>Volume` × `BUS_HEADROOM[bus]` so the
    // Settings sliders shape the mix without needing a re-wire.
    //
    // The limiter is a two-line insurance policy: SFX headroom is 1.0
    // and one-shots stack (explosion 0.55 + wave chord ~0.5 + engine +
    // wind + skid in 8-bike item chaos), so nothing else *guarantees*
    // the master stays under 0 dB. Gentle brick-wall settings — it
    // only engages on genuine pile-ups.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -3
    limiter.knee.value = 6
    limiter.ratio.value = 16
    limiter.attack.value = 0.002
    limiter.release.value = 0.25
    limiter.connect(ctx.destination)
    masterGain = ctx.createGain()
    masterGain.gain.value = muted ? 0 : busLevel('master')
    masterGain.connect(limiter)
    musicBus = ctx.createGain()
    musicBus.gain.value = busLevel('music')
    musicBus.connect(masterGain)
    sfxBus = ctx.createGain()
    sfxBus.gain.value = busLevel('sfx')
    sfxBus.connect(masterGain)
    ambientBus = ctx.createGain()
    ambientBus.gain.value = busLevel('ambient')
    ambientBus.connect(masterGain)

    // Engine + wind ride the SFX bus (they're bike-driven cues, not
    // ambient environmental beds).
    engineOsc = ctx.createOscillator()
    engineOsc.type = 'sawtooth'
    engineOsc.frequency.value = 60
    engineSubOsc = ctx.createOscillator()
    engineSubOsc.type = 'sine'
    engineSubOsc.frequency.value = 30
    engineFilter = ctx.createBiquadFilter()
    engineFilter.type = 'lowpass'
    engineFilter.frequency.value = 900
    engineFilter.Q.value = 1.4
    engineGain = ctx.createGain()
    engineGain.gain.value = 0.05
    engineOsc.connect(engineFilter)
    engineSubOsc.connect(engineFilter)
    engineFilter.connect(engineGain)
    engineGain.connect(sfxBus)
    engineOsc.start()
    engineSubOsc.start()

    // Rival engine voice pool — the nearest opponents get a cheap
    // LOD'd engine loop each (single saw through a lowpass, panned).
    // Idle at zero gain; `tickRivalEngines` drives gain/pan/pitch per
    // frame. Two voices covers "who's on my tail" without turning an
    // 8-bike grid into a beehive.
    for (let i = 0; i < RIVAL_ENGINE_VOICES; i++) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = 70
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 700
      filter.Q.value = 1.1
      const panner = ctx.createStereoPanner()
      const gain = ctx.createGain()
      gain.gain.value = 0
      osc.connect(filter)
      filter.connect(panner)
      panner.connect(gain)
      gain.connect(sfxBus)
      osc.start()
      rivalVoices.push({ osc, panner, gain, silenced: true })
    }

    // Wind: looping white-noise buffer through a bandpass — opens up
    // with speed. Also SFX (bike-coupled). Same shared buffer the
    // one-shots slice.
    const noiseBuffer = sharedNoiseBuffer(ctx)
    const windNoise = ctx.createBufferSource()
    windNoise.buffer = noiseBuffer
    windNoise.loop = true
    windFilter = ctx.createBiquadFilter()
    windFilter.type = 'bandpass'
    windFilter.frequency.value = 1500
    windFilter.Q.value = 0.7
    windGain = ctx.createGain()
    windGain.gain.value = 0
    windNoise.connect(windFilter)
    windFilter.connect(windGain)
    windGain.connect(sfxBus)
    windNoise.start()

    // Drift skid — looping noise through a tight bandpass at ~2.6 kHz
    // for a tyre-scrape character. Distinct band from wind (1.5 kHz)
    // so the two layers don't mask each other when drifting at speed.
    // Idle at zero gain; `driftSkid(intensity)` ramps in/out.
    const driftNoise = ctx.createBufferSource()
    driftNoise.buffer = noiseBuffer
    driftNoise.loop = true
    driftSkidFilter = ctx.createBiquadFilter()
    driftSkidFilter.type = 'bandpass'
    driftSkidFilter.frequency.value = 2600
    driftSkidFilter.Q.value = 1.4
    driftSkidGain = ctx.createGain()
    driftSkidGain.gain.value = 0
    driftNoise.connect(driftSkidFilter)
    driftSkidFilter.connect(driftSkidGain)
    driftSkidGain.connect(sfxBus)
    driftNoise.start()

    // Ambient water: filtered low rumble, fixed quiet level. Rides
    // the ambient bus.
    const ambNoise = ctx.createBufferSource()
    ambNoise.buffer = noiseBuffer
    ambNoise.loop = true
    const ambFilter = ctx.createBiquadFilter()
    ambFilter.type = 'lowpass'
    ambFilter.frequency.value = 380
    ambFilter.Q.value = 0.5
    const ambientGain = ctx.createGain()
    ambientGain.gain.value = 0.08
    ambNoise.connect(ambFilter)
    ambFilter.connect(ambientGain)
    ambientGain.connect(ambientBus)
    ambNoise.start()

    // Procedural music bed — simple slow sine pad with a sub osc + a
    // tremolo LFO. Intentionally bland; this is the hook for the real
    // music drop (M11–12). `setMusicEnabled(false)` mutes it via
    // musicBedGain; the bed nodes keep running so re-enable is free.
    // Honor the persisted enable flag on first unlock.
    musicEnabled = playerSettings.audioMusicEnabled
    musicBedGain = ctx.createGain()
    musicBedGain.gain.value = musicEnabled ? 1 : 0
    musicBedGain.connect(musicBus)
    musicBedNodes = buildMusicBed(ctx, musicBedGain)

    // Soundtrack radio — streams the licensed tracks through the music
    // bus. Created here (it needs the live context); fed the playlist
    // buffered by setSoundtrack before unlock. Supersedes the bed when
    // real tracks are present (see restoreDefaultMusic).
    jukebox = createJukebox({
      ctx,
      destination: musicBus,
      getEnabled: () => musicEnabled,
      onSongChange: (entry) => songChangeCb?.(entry),
    })
    jukebox.setPlaylist(soundtrack)

    // If setTrackAudio was called before the context existed (the
    // boot path: track loads while the user hasn't pressed a key
    // yet), apply the buffered config now — it decides bed vs. jukebox
    // vs. per-track loop. Otherwise start the default music source.
    if (pendingTrackAudio) {
      const { config } = pendingTrackAudio
      pendingTrackAudio = null
      // Fire-and-forget — load failures don't block the rest of boot.
      void applyTrackAudioToContext(ctx, config)
    } else {
      restoreDefaultMusic()
    }

    return ctx
  }

  function duckMusicInternal(amount: number, recoverSeconds: number): void {
    if (!ctx || !musicBus) return
    const now = ctx.currentTime
    // Keep-the-deeper rule: this used to be last-caller-wins
    // (cancel + ramp to the new target), which let a DISTANT
    // explosion's shallow spatial duck cancel a near one's deep duck
    // and audibly pop the music back up while the player's own boom
    // was still ringing. A shallower duck arriving while a deeper one
    // is still active is ignored; a deeper (or later-recovering-equal)
    // one takes over.
    const clamped = Math.max(0, Math.min(1, amount))
    if (now < activeDuckUntil && clamped < activeDuckAmount) return
    activeDuckAmount = clamped
    activeDuckUntil = now + 0.04 + Math.max(0.05, recoverSeconds)
    const base = busLevel('music')
    const ducked = base * (1 - clamped)
    musicBus.gain.cancelScheduledValues(now)
    musicBus.gain.setValueAtTime(musicBus.gain.value, now)
    musicBus.gain.linearRampToValueAtTime(ducked, now + 0.04)
    musicBus.gain.linearRampToValueAtTime(base, activeDuckUntil)
  }

  /** Resolve the per-track pump-duck multiplier. Defaults to 1.0
   *  (i.e. the engine's base 0.35 duck amount is unchanged) when no
   *  track-level override is set. */
  function trackDuckMultiplier(): number {
    const m = trackAudioConfig?.music3dEffects?.duckOnPump
    return typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m : 1
  }

  /** Route the default (non-per-track) music source. When a real
   *  soundtrack is loaded the jukebox is the music and the procedural bed
   *  stays silent; otherwise the bed plays per the music-enabled flag.
   *  Called on unlock and whenever a per-track licensed loop clears. */
  function restoreDefaultMusic(): void {
    trackMusicActive = false
    if (jukebox?.hasTracks()) {
      if (musicBedGain) musicBedGain.gain.value = 0
      jukebox.play() // no-op when music is disabled
    } else if (musicBedGain) {
      musicBedGain.gain.value = musicEnabled ? 1 : 0
    }
  }

  async function loadAudioBuffer(c: AudioContext, url: string): Promise<AudioBuffer | null> {
    if (decodedAudioCache.has(url)) return decodedAudioCache.get(url) ?? null
    try {
      const res = await fetch(url)
      if (!res.ok) {
        // 404 etc. — expected while licensed audio is still pending.
        // Warn once and cache the miss so we don't refetch on
        // track-change.
        console.warn(`[audio] fetch ${url} returned ${res.status}; falling back`)
        decodedAudioCache.set(url, null)
        return null
      }
      const bytes = await res.arrayBuffer()
      const buf = await c.decodeAudioData(bytes.slice(0))
      decodedAudioCache.set(url, buf)
      return buf
    } catch (e) {
      console.warn(`[audio] failed to load ${url}: ${(e as Error).message}`)
      decodedAudioCache.set(url, null)
      return null
    }
  }

  function stopTrackAudio(): void {
    if (trackMusic) {
      try {
        trackMusic.source.stop()
      } catch {
        // Already stopped — safe.
      }
      try {
        trackMusic.source.disconnect()
        trackMusic.gain.disconnect()
      } catch {
        // Disconnected — safe.
      }
      trackMusic = null
    }
    for (const layer of trackAmbient) {
      try {
        layer.source.stop()
      } catch {
        // Already stopped — safe.
      }
      try {
        layer.source.disconnect()
        layer.gain.disconnect()
      } catch {
        // Disconnected — safe.
      }
    }
    trackAmbient = []
  }

  async function applyTrackAudioToContext(
    c: AudioContext,
    config: AudioConfig | undefined,
  ): Promise<void> {
    stopTrackAudio()
    trackAudioConfig = config
    if (!config) {
      // Cleared — restore the default music source (jukebox or bed).
      restoreDefaultMusic()
      return
    }
    // Music: when a per-track licensed loop is present + reachable, it
    // takes over the music bus — silence the bed and pause the
    // soundtrack radio so they don't double up. When absent or 404,
    // fall back to the default source (radio if loaded, else bed) —
    // that's the documented graceful-degrade contract.
    if (config.music && musicBus) {
      const url = assetUrl(`/audio/music/${config.music}`)
      const buf = await loadAudioBuffer(c, url)
      if (buf) {
        const source = c.createBufferSource()
        source.buffer = buf
        source.loop = true
        const gain = c.createGain()
        gain.gain.value = 1
        source.connect(gain)
        gain.connect(musicBus)
        try {
          source.start()
        } catch {
          // start() throws if called twice — defensive only.
        }
        trackMusic = { source, gain }
        // Per-track loop owns the bus: silence the bed, pause the radio.
        if (musicBedGain) musicBedGain.gain.value = 0
        trackMusicActive = true
        jukebox?.pause()
      } else {
        restoreDefaultMusic()
      }
    } else {
      restoreDefaultMusic()
    }
    // Ambient layers — load + play each in parallel.
    if (config.ambient && config.ambient.length > 0 && ambientBus) {
      const ambBus = ambientBus
      await Promise.all(
        config.ambient.map(async (name, i) => {
          const url = assetUrl(`/audio/ambient/${name}`)
          const buf = await loadAudioBuffer(c, url)
          if (!buf) return
          const source = c.createBufferSource()
          source.buffer = buf
          source.loop = true
          const layerGain = config.ambientGains?.[i]
          const g = c.createGain()
          g.gain.value =
            typeof layerGain === 'number' && Number.isFinite(layerGain) && layerGain >= 0
              ? layerGain
              : 1
          source.connect(g)
          g.connect(ambBus)
          try {
            source.start()
          } catch {
            // start() throws if called twice — defensive only.
          }
          trackAmbient.push({ source, gain: g })
        }),
      )
    }
  }

  return {
    isUnlocked() {
      return ctx !== null && ctx.state === 'running'
    },

    async resume() {
      const c = ensureContext()
      if (c && c.state === 'suspended') {
        try {
          await c.resume()
        } catch {
          // Some headless / blocked-context environments reject the
          // resume promise. Treat as a soft failure — every other
          // method is a no-op without a running context.
        }
      }
      // Resume the soundtrack radio after a suspend (Steam Deck sleep,
      // mobile lock-screen). No-op if music is disabled or already
      // playing; skipped while a per-track loop owns the bus.
      if (c && !trackMusicActive) jukebox?.play()
    },

    setMuted(m: boolean) {
      muted = m
      if (masterGain && ctx) {
        masterGain.gain.setTargetAtTime(m ? 0 : busLevel('master'), ctx.currentTime, 0.05)
      }
    },

    isMuted() {
      return muted
    },

    setBusVolume(bus, volume) {
      const v = Math.max(0, Math.min(1, volume))
      // Persistence is owned by the caller (Settings overlay calls
      // `setAudioBusVolume` from player-settings.ts, which both writes
      // the field and calls this method). We just apply.
      if (!ctx) return
      const target = bus === 'master' && muted ? 0 : v * BUS_HEADROOM[bus]
      const node =
        bus === 'master'
          ? masterGain
          : bus === 'music'
            ? musicBus
            : bus === 'sfx'
              ? sfxBus
              : ambientBus
      if (node) node.gain.setTargetAtTime(target, ctx.currentTime, 0.05)
    },

    setMusicEnabled(enabled) {
      musicEnabled = enabled
      if (!ctx) return
      // The toggle now gates the whole music layer. The radio pauses /
      // resumes; the bed only sounds when there's no real soundtrack and
      // no per-track loop in play.
      jukebox?.setEnabled(enabled)
      if (musicBedGain) {
        const bedTarget = enabled && !jukebox?.hasTracks() && !trackMusicActive ? 1 : 0
        musicBedGain.gain.setTargetAtTime(bedTarget, ctx.currentTime, 0.1)
      }
    },

    duckMusic(amount, recoverSeconds) {
      duckMusicInternal(amount, recoverSeconds)
    },

    tickEngine(speed: number) {
      if (!ctx || !engineOsc || !engineSubOsc || !engineGain || !windGain) return
      const u = Math.max(0, Math.min(1, speed / TOP_SPEED_FOR_AUDIO))
      const now = ctx.currentTime
      // 60 Hz idle → 220 Hz at top speed; sub-osc is exactly half that.
      const targetFreq = 60 + u * 160
      engineOsc.frequency.setTargetAtTime(targetFreq, now, 0.05)
      engineSubOsc.frequency.setTargetAtTime(targetFreq * 0.5, now, 0.05)
      // Idle hum + speed-driven body. Cap so it never dominates.
      const targetEngineGain = 0.05 + u * 0.18
      engineGain.gain.setTargetAtTime(targetEngineGain, now, 0.05)
      // Wind kicks in past ~30% top speed and grows quadratically.
      const targetWindGain = u * u * 0.16
      windGain.gain.setTargetAtTime(targetWindGain, now, 0.05)
    },

    driftSkid(intensity: number) {
      if (!ctx || !driftSkidGain || !driftSkidFilter) return
      const u = Math.max(0, Math.min(1, intensity))
      const now = ctx.currentTime
      // Cap below wind's peak (~0.16) so drift skid layers in without
      // burying the engine + wind body. A 0.10 ceiling reads as
      // "tyre scrape just under the engine note" — present but not
      // dominant. setTargetAtTime gives a ~70 ms fade so the loop
      // doesn't click on/off as drift activates / cancels.
      const targetGain = u * 0.1
      driftSkidGain.gain.setTargetAtTime(targetGain, now, 0.07)
      // Speed-modulated brightness — faster drift = higher band centre.
      // Idle (drift off) stays at 2600 Hz to avoid clicks; ramps to
      // ~3400 Hz at full intensity.
      const targetFreq = 2600 + u * 800
      driftSkidFilter.frequency.setTargetAtTime(targetFreq, now, 0.07)
    },

    driftBoost(tier: number) {
      const c = ctx
      const dest = sfxBus
      if (!c || !dest) return
      const now = c.currentTime
      const t = Math.max(1, Math.min(3, Math.floor(tier)))
      // Bell pitch climbs with tier so the player can hear which
      // mini-turbo just fired: blue MT ≈ A5, orange SMT ≈ C#6,
      // purple UMT ≈ E6 (an A-major chord across the tiers, parallel
      // to the wavePump's stacked-chord idiom). Gain + whoosh
      // brightness scale together so UMT reads as a clear afterburner.
      const bellFreq = t === 3 ? 1318.5 : t === 2 ? 1108.7 : 880
      const gainMul = t === 3 ? 1.5 : t === 2 ? 1.2 : 1.0
      const baseGain = 0.22 * gainMul
      gatePulse(c, dest, now, bellFreq, 0.01, 0.26, baseGain)
      // Octave layer for tier 2+ — adds a brighter top so SMT/UMT
      // ride brighter than the MT's clean bell.
      if (t >= 2) {
        gatePulse(c, dest, now, bellFreq * 2, 0.012, 0.22, baseGain * 0.55)
      }
      // Whoosh — same shape as wavePump's but shorter and centered
      // higher so it reads as a quick punch rather than a launch.
      // Sweep range widens with tier.
      const noise = c.createBufferSource()
      noise.buffer = sharedNoiseBuffer(c)
      const filt = c.createBiquadFilter()
      filt.type = 'bandpass'
      filt.frequency.setValueAtTime(700, now)
      filt.frequency.exponentialRampToValueAtTime(t === 3 ? 4200 : t === 2 ? 3200 : 2400, now + 0.2)
      filt.Q.value = 0.85
      const g = c.createGain()
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime(0.12 * gainMul, now + 0.015)
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.24)
      noise.connect(filt)
      filt.connect(g)
      g.connect(dest)
      startNoise(noise, now, 0.26)
    },

    pickupCollect() {
      const c = ctx
      const dest = sfxBus
      if (!c || !dest) return
      const now = c.currentTime
      // A4 → C#5 → E5 ascending arpeggio with quick triangle envelopes.
      const notes = [440, 554.37, 659.25]
      for (let i = 0; i < notes.length; i++) {
        const osc = c.createOscillator()
        osc.type = 'triangle'
        osc.frequency.value = notes[i]!
        const g = c.createGain()
        const start = now + i * 0.06
        g.gain.setValueAtTime(0, start)
        g.gain.linearRampToValueAtTime(0.18, start + 0.01)
        g.gain.exponentialRampToValueAtTime(0.001, start + 0.18)
        osc.connect(g)
        g.connect(dest)
        osc.start(start)
        osc.stop(start + 0.2)
      }
    },

    pickupFire(type: PickupSoundType, spatial?: SpatialCue) {
      const c = ctx
      const bus = sfxBus
      if (!c || !bus) return
      const dest = spatialTarget(c, bus, spatial)
      const now = c.currentTime
      switch (type) {
        case 'boost':
          firePickupBoost(c, dest, now)
          break
        case 'shield':
          firePickupShield(c, dest, now)
          break
        case 'missile':
          firePickupMissile(c, dest, now)
          break
        case 'mine':
          firePickupMine(c, dest, now)
          break
      }
    },

    explosion(spatial?: SpatialCue) {
      const c = ctx
      const bus = sfxBus
      if (!c || !bus) return
      const dest = spatialTarget(c, bus, spatial)
      const now = c.currentTime
      const noise = c.createBufferSource()
      noise.buffer = sharedNoiseBuffer(c)
      const filt = c.createBiquadFilter()
      filt.type = 'lowpass'
      filt.frequency.setValueAtTime(7000, now)
      filt.frequency.exponentialRampToValueAtTime(180, now + 0.4)
      const g = c.createGain()
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime(0.55, now + 0.005)
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.45)
      noise.connect(filt)
      filt.connect(g)
      g.connect(dest)
      startNoise(noise, now, 0.5)
      // Duck music to let the boom through. Big amount, slow recover —
      // explosions are infrequent + big-deal events. Scaled by the
      // spatial gain: a detonation 300 m away shouldn't dip the
      // soundtrack like one at your wheel.
      duckMusicInternal(0.7 * (spatial?.gain ?? 1), 0.6)
    },

    tickRivalEngines(rivals) {
      const c = ctx
      if (!c) return
      const now = c.currentTime
      for (let i = 0; i < rivalVoices.length; i++) {
        const voice = rivalVoices[i]!
        const drive = rivals[i]
        const level = drive ? Math.max(0, Math.min(1, drive.gain)) * 0.045 : 0
        if (level <= 0) {
          // Command silence once, then stop scheduling — solo modes
          // shouldn't insert automation events every frame forever.
          if (!voice.silenced) {
            voice.gain.gain.setTargetAtTime(0, now, 0.08)
            voice.silenced = true
          }
          continue
        }
        voice.silenced = false
        const pan = Math.max(-1, Math.min(1, drive!.pan))
        const freq = 55 + 150 * Math.max(0, Math.min(1, drive!.pitch01))
        if (drive!.snap) {
          // Slot changed hands: re-seat pan/pitch instantly and fade
          // the level in from silence — never glide one engine tone
          // between two different bikes.
          voice.panner.pan.cancelScheduledValues(now)
          voice.panner.pan.setValueAtTime(pan, now)
          voice.osc.frequency.cancelScheduledValues(now)
          voice.osc.frequency.setValueAtTime(freq, now)
          voice.gain.gain.cancelScheduledValues(now)
          voice.gain.gain.setValueAtTime(0, now)
          voice.gain.gain.setTargetAtTime(level, now, 0.08)
        } else {
          voice.gain.gain.setTargetAtTime(level, now, 0.08)
          voice.panner.pan.setTargetAtTime(pan, now, 0.08)
          voice.osc.frequency.setTargetAtTime(freq, now, 0.08)
        }
      }
    },

    gateCleared() {
      const c = ctx
      const dest = sfxBus
      if (!c || !dest) return
      // Quick two-note "ding-DING" hop, distinct from the pickup
      // arpeggio so the player can tell at a glance which event fired.
      // G5 → C6 with sharp triangle envelopes.
      gatePulse(c, dest, c.currentTime, 783.99, 0.05, 0.12)
      gatePulse(c, dest, c.currentTime + 0.07, 1046.5, 0.05, 0.16)
    },

    lapCompleted() {
      const c = ctx
      const dest = sfxBus
      if (!c || !dest) return
      // Triumphant up-arpeggio: C5 → E5 → G5 → C6, slightly louder
      // and longer than a normal gate ding.
      const notes = [523.25, 659.25, 783.99, 1046.5]
      for (let i = 0; i < notes.length; i++) {
        gatePulse(c, dest, c.currentTime + i * 0.08, notes[i]!, 0.06, 0.2)
      }
    },

    countdownTick(n) {
      const c = ctx
      const dest = sfxBus
      if (!c || !dest) return
      const now = c.currentTime
      // Dedicated rising ladder in the race-structure (C-major) family:
      // 3 → C5, 2 → E5, 1 → G5, GO → C6 + E6 flourish. The lights
      // (start-lights.ts) tick from the same callback so audio and
      // visual can never drift apart.
      if (n === 3) gatePulse(c, dest, now, 523.25, 0.02, 0.14, 0.24)
      else if (n === 2) gatePulse(c, dest, now, 659.25, 0.02, 0.14, 0.24)
      else if (n === 1) gatePulse(c, dest, now, 783.99, 0.02, 0.14, 0.24)
      else if (n === 0) {
        gatePulse(c, dest, now, 1046.5, 0.015, 0.34, 0.32)
        gatePulse(c, dest, now + 0.06, 1318.5, 0.015, 0.3, 0.24)
      }
    },

    finishStinger(kind) {
      const c = ctx
      const dest = sfxBus
      if (!c || !dest) return
      const now = c.currentTime
      // Score the finish (the loop's emotional peak, previously mute).
      // Race-structure family, sized to the result: the win fanfare
      // must out-rank the lap arpeggio the final crossing just played.
      if (kind === 'win') {
        const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5] // C5 E5 G5 C6 E6
        for (let i = 0; i < notes.length; i++) {
          gatePulse(c, dest, now + i * 0.09, notes[i]!, 0.02, 0.38, 0.28)
        }
        // Held top chord — the "champion" tail.
        gatePulse(c, dest, now + 0.5, 1046.5, 0.03, 0.7, 0.22)
        gatePulse(c, dest, now + 0.5, 1567.98, 0.03, 0.7, 0.16) // G6
        duckMusicInternal(0.5, 1.4)
      } else if (kind === 'podium') {
        const notes = [523.25, 783.99, 1046.5] // C5 G5 C6
        for (let i = 0; i < notes.length; i++) {
          gatePulse(c, dest, now + i * 0.09, notes[i]!, 0.02, 0.32, 0.24)
        }
        duckMusicInternal(0.35, 0.9)
      } else if (kind === 'finish') {
        gatePulse(c, dest, now, 523.25, 0.02, 0.26, 0.2)
        gatePulse(c, dest, now + 0.1, 783.99, 0.02, 0.3, 0.2)
        duckMusicInternal(0.25, 0.7)
      } else {
        // DNF — low, neutral resolve. No celebration, no duck; the
        // race ended, the music keeps its dignity.
        gatePulse(c, dest, now, 392.0, 0.03, 0.3, 0.14) // G4
        gatePulse(c, dest, now + 0.12, 329.63, 0.03, 0.34, 0.12) // E4
      }
    },

    cupFanfare() {
      const c = ctx
      const dest = sfxBus
      if (!c || !dest) return
      // The podium is a fresh navigation, so this can be called with a
      // context that exists but is still autoplay-suspended — cues
      // scheduled then would pile up at the frozen clock and blast as
      // a cluster on the next gesture. The caller retries on unlock.
      if (c.state !== 'running') return
      const now = c.currentTime
      // Podium ceremony — the biggest structure cue in the game: full
      // ascending run into a held C-major triad with a sparkle top.
      const run = [523.25, 659.25, 783.99, 1046.5] // C5 E5 G5 C6
      for (let i = 0; i < run.length; i++) {
        gatePulse(c, dest, now + i * 0.11, run[i]!, 0.02, 0.4, 0.26)
      }
      gatePulse(c, dest, now + 0.55, 1046.5, 0.04, 1.0, 0.22) // C6
      gatePulse(c, dest, now + 0.55, 1318.5, 0.04, 1.0, 0.18) // E6
      gatePulse(c, dest, now + 0.55, 1567.98, 0.04, 1.0, 0.15) // G6
      gatePulse(c, dest, now + 0.72, 2093.0, 0.02, 0.6, 0.12) // C7 sparkle
      duckMusicInternal(0.6, 2.0)
    },

    boostIgnite(charge) {
      const c = ctx
      const dest = sfxBus
      if (!c || !dest) return
      const q = Math.max(0, Math.min(1, charge))
      const now = c.currentTime
      // Boost gets its own ignition voice in the drift-whoosh family —
      // a low thump + rising noise sweep, deliberately NOT the
      // wave-mastery chord (no stacked 5th/octave, no sparkle), so the
      // signature cue stays reserved for graded water reads.
      gatePulse(c, dest, now, 220, 0.008, 0.16, 0.16 + 0.08 * q) // A3 thump
      const noise = c.createBufferSource()
      noise.buffer = sharedNoiseBuffer(c)
      const filt = c.createBiquadFilter()
      filt.type = 'bandpass'
      filt.frequency.setValueAtTime(500, now)
      filt.frequency.exponentialRampToValueAtTime(3800, now + 0.22)
      filt.Q.value = 0.9
      const g = c.createGain()
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime(0.1 + 0.08 * q, now + 0.015)
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.26)
      noise.connect(filt)
      filt.connect(g)
      g.connect(dest)
      startNoise(noise, now, 0.28)
      // Honor the same per-track duck knob the wavePump chord used at
      // these call sites — `music3dEffects.duckOnPump` opted a track's
      // music out of pump-channel ducking, and boost vents/pads were
      // half of that channel.
      duckMusicInternal(0.3 * trackDuckMultiplier(), 0.4)
    },

    wavePump(strength, perfect = false) {
      const c = ctx
      const dest = sfxBus
      if (!c || !dest) return
      const s = Math.max(0, Math.min(1, strength))
      const now = c.currentTime
      // Bright stacked chord — root + perfect 5th + octave at A4 anchor.
      // Strength scales the gain envelope and the octave layer's volume
      // so weak pumps read as a single chime, strong ones as a full
      // chord with a sparkly top. Distinct from gateCleared's two-note
      // ding so the player can tell pumps from checkpoints by ear.
      const root = 440 // A4
      const fifth = 659.25 // E5 (perfect 5th)
      const oct = 880 // A5
      // Perfect tricks ride hotter and add a top-octave sparkle so the
      // tier reads as "you nailed it" rather than just louder.
      const gainMul = perfect ? 1.35 : 1.0
      const baseGain = (0.18 + 0.14 * s) * gainMul
      gatePulse(c, dest, now, root, 0.012, 0.32, baseGain)
      gatePulse(c, dest, now, fifth, 0.012, 0.32, baseGain * 0.85)
      gatePulse(c, dest, now, oct, 0.012, 0.28, baseGain * (0.4 + 0.6 * s))
      if (perfect) {
        // Top-octave sparkle (A6) + major third (C#6) — adds a brassy
        // win-jingle layer on top of the stacked chord. Slightly
        // delayed so it reads as a flourish rather than smearing into
        // the root pulse.
        gatePulse(c, dest, now + 0.04, 1108.73, 0.01, 0.22, baseGain * 0.55)
        gatePulse(c, dest, now + 0.06, 1760, 0.01, 0.26, baseGain * 0.7)
      }
      // Whoosh layer — short noise burst with a band-pass sweep up,
      // sells the surfboard-launch feel under the chime. Perfect
      // tricks sweep wider + brighter for the afterburner read.
      const noise = c.createBufferSource()
      noise.buffer = sharedNoiseBuffer(c)
      const filt = c.createBiquadFilter()
      filt.type = 'bandpass'
      filt.frequency.setValueAtTime(perfect ? 520 : 420, now)
      filt.frequency.exponentialRampToValueAtTime(perfect ? 3200 : 1800, now + 0.22)
      filt.Q.value = perfect ? 0.9 : 1.1
      const g = c.createGain()
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime((0.06 + 0.1 * s) * gainMul, now + 0.02)
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.28)
      noise.connect(filt)
      filt.connect(g)
      g.connect(dest)
      startNoise(noise, now, 0.3)
      // Sidechain duck — strength scales how hard we dip the music.
      // The per-track `music3dEffects.duckOnPump` multiplier lets
      // tracks with heavier music tune the depth without the engine
      // shifting its default for everyone.
      const duckMul = trackDuckMultiplier()
      duckMusicInternal((0.35 + 0.3 * s) * duckMul * (perfect ? 1.25 : 1.0), 0.45)
    },

    setTrackAudio(config) {
      if (!ctx) {
        // Boot path: track loads before any user gesture. Buffer the
        // config and apply it when ensureContext runs.
        pendingTrackAudio = { config }
        trackAudioConfig = config
        return
      }
      // Fire-and-forget — load failures (404 etc.) don't block the
      // caller and surface as console.warn at most.
      void applyTrackAudioToContext(ctx, config)
    },

    setSoundtrack(tracks) {
      soundtrack = tracks
      if (jukebox) {
        jukebox.setPlaylist(tracks)
        // Make the radio the default source if nothing else owns the bus.
        if (!trackMusicActive) restoreDefaultMusic()
      }
    },

    onSongChange(cb) {
      songChangeCb = cb
      // Replay the current song to a late subscriber so the toast can
      // reflect what's already playing.
      const cur = jukebox?.current() ?? null
      if (cur) cb(cur)
    },

    nextSong() {
      jukebox?.next()
    },
  }
}

/** Build the procedural music bed. Subtle slow pad over a sub osc with
 *  a tremolo LFO modulating gain — pleasant background texture that
 *  doesn't fight gameplay cues. Replace this whole function when the
 *  real music drop arrives. */
function buildMusicBed(
  c: AudioContext,
  dest: GainNode,
): { osc: OscillatorNode; lfo: OscillatorNode }[] {
  const out: { osc: OscillatorNode; lfo: OscillatorNode }[] = []
  // A2, E3, A3 — sparse drone, three voices.
  const freqs = [110, 164.81, 220]
  for (const freq of freqs) {
    const osc = c.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    const voiceGain = c.createGain()
    voiceGain.gain.value = 0.04
    const lfo = c.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = 0.25
    const lfoGain = c.createGain()
    lfoGain.gain.value = 0.015
    lfo.connect(lfoGain)
    lfoGain.connect(voiceGain.gain)
    osc.connect(voiceGain)
    voiceGain.connect(dest)
    osc.start()
    lfo.start()
    out.push({ osc, lfo })
  }
  return out
}

function gatePulse(
  c: AudioContext,
  dest: GainNode,
  start: number,
  freq: number,
  attack: number,
  release: number,
  peak = 0.22,
): void {
  const osc = c.createOscillator()
  osc.type = 'triangle'
  osc.frequency.value = freq
  const g = c.createGain()
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(peak, start + attack)
  g.gain.exponentialRampToValueAtTime(0.001, start + attack + release)
  osc.connect(g)
  g.connect(dest)
  osc.start(start)
  osc.stop(start + attack + release + 0.02)
}

function makeNoiseBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
  const len = Math.max(1, Math.floor(durationSec * ctx.sampleRate))
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  return buf
}

/** One cached noise buffer per context, shared by every one-shot.
 *  The old per-call `makeNoiseBuffer` allocated a fresh AudioBuffer
 *  (0.5 s ≈ 96 KB) for every explosion/whoosh — steady main-thread
 *  allocation + GC pressure during exactly the frames an 8-bike item
 *  battle already spikes. One-shots slice it via `startNoise`'s
 *  random offset so repeats don't sound identical. */
const NOISE_BUFFER_SECONDS = 2
const noiseBufferCache = new WeakMap<AudioContext, AudioBuffer>()
function sharedNoiseBuffer(c: AudioContext): AudioBuffer {
  let buf = noiseBufferCache.get(c)
  if (!buf) {
    buf = makeNoiseBuffer(c, NOISE_BUFFER_SECONDS)
    noiseBufferCache.set(c, buf)
  }
  return buf
}

/** Start a one-shot slice of the shared noise buffer: random offset
 *  (so back-to-back shots decorrelate) and an explicit stop at the
 *  requested duration — the same start/stop discipline every one-shot
 *  already followed. */
function startNoise(noise: AudioBufferSourceNode, when: number, durationSec: number): void {
  const maxOffset = Math.max(0, NOISE_BUFFER_SECONDS - durationSec)
  noise.start(when, Math.random() * maxOffset)
  noise.stop(when + durationSec)
}

/** Route a one-shot toward the bus, optionally through a per-shot
 *  distance-gain + stereo-pan pair. Fire-and-forget like every other
 *  node chain here — once the source stops, the subgraph is
 *  collectable. */
function spatialTarget(c: AudioContext, bus: GainNode, spatial: SpatialCue | undefined): GainNode {
  if (!spatial) return bus
  const g = c.createGain()
  g.gain.value = Math.max(0, Math.min(1, spatial.gain))
  const p = c.createStereoPanner()
  p.pan.value = Math.max(-1, Math.min(1, spatial.pan))
  g.connect(p)
  p.connect(bus)
  return g
}

function firePickupBoost(c: AudioContext, dest: GainNode, now: number): void {
  const noise = c.createBufferSource()
  noise.buffer = sharedNoiseBuffer(c)
  const filt = c.createBiquadFilter()
  filt.type = 'bandpass'
  filt.frequency.setValueAtTime(360, now)
  filt.frequency.exponentialRampToValueAtTime(2400, now + 0.4)
  filt.Q.value = 1.2
  const g = c.createGain()
  g.gain.setValueAtTime(0, now)
  g.gain.linearRampToValueAtTime(0.32, now + 0.04)
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.5)
  noise.connect(filt)
  filt.connect(g)
  g.connect(dest)
  startNoise(noise, now, 0.55)
}

function firePickupShield(c: AudioContext, dest: GainNode, now: number): void {
  // Rising sine + soft body.
  const osc = c.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(220, now)
  osc.frequency.exponentialRampToValueAtTime(660, now + 0.4)
  const g = c.createGain()
  g.gain.setValueAtTime(0, now)
  g.gain.linearRampToValueAtTime(0.22, now + 0.05)
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.5)
  osc.connect(g)
  g.connect(dest)
  osc.start(now)
  osc.stop(now + 0.55)
}

function firePickupMissile(c: AudioContext, dest: GainNode, now: number): void {
  // Psheww: noise burst with a closing lowpass.
  const noise = c.createBufferSource()
  noise.buffer = sharedNoiseBuffer(c)
  const filt = c.createBiquadFilter()
  filt.type = 'lowpass'
  filt.frequency.setValueAtTime(4500, now)
  filt.frequency.exponentialRampToValueAtTime(700, now + 0.3)
  const g = c.createGain()
  g.gain.setValueAtTime(0.4, now)
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.4)
  noise.connect(filt)
  filt.connect(g)
  g.connect(dest)
  startNoise(noise, now, 0.45)
}

function firePickupMine(c: AudioContext, dest: GainNode, now: number): void {
  // Bass thud body plus a bright HP-filtered click on the attack.
  const osc = c.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(80, now)
  osc.frequency.exponentialRampToValueAtTime(40, now + 0.2)
  const g = c.createGain()
  g.gain.setValueAtTime(0, now)
  g.gain.linearRampToValueAtTime(0.45, now + 0.005)
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
  osc.connect(g)
  g.connect(dest)
  osc.start(now)
  osc.stop(now + 0.35)

  const click = c.createBufferSource()
  click.buffer = sharedNoiseBuffer(c)
  const cf = c.createBiquadFilter()
  cf.type = 'highpass'
  cf.frequency.value = 2000
  const cg = c.createGain()
  cg.gain.setValueAtTime(0.18, now)
  cg.gain.exponentialRampToValueAtTime(0.001, now + 0.05)
  click.connect(cf)
  cf.connect(cg)
  cg.connect(dest)
  startNoise(click, now, 0.06)
}
