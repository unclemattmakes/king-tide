import { expect, test } from './helpers/console-errors'

/**
 * The cold-boot menu's live backdrop must load the decimated
 * `<track>-menu.glb` variant, not the full render GLB.
 *
 * Measured 2026-08-21, the backdrop was pulling 34.2 MB and taking 15.3 s to
 * go live on a 20 Mbps connection — `sandbar.glb` alone is 20.7 MB of pure
 * geometry (zero textures), plus a 4.7 MB collider proxy. The variant
 * (`tools/blender/build_track_menu.py`) is 6.6 MB and doubles as its own
 * collision source, taking that to 14.4 MB / 9.5 s.
 *
 * This asserts the routing, which has two independent ways to silently
 * regress: `attract-mode.ts` dropping `preferMenuVariant`, and the variant
 * going missing from R2 (`resolveGlbVariant` then falls back to the full GLB —
 * correct behaviour, invisible to the player, and the whole saving gone).
 *
 * Needs R2 assets and a real GPU:
 *   E2E_PORT=5399 pnpm e2e menu-backdrop.spec.ts
 */

test.describe.configure({ mode: 'serial', timeout: 120_000 })

test.describe('menu backdrop', () => {
  test('loads the decimated menu variant, not the full track GLB', async ({
    page,
    consoleErrors,
  }) => {
    // The cold-boot menu opens a multiplayer-relay socket that nothing is
    // listening on locally. Unrelated to the backdrop and noisy in every
    // menu boot — allowlist it rather than opting out of error checking.
    consoleErrors.allow(/ERR_CONNECTION_REFUSED/)
    const trackGlbs: string[] = []
    page.on('request', (r) => {
      const name = r.url().split('/').pop() ?? ''
      if (/^sandbar.*\.glb$/.test(name)) trackGlbs.push(name)
    })

    await page.goto('/')
    await page.waitForFunction(() => document.body.classList.contains('attract-live'), null, {
      timeout: 90_000,
    })

    const unique = [...new Set(trackGlbs)]
    expect(
      unique,
      'backdrop should fetch only sandbar-menu.glb. Missing it means either ' +
        'attract-mode.ts stopped passing preferMenuVariant, or the variant is ' +
        'absent from R2 — rebuild with tools/blender/build_track_menu.py and ' +
        '`pnpm assets:push`.',
    ).toEqual(['sandbar-menu.glb'])
  })

  test('the variant carries its collider_mesh slabs', async ({ page, consoleErrors }) => {
    consoleErrors.allow(/ERR_CONNECTION_REFUSED/)
    // The backdrop colliders the variant directly — no `-collider.glb` is
    // fetched for it — so the docks' collide-but-don't-render slabs have to
    // survive the decimate, or AI bikes fall through the jetty on the one
    // screen every player sees first.
    let variantUrl = ''
    page.on('request', (r) => {
      if (r.url().endsWith('sandbar-menu.glb')) variantUrl = r.url()
    })

    await page.goto('/')
    await page.waitForFunction(() => document.body.classList.contains('attract-live'), null, {
      timeout: 90_000,
    })
    // Read the bytes the page actually loaded rather than rebuilding the URL
    // here — `.env` points `/assets/**` at R2 even in dev, so a locally
    // resolved path would test the wrong file.
    expect(variantUrl, 'backdrop never fetched the menu variant').not.toBe('')

    const kinds: string[] = await page.evaluate(async (url) => {
      const buf = await (await fetch(url)).arrayBuffer()
      const view = new DataView(buf)
      let offset = 12 // past the 12-byte GLB header
      while (offset + 8 <= buf.byteLength) {
        const len = view.getUint32(offset, true)
        if (view.getUint32(offset + 4, true) === 0x4e4f534a /* "JSON" */) {
          const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, offset + 8, len)))
          return (json.nodes ?? [])
            .map((n: { extras?: { kind?: string } }) => n.extras?.kind)
            .filter(Boolean) as string[]
        }
        offset += 8 + len
      }
      throw new Error('no JSON chunk in menu variant')
    }, variantUrl)

    expect(kinds.filter((k) => k === 'collider_mesh').length).toBe(2)
    // The tags the terrain shader / decal / emitter / horizon passes key off
    // must survive too — decimating per-object rather than joining is what
    // keeps them, and a builder that regressed to a join would drop them all.
    expect(kinds).toContain('track')
    expect(kinds).toContain('decoration')
  })
})
