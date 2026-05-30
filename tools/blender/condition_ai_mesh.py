"""Condition an AI-generated mesh into a pipeline-legal Hoverbike prop.

AI text/image-to-3D generators (Hyper3D Rodin, Meshy, Tripo, TRELLIS,
Hunyuan3D) emit dense, un-instanced, arbitrary-topology meshes with none
of this engine's contract: no ``COLOR_0`` vertex attribute, no ``kind``
extras, no primitive collider, wrong scale, and a generator material the
runtime doesn't understand. This module is the **conditioning pass** from
docs/props-production-plan.md — the leverage step that makes generation
actually usable. Generation is minutes; conditioning is the hour, so it
lives here, once, reused for every generated asset.

What it does to a raw mesh object:
  1. Decimate to a race-pace triangle budget.
  2. Orient to the authoring frame (Blender Z-up) and recenter the origin
     to bottom-centre so the prop sits on the ground.
  3. Optionally rescale to a target height (the "reads at 40 m/s",
     larger-than-life pillar — pass a generous height).
  4. Strip the generator material; assign a single ``mat_<family>_<id>``
     in the one-shader-per-family convention.
  5. Stamp ``COLOR_0`` per docs/vertex-attribute-spec.md (terrain default
     for static props, linear sway for foliage).
  6. Wrap in a ``prop_<id>_root`` empty (kind=prop) + a primitive
     ``collider_body`` derived from the bounding box (kind=collider).

Two ways to run it:

  • INTERACTIVE (the Rodin loop) — after the AI asset lands in Blender
    (e.g. the ahujasid blender-mcp ``import_generated_asset``), select it
    and run::

        import sys; sys.path.insert(0, r"<repo root>")
        from tools.blender.condition_ai_mesh import condition_active
        condition_active(prop_id="coral_fan", family="prop",
                         target_tris=400, target_height=3.0, tint="#c86a5a")

    The conditioned ``prop_coral_fan`` collection is then ready to drag
    into ``props-library.blend`` (lock it with ``hv_locked`` if you hand
    tune it — see docs/asset-pipeline-guide.md) or export via build_prop.

  • HEADLESS (batch) — condition a file straight to a GLB::

        HOVERBIKE_INPUT=raw/coral_fan.glb HOVERBIKE_PROP_ID=coral_fan \\
        HOVERBIKE_OUTPUT=public/assets/props/coral_fan.glb \\
          blender --background --python tools/blender/condition_ai_mesh.py

Authoring frame matches build_prop.py / build_bike.py: Blender X=right,
Z=up, -Y=forward. glTF imports already arrive Z-up; pass ``source_up="Y"``
for raw OBJ exports that arrive Y-up.
"""

from __future__ import annotations

import os
import sys

import bpy

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(_SCRIPT_DIR))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from tools.blender.hoverbike_kinds import ExportedKind  # noqa: E402
from tools.blender.vertex_attrs import (  # noqa: E402
    DEFAULT_TERRAIN,
    set_constant,
    set_linear_sway_z,
)


# ────────────────────────────────────────────────────────────────────
# Small helpers
# ────────────────────────────────────────────────────────────────────

def _hex_to_rgba(s: str) -> tuple[float, float, float, float]:
    s = s.lstrip("#")
    r = int(s[0:2], 16) / 255.0
    g = int(s[2:4], 16) / 255.0
    b = int(s[4:6], 16) / 255.0
    return (r ** 2.2, g ** 2.2, b ** 2.2, 1.0)  # sRGB → linear


def _select_only(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def _apply_transforms(obj: bpy.types.Object) -> None:
    _select_only(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def _local_bbox(obj: bpy.types.Object) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """(min, max) corner of the object's mesh in local space."""
    cs = [v.co for v in obj.data.vertices]
    return (
        (min(c.x for c in cs), min(c.y for c in cs), min(c.z for c in cs)),
        (max(c.x for c in cs), max(c.y for c in cs), max(c.z for c in cs)),
    )


# ────────────────────────────────────────────────────────────────────
# Conditioning steps
# ────────────────────────────────────────────────────────────────────

def _orient_z_up(obj: bpy.types.Object, source_up: str) -> None:
    """Rotate a Y-up import into Blender Z-up. glTF imports are already
    Z-up (source_up='Z' → no-op); OBJ exports are often Y-up."""
    if source_up.upper() == "Y":
        import math
        obj.rotation_euler = (math.radians(90.0), 0.0, 0.0)
        _apply_transforms(obj)


def _decimate(obj: bpy.types.Object, target_tris: int) -> None:
    """Collapse-decimate down to roughly ``target_tris`` triangles. AI
    meshes are typically 50k–500k tris; props read fine at a few hundred."""
    tri_count = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    if tri_count <= target_tris or target_tris <= 0:
        return
    md = obj.modifiers.new("HV_Condition_Decimate", "DECIMATE")
    md.decimate_type = "COLLAPSE"
    md.ratio = max(0.01, min(1.0, target_tris / float(tri_count)))
    _select_only(obj)
    bpy.ops.object.modifier_apply(modifier=md.name)


def _recenter_bottom(obj: bpy.types.Object) -> None:
    """Move the mesh so its bounding box is centred on XY and its base
    sits on z=0, then zero the object's transform — props sit on ground."""
    (mnx, mny, mnz), (mxx, mxy, mxz) = _local_bbox(obj)
    cx, cy = (mnx + mxx) * 0.5, (mny + mxy) * 0.5
    for v in obj.data.vertices:
        v.co.x -= cx
        v.co.y -= cy
        v.co.z -= mnz
    obj.data.update()
    obj.location = (0.0, 0.0, 0.0)


def _rescale_to_height(obj: bpy.types.Object, target_height: float | None) -> None:
    if not target_height or target_height <= 0:
        return
    (_mn, _mny, mnz), (_mx, _mxy, mxz) = _local_bbox(obj)
    h = mxz - mnz
    if h <= 1e-6:
        return
    s = target_height / h
    for v in obj.data.vertices:
        v.co *= s
    obj.data.update()


def _assign_family_material(obj: bpy.types.Object, prop_id: str, family: str,
                            tint: str | None) -> str:
    """Strip generator materials; assign one ``mat_<family>_<id>``. family
    'foliage' opts the prop into the runtime sway shader by name."""
    mat_name = f"mat_{family}_{prop_id}"
    mat = bpy.data.materials.get(mat_name) or bpy.data.materials.new(mat_name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None and tint:
        bsdf.inputs["Base Color"].default_value = _hex_to_rgba(tint)
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = 0.8
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return mat_name


def _stamp_color0(obj: bpy.types.Object, foliage: bool) -> None:
    if foliage:
        (_mn, _mny, mnz), (_mx, _mxy, mxz) = _local_bbox(obj)
        set_linear_sway_z(obj.data, z_min=mnz, z_max=mxz * 1.1, ao=1.0)
    else:
        set_constant(obj.data, DEFAULT_TERRAIN)


def _add_box_collider(root: bpy.types.Object, obj: bpy.types.Object,
                      shape: str) -> bpy.types.Object:
    """Derive a primitive collider from the conditioned mesh bbox. Extents
    are written in THREE axes [right, up, forward] = Blender [X, Z, -Y],
    matching build_prop.py so the runtime uses them without remapping."""
    (mnx, mny, mnz), (mxx, mxy, mxz) = _local_bbox(obj)
    hx, hy, hz = (mxx - mnx) * 0.5, (mxy - mny) * 0.5, (mxz - mnz) * 0.5
    cz = (mnz + mxz) * 0.5
    gizmo = {"box": "CUBE", "sphere": "SPHERE", "cylinder": "CIRCLE",
             "capsule": "SPHERE"}.get(shape, "CUBE")
    bpy.ops.object.empty_add(type=gizmo, location=(0.0, 0.0, cz))
    coll = bpy.context.active_object
    coll.name = "collider_body"
    coll.parent = root
    extras = {"kind": ExportedKind.COLLIDER, "shape": shape}
    if shape == "box":
        extras["half_extents"] = [hx, hz, hy]            # → [right, up, forward]
    elif shape == "sphere":
        extras["radius"] = max(hx, hy, hz)
    elif shape in ("cylinder", "capsule"):
        extras["radius"] = max(hx, hy)
        extras["height"] = hz * 2.0
    for k, v in extras.items():
        coll[k] = v
    return coll


# ────────────────────────────────────────────────────────────────────
# Public API
# ────────────────────────────────────────────────────────────────────

def condition_object(obj: bpy.types.Object, *, prop_id: str, family: str = "prop",
                     target_tris: int = 400, target_height: float | None = None,
                     source_up: str = "Z", collider: str = "box",
                     tint: str | None = None, foliage: bool = False,
                     smooth: bool = False) -> bpy.types.Object:
    """Condition ``obj`` (a raw generated mesh) into a pipeline-legal prop.

    Returns the ``prop_<id>_root`` empty. The object is mutated in place
    and re-parented under the new root, inside a fresh ``prop_<id>``
    collection ready to drag into a library or export via build_prop.
    """
    if obj is None or obj.type != "MESH":
        raise ValueError("condition_object needs a mesh object")

    _orient_z_up(obj, source_up)
    _apply_transforms(obj)
    _decimate(obj, target_tris)
    _recenter_bottom(obj)
    _rescale_to_height(obj, target_height)

    _assign_family_material(obj, prop_id, family, tint)
    _stamp_color0(obj, foliage or family == "foliage")
    for p in obj.data.polygons:
        p.use_smooth = smooth

    # Rehome into a clean prop_<id> collection: root empty + mesh + collider.
    coll = bpy.data.collections.new(f"prop_{prop_id}")
    bpy.context.scene.collection.children.link(coll)

    root = bpy.data.objects.new(f"prop_{prop_id}_root", None)
    root.empty_display_type = "PLAIN_AXES"
    root["kind"] = ExportedKind.PROP
    root["prop_id"] = prop_id
    coll.objects.link(root)

    # Unlink the mesh from wherever it lived and re-link under the prop coll.
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)
    obj.name = f"prop_{prop_id}_mesh"
    obj.data.name = f"prop_{prop_id}_mesh"
    obj.parent = root

    _add_box_collider(root, obj, collider)

    tri_count = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f"[condition] prop_{prop_id}: {len(obj.data.vertices)}v / ~{tri_count} tris, "
          f"family={family}, collider={collider}")
    return root


def condition_active(prop_id: str, **kwargs) -> bpy.types.Object:
    """Condition the active object — the interactive Rodin-loop entry.
    If several objects are selected they are joined first (generators
    sometimes split a model into parts)."""
    sel = [o for o in bpy.context.selected_objects if o.type == "MESH"]
    obj = bpy.context.view_layer.objects.active
    if obj is None or obj.type != "MESH":
        obj = sel[0] if sel else None
    if obj is None:
        raise ValueError("Select the imported generated mesh first")
    if len(sel) > 1:
        _select_only(obj)
        for o in sel:
            o.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active
    return condition_object(obj, prop_id=prop_id, **kwargs)


# ────────────────────────────────────────────────────────────────────
# Headless entry — condition a file to a GLB
# ────────────────────────────────────────────────────────────────────

def _import_any(path: str) -> bpy.types.Object:
    ext = os.path.splitext(path)[1].lower()
    before = set(bpy.data.objects)
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext in (".stl",):
        bpy.ops.wm.stl_import(filepath=path)
    else:
        raise ValueError(f"unsupported input format: {ext}")
    new = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    if not new:
        raise ValueError(f"no mesh imported from {path}")
    return new[0]


def main() -> None:
    from tools.blender.common import export_glb, reset_scene

    inp = os.environ["HOVERBIKE_INPUT"]
    prop_id = os.environ["HOVERBIKE_PROP_ID"]
    out = os.environ.get("HOVERBIKE_OUTPUT")
    reset_scene()

    obj = _import_any(inp)
    root = condition_object(
        obj,
        prop_id=prop_id,
        family=os.environ.get("HOVERBIKE_FAMILY", "prop"),
        target_tris=int(os.environ.get("HOVERBIKE_TARGET_TRIS", "400")),
        target_height=(float(os.environ["HOVERBIKE_TARGET_HEIGHT"])
                       if os.environ.get("HOVERBIKE_TARGET_HEIGHT") else None),
        source_up=os.environ.get("HOVERBIKE_SOURCE_UP", "Z"),
        collider=os.environ.get("HOVERBIKE_COLLIDER", "box"),
        tint=os.environ.get("HOVERBIKE_TINT"),
        foliage=os.environ.get("HOVERBIKE_FOLIAGE", "0") == "1",
    )

    if out:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        export_glb(out)
        print(f"[condition] exported → {out}")
    else:
        print(f"[condition] conditioned {root.name} (no HOVERBIKE_OUTPUT — not exported)")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"[condition] FAILED: {e}", file=sys.stderr)
        raise
