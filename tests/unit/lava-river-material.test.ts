/**
 * Lava-river runtime material — pure helpers + scene-swap + setting
 * round-trip.
 *
 * Covers:
 *  - ``mixHotEdge`` ramps the band-edge → hot-core colour bidirectionally,
 *    clamps out-of-band inputs (negative, > 1, NaN), and anchors at the
 *    seed's 0.2 bank-edge mask value.
 *  - ``intensityForSetting`` mirrors ``EMISSIVE_LANDMARKS_SCALAR`` for
 *    every member of the union (no silent fall-through).
 *  - ``applyEmissiveLandmarksSetting`` writes through to the debug-view
 *    intensity (so the in-graph uniform travels with the setting).
 *  - ``applyLavaRiverMaterialToScene`` walks an Object3D tree, swaps
 *    only meshes tagged ``landmark_id === 'lava_river_strip'``, leaves
 *    untagged meshes alone, and disposes the prior material exactly once.
 *  - ``setEmissiveLandmarks`` persists through localStorage along with
 *    the rest of ``playerSettings``.
 */

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAYER_SETTINGS,
  EMISSIVE_LANDMARKS_SCALAR,
  loadPlayerSettings,
  playerSettings,
  setEmissiveLandmarks,
} from '../../src/engine/player-settings'
import {
  applyEmissiveLandmarksSetting,
  applyLavaRiverMaterialToScene,
  buildLavaRiverMaterial,
  debugLavaState,
  intensityForSetting,
  LAVA_BAND_EDGE_RGB,
  LAVA_BANK_EDGE_R,
  LAVA_HOT_CORE_RGB,
  mixHotEdge,
  updateLavaTime,
} from '../../src/engine/render/lava-river-material'

describe('mixHotEdge', () => {
  it('returns the band-edge colour at r = LAVA_BANK_EDGE_R', () => {
    const [r, g, b] = mixHotEdge(LAVA_BANK_EDGE_R)
    expect(r).toBeCloseTo(LAVA_BAND_EDGE_RGB[0], 6)
    expect(g).toBeCloseTo(LAVA_BAND_EDGE_RGB[1], 6)
    expect(b).toBeCloseTo(LAVA_BAND_EDGE_RGB[2], 6)
  })

  it('returns the hot-core colour at r = 1', () => {
    const [r, g, b] = mixHotEdge(1)
    expect(r).toBeCloseTo(LAVA_HOT_CORE_RGB[0], 6)
    expect(g).toBeCloseTo(LAVA_HOT_CORE_RGB[1], 6)
    expect(b).toBeCloseTo(LAVA_HOT_CORE_RGB[2], 6)
  })

  it('interpolates monotonically between the two anchors', () => {
    const midR = (LAVA_BANK_EDGE_R + 1) / 2
    const [er] = mixHotEdge(LAVA_BANK_EDGE_R)
    const [mr] = mixHotEdge(midR)
    const [hr] = mixHotEdge(1)
    expect(mr).toBeGreaterThan(er)
    expect(hr).toBeGreaterThan(mr)
  })

  it('clamps inputs below the bank-edge to the band-edge colour', () => {
    expect(mixHotEdge(0)).toEqual(mixHotEdge(LAVA_BANK_EDGE_R))
    expect(mixHotEdge(-5)).toEqual(mixHotEdge(LAVA_BANK_EDGE_R))
  })

  it('clamps inputs above 1 to the hot-core colour', () => {
    expect(mixHotEdge(1)).toEqual(mixHotEdge(2.5))
  })

  it('falls back to the band-edge colour on non-finite input', () => {
    const [r] = mixHotEdge(Number.NaN)
    expect(r).toBeCloseTo(LAVA_BAND_EDGE_RGB[0], 6)
  })
})

describe('intensityForSetting', () => {
  it('mirrors EMISSIVE_LANDMARKS_SCALAR for every named setting', () => {
    expect(intensityForSetting('full')).toBe(EMISSIVE_LANDMARKS_SCALAR.full)
    expect(intensityForSetting('reduced')).toBe(EMISSIVE_LANDMARKS_SCALAR.reduced)
    expect(intensityForSetting('off')).toBe(EMISSIVE_LANDMARKS_SCALAR.off)
  })

  it('orders full > reduced > off (off is a true bypass)', () => {
    expect(EMISSIVE_LANDMARKS_SCALAR.full).toBeGreaterThan(EMISSIVE_LANDMARKS_SCALAR.reduced)
    expect(EMISSIVE_LANDMARKS_SCALAR.reduced).toBeGreaterThan(0)
    expect(EMISSIVE_LANDMARKS_SCALAR.off).toBe(0)
  })
})

describe('applyEmissiveLandmarksSetting', () => {
  it('writes through to the debug intensity reader', () => {
    applyEmissiveLandmarksSetting('reduced')
    expect(debugLavaState().intensity).toBe(EMISSIVE_LANDMARKS_SCALAR.reduced)
    applyEmissiveLandmarksSetting('off')
    expect(debugLavaState().intensity).toBe(0)
    applyEmissiveLandmarksSetting('full')
    expect(debugLavaState().intensity).toBe(EMISSIVE_LANDMARKS_SCALAR.full)
  })
})

describe('updateLavaTime', () => {
  it('writes through to the debug time reader', () => {
    updateLavaTime(0)
    expect(debugLavaState().timeSeconds).toBe(0)
    updateLavaTime(12.5)
    expect(debugLavaState().timeSeconds).toBe(12.5)
  })

  it('silently ignores non-finite input', () => {
    updateLavaTime(7)
    updateLavaTime(Number.NaN)
    expect(debugLavaState().timeSeconds).toBe(7)
    updateLavaTime(Number.POSITIVE_INFINITY)
    expect(debugLavaState().timeSeconds).toBe(7)
  })
})

describe('applyLavaRiverMaterialToScene', () => {
  function lavaMesh(): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial())
    mesh.userData = { landmark_id: 'lava_river_strip', kind: 'track' }
    return mesh
  }

  function plainMesh(): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial())
    mesh.userData = { kind: 'track' }
    return mesh
  }

  it('swaps the material on every lava-tagged mesh', () => {
    const root = new THREE.Group()
    const lava1 = lavaMesh()
    const lava2 = lavaMesh()
    const plain = plainMesh()
    root.add(lava1, lava2, plain)

    const count = applyLavaRiverMaterialToScene(root, 'full')
    expect(count).toBe(2)
    expect((lava1.material as THREE.Material).name).toBe('mat_lava_river')
    expect((lava2.material as THREE.Material).name).toBe('mat_lava_river')
    expect((plain.material as THREE.Material).name).not.toBe('mat_lava_river')
  })

  it("doesn't touch meshes tagged with a different landmark_id", () => {
    const root = new THREE.Group()
    const otherLandmark = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial(),
    )
    otherLandmark.userData = { landmark_id: 'tower_cylinder_spiral', kind: 'track' }
    root.add(otherLandmark)
    expect(applyLavaRiverMaterialToScene(root, 'full')).toBe(0)
    expect((otherLandmark.material as THREE.Material).name).not.toBe('mat_lava_river')
  })

  it('still swaps when setting is off (intensity uniform handles zeroing)', () => {
    const root = new THREE.Group()
    const lava = lavaMesh()
    root.add(lava)
    const count = applyLavaRiverMaterialToScene(root, 'off')
    expect(count).toBe(1)
    expect((lava.material as THREE.Material).name).toBe('mat_lava_river')
    expect(debugLavaState().intensity).toBe(0)
  })

  it('disposes the prior material on swap', () => {
    const root = new THREE.Group()
    const lava = lavaMesh()
    const priorMat = lava.material as THREE.Material
    let disposed = 0
    priorMat.dispose = () => {
      disposed += 1
    }
    root.add(lava)
    applyLavaRiverMaterialToScene(root, 'full')
    expect(disposed).toBe(1)
  })
})

describe('buildLavaRiverMaterial', () => {
  it('returns a MeshStandardNodeMaterial with the canonical name', () => {
    const m = buildLavaRiverMaterial()
    expect(m.name).toBe('mat_lava_river')
    expect(m.metalness).toBe(0)
    // Node-material wraps roughness through the node graph; the
    // numeric property still reflects the constructor option as long
    // as no roughnessNode is set.
    expect(m.roughness).toBeCloseTo(0.85, 6)
  })
})

describe('setEmissiveLandmarks', () => {
  it('round-trips via localStorage with the other player settings', () => {
    if (typeof window === 'undefined' || !window.localStorage) return
    try {
      window.localStorage.removeItem('hoverbike.playerSettings.v2')
      setEmissiveLandmarks('reduced')
      expect(playerSettings.emissiveLandmarks).toBe('reduced')
      // Wipe in-memory + reload from storage.
      playerSettings.emissiveLandmarks = 'full'
      loadPlayerSettings()
      expect(playerSettings.emissiveLandmarks).toBe('reduced')
    } finally {
      playerSettings.emissiveLandmarks = DEFAULT_PLAYER_SETTINGS.emissiveLandmarks
      window.localStorage.removeItem('hoverbike.playerSettings.v2')
    }
  })
})
