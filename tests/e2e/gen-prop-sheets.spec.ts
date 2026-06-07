/**
 * Prop contact-sheet capture — a visual index of every prop GLB so a later
 * reader (human or a Claude session) can eyeball "which asset is this?" from
 * one image instead of loading + analysing each GLB.
 *
 * Gated on `PROP_SHEETS=1` so day-to-day `pnpm e2e` stays fast. Author invokes
 * via `pnpm gen:prop-sheets`, which sets the env + targets only this spec.
 *
 * Each prop is rendered through the real `?propviewer=<id>&thumb=1` path —
 * headed Chromium, real WebGPU, the same painterly-vinyl material the game
 * ships — so the sheet matches what shows up on track. (Same reasoning as the
 * bike-thumbnail spec: a Blender clay render wouldn't reproduce the runtime
 * look.) Tiles are composited into per-folder sheets in the browser (data-URI
 * grid → screenshot) so no image library is needed.
 *
 * Output: `public/assets/props/_sheets/<group>[-<page>].jpg` + a `README.md`
 * index. That dir rides to R2 with `pnpm assets:push` like the rest of the
 * compiled props.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const TILE_W = 460
const TILE_H = 340
const COLS = 4
const ROWS_PER_SHEET = 5
const PER_SHEET = COLS * ROWS_PER_SHEET // 20 props per sheet — keeps each image
//                                          legible after a vision model downsamples it.
const PAD = 24
const GAP_X = 24

const PROPS_DIR = path.resolve(process.cwd(), 'public', 'assets', 'props')
const OUT_DIR = path.join(PROPS_DIR, '_sheets')
const BASE = `http://localhost:${process.env.E2E_PORT ?? 5391}`

/** One captured prop: its id, measured bbox label, and the tile image (or null
 *  if the prop failed to load — rendered as a placeholder cell so the sheet and
 *  the index stay complete). */
type Tile = { id: string; bbox: string; dataUri: string | null }

/** The folders we split sheets by, in catalogue order. */
const GROUPS: Array<{ key: string; title: string; match: (id: string) => boolean }> = [
  { key: 'props', title: 'props/ (loose)', match: (id) => !id.includes('/') },
  { key: 'props-ai', title: 'props/ai', match: (id) => id.startsWith('ai/') },
  { key: 'props-cc0', title: 'props/cc0', match: (id) => id.startsWith('cc0/') },
]

/** Recursively collect prop ids (path under props/, forward slashes, no ext),
 *  skipping the generated `_sheets/` output dir. */
function listPropIds(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === '_sheets') continue
      const p = path.join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (entry.endsWith('.glb')) {
        out.push(
          path
            .relative(PROPS_DIR, p)
            .split(path.sep)
            .join('/')
            .replace(/\.glb$/, ''),
        )
      }
    }
  }
  walk(PROPS_DIR)
  return out.sort()
}

test.describe('prop contact sheets', () => {
  test.skip(
    process.env.PROP_SHEETS !== '1',
    'gated on PROP_SHEETS=1 — invoke via pnpm gen:prop-sheets',
  )

  test('capture + composite', async ({ browser }) => {
    test.setTimeout(20 * 60 * 1000) // ~89 GPU reloads + sheet renders; well over 30s.
    mkdirSync(OUT_DIR, { recursive: true })

    // `PROP_SHEETS_IDS=cc0/anchor,ai/boat_wreck` narrows the run to a subset
    // (smoke-testing / regenerating one folder); unset captures everything.
    const only = (process.env.PROP_SHEETS_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const ids = only.length ? listPropIds().filter((id) => only.includes(id)) : listPropIds()
    expect(ids.length).toBeGreaterThan(0)

    // A full run clears stale sheet JPEGs first, so a folder that changed page
    // count (e.g. cc0 crossing the 20-per-sheet line) can't leave an orphaned
    // page behind. Subset runs (PROP_SHEETS_IDS) touch only a few props, so
    // they leave the rest of the index in place.
    if (!only.length) {
      for (const f of readdirSync(OUT_DIR)) {
        if (f.endsWith('.jpg')) rmSync(path.join(OUT_DIR, f))
      }
    }

    // Capture context is locked to the tile size so each screenshot IS the tile.
    const context = await browser.newContext({
      viewport: { width: TILE_W, height: TILE_H },
      deviceScaleFactor: 1,
    })

    const captureTile = async (
      page: import('@playwright/test').Page,
      id: string,
    ): Promise<Tile> => {
      try {
        await page.goto(`${BASE}/?propviewer=${id}&thumb=1`)
        await page.waitForFunction(() => document.body.dataset.propViewerReady === '1', null, {
          timeout: 20_000,
        })
        // The prop viewer hides its own HUD in thumb mode; this strips any
        // index.html app chrome (dev toggles, loading overlay) still painted on
        // top — mirrors the bike-thumbnail spec.
        await page.evaluate(() => {
          document.body.classList.remove('dev-build')
          for (const sel of [
            '#hud',
            '#loading-screen',
            '#menu',
            '#race-hud',
            '#garage-toggle',
            '#devsettings-toggle',
            '#water-debug-toggle',
          ]) {
            const el = document.querySelector(sel)
            if (el) (el as HTMLElement).style.display = 'none'
          }
        })
        await page.waitForTimeout(120) // settle a couple frames after hiding chrome
        const bbox = await page.evaluate(() => document.body.dataset.propBbox ?? '')
        const buf = await page.screenshot({ type: 'jpeg', quality: 88 })
        return { id, bbox, dataUri: `data:image/jpeg;base64,${buf.toString('base64')}` }
      } catch {
        return { id, bbox: '', dataUri: null }
      }
    }

    // ── Capture every prop ────────────────────────────────────────────────────
    // Recycle the page periodically so a long run doesn't pile up WebGPU
    // contexts across ~89 reloads in one page.
    const tiles = new Map<string, Tile>()
    let page = await context.newPage()
    let captured = 0
    const failures: string[] = []
    for (const [i, id] of ids.entries()) {
      if (i > 0 && i % 24 === 0) {
        await page.close()
        page = await context.newPage()
      }
      const tile = await captureTile(page, id)
      tiles.set(id, tile)
      if (tile.dataUri) captured++
      else failures.push(id)
      console.info(`[prop-sheets] ${i + 1}/${ids.length}  ${id}${tile.dataUri ? '' : '  (FAILED)'}`)
    }
    await page.close()

    // ── Composite per-folder sheets ───────────────────────────────────────────
    const sheetWidth = PAD * 2 + COLS * TILE_W + (COLS - 1) * GAP_X
    const sheetHtml = (title: string, group: Tile[]): string => {
      const cell = (t: Tile): string => {
        const img = t.dataUri
          ? `<img src="${t.dataUri}" width="${TILE_W}" height="${TILE_H}" style="display:block;border-radius:6px;background:#555a61">`
          : `<div style="width:${TILE_W}px;height:${TILE_H}px;display:flex;align-items:center;justify-content:center;background:#3a2326;color:#ff9a8a;border-radius:6px;font:600 18px system-ui">&#9888; load failed</div>`
        return `<div style="display:flex;flex-direction:column;gap:5px">
            ${img}
            <div style="font:600 17px ui-monospace,SFMono-Regular,monospace;color:#eaf0f6;word-break:break-all">${t.id}</div>
            <div style="font:13px system-ui;color:#8a96a6">${t.bbox ? `${t.bbox} m` : ''}</div>
          </div>`
      }
      return `<!doctype html><html><body style="margin:0;background:#191d23;padding:${PAD}px;box-sizing:border-box">
          <div style="font:700 28px system-ui;color:#dff7ff;margin:0 0 20px">${title}</div>
          <div style="display:grid;grid-template-columns:repeat(${COLS}, ${TILE_W}px);gap:30px ${GAP_X}px;width:max-content">${group.map(cell).join('')}</div>
        </body></html>`
    }

    const sheetPage = await context.newPage()
    const indexMd: string[] = [
      '# Prop contact sheets',
      '',
      'Visual index of `public/assets/props/`, regenerated by `pnpm gen:prop-sheets`.',
      'Each cell is the in-engine (`?propviewer=<id>&thumb=1`) render, labelled with',
      'the **asset id** you pass when placing the prop, plus its bounding-box size.',
      '',
      `Last run: ${captured}/${ids.length} props rendered` +
        (failures.length ? `, ${failures.length} failed (\`${failures.join('`, `')}\`).` : '.'),
      '',
    ]

    for (const g of GROUPS) {
      const groupIds = ids.filter(g.match)
      if (groupIds.length === 0) continue
      const pageCount = Math.ceil(groupIds.length / PER_SHEET)
      for (let p = 0; p < pageCount; p++) {
        const slice = groupIds
          .slice(p * PER_SHEET, (p + 1) * PER_SHEET)
          .map((id) => tiles.get(id) ?? { id, bbox: '', dataUri: null })
        const name = pageCount > 1 ? `${g.key}-${p + 1}` : g.key
        const title = pageCount > 1 ? `${g.title}  (${p + 1}/${pageCount})` : g.title
        await sheetPage.setViewportSize({ width: sheetWidth, height: 900 })
        await sheetPage.setContent(sheetHtml(title, slice), { waitUntil: 'load' })
        await sheetPage.evaluate(() =>
          Promise.all([...document.images].map((i) => i.decode().catch(() => undefined))),
        )
        await sheetPage.screenshot({
          path: path.join(OUT_DIR, `${name}.jpg`),
          type: 'jpeg',
          quality: 90,
          fullPage: true,
        })
        indexMd.push(
          `## ${name}.jpg — ${title}`,
          '',
          slice
            .map(
              (t) =>
                `- \`${t.id}\`${t.bbox ? ` · ${t.bbox} m` : ''}${t.dataUri ? '' : ' · ⚠ load failed'}`,
            )
            .join('\n'),
          '',
        )
        console.info(`[prop-sheets] wrote ${name}.jpg (${slice.length} props)`)
      }
    }

    writeFileSync(path.join(OUT_DIR, 'README.md'), `${indexMd.join('\n')}\n`)
    await context.close()
    expect(captured).toBeGreaterThan(0)
  })
})
