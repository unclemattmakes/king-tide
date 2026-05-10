import { REPLAY_FLOATS_PER_BIKE, type ReplayFile } from './format'

/** A single bike's interpolated transform at a moment in playback time. */
export type ReplayBikePose = {
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
}

export type ReplayPlayer = {
  readonly replay: ReplayFile
  readonly duration: number
  readonly bikeCount: number
  paused: boolean
  speed: number
  /** Current playback time in seconds (clamped to [0, duration]). */
  time: number
  /** Advance playback by `realDt` seconds and return interpolated poses. */
  tick(realDt: number, out: ReplayBikePose[]): void
  /** Sample at the current time without advancing. */
  sample(out: ReplayBikePose[]): void
  /** Jump to an absolute playback time. */
  seek(t: number): void
  /** Reached the end? Latched until seek() resets it. */
  ended(): boolean
}

export function createReplayPlayer(replay: ReplayFile): ReplayPlayer {
  const frames = replay.frames
  const bikeCount = replay.bikes.length
  const duration = frames.length > 0 ? frames[frames.length - 1]!.t : 0

  let time = 0
  let cursor = 0 // index of frame i where frames[i].t <= time < frames[i+1].t

  function findCursor(t: number): number {
    if (frames.length === 0) return 0
    if (t <= frames[0]!.t) return 0
    if (t >= frames[frames.length - 1]!.t) return frames.length - 1
    // Linear advance from current cursor — playback is almost always
    // monotonic forward so this is O(1) amortised. Fall back to bisect on
    // big seeks.
    if (frames[cursor]!.t <= t && cursor + 1 < frames.length && frames[cursor + 1]!.t > t) {
      return cursor
    }
    let lo = 0
    let hi = frames.length - 1
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      if (frames[mid]!.t <= t) lo = mid
      else hi = mid
    }
    return lo
  }

  function writePose(
    out: ReplayBikePose[],
    slot: number,
    x: number,
    y: number,
    z: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ) {
    const p = out[slot]!
    p.x = x
    p.y = y
    p.z = z
    p.qx = qx
    p.qy = qy
    p.qz = qz
    p.qw = qw
  }

  function sampleInto(out: ReplayBikePose[]) {
    if (frames.length === 0) return
    cursor = findCursor(time)
    const f0 = frames[cursor]!
    const f1 = frames[cursor + 1] ?? f0
    const span = f1.t - f0.t
    const u = span > 0 ? Math.max(0, Math.min(1, (time - f0.t) / span)) : 0
    for (let s = 0; s < bikeCount; s++) {
      const i = s * REPLAY_FLOATS_PER_BIKE
      const ax = f0.bikes[i]!
      const ay = f0.bikes[i + 1]!
      const az = f0.bikes[i + 2]!
      const aqx = f0.bikes[i + 3]!
      const aqy = f0.bikes[i + 4]!
      const aqz = f0.bikes[i + 5]!
      const aqw = f0.bikes[i + 6]!
      const bx = f1.bikes[i]!
      const by = f1.bikes[i + 1]!
      const bz = f1.bikes[i + 2]!
      const bqx = f1.bikes[i + 3]!
      const bqy = f1.bikes[i + 4]!
      const bqz = f1.bikes[i + 5]!
      const bqw = f1.bikes[i + 6]!
      const x = ax + (bx - ax) * u
      const y = ay + (by - ay) * u
      const z = az + (bz - az) * u
      // SLERP for orientation. Falls back to nlerp when quats are nearly
      // colinear (tiny sin), which matters because at 30Hz neighbouring
      // frames are <33ms apart and quats stay close.
      const sl = slerp(aqx, aqy, aqz, aqw, bqx, bqy, bqz, bqw, u)
      writePose(out, s, x, y, z, sl.x, sl.y, sl.z, sl.w)
    }
  }

  return {
    replay,
    duration,
    bikeCount,
    paused: false,
    speed: 1,
    get time() {
      return time
    },
    set time(t: number) {
      time = Math.max(0, Math.min(duration, t))
    },
    tick(realDt, out) {
      if (!this.paused) {
        time = Math.max(0, Math.min(duration, time + realDt * this.speed))
      }
      sampleInto(out)
    },
    sample(out) {
      sampleInto(out)
    },
    seek(t) {
      time = Math.max(0, Math.min(duration, t))
    },
    ended() {
      return time >= duration && duration > 0
    },
  }
}

const tmpSlerp = { x: 0, y: 0, z: 0, w: 1 }

function slerp(
  ax: number,
  ay: number,
  az: number,
  aw: number,
  bx: number,
  by: number,
  bz: number,
  bw: number,
  u: number,
): { x: number; y: number; z: number; w: number } {
  // Quaternion shortest-path: flip B if dot is negative so we slerp the short
  // way around. Without this, recordings can flip between equivalent
  // double-cover representations and the bike does a 360° spin between
  // frames.
  let cos = ax * bx + ay * by + az * bz + aw * bw
  let bx2 = bx
  let by2 = by
  let bz2 = bz
  let bw2 = bw
  if (cos < 0) {
    cos = -cos
    bx2 = -bx
    by2 = -by
    bz2 = -bz
    bw2 = -bw
  }
  let scaleA: number
  let scaleB: number
  if (cos > 0.9995) {
    // Nearly parallel → linear blend, then renormalise.
    scaleA = 1 - u
    scaleB = u
  } else {
    const omega = Math.acos(cos)
    const sinO = Math.sin(omega)
    scaleA = Math.sin((1 - u) * omega) / sinO
    scaleB = Math.sin(u * omega) / sinO
  }
  let x = scaleA * ax + scaleB * bx2
  let y = scaleA * ay + scaleB * by2
  let z = scaleA * az + scaleB * bz2
  let w = scaleA * aw + scaleB * bw2
  const len = Math.hypot(x, y, z, w) || 1
  x /= len
  y /= len
  z /= len
  w /= len
  tmpSlerp.x = x
  tmpSlerp.y = y
  tmpSlerp.z = z
  tmpSlerp.w = w
  return tmpSlerp
}

/** Allocate a per-bike pose array for use with `tick`/`sample`. */
export function makePoseBuffer(bikeCount: number): ReplayBikePose[] {
  const out: ReplayBikePose[] = []
  for (let i = 0; i < bikeCount; i++) {
    out.push({ x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 })
  }
  return out
}
