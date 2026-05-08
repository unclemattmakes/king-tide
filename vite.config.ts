import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url))
const TRACKS_DIR = path.resolve(REPO_ROOT, 'public', 'tracks')

/**
 * Dev-only POST endpoint for the in-app track editor. The editor sends
 * `{ id, json }`; we write `public/tracks/<id>.json` after a strict id
 * check (lowercase letters, digits, dashes only — never traversal). The
 * file then ships as a static asset (works in dev and prod alike — the
 * runtime fetches `/tracks/<id>.json`).
 *
 * Loaded only when Vite runs in `serve` mode, so production builds don't
 * ship a write endpoint.
 */
function trackEditorSavePlugin(): Plugin {
  return {
    name: 'hoverbike:track-editor-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__editor/save-track', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('method not allowed')
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              id?: unknown
              json?: unknown
            }
            const id = body.id
            if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) {
              res.statusCode = 400
              res.end('id must match /^[a-z0-9-]+$/')
              return
            }
            if (typeof body.json !== 'object' || body.json === null) {
              res.statusCode = 400
              res.end('json must be an object')
              return
            }
            const target = path.join(TRACKS_DIR, `${id}.json`)
            if (!target.startsWith(TRACKS_DIR + path.sep)) {
              res.statusCode = 400
              res.end('resolved path escaped tracks-src/')
              return
            }
            fs.mkdirSync(TRACKS_DIR, { recursive: true })
            fs.writeFileSync(target, `${JSON.stringify(body.json, null, 2)}\n`, 'utf8')
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true, path: path.relative(REPO_ROOT, target) }))
          } catch (e) {
            res.statusCode = 400
            res.end(`save-track: ${(e as Error).message}`)
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [trackEditorSavePlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5191,
    // strictPort intentionally off: if 5191 is taken (e.g. by the Claude in-app
    // preview server), Vite picks 5192, 5193, ... so a parallel `pnpm dev` still
    // runs. Playwright's webServer is configured to reuse 5191 if up, so its
    // smoke test still hits the running preview.
    strictPort: false,
    fs: { allow: [REPO_ROOT] },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
})
