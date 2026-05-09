"""Shared helpers for the headless Blender builders.

This is a pure-Python module imported by every build_<category>.py
script. Anything specific to bikes, props, or tracks lives in those
scripts; anything reused (scene reset, spec loading, GLB export,
extras assignment, kind validation) lives here.

Importable from a smoke-test script:
    import sys, os
    sys.path.insert(0, os.path.join(REPO_ROOT, "tools"))
    from blender import common
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter
from typing import Any, Callable, Iterable

import bpy

# Repo root (two dirs up from this file: tools/blender/common.py).
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def reset_scene() -> None:
    """Wipe the default cube/light/camera and any leftover datablocks.

    Called at the top of every builder so the resulting GLB only
    contains content the builder explicitly added.
    """
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.curves,
        bpy.data.lights,
        bpy.data.cameras,
        bpy.data.armatures,
        bpy.data.images,
    ):
        for item in list(block):
            try:
                block.remove(item)
            except RuntimeError:
                pass


def read_spec(env_var: str = "HOVERBIKE_SPEC") -> dict[str, Any]:
    """Read the JSON spec referenced by an env var.

    The path may be absolute or repo-relative. Returns the parsed dict
    with the resolved path injected as ``__path__`` for diagnostics.
    """
    raw = os.environ.get(env_var)
    if not raw:
        raise SystemExit(f"[builder] {env_var} not set — pass via env var")
    path = raw if os.path.isabs(raw) else os.path.join(REPO_ROOT, raw)
    if not os.path.exists(path):
        raise SystemExit(f"[builder] spec not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        spec = json.load(f)
    spec["__path__"] = path
    return spec


def output_path(env_var: str = "HOVERBIKE_OUTPUT", default: str | None = None) -> str:
    """Resolve the output path from an env var (or default)."""
    raw = os.environ.get(env_var) or default
    if not raw:
        raise SystemExit(f"[builder] {env_var} not set and no default supplied")
    return raw if os.path.isabs(raw) else os.path.join(REPO_ROOT, raw)


def apply_extras(obj: bpy.types.Object, **kwargs: Any) -> None:
    """Set glTF custom properties on an object.

    Blender's glTF exporter copies object custom properties into
    ``extras`` verbatim, so this is just dict assignment with
    JSON-friendly value coercion.
    """
    for key, value in kwargs.items():
        if isinstance(value, (list, tuple)):
            obj[key] = list(value)
        elif isinstance(value, bool):
            # Blender stores bools as ints; we'd rather see real bools
            # in extras for runtime ergonomics. The exporter respects
            # the python type if assigned via ID property API.
            obj[key] = bool(value)
        else:
            obj[key] = value


def validate_required_kinds(
    required: dict[str, int | tuple[int, int | None]],
    extras_key: str = "kind",
) -> list[str]:
    """Assert the scene has the right per-kind object counts.

    ``required`` maps kind → exact count, or kind → (min, max). ``max``
    of ``None`` means "no upper bound".

    Returns the list of validation errors. Empty list = pass.
    """
    counts: Counter[str] = Counter()
    for obj in bpy.data.objects:
        kind = obj.get(extras_key)
        if isinstance(kind, str):
            counts[kind] += 1

    errors: list[str] = []
    for kind, bounds in required.items():
        n = counts.get(kind, 0)
        if isinstance(bounds, tuple):
            lo, hi = bounds
            if n < lo:
                errors.append(f"kind={kind!r} count={n} below required minimum {lo}")
            if hi is not None and n > hi:
                errors.append(f"kind={kind!r} count={n} above allowed maximum {hi}")
        else:
            if n != bounds:
                errors.append(f"kind={kind!r} count={n} != expected {bounds}")
    return errors


def export_glb(
    out_path: str,
    validators: Iterable[Callable[[], list[str]]] = (),
    *,
    export_animations: bool = False,
    export_skins: bool = False,
) -> None:
    """Run validators and export the scene to GLB.

    Validators are zero-arg callables returning ``list[str]`` of
    errors. Any error aborts before writing the GLB.
    """
    all_errors: list[str] = []
    for v in validators:
        all_errors.extend(v())
    if all_errors:
        print("[builder] VALIDATION FAILED:", file=sys.stderr)
        for e in all_errors:
            print(f"  - {e}", file=sys.stderr)
        raise SystemExit(1)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    print(f"[builder] writing {out_path}")

    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_extras=True,
        export_yup=True,
        export_apply=True,
        use_selection=False,
        use_visible=False,
        use_renderable=False,
        use_active_collection=False,
        export_cameras=False,
        export_lights=False,
        export_animations=export_animations,
        export_skins=export_skins,
    )
    print("[builder] done")
