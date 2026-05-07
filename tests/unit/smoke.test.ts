import { describe, expect, it } from 'vitest'
import { emptyIntent } from '../../src/engine/input/intent'
import { createSimWorld } from '../../src/engine/sim/ecs/world'

describe('sim smoke', () => {
  it('creates an empty ECS world', () => {
    const w = createSimWorld()
    expect(w).toBeDefined()
  })

  it('produces a zeroed intent', () => {
    const i = emptyIntent()
    expect(i.throttle).toBe(0)
    expect(i.steer).toBe(0)
    expect(i.fire).toBe(false)
  })
})
