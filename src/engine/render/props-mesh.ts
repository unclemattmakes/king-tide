import * as THREE from 'three'
import type { Prop, PropType } from '@/game/tracks/types'
import { buildPropGeometry } from './props-geometry'

/**
 * Build a Three.js group containing one mesh per editor-authored prop. The
 * runtime adds this group to the scene; physics colliders are attached
 * separately via `attachPropColliders`.
 */
const DEFAULT_COLORS: Record<PropType, number> = {
  box: 0xc0a070,
  sphere: 0xddaa66,
  cylinder: 0x9999bb,
  pipe: 0x99ccdd,
  halfpipe: 0xaadddd,
}

export function createPropsMesh(props: Prop[]): THREE.Group {
  const group = new THREE.Group()
  group.name = 'track:props'
  for (const p of props) {
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
