"""Turn-indicator chevrons.

Samples the AI spline's polyline, finds peaks of signed curvature in
the horizontal plane, and places chevron-shaped arrow gizmos at those
points facing in the direction of the bend. The math is sim-safe and
could mirror to TS later if we ever want auto-placed turn arrows in
the runtime, but today this is preview-only.
"""

from __future__ import annotations

import math

import bpy
import mathutils
from bpy.props import FloatProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

TURN_PREVIEW_COLLECTION = "_hoverbike_turn_preview"
TURN_PREVIEW_MESH = "_hoverbike_turn_chevron"
TURN_INDICATOR_MATERIAL_NAME = "mat_turn_indicator_preview"

# Default curvature threshold in radians-per-metre. ~0.02 ≈ 50 m
# corner radius; tighter than that gets an indicator. The previous
# default of 0.02 missed gentle ovals (200-400 m anchor spacing →
# broad arcs that never crossed the threshold) so authors saw zero
# chevrons placed and assumed the operator was broken. Lowering to
# 0.01 picks up ~100 m radius bends, which is the smallest sweep most
# JetMoto-style tracks author. Authors tune up if a track has too
# many indicators.
DEFAULT_TURN_KAPPA = 0.01
DEFAULT_TURN_LOOKAHEAD = 20.0  # min metres between consecutive markers


# ────────────────────────────────────────────────────────────────────
# Material + mesh
# ────────────────────────────────────────────────────────────────────


def _turn_indicator_material() -> bpy.types.Material:
    """Bright orange unshaded material so the chevron reads against
    any terrain colour at any time of day in the viewport. Same family
    as ``mat_track_ramp`` so the eye groups them as track features."""
    mat = bpy.data.materials.get(TURN_INDICATOR_MATERIAL_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(TURN_INDICATOR_MATERIAL_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (1.0, 0.42, 0.05, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.4
        # Self-emit a little so the chevron stays visible in shaded
        # viewport without depending on scene lighting.
        try:
            bsdf.inputs["Emission Color"].default_value = (1.0, 0.42, 0.05, 1.0)
            bsdf.inputs["Emission Strength"].default_value = 1.5
        except KeyError:
            pass
    return mat


def _turn_chevron_mesh(
    name: str,
    *,
    width: float = 12.0,
    depth: float = 6.0,
    height: float = 2.5,
    thickness: float = 0.4,
):
    """Solid chevron arrow that points along local +X (the bend
    direction). Width = wingspan across, depth = how far the tip
    extends ahead of the wing roots, height = vertical extrusion so
    the sign reads as a 3D pylon rather than a flat decal lying on
    the ground.

    Earlier iterations of this gizmo were a 2.5 m wireframe lying flat
    in XY, invisible against terrain at track scale. Solidifying and
    standing it upright closes the "I rebuilt the indicators but
    don't see them" complaint."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    hw = width * 0.5
    d = depth
    _t = thickness
    h = height
    base = [
        (-d * 0.4, -hw, 0.0),         # 0 back-left
        (0.0, -hw * 0.55, 0.0),       # 1 wing-root-left
        (d, 0.0, 0.0),                # 2 tip
        (0.0, hw * 0.55, 0.0),        # 3 wing-root-right
        (-d * 0.4, hw, 0.0),          # 4 back-right
        (-d * 0.1, hw * 0.45, 0.0),   # 5 inner-right
        (-d * 0.1, 0.0, 0.0),         # 6 inner-tail
        (-d * 0.1, -hw * 0.45, 0.0),  # 7 inner-left
    ]
    verts: list[tuple[float, float, float]] = []
    # Bottom slab at z=0, top slab at z=h. Pylon stands +Z up.
    for x, y, _z in base:
        verts.append((x, y, 0.0))
    for x, y, _z in base:
        verts.append((x, y, h))
    n = 8
    faces: list[tuple[int, ...]] = []
    # Top face (CCW seen from +Z)
    faces.append((n + 0, n + 1, n + 2, n + 3, n + 4, n + 5, n + 6, n + 7))
    # Bottom face (reverse winding)
    faces.append((7, 6, 5, 4, 3, 2, 1, 0))
    # Side quads — one per outer edge of the chevron silhouette
    for i in range(n):
        a = i
        b = (i + 1) % n
        faces.append((a, b, n + b, n + a))
    me.from_pydata(verts, [], faces)
    me.update()
    for poly in me.polygons:
        poly.use_smooth = False
    me.materials.append(_turn_indicator_material())
    return me


# ────────────────────────────────────────────────────────────────────
# Curvature analysis
# ────────────────────────────────────────────────────────────────────


def _signed_curvature_peaks(points, *, kappa_threshold: float, min_spacing_m: float):
    """Walk the closed polyline and return a list of dicts with
    ``index`` (peak index), ``position`` (world Vector3 tuple),
    ``tangent`` (unit XY tuple), ``perp`` (unit XY tuple pointing in
    the bend direction; positive curvature → left turn in xy, perp
    points right of the tangent), ``kappa`` (signed rad/m).

    Curvature is approximated as the signed angle between adjacent
    polyline segments divided by the local segment length. Local
    maxima of |kappa| above ``kappa_threshold`` are kept, with
    adjacent candidates within ``min_spacing_m`` collapsed to the
    strongest."""
    n = len(points)
    if n < 3:
        return []

    kappas = []
    arc_pos = []
    cumulative = 0.0
    for i in range(n):
        p_prev = points[(i - 1) % n]
        p_cur = points[i]
        p_next = points[(i + 1) % n]
        # Blender Z-up: racing-line lives in XY; ignore Z for curvature.
        ax = p_cur[0] - p_prev[0]; ay = p_cur[1] - p_prev[1]
        bx = p_next[0] - p_cur[0]; by = p_next[1] - p_cur[1]
        la = math.hypot(ax, ay) or 1e-6
        lb = math.hypot(bx, by) or 1e-6
        cross = ax * by - ay * bx
        dot = ax * bx + ay * by
        angle = math.atan2(cross, dot)
        seg = 0.5 * (la + lb)
        kappa = angle / seg if seg > 0 else 0.0
        kappas.append(kappa)
        cumulative += la
        arc_pos.append(cumulative - la)  # arc position at p_cur

    # Find local maxima of |kappa| above threshold.
    candidates = []
    for i in range(n):
        if abs(kappas[i]) < kappa_threshold:
            continue
        prev_k = abs(kappas[(i - 1) % n])
        next_k = abs(kappas[(i + 1) % n])
        cur_k = abs(kappas[i])
        if cur_k < prev_k or cur_k < next_k:
            continue
        candidates.append((i, cur_k, kappas[i]))

    # Greedy collapse — sort by strength descending, keep peaks at
    # least min_spacing_m apart in arc length.
    candidates.sort(key=lambda c: -c[1])
    kept_indices: list[int] = []
    for idx, _, _ in candidates:
        too_close = False
        for kept_idx in kept_indices:
            d = abs(arc_pos[idx] - arc_pos[kept_idx])
            d = min(d, cumulative - d)  # closed-loop wrap
            if d < min_spacing_m:
                too_close = True
                break
        if not too_close:
            kept_indices.append(idx)

    kept_indices.sort()

    out = []
    for i in kept_indices:
        p_cur = points[i]
        p_next = points[(i + 1) % n]
        tx = p_next[0] - p_cur[0]
        ty = p_next[1] - p_cur[1]
        tl = math.hypot(tx, ty) or 1.0
        tx /= tl
        ty /= tl
        sign = 1.0 if kappas[i] > 0 else -1.0
        perp_x = -ty * sign
        perp_y = tx * sign
        out.append({
            "index": i,
            "position": (p_cur[0], p_cur[1], p_cur[2]),
            "tangent": (tx, ty, 0.0),
            "perp": (perp_x, perp_y, 0.0),
            "kappa": kappas[i],
        })
    return out


def _chevron_rotation(perp_xy):
    """Quaternion that maps local +X to the perp direction (bend
    direction) and local +Z to world +Z (up). Chevron lies flat on
    the horizontal plane."""
    x_axis = mathutils.Vector((perp_xy[0], perp_xy[1], 0)).normalized()
    z_axis = mathutils.Vector((0, 0, 1))
    y_axis = z_axis.cross(x_axis).normalized()
    mat = mathutils.Matrix(
        (
            (x_axis.x, y_axis.x, z_axis.x, 0),
            (x_axis.y, y_axis.y, z_axis.y, 0),
            (x_axis.z, y_axis.z, z_axis.z, 0),
            (0, 0, 0, 1),
        )
    )
    return mat.to_quaternion()


def rebuild_turn_indicators(scene, *, kappa_threshold: float, min_spacing_m: float) -> dict:
    """Sample the AI spline, find curvature peaks, and lay down a
    chevron at each. Public because the package-level debounce timer
    in ``_legacy._run_pending_rebuilds`` calls back here when the
    user scrubs the kappa / spacing sliders."""
    from ._legacy import _find_layer_collection, _sample_curve_to_polyline

    sp = bpy.data.objects.get("ai_spline_main")
    if sp is None or sp.type != "CURVE":
        raise RuntimeError("Turn indicators need `ai_spline_main` curve in the scene.")
    points = _sample_curve_to_polyline(sp)
    peaks = _signed_curvature_peaks(
        points, kappa_threshold=kappa_threshold, min_spacing_m=min_spacing_m
    )

    # Wipe prior
    old = bpy.data.collections.get(TURN_PREVIEW_COLLECTION)
    if old:
        for o in list(old.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.collections.remove(old)

    me = _turn_chevron_mesh(TURN_PREVIEW_MESH)
    coll = bpy.data.collections.new(TURN_PREVIEW_COLLECTION)
    scene.collection.children.link(coll)

    for i, p in enumerate(peaks):
        obj = bpy.data.objects.new(f"turn_indicator_{i:02d}", me)
        # Sit the pylon's base on (or just above) the spline's z so it
        # reads as planted on the surface. The chevron mesh is built
        # standing upright (+Z height), so no extra fix-up rotation
        # is needed beyond the in-plane bend-direction rotation.
        obj.location = (p["position"][0], p["position"][1], p["position"][2] + 0.1)
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = _chevron_rotation(p["perp"])
        obj.hide_render = True
        # Don't ghost-through-terrain by default. The chevron is solid
        # and big enough to be legible without the X-ray hack.
        obj.show_in_front = False
        coll.objects.link(obj)

    lc = _find_layer_collection(
        bpy.context.view_layer.layer_collection, TURN_PREVIEW_COLLECTION
    )
    if lc:
        lc.exclude = False

    return {
        "peak_count": len(peaks),
        "max_abs_kappa": max((abs(p["kappa"]) for p in peaks), default=0.0),
    }


def _on_turn_prop_changed(self, context):
    from .handlers import _schedule_rebuild

    _schedule_rebuild("turns")


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_rebuild_turn_indicators(Operator):
    """Find peaks of signed curvature along ``ai_spline_main`` and
    drop chevron arrows pointing in the bend direction. Pure preview —
    collection is render-disabled and never exports."""

    bl_idname = "hoverbike.rebuild_turn_indicators"
    bl_label = "Rebuild Turn Indicators"
    bl_description = "Place chevron arrows at high-curvature points along ai_spline_main"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        threshold = float(scene.hoverbike_turn_kappa)
        summary = rebuild_turn_indicators(
            scene,
            kappa_threshold=threshold,
            min_spacing_m=float(scene.hoverbike_turn_min_spacing),
        )
        if summary["peak_count"] == 0:
            # Common cause: threshold higher than the track's tightest
            # corner. Surface the hint so the author isn't left
            # wondering why nothing appeared.
            max_k = summary["max_abs_kappa"]
            self.report(
                {"WARNING"},
                f"No turns placed — strongest curvature on ai_spline_main is "
                f"|κ|={max_k:.4f} 1/m, below threshold {threshold:.4f}. Lower "
                f"the |κ| min in the panel, or sharpen the spline's bends.",
            )
        else:
            self.report(
                {"INFO"},
                f"Placed {summary['peak_count']} turn indicators "
                f"(max |κ|={summary['max_abs_kappa']:.3f}, threshold {threshold:.3f}).",
            )
        return {"FINISHED"}


class HOVERBIKE_OT_hide_turn_indicators(Operator):
    """Hide the turn-indicator collection without deleting it."""

    bl_idname = "hoverbike.hide_turn_indicators"
    bl_label = "Hide Turn Indicators"
    bl_description = "Hide turn indicators without deleting them"
    bl_options = {"REGISTER"}

    def execute(self, context):
        from ._legacy import _find_layer_collection

        lc = _find_layer_collection(
            context.view_layer.layer_collection, TURN_PREVIEW_COLLECTION
        )
        if lc:
            lc.exclude = True
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_rebuild_turn_indicators,
    HOVERBIKE_OT_hide_turn_indicators,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.Scene.hoverbike_turn_kappa = FloatProperty(
        name="Turn |κ| min (1/m)",
        description=(
            "Curvature threshold for a turn indicator. ~0.05 ≈ 20m-radius corner; lower = more indicators."
        ),
        default=DEFAULT_TURN_KAPPA,
        min=0.001,
        max=2.0,
        precision=4,
        update=_on_turn_prop_changed,
    )
    bpy.types.Scene.hoverbike_turn_min_spacing = FloatProperty(
        name="Turn min spacing (m)",
        description="Minimum arc distance between consecutive turn indicators; collapses adjacent peaks.",
        default=DEFAULT_TURN_LOOKAHEAD,
        min=1.0,
        max=200.0,
        precision=1,
        update=_on_turn_prop_changed,
    )


def unregister() -> None:
    for prop in ("hoverbike_turn_kappa", "hoverbike_turn_min_spacing"):
        try:
            delattr(bpy.types.Scene, prop)
        except AttributeError:
            pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
