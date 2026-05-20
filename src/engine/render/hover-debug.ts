/**
 * Per-bike hover-spring visualizer — draws the 5 probe rays (center +
 * bow / stern / port / starboard), the surface-hit markers, the spring
 * force arrows, the hover-height target ring, the isGrounded ring, and
 * the bike's actual physics collider as an orange wireframe capsule.
 *
 * Cheap-when-off pattern, matching `physics-debug.ts` and
 * `anti-grav-debug.ts`:
 *   - One global flag (`hoverDebugEnabled`) gates both the sim-side
 *     data writes (in `hoverSystem`) and the render-side draw. When
 *     off the LineSegments mesh is invisible AND `hoverSystem` skips
 *     the `HoverDebugStore.set(...)` call so there's no per-tick
 *     allocation.
 *   - Single `THREE.LineSegments` per call to `tick()` that
 *     re-fills its position/color attributes from the latest
 *     `HoverDebugStore` snapshot.
 *
 * Toggle from `main.ts`:
 *   - F4 key (per-session)
 *   - `?debug=hover` URL param (boot-time)
 *   - `window.__hover.toggleHoverDebug()` (programmatic)
 */

import * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { isHoverDebugEnabled, setHoverDebugEnabled } from '@/engine/sim/debug-flags'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { BikeTag, HoverDebugStore, RBHandleStore } from '@/game/components'
import { query } from 'bitecs'

// Re-exported for callers that want to gate non-render-side code on the
// flag (e.g. HUD pills) without pulling the sim-layer module directly.
export { isHoverDebugEnabled, setHoverDebugEnabled }

/** Visual scale for the spring force arrows. `aUp` is in m/s²; multiply
 *  to get arrow length in metres. 25 m/s² (≈ 1g) maps to a 1.5m arrow
 *  which reads cleanly above the bike. */
const FORCE_TO_LEN = 1.5 / 25
/** Probe-ray rendering colour while no surface was hit (miss). */
const COL_MISS = new THREE.Color(0x666666)
/** Probe-ray segment that connects ray origin to hit point. */
const COL_RAY_LAND = new THREE.Color(0x88ddff)
const COL_RAY_WATER = new THREE.Color(0x44aaff)
/** Hit-point cross marker. */
const COL_HIT_LAND = new THREE.Color(0x00ff88)
const COL_HIT_WATER = new THREE.Color(0x33ccff)
/** Spring arrow colour — green when corner is firing, faded grey when
 *  the local-grounded gate culled it (locally airborne / past lip). */
const COL_FORCE_ACTIVE = new THREE.Color(0x22ff44)
const COL_FORCE_INACTIVE = new THREE.Color(0x553333)
/** Center probe colour. */
const COL_CENTER = new THREE.Color(0xffaa00)
/** Up-axis arrow above the bike — shows the effective hover-up direction. */
const COL_UP = new THREE.Color(0xffff66)
/** Hover-height target ring at the bike's nominal hover height. */
const COL_TARGET_RING = new THREE.Color(0xff44ff)
/** isGrounded ring around the bike — green grounded, red airborne. */
const COL_GROUND_OK = new THREE.Color(0x33ff33)
const COL_GROUND_AIR = new THREE.Color(0xff5533)
/** Bike collider wireframe colour — orange so it reads against both
 *  land (greens / browns) and water (blues / teals). */
const COL_COLLIDER = new THREE.Color(0xff9933)

export type HoverDebugRenderer = {
  mesh: THREE.LineSegments
  tick(sim: SimWorld): void
  setEnabled(on: boolean): void
  isEnabled(): boolean
  toggle(): boolean
}

export function createHoverDebugRenderer(phys: PhysicsWorld): HoverDebugRenderer {
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3))
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
    linewidth: 2,
  })
  const mesh = new THREE.LineSegments(geom, mat)
  mesh.name = 'hover-debug'
  mesh.visible = false
  mesh.frustumCulled = false
  mesh.renderOrder = 997

  // Re-used per-tick scratch arrays. Resize lazily when bike count
  // changes; otherwise we just overwrite contents.
  let posScratch: number[] = []
  let colScratch: number[] = []

  function pushSeg(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    c: THREE.Color,
  ): void {
    posScratch.push(ax, ay, az, bx, by, bz)
    colScratch.push(c.r, c.g, c.b, c.r, c.g, c.b)
  }

  /** 12-segment ring at radius `r` around `(cx,cy,cz)` lying in the
   *  plane perpendicular to (upX,upY,upZ). */
  function pushRing(
    cx: number,
    cy: number,
    cz: number,
    r: number,
    upX: number,
    upY: number,
    upZ: number,
    c: THREE.Color,
  ): void {
    // Build two orthonormal axes spanning the up-plane.
    let aX = 1,
      aY = 0,
      aZ = 0
    const dot = aX * upX + aY * upY + aZ * upZ
    aX -= dot * upX
    aY -= dot * upY
    aZ -= dot * upZ
    let aLen = Math.hypot(aX, aY, aZ)
    if (aLen < 0.01) {
      // up was nearly ±X — use world Z as the seed instead.
      aX = 0
      aY = 0
      aZ = 1
      const d2 = aZ * upZ
      aX -= d2 * upX
      aY -= d2 * upY
      aZ -= d2 * upZ
      aLen = Math.hypot(aX, aY, aZ)
    }
    aX /= aLen
    aY /= aLen
    aZ /= aLen
    // b = up × a
    const bX = upY * aZ - upZ * aY
    const bY = upZ * aX - upX * aZ
    const bZ = upX * aY - upY * aX
    const N = 16
    let prevX = cx + aX * r
    let prevY = cy + aY * r
    let prevZ = cz + aZ * r
    for (let i = 1; i <= N; i++) {
      const t = (i / N) * Math.PI * 2
      const cs = Math.cos(t)
      const sn = Math.sin(t)
      const nx = cx + (aX * cs + bX * sn) * r
      const ny = cy + (aY * cs + bY * sn) * r
      const nz = cz + (aZ * cs + bZ * sn) * r
      pushSeg(prevX, prevY, prevZ, nx, ny, nz, c)
      prevX = nx
      prevY = ny
      prevZ = nz
    }
  }

  function pushCross(x: number, y: number, z: number, r: number, c: THREE.Color): void {
    pushSeg(x - r, y, z, x + r, y, z, c)
    pushSeg(x, y - r, z, x, y + r, z, c)
    pushSeg(x, y, z - r, x, y, z + r, c)
  }

  /** Rotate a local-space vector `(lx,ly,lz)` by quaternion `q`. */
  function rotateBy(
    q: { x: number; y: number; z: number; w: number },
    lx: number,
    ly: number,
    lz: number,
  ): [number, number, number] {
    const { x, y, z, w } = q
    // v' = v + 2 * q.xyz × (q.xyz × v + q.w * v)
    const tx = 2 * (y * lz - z * ly)
    const ty = 2 * (z * lx - x * lz)
    const tz = 2 * (x * ly - y * lx)
    return [
      lx + w * tx + (y * tz - z * ty),
      ly + w * ty + (z * tx - x * tz),
      lz + w * tz + (x * ty - y * tx),
    ]
  }

  /** Emit a wireframe capsule centred at `T`, oriented by `Q` (capsule
   *  axis along local Y — Rapier's convention). `hh` is half-height
   *  of the cylinder section; `r` the capsule radius. Total endpoint
   *  separation is `2*(hh+r)`. */
  function pushCapsule(
    T: { x: number; y: number; z: number },
    Q: { x: number; y: number; z: number; w: number },
    hh: number,
    r: number,
    c: THREE.Color,
  ): void {
    // Local axes in world: ax (X) = lateral, ay (Y) = capsule long axis,
    // az (Z) = forward.
    const [axX, axY, axZ] = rotateBy(Q, 1, 0, 0)
    const [ayX, ayY, ayZ] = rotateBy(Q, 0, 1, 0)
    const [azX, azY, azZ] = rotateBy(Q, 0, 0, 1)
    const SEGS = 12
    // Two rings at the cylinder/hemisphere junctions (top + bottom of
    // the straight section).
    const ringCenters: [number, number, number][] = [
      [T.x + ayX * hh, T.y + ayY * hh, T.z + ayZ * hh],
      [T.x - ayX * hh, T.y - ayY * hh, T.z - ayZ * hh],
    ]
    for (const [cx, cy, cz] of ringCenters) {
      let pX = cx + axX * r
      let pY = cy + axY * r
      let pZ = cz + axZ * r
      for (let i = 1; i <= SEGS; i++) {
        const t = (i / SEGS) * Math.PI * 2
        const cs = Math.cos(t) * r
        const sn = Math.sin(t) * r
        const nX = cx + axX * cs + azX * sn
        const nY = cy + axY * cs + azY * sn
        const nZ = cz + axZ * cs + azZ * sn
        pushSeg(pX, pY, pZ, nX, nY, nZ, c)
        pX = nX
        pY = nY
        pZ = nZ
      }
    }
    // Cylinder side lines — 4 around at the cardinal directions.
    const dirs: [number, number][] = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ]
    for (const [cs0, sn0] of dirs) {
      const offX = axX * (cs0 * r) + azX * (sn0 * r)
      const offY = axY * (cs0 * r) + azY * (sn0 * r)
      const offZ = axZ * (cs0 * r) + azZ * (sn0 * r)
      pushSeg(
        T.x + ayX * hh + offX,
        T.y + ayY * hh + offY,
        T.z + ayZ * hh + offZ,
        T.x - ayX * hh + offX,
        T.y - ayY * hh + offY,
        T.z - ayZ * hh + offZ,
        c,
      )
    }
    // Hemisphere caps — meridian arcs in the (ax, ay) and (az, ay)
    // planes for each cap. 6 segments per quarter-arc, two planes per
    // cap, two caps = 24 segments per cap geometry.
    const ARC_SEGS = 6
    for (const sign of [1, -1]) {
      const topX = T.x + ayX * (sign * hh)
      const topY = T.y + ayY * (sign * hh)
      const topZ = T.z + ayZ * (sign * hh)
      // Meridian in the (ax, ay) plane.
      for (const ax of [
        [axX, axY, axZ],
        [-axX, -axY, -axZ],
        [azX, azY, azZ],
        [-azX, -azY, -azZ],
      ] as [number, number, number][]) {
        let pX = topX + ax[0] * r
        let pY = topY + ax[1] * r
        let pZ = topZ + ax[2] * r
        // Start at the ring (angle 0) and walk up to the pole (angle π/2).
        for (let i = 1; i <= ARC_SEGS; i++) {
          const ang = (i / ARC_SEGS) * (Math.PI / 2)
          const cs = Math.cos(ang) * r
          const sn = Math.sin(ang) * r
          const nX = topX + ax[0] * cs + ayX * (sign * sn)
          const nY = topY + ax[1] * cs + ayY * (sign * sn)
          const nZ = topZ + ax[2] * cs + ayZ * (sign * sn)
          pushSeg(pX, pY, pZ, nX, nY, nZ, c)
          pX = nX
          pY = nY
          pZ = nZ
        }
      }
    }
  }

  function tick(sim: SimWorld): void {
    if (!isHoverDebugEnabled()) return
    posScratch.length = 0
    colScratch.length = 0

    const eids = query(sim, [BikeTag])
    for (const eid of eids) {
      const d = HoverDebugStore.get(eid)
      if (!d) continue

      // 1. Up-axis arrow (1.5m) above bike center — shows effective hover up.
      pushSeg(
        d.cx,
        d.cy,
        d.cz,
        d.cx + d.upX * 1.5,
        d.cy + d.upY * 1.5,
        d.cz + d.upZ * 1.5,
        COL_UP,
      )

      // 2. Center probe ray — full length when no surface, or up to the
      //    hit point. Cross at the hit if there is one.
      if (d.hasSurface) {
        pushSeg(
          d.cx,
          d.cy,
          d.cz,
          d.centerHitX,
          d.centerHitY,
          d.centerHitZ,
          d.isWater ? COL_RAY_WATER : COL_RAY_LAND,
        )
        pushCross(
          d.centerHitX,
          d.centerHitY,
          d.centerHitZ,
          0.3,
          d.isWater ? COL_HIT_WATER : COL_HIT_LAND,
        )
      } else {
        const farLen = 6
        pushSeg(
          d.cx,
          d.cy,
          d.cz,
          d.cx + d.dnX * farLen,
          d.cy + d.dnY * farLen,
          d.cz + d.dnZ * farLen,
          COL_MISS,
        )
      }
      pushCross(d.cx, d.cy, d.cz, 0.15, COL_CENTER)

      // 3. Hover-height target ring under the bike. Sits one
      //    `effHoverHeight` below the bike center along −up. Magenta
      //    so it stands out from the chassis silhouette.
      const tcx = d.cx + d.dnX * d.effHoverHeight
      const tcy = d.cy + d.dnY * d.effHoverHeight
      const tcz = d.cz + d.dnZ * d.effHoverHeight
      pushRing(tcx, tcy, tcz, 0.6, d.upX, d.upY, d.upZ, COL_TARGET_RING)

      // 4. isGrounded ring above the bike. Green = grounded, red = air.
      const groundCol = d.isGrounded ? COL_GROUND_OK : COL_GROUND_AIR
      pushRing(
        d.cx + d.upX * 0.4,
        d.cy + d.upY * 0.4,
        d.cz + d.upZ * 0.4,
        0.5,
        d.upX,
        d.upY,
        d.upZ,
        groundCol,
      )

      // 5. Bike collider wireframe — read the capsule's world-space
      //    pose + dimensions directly from Rapier so we draw exactly
      //    what the physics engine is using. Only handles capsules
      //    today (every bike is a capsule); other shape types are
      //    silently skipped to avoid lying about the geometry.
      const handle = RBHandleStore.get(eid)
      if (handle) {
        const rb = phys.world.getRigidBody(handle.handle)
        const col = rb?.collider(0)
        if (col) {
          const shape = col.shape as {
            type: number | string
            halfHeight?: number
            radius?: number
          }
          // Rapier exposes the enum as `ShapeType` on the rapier module
          // (Capsule = 2 historically). Match by duck-typed fields to
          // avoid importing the enum.
          if (typeof shape.halfHeight === 'number' && typeof shape.radius === 'number') {
            const T = col.translation()
            const Q = col.rotation()
            pushCapsule(T, Q, shape.halfHeight, shape.radius, COL_COLLIDER)
          }
        }
      }

      // 6. Per-corner probe rays + force arrows.
      for (const p of d.corners) {
        const hitOk = p.hx !== Number.NEGATIVE_INFINITY
        if (hitOk) {
          pushSeg(
            p.ox,
            p.oy,
            p.oz,
            p.hx,
            p.hy,
            p.hz,
            d.isWater ? COL_RAY_WATER : COL_RAY_LAND,
          )
          pushCross(
            p.hx,
            p.hy,
            p.hz,
            0.2,
            d.isWater ? COL_HIT_WATER : COL_HIT_LAND,
          )
        } else {
          const farLen = 6
          pushSeg(
            p.ox,
            p.oy,
            p.oz,
            p.ox + d.dnX * farLen,
            p.oy + d.dnY * farLen,
            p.oz + d.dnZ * farLen,
            COL_MISS,
          )
        }
        // Force arrow at the probe's footprint position. Walk back
        // from the lifted origin along −up by the current probe-lift
        // distance — using the same live value as the spring so the
        // arrow stays anchored to the actual contact reference when
        // the player drags the lift slider.
        const lift = d.probeLift
        const fx = p.ox - d.upX * lift
        const fy = p.oy - d.upY * lift
        const fz = p.oz - d.upZ * lift
        const len = p.aUp * FORCE_TO_LEN
        if (Math.abs(len) > 0.02) {
          pushSeg(
            fx,
            fy,
            fz,
            fx + d.upX * len,
            fy + d.upY * len,
            fz + d.upZ * len,
            p.active ? COL_FORCE_ACTIVE : COL_FORCE_INACTIVE,
          )
        }
      }
    }

    // Upload to the geometry. Reallocate when total vertex count
    // changes (bike count changed) — otherwise reuse the buffer.
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute
    const colAttr = geom.getAttribute('color') as THREE.BufferAttribute
    if (posAttr.array.length !== posScratch.length) {
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posScratch), 3))
      geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colScratch), 3))
    } else {
      ;(posAttr.array as Float32Array).set(posScratch)
      ;(colAttr.array as Float32Array).set(colScratch)
      posAttr.needsUpdate = true
      colAttr.needsUpdate = true
    }
  }

  return {
    mesh,
    tick,
    setEnabled(on) {
      setHoverDebugEnabled(on)
      mesh.visible = on
    },
    isEnabled() {
      return isHoverDebugEnabled()
    },
    toggle() {
      const next = !isHoverDebugEnabled()
      setHoverDebugEnabled(next)
      mesh.visible = next
      return next
    },
  }
}
