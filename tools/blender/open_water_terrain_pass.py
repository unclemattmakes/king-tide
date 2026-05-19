"""Drop terrain elevation far from the road for "open water" tracks.

Run via ``blender --background <track.blend> --python open_water_terrain_pass.py -- <radius_m> <seabed_y>``.

Walks every vertex in the ``terrain`` mesh. For each vertex above water-y:
  - find the closest road vertex (xz distance)
  - if the closest road vertex is farther than ``radius_m``, drop the
    terrain vertex's Z down to ``seabed_y``.

The result: terrain near the road's footprint is preserved (so authored
shoulders, landmarks, set-pieces still sit at their designed elevation),
while terrain far from the road — the stuff the user reads as "fake
land" in supposedly open-water sections — is pushed below water so the
runtime water shader renders open ocean there.

Then re-saves the .blend.

Skips silently if no road / terrain mesh is found.
"""
from __future__ import annotations

import sys

import bpy
import mathutils


def find_terrain() -> bpy.types.Object | None:
    for obj in bpy.data.objects:
        if obj.type == 'MESH' and 'terrain' in obj.name.lower():
            return obj
    return None


def find_road() -> bpy.types.Object | None:
    for obj in bpy.data.objects:
        if obj.type == 'MESH' and (obj.name == 'road_main' or obj.name == 'road'):
            return obj
    return None


def apply(radius_m: float, seabed_y: float, water_y: float, dry_run: bool = False) -> dict:
    terrain = find_terrain()
    road = find_road()
    if not terrain or not road:
        return {
            "skipped": True,
            "reason": f"terrain={bool(terrain)} road={bool(road)}",
        }

    # Blender's vertical axis is Z (Z-up); the runtime exports to glTF
    # which is Y-up. Inside Blender we measure elevation as v.co.z.
    # Build a KDTree of road verts in (x, 0, z) so the .find() distance
    # is the horizontal (XZ-plane) separation independent of elevation.
    road_mw = road.matrix_world
    rverts = [road_mw @ v.co for v in road.data.vertices]
    if not rverts:
        return {"skipped": True, "reason": "road has no verts"}
    kd = mathutils.kdtree.KDTree(len(rverts))
    for i, v in enumerate(rverts):
        kd.insert(mathutils.Vector((v.x, 0.0, v.y)), i)
    kd.balance()

    terrain_mw = terrain.matrix_world
    me = terrain.data
    radius_sq = radius_m * radius_m
    modified = 0
    total_above_water = 0
    above_water_far = 0

    inv = terrain_mw.inverted_safe()

    for v in me.vertices:
        wp = terrain_mw @ v.co
        # Elevation = world Z (Blender Z-up). Anything at or below
        # waterline is already submerged → leave alone.
        if wp.z <= water_y:
            continue
        total_above_water += 1
        # XZ-plane horizontal distance to nearest road vert. The KDTree
        # was built with (x, 0, y) so .y here is the Blender Y axis
        # (horizontal, not vertical).
        co, _idx, dist = kd.find(mathutils.Vector((wp.x, 0.0, wp.y)))
        if dist * dist <= radius_sq:
            continue
        above_water_far += 1
        if dry_run:
            continue
        # Drop the vert to seabed elevation. Build the world-space
        # target (same X/Y, Z=seabed) and convert back to local. With
        # an identity matrix_world (the common case) this is a no-op
        # except for the Z assignment.
        target_world = mathutils.Vector((wp.x, wp.y, seabed_y))
        target_local = inv @ target_world
        v.co.z = target_local.z
        modified += 1

    if modified > 0:
        me.update()
        bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)

    return {
        "skipped": False,
        "dry_run": dry_run,
        "terrain": terrain.name,
        "road": road.name,
        "radius_m": radius_m,
        "seabed_y": seabed_y,
        "water_y": water_y,
        "total_verts": len(me.vertices),
        "total_above_water": total_above_water,
        "above_water_far": above_water_far,
        "modified": modified,
    }


def main() -> None:
    argv = sys.argv
    rest = argv[argv.index("--") + 1:] if "--" in argv else []
    radius_m = float(rest[0]) if len(rest) > 0 else 60.0
    seabed_y = float(rest[1]) if len(rest) > 1 else -25.0
    water_y = float(rest[2]) if len(rest) > 2 else 0.0
    dry_run = len(rest) > 3 and rest[3].lower() in ("dry", "true", "1")
    out = apply(radius_m, seabed_y, water_y, dry_run=dry_run)
    print("===OPENWATER_BEGIN===")
    import json
    print(json.dumps(out, indent=2))
    print("===OPENWATER_END===")


if __name__ == "__main__":
    main()
