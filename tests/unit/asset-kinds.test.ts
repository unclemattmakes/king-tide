import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ExportedKind, resolveNodeKind } from '../../src/engine/asset-kinds'

/**
 * Asserts the TS `ExportedKind` registry stays in sync with the Python
 * `ExportedKind` class in `tools/blender/kingtide_kinds.py`. Adding a
 * value to one side without the other fails this test loud.
 */

const PYTHON_REGISTRY = resolve(__dirname, '../../tools/blender/kingtide_kinds.py')

function parsePythonExportedKind(): Set<string> {
  const src = readFileSync(PYTHON_REGISTRY, 'utf-8')
  // Slice the body of `class ExportedKind:` up to the next class
  // declaration (or EOF). Done with explicit string ops because the
  // regex equivalent needs `\Z` (end-of-input), which JS regex
  // doesn't have; biome flagged it as a useless escape.
  const start = src.search(/^class\s+ExportedKind[^:]*:/m)
  if (start < 0) {
    throw new Error(`could not locate class ExportedKind in ${PYTHON_REGISTRY}`)
  }
  const afterHeader = src.indexOf('\n', start) + 1
  const nextClassRel = src.slice(afterHeader).search(/^class\s/m)
  const end = nextClassRel < 0 ? src.length : afterHeader + nextClassRel
  const block = src.slice(afterHeader, end)
  // Match `NAME = "value"` (or single quotes). Skip names starting
  // with `_` to mirror the convenience-tuple filter in
  // kingtide_kinds.py (private / dunder helpers don't count as
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

describe('asset-kinds.ts ↔ kingtide_kinds.py sync', () => {
  it('TS ExportedKind has the same values as Python ExportedKind', () => {
    const tsValues: Set<string> = new Set(Object.values(ExportedKind))
    const pyValues = parsePythonExportedKind()
    // Symmetric diff for a precise error if they drift.
    const missingInTs = [...pyValues].filter((v) => !tsValues.has(v))
    const extraInTs = [...tsValues].filter((v) => !pyValues.has(v))
    expect(
      { missingInTs, extraInTs },
      `ExportedKind drift between Python and TS — both files must be kept in sync. See ` +
        `tools/blender/kingtide_kinds.py and src/engine/asset-kinds.ts.`,
    ).toEqual({ missingInTs: [], extraInTs: [] })
  })

  it('exposes every value via Object.values for runtime iteration', () => {
    expect(Object.values(ExportedKind).length).toBeGreaterThan(0)
    expect(new Set(Object.values(ExportedKind)).size).toBe(Object.values(ExportedKind).length)
  })
})

describe('resolveNodeKind — multi-primitive parent walk', () => {
  it('returns the object’s own kind when present', () => {
    expect(resolveNodeKind({ userData: { kind: ExportedKind.TRACK } })).toBe(ExportedKind.TRACK)
  })

  it('inherits a parent node’s kind when the child mesh carries none', () => {
    // Models three.js’s GLTFLoader split of a 2-material HV_Dock node:
    // Group{kind:'decoration'} → child Mesh{} (no kind). The collider/
    // heightmap passes visit the child, which must still read 'decoration'.
    const group = { userData: { kind: 'decoration' } }
    const childMesh = { userData: {}, parent: group }
    expect(resolveNodeKind(childMesh)).toBe('decoration')
  })

  it('returns undefined when neither the object nor any ancestor has a kind', () => {
    const root = { userData: {} }
    const child = { userData: {}, parent: root }
    expect(resolveNodeKind(child)).toBeUndefined()
  })

  it('prefers the nearest kind — a child’s own tag wins over an ancestor’s', () => {
    const grandparent = { userData: { kind: ExportedKind.TRACK } }
    const parent = { userData: { kind: ExportedKind.COLLIDER_MESH }, parent: grandparent }
    const child = { userData: {}, parent }
    expect(resolveNodeKind(child)).toBe(ExportedKind.COLLIDER_MESH)
  })

  it('tolerates null / undefined input', () => {
    expect(resolveNodeKind(null)).toBeUndefined()
    expect(resolveNodeKind(undefined)).toBeUndefined()
  })
})
