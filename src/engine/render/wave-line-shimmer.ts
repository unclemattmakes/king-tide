/**
 * Wave-line shimmer — forward-looking visual signal showing where
 * pumpable wave crests are in front of the player. The signal half is
 * already shipped (wave-pump after-the-fact HUD + audio); this module
 * is the *predictive* counterpart: glowing cyan markers on the water
 * surface in a fan ahead of the bike, brighter where the wave is
 * rising fastest.
 *
 * Lives in the render layer — pure read of the wave field, never
 * touches sim or physics. The wave field's `sampleSurface` returns the
 * surface y plus its time derivative vy at any world-XZ. We sample a
 * forward fan each frame, map each sample's vy through `scorePumpability`,
 * and update a pool of additive-blended sprites with size + opacity
 * driven by the score. The pool size is fixed at construct time so
 * there are no per-frame allocations once warmed.
 *
 * Settings → Gameplay → "Wave-line guidance" (Full / Subtle / Off):
 *
 *   - `full`:   full glow, bigger markers, brighter ring, faster pulse
 *   - `subtle`: thinner markers, smaller, slower pulse, fewer visible
 *   - `off`:    group hidden, tick() early-returns
 */

import * as THREE from 'three'
import { playerSettings } from '@/engine/player-settings'
import { sampleSurface, type WaveFieldState } from '@/engine/sim/water/wave-field'
import {
  buildSampleFan,
  DEFAULT_FAN_CONFIG,
  type FanConfig,
  makeFanBuffer,
  type SampleSlot,
  scorePumpability,
} from './wave-line-scoring'

export interface WaveLineShimmer {
  /** The Object3D to add to the scene once. */
  mesh: THREE.Object3D
  tick(
    waveField: WaveFieldState,
    playerPos: THREE.Vector3,
    playerQuat: THREE.Quaternion,
    dt: number,
  ): void
  /** Highest score observed across the fan on the most recent tick.
   *  0 when no marker is lit. The HUD pip uses this to decide whether
   *  to flash the "WAVE LINE LOCK" status. */
  currentMaxScore(): number
  dispose(): void
}

/** Score below which a marker is hidden — keeps the field clean of
 *  faint shimmer over flat water. Tuned so a tame Gerstner setup with
 *  ~0.2 m/s vy crests stays inert; pumpable swells pop above instantly. */
const SCORE_THRESHOLD = 0.12

/** Vertical lift in meters of the marker above the sampled surface y.
 *  Just enough that the additive sprite doesn't z-fight with the
 *  water mesh — too high reads as a floating pad rather than a glow
 *  on the surface itself. */
const SURFACE_LIFT = 0.04

/** Plane scale at score = 1, full mode. Subtle mode scales this down. */
const FULL_MARKER_SIZE = 3.6

/** Visual config per intensity. Both knobs feed the per-marker tick. */
type IntensityVisual = {
  sizeScale: number
  opacityScale: number
  pulseSpeed: number
}
const FULL_VISUAL: IntensityVisual = { sizeScale: 1, opacityScale: 1, pulseSpeed: 3.4 }
const SUBTLE_VISUAL: IntensityVisual = { sizeScale: 0.55, opacityScale: 0.55, pulseSpeed: 2.1 }

export function createWaveLineShimmer(config: FanConfig = DEFAULT_FAN_CONFIG): WaveLineShimmer {
  const group = new THREE.Group()
  group.name = 'wave-line-shimmer'
  // Render after the water so additive blending mixes against the
  // already-painted surface. Slightly higher than props but below the
  // direction arrow (999) so the arrow is never visually overpainted
  // by the shimmer.
  group.renderOrder = 5
  group.visible = false

  const tex = buildShimmerTexture()
  const material = new THREE.MeshBasicMaterial({
    map: tex,
    color: new THREE.Color(0x6ee7ff),
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  // Shared geometry; per-marker scale is on the mesh transform.
  const geom = new THREE.PlaneGeometry(1, 1)

  const fan = makeFanBuffer(config)
  const total = fan.length
  const meshes: THREE.Mesh[] = []
  for (let i = 0; i < total; i++) {
    const m = new THREE.Mesh(geom, material)
    m.rotation.x = -Math.PI / 2 // lay flat on the XZ plane
    m.visible = false
    m.renderOrder = group.renderOrder
    meshes.push(m)
    group.add(m)
  }

  // Per-marker phase offset (radians). Spread evenly so the field
  // shimmers with a wave rather than every marker pulsing in unison.
  const phaseOffsets: number[] = new Array(total)
  for (let i = 0; i < total; i++) phaseOffsets[i] = (i / Math.max(1, total - 1)) * Math.PI * 2

  let pulseT = 0
  let lastMaxScore = 0
  const forward = new THREE.Vector3()
  const FORWARD_LOCAL = new THREE.Vector3(0, 0, 1) // bike +Z is forward
  const origin = { x: 0, z: 0 }

  function tick(
    waveField: WaveFieldState,
    playerPos: THREE.Vector3,
    playerQuat: THREE.Quaternion,
    dt: number,
  ): void {
    const mode = playerSettings.waveLineIntensity
    if (mode === 'off') {
      hideAll()
      lastMaxScore = 0
      group.visible = false
      return
    }
    const vis = mode === 'subtle' ? SUBTLE_VISUAL : FULL_VISUAL
    pulseT += dt * vis.pulseSpeed
    group.visible = true

    // Forward heading in the XZ plane. We flatten the player quat so
    // the fan doesn't tilt with bike roll/pitch — the shimmer is a
    // map-space guide, not a roll-with-the-bike effect.
    forward.copy(FORWARD_LOCAL).applyQuaternion(playerQuat)
    forward.y = 0
    const fwdLen = forward.length()
    if (fwdLen < 1e-3) {
      // Player nearly vertical (loop or fall) — hide rather than
      // sample along a degenerate direction.
      hideAll()
      lastMaxScore = 0
      return
    }
    forward.divideScalar(fwdLen)

    origin.x = playerPos.x
    origin.z = playerPos.z
    buildSampleFan(fan, origin, forward.x, forward.z, config)

    let maxScore = 0
    for (let i = 0; i < total; i++) {
      const s: SampleSlot | undefined = fan[i]
      const mesh = meshes[i]
      if (!s || !mesh) continue
      const surf = sampleSurface(waveField, s.x, s.z)
      const score = scorePumpability(surf.vy)
      if (score < SCORE_THRESHOLD) {
        mesh.visible = false
        continue
      }
      if (score > maxScore) maxScore = score
      // Per-marker pulse so the shimmer feels alive even on a static
      // wave field. 0.7..1.0 multiplier — never fully snuffs the marker.
      const phase = phaseOffsets[i] ?? 0
      const pulse = 0.7 + 0.3 * Math.sin(pulseT + phase)
      const size = FULL_MARKER_SIZE * vis.sizeScale * (0.6 + 0.5 * score) * pulse
      mesh.visible = true
      mesh.position.set(s.x, surf.y + SURFACE_LIFT, s.z)
      mesh.scale.set(size, size, size)
      // material.opacity is shared — but we don't want every marker to
      // share opacity; instead bake the per-marker fade into scale +
      // pulse. The material stays at its peak opacity scalar so the
      // additive blend is dominated by the size envelope.
      // (Keeping material immutable also avoids the per-frame setter
      // cost on a single shared MeshBasicMaterial.)
    }

    // Apply the per-intensity opacity scale to the shared material.
    // Subtle dims everything by half; full keeps it full bright.
    if (material.opacity !== vis.opacityScale) {
      material.opacity = vis.opacityScale
      material.needsUpdate = true
    }

    lastMaxScore = maxScore
  }

  function hideAll(): void {
    for (const m of meshes) m.visible = false
  }

  function dispose(): void {
    hideAll()
    group.visible = false
    geom.dispose()
    material.dispose()
    tex.dispose()
  }

  return { mesh: group, tick, currentMaxScore: () => lastMaxScore, dispose }
}

/** Procedural soft radial gradient with a bright ring at r≈0.7 —
 *  reads as a flat disc with an emphasis halo. RGBA8 64×64 is
 *  plenty for additive shimmer; the bilinear filter smooths it. */
function buildShimmerTexture(): THREE.DataTexture {
  const N = 64
  const data = new Uint8Array(N * N * 4)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x + 0.5 - N / 2) / (N / 2)
      const dy = (y + 0.5 - N / 2) / (N / 2)
      const r = Math.min(1, Math.hypot(dx, dy))
      const inner = Math.max(0, 1 - r) // smooth fade to edge
      // Gaussian ring centered at r=0.7
      const ring = Math.exp(-((r - 0.7) ** 2) / 0.04)
      const a = Math.max(0, Math.min(1, inner * 0.7 + ring * 0.7))
      const i = (y * N + x) * 4
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = Math.round(a * 255)
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.needsUpdate = true
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}
