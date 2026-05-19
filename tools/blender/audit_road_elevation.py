"""Audit the road curve's elevation vs the terrain underneath.

Run via ``blender --background <track.blend> --python audit_road_elevation.py``
or under the MCP's ``execute_blender_code_for_cli`` glue.

For each control point on ``road_curve_main``:
  * raycast the *terrain* mesh straight down from the point
  * report ``(road_z, terrain_z, delta, current weight_softbody)``

Used by ``mark_elevated_floating.py`` as a preview and by the run-once
``run-mark-elevated-floating.mjs`` to identify which tracks have
overpass-like sections that need the Float flag set on their road curve.
"""
from __future__ import annotations

import json
import sys

import bpy
import mathutils
from mathutils.bvhtree import BVHTree


def find_terrain() -> bpy.types.Object | None:
    # Prefer an object whose name literally matches the seed-template
    # conventions; fall back to anything with "terrain" in the name.
    by_exact = [
        "terrain", "terrain_island", "terrain_mesa", "terrain_alpine",
        "terrain_downtown", "terrain_tunnel_island",
    ]
    for name in by_exact:
        obj = bpy.data.objects.get(name)
        if obj and obj.type == 'MESH':
            return obj
    for obj in bpy.data.objects:
        if obj.type == 'MESH' and 'terrain' in obj.name.lower():
            return obj
    return None


def build_terrain_bvh(terrain: bpy.types.Object) -> BVHTree:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    terrain_eval = terrain.evaluated_get(depsgraph)
    mesh = terrain_eval.to_mesh()
    mw = terrain.matrix_world
    verts = [mw @ v.co for v in mesh.vertices]
    tris: list[tuple[int, int, int]] = []
    for p in mesh.polygons:
        vs = list(p.vertices)
        if len(vs) == 3:
            tris.append((vs[0], vs[1], vs[2]))
        elif len(vs) == 4:
            tris.append((vs[0], vs[1], vs[2]))
            tris.append((vs[0], vs[2], vs[3]))
    bvh = BVHTree.FromPolygons(verts, tris)
    terrain_eval.to_mesh_clear()
    return bvh


def audit(blend_path: str, threshold: float = 3.5) -> dict:
    curve = bpy.data.objects.get("road_curve_main")
    terrain = find_terrain()
    if not curve:
        return {"error": "road_curve_main not found", "blend": blend_path}
    if not terrain:
        return {"error": "no terrain mesh found", "blend": blend_path,
                "objects": [o.name for o in bpy.data.objects if o.type == 'MESH'][:10]}

    bvh = build_terrain_bvh(terrain)
    mw_c = curve.matrix_world

    samples = []
    for sp_idx, spline in enumerate(curve.data.splines):
        pts = spline.bezier_points if spline.type == 'BEZIER' else spline.points
        for i, pt in enumerate(pts):
            pworld = mw_c @ pt.co
            origin = mathutils.Vector((pworld.x, pworld.y, pworld.z + 1000))
            down = mathutils.Vector((0, 0, -1))
            hit = bvh.ray_cast(origin, down)
            terrain_z = hit[0].z if hit[0] is not None else None
            delta = (pworld.z - terrain_z) if terrain_z is not None else None
            samples.append({
                "spline": sp_idx, "i": i,
                "road_z": round(pworld.z, 3),
                "terrain_z": round(terrain_z, 3) if terrain_z is not None else None,
                "delta": round(delta, 3) if delta is not None else None,
                "float": round(pt.weight_softbody, 3) if spline.type == 'BEZIER' else 0,
            })

    elevated = [s for s in samples
                if s["delta"] is not None and s["delta"] > threshold]
    return {
        "blend": blend_path,
        "terrain_object": terrain.name,
        "threshold": threshold,
        "total_pts": len(samples),
        "elevated_pts": len(elevated),
        "samples": samples,
    }


def main() -> None:
    argv = sys.argv
    if "--" in argv:
        rest = argv[argv.index("--") + 1:]
    else:
        rest = []
    threshold = float(rest[0]) if rest else 3.5
    out = audit(bpy.data.filepath, threshold)
    # Emit a clearly delimited JSON block so the wrapper script can
    # parse it out of Blender's noisy stderr/stdout.
    print("===AUDIT_JSON_BEGIN===")
    print(json.dumps(out, indent=2))
    print("===AUDIT_JSON_END===")


if __name__ == "__main__":
    main()
