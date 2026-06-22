#!/usr/bin/env node
// check-assets-present.mjs — guard against shipping an empty asset tree.
//
// The compiled runtime assets (GLBs, audio, atlases) are gitignored and live
// on Cloudflare R2 (see docs/asset-storage.md). A desktop/Steam bundle built
// from a bare checkout — without `pnpm assets:pull` — would ship with an EMPTY
// public/assets and look fine to electron-builder while being a broken game.
// This script is the floor check: run it AFTER hydration (and again after the
// build, against the staged tree) so an empty bundle fails the job loudly
// instead of silently uploading.
//
// Exit codes: 0 = OK (prints a one-line summary), non-zero = something is
// missing (prints exactly what). Zero runtime deps — plain Node ESM.
//
// Env overrides:
//   ASSET_GLB_FLOOR  minimum number of *.glb files required (default 20)
//   ASSET_DIR        root of the compiled asset tree (default public/assets)

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const ASSET_DIR = process.env.ASSET_DIR
  ? resolve(process.env.ASSET_DIR)
  : join(repoRoot, 'public', 'assets')
const GLB_FLOOR = Number.parseInt(process.env.ASSET_GLB_FLOOR ?? '20', 10)

// Must-haves: a handful of canonical files whose absence means the pull
// didn't land (or landed the wrong bucket). Paths are relative to ASSET_DIR.
const MUST_HAVE = ['bikes/racer.glb', 'manifest.json']

/** Recursively count files matching `ext` under `dir`. */
function countByExt(dir, ext) {
  let n = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const ent of entries) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      n += countByExt(full, ext)
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith(ext)) {
      n += 1
    }
  }
  return n
}

const problems = []

if (!existsSync(ASSET_DIR) || !statSync(ASSET_DIR).isDirectory()) {
  problems.push(`asset dir missing: ${ASSET_DIR} (did you run \`pnpm assets:pull\`?)`)
} else {
  const glbCount = countByExt(ASSET_DIR, '.glb')
  if (glbCount < GLB_FLOOR) {
    problems.push(
      `only ${glbCount} *.glb under ${ASSET_DIR}, need >= ${GLB_FLOOR} ` +
        `(set ASSET_GLB_FLOOR to override). The asset bucket likely didn't hydrate.`,
    )
  }

  for (const rel of MUST_HAVE) {
    const full = join(ASSET_DIR, rel)
    if (!existsSync(full)) {
      problems.push(`required asset missing: ${join(ASSET_DIR, rel)}`)
    }
  }
}

if (problems.length > 0) {
  console.error('check-assets-present: FAIL — the compiled asset tree is incomplete.')
  console.error('An empty/partial bundle must never ship (see docs/asset-storage.md).')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

const glbCount = countByExt(ASSET_DIR, '.glb')
console.log(
  `check-assets-present: OK — ${glbCount} *.glb (floor ${GLB_FLOOR}) + ` +
    `${MUST_HAVE.length} must-haves present under ${ASSET_DIR}.`,
)
