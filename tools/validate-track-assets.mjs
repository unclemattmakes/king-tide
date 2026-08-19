#!/usr/bin/env node
// validate-track-assets.mjs — assert every asset a track JSON references
// actually exists on disk.
//
// A track at public/tracks/<id>.json points at two kinds of binary asset:
//
//   - props[].assetId  → public/assets/props/<assetId>.glb
//       The assetId may carry a subfolder (cc0/shipping_container,
//       mxc/canal_wall, ai/sea_boulder, …). The runtime resolves it as
//       `/assets/props/${assetId}.glb` (see src/boot/race-boot.ts ~806 and
//       src/engine/render/props-mesh.ts), so we check the same on-disk path.
//   - environmentGlb   → public/<environmentGlb>
//       An app-absolute path like `/assets/tracks/<id>.glb`. The runtime
//       loads it via assetUrl(track.environmentGlb) (track-loader.ts), which
//       in dev/build maps `/assets/...` straight onto `public/assets/...`.
//
// We validate against the REAL on-disk file, not manifest.json membership —
// the manifest lists only a handful of entries while ~130 GLBs exist on
// disk, so a manifest check would be a wall of false positives.
//
// The optional `<env>-collider.glb` sibling is intentionally NOT required:
// the runtime falls back to the visual GLB's geometry when it's absent
// (track-loader.ts loadColliderProxy), so a missing collider is not a
// dangling reference.
//
// Exit codes: 0 = every reference resolves (prints a per-track summary),
// non-zero = at least one dangling reference (prints them grouped by track).
// Zero runtime deps — plain Node ESM.
//
// Env overrides:
//   TRACKS_DIR  directory of track JSON (default public/tracks)
//   PUBLIC_DIR  web root the app-absolute asset paths resolve against
//               (default public)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const TRACKS_DIR = process.env.TRACKS_DIR
  ? resolve(process.env.TRACKS_DIR)
  : join(repoRoot, 'public', 'tracks')
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? resolve(process.env.PUBLIC_DIR)
  : join(repoRoot, 'public')

/** True if `p` is an existing regular file. */
function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Map a props[].assetId to its on-disk GLB path. */
function propAssetPath(assetId) {
  // assetId is a forward-slash id (possibly with a subfolder). join()
  // normalises the separators for the host OS.
  return join(PUBLIC_DIR, 'assets', 'props', `${assetId}.glb`)
}

/** Map an app-absolute asset path (`/assets/...`) to its on-disk path. */
function publicPath(appPath) {
  const rel = appPath.replace(/^\/+/, '')
  return join(PUBLIC_DIR, rel)
}

if (!existsSync(TRACKS_DIR) || !statSync(TRACKS_DIR).isDirectory()) {
  console.error(`validate-track-assets: FAIL — tracks dir missing: ${TRACKS_DIR}`)
  process.exit(1)
}

const files = readdirSync(TRACKS_DIR)
  .filter((f) => f.toLowerCase().endsWith('.json'))
  .sort()

let totalRefs = 0
let totalTracks = 0
const danglingByTrack = [] // { track, missing: [{ ref, kind, path }] }
const parseFailures = [] // { file, error }

for (const f of files) {
  const full = join(TRACKS_DIR, f)
  let json
  try {
    json = JSON.parse(readFileSync(full, 'utf8'))
  } catch (err) {
    parseFailures.push({ file: f, error: err.message })
    continue
  }

  // Collect (ref, kind, on-disk path) tuples for this track.
  const refs = []
  if (typeof json.environmentGlb === 'string' && json.environmentGlb) {
    refs.push({
      ref: json.environmentGlb,
      kind: 'environmentGlb',
      path: publicPath(json.environmentGlb),
    })
  }
  if (Array.isArray(json.props)) {
    for (const p of json.props) {
      if (p && p.type === 'asset' && typeof p.assetId === 'string' && p.assetId) {
        refs.push({ ref: p.assetId, kind: 'props[].assetId', path: propAssetPath(p.assetId) })
      }
    }
  }
  // Audio references 404 softly at runtime (warned, never crashed), which is
  // exactly how three phantom ambience files shipped to production unnoticed —
  // so validate them as hard dangles here at authoring time.
  if (json.audio && typeof json.audio === 'object') {
    if (typeof json.audio.music === 'string' && json.audio.music) {
      refs.push({
        ref: json.audio.music,
        kind: 'audio.music',
        path: join(PUBLIC_DIR, 'audio', 'music', json.audio.music),
      })
    }
    if (Array.isArray(json.audio.ambient)) {
      for (const a of json.audio.ambient) {
        if (typeof a === 'string' && a) {
          refs.push({ ref: a, kind: 'audio.ambient', path: join(PUBLIC_DIR, 'audio', 'ambient', a) })
        }
      }
    }
  }

  // A JSON with no asset references (greybox route-stub, test scene) is
  // valid — nothing to dangle.
  if (refs.length === 0) continue

  totalTracks += 1

  // De-dup so a track placing 19 of the same prop reports the dangle once.
  const seen = new Set()
  const unique = refs.filter((r) => {
    const k = `${r.kind}:${r.ref}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  totalRefs += unique.length

  const missing = unique.filter((r) => !isFile(r.path))
  if (missing.length > 0) danglingByTrack.push({ track: f, missing })
}

let failed = false

if (parseFailures.length > 0) {
  failed = true
  console.error('validate-track-assets: FAIL — unparseable track JSON:')
  for (const { file, error } of parseFailures) console.error(`  - ${file}: ${error}`)
}

if (danglingByTrack.length > 0) {
  failed = true
  console.error('validate-track-assets: FAIL — dangling asset references:')
  for (const { track, missing } of danglingByTrack) {
    console.error(`  ${track}:`)
    for (const m of missing) {
      console.error(`    - [${m.kind}] ${m.ref}  →  ${m.path} (not found)`)
    }
  }
}

if (failed) {
  process.exit(1)
}

console.log(
  `validate-track-assets: OK — ${totalRefs} unique asset reference(s) across ` +
    `${totalTracks} track(s) all resolve on disk.`,
)
