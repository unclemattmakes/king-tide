/**
 * Mechanical guard for the sim-purity rules that the rest of the codebase
 * relies on but, until now, only enforced socially (CLAUDE.md hard rule 3 /
 * ADR 0002, and the seeded-RNG determinism contract in
 * `engine/sim/ecs/world.ts`).
 *
 * Anything under `src/engine/sim/**` or `src/game/systems/**` must be:
 *   - Three-free          → no `import … from 'three'`
 *   - render-free         → no `import … from '@/engine/render/…'`
 *   - deterministic       → no `Math.random()`, `Date.now()`, `performance.now()`
 *   - devSettings-free    → no `import … from '@/engine/dev-settings'` (the
 *                           mutable, localStorage-backed, dev-palette-tunable
 *                           singleton is a silent multiplayer-desync source if
 *                           read mid-tick; §1.2 routed its sim-affecting knobs
 *                           through `StepInputs.tuning` instead)
 *
 * A single stray import in one of those layers would otherwise sail through
 * typecheck/lint/test/build and only surface as a multiplayer desync or a
 * broken headless test much later. This test fails loudly at the source.
 *
 * Comments are stripped before matching so prose that merely *mentions* a
 * banned token (e.g. "we deliberately avoid Math.random here") doesn't trip it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const GUARDED_DIRS = ['src/engine/sim', 'src/game/systems']

function listTs(dir: string): string[] {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, entry.name)
    if (entry.isDirectory()) out.push(...listTs(path.relative(ROOT, p)))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Strip block + line comments so banned tokens in prose don't false-positive. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const BANS: { label: string; re: RegExp }[] = [
  { label: "import from 'three'", re: /\bfrom\s+['"]three(?:\/[^'"]*)?['"]/ },
  { label: "require('three')", re: /\brequire\(\s*['"]three(?:\/[^'"]*)?['"]\s*\)/ },
  { label: 'import from @/engine/render', re: /\bfrom\s+['"]@\/engine\/render(?:\/[^'"]*)?['"]/ },
  { label: 'Math.random()', re: /\bMath\.random\s*\(/ },
  { label: 'Date.now()', re: /\bDate\.now\s*\(/ },
  { label: 'performance.now()', re: /\bperformance\.now\s*\(/ },
  // Matches both the alias import (`@/engine/dev-settings`) and any relative
  // path that ends in `dev-settings` (e.g. `../../engine/dev-settings`).
  {
    label: "import from '@/engine/dev-settings'",
    re: /\bfrom\s+['"](?:@\/engine\/dev-settings|(?:\.\.?\/)+(?:[^'"]*\/)?dev-settings)['"]/,
  },
]

describe('sim-purity guard', () => {
  const files = GUARDED_DIRS.flatMap(listTs)

  it('finds the guarded source files', () => {
    // Sanity: if the globs ever break, fail rather than pass vacuously.
    expect(files.length).toBeGreaterThan(20)
  })

  for (const ban of BANS) {
    it(`forbids ${ban.label} under ${GUARDED_DIRS.join(' / ')}`, () => {
      const offenders: string[] = []
      for (const file of files) {
        const code = stripComments(fs.readFileSync(file, 'utf8'))
        if (ban.re.test(code)) offenders.push(path.relative(ROOT, file))
      }
      expect(
        offenders,
        `${ban.label} is banned in sim layers but found in:\n${offenders.join('\n')}`,
      ).toEqual([])
    })
  }
})
