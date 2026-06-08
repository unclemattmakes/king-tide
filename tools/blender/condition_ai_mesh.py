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
     in the one-shader-per-family convention. With ``keep_material=True``
     the source material is instead *preserved* (its ``baseColorTexture``
     + UVs kept) and merely renamed to the canonical name — for external
     CC0 packs (Quaternius) whose multi-tone look lives in a shared
     palette texture, not vertex colours, so stripping it would flatten
     the prop to one tint.
  5. Stamp ``COLOR_0`` per docs/vertex-attribute-spec.md (terrain default
     for static props, linear sway for foliage; a neutral white for
     ``keep_material`` static props so the attribute can't tint the
     preserved texture — see ``_stamp_color0``).
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
    set_color_attr,
    set_constant,
    set_linear_sway_z,
    welded_convexity,
)

# Neutral COLOR_0 for ``keep_material`` static props. Three.js turns a present
# COLOR_0 into a vertex-colour albedo *multiply* (GLTFLoader sets
# vertexColors=true; the WebGPU MeshStandardNodeMaterial multiplies diffuse by
# it), so a non-neutral default would tint the preserved baseColorTexture.
# (1,1,1,1) is a no-op multiply yet still a valid, present attribute (G=AO=1).
NEUTRAL_COLOR0 = (1.0, 1.0, 1.0, 1.0)


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
    """Iterative collapse-decimate down to ~``target_tris``. AI meshes are
    typically 50k–500k tris. Each pass reduces by at most 10x (ratio
    floored at 0.1): chaining gentle passes preserves shape and topology
    far better than one aggressive single-shot collapse — an author found
    two stacked 0.1 Decimate modifiers (= 0.01 effective) gave the cleanest
    hoverbike mesh, and this generalises. The final pass uses the exact
    remaining ratio to land near the target."""
    if target_tris <= 0:
        return
    for i in range(8):
        tri_count = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        if tri_count <= target_tris:
            return
        md = obj.modifiers.new(f"HV_Condition_Decimate_{i}", "DECIMATE")
        md.decimate_type = "COLLAPSE"
        md.ratio = max(0.1, target_tris / float(tri_count))   # ≤10x reduction per pass
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


def _material_has_image(mat: bpy.types.Material) -> bool:
    """True if *mat*'s node tree references at least one image — i.e. there is a
    real texture to preserve (vs. a flat principled colour or vertex-coloured
    pack)."""
    if not mat.use_nodes or mat.node_tree is None:
        return False
    return any(getattr(n, "image", None) is not None
               for n in mat.node_tree.nodes if n.type == "TEX_IMAGE")


def _force_opaque_if_degenerate(mat: bpy.types.Material) -> bool:
    """Force *mat* fully opaque when it would otherwise render invisible /
    over-transparent — a Principled ``Alpha`` below the mask cutoff (or a
    non-opaque blend mode) with **no texture** to supply a real per-texel
    cutout. Seen on FBX-sourced packs (e.g. Quaternius palms) that import with
    ``Alpha=0`` + alpha-clip: glTF then exports ``baseColorFactor`` alpha 0 and
    every fragment is discarded, so the prop is invisible while its shadow still
    casts. Returns True if it changed anything.

    Belt-and-braces across Blender versions: set the blend mode opaque where the
    attribute still exists *and* pin the Principled ``Alpha`` socket to 1.0
    (which drives the exported ``baseColorFactor`` alpha; alpha 1 means no
    fragment is ever masked out, whatever the alphaMode)."""
    bsdf = (mat.node_tree.nodes.get("Principled BSDF")
            if mat.use_nodes and mat.node_tree else None)
    alpha_in = bsdf.inputs.get("Alpha") if bsdf else None
    low_alpha = alpha_in is not None and not alpha_in.links and alpha_in.default_value < 0.5
    masked = getattr(mat, "blend_method", "OPAQUE") in ("CLIP", "BLEND", "HASHED")
    if not (low_alpha or masked):
        return False
    try:                                   # blend_method removed in newer Blender
        mat.blend_method = "OPAQUE"
    except (AttributeError, TypeError):
        pass
    if alpha_in is not None:
        for link in list(alpha_in.links):
            mat.node_tree.links.remove(link)
        alpha_in.default_value = 1.0
    try:                                   # legacy / non-node fallback
        mat.diffuse_color = (*mat.diffuse_color[:3], 1.0)
    except (AttributeError, TypeError):
        pass
    return True


def _preserve_material(obj: bpy.types.Object, prop_id: str, family: str) -> str:
    """The ``keep_material`` counterpart to ``_assign_family_material``: keep the
    source mesh's material — its ``baseColorTexture`` + UVs intact — and only
    *rename* the primary material to ``mat_<family>_<id>`` so it still satisfies
    the one-shader-per-family convention. External CC0 packs (Quaternius) get
    their multi-tone look from a shared palette ``baseColorTexture`` mapped
    through UVs; stripping + re-tinting (the default path) would flatten the prop
    to a single colour, so here we rename-only and leave the texture untouched.

    Falls back to a flat ``_assign_family_material`` when the mesh has no source
    material at all, and warns when the kept material carries no image texture
    (a tell that the pack stores colour in *vertex* colours instead — which the
    later ``_strip_color_attrs`` wipes, so ``keep_material`` can't rescue it)."""
    mats = [m for m in obj.data.materials if m is not None]
    if not mats:
        print(f"[condition] prop_{prop_id}: keep_material set but mesh has no "
              f"source material — falling back to a flat mat_{family}_{prop_id}.")
        return _assign_family_material(obj, prop_id, family, tint=None)
    mat_name = f"mat_{family}_{prop_id}"
    primary = mats[0]
    primary.name = mat_name
    # Repair degenerate alpha so preserved props actually render — textureless
    # materials only (a textured material's alpha may be a legitimate cutout,
    # e.g. leaf cards, so it's left alone).
    repaired = sum(1 for m in mats
                   if not _material_has_image(m) and _force_opaque_if_degenerate(m))
    # Diagnose where this prop's colour actually lives, so the operator knows
    # whether keep_material preserved it — a palette ``baseColorTexture`` *or*
    # multiple flat material slots both round-trip multi-tone (glTF splits a
    # multi-material mesh into one primitive per slot) — or whether it will
    # flatten: a single-material vertex-colour pack loses its colour because
    # the engine contract strips vertex colours (``_strip_color_attrs``).
    has_image = any(_material_has_image(m) for m in mats)
    if has_image:
        source = "baseColorTexture"
    elif len(mats) > 1:
        source = f"{len(mats)} flat material slots"
    elif obj.data.color_attributes:
        source = "VERTEX COLOURS — will FLATTEN (stripped for the COLOR_0 contract)"
        print(f"[condition] prop_{prop_id}: WARNING {source}. Bake to a texture or skip.")
    else:
        source = "single flat material"
    extra = f"; repaired {repaired} degenerate-alpha material(s)" if repaired else ""
    print(f"[condition] prop_{prop_id}: kept material {mat_name!r}; colour source: {source}{extra}.")
    return mat_name


def _strip_color_attrs(mesh: bpy.types.Mesh) -> None:
    """Remove every existing color attribute. AI-generated meshes ship their
    own vertex-color layer (often a baked albedo); ``set_color_attr`` only
    replaces a same-named ``COLOR_0``, so without this the generator's layer
    survives and the glTF exporter emits it as a stray ``COLOR_1`` — breaking
    the single-``COLOR_0`` contract (docs/vertex-attribute-spec.md). Wipe
    them all so the subsequent stamp leaves exactly one clean ``COLOR_0``."""
    while mesh.color_attributes:
        mesh.color_attributes.remove(mesh.color_attributes[0])


def _edge_convexity(mesh: bpy.types.Mesh, gain: float = 1.6) -> list[float]:
    """Per-vertex convex-edge strength in [0, 1] (0 = flat/concave, 1 = a sharp
    convex ridge) — the painted-miniature drybrush mask the vinyl material reads
    as ``1 - A``. Shimmer-free because it's smooth per-vertex data baked at asset
    time (vs screen-space curvature, which catches the tessellation).

    Delegates to the shared ``vertex_attrs.welded_convexity`` so the source bake
    here, the GLB retrofit (``patch_convexity.py``), and the runtime primitive
    stamp (``edge-wear-convexity.ts``) all agree. The welded view is what lets
    hard-surface props — whose vertices are SPLIT along every hard edge — read
    convex at all; the old per-vertex bmesh walk saw only coplanar in-face edges
    on those and reported ~0 (flat). Index-aligned with ``mesh.vertices``."""
    return welded_convexity(mesh, gain=gain)


def _stamp_color0(obj: bpy.types.Object, foliage: bool, *,
                  neutral_albedo: bool = False) -> None:
    _strip_color_attrs(obj.data)         # drop the generator's color layer(s) first
    if foliage:
        (_mn, _mny, mnz), (_mx, _mxy, mxz) = _local_bbox(obj)
        set_linear_sway_z(obj.data, z_min=mnz, z_max=mxz * 1.1, ao=1.0)
    else:
        # Static prop. Base RGB from the neutral (keep_material) or terrain
        # default, but bake per-vertex convex-edge strength into A: 1 = flat,
        # <1 = convex ridge. The vinyl material reads (1 - A) as edge-wear, so a
        # flat A=1 is a no-op and foliage (A=1 from the sway preset) is untouched.
        # keep_material props keep NEUTRAL on RGB (the terrain default's B=0 would
        # zero the preserved texture's blue), and A is safe to vary because
        # vertex-colour alpha is ignored on opaque props.
        base = NEUTRAL_COLOR0 if neutral_albedo else DEFAULT_TERRAIN
        r, g, b = base[0], base[1], base[2]
        conv = _edge_convexity(obj.data)
        set_color_attr(obj.data, lambda i, _co: (r, g, b, 1.0 - conv[i]))
    # Make COLOR_0 active + render color so it exports at index 0 and the
    # Asset-Browser preview reads it.
    ca = obj.data.color_attributes
    c0 = ca.get("COLOR_0")
    if c0 is not None:
        try:
            ca.active_color = c0
            ca.render_color_index = list(ca).index(c0)
        except (AttributeError, ValueError, TypeError):
            pass


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
                     smooth: bool = False, keep_material: bool = False) -> bpy.types.Object:
    """Condition ``obj`` (a raw generated mesh) into a pipeline-legal prop.

    Returns the ``prop_<id>_root`` empty. The object is mutated in place
    and re-parented under the new root, inside a fresh ``prop_<id>``
    collection ready to drag into a library or export via build_prop.

    ``keep_material``: preserve the source material's ``baseColorTexture`` +
    UVs (renaming it to ``mat_<family>_<id>``) instead of stripping it for a
    flat ``tint``. For external CC0 packs whose colour lives in a palette
    texture; ``tint`` is ignored in this mode. The decimate budget is honoured
    as usual — Quaternius is low-poly so it typically no-ops at the ~2 000-tri
    default, leaving the UVs untouched; an aggressive budget on a denser mesh
    can still distort the UV mapping (collapse-decimate interpolates UVs).
    """
    if obj is None or obj.type != "MESH":
        raise ValueError("condition_object needs a mesh object")

    _orient_z_up(obj, source_up)
    _apply_transforms(obj)
    _decimate(obj, target_tris)
    _recenter_bottom(obj)
    _rescale_to_height(obj, target_height)

    if keep_material:
        _preserve_material(obj, prop_id, family)
    else:
        _assign_family_material(obj, prop_id, family, tint)
    _stamp_color0(obj, foliage or family == "foliage", neutral_albedo=keep_material)
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
        keep_material=os.environ.get("HOVERBIKE_KEEP_MATERIAL", "0") == "1",
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
