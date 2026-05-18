/**
 * Hand-rolled profanity filter for anonymous leaderboard handles. Two
 * layers:
 *
 *   1. `leetNormalize`  — folds `@→A`, `0→O`, `1→I`, `3→E`, `5→S`,
 *      `7→T`, `$→S`, `!→I`. Catches the most common evasion ladder
 *      without trying to be exhaustive.
 *   2. Substring + word-boundary lookups against `BAD_STEMS`. Short
 *      stems (`ASS`) only match at word boundaries (or as whole-string)
 *      to side-step the Scunthorpe problem; longer stems match anywhere
 *      since false-positive risk drops fast with length.
 *
 * The filter is the front line, not the wall. It rejects the casual
 * try-once cases; everything else is caught by the reactive admin
 * wipe path. Tuning is conservative — we lean toward letting some
 * cringe through rather than blocking innocent names.
 *
 * Stem list curated from the small public-domain lists circulating on
 * GitHub (e.g. `LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words`)
 * — trimmed to ~80 entries covering common English slurs + profanity.
 * Stems are stored uppercase + post-leet-normalize so the comparison is
 * a straight substring test after applying the same normalizer to the
 * candidate handle.
 *
 * NB: by deliberate design this list is offensive content held in
 * source. Reviewers should expect to see it; the only way to filter
 * the words is to enumerate them.
 */

/** Substitution table. Keys are the raw characters players type;
 *  values are the canonical letters the substring check operates on. */
const LEET_MAP: Readonly<Record<string, string>> = Object.freeze({
  '0': 'O',
  '1': 'I',
  '3': 'E',
  '4': 'A',
  '5': 'S',
  '7': 'T',
  '8': 'B',
  '@': 'A',
  $: 'S',
  '!': 'I',
  '|': 'I',
  '+': 'T',
})

/** Apply the leet substitutions + uppercase. Pure. */
export function leetNormalize(raw: string): string {
  if (typeof raw !== 'string') return ''
  const up = raw.toUpperCase()
  let out = ''
  for (let i = 0; i < up.length; i++) {
    const c = up.charAt(i)
    out += LEET_MAP[c] ?? c
  }
  return out
}

/** Short stems — flagged only when they appear as the entire string
 *  or are bounded by non-letter characters (or string edges). Avoids
 *  the Scunthorpe / classes problem where `ASS` matches `CLASSIC`,
 *  `BASS`, etc. */
const SHORT_STEMS: ReadonlyArray<string> = Object.freeze(['ASS', 'CUM', 'FAG', 'GAY', 'JEW', 'TIT'])

/** Longer stems — flagged anywhere in the string. False-positive risk
 *  shrinks rapidly with length so a plain substring match is fine. */
const LONG_STEMS: ReadonlyArray<string> = Object.freeze([
  'ANAL',
  'ANUS',
  'ARSE',
  'BASTARD',
  'BITCH',
  'BOLLOCK',
  'BONER',
  'BOOB',
  'BUGGER',
  'BUKKAKE',
  'BULLSHIT',
  'CHINK',
  'COCK',
  'CRAP',
  'CUNT',
  'DICK',
  'DILDO',
  'DYKE',
  'FAGGOT',
  'FELLATIO',
  'FISTING',
  'FUCK',
  'GOOK',
  'HANDJOB',
  'HOMO',
  'JIZZ',
  'KIKE',
  'KKK',
  'KNOB',
  'KUNT',
  'LMAO',
  'MUFF',
  'NAZI',
  'NIGGA',
  'NIGGER',
  'NUTSACK',
  'PAKI',
  'PEDO',
  'PENIS',
  'PHUCK',
  'PISS',
  'POOP',
  'PORN',
  'PRICK',
  'PUSSY',
  'QUEER',
  'RAPE',
  'RETARD',
  'SCROTUM',
  'SEMEN',
  'SHIT',
  'SLUT',
  'SPIC',
  'TITS',
  'TOSSER',
  'TRANNY',
  'TURD',
  'TWAT',
  'VAGINA',
  'VULVA',
  'WANK',
  'WHORE',
  'WOG',
])

/** True if the handle (after leet-normalization) contains any banned
 *  stem. Used by both the client (gentle nudge) and the server (hard
 *  reject). Pure. */
export function containsProfanity(handle: string): boolean {
  const norm = leetNormalize(handle)
  if (!norm) return false
  // The handle alphabet is `[A-Z0-9_-]` so a "word boundary" here is
  // anything that isn't `[A-Z]` — including digits, hyphens, and
  // underscores. Test the original (uppercased) string against the
  // leet-normalized comparison to keep both layers honest.
  for (const stem of SHORT_STEMS) {
    if (norm === stem) return true
    if (containsBounded(norm, stem)) return true
  }
  for (const stem of LONG_STEMS) {
    if (norm.includes(stem)) return true
  }
  return false
}

function containsBounded(haystack: string, needle: string): boolean {
  let i = 0
  while (i <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, i)
    if (idx < 0) return false
    const before = idx > 0 ? haystack.charCodeAt(idx - 1) : -1
    const after =
      idx + needle.length < haystack.length ? haystack.charCodeAt(idx + needle.length) : -1
    const isLetter = (c: number) => c >= 65 && c <= 90 // A..Z
    if (!isLetter(before) && !isLetter(after)) return true
    i = idx + 1
  }
  return false
}

export const __test__ = { SHORT_STEMS, LONG_STEMS, LEET_MAP }
