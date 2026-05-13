/**
 * Track-editor save flow.
 *
 * POSTs the draft as JSON to the dev-only `/__editor/save-track` endpoint,
 * which writes `public/tracks/<id>.json`. Status messages flow back through
 * the caller-supplied `setStatus` so the editor panel can render them.
 *
 * Extracted from `track-editor.ts` so the orchestrator stays focused on
 * gizmo + state wiring.
 */

import { trackToJson } from '@/game/tracks/json-loader'
import type { Track } from '@/game/tracks/types'

export type SaveTrackOptions = {
  draft: Track
  setStatus: (msg: string, color?: string) => void
  /** Called after a successful save so the undo stack can mark the
   *  current depth as the "clean" baseline. */
  onSaved: () => void
}

export async function saveTrack(opts: SaveTrackOptions): Promise<void> {
  const { draft, setStatus, onSaved } = opts
  setStatus('Saving…', '#7a8')
  try {
    const res = await fetch('/__editor/save-track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: draft.id, json: trackToJson(draft) }),
    })
    if (!res.ok) {
      const txt = await res.text()
      throw new Error(`${res.status}: ${txt}`)
    }
    const body = (await res.json()) as { path?: string }
    onSaved()
    setStatus(`Saved → ${body.path ?? 'public/tracks/'}`, '#7a8')
  } catch (e) {
    setStatus(`Save failed: ${(e as Error).message}`, '#f88')
  }
}
