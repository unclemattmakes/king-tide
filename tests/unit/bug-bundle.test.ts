/**
 * Step 8 — Bug-bundle unit coverage.
 *
 * The bundle is pure assembly — every input is provided via the
 * `BundleSources` interface so the unit test can hand it a fully
 * synthetic surface. We assert:
 *
 *  - the schema version is locked at 1 so the GitHub issue template
 *    referencing it stays in sync
 *  - the leaderboard handle is masked to length only (never appears
 *    verbatim in the bundle)
 *  - missing optional sources don't NaN the bundle — every field is
 *    either populated or explicitly `null`
 *  - the console-trap dump matches the trap's view
 *  - `bundleToString` produces parseable JSON (round-trip) — the issue
 *    template's "paste this" affordance assumes the dump is valid JSON
 */
import { describe, expect, it } from 'vitest'
import { buildBugBundle, bundleToString } from '../../src/engine/qa/bug-bundle'

function fakeTrap(records: { source: string; message: string; ts: number }[]) {
  return {
    records: () => records as never,
    recordsSince: () => records as never,
    totalCount: () => records.length,
    clear: () => {},
    hasErrors: () =>
      records.some(
        (r) =>
          r.source === 'error' || r.source === 'pageerror' || r.source === 'unhandledrejection',
      ),
  }
}

describe('bug-bundle', () => {
  it('produces a schemaVersion=1 bundle with all expected sections', () => {
    const bundle = buildBugBundle({ consoleTrap: null })
    expect(bundle.schemaVersion).toBe(1)
    // ISO-8601 with milliseconds
    expect(bundle.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(typeof bundle.url).toBe('string')
    expect(typeof bundle.userAgent).toBe('string')
    expect(bundle.viewport).toMatchObject({
      innerWidth: expect.any(Number),
      innerHeight: expect.any(Number),
      devicePixelRatio: expect.any(Number),
    })
    expect(bundle.build).toMatchObject({ mode: expect.any(String), gitSha: null })
    expect(bundle.renderer.backend).toBe('unknown')
    expect(bundle.perf).toBeNull()
    expect(bundle.player).toBeNull()
    expect(bundle.race).toBeNull()
    expect(bundle.settings).toBeNull()
    expect(bundle.console).toMatchObject({ records: [], totalCount: 0 })
    expect(bundle.replay).toMatchObject({
      hasRecorder: false,
      eventCount: null,
      sizeBytes: null,
    })
    expect(bundle.network).toBeNull()
  })

  it('round-trips through JSON cleanly', () => {
    const bundle = buildBugBundle({ consoleTrap: null })
    const text = bundleToString(bundle)
    const parsed = JSON.parse(text)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.timestamp).toBe(bundle.timestamp)
  })

  it('masks the leaderboard handle to its length', () => {
    // We don't import PlayerSettings directly to avoid pulling the
    // module's localStorage side-effects into the unit test; the bundle
    // only cares that `leaderboardHandle` exists on the input.
    const settings = {
      leaderboardHandle: 'SECRET_NAME',
      otherFlag: true,
    } as unknown as import('../../src/engine/player-settings').PlayerSettings

    const bundle = buildBugBundle({
      consoleTrap: null,
      settings: () => settings,
    })
    expect(bundle.settings).not.toBeNull()
    expect(bundle.settings).not.toHaveProperty('leaderboardHandle')
    expect(bundle.settings?.leaderboardHandleLength).toBe('SECRET_NAME'.length)
  })

  it('mirrors the console trap dump', () => {
    const records = [
      { source: 'error', message: 'boom', ts: 1 },
      { source: 'warn', message: 'eh', ts: 2 },
    ]
    const bundle = buildBugBundle({ consoleTrap: fakeTrap(records) as never })
    expect(bundle.console.totalCount).toBe(2)
    expect(bundle.console.records).toHaveLength(2)
    expect(bundle.console.records[0]?.message).toBe('boom')
  })

  it('preserves player + race snapshots when accessors return them', () => {
    const bundle = buildBugBundle({
      consoleTrap: null,
      player: () => ({
        eid: 7,
        position: { x: 1, y: 2, z: 3 },
        velocity: { x: 4, y: 5, z: 6 },
        speed: 12,
        isGrounded: true,
      }),
      race: () => ({
        lap: 2,
        lapsToFinish: 3,
        nextCheckpoint: 5,
        checkpointsCrossed: 14,
        totalCheckpoints: 9,
        finished: false,
        raceTime: 45.6,
      }),
    })
    expect(bundle.player?.eid).toBe(7)
    expect(bundle.player?.position).toEqual({ x: 1, y: 2, z: 3 })
    expect(bundle.race?.lap).toBe(2)
    expect(bundle.race?.totalCheckpoints).toBe(9)
  })

  it('renders network state when the netProbe is wired', () => {
    const bundle = buildBugBundle({
      consoleTrap: null,
      network: () => ({
        ready: true,
        peerId: 0,
        remotePeers: [1, 2],
        isHost: true,
        snapshotsReceived: 42,
      }),
    })
    expect(bundle.network).toEqual({
      ready: true,
      peerId: 0,
      remotePeers: [1, 2],
      isHost: true,
      snapshotsReceived: 42,
    })
  })
})
