/**
 * M10.11/M10.12 — two-tab multiplayer e2e: the spec sketched in
 * docs/m10-11-state-sync.md §10 and deferred in status.md until the
 * 2026-06-09 hardening pass (docs/multiplayer-review.md item 7.3).
 *
 * Exercises the SUPPORTED flow end-to-end — both players share the
 * lobby, ready up, load in together, and race from their own 3-2-1
 * (mid-race joining is a product no per 2026-06-09; the relay locks the
 * room a grace period after start-race). What it pins:
 *
 *  1. Lobby cohort → race: two tabs ready up and land on the same
 *     ?race=1 URL; exactly one becomes AI host (tenure election).
 *  2. TransformSnapshots flow BOTH directions (the P0 regression class:
 *     the host's 8-bike broadcast used to RangeError and freeze the tab).
 *  3. Convergence: the non-host's snapshot-driven AI + remote-player
 *     bikes track the host's sim-truth poses within a lag tolerance,
 *     actually MOVE, and stay kinematic (a dynamic AI bike on the
 *     non-host means it's racing a divergent local sim).
 *  4. Host handoff on leave: close the host tab → survivor flips to
 *     host (all-dynamic AI) and the field keeps racing, no errors.
 *  5. Lobby start integrity (review finding #2): peers voting DIFFERENT
 *     tracks still navigate to the SAME race URL.
 *  6. The race lock: a join attempt after RACE_JOIN_GRACE_MS is turned
 *     away with the RACE IN PROGRESS notice and never enters the race.
 *
 * Relay sidecar: each Playwright worker spawns its own `partykit dev`
 * on a worker-unique port (E2E_PORT + 1017 + parallelIndex) so parallel
 * workers — and parallel Claude/dev sessions pinning different
 * E2E_PORTs — never share relay state. The app is pointed at it via the
 * first-class `?host=` override. The vite server still comes from
 * playwright.config.ts's webServer.
 *
 * Run it headed (repo default — real GPU):
 *   pwsh:  $env:E2E_PORT='5377'; pnpm e2e m10-11-state-sync
 *   bash:  E2E_PORT=5377 pnpm e2e m10-11-state-sync
 *
 * Tolerances: the non-host renders remote bikes ~100–150 ms behind the
 * owner (remote-interp INTERP_DELAY_MS + sampling skew), so at race
 * speeds (≤28 m/s) a per-bike gap of a few meters is healthy. Median
 * over several samples vs a 10 m bound cleanly separates "synced with
 * lag" from "divergent sims" (independent AI drifts tens of meters in
 * seconds — that was the M10.11 motivation) while absorbing one-sample
 * transients (wipeout respawn sweeps). Like m10-determinism, this file
 * captures console/page errors inline because it owns its own contexts
 * (the consoleErrors fixture binds to the default page fixture).
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import * as path from 'node:path'
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test'

// Chromium throttles (and can outright pause) rAF in occluded /
// backgrounded windows, and two headed same-size Playwright windows
// overlap exactly. A throttled tab's fixed-step sim crawls at the rAF
// dt-clamp rate (~6% speed), so its snapshot broadcast drops to ~1/s
// and its kinematic remote bikes freeze between sparse samples — while
// WebSocket receipt (off-rAF) keeps every `snapshotsReceived` gate
// green. Observed live in both directions before this was structural,
// and the anti-throttling flags alone did NOT reliably prevent it.
// Structural fix: the convergence test launches TWO separate browsers
// with explicitly non-overlapping windows, so neither can ever occlude
// the other; the flags stay as belt-and-braces.
const ANTI_THROTTLE_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
]
const HEADLESS = process.env.E2E_HEADLESS === '1'

test.use({ launchOptions: { args: ANTI_THROTTLE_ARGS } })

const E2E_PORT = Number(process.env.E2E_PORT ?? 5391)
// Salted with the worker pid so an orphaned sidecar from a previous
// (crashed / interrupted) run can never squat this run's port — a stale
// relay answers the readiness probe while running OLD relay code, which
// silently invalidates whatever behavior this run is testing.
const PARTY_PORT_BASE = Number(process.env.E2E_PARTY_PORT ?? E2E_PORT + 1017 + (process.pid % 200))

/** Must exceed party/relay.ts RACE_JOIN_GRACE_MS (30 s). */
const JOIN_GRACE_WAIT_MS = 32_000

// ── PartyKit sidecar ─────────────────────────────────────────────────

let party: ChildProcess | null = null
let partyPort = PARTY_PORT_BASE

async function startPartyKit(port: number): Promise<ChildProcess> {
  const bin = path.join(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'partykit.CMD' : 'partykit',
  )
  // .CMD shims need a shell on Windows (Node rejects them otherwise).
  const child = spawn(bin, ['dev', '--port', String(port)], {
    stdio: 'pipe',
    shell: process.platform === 'win32',
  })
  let log = ''
  child.stdout?.on('data', (d: Buffer) => {
    log += d.toString()
    // Surface relay-side decisions (joins, rejects) in the test output —
    // without this, a relay that silently admits instead of rejecting is
    // indistinguishable from a client that swallowed the rejection.
    for (const line of d.toString().split('\n')) {
      if (line.includes('[relay]')) console.log(`[sidecar:${port}] ${line.trim()}`)
    }
  })
  child.stderr?.on('data', (d: Buffer) => {
    log += d.toString()
  })
  // Ready when the local HTTP endpoint answers at all (root returns a
  // 404-ish response once the worker is up). First run pays an esbuild
  // of party/relay.ts — keep the budget generous.
  const deadline = Date.now() + 60_000
  for (;;) {
    // Child-death check BEFORE the probe: if the port was squatted (an
    // orphaned sidecar), `partykit dev` dies with EADDRINUSE while the
    // probe would still get a 200 from the impostor.
    if (child.exitCode !== null) {
      throw new Error(`partykit dev exited (${child.exitCode}) before ready:\n${log}`)
    }
    try {
      await fetch(`http://127.0.0.1:${port}/`)
      if (child.exitCode !== null) {
        throw new Error(`port :${port} is answering but our partykit exited — stale sidecar?`)
      }
      return child
    } catch (err) {
      if (err instanceof Error && err.message.includes('stale sidecar')) throw err
      if (Date.now() > deadline) {
        stopPartyKit(child)
        throw new Error(`partykit dev not reachable on :${port} after 60s:\n${log}`)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

function stopPartyKit(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    // Kill the whole tree — the .CMD shim parents a node process.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  partyPort = PARTY_PORT_BASE + test.info().parallelIndex
  party = await startPartyKit(partyPort)
})

test.afterAll(() => {
  stopPartyKit(party)
  party = null
})

// ── Tab plumbing ─────────────────────────────────────────────────────

type Tab = { ctx: BrowserContext; page: Page; errors: string[] }

async function bootTab(browser: Browser, url: string): Promise<Tab> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })
  await page.goto(url)
  return { ctx, page, errors }
}

/** A dedicated browser whose window is pinned to a known screen slot so
 *  two of them can never overlap (see the anti-throttling note above).
 *  `slot` 0 = left half, 1 = right half. */
function launchSideBySide(slot: 0 | 1): Promise<Browser> {
  return chromium.launch({
    headless: HEADLESS,
    args: [...ANTI_THROTTLE_ARGS, `--window-position=${slot * 880},0`, '--window-size=860,680'],
  })
}

type NetSample = {
  ready: boolean
  peerId: number
  remotePeers: readonly number[]
  isHost: boolean
  snapshotsReceived: number
}

function readNet(page: Page): Promise<NetSample | null> {
  return page.evaluate(() => {
    const np = window.__hover?.net
    if (!np) return null
    return {
      ready: np.ready(),
      peerId: np.peerId(),
      remotePeers: np.remotePeers(),
      isHost: np.isHost(),
      snapshotsReceived: np.snapshotsReceived(),
    }
  })
}

async function waitNet(
  page: Page,
  label: string,
  pred: (n: NetSample) => boolean,
  timeoutMs = 60_000,
): Promise<NetSample> {
  const deadline = Date.now() + timeoutMs
  let last: NetSample | null = null
  for (;;) {
    last = await readNet(page)
    if (last && pred(last)) return last
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${label}; last: ${JSON.stringify(last)}`)
    }
    await page.waitForTimeout(400)
  }
}

type Pos = { x: number; y: number; z: number } | null
type Poses = {
  player: Pos
  ai: Pos[]
  aiDynamic: boolean[]
  remote: Record<number, Exclude<Pos, null>>
}

function readPoses(page: Page): Promise<Poses | null> {
  return page.evaluate(() => window.__hover?.net?.bikePoses() ?? null)
}

function dist(a: Pos, b: Pos): number | null {
  if (!a || !b) return null
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** Largest displacement of any AI bike between two pose snapshots. */
function maxAiDisplacement(from: Poses, to: Poses): number {
  let max = 0
  for (let i = 0; i < to.ai.length; i++) {
    const d = dist(from.ai[i] ?? null, to.ai[i] ?? null)
    if (d !== null && d > max) max = d
  }
  return max
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? Number.NaN
}

type BarrierStamps = { supported: boolean; loadedAt: number | null; goAt: number | null }

/** Poll the synchronized-start stamps until race-go has landed.
 *  Timestamps are Date.now, so two tabs on one machine compare. */
async function waitBarrierGo(
  page: Page,
  label: string,
): Promise<BarrierStamps & { goAt: number; loadedAt: number }> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const b = await page.evaluate(() => window.__hover?.net?.barrier() ?? null)
    if (b?.goAt != null && b.loadedAt != null) {
      return b as BarrierStamps & { goAt: number; loadedAt: number }
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${label}; last barrier: ${JSON.stringify(b)}`)
    }
    await page.waitForTimeout(200)
  }
}

/** Lobby URL for this worker's relay. No `race=1` — the lobby phase owns
 *  navigation into the race. */
function lobbyUrl(room: string, track: string): string {
  return `/?room=${room}&track=${track}&bike=racer&host=localhost:${partyPort}`
}

/** Drive a lobby tab to readiness: connected, expected rider count
 *  visible, then click READY. */
async function readyUp(tab: Tab, expectedRiders: number): Promise<void> {
  await tab.page.waitForSelector('#lobby-ready:not([disabled])', { timeout: 60_000 })
  await tab.page.waitForFunction(
    (n) => document.querySelectorAll('.bc-slot.filled').length === n,
    expectedRiders,
    { timeout: 30_000 },
  )
  await tab.page.click('#lobby-ready')
}

// ── Tests ────────────────────────────────────────────────────────────

// Sequential in ONE worker (overrides the config's fullyParallel):
// each test boots multiple full app instances, and three tests' worth
// of parallel chromium boots + cold vite transforms can push a race
// tab's load past the relay's 25 s start timeout — which releases the
// grid early and reads as a barrier-skew failure. 'default' (not
// 'serial') so a failure doesn't skip the remaining tests.
test.describe.configure({ mode: 'default' })

test.describe('M10.11 two-tab state sync', () => {
  test('lobby cohort races together; snapshots converge; host hands off on leave', async () => {
    // Two lobby boots + two race boots + intro/countdown + spread +
    // sampling + handoff.
    test.setTimeout(300_000)
    const room = `SYNC${Date.now().toString(36).toUpperCase()}`

    // Dedicated, non-overlapping browser windows — NOT two contexts of
    // the shared fixture browser, whose stacked windows occlude each
    // other and get rAF-throttled (see header). Closed in finally.
    const browserA = await launchSideBySide(0)
    const browserB = await launchSideBySide(1)
    try {
      await runConvergenceScenario(browserA, browserB, room)
    } finally {
      await browserA.close()
      await browserB.close()
    }
  })

  async function runConvergenceScenario(
    browserA: Browser,
    browserB: Browser,
    room: string,
  ): Promise<void> {
    // ── Lobby phase: the supported entry into a multiplayer race. ──
    const A = await bootTab(browserA, lobbyUrl(room, 'sandbar'))
    await A.page.waitForSelector('#lobby-ready:not([disabled])', { timeout: 60_000 })
    const B = await bootTab(browserB, lobbyUrl(room, 'sandbar'))
    await readyUp(B, 2)
    await readyUp(A, 2)

    // Both navigate into the same race (deterministic pick — both voted
    // sandbar here; the differing-votes case is its own test below).
    await A.page.waitForURL(/[?&]race=1/, { timeout: 30_000 })
    await B.page.waitForURL(/[?&]race=1/, { timeout: 30_000 })

    // ── Race phase. Whichever race tab reconnected first holds the
    // lowest joinSeq and the AI authority — resolve host vs spectator
    // dynamically instead of assuming boot order.
    await waitNet(A.page, 'A in race room', (n) => n.ready && n.remotePeers.length === 1, 90_000)
    await waitNet(B.page, 'B in race room', (n) => n.ready && n.remotePeers.length === 1, 90_000)
    const aNet = await readNet(A.page)
    const bNet = await readNet(B.page)
    expect(
      aNet?.isHost !== bNet?.isHost,
      `exactly one host expected; A=${JSON.stringify(aNet)} B=${JSON.stringify(bNet)}`,
    ).toBe(true)
    const H = aNet?.isHost ? A : B // AI authority
    const S = aNet?.isHost ? B : A // spectator of the AI field
    const hPeerId = (aNet?.isHost ? aNet : bNet)?.peerId as number

    // ── Synchronized start. Each tab reports race-loaded and holds its
    // 3-2-1 until the relay's single race-go. The Date.now stamps prove
    // the barrier semantics: one go, delivered to both tabs nearly
    // simultaneously, and only after the LAST tab finished loading —
    // start skew is relay latency, not load-time difference.
    const barH = await waitBarrierGo(H.page, 'H race-go')
    const barS = await waitBarrierGo(S.page, 'S race-go')
    expect(barH.supported, 'relay advertises the start barrier').toBe(true)
    expect(Math.abs(barH.goAt - barS.goAt), `go skew: H=${barH.goAt} S=${barS.goAt}`).toBeLessThan(
      750,
    )
    // 250 ms fudge: loadedAt stamps before the report hits the wire and
    // the relay's go comes back, so exact ordering has a small window.
    expect(barH.goAt, 'go waited for S to load').toBeGreaterThanOrEqual(barS.loadedAt - 250)
    expect(barS.goAt, 'go waited for H to load').toBeGreaterThanOrEqual(barH.loadedAt - 250)

    // Drive the host's player in a wide arc via the intent override
    // (which also fast-forwards its countdown — fine, the shared-start
    // proof above is already banked) so the remote-player convergence
    // check sees real motion, not a bike idling at spawn.
    await H.page.evaluate(() => {
      window.__hover?.setIntentOverride({
        throttle: 0.55,
        steer: 0.12,
        brake: 0,
        fire: false,
        boost: false,
        pitch: 0,
        trickLeft: false,
        trickRight: false,
      })
    })

    // Snapshots must flow both directions. S gets the host's 8-bike
    // records (the P0 freeze scenario), H gets S's 1-bike player records.
    await waitNet(S.page, 'S receiving host snapshots', (n) => n.snapshotsReceived > 0, 30_000)
    await waitNet(H.page, 'H receiving peer snapshots', (n) => n.snapshotsReceived > 0, 30_000)

    // Wait for the race to actually spread the field: the host's AI must
    // clear its grid slot by a sim-meaningful margin (3-2-1 + launch).
    const hBase = (await readPoses(H.page)) as Poses
    const sBase = (await readPoses(S.page)) as Poses
    expect(hBase).not.toBeNull()
    expect(sBase).not.toBeNull()
    const spreadDeadline = Date.now() + 120_000
    for (;;) {
      const now = (await readPoses(H.page)) as Poses
      if (maxAiDisplacement(hBase, now) > 25) break
      if (Date.now() > spreadDeadline) {
        throw new Error('host AI never left the grid — race did not start?')
      }
      await H.page.waitForTimeout(1000)
    }

    // Convergence: six paired samples, 500 ms apart; per sample take the
    // worst per-bike gap (AI index i on H is AI index i on S — snapshot
    // bikeIndex aligns the arrays) and the remote-player gap (S's view
    // of the host's bike vs the host's sim truth).
    const aiGaps: number[] = []
    const playerGaps: number[] = []
    const sampleDiag: string[] = []
    for (let s = 0; s < 6; s++) {
      const h = (await readPoses(H.page)) as Poses
      const sv = (await readPoses(S.page)) as Poses
      let worstAi = 0
      let pairs = 0
      for (let i = 0; i < h.ai.length; i++) {
        const d = dist(h.ai[i] ?? null, sv.ai[i] ?? null)
        if (d === null) continue
        pairs++
        if (d > worstAi) worstAi = d
      }
      expect(pairs, 'both tabs expose the full AI field').toBeGreaterThanOrEqual(5)
      aiGaps.push(worstAi)
      const dp = dist(h.player, sv.remote[hPeerId] ?? null)
      if (dp !== null) playerGaps.push(dp)
      // The spectator's AI must be kinematic (snapshot-driven). A
      // dynamic AI bike here means it's racing a divergent local sim.
      expect(
        sv.aiDynamic.filter(Boolean).length,
        'spectator AI bikes must all be kinematic while the host lives',
      ).toBe(0)
      // Triage breadcrumbs: frozen sDisp with growing gaps = spectator
      // loop stalled; dynamic AI on S = host-role leak; stalled rx
      // counters = relay/socket trouble.
      const sDisp = maxAiDisplacement(sBase, sv).toFixed(1)
      const hNet2 = await readNet(H.page)
      const sNet2 = await readNet(S.page)
      sampleDiag.push(
        `s${s}: gap=${worstAi.toFixed(1)} sDispFromBase=${sDisp} ` +
          `hostH=${hNet2?.isHost} hostS=${sNet2?.isHost} ` +
          `rxH=${hNet2?.snapshotsReceived} rxS=${sNet2?.snapshotsReceived}`,
      )
      await H.page.waitForTimeout(500)
    }
    // Median absorbs single-sample transients (a wipeout respawn sweep);
    // 10 m >> healthy interp lag (≤ ~4 m) and << divergent-sim drift.
    expect(median(aiGaps), `AI convergence:\n${sampleDiag.join('\n')}`).toBeLessThan(10)
    expect(playerGaps.length, 'S exposes a remote bike for the host').toBeGreaterThanOrEqual(5)
    expect(
      median(playerGaps),
      `player gaps per sample: ${playerGaps.map((d) => d.toFixed(1))}`,
    ).toBeLessThan(10)

    // The convergence above must come from the wire: the spectator's
    // kinematic bikes moved because snapshots drove them.
    const sNow = (await readPoses(S.page)) as Poses
    expect(
      maxAiDisplacement(sBase, sNow),
      'spectator AI bikes are snapshot-driven (they moved)',
    ).toBeGreaterThan(25)

    // Host leaves → survivor takes over without errors: AI flips
    // dynamic under the promoted host and keeps racing.
    expect(H.errors, H.errors.join('\n')).toEqual([])
    await H.ctx.close()
    await waitNet(
      S.page,
      'S promoted to host after H left',
      (n) => n.isHost && n.remotePeers.length === 0,
      30_000,
    )
    const handoffBase = (await readPoses(S.page)) as Poses
    expect(
      handoffBase.aiDynamic.every(Boolean),
      'promoted host runs every AI bike dynamically',
    ).toBe(true)
    await S.page.waitForTimeout(2500)
    const handoffNow = (await readPoses(S.page)) as Poses
    expect(
      maxAiDisplacement(handoffBase, handoffNow),
      'AI keeps moving under the promoted host',
    ).toBeGreaterThan(4)
    expect(S.errors, S.errors.join('\n')).toEqual([])
    await S.ctx.close()
  }

  test('lobby: peers voting different tracks navigate to the same race', async ({ browser }) => {
    test.setTimeout(180_000)
    const room = `LOBBY${Date.now().toString(36).toUpperCase()}`

    // Different votes — the exact split-brain setup from review finding
    // #2 (pre-fix, each tab rolled its own Math.random over the votes
    // and could navigate to a different winner).
    const A = await bootTab(browser, lobbyUrl(room, 'sandbar'))
    await A.page.waitForSelector('#lobby-ready:not([disabled])', { timeout: 60_000 })
    const B = await bootTab(browser, lobbyUrl(room, 'the-maw'))
    await readyUp(B, 2)
    await readyUp(A, 2)

    // Deterministic pick + relay sticky winner → both tabs must land on
    // the SAME ?race=1 URL (1.4 s banner pause, then navigation).
    await A.page.waitForURL(/[?&]race=1/, { timeout: 30_000 })
    await B.page.waitForURL(/[?&]race=1/, { timeout: 30_000 })
    const trackA = new URL(A.page.url()).searchParams.get('track')
    const trackB = new URL(B.page.url()).searchParams.get('track')
    expect(trackA).not.toBeNull()
    expect(trackA).toBe(trackB)
    expect(['sandbar', 'the-maw']).toContain(trackA)

    // Uncaught exceptions only — the post-navigation race boot is out of
    // scope here (the convergence test owns it) and its console chatter
    // shouldn't fail the lobby contract.
    const pageErrors = [...A.errors, ...B.errors].filter((e) => e.startsWith('pageerror'))
    expect(pageErrors, pageErrors.join('\n')).toEqual([])
    await A.ctx.close()
    await B.ctx.close()
  })

  test('mid-race join is rejected after the grace window', async ({ browser }) => {
    // Solo cohort + race boot + the 30 s relay grace + rejection. The
    // lobby→race handoff empties the room (every lobby socket closes at
    // the banner timeout while race tabs spend seconds loading), so this
    // also pins the relay's in-grace empty-room exception: the race
    // state must SURVIVE the handoff gap for the lock to ever arm.
    test.setTimeout(240_000)
    const room = `LOCK${Date.now().toString(36).toUpperCase()}`

    // A readies alone → solo race starts → the relay stamps
    // raceStartedAt and begins counting the join grace.
    const A = await bootTab(browser, lobbyUrl(room, 'sandbar'))
    await readyUp(A, 1)
    await A.page.waitForURL(/[?&]race=1/, { timeout: 30_000 })
    // A's race tab reconnects within the grace (to a briefly-empty room)
    // — must be admitted.
    await waitNet(A.page, "A's race tab admitted in-grace", (n) => n.ready, 90_000)

    // Let the grace window lapse, then try to join.
    await A.page.waitForTimeout(JOIN_GRACE_WAIT_MS)
    const C = await bootTab(browser, lobbyUrl(room, 'sandbar'))
    try {
      await C.page.waitForFunction(
        () => document.querySelector('#lobby-banner')?.textContent?.includes('RACE IN PROGRESS'),
        null,
        { timeout: 30_000 },
      )
    } catch (err) {
      const url = C.page.url()
      const banner = await C.page
        .evaluate(() => document.querySelector('#lobby-banner')?.textContent ?? '(no banner el)')
        .catch(() => '(page gone)')
      const readyBtn = await C.page
        .evaluate(() => document.querySelector('#lobby-ready')?.textContent ?? '(no btn)')
        .catch(() => '(page gone)')
      throw new Error(
        `no RACE IN PROGRESS notice; C url=${url} banner=${JSON.stringify(banner)} ` +
          `readyBtn=${JSON.stringify(readyBtn)} consoleErrors=${JSON.stringify(C.errors)}`,
        { cause: err },
      )
    }
    // The locked-out tab must never navigate into the race.
    await C.page.waitForTimeout(3000)
    expect(C.page.url()).not.toMatch(/[?&]race=1/)

    // The racer is untouched by the rejected join attempt.
    const aNet = await readNet(A.page)
    expect(aNet?.ready).toBe(true)
    expect(aNet?.isHost).toBe(true)
    const pageErrors = [...A.errors, ...C.errors].filter((e) => e.startsWith('pageerror'))
    expect(pageErrors, pageErrors.join('\n')).toEqual([])
    await A.ctx.close()
    await C.ctx.close()
  })
})
