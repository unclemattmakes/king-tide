import { describe, expect, it } from 'vitest'
import { buildUrl } from '@/engine/dev/registry'

// `buildUrl` takes an explicit href so it's testable under Vitest's node env
// (no `window`). It must preserve the full deep-link context and only touch
// the params it's told to.
const base = 'http://localhost:5173/?track=the-maw&bike=racer&dev=1'

describe('buildUrl', () => {
  it('preserves existing params and sets a new one', () => {
    const out = new URL(buildUrl({ viewer: '1' }, base))
    expect(out.searchParams.get('track')).toBe('the-maw')
    expect(out.searchParams.get('bike')).toBe('racer')
    expect(out.searchParams.get('dev')).toBe('1')
    expect(out.searchParams.get('viewer')).toBe('1')
  })

  it('deletes a param when the value is null', () => {
    const out = new URL(buildUrl({ bike: null }, base))
    expect(out.searchParams.has('bike')).toBe(false)
    expect(out.searchParams.get('track')).toBe('the-maw')
  })

  it('overwrites an existing param', () => {
    const out = new URL(buildUrl({ track: 'sandbar' }, base))
    expect(out.searchParams.get('track')).toBe('sandbar')
  })

  it('sets a bare flag (empty value)', () => {
    const out = new URL(buildUrl({ perf: '' }, base))
    expect(out.searchParams.has('perf')).toBe(true)
    expect(out.searchParams.get('perf')).toBe('')
  })

  it('applies several mutations at once', () => {
    const out = new URL(buildUrl({ bike: null, edit: '1', track: 'cape-town' }, base))
    expect(out.searchParams.has('bike')).toBe(false)
    expect(out.searchParams.get('edit')).toBe('1')
    expect(out.searchParams.get('track')).toBe('cape-town')
    expect(out.searchParams.get('dev')).toBe('1')
  })
})
