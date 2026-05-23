/**
 * Pure helper-mesh factories used by the track editor. Each function
 * takes plain entity data and returns a self-contained THREE.Group with
 * a `userData.setSelected(v: boolean)` callback so the editor can
 * re-tint markers without rebuilding geometry.
 *
 * Extracted from `track-editor.ts` so the orchestration file stays
 * focused on state + gizmo + I/O. None of these functions touch the
 * editor closure.
 */

import * as THREE from 'three'
import { AI_GRID_SLOTS } from '@/boot/grid-offsets'
import { buildPropGeometry } from '@/engine/render/props-geometry'
import type { Vec3 } from '@/engine/sim/physics/vec'
import type { AntiGravZone, BoostPad, Checkpoint, Prop, PropType } from '@/game/tracks/types'

export function makeGateHelper(cp: Checkpoint, selected: boolean): THREE.Group {
  const g = new THREE.Group()
  g.position.set(cp.position.x, cp.position.y, cp.position.z)
  g.quaternion.set(cp.rotation.x, cp.rotation.y, cp.rotation.z, cp.rotation.w)
  // helper.scale stays (1,1,1) — geometry is built at the entity's real
  // dims so the gizmo's scale gestures are intuitive (drag = stretch).

  const baseColor = 0xff7733
  const selColor = 0xffcc66
  const mat = new THREE.MeshBasicMaterial({
    color: selected ? selColor : baseColor,
    transparent: true,
    opacity: 0.9,
  })

  const pillarGeom = new THREE.CylinderGeometry(0.5, 0.5, cp.height, 8)
  const left = new THREE.Mesh(pillarGeom, mat)
  left.position.set(-cp.halfWidth, cp.height / 2, 0)
  g.add(left)
  const right = new THREE.Mesh(pillarGeom, mat.clone())
  right.position.set(cp.halfWidth, cp.height / 2, 0)
  g.add(right)
  const barGeom = new THREE.BoxGeometry(cp.halfWidth * 2, 0.5, 0.4)
  const bar = new THREE.Mesh(barGeom, mat.clone())
  bar.position.set(0, cp.height + 0.25, 0)
  g.add(bar)
  // Forward arrow — small triangle pointing +Z to show gate orientation.
  const arrowGeom = new THREE.ConeGeometry(0.7, 1.4, 4)
  arrowGeom.rotateX(Math.PI / 2) // cone tip toward +Z
  const arrow = new THREE.Mesh(arrowGeom, mat.clone())
  arrow.position.set(0, 0.7, 1.2)
  g.add(arrow)

  g.userData.setSelected = (v: boolean) => {
    g.traverse((c) => {
      const m = (c as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined
      if (m) m.color.setHex(v ? selColor : baseColor)
    })
  }
  return g
}

export function makePickupHelper(
  p: { x: number; y: number; z: number },
  selected: boolean,
): THREE.Group {
  const g = new THREE.Group()
  g.position.set(p.x, p.y, p.z)
  const baseColor = 0xffaa00
  const selColor = 0xffff66
  const mat = new THREE.MeshBasicMaterial({
    color: selected ? selColor : baseColor,
    transparent: true,
    opacity: 0.9,
  })
  const m = new THREE.Mesh(new THREE.SphereGeometry(1.0, 14, 10), mat)
  g.add(m)
  g.userData.setSelected = (v: boolean) => {
    mat.color.setHex(v ? selColor : baseColor)
  }
  return g
}

export function makePadHelper(pad: BoostPad, selected: boolean): THREE.Group {
  const g = new THREE.Group()
  g.position.set(pad.position.x, pad.position.y, pad.position.z)
  g.quaternion.set(pad.rotation.x, pad.rotation.y, pad.rotation.z, pad.rotation.w)

  const baseColor = 0x33ddff
  const selColor = 0x99ffff
  const w = pad.halfWidth * 2
  const h = pad.halfHeight * 2
  const d = pad.halfDepth * 2

  // Wireframe + faint fill matching the trigger volume. Same model as
  // the runtime mesh — kept separate so the editor can swap color on
  // selection without touching the play-mode mesh.
  const fillMat = new THREE.MeshBasicMaterial({
    color: selected ? selColor : baseColor,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const boxGeom = new THREE.BoxGeometry(w, h, d)
  g.add(new THREE.Mesh(boxGeom, fillMat))

  const wireMat = new THREE.LineBasicMaterial({
    color: selected ? selColor : baseColor,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  })
  g.add(new THREE.LineSegments(new THREE.WireframeGeometry(boxGeom), wireMat))

  // Direction arrow pointing +Z (boost direction), sitting on the bottom
  // interior face.
  const arrowGeom = new THREE.ConeGeometry(0.6, 1.2, 4)
  arrowGeom.rotateX(Math.PI / 2)
  const arrow = new THREE.Mesh(
    arrowGeom,
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
  )
  arrow.position.set(0, -pad.halfHeight + 0.6, d * 0.3)
  g.add(arrow)

  g.userData.setSelected = (v: boolean) => {
    fillMat.color.setHex(v ? selColor : baseColor)
    wireMat.color.setHex(v ? selColor : baseColor)
  }
  return g
}

/**
 * Anti-grav zone helper. Translucent purple box with an up-arrow showing
 * the zone's local +Y (the "up" direction gravity points away from while
 * a bike is inside). The box matches the zone's full extents so the gizmo
 * scale handles map intuitively to the half-extent fields.
 */
export function makeAntiGravHelper(zone: AntiGravZone, selected: boolean): THREE.Group {
  const g = new THREE.Group()
  g.position.set(zone.position.x, zone.position.y, zone.position.z)
  g.quaternion.set(zone.rotation.x, zone.rotation.y, zone.rotation.z, zone.rotation.w)

  const baseColor = 0xa066ff
  const selColor = 0xddaaff
  const w = zone.halfWidth * 2
  const h = zone.halfHeight * 2
  const d = zone.halfDepth * 2

  const boxMat = new THREE.MeshBasicMaterial({
    color: selected ? selColor : baseColor,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), boxMat)
  g.add(box)

  const wireMat = new THREE.LineBasicMaterial({
    color: selected ? selColor : baseColor,
    transparent: true,
    opacity: 0.85,
  })
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.BoxGeometry(w, h, d)),
    wireMat,
  )
  g.add(wire)

  // Up-arrow along local +Y, anchored at the floor.
  const arrowMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
  })
  const arrowLen = Math.min(zone.halfHeight * 1.4, 4)
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, arrowLen, 8), arrowMat)
  shaft.position.y = -zone.halfHeight + arrowLen / 2
  g.add(shaft)
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 12), arrowMat)
  head.position.y = -zone.halfHeight + arrowLen + 0.45
  g.add(head)

  g.userData.setSelected = (v: boolean) => {
    boxMat.color.setHex(v ? selColor : baseColor)
    wireMat.color.setHex(v ? selColor : baseColor)
  }
  return g
}

/**
 * Anchor / control-point helper. Bigger (1.2m) when this is a Catmull-Rom
 * anchor — the user is meant to grab and drag these. Smaller (0.6m) for
 * legacy dense polyline points where there are many.
 */
export function makeAnchorHelper(
  p: { x: number; y: number; z: number },
  selected: boolean,
  isAnchor: boolean,
): THREE.Group {
  const g = new THREE.Group()
  g.position.set(p.x, p.y + 0.2, p.z)
  const baseColor = isAnchor ? 0x66bbff : 0x88ccff
  const selColor = 0xffff66
  const mat = new THREE.MeshBasicMaterial({ color: selected ? selColor : baseColor })
  const radius = isAnchor ? 1.4 : 0.6
  const segs = isAnchor ? 12 : 8
  const dot = new THREE.Mesh(new THREE.SphereGeometry(radius, segs, segs), mat)
  g.add(dot)
  if (isAnchor) {
    // Faint vertical post so anchors are visible when the camera is low.
    const postMat = new THREE.MeshBasicMaterial({
      color: baseColor,
      transparent: true,
      opacity: 0.4,
    })
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 3, 6), postMat)
    post.position.set(0, 1.5, 0)
    g.add(post)
  }
  g.userData.setSelected = (v: boolean) => {
    mat.color.setHex(v ? selColor : baseColor)
  }
  return g
}

/**
 * Smooth curve drawn from the dense runtime-sample list. For anchored
 * splines this is the Catmull-Rom output; for legacy splines it's just
 * the polyline.
 */
export function makeSplineCurve(points: { x: number; y: number; z: number }[]): THREE.Line {
  const geom = new THREE.BufferGeometry()
  if (points.length < 2) {
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
    return new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x4488aa }))
  }
  const arr = new Float32Array((points.length + 1) * 3)
  for (let i = 0; i < points.length; i++) {
    arr[i * 3] = points[i]!.x
    arr[i * 3 + 1] = points[i]!.y + 0.2
    arr[i * 3 + 2] = points[i]!.z
  }
  arr[points.length * 3] = points[0]!.x
  arr[points.length * 3 + 1] = points[0]!.y + 0.2
  arr[points.length * 3 + 2] = points[0]!.z
  geom.setAttribute('position', new THREE.BufferAttribute(arr, 3))
  const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x66aacc }))
  line.name = 'editor:spline-curve'
  return line
}

/** Bike footprint (m). Roughly matches a tucked rider on the racer
 *  variant — width across handlebars, length nose-to-tail. Used by the
 *  start-helper grid markers so each slot reads as one bike. */
const START_BIKE_WIDTH = 2.0
const START_BIKE_LENGTH = 3.2
/** Lateral padding around the grid for the starting platform mesh. */
const START_PLATFORM_PAD_X = 3
const START_PLATFORM_PAD_Z = 3

/**
 * Player-start helper. Draws the full 2×4 starting grid: a translucent
 * tarmac platform underneath, eight bike-sized rectangles at the actual
 * spawn slots (pole position highlighted), a forward arrow, and a tall
 * vertical post that's visible from far away. The whole rig is parented
 * to a group rotated by `start.yaw` so the local slot offsets (sourced
 * from `specs/grid-offsets.json`) lay out in the start's facing frame —
 * rotate the start in the editor and the entire grid pivots with it,
 * mirroring the runtime spawn behavior.
 */
export function makeStartHelper(
  start: { position: Vec3; yaw: number; splineT?: number },
  selected: boolean,
): THREE.Group {
  const g = new THREE.Group()
  g.position.set(start.position.x, start.position.y, start.position.z)
  const halfA = start.yaw / 2
  g.quaternion.set(0, Math.sin(halfA), 0, Math.cos(halfA))

  // Resolve grid bounds from the JSON offsets so the platform always
  // wraps every slot, even if the layout changes.
  let minX = 0
  let maxX = 0
  let minZ = 0
  let maxZ = 0
  for (const slot of AI_GRID_SLOTS) {
    if (slot.dx < minX) minX = slot.dx
    if (slot.dx > maxX) maxX = slot.dx
    if (slot.dz < minZ) minZ = slot.dz
    if (slot.dz > maxZ) maxZ = slot.dz
  }
  const platformW = maxX - minX + START_BIKE_WIDTH + START_PLATFORM_PAD_X * 2
  const platformD = maxZ - minZ + START_BIKE_LENGTH + START_PLATFORM_PAD_Z * 2
  const platformCx = (minX + maxX) / 2
  const platformCz = (minZ + maxZ) / 2

  // ── Starting platform — translucent dark tarmac with a coloured edge. ──
  const platformBaseColor = selected ? 0x55cc99 : 0x224a3a
  const platformGeom = new THREE.PlaneGeometry(platformW, platformD)
  platformGeom.rotateX(-Math.PI / 2)
  const platformMat = new THREE.MeshBasicMaterial({
    color: platformBaseColor,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const platform = new THREE.Mesh(platformGeom, platformMat)
  platform.position.set(platformCx, 0.04, platformCz)
  g.add(platform)

  // Platform outline so the rectangle reads on dark terrain.
  const outlineColor = selected ? 0xaaffcc : 0x66ffaa
  const outlineMat = new THREE.LineBasicMaterial({
    color: outlineColor,
    transparent: true,
    opacity: 0.85,
  })
  const outlineGeom = new THREE.BufferGeometry()
  const ox0 = platformCx - platformW / 2
  const ox1 = platformCx + platformW / 2
  const oz0 = platformCz - platformD / 2
  const oz1 = platformCz + platformD / 2
  const oy = 0.06
  outlineGeom.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        ox0,
        oy,
        oz0,
        ox1,
        oy,
        oz0,
        ox1,
        oy,
        oz0,
        ox1,
        oy,
        oz1,
        ox1,
        oy,
        oz1,
        ox0,
        oy,
        oz1,
        ox0,
        oy,
        oz1,
        ox0,
        oy,
        oz0,
      ],
      3,
    ),
  )
  const outline = new THREE.LineSegments(outlineGeom, outlineMat)
  g.add(outline)

  // ── Start-line stripe — runs across the front row in local +X. ──
  const stripeColor = selected ? 0xffffff : 0xddeedd
  const stripeMat = new THREE.MeshBasicMaterial({
    color: stripeColor,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const stripeGeom = new THREE.PlaneGeometry(platformW, 0.6)
  stripeGeom.rotateX(-Math.PI / 2)
  const stripe = new THREE.Mesh(stripeGeom, stripeMat)
  // Place the stripe along the front of the front row (slightly ahead of
  // the bikes so it reads as "the line you cross").
  stripe.position.set(platformCx, 0.07, START_BIKE_LENGTH / 2 + 0.6)
  g.add(stripe)

  // ── Per-slot bike markers. Slot 0 (pole / player) is brighter. ──
  const slotMaterials: THREE.MeshBasicMaterial[] = []
  const slotOutlineMats: THREE.LineBasicMaterial[] = []
  const allSlots: { dx: number; dz: number; isPole: boolean }[] = [
    { dx: 0, dz: 0, isPole: true },
    ...AI_GRID_SLOTS.map((s) => ({ dx: s.dx, dz: s.dz, isPole: false })),
  ]
  const poleBase = 0x66ffcc
  const poleSel = 0xffff88
  const aiBase = 0x2e8a66
  const aiSel = 0x88ffbb
  for (const slot of allSlots) {
    const base = slot.isPole ? poleBase : aiBase
    const sel = slot.isPole ? poleSel : aiSel
    const fillMat = new THREE.MeshBasicMaterial({
      color: selected ? sel : base,
      transparent: true,
      opacity: slot.isPole ? 0.75 : 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const fillGeom = new THREE.PlaneGeometry(START_BIKE_WIDTH, START_BIKE_LENGTH)
    fillGeom.rotateX(-Math.PI / 2)
    const fill = new THREE.Mesh(fillGeom, fillMat)
    fill.position.set(slot.dx, 0.09, slot.dz)
    g.add(fill)
    slotMaterials.push(fillMat)

    const halfW = START_BIKE_WIDTH / 2
    const halfL = START_BIKE_LENGTH / 2
    const wireMat = new THREE.LineBasicMaterial({
      color: selected ? sel : base,
      transparent: true,
      opacity: 0.95,
    })
    const wireGeom = new THREE.BufferGeometry()
    const wy = 0.1
    wireGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          slot.dx - halfW,
          wy,
          slot.dz - halfL,
          slot.dx + halfW,
          wy,
          slot.dz - halfL,
          slot.dx + halfW,
          wy,
          slot.dz - halfL,
          slot.dx + halfW,
          wy,
          slot.dz + halfL,
          slot.dx + halfW,
          wy,
          slot.dz + halfL,
          slot.dx - halfW,
          wy,
          slot.dz + halfL,
          slot.dx - halfW,
          wy,
          slot.dz + halfL,
          slot.dx - halfW,
          wy,
          slot.dz - halfL,
        ],
        3,
      ),
    )
    const wire = new THREE.LineSegments(wireGeom, wireMat)
    g.add(wire)
    slotOutlineMats.push(wireMat)

    // Tiny nose triangle inside each slot so the bike's facing reads.
    const nose = new THREE.Mesh(
      (() => {
        const geom = new THREE.ConeGeometry(0.35, 0.7, 3)
        geom.rotateX(Math.PI / 2)
        return geom
      })(),
      new THREE.MeshBasicMaterial({
        color: slot.isPole ? 0xffffff : 0xcfeedd,
        transparent: true,
        opacity: 0.9,
      }),
    )
    nose.position.set(slot.dx, 0.12, slot.dz + halfL - 0.4)
    g.add(nose)
  }

  // ── Forward arrow — points along the start's facing direction. ──
  const arrowColor = selected ? 0xffff88 : 0xaaffcc
  const arrowMat = new THREE.MeshBasicMaterial({
    color: arrowColor,
    transparent: true,
    opacity: 0.95,
  })
  const arrowGeom = new THREE.ConeGeometry(1.2, 2.6, 4)
  arrowGeom.rotateX(Math.PI / 2)
  const arrow = new THREE.Mesh(arrowGeom, arrowMat)
  arrow.position.set(0, 0.6, START_BIKE_LENGTH / 2 + 2.4)
  g.add(arrow)

  // ── Vertical post — visible from far away so the start is easy to find. ──
  const postBase = selected ? 0xffff88 : 0x66ffaa
  const postMat = new THREE.MeshBasicMaterial({
    color: postBase,
    transparent: true,
    opacity: 0.7,
  })
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 5, 8), postMat)
  // Anchor the post at the pole position so it always marks where the
  // player will spawn, not the geometric centre of the grid.
  post.position.set(0, 2.5, 0)
  g.add(post)
  const flag = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 8, 6),
    new THREE.MeshBasicMaterial({
      color: postBase,
      transparent: true,
      opacity: 0.85,
    }),
  )
  flag.position.set(0, 5.2, 0)
  g.add(flag)

  g.userData.setSelected = (v: boolean) => {
    platformMat.color.setHex(v ? 0x55cc99 : 0x224a3a)
    outlineMat.color.setHex(v ? 0xaaffcc : 0x66ffaa)
    stripeMat.color.setHex(v ? 0xffffff : 0xddeedd)
    arrowMat.color.setHex(v ? 0xffff88 : 0xaaffcc)
    postMat.color.setHex(v ? 0xffff88 : 0x66ffaa)
    ;(flag.material as THREE.MeshBasicMaterial).color.setHex(v ? 0xffff88 : 0x66ffaa)
    for (let i = 0; i < slotMaterials.length; i++) {
      const isPole = i === 0
      const base = isPole ? 0x66ffcc : 0x2e8a66
      const sel = isPole ? 0xffff88 : 0x88ffbb
      slotMaterials[i]!.color.setHex(v ? sel : base)
      slotOutlineMats[i]!.color.setHex(v ? sel : base)
    }
  }
  return g
}

const PROP_DEFAULT_COLORS: Record<PropType, number> = {
  box: 0xc0a070,
  sphere: 0xddaa66,
  cylinder: 0x9999bb,
  pipe: 0x99ccdd,
  halfpipe: 0xaadddd,
  asset: 0x88ccff,
}

export function makePropHelper(p: Prop, selected: boolean): THREE.Group {
  const g = new THREE.Group()
  g.position.set(p.position.x, p.position.y, p.position.z)
  g.quaternion.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w)
  const baseColor = p.color ? new THREE.Color(p.color).getHex() : PROP_DEFAULT_COLORS[p.type]
  const selColor = 0xffff66
  const mat = new THREE.MeshLambertMaterial({
    color: selected ? selColor : baseColor,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
  })
  // Asset props don't have parametric geometry; their `size` is a scale
  // applied to the runtime-loaded GLB. Editor shows a translucent
  // placeholder box scaled by `size` so users can position them.
  const geom =
    p.type === 'asset'
      ? new THREE.BoxGeometry(
          Math.max(0.1, p.size.x * 2),
          Math.max(0.1, p.size.y * 2),
          Math.max(0.1, p.size.z * 2),
        )
      : buildPropGeometry(p.type, p.size)
  const mesh = new THREE.Mesh(geom, mat)
  g.add(mesh)
  // A wireframe overlay helps gauge size against the gizmo.
  const wireMat = new THREE.LineBasicMaterial({
    color: selected ? selColor : 0x000000,
    transparent: true,
    opacity: 0.25,
  })
  const wire = new THREE.LineSegments(new THREE.WireframeGeometry(geom), wireMat)
  g.add(wire)
  g.userData.setSelected = (v: boolean) => {
    mat.color.setHex(v ? selColor : baseColor)
    wireMat.color.setHex(v ? selColor : 0x000000)
  }
  return g
}

export function defaultPropSize(t: PropType): Vec3 {
  if (t === 'box') return { x: 4, y: 1.5, z: 4 }
  if (t === 'sphere') return { x: 3, y: 3, z: 3 }
  if (t === 'cylinder') return { x: 2.5, y: 2, z: 2.5 }
  // pipes default to a 5m radius, 10m long, 0.6m wall — large enough to ride.
  return { x: 5, y: 5, z: 0.6 }
}

export function defaultPropDropY(t: PropType, size: Vec3): number {
  // Drop boxes / cylinders so they sit ON the water plane (y=0) rather than
  // floating in mid-air. Spheres rest on radius. Pipes lay on their outer
  // radius.
  if (t === 'box') return size.y
  if (t === 'sphere') return size.x
  if (t === 'cylinder') return size.y
  return size.x // pipe / halfpipe rest on outer radius
}

export function propSizeHint(t: PropType): string {
  if (t === 'box') return 'size = halfWidth, halfHeight, halfDepth'
  if (t === 'sphere') return 'size.x = radius'
  if (t === 'cylinder') return 'size.x = radius, size.y = halfHeight'
  return 'size = outerRadius, halfLength, wallThickness'
}

/** Yaw (rotation around +Y) extracted from a quaternion via the YXZ Euler. */
export function yawFromQuaternion(q: THREE.Quaternion): number {
  const e = new THREE.Euler().setFromQuaternion(q, 'YXZ')
  return e.y
}

/** Recursively dispose a THREE.Object3D's geometries + materials. */
export function disposeObj(o: THREE.Object3D): void {
  o.traverse((c) => {
    const geom = (c as THREE.Mesh).geometry
    if (geom) geom.dispose()
    const m = (c as THREE.Mesh).material
    if (m) {
      if (Array.isArray(m)) {
        for (const mm of m) mm.dispose()
      } else {
        m.dispose()
      }
    }
  })
}
