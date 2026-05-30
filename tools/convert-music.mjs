#!/usr/bin/env node
/**
 * Soundtrack build step — transcode the licensed `.mp3` source tracks
 * into streaming-friendly Opus and regenerate the runtime manifest.
 *
 * Mirrors the `gen:*` Blender pipeline shape: raw authoring sources live
 * out of git (the Google-Drive content folder, see docs/asset-storage.md);
 * the compiled exports land under `public/audio/music/*.opus` (tracked via
 * Git LFS) and a generated TS manifest captures the artist/title metadata
 * parsed from each filename.
 *
 *   Source files are named `<artist> - <title>.mp3` (the convention the
 *   credit toast keys off). This script splits on the first " - ",
 *   normalises a few filesystem-safe substitutions (`_phrase_` → `(phrase)`),
 *   slugs `<artist>-<title>` for the output filename, and writes:
 *
 *     public/audio/music/<slug>.opus           — streamed at runtime
 *     src/engine/audio/soundtrack.generated.ts  — { file, artist, title }[]
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
 *   HOVERBIKE_MUSIC_SRC     source dir of .mp3s (else <content>/audio/music)
 *   HOVERBIKE_CONTENT_ROOT  content root (default C:/project-content/hoverbike)
 *   FFMPEG_EXE              explicit ffmpeg path (else PATH, else winget glob)
 *   MUSIC_OPUS_BITRATE      target bitrate (default 112k)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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

const contentRoot = process.env.HOVERBIKE_CONTENT_ROOT || 'C:/project-content/hoverbike'
const srcDir =
  positional[0] || process.env.HOVERBIKE_MUSIC_SRC || join(contentRoot, 'audio', 'music')
const outDir = join(repoRoot, 'public', 'audio', 'music')
const manifestPath = join(repoRoot, 'src', 'engine', 'audio', 'soundtrack.generated.ts')

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
  console.error('        Set HOVERBIKE_MUSIC_SRC or pass the dir as the first argument.')
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

console.log(`[music] ffmpeg: ${ffmpeg}`)
console.log(`[music] ${mp3s.length} source track(s) in ${srcDir}`)
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

  const fresh =
    !force && existsSync(outPath) && statSync(outPath).mtimeMs >= statSync(inPath).mtimeMs
  if (fresh) {
    outTotal += statSync(outPath).size
    console.log(`  • ${outName}  (up to date)`)
  } else {
    const r = spawnSync(
      ffmpeg,
      [
        '-y',
        '-i',
        inPath,
        '-vn', // drop embedded cover art
        '-map_metadata',
        '-1', // strip ID3 — manifest owns the credits
        '-c:a',
        'libopus',
        '-b:a',
        bitrate,
        '-vbr',
        'on',
        '-application',
        'audio',
        '-ar',
        '48000', // Opus' native rate
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
    console.log(`  ✓ ${outName}  (${fmtBytes(outSize)})`)
  }

  entries.push({ file: outName, artist, title })
}

// ---- manifest --------------------------------------------------------------

const lines = entries
  .map((e) => {
    const j = (s) => JSON.stringify(s)
    return `  { file: ${j(e.file)}, artist: ${j(e.artist)}, title: ${j(e.title)} },`
  })
  .join('\n')

const manifest = `// AUTO-GENERATED by tools/convert-music.mjs — do not edit by hand.
// Regenerate with: pnpm gen:music
//
// Source: ${mp3s.length} licensed track(s), transcoded to Opus @ ${bitrate} VBR.
// Credits are parsed from the "<artist> - <title>.mp3" source filenames.

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
