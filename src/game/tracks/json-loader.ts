import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import type { AISpline, BoostPad, Checkpoint, Track, WaterConfig } from './types'

/**
 * JSON track loader. The new (and preferred) authoring format:
 *
 *   tracks-src/<id>.json    ← gameplay data (gates, spline, pickups, pads,
 *                              start, water tuning, optional environmentGlb)
 *   public/assets/tracks/<id>.glb   ← optional Blender-authored geometry
 *
 * The in-app editor reads + writes the JSON. Blender writes the .glb. This
 * file is the bridge from a fetched JSON document to a runtime {@link Track}.
 *
 * Three-free per the architecture rule (sim layer must not import Three).
 *
 * The shape on disk mirrors {@link Track} closely so authors can hand-edit
 * if needed. Validation is strict — every required field must be present
 * and well-typed; unknown fields are ignored (forward-compat).
 */

export type TrackJson = {
  id: string
  name: string
  lapsToFinish: number
  start: { position: Vec3; yaw: number }
  checkpoints: Checkpoint[]
  aiSplines: AISpline[]
  pickupSpawns: Vec3[]
  boostPads?: BoostPad[]
  environmentGlb?: string
  water?: WaterConfig
}

export async function loadTrackFromJson(url: string): Promise<Track> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`track-json: fetch ${url} failed: ${res.status} ${res.statusText}`)
  }
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`track-json: ${url} invalid JSON: ${(e as Error).message}`)
  }
  return buildTrackFromJson(parsed)
}

/** Validate + coerce. Throws with a clear message on the first violation. */
export function buildTrackFromJson(input: unknown): Track {
  if (!isObject(input)) throw new Error('track-json: root must be an object')

  const id = requireString(input, 'id')
  const name = requireString(input, 'name')
  const lapsToFinish = requireNumber(input, 'lapsToFinish')
  if (!Number.isInteger(lapsToFinish) || lapsToFinish < 1) {
    throw new Error(`track-json: lapsToFinish must be a positive integer (got ${lapsToFinish})`)
  }

  const startRaw = requireField(input, 'start')
  if (!isObject(startRaw)) throw new Error('track-json: start must be an object')
  const start = {
    position: readVec3(startRaw.position, 'start.position'),
    yaw: requireNumber(startRaw, 'yaw'),
  }

  const checkpointsRaw = requireField(input, 'checkpoints')
  if (!Array.isArray(checkpointsRaw) || checkpointsRaw.length === 0) {
    throw new Error('track-json: checkpoints must be a non-empty array')
  }
  const checkpoints: Checkpoint[] = checkpointsRaw.map((cp, i) => readCheckpoint(cp, i))
  for (let i = 0; i < checkpoints.length; i++) {
    if (checkpoints[i]!.index !== i) {
      throw new Error(
        `track-json: checkpoints[${i}].index = ${checkpoints[i]!.index} (must equal array position)`,
      )
    }
  }

  const aiSplinesRaw = requireField(input, 'aiSplines')
  if (!Array.isArray(aiSplinesRaw) || aiSplinesRaw.length === 0) {
    throw new Error('track-json: aiSplines must be a non-empty array')
  }
  const aiSplines: AISpline[] = aiSplinesRaw.map((s, i) => readSpline(s, i))
  if (!aiSplines.some((s) => s.id === 'main')) {
    throw new Error('track-json: missing aiSplines entry with id="main"')
  }

  const pickupSpawnsRaw = (input as { pickupSpawns?: unknown }).pickupSpawns ?? []
  if (!Array.isArray(pickupSpawnsRaw)) {
    throw new Error('track-json: pickupSpawns must be an array if present')
  }
  const pickupSpawns: Vec3[] = pickupSpawnsRaw.map((p, i) => readVec3(p, `pickupSpawns[${i}]`))

  const boostPadsRaw = (input as { boostPads?: unknown }).boostPads ?? []
  if (!Array.isArray(boostPadsRaw)) {
    throw new Error('track-json: boostPads must be an array if present')
  }
  const boostPads: BoostPad[] = boostPadsRaw.map((p, i) => readBoostPad(p, i))

  const water = readOptionalWater((input as { water?: unknown }).water)
  const environmentGlb = (input as { environmentGlb?: unknown }).environmentGlb
  if (environmentGlb !== undefined && typeof environmentGlb !== 'string') {
    throw new Error('track-json: environmentGlb must be a string if present')
  }

  const track: Track = {
    id,
    name,
    lapsToFinish,
    start,
    checkpoints,
    aiSplines,
    pickupSpawns,
    boostPads,
    surfaces: [],
  }
  if (environmentGlb) track.environmentGlb = environmentGlb
  if (water) track.water = water
  return track
}

/**
 * Inverse: serialise a Track back to the JSON shape so the editor can save
 * the user's edits. Only the fields the JSON format owns are written;
 * runtime-derived `surfaces` is dropped.
 */
export function trackToJson(track: Track): TrackJson {
  const out: TrackJson = {
    id: track.id,
    name: track.name,
    lapsToFinish: track.lapsToFinish,
    start: { position: { ...track.start.position }, yaw: track.start.yaw },
    checkpoints: track.checkpoints.map((cp) => ({
      index: cp.index,
      position: { ...cp.position },
      rotation: { ...cp.rotation },
      halfWidth: cp.halfWidth,
      height: cp.height,
    })),
    aiSplines: track.aiSplines.map((s) => ({
      id: s.id,
      points: s.points.map((p) => ({ ...p })),
    })),
    pickupSpawns: track.pickupSpawns.map((p) => ({ ...p })),
    boostPads: track.boostPads.map((p) => ({
      position: { ...p.position },
      rotation: { ...p.rotation },
      halfWidth: p.halfWidth,
      halfDepth: p.halfDepth,
      strength: p.strength,
    })),
  }
  if (track.environmentGlb) out.environmentGlb = track.environmentGlb
  if (track.water) out.water = { ...track.water }
  return out
}

function readCheckpoint(raw: unknown, i: number): Checkpoint {
  if (!isObject(raw)) throw new Error(`track-json: checkpoints[${i}] must be an object`)
  const index = requireNumber(raw, 'index')
  const position = readVec3(raw.position, `checkpoints[${i}].position`)
  const rotation = readQuat(raw.rotation, `checkpoints[${i}].rotation`)
  const halfWidth = requireNumber(raw, 'halfWidth')
  const height = requireNumber(raw, 'height')
  if (halfWidth <= 0 || height <= 0) {
    throw new Error(`track-json: checkpoints[${i}] halfWidth/height must be positive`)
  }
  return { index, position, rotation, halfWidth, height }
}

function readSpline(raw: unknown, i: number): AISpline {
  if (!isObject(raw)) throw new Error(`track-json: aiSplines[${i}] must be an object`)
  const id = requireString(raw, 'id')
  const pts = (raw as { points?: unknown }).points
  if (!Array.isArray(pts) || pts.length < 2) {
    throw new Error(`track-json: aiSplines[${i}].points must have at least 2 entries`)
  }
  const points: Vec3[] = pts.map((p, j) => readVec3(p, `aiSplines[${i}].points[${j}]`))
  return { id, points }
}

function readBoostPad(raw: unknown, i: number): BoostPad {
  if (!isObject(raw)) throw new Error(`track-json: boostPads[${i}] must be an object`)
  const position = readVec3(raw.position, `boostPads[${i}].position`)
  const rotation = readQuat(raw.rotation, `boostPads[${i}].rotation`)
  const halfWidth = requireNumber(raw, 'halfWidth')
  const halfDepth = requireNumber(raw, 'halfDepth')
  const strength = requireNumber(raw, 'strength')
  if (halfWidth <= 0 || halfDepth <= 0) {
    throw new Error(`track-json: boostPads[${i}] halfWidth/halfDepth must be positive`)
  }
  return { position, rotation, halfWidth, halfDepth, strength }
}

function readOptionalWater(raw: unknown): WaterConfig | null {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw)) throw new Error('track-json: water must be an object if present')
  return {
    height: requireNumber(raw, 'height'),
    waveHeight: requireNumber(raw, 'waveHeight'),
    waveFreq: requireNumber(raw, 'waveFreq'),
  }
}

function readVec3(raw: unknown, ctx: string): Vec3 {
  if (!isObject(raw)) throw new Error(`track-json: ${ctx} must be an object {x,y,z}`)
  return {
    x: requireNumber(raw, 'x', ctx),
    y: requireNumber(raw, 'y', ctx),
    z: requireNumber(raw, 'z', ctx),
  }
}

function readQuat(raw: unknown, ctx: string): Quat {
  if (!isObject(raw)) throw new Error(`track-json: ${ctx} must be an object {x,y,z,w}`)
  return {
    x: requireNumber(raw, 'x', ctx),
    y: requireNumber(raw, 'y', ctx),
    z: requireNumber(raw, 'z', ctx),
    w: requireNumber(raw, 'w', ctx),
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function requireField(obj: Record<string, unknown>, key: string): unknown {
  if (!(key in obj)) throw new Error(`track-json: missing required field "${key}"`)
  return obj[key]
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = requireField(obj, key)
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`track-json: "${key}" must be a non-empty string`)
  }
  return v
}

function requireNumber(obj: Record<string, unknown>, key: string, ctx?: string): number {
  const v = requireField(obj, key)
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`track-json: ${ctx ? `${ctx}.` : ''}${key} must be a finite number`)
  }
  return v
}
