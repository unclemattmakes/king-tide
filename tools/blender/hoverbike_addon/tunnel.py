"""Tunnel tool — AI-spline-driven boolean carve.

.. deprecated::
   The canonical tunnel rig is the hand-curve-driven seed in
   ``tracks-src/template-tunnels.blend`` (see
   ``tools/blender/seed_template_tunnels.py``). This Python OT
   approach is retained for the existing ``template-tunnel-island``
   scene and will be deleted in a follow-up once that scene is
   migrated or retired.

A tunnel is three things in lockstep:

  * ``tunnel_curve_main``     — user-edited Bezier through the hill.
  * ``tunnel_main_cutter``    — closed manifold cylinder swept along
                                the curve. Hidden from viewport +
                                export, lives in a dedicated
                                ``_hoverbike_tunnel_cutters``
                                collection.
  * ``tunnel_main_interior``  — inward-facing cylindrical shell along
                                the same curve. ``kind="track"`` so
                                the runtime trimesh collider attaches.

The terrain mesh carries a single Boolean DIFFERENCE modifier whose
operand is the cutters *collection* (not a single object), so a
second tunnel just drops another cutter into the collection and the
modifier picks it up. A Solidify pre-pass extrudes the heightfield
into a 200 m crust so the boolean has volume to carve through.
"""

from __future__ import annotations

import math

import bpy
import mathutils
from bpy.props import FloatProperty, IntProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

TUNNEL_CURVE_NAME = "tunnel_curve_main"
TUNNEL_PARENT_PREFIX = "tunnel_"
TUNNEL_CUTTERS_COLLECTION = "_hoverbike_tunnel_cutters"
TUNNEL_BOOLEAN_MOD_NAME = "HV_Tunnel_Cut"
TUNNEL_SOLIDIFY_MOD_NAME = "HV_Tunnel_Solidify"
TUNNEL_SOLIDIFY_THICKNESS = 200.0  # m — terrain extruded down by this much
TUNNEL_MATERIAL_NAME = "mat_track_tunnel"


# ────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────


def _ensure_tunnel_material() -> bpy.types.Material:
    """Concrete-liner material for the inside of a tunnel. Dark
    enough to read as "inside a hill" against the brighter outside
    terrain, with a slight blue cast so it doesn't disappear into
    the runtime fog."""
    mat = bpy.data.materials.get(TUNNEL_MATERIAL_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(TUNNEL_MATERIAL_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.18, 0.19, 0.22, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.78
        spec = bsdf.inputs.get("Specular IOR Level") or bsdf.inputs.get("Specular")
        if spec is not None:
            spec.default_value = 0.3
    return mat


def _ensure_tunnel_cutters_collection(scene) -> bpy.types.Collection:
    """Get-or-create the hidden collection that holds every tunnel
    cutter. Hidden in the viewport + render so the closed cylinder
    doesn't show, but the collection still exists in the depsgraph so
    the terrain's Boolean modifier evaluates against it."""
    from ._legacy import _find_layer_collection

    col = bpy.data.collections.get(TUNNEL_CUTTERS_COLLECTION)
    if col is None:
        col = bpy.data.collections.new(TUNNEL_CUTTERS_COLLECTION)
        scene.collection.children.link(col)
    col.hide_render = True
    vl = bpy.context.view_layer
    lc = _find_layer_collection(vl.layer_collection, TUNNEL_CUTTERS_COLLECTION)
    if lc is not None:
        lc.hide_viewport = True
    return col


def _sample_tunnel_curve(curve_obj: bpy.types.Object, n_samples: int) -> list[dict]:
    """Arc-length sampling of the tunnel curve. Returns
    ``[{x, y, z, tx, ty, tz}, ...]`` in world coordinates. Unlike the
    road sampler, we keep the curve's authored Z (the whole point of
    a tunnel is to dive *below* terrain) — no terrain raycast."""
    from ._legacy import _sample_curve_to_polyline

    raw = _sample_curve_to_polyline(curve_obj)
    if len(raw) < 2:
        return []
    cum = [0.0]
    for i in range(len(raw) - 1):
        a, b = raw[i], raw[i + 1]
        cum.append(cum[-1] + math.sqrt(
            (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2
        ))
    total = cum[-1]
    if total <= 0:
        return []
    samples: list[dict] = []
    denom = max(1, n_samples - 1)
    j = 0
    for i in range(n_samples):
        target = (i / denom) * total
        while j < len(cum) - 1 and cum[j + 1] < target:
            j += 1
        seg_len = (cum[j + 1] - cum[j]) if (j + 1 < len(cum)) else 1.0
        frac = (target - cum[j]) / seg_len if seg_len > 0 else 0.0
        a = raw[j]
        b = raw[j + 1] if (j + 1 < len(raw)) else raw[j]
        x = a[0] + (b[0] - a[0]) * frac
        y = a[1] + (b[1] - a[1]) * frac
        z = a[2] + (b[2] - a[2]) * frac
        dx = b[0] - a[0]
        dy = b[1] - a[1]
        dz = b[2] - a[2]
        tl = math.sqrt(dx * dx + dy * dy + dz * dz) or 1.0
        samples.append({
            "x": x, "y": y, "z": z,
            "tx": dx / tl, "ty": dy / tl, "tz": dz / tl,
        })
    return samples


def _tunnel_ring_basis(
    tx: float, ty: float, tz: float
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """Pick a (right, up) basis perpendicular to a tangent so each
    ring around the tunnel sits flat against the tube direction."""
    t = mathutils.Vector((tx, ty, tz)).normalized()
    world_up = mathutils.Vector((0.0, 0.0, 1.0))
    if abs(t.dot(world_up)) > 0.95:
        world_up = mathutils.Vector((1.0, 0.0, 0.0))
    right = t.cross(world_up).normalized()
    up = right.cross(t).normalized()
    return (right.x, right.y, right.z), (up.x, up.y, up.z)


def _build_tunnel_interior_mesh(
    name: str, samples: list[dict], *, radius: float, segments: int
) -> bpy.types.Mesh:
    """Inward-facing cylindrical shell along the sampled curve. No end
    caps — the tunnel is open at entrance + exit so the player can
    drive in/out."""
    me = bpy.data.meshes.new(name)
    if len(samples) < 2 or segments < 3:
        me.from_pydata([], [], [])
        return me
    verts: list[tuple[float, float, float]] = []
    for s in samples:
        right, up = _tunnel_ring_basis(s["tx"], s["ty"], s["tz"])
        rx, ry, rz = right
        ux, uy, uz = up
        cx, cy, cz = s["x"], s["y"], s["z"]
        for i in range(segments):
            theta = 2.0 * math.pi * i / segments
            cs = math.cos(theta)
            sn = math.sin(theta)
            ox = rx * cs * radius + ux * sn * radius
            oy = ry * cs * radius + uy * sn * radius
            oz = rz * cs * radius + uz * sn * radius
            verts.append((cx + ox, cy + oy, cz + oz))
    faces: list[tuple[int, ...]] = []
    for j in range(len(samples) - 1):
        for i in range(segments):
            i_next = (i + 1) % segments
            a = j * segments + i
            b = j * segments + i_next
            c = (j + 1) * segments + i_next
            d = (j + 1) * segments + i
            # Reverse winding so normals point inward toward the
            # tunnel axis.
            faces.append((a, d, c, b))
    me.from_pydata(verts, [], faces)
    me.update(calc_edges=True)
    me.shade_smooth()
    return me


def _build_tunnel_cutter_mesh(
    name: str,
    samples: list[dict],
    *,
    radius: float,
    segments: int,
    end_extend: float,
) -> bpy.types.Mesh:
    """Closed manifold cylinder swept along the samples. Used as the
    Boolean DIFFERENCE operand on the terrain. Extended past sampled
    endpoints by ``end_extend`` so the cut clears the terrain surface
    at the tunnel mouth."""
    me = bpy.data.meshes.new(name)
    if len(samples) < 2 or segments < 3:
        me.from_pydata([], [], [])
        return me

    extended: list[dict] = []
    s0 = samples[0]
    extended.append({
        **s0,
        "x": s0["x"] - s0["tx"] * end_extend,
        "y": s0["y"] - s0["ty"] * end_extend,
        "z": s0["z"] - s0["tz"] * end_extend,
    })
    extended.extend(samples)
    sN = samples[-1]
    extended.append({
        **sN,
        "x": sN["x"] + sN["tx"] * end_extend,
        "y": sN["y"] + sN["ty"] * end_extend,
        "z": sN["z"] + sN["tz"] * end_extend,
    })

    verts: list[tuple[float, float, float]] = []
    for s in extended:
        right, up = _tunnel_ring_basis(s["tx"], s["ty"], s["tz"])
        rx, ry, rz = right
        ux, uy, uz = up
        cx, cy, cz = s["x"], s["y"], s["z"]
        for i in range(segments):
            theta = 2.0 * math.pi * i / segments
            cs = math.cos(theta)
            sn = math.sin(theta)
            ox = rx * cs * radius + ux * sn * radius
            oy = ry * cs * radius + uy * sn * radius
            oz = rz * cs * radius + uz * sn * radius
            verts.append((cx + ox, cy + oy, cz + oz))

    faces: list[tuple[int, ...]] = []
    for j in range(len(extended) - 1):
        for i in range(segments):
            i_next = (i + 1) % segments
            a = j * segments + i
            b = j * segments + i_next
            c = (j + 1) * segments + i_next
            d = (j + 1) * segments + i
            faces.append((a, b, c, d))
    front_cap = tuple(range(segments - 1, -1, -1))
    faces.append(front_cap)
    back_start = (len(extended) - 1) * segments
    back_cap = tuple(range(back_start, back_start + segments))
    faces.append(back_cap)

    me.from_pydata(verts, [], faces)
    me.update(calc_edges=True)
    return me


def _next_tunnel_index() -> int:
    """First free index NN such that ``tunnel_NN_*`` isn't used yet."""
    i = 0
    while True:
        name = f"{TUNNEL_PARENT_PREFIX}{i:02d}_interior"
        if name not in bpy.data.objects:
            return i
        i += 1


def _ensure_terrain_tunnel_boolean(
    terrain: bpy.types.Object, cutters: bpy.types.Collection
) -> None:
    """Stack Solidify+Boolean on the terrain so cutters can carve a
    real tube through it. Solidify (offset=-1, thickness=200,
    use_rim=False) extrudes the sheet downward into a thick crust so
    the boolean has volume to carve."""
    sol = terrain.modifiers.get(TUNNEL_SOLIDIFY_MOD_NAME)
    if sol is None:
        sol = terrain.modifiers.new(name=TUNNEL_SOLIDIFY_MOD_NAME, type="SOLIDIFY")
    sol.thickness = TUNNEL_SOLIDIFY_THICKNESS
    sol.offset = -1.0
    sol.use_rim = False

    mod = terrain.modifiers.get(TUNNEL_BOOLEAN_MOD_NAME)
    if mod is None:
        mod = terrain.modifiers.new(name=TUNNEL_BOOLEAN_MOD_NAME, type="BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.operand_type = "COLLECTION"
    mod.collection = cutters
    mod.solver = "EXACT"

    # Belt-and-braces: ensure modifier order is Solidify → Boolean.
    names = [m.name for m in terrain.modifiers]
    sol_idx = names.index(TUNNEL_SOLIDIFY_MOD_NAME)
    cut_idx = names.index(TUNNEL_BOOLEAN_MOD_NAME)
    if sol_idx > cut_idx:
        prev_active = bpy.context.view_layer.objects.active
        bpy.context.view_layer.objects.active = terrain
        try:
            bpy.ops.object.modifier_move_to_index(
                modifier=TUNNEL_BOOLEAN_MOD_NAME,
                index=len(terrain.modifiers) - 1,
            )
        except RuntimeError:
            pass
        finally:
            bpy.context.view_layer.objects.active = prev_active


def _add_tunnel_starter_curve(scene) -> bpy.types.Object:
    """Create a 4-point Bezier curve named ``tunnel_curve_main``."""
    existing = bpy.data.objects.get(TUNNEL_CURVE_NAME)
    if existing is not None:
        return existing
    curve_data = bpy.data.curves.new(TUNNEL_CURVE_NAME, type="CURVE")
    curve_data.dimensions = "3D"
    spline = curve_data.splines.new(type="BEZIER")
    spline.bezier_points.add(3)
    coords = [(-60, 0, 10), (-20, 0, 12), (20, 0, 12), (60, 0, 10)]
    for bp, (x, y, z) in zip(spline.bezier_points, coords):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    spline.use_cyclic_u = False
    curve_data.resolution_u = 24
    obj = bpy.data.objects.new(TUNNEL_CURVE_NAME, curve_data)
    obj["kind"] = "tunnel_curve"
    scene.collection.objects.link(obj)
    return obj


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_add_tunnel_starter_curve(Operator):
    """Spawn a ready-to-edit ``tunnel_curve_main`` Bezier through the
    middle of the scene. The user drags its control points into / out
    of a hillside, then clicks *Build Tunnel* to drill through."""

    bl_idname = "hoverbike.add_tunnel_starter_curve"
    bl_label = "Add Tunnel Starter Curve"
    bl_description = "Create a starter Bezier curve for the tunnel tool"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        obj = _add_tunnel_starter_curve(context.scene)
        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj
        self.report({"INFO"}, f"Created {obj.name}. Edit the curve, then click Build Tunnel.")
        return {"FINISHED"}


class HOVERBIKE_OT_build_tunnel(Operator):
    """Sweep a cutter cylinder + an interior shell along the active
    tunnel curve, and ensure the terrain mesh's Boolean DIFFERENCE
    modifier targets the cutters collection."""

    bl_idname = "hoverbike.build_tunnel"
    bl_label = "Build Tunnel"
    bl_description = "Carve a tunnel through the terrain along tunnel_curve_main"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from ._legacy import _largest_terrain_mesh

        scene = context.scene
        curve = bpy.data.objects.get(TUNNEL_CURVE_NAME)
        if curve is None or curve.type != "CURVE":
            self.report(
                {"ERROR"},
                f"No {TUNNEL_CURVE_NAME} in scene. Click *Add Tunnel Starter Curve* first.",
            )
            return {"CANCELLED"}
        terrain = _largest_terrain_mesh()
        if terrain is None:
            self.report({"ERROR"}, "No terrain mesh found (largest visible kind='track' mesh).")
            return {"CANCELLED"}

        radius = float(getattr(scene, "hoverbike_tunnel_radius", 8.0))
        wall_thickness = float(getattr(scene, "hoverbike_tunnel_wall_thickness", 1.0))
        n_samples = int(getattr(scene, "hoverbike_tunnel_samples", 32))
        segments = int(getattr(scene, "hoverbike_tunnel_segments", 14))
        end_extend = float(getattr(scene, "hoverbike_tunnel_end_extend", 4.0))
        if radius <= 0 or n_samples < 2 or segments < 3:
            self.report({"ERROR"}, "Invalid tunnel parameters — fix radius / samples / segments.")
            return {"CANCELLED"}

        samples = _sample_tunnel_curve(curve, n_samples)
        if not samples:
            self.report({"ERROR"}, f"Couldn't sample {curve.name!r} (need at least 2 control points).")
            return {"CANCELLED"}

        idx = _next_tunnel_index()
        cutter_mesh = _build_tunnel_cutter_mesh(
            f"{TUNNEL_PARENT_PREFIX}{idx:02d}_cutter_mesh",
            samples,
            radius=radius + wall_thickness,
            segments=segments,
            end_extend=end_extend,
        )
        cutter_obj = bpy.data.objects.new(f"{TUNNEL_PARENT_PREFIX}{idx:02d}_cutter", cutter_mesh)
        cutter_obj["kind"] = "tunnel_cutter"
        cutter_obj.display_type = "WIRE"
        cutters_col = _ensure_tunnel_cutters_collection(scene)
        cutters_col.objects.link(cutter_obj)
        cutter_obj.hide_render = True
        cutter_obj.hide_set(True)

        interior_mesh = _build_tunnel_interior_mesh(
            f"{TUNNEL_PARENT_PREFIX}{idx:02d}_interior_mesh",
            samples,
            radius=radius,
            segments=segments,
        )
        interior_obj = bpy.data.objects.new(
            f"{TUNNEL_PARENT_PREFIX}{idx:02d}_interior", interior_mesh
        )
        interior_obj["kind"] = "track"
        interior_obj["tunnel_curve"] = curve.name
        interior_obj.data.materials.append(_ensure_tunnel_material())
        scene.collection.objects.link(interior_obj)

        _ensure_terrain_tunnel_boolean(terrain, cutters_col)

        self.report(
            {"INFO"},
            f"Built {interior_obj.name}: {len(samples)} samples, radius {radius:.1f}m. "
            f"Terrain boolean cut via {cutters_col.name}.",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_add_tunnel_starter_curve,
    HOVERBIKE_OT_build_tunnel,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.Scene.hoverbike_tunnel_radius = FloatProperty(
        name="Tunnel radius (m)",
        description=(
            "Inner radius of the tunnel — half the tube diameter. "
            "8 m = 16 m wide and 16 m tall, comfortably arcade-sized."
        ),
        default=8.0, min=1.0, max=40.0, precision=2,
    )
    bpy.types.Scene.hoverbike_tunnel_wall_thickness = FloatProperty(
        name="Tunnel wall (m)",
        description=(
            "Extra radius on the boolean cutter beyond the interior shell. Becomes the apparent "
            "thickness of the concrete liner at the tunnel mouth — 1 m reads as a real engineered "
            "tunnel; 0.1 m reads as a clean drilled hole."
        ),
        default=1.0, min=0.0, max=8.0, precision=2,
    )
    bpy.types.Scene.hoverbike_tunnel_samples = IntProperty(
        name="Tunnel samples",
        description=(
            "Number of arc-length samples along the tunnel curve. "
            "Higher = smoother tube, denser cutter, slower boolean."
        ),
        default=32, min=4, max=256,
    )
    bpy.types.Scene.hoverbike_tunnel_segments = IntProperty(
        name="Tunnel segments",
        description="Number of radial sides per cross-section ring. 12-16 reads as a smooth tube; 6 reads as a hex pipe.",
        default=14, min=3, max=64,
    )
    bpy.types.Scene.hoverbike_tunnel_end_extend = FloatProperty(
        name="Tunnel end extend (m)",
        description=(
            "Distance the cutter pushes past the curve's endpoints along the tangent. "
            "Ensures the boolean cut clears the terrain surface at the tunnel mouth even when "
            "the user's endpoints land right on the hillside."
        ),
        default=4.0, min=0.0, max=50.0, precision=2,
    )


def unregister() -> None:
    for prop in (
        "hoverbike_tunnel_radius",
        "hoverbike_tunnel_wall_thickness",
        "hoverbike_tunnel_samples",
        "hoverbike_tunnel_segments",
        "hoverbike_tunnel_end_extend",
    ):
        try:
            delattr(bpy.types.Scene, prop)
        except AttributeError:
            pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
