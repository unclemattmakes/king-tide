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

// Watch specs/<cat>/*.json, tools/blender/lib/*.blend, and
// bikes-src/*.blend. Whenever one changes, debounce 600ms and spawn
// the appropriate `node tools/blender/run.mjs build_<category>
// specs/<category>` to regenerate the affected GLBs. Outputs land
// in `public/assets/`, which Vite serves as static assets — clients
// pick up the new files on the next reload (no HMR plumbing needed
// for binary GLBs).
//
// `bikes-src/<id>.blend` is the source of truth for bike geometry as
// of M9.39, so saving any of those files re-runs `pnpm gen:bikes` —
// matches the spec-watching ergonomics for props/tracks. The addon's
// "Export Bike to Game" button still works (it writes the GLB
// directly without going through this watcher), so authors can pick
// between Ctrl+S → headless rebuild and an explicit click.
//
// `tracks-src/<id>.blend` is intentionally NOT watched — tracks have
// the in-app editor and the addon button covering the same ground,
// and tracks-src/ saves are too frequent to make a useful trigger.
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
        path.resolve(REPO_ROOT, 'bikes-src'),
      ])
      const handler = (file: string) => {
        const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/')
        if (rel.startsWith('specs/bikes/') && rel.endsWith('.json')) {
          schedule('bikes', `spec ${path.basename(file)} changed`)
        } else if (rel.startsWith('specs/props/') && rel.endsWith('.json')) {
          schedule('props', `spec ${path.basename(file)} changed`)
        } else if (rel.startsWith('specs/tracks/') && rel.endsWith('.json')) {
          schedule('tracks', `spec ${path.basename(file)} changed`)
        } else if (rel.startsWith('bikes-src/') && rel.endsWith('.blend')) {
          schedule('bikes', `${path.basename(file)} changed`)
        } else if (rel === 'tools/blender/lib/bike_parts.blend') {
          // Legacy kit — no longer wired up by the bike build path
          // (M9.39 flipped to per-variant .blend files), but keep
          // the trigger so anyone still iterating on the old kit
          // gets a rebuild.
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

/**
 * Discover every `making-of/**​/index.html` page so the multi-page build
 * emits each one. The making-of microsite (see making-of/) is a set of
 * static article pages served from the same app as the game; each gets
 * its own Rollup entry keyed by its path (e.g. `making-of/wave-field`).
 */
function makingOfInputs(): Record<string, string> {
  const root = path.resolve(REPO_ROOT, 'making-of')
  const inputs: Record<string, string> = {}
  if (!fs.existsSync(root)) return inputs
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name === 'index.html') {
        const key = path
          .relative(REPO_ROOT, full)
          .replace(/[/\\]index\.html$/, '')
          .replace(/[/\\]/g, '-')
        inputs[key] = full
      }
    }
  }
  walk(root)
  return inputs
}

/**
 * First-run heads-up in the terminal. On a cold dep cache Vite pre-bundles the
 * (large) three.js graph before it can serve, and that work holds the first
 * request — so the browser sits BLANK (not even the inline loading screen) until
 * it finishes. Nothing in the page can paint during that window, so the honest
 * "it's working, hang on" signal has to live in the terminal: tell the dev to
 * wait for `ready` before opening the browser. Fires only when the deps cache is
 * absent (the genuine first run, or after `--force` / a dependency bump nukes
 * it) so warm restarts stay quiet. Serve-only — never runs for `vite build`.
 */
function coldStartHintPlugin(): Plugin {
  return {
    name: 'hoverbike:cold-start-hint',
    apply: 'serve',
    config() {
      const depsCache = path.resolve(REPO_ROOT, 'node_modules', '.vite', 'deps', '_metadata.json')
      if (!fs.existsSync(depsCache)) {
        console.log(
          '\n  \x1b[36m[hoverbike]\x1b[0m First run — pre-bundling the three.js dependency graph (~10–20s).' +
            '\n  The page stays blank until you see \x1b[1mready\x1b[0m below; open the browser then.\n',
        )
      }
    },
  }
}

export default defineConfig({
  plugins: [coldStartHintPlugin(), trackEditorSavePlugin(), assetPipelineWatchPlugin()],
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
    // Pre-transform the entry + the two heavy boot graphs (race + cold-boot
    // menu/attract) at server start, so the first navigation isn't paying their
    // transform on the critical path. Pairs with the optimizeDeps tuning below.
    warmup: {
      clientFiles: [
        './src/main.ts',
        './src/boot/race-boot.ts',
        './src/boot/attract-mode.ts',
        './src/engine/menus/menu-flow.ts',
      ],
    },
  },
  build: {
    target: 'es2022',
    // 'hidden' still emits .map files (so a crash reporter / source-map
    // upload can symbolicate stacks) but omits the `//# sourceMappingURL`
    // comment from the served bundles — so we don't publish browsable source
    // on the deployed site. Set SOURCEMAP=1 for a local build with maps
    // wired up for DevTools.
    sourcemap: process.env.SOURCEMAP === '1' ? true : 'hidden',
    rollupOptions: {
      input: {
        main: path.resolve(REPO_ROOT, 'index.html'),
        ...makingOfInputs(),
      },
    },
  },
  optimizeDeps: {
    // Rapier ships hand-written WASM glue the dep pre-bundler can't follow —
    // let Vite serve it untouched.
    exclude: ['@dimforge/rapier3d-compat'],
    // ── Cold-start fix: the "blank page before KING TIDE on the first
    // `pnpm dev` visit". ──────────────────────────────────────────────────
    // On a cold dep cache Vite esbuild-SCANS the whole source graph to
    // discover deps before it serves anything. On this Three.js-heavy graph
    // that crawl runs ~40 s+ and holds the very first request — the HTML
    // document included — so the browser sits BLANK (not even the inline
    // loading screen) the whole time. `noDiscovery` skips that scan and
    // pre-bundles only the modules listed here, at server startup
    // ("bundling dependencies… → ready" in the terminal). A browser opened
    // after "ready" then gets the HTML immediately and paints the loading
    // screen instantly. Dev-only — `optimizeDeps` has no effect on the
    // production build (the deployed site already paints KING TIDE in ~0.6 s).
    //
    // Trade-off: with discovery off, EVERY bare browser import under src/ must
    // be listed here. Add a new npm dependency the game imports? Add it below.
    // A missing CJS-only dep fails loudly at dev start (clear Vite error); a
    // missing ESM dep just serves unbundled (slower, still works). This list
    // mirrors the bare specifiers found under src/ — regenerate with:
    //   grep -rhoE "from '[^.@/][^']*'|import\('[^.@/][^']*'\)" src | sed -E "s/.*'(.*)'.*/\1/" | sort -u
    include: [
      'three',
      'three/webgpu',
      'three/tsl',
      'three/addons/controls/OrbitControls.js',
      'three/addons/controls/TransformControls.js',
      'three/addons/loaders/GLTFLoader.js',
      'three/addons/tsl/display/BloomNode.js',
      'three/addons/tsl/display/MotionBlur.js',
      'three/addons/tsl/display/SobelOperatorNode.js',
      'three/addons/utils/BufferGeometryUtils.js',
      'three/addons/utils/SkeletonUtils.js',
      'bitecs',
      'partysocket',
    ],
    noDiscovery: true,
  },
})
