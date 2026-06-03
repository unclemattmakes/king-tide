import * as THREE from 'three'
import { createShark, type Shark } from './shark'

/**
 * The AirJaws out-of-bounds set-piece. A great white breaches from the depths:
 *
 *  - **hit**: rises vertically under the bike (homing so it stays aligned),
 *    gapes, snaps at the apex (ejecting the rider ragdoll), then arcs back into
 *    the deep carrying the bike in its mouth — a death-cam owns the shot, then
 *    the bike respawns on the line. The race credit was already forfeited.
 *  - **nearmiss**: you recovered in time — the shark breaches just wide and
 *    crashes back on empty water. No camera takeover, no respawn; you race on.
 *
 * Render-only. The sim mutations (rider eject, carry, respawn) are driven via
 * the callbacks the loop wires to the player's rigid body.
 */
export type SharkSequenceOpts = {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** Track water surface height — the shark starts below it. */
  waterHeight: () => number
  /** Live bike world position, written into `out`. Null if unavailable. */
  getBikePos: (out: THREE.Vector3) => THREE.Vector3 | null
  /** hit only — fired once at the chomp to eject the rider ragdoll. */
  onChomp: () => void
  /** hit only — place the bike at this world point each tick during the
   *  carry-down (it rides the shark's mouth). */
  carryBikeTo: (x: number, y: number, z: number) => void
  /** Fired once when the sequence ends — respawn (hit) + clear OOB state. */
  onComplete: () => void
  /** Impact cue (reuses the explosion boom). */
  audioCue?: () => void
}

export type SharkSequence = {
  start(kind: 'hit' | 'nearmiss', breach: { x: number; y: number; z: number }): void
  tick(dt: number): void
  isActive(): boolean
  /** True only while a 'hit' breach owns the camera (chase cam should yield). */
  ownsCamera(): boolean
  dispose(): void
}

const RISE_S = 0.85
const HANG_S = 0.12
const DOWN_S = 1.3
const SUBMERGE_S = 0.55

const NM_RISE_S = 0.65
const NM_DOWN_S = 0.8
const NM_TOTAL = NM_RISE_S + NM_DOWN_S
const NM_LATERAL = 7 // how far to the side the near-miss breaches

const START_DEPTH = 20 // metres below the surface the lunge begins
const SINK_DEPTH = 17 // metres below the surface the carry ends
const APEX_OVER = 1.4 // metres the apex clears the bike

const easeOut = (u: number): number => 1 - (1 - u) ** 3
const easeIn = (u: number): number => u * u * u

export function createSharkSequence(opts: SharkSequenceOpts): SharkSequence {
  let shark: Shark | null = null
  let active = false
  let kind: 'hit' | 'nearmiss' = 'hit'
  let t = 0
  let chomped = false
  let completed = false

  const breach = new THREE.Vector3()
  const prevPos = new THREE.Vector3()
  const curPos = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const mouth = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const Z = new THREE.Vector3(0, 0, 1)

  function ensureShark(): Shark {
    if (!shark) shark = createShark()
    if (!shark.group.parent) opts.scene.add(shark.group)
    shark.group.visible = true
    return shark
  }

  function orientAlongVelocity(s: Shark): void {
    fwd.copy(curPos).sub(prevPos)
    if (fwd.lengthSq() > 1e-6) {
      fwd.normalize()
      s.group.quaternion.setFromUnitVectors(Z, fwd)
    }
  }

  function end(): void {
    if (completed) return
    completed = true
    active = false
    if (shark) shark.group.visible = false
    opts.onComplete()
  }

  return {
    start(k, b) {
      kind = k
      breach.set(b.x, b.y, b.z)
      if (k === 'nearmiss') {
        breach.x += NM_LATERAL // crash wide of the player
      }
      t = 0
      chomped = false
      completed = false
      active = true
      const s = ensureShark()
      const startY = opts.waterHeight() - START_DEPTH
      s.group.position.set(breach.x, startY, breach.z)
      prevPos.copy(s.group.position)
      curPos.copy(s.group.position)
      s.setJawOpen(0)
    },

    tick(dt) {
      if (!active || !shark) return
      const s = shark
      t += dt
      s.update(dt)
      const water = opts.waterHeight()

      if (kind === 'nearmiss') {
        const apexY = breach.y + APEX_OVER
        const startY = water - START_DEPTH
        if (t < NM_RISE_S) {
          const u = easeOut(t / NM_RISE_S)
          curPos.set(breach.x, startY + (apexY - startY) * u, breach.z)
          s.setJawOpen(u)
        } else if (t < NM_TOTAL) {
          const u = easeIn((t - NM_RISE_S) / NM_DOWN_S)
          curPos.set(breach.x, apexY + (water - SINK_DEPTH - apexY) * u, breach.z)
          s.setJawOpen(1 - u)
          if (!chomped && t >= NM_RISE_S) {
            chomped = true
            opts.audioCue?.()
          }
        } else {
          end()
          return
        }
        s.group.position.copy(curPos)
        orientAlongVelocity(s)
        prevPos.copy(curPos)
        return
      }

      // ── hit ──────────────────────────────────────────────────────────────
      const apexY = breach.y + APEX_OVER
      if (t < RISE_S) {
        // Home on the bike so the lunge stays under it.
        if (opts.getBikePos(tmp)) {
          breach.x = tmp.x
          breach.z = tmp.z
          breach.y = tmp.y
        }
        const startY = water - START_DEPTH
        const u = easeOut(t / RISE_S)
        curPos.set(breach.x, startY + (breach.y + APEX_OVER - startY) * u, breach.z)
        s.setJawOpen(u)
      } else if (t < RISE_S + HANG_S) {
        if (!chomped) {
          chomped = true
          s.setJawOpen(1)
          opts.onChomp()
          opts.audioCue?.()
        }
        // Snap the jaw shut on the bike.
        const u = (t - RISE_S) / HANG_S
        s.setJawOpen(1 - 0.7 * u)
        curPos.set(breach.x, apexY, breach.z)
        s.mouthWorldPosition(mouth)
        opts.carryBikeTo(mouth.x, mouth.y, mouth.z)
      } else if (t < RISE_S + HANG_S + DOWN_S + SUBMERGE_S) {
        const u = easeIn((t - RISE_S - HANG_S) / (DOWN_S + SUBMERGE_S))
        const endY = water - SINK_DEPTH
        curPos.set(breach.x, apexY + (endY - apexY) * u, breach.z)
        s.setJawOpen(0.3 * (1 - u))
        s.mouthWorldPosition(mouth)
        opts.carryBikeTo(mouth.x, mouth.y, mouth.z)
      } else {
        end()
        return
      }
      s.group.position.copy(curPos)
      orientAlongVelocity(s)
      prevPos.copy(curPos)

      // Death-cam — frame the breach from the side, slightly above, tracking
      // the action. Lerp the camera in so the handoff from the chase cam is
      // smooth; a little jitter at the chomp sells the impact.
      const cam = opts.camera
      tmp.set(breach.x + 9, apexY + 4.5, breach.z + 8)
      cam.position.lerp(tmp, 0.12)
      const shakeT = t - RISE_S
      if (shakeT > 0 && shakeT < 0.3) {
        const a = (0.3 - shakeT) * 1.2
        cam.position.x += (Math.random() - 0.5) * a
        cam.position.y += (Math.random() - 0.5) * a
      }
      cam.lookAt(curPos.x, curPos.y + 0.5, curPos.z)
    },

    isActive() {
      return active
    },
    ownsCamera() {
      return active && kind === 'hit'
    },
    dispose() {
      if (shark) {
        shark.dispose()
        shark = null
      }
      active = false
    },
  }
}
