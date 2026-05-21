"""Tunnel tool — curve-bevel cylinder + boolean cut.

.. note::
   The canonical tunnel rig for new tracks is the GN-driven seed in
   ``tracks-src/template-tunnels.blend`` (see
   ``tools/blender/seed_template_tunnels.py``). When you're working in
   that .blend, just duplicate ``tunnel_00_curve`` into the
   ``Tunnel Curves`` collection — the interior + cutter sweeps update
   live and the terrain boolean picks up new curves automatically. The
   Build Tunnel operator here is for scenes that *don't* already have
   the GN rig: it bakes a single tunnel from a single curve using the
   Blender-native curve-bevel-to-cylinder flow.

What Build Tunnel does (per click, on the active or named tunnel curve):

  1. Set the curve's own bevel: ``Round`` profile, depth=radius,
     ``use_fill_caps=True``, tagged ``kind="track"`` so it ships as
     the visible interior. The curve stays live — Tab in, drag points,
     the cylinder follows.
  2. Make a *copy* of the curve datablock with bevel depth pumped out
     by the wall thickness, convert it to mesh → closed manifold
     cutter. Hidden, stashed in ``_hoverbike_tunnel_cutters``.
  3. Add a Boolean DIFFERENCE modifier on the terrain mesh against
     the cutter (EXACT solver). Cuts the mouth ring where the cutter
     pierces the heightfield. No Solidify — the heightfield is a
     sheet, the visible interior is the curve's own bevel.

Re-clicking Build Tunnel on the same curve rebuilds *its* cutter in
place rather than stacking duplicates. Different curve → new tunnel.
"""

from __future__ import annotations

import json

import bpy
from bpy.props import FloatProperty, IntProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

TUNNEL_CURVE_NAME = "tunnel_curve_main"
TUNNEL_PARENT_PREFIX = "tunnel_"
TUNNEL_CUTTERS_COLLECTION = "_hoverbike_tunnel_cutters"
TUNNEL_BOOLEAN_MOD_PREFIX = "HV_Tunnel_Cut_"
TUNNEL_SOLIDIFY_LEGACY_NAME = "HV_Tunnel_Solidify"  # purged on rebuild
TUNNEL_GN_BOOLEAN_NAME = "HV_TunnelCut"  # singleton from template-tunnels
TUNNEL_MATERIAL_NAME = "mat_track_tunnel"

# Custom-prop key on a tunnel curve that points at its cutter object.
TUNNEL_CUTTER_PROP = "tunnel_cutter_name"

# Custom-prop key on the terrain mesh that holds the JSON-serialised
# specs of every Boolean modifier the Edit-mode toggle has stripped.
# Presence of this key == "we're currently in Edit Mode".
TUNNEL_STASHED_CUTS_PROP = "_hoverbike_stashed_tunnel_cuts"


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
    cutter mesh. Hidden in the viewport + render so the closed
    cylinder doesn't show, but it still exists in the depsgraph so
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


def _apply_curve_bevel(
    curve_obj: bpy.types.Object,
    *,
    radius: float,
    segments: int,
    fill_caps: bool,
) -> None:
    """Configure a curve datablock so it renders as a cylinder along
    its splines. ``bevel_resolution`` is rounded from a target side
    count (4 segments per ring at resolution 1, 8 at 2, ...).
    ``use_fill_caps`` closes the ends — required for the cutter copy
    (boolean needs a manifold operand), disabled for the visible
    interior so the player can ride through."""
    cd = curve_obj.data
    cd.bevel_mode = "ROUND"
    cd.bevel_depth = float(radius)
    # bevel_resolution → 4*(res+1) radial sides. Map "segments" → res.
    cd.bevel_resolution = max(0, (int(segments) - 4) // 4)
    cd.use_fill_caps = bool(fill_caps)
    # Keep authored resolution_u alone (defaults to 12 from new-curve
    # creators) so the user can crank it for smoothness without us
    # overriding it on every rebuild.


def _strip_solidify_legacy(terrain: bpy.types.Object) -> None:
    """Earlier versions stacked a 200 m Solidify modifier on the
    terrain so the boolean could carve a volume. It worked
    geometrically but the downward crust poked through other cliffs
    at oblique angles and made the terrain look fractured. The
    template-tunnels rig dropped it and so do we — remove any leftover
    instance so old .blends silently heal on first rebuild."""
    mod = terrain.modifiers.get(TUNNEL_SOLIDIFY_LEGACY_NAME)
    if mod is not None:
        terrain.modifiers.remove(mod)


def _next_tunnel_index() -> int:
    """First free index NN such that ``tunnel_NN_cutter`` isn't used."""
    i = 0
    while True:
        name = f"{TUNNEL_PARENT_PREFIX}{i:02d}_cutter"
        if name not in bpy.data.objects:
            return i
        i += 1


def _resolve_tunnel_curve(context) -> bpy.types.Object | None:
    """Use the active object if it's a curve; otherwise fall back to
    the legacy ``tunnel_curve_main`` singleton. Returns ``None`` if
    neither yields a curve."""
    act = context.view_layer.objects.active
    if act is not None and act.type == "CURVE":
        return act
    return bpy.data.objects.get(TUNNEL_CURVE_NAME)


def _build_cutter_from_curve(
    curve_obj: bpy.types.Object,
    *,
    radius: float,
    segments: int,
    end_extend: float,
    cutter_name: str,
) -> bpy.types.Object:
    """Duplicate the curve's datablock, pump up its bevel by the
    wall thickness, optionally extend its endpoints along their
    tangents to clear the terrain at the mouth, then convert the
    duplicate to a mesh.

    The result is a closed manifold cylinder following the curve's
    centreline. Owned by the cutters collection, hidden, returned to
    the caller for boolean wiring."""
    src_data: bpy.types.Curve = curve_obj.data
    dup_data = src_data.copy()
    dup_data.name = f"{cutter_name}_curve"
    dup_data.bevel_mode = "ROUND"
    dup_data.bevel_depth = float(radius)
    dup_data.bevel_resolution = max(0, (int(segments) - 4) // 4)
    dup_data.use_fill_caps = True

    if end_extend > 0.0:
        for spline in dup_data.splines:
            if spline.type != "BEZIER" or len(spline.bezier_points) < 2:
                continue
            bps = spline.bezier_points
            a, b = bps[0].co, bps[1].co
            dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
            n = (dx * dx + dy * dy + dz * dz) ** 0.5
            if n > 1e-6:
                k = end_extend / n
                bps[0].co = (a.x + dx * k, a.y + dy * k, a.z + dz * k)
                bps[0].handle_left = (
                    bps[0].handle_left.x + dx * k,
                    bps[0].handle_left.y + dy * k,
                    bps[0].handle_left.z + dz * k,
                )
                bps[0].handle_right = (
                    bps[0].handle_right.x + dx * k,
                    bps[0].handle_right.y + dy * k,
                    bps[0].handle_right.z + dz * k,
                )
            p, q = bps[-1].co, bps[-2].co
            dx, dy, dz = p.x - q.x, p.y - q.y, p.z - q.z
            n = (dx * dx + dy * dy + dz * dz) ** 0.5
            if n > 1e-6:
                k = end_extend / n
                bps[-1].co = (p.x + dx * k, p.y + dy * k, p.z + dz * k)
                bps[-1].handle_left = (
                    bps[-1].handle_left.x + dx * k,
                    bps[-1].handle_left.y + dy * k,
                    bps[-1].handle_left.z + dz * k,
                )
                bps[-1].handle_right = (
                    bps[-1].handle_right.x + dx * k,
                    bps[-1].handle_right.y + dy * k,
                    bps[-1].handle_right.z + dz * k,
                )

    dup_obj = bpy.data.objects.new(cutter_name, dup_data)
    dup_obj.matrix_world = curve_obj.matrix_world.copy()

    # Convert the duplicate to mesh. Done via the low-level path so we
    # don't have to stage selection/active state for bpy.ops. Link
    # then update the view layer so the depsgraph picks up the new
    # object — without that, evaluated_get returns an unevaluated
    # clone and new_from_object emits an empty mesh.
    scene_coll = bpy.context.scene.collection
    scene_coll.objects.link(dup_obj)
    try:
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        eval_obj = dup_obj.evaluated_get(depsgraph)
        new_mesh = bpy.data.meshes.new_from_object(
            eval_obj, preserve_all_data_layers=False, depsgraph=depsgraph
        )
        new_mesh.name = f"{cutter_name}_mesh"
        dup_obj.data = new_mesh
        bpy.data.curves.remove(dup_data)
    finally:
        scene_coll.objects.unlink(dup_obj)

    return dup_obj


def _attach_terrain_boolean(
    terrain: bpy.types.Object,
    cutter: bpy.types.Object,
    *,
    mod_name: str,
) -> None:
    """Stack a Boolean DIFFERENCE modifier on the terrain pointing at
    ``cutter``. One modifier per tunnel — keeps each carve independent
    so deleting a tunnel just removes its modifier. EXACT solver, no
    self-intersection check (use_self=False — the 148k-vert terrain
    asks the solver for ~58 GB if it's on)."""
    mod = terrain.modifiers.get(mod_name)
    if mod is None:
        mod = terrain.modifiers.new(name=mod_name, type="BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.operand_type = "OBJECT"
    mod.object = cutter
    mod.solver = "EXACT"
    mod.use_self = False
    mod.show_viewport = True


def _is_tunnel_boolean(mod: bpy.types.Modifier) -> bool:
    """True if this modifier is one of ours — either the GN-rig
    singleton or a per-cutter Boolean stamped by Build Tunnel."""
    if mod.type != "BOOLEAN":
        return False
    return mod.name == TUNNEL_GN_BOOLEAN_NAME or mod.name.startswith(TUNNEL_BOOLEAN_MOD_PREFIX)


def _stash_tunnel_cuts(terrain: bpy.types.Object) -> int:
    """Strip every tunnel Boolean modifier off the terrain and record
    its spec as JSON on the terrain so ``_restore_tunnel_cuts`` can
    rebuild it later. Editing curves is interactive (~1 ms / edit)
    while the stash exists because there's no longer a depsgraph
    edge from the cutter meshes back to the terrain.

    Returns the number of modifiers stashed."""
    specs: list[dict] = []
    for m in list(terrain.modifiers):
        if not _is_tunnel_boolean(m):
            continue
        specs.append({
            "name": m.name,
            "operation": m.operation,
            "solver": m.solver,
            "use_self": bool(m.use_self),
            "operand_type": getattr(m, "operand_type", "OBJECT"),
            "object": m.object.name if m.object else None,
            "collection": m.collection.name if getattr(m, "collection", None) else None,
        })
        terrain.modifiers.remove(m)
    terrain[TUNNEL_STASHED_CUTS_PROP] = json.dumps(specs)
    return len(specs)


def _restore_tunnel_cuts(terrain: bpy.types.Object) -> int:
    """Re-attach every tunnel Boolean modifier from the stash on the
    terrain. Skips specs whose operand has gone missing rather than
    failing the whole restore — a stale stash from a deleted tunnel
    shouldn't strand the user."""
    raw = terrain.get(TUNNEL_STASHED_CUTS_PROP)
    if not raw:
        return 0
    try:
        specs = json.loads(raw)
    except (TypeError, ValueError):
        del terrain[TUNNEL_STASHED_CUTS_PROP]
        return 0
    n = 0
    for spec in specs:
        name = spec["name"]
        # If somehow a modifier with the same name was added back
        # outside this toggle (e.g. another Build Tunnel call while in
        # edit mode), don't double-stack.
        if terrain.modifiers.get(name) is not None:
            continue
        m = terrain.modifiers.new(name, "BOOLEAN")
        m.operation = spec.get("operation", "DIFFERENCE")
        m.solver = spec.get("solver", "EXACT")
        m.use_self = bool(spec.get("use_self", False))
        m.operand_type = spec.get("operand_type", "OBJECT")
        if m.operand_type == "OBJECT":
            obj_name = spec.get("object")
            obj = bpy.data.objects.get(obj_name) if obj_name else None
            if obj is None:
                # Operand gone — back the modifier out and continue.
                terrain.modifiers.remove(m)
                continue
            m.object = obj
        else:
            col_name = spec.get("collection")
            col = bpy.data.collections.get(col_name) if col_name else None
            if col is None:
                terrain.modifiers.remove(m)
                continue
            m.collection = col
        n += 1
    del terrain[TUNNEL_STASHED_CUTS_PROP]
    return n


def _is_in_tunnel_edit_mode(terrain: bpy.types.Object | None) -> bool:
    return terrain is not None and TUNNEL_STASHED_CUTS_PROP in terrain.keys()


def _add_tunnel_starter_curve(scene) -> bpy.types.Object:
    """Create a 4-point Bezier curve named ``tunnel_curve_main``."""
    existing = bpy.data.objects.get(TUNNEL_CURVE_NAME)
    if existing is not None:
        return existing
    curve_data = bpy.data.curves.new(TUNNEL_CURVE_NAME, type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 24
    spline = curve_data.splines.new(type="BEZIER")
    spline.bezier_points.add(3)
    coords = [(-60, 0, 10), (-20, 0, 12), (20, 0, 12), (60, 0, 10)]
    for bp, (x, y, z) in zip(spline.bezier_points, coords):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    spline.use_cyclic_u = False
    obj = bpy.data.objects.new(TUNNEL_CURVE_NAME, curve_data)
    scene.collection.objects.link(obj)
    # Canonical tag via the auto_tag rule table (same source as the
    # depsgraph handler) so operator + paste + rename paths all agree.
    from .auto_tag import apply_canonical_tag
    apply_canonical_tag(obj)
    return obj


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_toggle_tunnel_edit_mode(Operator):
    """Toggle Tunnel Edit Mode: strip every tunnel Boolean from the
    terrain (or re-attach them).

    Why: editing a tunnel curve dirties its containing collection
    → dirties the cutter mesh → dirties the terrain. Blender's
    modifier stack has no per-modifier output cache, so the terrain
    re-evaluates ``HV_Island`` (~1 s) *and* ``HV_TunnelCut`` (~1 s)
    on every single bezier-point drag. ``show_viewport=False`` doesn't
    fix this — the dep edge still exists. Removing the modifier breaks
    the edge cleanly. Edits drop from ~2 s to ~1 ms.

    Reversible: the modifier specs are JSON-stashed on the terrain
    and re-instated on the next toggle, preserving operation, solver,
    use_self, and operand pointer."""

    bl_idname = "hoverbike.toggle_tunnel_edit_mode"
    bl_label = "Toggle Tunnel Edit Mode"
    bl_description = (
        "Strip the tunnel Boolean modifiers off the terrain so curve edits are "
        "interactive again; toggle again to re-attach them and see the mouth cuts"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from ._legacy import _largest_terrain_mesh

        terrain = _largest_terrain_mesh()
        if terrain is None:
            self.report({"ERROR"}, "No terrain mesh found (largest visible kind='track' mesh).")
            return {"CANCELLED"}

        if _is_in_tunnel_edit_mode(terrain):
            n = _restore_tunnel_cuts(terrain)
            self.report(
                {"INFO"},
                f"Re-attached {n} tunnel cut(s) — terrain will re-evaluate on the next curve edit.",
            )
        else:
            n = _stash_tunnel_cuts(terrain)
            if n == 0:
                # Nothing was stashed — drop the flag again so we don't
                # leave the terrain in a half-state.
                if TUNNEL_STASHED_CUTS_PROP in terrain.keys():
                    del terrain[TUNNEL_STASHED_CUTS_PROP]
                self.report(
                    {"INFO"},
                    "No tunnel Boolean modifiers on the terrain — already interactive.",
                )
                return {"CANCELLED"}
            self.report(
                {"INFO"},
                f"Stashed {n} tunnel cut(s). Curve edits should be instant — toggle again to preview.",
            )
        return {"FINISHED"}


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


def build_tunnel_from_curve(
    scene,
    curve: bpy.types.Object,
    terrain: bpy.types.Object,
    *,
    radius: float,
    wall_thickness: float,
    segments: int,
    end_extend: float,
) -> bpy.types.Object:
    """Bake a tunnel from a single curve. Public entry point used by
    the Build Tunnel operator *and* by ``seed_template_tunnel_island``
    so both go through the same path.

    Returns the cutter mesh object."""
    _apply_curve_bevel(curve, radius=radius, segments=segments, fill_caps=False)
    curve["kind"] = "track"
    if not curve.data.materials:
        curve.data.materials.append(_ensure_tunnel_material())

    prev_cutter_name = curve.get(TUNNEL_CUTTER_PROP)
    prev_cutter = bpy.data.objects.get(prev_cutter_name) if prev_cutter_name else None
    if prev_cutter is not None:
        cutter_name = prev_cutter.name
        mod_name = f"{TUNNEL_BOOLEAN_MOD_PREFIX}{cutter_name}"
        old_mod = terrain.modifiers.get(mod_name)
        if old_mod is not None:
            old_mod.object = None
        mesh_data = prev_cutter.data if prev_cutter.type == "MESH" else None
        bpy.data.objects.remove(prev_cutter, do_unlink=True)
        if mesh_data is not None and mesh_data.users == 0:
            bpy.data.meshes.remove(mesh_data)
    else:
        idx = _next_tunnel_index()
        cutter_name = f"{TUNNEL_PARENT_PREFIX}{idx:02d}_cutter"
        mod_name = f"{TUNNEL_BOOLEAN_MOD_PREFIX}{cutter_name}"

    cutter_obj = _build_cutter_from_curve(
        curve,
        radius=radius + wall_thickness,
        segments=segments,
        end_extend=end_extend,
        cutter_name=cutter_name,
    )
    cutter_obj["kind"] = "tunnel_cutter"
    cutter_obj["tunnel_curve"] = curve.name
    cutter_obj.display_type = "WIRE"
    cutters_col = _ensure_tunnel_cutters_collection(scene)
    cutters_col.objects.link(cutter_obj)
    cutter_obj.hide_render = True
    cutter_obj.hide_set(True)

    curve[TUNNEL_CUTTER_PROP] = cutter_obj.name

    _strip_solidify_legacy(terrain)
    _attach_terrain_boolean(terrain, cutter_obj, mod_name=mod_name)
    return cutter_obj


class HOVERBIKE_OT_build_tunnel(Operator):
    """Bake a tunnel from the active (or named) tunnel curve.

    Sets the curve's own bevel to a closed cylinder for the visible
    interior, then duplicates the curve, pumps the bevel out by the
    wall thickness, converts the duplicate to a manifold mesh, stashes
    it as the cutter, and adds a Boolean DIFFERENCE modifier on the
    terrain so the mouth ring is cut where the cutter pierces the
    surface.

    Re-clicking on the same curve rebuilds its cutter in place. To
    add a *new* tunnel, select a different curve first."""

    bl_idname = "hoverbike.build_tunnel"
    bl_label = "Build Tunnel"
    bl_description = "Carve a tunnel through the terrain along the active tunnel curve"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from ._legacy import _largest_terrain_mesh

        scene = context.scene

        # template-tunnels.blend has its own live GN rig: a
        # ``tunnels_cutter`` mesh whose GN modifier sweeps every curve
        # in the ``Tunnel Curves`` collection. Don't fight it — clicking
        # Build Tunnel there should redirect the user, not stamp a
        # competing curve-bevel system on top.
        gn_cutter = bpy.data.objects.get("tunnels_cutter")
        if gn_cutter is not None and any(m.type == "NODES" for m in gn_cutter.modifiers):
            self.report(
                {"INFO"},
                "This scene uses the GN tunnel rig — duplicate a curve in 'Tunnel Curves' "
                "(Shift-D) to add a new tunnel. The sweep + terrain boolean update live.",
            )
            return {"CANCELLED"}

        curve = _resolve_tunnel_curve(context)
        if curve is None or curve.type != "CURVE":
            self.report(
                {"ERROR"},
                "Select a Bezier curve, or click *Add Tunnel Starter Curve* first.",
            )
            return {"CANCELLED"}
        terrain = _largest_terrain_mesh()
        if terrain is None:
            self.report({"ERROR"}, "No terrain mesh found (largest visible kind='track' mesh).")
            return {"CANCELLED"}

        radius = float(getattr(scene, "hoverbike_tunnel_radius", 8.0))
        wall_thickness = float(getattr(scene, "hoverbike_tunnel_wall_thickness", 1.0))
        segments = int(getattr(scene, "hoverbike_tunnel_segments", 14))
        end_extend = float(getattr(scene, "hoverbike_tunnel_end_extend", 4.0))
        if radius <= 0 or segments < 3:
            self.report({"ERROR"}, "Invalid tunnel parameters — fix radius / segments.")
            return {"CANCELLED"}

        cutter = build_tunnel_from_curve(
            scene, curve, terrain,
            radius=radius,
            wall_thickness=wall_thickness,
            segments=segments,
            end_extend=end_extend,
        )

        self.report(
            {"INFO"},
            f"Built {cutter.name} from {curve.name}: r={radius:.1f}m, wall={wall_thickness:.2f}m. "
            f"Edit the curve and re-click Build Tunnel to update.",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_toggle_tunnel_edit_mode,
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
            "Legacy — no longer used. Curve smoothness is governed by the curve's own "
            "resolution_u (in Object Data → Shape)."
        ),
        default=32, min=4, max=256,
    )
    bpy.types.Scene.hoverbike_tunnel_segments = IntProperty(
        name="Tunnel segments",
        description=(
            "Number of radial sides per cross-section ring. 12–16 reads as a smooth tube; "
            "6 reads as a hex pipe. Rounded internally to the nearest multiple of 4."
        ),
        default=14, min=3, max=64,
    )
    bpy.types.Scene.hoverbike_tunnel_end_extend = FloatProperty(
        name="Tunnel end extend (m)",
        description=(
            "Distance the cutter's endpoints are pushed past the curve's endpoints along the "
            "tangent. Ensures the boolean cut clears the terrain surface at the mouth even when "
            "the user's endpoints land right on the hillside. Applied only to the cutter copy — "
            "the visible interior keeps the curve's authored endpoints."
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
