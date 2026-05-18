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

Path-wear knobs are scene-level (``hoverbike_path_wear_inner`` /
``_outer`` / ``_intensity``) so authors can tune width / depth from
the addon panel without re-editing the operator. See
[docs/vertex-attribute-spec.md](../../docs/vertex-attribute-spec.md)
for the channel contract.
"""

from __future__ import annotations

import bpy
from bpy.props import BoolProperty, FloatProperty
from bpy.types import Operator
from mathutils import Vector
from mathutils.kdtree import KDTree


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

BAKED_AO_ATTR = "baked_ao"
BAKED_PATH_ATTR = "baked_path"
BAKE_TEMP_ATTR = "_hoverbike_bake_target"

# Path-wear defaults. Inner = 0 m → full wear on the line itself;
# outer = 8 m → faded out beyond 8 m. Intensity is a [0, 1] multiplier
# on the final wear value, useful for backing the racing line off
# when the runtime ``pathTint`` is already aggressive.
DEFAULT_PATH_WEAR_INNER_M = 0.0
DEFAULT_PATH_WEAR_OUTER_M = 8.0
DEFAULT_PATH_WEAR_INTENSITY = 1.0


# ────────────────────────────────────────────────────────────────────
# Pure math — kept as a free function so the self-test below can
# exercise it without booting Blender's depsgraph.
# ────────────────────────────────────────────────────────────────────


def path_wear_at_distance(
    distance: float,
    inner: float = DEFAULT_PATH_WEAR_INNER_M,
    outer: float = DEFAULT_PATH_WEAR_OUTER_M,
    intensity: float = DEFAULT_PATH_WEAR_INTENSITY,
) -> float:
    """Map ``distance`` (metres from the AI spline polyline) to a wear
    value in [0, 1].

    * ``distance <= inner`` → ``1.0 * intensity`` (full wear on the line).
    * ``distance >= outer`` → ``0.0`` (no wear beyond the falloff).
    * In between, follows a smoothstep from outer→inner (so wear *rises*
      as you approach the line).

    ``intensity`` is a [0, 1] multiplier on the final value (clamped to
    a sane upper bound so a runaway slider can't write values past 1).
    """
    if outer <= inner:
        # Degenerate band — collapse to a hard mask at ``inner``.
        wear = 1.0 if distance <= inner else 0.0
    elif distance <= inner:
        wear = 1.0
    elif distance >= outer:
        wear = 0.0
    else:
        # Smoothstep from outer (wear=0) → inner (wear=1).
        t = (outer - distance) / (outer - inner)
        wear = t * t * (3.0 - 2.0 * t)
    return max(0.0, min(1.0, wear * max(0.0, min(1.0, intensity))))


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


def _bake_path_wear(
    terrain: bpy.types.Object,
    spline: bpy.types.Object,
    *,
    inner: float = DEFAULT_PATH_WEAR_INNER_M,
    outer: float = DEFAULT_PATH_WEAR_OUTER_M,
    intensity: float = DEFAULT_PATH_WEAR_INTENSITY,
) -> int:
    """Compute per-vertex distance from the AI spline, run it through
    a smoothstep falloff, and write the result to ``baked_path`` on
    the source terrain. Reads the *evaluated* terrain mesh (post-GN)
    so vertex world positions reflect the actual displaced terrain —
    distance-from-spline only makes sense in the played world, not on
    a flat undisplaced plane. The vertex-index mapping back to the
    source mesh is one-to-one because the GN graph doesn't add or
    remove verts.

    Idempotent: re-running with the same inputs stamps the same values.

    Args:
        terrain: the source ``kind=track`` terrain mesh.
        spline: the AI racing-line curve (``ai_spline_main``).
        inner: distance (m) at which wear saturates at 1.0.
        outer: distance (m) beyond which wear is 0.0. Must be > inner
            (or the band collapses to a hard mask at ``inner``).
        intensity: [0, 1] multiplier on the final wear value.
    """
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

    # XZ-only distance (per vertex-attribute-spec): project the spline
    # samples onto the y=0 plane before inserting. That way a vertex
    # *under* the racing line — on a hill where the spline floats well
    # above the terrain — still picks up wear, which is what authors
    # expect: the worn band is where the bike *would drive*, not where
    # the spline floats in 3D.
    tree = KDTree(len(spline_pts))
    for i, p in enumerate(spline_pts):
        tree.insert(Vector((p.x, 0.0, p.z)), i)
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
        n_verts = len(eme.vertices)
        # Both stored points and queries live on the y=0 plane, so the
        # KDTree's 3D nearest-neighbour distance is the planar XZ
        # distance from the vertex to the racing line — exactly what
        # path-worn wants (the bike's racing footprint, not the
        # spline's possibly-elevated 3D arc).
        for i, v in enumerate(eme.vertices):
            world = mw @ Vector(v.co)
            _, _, dist = tree.find(Vector((world.x, 0.0, world.z)))
            path_attr.data[i].value = path_wear_at_distance(
                dist, inner=inner, outer=outer, intensity=intensity
            )
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
# Helpers shared by the operators + the auto-bake export hook.
# ────────────────────────────────────────────────────────────────────


def _resolve_terrain() -> bpy.types.Object | None:
    """Resolve "the terrain mesh" the bakers should write into. Prefers
    a literal ``terrain`` object (every seeded template uses that name),
    then falls back to the largest visible ``kind=track`` mesh — same
    rule the road / sculpt / tunnel tools use, so hand-authored maps
    that don't start from a template still find their terrain."""
    obj = bpy.data.objects.get("terrain")
    if obj is not None and obj.type == "MESH":
        return obj
    # Lazy import: ``_legacy`` pulls in a chunk of the addon, no point
    # paying for it on every module import.
    from ._legacy import _largest_terrain_mesh

    return _largest_terrain_mesh()


def _path_wear_params(scene: bpy.types.Scene) -> tuple[float, float, float]:
    """Read the three scene-level path-wear knobs with safe defaults so
    a scene that pre-dates the props doesn't error out."""
    inner = float(
        getattr(scene, "hoverbike_path_wear_inner", DEFAULT_PATH_WEAR_INNER_M)
        or 0.0
    )
    outer = float(
        getattr(scene, "hoverbike_path_wear_outer", DEFAULT_PATH_WEAR_OUTER_M)
        or 0.0
    )
    intensity = float(
        getattr(scene, "hoverbike_path_wear_intensity", DEFAULT_PATH_WEAR_INTENSITY)
        or 0.0
    )
    return inner, outer, intensity


def auto_bake_path_wear_for_export(scene: bpy.types.Scene) -> tuple[bool, str]:
    """Pre-export hook: stamp ``baked_path`` from the current scene
    settings before the GLB is written, so authors who never thought
    about path-wear still ship with a baked racing line.

    Returns ``(ok, message)``. ``ok=False`` is non-fatal — the caller
    logs it as a warning and continues the export. Skipped if the
    scene has no ``ai_spline_main`` (a brand-new map mid-authoring),
    no terrain, or if every path-wear input is at its skip-it default
    (``intensity == 0``).
    """
    inner, outer, intensity = _path_wear_params(scene)
    if intensity <= 0.0:
        return True, "path-wear bake skipped (intensity = 0)"

    terrain = _resolve_terrain()
    if terrain is None:
        return False, "path-wear bake skipped: no kind=track terrain"
    spline = bpy.data.objects.get("ai_spline_main")
    if spline is None or spline.type != "CURVE":
        return False, "path-wear bake skipped: no ai_spline_main"

    _ensure_baked_attrs(terrain)
    try:
        n = _bake_path_wear(
            terrain, spline, inner=inner, outer=outer, intensity=intensity
        )
    except Exception as e:  # noqa: BLE001
        return False, f"path-wear bake failed: {e}"
    return True, f"path-wear baked over {n} vertices"


# ────────────────────────────────────────────────────────────────────
# Operators
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
        terrain = _resolve_terrain()
        if terrain is None:
            self.report({"ERROR"}, "no `kind=track` terrain mesh in scene")
            return {"CANCELLED"}
        spline = bpy.data.objects.get("ai_spline_main")
        if spline is None or spline.type != "CURVE":
            self.report({"ERROR"}, "no `ai_spline_main` curve in scene")
            return {"CANCELLED"}

        inner, outer, intensity = _path_wear_params(context.scene)
        _ensure_baked_attrs(terrain)
        try:
            _bake_ao_cycles(terrain)
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"AO bake failed: {e}")
            return {"CANCELLED"}
        try:
            n = _bake_path_wear(
                terrain, spline, inner=inner, outer=outer, intensity=intensity
            )
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"path-wear bake failed: {e}")
            return {"CANCELLED"}
        self.report({"INFO"}, f"Baked AO + path wear over {n} vertices")
        return {"FINISHED"}


class HOVERBIKE_OT_bake_path_worn(Operator):
    """Bake just the racing-line wear mask — fast path for iterating on
    falloff width / intensity without paying the Cycles AO cost. Writes
    the same ``baked_path`` FLOAT attribute the AO+path operator writes
    into, so the GN graph still picks it up into ``COLOR_0.B``.

    The bake reads the *evaluated* terrain (post-GN modifiers) so any
    procedural displacement is reflected in the per-vertex world XZ
    distance to the AI spline. The wear value follows a smoothstep:
    full wear (= 1 × intensity) within ``Falloff inner`` of the line,
    no wear beyond ``Falloff outer``. Defaults match the racing-line
    feel — full wear directly on the line, faded out beyond 8 m.

    Idempotent: same inputs → same stamps. Pure producer for the
    runtime ``pathTint`` mix in ``src/engine/render/terrain-shader.ts``;
    requires the seeded GN graph (or an equivalent one) that samples
    ``baked_path`` into ``COLOR_0.B``."""

    bl_idname = "hoverbike.bake_path_worn"
    bl_label = "Bake Path-Worn"
    bl_description = (
        "Stamp the racing-line wear mask (distance-to-spline, smoothstep falloff) "
        "into the terrain's baked_path attribute. ~1 s on a 150k-vert terrain"
    )
    bl_options = {"REGISTER", "UNDO"}

    # Operator-level overrides so the F6 Redo panel exposes the same
    # three knobs as the sub-panel. Default to the scene props so a
    # click on the sub-panel button uses the author's tuning verbatim.
    inner_m: FloatProperty(  # type: ignore[valid-type]
        name="Falloff inner (m)",
        description=(
            "Distance from the AI spline at which wear saturates at 1.0. "
            "Default 0 m — full wear on the racing line itself"
        ),
        default=DEFAULT_PATH_WEAR_INNER_M, min=0.0, max=50.0, precision=2,
    )
    outer_m: FloatProperty(  # type: ignore[valid-type]
        name="Falloff outer (m)",
        description=(
            "Distance beyond which wear is 0. Smoothstep falloff between inner "
            "and outer. Default 8 m"
        ),
        default=DEFAULT_PATH_WEAR_OUTER_M, min=0.1, max=200.0, precision=2,
    )
    intensity: FloatProperty(  # type: ignore[valid-type]
        name="Intensity",
        description=(
            "Multiplier on the final wear value (clamped to [0, 1]). 0 disables "
            "the bake entirely so the GLB ships pristine; 1 stamps the full mask"
        ),
        default=DEFAULT_PATH_WEAR_INTENSITY, min=0.0, max=1.0, precision=2,
    )
    use_scene: BoolProperty(  # type: ignore[valid-type]
        name="Use scene knobs",
        description=(
            "If on (default), pull falloff inner/outer/intensity from the "
            "scene-level path-wear sliders. Off lets you A/B test values in "
            "the F6 Redo panel without disturbing the scene tuning"
        ),
        default=True,
    )

    def execute(self, context):
        terrain = _resolve_terrain()
        if terrain is None:
            self.report({"ERROR"}, "no `kind=track` terrain mesh in scene")
            return {"CANCELLED"}
        spline = bpy.data.objects.get("ai_spline_main")
        if spline is None or spline.type != "CURVE":
            self.report({"ERROR"}, "no `ai_spline_main` curve in scene")
            return {"CANCELLED"}

        if self.use_scene:
            inner, outer, intensity = _path_wear_params(context.scene)
        else:
            inner, outer, intensity = (
                float(self.inner_m),
                float(self.outer_m),
                float(self.intensity),
            )

        _ensure_baked_attrs(terrain)
        try:
            n = _bake_path_wear(
                terrain, spline, inner=inner, outer=outer, intensity=intensity
            )
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"path-wear bake failed: {e}")
            return {"CANCELLED"}
        self.report(
            {"INFO"},
            f"Baked path wear over {n} vertices "
            f"(inner={inner:.1f} m, outer={outer:.1f} m, intensity={intensity:.2f})",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Self-test — exercised by `pnpm test:blender` and the python -m run
# at the bottom of the file. Lives next to the math it tests so a
# missed edge case fails loud the moment someone reloads the addon.
# ────────────────────────────────────────────────────────────────────


def _self_test() -> None:
    # Defaults: inner=0, outer=8, intensity=1.
    eps = 1e-9
    assert abs(path_wear_at_distance(0.0) - 1.0) < eps, "vertex on line → 1"
    assert abs(path_wear_at_distance(8.0) - 0.0) < eps, "vertex at outer → 0"
    assert abs(path_wear_at_distance(9.0) - 0.0) < eps, "vertex past outer → 0"
    # Midpoint: 4 m of an 8 m band → smoothstep(0.5) = 0.5.
    mid = path_wear_at_distance(4.0)
    assert abs(mid - 0.5) < 1e-6, f"midpoint should be ~0.5, got {mid}"

    # Inner band: anything within 0 m saturates; pick a non-zero inner to
    # show the saturation plateau.
    assert path_wear_at_distance(0.5, inner=1.0, outer=5.0) == 1.0
    assert path_wear_at_distance(1.0, inner=1.0, outer=5.0) == 1.0

    # Intensity scales the output linearly.
    assert abs(path_wear_at_distance(0.0, intensity=0.4) - 0.4) < eps
    assert abs(path_wear_at_distance(4.0, intensity=0.5) - 0.25) < 1e-6

    # Intensity = 0 → always 0 (used by the export hook to short-circuit).
    assert path_wear_at_distance(0.0, intensity=0.0) == 0.0

    # Degenerate band (outer <= inner) collapses to a hard mask at inner.
    assert path_wear_at_distance(2.0, inner=5.0, outer=5.0) == 1.0
    assert path_wear_at_distance(6.0, inner=5.0, outer=5.0) == 0.0

    # Intensity gets clamped to [0, 1] so a runaway slider can't write
    # values past 1 into COLOR_0.B.
    assert path_wear_at_distance(0.0, intensity=2.0) == 1.0
    assert path_wear_at_distance(0.0, intensity=-1.0) == 0.0

    # Monotone in distance over the falloff band.
    last = float("inf")
    for d_int in range(0, 81):
        d = d_int / 10.0  # 0.0 → 8.0 in 0.1 steps
        w = path_wear_at_distance(d)
        assert w <= last + 1e-9, f"wear should be monotone decreasing, {w} > {last}"
        last = w

    print("ALL PYTHON CHECKS PASS")


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_bake_terrain_attrs,
    HOVERBIKE_OT_bake_path_worn,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.Scene.hoverbike_path_wear_inner = FloatProperty(
        name="Path-wear inner (m)",
        description=(
            "Distance from the AI spline at which wear saturates at 1.0. "
            "0 = full wear directly on the racing line"
        ),
        default=DEFAULT_PATH_WEAR_INNER_M, min=0.0, max=50.0, precision=2,
    )
    bpy.types.Scene.hoverbike_path_wear_outer = FloatProperty(
        name="Path-wear outer (m)",
        description=(
            "Distance beyond which wear fades to 0. Smoothstep falloff between "
            "inner and outer"
        ),
        default=DEFAULT_PATH_WEAR_OUTER_M, min=0.1, max=200.0, precision=2,
    )
    bpy.types.Scene.hoverbike_path_wear_intensity = FloatProperty(
        name="Path-wear intensity",
        description=(
            "Multiplier on the final wear stamp. 0 disables the bake (handy "
            "for tracks whose biome shouldn't show a worn line, e.g. tunnel "
            "interiors or anti-grav stretches); 1 stamps the full mask"
        ),
        default=DEFAULT_PATH_WEAR_INTENSITY, min=0.0, max=1.0, precision=2,
    )


def unregister() -> None:
    for prop in (
        "hoverbike_path_wear_inner",
        "hoverbike_path_wear_outer",
        "hoverbike_path_wear_intensity",
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


# Run the self-test when invoked as a script (the existing
# tools/blender pattern — see gate_placement.py for a sibling).
if __name__ == "__main__":
    _self_test()
