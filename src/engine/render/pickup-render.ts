import { query } from 'bitecs'
import * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import {
  PickupSpawnState,
  PickupSpawnStateStore,
  PickupSpawnTag,
  type PickupType,
} from '@/game/components/pickup'
import { createPickupBoxMesh } from './pickup-mesh'
import { SIGNAL_COLORS } from './signal-colors'
import { signalsEnabled } from './signal-state'

type PickupBox = {
  mesh: THREE.Object3D
  type: PickupType
  /** Emissive materials inside this box, captured once so the signal pulse can
   *  drive them without re-walking the tree each frame. */
  emissives: THREE.MeshStandardMaterial[]
  /** Each captured material's baseline `{ emissive, emissiveIntensity }`, so the
   *  signal pulse is fully reversible — restored the instant the master flag goes
   *  off, leaving today's look byte-identical. */
  baseline: Array<{ color: THREE.Color; intensity: number }>
  /** True while the box is currently showing the magenta signal pulse, so we only
   *  restore the baseline once on the off-transition. */
  signalled: boolean
}

/** The reserved "collectible available" signal (magenta) + its pulse motion —
 *  see signal-colors.ts. Linear-space colour, fed straight to `emissive`. */
const PICKUP_SIGNAL = SIGNAL_COLORS.pickup
/** Pulse shaping: emissive intensity swings between these (sine) so an available
 *  pickup throbs magenta — the `pulse` motion the vocabulary pairs with `pickup`,
 *  readable in peripheral vision. */
const PICKUP_PULSE_MIN = 0.55
const PICKUP_PULSE_MAX = 1.5
const PICKUP_PULSE_HZ = 2.2

/**
 * Renders pickup spawn boxes — visible only while `active`. Each box rotates
 * for visibility. When a spawn refills with a different pickup type the
 * mesh is rebuilt so the color matches.
 *
 * Style-as-legibility (B1, default-OFF): when the signal master flag is on
 * (`?signals=1`), an available box also PULSES the reserved pickup magenta on its
 * emissive — the "collectible available" cue, double-coded colour + pulse motion.
 * With the flag off the box materials are never touched, so the look is identical
 * to today; flipping the flag off live restores each captured baseline.
 */
export function createPickupRenderSystem(scene: THREE.Scene, sim: SimWorld) {
  const boxes = new Map<number, PickupBox>()
  // Reused per-frame scratch for the live-eids reconciliation set.
  const live = new Set<number>()
  let timeAccum = 0

  /** Capture the emissive materials + baselines inside a freshly built box. */
  function captureEmissives(mesh: THREE.Object3D): Pick<PickupBox, 'emissives' | 'baseline'> {
    const emissives: THREE.MeshStandardMaterial[] = []
    const baseline: Array<{ color: THREE.Color; intensity: number }> = []
    mesh.traverse((obj) => {
      const m = (obj as THREE.Mesh).material
      const mat = Array.isArray(m) ? m[0] : m
      if (mat instanceof THREE.MeshStandardMaterial) {
        emissives.push(mat)
        baseline.push({ color: mat.emissive.clone(), intensity: mat.emissiveIntensity })
      }
    })
    return { emissives, baseline }
  }

  /** Restore a box's captured emissive baseline (the off / today's-look state). */
  function restoreBaseline(box: PickupBox): void {
    for (let k = 0; k < box.emissives.length; k++) {
      const mat = box.emissives[k]
      const base = box.baseline[k]
      if (!mat || !base) continue
      mat.emissive.copy(base.color)
      mat.emissiveIntensity = base.intensity
    }
    box.signalled = false
  }

  return function tick(dt: number): void {
    timeAccum += dt
    const eids = query(sim, [PickupSpawnTag, PickupSpawnState])
    live.clear()
    // Sine pulse in [PULSE_MIN, PULSE_MAX]; shared across all boxes so they throb
    // in unison (one learned rhythm for "available").
    const pulse =
      PICKUP_PULSE_MIN +
      (PICKUP_PULSE_MAX - PICKUP_PULSE_MIN) *
        (0.5 + 0.5 * Math.sin(timeAccum * Math.PI * 2 * PICKUP_PULSE_HZ))
    const signalsOn = signalsEnabled()
    for (const eid of eids) {
      live.add(eid)
      const s = PickupSpawnStateStore.must(eid)
      let box = boxes.get(eid)
      if (!box || box.type !== s.nextType) {
        if (box) scene.remove(box.mesh)
        const mesh = createPickupBoxMesh(s.nextType)
        mesh.position.set(s.position.x, s.position.y, s.position.z)
        scene.add(mesh)
        box = { mesh, type: s.nextType, ...captureEmissives(mesh), signalled: false }
        boxes.set(eid, box)
      }
      box.mesh.visible = s.active
      box.mesh.rotation.y = timeAccum * 1.6

      // Signal pulse — only while the master flag is on AND the box is collectible
      // (active + visible). Paint the reserved magenta on emissive and throb the
      // intensity. When the flag (or availability) turns off, restore the baseline
      // exactly once so the box returns to today's look.
      if (signalsOn && s.active) {
        for (const mat of box.emissives) {
          mat.emissive.copy(PICKUP_SIGNAL.color)
          mat.emissiveIntensity = pulse
        }
        box.signalled = true
      } else if (box.signalled) {
        restoreBaseline(box)
      }
    }
    for (const [eid, box] of boxes) {
      if (!live.has(eid)) {
        scene.remove(box.mesh)
        boxes.delete(eid)
      }
    }
  }
}
