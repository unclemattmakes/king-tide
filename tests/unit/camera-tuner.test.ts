/**
 * @vitest-environment jsdom
 *
 * Chase-camera tuner (`?camtune=1`) — verifies the dev overlay mounts and its
 * sliders actually drive the shared CHASE_CAM_TUNING object (and camera.fov),
 * which is the whole point of the tool. Pure jsdom — no WebGPU / no renderer.
 *
 * CHASE_CAM_TUNING is a shared module singleton, so every test restores it to
 * the frozen baseline + clears localStorage afterwards; otherwise a mutation
 * here would leak into the chase-camera framing tests.
 */
import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCameraTuner } from '../../src/boot/camera-tuner'
import { CHASE_CAM_BASELINE, CHASE_CAM_TUNING } from '../../src/engine/render/camera'

function restoreTuning(): void {
  Object.assign(CHASE_CAM_TUNING, CHASE_CAM_BASELINE)
  try {
    window.localStorage.removeItem('hoverbike.cameraTuning.v1')
  } catch {
    // no storage in this env — nothing to clear.
  }
}

/** Nth range slider in the panel, or a hard failure (keeps the tests free of
 *  non-null assertions while still pinpointing a missing control). */
function nthRange(i: number): HTMLInputElement {
  const panel = document.getElementById('camtune-panel')
  if (!panel) throw new Error('camtune panel not mounted')
  const ranges = panel.querySelectorAll<HTMLInputElement>('input[type=range]')
  const el = ranges[i]
  if (!el) throw new Error(`no range slider at index ${i}`)
  return el
}

function setSlider(i: number, value: number): void {
  const el = nthRange(i)
  el.value = String(value)
  el.dispatchEvent(new Event('input'))
}

function newCamera(): THREE.PerspectiveCamera {
  return new THREE.PerspectiveCamera(62, 1, 0.1, 100)
}

// Field order mirrors FIELDS in camera-tuner.ts.
const I_OFFSET_X = 0
const I_OFFSET_Y = 1
const I_OFFSET_Z = 2
const I_FOV = 8

describe('createCameraTuner', () => {
  beforeEach(restoreTuning)
  afterEach(() => {
    for (const el of document.querySelectorAll('#camtune-panel, #camtune-style')) el.remove()
    restoreTuning()
  })

  it('mounts a panel with a slider per tunable field', () => {
    createCameraTuner(newCamera())
    const panel = document.getElementById('camtune-panel')
    expect(panel).not.toBeNull()
    // offset xyz + look xyz + pivot + damping + fov = 9 sliders.
    expect(panel?.querySelectorAll('input[type=range]')).toHaveLength(9)
  })

  it('a slider edit writes through to CHASE_CAM_TUNING live', () => {
    createCameraTuner(newCamera())
    setSlider(I_OFFSET_Y, 3.4)
    expect(CHASE_CAM_TUNING.offsetY).toBeCloseTo(3.4, 5)
  })

  it('the FOV slider writes through to camera.fov', () => {
    const cam = newCamera()
    createCameraTuner(cam)
    setSlider(I_FOV, 74)
    expect(cam.fov).toBeCloseTo(74, 5)
  })

  it('restores the dialed-in look from localStorage on the next mount', () => {
    const tuner = createCameraTuner(newCamera())
    setSlider(I_OFFSET_Z, -8.5)
    // Simulate a reload: tear the tuner down and wipe the in-memory tuning,
    // leaving only the localStorage blob behind.
    tuner.dispose()
    Object.assign(CHASE_CAM_TUNING, CHASE_CAM_BASELINE)

    createCameraTuner(newCamera())
    expect(CHASE_CAM_TUNING.offsetZ).toBeCloseTo(-8.5, 5)
  })

  it('Reset returns every field to the shipped baseline', () => {
    createCameraTuner(newCamera())
    setSlider(I_OFFSET_X, 5)
    expect(CHASE_CAM_TUNING.offsetX).toBe(5)

    const resetBtn = Array.from(document.querySelectorAll('#camtune-panel button')).find(
      (b) => b.textContent === 'Reset',
    )
    if (!resetBtn) throw new Error('Reset button not found')
    ;(resetBtn as HTMLButtonElement).click()
    expect(CHASE_CAM_TUNING.offsetX).toBe(CHASE_CAM_BASELINE.offsetX)
  })

  it('dispose() removes the panel and its styles', () => {
    const tuner = createCameraTuner(newCamera())
    tuner.dispose()
    expect(document.getElementById('camtune-panel')).toBeNull()
    expect(document.getElementById('camtune-style')).toBeNull()
  })
})
