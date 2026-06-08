/**
 * Tiny dependency-free fuzzy matcher for the dev command bar.
 *
 * `fuzzyScore` returns a score (LOWER = better) when every character of
 * `query` appears in `text` in order (a subsequence), or `null` when it
 * doesn't match at all. Scoring rewards consecutive runs, matches at word
 * boundaries, and an early first hit — enough to feel VS-Code-ish over a
 * ~40-entry palette. Not a general-purpose ranker.
 */

const BOUNDARY = new Set([' ', '-', '_', '.', '/', ':'])

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (q.length === 0) return 0

  let score = 0
  let ti = 0
  let prevMatch = -2
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q.charAt(qi), ti)
    if (found === -1) return null
    // Gap penalty — characters skipped since the previous match.
    score += found - ti
    // Consecutive-run bonus.
    if (found === prevMatch + 1) score -= 1.5
    // Word-boundary bonus (start of string, or preceded by a separator).
    const before = found > 0 ? t.charAt(found - 1) : ' '
    if (BOUNDARY.has(before)) score -= 1
    prevMatch = found
    ti = found + 1
  }
  // Tie-breaker: prefer the shorter (more specific) text.
  return score + t.length * 0.01
}
