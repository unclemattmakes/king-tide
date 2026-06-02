import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import { asSurfaceType } from '@/engine/sim/surface-types'
import { pointAtT, sampleCatmullRom, sampleScalarToMatch, tangentAtT } from './catmull-rom'
import {
  type AISpline,
  type AntiGravZone,
  type AudioConfig,
  type BoostPad,
  type Checkpoint,
  type HorizonConfig,
  type LapWeather,
  type Prop,
  type PropType,
  type RoadSpline,
  SKY_COLOR_GRADES,
  SKY_TONE_MAPPINGS,
  type SkyColorGrade,
  type SkyConfig,
  type SkyToneMapping,
  type TerrainShaderConfig,
  type Track,
  type WaterConfig,
  type WaveZone,
} from './types'

const PROP_TYPES: readonly PropType[] = ['box', 'sphere', 'cylinder', 'pipe', 'halfpipe', 'asset']

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
  start: { position: Vec3; yaw: number; splineT?: number }
  checkpoints: Checkpoint[]
  aiSplines: AISpline[]
  roadSpline?: RoadSpline
  pickupSpawns: Vec3[]
  boostPads?: BoostPad[]
  antiGravZones?: AntiGravZone[]
  waveZones?: WaveZone[]
  props?: Prop[]
  environmentGlb?: string
  water?: WaterConfig
  sky?: SkyConfig
  horizon?: HorizonConfig
  gateSpacing?: number
  terrainShader?: TerrainShaderConfig
  audio?: AudioConfig
  lapWeather?: LapWeather[]
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
  const startSplineTRaw = (startRaw as { splineT?: unknown }).splineT
  const startHasSplineT = typeof startSplineTRaw === 'number' && Number.isFinite(startSplineTRaw)
  const start: Track['start'] = {
    position: readVec3(startRaw.position, 'start.position'),
    yaw: requireNumber(startRaw, 'yaw'),
  }
  if (startHasSplineT) {
    start.splineT = (((startSplineTRaw as number) % 1) + 1) % 1
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

  const roadSpline = readOptionalRoadSpline((input as { roadSpline?: unknown }).roadSpline)

  // Spline-bound gates derive position + rotation from the main spline at
  // their `splineT`. Done after both arrays have been parsed so we can
  // reach into the resolved sample list. The player start participates in
  // the same binding when `start.splineT` is set — pose is derived from
  // the curve, the JSON's position.y is preserved so authors can lift the
  // start above the curve when needed.
  const main = aiSplines.find((s) => s.id === 'main')
  if (main) {
    for (const cp of checkpoints) {
      if (typeof cp.splineT === 'number') {
        const p = pointAtT(main.points, cp.splineT)
        const tan = tangentAtT(main.points, cp.splineT)
        cp.position = { x: p.x, y: cp.position.y, z: p.z }
        const yaw = Math.atan2(tan.x, tan.z)
        const halfA = yaw / 2
        cp.rotation = { x: 0, y: Math.sin(halfA), z: 0, w: Math.cos(halfA) }
      }
    }
    if (typeof start.splineT === 'number') {
      const p = pointAtT(main.points, start.splineT)
      const tan = tangentAtT(main.points, start.splineT)
      start.position = { x: p.x, y: start.position.y, z: p.z }
      start.yaw = Math.atan2(tan.x, tan.z)
    }
  }

  // Legacy auto-correct for cp.rotation: gates exported from Blender before
  // the `_blender_yaw_to_three_yaw` fix (`tools/blender/hoverbike_addon/_
  // legacy.py::derive_track_json`) ship rotated 180° from the racing
  // tangent — race.ts's `signed < 0 → >= 0` crossed-check then never fires
  // and laps don't count. We detect the bug per-gate by asking: does this
  // gate's local +Z point TOWARDS the next checkpoint in the race order?
  // If the dot is negative, the gate is facing backward and we flip it
  // 180° around Y in place.
  //
  // Heuristic vs. "compare to nearest-spline tangent": the spline can be
  // parameterised in either direction relative to race flow (calibration.
  // json's spline goes +Z while the race goes -Z), so spline tangent isn't
  // a reliable source of truth. cp[i] → cp[i+1] always points along the
  // race direction at cp[i] regardless of how the curve was authored.
  //
  // Skipped for cps that already had `splineT` set (those were just
  // rebound above, so their rotation is fresh and correct).
  for (let i = 0; i < checkpoints.length; i++) {
    const cp = checkpoints[i]!
    if (typeof cp.splineT === 'number') continue
    const next = checkpoints[(i + 1) % checkpoints.length]!
    const dx = next.position.x - cp.position.x
    const dz = next.position.z - cp.position.z
    if (dx * dx + dz * dz < 1e-6) continue
    const q = cp.rotation
    // fwd = q · (0,0,1). Closed-form for an arbitrary unit quat:
    //   fwd.x = 2(x·z + w·y), fwd.z = 1 - 2(x² + y²).
    const fwdX = 2 * (q.x * q.z + q.w * q.y)
    const fwdZ = 1 - 2 * (q.x * q.x + q.y * q.y)
    if (fwdX * dx + fwdZ * dz < 0) {
      // q' = q * Ry(π). Ry(π) as quat = (x=0, y=1, z=0, w=0); the
      // Hamilton product collapses to the swap+negate below.
      cp.rotation = { x: -q.z, y: q.w, z: q.x, w: -q.y }
    }
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

  const antiGravRaw = (input as { antiGravZones?: unknown }).antiGravZones ?? []
  if (!Array.isArray(antiGravRaw)) {
    throw new Error('track-json: antiGravZones must be an array if present')
  }
  const antiGravZones: AntiGravZone[] = antiGravRaw.map((z, i) => readAntiGravZone(z, i))

  const waveZonesRaw = (input as { waveZones?: unknown }).waveZones ?? []
  if (!Array.isArray(waveZonesRaw)) {
    throw new Error('track-json: waveZones must be an array if present')
  }
  const waveZones: WaveZone[] = waveZonesRaw.map((z, i) => readWaveZone(z, i))

  const propsRaw = (input as { props?: unknown }).props ?? []
  if (!Array.isArray(propsRaw)) {
    throw new Error('track-json: props must be an array if present')
  }
  const props: Prop[] = propsRaw.map((p, i) => readProp(p, i))

  // Wave-rider buoys — top-level array of {position, rotation} entries
  // emitted by the Blender exporter for every spline-derived buoy.
  // Synthesised here as ordinary asset props (assetId='buoy', unit
  // size) so the rest of the runtime — prop loader, wave-rider
  // spawner, render — needs no awareness of the new field. Replaces
  // the previous kind=track buoy trimesh that shipped inside the GLB.
  const buoysRaw = (input as { waveRiderBuoys?: unknown }).waveRiderBuoys ?? []
  if (!Array.isArray(buoysRaw)) {
    throw new Error('track-json: waveRiderBuoys must be an array if present')
  }
  for (let i = 0; i < buoysRaw.length; i++) {
    const buoy = buoysRaw[i]
    if (buoy === null || typeof buoy !== 'object') {
      throw new Error(`track-json: waveRiderBuoys[${i}] must be an object`)
    }
    const b = buoy as { position?: unknown; rotation?: unknown }
    props.push({
      type: 'asset',
      assetId: 'buoy',
      position: readVec3(b.position, `waveRiderBuoys[${i}].position`),
      rotation: readQuat(b.rotation, `waveRiderBuoys[${i}].rotation`),
      size: { x: 1, y: 1, z: 1 },
    })
  }

  const water = readOptionalWater((input as { water?: unknown }).water)
  const sky = readOptionalSky((input as { sky?: unknown }).sky)
  const horizon = readOptionalHorizon((input as { horizon?: unknown }).horizon)
  const terrainShader = readOptionalTerrainShader(
    (input as { terrainShader?: unknown }).terrainShader,
  )
  const audio = readOptionalAudio((input as { audio?: unknown }).audio)
  const lapWeather = readOptionalLapWeather((input as { lapWeather?: unknown }).lapWeather)
  const environmentGlb = (input as { environmentGlb?: unknown }).environmentGlb
  if (environmentGlb !== undefined && typeof environmentGlb !== 'string') {
    throw new Error('track-json: environmentGlb must be a string if present')
  }
  const gateSpacingRaw = (input as { gateSpacing?: unknown }).gateSpacing
  let gateSpacing: number | undefined
  if (gateSpacingRaw !== undefined) {
    if (typeof gateSpacingRaw !== 'number' || !(gateSpacingRaw > 0)) {
      throw new Error(
        `track-json: gateSpacing must be a positive number if present (got ${String(gateSpacingRaw)})`,
      )
    }
    gateSpacing = gateSpacingRaw
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
    antiGravZones,
    waveZones,
    props,
    surfaces: [],
  }
  if (environmentGlb) track.environmentGlb = environmentGlb
  if (water) track.water = water
  if (sky) track.sky = sky
  if (horizon) track.horizon = horizon
  if (gateSpacing !== undefined) track.gateSpacing = gateSpacing
  if (terrainShader) track.terrainShader = terrainShader
  if (audio) track.audio = audio
  if (lapWeather) track.lapWeather = lapWeather
  if (roadSpline) track.roadSpline = roadSpline
  return track
}

function readOptionalRoadSpline(raw: unknown): RoadSpline | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isObject(raw)) {
    throw new Error('track-json: roadSpline must be an object if present')
  }
  const pointsRaw = (raw as { points?: unknown }).points
  if (!Array.isArray(pointsRaw) || pointsRaw.length < 2) {
    throw new Error('track-json: roadSpline.points must be an array with ≥ 2 entries')
  }
  const points: Vec3[] = pointsRaw.map((p, i) => readVec3(p, `roadSpline.points[${i}]`))
  return { points }
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
    start: (() => {
      const out: TrackJson['start'] = {
        position: { ...track.start.position },
        yaw: track.start.yaw,
      }
      if (typeof track.start.splineT === 'number') out.splineT = track.start.splineT
      return out
    })(),
    checkpoints: track.checkpoints.map((cp) => {
      const out: Checkpoint = {
        index: cp.index,
        position: { ...cp.position },
        rotation: { ...cp.rotation },
        halfWidth: cp.halfWidth,
        height: cp.height,
      }
      if (typeof cp.splineT === 'number') out.splineT = cp.splineT
      return out
    }),
    aiSplines: track.aiSplines.map((s) => {
      // When anchors are present, save anchors only — the loader will
      // resample on next load. We drop the dense `points` to keep the
      // file small and avoid drift between the two representations.
      if (s.anchors && s.anchors.length >= 2) {
        const out: AISpline = {
          id: s.id,
          // The points field is required by the on-disk type; keep an
          // empty array so the JSON validates (loader prefers anchors
          // when present).
          points: [],
          anchors: s.anchors.map((p) => ({ ...p })),
        }
        if (s.anchorBankings) out.anchorBankings = [...s.anchorBankings]
        if (s.antiGrav) out.antiGrav = true
        if (s.antiGravFalloff !== undefined) out.antiGravFalloff = s.antiGravFalloff
        return out
      }
      const out: AISpline = { id: s.id, points: s.points.map((p) => ({ ...p })) }
      if (s.antiGrav) out.antiGrav = true
      if (s.antiGravFalloff !== undefined) out.antiGravFalloff = s.antiGravFalloff
      return out
    }),
    pickupSpawns: track.pickupSpawns.map((p) => ({ ...p })),
    boostPads: track.boostPads.map((p) => ({
      position: { ...p.position },
      rotation: { ...p.rotation },
      halfWidth: p.halfWidth,
      halfHeight: p.halfHeight,
      halfDepth: p.halfDepth,
      strength: p.strength,
    })),
    antiGravZones: track.antiGravZones.map((z) => ({
      position: { ...z.position },
      rotation: { ...z.rotation },
      halfWidth: z.halfWidth,
      halfHeight: z.halfHeight,
      halfDepth: z.halfDepth,
    })),
    waveZones: track.waveZones.map((z) => {
      const out: WaveZone = {
        position: { ...z.position },
        rotation: { ...z.rotation },
        halfWidth: z.halfWidth,
        halfHeight: z.halfHeight,
        halfDepth: z.halfDepth,
        heightMult: z.heightMult,
        freqMult: z.freqMult,
        blendRadiusM: z.blendRadiusM,
      }
      if (z.directionDeg !== undefined) out.directionDeg = z.directionDeg
      if (z.surgePeriodS !== undefined) out.surgePeriodS = z.surgePeriodS
      if (z.surgeAmplitude !== undefined) out.surgeAmplitude = z.surgeAmplitude
      return out
    }),
    props: track.props.map((p) => {
      const out: Prop = {
        type: p.type,
        position: { ...p.position },
        rotation: { ...p.rotation },
        size: { ...p.size },
      }
      if (p.color) out.color = p.color
      if (p.assetId) out.assetId = p.assetId
      if (p.surface) out.surface = p.surface
      return out
    }),
  }
  if (track.environmentGlb) out.environmentGlb = track.environmentGlb
  if (track.water) out.water = { ...track.water }
  if (track.sky) out.sky = { ...track.sky }
  if (track.horizon) out.horizon = { ...track.horizon }
  if (track.gateSpacing !== undefined) out.gateSpacing = track.gateSpacing
  if (track.terrainShader) out.terrainShader = { ...track.terrainShader }
  if (track.audio) {
    const audio: AudioConfig = {}
    if (track.audio.music !== undefined) audio.music = track.audio.music
    if (track.audio.ambient !== undefined) audio.ambient = [...track.audio.ambient]
    if (track.audio.ambientGains !== undefined) audio.ambientGains = [...track.audio.ambientGains]
    if (track.audio.music3dEffects !== undefined) {
      audio.music3dEffects = { ...track.audio.music3dEffects }
    }
    out.audio = audio
  }
  if (track.lapWeather) out.lapWeather = track.lapWeather.map((w) => ({ ...w }))
  if (track.roadSpline) {
    out.roadSpline = { points: track.roadSpline.points.map((p) => ({ ...p })) }
  }
  return out
}

function readCheckpoint(raw: unknown, i: number): Checkpoint {
  if (!isObject(raw)) throw new Error(`track-json: checkpoints[${i}] must be an object`)
  const index = requireNumber(raw, 'index')
  const halfWidth = requireNumber(raw, 'halfWidth')
  const height = requireNumber(raw, 'height')
  if (halfWidth <= 0 || height <= 0) {
    throw new Error(`track-json: checkpoints[${i}] halfWidth/height must be positive`)
  }
  // splineT-bound gates get their position + rotation derived from the
  // main spline; the JSON's stored values are still required so the gate
  // has a sane y when the spline is xz-only. We use the JSON pose as the
  // initial guess and overwrite xz/rotation in the post-pass above.
  const splineTRaw = (raw as { splineT?: unknown }).splineT
  const hasSplineT = typeof splineTRaw === 'number' && Number.isFinite(splineTRaw)
  const position = readVec3(raw.position, `checkpoints[${i}].position`)
  const rotation = readQuat(raw.rotation, `checkpoints[${i}].rotation`)
  const out: Checkpoint = { index, position, rotation, halfWidth, height }
  if (hasSplineT) out.splineT = (((splineTRaw as number) % 1) + 1) % 1
  return out
}

function readSpline(raw: unknown, i: number): AISpline {
  if (!isObject(raw)) throw new Error(`track-json: aiSplines[${i}] must be an object`)
  const id = requireString(raw, 'id')

  // Two source formats:
  //   - `anchors` (preferred): sparse Catmull-Rom control points. The
  //     loader samples them into the dense `points` array the runtime
  //     consumes.
  //   - `points` (legacy): the dense polyline directly.
  const anchorsRaw = (raw as { anchors?: unknown }).anchors
  let anchors: Vec3[] | undefined
  let points: Vec3[]
  if (Array.isArray(anchorsRaw)) {
    if (anchorsRaw.length < 2) {
      throw new Error(`track-json: aiSplines[${i}].anchors must have at least 2 entries`)
    }
    anchors = anchorsRaw.map((p, j) => readVec3(p, `aiSplines[${i}].anchors[${j}]`))
    points = sampleCatmullRom(anchors, { divisionsPerSegment: 12, closed: true })
  } else {
    const pts = (raw as { points?: unknown }).points
    if (!Array.isArray(pts) || pts.length < 2) {
      throw new Error(`track-json: aiSplines[${i}] needs either anchors[≥2] or points[≥2]`)
    }
    points = pts.map((p, j) => readVec3(p, `aiSplines[${i}].points[${j}]`))
  }

  const out: AISpline = { id, points }
  if (anchors) out.anchors = anchors

  const antiGravRaw = (raw as { antiGrav?: unknown }).antiGrav
  if (antiGravRaw !== undefined) {
    if (typeof antiGravRaw !== 'boolean') {
      throw new Error(`track-json: aiSplines[${i}].antiGrav must be a boolean if present`)
    }
    out.antiGrav = antiGravRaw
  }

  const falloffRaw = (raw as { antiGravFalloff?: unknown }).antiGravFalloff
  if (falloffRaw !== undefined) {
    if (typeof falloffRaw !== 'number' || !(falloffRaw > 0)) {
      throw new Error(`track-json: aiSplines[${i}].antiGravFalloff must be a positive number`)
    }
    out.antiGravFalloff = falloffRaw
  }

  // Per-anchor banking → dense bankings array matching `points` length.
  // Only attached when the spline opts into anti-grav (or carries non-zero
  // banking), so tracks that never use anti-grav don't pay the storage.
  const bankingsRaw = (raw as { anchorBankings?: unknown }).anchorBankings
  if (bankingsRaw !== undefined) {
    if (!Array.isArray(bankingsRaw)) {
      throw new Error(`track-json: aiSplines[${i}].anchorBankings must be an array`)
    }
    if (!anchors) {
      throw new Error(`track-json: aiSplines[${i}].anchorBankings requires anchors[]`)
    }
    if (bankingsRaw.length !== anchors.length) {
      throw new Error(
        `track-json: aiSplines[${i}].anchorBankings length (${bankingsRaw.length}) must match anchors length (${anchors.length})`,
      )
    }
    const anchorBankings: number[] = bankingsRaw.map((b, j) => {
      if (typeof b !== 'number' || !Number.isFinite(b)) {
        throw new Error(`track-json: aiSplines[${i}].anchorBankings[${j}] must be a finite number`)
      }
      return b
    })
    const hasAny = anchorBankings.some((b) => b !== 0)
    if (hasAny || out.antiGrav) {
      out.anchorBankings = anchorBankings
      out.bankings = sampleScalarToMatch(anchorBankings, {
        divisionsPerSegment: 12,
        closed: true,
      })
      // Implicit opt-in: any non-zero banking activates the resolver for
      // this spline without requiring an explicit antiGrav: true.
      if (!out.antiGrav && hasAny) out.antiGrav = true
    }
  }

  return out
}

function readBoostPad(raw: unknown, i: number): BoostPad {
  if (!isObject(raw)) throw new Error(`track-json: boostPads[${i}] must be an object`)
  const position = readVec3(raw.position, `boostPads[${i}].position`)
  const rotation = readQuat(raw.rotation, `boostPads[${i}].rotation`)
  const halfWidth = requireNumber(raw, 'halfWidth')
  const halfDepth = requireNumber(raw, 'halfDepth')
  const strength = requireNumber(raw, 'strength')
  // halfHeight is optional for backward compat — pads authored before the
  // 3D-volume rework had no vertical extent (the sim used a hardcoded 3 m
  // band). Default 3 here so existing tracks keep the historic trigger
  // band; new pads authored from Blender / the in-app editor write 4.
  const halfHeightRaw = raw.halfHeight
  const halfHeight = halfHeightRaw === undefined ? 3 : requireNumber(raw, 'halfHeight')
  if (halfWidth <= 0 || halfHeight <= 0 || halfDepth <= 0) {
    throw new Error(`track-json: boostPads[${i}] halfWidth/halfHeight/halfDepth must be positive`)
  }
  return { position, rotation, halfWidth, halfHeight, halfDepth, strength }
}

function readWaveZone(raw: unknown, i: number): WaveZone {
  if (!isObject(raw)) throw new Error(`track-json: waveZones[${i}] must be an object`)
  const position = readVec3(raw.position, `waveZones[${i}].position`)
  const rotation = readQuat(raw.rotation, `waveZones[${i}].rotation`)
  const halfWidth = requireNumber(raw, 'halfWidth')
  const halfHeight = requireNumber(raw, 'halfHeight')
  const halfDepth = requireNumber(raw, 'halfDepth')
  const heightMult = requireNumber(raw, 'heightMult')
  const freqMult = requireNumber(raw, 'freqMult')
  const blendRadiusM = requireNumber(raw, 'blendRadiusM')
  if (halfWidth <= 0 || halfHeight <= 0 || halfDepth <= 0) {
    throw new Error(`track-json: waveZones[${i}] halfWidth/halfHeight/halfDepth must be positive`)
  }
  if (heightMult <= 0) {
    throw new Error(`track-json: waveZones[${i}].heightMult must be positive (got ${heightMult})`)
  }
  if (freqMult <= 0) {
    throw new Error(`track-json: waveZones[${i}].freqMult must be positive (got ${freqMult})`)
  }
  if (blendRadiusM <= 0) {
    throw new Error(
      `track-json: waveZones[${i}].blendRadiusM must be positive (got ${blendRadiusM})`,
    )
  }
  const out: WaveZone = {
    position,
    rotation,
    halfWidth,
    halfHeight,
    halfDepth,
    heightMult,
    freqMult,
    blendRadiusM,
  }
  const dirRaw = (raw as { directionDeg?: unknown }).directionDeg
  if (dirRaw !== undefined) {
    if (typeof dirRaw !== 'number' || !Number.isFinite(dirRaw)) {
      throw new Error(`track-json: waveZones[${i}].directionDeg must be a finite number if present`)
    }
    out.directionDeg = dirRaw
  }
  // Surge fields come as a pair — set both or neither. A partial pair
  // is almost always an authoring mistake (e.g. dropped half of a
  // tsunami spec); fail loud rather than silently surge with 0.
  const periodRaw = (raw as { surgePeriodS?: unknown }).surgePeriodS
  const ampRaw = (raw as { surgeAmplitude?: unknown }).surgeAmplitude
  if (periodRaw !== undefined || ampRaw !== undefined) {
    if (typeof periodRaw !== 'number' || !(periodRaw > 0)) {
      throw new Error(
        `track-json: waveZones[${i}].surgePeriodS must be a positive number when present`,
      )
    }
    if (typeof ampRaw !== 'number' || !Number.isFinite(ampRaw)) {
      throw new Error(
        `track-json: waveZones[${i}].surgeAmplitude must be a finite number when surgePeriodS is set`,
      )
    }
    out.surgePeriodS = periodRaw
    out.surgeAmplitude = ampRaw
  }
  return out
}

function readAntiGravZone(raw: unknown, i: number): AntiGravZone {
  if (!isObject(raw)) throw new Error(`track-json: antiGravZones[${i}] must be an object`)
  const position = readVec3(raw.position, `antiGravZones[${i}].position`)
  const rotation = readQuat(raw.rotation, `antiGravZones[${i}].rotation`)
  const halfWidth = requireNumber(raw, 'halfWidth')
  const halfHeight = requireNumber(raw, 'halfHeight')
  const halfDepth = requireNumber(raw, 'halfDepth')
  if (halfWidth <= 0 || halfHeight <= 0 || halfDepth <= 0) {
    throw new Error(
      `track-json: antiGravZones[${i}] halfWidth/halfHeight/halfDepth must be positive`,
    )
  }
  return { position, rotation, halfWidth, halfHeight, halfDepth }
}

function readProp(raw: unknown, i: number): Prop {
  if (!isObject(raw)) throw new Error(`track-json: props[${i}] must be an object`)
  const typeRaw = raw.type
  if (typeof typeRaw !== 'string' || !PROP_TYPES.includes(typeRaw as PropType)) {
    throw new Error(
      `track-json: props[${i}].type must be one of ${PROP_TYPES.join(', ')} (got ${String(typeRaw)})`,
    )
  }
  const position = readVec3(raw.position, `props[${i}].position`)
  const rotation = readQuat(raw.rotation, `props[${i}].rotation`)
  const size = readVec3(raw.size, `props[${i}].size`)
  const out: Prop = { type: typeRaw as PropType, position, rotation, size }
  const colorRaw = (raw as { color?: unknown }).color
  if (typeof colorRaw === 'string' && colorRaw.length > 0) out.color = colorRaw
  const assetIdRaw = (raw as { assetId?: unknown }).assetId
  if (typeof assetIdRaw === 'string' && assetIdRaw.length > 0) out.assetId = assetIdRaw
  // Surface tag — tolerant: an unknown / typo'd value is dropped
  // silently (asSurfaceType returns undefined) so a bad string falls
  // back to DEFAULT rather than throwing the whole track load.
  const surface = asSurfaceType((raw as { surface?: unknown }).surface)
  if (surface) out.surface = surface
  if (typeRaw === 'asset' && !out.assetId) {
    throw new Error(`track-json: props[${i}] type='asset' requires an assetId`)
  }
  return out
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

function readOptionalTerrainShader(raw: unknown): TerrainShaderConfig | null {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw)) throw new Error('track-json: terrainShader must be an object if present')
  const out: TerrainShaderConfig = {}
  for (const key of [
    'altMin',
    'altMax',
    'slopeStart',
    'slopeEnd',
    'variation',
    'wetBand',
    'warpStrength',
    'macroScale',
    'microScale',
    'altJitter',
    'screeBand',
    'saturation',
    'triplanar',
    'waterline',
  ] as const) {
    if (key in raw) {
      const v = raw[key]
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`track-json: terrainShader.${key} must be a finite number if present`)
      }
      out[key] = v
    }
  }
  if ('pathTint' in raw) {
    const v = raw.pathTint
    if (
      !Array.isArray(v) ||
      v.length !== 3 ||
      v.some((n) => typeof n !== 'number' || !Number.isFinite(n))
    ) {
      throw new Error('track-json: terrainShader.pathTint must be a 3-element number array')
    }
    out.pathTint = [v[0] as number, v[1] as number, v[2] as number]
  }
  return out
}

function readOptionalHorizon(raw: unknown): HorizonConfig | null {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw)) throw new Error('track-json: horizon must be an object if present')
  const out: HorizonConfig = {}
  for (const key of ['radius', 'peakHeight', 'seed', 'silhouetteDark'] as const) {
    if (key in raw) {
      const v = raw[key]
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`track-json: horizon.${key} must be a finite number if present`)
      }
      out[key] = v
    }
  }
  if (out.radius !== undefined && !(out.radius > 0)) {
    throw new Error(`track-json: horizon.radius must be > 0 (got ${out.radius})`)
  }
  if (out.peakHeight !== undefined && !(out.peakHeight > 0)) {
    throw new Error(`track-json: horizon.peakHeight must be > 0 (got ${out.peakHeight})`)
  }
  if (out.silhouetteDark !== undefined && (out.silhouetteDark < 0 || out.silhouetteDark > 2)) {
    throw new Error(
      `track-json: horizon.silhouetteDark must be in [0, 2] (got ${out.silhouetteDark})`,
    )
  }
  return out
}

function readOptionalSky(raw: unknown): SkyConfig | null {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw)) throw new Error('track-json: sky must be an object if present')
  const out: SkyConfig = {}
  if ('tint' in raw) {
    const v = raw.tint
    if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) {
      throw new Error('track-json: sky.tint must be a 6-digit hex color (e.g. "#ffe4c4")')
    }
    out.tint = v
  }
  for (const key of [
    'cloudiness',
    'sunIntensity',
    'fogNear',
    'fogFar',
    'timeOfDay',
    'cloudTowering',
    'sunSize',
  ] as const) {
    if (key in raw) {
      const v = raw[key]
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`track-json: sky.${key} must be a finite number if present`)
      }
      out[key] = v
    }
  }
  if (out.cloudiness !== undefined && (out.cloudiness < 0 || out.cloudiness > 1)) {
    throw new Error(`track-json: sky.cloudiness must be in [0,1] (got ${out.cloudiness})`)
  }
  if (out.cloudTowering !== undefined && (out.cloudTowering < 0 || out.cloudTowering > 1)) {
    throw new Error(`track-json: sky.cloudTowering must be in [0,1] (got ${out.cloudTowering})`)
  }
  if (out.sunSize !== undefined && (out.sunSize < 0.25 || out.sunSize > 8)) {
    throw new Error(`track-json: sky.sunSize must be in [0.25,8] (got ${out.sunSize})`)
  }
  if (out.sunIntensity !== undefined && out.sunIntensity < 0) {
    throw new Error(`track-json: sky.sunIntensity must be >= 0 (got ${out.sunIntensity})`)
  }
  if (out.fogNear !== undefined && out.fogFar !== undefined && out.fogNear >= out.fogFar) {
    throw new Error(`track-json: sky.fogNear (${out.fogNear}) must be < sky.fogFar (${out.fogFar})`)
  }
  if ('colorGrade' in raw) {
    const v = raw.colorGrade
    if (typeof v !== 'string' || !SKY_COLOR_GRADES.includes(v as SkyColorGrade)) {
      throw new Error(
        `track-json: sky.colorGrade must be one of ${SKY_COLOR_GRADES.join(', ')} (got ${String(v)})`,
      )
    }
    out.colorGrade = v as SkyColorGrade
  }
  if ('bloom' in raw) {
    const v = raw.bloom
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error('track-json: sky.bloom must be a finite number if present')
    }
    if (v < 0 || v > 2) {
      throw new Error(`track-json: sky.bloom must be in [0, 2] (got ${v})`)
    }
    out.bloom = v
  }
  if ('seaStateBeaufort' in raw) {
    const v = raw.seaStateBeaufort
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error('track-json: sky.seaStateBeaufort must be a finite number if present')
    }
    if (v < 0 || v > 12) {
      throw new Error(`track-json: sky.seaStateBeaufort must be in [0, 12] (got ${v})`)
    }
    out.seaStateBeaufort = v
  }
  if ('toneMapping' in raw) {
    const v = raw.toneMapping
    if (typeof v !== 'string' || !SKY_TONE_MAPPINGS.includes(v as SkyToneMapping)) {
      throw new Error(
        `track-json: sky.toneMapping must be one of ${SKY_TONE_MAPPINGS.join(', ')} (got ${String(v)})`,
      )
    }
    out.toneMapping = v as SkyToneMapping
  }
  return out
}

function readOptionalLapWeather(raw: unknown): LapWeather[] | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) {
    throw new Error('track-json: lapWeather must be an array if present')
  }
  const out: LapWeather[] = []
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i]
    if (!isObject(e)) {
      throw new Error(`track-json: lapWeather[${i}] must be an object`)
    }
    const entry: LapWeather = {}
    if ('cloudiness' in e) {
      const v = e.cloudiness
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error(`track-json: lapWeather[${i}].cloudiness must be a number in [0,1]`)
      }
      entry.cloudiness = v
    }
    if ('beaufort' in e) {
      const v = e.beaufort
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 12) {
        throw new Error(`track-json: lapWeather[${i}].beaufort must be a number in [0,12]`)
      }
      entry.beaufort = v
    }
    if ('sunIntensity' in e) {
      const v = e.sunIntensity
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`track-json: lapWeather[${i}].sunIntensity must be a non-negative number`)
      }
      entry.sunIntensity = v
    }
    if ('transitionSeconds' in e) {
      const v = e.transitionSeconds
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(
          `track-json: lapWeather[${i}].transitionSeconds must be a non-negative number`,
        )
      }
      entry.transitionSeconds = v
    }
    out.push(entry)
  }
  return out
}

function readOptionalAudio(raw: unknown): AudioConfig | null {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw)) throw new Error('track-json: audio must be an object if present')
  const out: AudioConfig = {}
  if ('music' in raw) {
    const v = raw.music
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error('track-json: audio.music must be a non-empty string if present')
    }
    out.music = v
  }
  let ambient: string[] | undefined
  if ('ambient' in raw) {
    const v = raw.ambient
    if (!Array.isArray(v)) {
      throw new Error('track-json: audio.ambient must be an array of strings if present')
    }
    ambient = v.map((s, i) => {
      if (typeof s !== 'string' || s.length === 0) {
        throw new Error(`track-json: audio.ambient[${i}] must be a non-empty string`)
      }
      return s
    })
    out.ambient = ambient
  }
  if ('ambientGains' in raw) {
    const v = raw.ambientGains
    if (!Array.isArray(v)) {
      throw new Error('track-json: audio.ambientGains must be an array of numbers if present')
    }
    const gains = v.map((g, i) => {
      if (typeof g !== 'number' || !Number.isFinite(g)) {
        throw new Error(`track-json: audio.ambientGains[${i}] must be a finite number`)
      }
      if (g < 0) {
        throw new Error(`track-json: audio.ambientGains[${i}] must be non-negative (got ${g})`)
      }
      return g
    })
    if (ambient === undefined) {
      throw new Error('track-json: audio.ambientGains requires a matching audio.ambient array')
    }
    if (gains.length !== ambient.length) {
      throw new Error(
        `track-json: audio.ambientGains length (${gains.length}) must match audio.ambient length (${ambient.length})`,
      )
    }
    out.ambientGains = gains
  }
  if ('music3dEffects' in raw) {
    const fx = raw.music3dEffects
    if (!isObject(fx)) {
      throw new Error('track-json: audio.music3dEffects must be an object if present')
    }
    const effects: { duckOnPump?: number } = {}
    if ('duckOnPump' in fx) {
      const v = fx.duckOnPump
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error('track-json: audio.music3dEffects.duckOnPump must be a finite number')
      }
      if (v < 0) {
        throw new Error(
          `track-json: audio.music3dEffects.duckOnPump must be non-negative (got ${v})`,
        )
      }
      effects.duckOnPump = v
    }
    if (Object.keys(effects).length > 0) out.music3dEffects = effects
  }
  return out
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
