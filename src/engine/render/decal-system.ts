import * as THREE from 'three'
import { ExportedKind } from '@/engine/asset-kinds'

/**
 * Decal system.
 *
 * Walks a loaded GLB scene and converts every `kind=decal` mesh into a
 * proper alpha-blended overlay sitting on the surface beneath it. The
 * actual decal artwork comes from the shared atlas at
 * `public/assets/decals/atlas.png` (16 cells; see
 * `tools/blender/build_decal_atlas.py` for the cell legend); the
 * Blender-side *Add Decal* operator UV-unwraps each quad onto its
 * chosen cell.
 *
 * Per-decal material treatment:
 *
 *   - `depthTest: true`, `depthWrite: false` — the decal occludes
 *     correctly behind closer geometry but doesn't pollute the depth
 *     buffer (so a second decal can layer on top of the first).
 *   - `polygonOffset: true` with negative factor/units — nudges the
 *     decal slightly toward the camera, avoiding z-fighting with the
 *     surface mesh underneath at distance.
 *   - `transparent: true` with the atlas RGBA's alpha driving blend.
 *   - `castShadow / receiveShadow = false` — decals don't participate
 *     in the shadow pass. Shadow casters of paper-thin geometry are
 *     usually a visual mess anyway.
 *
 * Trimesh-collider attachment in `glb-track.ts` also opts out for
 * `kind=decal` so the physics layer never sees them.
 *
 * One shared atlas texture is loaded the first time `applyDecalsToScene`
 * runs and cached process-wide; subsequent tracks reuse the same GPU
 * texture. The atlas is only fetched lazily — projects that don't ship
 * decals never pay the bytes.
 */

const ATLAS_URL = '/assets/decals/atlas.png'

let atlasTexture: THREE.Texture | null = null
let atlasLoadPromise: Promise<THREE.Texture> | null = null

function loadAtlas(): Promise<THREE.Texture> {
  if (atlasTexture) return Promise.resolve(atlasTexture)
  if (atlasLoadPromise) return atlasLoadPromise
  atlasLoadPromise = new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader()
    loader.load(
      ATLAS_URL,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace
        tex.magFilter = THREE.LinearFilter
        tex.minFilter = THREE.LinearMipmapLinearFilter
        tex.anisotropy = 8
        atlasTexture = tex
        resolve(tex)
      },
      undefined,
      (err) => {
        atlasLoadPromise = null
        reject(err)
      },
    )
  })
  return atlasLoadPromise
}

function configureDecalMaterial(material: THREE.Material): void {
  // Idempotent — `userData.__hv_decal` marks materials we've already
  // configured so re-running the walk on a re-loaded track doesn't
  // double-tweak (which would compound `polygonOffsetFactor` etc.).
  if ((material.userData as { __hv_decal?: true })?.__hv_decal) return
  material.transparent = true
  material.depthWrite = false
  material.depthTest = true
  material.polygonOffset = true
  material.polygonOffsetFactor = -1
  material.polygonOffsetUnits = -1
  material.side = THREE.DoubleSide
  ;(material.userData as Record<string, unknown>).__hv_decal = true
  material.needsUpdate = true
}

function assignAtlas(material: THREE.Material, atlas: THREE.Texture): void {
  // The GLB ships either a placeholder Principled BSDF (no texture) or
  // an authored material with the atlas already linked. In both cases
  // we ensure the atlas texture is what gets sampled — overwriting any
  // baseColor map keeps the runtime material consistent across tracks
  // even when authors forget to assign the image in Blender.
  const mat = material as THREE.MeshBasicMaterial &
    THREE.MeshStandardMaterial & {
      map?: THREE.Texture | null
    }
  if ('map' in mat) {
    mat.map = atlas
  }
  // Force baseColor to white so the atlas isn't dimmed; authors can
  // still tint per-decal via the material's diffuse color in Blender.
  if ('color' in mat && (mat as { color?: THREE.Color }).color) {
    // Leave authored tint untouched if it isn't pure black (the BSDF
    // default after the seed runs).
    const c = (mat as { color: THREE.Color }).color
    if (c.r < 0.02 && c.g < 0.02 && c.b < 0.02) c.setRGB(1, 1, 1)
  }
}

/**
 * Walk `scene` and convert every `kind=decal` mesh into an alpha-blended
 * decal overlay. Safe to call after `loadGlbTrackVisuals`; idempotent
 * across re-loads.
 *
 * Returns the number of decals processed — useful for logs and tests.
 */
export async function applyDecalsToScene(scene: THREE.Object3D): Promise<number> {
  const decals: THREE.Mesh[] = []
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.userData?.kind === ExportedKind.DECAL) {
      decals.push(obj)
    }
  })
  if (decals.length === 0) return 0

  let atlas: THREE.Texture
  try {
    atlas = await loadAtlas()
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[decals] atlas load failed; decals will render without art', e)
    // Fall through with no atlas — just apply the material profile so
    // the meshes still don't z-fight or cast shadows.
    for (const mesh of decals) {
      mesh.castShadow = false
      mesh.receiveShadow = false
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if (m) configureDecalMaterial(m)
      }
    }
    return decals.length
  }

  for (const mesh of decals) {
    mesh.castShadow = false
    mesh.receiveShadow = false
    // `renderOrder` bumps the decal pass after the regular opaque pass
    // so the depthTest:on / depthWrite:off interplay reads correctly
    // against opaque receivers, while still letting two decals layer.
    mesh.renderOrder = 1
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) {
      if (!m) continue
      configureDecalMaterial(m)
      assignAtlas(m, atlas)
    }
  }
  return decals.length
}

/** Test-only — drop the cached atlas so successive tests don't share state. */
export function _resetDecalSystemForTests(): void {
  atlasTexture = null
  atlasLoadPromise = null
}
