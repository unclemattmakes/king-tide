/**
 * Rider head-look regression pack.
 *
 * Test 1 — boundedness (bug report: "heads spin freely when riding"): boots
 * Sandbar into a live race, autopilots the player, then samples every rider's
 * Head/neck LOCAL quaternions per frame for ~8s via the `__riderMannequin`
 * dev hook. While attached, the head's local pose is the seated clip's pose ⊗
 * a bounded headYaw offset, so its angular deviation from the first sample
 * must stay small. A free-spinning / accumulating head walks toward 180°.
 * Ragdoll frames are excluded (the clip is stopped and physics owns the
 * bones). Also asserts the grid poses with DISTINCT per-variant clips (AI
 * spawn with their slot's variantId).
 *
 * Test 2 — responsiveness ("head is the first thing to move; the look leads
 * the bike"): overrides the player's intent with a full-stick flick and
 * times the sim headYaw attack (fast) and release (lazy).
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
  bikeEid: number
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
  // (≤ ~30° at full deflection, Head share thereof). 60° only trips on
  // runaway accumulation, not tuning.
  expect(worst.dev).toBeLessThan(60)

  // Vehicle-specific idles: AI spawn with their slot's variantId, so the
  // grid's riders pose with DISTINCT per-bike clips (the rotation fields
  // cruiser/stunt/racer/scout/sparrow), not a single shared one.
  const clips = new Set<string>()
  for (const f of samples) for (const r of f.riders) if (r.clip) clips.add(r.clip)
  console.log(`rider clips in field: ${[...clips].join(', ')}`)
  expect(clips.size).toBeGreaterThanOrEqual(3)
})

test('head look attacks fast on stick input and releases slow', async ({ page }) => {
  test.setTimeout(120_000)

  await page.goto('/?autostart=1&track=sandbar&skipintro=1')
  await page.bringToFront()
  await waitForReady(page, { timeout: 60_000 })
  // Past the countdown so player intent isn't gated.
  await page.waitForFunction(() => (window.__hover?.frame() ?? 0) > 400, null, { timeout: 90_000 })

  // Slam the stick via the intent override, sample the player rider's sim
  // headYaw per frame, then release and time the ease back to centre.
  const result = await page.evaluate(
    () =>
      new Promise<{ attackMs: number; peak: number; releaseMs: number }>((resolve, reject) => {
        type Hook = { debug(): { bikeEid: number; headYaw: number }[] }
        const hook = (window as unknown as { __riderMannequin?: Hook }).__riderMannequin
        const hover = window.__hover
        if (!hook || !hover) {
          reject(new Error('debug hooks missing'))
          return
        }
        const playerEid = hover.playerEid()
        const headYaw = () => hook.debug().find((r) => r.bikeEid === playerEid)?.headYaw ?? 0
        const steer = (v: number) =>
          hover.setIntentOverride({
            throttle: 0.5,
            steer: v,
            brake: 0,
            fire: false,
            boost: false,
            pitch: 0,
            trickLeft: false,
            trickRight: false,
          })

        const HEAD_YAW_MAX = 0.7 // rider-pose.ts headYawMax (rad)
        const t0 = performance.now()
        let attackMs = -1
        let peak = 0
        let releaseStart = 0
        let phase: 'attack' | 'release' = 'attack'
        steer(1)
        const tick = () => {
          const t = performance.now() - t0
          const y = headYaw()
          peak = Math.max(peak, y)
          if (phase === 'attack') {
            if (attackMs < 0 && y >= 0.6 * HEAD_YAW_MAX) attackMs = t
            if (t > 1200) {
              phase = 'release'
              releaseStart = t
              steer(0)
            }
          } else if (y <= 0.15 || t - releaseStart > 4000) {
            hover.setIntentOverride(null)
            resolve({ attackMs, peak, releaseMs: y <= 0.15 ? t - releaseStart : -1 })
            return
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
  console.log(
    `head-look: attack→60% in ${result.attackMs.toFixed(0)}ms, ` +
      `peak ${result.peak.toFixed(2)} rad, release→0.15rad in ${result.releaseMs.toFixed(0)}ms`,
  )

  // Attack: the head is the FIRST thing to move — 60% of full deflection
  // within 150ms of the stick (the tuned curve does it in ~2 sim ticks;
  // the budget absorbs frame drops).
  expect(result.attackMs).toBeGreaterThanOrEqual(0)
  expect(result.attackMs).toBeLessThan(150)
  // Holds (near) full deflection while the stick is held.
  expect(result.peak).toBeGreaterThan(0.6)
  // Release is the lazy side — measurably slower than the attack, but it
  // does come home.
  expect(result.releaseMs).toBeGreaterThan(result.attackMs)
  expect(result.releaseMs).toBeLessThan(1500)
})
