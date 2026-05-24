/**
 * Audio mixer — per-bus volume persistence + the audio-service glue.
 *
 * Covers:
 *  - The four bus fields and the music-enabled toggle round-trip via
 *    localStorage with the rest of `playerSettings`.
 *  - `setAudioBusVolume` clamps to [0,1] (sliders shouldn't be able to
 *    push out-of-range values through to the AudioEngine).
 *  - `applyAudioBusVolume` no-ops when no engine is registered (the
 *    main-menu can open Settings before audio context is up, and the
 *    overlay shouldn't crash).
 *  - `setAudioEngine` + `getAudioEngine` round-trip.
 *
 * Doesn't try to instantiate the real AudioEngine — that needs a Web
 * Audio context which jsdom doesn't ship; the WebAudio path is
 * smoke-tested in the browser instead.
 */

import { describe, expect, it } from 'vitest'
import type { AudioBus, AudioEngine } from '../../src/engine/audio/audio'
import {
  applyAudioBusVolume,
  applyAudioMusicEnabled,
  getAudioEngine,
  setAudioEngine,
} from '../../src/engine/audio/audio-service'
import {
  DEFAULT_PLAYER_SETTINGS,
  loadPlayerSettings,
  playerSettings,
  setAudioBusVolume,
  setAudioMusicEnabled,
} from '../../src/engine/player-settings'

function resetPlayerSettings(): void {
  Object.assign(playerSettings, DEFAULT_PLAYER_SETTINGS)
}

function withMockStorage(fn: () => void): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.removeItem('hoverbike.playerSettings.v1')
    fn()
  } finally {
    window.localStorage.removeItem('hoverbike.playerSettings.v1')
    resetPlayerSettings()
    setAudioEngine(null as unknown as AudioEngine)
  }
}

describe('setAudioBusVolume', () => {
  it('writes the right field per bus', () => {
    withMockStorage(() => {
      setAudioBusVolume('master', 0.42)
      setAudioBusVolume('music', 0.18)
      setAudioBusVolume('sfx', 0.99)
      setAudioBusVolume('ambient', 0.0)
      expect(playerSettings.audioMasterVolume).toBeCloseTo(0.42)
      expect(playerSettings.audioMusicVolume).toBeCloseTo(0.18)
      expect(playerSettings.audioSfxVolume).toBeCloseTo(0.99)
      expect(playerSettings.audioAmbientVolume).toBeCloseTo(0.0)
    })
  })

  it('clamps to [0,1]', () => {
    withMockStorage(() => {
      setAudioBusVolume('master', -2)
      setAudioBusVolume('music', 5)
      expect(playerSettings.audioMasterVolume).toBe(0)
      expect(playerSettings.audioMusicVolume).toBe(1)
    })
  })

  it('persists across a load cycle', async () => {
    if (typeof window === 'undefined' || !window.localStorage) return
    try {
      window.localStorage.removeItem('hoverbike.playerSettings.v1')
      setAudioBusVolume('master', 0.3)
      setAudioBusVolume('sfx', 0.7)
      setAudioMusicEnabled(false)
      // Flip in memory, then reload from storage.
      playerSettings.audioMasterVolume = 0.9
      playerSettings.audioSfxVolume = 0.1
      playerSettings.audioMusicEnabled = true
      loadPlayerSettings()
      expect(playerSettings.audioMasterVolume).toBeCloseTo(0.3)
      expect(playerSettings.audioSfxVolume).toBeCloseTo(0.7)
      expect(playerSettings.audioMusicEnabled).toBe(false)
    } finally {
      window.localStorage.removeItem('hoverbike.playerSettings.v1')
      resetPlayerSettings()
    }
  })

  it('ignores NaN / Infinity / non-number persistence', () => {
    if (typeof window === 'undefined' || !window.localStorage) return
    try {
      window.localStorage.setItem(
        'hoverbike.playerSettings.v1',
        JSON.stringify({ audioMasterVolume: 'loud', audioMusicVolume: Infinity }),
      )
      resetPlayerSettings()
      loadPlayerSettings()
      // Bad values should leave the defaults intact.
      expect(playerSettings.audioMasterVolume).toBe(DEFAULT_PLAYER_SETTINGS.audioMasterVolume)
      expect(playerSettings.audioMusicVolume).toBe(DEFAULT_PLAYER_SETTINGS.audioMusicVolume)
    } finally {
      window.localStorage.removeItem('hoverbike.playerSettings.v1')
      resetPlayerSettings()
    }
  })
})

describe('audio-service', () => {
  it('round-trips the registered engine', () => {
    const stub: AudioEngine = {
      resume: async () => {},
      setMuted: () => {},
      isMuted: () => false,
      setBusVolume: () => {},
      setMusicEnabled: () => {},
      duckMusic: () => {},
      tickEngine: () => {},
      driftSkid: () => {},
      driftBoost: () => {},
      pickupCollect: () => {},
      pickupFire: () => {},
      explosion: () => {},
      gateCleared: () => {},
      lapCompleted: () => {},
      wavePump: () => {},
      setTrackAudio: () => {},
    }
    setAudioEngine(stub)
    expect(getAudioEngine()).toBe(stub)
    setAudioEngine(null as unknown as AudioEngine)
  })

  it('applyAudioBusVolume forwards to the registered engine', () => {
    const calls: { bus: AudioBus; vol: number }[] = []
    const stub: AudioEngine = {
      resume: async () => {},
      setMuted: () => {},
      isMuted: () => false,
      setBusVolume: (bus, volume) => calls.push({ bus, vol: volume }),
      setMusicEnabled: () => {},
      duckMusic: () => {},
      tickEngine: () => {},
      driftSkid: () => {},
      driftBoost: () => {},
      pickupCollect: () => {},
      pickupFire: () => {},
      explosion: () => {},
      gateCleared: () => {},
      lapCompleted: () => {},
      wavePump: () => {},
      setTrackAudio: () => {},
    }
    setAudioEngine(stub)
    applyAudioBusVolume('master', 0.5)
    applyAudioBusVolume('sfx', 0.25)
    expect(calls).toEqual([
      { bus: 'master', vol: 0.5 },
      { bus: 'sfx', vol: 0.25 },
    ])
    setAudioEngine(null as unknown as AudioEngine)
  })

  it('apply helpers no-op when no engine is registered', () => {
    setAudioEngine(null as unknown as AudioEngine)
    // Should not throw.
    applyAudioBusVolume('master', 0.5)
    applyAudioMusicEnabled(true)
  })
})
