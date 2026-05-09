# Authoring props

Props are static, editor-placeable decor — barriers, lampposts, crates, pylons. Each prop is one JSON spec plus a named kit part in `tools/blender/lib/prop_kit.blend`.

## Quick add

```bash
# 1. Copy an existing spec
cp specs/props/barrier_low.json specs/props/jersey_long.json

# 2. Edit id, displayName, kitPart, scale, tint, collider

# 3. Save — Vite's watcher rebuilds public/assets/props/jersey_long.glb
#    and writes a new manifest entry.

# 4. Reload the editor (?edit=1). The +Asset dropdown picks up the new prop.
```

If the shape needs a brand-new kit object, edit `tools/blender/lib/prop_kit.blend` (or extend `tools/blender/seed_prop_kit.py` and re-run) before pointing your spec at it.

## Spec format

```json
{
  "$schema": "../_schema/prop.json",
  "id": "barrier_low",
  "displayName": "Low Barrier",
  "category": "barrier",
  "geometry": {
    "kitPart": "barrier_a",
    "scale": [1, 1, 1],
    "tint": "#666666"
  },
  "collider": {
    "shape": "box",
    "halfExtents": [1.0, 0.5, 0.2]
  }
}
```

### Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | `^[a-z][a-z0-9_-]*$`. GLB filename. |
| `displayName` | string | yes | Shown in the editor *+Asset* dropdown. |
| `category` | enum | yes | One of `barrier` \| `lamppost` \| `crate` \| `pylon` \| `decor`. Editor groups by this. |

### `geometry`

| Field | Notes |
|---|---|
| `kitPart` | Name of the source object in `tools/blender/lib/prop_kit.blend`. |
| `scale` | `[sx, sy, sz]`. Per-axis scale applied to the kit part. |
| `tint` | `#RRGGBB`. Multiplied into the kit part's albedo. |

### `collider`

A primitive collider — the Rapier static body the bike will actually hit. Fields you set depend on `shape`:

| Shape | Fields | Notes |
|---|---|---|
| `box` | `halfExtents: [hx, hy, hz]` | In three.js axes: `[right, up, forward]`. |
| `sphere` | `radius` | Centered on the prop origin. |
| `cylinder` | `radius`, `height` | Axis-aligned along Y. |
| `capsule` | `radius`, `height` | Axis-aligned along Y; `height` is end-to-end of the cylinder portion. |

::: warning Collider authoring tips
- **Match the visual shape conservatively** — a slightly larger collider than the mesh is fine; a smaller one looks like the bike clips into the prop.
- **Boxes are cheapest.** Prefer them for rectangular things. Capsules are great for posts and pylons.
- **Half-extents, not full-extents.** A `[1, 0.5, 0.2]` box is 2 m wide, 1 m tall, 0.4 m deep.
:::

## Placing a prop in the editor

In `?edit=1`, the *+Asset* dropdown is populated from `manifest.json`. Pick a prop, click the ground to place it. The track JSON gets:

```json
{
  "type": "asset",
  "assetId": "barrier_low",
  "position": [12, 0, 18],
  "rotation": [0, 1.57, 0],
  "size": [1, 1, 1]
}
```

The runtime preloads every referenced GLB at boot via `prop-loader.ts`. Missing assets log a warning and render nothing — they don't crash the scene.

## Categories at a glance

| Category | Typical props |
|---|---|
| `barrier` | Jersey barriers, walls, low walls — anything that defines a track edge |
| `lamppost` | Vertical posts, signs, light poles |
| `crate` | Boxy obstacles, chicane fillers |
| `pylon` | Cones, traffic pylons, breakaway markers |
| `decor` | Catch-all for everything that's atmospheric, not gameplay-relevant |

The category drives the editor's grouping. Keep it tight — you'll be picking from this dropdown a lot.
