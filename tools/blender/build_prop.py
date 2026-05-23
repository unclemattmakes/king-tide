"""Headless prop GLB builder. Spec → GLB.

Run:
    HOVERBIKE_SPEC=specs/props/barrier_low.json \\
    HOVERBIKE_OUTPUT=public/assets/props/barrier_low.glb \\
      blender --background --python tools/blender/build_prop.py

Reads the spec, appends a single kit part from
tools/blender/lib/prop_kit.blend, applies scale + tint, attaches a
primitive collider per spec.collider, validates, and exports.

Authoring frame matches build_bike.py: Blender X=right, Z=up; the yup
exporter rotates Blender Y/Z so three sees Y up. ``halfExtents`` in
the spec is already in three's axes ([right, up, forward]) so the
runtime can use it without remapping.
"""

from __future__ import annotations

import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(_SCRIPT_DIR))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import bpy  # noqa: E402

from tools.blender.common import (  # noqa: E402
    REPO_ROOT,
    apply_extras,
    export_glb,
    output_path,
    read_spec,
    reset_scene,
    validate_required_kinds,
)
from tools.blender.lib_loader import append_objects  # noqa: E402

KIT_BLEND = os.path.join(REPO_ROOT, "tools", "blender", "lib", "prop_kit.blend")


def hex_to_rgba(s: str) -> tuple[float, float, float, float]:
    s = s.lstrip("#")
    r = int(s[0:2], 16) / 255.0
    g = int(s[2:4], 16) / 255.0
    b = int(s[4:6], 16) / 255.0
    return (r ** 2.2, g ** 2.2, b ** 2.2, 1.0)


def make_material(name: str, color_hex: str) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = hex_to_rgba(color_hex)
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = 0.6
    return mat


def select_only(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def build_collider_extras(coll_spec: dict) -> dict:
    """Map spec.collider → flat extras dict for the runtime."""
    out: dict = {"kind": "collider", "shape": coll_spec["shape"]}
    if coll_spec["shape"] == "box":
        out["half_extents"] = list(coll_spec.get("halfExtents", [1.0, 1.0, 1.0]))
    if "radius" in coll_spec:
        out["radius"] = float(coll_spec["radius"])
    if "height" in coll_spec:
        out["height"] = float(coll_spec["height"])
    return out


def build() -> None:
    spec = read_spec()
    prop_id = spec["id"]
    geom = spec["geometry"]
    coll_spec = spec["collider"]

    out = output_path()
    print(f"[build-prop] {prop_id} -> {out}")

    reset_scene()

    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    prop_root = bpy.context.active_object
    prop_root.name = "prop_root"
    # The optional ``waveRider`` block opts the prop into the runtime
    # wave-rider entity path. The runtime keys on the sibling
    # ``wave_rider_archetype`` extras key — kind stays ``"prop"`` so
    # existing track loaders / asset registries continue to recognise
    # the GLB exactly the same way. Known archetypes are validated on
    # load (see ``src/game/assets/prop-loader.ts``); unknown strings
    # warn and fall back to a static prop at runtime.
    root_extras: dict[str, object] = {
        "kind": "prop",
        "prop_id": prop_id,
        "category": spec.get("category", "decor"),
    }
    wave_rider_spec = spec.get("waveRider")
    if isinstance(wave_rider_spec, dict):
        arche = wave_rider_spec.get("archetype")
        if isinstance(arche, str):
            root_extras["wave_rider_archetype"] = arche
    apply_extras(prop_root, **root_extras)

    [body] = append_objects(KIT_BLEND, [geom["kitPart"]])
    body.name = "prop_body"
    sx, sy, sz = geom["scale"]
    body.scale = (sx, sy, sz)
    select_only(body)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    body.parent = prop_root

    tint_mat = make_material(f"mat_prop_{prop_id}", geom["tint"])
    body.data.materials.clear()
    body.data.materials.append(tint_mat)

    # Collider — primitive empty whose extras carry the runtime's
    # description. We pick a gizmo type matching the shape so authors
    # can see it in viewport when editing the kit later.
    extras = build_collider_extras(coll_spec)
    gizmo = {
        "box": "CUBE",
        "capsule": "SPHERE",
        "cylinder": "CIRCLE",
        "sphere": "SPHERE",
    }.get(extras["shape"], "PLAIN_AXES")
    bpy.ops.object.empty_add(type=gizmo, location=(0, 0, 0))
    coll = bpy.context.active_object
    coll.name = "collider_body"
    coll.parent = prop_root
    apply_extras(coll, **extras)

    def validators() -> list[str]:
        return validate_required_kinds({"prop": 1, "collider": (1, None)})

    export_glb(out, validators=[validators])


if __name__ == "__main__":
    try:
        build()
    except SystemExit:
        raise
    except Exception as e:
        print(f"[build-prop] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
