"""
Build tracks-src/calibration.blend — a deliberately-minimal scene containing
exactly one of every metadata-bearing object kind documented in
docs/blender-conventions.md.

Run from the repo root:
    blender --background --python tools/build_calibration_scene.py

The script:
  1. Wipes the default cube/light/camera.
  2. Adds a flat track surface mesh (12x18m) with material `mat_track_main`.
  3. Adds one water_volume_main (empty cube) with custom props.
  4. Adds 4 ordered checkpoints (cp_00..cp_03) along the track.
  5. Adds an ai_spline_main NURBS curve following the centerline.
  6. Adds one pickup_main spawn.
  7. Adds two start_00 / start_01 grid positions.
  8. Saves the result to tracks-src/calibration.blend.

Run tools/export_track.py against this .blend to produce calibration.glb. The
runtime track loader will validate that every metadata kind is present.
"""

from __future__ import annotations

import os
import sys

import bpy
from mathutils import Vector

# Repo root resolution — the script lives in <repo>/tools/.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "calibration.blend")


def reset_scene() -> None:
    """Wipe everything so the scene is reproducible."""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.lights):
        for item in list(block):
            block.remove(item)


def add_track_surface() -> bpy.types.Object:
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = "track_surface"
    obj.scale = (12, 18, 1)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    mat = bpy.data.materials.new(name="mat_track_main")
    obj.data.materials.append(mat)
    obj["kind"] = "track"
    return obj


def add_water_volume() -> bpy.types.Object:
    bpy.ops.object.empty_add(type="CUBE", location=(0, 12, 0))
    obj = bpy.context.active_object
    obj.name = "water_volume_main"
    obj.scale = (40, 40, 4)
    obj["kind"] = "water"
    obj["wave_height"] = 1.0
    obj["wave_freq"] = 0.5
    return obj


def add_checkpoints() -> list[bpy.types.Object]:
    """4 ordered gates along the +Y axis."""
    out: list[bpy.types.Object] = []
    for i, y in enumerate([-6.0, -2.0, 2.0, 6.0]):
        bpy.ops.object.empty_add(type="ARROWS", location=(0, y, 1.5))
        obj = bpy.context.active_object
        obj.name = f"cp_{i:02d}"
        obj["kind"] = "checkpoint"
        obj["index"] = i
        # Gate envelope — half_width is half of the full gate horizontal
        # span, height is the vertical clearance. Real tracks use 14 / 6.
        # The calibration's track surface is only 12m wide so we use a
        # tighter envelope here (4 / 2) to keep the gates inside.
        obj["half_width"] = 4.0
        obj["height"] = 2.0
        out.append(obj)
    return out


def add_ai_spline() -> bpy.types.Object:
    """NURBS curve traversing the track centerline."""
    curve_data = bpy.data.curves.new(name="ai_spline_main", type="CURVE")
    curve_data.dimensions = "3D"
    spline = curve_data.splines.new(type="NURBS")
    points = [(0, -8, 0.5), (0, -4, 0.5), (0, 0, 0.5), (0, 4, 0.5), (0, 8, 0.5)]
    spline.points.add(len(points) - 1)  # NURBS spline starts with 1 point
    for i, (x, y, z) in enumerate(points):
        spline.points[i].co = (x, y, z, 1.0)
    spline.use_endpoint_u = True
    obj = bpy.data.objects.new("ai_spline_main", curve_data)
    bpy.context.collection.objects.link(obj)
    obj["kind"] = "ai_spline"
    obj["branch"] = "main"
    return obj


def add_pickup_spawn() -> bpy.types.Object:
    bpy.ops.object.empty_add(type="SPHERE", location=(0, 0, 1.0))
    obj = bpy.context.active_object
    obj.name = "pickup_main"
    obj["kind"] = "pickup_spawn"
    return obj


def add_player_starts() -> list[bpy.types.Object]:
    out: list[bpy.types.Object] = []
    for i, x in enumerate([-1.0, 1.0]):
        bpy.ops.object.empty_add(type="ARROWS", location=(x, -10.0, 0.5))
        obj = bpy.context.active_object
        obj.name = f"start_{i:02d}"
        obj["kind"] = "start"
        obj["index"] = i
        out.append(obj)
    return out


def add_lighting() -> None:
    bpy.ops.object.light_add(type="SUN", location=(10, 10, 20))
    sun = bpy.context.active_object
    sun.name = "sun"
    sun.data.energy = 4.0


def main() -> None:
    print(f"[calibration] writing {OUTPUT_PATH}")
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)

    reset_scene()
    add_track_surface()
    add_water_volume()
    add_checkpoints()
    add_ai_spline()
    add_pickup_spawn()
    add_player_starts()
    add_lighting()

    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    print(f"[calibration] done — {len(bpy.data.objects)} objects in scene")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[calibration] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
