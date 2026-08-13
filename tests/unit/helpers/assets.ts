/**
 * Guard for unit tests that parse **real compiled asset bytes**.
 *
 * Compiled GLBs are not in git — they live on Cloudflare R2 and are gitignored
 * (docs/asset-storage.md). So they're absent in three legitimate situations:
 * a fresh clone before `pnpm assets:pull`, a fork with no bucket credentials,
 * and CI's `check-and-build` job, which deliberately runs the fast checks
 * *without* asset bytes (the asset-dependent gates are the `e2e` /
 * `determinism` jobs, which hydrate from R2 first).
 *
 * A test that reads those bytes must therefore **skip, not fail**, when they
 * aren't there — otherwise the asset-free job goes red for a reason that has
 * nothing to do with the code under test. Skipping keeps full coverage
 * wherever assets exist (every local dev run, every hydrated CI job) while
 * letting the asset-free lane stay honest.
 *
 * Usage — read at module scope, gate the suite, and guard the parse, since
 * vitest still executes a `skipIf`-ed `describe` body to collect its tests:
 *
 *     const racer = readAssetBytes('bikes/racer.glb')
 *     describe.skipIf(!racer.available)(racer.describeSuffix('bike contract'), () => {
 *       const gltf = racer.available ? parseGlbJson(racer.arrayBuffer()) : { nodes: [] }
 *       …
 *     })
 */
import fs from 'node:fs'
import path from 'node:path'

const ASSETS_ROOT = path.resolve(__dirname, '../../..', 'public', 'assets')

/** Pre-R2 clones can still hold Git LFS pointer stubs instead of real bytes
 *  (LFS was dropped in #292). Treated the same as "absent": not parseable. */
const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1'

export interface AssetBytes {
  /** True only when real, parseable bytes are on disk. */
  readonly available: boolean
  /** Human-readable why-not, for the skip label. Empty when available. */
  readonly reason: string
  /** The bytes; empty when unavailable (never throws). */
  readonly buffer: Buffer
  /** The bytes as an ArrayBuffer, for glTF parsers. */
  arrayBuffer(): ArrayBuffer
  /** Suite name with the skip reason appended, so a skipped run says why. */
  describeSuffix(name: string): string
}

/** Read a compiled asset under `public/assets/`, tolerating absence.
 *  @param relPath e.g. `'tracks/calibration.glb'` */
export function readAssetBytes(relPath: string): AssetBytes {
  const full = path.join(ASSETS_ROOT, relPath)
  let buffer = Buffer.alloc(0)
  let reason = ''

  if (!fs.existsSync(full)) {
    reason = `${relPath} not hydrated — run \`pnpm assets:pull\``
  } else {
    buffer = fs.readFileSync(full)
    if (buffer.subarray(0, LFS_POINTER_PREFIX.length).toString('utf8') === LFS_POINTER_PREFIX) {
      buffer = Buffer.alloc(0)
      reason = `${relPath} is a stale Git LFS pointer — run \`pnpm assets:pull\``
    }
  }

  return {
    available: reason === '',
    reason,
    buffer,
    arrayBuffer: () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    describeSuffix: (name: string) => (reason === '' ? name : `${name} [skipped: ${reason}]`),
  }
}
