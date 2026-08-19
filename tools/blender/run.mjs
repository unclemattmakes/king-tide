#!/usr/bin/env node
/**
 * Cross-platform Blender invoker for the asset pipeline.
 *
 * Usage:
 *   node tools/blender/run.mjs build_bike specs/bikes
 *   node tools/blender/run.mjs build_prop specs/props
 *   node tools/blender/run.mjs build_track specs/tracks
 *   node tools/blender/run.mjs build_all
 *   node tools/blender/run.mjs manifest
 *
 * For build_<category>:
 *   1. Resolves the Blender executable.
 *   2. Lists *.json files in the spec directory (skipping _schema/).
 *   3. Validates each spec against its $schema (ajv).
 *   4. Spawns Blender per spec with KINGTIDE_SPEC and KINGTIDE_OUTPUT
 *      pointing at the corresponding GLB under public/assets/<category>/.
 *   5. Streams stdout/stderr with a per-spec prefix.
 *   6. Exits non-zero if any builder failed.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Ajv from 'ajv'

const __filename = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(__filename)
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')

const args = process.argv.slice(2)
const action = args[0]

if (!action) {
  printUsage()
  process.exit(1)
}

const builderToCategory = {
  build_bike: 'bikes',
  build_prop: 'props',
  build_track: 'tracks',
}

function printUsage() {
  console.error('usage:')
  console.error('  run.mjs build_bike specs/bikes')
  console.error('  run.mjs build_prop specs/props')
  console.error('  run.mjs build_track specs/tracks')
  console.error('  run.mjs build_all')
  console.error('  run.mjs manifest')
}

/** Locate the Blender executable. Order: $BLENDER_EXE, PATH, OS-default. */
function resolveBlender() {
  const explicit = process.env.BLENDER_EXE
  if (explicit) {
    if (!existsSync(explicit)) {
      console.error(`[run] BLENDER_EXE=${explicit} does not exist`)
      process.exit(2)
    }
    return explicit
  }

  const pathProbe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['blender'], {
    encoding: 'utf8',
  })
  if (pathProbe.status === 0 && pathProbe.stdout.trim()) {
    return pathProbe.stdout.trim().split(/\r?\n/)[0]
  }

  const candidates = []
  if (process.platform === 'win32') {
    for (const v of ['5.3', '5.2', '5.1', '5.0', '4.5', '4.4']) {
      candidates.push(`C:\\Program Files\\Blender Foundation\\Blender ${v}\\blender.exe`)
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Blender.app/Contents/MacOS/Blender')
  } else {
    candidates.push('/usr/bin/blender', '/usr/local/bin/blender')
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  console.error(
    '[run] could not locate Blender. Set BLENDER_EXE or install per docs/asset-pipeline-guide.md.',
  )
  process.exit(2)
}

/** Read a JSON spec and validate against its $schema (relative path). */
function validateSpec(specPath, ajv) {
  const raw = readFileSync(specPath, 'utf8')
  const spec = JSON.parse(raw)
  const schemaRel = spec.$schema
  if (!schemaRel || typeof schemaRel !== 'string') {
    return { ok: false, errors: [`${path.basename(specPath)}: missing $schema`] }
  }
  // Resolve $schema relative to the spec file location.
  const schemaPath = path.resolve(path.dirname(specPath), schemaRel)
  if (!existsSync(schemaPath)) {
    return { ok: false, errors: [`${path.basename(specPath)}: $schema not found at ${schemaPath}`] }
  }
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  const cacheKey = schemaPath
  let validate = ajv.getSchema(cacheKey)
  if (!validate) {
    ajv.addSchema(schema, cacheKey)
    validate = ajv.getSchema(cacheKey)
  }
  // Strip $schema before validating since the schema doesn't allow extras
  // (additionalProperties: true at top-level lets it through anyway, but
  // some schemas may set additionalProperties: false).
  const { $schema: _ignored, ...specForValidation } = spec
  const ok = validate(specForValidation)
  if (!ok) {
    const errors = (validate.errors ?? []).map(
      (e) => `${path.basename(specPath)}: ${e.instancePath || '/'} ${e.message}`,
    )
    return { ok: false, errors }
  }
  return { ok: true, spec }
}

function runBuilder(builder, specDir) {
  const category = builderToCategory[builder]
  if (!category) {
    console.error(`[run] unknown builder: ${builder}`)
    process.exit(1)
  }
  const specDirAbs = path.resolve(REPO_ROOT, specDir)
  if (!existsSync(specDirAbs)) {
    console.error(`[run] spec dir not found: ${specDirAbs}`)
    process.exit(2)
  }

  const blender = resolveBlender()
  const builderScript = path.join(SCRIPT_DIR, `${builder}.py`)
  if (!existsSync(builderScript)) {
    console.error(`[run] builder script not found: ${builderScript}`)
    process.exit(2)
  }

  const outDir = path.join(REPO_ROOT, 'public', 'assets', category)
  mkdirSync(outDir, { recursive: true })

  const specs = readdirSync(specDirAbs)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(specDirAbs, f))
  if (specs.length === 0) {
    console.error(`[run] no specs in ${specDirAbs}`)
    return { built: [], failed: [] }
  }

  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false })
  const built = []
  const failed = []
  for (const specPath of specs) {
    const result = validateSpec(specPath, ajv)
    if (!result.ok) {
      console.error(`[${category}] schema FAIL ${path.basename(specPath)}`)
      for (const e of result.errors) console.error(`  - ${e}`)
      failed.push(specPath)
      continue
    }
    const id = result.spec.id
    const outPath = path.join(outDir, `${id}.glb`)
    console.log(
      `[${category}] build ${path.basename(specPath)} -> ${path.relative(REPO_ROOT, outPath)}`,
    )
    const child = spawnSync(blender, ['--background', '--python', builderScript], {
      env: {
        ...process.env,
        KINGTIDE_SPEC: specPath,
        KINGTIDE_OUTPUT: outPath,
      },
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
    if (child.status !== 0) {
      console.error(`[${category}] FAIL ${path.basename(specPath)} (exit ${child.status})`)
      failed.push(specPath)
    } else {
      built.push({ id, specPath, outPath, spec: result.spec, category })
    }
  }
  return { built, failed }
}

function listSpecsAcrossCategories() {
  const out = []
  for (const builder of Object.keys(builderToCategory)) {
    const category = builderToCategory[builder]
    const specDir = path.join(REPO_ROOT, 'specs', category)
    if (!existsSync(specDir)) continue
    out.push({ builder, specDir: path.relative(REPO_ROOT, specDir), category })
  }
  return out
}

function buildAll() {
  let allBuilt = []
  let allFailed = []
  for (const { builder, specDir } of listSpecsAcrossCategories()) {
    const { built, failed } = runBuilder(builder, specDir)
    allBuilt = allBuilt.concat(built)
    allFailed = allFailed.concat(failed)
  }
  writeManifest(allBuilt)
  if (allFailed.length > 0) {
    console.error(`[run] ${allFailed.length} builder(s) failed`)
    process.exit(1)
  }
  console.log(`[run] built ${allBuilt.length} asset(s)`)
}

function writeManifest(built) {
  // Start from whatever's on disk so addon-authored tracks (entries
  // not produced by `gen:*`) survive a `build_all`. The spec pipeline
  // upserts by id for tracks; bikes / props / riders get wipe-and-
  // replaced since the spec pipeline is the only authoring path.
  const manifestPath = path.join(REPO_ROOT, 'public', 'assets', 'manifest.json')
  let existing = { schemaVersion: 1, bikes: [], props: [], riders: [], tracks: [] }
  if (existsSync(manifestPath)) {
    try {
      existing = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      // corrupt → fall back to a fresh manifest
    }
  }
  existing.bikes = []
  existing.props = []
  existing.riders = existing.riders ?? []
  existing.tracks = existing.tracks ?? []
  for (const item of built) {
    const url = `/assets/${item.category}/${item.id}.glb`
    const specPath = path.relative(REPO_ROOT, item.specPath).replace(/\\/g, '/')
    const entry = {
      id: item.id,
      displayName: item.spec.displayName ?? item.id,
      url,
      specPath,
    }
    if (item.category === 'bikes') {
      entry.physics = item.spec.physics
      entry.appearance = item.spec.appearance
      existing.bikes.push(entry)
    } else if (item.category === 'props') {
      entry.category = item.spec.category
      // Surface the wave-rider archetype to the manifest so the editor
      // palette can show a "rides waves" hint without re-fetching the
      // spec. The runtime ground-truths this off the GLB's extras (see
      // `prop-loader.ts`), so the manifest field is UI-only — divergence
      // wouldn't change physics behaviour.
      if (item.spec.waveRider?.archetype) {
        entry.waveRider = item.spec.waveRider.archetype
      }
      existing.props.push(entry)
    } else if (item.category === 'tracks') {
      // Upsert: same id → replace; new id → append; addon-built entries
      // already on disk are preserved.
      const idx = existing.tracks.findIndex((e) => e.id === item.id)
      if (idx >= 0) existing.tracks[idx] = entry
      else existing.tracks.push(entry)
    }
  }
  for (const k of ['bikes', 'props', 'riders', 'tracks']) {
    existing[k].sort((a, b) => a.id.localeCompare(b.id))
  }
  existing.schemaVersion = 1
  existing.generatedAt = new Date().toISOString()
  mkdirSync(path.dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
  console.log(`[run] wrote ${path.relative(REPO_ROOT, manifestPath)}`)
}

if (action === 'build_bike' || action === 'build_prop' || action === 'build_track') {
  const specDir = args[1]
  if (!specDir) {
    console.error(`[run] ${action} requires a spec directory`)
    process.exit(1)
  }
  const { built, failed } = runBuilder(action, specDir)
  // Single-builder mode only refreshes its category in the manifest. To
  // keep things simple we re-merge with the existing manifest if present.
  const manifestPath = path.join(REPO_ROOT, 'public', 'assets', 'manifest.json')
  let existing = { schemaVersion: 1, bikes: [], props: [], riders: [], tracks: [] }
  if (existsSync(manifestPath)) {
    try {
      existing = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      // fall through with empty manifest if file is corrupt
    }
  }
  const category = builderToCategory[action]
  // Per-category merge policy:
  //   - bikes / props / riders: wipe-and-replace, since the only author
  //     for those is the spec pipeline.
  //   - tracks: upsert by id. Tracks authored interactively by the
  //     Blender addon (see `_upsert_manifest_track` in kingtide_addon.py)
  //     have specPath under public/tracks/; the spec pipeline's tracks
  //     live under specs/. We let `gen:tracks` refresh the spec-driven
  //     entries by id but preserve any other ids that are already
  //     present, so addon-built tracks survive a `gen:tracks` run.
  existing.bikes = existing.bikes ?? []
  existing.props = existing.props ?? []
  existing.riders = existing.riders ?? []
  existing.tracks = existing.tracks ?? []

  function buildEntry(item) {
    const url = `/assets/${item.category}/${item.id}.glb`
    const specPath = path.relative(REPO_ROOT, item.specPath).replace(/\\/g, '/')
    const entry = {
      id: item.id,
      displayName: item.spec.displayName ?? item.id,
      url,
      specPath,
    }
    if (item.category === 'bikes') {
      entry.physics = item.spec.physics
      entry.appearance = item.spec.appearance
    } else if (item.category === 'props') {
      entry.category = item.spec.category
      if (item.spec.waveRider?.archetype) {
        entry.waveRider = item.spec.waveRider.archetype
      }
    }
    return entry
  }

  if (category === 'tracks') {
    const byId = new Map(existing.tracks.map((e) => [e.id, e]))
    for (const item of built) {
      byId.set(item.id, buildEntry(item))
    }
    existing.tracks = [...byId.values()]
  } else {
    existing[category] = built.map(buildEntry)
  }
  existing[category].sort((a, b) => a.id.localeCompare(b.id))
  existing.schemaVersion = 1
  existing.generatedAt = new Date().toISOString()
  mkdirSync(path.dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
  console.log(`[run] wrote ${path.relative(REPO_ROOT, manifestPath)}`)
  if (failed.length > 0) {
    console.error(`[run] ${failed.length} builder(s) failed`)
    process.exit(1)
  }
} else if (action === 'build_all') {
  buildAll()
} else if (action === 'manifest') {
  // Regenerate manifest from already-built GLBs without invoking
  // Blender. Useful when only metadata changed.
  const built = []
  for (const { category } of listSpecsAcrossCategories()) {
    const specDir = path.join(REPO_ROOT, 'specs', category)
    if (!existsSync(specDir)) continue
    for (const f of readdirSync(specDir).filter((x) => x.endsWith('.json'))) {
      const specPath = path.join(specDir, f)
      const spec = JSON.parse(readFileSync(specPath, 'utf8'))
      const outPath = path.join(REPO_ROOT, 'public', 'assets', category, `${spec.id}.glb`)
      if (!existsSync(outPath)) continue
      built.push({ id: spec.id, specPath, outPath, spec, category })
    }
  }
  writeManifest(built)
} else {
  console.error(`[run] unknown action: ${action}`)
  printUsage()
  process.exit(1)
}
