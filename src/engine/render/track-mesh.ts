import * as THREE from 'three'
import { sampleHeight, type WaveFieldState } from '@/engine/sim/water/wave-field'
import { gateFloatsOnWaves } from '@/game/tracks/gate-float'
import type { AntiGravZone, BoostPad, Checkpoint, Track } from '@/game/tracks/types'
import { createInstancedGates, type InstancedGates } from './instanced-gates'

export type TrackVisuals = {
  group: THREE.Object3D
  setCheckpointState(index: number, state: CheckpointVisualState): void
  /** Per-frame: bob floating gates (track `floatGates`, gates over water)
   *  onto the wave surface. No-op when the track has none. Call after the
   *  wave field has advanced for the frame. */
  tick(waveField: WaveFieldState): void
  dispose(): void
}

export type CheckpointVisualState = 'upcoming' | 'next' | 'passed'

const COLORS = {
  upcoming: 0x4d6b7a,
  next: 0xff9933,
  passed: 0x44cc88,
}

export type TrackVisualsOptions = {
  /** Pre-loaded `prop_gate_mesh` from `public/assets/props/gate.glb`,
   *  authored in Blender's `tracks-src/props-library.blend`. When
   *  provided, every gate clones this mesh — placement matches what
   *  the Blender N-panel gate-preview gizmo shows because both
   *  surfaces share the same source mesh + the same JSON-driven
   *  position/rotation. When `null` (or the asset failed to load),
   *  gates fall back to the procedural Cylinder + Box geometry so
   *  legacy / fresh-checkout builds still render. */
  gatePropTemplate?: THREE.Object3D | null
}

export function createTrackVisuals(track: Track, options: TrackVisualsOptions = {}): TrackVisuals {
  const group = new THREE.Group()
  group.name = `track:${track.id}`

  const gatePropTemplate = options.gatePropTemplate ?? null
  // Gates that bob on the swell (track opted into `floatGates` + this gate sits
  // over water). Each frame `tick` drives their Y onto the wave surface; the
  // authored Y is the rest height. Empty → tick is a no-op.
  const floatingGates: { index: number; x: number; y: number; z: number }[] = []
  for (const cp of track.checkpoints) {
    if (gateFloatsOnWaves(track, cp)) {
      floatingGates.push({ index: cp.index, x: cp.position.x, y: cp.position.y, z: cp.position.z })
    }
  }

  // Library-mesh path: the whole gate set draws through ONE InstancedMesh (shared
  // painterly-vinyl material, per-instance state colour + next-gate glow). The
  // procedural-fallback path (no `gate.glb` yet) keeps per-gate primitive clones.
  let instancedGates: InstancedGates | null = null
  const proceduralGates = new Map<number, GateMesh>()

  if (gatePropTemplate) {
    instancedGates = createInstancedGates(track.checkpoints, gatePropTemplate)
    group.add(instancedGates.group)
    for (const cp of track.checkpoints) {
      if (cp.index === 0) {
        // The start/finish gate's checkered banner + ground stripe are unique
        // (one gate), so they stay as their own meshes alongside the instanced arch.
        const fx = createFinishExtras(cp)
        fx.position.set(cp.position.x, cp.position.y, cp.position.z)
        fx.quaternion.set(cp.rotation.x, cp.rotation.y, cp.rotation.z, cp.rotation.w)
        group.add(fx)
      }
      instancedGates.setState(cp.index, cp.index === 0 ? 'next' : 'upcoming')
    }
  } else {
    for (const cp of track.checkpoints) {
      const gate = createGateMesh(cp, cp.index === 0)
      gate.root.position.set(cp.position.x, cp.position.y, cp.position.z)
      gate.root.quaternion.set(cp.rotation.x, cp.rotation.y, cp.rotation.z, cp.rotation.w)
      group.add(gate.root)
      proceduralGates.set(cp.index, gate)
    }
    for (const cp of track.checkpoints) {
      setStateOn(proceduralGates.get(cp.index) as GateMesh, cp.index === 0 ? 'next' : 'upcoming')
    }
  }

  for (const pad of track.boostPads) {
    group.add(createBoostPadMesh(pad, track.water?.height ?? 0))
  }

  for (const zone of track.antiGravZones) {
    group.add(createAntiGravZoneMesh(zone))
  }

  function setCheckpointState(index: number, state: CheckpointVisualState) {
    if (instancedGates) {
      instancedGates.setState(index, state)
      return
    }
    const gate = proceduralGates.get(index)
    if (gate) setStateOn(gate, state)
  }

  function tick(waveField: WaveFieldState) {
    if (floatingGates.length === 0) return
    // y = authoredY + (surface − meanLevel): a gate on the water rides the swell;
    // the trigger (race.ts) stays static and is widened instead.
    for (const g of floatingGates) {
      const y = g.y + sampleHeight(waveField, g.x, g.z) - waveField.baseY
      if (instancedGates) {
        instancedGates.setY(g.index, y)
      } else {
        const gate = proceduralGates.get(g.index)
        if (gate) gate.root.position.y = y
      }
    }
  }

  function dispose() {
    instancedGates?.dispose()
    for (const g of proceduralGates.values()) g.dispose()
  }

  return { group, setCheckpointState, tick, dispose }
}

type GateMesh = {
  root: THREE.Object3D
  recolorables: THREE.Mesh[]
  dispose(): void
}

// Procedural gate — primitive Cylinder posts + Box bar. The fallback path when
// `gate.glb` hasn't been generated yet (fresh checkout / CI before
// `pnpm gen:prop-gate`); the library-mesh path goes through the instanced gates
// in createTrackVisuals.
function createGateMesh(cp: Checkpoint, isFinishLine: boolean): GateMesh {
  const root = new THREE.Group()
  root.name = `gate:${cp.index}`

  const recolorables: THREE.Mesh[] = []
  const ownedGeoms: THREE.BufferGeometry[] = []
  {
    const pillarGeom = new THREE.CylinderGeometry(0.4, 0.4, cp.height, 12)
    ownedGeoms.push(pillarGeom)
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x4d6b7a, emissive: 0x000000 })

    const left = new THREE.Mesh(pillarGeom, pillarMat.clone())
    left.position.set(-cp.halfWidth, cp.height / 2, 0)
    left.castShadow = true
    left.receiveShadow = true
    root.add(left)
    recolorables.push(left)

    const right = new THREE.Mesh(pillarGeom, pillarMat.clone())
    right.position.set(cp.halfWidth, cp.height / 2, 0)
    right.castShadow = true
    right.receiveShadow = true
    root.add(right)
    recolorables.push(right)

    const barGeom = new THREE.BoxGeometry(cp.halfWidth * 2, 0.8, 0.4)
    ownedGeoms.push(barGeom)
    const bar = new THREE.Mesh(barGeom, pillarMat.clone())
    bar.position.set(0, cp.height + 0.4, 0)
    bar.castShadow = true
    bar.receiveShadow = true
    root.add(bar)
    recolorables.push(bar)
  }

  // The start/finish gate gets a checkered banner + ground stripe so it reads as
  // the "finish line" from any approach angle (purely visual — lap completion on
  // cp 0 is identical to any other checkpoint). Shared with the instanced-gate
  // path, which adds the same extras as their own meshes alongside the arch.
  if (isFinishLine) {
    root.add(createFinishExtras(cp))
  }

  // Note: the "next" gate used to also wear a tall glowing beacon column,
  // but the recolor + on-screen direction arrow already make the target
  // gate unmistakable — the beacon was visual noise.

  function dispose() {
    // Geometries are only owned by the procedural-fallback path; the
    // library-mesh path shares geometries across all instances of the
    // gate template, so disposing them here would yank them out from
    // under sibling gates. Materials are cloned per-instance for both
    // paths and need to be released.
    for (const g of ownedGeoms) g.dispose()
    for (const m of recolorables) {
      if (Array.isArray(m.material)) {
        for (const mat of m.material) mat.dispose()
      } else if (m.material) {
        ;(m.material as THREE.Material).dispose()
      }
    }
  }

  return { root, recolorables, dispose }
}

/**
 * Start/finish-line extras (checkered banner + ground stripe + label) in a gate's
 * LOCAL frame — the caller positions the returned group at the gate's
 * pose. Factored out so both the procedural gate and the instanced-gate path
 * render the identical finish dressing.
 */
function createFinishExtras(cp: Checkpoint): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'gate_finish_extras'
  const checker = makeCheckerTexture(16, 4)

  const bannerHeight = 1.6
  const bannerFront = new THREE.Mesh(
    new THREE.PlaneGeometry(cp.halfWidth * 2, bannerHeight),
    new THREE.MeshBasicMaterial({ map: checker, side: THREE.DoubleSide }),
  )
  bannerFront.position.set(0, cp.height - bannerHeight / 2 - 0.4, 0)
  root.add(bannerFront)

  const stripeGeom = new THREE.PlaneGeometry(cp.halfWidth * 2, 1.6)
  stripeGeom.rotateX(-Math.PI / 2)
  const stripe = new THREE.Mesh(
    stripeGeom,
    new THREE.MeshBasicMaterial({
      map: checker,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }),
  )
  // Sit just above the gate's local ground plane so it doesn't z-fight the water.
  stripe.position.set(0, -cp.position.y + 0.05, 0)
  stripe.renderOrder = 1
  root.add(stripe)

  const finishLabel = new THREE.Mesh(
    new THREE.BoxGeometry(cp.halfWidth * 0.6, 0.6, 0.1),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    }),
  )
  finishLabel.position.set(0, cp.height + 1.4, 0)
  root.add(finishLabel)
  return root
}

/**
 * Boost-pad visual — a flat painted "speed strip" sitting on the water
 * surface with forward chevrons marking the boost direction. Replaces the
 * old cyan wireframe placement-gizmo, which read as a stray debug volume in
 * the actual race (it was authored as the editor's placement-confirmation
 * box back when boost wasn't wired). The catch volume itself stays
 * invisible; the strip just marks where to ride. `boostPadSystem` applies
 * the speed-up on contact.
 */
function createBoostPadMesh(pad: BoostPad, waterHeight: number): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'boost_pad'
  root.position.set(pad.position.x, pad.position.y, pad.position.z)
  root.quaternion.set(pad.rotation.x, pad.rotation.y, pad.rotation.z, pad.rotation.w)
  // Camera-locked water sorts last and overpaints depthWrite=false
  // transparents — draw the strip after it (see ghost-over-water trap).
  root.renderOrder = 3

  const w = pad.halfWidth * 2
  const d = pad.halfDepth * 2
  // Lay the strip just above the water surface, clamped inside the authored
  // catch volume, so it reads as an on-water marking at a glancing racing
  // angle rather than a box hanging in the air.
  const surfaceLocalY = THREE.MathUtils.clamp(
    waterHeight + 0.12 - pad.position.y,
    -pad.halfHeight,
    pad.halfHeight,
  )

  const WARM = 0xff9a3c // energetic amber — distinct from the gold checkpoint gates
  const BRIGHT = 0xffdca0

  const flat = (gw: number, gd: number): THREE.PlaneGeometry => {
    const g = new THREE.PlaneGeometry(gw, gd)
    g.rotateX(-Math.PI / 2)
    return g
  }

  // Outer glow pad.
  const pad0 = new THREE.Mesh(
    flat(w, d),
    new THREE.MeshBasicMaterial({
      color: WARM,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  pad0.position.y = surfaceLocalY
  root.add(pad0)

  // Brighter core.
  const core = new THREE.Mesh(
    flat(w * 0.72, d * 0.88),
    new THREE.MeshBasicMaterial({
      color: BRIGHT,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  core.position.y = surfaceLocalY + 0.02
  root.add(core)

  // Clean border — 4 edges only (EdgesGeometry, no face diagonals), so it
  // defines the pad without ever reading as a debug wireframe.
  const border = new THREE.LineSegments(
    new THREE.EdgesGeometry(flat(w, d)),
    new THREE.LineBasicMaterial({
      color: WARM,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    }),
  )
  border.position.y = surfaceLocalY + 0.03
  root.add(border)

  // Forward bars (point +Z, the boost direction) — bright cream so the
  // "ride this way, fast" read pops against the amber pad.
  const chevMat = new THREE.MeshBasicMaterial({
    color: 0xfff2dc,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const chevGeom = flat(w * 0.5, d * 0.14)
  for (const offsetZ of [-d * 0.28, 0, d * 0.28]) {
    const c = new THREE.Mesh(chevGeom, chevMat)
    c.position.set(0, surfaceLocalY + 0.04, offsetZ)
    root.add(c)
  }
  return root
}

/**
 * Anti-gravity zone visual — translucent purple box wireframe so drivers
 * can see the section boundary at race time. The actual gravity flip is
 * applied by `antiGravSystem` whenever the bike's center is inside. Kept
 * subtle (low fill opacity) so it doesn't drown out the road geometry.
 */
function createAntiGravZoneMesh(zone: AntiGravZone): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'anti_grav_zone'
  root.position.set(zone.position.x, zone.position.y, zone.position.z)
  root.quaternion.set(zone.rotation.x, zone.rotation.y, zone.rotation.z, zone.rotation.w)

  const w = zone.halfWidth * 2
  const h = zone.halfHeight * 2
  const d = zone.halfDepth * 2

  const fillGeom = new THREE.BoxGeometry(w, h, d)
  const fillMat = new THREE.MeshBasicMaterial({
    color: 0xa066ff,
    transparent: true,
    opacity: 0.08,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  root.add(new THREE.Mesh(fillGeom, fillMat))

  const wireMat = new THREE.LineBasicMaterial({
    color: 0xc8a0ff,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  })
  root.add(new THREE.LineSegments(new THREE.WireframeGeometry(fillGeom), wireMat))

  return root
}

/**
 * Procedural black/white checker texture used on the start/finish gate's
 * banner and ground stripe. Built once per gate; cheap (16×16 canvas).
 */
function makeCheckerTexture(repeats: number, rows: number): THREE.Texture {
  const cellSize = 16
  const width = repeats * cellSize
  const height = rows * cellSize
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < repeats; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#ffffff' : '#111111'
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize)
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

function setStateOn(gate: GateMesh, state: CheckpointVisualState): void {
  const color = COLORS[state]
  for (const m of gate.recolorables) {
    const mat = m.material as THREE.MeshStandardMaterial
    mat.color.setHex(color)
    mat.emissive.setHex(state === 'next' ? color : 0x000000)
    mat.emissiveIntensity = state === 'next' ? 0.6 : 0
  }
}
