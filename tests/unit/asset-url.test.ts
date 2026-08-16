import { describe, expect, it } from 'vitest'
import { assetUrl, joinAssetUrl } from '@/engine/asset-url'

describe('joinAssetUrl', () => {
  it('returns the path unchanged when the base is empty', () => {
    expect(joinAssetUrl('', '/assets/tracks/sandbar.glb')).toBe('/assets/tracks/sandbar.glb')
  })

  it('prefixes an app-absolute path with the base origin', () => {
    expect(joinAssetUrl('https://assets.hoverbike.gg', '/assets/bikes/racer.glb')).toBe(
      'https://assets.hoverbike.gg/assets/bikes/racer.glb',
    )
  })

  it('tolerates a trailing slash on the base (no double slash)', () => {
    expect(joinAssetUrl('https://cdn.example.com/', '/audio/music/foo.opus')).toBe(
      'https://cdn.example.com/audio/music/foo.opus',
    )
  })

  it('strips multiple trailing slashes', () => {
    expect(joinAssetUrl('https://cdn.example.com///', '/assets/x.png')).toBe(
      'https://cdn.example.com/assets/x.png',
    )
  })

  it('adds a separator when the path lacks a leading slash', () => {
    expect(joinAssetUrl('https://cdn.example.com', 'assets/x.png')).toBe(
      'https://cdn.example.com/assets/x.png',
    )
  })

  it('treats a whitespace-only base as empty', () => {
    expect(joinAssetUrl('   ', '/assets/x.png')).toBe('/assets/x.png')
  })
})

describe('assetUrl', () => {
  // Both states are legitimate and vitest loads `.env`, so this can't assume
  // either one: a fresh clone follows README/.env.example and sets
  // VITE_ASSET_BASE_URL to the public asset CDN (the zero-credential path),
  // while a maintainer clone with hydrated assets leaves it unset. Asserting
  // the unset case unconditionally made `cp .env.example .env` — the very
  // first step we tell contributors to take — turn the suite red.
  const base = ((import.meta.env.VITE_ASSET_BASE_URL as string | undefined) ?? '').trim()

  it('resolves an asset path against whatever base is configured', () => {
    for (const path of ['/assets/tracks/sandbar.glb', '/audio/music/foo.opus']) {
      const out = assetUrl(path)
      expect(out.endsWith(path)).toBe(true)
      if (base === '') {
        // Offline-dev contract: no base ⇒ untouched, resolves against the
        // local public/ dir. This is what keeps the R2 migration reversible.
        expect(out).toBe(path)
      } else {
        expect(out).toBe(`${base.replace(/\/+$/, '')}${path}`)
      }
    }
  })
})
