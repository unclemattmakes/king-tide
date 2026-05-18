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
 * A subtle procedural music bed runs on the music bus from first
 * unlock. It exists primarily as a hook for the real licensed/
 * commissioned music drop in M11–12 — the per-frame interface is
 * stable (`setMusicEnabled`, `duckMusic`) so swapping in a real loop
 * is a one-line change in `ensureContext`. The `duckMusic` helper
 * briefly dips the music bus on big SFX (wave-pump chime, explosion)
 * so the cue cuts through.
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

import { playerSettings } from '@/engine/player-settings'
import type { AudioConfig } from '@/game/tracks/types'

export type PickupSoundType = 'boost' | 'shield' | 'missile' | 'mine'
export type AudioBus = 'master' | 'music' | 'sfx' | 'ambient'

export interface AudioEngine {
  /** Resume the AudioContext, creating it on first call. Call from a
   *  user-gesture listener. Safe to call repeatedly. */
  resume(): Promise<void>
  setMuted(muted: boolean): void
  isMuted(): boolean
  /** Set a per-bus linear volume ∈ [0,1]. The bus stays at this value
   *  until set again; called by the Settings overlay slider. Tracks
   *  `playerSettings.audio<Bus>Volume` for persistence. */
  setBusVolume(bus: AudioBus, volume: number): void
  /** Enable / disable the procedural music bed. When disabled the
   *  music bus is silenced but kept routed so a future licensed loop
   *  can be slotted in without rewiring. */
  setMusicEnabled(enabled: boolean): void
  /** Ducks the music bus down by `amount` ∈ [0,1] for `recoverSeconds`,
   *  then ramps back to the current bus level. Used by wave-pump +
   *  explosion to let the cue cut through. */
  duckMusic(amount: number, recoverSeconds: number): void
  /** Continuous: drives engine pitch + wind volume from the player bike
   *  speed. Call once per render frame. */
  tickEngine(speed: number): void
  /** A bike (any bike) just put a pickup into its slot. */
  pickupCollect(): void
  /** A bike (any bike) just consumed its slot. `type` selects the SFX. */
  pickupFire(type: PickupSoundType): void
  /** A new explosion entity just spawned (mine or missile detonation). */
  explosion(): void
  /** The player just crossed a checkpoint (any but the lap-completion one). */
  gateCleared(): void
  /** The player just completed a lap. */
  lapCompleted(): void
  /** The player just completed a wave pump. `strength` is 0..1 — the
   *  audio engine scales the cue's gain + adds an upper-octave layer
   *  on strong pumps so a clean crest launch reads louder + brighter
   *  than a marginal one. The positive-feedback layer (per the v1
   *  work-breakdown) is the chord shape itself: stacked perfect 5th +
   *  octave rather than a single ping. */
  wavePump(strength: number): void
  /** Apply a per-track audio palette. Called once at boot after
   *  the AudioEngine + Track are both available; replaces any
   *  previously-set track audio (stop+release of prior music/ambient
   *  layers). Pass `undefined` to clear back to the procedural pad
   *  bed + ambient water rumble only. Audio files load lazily;
   *  missing files (404) warn and fall back gracefully. */
  setTrackAudio(config: AudioConfig | undefined): void
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

export function createAudioEngine(): AudioEngine {
  let ctx: AudioContext | null = null
  let masterGain: GainNode | null = null
  let musicBus: GainNode | null = null
  let sfxBus: GainNode | null = null
  let ambientBus: GainNode | null = null
  let muted = false
  let musicEnabled = true

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

  // Per-track audio palette state. Held so the boot wiring can swap
  // tracks at runtime (track-change, return-to-menu, replays) without
  // leaking nodes. `pendingTrackAudio` is set when setTrackAudio runs
  // before the AudioContext exists — we apply it once the user
  // gesture unlocks the engine.
  let trackMusic: { source: AudioBufferSourceNode; gain: GainNode } | null = null
  let trackAmbient: { source: AudioBufferSourceNode; gain: GainNode }[] = []
  let trackAudioConfig: AudioConfig | undefined = undefined
  let pendingTrackAudio: { config: AudioConfig | undefined } | null = null
  const decodedAudioCache = new Map<string, AudioBuffer | null>()

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
    // feed master, which feeds destination. Each bus is read from
    // `playerSettings.audio<Bus>Volume` × `BUS_HEADROOM[bus]` so the
    // Settings sliders shape the mix without needing a re-wire.
    masterGain = ctx.createGain()
    masterGain.gain.value = muted ? 0 : busLevel('master')
    masterGain.connect(ctx.destination)
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

    // Wind: looping white-noise buffer through a bandpass — opens up
    // with speed. Also SFX (bike-coupled).
    const noiseBuffer = makeNoiseBuffer(ctx, 2)
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

    // If setTrackAudio was called before the context existed (the
    // boot path: track loads while the user hasn't pressed a key
    // yet), apply the buffered config now.
    if (pendingTrackAudio) {
      const { config } = pendingTrackAudio
      pendingTrackAudio = null
      // Fire-and-forget — load failures don't block the rest of boot.
      void applyTrackAudioToContext(ctx, config)
    }

    return ctx
  }

  function duckMusicInternal(amount: number, recoverSeconds: number): void {
    if (!ctx || !musicBus) return
    const now = ctx.currentTime
    const base = busLevel('music')
    const ducked = base * Math.max(0, 1 - Math.max(0, Math.min(1, amount)))
    musicBus.gain.cancelScheduledValues(now)
    musicBus.gain.setValueAtTime(musicBus.gain.value, now)
    musicBus.gain.linearRampToValueAtTime(ducked, now + 0.04)
    musicBus.gain.linearRampToValueAtTime(base, now + 0.04 + Math.max(0.05, recoverSeconds))
  }

  /** Resolve the per-track pump-duck multiplier. Defaults to 1.0
   *  (i.e. the engine's base 0.35 duck amount is unchanged) when no
   *  track-level override is set. */
  function trackDuckMultiplier(): number {
    const m = trackAudioConfig?.music3dEffects?.duckOnPump
    return typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m : 1
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
      // Cleared — restore the procedural pad bed audibility.
      if (musicBedGain) musicBedGain.gain.value = musicEnabled ? 1 : 0
      return
    }
    // Music: when present + reachable, mute the procedural bed and
    // play the licensed track on the music bus. When the file misses
    // (404), keep the procedural bed at its current level — that's
    // the documented fallback contract.
    if (config.music && musicBus) {
      const url = `/audio/music/${config.music}`
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
        // Procedural bed gets silenced while licensed music plays;
        // it stays routed so setMusicEnabled(false) still works.
        if (musicBedGain) musicBedGain.gain.value = 0
      } else if (musicBedGain) {
        musicBedGain.gain.value = musicEnabled ? 1 : 0
      }
    } else if (musicBedGain) {
      musicBedGain.gain.value = musicEnabled ? 1 : 0
    }
    // Ambient layers — load + play each in parallel.
    if (config.ambient && config.ambient.length > 0 && ambientBus) {
      const ambBus = ambientBus
      await Promise.all(
        config.ambient.map(async (name, i) => {
          const url = `/audio/ambient/${name}`
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
      if (ctx && musicBedGain) {
        musicBedGain.gain.setTargetAtTime(enabled ? 1 : 0, ctx.currentTime, 0.1)
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

    pickupFire(type: PickupSoundType) {
      const c = ctx
      const dest = sfxBus
      if (!c || !dest) return
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

    explosion() {
      const c = ctx
      const dest = sfxBus
      if (!c || !dest) return
      const now = c.currentTime
      const noise = c.createBufferSource()
      noise.buffer = makeNoiseBuffer(c, 0.5)
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
      noise.start(now)
      noise.stop(now + 0.5)
      // Duck music to let the boom through. Big amount, slow recover —
      // explosions are infrequent + big-deal events.
      duckMusicInternal(0.7, 0.6)
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

    wavePump(strength) {
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
      const baseGain = 0.18 + 0.14 * s
      gatePulse(c, dest, now, root, 0.012, 0.32, baseGain)
      gatePulse(c, dest, now, fifth, 0.012, 0.32, baseGain * 0.85)
      gatePulse(c, dest, now, oct, 0.012, 0.28, baseGain * (0.4 + 0.6 * s))
      // Whoosh layer — short noise burst with a band-pass sweep up,
      // sells the surfboard-launch feel under the chime.
      const noise = c.createBufferSource()
      noise.buffer = makeNoiseBuffer(c, 0.3)
      const filt = c.createBiquadFilter()
      filt.type = 'bandpass'
      filt.frequency.setValueAtTime(420, now)
      filt.frequency.exponentialRampToValueAtTime(1800, now + 0.22)
      filt.Q.value = 1.1
      const g = c.createGain()
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime(0.06 + 0.1 * s, now + 0.02)
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.28)
      noise.connect(filt)
      filt.connect(g)
      g.connect(dest)
      noise.start(now)
      noise.stop(now + 0.3)
      // Sidechain duck — strength scales how hard we dip the music.
      // The per-track `music3dEffects.duckOnPump` multiplier lets
      // tracks with heavier music tune the depth without the engine
      // shifting its default for everyone.
      const duckMul = trackDuckMultiplier()
      duckMusicInternal((0.35 + 0.3 * s) * duckMul, 0.45)
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

function firePickupBoost(c: AudioContext, dest: GainNode, now: number): void {
  const noise = c.createBufferSource()
  noise.buffer = makeNoiseBuffer(c, 0.55)
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
  noise.start(now)
  noise.stop(now + 0.55)
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
  noise.buffer = makeNoiseBuffer(c, 0.45)
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
  noise.start(now)
  noise.stop(now + 0.45)
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
  click.buffer = makeNoiseBuffer(c, 0.06)
  const cf = c.createBiquadFilter()
  cf.type = 'highpass'
  cf.frequency.value = 2000
  const cg = c.createGain()
  cg.gain.setValueAtTime(0.18, now)
  cg.gain.exponentialRampToValueAtTime(0.001, now + 0.05)
  click.connect(cf)
  cf.connect(cg)
  cg.connect(dest)
  click.start(now)
  click.stop(now + 0.06)
}
