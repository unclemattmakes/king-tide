"""Headless builder: HV_Cloud geonode variants -> standalone cloud GLBs.

Each variant is realised from the **HV_Cloud** geometry-nodes tool (built by
``build_geonode_props.build_cloud``), given the toolkit's finishing stack
(Collapse Decimate 0.1 + Smooth by Angle 60deg), wrapped in the prop-export
contract (a ``prop_root`` empty ``kind=prop`` + a box ``collider`` sized to the
realised cloud), and exported to ``public/assets/props/cloud_<id>.glb``.

These GLBs feed the **hero cumulus field** (``src/engine/render/clouds.ts``):
the field loads each one, pulls the ``prop_body`` mesh out, normalises it to
~unit size, stamps the ``aHeightT`` ramp + recentres it, and instances it at
altitude under the sky-locked cloud material. (They also satisfy the standard
prop contract, so a track *could* place one statically via ``props[]`` with
``assetId: cloud_<id>`` — but the field is the primary consumer.)

The HV_Cloud node group already sets shade-smooth + writes ``COLOR_0`` inside
the tree, and the runtime prop-loader re-creases normals on load, so the cloud
reads soft even before the Smooth-by-Angle modifier.

Run (cwd = repo root)::

    blender --background --python tools/blender/build_cloud_props.py

Idempotent: rebuilds the node group + every GLB from scratch each run.
"""
from __future__ import annotations

import importlib.util
import os
import sys

import bpy
from mathutils import Vector

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(_SCRIPT_DIR))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from tools.blender.common import apply_extras, export_glb  # noqa: E402

# Import the geonode toolkit as a module so we reuse the *exact* HV_Cloud
# builder + helpers (single source of truth — no cloned node graph).
_BGP_PATH = os.path.join(_SCRIPT_DIR, "build_geonode_props.py")
_spec = importlib.util.spec_from_file_location("bgp", _BGP_PATH)
bgp = importlib.util.module_from_spec(_spec)
sys.modules["bgp"] = bgp
_spec.loader.exec_module(bgp)

OUT_DIR = os.path.join(_REPO_ROOT, "public", "assets", "props")

# Four distinct cumulus silhouettes for sky-field variety. Knob names must match
# the HV_Cloud interface sockets exactly (build_geonode_props.build_cloud).
VARIANTS: dict[str, dict] = {
    # humilis — wide, low, fair-weather puff (the flat little ones)
    "cloud_humilis": dict(
        Size=16.0, Height=5.0, Puffs=12,
        **{"Flat Base": 0.86, "Top Bias": 0.28, "Billow": 0.18}, Seed=2.0,
    ),
    # mediocris — the rounded medium default cumulus
    "cloud_mediocris": dict(Seed=5.0),
    # congestus — tall, towering, lots of cauliflower
    "cloud_congestus": dict(
        Size=11.0, Height=16.0, Puffs=20,
        **{"Top Bias": 0.75, "Flat Base": 0.70, "Billow": 0.24}, Seed=8.0,
    ),
    # stratocumulus — broad, flat, lumpy raft (big lateral mass)
    "cloud_stratocumulus": dict(
        Size=20.0, Height=6.0, Puffs=16,
        **{"Flat Base": 0.88, "Top Bias": 0.35, "Lumpiness": 0.45, "Billow": 0.16},
        Seed=13.0,
    ),
}


def _clear_objects() -> None:
    """Drop every object + mesh but keep node groups / materials.

    (We rebuild the node group per variant anyway; keeping them avoids
    re-linking the bundled 'Smooth by Angle' essentials group each time.)
    """
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for me in list(bpy.data.meshes):
        try:
            bpy.data.meshes.remove(me)
        except RuntimeError:
            pass


def _evaluated_aabb(ob: bpy.types.Object) -> tuple[Vector, Vector]:
    """World-space AABB of *ob* with its modifier stack applied (the realised
    cloud the exporter will write)."""
    deps = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(deps)
    me = ev.to_mesh()
    lo = Vector((1e18, 1e18, 1e18))
    hi = Vector((-1e18, -1e18, -1e18))
    mw = ob.matrix_world
    for v in me.vertices:
        co = mw @ v.co
        for i in range(3):
            lo[i] = min(lo[i], co[i])
            hi[i] = max(hi[i], co[i])
    ev.to_mesh_clear()
    return lo, hi


def build_variant(prop_id: str, knobs: dict, out_path: str) -> None:
    print(f"[build-cloud] {prop_id} -> {out_path}")
    _clear_objects()

    # (Re)build the HV_Cloud node group + its material from the toolkit.
    tree = bgp.build_cloud()

    # Host single-vert mesh + the generator modifier + the toolkit finishing
    # stack (one aggressive Collapse Decimate, then Smooth by Angle 60deg).
    body = bgp._single_vert_obj("prop_body")
    bgp._apply(body, tree, knobs)
    dec = body.modifiers.new("Decimate", "DECIMATE")
    dec.decimate_type = "COLLAPSE"
    dec.ratio = 0.1
    bgp._smooth_by_angle(body, 60.0)
    bpy.context.scene.collection.objects.link(body)
    bpy.context.view_layer.update()

    # Measure the realised cloud for the collider box.
    lo, hi = _evaluated_aabb(body)
    centre = (lo + hi) * 0.5
    half_b = (hi - lo) * 0.5  # Blender-axes half-extents (X,Y,Z; Z up)

    # prop_root empty carrying the runtime contract extras.
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    root = bpy.context.active_object
    root.name = "prop_root"
    apply_extras(root, kind="prop", prop_id=prop_id, category="decor")
    body.parent = root

    # Box collider at the cloud centre. half_extents are expressed in three's
    # axes ([right, up, forward]); the yup exporter maps Blender (x,y,z) ->
    # three (x, z, -y), so up<-Z and forward<-Y. (Decorative: a placed cloud
    # rides at altitude where bikes never reach — this just satisfies the
    # standard prop contract.)
    bpy.ops.object.empty_add(type="CUBE", location=(centre.x, centre.y, centre.z))
    coll = bpy.context.active_object
    coll.name = "collider_body"
    coll.parent = root
    apply_extras(
        coll,
        kind="collider",
        shape="box",
        half_extents=[float(half_b.x), float(half_b.z), float(half_b.y)],
    )

    def validators() -> list[str]:
        from tools.blender.common import validate_required_kinds
        return validate_required_kinds({"prop": 1, "collider": (1, None)})

    # single_color0: the realised GN geometry carries the tree's COLOR_0 store;
    # force ACTIVE-only so a stray layer can't leak out as a contract-breaking
    # COLOR_1 (matches the AI-mesh / addon export).
    export_glb(out_path, validators=[validators], single_color0=True)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for prop_id, knobs in VARIANTS.items():
        out = os.path.join(OUT_DIR, f"{prop_id}.glb")
        build_variant(prop_id, knobs, out)
    print(f"[build-cloud] done — {len(VARIANTS)} cloud GLBs in {OUT_DIR}")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # pragma: no cover - surfaced in the blender log
        print(f"[build-cloud] FAILED: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
