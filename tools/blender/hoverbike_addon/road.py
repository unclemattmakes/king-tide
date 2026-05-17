"""Road tool — turn a Bezier curve into a drivable, terrain-conformed
asphalt strip with optional F1-style curbs and auto-banked corners.

The road tool turns a Bezier curve (``road_curve_main``) into two
things at once:

  1. A drivable road strip mesh tagged ``kind=track`` that sits a hair
     above the terrain along the curve. Material ``mat_track_road`` is
     a saturated asphalt grey so the road reads against the natural
     ground colours.
  2. A deformation pass that pushes terrain vertices within
     ``half_width + blend_radius`` of the road toward the road's local
     altitude profile, with a smoothstep falloff so the outer band
     eases off rather than producing a hard step.

Caveat: this works on the *source* terrain mesh, not on a procedural
modifier output. If the terrain has an active Geometry Nodes modifier
(the ``HV_Island`` graph on the template), the modifier will
overwrite the deformation on next evaluation. Apply the modifier
first (Object → Apply → Visual Geometry to Mesh) before building a
road on a procedural island — or check *Apply modifiers first* on the
Build Road redo panel and the operator will do it for you.
"""

from __future__ import annotations

import math

import bpy
import mathutils
from bpy.props import BoolProperty, FloatProperty, IntProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

ROAD_CURVE_NAME = "road_curve_main"
ROAD_OBJECT_NAME = "road_main"
ROAD_MESH_NAME = "road_main_mesh"
ROAD_MATERIAL_NAME = "mat_track_road"
ROAD_UNDERSIDE_MATERIAL_NAME = "mat_track_road_underside"


# ────────────────────────────────────────────────────────────────────
# Material helpers
# ────────────────────────────────────────────────────────────────────


def _ensure_road_material() -> bpy.types.Material:
    """Asphalt road surface. Layered: a value-noise texture darkens the
    base colour slightly so the road doesn't read as a single flat
    tint, and a low-frequency Voronoi pattern adds tire-groove streaks
    when viewed up close. Aesthetic baseline only — hand-tune the
    shader graph in Blender after first generation for production polish."""
    mat = bpy.data.materials.get(ROAD_MATERIAL_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(ROAD_MATERIAL_NAME)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    output = nt.nodes.get("Material Output")
    if bsdf is None or output is None:
        return mat

    bsdf.inputs["Base Color"].default_value = (0.11, 0.11, 0.12, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.85
    spec = bsdf.inputs.get("Specular IOR Level") or bsdf.inputs.get("Specular")
    if spec is not None:
        spec.default_value = 0.2

    # Grain: a stretchy Noise → BrightContrast → ColorRamp chain darkens
    # the asphalt non-uniformly. UV-less so the noise samples in world
    # space and tiles naturally as the road bends.
    tex_coord = nt.nodes.new(type="ShaderNodeTexCoord")
    tex_coord.location = (-900, 0)
    noise = nt.nodes.new(type="ShaderNodeTexNoise")
    noise.location = (-700, 0)
    noise.inputs["Scale"].default_value = 8.0
    noise.inputs["Detail"].default_value = 4.0
    noise.inputs["Roughness"].default_value = 0.65
    ramp = nt.nodes.new(type="ShaderNodeValToRGB")
    ramp.location = (-450, 0)
    # Two-stop ramp: most asphalt mid-grey, dark patches a notch darker.
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (0.08, 0.08, 0.09, 1.0)
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (0.13, 0.13, 0.14, 1.0)
    nt.links.new(tex_coord.outputs["Object"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def _ensure_road_underside_material() -> bpy.types.Material:
    """Bridge / underside material — flat concrete grey, lighter than the
    asphalt so the underside reads as structure rather than disappearing
    into ground shadow on cross-valley shots."""
    mat = bpy.data.materials.get(ROAD_UNDERSIDE_MATERIAL_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(ROAD_UNDERSIDE_MATERIAL_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.30, 0.29, 0.27, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.7
    return mat


def _ensure_curb_material(*, red: bool) -> bpy.types.Material:
    """F1-style curb material — saturated red or white, mat-prefixed so
    it groups with the other track materials. Two-tone alternation
    happens at the mesh level via `material_index` on each curb quad."""
    name = "mat_track_curb_red" if red else "mat_track_curb_white"
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        if red:
            bsdf.inputs["Base Color"].default_value = (0.85, 0.08, 0.10, 1.0)
        else:
            bsdf.inputs["Base Color"].default_value = (0.92, 0.92, 0.92, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.6
    return mat


# ────────────────────────────────────────────────────────────────────
# Curve helpers
# ────────────────────────────────────────────────────────────────────


def _add_road_starter_curve(scene) -> bpy.types.Object:
    """Create a 4-point Bezier curve named ``road_curve_main`` straddling
    the centre of the scene. The user edits it (Tab into edit mode, move
    handles) before clicking Build Road."""
    existing = bpy.data.objects.get(ROAD_CURVE_NAME)
    if existing is not None:
        return existing
    curve_data = bpy.data.curves.new(ROAD_CURVE_NAME, type="CURVE")
    curve_data.dimensions = "3D"
    spline = curve_data.splines.new(type="BEZIER")
    # 4 control points spanning ~80m along Y with a gentle S-curve.
    spline.bezier_points.add(3)  # we start with 1 implicit point
    coords = [(-40, -40, 0), (-15, -10, 0), (15, 10, 0), (40, 40, 0)]
    for bp, (x, y, z) in zip(spline.bezier_points, coords):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    spline.use_cyclic_u = False
    curve_data.resolution_u = 24
    obj = bpy.data.objects.new(ROAD_CURVE_NAME, curve_data)
    obj["kind"] = "road_curve"
    scene.collection.objects.link(obj)
    return obj


def _resolve_road_curve() -> bpy.types.Object | None:
    """Pick the curve the road tool should follow. Prefers the dedicated
    `road_curve_main` if it exists, falls back to `ai_spline_main` so
    authors who don't want two curves with the same shape can just
    author the racing line and have the road follow it. Returns None
    if neither is present."""
    for name in (ROAD_CURVE_NAME, "ai_spline_main"):
        obj = bpy.data.objects.get(name)
        if obj is not None and obj.type == "CURVE":
            return obj
    return None


def _curve_control_radii(curve_obj: bpy.types.Object) -> tuple[list[float], bool]:
    """Return (radii, cyclic) for the curve's first spline. NURBS
    `point.radius` and Bezier `bezier_point.radius` both live in [0, ∞);
    Blender defaults to 1.0. Authors can set per-point radius in edit
    mode (N-panel → Curve → Radius). The road tool reads these as a
    width multiplier so apexes can be wider than straights."""
    if not curve_obj.data.splines:
        return [], False
    spline = curve_obj.data.splines[0]
    if spline.type == "BEZIER":
        radii = [float(bp.radius) for bp in spline.bezier_points]
    else:
        radii = [float(pt.radius) for pt in spline.points]
    return radii, bool(spline.use_cyclic_u)


def _curve_control_tilts(curve_obj: bpy.types.Object) -> list[float]:
    """Return per-control-point tilt (radians) for the curve's first
    spline. Blender exposes `tilt` on both NURBS / Bezier points; the
    road tool reads it as an *additive* bank angle on top of the auto
    bank from curvature, so an author can hand-tune corners without
    fighting the curvature-driven default. Empty list when the spline
    has no points."""
    if not curve_obj.data.splines:
        return []
    spline = curve_obj.data.splines[0]
    if spline.type == "BEZIER":
        return [float(bp.tilt) for bp in spline.bezier_points]
    return [float(pt.tilt) for pt in spline.points]


def _terrain_water_floor(scene) -> float | None:
    """Lowest Z the road's terrain-cast result is allowed to land on.
    Reads ``water_volume_main``'s Z (the still-water level) plus its
    ``wave_height`` custom prop (the runtime Gerstner amplitude), with
    a small clearance multiplier so the road sits above the highest
    wave crest rather than at exactly the trough-to-peak average.

    Returns ``None`` if there is no water volume in the scene — older
    inland tracks (Cliffside, alpine-sprint) shouldn't pick up a floor
    they don't need."""
    water = scene.objects.get("water_volume_main") if hasattr(scene, "objects") else bpy.data.objects.get("water_volume_main")
    if water is None:
        return None
    base = float(water.matrix_world.translation.z)
    wave_h = float(water.get("wave_height", 0.0))
    # 1.3× the authored wave height gives a comfortable margin over the
    # tallest realistic crest without lifting straight stretches of road
    # so far above water that the bridge looks stilted. Tunable; revisit
    # if a future ramped-up wave preset clips the road.
    clearance = max(0.4, wave_h * 1.3)
    return base + clearance


def _curve_control_conform(curve_obj: bpy.types.Object) -> list[float]:
    """Return per-control-point conform weight in [0, 1] for the curve's
    first spline. Stored *inverted* in Blender's ``weight_softbody``
    field — chosen because (a) it's already exposed on every Bezier /
    NURBS point and survives copy / paste, (b) it's not used for
    anything else by the addon, (c) Blender's factory default for
    ``weight_softbody`` on a fresh BezierSplinePoint is 0, so storing
    the *float weight* there (not the conform weight) means existing
    curves authored before this feature shipped automatically read as
    fully conforming — no migration pass needed.

    Mapping: ``conform = 1.0 - weight_softbody``.

      * ``weight_softbody == 0`` (Blender's default) → ``conform = 1``
        → the road conforms to the terrain at this point: Z comes from
        a downward raycast and the terrain is lifted to meet it.
      * ``weight_softbody == 1`` → ``conform = 0`` → the point is
        floating: road Z = authored bezier height, terrain untouched.
      * In-between values blend smoothly so a bridge can lift off the
        shore, span open water, and land cleanly on the far side.

    Empty list when the spline has no points."""
    if not curve_obj.data.splines:
        return []
    spline = curve_obj.data.splines[0]
    if spline.type == "BEZIER":
        pts = spline.bezier_points
    else:
        pts = spline.points
    return [1.0 - float(min(1.0, max(0.0, pt.weight_softbody))) for pt in pts]


def _radius_at_t(radii: list[float], t: float, cyclic: bool) -> float:
    """Linearly interpolate a control-point radius array at parameter
    t in [0, 1]. Cyclic splines wrap around; open splines clamp at
    both ends."""
    n = len(radii)
    if n == 0:
        return 1.0
    if n == 1:
        return radii[0]
    if cyclic:
        f = (t * n) % n
        i0 = int(f) % n
        i1 = (i0 + 1) % n
    else:
        f = t * (n - 1)
        i0 = min(int(f), n - 1)
        i1 = min(i0 + 1, n - 1)
    frac = f - int(f)
    return radii[i0] * (1.0 - frac) + radii[i1] * frac


def _conform_at_t(weights: list[float], t: float, cyclic: bool) -> float:
    """Linearly interpolate a control-point conform-weight array at
    parameter t in [0, 1]. Same wrap rules as ``_radius_at_t`` so the
    conform / radius / tilt fields on a control point all land at the
    same sample. Returns 1.0 (full conform — backwards compatible with
    pre-existing curves) when no weights are set."""
    n = len(weights)
    if n == 0:
        return 1.0
    if n == 1:
        return weights[0]
    if cyclic:
        f = (t * n) % n
        i0 = int(f) % n
        i1 = (i0 + 1) % n
    else:
        f = t * (n - 1)
        i0 = min(int(f), n - 1)
        i1 = min(i0 + 1, n - 1)
    frac = f - int(f)
    return weights[i0] * (1.0 - frac) + weights[i1] * frac


def _tilt_at_t(tilts: list[float], t: float, cyclic: bool) -> float:
    """Linearly interpolate a control-point tilt array (radians) at
    parameter t in [0, 1]. Same wrap rules as `_radius_at_t` so a
    radius / tilt pair on the same control point land at the same
    sample. Returns 0.0 when no tilts are set (preserving backwards
    compat with curves that predate this knob)."""
    n = len(tilts)
    if n == 0:
        return 0.0
    if n == 1:
        return tilts[0]
    if cyclic:
        f = (t * n) % n
        i0 = int(f) % n
        i1 = (i0 + 1) % n
    else:
        f = t * (n - 1)
        i0 = min(int(f), n - 1)
        i1 = min(i0 + 1, n - 1)
    frac = f - int(f)
    return tilts[i0] * (1.0 - frac) + tilts[i1] * frac


def _compute_per_sample_bank(
    samples: list[dict],
    *,
    bank_strength: float,
    bank_max_rad: float,
    cyclic: bool = False,
    smoothing_passes: int = 6,
) -> None:
    """Stamp `bank` (signed radians around the road tangent) onto each
    sample. Positive bank tilts the cross-section so the *inside* of the
    corner is lower than the outside — racing-game banking convention,
    matches what JetMoto / WipEout players expect.

    Per-sample curvature is the signed angle between the tangent at i-1
    and the tangent at i+1, divided by the local arc length. Multiply by
    `bank_strength`, clamp to `bank_max_rad`, then smooth so the bank
    transitions in/out of corners are gentle (a hard step would pinch
    the road mesh).

    Per-control-point `tilt` is added on top so authors who want to
    hand-tune a specific corner can edit the bezier point's tilt and
    have it stack with the curvature-driven default.

    `cyclic` controls how the endpoint samples are handled. Open curves
    (default) duplicate the endpoint tangent so the first/last samples
    don't pick up a bogus curvature from wrapping around. Closed loops
    wrap so the join doesn't get a fake straight bit."""
    n = len(samples)
    if n < 3 or bank_strength <= 0:
        for s in samples:
            s["bank"] = float(s.get("tilt", 0.0))
        return

    def neighbour_indices(i: int) -> tuple[int, int]:
        if cyclic:
            return (i - 1) % n, (i + 1) % n
        # Open: clamp to endpoints. The endpoint sample's curvature
        # then collapses to 0 (consecutive segments are identical),
        # so banks ease to neutral at the road ends.
        return max(0, i - 1), min(n - 1, i + 1)

    raw_bank: list[float] = [0.0] * n
    for i in range(n):
        i_prev, i_next = neighbour_indices(i)
        ax = samples[i]["x"] - samples[i_prev]["x"]
        ay = samples[i]["y"] - samples[i_prev]["y"]
        bx = samples[i_next]["x"] - samples[i]["x"]
        by = samples[i_next]["y"] - samples[i]["y"]
        la = math.hypot(ax, ay) or 1e-6
        lb = math.hypot(bx, by) or 1e-6
        cross = ax * by - ay * bx
        dot = ax * bx + ay * by
        angle = math.atan2(cross, dot)
        seg = 0.5 * (la + lb)
        kappa = angle / seg if seg > 0 else 0.0
        # bank_strength has units of seconds² (effectively v² × time-of-bank);
        # using a sane physical scale for "speed" — bikes settle around
        # 50 m/s on straights — gives kappa * v² ≈ comfortable bank rad.
        ref_v_sq = 50.0 * 50.0
        bank = kappa * ref_v_sq * bank_strength * 0.001
        # Clamp signed.
        if bank > bank_max_rad:
            bank = bank_max_rad
        elif bank < -bank_max_rad:
            bank = -bank_max_rad
        raw_bank[i] = bank

    # Smooth with a 1-2-1 binomial pass — bank should ease into corners,
    # not snap. Open-ended profiles use clamped boundaries; closed loops
    # wrap. Authors typically work with open road_curve_main, but the AI
    # spline (which can drive the road in single-curve mode) is usually
    # cyclic.
    smoothed = list(raw_bank)
    for _ in range(max(0, int(smoothing_passes))):
        new = [0.0] * n
        for i in range(n):
            if cyclic:
                l = smoothed[(i - 1) % n]
                r = smoothed[(i + 1) % n]
            else:
                l = smoothed[i - 1] if i > 0 else smoothed[i]
                r = smoothed[i + 1] if i < n - 1 else smoothed[i]
            new[i] = (l + 2.0 * smoothed[i] + r) * 0.25
        smoothed = new

    for i, s in enumerate(samples):
        author_tilt = float(s.get("tilt", 0.0))
        s["bank"] = smoothed[i] + author_tilt


def _sample_road_path(
    curve_obj: bpy.types.Object,
    terrain_obj: bpy.types.Object,
    *,
    n_samples: int,
    smooth_passes: int,
) -> list[dict]:
    """Sample `curve_obj` at `n_samples` arc-length steps, raycast each
    sample down onto the scene's terrain, smooth the resulting Z
    profile, and return a list of {x, y, z, tx, ty} dicts. The Z values
    are world-space terrain heights with `smooth_passes` of 1-2-1
    binomial smoothing applied so the road doesn't follow every bump.

    Preview collections are hidden during the raycast so gizmos can't
    catch the ray. The terrain object is preferred but any other
    `kind=track` mesh under the curve will also produce hits."""
    from ._legacy import _PreviewCollectionsHidden, _sample_curve_to_polyline

    raw = _sample_curve_to_polyline(curve_obj)
    if len(raw) < 2:
        return []
    # Cumulative arc length in the horizontal plane.
    cum = [0.0]
    for i in range(len(raw) - 1):
        a, b = raw[i], raw[i + 1]
        cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    total = cum[-1]
    if total <= 0:
        return []

    radii, cyclic = _curve_control_radii(curve_obj)
    tilts = _curve_control_tilts(curve_obj)
    conforms = _curve_control_conform(curve_obj)
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
        # Authored Z, linearly interpolated from the polyline. Used as
        # the road's altitude wherever the conform weight is < 1 — a
        # floating bridge takes its Z from the bezier point's authored
        # height instead of a raycast.
        authored_z = a[2] + (b[2] - a[2]) * frac
        dx = b[0] - a[0]
        dy = b[1] - a[1]
        tl = math.hypot(dx, dy) or 1.0
        t_norm = i / denom
        r = _radius_at_t(radii, t_norm, cyclic)
        tilt = _tilt_at_t(tilts, t_norm, cyclic)
        conform = _conform_at_t(conforms, t_norm, cyclic)
        samples.append({
            "x": x, "y": y, "z": authored_z, "_authored_z": authored_z,
            "tx": dx / tl, "ty": dy / tl,
            "r": r, "t": t_norm, "tilt": tilt, "conform": conform,
        })

    # Raycast each sample's (x, y) downward onto the *terrain mesh
    # specifically* (not the scene). Casting against the scene hit any
    # visible kind=track mesh — downtown buildings, ramps, tunnel
    # interiors — so a road curve passing near a city block could find
    # its altitude was a building roof 80 m up. Casting against the
    # terrain object directly skips everything else and gives the
    # author "the ground" no matter what's standing on it.
    #
    # The water surface provides an altitude floor. When the cast
    # misses the terrain (off the edge, or through a tunnel hole) OR
    # hits below the water surface (a sample over Puget Sound / Lake
    # Washington / etc. where the seabed is at -8 m), we fall back to
    # ``water_base + wave_peak`` so the road sits above the highest
    # wave crest rather than diving into the seabed.
    #
    # The sample's final Z is a blend of authored (bezier point) Z and
    # the terrain-or-water-floor Z, weighted by the per-sample conform
    # weight. Fully-floating samples (weight = 0) skip the cast and
    # the floor entirely — the authored Z is final.
    water_floor = _terrain_water_floor(bpy.context.scene)
    down = mathutils.Vector((0.0, 0.0, -1.0))
    ray_origin_z = 10000.0
    misses = 0
    floored = 0
    with _PreviewCollectionsHidden(bpy.context.view_layer):
        bpy.context.view_layer.update()
        if terrain_obj is not None:
            terrain_mw_inv = terrain_obj.matrix_world.inverted_safe()
            terrain_mw = terrain_obj.matrix_world
        for s in samples:
            conform = float(s["conform"])
            if conform <= 0.001:
                # Fully floating — authored Z wins, skip the cast.
                continue
            terrain_z: float | None = None
            if terrain_obj is not None:
                origin_local = terrain_mw_inv @ mathutils.Vector(
                    (s["x"], s["y"], ray_origin_z)
                )
                direction_local = terrain_mw_inv.to_3x3() @ down
                result, location_local, _normal, _index = terrain_obj.ray_cast(
                    origin_local, direction_local, distance=ray_origin_z * 2.0
                )
                if result:
                    terrain_z = float((terrain_mw @ location_local).z)
            if terrain_z is None:
                # Cast missed the terrain — must be over water (or off-map).
                if water_floor is not None:
                    terrain_z = water_floor
                    floored += 1
                else:
                    misses += 1
                    continue
            elif water_floor is not None and terrain_z < water_floor:
                # Terrain dips below the water floor here (seabed under
                # Puget Sound, Lake Washington trough, locks canal); the
                # road rides on the water, not the seabed.
                terrain_z = water_floor
                floored += 1
            s["z"] = s["_authored_z"] * (1.0 - conform) + terrain_z * conform

    # Smooth the height profile (1-2-1 binomial, in place).
    for _ in range(max(0, int(smooth_passes))):
        new_z = []
        n = len(samples)
        for i in range(n):
            zp = samples[max(0, i - 1)]["z"]
            zn = samples[min(n - 1, i + 1)]["z"]
            new_z.append((zp + samples[i]["z"] * 2 + zn) / 4.0)
        for i, z in enumerate(new_z):
            samples[i]["z"] = z

    return samples


def _build_road_strip_mesh(
    samples: list[dict],
    *,
    width: float,
    lift: float,
    thickness: float = 0.0,
    curb_width: float = 0.0,
    curb_height: float = 0.0,
    curb_stripe_length: float = 2.0,
) -> bpy.types.Mesh:
    """Build a road-slab mesh from the (x, y, z, tx, ty) samples.

    Top-face column layout (left to right):

        curb_L_outer ─ curb_L_inner = road_L ──── road_R = curb_R_inner ─ curb_R_outer
                       (when curb_width > 0)               (when curb_width > 0)

    The curb verts are elevated by `curb_height` above the road surface;
    each curb stripe (one quad along the road's tangent) gets a
    `material_index` of 1 (white) or 2 (red) on an alternating
    `curb_stripe_length`-metre cadence, producing F1-style serrated
    rumble strips.

    When `thickness > 0` the strip is extruded downward into a slab —
    two extra outer-edge verts per sample at `z_road - thickness`, plus
    side / bottom / end-cap faces. The thicker silhouette reads as a
    real banked road (vs. a paper ribbon) and pushes the road's
    underside well below the conformed terrain so Z-fighting along the
    flattened band is gone.
    """
    if ROAD_MESH_NAME in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[ROAD_MESH_NAME])
    me = bpy.data.meshes.new(ROAD_MESH_NAME)
    half_w = width / 2.0
    has_curbs = curb_width > 0 and curb_height >= 0
    has_thickness = thickness > 0
    outer_half = half_w + (curb_width if has_curbs else 0.0)

    # Per-sample TOP cols: 2 (no curb) or 4 (with curb).
    top_cols = 4 if has_curbs else 2
    # Per-sample BOTTOM cols when thickness > 0: 2 at the outer edges.
    bot_cols = 2 if has_thickness else 0
    cols_per_sample = top_cols + bot_cols

    verts: list[tuple[float, float, float]] = []
    for s in samples:
        nx = -s["ty"]
        ny = s["tx"]
        z_road = s["z"] + lift
        # Per-sample radius from the curve's control-point `radius`
        # field (linearly interpolated, default 1.0). Scales width and
        # curb-band horizontally so apexes can be wider than straights.
        r = float(s.get("r", 1.0))
        hw = half_w * r
        outer_h = outer_half * r
        # Bank: rotate the cross-section around the tangent axis so the
        # outside edge of a corner lifts and the inside drops. `bank`
        # is signed radians; positive bank corresponds to a positive
        # signed-curvature corner (CCW / left turn in Blender XY where
        # the cross product of consecutive segments is positive).
        #
        # Geometry: for tangent (tx, ty), the cross-section perp
        # `(nx, ny) = (-ty, tx)` points toward the LEFT side of the
        # road (the *inside* of a left turn). Racing-line banking
        # convention: tilt so the inside is LOWER than the outside.
        # Therefore positive bank should LOWER the +nx side and LIFT
        # the -nx side — opposite the naive "lat * bank" lift.
        #
        # We use the linear-tangent approximation (sin ≈ bank) since
        # at the configured 25° max the error is < 3% and it's one
        # less trig per vertex.
        bank = float(s.get("bank", 0.0))

        def _lift_for(lat: float) -> float:
            # `lat` positive = +nx side (left / inside of left turn);
            # negative = -nx side (right / outside of left turn).
            # Negating ensures positive bank tilts the road INTO the
            # corner as authors expect.
            return -lat * bank

        if has_curbs:
            z_curb = z_road + curb_height
            verts.append((
                s["x"] - nx * outer_h,
                s["y"] - ny * outer_h,
                z_curb + _lift_for(-outer_h),
            ))
            verts.append((
                s["x"] - nx * hw,
                s["y"] - ny * hw,
                z_road + _lift_for(-hw),
            ))
            verts.append((
                s["x"] + nx * hw,
                s["y"] + ny * hw,
                z_road + _lift_for(hw),
            ))
            verts.append((
                s["x"] + nx * outer_h,
                s["y"] + ny * outer_h,
                z_curb + _lift_for(outer_h),
            ))
        else:
            verts.append((
                s["x"] - nx * outer_h,
                s["y"] - ny * outer_h,
                z_road + _lift_for(-outer_h),
            ))
            verts.append((
                s["x"] + nx * outer_h,
                s["y"] + ny * outer_h,
                z_road + _lift_for(outer_h),
            ))
        if has_thickness:
            z_bot = z_road - thickness
            verts.append((
                s["x"] - nx * outer_h,
                s["y"] - ny * outer_h,
                z_bot + _lift_for(-outer_h),
            ))
            verts.append((
                s["x"] + nx * outer_h,
                s["y"] + ny * outer_h,
                z_bot + _lift_for(outer_h),
            ))

    faces: list[tuple[int, int, int, int]] = []
    face_mats: list[int] = []

    # Indices within a sample's column block. The bottom row sits after
    # whatever top cols are present, so its slot indices are fixed
    # relative to `top_cols`.
    L_OUT_TOP = 0
    R_OUT_TOP = top_cols - 1  # last top col is always the right outer edge
    L_BOT = top_cols          # first bottom col
    R_BOT = top_cols + 1

    arc = 0.0
    for i in range(len(samples) - 1):
        a = i * cols_per_sample
        b = (i + 1) * cols_per_sample
        seg_len = math.hypot(
            samples[i + 1]["x"] - samples[i]["x"],
            samples[i + 1]["y"] - samples[i]["y"],
        )
        stripe_idx = int(arc // max(curb_stripe_length, 0.01)) if has_curbs else 0
        curb_mat = 1 + (stripe_idx % 2)
        if has_curbs:
            faces.append((a + 0, b + 0, b + 1, a + 1)); face_mats.append(curb_mat)
            faces.append((a + 1, b + 1, b + 2, a + 2)); face_mats.append(0)
            faces.append((a + 2, b + 2, b + 3, a + 3)); face_mats.append(curb_mat)
        else:
            faces.append((a + 0, b + 0, b + 1, a + 1)); face_mats.append(0)
        if has_thickness:
            # Slab sides and bottom use the underside material (slot 3
            # when curbs are present, slot 1 when they aren't). The
            # underside reads as concrete bridge structure on
            # cross-valley shots instead of disappearing into asphalt.
            underside_slot = 3 if has_curbs else 1
            # Left side: outer-top → bottom-left, span sample i→i+1.
            faces.append((a + L_OUT_TOP, a + L_BOT, b + L_BOT, b + L_OUT_TOP))
            face_mats.append(underside_slot)
            # Right side: bottom-right → outer-top.
            faces.append((a + R_OUT_TOP, b + R_OUT_TOP, b + R_BOT, a + R_BOT))
            face_mats.append(underside_slot)
            # Bottom face — normal faces -Z (CCW seen from below).
            faces.append((a + L_BOT, a + R_BOT, b + R_BOT, b + L_BOT))
            face_mats.append(underside_slot)
        arc += seg_len

    # End caps so the slab reads as solid from the front/back. Skipped
    # when thickness == 0 (the ribbon doesn't need them).
    if has_thickness and len(samples) >= 2:
        first = 0
        last = (len(samples) - 1) * cols_per_sample
        underside_slot = 3 if has_curbs else 1
        # Front cap at sample 0: outer-L-top → outer-R-top → bottom-R → bottom-L.
        # Winding so the normal points OPPOSITE the road tangent.
        faces.append((first + L_OUT_TOP, first + L_BOT, first + R_BOT, first + R_OUT_TOP))
        face_mats.append(underside_slot)
        # Back cap at last sample: reversed winding.
        faces.append((last + L_OUT_TOP, last + R_OUT_TOP, last + R_BOT, last + L_BOT))
        face_mats.append(underside_slot)

    me.from_pydata(verts, [], faces)
    me.update()
    for i, poly in enumerate(me.polygons):
        poly.use_smooth = False
        poly.material_index = face_mats[i]
    return me


def _conform_terrain_to_road(
    terrain_obj: bpy.types.Object,
    samples: list[dict],
    *,
    width: float,
    blend_radius: float,
    lift: float,
    curb_width: float = 0.0,
    clearance: float = 0.20,
    fill_shelf_width: float = 3.0,
) -> dict:
    """Push each terrain vertex within `(width/2 + curb_width + blend_radius)`
    of the road centerline toward the road's local Z. Inside the road
    footprint (`d ≤ width/2`) the vertex snaps to the road's reference
    altitude (`sample_z`), so the road strip mesh sits `lift` metres
    above. Inside the curb band (`d ≤ width/2 + curb_width`) the same
    snap applies — the curbs themselves rise `curb_height` above the
    road, so terrain can't pop through them. The outer band smoothsteps
    back to natural terrain.

    A `clearance` cap (default 0.20 m) clamps the result so a steep
    hillside can never poke up *through* the drivable surface — the
    earlier "terrain jumped" symptom on the template island was a
    coarse-grid vertex inside the blend band ending up above the road
    surface and slicing through the strip mesh. The cap follows the
    same smoothstep so the visual transition stays seamless.

    **Always-push-down rule for overlapping roads**: when multiple
    road samples have a terrain vertex inside their footprint (the
    ``inner`` band = half-width + curb-width), we pick the
    *lowest-Z* one as the conform target. That guarantees terrain
    always sits *below* every overlapping road's drivable surface —
    no terrain poking through curb edges where the curve doubles
    back, no terrain piling up where the road's smoothed Z dips
    momentarily. Trade-off: in doubled-back sections the upper road
    visibly bridges over the lower road (its slab underside is
    exposed); in road-dip sections the curb-edge terrain follows
    the dip exactly, producing a slight trench along the curb. The
    "Float" per-control-point flag is the recommended cleanup for
    overpass authoring — marking the upper segment's control points
    Float makes that segment a true bridge with terrain unchanged
    beneath.

    **Banking-aware target**: each sample carries a per-segment
    ``bank`` (signed radians around the tangent, populated by
    ``_compute_per_sample_bank`` at build time and recovered from
    the road mesh's tilted cross-section at re-conform time). For a
    terrain vert at signed lateral offset ``L`` from the segment
    centerline, the conform target is
    ``seg_centerline_z - L * seg_bank`` — terrain follows the
    road's banked cross-section instead of pulling everything to
    the centerline altitude. Without this, banked corners showed
    the high-side curb hovering over a void and the low-side curb
    getting terrain poking through it. ``L`` is clipped to
    ``±inner`` so the bank effect stops at the road's footprint
    edge and doesn't extrapolate into the blend band.

    **Fill shelf on the downhill side** (``fill_shelf_width`` > 0): for
    terrain vertices whose natural Z is below the road, the "fully
    flattened" zone extends past the curbs by an extra ``fill_shelf_width``
    metres before the smoothstep blend kicks in. On a hillside this
    produces an asymmetric road embankment — wider fill on the downhill
    side that keeps the road's slab underside hidden, normal cut width
    on the uphill side. Without this, on steep traverses the smoothstep
    blend lets terrain fall away within the conform band, leaving the
    slab visibly hanging over a void on the downhill flank. Set to 0 to
    restore the legacy symmetric behaviour.

    Returns a summary ``{flattened, blended, floating}`` count for the
    report — useful for the operator to surface how much terrain was
    actually moved."""
    from mathutils.kdtree import KDTree

    if not samples:
        return {"flattened": 0, "blended": 0, "floating": 0}

    half_w = width / 2.0
    # The "fully flattened" zone now spans the road *plus* the curbs so
    # the curb stripes themselves don't fight the terrain.
    inner = half_w + max(0.0, curb_width)
    outer = inner + max(0.0, blend_radius)
    # Cap ceiling: clamped to the *road* surface (= sample_z + lift),
    # NOT the curb top. Curbs rise above the road and we want terrain
    # to sit below the lowest drivable point so nothing pokes through
    # the road quad. Curbs themselves are a separate elevated mesh and
    # their bases meet flush with the terrain at the road edge.
    surface_lift = lift

    # Downhill fill shelf: wider flat zone on the side where the road's
    # slab would otherwise hang over a void. The blend band keeps the
    # same width — it shifts outward — so the smoothstep visual edge
    # transitions at a comparable rate, just further from the curb.
    fill_shelf = max(0.0, fill_shelf_width)
    fill_inner = inner + fill_shelf
    fill_outer = fill_inner + max(0.0, blend_radius)
    # KDTree search radius must cover the widest possible "in band"
    # distance — that's the fill shelf's outer edge.
    search_radius = max(outer, fill_outer)

    kd = KDTree(len(samples))
    for i, s in enumerate(samples):
        kd.insert((s["x"], s["y"], 0.0), i)
    kd.balance()

    me = terrain_obj.data
    mw = terrain_obj.matrix_world
    mw_inv = mw.inverted_safe()

    # Z-bias for the candidate score. Higher = pickier about matching
    # the terrain's altitude (better separates layered roads), but at
    # ~1.0 you start to break the "carve through hill" case where the
    # terrain is much higher than the road. 0.5 is the sweet spot in
    # practice — XY proximity still dominates for single-segment
    # roads, but a 6 m vertical gap is enough to swing the choice for
    # doubled-back roads at the same XY.
    z_bias = 0.5

    n_samples = len(samples)
    # Decide whether the sample sequence wraps around (cyclic curve).
    # The road sampler emits points in arc order; if the endpoints sit
    # within ~1.5 segment-widths of each other in XY, treat it as
    # cyclic so the segment between the last and first samples is
    # available for terrain projection.
    cyclic_close = False
    if n_samples >= 3:
        first = samples[0]
        last = samples[-1]
        avg_seg = (
            math.hypot(samples[1]["x"] - first["x"], samples[1]["y"] - first["y"])
            + math.hypot(last["x"] - samples[-2]["x"], last["y"] - samples[-2]["y"])
        ) * 0.5
        endpoint_gap = math.hypot(last["x"] - first["x"], last["y"] - first["y"])
        cyclic_close = endpoint_gap < avg_seg * 1.5

    def _next_idx(i: int) -> int:
        """Index of the next sample along the curve, or -1 if no
        segment starts at this sample (open curve, last point)."""
        if i < n_samples - 1:
            return i + 1
        return 0 if cyclic_close else -1

    flattened = 0
    blended = 0
    floating = 0
    for v in me.vertices:
        world = mw @ v.co
        candidates = kd.find_range((world.x, world.y, 0.0), search_radius)
        if not candidates:
            continue

        # Build candidate SEGMENTS — each nearby sample contributes the
        # segment to its next neighbour AND (if it's not the start of
        # the curve) the segment from its previous neighbour. This
        # eliminates the stairstepping artefact of point-based conform:
        # adjacent terrain verts can land on different samples and
        # snap to different Z values, producing visible mesh steps.
        # Segment-based conform interpolates Z along the segment so
        # terrain follows the road's slope continuously.
        candidate_segs: set[int] = set()
        for _co, sidx, _xy_d in candidates:
            if _next_idx(sidx) >= 0:
                candidate_segs.add(sidx)
            prev_idx = sidx - 1 if sidx > 0 else (n_samples - 1 if cyclic_close else -1)
            if prev_idx >= 0 and _next_idx(prev_idx) >= 0:
                candidate_segs.add(prev_idx)

        # Per-segment: perpendicular projection onto segment line +
        # interpolated Z + interpolated conform weight at the closest
        # point. Always-push-down rule still applies — when multiple
        # segments cover this XY inside their inner band, the
        # lowest-Z one wins.
        best_in_inner_z = float("inf")
        best_in_inner = None
        best_blend_score = float("inf")
        best_blend = None
        for seg_start in candidate_segs:
            seg_end = _next_idx(seg_start)
            if seg_end < 0:
                continue
            sa = samples[seg_start]
            sb = samples[seg_end]
            dx = sb["x"] - sa["x"]
            dy = sb["y"] - sa["y"]
            seg_len_sq = dx * dx + dy * dy
            if seg_len_sq < 1e-9:
                continue
            t_seg = (
                (world.x - sa["x"]) * dx + (world.y - sa["y"]) * dy
            ) / seg_len_sq
            t_seg = max(0.0, min(1.0, t_seg))
            cx = sa["x"] + t_seg * dx
            cy = sa["y"] + t_seg * dy
            perp_d = math.hypot(world.x - cx, world.y - cy)
            seg_z_centerline = sa["z"] + t_seg * (sb["z"] - sa["z"])
            sa_c = float(sa.get("conform", 1.0))
            sb_c = float(sb.get("conform", 1.0))
            seg_conform = sa_c + t_seg * (sb_c - sa_c)

            # Banked target: tilt the conform target around the road
            # tangent so terrain follows the road's banked cross-
            # section. Without this, terrain pulls to centerline Z
            # and the road's high-side curb hovers over a void while
            # the low-side curb gets terrain poking up through it.
            #
            # Signed lateral offset of the terrain vert from the
            # segment centerline. nx,ny is the LEFT perpendicular —
            # same convention as ``_build_road_strip_mesh`` so the
            # bank sign matches what the road mesh used. Bank is
            # interpolated per-segment so the tilt transitions
            # smoothly between samples.
            seg_len = math.sqrt(seg_len_sq)
            nx = -dy / seg_len
            ny = dx / seg_len
            lat_signed = (world.x - cx) * nx + (world.y - cy) * ny
            sa_b = float(sa.get("bank", 0.0))
            sb_b = float(sb.get("bank", 0.0))
            seg_bank = sa_b + t_seg * (sb_b - sa_b)
            # Clip lateral to the inner band so banking only applies
            # inside the road's actual footprint — past inner the
            # smoothstep blend toward natural terrain handles the
            # transition, and we don't want a 12 m blend band
            # extrapolating bank to wildly tilt the surrounding
            # terrain.
            lat_clipped = max(-inner, min(inner, lat_signed))
            bank_lift = -lat_clipped * seg_bank
            seg_z = seg_z_centerline + bank_lift

            # Effective inner/outer for THIS segment: downhill side
            # uses the wider fill shelf so terrain pulls up beyond
            # the narrow cut band, hiding the road's slab underside.
            if world.z < seg_z and fill_shelf > 0.0:
                ef_inner_s = fill_inner
                ef_outer_s = fill_outer
            else:
                ef_inner_s = inner
                ef_outer_s = outer

            if perp_d >= ef_outer_s:
                continue

            info = {
                "d": perp_d, "z": seg_z, "conform": seg_conform,
                "ef_inner": ef_inner_s, "ef_outer": ef_outer_s,
            }
            if perp_d <= ef_inner_s:
                if seg_z < best_in_inner_z - 0.1 or (
                    abs(seg_z - best_in_inner_z) < 0.1
                    and (best_in_inner is None or perp_d < best_in_inner["d"])
                ):
                    best_in_inner_z = seg_z
                    best_in_inner = info
            else:
                score = perp_d + z_bias * abs(world.z - seg_z)
                if score < best_blend_score:
                    best_blend_score = score
                    best_blend = info

        chosen = best_in_inner if best_in_inner is not None else best_blend
        if chosen is None:
            continue

        d = chosen["d"]
        target_z = chosen["z"]
        conform_w = chosen["conform"]
        ef_inner = chosen["ef_inner"]
        ef_outer = chosen["ef_outer"]

        if d <= ef_inner:
            base_blend = 1.0
        else:
            t_band = (ef_outer - d) / (ef_outer - ef_inner)
            base_blend = t_band * t_band * (3.0 - 2.0 * t_band)  # smoothstep
        blend = base_blend * conform_w
        if blend <= 0.001:
            floating += 1
            continue
        if d <= ef_inner:
            flattened += 1
        else:
            blended += 1
        new_world_z = world.z * (1.0 - blend) + target_z * blend
        # Cap: never let the terrain rise above the drivable surface.
        # Interpolates from a strict cap at inner (surface_z = road top
        # minus clearance) to road_top itself at outer — guarantees
        # terrain stays at or below the road's actual top surface
        # everywhere in the band. The old formula blended toward
        # ``world.z`` which let highly-uphill terrain pop above road
        # top in the blend band, and each subsequent Re-conform would
        # then sample that popped-up terrain as the new road altitude,
        # producing a runaway drift that buried the road.
        surface_z = target_z + surface_lift - clearance
        road_top_z = target_z + surface_lift
        max_allowed = surface_z + (road_top_z - surface_z) * (1.0 - blend)
        if new_world_z > max_allowed:
            new_world_z = max_allowed
        v.co = mw_inv @ mathutils.Vector((world.x, world.y, new_world_z))

    me.update()
    me.calc_loop_triangles()
    return {"flattened": flattened, "blended": blended, "floating": floating}


# Terrain-mesh / modifier helpers live in ``_legacy`` so every domain
# module (road, tunnel, terrain sculpt, downtown, lint) picks the same
# terrain and handles modifier stacks the same way. Re-imported here as
# private names for backwards compatibility with the module-local call
# sites below.
from ._legacy import (  # noqa: E402
    _terrain_active_modifiers,
    _apply_all_viewport_modifiers,
)


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_add_road_starter_curve(Operator):
    """Create a 4-point Bezier curve named ``road_curve_main`` straddling
    the scene centre. Tab into edit mode to drag the handles into the
    road shape you want, then click *Build Road*."""

    bl_idname = "hoverbike.add_road_starter_curve"
    bl_label = "Add Road Curve"
    bl_description = "Drop a 4-point starter Bezier curve for the road tool to follow"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        obj = _add_road_starter_curve(context.scene)
        self.report({"INFO"}, f"Created {obj.name}. Tab into edit mode to shape it, then Build Road.")
        return {"FINISHED"}


class HOVERBIKE_OT_build_road(Operator):
    """Sample `road_curve_main` along its arc length, raycast onto the
    terrain to get each sample's altitude, smooth the height profile,
    build a road-strip mesh with `mat_track_road`, and deform the
    terrain so it conforms to the road in a `width + blend_radius` band.
    Re-runs replace any prior road mesh; the terrain deformation
    accumulates, so undo (Ctrl+Z) is your friend during iteration.

    If the terrain has active modifiers (e.g. a Geometry Nodes
    procedural island), they'd override the road's vertex edits — or
    worse, add their displacement on top so the terrain spikes upward.
    Toggle *Apply modifiers first* to bake them in before deforming
    (one-way: GN parametric tunability is lost in exchange for a
    drivable road)."""

    bl_idname = "hoverbike.build_road"
    bl_label = "Build Road"
    bl_description = (
        "Conform terrain to road_curve_main and build a kind=track road strip"
    )
    bl_options = {"REGISTER", "UNDO"}

    apply_modifiers: BoolProperty(  # type: ignore[valid-type]
        name="Apply modifiers first",
        description=(
            "Bake terrain modifiers (e.g. Geometry Nodes island) into the "
            "mesh before deforming. Required to deform procedural terrain; "
            "loses parametric tunability of the source modifier."
        ),
        default=False,
    )

    def execute(self, context):
        from ._legacy import _largest_terrain_mesh

        # Single-curve mode: prefer `road_curve_main` if present, else
        # fall back to `ai_spline_main`. Authors who want one curve for
        # both racing line and road can author only the AI spline and
        # the road follows it; authors who want a different road shape
        # (e.g., wider apex) add a separate `road_curve_main`.
        curve_obj = _resolve_road_curve()
        if curve_obj is None:
            self.report(
                {"ERROR"},
                "No road curve found — click *Add Road Curve* or "
                "create an `ai_spline_main` curve.",
            )
            return {"CANCELLED"}

        # Pick terrain: the active mesh, else the largest kind=track mesh.
        terrain = context.active_object
        if terrain is None or terrain.type != "MESH" or terrain.get("kind") != "track":
            terrain = _largest_terrain_mesh()
        if terrain is None:
            self.report(
                {"ERROR"},
                "No terrain mesh found. Select a kind=track mesh, or set kind='track' on your terrain.",
            )
            return {"CANCELLED"}

        active_mods = _terrain_active_modifiers(terrain)
        applied_mods: list[str] = []
        if active_mods:
            if self.apply_modifiers:
                applied_mods = _apply_all_viewport_modifiers(terrain)
            else:
                self.report(
                    {"ERROR"},
                    f"{terrain.name} has active modifiers ({', '.join(active_mods)}) — they'd "
                    "spike the terrain wildly because GN adds its displacement on top of the "
                    "road's vertex edits. Toggle *Apply modifiers first* in the redo panel, or "
                    "apply them manually (Object → Apply → Visual Geometry to Mesh) and re-run.",
                )
                return {"CANCELLED"}

        scene = context.scene
        # Wipe any prior road_main BEFORE sampling — _sample_road_path's
        # downward raycast would otherwise hit the existing road strip
        # and treat it as terrain. Each re-run would then lift the road
        # by another `lift` metres, racing the terrain up.
        old_road = bpy.data.objects.get(ROAD_OBJECT_NAME)
        if old_road is not None:
            old_road_mesh = old_road.data
            bpy.data.objects.remove(old_road, do_unlink=True)
            if isinstance(old_road_mesh, bpy.types.Mesh) and old_road_mesh.users == 0:
                bpy.data.meshes.remove(old_road_mesh)

        samples = _sample_road_path(
            curve_obj,
            terrain,
            n_samples=int(scene.hoverbike_road_samples),
            smooth_passes=int(scene.hoverbike_road_smooth_passes),
        )
        if len(samples) < 2:
            self.report({"ERROR"}, "Couldn't sample road curve — does it have ≥ 2 control points?")
            return {"CANCELLED"}

        width = float(scene.hoverbike_road_width)
        lift = float(scene.hoverbike_road_lift)
        blend_radius = float(scene.hoverbike_road_blend_radius)
        curb_width = float(scene.hoverbike_road_curb_width)
        curb_height = float(scene.hoverbike_road_curb_height)
        curb_stripe = float(scene.hoverbike_road_curb_stripe_length)
        thickness = float(scene.hoverbike_road_thickness)
        bank_strength = float(scene.hoverbike_road_bank_strength)
        bank_max_rad = math.radians(float(scene.hoverbike_road_bank_max_deg))

        # Stamp the bank angle on each sample. Mutates `samples` in
        # place to add an `s["bank"]` field that `_build_road_strip_mesh`
        # consumes when laying out the cross-section. The curve's
        # cyclic flag matters here — a closed loop wraps so the join
        # doesn't get a fake straight, while an open road clamps so
        # the endpoints don't pick up a wrap-around bogus curvature.
        curve_cyclic = bool(curve_obj.data.splines and curve_obj.data.splines[0].use_cyclic_u)
        _compute_per_sample_bank(
            samples,
            bank_strength=bank_strength,
            bank_max_rad=bank_max_rad,
            cyclic=curve_cyclic,
        )

        # Deform terrain first, then build the road strip — that way the
        # road's Z (sampled before deformation) sits on the *original*
        # surface and the terrain rises/falls to meet it. The conform
        # treats the curb band as part of the road footprint so curbs
        # don't fight the surrounding terrain.
        clearance = float(scene.hoverbike_road_conform_clearance)
        fill_shelf = float(scene.hoverbike_road_fill_shelf_width)
        deform_summary = _conform_terrain_to_road(
            terrain,
            samples,
            width=width,
            blend_radius=blend_radius,
            lift=lift,
            curb_width=curb_width,
            clearance=clearance,
            fill_shelf_width=fill_shelf,
        )

        # Build the road strip mesh (the prior `road_main`, if any, was
        # removed before sampling above so the raycast saw fresh terrain).
        me = _build_road_strip_mesh(
            samples,
            width=width,
            lift=lift,
            thickness=thickness,
            curb_width=curb_width,
            curb_height=curb_height,
            curb_stripe_length=curb_stripe,
        )
        # Slot order MUST match the face material_index values emitted
        # by `_build_road_strip_mesh`:
        #   curbs ON:  0 asphalt | 1 curb-white | 2 curb-red | 3 underside
        #   curbs OFF: 0 asphalt | 1 underside
        me.materials.append(_ensure_road_material())
        if curb_width > 0:
            me.materials.append(_ensure_curb_material(red=False))
            me.materials.append(_ensure_curb_material(red=True))
        if thickness > 0:
            me.materials.append(_ensure_road_underside_material())
        obj = bpy.data.objects.new(ROAD_OBJECT_NAME, me)
        obj["kind"] = "track"
        scene.collection.objects.link(obj)

        applied_msg = f" (applied {', '.join(applied_mods)})" if applied_mods else ""
        float_count = sum(1 for s in samples if float(s.get("conform", 1.0)) < 0.5)
        float_msg = f", {float_count} floating samples" if float_count > 0 else ""
        self.report(
            {"INFO"},
            f"Road built: {len(samples)} samples, width {width:.1f}m{float_msg}. "
            f"Terrain: {deform_summary['flattened']} verts flattened, "
            f"{deform_summary['blended']} blended, "
            f"{deform_summary['floating']} skipped (floating){applied_msg}.",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Per-point conform mode — float / conform toggles for the road curve
# ────────────────────────────────────────────────────────────────────


def _set_selected_float_weight(curve_obj: bpy.types.Object, float_weight: float) -> int:
    """Write ``weight_softbody`` (= 1 - conform) on every selected
    control point of the active curve. Returns the count of points
    modified. Works in edit mode (uses ``select_control_point`` flags)
    and falls back to all points when the curve is not in edit mode.

    ``float_weight`` semantics:
      * 1.0 → fully floating (road takes authored Z, terrain untouched).
      * 0.0 → fully conforming (default; road raycasts onto terrain)."""
    count = 0
    in_edit = bool(curve_obj.mode == "EDIT")
    for spline in curve_obj.data.splines:
        if spline.type == "BEZIER":
            for bp in spline.bezier_points:
                if in_edit and not bp.select_control_point:
                    continue
                bp.weight_softbody = float_weight
                count += 1
        else:
            for pt in spline.points:
                if in_edit and not pt.select:
                    continue
                pt.weight_softbody = float_weight
                count += 1
    return count


def _resolve_active_road_curve(context) -> bpy.types.Object | None:
    """Pick the curve the conform-toggle operators should act on. Order:
    (1) the active object if it's a curve, (2) ``road_curve_main``, (3)
    ``ai_spline_main``. Mirrors the road builder's resolution so the
    toggles act on whichever curve will actually drive the build."""
    obj = context.active_object
    if obj is not None and obj.type == "CURVE":
        return obj
    for name in (ROAD_CURVE_NAME, "ai_spline_main"):
        candidate = bpy.data.objects.get(name)
        if candidate is not None and candidate.type == "CURVE":
            return candidate
    return None


def _extract_samples_from_road_mesh(
    road_obj: bpy.types.Object, *, lift: float, curb_width: float, thickness: float
) -> list[dict]:
    """Recover ``{x, y, z, tx, ty, conform}`` samples from an existing
    road mesh — used by Re-conform Terrain to snap terrain to the road
    that's already built, NOT to re-sample the curve onto the (possibly
    drifted) current terrain.

    Why this matters: ``_sample_road_path`` raycasts the curve XY onto
    whatever terrain looks like *now*. If terrain has been sculpted up
    around the road, or the previous conform's cap let terrain pop
    slightly above the road in the blend band, the next raycast hits
    that raised terrain — and ``target_z`` climbs with every Re-conform
    until the road is fully buried. Reading the road mesh directly
    pins ``target_z`` to the road's actual altitude, so Re-conform
    converges to a stable state instead of drifting upward.

    Reconstructs cross-section layout from the road's actual material
    slot count: curbs add 2 cols (L_outer + R_outer), thickness adds
    2 more (bottom row). ``z_road_top = (v_L_inner + v_R_inner) / 2``;
    subtract ``lift`` to recover ``target_z``."""
    me = road_obj.data
    n_verts = len(me.vertices)
    # Figure out how many cols per sample. Materials are appended in
    # this order: asphalt, [curb white, curb red], [underside]. We use
    # the operator's settings rather than parsing the mesh because
    # they're the source of truth at re-conform time.
    has_curbs = curb_width > 0
    has_thick = thickness > 0
    cols_per_sample = 2 + (2 if has_curbs else 0) + (2 if has_thick else 0)
    if cols_per_sample == 0 or n_verts % cols_per_sample != 0:
        return []
    n_samples = n_verts // cols_per_sample
    if n_samples < 2:
        return []
    # Inner-road column indices for centerline reconstruction. With
    # curbs, columns are [L_outer_top, L_inner, R_inner, R_outer_top, L_bot, R_bot].
    # Without curbs, columns are [L_outer_top, R_outer_top, L_bot, R_bot].
    if has_curbs:
        l_inner_col, r_inner_col = 1, 2
    else:
        l_inner_col, r_inner_col = 0, 1

    mw = road_obj.matrix_world
    samples: list[dict] = []
    for i in range(n_samples):
        a = i * cols_per_sample
        v_lin = mw @ me.vertices[a + l_inner_col].co
        v_rin = mw @ me.vertices[a + r_inner_col].co
        cx = (v_lin.x + v_rin.x) * 0.5
        cy = (v_lin.y + v_rin.y) * 0.5
        z_top = (v_lin.z + v_rin.z) * 0.5  # = target_z + lift
        target_z = z_top - lift
        # Recover bank (signed radians around the tangent) from the
        # tilted cross-section's Z asymmetry: the road mesh tilts the
        # inner verts so v_L sits at z_road + hw*bank and v_R at
        # z_road - hw*bank. Solving: bank = (v_L.z - v_R.z) / (2*hw).
        # The terrain conform reads this back so it can drop terrain
        # toward the road's banked top surface — without it the
        # high-side curb edge would hover over a void and the
        # low-side would have terrain poking up through the slab.
        hw_xy = math.hypot(v_rin.x - v_lin.x, v_rin.y - v_lin.y) * 0.5
        bank = ((v_lin.z - v_rin.z) / (2.0 * hw_xy)) if hw_xy > 1e-6 else 0.0
        samples.append({
            "x": cx, "y": cy, "z": target_z,
            "_authored_z": target_z,
            "conform": 1.0,  # treat as fully conforming — Re-conform
                             # is "lock terrain to existing road" so
                             # bridge-floating semantics don't apply
                             # (rebuild the road if you need them).
            "bank": float(bank),
        })
    # Tangents from neighbouring samples — needed by callers that
    # check them, even though _conform_terrain_to_road itself only
    # uses {x, y, z, conform}.
    n = len(samples)
    for i, s in enumerate(samples):
        j = (i + 1) % n if i == n - 1 else i + 1
        dx = samples[j]["x"] - s["x"]
        dy = samples[j]["y"] - s["y"]
        tl = math.hypot(dx, dy) or 1.0
        s["tx"] = dx / tl
        s["ty"] = dy / tl
    return samples


class HOVERBIKE_OT_reconform_terrain_to_road(Operator):
    """Re-run only the terrain-conform pass against the current road
    *mesh* — not the curve. Useful after:

      * Sculpting terrain manually around an existing road — the
        sculpt would otherwise poke up through the road slab; this
        operator re-flattens the conform band.
      * Updating the conform clearance / blend radius / width / fill
        shelf scene props — the old build's terrain reflects the old
        settings; this re-applies them without rebuilding the road
        mesh.
      * Pulling a fix to the conform algorithm — re-conforms the
        existing terrain to the road without changing the road shape.

    Reads the centerline Z directly from the road mesh's inner-road
    columns instead of re-sampling the curve onto the current terrain.
    That makes the operator a stable "snap terrain to existing road"
    — no drift, even if Re-conform is run repeatedly or after terrain
    sculpting has raised the surface above the road.

    Requires an existing ``road_main`` and a ``kind=track`` terrain
    mesh. To change the road's shape, use Build Road (which re-samples
    the curve onto terrain); Re-conform is the "road wins, terrain
    follows" counterpart."""

    bl_idname = "hoverbike.reconform_terrain_to_road"
    bl_label = "Re-conform Terrain"
    bl_description = (
        "Snap terrain to the existing road mesh's altitude. Use after sculpting "
        "terrain or tweaking conform clearance / fill shelf. Stable across "
        "repeated runs — does NOT re-sample the curve (use Build Road for that)"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from ._legacy import _largest_terrain_mesh

        road_obj = bpy.data.objects.get(ROAD_OBJECT_NAME)
        if road_obj is None or road_obj.type != "MESH":
            self.report(
                {"ERROR"},
                f"No `{ROAD_OBJECT_NAME}` mesh in scene — run Build Road first.",
            )
            return {"CANCELLED"}

        terrain = context.active_object
        if terrain is None or terrain.type != "MESH" or terrain.get("kind") != "track":
            terrain = _largest_terrain_mesh()
        if terrain is None:
            self.report({"ERROR"}, "No kind=track terrain mesh found.")
            return {"CANCELLED"}

        active_mods = _terrain_active_modifiers(terrain)
        if active_mods:
            self.report(
                {"ERROR"},
                f"{terrain.name} has active modifiers ({', '.join(active_mods)}) — "
                "apply them first (Object → Apply → Visual Geometry to Mesh) or "
                "use Build Road with 'Apply modifiers first' toggled on.",
            )
            return {"CANCELLED"}

        scene = context.scene
        width = float(scene.hoverbike_road_width)
        lift = float(scene.hoverbike_road_lift)
        blend_radius = float(scene.hoverbike_road_blend_radius)
        curb_width = float(scene.hoverbike_road_curb_width)
        thickness = float(scene.hoverbike_road_thickness)
        clearance = float(scene.hoverbike_road_conform_clearance)
        fill_shelf = float(scene.hoverbike_road_fill_shelf_width)

        samples = _extract_samples_from_road_mesh(
            road_obj, lift=lift, curb_width=curb_width, thickness=thickness,
        )
        if len(samples) < 2:
            self.report(
                {"ERROR"},
                f"Couldn't reconstruct samples from {ROAD_OBJECT_NAME} — vertex count "
                "doesn't match the current width / curb / thickness settings. Rebuild "
                "the road and try again.",
            )
            return {"CANCELLED"}

        deform_summary = _conform_terrain_to_road(
            terrain,
            samples,
            width=width,
            blend_radius=blend_radius,
            lift=lift,
            curb_width=curb_width,
            clearance=clearance,
            fill_shelf_width=fill_shelf,
        )
        self.report(
            {"INFO"},
            f"Re-conformed terrain to {len(samples)} mesh samples: "
            f"{deform_summary['flattened']} verts flattened, "
            f"{deform_summary['blended']} blended, "
            f"{deform_summary['floating']} skipped.",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_mark_selected_floating(Operator):
    """Mark the active curve's selected control points as floating —
    the road tool will take their Z verbatim from the bezier point's
    authored height and leave the terrain underneath untouched. Use
    this to author bridges, ramps over water, or any road segment
    that should not push the seabed up to road level."""

    bl_idname = "hoverbike.mark_selected_floating"
    bl_label = "Mark Selected Floating"
    bl_description = (
        "Set float weight (weight_softbody) to 1 on selected control points; "
        "the road's Z at these points will come from the authored bezier height "
        "and the terrain underneath stays put (use for bridges, ramps over water)"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        curve_obj = _resolve_active_road_curve(context)
        if curve_obj is None:
            self.report({"ERROR"}, "No curve to edit. Select a curve (or create road_curve_main).")
            return {"CANCELLED"}
        n = _set_selected_float_weight(curve_obj, 1.0)
        self.report({"INFO"}, f"Marked {n} point(s) floating on {curve_obj.name}.")
        return {"FINISHED"}


class HOVERBIKE_OT_mark_selected_conforming(Operator):
    """Mark the active curve's selected control points as conforming —
    the road tool will raycast each point onto the terrain and lift
    the terrain to meet the road. This is the default; use this
    operator to restore conform after experimentally marking a point
    floating."""

    bl_idname = "hoverbike.mark_selected_conforming"
    bl_label = "Mark Selected Conforming"
    bl_description = (
        "Set float weight (weight_softbody) to 0 on selected control points; "
        "the road's Z at these points will be raycast onto the terrain and the "
        "terrain will be lifted to meet it (the default for new curves)"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        curve_obj = _resolve_active_road_curve(context)
        if curve_obj is None:
            self.report({"ERROR"}, "No curve to edit. Select a curve (or create road_curve_main).")
            return {"CANCELLED"}
        n = _set_selected_float_weight(curve_obj, 0.0)
        self.report({"INFO"}, f"Marked {n} point(s) conforming on {curve_obj.name}.")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_add_road_starter_curve,
    HOVERBIKE_OT_build_road,
    HOVERBIKE_OT_reconform_terrain_to_road,
    HOVERBIKE_OT_mark_selected_floating,
    HOVERBIKE_OT_mark_selected_conforming,
)

_SCENE_PROP_NAMES: tuple[str, ...] = (
    "hoverbike_road_width",
    "hoverbike_road_lift",
    "hoverbike_road_blend_radius",
    "hoverbike_road_samples",
    "hoverbike_road_smooth_passes",
    "hoverbike_road_curb_width",
    "hoverbike_road_curb_height",
    "hoverbike_road_curb_stripe_length",
    "hoverbike_road_thickness",
    "hoverbike_road_bank_strength",
    "hoverbike_road_bank_max_deg",
    "hoverbike_road_conform_clearance",
    "hoverbike_road_fill_shelf_width",
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.Scene.hoverbike_road_width = FloatProperty(
        name="Road width (m)",
        description="Total width of the road strip; terrain inside this band flattens fully to the road.",
        default=8.0, min=0.5, max=80.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_lift = FloatProperty(
        name="Road lift (m)",
        description="Small vertical offset above terrain so the road's surface is visible against the ground.",
        default=0.15, min=0.0, max=5.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_blend_radius = FloatProperty(
        name="Blend radius (m)",
        description="Outer falloff band where terrain blends from flattened to natural via smoothstep.",
        default=6.0, min=0.0, max=50.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_samples = IntProperty(
        name="Samples",
        description="Number of arc-length samples along the road curve. Higher = smoother road, slower build.",
        default=64, min=4, max=512,
    )
    bpy.types.Scene.hoverbike_road_smooth_passes = IntProperty(
        name="Smoothing passes",
        description="1-2-1 binomial passes applied to the height profile so the road doesn't follow every terrain bump.",
        default=4, min=0, max=32,
    )
    bpy.types.Scene.hoverbike_road_curb_width = FloatProperty(
        name="Curb width (m)",
        description="Width of each F1-style curb strip. 0 disables curbs entirely.",
        default=0.6, min=0.0, max=5.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_curb_height = FloatProperty(
        name="Curb height (m)",
        description="Vertical rise of the curbs above the road surface.",
        default=0.12, min=0.0, max=1.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_curb_stripe_length = FloatProperty(
        name="Stripe length (m)",
        description="Length of each red/white stripe along the road. Shorter = busier rumble.",
        default=2.0, min=0.2, max=20.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_thickness = FloatProperty(
        name="Slab thickness (m)",
        description="Vertical extrusion of the road into a solid slab. 0 keeps the legacy paper-thin ribbon.",
        default=0.6, min=0.0, max=10.0, precision=2,
    )
    # Road banking — auto-tilt cross-section based on per-sample
    # curvature. Bank strength is a multiplier on the (kappa × ref_v²)
    # product; max-deg caps the total signed angle so steep corners
    # don't roll the road past comfortable racing angles. 0 strength
    # disables auto-bank entirely (per-control-point Tilt still
    # contributes).
    bpy.types.Scene.hoverbike_road_bank_strength = FloatProperty(
        name="Bank strength",
        description="Auto-bank multiplier driven by curvature. 0 disables auto-bank; 0.5 = subtle; 1.0 = pronounced; >1 = aggressive.",
        default=0.6, min=0.0, max=4.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_bank_max_deg = FloatProperty(
        name="Bank max (deg)",
        description="Hard cap on the road's bank angle in degrees. 25° is a typical road race banking; 45° is NASCAR-superspeedway extreme.",
        default=25.0, min=0.0, max=80.0, precision=1,
    )
    # Conform clearance — how far below the road surface the terrain
    # is forced to sit inside the fully-flattened band. 0.20 m is a
    # comfortable default: the road's underside slab (thickness =
    # 0.6 m by default) buries another ~0.4 m below that, so no
    # terrain pokes through the road quad even with a coarse 384²
    # grid sampling. Raise to 0.5 m for very hilly tracks where the
    # blend's smoothstep would otherwise leave a noticeable terrain
    # ridge along the curbs.
    bpy.types.Scene.hoverbike_road_conform_clearance = FloatProperty(
        name="Conform clearance (m)",
        description=(
            "Minimum vertical gap between the conformed terrain and the road "
            "surface inside the flattened band. Larger values hide sampling "
            "artefacts on coarse-grid terrain but make the road's terrain "
            "groove visually deeper. 0.05 is the legacy tight default; 0.20 "
            "is the new recommended floor"
        ),
        default=0.20, min=0.0, max=2.0, precision=2,
    )
    # Downhill fill shelf — extra width on the fill side of a hillside
    # traverse so the road's slab underside is hidden by raised terrain
    # rather than hanging over a void. Asymmetric: only applies where
    # terrain is naturally below the road. Default 3.0 m gives a clean
    # embankment look on moderate slopes (up to ~10° before the
    # blend-band smoothstep starts to expose the slab). Crank higher on
    # very hilly tracks; set 0 to restore the legacy symmetric conform.
    bpy.types.Scene.hoverbike_road_fill_shelf_width = FloatProperty(
        name="Fill shelf width (m)",
        description=(
            "Extra width of the fully-conformed band on the downhill side of "
            "the road, before the smoothstep blend kicks in. Hides the road's "
            "slab underside on hillside traverses. 0 = legacy symmetric "
            "conform; 3 m = typical mountain-road embankment; 8 m+ = wide "
            "shelf for steep cliff roads"
        ),
        default=3.0, min=0.0, max=40.0, precision=1,
    )


def unregister() -> None:
    for prop in _SCENE_PROP_NAMES:
        try:
            delattr(bpy.types.Scene, prop)
        except AttributeError:
            pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
