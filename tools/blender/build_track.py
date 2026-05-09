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

import json
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


def emit_gameplay_json(spec: dict, glb_url: str) -> dict:
    """Build the runtime gameplay JSON (`public/tracks/<id>.json`) from
    the same spec the GLB was built from.

    Axis convention: spec coords are Blender (X right, Y forward, Z up)
    matching the export_track.py yup conversion. We flip into three.js
    axes (X right, Y up, Z forward; Blender +Y → three -Z) so the
    runtime can use the JSON without remapping.
    """
    cps_spec = spec.get("checkpoints", [])
    starts_spec = spec.get("starts", [])
    pickups_spec = spec.get("pickups", [])
    spline_pts_spec = spec.get("aiSpline", [])
    water_spec = spec.get("water") or {}

    def b2t(p: list[float]) -> dict:
        # Blender (x, y, z) → three (x, z, -y).
        return {"x": float(p[0]), "y": float(p[2]), "z": -float(p[1])}

    checkpoints = []
    for i, cp in enumerate(cps_spec):
        cx = float(cp.get("x", 0.0))
        cy = float(cp.get("y", 0.0))
        cz = float(cp.get("z", 1.5))
        checkpoints.append({
            "index": i,
            "position": {"x": cx, "y": cz, "z": -cy},
            "rotation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
            "halfWidth": float(cp["halfWidth"]),
            "height": float(cp["height"]),
        })

    if not starts_spec:
        raise ValueError("track spec must have at least one entry in `starts`")
    start = b2t(starts_spec[0])

    json_body: dict = {
        "id": spec["id"],
        "name": spec.get("displayName", spec["id"]),
        "lapsToFinish": int(spec.get("lapsToFinish", 1)),
        "environmentGlb": glb_url,
        "water": {
            "height": 0.0,
            "waveHeight": float(water_spec.get("waveHeight", 1.0)),
            "waveFreq": float(water_spec.get("waveFreq", 0.5)),
        },
        "start": {
            "position": start,
            # Default yaw 0 — pointing at the first checkpoint. Authors
            # who need a specific yaw can hand-edit after first emit.
            "yaw": 0.0,
        },
        "checkpoints": checkpoints,
        "aiSplines": [
            {
                "id": "main",
                "points": [b2t(p) for p in spline_pts_spec],
            }
        ],
        "pickupSpawns": [b2t(p) for p in pickups_spec],
        "boostPads": [],
    }
    return json_body


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

    # Also emit the runtime gameplay JSON so a single `pnpm gen:tracks`
    # produces a fully playable track. Path:
    # `public/tracks/<id>.json`. We DON'T overwrite an existing file by
    # default — once the in-app editor has saved a tuned version, the
    # spec is no longer the source of truth for gameplay placement.
    # Override with HOVERBIKE_FORCE_GAMEPLAY_JSON=1 to overwrite.
    gameplay_path = os.path.join(REPO_ROOT, "public", "tracks", f"{track_id}.json")
    glb_rel_url = f"/assets/tracks/{track_id}.glb"
    body = emit_gameplay_json(spec, glb_rel_url)
    force = os.environ.get("HOVERBIKE_FORCE_GAMEPLAY_JSON") == "1"
    if os.path.exists(gameplay_path) and not force:
        print(
            f"[build-track] preserving existing {gameplay_path} "
            f"(set HOVERBIKE_FORCE_GAMEPLAY_JSON=1 to overwrite)"
        )
    else:
        os.makedirs(os.path.dirname(gameplay_path), exist_ok=True)
        with open(gameplay_path, "w", encoding="utf-8") as f:
            json.dump(body, f, indent=2)
            f.write("\n")
        print(f"[build-track] wrote {gameplay_path}")


if __name__ == "__main__":
    try:
        build()
    except SystemExit:
        raise
    except Exception as e:
        print(f"[build-track] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
