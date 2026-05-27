"""Diagnose path-wear visualisation on the loaded .blend.

Walks the whole chain from authored AI spline → baked_path FLOAT →
COLOR_0.B → mat_terrain_main's dirt-tint node block. Reports which
step (if any) is producing zeroes.

Invocation:
    "$BLENDER_EXE" --background tracks-src/<id>.blend \
        --python tools/blender/_diag_path_wear.py
"""

from __future__ import annotations

import sys

import bpy
from mathutils import Vector


def _largest_terrain_or_named() -> bpy.types.Object | None:
    obj = bpy.data.objects.get("terrain")
    if obj is not None and obj.type == "MESH":
        return obj
    best = None
    best_area = -1.0
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        if str(o.get("kind", "")) != "track":
            continue
        me = o.data
        area = sum(p.area for p in me.polygons)
        if area > best_area:
            best_area = area
            best = o
    return best


def main() -> int:
    print("=" * 60)
    print("Path-wear diagnostic")
    print("=" * 60)
    blend = bpy.data.filepath
    if not blend:
        print("FAIL: no .blend loaded")
        return 1
    print(f"blend file: {blend}")

    # 1. Find the AI spline.
    spline = bpy.data.objects.get("ai_spline_main")
    if spline is None:
        print("FAIL: no ai_spline_main in scene")
        return 1
    if spline.type != "CURVE":
        print(f"FAIL: ai_spline_main is type {spline.type}, expected CURVE")
        return 1
    n_anchors = sum(
        len(s.bezier_points) if s.type == "BEZIER" else len(s.points)
        for s in spline.data.splines
    )
    print(f"ai_spline_main: {n_anchors} control points, "
          f"resolution_u={spline.data.resolution_u}")

    # 2. Find the terrain.
    terrain = _largest_terrain_or_named()
    if terrain is None:
        print("FAIL: no terrain (no 'terrain' object, no kind=track mesh)")
        return 1
    me = terrain.data
    print(f"terrain: {terrain.name} ({len(me.vertices)} verts)")

    # 3. baked_path attribute — present? non-zero?
    if "baked_path" not in me.attributes:
        print("FAIL: terrain has no 'baked_path' attribute")
        print("      → run 'Bake AO + Path Wear' or 'Bake Path-Worn' first")
        return 1
    path_attr = me.attributes["baked_path"]
    values = [d.value for d in path_attr.data]
    n_nonzero = sum(1 for v in values if v > 0.001)
    vmax = max(values)
    vmean = sum(values) / len(values) if values else 0.0
    print(f"baked_path: {n_nonzero}/{len(values)} verts non-zero, "
          f"max={vmax:.3f}, mean={vmean:.4f}")
    if n_nonzero == 0:
        print("FAIL: baked_path is all zero — bake didn't write any wear")
        print("      → check ai_spline_main has at least 2 control points")
        print("      → check spline + terrain XY overlap")
        return 1

    # 4. COLOR_0 — does the .B channel match baked_path?
    if "COLOR_0" not in me.color_attributes:
        print("FAIL: terrain has no COLOR_0 attribute")
        print("      → run 'Apply Terrain Vertex Colors'")
        return 1
    col = me.color_attributes["COLOR_0"]
    color_b_values = [d.color[2] for d in col.data]
    n_b_nonzero = sum(1 for v in color_b_values if v > 0.001)
    bmax = max(color_b_values)
    bmean = sum(color_b_values) / len(color_b_values) if color_b_values else 0.0
    print(f"COLOR_0.B: {n_b_nonzero}/{len(color_b_values)} verts non-zero, "
          f"max={bmax:.3f}, mean={bmean:.4f}")
    if n_b_nonzero == 0:
        print("FAIL: COLOR_0.B is all zero — re-stamp didn't carry baked_path")
        print("      → run 'Apply Terrain Vertex Colors' after the bake")
        return 1
    # Sanity: do COLOR_0.B values agree with baked_path values?
    drift = sum(abs(values[i] - color_b_values[i]) for i in range(len(values)))
    drift_max = max(abs(values[i] - color_b_values[i]) for i in range(len(values)))
    print(f"COLOR_0.B vs baked_path drift: sum={drift:.4f}, max={drift_max:.4f}")
    if drift_max > 0.01:
        print("WARN: COLOR_0.B has drifted from baked_path — re-stamp recommended")

    # 5. mat_terrain_main assigned?
    mat_name = "mat_terrain_main"
    if mat_name not in bpy.data.materials:
        print(f"FAIL: '{mat_name}' material not in .blend")
        return 1
    mat = bpy.data.materials[mat_name]
    assigned = any(m is mat for m in me.materials)
    print(f"mat_terrain_main: present={'yes' if mat else 'no'}, "
          f"assigned to terrain={'yes' if assigned else 'no'}, "
          f"version={mat.get('hoverbike_terrain_material_version', '<missing>')}")
    if not assigned:
        print("FAIL: mat_terrain_main exists but isn't assigned to the terrain")
        print("      → re-run 'Apply Terrain Vertex Colors' or 'Add Terrain Material'")
        return 1

    # 6. Node graph — does the wear node block exist?
    nt = mat.node_tree
    if nt is None or not nt.nodes:
        print("FAIL: mat_terrain_main has no node tree")
        return 1
    node_kinds = [n.bl_idname for n in nt.nodes]
    has_separate_color = "ShaderNodeSeparateColor" in node_kinds
    color_attr_nodes = [
        n for n in nt.nodes
        if n.bl_idname == "ShaderNodeAttribute" and n.attribute_name == "COLOR_0"
    ]
    print(f"mat node tree: {len(nt.nodes)} nodes, {len(nt.links)} links")
    print(f"  has Separate Color node: {has_separate_color}")
    print(f"  COLOR_0 attribute readers: {len(color_attr_nodes)}")

    # Trace the wear path. Should find: SeparateColor.Blue → Multiply(0.8) → Mix(factor)
    sep_node = next(
        (n for n in nt.nodes if n.bl_idname == "ShaderNodeSeparateColor"),
        None,
    )
    if sep_node is None:
        print("FAIL: no Separate Color node — wear visualisation not in material")
        print("      → re-build mat_terrain_main (rebuild=True on Add Terrain Material)")
        return 1
    print(f"  Separate Color found ({sep_node.name})")
    # Blender's socket wrappers return new Python objects on each
    # attribute access, so identity comparison (``link.from_socket is
    # sock``) flakes. Compare by node identity + socket name instead.
    blue_links = [
        link for link in nt.links
        if link.from_node == sep_node and link.from_socket.name == "Blue"
    ]
    print(f"  Blue output has {len(blue_links)} outgoing link(s)")
    if not blue_links:
        print("FAIL: Separate Color's Blue output is unwired — wear can't reach the BSDF")
        return 1
    downstream = blue_links[0].to_node
    print(f"    → connects to: {downstream.bl_idname!r} ({downstream.name})")
    if downstream.bl_idname == "ShaderNodeMath":
        op = getattr(downstream, "operation", "?")
        mul_value = downstream.inputs[1].default_value if len(downstream.inputs) > 1 else None
        print(f"      operation={op!r}, multiplier={mul_value}")

    print()
    print("PASS: path-wear chain looks healthy.")
    print(f"  baked_path covers {n_nonzero} verts, COLOR_0.B carries it,")
    print(f"  mat_terrain_main v{mat.get('hoverbike_terrain_material_version', '?')} "
          f"reads COLOR_0 → Separate → wear → BSDF.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
