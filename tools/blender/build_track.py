"""Headless track GLB builder. Spec → .blend → GLB.

Run:
    HOVERBIKE_SPEC=specs/tracks/calibration.json \\
    HOVERBIKE_OUTPUT=public/assets/tracks/calibration.glb \\
      blender --background --python tools/blender/build_track.py

Replaces ``tools/build_calibration_scene.py``. Reads the JSON spec,
constructs the scene programmatically (matching the legacy script's
output one-for-one for spec.id="calibration"), saves a `.blend` to
``tracks-src/<id>.blend`` for human follow-up authoring, then invokes
the existing track exporter (``tools/export_track.py``) to produce the
GLB at ``HOVERBIKE_OUTPUT``.

The save path can be overridden via ``HOVERBIKE_BLEND`` (e.g. for CI
runs that don't want to write into the source tree). To skip the
.blend save entirely (GLB-only mode), set
``HOVERBIKE_SKIP_BLEND_SAVE=1``.
"""

from __future__ import annotations

import os
import subprocess
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(_SCRIPT_DIR))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import bpy  # noqa: E402

from tools.blender.common import (  # noqa: E402
    REPO_ROOT,
    output_path,
    read_spec,
    reset_scene,
)


def add_track_surface(spec: dict) -> bpy.types.Object:
    surface = spec.get("surface", {})
    size = surface.get("size", [12, 18])
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = "track_surface"
    obj.scale = (float(size[0]), float(size[1]), 1.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    mat = bpy.data.materials.new(name="mat_track_main")
    obj.data.materials.append(mat)
    obj["kind"] = "track"
    return obj


def add_water_volume(spec: dict) -> bpy.types.Object | None:
    water = spec.get("water")
    if water is None:
        return None
    center = water.get("center", [0, 0, 0])
    extents = water.get("extents", [40, 40, 4])
    bpy.ops.object.empty_add(type="CUBE", location=tuple(center))
    obj = bpy.context.active_object
    obj.name = "water_volume_main"
    obj.scale = tuple(extents)
    obj["kind"] = "water"
    obj["wave_height"] = float(water.get("waveHeight", 1.0))
    obj["wave_freq"] = float(water.get("waveFreq", 0.5))
    return obj


def add_checkpoints(spec: dict) -> list[bpy.types.Object]:
    cps = spec.get("checkpoints", [])
    out: list[bpy.types.Object] = []
    for i, cp in enumerate(cps):
        x = float(cp.get("x", 0))
        y = float(cp["y"])
        z = float(cp.get("z", 1.5))
        bpy.ops.object.empty_add(type="ARROWS", location=(x, y, z))
        obj = bpy.context.active_object
        obj.name = f"cp_{i:02d}"
        obj["kind"] = "checkpoint"
        obj["index"] = i
        obj["half_width"] = float(cp["halfWidth"])
        obj["height"] = float(cp["height"])
        out.append(obj)
    return out


def add_ai_spline(spec: dict) -> bpy.types.Object | None:
    pts = spec.get("aiSpline")
    if not pts:
        return None
    curve_data = bpy.data.curves.new(name="ai_spline_main", type="CURVE")
    curve_data.dimensions = "3D"
    spline = curve_data.splines.new(type="NURBS")
    spline.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        spline.points[i].co = (float(p[0]), float(p[1]), float(p[2]), 1.0)
    spline.use_endpoint_u = True
    obj = bpy.data.objects.new("ai_spline_main", curve_data)
    bpy.context.collection.objects.link(obj)
    obj["kind"] = "ai_spline"
    obj["branch"] = "main"
    return obj


def add_pickup_spawns(spec: dict) -> list[bpy.types.Object]:
    pickups = spec.get("pickups", [])
    out: list[bpy.types.Object] = []
    for i, p in enumerate(pickups):
        bpy.ops.object.empty_add(type="SPHERE", location=tuple(float(x) for x in p))
        obj = bpy.context.active_object
        obj.name = "pickup_main" if (i == 0 and len(pickups) == 1) else f"pickup_{i:02d}"
        obj["kind"] = "pickup_spawn"
        out.append(obj)
    return out


def add_player_starts(spec: dict) -> list[bpy.types.Object]:
    starts = spec.get("starts", [])
    out: list[bpy.types.Object] = []
    for i, p in enumerate(starts):
        bpy.ops.object.empty_add(type="ARROWS", location=tuple(float(x) for x in p))
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


def build() -> None:
    spec = read_spec()
    track_id = spec["id"]
    out_glb = output_path()
    print(f"[build-track] {track_id} -> {out_glb}")

    reset_scene()
    add_track_surface(spec)
    add_water_volume(spec)
    add_checkpoints(spec)
    add_ai_spline(spec)
    add_pickup_spawns(spec)
    add_player_starts(spec)
    add_lighting()

    # Save the .blend so authors can open and tweak. The legacy
    # build_calibration_scene.py wrote to tracks-src/<id>.blend; we
    # preserve that path for compatibility.
    skip_blend_save = os.environ.get("HOVERBIKE_SKIP_BLEND_SAVE") == "1"
    blend_override = os.environ.get("HOVERBIKE_BLEND")
    if blend_override:
        blend_path = (
            blend_override
            if os.path.isabs(blend_override)
            else os.path.join(REPO_ROOT, blend_override)
        )
    else:
        blend_path = os.path.join(REPO_ROOT, "tracks-src", f"{track_id}.blend")

    if not skip_blend_save:
        os.makedirs(os.path.dirname(blend_path), exist_ok=True)
        print(f"[build-track] saving {blend_path}")
        bpy.ops.wm.save_as_mainfile(filepath=blend_path)

    # Now export to GLB by invoking the canonical exporter against the
    # in-memory scene. We can't re-invoke Blender from inside Blender,
    # so we use the export logic directly.
    export_track_path = os.path.join(REPO_ROOT, "tools", "export_track.py")
    if os.path.exists(export_track_path):
        # Pass HOVERBIKE_OUTPUT through; export_track.py reads it for the
        # output path and validates the in-memory scene.
        os.environ["HOVERBIKE_OUTPUT"] = out_glb
        with open(export_track_path, "r", encoding="utf-8") as f:
            code = compile(f.read(), export_track_path, "exec")
        # Run as __main__ so its `if __name__ == "__main__"` block fires.
        glb: dict = {"__name__": "__main__", "__file__": export_track_path}
        try:
            exec(code, glb)
        except SystemExit as e:
            if e.code not in (0, None):
                raise
        print(f"[build-track] done -> {out_glb}")
    else:
        raise SystemExit(f"[build-track] tools/export_track.py not found at {export_track_path}")


if __name__ == "__main__":
    try:
        build()
    except SystemExit:
        raise
    except Exception as e:
        print(f"[build-track] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
