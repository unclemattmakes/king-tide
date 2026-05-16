"""Terrain attribute bakers — AO + path-wear.

Fills the ``baked_ao`` (FLOAT) and ``baked_path`` (FLOAT) attributes
on the source terrain mesh so the GN graph can route them into
COLOR_0.G (AO multiplier) and COLOR_0.B (racing-line wear). The
seeded GN graph samples these as Named Attributes; the runtime
terrain shader reads both channels and uses them to darken cavities
and tint a worn dirt line into the surface where the racing line
runs.

AO uses Cycles' vertex-colour bake — fastest path on consumer GPUs
and handles the GN-evaluated terrain geometry correctly (Cycles
internally applies modifiers before baking). Path-wear uses a KDTree
over a densely sampled spline polyline — pure Python, ~1 s on a
150 k-vert terrain.
"""

from __future__ import annotations

import bpy
from bpy.types import Operator
from mathutils import Vector
from mathutils.kdtree import KDTree


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

BAKED_AO_ATTR = "baked_ao"
BAKED_PATH_ATTR = "baked_path"
BAKE_TEMP_ATTR = "_hoverbike_bake_target"
PATH_WEAR_INNER_M = 4.0      # full wear within this distance of the spline
PATH_WEAR_OUTER_M = 14.0     # zero wear beyond this distance


# ────────────────────────────────────────────────────────────────────
# Bake implementations
# ────────────────────────────────────────────────────────────────────


def _ensure_baked_attrs(terrain: bpy.types.Object) -> None:
    """Make sure the source terrain mesh has the baked-* attributes the
    GN graph reads. Both stored as plain FLOAT so glTF's vertex-colour
    heuristic doesn't pick them up and stomp the GN-stamped COLOR_0 in
    the export. Idempotent — pre-existing attributes are left alone."""
    me = terrain.data
    if BAKED_AO_ATTR not in me.attributes:
        attr = me.attributes.new(name=BAKED_AO_ATTR, type="FLOAT", domain="POINT")
        for i in range(len(attr.data)):
            attr.data[i].value = 1.0  # default = no occlusion
    if BAKED_PATH_ATTR not in me.attributes:
        attr = me.attributes.new(name=BAKED_PATH_ATTR, type="FLOAT", domain="POINT")
        for i in range(len(attr.data)):
            attr.data[i].value = 0.0  # default = no wear


def _bake_ao_cycles(
    terrain: bpy.types.Object, samples: int = 16, distance: float = 30.0
) -> None:
    """Bake Cycles AO into the terrain's ``baked_ao`` FLOAT attribute.

    Cycles needs a vertex *colour* attribute as its target, but a
    FLOAT_COLOR on the source mesh would be picked up by glTF's
    auto-export heuristic and shipped as COLOR_0, fighting the
    GN-stamped COLOR_0. We work around that by creating a throwaway
    FLOAT_COLOR (``_hoverbike_bake_target``) for Cycles to write into,
    copying the R channel into the persistent ``baked_ao`` float, and
    deleting the temporary attribute on the way out. Net effect: the
    source mesh ships with only FLOAT attributes, and the GN graph's
    ``Named Attribute`` sampler reads ``baked_ao`` for COLOR_0.G."""
    scene = bpy.context.scene
    me = terrain.data
    prev_engine = scene.render.engine

    # Create the throwaway bake target.
    if BAKE_TEMP_ATTR in me.color_attributes:
        me.color_attributes.remove(me.color_attributes[BAKE_TEMP_ATTR])
    target = me.color_attributes.new(
        name=BAKE_TEMP_ATTR, type="FLOAT_COLOR", domain="POINT"
    )
    me.color_attributes.active_color_index = me.color_attributes.find(BAKE_TEMP_ATTR)

    scene.render.engine = "CYCLES"
    scene.cycles.bake_type = "AO"
    scene.cycles.samples = samples
    scene.render.bake.target = "VERTEX_COLORS"
    if scene.world is not None:
        try:
            scene.world.light_settings.use_ambient_occlusion = True
            scene.world.light_settings.distance = distance
        except AttributeError:
            pass

    prev_active_obj = bpy.context.view_layer.objects.active
    # ``selected_objects`` isn't available on every context (e.g. when
    # the operator runs from a non-VIEW_3D context like MCP/headless).
    prev_selection = list(getattr(bpy.context, "selected_objects", []))
    for o in prev_selection:
        o.select_set(False)
    bpy.context.view_layer.objects.active = terrain
    terrain.select_set(True)
    try:
        bpy.ops.object.bake(type="AO")
        # Transfer Cycles' RGB output (greyscale, R == G == B for AO)
        # into the persistent FLOAT attribute.
        ao_attr = me.attributes[BAKED_AO_ATTR]
        for i in range(len(target.data)):
            ao_attr.data[i].value = float(target.data[i].color[0])
    finally:
        terrain.select_set(False)
        for o in prev_selection:
            o.select_set(True)
        bpy.context.view_layer.objects.active = prev_active_obj
        scene.render.engine = prev_engine
        if BAKE_TEMP_ATTR in me.color_attributes:
            me.color_attributes.remove(me.color_attributes[BAKE_TEMP_ATTR])


def _bake_path_wear(terrain: bpy.types.Object, spline: bpy.types.Object) -> int:
    """Compute per-vertex distance from the AI spline, run it through
    a smoothstep falloff, and write the result to ``baked_path`` on
    the source terrain. Reads the *evaluated* terrain mesh (post-GN)
    so vertex world positions reflect the actual displaced terrain —
    distance-from-spline only makes sense in the played world, not on
    a flat undisplaced plane. The vertex-index mapping back to the
    source mesh is one-to-one because the GN graph doesn't add or
    remove verts."""
    if spline is None or spline.type != "CURVE":
        raise RuntimeError("path-wear bake needs an ai_spline_main curve")

    dg = bpy.context.evaluated_depsgraph_get()

    # Dense polyline samples from the spline. Step ~1 m so a KDTree
    # nearest-neighbour is a very tight distance estimate.
    cobj = spline.evaluated_get(dg)
    cme = cobj.to_mesh()
    try:
        sw = spline.matrix_world
        spline_pts = [sw @ Vector(v.co) for v in cme.vertices]
    finally:
        try:
            cobj.to_mesh_clear()
        except ReferenceError:
            pass
    if len(spline_pts) < 2:
        raise RuntimeError("ai_spline_main has too few sampled points")

    tree = KDTree(len(spline_pts))
    for i, p in enumerate(spline_pts):
        tree.insert(p, i)
    tree.balance()

    eobj = terrain.evaluated_get(dg)
    eme = eobj.to_mesh()
    n_verts = 0
    try:
        if len(eme.vertices) != len(terrain.data.vertices):
            raise RuntimeError(
                f"vertex-count mismatch (source {len(terrain.data.vertices)}, "
                f"evaluated {len(eme.vertices)}) — GN graph appears to add/remove verts"
            )
        mw = terrain.matrix_world
        path_attr = terrain.data.attributes[BAKED_PATH_ATTR]
        outer = float(PATH_WEAR_OUTER_M)
        inner = float(PATH_WEAR_INNER_M)
        span = max(outer - inner, 1e-6)
        n_verts = len(eme.vertices)
        for i, v in enumerate(eme.vertices):
            world = mw @ Vector(v.co)
            _, _, dist = tree.find(world)
            # Smoothstep from outer (wear=0) to inner (wear=1).
            t = max(0.0, min(1.0, (outer - dist) / span))
            wear = t * t * (3.0 - 2.0 * t)
            path_attr.data[i].value = wear
    finally:
        try:
            eobj.to_mesh_clear()
        except ReferenceError:
            # Cycles' bake can invalidate the cached evaluated mesh
            # mid-operator; the per-vertex writes above already
            # happened so the bake is complete — we just can't clean
            # up the cache reference any more. Safe to swallow.
            pass
    return n_verts


# ────────────────────────────────────────────────────────────────────
# Operator
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_bake_terrain_attrs(Operator):
    """Bake AO + racing-line wear into the source terrain's
    ``baked_ao`` / ``baked_path`` attributes. The HV_Island GN graph
    samples both via Named Attribute nodes and routes them into
    COLOR_0.G (AO multiplier) and COLOR_0.B (path-worn), which the
    runtime terrain shader reads to darken cavities and stamp a worn
    dirt line into the racing surface."""

    bl_idname = "hoverbike.bake_terrain_attrs"
    bl_label = "Bake AO + Path Wear"
    bl_description = (
        "Bake ambient occlusion (Cycles) and AI-spline path wear (Python KDTree) "
        "into the terrain's baked_ao + baked_path attributes. ~10-20 s on a 150k-vert terrain."
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        terrain = bpy.data.objects.get("terrain")
        if terrain is None or terrain.type != "MESH":
            self.report({"ERROR"}, "no `terrain` mesh in scene")
            return {"CANCELLED"}
        spline = bpy.data.objects.get("ai_spline_main")
        if spline is None or spline.type != "CURVE":
            self.report({"ERROR"}, "no `ai_spline_main` curve in scene")
            return {"CANCELLED"}

        _ensure_baked_attrs(terrain)
        try:
            _bake_ao_cycles(terrain)
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"AO bake failed: {e}")
            return {"CANCELLED"}
        try:
            n = _bake_path_wear(terrain, spline)
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"path-wear bake failed: {e}")
            return {"CANCELLED"}
        self.report({"INFO"}, f"Baked AO + path wear over {n} vertices")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (HOVERBIKE_OT_bake_terrain_attrs,)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
