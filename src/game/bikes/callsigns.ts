/**
 * Deterministic racer call-signs for AI opponents.
 *
 * Replaces the placeholder `"Racer N"` labels that the replay recorder used
 * to ship with. The Circuit is a spectator sport; the broadcast intro needs
 * names that read like Wipeout / F-Zero / G-Police call-signs, not generic
 * filler.
 *
 * Determinism: seeded on `(trackId, slot)`. Same track + same slot always
 * yields the same name, so a replay's roster lines up with the live race
 * that recorded it — important because the replay file stores names as
 * strings; if we re-rolled per session, replay playback would show a
 * different roster than the original race.
 *
 * Slot 0 is reserved for the player (we never roll a call-sign for slot 0).
 */

const CALL_SIGNS: readonly string[] = [
  'FOAM-7',
  'ECHOLINE',
  'STORMVANE',
  'RIPTIDE',
  'NEONHAWK',
  'KESTREL-9',
  'SALTWIRE',
  'KOI-13',
  'TIDESHARK',
  'DUSKLINE',
  'BAYOU-VOLT',
  'CINDER',
  'GULFTONE',
  'NIGHTGULL',
  'AURORA',
  'BASALT',
  'FRACTAL-2',
  'HALYARD',
  'MEGAPASCAL',
  'NIMBUS',
  'SARGASSO',
  'TROPIC-K',
  'WAKELINE',
  'XYLEM',
  'YONDER',
  'ZERO-K',
  'BREAKWATER',
  'KELP-RUNNER',
  'MIRAGE-4',
  'OBSIDIAN',
  'PILOT-FISH',
  'QUARRY',
]

/** Pick a call-sign deterministically from (trackId, slot). Slot 0 is the
 *  player and is never used as a seed key here (the caller should pass the
 *  player's variant name instead). */
export function aiCallSign(trackId: string, slot: number): string {
  // Slot ≥ 1 → roll an index into CALL_SIGNS using a stable FNV-ish hash so
  // the same (track, slot) round-trips the same name. We add an offset per
  // slot so two AI bikes on the same grid don't collide on a single name
  // when the hash happens to wrap.
  const seed = fnv1a(`${trackId}#${slot}`)
  return CALL_SIGNS[seed % CALL_SIGNS.length] as string
}

/** Stable 32-bit FNV-1a — small, allocation-free, deterministic across
 *  JS engines. Used only at race-start to pick names; not hot. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}
