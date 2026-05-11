# Vertex attribute spec — Item 6

Single source of truth for the `COLOR_0` vertex attribute every
procedurally-built asset (props, foliage, terrain) carries through the
Blender → glTF → Three.js pipeline. This spec exists so authors,
build scripts, and runtime shaders agree on what each channel means
**before** the first foliage prop or scattered asset lands.

Status as of 2026-05-11: scaffold + spec only. The runtime sway shader
hook ([`src/engine/render/foliage-sway.ts`](../src/engine/render/foliage-sway.ts))
is wired and exported; nothing consumes it yet — Items 3 and 4 in
[blender-wishlist.md](./blender-wishlist.md) will be the first.

## Why vertex attributes for parameters

We want textures to carry visible *colour*, vertex attributes to carry
*per-vertex parameters* the shader needs at runtime — sway strength,
AO darkness, animation phase offset, path-wear, biome blends, etc.
Vertex data is cheaper than per-pixel parameter maps for low-poly
assets, regenerates trivially from the procedural builder, and rides
through glTF with no special handling.

The asset's *visible colour* therefore comes from its material texture
(`baseColorTexture` in glTF terms), not from `COLOR_0`. The runtime
material does **not** set `vertexColors = true` in the
"colour-tint" sense; instead the shader reads the attribute via a
fragment-stage uniform path described below.

## The attribute

- **Name:** `COLOR_0` (glTF canonical name for the first vertex colour
  attribute; Three.js exposes it as `attribute vec3 color` in vertex
  shaders).
- **Type:** `VEC3` or `VEC4` of `UNSIGNED_BYTE` normalised. Author as
  `VEC4` when channel `A` is meaningful for the prop, `VEC3` otherwise.
- **Required on:** every mesh built by `tools/blender/build_*.py`,
  every GN-scattered prop, every authored prop in
  `tracks-src/props-library.blend`. Optional on hand-authored decoration.

## Channel meanings

The same `COLOR_0` attribute carries different meanings depending on
material type. Disambiguation happens at the material level — the
foliage shader treats `B` as a phase offset, the terrain shader treats
`B` as a path-worn mask. There is no ambiguity at runtime because each
shader reads only the channels it knows about.

### Foliage / animated props (`mat_foliage_*`, `mat_prop_*` when opted in)

| Channel | Meaning | Authoring guidance |
|---|---|---|
| `R` | **Wind sway strength.** `0` = rigid, `1` = full sway. | Palm leaf tips → `1.0`; trunk base → `0.0`; smooth gradient between. |
| `G` | **AO multiplier.** `1` = no darkening, `0` = full shadow. | Inside seams and under-leaf regions → low; exposed surfaces → `1`. |
| `B` | **Per-instance animation phase offset** in `[0, 1)`. Used to desync a cluster's anim so it doesn't move in lockstep. | Authored at the GN-scatter level (random per instance) OR by `build_*.py` from a deterministic hash of the source mesh + transform. |
| `A` | **Free / per-prop semantics.** E.g. emissive multiplier for buoys, tear-line mask for banners. | Document the per-prop usage where you set it. |

### Terrain (`mat_track_*`)

| Channel | Meaning | Authoring guidance |
|---|---|---|
| `R` | **Reserved.** Future: per-vertex roughness or wet mask. | Leave at `1` for now. |
| `G` | **AO multiplier.** Same semantics as foliage. | Geometry-driven AO bake — concave corners → low. |
| `B` | **Path-worn mask** in `[0, 1)`. `1` = heavily worn racing line, `0` = pristine. | Authored by GN: distance-from-spline mapping, with worn band along the racing line. |
| `A` | **Biome blend.** `0..1` mapping into the track's biome lookup (water, sand, grass, rock). | GN-driven from height + slope + distance-from-water. |

### Bikes (`mat_bike_*`)

Bikes pre-date this spec and do **not** carry `COLOR_0` today. Adding
it is non-blocking; recommended channel usage when we get there:

- `R` reserved (chassis liveries via texture, no vertex param needed).
- `G` AO.
- `B` reserved.
- `A` reserved.

## Authoring (Blender side)

Use the helper in `tools/blender/vertex_attrs.py`:

```python
from tools.blender.vertex_attrs import set_color_attr, FOLIAGE_CHANNELS

def write_palm_sway(mesh, leaf_tip_indices):
    def value_for(i, co):
        # Linear sway gradient from trunk base (z=0) to leaf tip:
        sway = max(0.0, min(1.0, co.z / 4.0))  # palm is ~4m tall
        ao = 1.0
        phase = 0.0  # writer sets per-instance later via GN
        return (sway, ao, phase, 1.0)
    set_color_attr(mesh, "COLOR_0", value_for)
```

Procedural meshes built by `build_*.py` MUST call `set_color_attr`
before the script exits, even if all channels are `(0, 1, 0, 0)` — so
downstream readers can assume the attribute is present.

GN-scatter authoring uses a `Store Named Attribute` node writing
`COLOR_0` of type `Float Color`, set per-instance via Random Value or
sampled-from-source nodes.

## Runtime (Three.js side)

The shared sway hook lives in
[`src/engine/render/foliage-sway.ts`](../src/engine/render/foliage-sway.ts).
It exports:

- `windUniform: { value: Vector3 }` — single shared wind direction +
  magnitude, updated once per frame by the render loop.
- `applyFoliageSway(material, opts?)` — patches a Three.js material
  via `onBeforeCompile` to inject the vertex displacement shader
  fragment. Idempotent; safe to call multiple times on the same
  material (it no-ops on the second call).
- `updateWind(direction, strength)` — convenience setter.

Foliage props opt in by calling `applyFoliageSway(mesh.material)` at
load time. Non-foliage props ignore the helper and look identical to
their pre-spec behaviour.

For terrain, a separate `applyTerrainWear(material)` helper will land
with Item 1 / the actual terrain shader work. It reads `B` and blends
a worn-path texture in.

## glTF round-trip

- Blender's glTF exporter emits `COLOR_0` automatically when the mesh
  has a vertex colour attribute named `COLOR_0` (the default for
  attributes typed as Float Color). No special export flag needed.
- `EXT_mesh_gpu_instancing` round-trip preserves per-instance vertex
  attributes via instance-attribute promotion. We don't need that yet
  but it's available for Item 4.
- Three.js's `GLTFLoader` exposes the attribute on
  `BufferGeometry.attributes.color` (note: lowercase, three.js
  convention).

## When this spec changes

Edit this file *first*. Bump the schema version in
`tools/blender/vertex_attrs.py`'s `SCHEMA_VERSION` constant and add a
note here describing the migration. Old GLBs without the attribute
remain valid; new readers must tolerate missing `COLOR_0` and fall
back to `(0, 1, 0, 0)` defaults.

## Cross-references

- [docs/blender-wishlist.md § Item 6](./blender-wishlist.md) — the
  wishlist item this spec answers.
- [docs/blender-conventions.md](./blender-conventions.md) — material
  naming convention (`mat_*` prefixes) that determines which shader a
  mesh gets.
- [`src/engine/render/foliage-sway.ts`](../src/engine/render/foliage-sway.ts) —
  runtime sway hook.
- [`tools/blender/vertex_attrs.py`](../tools/blender/vertex_attrs.py) —
  Blender-side authoring helper.
