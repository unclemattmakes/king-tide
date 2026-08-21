import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ExportedKind } from '@/engine/asset-kinds'
import { NON_COLLIDING_KINDS } from '@/engine/render/glb-track'

/**
 * Guards the collision-proxy mirror.
 *
 * `tools/blender/build_track_collider.py` bakes `<track>-collider.glb`, and
 * `track-loader.ts` colliders THAT INSTEAD OF the render geometry whenever it
 * exists. So the builder's strip list is not an optimisation hint — it decides
 * what has collision in a race. A kind listed there but not in
 * `attachTrackColliders`' skip set is collision that vanishes silently: the
 * mesh still renders, and the bike flies through it.
 *
 * That is exactly what happened to Mayday Bay's docks. `collider_mesh` — the
 * collide-but-don't-render kind carrying the docks' only collision, since their
 * visible plank decks are tagged `decoration` — was in the Python set, so the
 * proxy dropped both dock ramps' collision while the decks kept rendering.
 */

const PY = resolve(__dirname, '../../tools/blender/build_track_collider.py')

/** Parse the `NON_COLLIDING_KINDS = {...}` set literal out of the builder. */
function parsePythonSkipSet(): Set<string> {
  const src = readFileSync(PY, 'utf-8')
  const m = /^NON_COLLIDING_KINDS\s*=\s*\{([^}]*)\}/m.exec(src)
  if (!m) throw new Error(`could not locate NON_COLLIDING_KINDS in ${PY}`)
  const values = new Set<string>()
  for (const q of m[1]!.matchAll(/["']([^"']+)["']/g)) values.add(q[1]!)
  if (values.size === 0) {
    throw new Error('parsed NON_COLLIDING_KINDS but found no values — regex drift in the test?')
  }
  return values
}

describe('glb-track.ts ↔ build_track_collider.py non-colliding-kind sync', () => {
  it('the runtime skip set and the proxy strip list are identical', () => {
    const py = parsePythonSkipSet()
    const ts = new Set(NON_COLLIDING_KINDS)
    const missingInTs = [...py].filter((v) => !ts.has(v))
    const extraInTs = [...ts].filter((v) => !py.has(v))
    expect(
      { missingInTs, extraInTs },
      'Non-colliding-kind drift between the runtime collider attach and the ' +
        'Blender proxy builder. A kind stripped by the builder but collided by ' +
        'the runtime loses its collision on any track that ships a ' +
        '<track>-collider.glb. Keep NON_COLLIDING_KINDS in ' +
        'src/engine/render/glb-track.ts and tools/blender/build_track_collider.py ' +
        'in sync.',
    ).toEqual({ missingInTs: [], extraInTs: [] })
  })

  it('never treats collider_mesh as non-colliding on either side', () => {
    // The regression itself. `collider_mesh` is hidden from RENDER precisely so
    // it can carry COLLISION (see ExportedKind.COLLIDER_MESH) — it belongs in
    // neither skip list, and the proxy must bake it in verbatim.
    expect(NON_COLLIDING_KINDS.has(ExportedKind.COLLIDER_MESH)).toBe(false)
    expect(parsePythonSkipSet().has(ExportedKind.COLLIDER_MESH)).toBe(false)
  })

  it('keeps authored collider_mesh out of the decimate pass', () => {
    // A swept dock ramp is ~1k tris against the terrain's ~200k, and its lip is
    // feel-critical — a collapse-decimate would round it off for no meaningful
    // saving. The builder routes EXACT_KIND into its own undecimated object.
    const src = readFileSync(PY, 'utf-8')
    expect(/^EXACT_KIND\s*=\s*["']collider_mesh["']/m.test(src)).toBe(true)
    expect(src).toContain('HV_TrackColliderExact')
  })

  it('skips every kind that is render-only, and nothing else', () => {
    // Spot-check the members so a careless edit to the set has to be deliberate.
    expect([...NON_COLLIDING_KINDS].sort()).toEqual(['decal', 'decoration', 'emitter', 'horizon'])
    // Load-bearing collidable kinds must never creep in.
    expect(NON_COLLIDING_KINDS.has(ExportedKind.TRACK)).toBe(false)
    expect(NON_COLLIDING_KINDS.has(ExportedKind.COLLIDER_MESH)).toBe(false)
  })
})
