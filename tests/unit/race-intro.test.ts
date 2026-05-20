/**
 * Pre-lap intro director — pure-render module that flies a cinematic
 * camera sequence before the race countdown arms.
 *
 * Tests cover:
 *   - shot construction for each mode ('full' / 'short' / 'off')
 *   - lifecycle (`isActive` / `isDone` transitions, `tick` advancement)
 *   - the descent shot ends at the chase-camera's idle position so the
 *     handoff to `ChaseCamera.tick()` is seamless
 *   - `skip()` is idempotent + cuts to the final pose
 *   - degenerate tracks (no checkpoints, no spline) don't NaN out
 */

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { buildShots, createRaceIntro } from '../../src/engine/render/race-intro'
import type { Track } from '../../src/game/tracks/types'

function makeTrack(overrides: Partial<Track> = {}): Track {
  // Minimal track shaped enough for the intro to derive focal points.
  // Eight checkpoints in a loop + an AI spline through them; mirrors the
  // shipping track shape (Lagoon Loop, etc.). The points + start are
  // chosen so the focal-pick logic has more than one obvious candidate.
  const checkpoints = [
    { index: 0, position: { x: 0, y: 1, z: 0 } },
    { index: 1, position: { x: 30, y: 1, z: 10 } },
    { index: 2, position: { x: 50, y: 1, z: 40 } },
    { index: 3, position: { x: 40, y: 1, z: 80 } },
    { index: 4, position: { x: 0, y: 1, z: 100 } },
    { index: 5, position: { x: -40, y: 1, z: 80 } },
    { index: 6, position: { x: -50, y: 1, z: 40 } },
    { index: 7, position: { x: -30, y: 1, z: 10 } },
  ].map((c) => ({
    ...c,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    halfWidth: 8,
    height: 4,
  }))
  return {
    id: 'test',
    name: 'Test',
    start: { position: { x: 0, y: 1, z: -10 }, yaw: 0 },
    checkpoints,
    lapsToFinish: 3,
    surfaces: [],
    pickupSpawns: [],
    aiSplines: [
      {
        id: 'main',
        points: checkpoints.map((c) => c.position),
      },
    ],
    boostPads: [],
    antiGravZones: [],
    waveZones: [],
    props: [],
    ...overrides,
  }
}

const PLAYER_START = { x: 0, y: 1, z: -10, yaw: 0 }

describe('buildShots', () => {
  it("returns an empty list in 'off' mode", () => {
    const shots = buildShots(
      { camera: new THREE.PerspectiveCamera(), track: makeTrack(), playerStart: PLAYER_START },
      'off',
    )
    expect(shots).toHaveLength(0)
  })

  it("'short' mode yields one descent shot whose end is near the chase-idle pose", () => {
    const shots = buildShots(
      { camera: new THREE.PerspectiveCamera(), track: makeTrack(), playerStart: PLAYER_START },
      'short',
    )
    expect(shots).toHaveLength(1)
    const descent = shots[0]!
    // Chase idle for yaw=0 sits at (0, 2.5, -5.5) + start. With
    // start.y=1 + start.z=-10, the descent ends near (0, 3.5, -15.5).
    expect(descent.to.x).toBeCloseTo(0, 5)
    expect(descent.to.y).toBeCloseTo(3.5, 5)
    expect(descent.to.z).toBeCloseTo(-15.5, 5)
    // Camera starts higher than its final altitude.
    expect(descent.from.y).toBeGreaterThan(descent.to.y + 5)
  })

  it("'full' mode yields three shots ending at the chase-idle pose", () => {
    const shots = buildShots(
      { camera: new THREE.PerspectiveCamera(), track: makeTrack(), playerStart: PLAYER_START },
      'full',
    )
    expect(shots).toHaveLength(3)
    const last = shots[2]!
    expect(last.to.x).toBeCloseTo(0, 5)
    expect(last.to.y).toBeCloseTo(3.5, 5)
    expect(last.to.z).toBeCloseTo(-15.5, 5)
  })

  it("'full' mode's aerial shot starts well above the focal checkpoint", () => {
    const shots = buildShots(
      { camera: new THREE.PerspectiveCamera(), track: makeTrack(), playerStart: PLAYER_START },
      'full',
    )
    const aerial = shots[0]!
    // Mid checkpoint of an 8-CP loop is index 4 = (0, 1, 100). Aerial
    // starts 80m above it.
    expect(aerial.from.y).toBeGreaterThan(75)
    expect(aerial.lookFrom.y).toBeLessThan(aerial.from.y)
  })

  it('respects start.yaw — chase-idle pose rotates with the bike facing', () => {
    // Bike facing -X (yaw = -π/2 in Three.js: rotation about +Y by -π/2
    // takes the local +Z forward to world -X). The chase idle offset
    // (0, 2.5, -5.5) — "behind the bike" — rotates to ≈ (+5.5, 2.5, 0)
    // because the local -Z direction lines up with world +X.
    const shots = buildShots(
      {
        camera: new THREE.PerspectiveCamera(),
        track: makeTrack(),
        playerStart: { x: 0, y: 0, z: 0, yaw: -Math.PI / 2 },
      },
      'short',
    )
    const descent = shots[0]!
    expect(descent.to.x).toBeGreaterThan(3)
    expect(Math.abs(descent.to.z)).toBeLessThan(2)
  })

  it('falls back to a spline midpoint when checkpoints are scarce', () => {
    // 2 checkpoints — under the 3-cp threshold, so the focal-pick
    // routes through the spline midpoint instead.
    const splinePoints = [
      { x: 50, y: 0, z: 50 },
      { x: 100, y: 0, z: 50 },
      { x: 100, y: 0, z: 100 },
    ]
    const track = makeTrack({
      checkpoints: [
        {
          index: 0,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          halfWidth: 8,
          height: 4,
        },
        {
          index: 1,
          position: { x: 50, y: 0, z: 50 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          halfWidth: 8,
          height: 4,
        },
      ],
      aiSplines: [{ id: 'main', points: splinePoints }],
    })
    const shots = buildShots(
      { camera: new THREE.PerspectiveCamera(), track, playerStart: PLAYER_START },
      'full',
    )
    const aerial = shots[0]!
    // Spline midpoint is points[1] = (100, 0, 50). Aerial starts 80m above.
    expect(aerial.from.x).toBeCloseTo(100, 5)
    expect(aerial.from.z).toBeCloseTo(50, 5)
  })

  it('handles an empty spline + 1 checkpoint without NaN-ing', () => {
    const track = makeTrack({
      checkpoints: [
        {
          index: 0,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          halfWidth: 8,
          height: 4,
        },
      ],
      aiSplines: [{ id: 'main', points: [] }],
    })
    const shots = buildShots(
      { camera: new THREE.PerspectiveCamera(), track, playerStart: PLAYER_START },
      'full',
    )
    for (const shot of shots) {
      expect(Number.isFinite(shot.from.x)).toBe(true)
      expect(Number.isFinite(shot.from.y)).toBe(true)
      expect(Number.isFinite(shot.from.z)).toBe(true)
      expect(Number.isFinite(shot.to.x)).toBe(true)
      expect(Number.isFinite(shot.duration)).toBe(true)
    }
  })
})

describe('createRaceIntro lifecycle', () => {
  it("'off' mode is done immediately, never active", () => {
    const intro = createRaceIntro({
      camera: new THREE.PerspectiveCamera(),
      track: makeTrack(),
      playerStart: PLAYER_START,
      mode: 'off',
    })
    expect(intro.isActive()).toBe(false)
    expect(intro.isDone()).toBe(true)
    expect(intro.totalDuration()).toBe(0)
  })

  it("'short' mode plays + completes after totalDuration elapses", () => {
    const camera = new THREE.PerspectiveCamera()
    const intro = createRaceIntro({
      camera,
      track: makeTrack(),
      playerStart: PLAYER_START,
      mode: 'short',
    })
    // Before first tick the director is "done=false" but isActive() is
    // also false (the started flag hasn't flipped yet) — same shape the
    // game loop relies on for the "arm countdown on the first done frame"
    // logic.
    expect(intro.isActive()).toBe(false)
    expect(intro.isDone()).toBe(false)
    expect(intro.totalDuration()).toBeGreaterThan(0)

    // First tick — director starts playing.
    intro.tick(0.016)
    expect(intro.isActive()).toBe(true)
    expect(intro.isDone()).toBe(false)

    // Advance past the full duration. Two ticks of (total/2 + 0.05s)
    // each so we cross the boundary cleanly.
    const dur = intro.totalDuration()
    intro.tick(dur * 0.5)
    intro.tick(dur * 0.5 + 0.5)
    expect(intro.isActive()).toBe(false)
    expect(intro.isDone()).toBe(true)
  })

  it("'full' mode runs longer than 'short' mode", () => {
    const full = createRaceIntro({
      camera: new THREE.PerspectiveCamera(),
      track: makeTrack(),
      playerStart: PLAYER_START,
      mode: 'full',
    })
    const short = createRaceIntro({
      camera: new THREE.PerspectiveCamera(),
      track: makeTrack(),
      playerStart: PLAYER_START,
      mode: 'short',
    })
    expect(full.totalDuration()).toBeGreaterThan(short.totalDuration())
  })

  it('mid-shot tick writes a camera position between from + to', () => {
    const camera = new THREE.PerspectiveCamera()
    const intro = createRaceIntro({
      camera,
      track: makeTrack(),
      playerStart: PLAYER_START,
      mode: 'short',
    })
    // Halfway through the descent shot.
    const half = intro.totalDuration() * 0.5
    intro.tick(half)
    // Position should be between the descent's start (high) and end
    // (chase-idle ~3.5m above the spawn).
    expect(camera.position.y).toBeGreaterThan(3.5)
    expect(camera.position.y).toBeLessThan(22) // start altitude ≈ 19
  })

  it('skip() cuts the camera straight to the final pose', () => {
    const camera = new THREE.PerspectiveCamera()
    const intro = createRaceIntro({
      camera,
      track: makeTrack(),
      playerStart: PLAYER_START,
      mode: 'full',
    })
    intro.tick(0.016) // start playing
    intro.skip()
    intro.tick(0.016) // the skip-flagged tick writes the final pose + flips done
    expect(intro.isDone()).toBe(true)
    expect(intro.isActive()).toBe(false)
    // Camera should land near the chase-idle pose.
    expect(camera.position.x).toBeCloseTo(0, 1)
    expect(camera.position.y).toBeCloseTo(3.5, 1)
    expect(camera.position.z).toBeCloseTo(-15.5, 1)
  })

  it('skip() is idempotent', () => {
    const intro = createRaceIntro({
      camera: new THREE.PerspectiveCamera(),
      track: makeTrack(),
      playerStart: PLAYER_START,
      mode: 'full',
    })
    intro.skip()
    intro.tick(0.016)
    expect(intro.isDone()).toBe(true)
    // Second skip after we're done is a no-op (doesn't throw, doesn't
    // un-done the director).
    intro.skip()
    expect(intro.isDone()).toBe(true)
  })
})
