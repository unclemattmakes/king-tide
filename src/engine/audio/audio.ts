/**
 * Procedural audio for the hoverbike. Web Audio API directly; no asset
 * pipeline, no library — every sound is synthesised from oscillators and
 * filtered noise so the build stays bundler-friendly and we can iterate
 * tunings in code.
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

export type PickupSoundType = 'boost' | 'shield' | 'missile' | 'mine'

export interface AudioEngine {
  /** Resume the AudioContext, creating it on first call. Call from a
   *  user-gesture listener. Safe to call repeatedly. */
  resume(): Promise<void>
  setMuted(muted: boolean): void
  isMuted(): boolean
  /** Continuous: drives engine pitch + wind volume from the player bike
   *  speed. Call once per render frame. */
  tickEngine(speed: number): void
  /** A bike (any bike) just put a pickup into its slot. */
  pickupCollect(): void
  /** A bike (any bike) just consumed its slot. `type` selects the SFX. */
  pickupFire(type: PickupSoundType): void
  /** A new explosion entity just spawned (mine or missile detonation). */
  explosion(): void
}

const MASTER_VOLUME = 0.6
const TOP_SPEED_FOR_AUDIO = 28 // matches BikeStats.topSpeed roughly

export function createAudioEngine(): AudioEngine {
  let ctx: AudioContext | null = null
  let masterGain: GainNode | null = null
  let muted = false

  // Continuous layers, set up once on first unlock.
  let engineOsc: OscillatorNode | null = null
  let engineSubOsc: OscillatorNode | null = null
  let engineFilter: BiquadFilterNode | null = null
  let engineGain: GainNode | null = null
  let windFilter: BiquadFilterNode | null = null
  let windGain: GainNode | null = null

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

    masterGain = ctx.createGain()
    masterGain.gain.value = muted ? 0 : MASTER_VOLUME
    masterGain.connect(ctx.destination)

    // Engine: sawtooth for the body, sub-octave sine for low end.
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
    engineGain.connect(masterGain)
    engineOsc.start()
    engineSubOsc.start()

    // Wind: looping white-noise buffer through a bandpass — opens up
    // with speed.
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
    windGain.connect(masterGain)
    windNoise.start()

    // Ambient water: filtered low rumble, fixed quiet level.
    const ambNoise = ctx.createBufferSource()
    ambNoise.buffer = noiseBuffer
    ambNoise.loop = true
    const ambFilter = ctx.createBiquadFilter()
    ambFilter.type = 'lowpass'
    ambFilter.frequency.value = 380
    ambFilter.Q.value = 0.5
    const ambientGain = ctx.createGain()
    ambientGain.gain.value = 0.05
    ambNoise.connect(ambFilter)
    ambFilter.connect(ambientGain)
    ambientGain.connect(masterGain)
    ambNoise.start()

    return ctx
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
        masterGain.gain.setTargetAtTime(m ? 0 : MASTER_VOLUME, ctx.currentTime, 0.05)
      }
    },

    isMuted() {
      return muted
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
      if (!c || !masterGain) return
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
        g.connect(masterGain)
        osc.start(start)
        osc.stop(start + 0.2)
      }
    },

    pickupFire(type: PickupSoundType) {
      const c = ctx
      if (!c || !masterGain) return
      const now = c.currentTime
      switch (type) {
        case 'boost':
          firePickupBoost(c, masterGain, now)
          break
        case 'shield':
          firePickupShield(c, masterGain, now)
          break
        case 'missile':
          firePickupMissile(c, masterGain, now)
          break
        case 'mine':
          firePickupMine(c, masterGain, now)
          break
      }
    },

    explosion() {
      const c = ctx
      if (!c || !masterGain) return
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
      g.connect(masterGain)
      noise.start(now)
      noise.stop(now + 0.5)
    },
  }
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
