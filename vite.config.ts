import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url))
const TRACKS_DIR = path.resolve(REPO_ROOT, 'public', 'tracks')
const ASSET_TRACKS_DIR = path.resolve(REPO_ROOT, 'public', 'assets', 'tracks')

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
      // GET /__editor/list-tracks — returns every track the editor can
      // open. JSONs in public/tracks/ are first-class (the editor edits
      // their gameplay placement). GLBs in public/assets/tracks/ that
      // don't yet have a JSON are listed as "glb-only" — opening one
      // creates a starter draft from the GLB's metadata at edit time.
      server.middlewares.use('/__editor/list-tracks', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.end('method not allowed')
          return
        }
        try {
          const jsonIds = new Set<string>()
          const glbIds = new Set<string>()
          if (fs.existsSync(TRACKS_DIR)) {
            for (const f of fs.readdirSync(TRACKS_DIR)) {
              if (f.endsWith('.json')) jsonIds.add(f.slice(0, -5))
            }
          }
          if (fs.existsSync(ASSET_TRACKS_DIR)) {
            for (const f of fs.readdirSync(ASSET_TRACKS_DIR)) {
              if (f.endsWith('.glb')) glbIds.add(f.slice(0, -4))
            }
          }
          const allIds = [...new Set([...jsonIds, ...glbIds])].sort()
          const tracks = allIds.map((id) => ({
            id,
            kind: jsonIds.has(id) ? ('json' as const) : ('glb-only' as const),
            hasGlb: glbIds.has(id),
          }))
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ tracks }))
        } catch (e) {
          res.statusCode = 500
          res.end(`list-tracks: ${(e as Error).message}`)
        }
      })

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

// Watch specs/<cat>/*.json and tools/blender/lib/*.blend. Whenever
// one changes, debounce 600ms and spawn the appropriate
// `node tools/blender/run.mjs build_<category> specs/<category>` to
// regenerate the affected GLBs. Outputs land in `public/assets/`,
// which Vite serves as static assets — clients pick up the new files
// on the next reload (no HMR plumbing needed for binary GLBs).
//
// Disabled when HOVERBIKE_NO_ASSET_WATCH=1 is set (CI / focused
// sessions where Blender startup would be a distraction).
function assetPipelineWatchPlugin(): Plugin {
  const running = new Set<string>()
  const queue = new Map<string, NodeJS.Timeout>()

  function schedule(category: 'bikes' | 'props' | 'tracks', why: string) {
    const existing = queue.get(category)
    if (existing) clearTimeout(existing)
    const handle = setTimeout(() => {
      queue.delete(category)
      if (running.has(category)) {
        // Coalesce: if a build is already running, schedule another
        // pass right after it finishes.
        queue.set(
          category,
          setTimeout(() => schedule(category, why), 100),
        )
        return
      }
      running.add(category)
      const builderArg = `build_${category.replace(/s$/, '')}`
      console.log(`[asset-watch] ${why} → pnpm gen:${category}`)
      const child = spawn('node', ['tools/blender/run.mjs', builderArg, `specs/${category}`], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        shell: false,
      })
      child.on('close', (code) => {
        running.delete(category)
        console.log(`[asset-watch] ${category} build exited ${code}`)
      })
    }, 600)
    queue.set(category, handle)
  }

  return {
    name: 'hoverbike:asset-pipeline-watch',
    apply: 'serve',
    configureServer(server) {
      if (process.env.HOVERBIKE_NO_ASSET_WATCH === '1') return
      server.watcher.add([
        path.resolve(REPO_ROOT, 'specs'),
        path.resolve(REPO_ROOT, 'tools', 'blender', 'lib'),
      ])
      const handler = (file: string) => {
        const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/')
        if (rel.startsWith('specs/bikes/') && rel.endsWith('.json')) {
          schedule('bikes', `spec ${path.basename(file)} changed`)
        } else if (rel.startsWith('specs/props/') && rel.endsWith('.json')) {
          schedule('props', `spec ${path.basename(file)} changed`)
        } else if (rel.startsWith('specs/tracks/') && rel.endsWith('.json')) {
          schedule('tracks', `spec ${path.basename(file)} changed`)
        } else if (rel === 'tools/blender/lib/bike_parts.blend') {
          schedule('bikes', 'bike_parts.blend changed')
        } else if (rel === 'tools/blender/lib/prop_kit.blend') {
          schedule('props', 'prop_kit.blend changed')
        }
      }
      server.watcher.on('change', handler)
      server.watcher.on('add', handler)
    },
  }
}

export default defineConfig({
  plugins: [trackEditorSavePlugin(), assetPipelineWatchPlugin()],
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
