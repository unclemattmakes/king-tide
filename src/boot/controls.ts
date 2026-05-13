/**
 * Pause-menu, finish-screen, and keyboard wiring for the live race.
 *
 * Owns:
 *   - Pause menu open/close state + button bindings.
 *   - `retryRace` / `exitToMenu` URL builders.
 *   - `respawnPlayer` — snap the player bike to spawn pose with zero
 *     velocity.
 *   - The global `keydown` listener that drives Esc / R / Enter / T /
 *     F1 / F2 / M / Backspace.
 *
 * Returns a small handle the game loop polls for the pause state +
 * mutates when the finish screen shows.
 */

import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { RBHandleStore } from '@/game/components'
import { RacerStore } from '@/game/components/race'
import type { Track } from '@/game/tracks/types'

export interface ControlsHandle {
  /** True while the pause overlay is open. Polled by the game loop to
   *  freeze the single-player sim (multiplayer keeps stepping). */
  isPausedForMenu(): boolean
  /** True while the player bike is being driven by the AI controller
   *  (toggled by T / F1, or by `__hover.toggleAutoPlay()`). */
  isAutoPlay(): boolean
  /** Toggle auto-play on/off. Mirrors the keyboard binding. */
  setAutoPlay(on: boolean): void
  /** Set by the game loop when the player crosses the finish line. */
  setFinishShown(v: boolean): void
}

export interface ControlsOpts {
  phys: PhysicsWorld
  track: Track
  trackId: string
  playerEid: number
  playerVariantId: string
  roomId: string | null
  raceHud: { isLocked(): boolean }
  audio: { isMuted(): boolean; setMuted(v: boolean): void }
  physicsDebug: { toggle(): boolean; isEnabled(): boolean }
  /** Called when the user toggles auto-play. Implementation lives in
   *  main.ts because it needs to add/remove `AITag` against the player
   *  entity — keeping it there avoids leaking AI-component imports
   *  through this module. */
  onSetAutoPlay(on: boolean): void
  /** Called when the user toggles collision debug — updates the HUD
   *  pill. */
  onCollisionDebugChanged(): void
}

export function installControls(opts: ControlsOpts): ControlsHandle {
  const {
    phys,
    track,
    trackId,
    playerEid,
    playerVariantId,
    roomId,
    raceHud,
    audio,
    physicsDebug,
    onSetAutoPlay,
    onCollisionDebugChanged,
  } = opts

  let autoPlay = false
  let pausedForMenu = false
  let finishShown = false

  function setAutoPlay(on: boolean): void {
    autoPlay = on
    onSetAutoPlay(on)
  }

  const pauseMenuEl = document.getElementById('pause-menu')
  const pauseSubtitleEl = document.getElementById('pause-subtitle')
  function openPauseMenu(): void {
    if (pausedForMenu) return
    if (raceHud.isLocked()) return // can't pause during countdown
    if (finishShown) return
    pausedForMenu = true
    pauseMenuEl?.classList.add('show')
    if (pauseSubtitleEl) {
      const racer = RacerStore.get(playerEid)
      const lap = racer ? Math.min(racer.lap, track.lapsToFinish) : 1
      pauseSubtitleEl.textContent = `${track.name.toUpperCase()} · LAP ${lap}/${track.lapsToFinish}`
    }
    // Focus RESUME so Enter resumes immediately if the player wants.
    ;(document.getElementById('pause-resume') as HTMLButtonElement | null)?.focus({
      preventScroll: true,
    })
  }
  function closePauseMenu(): void {
    if (!pausedForMenu) return
    pausedForMenu = false
    pauseMenuEl?.classList.remove('show')
  }

  // Finish-screen / pause-menu actions. NEXT advances to the next track
  // in the catalogue rotation (wrapping); RETRY reloads the same combo;
  // EXIT navigates to a bare URL so boot re-enters the menu flow. All
  // three do a full page reload — boot is cheap (< 500ms) and a reload
  // keeps the asset/physics teardown story trivial.
  function buildRaceUrl(args: { trackId: string; bikeId: string }): string {
    const url = new URL(window.location.href)
    url.search = ''
    if (roomId) url.searchParams.set('room', roomId)
    url.searchParams.set('race', '1')
    url.searchParams.set('track', args.trackId)
    url.searchParams.set('bike', args.bikeId)
    return url.toString()
  }
  function retryRace(): void {
    window.location.assign(buildRaceUrl({ trackId, bikeId: playerVariantId }))
  }
  function exitToMenu(): void {
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.set('back', '1')
    window.location.assign(url.toString())
  }
  // Wire pause-menu buttons exactly once (the DOM is shared across the
  // session, so re-binding on every open would leak click handlers).
  ;(document.getElementById('pause-resume') as HTMLButtonElement | null)?.addEventListener(
    'click',
    closePauseMenu,
  )
  ;(document.getElementById('pause-restart') as HTMLButtonElement | null)?.addEventListener(
    'click',
    retryRace,
  )
  ;(document.getElementById('pause-exit') as HTMLButtonElement | null)?.addEventListener(
    'click',
    exitToMenu,
  )
  ;(document.getElementById('pause-settings') as HTMLButtonElement | null)?.addEventListener(
    'click',
    () => {
      // Hide pause menu while settings are open so the user lands on
      // a single overlay. The existing dev-settings toggle handles the
      // lazy-import + open; we just click it.
      closePauseMenu()
      ;(document.getElementById('devsettings-toggle') as HTMLButtonElement | null)?.click()
    },
  )
  // Multiplayer can't restart a race solo — disable that button when
  // we're connected to a room. (The button is still visible so the
  // pause menu reads consistently across modes.)
  if (roomId) {
    const restartBtn = document.getElementById('pause-restart') as HTMLButtonElement | null
    if (restartBtn) {
      restartBtn.disabled = true
      restartBtn.title = 'Disabled in multiplayer'
    }
  }

  /** Snap the player back to the spawn pose with zero velocity. Useful after
   *  collisions leave the bike upside-down, off-track, or unrecoverable. */
  function respawnPlayer(): void {
    const handle = RBHandleStore.get(playerEid)
    if (!handle) return
    const rb = phys.world.getRigidBody(handle.handle)
    if (!rb) return
    const halfYaw = track.start.yaw / 2
    rb.setTranslation(
      { x: track.start.position.x, y: track.start.position.y, z: track.start.position.z },
      true,
    )
    rb.setRotation({ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) }, true)
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
  }

  // Keys:
  //   Esc — toggle pause menu (in-race only; finish-screen Esc exits)
  //   Enter/R — NEXT/RETRY on the finish screen; on pause menu, Enter
  //             resumes (the focused button's default action) and R
  //             restarts; Q exits to menu.
  //   T/F1 — auto-play; F2 — collision debug; M — mute; Backspace — respawn.
  window.addEventListener('keydown', (e) => {
    if (finishShown && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
      ;(document.getElementById('finish-next') as HTMLButtonElement | null)?.click()
      e.preventDefault()
      return
    }
    if (finishShown && e.code === 'Escape') {
      exitToMenu()
      e.preventDefault()
      return
    }
    // Pause menu — Esc toggles open/closed during a live race. Once
    // open, R restarts and Q bails to the menu so you don't have to
    // mouse over the buttons.
    if (e.code === 'Escape' && !finishShown) {
      if (pausedForMenu) closePauseMenu()
      else openPauseMenu()
      e.preventDefault()
      return
    }
    if (pausedForMenu) {
      if (e.code === 'KeyR' && !roomId) {
        retryRace()
        e.preventDefault()
        return
      }
      if (e.code === 'KeyQ') {
        exitToMenu()
        e.preventDefault()
        return
      }
      // Eat other gameplay keys so they don't fire while paused.
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter') {
        return
      }
    }
    if (e.code === 'KeyR' && finishShown) {
      retryRace()
      e.preventDefault()
    } else if (e.code === 'KeyT' || e.code === 'F1') {
      setAutoPlay(!autoPlay)
    } else if (e.code === 'F2') {
      physicsDebug.toggle()
      onCollisionDebugChanged()
      e.preventDefault()
    } else if (e.code === 'KeyM') {
      audio.setMuted(!audio.isMuted())
    } else if (e.code === 'Backspace') {
      respawnPlayer()
      e.preventDefault()
    }
  })

  return {
    isPausedForMenu: () => pausedForMenu,
    isAutoPlay: () => autoPlay,
    setAutoPlay,
    setFinishShown: (v) => {
      finishShown = v
    },
  }
}
