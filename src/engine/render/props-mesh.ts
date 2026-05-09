import * as THREE from 'three'
import { cloneLoadedProp, type LoadedProp } from '@/game/assets/prop-loader'
import type { Prop, PropType } from '@/game/tracks/types'
import { buildPropGeometry } from './props-geometry'

/**
 * Build a Three.js group containing one mesh per editor-authored prop.
 * Procedural prop types (box/sphere/etc) are rendered via
 * buildPropGeometry; asset-prop types (`type === 'asset'` with an
 * `assetId`) are cloned from a pre-loaded GLB. Physics colliders are
 * attached separately by `createPropColliders`.
 */
const DEFAULT_COLORS: Record<Exclude<PropType, 'asset'>, number> = {
  box: 0xc0a070,
  sphere: 0xddaa66,
  cylinder: 0x9999bb,
  pipe: 0x99ccdd,
  halfpipe: 0xaadddd,
}

/** Pre-loaded prop GLBs keyed by `assetId`. Provided by main.ts after
 *  the boot pre-load step finishes. Empty when no asset-props are in
 *  the track (procedural-only). */
export type PropAssetRegistry = Map<string, LoadedProp>

export function createPropsMesh(props: Prop[], assets?: PropAssetRegistry): THREE.Group {
  const group = new THREE.Group()
  group.name = 'track:props'
  for (const p of props) {
    if (p.type === 'asset') {
      const loaded = p.assetId ? assets?.get(p.assetId) : undefined
      if (!loaded) continue // silently skip; caller logs missing assets at boot
      const inst = cloneLoadedProp(loaded)
      inst.position.set(p.position.x, p.position.y, p.position.z)
      inst.quaternion.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w)
      inst.scale.set(Math.max(0.01, p.size.x), Math.max(0.01, p.size.y), Math.max(0.01, p.size.z))
      inst.userData.kind = 'prop'
      group.add(inst)
      continue
    }
    const color = p.color ? new THREE.Color(p.color).getHex() : DEFAULT_COLORS[p.type]
    const mat = new THREE.MeshLambertMaterial({
      color,
      // Ring (pipe / halfpipe) needs DoubleSide because the inner wall's
      // triangles face inward; viewing the open-top half-pipe from above
      // should show the inside surface lit.
      side: p.type === 'pipe' || p.type === 'halfpipe' ? THREE.DoubleSide : THREE.FrontSide,
    })
    const geom = buildPropGeometry(p.type, p.size)
    const mesh = new THREE.Mesh(geom, mat)
    mesh.position.set(p.position.x, p.position.y, p.position.z)
    mesh.quaternion.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w)
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.userData.kind = 'prop'
    group.add(mesh)
  }
  return group
}
