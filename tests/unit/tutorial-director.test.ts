/**
 * Tutorial director — predicate-driven beat advancer.
 *
 * The director is the brains of the tutorial framework — it takes a
 * `TutorialScript`, holds the active beat index, advances on the
 * beat's `clearWhen` predicate (or its `clearAfterSeconds` timeout),
 * and emits arm/clear/completed callbacks for the HUD widget to
 * consume. These tests cover the lifecycle, the out-of-band signals
 * (pump + orbit), the timeout fallback, and the manual skip path.
 */

import { describe, expect, it } from 'vitest'
import { createTutorialDirector } from '../../src/engine/tutorial/tutorial-director'
import type { TutorialBeat, TutorialScript } from '../../src/engine/tutorial/tutorial-script'

function makeScript(beats: TutorialBeat[]): TutorialScript {
  return {
    id: 'test',
    label: 'TEST',
    finishMessage: 'DONE',
    beats,
  }
}

const defaultSample = { playerSpeed: 0, throttle: 0, inAntiGrav: false }

describe('createTutorialDirector', () => {
  it('arms the first beat on the first tick', () => {
    const armed: string[] = []
    const script = makeScript([
      { id: 'a', title: 'A', clearWhen: () => false },
      { id: 'b', title: 'B', clearWhen: () => false },
    ])
    const dir = createTutorialDirector(script, {
      onBeatArmed: (b) => armed.push(b.id),
    })
    expect(dir.currentBeat()).toBe(null) // lazy arm
    dir.tick(0.016, defaultSample)
    expect(armed).toEqual(['a'])
    expect(dir.currentBeat()?.id).toBe('a')
    expect(dir.currentBeatIndex()).toBe(0)
  })

  it('clears a beat when its predicate fires and arms the next', () => {
    const cleared: string[] = []
    const armed: string[] = []
    const script = makeScript([
      { id: 'speed', title: 'GO', clearWhen: (ctx) => ctx.playerSpeed > 5 },
      { id: 'speed2', title: 'GO2', clearWhen: (ctx) => ctx.playerSpeed > 10 },
    ])
    const dir = createTutorialDirector(script, {
      onBeatArmed: (b) => armed.push(b.id),
      onBeatCleared: (b) => cleared.push(b.id),
    })
    dir.tick(0.016, { playerSpeed: 2, throttle: 1, inAntiGrav: false })
    expect(cleared).toEqual([])
    dir.tick(0.016, { playerSpeed: 7, throttle: 1, inAntiGrav: false })
    expect(cleared).toEqual(['speed'])
    expect(armed).toEqual(['speed', 'speed2'])
    expect(dir.currentBeatIndex()).toBe(1)
  })

  it('clears via timeout when clearWhen never fires', () => {
    const cleared: string[] = []
    const script = makeScript([
      { id: 'wait', title: 'WAIT', clearWhen: () => false, clearAfterSeconds: 2 },
      { id: 'next', title: 'NEXT', clearWhen: () => true },
    ])
    const dir = createTutorialDirector(script, {
      onBeatCleared: (b) => cleared.push(b.id),
    })
    // 1 second in — should still be on beat 0.
    for (let i = 0; i < 60; i += 1) dir.tick(0.016, defaultSample)
    expect(cleared).toEqual([])
    // Cross the 2-second threshold — beat 0 timeout-clears, beat 1
    // arms, beat 1's clearWhen (true) fires immediately.
    for (let i = 0; i < 80; i += 1) dir.tick(0.016, defaultSample)
    expect(cleared).toContain('wait')
  })

  it('emits onCompleted exactly once after the final beat clears', () => {
    let completedCount = 0
    const script = makeScript([{ id: 'only', title: 'ONLY', clearWhen: () => true }])
    const dir = createTutorialDirector(script, {
      onCompleted: () => {
        completedCount += 1
      },
    })
    dir.tick(0.016, defaultSample)
    expect(completedCount).toBe(1)
    expect(dir.isCompleted()).toBe(true)
    expect(dir.currentBeat()).toBe(null)
    // Extra ticks after completion do nothing.
    dir.tick(0.016, defaultSample)
    dir.tick(0.016, defaultSample)
    expect(completedCount).toBe(1)
  })

  it('tracks pump events per-beat (counter resets at each arm)', () => {
    const cleared: string[] = []
    const script = makeScript([
      { id: 'first', title: 'FIRST', clearWhen: () => true },
      {
        id: 'pump-once',
        title: 'PUMP',
        clearWhen: (ctx) => ctx.pumpEventsThisBeat >= 1,
      },
    ])
    const dir = createTutorialDirector(script, {
      onBeatCleared: (b) => cleared.push(b.id),
    })
    // Arm beat 0, fire 3 pumps under it, clear it. Beat 1's pump
    // counter should start at 0, NOT inherit the 3 pumps.
    dir.tick(0.016, defaultSample) // arms + clears beat 0
    expect(cleared).toEqual(['first'])
    dir.notifyPumpEvent()
    dir.notifyPumpEvent()
    dir.notifyPumpEvent()
    // No tick yet to evaluate beat 1's predicate — give it one frame.
    dir.tick(0.016, defaultSample)
    expect(cleared).toContain('pump-once')
  })

  it('respects notifyOrbitTouch on the look-around-style beat', () => {
    const cleared: string[] = []
    const script = makeScript([
      {
        id: 'look',
        title: 'LOOK',
        clearWhen: (ctx) => ctx.orbitTouchedThisBeat,
      },
    ])
    const dir = createTutorialDirector(script, {
      onBeatCleared: (b) => cleared.push(b.id),
    })
    dir.tick(0.016, defaultSample) // arms beat 0
    expect(cleared).toEqual([])
    dir.notifyOrbitTouch()
    dir.tick(0.016, defaultSample)
    expect(cleared).toEqual(['look'])
  })

  it('clears a drift beat once notifyDrift reports a charged release', () => {
    const cleared: string[] = []
    const script = makeScript([
      {
        id: 'drift',
        title: 'DRIFT',
        clearWhen: (ctx) => ctx.driftTierThisBeat >= 1,
      },
    ])
    const dir = createTutorialDirector(script, {
      onBeatCleared: (b) => cleared.push(b.id),
    })
    dir.tick(0.016, defaultSample) // arms beat 0
    expect(cleared).toEqual([])
    dir.notifyDrift(1) // blue MT release
    dir.tick(0.016, defaultSample)
    expect(cleared).toEqual(['drift'])
  })

  it('notifyDrift keeps the MAX tier seen this beat', () => {
    let seenTier = 0
    const script = makeScript([
      {
        id: 'drift-smt',
        title: 'DRIFT',
        clearWhen: (ctx) => {
          seenTier = ctx.driftTierThisBeat
          return ctx.driftTierThisBeat >= 2
        },
      },
    ])
    const dir = createTutorialDirector(script)
    dir.tick(0.016, defaultSample) // arms beat 0
    dir.notifyDrift(2) // SMT
    dir.notifyDrift(1) // a later weaker release must NOT lower the max
    dir.tick(0.016, defaultSample)
    expect(seenTier).toBe(2)
    expect(dir.isCompleted()).toBe(true)
  })

  it('driftTierThisBeat resets when a new beat arms', () => {
    const cleared: string[] = []
    const script = makeScript([
      { id: 'first', title: 'FIRST', clearWhen: () => true },
      {
        id: 'drift-2',
        title: 'DRIFT',
        clearWhen: (ctx) => ctx.driftTierThisBeat >= 1,
      },
    ])
    const dir = createTutorialDirector(script, {
      onBeatCleared: (b) => cleared.push(b.id),
    })
    dir.tick(0.016, defaultSample) // arms + clears beat 0 (unconditional)
    expect(cleared).toEqual(['first'])
    // Beat 1's drift tier must start at 0 — a drift on beat 0 mustn't
    // bleed into beat 1 and auto-clear it.
    dir.tick(0.016, defaultSample)
    expect(cleared).toEqual(['first'])
    dir.notifyDrift(3)
    dir.tick(0.016, defaultSample)
    expect(cleared).toContain('drift-2')
  })

  it('skipCurrentBeat advances past the active beat', () => {
    const cleared: string[] = []
    const script = makeScript([
      { id: 'a', title: 'A', clearWhen: () => false },
      { id: 'b', title: 'B', clearWhen: () => false },
      { id: 'c', title: 'C', clearWhen: () => false },
    ])
    const dir = createTutorialDirector(script, {
      onBeatCleared: (b) => cleared.push(b.id),
    })
    dir.tick(0.016, defaultSample)
    dir.skipCurrentBeat()
    expect(cleared).toEqual(['a'])
    expect(dir.currentBeatIndex()).toBe(1)
    dir.skipCurrentBeat()
    dir.skipCurrentBeat()
    expect(cleared).toEqual(['a', 'b', 'c'])
    expect(dir.isCompleted()).toBe(true)
  })

  it('out-of-band signals are no-ops after completion', () => {
    const script = makeScript([{ id: 'one', title: 'ONE', clearWhen: () => true }])
    const dir = createTutorialDirector(script)
    dir.tick(0.016, defaultSample)
    expect(dir.isCompleted()).toBe(true)
    // These should not throw and not change state.
    dir.notifyPumpEvent()
    dir.notifyOrbitTouch()
    dir.notifyDrift(3)
    expect(dir.isCompleted()).toBe(true)
  })

  it('passes elapsed time correctly to predicates', () => {
    let seen = 0
    const script = makeScript([
      {
        id: 'time',
        title: 'TIME',
        clearWhen: (ctx) => {
          seen = ctx.beatTime
          return ctx.beatTime > 0.5
        },
      },
    ])
    const dir = createTutorialDirector(script)
    for (let i = 0; i < 40; i += 1) dir.tick(0.02, defaultSample)
    // After 40 × 0.02 = 0.8s we should have cleared, and the last
    // observed beatTime should be > 0.5.
    expect(seen).toBeGreaterThan(0.5)
    expect(dir.isCompleted()).toBe(true)
  })

  it("reports 'performed' for predicate clears and 'timeout' for timer/skip clears", () => {
    const hows: string[] = []
    const script = makeScript([
      { id: 'act', title: 'ACT', clearWhen: (ctx) => ctx.playerSpeed > 5 },
      { id: 'wait', title: 'WAIT', clearWhen: () => false, clearAfterSeconds: 0.1 },
      { id: 'skipme', title: 'SKIP', clearWhen: () => false },
    ])
    const dir = createTutorialDirector(script, {
      onBeatCleared: (b, how) => hows.push(`${b.id}:${how}`),
    })
    dir.tick(0.016, { playerSpeed: 7, throttle: 1, inAntiGrav: false }) // performs 'act'
    for (let i = 0; i < 10; i += 1) dir.tick(0.02, defaultSample) // times out 'wait'
    dir.skipCurrentBeat() // skips 'skipme' — counts as timeout, no celebration
    expect(hows).toEqual(['act:performed', 'wait:timeout', 'skipme:timeout'])
    expect(dir.isCompleted()).toBe(true)
  })
})
