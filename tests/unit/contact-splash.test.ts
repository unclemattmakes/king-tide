import { describe, expect, it } from 'vitest'
import { createContactSplashDriver } from '../../src/engine/render/contact-splash'
import type { WaterContact } from '../../src/engine/render/water-contacts'

const PILLAR: WaterContact = { x: 0, z: 0, radius: 1, strength: 1 }

type Fire = { x: number; surfaceY: number; strength: number }

function makeDriver(opts?: {
  contacts?: WaterContact[]
  config?: Parameters<typeof createContactSplashDriver>[0]['config']
}) {
  const fires: Fire[] = []
  let h = 0
  let vy = 0
  const sampled: Array<{ x: number; z: number }> = []
  const driver = createContactSplashDriver({
    contacts: opts?.contacts ?? [PILLAR],
    baseY: 10, // non-zero base so the height math is exercised
    sample: (x, z) => {
      sampled.push({ x, z })
      return { y: 10 + h, vy }
    },
    emit: (c, surfaceY, strength) => fires.push({ x: c.x, surfaceY, strength }),
    config: opts?.config,
  })
  return {
    driver,
    fires,
    sampled,
    set(height: number, velocity: number) {
      h = height
      vy = velocity
    },
  }
}

describe('contact splash driver', () => {
  it('fires once per crest slam, re-arms in the trough, fires again', () => {
    // Short cooldown: the test's crests are 0.3 s apart, far quicker than a
    // real swell — the default 1.1 s floor has its own test below.
    const t = makeDriver({ config: { cooldownS: 0.1 } })
    let time = 0
    const step = (height: number, vy: number) => {
      t.set(height, vy)
      time += 0.1
      t.driver.tick(0, 0, time)
    }
    // Born disarmed — must see a trough before it can fire.
    step(0.05, 0) // below rearm → arms
    step(0.5, 1.2) // crest slam → fires
    step(0.9, 0.4) // still high, vy low — no double fire (disarmed anyway)
    step(0.05, -0.5) // trough → re-arms
    step(0.6, 1.5) // second slam → fires
    expect(t.fires.length).toBe(2)
    expect(t.fires[0]!.surfaceY).toBeCloseTo(10.5)
  })

  it('does not fire on first sight mid-crest (born disarmed)', () => {
    const t = makeDriver()
    t.set(1.0, 2.0) // already slamming when the driver first looks
    t.driver.tick(0, 0, 0.1)
    t.driver.tick(0, 0, 0.2)
    expect(t.fires.length).toBe(0)
  })

  it('requires upward surface velocity, not just height', () => {
    const t = makeDriver()
    let time = 0
    const step = (height: number, vy: number) => {
      t.set(height, vy)
      time += 0.1
      t.driver.tick(0, 0, time)
    }
    step(0.0, 0) // arm
    step(0.8, 0.1) // tall but falling/slow — a fat swell sliding past
    expect(t.fires.length).toBe(0)
    step(0.8, 1.4) // same height, now rising hard
    expect(t.fires.length).toBe(1)
  })

  it('enforces the per-contact cooldown', () => {
    const t = makeDriver({ config: { cooldownS: 10 } })
    let time = 0
    const step = (height: number, vy: number) => {
      t.set(height, vy)
      time += 0.5
      t.driver.tick(0, 0, time)
    }
    step(0.0, 0)
    step(0.8, 2) // fires (t=1.0)
    step(0.0, 0) // re-arm
    step(0.8, 2) // armed + slamming, but inside cooldown
    expect(t.fires.length).toBe(1)
  })

  it('caps fires per tick across a field of contacts', () => {
    const contacts: WaterContact[] = []
    for (let i = 0; i < 10; i++) contacts.push({ x: i * 5, z: 0, radius: 1, strength: 1 })
    const t = makeDriver({ contacts, config: { maxFiresPerTick: 3, cooldownS: 0 } })
    t.set(0.0, 0)
    t.driver.tick(0, 0, 0.1) // arm everyone
    t.set(0.9, 2.0)
    t.driver.tick(0, 0, 0.2) // a set wave slams the whole field at once
    expect(t.fires.length).toBe(3)
    t.driver.tick(0, 0, 0.3) // survivors still slamming → next 3
    expect(t.fires.length).toBe(6)
  })

  it('skips contacts beyond the cull radius without sampling them', () => {
    const far: WaterContact = { x: 500, z: 0, radius: 1, strength: 1 }
    const t = makeDriver({ contacts: [far], config: { cullRadiusM: 100 } })
    t.set(0.9, 2.0)
    t.driver.tick(0, 0, 0.1)
    expect(t.sampled.length).toBe(0)
    expect(t.fires.length).toBe(0)
  })

  it('scales strength with crest height', () => {
    const t = makeDriver({ config: { cooldownS: 0 } })
    let time = 0
    const cycle = (height: number) => {
      t.set(0, 0)
      time += 0.1
      t.driver.tick(0, 0, time) // arm
      t.set(height, 2.0)
      time += 0.1
      t.driver.tick(0, 0, time) // fire
    }
    cycle(0.4)
    cycle(1.4)
    expect(t.fires.length).toBe(2)
    expect(t.fires[1]!.strength).toBeGreaterThan(t.fires[0]!.strength)
  })

  it('setContacts swaps the field and resets arming', () => {
    const t = makeDriver()
    t.driver.setContacts([{ x: 3, z: 4, radius: 2, strength: 1 }])
    t.set(0.9, 2.0)
    t.driver.tick(0, 0, 0.1) // born disarmed again — no fire
    expect(t.fires.length).toBe(0)
    t.set(0.0, 0)
    t.driver.tick(0, 0, 0.2)
    t.set(0.9, 2.0)
    t.driver.tick(0, 0, 0.3)
    expect(t.fires.length).toBe(1)
    expect(t.fires[0]!.x).toBe(3)
    expect(t.driver.firedCount()).toBe(1)
  })
})
