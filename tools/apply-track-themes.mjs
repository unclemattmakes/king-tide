#!/usr/bin/env node
/**
 * Apply themed terrainShader + sky deltas to the 12 ship tracks.
 *
 * The asset-pipeline seeds emit identical default palettes for every track
 * (pathTint = packed-dirt brown, saturation = 1.05, cloudiness clustered
 * around 0.4) — readable in isolation, mushy when you compare them
 * side-by-side. This script bakes a per-track delta on top of the seed
 * defaults so each track reads as its location's palette per
 * docs/track-themes.md without re-running the seed pipeline.
 *
 * Run: `node tools/apply-track-themes.mjs`
 */

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const TRACKS_DIR = path.resolve(__dirname, '..', 'public', 'tracks')

/**
 * Per-track theme deltas. Keys are merged into the track JSON at the
 * matching paths; unset keys leave the seed default in place.
 *
 * pathTint values are linear-RGB in [0, 1]. Numbers are reference, not
 * pixel-matched — the in-game look pipes through the sky tint + grade.
 */
const THEMES = {
  sandbar: {
    sky: { cloudiness: 0.15 },
    terrainShader: {
      pathTint: [0.62, 0.5, 0.34],
      saturation: 1.0,
      wetBand: 2.0,
    },
  },
  'south-beach-sunken': {
    sky: { cloudiness: 0.18, colorGrade: 'miami_pastel', seaStateBeaufort: 2 },
    terrainShader: {
      pathTint: [0.82, 0.72, 0.7],
      saturation: 1.1,
      wetBand: 2.5,
    },
  },
  'hatteras-light': {
    sky: { cloudiness: 0.82, seaStateBeaufort: 5, sunIntensity: 0.82 },
    terrainShader: {
      pathTint: [0.32, 0.3, 0.28],
      saturation: 0.85,
      wetBand: 4.0,
    },
  },
  'cape-town-drift': {
    sky: { cloudiness: 0.3, colorGrade: 'cape_town_blue', seaStateBeaufort: 4 },
    terrainShader: {
      pathTint: [0.46, 0.34, 0.24],
      saturation: 1.0,
      wetBand: 2.5,
    },
  },
  'the-maw': {
    sky: { cloudiness: 0.7, colorGrade: 'big_sur_golden', seaStateBeaufort: 5 },
    terrainShader: {
      pathTint: [0.5, 0.4, 0.28],
      saturation: 1.1,
      wetBand: 3.0,
    },
  },
  'shibuya-submerged': {
    sky: { cloudiness: 0.45, colorGrade: 'tokyo_neon', seaStateBeaufort: 3 },
    terrainShader: {
      pathTint: [0.18, 0.15, 0.16],
      saturation: 1.25,
      wetBand: 2.5,
    },
  },
  'kilauea-crown': {
    sky: { cloudiness: 0.18, colorGrade: 'kilauea_volcanic', seaStateBeaufort: 3 },
    terrainShader: {
      pathTint: [0.1, 0.09, 0.08],
      saturation: 1.15,
      wetBand: 1.4,
    },
  },
  'marina-bay-7': {
    sky: { cloudiness: 0.62, seaStateBeaufort: 2, sunIntensity: 0.92 },
    terrainShader: {
      pathTint: [0.36, 0.2, 0.14],
      saturation: 0.95,
      wetBand: 3.5,
    },
  },
  'doges-drift': {
    sky: { cloudiness: 0.28, colorGrade: 'venice_warm', seaStateBeaufort: 3 },
    terrainShader: {
      pathTint: [0.55, 0.4, 0.24],
      saturation: 0.95,
      wetBand: 2.5,
    },
  },
  aqualand: {
    sky: { cloudiness: 0.25, seaStateBeaufort: 3 },
    terrainShader: {
      pathTint: [0.45, 0.5, 0.32],
      saturation: 1.0,
      wetBand: 2.0,
    },
  },
  'angkor-drowned': {
    sky: { cloudiness: 0.55, seaStateBeaufort: 2 },
    terrainShader: {
      pathTint: [0.3, 0.32, 0.2],
      saturation: 0.9,
      wetBand: 3.0,
    },
  },
  'liberty-drowned': {
    sky: { cloudiness: 0.55, colorGrade: 'nyc_sunset', seaStateBeaufort: 4 },
    terrainShader: {
      pathTint: [0.32, 0.45, 0.4],
      saturation: 1.1,
      wetBand: 3.0,
    },
  },
}

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {}
      deepMerge(target[k], v)
    } else {
      target[k] = v
    }
  }
}

const summary = []
for (const [id, theme] of Object.entries(THEMES)) {
  const file = path.join(TRACKS_DIR, `${id}.json`)
  if (!fs.existsSync(file)) {
    console.warn(`[apply-track-themes] missing track ${id} at ${file}`)
    continue
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  deepMerge(json, theme)
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
  summary.push({
    id,
    pathTint: theme.terrainShader?.pathTint?.map((v) => v.toFixed(2)).join(','),
    sat: theme.terrainShader?.saturation,
    cloud: theme.sky?.cloudiness,
    beaufort: theme.sky?.seaStateBeaufort,
    grade: theme.sky?.colorGrade,
  })
}

console.table(summary)
