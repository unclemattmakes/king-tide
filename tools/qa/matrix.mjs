/**
 * King Tide QA matrix — single source of truth for the parameterized
 * smoke / soak runs.
 *
 * A "cell" is one (track × bike) tuple the QA pass exercises. We
 * intentionally keep this hard-coded rather than discovering tracks via
 * the asset manifest so a regression that *removes* a track from the
 * build is loud — the cell still fails, with a clear "no GLB" error,
 * instead of silently shrinking the matrix.
 *
 * Per-track budgets override the global default (`fps >= 30`, `p95
 * <= 50ms`) where we expect the perf load to differ. Today every cell
 * shares the global budget; populate `perfBudget` overrides as the v1
 * art lands and per-track baselines emerge.
 *
 * `enabled: false` cells are left in the manifest as TODO markers so a
 * grep can see "this track is expected to ship". They're skipped in
 * `pnpm qa`. Flip to `true` once the track GLB exists.
 */

/** @typedef {{ id: string, bike: 'cruiser' | 'racer' | 'stunt', enabled: boolean, perfBudget?: { fpsFloor?: number, p95CeilingMs?: number }, note?: string }} QaCell */

/** @type {{ fpsFloor: number, p95CeilingMs: number }} */
export const GLOBAL_PERF_BUDGET = Object.freeze({
  fpsFloor: 30,
  p95CeilingMs: 50,
})

/** @type {QaCell[]} */
export const QA_MATRIX = [
  // Procedural tracks — always present, every bike. The smoke floor.
  { id: 'lagoon', bike: 'racer', enabled: true },
  { id: 'lagoon', bike: 'cruiser', enabled: true },
  { id: 'lagoon', bike: 'stunt', enabled: true },
  { id: 'cliffside', bike: 'racer', enabled: true },
  { id: 'cliffside', bike: 'cruiser', enabled: true },
  { id: 'cliffside', bike: 'stunt', enabled: true },

  // Reef Cup — v1 ship tracks (sprint 1). GLBs landed 2026-05-18.
  // Test only the default bike for non-procedural tracks until they
  // flip to `status: 'ship'`; expand to all three bikes per track as
  // each cup goes live.
  { id: 'sandbar', bike: 'racer', enabled: true },
  // Mexico City replaced South Beach in the opener slot. GLB + art pass
  // landed and it's `status: 'ship'`, so it's live in the matrix — also the
  // heaviest dressed track, which anchors the boot-time budget.
  { id: 'mexico-city', bike: 'racer', enabled: true },
  { id: 'cape-town-drift', bike: 'racer', enabled: true },

  // Harbor Cup (v2) — drowned harbor cities, replacing the Open Sea
  // Cup. Seattle + Sydney are fresh concepts with no geometry yet, so
  // they sit as disabled TODO markers until their GLBs land. (San
  // Francisco / Golden Gate moved up from Continental; its greybox is
  // exercised through the menu + race-mode paths, not yet here.)
  {
    id: 'needle-sound',
    bike: 'racer',
    enabled: false,
    note: 'Harbor Cup — Seattle concept; GLB pending',
  },
  {
    id: 'opera-drowned',
    bike: 'racer',
    enabled: false,
    note: 'Harbor Cup — Sydney concept; GLB pending',
  },

  // Continental Cup — sprint 2 (M14). GLBs landed 2026-05-18. Shibuya
  // backfilled the slot Golden Gate vacated for the Harbor Cup.
  { id: 'shibuya-submerged', bike: 'racer', enabled: true },
  { id: 'kilauea-crown', bike: 'racer', enabled: true },
  { id: 'marina-bay-7', bike: 'racer', enabled: true },
  { id: 'doges-drift', bike: 'racer', enabled: true },

  // Parked to the B-list (v2) — the pure-open-water tracks pulled from
  // the ship cups in the no-open-water pass. Still in the build, so we
  // keep QA on them to catch a regression that drops the GLB.
  { id: 'the-maw', bike: 'racer', enabled: true },
  { id: 'hatteras-light', bike: 'racer', enabled: true },

  // Drowned Cup — sprint 3 (M15). No GLBs yet; left as TODO markers
  // so `pnpm qa` reports them as "pending" rather than dropping them.
  {
    id: 'aqualand',
    bike: 'racer',
    enabled: false,
    note: 'Drowned Cup chaos slot — sprint 3 (M15)',
  },
  {
    id: 'angkor-drowned',
    bike: 'racer',
    enabled: false,
    note: 'Drowned Cup — sprint 3 (M15)',
  },
  {
    id: 'liberty-drowned',
    bike: 'racer',
    enabled: false,
    note: 'Drowned Cup finale — sprint 3 (M15)',
  },
]

/** Soak run — single track held under autoplay for 60+ seconds.
 *  Smaller surface than the matrix; the goal is "no leaks, no console
 *  errors, no NaN bike positions" across a long window. */
export const SOAK_TRACKS = [{ id: 'lagoon', bike: 'racer', durationSec: 60 }]

/** Filtered matrix (only enabled cells) as a JSON-friendly array. */
export function enabledCells() {
  return QA_MATRIX.filter((c) => c.enabled)
}
