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
  // In dev / tests no VITE_ASSET_BASE_URL is set, so it must be a no-op and
  // resolve against the local public/ dir — the offline-dev contract that
  // keeps the whole migration safe to land before R2 is wired up.
  it('is a no-op without VITE_ASSET_BASE_URL (local dev / test)', () => {
    expect(assetUrl('/assets/tracks/sandbar.glb')).toBe('/assets/tracks/sandbar.glb')
    expect(assetUrl('/audio/music/foo.opus')).toBe('/audio/music/foo.opus')
  })
})
