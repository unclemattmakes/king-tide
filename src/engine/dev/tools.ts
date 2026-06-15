/**
 * Dev-tools palette — the grouped tool catalogue.
 *
 * `createDevTools(deps)` returns the full `DevTool[]` the dock rail and
 * command bar share. It's mostly declarative data; the only live wiring is
 * `deps` (the chase camera, for copy-pose, and the tuner-host open/isOpen
 * callbacks). Everything else reaches the running game through the dev-only
 * `window.__hover` surface (debug.ts), so a not-yet-ready build no-ops
 * cleanly rather than throwing.
 *
 * Adding a buried dev surface? Add one entry here and it shows up in both
 * the rail and the search bar — no other change needed.
 */

import * as THREE from 'three'
import { resetDevSettings } from '../dev-settings'
import { racingLineRibbonEnabled, setRacingLineRibbonEnabled } from '../render/racing-line-ribbon'
import { getActivePostPipeline } from '../render/renderer-service'
import { setSignalsEnabled, signalsEnabled } from '../render/signal-state'
import { getSkySystem } from '../render/sky-service'
import { getWaterMesh } from '../render/water-service'
import { getWaterTuningScope } from '../water-debug-storage'
import { getWaveDotsController, getWindTrailsController } from './dev-runtime'
import type {
  ActionTool,
  DevTool,
  PanelTool,
  ParamTool,
  SceneTool,
  ToggleTool,
  TunerId,
} from './registry-types'

export type DevToolDeps = {
  /** Live chase camera — needed by the copy-camera-pose action. */
  camera: THREE.PerspectiveCamera
  /** Open a docked tuner (single-active; routed through the tuner host). */
  openTuner: (id: TunerId) => void
  /** Whether a docked tuner is currently open — drives the rail's state dot. */
  isTunerOpen: (id: TunerId) => boolean
}

/** Dev debug surface — present in dev/test builds, absent otherwise. */
const hv = () => window.__hover

function hasFlag(param: string): boolean {
  return new URLSearchParams(window.location.search).has(param)
}
function paramEquals(param: string, value: string): boolean {
  return new URLSearchParams(window.location.search).get(param) === value
}

// ---- typed builders (keep the discriminated-union literals honest) --------

function scene(
  id: string,
  label: string,
  param: string,
  opts: { hint?: string; keywords?: string; value?: string } = {},
): SceneTool {
  return { kind: 'scene', group: 'Scenes', id, label, param, ...opts }
}

function toggle(
  id: string,
  label: string,
  toggleFn: () => void,
  isOn: () => boolean,
  opts: { hint?: string; keywords?: string } = {},
): ToggleTool {
  return { kind: 'toggle', group: 'Toggles', id, label, toggle: toggleFn, isOn, ...opts }
}

function flagParam(
  id: string,
  label: string,
  param: string,
  opts: { hint?: string; keywords?: string } = {},
): ParamTool {
  return {
    kind: 'param',
    mode: 'flag',
    group: 'Render',
    id,
    label,
    param,
    isOn: () => hasFlag(param),
    ...opts,
  }
}

function valueParam(
  id: string,
  label: string,
  param: string,
  opts: { hint?: string; keywords?: string; value?: string; isOn?: () => boolean } = {},
): ParamTool {
  return { kind: 'param', mode: 'value', group: 'Render', id, label, param, ...opts }
}

function action(
  id: string,
  label: string,
  run: () => void | Promise<void>,
  opts: { hint?: string; keywords?: string } = {},
): ActionTool {
  return { kind: 'action', group: 'Actions', id, label, run, ...opts }
}

// ---- one-shot action implementations --------------------------------------

/** Mimic the Backspace respawn keybind (controls.ts). Dispatch keyup too so
 *  the key doesn't linger in the keyboard's held-set. */
function dispatchRespawn(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backspace' }))
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backspace' }))
}

/** Copy the live camera's world pose as a `CameraPose` JSON blob, ready to
 *  paste into `window.__hover.setCameraPose(...)`. */
function copyCameraPose(camera: THREE.PerspectiveCamera): void {
  const pos = new THREE.Vector3()
  const dir = new THREE.Vector3()
  camera.getWorldPosition(pos)
  camera.getWorldDirection(dir)
  const target = pos.clone().addScaledVector(dir, 20)
  const r = (n: number) => Math.round(n * 100) / 100
  const pose = {
    pos: { x: r(pos.x), y: r(pos.y), z: r(pos.z) },
    target: { x: r(target.x), y: r(target.y), z: r(target.z) },
  }
  void navigator.clipboard?.writeText(JSON.stringify(pose))
}

// ---- the catalogue --------------------------------------------------------

export function createDevTools(deps: DevToolDeps): DevTool[] {
  const panel = (id: string, label: string, tuner: TunerId, hint: string): PanelTool => ({
    kind: 'panel',
    group: 'Tuners',
    id,
    label,
    hint,
    open: () => deps.openTuner(tuner),
    isOpen: () => deps.isTunerOpen(tuner),
  })

  // Live water-shader debug surface (null on procedural / edit-mode tracks).
  const water = () => getWaterMesh()?.debug ?? null
  // Closure-tracked state for the binary water diagnostics — the debug surface
  // has no getters for these. Seed wireframe from the boot URL so `?wire=1`
  // reads correct on the rail.
  let wireOn = hasFlag('wire')
  let colorizeOn = false
  // Scene-grade toggle is a coarse identity↔muted-preset flip (the contrast
  // budget on/off); the post pipeline has no grade getter, so track state here.
  let gradeMuted = false

  return [
    // ---- Scenes (navigate away / restart boot) ----
    scene('scene.viewer', 'Bike viewer', 'viewer', {
      hint: 'Studio turntable for the bike mesh',
      keywords: 'model garage turntable',
    }),
    scene('scene.propviewer', 'Prop viewer', 'propviewer', {
      hint: 'Painterly-vinyl validation bench for a single prop',
      keywords: 'asset mesh material',
    }),
    scene('scene.calibrate', 'Rider pose calibration', 'calibrate', {
      hint: 'Dial in rider rest-pose + reactive joint angles',
      keywords: 'character bones',
    }),
    scene('scene.rideredit', 'Rider editor', 'rideredit', {
      hint: 'Per-bone primitive + colour editor for the rider',
      keywords: 'character design',
    }),
    scene('scene.waveriders', 'Wave-rider validation', 'waveriders', {
      hint: 'Buoyancy + spring tuning against a row of floats',
      keywords: 'water buoyancy float',
    }),
    scene('scene.waterlab', 'Water lab', 'waterlab', {
      hint: 'Open-ocean water analysis: tuner + phase-speed pace cones + iso-line speed probe',
      keywords: 'water contour swell shader tuning ocean waves',
    }),
    {
      kind: 'action',
      group: 'Scenes',
      id: 'scene.watertune',
      label: 'Water tune (free cam)',
      hint: 'Reload THIS level into a free-cam water tuner — track-scoped, no race',
      keywords: 'water tune free camera look foam contour body absorption swell level',
      run: () => {
        const scope = getWaterTuningScope()
        const slug = scope.kind === 'track' ? scope.slug : 'sandbar'
        window.location.assign(`${location.pathname}?watertune=${encodeURIComponent(slug)}`)
      },
    },
    scene('scene.podium', 'Podium ceremony', 'podium', {
      hint: 'Cup-win trophy + standings sequence',
      keywords: 'trophy win cup',
    }),
    scene('scene.edit', 'Track editor', 'edit', {
      hint: 'In-app gameplay-data editor (checkpoints, props…)',
      keywords: 'level checkpoint spline',
    }),
    scene('scene.bench', 'Benchmark', 'bench', {
      hint: 'Full 8-bike field, warmup + measure window',
      keywords: 'perf performance fps',
    }),
    scene('scene.tt', 'Time trial', 'tt', {
      hint: 'Solo run vs the clock + ghost of your best lap',
      keywords: 'ghost lap solo',
    }),

    // ---- Tuners (docked live panels — scene stays visible) ----
    panel(
      'panel.devsettings',
      'Dev settings',
      'devsettings',
      'Input / camera / hover-spring feel knobs',
    ),
    panel('panel.water', 'Water debug', 'water', 'Wave field + water shader live tuning'),
    panel('panel.camera', 'Chase-camera tuner', 'camera', 'Offset / look-ahead / damping / FOV'),
    panel(
      'panel.brush',
      'Brush strokes',
      'brush',
      'Painterly stroke size/strength — terrain + rocks, independent',
    ),

    // ---- Toggles (flip live in-race) ----
    toggle(
      'toggle.collision',
      'Collision wireframe',
      () => hv()?.toggleCollisionDebug(),
      () => hv()?.isCollisionDebugOn() ?? false,
      { hint: 'Rapier collider overlay · F2', keywords: 'physics rapier debug' },
    ),
    toggle(
      'toggle.antigrav',
      'Anti-grav debug',
      () => hv()?.toggleAntiGravDebug(),
      () => hv()?.isAntiGravDebugOn() ?? false,
      { hint: 'Spline polylines + zone boxes · F3', keywords: 'zone spline' },
    ),
    toggle(
      'toggle.hover',
      'Hover-spring debug',
      () => hv()?.toggleHoverDebug(),
      () => hv()?.isHoverDebugOn() ?? false,
      { hint: 'Probe rays + force arrows · F4', keywords: 'buoyancy probe spring' },
    ),
    toggle(
      'toggle.autoplay',
      'Auto-play',
      () => hv()?.toggleAutoPlay(),
      () => hv()?.isAutoPlay() ?? false,
      { hint: 'AI drives the player bike · T / F1', keywords: 'ai autopilot' },
    ),
    toggle(
      'toggle.dirarrow',
      'Checkpoint arrow',
      () => hv()?.toggleDirectionArrow(),
      () => hv()?.isDirectionArrowOn() ?? false,
      { hint: 'Next-checkpoint direction marker', keywords: 'guidance navigation' },
    ),
    toggle(
      'toggle.perfhud',
      'Perf HUD',
      () => hv()?.perf?.toggleHud(),
      () => hv()?.perf?.isHudOn() ?? false,
      { hint: 'Frame-time overlay · backtick', keywords: 'fps performance frame' },
    ),
    toggle(
      'toggle.devhud',
      'Dev HUD overlay',
      () => {
        document.body.classList.toggle('dev-hud')
      },
      () => document.body.classList.contains('dev-hud'),
      {
        hint: 'Top-left fps / backend / input / race / audio strip',
        keywords: 'fps stats telemetry overlay debug',
      },
    ),

    // Water-shader diagnostics — live via the water debug surface (the URL
    // params `?wire` etc. only ever set boot defaults; the panel + these
    // toggles drive the same setters live).
    toggle(
      'toggle.water-wire',
      'Water wireframe',
      () => {
        wireOn = !wireOn
        water()?.setWireframe(wireOn)
      },
      () => wireOn,
      { hint: 'Render the wave mesh as wireframe (live)', keywords: 'water mesh debug grid' },
    ),
    toggle(
      'toggle.water-colorize',
      'Water wave colorize',
      () => {
        colorizeOn = !colorizeOn
        water()?.setColorize(colorizeOn)
      },
      () => colorizeOn,
      {
        hint: 'Tint the 3 wave components to read the spectrum (live)',
        keywords: 'water debug visualize',
      },
    ),
    toggle(
      'toggle.wavedots',
      'Sim-surface probe',
      () => getWaveDotsController()?.toggle(),
      () => getWaveDotsController()?.isOn() ?? false,
      {
        hint: 'Red dots at the CPU water height vs the rendered mesh (live)',
        keywords: 'water buoyancy sim wavedots',
      },
    ),
    toggle(
      'toggle.signals',
      'Gameplay signals (rim)',
      () => setSignalsEnabled(!signalsEnabled()),
      () => signalsEnabled(),
      {
        hint: 'Style-as-legibility rim signals — drift-charge ladder + pickup pulse (live)',
        keywords: 'legibility rim signal charge drift pickup boost hazard slipstream',
      },
    ),
    toggle(
      'toggle.raceline',
      'Racing-line ribbon',
      () => setRacingLineRibbonEnabled(!racingLineRibbonEnabled()),
      () => racingLineRibbonEnabled(),
      {
        hint: 'B3 painted flow ribbon on the water along the racing line — cool=hold, warm=brake/off-line (live)',
        keywords: 'legibility racing line ribbon flow wayfinding forza wave brake guidance',
      },
    ),

    // ---- World (live scene state — no reload) ----
    {
      kind: 'action',
      group: 'World',
      id: 'world.tod',
      label: 'Time of day…',
      hint: 'Live sun / sky / env-map — no reload (285 ≈ sunset)',
      keywords: 'sun sky lighting sunset dusk dawn tod',
      run: () => {
        const sky = getSkySystem()
        if (!sky) return
        const entered = window.prompt(
          'Time of day — seconds into the 0–360s cycle (285 ≈ sunset):',
          '',
        )
        if (entered === null) return
        const n = Number(entered.trim())
        if (Number.isFinite(n)) sky.setTimeOfDay(n)
      },
    },
    {
      kind: 'toggle',
      group: 'World',
      id: 'world.wind-trails',
      label: 'Wind gusts',
      hint: 'Wind-Waker-ish white gust strokes (live; ?wind=0 boots them off)',
      keywords: 'wind trails gusts streamers vfx ambience',
      toggle: () => getWindTrailsController()?.toggle(),
      isOn: () => getWindTrailsController()?.isOn() ?? false,
    },
    {
      kind: 'toggle',
      group: 'World',
      id: 'world.freeze-water',
      label: 'Freeze water',
      hint: 'Pause the wave field — great for clean screenshots',
      keywords: 'pause time stop water timescale freeze',
      toggle: () => {
        const d = water()
        if (d) d.setTimeScale(d.getTimeScale() === 0 ? 1 : 0)
      },
      isOn: () => (water()?.getTimeScale() ?? 1) === 0,
    },
    {
      kind: 'toggle',
      group: 'World',
      id: 'world.scene-grade',
      label: 'Scene grade (muted)',
      hint: 'Pull the world into a muted band so gameplay signals pop — the contrast budget (live)',
      keywords: 'grade colour color saturation contrast muted budget legibility post',
      toggle: () => {
        gradeMuted = !gradeMuted
        getActivePostPipeline()?.setGrade(
          gradeMuted
            ? { exposure: 0.96, temperature: 0.08, saturation: 0.8, contrast: 0.92 }
            : { exposure: 1, temperature: 0, saturation: 1, contrast: 1 },
        )
      },
      isOn: () => gradeMuted,
    },

    // ---- Render (these genuinely need a map reload) ----
    valueParam('param.backend.webgpu', 'Renderer: WebGPU', 'backend', {
      value: 'webgpu',
      isOn: () => paramEquals('backend', 'webgpu'),
      hint: 'Reloads — the renderer is backend-specific',
      keywords: 'gpu graphics reload',
    }),
    valueParam('param.backend.webgl2', 'Renderer: WebGL2', 'backend', {
      value: 'webgl2',
      isOn: () => paramEquals('backend', 'webgl2'),
      hint: 'Reloads — the renderer is backend-specific',
      keywords: 'gpu graphics fallback reload',
    }),
    valueParam('param.aa', 'Disable AA', 'aa', {
      value: 'off',
      isOn: () => paramEquals('aa', 'off'),
      hint: 'Reloads — MSAA is fixed at render-target creation',
      keywords: 'antialias msaa reload',
    }),
    valueParam('param.rider', 'Capsule rider', 'rider', {
      value: 'capsule',
      isOn: () => paramEquals('rider', 'capsule'),
      hint: 'Reloads — rebuilds the rider rig',
      keywords: 'character mesh reload',
    }),
    flagParam('param.jitter', 'Jitter telemetry', 'jitter', {
      hint: 'Reloads — needs boot-time sim instrumentation',
      keywords: 'perf smoothness reload',
    }),

    // ---- Actions (one-shot) ----
    action('action.respawn', 'Respawn player', dispatchRespawn, {
      hint: 'Reset to start pose · Backspace',
      keywords: 'reset start',
    }),
    action('action.copycam', 'Copy camera pose', () => copyCameraPose(deps.camera), {
      hint: 'CameraPose JSON → clipboard (for setCameraPose)',
      keywords: 'screenshot framing clipboard',
    }),
    action('action.perfcsv', 'Download perf CSV', () => hv()?.perf?.downloadCsv(), {
      hint: 'Rolling frame-time window → .csv',
      keywords: 'performance export',
    }),
    action('action.qabundle', 'Download bug bundle', () => hv()?.qa?.downloadBundle(), {
      hint: 'Console trap + state snapshot → .json',
      keywords: 'qa repro report',
    }),
    action('action.resettuning', 'Reset input/feel tuning', () => resetDevSettings(), {
      hint: 'Restore dev-settings defaults',
      keywords: 'default revert',
    }),
  ]
}
