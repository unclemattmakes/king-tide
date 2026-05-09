"""
Export a Blender .blend to a glTF .glb with per-object metadata in `extras`.

Run from the repo root:
    blender --background tracks-src/calibration.blend --python tools/export_track.py

By default, writes to public/assets/tracks/<basename>.glb. Override the output
path via the HOVERBIKE_OUTPUT environment variable:
    HOVERBIKE_OUTPUT=public/assets/tracks/calibration.glb \
      blender --background tracks-src/calibration.blend --python tools/export_track.py

Validation:
  * Each named-by-convention object must have a `kind` custom property.
  * cp_NN indices must be contiguous starting from 0.
  * Exactly one ai_spline_main is required.
The exporter prints a summary and aborts with exit code 1 if validation fails.
"""

from __future__ import annotations

import os
import re
import sys
from collections import defaultdict

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)


# Recognised name patterns — these MUST carry a `kind` custom property.
NAME_PATTERNS = [
    (re.compile(r"^water_volume(_.*)?$"), "water"),
    (re.compile(r"^cp_(\d+)$"), "checkpoint"),
    (re.compile(r"^ai_spline_(.+)$"), "ai_spline"),
    (re.compile(r"^pickup(_.*)?$"), "pickup_spawn"),
    (re.compile(r"^start_(\d+)$"), "start"),
]


def is_object_visible(obj: bpy.types.Object) -> bool:
    """True iff the object is visible in the active view layer.

    Hidden objects (eye icon off, or in a hidden collection) are
    skipped by validation, baking, and the GLB export so authors
    can stage WIP or reference geometry without it leaking into the
    game build.
    """
    try:
        return bool(obj.visible_get())
    except RuntimeError:
        return False


def bake_ai_splines() -> None:
    """Sample every visible ai_spline_* curve into a flat
    [x0,y0,z0,...] custom property on the same object. glTF doesn't
    carry NURBS curves natively, so we bake the geometry into extras
    at export time. Authors keep editing the curve in Blender; the
    exported .glb gets the points. Hidden curves are skipped.
    """
    for obj in list(bpy.data.objects):
        if not obj.name.startswith("ai_spline_") or obj.type != "CURVE":
            continue
        if not is_object_visible(obj):
            continue
        # `to_mesh` honours the curve's resolution_u and gives evaluated
        # vertices in object-local space. We then transform to world.
        mesh = obj.to_mesh()
        try:
            mw = obj.matrix_world
            verts = [mw @ v.co for v in mesh.vertices]
        finally:
            obj.to_mesh_clear()
        flat: list[float] = []
        for v in verts:
            flat.extend([float(v.x), float(v.y), float(v.z)])
        obj["points"] = flat
        print(f"[export] baked {obj.name}: {len(verts)} sampled points")


def expected_kind(name: str) -> str | None:
    for pat, kind in NAME_PATTERNS:
        if pat.match(name):
            return kind
    return None


def validate_scene() -> list[str]:
    errors: list[str] = []
    by_kind: dict[str, list[bpy.types.Object]] = defaultdict(list)

    for obj in bpy.data.objects:
        kind = expected_kind(obj.name)
        if kind is None:
            continue
        if not is_object_visible(obj):
            continue
        if "kind" not in obj.keys():
            errors.append(f"{obj.name}: missing custom property 'kind'")
            continue
        if obj["kind"] != kind:
            errors.append(
                f"{obj.name}: kind='{obj['kind']}' does not match name pattern (expected '{kind}')"
            )
        by_kind[kind].append(obj)

    # Checkpoint indices must be 0, 1, 2, ... contiguous.
    cps = sorted(by_kind.get("checkpoint", []), key=lambda o: o.name)
    for i, cp in enumerate(cps):
        if cp.get("index") != i:
            errors.append(f"{cp.name}: index={cp.get('index')} does not match position {i}")

    # Exactly one ai_spline named ai_spline_main, and it must have baked
    # points (set by bake_ai_splines). Empty splines are useless to the
    # runtime loader.
    splines = by_kind.get("ai_spline", [])
    main = next((o for o in splines if o.name == "ai_spline_main"), None)
    if main is None:
        errors.append("missing required object: ai_spline_main")
    else:
        pts = main.get("points")
        if pts is None or len(pts) < 6:
            errors.append(
                f"ai_spline_main: needs at least 2 points (got {len(pts) if pts else 0} floats)"
            )

    # Each checkpoint must declare half_width and height for the gate envelope.
    for cp in by_kind.get("checkpoint", []):
        for prop in ("half_width", "height"):
            if cp.get(prop) is None:
                errors.append(f"{cp.name}: missing custom property '{prop}'")

    return errors


def output_path() -> str:
    override = os.environ.get("HOVERBIKE_OUTPUT")
    if override:
        if os.path.isabs(override):
            return override
        return os.path.join(REPO_ROOT, override)
    blend = bpy.data.filepath
    base = os.path.splitext(os.path.basename(blend))[0] if blend else "track"
    return os.path.join(REPO_ROOT, "public", "assets", "tracks", f"{base}.glb")


def main() -> None:
    print(f"[export] validating {bpy.data.filepath or '<unsaved>'}")
    bake_ai_splines()
    errors = validate_scene()
    if errors:
        print("[export] VALIDATION FAILED:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    out = output_path()
    os.makedirs(os.path.dirname(out), exist_ok=True)
    print(f"[export] writing {out}")

    # Make sure all objects export — Blender's glTF exporter only includes
    # selected/visible-collection-default depending on version. We force-export
    # the entire scene with extras.
    # Visible-only export: hidden objects (eye icon off in the
    # outliner, or in a hidden collection) are excluded. Mirrors the
    # validation + bake filters above so an author can park WIP /
    # reference geometry in the .blend without it bleeding into the
    # game build.
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        export_extras=True,
        export_yup=True,
        export_apply=True,
        use_selection=False,
        use_visible=True,
        use_renderable=False,
        use_active_collection=False,
        export_cameras=False,
        export_lights=False,
    )
    print("[export] done")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[export] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
