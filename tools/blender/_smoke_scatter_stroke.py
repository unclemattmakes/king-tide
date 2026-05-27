"""Smoke test — exercise HV_StrokeScatter end-to-end on any track .blend.

  1. Confirms the hoverbike addon is registered (or registers it).
  2. Runs ``hoverbike.add_scatter_stroke`` to drop a palm stroke at the
     3D cursor and attach HV_StrokeScatter to the surf mesh.
  3. Evaluates the modifier on the depsgraph and counts emitted
     instances. Expects > 0 instances (default 12 m curve at width 8,
     density 0.1 → ribbon area ≈ 12 × 16 = 192 m² × 0.1 = ~19 instances).
  4. Adds a second rock stroke and re-evaluates — confirms two strokes
     of different prop types coexist in the same scene.

Pass: both strokes produce > 0 instances on the evaluated depsgraph.
Fail: zero instances on either stroke (graph misconfigured), or
operator errors.

Invocation:
    "$BLENDER_EXE" --background tracks-src/<id>.blend \
        --python tools/blender/_smoke_scatter_stroke.py
"""

from __future__ import annotations

import os
import sys

import bpy


def _enable_addon() -> bool:
    blend = bpy.data.filepath
    if not blend:
        print("FAIL: no .blend loaded")
        return False
    repo = os.path.dirname(os.path.dirname(blend))
    addons_root = os.path.join(repo, "tools", "blender")
    if addons_root not in sys.path:
        sys.path.insert(0, addons_root)
    try:
        import hoverbike_addon  # type: ignore
    except ImportError as e:
        print(f"FAIL: hoverbike_addon import: {e}")
        return False
    if not hasattr(bpy.ops.hoverbike, "add_scatter_stroke"):
        try:
            hoverbike_addon.register()
        except (RuntimeError, ValueError) as e:
            print(f"FAIL: addon register: {e}")
            return False
        print("OK: addon registered fresh")
    else:
        print("OK: addon already registered by Blender startup")
    return True


def _count_instances(surf_name: str) -> int:
    surf = bpy.data.objects.get(surf_name)
    if surf is None:
        return -1
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    count = 0
    for inst in dg.object_instances:
        if inst.parent and inst.parent.original == surf:
            count += 1
    return count


def _add_stroke(prop_key: str) -> str | None:
    """Add one stroke of the given prop type; return the surf-object
    name on success, None on failure."""
    try:
        bpy.ops.hoverbike.add_scatter_stroke(prop=prop_key)
    except RuntimeError as e:
        print(f"FAIL: add_scatter_stroke prop={prop_key}: {e}")
        return None
    # The operator selects + activates the curve. Find the surf via
    # the active object's parent (the empty), then the empty's other
    # mesh child.
    curve_obj = bpy.context.active_object
    if curve_obj is None or curve_obj.parent is None:
        print(f"FAIL: stroke prop={prop_key} — active object after Add not set up as expected")
        return None
    empty = curve_obj.parent
    surf = next(
        (c for c in empty.children if c.type == "MESH" and c.name.endswith("_surf")),
        None,
    )
    if surf is None:
        print(f"FAIL: stroke prop={prop_key} — no _surf mesh under {empty.name}")
        return None
    print(f"OK: added {empty.name} ({curve_obj.name}, {surf.name})")
    return surf.name


def main() -> int:
    if not _enable_addon():
        return 1

    palm_surf = _add_stroke("palm")
    if palm_surf is None:
        return 1
    palm_count = _count_instances(palm_surf)
    print(f"OK: palm stroke produced {palm_count} instances")
    if palm_count <= 0:
        print(f"FAIL: expected > 0 palm instances, got {palm_count}")
        return 1

    rock_surf = _add_stroke("rock")
    if rock_surf is None:
        return 1
    rock_count = _count_instances(rock_surf)
    print(f"OK: rock stroke produced {rock_count} instances")
    if rock_count <= 0:
        print(f"FAIL: expected > 0 rock instances, got {rock_count}")
        return 1

    # Confirm the two strokes coexist (palm count should be unchanged
    # after rock was added — they're independent modifiers).
    palm_count_after = _count_instances(palm_surf)
    if palm_count_after != palm_count:
        print(
            f"FAIL: palm count drifted from {palm_count} to {palm_count_after} "
            "after adding the rock stroke — strokes are not independent"
        )
        return 1
    print(f"OK: palm count stable ({palm_count}) after rock stroke added")

    print()
    print("PASS: scatter-stroke smoke test (Proposal C)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
