#!/usr/bin/env node
/**
 * Soundtrack build step — transcode the Creative-Commons `.mp3` source
 * tracks into streaming-friendly Opus and regenerate the runtime manifest.
 *
 * Mirrors the `gen:*` Blender pipeline shape: raw authoring sources live
 * out of git (the Google-Drive content folder, see docs/asset-storage.md);
 * the compiled exports land under `public/audio/music/*.opus` (served from
 * R2, gitignored) and a generated TS manifest captures the credits.
 *
 *   Source files are named `<artist> - <title>.mp3` (the convention the
 *   credit toast keys off). This script splits on the first " - ",
 *   normalises a few filesystem-safe substitutions (`_phrase_` → `(phrase)`),
 *   slugs `<artist>-<title>` for the output filename, and writes:
 *
 *     public/audio/music/<slug>.opus           — streamed at runtime
 *     src/engine/audio/soundtrack.generated.ts  — SoundtrackEntry[]
 *
 * License provenance comes from `credits.json` NEXT TO THE SOURCE MP3S,
 * keyed by exact source filename with { license, licenseUrl, sourceUrl }
 * per track (verified against each track's canonical source page — see
 * CREDITS.md). A track missing from the sidecar is emitted with license
 * "UNVERIFIED" and a loud warning: fix the sidecar, don't ship it.
 *
 * Opus is the most byte-efficient codec every modern browser can stream
 * via an <audio> element; ~half an equivalent-quality MP3. We strip cover
 * art (`-vn`) and all metadata (`-map_metadata -1`) — the manifest is the
 * single source of truth for credits, and stray ID3 art bloats the file.
 *
 * Usage:
 *   pnpm gen:music                 # default source + 112k VBR
 *   node tools/convert-music.mjs <srcDir> [--force] [--bitrate 128k]
 *
 * Env overrides:
 *   KINGTIDE_MUSIC_SRC     source dir of .mp3s (else <content>/audio/music)
 *   KINGTIDE_CONTENT_ROOT  content root (default C:/project-content/hoverbike)
 *   FFMPEG_EXE              explicit ffmpeg path (else PATH, else winget glob)
 *   MUSIC_OPUS_BITRATE      target bitrate (default 112k)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const args = process.argv.slice(2)
const force = args.includes('--force')
const bitrateFlag = args.indexOf('--bitrate')
const bitrate =
  bitrateFlag !== -1 && args[bitrateFlag + 1]
    ? args[bitrateFlag + 1]
    : process.env.MUSIC_OPUS_BITRATE || '112k'
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--bitrate')

const contentRoot = process.env.KINGTIDE_CONTENT_ROOT || 'C:/project-content/hoverbike'
const srcDir =
  positional[0] || process.env.KINGTIDE_MUSIC_SRC || join(contentRoot, 'audio', 'music')
const outDir = join(repoRoot, 'public', 'audio', 'music')
const manifestPath = join(repoRoot, 'src', 'engine', 'audio', 'soundtrack.generated.ts')

/** EBU R128 target for the two-pass loudness normalization: -14 LUFS
 *  integrated (the streaming-platform standard), -1.5 dBTP ceiling,
 *  LRA 11. Every track lands at the same perceived level, so the
 *  runtime's music-bus headroom + duck depths finally mean one thing. */
const LOUDNORM_TARGET = 'loudnorm=I=-14:TP=-1.5:LRA=11'

/** Pull the measured-values JSON block out of ffmpeg's loudnorm
 *  stderr (pass 1 prints it as the last {...} in the stream). Returns
 *  null when the block can't be found/parsed — caller falls back to
 *  single-pass (dynamic) mode with a warning. */
function parseLoudnormJson(stderr) {
  const start = stderr.lastIndexOf('{')
  const end = stderr.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    const parsed = JSON.parse(stderr.slice(start, end + 1))
    if (
      typeof parsed.input_i === 'string' &&
      typeof parsed.input_tp === 'string' &&
      typeof parsed.input_lra === 'string' &&
      typeof parsed.input_thresh === 'string' &&
      typeof parsed.target_offset === 'string'
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/** Locate an ffmpeg binary: explicit env → PATH → winget install glob. */
function resolveFfmpeg() {
  const candidates = []
  if (process.env.FFMPEG_EXE) candidates.push(process.env.FFMPEG_EXE)
  candidates.push('ffmpeg')
  // winget (Gyan.FFmpeg) drops a versioned folder here; the running shell
  // won't have the freshly-added PATH entry, so glob it as a fallback.
  const wingetBase = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages')
  if (existsSync(wingetBase)) {
    for (const pkg of readdirSync(wingetBase)) {
      if (!/ffmpeg/i.test(pkg)) continue
      const pkgDir = join(wingetBase, pkg)
      for (const build of readdirSync(pkgDir)) {
        const exe = join(pkgDir, build, 'bin', 'ffmpeg.exe')
        if (existsSync(exe)) candidates.push(exe)
      }
    }
  }
  for (const c of candidates) {
    const r = spawnSync(c, ['-version'], { stdio: 'ignore' })
    if (!r.error && r.status === 0) return c
  }
  return null
}

/** `<artist> - <title>.mp3` → { artist, title }. Tolerant of the
 *  `.mp3.mp3` double-extension and `_phrase_` filesystem substitutions. */
function parseName(filename) {
  const base = filename.replace(/(\.mp3)+$/i, '')
  const sep = base.indexOf(' - ')
  let artist = 'Unknown Artist'
  let title = base
  if (sep !== -1) {
    artist = base.slice(0, sep)
    title = base.slice(sep + 3)
  }
  const tidy = (s) =>
    s
      .replace(/_([^_]+)_/g, '($1)') // _Sandy Shores_ → (Sandy Shores)
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  return { artist: tidy(artist), title: tidy(title) }
}

function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents
    .replace(/['’`]/g, '') // drop apostrophes so "there's" → "theres"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function fmtBytes(n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`
}

// ---- run -------------------------------------------------------------------

const ffmpeg = resolveFfmpeg()
if (!ffmpeg) {
  console.error(
    '[music] ffmpeg not found. Install it (`winget install Gyan.FFmpeg`) or set FFMPEG_EXE.',
  )
  process.exit(1)
}
if (!existsSync(srcDir)) {
  console.error(`[music] source dir not found: ${srcDir}`)
  console.error('        Set KINGTIDE_MUSIC_SRC or pass the dir as the first argument.')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const mp3s = readdirSync(srcDir)
  .filter((f) => /\.mp3$/i.test(f))
  .sort((a, b) => a.localeCompare(b))

if (mp3s.length === 0) {
  console.error(`[music] no .mp3 files in ${srcDir}`)
  process.exit(1)
}

// License sidecar — lives next to the mp3s so provenance travels with them.
const creditsPath = join(srcDir, 'credits.json')
/** @type {Record<string, {license?: string, licenseUrl?: string, sourceUrl?: string}>} */
let credits = {}
if (existsSync(creditsPath)) {
  credits = JSON.parse(readFileSync(creditsPath, 'utf8'))
} else {
  console.warn(`[music] WARNING: no credits.json beside the mp3s (${creditsPath})`)
  console.warn('        every track will be emitted license:"UNVERIFIED" — fix before shipping.')
}

// Optional scene assignment. `playlists.json` (hand-authored, next to the
// .mp3s in the content dir) maps source filenames to scenes:
//
//   { "menu": ["Artist - Song.mp3", …],
//     "levels": { "<trackId>": ["Artist - Song.mp3", …] } }
//
// We bake the result into each manifest entry's `scenes` (['menu'] /
// ['level:<trackId>']). A song listed nowhere stays in the default pool.
// Absent file ⇒ no scoping (full shuffle everywhere — the prior behaviour).
const playlistsPath = join(srcDir, 'playlists.json')
let playlists = { menu: [], levels: {} }
if (existsSync(playlistsPath)) {
  try {
    const parsed = JSON.parse(readFileSync(playlistsPath, 'utf8'))
    playlists = {
      menu: Array.isArray(parsed.menu) ? parsed.menu : [],
      levels: parsed.levels && typeof parsed.levels === 'object' ? parsed.levels : {},
    }
  } catch (e) {
    console.error(`[music] failed to parse ${playlistsPath}: ${e.message}`)
    process.exit(1)
  }
  // Warn on references that don't match a source file — almost always a typo.
  const mp3set = new Set(mp3s)
  const referenced = [...playlists.menu, ...Object.values(playlists.levels).flat()]
  for (const ref of referenced) {
    if (!mp3set.has(ref)) console.warn(`[music] playlists.json references unknown file: "${ref}"`)
  }
}

/** Scene tags for a source filename, from playlists.json. */
function scenesFor(filename) {
  const tags = []
  if (playlists.menu.includes(filename)) tags.push('menu')
  for (const [levelId, files] of Object.entries(playlists.levels)) {
    if (Array.isArray(files) && files.includes(filename)) tags.push(`level:${levelId}`)
  }
  return tags
}

console.log(`[music] ffmpeg: ${ffmpeg}`)
console.log(`[music] ${mp3s.length} source track(s) in ${srcDir}`)
if (existsSync(playlistsPath)) console.log('[music] scene assignment: playlists.json')
console.log(`[music] encoding Opus @ ${bitrate} VBR → ${outDir}\n`)

const entries = []
let srcTotal = 0
let outTotal = 0
const seenSlugs = new Set()

for (const file of mp3s) {
  const { artist, title } = parseName(file)
  let slug = slugify(`${artist}-${title}`)
  // Guard against slug collisions (different titles that normalise alike).
  let unique = slug
  let n = 2
  while (seenSlugs.has(unique)) unique = `${slug}-${n++}`
  slug = unique
  seenSlugs.add(slug)

  const inPath = join(srcDir, file)
  const outName = `${slug}.opus`
  const outPath = join(outDir, outName)
  srcTotal += statSync(inPath).size

  // Freshness includes THIS SCRIPT's mtime: an output older than the
  // pipeline that produces it is stale even when it post-dates its
  // source mp3. Without this, a clone that converted before a pipeline
  // change (e.g. the loudnorm addition) reports every track "(up to
  // date)" forever, and a later partial run ships a mixed-processing
  // set while the logs claim uniformity.
  const pipelineMtime = statSync(fileURLToPath(import.meta.url)).mtimeMs
  const fresh =
    !force &&
    existsSync(outPath) &&
    statSync(outPath).mtimeMs >= Math.max(statSync(inPath).mtimeMs, pipelineMtime)
  if (fresh) {
    outTotal += statSync(outPath).size
    console.log(`  • ${outName}  (up to date)`)
  } else {
    // Two-pass EBU R128 loudness normalization (evaluation audio #1):
    // fourteen tracks from ten FMA artists arrive at wildly different
    // masters, so without this players ride the volume slider between
    // songs and the engine's fixed music-bus headroom + duck depths
    // mean something different under every track. Pass 1 measures;
    // pass 2 applies the measured values (linear mode) targeting
    // -14 LUFS integrated / -1.5 dBTP — the streaming-standard level.
    const measure = spawnSync(
      ffmpeg,
      ['-i', inPath, '-vn', '-af', `${LOUDNORM_TARGET}:print_format=json`, '-f', 'null', '-'],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
    )
    let loudnormFilter = LOUDNORM_TARGET
    let loudnormMode = 'single-pass dynamic'
    const measured = parseLoudnormJson(measure.stderr ?? '')
    // Guard the measured values: silent/near-silent sources measure
    // "-inf", which ffmpeg rejects as a measured_I (range −99..0) and
    // would hard-fail pass 2 on input the plain transcode handled fine.
    // Non-finite (or missing) measurements fall back to single-pass
    // dynamic mode — still normalized, different algorithm, and the
    // log says so instead of claiming two-pass uniformity.
    const finite =
      measured &&
      [
        measured.input_i,
        measured.input_tp,
        measured.input_lra,
        measured.input_thresh,
        measured.target_offset,
      ].every((v) => Number.isFinite(Number.parseFloat(v)))
    if (measure.status === 0 && measured && finite) {
      loudnormFilter =
        `${LOUDNORM_TARGET}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:` +
        `measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:` +
        `offset=${measured.target_offset}:linear=true`
      loudnormMode = 'two-pass linear'
    } else {
      console.warn(
        `  ! loudnorm measure pass ${measure.status === 0 ? 'returned unusable values' : 'failed'} ` +
          `for "${file}" — using single-pass dynamic mode`,
      )
    }
    const r = spawnSync(
      ffmpeg,
      [
        '-y',
        '-i',
        inPath,
        '-vn', // drop embedded cover art
        '-map_metadata',
        '-1', // strip ID3 — manifest owns the credits
        '-af',
        loudnormFilter,
        '-c:a',
        'libopus',
        '-b:a',
        bitrate,
        '-vbr',
        'on',
        '-application',
        'audio',
        '-ar',
        '48000', // Opus' native rate (loudnorm upsamples to 192k internally; -ar wins on output)
        outPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
    )
    if (r.status !== 0) {
      console.error(`\n[music] ffmpeg failed on "${file}":\n${r.stderr}`)
      process.exit(1)
    }
    const outSize = statSync(outPath).size
    outTotal += outSize
    console.log(`  ✓ ${outName}  (${fmtBytes(outSize)}, -14 LUFS ${loudnormMode})`)
  }

  const meta = credits[file]
  if (!meta?.license) {
    console.warn(`  ! no credits.json entry for "${file}" — license marked UNVERIFIED`)
  }
  entries.push({
    file: outName,
    artist,
    title,
    license: meta?.license ?? 'UNVERIFIED',
    licenseUrl: meta?.licenseUrl ?? '',
    sourceUrl: meta?.sourceUrl ?? '',
    scenes: scenesFor(file),
  })
}

const unverified = entries.filter((e) => e.license === 'UNVERIFIED').length
if (unverified > 0) {
  console.warn(`[music] WARNING: ${unverified} track(s) have no verified license — see above.`)
}

// ---- manifest --------------------------------------------------------------

const lines = entries
  .map((e) => {
    const j = (s) => JSON.stringify(s)
    return [
      '  {',
      `    file: ${j(e.file)},`,
      `    artist: ${j(e.artist)},`,
      `    title: ${j(e.title)},`,
      `    license: ${j(e.license)},`,
      `    licenseUrl: ${j(e.licenseUrl)},`,
      `    sourceUrl: ${j(e.sourceUrl)},`,
      // Omit the key entirely when unscoped — `scenes?: string[]` treats
      // absent and empty alike, and this keeps the common case one line
      // shorter in a generated file people do read.
      ...(e.scenes.length > 0 ? [`    scenes: ${j(e.scenes)},`] : []),
      '  },',
    ].join('\n')
  })
  .join('\n')

const manifest = `// AUTO-GENERATED by tools/convert-music.mjs — do not edit by hand.
// Regenerate with: pnpm gen:music
//
// Source: ${mp3s.length} Creative-Commons track(s), transcoded to Opus @ ${bitrate} VBR.
// Artist/title parsed from the "<artist> - <title>.mp3" source filenames;
// license + source URL merged from the credits.json sidecar next to them;
// scene tags from the playlists.json sidecar (absent ⇒ default pool).

import type { SoundtrackEntry } from './soundtrack'

export const SOUNDTRACK: readonly SoundtrackEntry[] = [
${lines}
]
`

writeFileSync(manifestPath, manifest, 'utf8')

console.log(
  `\n[music] done — ${entries.length} tracks, ${fmtBytes(srcTotal)} mp3 → ${fmtBytes(outTotal)} opus`,
)
console.log(`[music] manifest → ${manifestPath}`)
