/**
 * Rider head-pose boundedness (bug report: "heads spin freely when riding").
 *
 * Boots Sandbar into a live race, autopilots the player, then samples every
 * rider's Head/neck LOCAL quaternions per frame for ~8s via the
 * `__riderMannequin` dev hook. While attached, the head's local pose is the
 * seated clip's pose ⊗ a bounded headYaw offset (≤ headYawMax · gain ≈ 24°),
 * so its angular deviation from the first sample must stay small. A
 * free-spinning / accumulating head walks toward 180°. Ragdoll frames are
 * excluded (the clip is stopped and physics owns the bones).
 *
 * Screenshots land in artifacts/rider-head/ for the eyeball check.
 *
 *   E2E_PORT=5377 pnpm e2e tests/e2e/rider-head-spin.spec.ts
 */
import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

type RiderSample = {
  eid: number
  ragdoll: boolean
  clip: string | null
  running: boolean
  headLocal: number[]
  neckLocal: number[]
  headYaw: number
}
type FrameSample = { t: number; riders: RiderSample[] }

/** Angle (degrees) between two unit quaternions, sign/cover-agnostic. */
function quatAngleDeg(a: number[], b: number[]): number {
  const dot = Math.abs(
    (a[0] ?? 0) * (b[0] ?? 0) +
      (a[1] ?? 0) * (b[1] ?? 0) +
      (a[2] ?? 0) * (b[2] ?? 0) +
      (a[3] ?? 1) * (b[3] ?? 1),
  )
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI
}

test('rider heads stay bounded to the seated clip pose while racing', async ({ page }) => {
  test.setTimeout(150_000)
  mkdirSync('artifacts/rider-head', { recursive: true })

  await page.goto('/?autostart=1&track=sandbar&skipintro=1')
  await page.bringToFront()
  await waitForReady(page, { timeout: 60_000 })
  // Autopilot the player so the chase-cam subject steers constantly too.
  await page.evaluate(() => {
    if (!window.__hover?.isAutoPlay()) window.__hover?.toggleAutoPlay()
  })
  // Drive well past the countdown so the field is at speed and steering.
  await page.waitForFunction(() => (window.__hover?.frame() ?? 0) > 400, null, { timeout: 90_000 })

  // Sample per-frame inside the page (no round-trip jitter), screenshot from
  // outside while it runs.
  const sampling = page.evaluate(
    () =>
      new Promise<FrameSample[]>((resolve) => {
        type Hook = { debug(): RiderSample[] }
        const hook = (window as unknown as { __riderMannequin?: Hook }).__riderMannequin
        const out: { t: number; riders: RiderSample[] }[] = []
        const t0 = performance.now()
        const tick = () => {
          const t = performance.now() - t0
          out.push({ t, riders: hook ? hook.debug() : [] })
          if (t < 8000) requestAnimationFrame(tick)
          else resolve(out)
        }
        requestAnimationFrame(tick)
      }),
  )
  const shots = (async () => {
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(1200)
      await page.screenshot({ path: `artifacts/rider-head/ride-${i}.png` })
    }
  })()
  const samples = await sampling
  await shots

  expect(samples.length).toBeGreaterThan(100)
  expect(samples[0]?.riders.length ?? 0).toBeGreaterThanOrEqual(5)

  // Per rider: deviation of the head's LOCAL pose from its first attached
  // sample. neckDev tracks the same for the clip-only neck bone (mixer-health
  // signal: if the mixer stopped writing, the neck freezes while the head
  // accumulates).
  const eids = new Set<number>()
  for (const f of samples) for (const r of f.riders) eids.add(r.eid)

  let worst = { eid: -1, dev: 0 }
  let maxYawSeen = 0
  for (const eid of eids) {
    let ref: RiderSample | null = null
    let maxHeadDev = 0
    let maxNeckDev = 0
    let maxAbsHeadYaw = 0
    let attachedFrames = 0
    let runningFrames = 0
    let clip: string | null = null
    for (const f of samples) {
      const r = f.riders.find((x) => x.eid === eid)
      if (!r || r.ragdoll) continue
      attachedFrames++
      if (r.running) runningFrames++
      clip = r.clip
      if (!ref) {
        ref = r
        continue
      }
      maxHeadDev = Math.max(maxHeadDev, quatAngleDeg(ref.headLocal, r.headLocal))
      maxNeckDev = Math.max(maxNeckDev, quatAngleDeg(ref.neckLocal, r.neckLocal))
      maxAbsHeadYaw = Math.max(maxAbsHeadYaw, Math.abs(r.headYaw))
    }
    if (!ref || attachedFrames < 60) continue
    console.log(
      `eid=${eid} clip=${clip} attached=${attachedFrames} running=${runningFrames} ` +
        `maxHeadDev=${maxHeadDev.toFixed(1)}° maxNeckDev=${maxNeckDev.toFixed(1)}° ` +
        `maxHeadYaw=${((maxAbsHeadYaw * 180) / Math.PI).toFixed(1)}°`,
    )
    if (maxHeadDev > worst.dev) worst = { eid, dev: maxHeadDev }
    maxYawSeen = Math.max(maxYawSeen, maxAbsHeadYaw)
  }

  // The probe saw real steering — the head-look path actually ran.
  expect((maxYawSeen * 180) / Math.PI).toBeGreaterThan(2)
  // Bounded design budget: clip idle wobble (≤ ~10°) + headYaw offset
  // (≤ ~24°). 60° only trips on runaway accumulation, not tuning.
  expect(worst.dev).toBeLessThan(60)
})
