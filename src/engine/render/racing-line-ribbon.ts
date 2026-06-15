/**
 * B3 — the racing/wave line as a painted FLOW RIBBON
 * (docs/painterly-legibility-plan.md, Track B → B3 / Part 5).
 *
 * A painterly wayfinding ribbon laid on the water along the track's racing
 * line. The brushstroke flow runs ALONG the line and scrolls forward, so the
 * painted surface itself reads as the "arrow" — no HUD gizmo, no neon-broadcast
 * line (ui-art-direction.md). Forza-grammar colour: COOL green where you should
 * hold / accelerate (on the line, gentle), WARM amber where you should brake or
 * your approach is bad (a sharp bend ahead, or you've drifted off the line).
 * Pairs with the contour foam that's already on so the rideable line and the
 * wave shape read as distinct painted shapes at 40 m/s.
 *
 * ── Where the line comes from ────────────────────────────────────────────────
 * The track's `main` AI spline (`Track.aiSplines`, the canonical racing line the
 * AI follows) — a loop-closed dense XZ polyline. We reuse it verbatim rather than
 * re-deriving a path; if a track only carries the sparse `anchors`, we sample
 * them with the same Three-free `sampleCatmullRom` the JSON loader uses, so the
 * ribbon and the AI ride identical geometry.
 *
 * ── How it's drawn ───────────────────────────────────────────────────────────
 * One merged ribbon strip (two verts per spline point, extruded across the line
 * by a live half-width uniform in `positionNode`, exactly like wind-trails.ts),
 * ONE `MeshBasicNodeMaterial`, one draw call. Unlit + transparent: it's painted
 * light on the water, not a lit surface, and it reads the same at any
 * time-of-day. The colour is the COOL↔WARM mix; the painterly flow + the
 * directional chevron + the soft edges all live in the ALPHA, so the band breaks
 * into flowing strokes instead of a solid gel. Brush grain rides the shared
 * `brush_strokes.png` sheet the whole scene already uses, so it's the same paint
 * language (and can't 404 a look feature — it falls back to a neutral grey).
 *
 * ── The transparent-sort-over-water trap ─────────────────────────────────────
 * The centre water surface writes depth, is near-opaque, and is camera-locked, so
 * in the back-to-front transparent sort it draws AFTER a chase-distance overlay
 * and repaints it away (see the ghost-vs-water note in render-systems.ts and the
 * `ghost_water_transparent_sort_trap` memory). `renderOrder = 1` (above water's 0,
 * below the spray/foam FX at 2) forces the ribbon to composite after the water;
 * `depthTest` stays ON so wave crests, terrain and the bike still occlude it
 * naturally (the line dips under a crest, hides behind a hill) and `depthWrite`
 * stays OFF so it never occludes anything itself.
 *
 * ── Default-OFF, playtest-gated ──────────────────────────────────────────────
 * The whole thing is behind a module master flag that DEFAULTS OFF — with it off
 * the mesh is hidden every frame, so the shipped frame is byte-identical to today
 * until the owner enables it in a headed playtest (dev palette → Toggles →
 * "Racing-line ribbon", `?raceline=1` for e2e, or `window.__raceline` live). The
 * colour balance, width, flow speed and curvature mix are all live-tunable via
 * that dev surface — playtest-validatable starting points, not final values.
 *
 * Render-only: reads the loaded Track's spline geometry + the player's XZ each
 * frame, writes a Three object. Never touches the sim. WebGPU/TSL only — never
 * `THREE.ShaderMaterial`. This is a SEPARATE module + a small game-loop hook on
 * purpose: water.ts is being actively edited, so the ribbon stays out of it.
 */
import * as THREE from 'three'
import type Node from 'three/src/nodes/core/Node.js'
import {
  attribute,
  clamp,
  float,
  fract,
  length,
  mix,
  positionLocal,
  positionWorld,
  pow,
  smoothstep,
  texture as tslTexture,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import type { Vec3 } from '@/engine/sim/physics/vec'
import { sampleCatmullRom } from '@/game/tracks/catmull-rom'
import { sharedBrushTexture } from './brush-strokes'
import { SIGNAL_COLORS } from './signal-colors'

// ── Master flag (the one switch that keeps the shipped look frozen) ───────────
// Mirrors signal-state.ts: every consumer (here, the per-frame `mesh.visible`)
// reads this, and it DEFAULTS OFF, so off == today's frame exactly.

let enabled = false

/** Is the racing-line ribbon currently shown? */
export function racingLineRibbonEnabled(): boolean {
  return enabled
}

/** Toggle the ribbon. Live: the per-frame tick reads this and shows/hides the
 *  mesh next frame, so flipping it needs no reload. */
export function setRacingLineRibbonEnabled(on: boolean): void {
  enabled = on
}

/**
 * Boot hook for the e2e URL surface (`?raceline=1`). Kept here — not in
 * url-modes.ts — so this slice owns its flag parse (mirrors `parseSignalsFlag`).
 * Accepts `1`/`true`/`on` as on, `0`/`false`/`off` as an explicit off; anything
 * else leaves the current value. Returns the resulting state for logging.
 */
export function parseRacingLineFlag(search: string | URLSearchParams): boolean {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const raw = params.get('raceline')
  if (raw !== null) {
    const v = raw.trim().toLowerCase()
    if (v === '' || v === '1' || v === 'true' || v === 'on') enabled = true
    else if (v === '0' || v === 'false' || v === 'off') enabled = false
  }
  return enabled
}

// ── Tunables (playtest-validatable defaults) ─────────────────────────────────

/** Live, playtest-tunable knobs. All defaulted; the dev hook re-dials them with
 *  no recompile (uniform / geometry-free writes). */
export type RacingLineRibbonConfig = {
  /** Half-width of the painted band, metres (full band = 2×). Live. Default 3. */
  halfWidth: number
  /** Master alpha of the band, 0..1. Live. Default 0.5. */
  opacity: number
  /** Forward scroll speed of the brush flow + chevrons, in tile-lengths per
   *  second. Live. Default 0.5. */
  flowSpeed: number
  /** How strongly upcoming track curvature warms the line toward "brake"
   *  (0 = ribbon stays uniformly cool/ideal-green; 1 = corners go fully warm).
   *  Live. Default 0.7. */
  brakeMix: number
  /** Lift above the mean water surface, metres — keeps the band off the water
   *  plane so it doesn't z-fight, while wave crests still occlude it. Default
   *  0.18. (Build-time: baked into the strip's Y.) */
  lift: number
  /** World metres of line per brush/chevron tile — the painted stroke size.
   *  Snapped to an integer count around the loop so the flow wraps seamlessly.
   *  Default 7. (Build-time.) */
  tileMeters: number
}

const DEFAULT_CONFIG: RacingLineRibbonConfig = {
  halfWidth: 3,
  opacity: 0.5,
  flowSpeed: 0.5,
  brakeMix: 0.7,
  lift: 0.18,
  tileMeters: 7,
}

// Proximity "lead" fade — the ribbon is brightest around + ahead of the bike and
// fades to a faint floor in the distance, so it leads the player forward instead
// of glowing as a full-loop UI band.
const PROX_NEAR_M = 10 // full strength within this radius of the player
const PROX_FAR_M = 78 // faded to the floor past this radius
const PROX_FAR_FLOOR = 0.26 // distant-line alpha (still readable for wayfinding)

// Off-line warm-shift — how far off the line the player is before the whole
// ribbon shifts warm ("bad approach / get back on the line").
const OFFLINE_ON_M = 3.5 // on the line up to here
const OFFLINE_OFF_M = 16 // fully "off the line" by here

// Curvature → brake-zone colour. The warm appears in the APPROACH to a bend
// (lookahead), reading as a Forza brake marker, not a colour that only lands
// mid-corner.
const CURV_LOOKAHEAD_M = 18 // how far ahead a bend warms the line
const CURV_TANGENT_SPAN = 2 // points each side for a smooth tangent estimate
const CURV_TURN_LO = 0.12 // rad of turn over the lookahead that starts warming
const CURV_TURN_HI = 0.72 // rad that's fully "brake"
const CURV_SMOOTH = 3 // box-filter half-width (points) to de-speckle

// Painted structure.
const CHEVRON_SKEW = 0.35 // centre leads the flanks by this (the ▷ arrow read)
const STREAK_SHARP = 1.6 // leading-edge sharpness of each forward stroke
const STREAK_FLOOR = 0.45 // alpha kept between stroke fronts (band stays a line)
const GRAIN_FLOOR = 0.5 // alpha kept where the brush sheet is dark (painterly)
const EDGE_INNER = 0.45 // |across| where the soft edge feather starts

export type RacingLineRibbon = {
  mesh: THREE.Object3D
  /**
   * Per-frame update. `time` is the deterministic wave-field clock (s) — so
   * freeze-water freezes the flow for clean screenshots and replays reproduce
   * it; `playerX/playerZ` are the player's render-space XZ (for the lead fade +
   * the off-line warm-shift). Reads the master flag to drive visibility.
   */
  tick(time: number, playerX: number, playerZ: number): void
  dispose(): void
}

/** Inputs the ribbon needs from the loaded track. */
export type RacingLineRibbonInput = {
  /** The `main` AI spline's dense loop-closed polyline (the racing line). */
  points: readonly Vec3[]
  /** The sparse control anchors — used to resample `points` if a track shipped
   *  them un-densified (defensive; the loader normally fills `points`). */
  anchors?: readonly Vec3[]
  /** Mean water surface Y (`track.water.height`) the band sits on. */
  waterHeight: number
  /** Optional config overrides (else the playtest defaults). */
  config?: Partial<RacingLineRibbonConfig>
}

/**
 * Build the racing-line flow ribbon for a track, or return `null` when the track
 * has no usable racing line (procedural / open tracks with no `main` spline) —
 * the caller then simply skips it. The returned mesh is added to the scene by the
 * caller; nothing is visible until the master flag is enabled.
 */
export function createRacingLineRibbon(input: RacingLineRibbonInput): RacingLineRibbon | null {
  const cfg: RacingLineRibbonConfig = { ...DEFAULT_CONFIG, ...input.config }

  // Resolve the centreline. Prefer the loader-densified `points`; fall back to
  // sampling the anchors with the SAME closed Catmull-Rom the loader uses, so the
  // ribbon traces exactly the AI's line.
  let line = input.points
  if (line.length < 3 && input.anchors && input.anchors.length >= 2) {
    line = sampleCatmullRom(input.anchors as Vec3[], { divisionsPerSegment: 12, closed: true })
  }
  const n = line.length
  if (n < 3) return null

  const y = input.waterHeight + cfg.lift

  // ── Per-point geometry inputs: tangent, perpendicular, arc length, curvature.
  // Central-difference tangents over a small span for a smooth, low-noise frame.
  const tang: Array<{ x: number; z: number }> = new Array(n)
  for (let i = 0; i < n; i++) {
    const a = line[(i - CURV_TANGENT_SPAN + n) % n]!
    const b = line[(i + CURV_TANGENT_SPAN) % n]!
    let tx = b.x - a.x
    let tz = b.z - a.z
    const l = Math.hypot(tx, tz) || 1
    tx /= l
    tz /= l
    tang[i] = { x: tx, z: tz }
  }

  // Cumulative XZ arc length (closed) — drives the brush/chevron tiling and the
  // forward-lookahead used by the curvature/brake colour.
  const cum = new Float32Array(n + 1)
  for (let i = 0; i < n; i++) {
    const a = line[i]!
    const b = line[(i + 1) % n]!
    cum[i + 1] = cum[i]! + Math.hypot(b.x - a.x, b.z - a.z)
  }
  const perimeter = cum[n]! || 1

  // Curvature → brake, measured as the heading change over a forward lookahead so
  // the warm lands in the APPROACH to a bend (a brake marker), then box-smoothed.
  const brakeRaw = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const j = lookaheadIndex(cum, i, n, CURV_LOOKAHEAD_M, perimeter)
    const ti = tang[i]!
    const tj = tang[j]!
    const d = clampScalar(ti.x * tj.x + ti.z * tj.z, -1, 1)
    const turn = Math.acos(d) // radians of heading change over the lookahead
    brakeRaw[i] = smoothstepScalar(CURV_TURN_LO, CURV_TURN_HI, turn)
  }
  const brake = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    let w = 0
    for (let k = -CURV_SMOOTH; k <= CURV_SMOOTH; k++) {
      s += brakeRaw[(i + k + n) % n]!
      w++
    }
    brake[i] = s / w
  }

  // ── Build the strip: rings 0..n (ring n duplicates ring 0 to close the loop
  // with a continuous arc-length U so the flow wraps without a seam). Two verts
  // per ring (left/right), offset across the line in `positionNode`.
  const rings = n + 1
  const vertsPerRing = 2
  const vertCount = rings * vertsPerRing
  const positions = new Float32Array(vertCount * 3)
  const perp = new Float32Array(vertCount * 3) // unit across-line dir (XZ)
  const aBrake = new Float32Array(vertCount)
  const uvs = new Float32Array(vertCount * 2)

  // Integer tile count so the flow wraps seamlessly around the closed loop.
  const tileCount = Math.max(1, Math.round(perimeter / cfg.tileMeters))

  for (let r = 0; r < rings; r++) {
    const i = r % n
    const p = line[i]!
    const t = tang[i]!
    // Perpendicular in XZ (rotate the tangent −90°): (t.z, 0, −t.x).
    const px = t.z
    const pz = -t.x
    // Arc-length U mapped to [0, tileCount] so `fract` wraps at the loop join;
    // ring n carries the FULL length (= tileCount) rather than 0, closing clean.
    const uAlong = (cum[r]! / perimeter) * tileCount
    const bi = brake[i]!
    for (let side = 0; side < 2; side++) {
      const vi = r * vertsPerRing + side
      positions[vi * 3 + 0] = p.x
      positions[vi * 3 + 1] = y
      positions[vi * 3 + 2] = p.z
      perp[vi * 3 + 0] = px
      perp[vi * 3 + 1] = 0
      perp[vi * 3 + 2] = pz
      aBrake[vi] = bi
      uvs[vi * 2 + 0] = uAlong
      uvs[vi * 2 + 1] = side // 0 = left, 1 = right
    }
  }

  const indices = new Uint32Array(n * 6)
  let w = 0
  for (let r = 0; r < n; r++) {
    const a = r * vertsPerRing
    indices[w++] = a
    indices[w++] = a + 1
    indices[w++] = a + 2
    indices[w++] = a + 1
    indices[w++] = a + 3
    indices[w++] = a + 2
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aPerp', new THREE.BufferAttribute(perp, 3))
  geometry.setAttribute('aBrake', new THREE.BufferAttribute(aBrake, 1))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))

  // ── Material: one unlit node material for the whole ribbon.
  const uTime = uniform(0)
  const uHalfWidth = uniform(cfg.halfWidth)
  const uOpacity = uniform(cfg.opacity)
  const uFlow = uniform(cfg.flowSpeed)
  const uBrakeMix = uniform(cfg.brakeMix)
  const uOffline = uniform(0) // 0 = on the line, 1 = fully off — set per frame
  const uPlayer = uniform(new THREE.Vector2(0, 0))

  // Reserved-vocabulary hues (signal-colors.ts) as linear vec3 constants: COOL =
  // racingLineIdeal green (hold / on-line), WARM = hazard amber (brake / off).
  const cool = SIGNAL_COLORS.racingLineIdeal.color
  const warm = SIGNAL_COLORS.hazard.color
  const coolN = vec3(cool.r, cool.g, cool.b)
  const warmN = vec3(warm.r, warm.g, warm.b)

  const uAlong = uv().x
  const across = uv().y.mul(2).sub(1) // -1 (left) .. +1 (right)
  const brakeV = attribute('aBrake', 'float') as unknown as Node<'float'>

  // Extrude the strip across the line by the live half-width — wind-trails.ts
  // idiom. positionLocal is the centreline (mesh sits at world origin), so
  // positionWorld follows this displaced position for the proximity fade below.
  const perpN = attribute('aPerp', 'vec3') as unknown as Node<'vec3'>
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: true,
    toneMapped: true,
  })
  // biome-ignore lint/suspicious/noExplicitAny: TSL node assignment to material slots
  material.positionNode = positionLocal.add(perpN.mul(across).mul(uHalfWidth)) as any

  // Brake colour: per-point curvature (scaled by the live mix) OR the global
  // off-line shift — whichever is warmer wins, clamped. Cool ⇒ ideal green.
  const brakeFac = clamp(brakeV.mul(uBrakeMix).add(uOffline), float(0), float(1))
  const baseHue = mix(coolN, warmN, brakeFac)

  // Forward chevron streaks: a phase that scrolls toward +U (forward along the
  // line) with the CENTRE leading the flanks (|across| skews the phase), so each
  // stroke is a ▷ pointing the way. Bright leading edge, fading tail.
  const phase = fract(uAlong.sub(across.abs().mul(CHEVRON_SKEW)).sub(uTime.mul(uFlow)))
  const streak = pow(clamp(float(1).sub(phase), float(0), float(1)), float(STREAK_SHARP))

  // Painterly grain from the shared brush sheet, flowing with the strokes — adds
  // bristle break-up so the band reads as paint, not a gel. Average the 3 packed
  // scales for a smooth field; it's DATA (NoColorSpace), tiles via RepeatWrapping.
  const grainUv = vec2(uAlong.sub(uTime.mul(uFlow)), across.mul(0.5).add(0.5))
  const grainTex = tslTexture(sharedBrushTexture(), grainUv)
  const grain = grainTex.r.add(grainTex.g).add(grainTex.b).div(float(3))

  // Soft across-line feather so the band has painted edges, not a hard decal cut.
  const edge = clamp(
    float(1).sub(smoothstep(float(EDGE_INNER), float(1), across.abs())),
    float(0),
    float(1),
  )

  // Lead fade: full near the bike, faint (but readable) far away.
  const dist = length(positionWorld.xz.sub(uPlayer))
  const prox = mix(
    float(PROX_FAR_FLOOR),
    float(1),
    smoothstep(float(PROX_FAR_M), float(PROX_NEAR_M), dist),
  )

  // Compose alpha: the structure (streak + grain) lives here with floors so the
  // band never fully vanishes between strokes — it stays a readable line that
  // happens to be painted. Colour stays the signal hue; a touch of streak
  // brighten gives the strokes life without going rainbow.
  const streakA = mix(float(STREAK_FLOOR), float(1), streak)
  const grainA = mix(float(GRAIN_FLOOR), float(1), grain)
  // biome-ignore lint/suspicious/noExplicitAny: TSL node assignment to material slots
  material.colorNode = baseHue.mul(float(1).add(streak.mul(0.25))) as any
  // biome-ignore lint/suspicious/noExplicitAny: TSL node assignment to material slots
  material.opacityNode = clamp(
    uOpacity.mul(edge).mul(prox).mul(streakA).mul(grainA),
    float(0),
    float(1),
  ) as any

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'racing-line-ribbon'
  mesh.frustumCulled = false // spans the whole course; never let a bound cull it
  // Above the water's transparent repaint (0), below the spray/foam FX (2) — see
  // the file header + the ghost-vs-water sort trap.
  mesh.renderOrder = 1
  mesh.visible = enabled // default-off: hidden until the master flag is on

  // Live config setters (used by the dev hook + the dev-tools tuner). Geometry-
  // free: width is a uniform via positionNode; the rest are plain uniforms.
  const setConfig = (c: Partial<RacingLineRibbonConfig>): void => {
    if (c.halfWidth !== undefined) uHalfWidth.value = c.halfWidth
    if (c.opacity !== undefined) uOpacity.value = c.opacity
    if (c.flowSpeed !== undefined) uFlow.value = c.flowSpeed
    if (c.brakeMix !== undefined) uBrakeMix.value = c.brakeMix
  }

  // CPU-side nearest-point search state for the off-line warm-shift. A cached
  // last index + a windowed scan keeps it ~O(window) per frame on a long loop.
  let nearestHint = 0

  const ribbon: RacingLineRibbon = {
    mesh,
    tick(time: number, playerX: number, playerZ: number) {
      mesh.visible = enabled
      if (!enabled) return
      uTime.value = time
      uPlayer.value.set(playerX, playerZ)
      // Nearest centreline point (windowed around the last hit) → off-line amount.
      const d = nearestDistance(line, playerX, playerZ, nearestHint)
      nearestHint = d.index
      uOffline.value = smoothstepScalar(OFFLINE_ON_M, OFFLINE_OFF_M, Math.sqrt(d.dist2))
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }

  // Dev/test live surface (mirrors `__signals` / `__windTrails`): flip the flag
  // and dial the look without a reload, plus an enabled read-back for harnesses.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    ;(
      window as unknown as {
        __raceline?: {
          enable: () => void
          disable: () => void
          isEnabled: () => boolean
          set: (c: Partial<RacingLineRibbonConfig>) => void
        }
      }
    ).__raceline = {
      enable: () => setRacingLineRibbonEnabled(true),
      disable: () => setRacingLineRibbonEnabled(false),
      isEnabled: racingLineRibbonEnabled,
      set: setConfig,
    }
  }

  return ribbon
}

// ── Small pure helpers (kept local; Three-free scalar math) ──────────────────

function clampScalar(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstepScalar(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = clampScalar((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Index ~`distM` ahead of `i` by arc length on the closed loop. */
function lookaheadIndex(
  cum: Float32Array,
  i: number,
  n: number,
  distM: number,
  perimeter: number,
): number {
  const target = (cum[i]! + distM) % perimeter
  // Linear walk forward from i (lookahead is short vs the loop, so this is a few
  // steps); wrap the cumulative compare across the loop seam.
  for (let s = 1; s <= n; s++) {
    const j = (i + s) % n
    const cj = cum[j]! < cum[i]! ? cum[j]! + perimeter : cum[j]!
    const ct = target < cum[i]! ? target + perimeter : target
    if (cj >= ct) return j
  }
  return i
}

/** Nearest centreline point to (x,z), searching a window around `hint` first and
 *  falling back to a full scan if the window misses — keeps it cheap frame to
 *  frame while staying correct after a respawn / teleport. */
function nearestDistance(
  line: readonly Vec3[],
  x: number,
  z: number,
  hint: number,
): { index: number; dist2: number } {
  const n = line.length
  const WINDOW = 24
  let bestI = hint
  let bestD = Number.POSITIVE_INFINITY
  for (let s = -WINDOW; s <= WINDOW; s++) {
    const i = (hint + s + n) % n
    const p = line[i]!
    const dx = p.x - x
    const dz = p.z - z
    const d = dx * dx + dz * dz
    if (d < bestD) {
      bestD = d
      bestI = i
    }
  }
  // If the closest in the window is at its edge, the bike likely jumped — full
  // scan to recover (cheap; a few hundred points, only on the jump frame).
  if (Math.abs(((bestI - hint + n + n / 2) % n) - n / 2) >= WINDOW) {
    for (let i = 0; i < n; i++) {
      const p = line[i]!
      const dx = p.x - x
      const dz = p.z - z
      const d = dx * dx + dz * dz
      if (d < bestD) {
        bestD = d
        bestI = i
      }
    }
  }
  return { index: bestI, dist2: bestD }
}

// ── Boot auto-init (browser only) ─────────────────────────────────────────────
// Parse `?raceline=1` on first import so the e2e flag works without url-modes.ts
// wiring (this module is imported by race-boot when it builds the ribbon). Safe
// re: determinism — it only gates the RENDER-side overlay, never the sim.
if (typeof window !== 'undefined') {
  try {
    parseRacingLineFlag(window.location.search)
  } catch {
    // Non-browser / odd location — ignore; stays default-off.
  }
}
