/**
 * Pure helpers used during boot / end-of-race that don't need any
 * runtime state. Extracted from `main.ts` so the orchestrator stays
 * focused on the eight boot phases.
 */

import { type ReplayFile, serializeReplay } from '@/engine/replay/format'
import type { Track } from '@/game/tracks/types'

/**
 * Trigger a browser download of a serialized replay file. Filename
 * embeds the track id + a short timestamp so multiple saves from the
 * same browser don't overwrite each other.
 */
export function downloadReplay(replay: ReplayFile): void {
  const text = serializeReplay(replay)
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const stamp = new Date(replay.meta.recordedAt).toISOString().replace(/[:.]/g, '-')
  const a = document.createElement('a')
  a.href = url
  a.download = `hoverbike-${replay.meta.trackId}-${stamp}.replay`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Empty starter track used when the editor is opened on an id that
 * has neither a JSON nor a GLB. The user authors the layout from
 * scratch and the first Save materialises `public/tracks/<id>.json`.
 *
 * Two seed checkpoints + four seed spline anchors so the editor's
 * loader (which validates non-empty arrays) and the runtime-derived
 * spline-bound gates have something to work with.
 */
export function emptyDraftTrack(id: string): Track {
  return {
    id,
    name: id,
    lapsToFinish: 3,
    start: { position: { x: 0, y: 0.5, z: 0 }, yaw: 0 },
    checkpoints: [
      {
        index: 0,
        position: { x: 0, y: 1.5, z: 20 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 8,
        height: 4,
      },
      {
        index: 1,
        position: { x: 0, y: 1.5, z: -20 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 8,
        height: 4,
      },
    ],
    aiSplines: [
      {
        id: 'main',
        points: [
          { x: 0, y: 0.5, z: 20 },
          { x: 20, y: 0.5, z: 0 },
          { x: 0, y: 0.5, z: -20 },
          { x: -20, y: 0.5, z: 0 },
        ],
        anchors: [
          { x: 0, y: 0.5, z: 20 },
          { x: 20, y: 0.5, z: 0 },
          { x: 0, y: 0.5, z: -20 },
          { x: -20, y: 0.5, z: 0 },
        ],
      },
    ],
    pickupSpawns: [],
    boostPads: [],
    props: [],
    surfaces: [],
  }
}

/** "1" → "1st", "22" → "22nd", "13" → "13th", etc. */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

/** Format a duration in seconds as "M:SS.SS" or "S.SSs" if under 1 minute. */
export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return m > 0 ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${s.toFixed(2)}s`
}
