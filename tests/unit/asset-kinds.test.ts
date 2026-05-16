import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ExportedKind } from '../../src/engine/asset-kinds'

/**
 * Asserts the TS `ExportedKind` registry stays in sync with the Python
 * `ExportedKind` class in `tools/blender/hoverbike_kinds.py`. Adding a
 * value to one side without the other fails this test loud.
 */

const PYTHON_REGISTRY = resolve(__dirname, '../../tools/blender/hoverbike_kinds.py')

function parsePythonExportedKind(): Set<string> {
  const src = readFileSync(PYTHON_REGISTRY, 'utf-8')
  // Capture the body of `class ExportedKind:` up to the next class
  // declaration (or end of file).
  const blockMatch = src.match(/class\s+ExportedKind[^:]*:([\s\S]*?)(?=^class\s|\Z)/m)
  if (!blockMatch) {
    throw new Error(`could not locate class ExportedKind in ${PYTHON_REGISTRY}`)
  }
  const block = blockMatch[1]!
  // Match `NAME = "value"` (or single quotes). Skip names starting
  // with `_` to mirror the convenience-tuple filter in
  // hoverbike_kinds.py (private / dunder helpers don't count as
  // public values).
  const values = new Set<string>()
  for (const m of block.matchAll(/^\s+([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']+)["']/gm)) {
    values.add(m[2]!)
  }
  if (values.size === 0) {
    throw new Error(
      `parsed class ExportedKind body but found no constants — regex drift in the test?`,
    )
  }
  return values
}

describe('asset-kinds.ts ↔ hoverbike_kinds.py sync', () => {
  it('TS ExportedKind has the same values as Python ExportedKind', () => {
    const tsValues: Set<string> = new Set(Object.values(ExportedKind))
    const pyValues = parsePythonExportedKind()
    // Symmetric diff for a precise error if they drift.
    const missingInTs = [...pyValues].filter((v) => !tsValues.has(v))
    const extraInTs = [...tsValues].filter((v) => !pyValues.has(v))
    expect(
      { missingInTs, extraInTs },
      `ExportedKind drift between Python and TS — both files must be kept in sync. See ` +
        `tools/blender/hoverbike_kinds.py and src/engine/asset-kinds.ts.`,
    ).toEqual({ missingInTs: [], extraInTs: [] })
  })

  it('exposes every value via Object.values for runtime iteration', () => {
    expect(Object.values(ExportedKind).length).toBeGreaterThan(0)
    expect(new Set(Object.values(ExportedKind)).size).toBe(Object.values(ExportedKind).length)
  })
})
