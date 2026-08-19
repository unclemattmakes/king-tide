/**
 * Pause-menu, finish-screen, and keyboard wiring for the live race.
 *
 * Owns:
 *   - Pause menu open/close state + button bindings.
 *   - `retryRace` / `exitToMenu` URL builders.
 *   - `respawnPlayer` — snap the player bike back onto the racing
 *     line (falls back to the spawn pose on splineless scenes).
 *   - The global `keydown` listener that drives Esc / R / Enter / T /
 *     F1 / F2 / M / the rebindable respawn action.
 *
 * Returns a small handle the game loop polls for the pause state +
 * mutates when the finish screen shows.
 */

import { clearCupProgress } from '@/engine/cup-progress'
import {
  installMenuGamepad,
  isAnyOverlayShown,
  type MenuGamepad,
} from '@/engine/input/menu-gamepad'
import {
  AUTOPILOT_STATE_EVENT,
  TOUCH_AUTOPILOT_EVENT,
  TOUCH_MENU_EVENT,
} from '@/engine/input/touch'
import { trackDisplayName } from '@/engine/menus/tracks-catalog'
import { playerSettings } from '@/engine/player-settings'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { WaveFieldState } from '@/engine/sim/water/wave-field'
import { RBHandleStore } from '@/game/components'
import { RacerStore } from '@/game/components/race'
import { clearCrashTracking } from '@/game/systems/rider-crash'
import { resetRiderForBike } from '@/game/systems/rider-pose'
import type { Track } from '@/game/tracks/types'
import { respawnBikeToLine } from './respawn'

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
  sim: SimWorld
  phys: PhysicsWorld
  track: Track
  trackId: string
  /** Live wave-field state — the respawn drop height must clear the
   *  current tide, not the authored mean (see respawn.ts). */
  waveField: WaveFieldState
  playerEid: number
  playerVariantId: string
  roomId: string | null
  /** Cup id from `?cup=<id>` — propagated onto the retry URL so a
   *  pause-menu RESTART mid-cup re-enters the race still flagged as
   *  part of the championship. Null in single-race mode. */
  cupId: string | null
  raceHud: { isLocked(): boolean }
  audio: { isMuted(): boolean; setMuted(v: boolean): void }
  physicsDebug: { toggle(): boolean; isEnabled(): boolean }
  antiGravDebug: { toggle(): boolean; isEnabled(): boolean }
  hoverDebug: { toggle(): boolean; isEnabled(): boolean }
  /** Called when the user toggles auto-play. Implementation lives in
   *  main.ts because it needs to add/remove `AITag` against the player
   *  entity — keeping it there avoids leaking AI-component imports
   *  through this module. */
  onSetAutoPlay(on: boolean): void
  /** Called when the user toggles collision debug — updates the HUD
   *  pill. */
  onCollisionDebugChanged(): void
  /** Called when the user toggles anti-grav debug — updates the HUD pill. */
  onAntiGravDebugChanged(): void
  /** Called when the user toggles hover debug — updates the HUD pill. */
  onHoverDebugChanged(): void
}

export function installControls(opts: ControlsOpts): ControlsHandle {
  const {
    sim,
    phys,
    track,
    trackId,
    waveField,
    playerEid,
    playerVariantId,
    roomId,
    cupId,
    raceHud,
    audio,
    physicsDebug,
    antiGravDebug,
    hoverDebug,
    onSetAutoPlay,
    onCollisionDebugChanged,
    onAntiGravDebugChanged,
    onHoverDebugChanged,
  } = opts

  let autoPlay = false
  let pausedForMenu = false
  let finishShown = false

  function setAutoPlay(on: boolean): void {
    autoPlay = on
    onSetAutoPlay(on)
    // Let the touch overlay (and anything else) reflect the new state — keeps
    // the on-screen AUTO button lit in sync however auto-play was toggled.
    window.dispatchEvent(new CustomEvent(AUTOPILOT_STATE_EVENT, { detail: { on } }))
  }

  const pauseMenuEl = document.getElementById('pause-menu')
  const pauseSubtitleEl = document.getElementById('pause-subtitle')
  const finishEl = document.getElementById('finish')
  const cupResultsEl = document.getElementById('cup-results')
  // Gamepad navigation for the pause menu — installed lazily on first
  // open so we don't waste a rAF poller during the race itself. The
  // poller's `isActive` gate parks it while the menu is closed.
  // Start-button handling lives in the global watcher below so the
  // toggle works from both states (closed → open, open → close).
  let pauseGamepad: MenuGamepad | null = null
  function ensurePauseGamepad(): MenuGamepad {
    if (pauseGamepad) return pauseGamepad
    pauseGamepad = installMenuGamepad({
      container: () => pauseMenuEl,
      // Park while Settings / Rebind is layered on top of the pause card —
      // those run their own pollers and a second live one steals focus.
      isActive: () => pausedForMenu && !isAnyOverlayShown('settings-menu', 'rebind-menu'),
      onBack: () => closePauseMenu(),
    })
    return pauseGamepad
  }
  function openPauseMenu(): void {
    if (pausedForMenu) return
    if (raceHud.isLocked()) return // can't pause during countdown
    if (finishShown) return
    pausedForMenu = true
    pauseMenuEl?.classList.add('show')
    // CSS hook: hides the in-race touch overlay so the joystick / face
    // buttons don't sit on top of the pause card on mobile.
    document.body.classList.add('paused-for-menu')
    if (pauseSubtitleEl) {
      const racer = RacerStore.get(playerEid)
      const lap = racer ? Math.min(racer.lap, track.lapsToFinish) : 1
      // Prefer the catalogue display name ("Mayday Bay") over the raw
      // slug the track JSON carries in `track.name` ("sandbar"). Dev /
      // procedural tracks aren't in the ship catalogue → fall back.
      const displayName = trackDisplayName(trackId) ?? track.name
      pauseSubtitleEl.textContent = `${displayName.toUpperCase()} · LAP ${lap}/${track.lapsToFinish}`
    }
    // Focus RESUME so Enter resumes immediately if the player wants.
    ;(document.getElementById('pause-resume') as HTMLButtonElement | null)?.focus({
      preventScroll: true,
    })
    ensurePauseGamepad().focusFirst()
  }
  function closePauseMenu(): void {
    if (!pausedForMenu) return
    pausedForMenu = false
    pauseMenuEl?.classList.remove('show')
    document.body.classList.remove('paused-for-menu')
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
    if (cupId) url.searchParams.set('cup', cupId)
    url.searchParams.set('race', '1')
    url.searchParams.set('track', args.trackId)
    url.searchParams.set('bike', args.bikeId)
    return url.toString()
  }
  function retryRace(): void {
    // Retry preserves any in-progress cup — the cup-progress
    // sessionStorage state survives the reload and the
    // recordCupRaceFinish helper overwrites this race's slot when the
    // retry finishes.
    window.location.assign(buildRaceUrl({ trackId, bikeId: playerVariantId }))
  }
  function exitToMenu(): void {
    // Pause-menu EXIT always abandons any in-progress cup — the
    // sessionStorage key is dropped so the menu doesn't later surface
    // stale cup state. (RESUME / RESTART do NOT clear it.)
    clearCupProgress()
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.set('back', '1')
    window.location.assign(url.toString())
  }

  // Gamepad navigation for the post-race screens: the finish overlay and
  // the cup-results overlay that pops over it after the last cup race.
  // A SINGLE poller whose container resolves to whichever overlay is on
  // top — two competing pollers tug-of-war over focus and swallow the A
  // press (see tests/unit/menu-gamepad.test.ts). Start is handled by the
  // global watcher below; B mirrors the Esc-to-exit affordance. Installed
  // lazily on first finish so it costs nothing during the race.
  let finishGamepad: MenuGamepad | null = null
  function ensureFinishGamepad(): MenuGamepad {
    if (finishGamepad) return finishGamepad
    finishGamepad = installMenuGamepad({
      container: () => (cupResultsEl?.classList.contains('show') ? cupResultsEl : finishEl),
      isActive: () => finishShown,
      onBack: () => exitToMenu(),
    })
    return finishGamepad
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
      // Pause-menu → Settings opens the v1 Settings overlay
      // (Audio / Video / Controls / Gameplay). Lazy-imported so its
      // DOM cost stays out of the race-mode bundle. Pause stays open
      // underneath; the overlay sits above and reads the focus stack
      // back on close.
      void import('@/engine/menus/settings-overlay').then(({ installSettingsOverlay }) => {
        installSettingsOverlay().open()
      })
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

  /** Manual respawn: snap to the nearest racing-line point, heading
   *  down-course — a mid-race rescue must not cost the lap the way the
   *  old snap-to-start did. Splineless scenes (dev/spec tracks with no
   *  'main' AI spline) fall back to the spawn pose. */
  function respawnPlayer(): void {
    if (respawnBikeToLine({ sim, phys, track, waveField, eid: playerEid })) return
    const handle = RBHandleStore.get(playerEid)
    if (!handle) return
    const rb = phys.world.getRigidBody(handle.handle)
    if (!rb) return
    const halfYaw = track.start.yaw / 2
    // Forget Δv history before the velocity zero, or the crash detector
    // reads the stop as a wall hit and ejects the rider next tick.
    clearCrashTracking(playerEid)
    rb.setTranslation(
      { x: track.start.position.x, y: track.start.position.y, z: track.start.position.z },
      true,
    )
    rb.setRotation({ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) }, true)
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
    // Re-attach the rider — if it was launched (post-crash), this swaps
    // the bones back to kinematic, removes the ragdoll joints + colliders,
    // and lands them at the bike's seat for the next pose tick.
    resetRiderForBike(sim, phys, playerEid)
  }

  /** True when a keydown's code matches the (rebindable) respawn
   *  action. Reads the live bindings so a rebind applies immediately —
   *  same pattern as the trick-prompt HUD's key hint. */
  function isRespawnCode(code: string): boolean {
    const b = playerSettings.keyboardBindings.respawn
    return code === b.primary || (b.secondary !== null && code === b.secondary)
  }

  // Keys:
  //   Esc — toggle pause menu (in-race only; finish-screen Esc exits)
  //   Enter/R — NEXT/RETRY on the finish screen; on pause menu, Enter
  //             resumes (the focused button's default action) and R
  //             restarts; Q exits to menu.
  //   T/F1 — auto-play; F2 collision / F3 anti-grav / F4 hover-spring debug;
  //   M — mute; respawn — rebindable action (default Backspace), snaps
  //   to the nearest racing-line point.
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
    } else if (e.code === 'F3') {
      antiGravDebug.toggle()
      onAntiGravDebugChanged()
      e.preventDefault()
    } else if (e.code === 'F4') {
      hoverDebug.toggle()
      onHoverDebugChanged()
      e.preventDefault()
    } else if (e.code === 'KeyM') {
      audio.setMuted(!audio.isMuted())
    } else if (isRespawnCode(e.code)) {
      respawnPlayer()
      e.preventDefault()
    }
  })

  // Touch MENU button (mobile-only on-screen pause affordance) mirrors
  // keyboard Esc / gamepad Start. The touch overlay dispatches a
  // CustomEvent so this module doesn't have to reach into its DOM.
  window.addEventListener(TOUCH_MENU_EVENT, () => {
    if (finishShown) {
      exitToMenu()
      return
    }
    if (pausedForMenu) closePauseMenu()
    else openPauseMenu()
  })

  // Touch AUTO button (mobile-only on-screen autopilot toggle) mirrors the
  // keyboard T / F1 binding. Ignore it on the finish screen / while paused so
  // it can't flip autopilot under a menu.
  window.addEventListener(TOUCH_AUTOPILOT_EVENT, () => {
    if (finishShown || pausedForMenu) return
    setAutoPlay(!autoPlay)
  })

  // Gamepad Start (button 9) mirrors keyboard Esc — toggles pause from
  // anywhere in the race. We watch it globally rather than going through
  // the pause-menu's gamepad nav so the binding works equally from open
  // and closed states without a double-toggle race.
  let prevStart = false
  function watchGamepadStart(): void {
    requestAnimationFrame(watchGamepadStart)
    const pad = navigator.getGamepads?.()?.[0]
    if (!pad) {
      prevStart = false
      return
    }
    const start = pad.buttons[9]?.pressed ?? false
    if (start && !prevStart) {
      if (finishShown) {
        exitToMenu()
      } else if (pausedForMenu) {
        closePauseMenu()
      } else {
        openPauseMenu()
      }
    }
    prevStart = start
  }
  requestAnimationFrame(watchGamepadStart)

  return {
    isPausedForMenu: () => pausedForMenu,
    isAutoPlay: () => autoPlay,
    setAutoPlay,
    setFinishShown: (v) => {
      finishShown = v
      if (v) {
        // Suppress the in-race touch overlay so the joystick / face
        // buttons don't sit on top of the results card (the finish +
        // cup-results screens are z-indexed below the touch UI), then
        // give the screen a focus anchor for controller navigation.
        document.body.classList.add('touch-ui-hidden')
        ensureFinishGamepad().focusFirst()
      }
    },
  }
}
