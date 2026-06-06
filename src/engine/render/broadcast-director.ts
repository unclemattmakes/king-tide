import * as THREE from 'three'

/**
 * Broadcast-style camera director — picks one bike to "focus" on, picks
 * one of a handful of cinematic shot styles, and times the cut to the
 * next shot. Used by:
 *
 *  - Attract mode behind the cold-boot menu (renders an AI race with no
 *    player), so the menu always sits on top of live game footage.
 *  - Replay mode's "AUTO" camera, so saved races play back like a live
 *    TV broadcast — cuts between chase, side dolly, ground, and crane
 *    shots, with the followed rider drifting between leaders.
 *
 * The director is renderer-agnostic; it consumes per-bike world poses
 * each frame and writes the THREE.PerspectiveCamera in place.
 */

export type BikePose = {
  /** Stable per-bike id. Same value across frames so the director can
   *  remember which one it's been focused on. */
  id: number
  position: THREE.Vector3
  /** Yaw-only orientation is fine; the director only uses heading. */
  quaternion: THREE.Quaternion
  /** Optional metric used to bias toward "interesting" bikes. Higher =
   *  more likely to be focused. Defaults to 0. */
  score?: number
}

export type ShotKind =
  | 'chase' // classic over-the-shoulder
  | 'low' // ground-level tracking, low-angle
  | 'side' // side dolly
  | 'crane' // high overhead, drifting down
  | 'orbit' // slow yaw around the focus
  | 'hero' // wide three-quarter, slight push-in

export type BroadcastShot = {
  kind: ShotKind
  /** Seconds the cut will hold before the director picks the next. */
  duration: number
}

export type BroadcastDirector = {
  /** Update camera for the current shot. dt in seconds. */
  tick(poses: ReadonlyArray<BikePose>, dt: number): void
  /** Forcibly cut to a fresh shot/focus on the next tick. */
  cut(): void
  /** Currently followed bike id (or null when no poses have been fed yet). */
  getFocusId(): number | null
  /** Most-recently chosen shot. Useful for HUD readouts. */
  getCurrentShot(): BroadcastShot
}

export type BroadcastDirectorOpts = {
  /** Optional name on the perspective camera being controlled. */
  camera: THREE.PerspectiveCamera
  /** Override the shot rotation. Defaults to all six. */
  shots?: ShotKind[]
  /** Min and max seconds a single shot will hold before cutting. */
  minDuration?: number
  maxDuration?: number
  /** Seeded RNG for deterministic replays. Defaults to Math.random. */
  rng?: () => number
}

const DEFAULT_SHOTS: ShotKind[] = ['chase', 'side', 'low', 'crane', 'orbit', 'hero']

/** Uniform pull-in applied to every shot's bike-relative geometry. These shots
 *  were composed in the 2× era; the 1× bike is half its old on-screen size, so
 *  contracting each shot toward the subject re-frames the smaller bike like the
 *  bigger one. 1 = original framing; lower = tighter on the subject. Sibling of
 *  the chase-cam bake (the spectator free-orbit default distance gets the same
 *  factor). Nudge to taste. */
const BIKE_SCALE_PULL_IN = 0.6

export function createBroadcastDirector(opts: BroadcastDirectorOpts): BroadcastDirector {
  const camera = opts.camera
  const shots = opts.shots ?? DEFAULT_SHOTS
  const minDur = opts.minDuration ?? 4.5
  const maxDur = opts.maxDuration ?? 7.5
  const rng = opts.rng ?? Math.random

  let focusId: number | null = null
  let shot: BroadcastShot = { kind: shots[0] ?? 'chase', duration: midDuration() }
  let elapsed = 0
  // Per-shot animation phase (radians for orbit, 0..1 for crane glide, etc).
  let phase = 0
  let cutRequested = true

  const currentPos = new THREE.Vector3()
  const goalPos = new THREE.Vector3()
  const currentLook = new THREE.Vector3()
  const goalLook = new THREE.Vector3()
  const tmpForward = new THREE.Vector3()
  const tmpRight = new THREE.Vector3()
  const tmpQuatYaw = new THREE.Quaternion()
  let initialized = false

  function midDuration(): number {
    return minDur + rng() * (maxDur - minDur)
  }

  function pickFocus(poses: ReadonlyArray<BikePose>): number | null {
    if (poses.length === 0) return null
    // Soft-weight by score (defaulting to 1). Slight bias toward switching
    // away from the current focus so cuts feel like the director is moving
    // between riders rather than locking onto one.
    let total = 0
    for (const p of poses) total += Math.max(0.1, p.score ?? 1)
    let target = rng() * total
    let chosen = poses[0]!.id
    for (const p of poses) {
      const w = Math.max(0.1, p.score ?? 1)
      target -= w
      if (target <= 0) {
        chosen = p.id
        break
      }
    }
    // 60% of the time, prefer changing focus to keep the broadcast lively.
    if (chosen === focusId && poses.length > 1 && rng() < 0.6) {
      const others = poses.filter((p) => p.id !== focusId)
      const pick = others[Math.floor(rng() * others.length)]
      if (pick) chosen = pick.id
    }
    return chosen
  }

  function pickShot(prev: ShotKind): BroadcastShot {
    // Sample without repeating the previous shot — keeps cuts feeling new.
    const pool = shots.filter((s) => s !== prev)
    const list = pool.length > 0 ? pool : shots
    const kind = list[Math.floor(rng() * list.length)] ?? list[0] ?? 'chase'
    return { kind, duration: midDuration() }
  }

  function computeYawQuat(q: THREE.Quaternion): void {
    const yaw = Math.atan2(2 * (q.x * q.z + q.y * q.w), 1 - 2 * (q.x * q.x + q.y * q.y))
    const h = yaw * 0.5
    tmpQuatYaw.set(0, Math.sin(h), 0, Math.cos(h))
  }

  function computeShotGoal(focus: BikePose, kind: ShotKind, t: number): void {
    computeYawQuat(focus.quaternion)
    // Forward (along bike heading) and right vectors in world space.
    tmpForward.set(0, 0, 1).applyQuaternion(tmpQuatYaw)
    tmpRight.set(1, 0, 0).applyQuaternion(tmpQuatYaw)

    const fp = focus.position
    switch (kind) {
      case 'chase': {
        // Classic over-the-shoulder, slightly above + behind.
        goalPos.copy(fp).addScaledVector(tmpForward, -8)
        goalPos.y = fp.y + 3.2
        goalLook.copy(fp).addScaledVector(tmpForward, 6)
        goalLook.y = fp.y + 1.4
        break
      }
      case 'side': {
        // Side dolly — camera slides along the bike's side. `t` drives a slow
        // strafe so the framing has some life.
        const slide = Math.sin(t * 0.4) * 2
        goalPos
          .copy(fp)
          .addScaledVector(tmpRight, -9 - slide * 0.4)
          .addScaledVector(tmpForward, 1 + slide)
        goalPos.y = fp.y + 1.8
        goalLook.copy(fp)
        goalLook.y = fp.y + 1.2
        break
      }
      case 'low': {
        // Low ground-level tracking — looks heroic when the bike comes
        // toward / past the lens.
        goalPos.copy(fp).addScaledVector(tmpForward, -4.5).addScaledVector(tmpRight, 3.5)
        goalPos.y = fp.y - 0.6
        goalLook.copy(fp).addScaledVector(tmpForward, 4)
        goalLook.y = fp.y + 1
        break
      }
      case 'crane': {
        // High overhead pan that drifts down across the shot.
        const drop = Math.min(1, t * 0.18)
        goalPos.copy(fp).addScaledVector(tmpForward, -2).addScaledVector(tmpRight, 4)
        goalPos.y = fp.y + 22 - drop * 10
        goalLook.copy(fp).addScaledVector(tmpForward, 4)
        goalLook.y = fp.y + 0.5
        break
      }
      case 'orbit': {
        // Slow orbit at mid-distance. `t` is integrated phase (radians).
        const r = 11
        const angle = t * 0.35
        goalPos.set(fp.x + Math.cos(angle) * r, fp.y + 3.4, fp.z + Math.sin(angle) * r)
        goalLook.copy(fp)
        goalLook.y = fp.y + 1.2
        break
      }
      case 'hero': {
        // Wide three-quarter that slowly pushes in.
        const push = Math.min(1, t * 0.2)
        const dist = 15 - push * 4
        goalPos
          .copy(fp)
          .addScaledVector(tmpForward, -dist)
          .addScaledVector(tmpRight, -6 + push * 2)
        goalPos.y = fp.y + 5 - push * 1
        goalLook.copy(fp).addScaledVector(tmpForward, 3)
        goalLook.y = fp.y + 1.4
        break
      }
    }

    // Contract the whole shot (camera + look point) toward the subject so the
    // half-size 1× bike frames like the 2×-era bike these shots were composed
    // for. Uniform scaling keeps each shot's angle/composition — just closer.
    goalPos.sub(fp).multiplyScalar(BIKE_SCALE_PULL_IN).add(fp)
    goalLook.sub(fp).multiplyScalar(BIKE_SCALE_PULL_IN).add(fp)
  }

  function snapToGoal(): void {
    currentPos.copy(goalPos)
    currentLook.copy(goalLook)
    camera.position.copy(currentPos)
    camera.lookAt(currentLook)
    initialized = true
  }

  return {
    tick(poses, dt) {
      if (poses.length === 0) return
      // Initial or commanded cut: pick a focus + shot before anything else.
      if (cutRequested || focusId === null) {
        focusId = pickFocus(poses)
        shot = pickShot(shot.kind)
        elapsed = 0
        phase = 0
        cutRequested = false
        const focus = poses.find((p) => p.id === focusId) ?? poses[0]!
        computeShotGoal(focus, shot.kind, phase)
        snapToGoal()
        return
      }
      elapsed += dt
      phase += dt
      const focus = poses.find((p) => p.id === focusId) ?? poses[0]!
      computeShotGoal(focus, shot.kind, phase)

      if (!initialized) {
        snapToGoal()
      } else {
        // Spring-damp toward the goal so the shot eases in instead of snapping.
        const t = 1 - Math.exp(-dt * 3.2)
        currentPos.lerp(goalPos, t)
        currentLook.lerp(goalLook, t)
        camera.position.copy(currentPos)
        camera.lookAt(currentLook)
      }

      if (elapsed >= shot.duration) {
        cutRequested = true
      }
    },
    cut() {
      cutRequested = true
    },
    getFocusId() {
      return focusId
    },
    getCurrentShot() {
      return shot
    },
  }
}
