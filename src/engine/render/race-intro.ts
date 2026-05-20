import * as THREE from 'three'
import type { Track } from '@/game/tracks/types'

/**
 * Pre-lap track introduction — drives a sequence of cinematic camera
 * shots before the race countdown starts. Plays once per race, gated
 * on `raceHud.isLocked()` so the sim stays paused at the spawn grid
 * while the camera tours the course.
 *
 * The director runs entirely on the render side. It takes the track,
 * picks shot anchors from the AI spline + start position, and writes
 * `camera.position` + `camera.lookAt` directly each frame. The chase
 * camera is untouched until the intro is done — its first post-intro
 * `tick()` snaps to the spawn-relative goal because `initialized`
 * is still false at that point.
 *
 * Determinism: pure-render. The sim is `locked: true` for the whole
 * intro (race-hud's `armCountdown()` is held until the director
 * reports done), so no physics state advances. dt is the render-rAF
 * delta — fine, since nothing in the sim looks at the intro state.
 *
 * Three modes (`'full'` / `'short'` / `'off'`):
 *
 *  - `full` (default): three shots — a wide aerial of mid-track, a
 *    racing-line skim closer to the start, and a descent that arrives
 *    at the chase-camera goal behind the player.
 *  - `short`: just the descent shot, ~2 s. For players who want to
 *    skip the establishing pans but still get a "lights out and away
 *    we go" beat.
 *  - `off`: director reports done immediately; the countdown arms on
 *    the first frame and the existing 3-2-1-GO behaviour is preserved.
 */

export type RaceIntroMode = 'full' | 'short' | 'off'

export interface RaceIntroOpts {
  camera: THREE.PerspectiveCamera
  track: Track
  /** World-space spawn pose of the player bike. The descent shot
   *  finishes at the chase-camera's idle position relative to this
   *  pose so the handoff to `ChaseCamera.tick()` is seamless. */
  playerStart: { x: number; y: number; z: number; yaw: number }
  mode?: RaceIntroMode
  /** Time scale for the intro. 1.0 = real-time; 0 fast-forwards (skip).
   *  Tests pass arbitrary values to drive the director deterministically. */
  timeScale?: number
}

export interface RaceIntro {
  /** Advance the intro by `dt` seconds. Writes `camera.position` and
   *  re-aims the lens via `lookAt()`. No-op once `isActive()` is false. */
  tick(dt: number): void
  /** True while the director owns the camera. Mirrors `!isDone()`.
   *  Returns true even before the first `tick()` (so the game loop's
   *  first-frame check routes the camera through the director instead
   *  of handing it straight to the chase cam). Flips to false on the
   *  tick that the final shot finishes — or on the first tick after
   *  `skip()`. */
  isActive(): boolean
  /** True once the final shot has finished playing (or the director was
   *  constructed in `'off'` mode). The race-hud's countdown arming is
   *  gated on this transitioning to true. */
  isDone(): boolean
  /** Skip ahead to the final shot's end pose. The next `tick()` will
   *  flip `isActive()` to false and `isDone()` to true. Idempotent. */
  skip(): void
  /** Total seconds the director will play if not skipped (sum of
   *  shot durations). Exposed for HUD hints + tests. */
  totalDuration(): number
}

/** Per-shot anchor pair — camera moves from `from` to `to`, looking
 *  from `lookFrom` to `lookTo` over `duration` seconds. */
interface Shot {
  from: THREE.Vector3
  to: THREE.Vector3
  lookFrom: THREE.Vector3
  lookTo: THREE.Vector3
  duration: number
}

const SHOT_DURATION_FULL = {
  aerial: 2.6,
  skim: 2.6,
  descent: 2.4,
} as const

const SHOT_DURATION_SHORT = {
  descent: 2.0,
} as const

/** Idle chase-cam offset (mirrors `idealOffset` in
 *  [camera.ts](./camera.ts)) so the descent ends where the chase cam
 *  picks up. Kept inline rather than imported to avoid coupling the
 *  intro module to the chase camera's internals — the values match by
 *  inspection, and a chase-cam tweak would be caught by the seamless-
 *  handoff visual test. */
const CHASE_IDLE_OFFSET = new THREE.Vector3(0, 2.5, -5.5)
const CHASE_IDLE_LOOK = new THREE.Vector3(0, 1.0, 6)

/** Smoothstep with an ease-in-out feel — `s` is unit interval [0,1]. */
function smootherstep(s: number): number {
  if (s <= 0) return 0
  if (s >= 1) return 1
  return s * s * s * (s * (s * 6 - 15) + 10)
}

export function createRaceIntro(opts: RaceIntroOpts): RaceIntro {
  const mode: RaceIntroMode = opts.mode ?? 'full'
  const timeScale = opts.timeScale ?? 1

  // 'off' mode short-circuits to done so the caller's first `armCountdown`
  // check resolves immediately. Still returns a real object so the
  // game-loop can be wired unconditionally.
  const shots: Shot[] = mode === 'off' ? [] : buildShots(opts, mode)
  const totalDuration = shots.reduce((sum, s) => sum + s.duration, 0)

  let elapsed = 0
  let done = mode === 'off'

  return {
    tick(dt: number): void {
      if (done) return
      elapsed += Math.max(0, dt) * timeScale
      if (elapsed >= totalDuration || shots.length === 0) {
        // Settle on the last shot's end pose so the chase-cam's first
        // tick reads a sane camera position before its own lerp kicks
        // in. Setting `done = true` flips `isActive()` to false on the
        // next caller check.
        const last = shots[shots.length - 1]
        if (last) {
          opts.camera.position.copy(last.to)
          opts.camera.lookAt(last.lookTo)
        }
        done = true
        return
      }
      // Walk the shot list to find which one we're in.
      let acc = 0
      for (const shot of shots) {
        if (elapsed < acc + shot.duration) {
          const localT = (elapsed - acc) / shot.duration
          const eased = smootherstep(localT)
          opts.camera.position.lerpVectors(shot.from, shot.to, eased)
          // Look-at point also eases between anchors — gives a smooth
          // tracking feel rather than a snap when one shot's lookTo
          // doesn't match the next shot's lookFrom.
          const tmpLook = new THREE.Vector3().lerpVectors(shot.lookFrom, shot.lookTo, eased)
          opts.camera.lookAt(tmpLook)
          return
        }
        acc += shot.duration
      }
    },
    isActive(): boolean {
      // Active for the whole window between construction and done.
      // The game loop relies on this being true on the very first
      // frame — it gates whether to tick the director or hand the
      // camera back to the chase cam, BEFORE calling tick() this
      // frame. A "haven't ticked yet" sentinel would defeat that.
      return !done
    },
    isDone(): boolean {
      return done
    },
    skip(): void {
      // Force the next tick to read past the last shot. We can't just
      // jump the camera to the final pose here because `tick` writes it
      // — leaving the elapsed counter primed means the next `tick` does
      // the final write and flips `done`.
      if (done) return
      elapsed = totalDuration + 1
    },
    totalDuration(): number {
      return totalDuration
    },
  }
}

/** Build the shot list for the given mode. Pure — depends only on the
 *  track + player-start so unit tests can exercise it without a live
 *  scene. */
export function buildShots(opts: RaceIntroOpts, mode: RaceIntroMode): Shot[] {
  if (mode === 'off') return []

  const start = opts.playerStart
  const startVec = new THREE.Vector3(start.x, start.y, start.z)

  // Anchor used by every shot — the player's chase-cam idle pose. This
  // is where the descent shot ends and where the chase camera will
  // pick up. Computed once and reused so a tracker-style cut between
  // shots keeps reading the same destination.
  const halfYaw = start.yaw * 0.5
  const startQuat = new THREE.Quaternion(0, Math.sin(halfYaw), 0, Math.cos(halfYaw))
  const chaseGoal = CHASE_IDLE_OFFSET.clone().applyQuaternion(startQuat).add(startVec)
  const chaseLook = CHASE_IDLE_LOOK.clone().applyQuaternion(startQuat).add(startVec)

  if (mode === 'short') {
    // Short mode: a single descent shot. Camera starts higher + further
    // back behind the grid, drifts to the chase position.
    const high = chaseGoal
      .clone()
      .add(new THREE.Vector3(0, 18, 0).add(new THREE.Vector3(0, 0, -8).applyQuaternion(startQuat)))
    return [
      {
        from: high,
        to: chaseGoal,
        lookFrom: startVec.clone().add(new THREE.Vector3(0, 1.2, 0)),
        lookTo: chaseLook,
        duration: SHOT_DURATION_SHORT.descent,
      },
    ]
  }

  // Full mode: three shots.
  //
  // 1. AERIAL — pulled-back overhead of the AI spline's mid-track
  //    "interesting" point (a checkpoint deep in the loop if available,
  //    otherwise the spline midpoint). High up, drifting outwards so
  //    the move parallaxes against the world.
  //
  // 2. SKIM — closer pass along the racing line a couple of corners
  //    out from the start. Lower and faster than the aerial; the move
  //    follows the spline's tangent at that point so it reads as
  //    "previewing the line".
  //
  // 3. DESCENT — high behind the start grid, falls to the chase pose.
  //    The intent is "the broadcast camera is settling behind the
  //    racers" — the bike grid becomes visible in the lower half of
  //    the frame as the camera arrives.
  const splinePoints =
    opts.track.aiSplines.find((s) => s.id === 'main')?.points ??
    opts.track.aiSplines[0]?.points ??
    []

  // Mid-track focal point. Prefer a checkpoint that's a meaningful
  // distance from the start (skip cp 0 which sits on the start line).
  // Falls back to the spline midpoint, then to a synthetic point
  // ahead of the start.
  const focalPoint = pickMidTrackFocus(opts.track, splinePoints, startVec)

  // Aerial — high above the focal point, slowly drifting outward
  // toward the start. Look direction tracks from the focal point back
  // toward where the grid will be.
  const aerialFrom = focalPoint.clone().add(new THREE.Vector3(0, 80, 0))
  const aerialDriftDir = new THREE.Vector3().subVectors(startVec, focalPoint).setY(0).normalize()
  if (aerialDriftDir.lengthSq() < 1e-4) aerialDriftDir.set(0, 0, 1)
  const aerialTo = focalPoint
    .clone()
    .add(new THREE.Vector3(0, 60, 0))
    .add(aerialDriftDir.clone().multiplyScalar(30))

  // Skim — between the focal point and the start, lower altitude.
  // Camera flies from "past the focal point" toward the start area.
  const skimMid = focalPoint.clone().lerp(startVec, 0.65)
  const skimAheadDir = new THREE.Vector3().subVectors(startVec, focalPoint).setY(0)
  const skimAheadLen = Math.max(20, skimAheadDir.length())
  skimAheadDir.normalize()
  if (skimAheadDir.lengthSq() < 1e-4) skimAheadDir.set(0, 0, 1)
  const skimRight = new THREE.Vector3(skimAheadDir.z, 0, -skimAheadDir.x)
  const skimFrom = skimMid
    .clone()
    .add(skimAheadDir.clone().multiplyScalar(-skimAheadLen * 0.25))
    .add(skimRight.clone().multiplyScalar(8))
    .add(new THREE.Vector3(0, 12, 0))
  const skimTo = skimMid
    .clone()
    .add(skimAheadDir.clone().multiplyScalar(skimAheadLen * 0.2))
    .add(skimRight.clone().multiplyScalar(-6))
    .add(new THREE.Vector3(0, 8, 0))
  const skimLookFrom = skimMid.clone().add(new THREE.Vector3(0, 1, 0))
  const skimLookTo = startVec.clone().add(new THREE.Vector3(0, 2, 0))

  // Descent — high behind the grid, falls to the chase pose.
  const descentFrom = chaseGoal
    .clone()
    .add(new THREE.Vector3(0, 26, 0))
    .add(new THREE.Vector3(0, 0, -10).applyQuaternion(startQuat))
  const descentLookFrom = startVec.clone().add(new THREE.Vector3(0, 1.5, 0))

  return [
    {
      from: aerialFrom,
      to: aerialTo,
      lookFrom: focalPoint.clone(),
      lookTo: focalPoint.clone().lerp(startVec, 0.5),
      duration: SHOT_DURATION_FULL.aerial,
    },
    {
      from: skimFrom,
      to: skimTo,
      lookFrom: skimLookFrom,
      lookTo: skimLookTo,
      duration: SHOT_DURATION_FULL.skim,
    },
    {
      from: descentFrom,
      to: chaseGoal,
      lookFrom: descentLookFrom,
      lookTo: chaseLook,
      duration: SHOT_DURATION_FULL.descent,
    },
  ]
}

/** Pick a focal point for the aerial shot. Prefers the checkpoint that
 *  sits furthest from cp 0 along the spline (so the camera doesn't sit
 *  right on top of the grid), falling back to the spline midpoint when
 *  the track has no useful checkpoint geometry. */
function pickMidTrackFocus(
  track: Track,
  splinePoints: ReadonlyArray<{ x: number; y: number; z: number }>,
  startVec: THREE.Vector3,
): THREE.Vector3 {
  // Prefer a "middle" checkpoint — index ≈ floor(n/2) of the track's
  // checkpoint list. Skips cp 0 (start line) explicitly so the aerial
  // doesn't sit on the grid. Two-or-fewer checkpoints fall through.
  const cps = track.checkpoints
  if (cps.length >= 3) {
    const midIdx = Math.floor(cps.length / 2)
    const cp = cps[midIdx]
    if (cp) {
      return new THREE.Vector3(cp.position.x, cp.position.y, cp.position.z)
    }
  }
  // Spline midpoint — only useful if the spline has any points.
  if (splinePoints.length > 0) {
    const mid = splinePoints[Math.floor(splinePoints.length / 2)]
    if (mid) return new THREE.Vector3(mid.x, mid.y, mid.z)
  }
  // Last-ditch fallback: just ahead of the start.
  return startVec.clone().add(new THREE.Vector3(0, 0, 40))
}
