/**
 * Step 8 — Performance overlay.
 *
 * Tiny top-right DOM panel that shows live frame-rate stats from
 * `perf-recorder.ts` alongside whatever Three.js's `renderer.info` tells
 * us about the last render call (draw calls, triangles, geometry/texture
 * counts) and the page's JS heap (Chromium-only).
 *
 * Built lazily — the module touches `document` only inside the factory,
 * so it's safe to import from non-DOM contexts (unit tests, headless
 * tooling). The factory appends a single `<div>` to `document.body` and
 * styles it inline; no `index.html` edits needed, no global CSS at risk
 * of being clobbered by track-specific styles. z-index sits above the
 * race HUD pills so the panel reads clearly when both are visible.
 *
 * The HUD does NOT import Three — it consumes a `RenderInfoLite` value
 * pulled from `renderer.info` by the game-loop. This keeps the module
 * trivially unit-testable and matches the rest of `src/engine/render/`
 * where view code lives without sim-layer coupling.
 *
 * Visibility starts off (false) by default; the boot wiring flips it on
 * for `?perf=1` URLs and the global `Backquote` shortcut. `tick()` is
 * cheap when the overlay is hidden — the panel is `display: none` and
 * we early-out before touching textContent.
 */
import type { PerfStats } from '@/engine/perf-recorder'

/** Subset of `THREE.WebGLRenderer['info']` that the HUD reads. Pulled out
 *  so this module doesn't import Three. */
export interface RenderInfoLite {
  render: {
    /** Draw calls submitted on the last render(). */
    calls: number
    /** Triangle count. */
    triangles: number
  }
  memory: {
    geometries: number
    textures: number
  }
}

/** Static environment diagnostics shown at the foot of the panel — set once
 *  at boot, not per frame. Lets an on-device session confirm the active
 *  render backend, the real GPU driver (hardware vs llvmpipe), and whether
 *  the Steam Deck profile actually latched. */
export interface PerfDiagnostics {
  /** 'webgpu' | 'webgl2' — the backend Three actually initialised. */
  backend: string
  /** Unmasked GPU renderer string from `probeGpuRenderer()`. */
  gpu: string
  /** True when `applyDeckProfile()` ran this session. */
  deckApplied: boolean
  /** Detection signals that fired (ua / viewport / gamepad / native). */
  deckSignals: readonly string[]
}

export interface PerfHud {
  /** Render one update. No-op when the HUD is hidden. */
  tick(stats: PerfStats, info: RenderInfoLite): void
  /** Set the static environment rows (backend / GPU / deck profile). Persists
   *  across show/hide toggles — call once after boot. */
  setDiagnostics(d: PerfDiagnostics): void
  /** Show / hide the overlay. Toggling via the backquote shortcut and the
   *  `?perf=1` URL boot path both call into this. */
  setVisible(on: boolean): void
  /** Current visibility state — used by the game-loop to skip the rolling
   *  stats() call when the overlay is off. */
  isVisible(): boolean
  /** Detach from the DOM. */
  dispose(): void
}

interface ChromeMemory {
  usedJSHeapSize?: number
  jsHeapSizeLimit?: number
}

export function createPerfHud(): PerfHud {
  const root = document.createElement('div')
  root.id = 'perf-hud'
  // Inline styles only — the panel is dev/QA chrome that we don't want
  // to wire through the project's main stylesheet. `position: fixed`
  // pins it to the top-right; high z-index so the race HUD's pills
  // don't overlap it.
  root.style.cssText = [
    'position: fixed',
    // Sit below the existing #hud-fps pill at the top-right corner.
    'top: 48px',
    'right: 12px',
    'z-index: 1500',
    'padding: 6px 10px',
    'background: rgba(8, 14, 24, 0.78)',
    'color: rgba(235, 245, 255, 0.95)',
    'font: 11px ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    'line-height: 1.5',
    'border: 1px solid rgba(255, 255, 255, 0.12)',
    'border-radius: 4px',
    'pointer-events: none',
    'white-space: pre',
    'min-width: 260px',
    'text-align: left',
    'display: none',
  ].join(';')

  const fpsRow = document.createElement('div')
  const drawRow = document.createElement('div')
  const heapRow = document.createElement('div')
  // Static env rows — set via setDiagnostics(), allowed to wrap because the
  // GPU driver string can be long. Dimmed slightly: it's reference, not live.
  const bkndRow = document.createElement('div')
  const gpuRow = document.createElement('div')
  gpuRow.style.cssText = 'white-space: normal; opacity: 0.8'
  bkndRow.style.cssText = 'opacity: 0.8'
  root.appendChild(fpsRow)
  root.appendChild(drawRow)
  root.appendChild(heapRow)
  root.appendChild(bkndRow)
  root.appendChild(gpuRow)
  document.body.appendChild(root)

  let visible = false

  function tick(stats: PerfStats, info: RenderInfoLite): void {
    if (!visible) return
    // Row 1: rolling frame-time stats.
    fpsRow.textContent = `FPS   ${stats.fps.toFixed(0).padStart(2)}  · P95 ${stats.p95Ms.toFixed(0)}ms · P99 ${stats.p99Ms.toFixed(0)}ms · HITCH ${stats.hitchCount}`
    // Row 2: GPU-side stats from renderer.info. Three resets render.calls
    // / render.triangles per renderer.render() call but does NOT reset
    // memory.geometries / memory.textures (those are running totals).
    drawRow.textContent = `DRAW  ${info.render.calls}  · TRI ${formatTriangles(info.render.triangles)} · GEO ${info.memory.geometries}  · TEX ${info.memory.textures}`
    // Row 3: JS heap usage. Chromium-only — Firefox / Safari leave
    // `performance.memory` undefined and we show an em-dash instead.
    const mem = (performance as unknown as { memory?: ChromeMemory }).memory
    if (mem?.usedJSHeapSize != null && mem?.jsHeapSizeLimit != null) {
      const usedMb = mem.usedJSHeapSize / (1024 * 1024)
      const limitMb = mem.jsHeapSizeLimit / (1024 * 1024)
      heapRow.textContent = `HEAP  ${usedMb.toFixed(0)} / ${limitMb.toFixed(0)} MB`
    } else {
      heapRow.textContent = 'HEAP  — / — MB'
    }
  }

  function setDiagnostics(d: PerfDiagnostics): void {
    const signals = d.deckSignals.length ? ` (${d.deckSignals.join('+')})` : ''
    bkndRow.textContent = `BKND  ${d.backend} · deck ${d.deckApplied ? 'on' : 'off'}${signals}`
    gpuRow.textContent = `GPU   ${d.gpu}`
  }

  function setVisible(on: boolean): void {
    visible = on
    root.style.display = on ? 'block' : 'none'
  }

  function isVisible(): boolean {
    return visible
  }

  function dispose(): void {
    root.remove()
  }

  return { tick, setDiagnostics, setVisible, isVisible, dispose }
}

/** Compact triangle counts: 1234 → "1k", 384000 → "384k", 1.2M → "1.2M". */
function formatTriangles(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
