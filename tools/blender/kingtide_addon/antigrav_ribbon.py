"""Anti-grav ribbon authoring — curve-driven anti-grav surfaces.

Seven of the eleven v1 ship tracks have anti-grav stretches (lighthouse
corkscrew, caldera loop, Cocoon Tower wall-ride, Liberty torch Möbius,
Doge's Campanile climb, Angkor spire, Kilauea caldera loop, plus the
tutorial half-pipe). Each is a different shape and authoring them as
bespoke meshes burns days per track; this module turns the work into a
two-step authoring loop:

  1. *Add Anti-Grav Curve* drops a 4-point Bezier (``antigrav_curve_NN``,
     ``AuthoringKind.ANTIGRAV_CURVE``) at the 3D cursor. The author
     shapes it (Tab into edit mode, drag handles).

  2. *Build Anti-Grav Surface* samples the curve by arc length, sweeps
     the chosen cross-section profile (TUBE / RIBBON / BANKED_STRIP)
     into a swept mesh named ``antigrav_NN_surface``, tagged
     ``kind="track"`` so the runtime trimesh collider attaches. At the
     same time the operator stamps an ``antigrav_NN_zone_entry`` /
     ``antigrav_NN_zone_exit`` empty pair at the curve endpoints with
     ``kind="antigrav_zone"`` — the existing zone system in
     ``antigrav.py`` (and the runtime controller) handles the actual
     gravity flip when a bike enters the volume.

Cross-section profiles:

  * ``TUBE``  — closed cylinder along the curve (corkscrews, loops).
    Mirrors the cylinder sweep in ``tunnel.py``; default radius is
    matched to the tunnel default so anti-grav tubes feel sibling-scale.
  * ``RIBBON`` — flat strip width × thickness (wall-rides, torch
    undersides, half-pipe lips). The strip is double-sided geometry so
    the bike sticks to either face inside the zone.
  * ``BANKED_STRIP`` — like the road tool's slab, with author-controlled
    tilt. Uses the curve's per-control-point ``tilt`` so authors can
    bank the strip (wall = ±π/2, ceiling = ±π) without dropping into
    edit mode.

Coordinates: Blender Z-up, glTF export rotates to runtime Y-up so a
swept mesh built here loads upright in the game.

Re-clicking *Build Anti-Grav Surface* on the same curve rebuilds the
surface + zones in place rather than stacking duplicates — same
re-build idempotency as the tunnel / road tools.
"""

from __future__ import annotations

import math
import re

import bpy
import mathutils
from bpy.props import EnumProperty, FloatProperty, IntProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

ANTIGRAV_CURVE_PREFIX = "antigrav_curve_"
ANTIGRAV_SURFACE_SUFFIX = "_surface"
ANTIGRAV_ZONE_ENTRY_SUFFIX = "_zone_entry"
ANTIGRAV_ZONE_EXIT_SUFFIX = "_zone_exit"
ANTIGRAV_RIBBON_MATERIAL_NAME = "mat_track_antigrav_ribbon"

# Custom-prop keys linking a curve to its built outputs so rebuilds can
# find and remove the previous artefacts before regenerating.
ANTIGRAV_CURVE_SURFACE_PROP = "antigrav_surface_name"
ANTIGRAV_CURVE_ENTRY_PROP = "antigrav_zone_entry_name"
ANTIGRAV_CURVE_EXIT_PROP = "antigrav_zone_exit_name"

PROFILE_TUBE = "TUBE"
PROFILE_RIBBON = "RIBBON"
PROFILE_BANKED_STRIP = "BANKED_STRIP"


# ────────────────────────────────────────────────────────────────────
# Material
# ────────────────────────────────────────────────────────────────────


def _ensure_ribbon_material() -> bpy.types.Material:
    """Authoring-time material for the anti-grav ribbon. A purple cast
    that reads as "this surface flips gravity" against any biome — same
    colour family as the zone gizmo in ``antigrav.py`` so the visual
    language stays consistent. Runtime swaps to the standard track
    shader; this is just so the .blend reads correctly."""
    mat = bpy.data.materials.get(ANTIGRAV_RIBBON_MATERIAL_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(ANTIGRAV_RIBBON_MATERIAL_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.32, 0.22, 0.56, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.55
        try:
            bsdf.inputs["Emission Color"].default_value = (0.55, 0.36, 0.95, 1.0)
            bsdf.inputs["Emission Strength"].default_value = 0.35
        except KeyError:
            pass
    return mat


# ────────────────────────────────────────────────────────────────────
# Indexing helpers
# ────────────────────────────────────────────────────────────────────


def _next_curve_index() -> int:
    """First free index NN such that ``antigrav_curve_NN`` is unused."""
    i = 0
    while True:
        if f"{ANTIGRAV_CURVE_PREFIX}{i:02d}" not in bpy.data.objects:
            return i
        i += 1


def _curve_index(curve: bpy.types.Object) -> int | None:
    """Extract NN from ``antigrav_curve_NN``; returns None on no match.
    Used to derive the matching surface / zone object names so rebuilds
    target the same NN consistently."""
    m = re.match(r"^antigrav_curve_(\d+)$", curve.name)
    if m is None:
        return None
    return int(m.group(1))


# ────────────────────────────────────────────────────────────────────
# Curve creation
# ────────────────────────────────────────────────────────────────────


def _add_antigrav_curve(scene, *, location: mathutils.Vector) -> bpy.types.Object:
    """Create a fresh ``antigrav_curve_NN`` Bezier at ``location`` with
    4 AUTO-handle control points spanning ~80 m along Y. Mirrors the
    starter curves emitted by the road and tunnel tools so authors who
    already know one workflow recognise the other."""
    idx = _next_curve_index()
    name = f"{ANTIGRAV_CURVE_PREFIX}{idx:02d}"
    curve_data = bpy.data.curves.new(name, type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 24
    spline = curve_data.splines.new(type="BEZIER")
    spline.bezier_points.add(3)  # 1 implicit + 3 new = 4 total
    # 80 m span along local Y, gentle climb so the starter shape reads
    # as "this is the anti-grav section" without being a flat strip.
    coords = [
        (0.0, -40.0, 0.0),
        (0.0, -15.0, 6.0),
        (0.0,  15.0, 6.0),
        (0.0,  40.0, 0.0),
    ]
    for bp, (x, y, z) in zip(spline.bezier_points, coords):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    spline.use_cyclic_u = False
    obj = bpy.data.objects.new(name, curve_data)
    obj.location = location.copy()
    scene.collection.objects.link(obj)
    # Canonical tag via auto_tag (matches antigrav_curve_NN regex).
    from .auto_tag import apply_canonical_tag
    apply_canonical_tag(obj)
    return obj


# ────────────────────────────────────────────────────────────────────
# Curve sampling + Frenet frame
# ────────────────────────────────────────────────────────────────────


def _sample_curve_polyline(curve_obj: bpy.types.Object) -> list[mathutils.Vector]:
    """World-space polyline samples from the curve's evaluated mesh.
    Same path the AI-spline export uses — relies on ``resolution_u`` for
    smoothness. The caller resamples to a fixed step count below; this
    raw polyline is just the source of truth for shape."""
    mesh = curve_obj.to_mesh()
    try:
        mw = curve_obj.matrix_world
        return [mw @ v.co for v in mesh.vertices]
    finally:
        curve_obj.to_mesh_clear()


def _curve_tilts(curve_obj: bpy.types.Object) -> list[float]:
    """Per-control-point tilt (radians) for the curve's first spline.
    Used by BANKED_STRIP — the strip rotates around its tangent by the
    interpolated tilt, so authors can wall-ride / ceiling-ride by
    setting tilt = ±π/2 or ±π on a control point. Empty list when the
    curve has no points."""
    if not curve_obj.data.splines:
        return []
    spline = curve_obj.data.splines[0]
    if spline.type == "BEZIER":
        return [float(bp.tilt) for bp in spline.bezier_points]
    return [float(pt.tilt) for pt in spline.points]


def _tilt_at_t(tilts: list[float], t: float) -> float:
    """Linearly interpolate the tilt array at t ∈ [0, 1]. Returns 0
    when no tilts authored (backwards compatible with curves that don't
    use banking)."""
    n = len(tilts)
    if n == 0:
        return 0.0
    if n == 1:
        return tilts[0]
    f = t * (n - 1)
    i0 = min(int(f), n - 1)
    i1 = min(i0 + 1, n - 1)
    frac = f - i0
    return tilts[i0] * (1.0 - frac) + tilts[i1] * frac


def _build_frenet_frames(
    points: list[mathutils.Vector], n_samples: int, tilts: list[float],
) -> list[dict]:
    """Resample the polyline to ``n_samples`` arc-length steps and
    compute a (position, tangent, normal, binormal) frame at each
    sample. Frame uses the *parallel-transport* (rotation-minimising)
    construction so the cross-section doesn't suddenly flip when the
    curve crosses a vertical-tangent stretch.

    Returns a list of ``{"co", "t", "n", "b", "tilt", "u"}`` dicts —
    ``co`` is the sample position, ``(t, n, b)`` is the orthonormal
    frame (tangent / normal / binormal) and ``u`` is the arc-length
    parameter in [0, 1]. ``tilt`` is the interpolated curve-control-
    point tilt at this sample, used by BANKED_STRIP to rotate the
    cross-section around the tangent.
    """
    if len(points) < 2:
        return []
    # Cumulative arc length along the polyline.
    cum = [0.0]
    for i in range(len(points) - 1):
        cum.append(cum[-1] + (points[i + 1] - points[i]).length)
    total = cum[-1]
    if total <= 0:
        return []

    # Resample to n_samples evenly spaced positions.
    sample_points: list[mathutils.Vector] = []
    sample_us: list[float] = []
    denom = max(1, n_samples - 1)
    j = 0
    for i in range(n_samples):
        target = (i / denom) * total
        while j < len(cum) - 1 and cum[j + 1] < target:
            j += 1
        seg = (cum[j + 1] - cum[j]) if (j + 1 < len(cum)) else 1.0
        frac = (target - cum[j]) / seg if seg > 0 else 0.0
        a = points[j]
        b = points[j + 1] if (j + 1 < len(points)) else points[j]
        sample_points.append(a + (b - a) * frac)
        sample_us.append(i / denom)

    # Per-sample tangent (central difference at interior, forward /
    # backward at endpoints). Normalise; collapse to (0,0,1) if zero.
    tangents: list[mathutils.Vector] = []
    n = len(sample_points)
    for i in range(n):
        if i == 0:
            d = sample_points[1] - sample_points[0]
        elif i == n - 1:
            d = sample_points[-1] - sample_points[-2]
        else:
            d = sample_points[i + 1] - sample_points[i - 1]
        if d.length < 1e-9:
            d = mathutils.Vector((0.0, 0.0, 1.0))
        tangents.append(d.normalized())

    # Initial frame: pick the world axis with the smallest |dot(tangent)|
    # so it's never colinear with the tangent. Cross with tangent to
    # get the first normal, then orthogonalise + normalise.
    t0 = tangents[0]
    candidates = [
        mathutils.Vector((0.0, 0.0, 1.0)),
        mathutils.Vector((0.0, 1.0, 0.0)),
        mathutils.Vector((1.0, 0.0, 0.0)),
    ]
    candidates.sort(key=lambda v: abs(v.dot(t0)))
    seed_up = candidates[0]
    normal = (seed_up - t0 * seed_up.dot(t0)).normalized()
    binormal = t0.cross(normal).normalized()

    frames: list[dict] = []
    for i in range(n):
        t = tangents[i]
        if i > 0:
            # Parallel-transport: rotate the previous normal by the
            # axis-angle from tangents[i-1] to tangents[i]. This stops
            # the normal from "snapping" through corners — a classic
            # tube-sweep artefact.
            t_prev = tangents[i - 1]
            axis = t_prev.cross(t)
            sin_a = axis.length
            cos_a = max(-1.0, min(1.0, t_prev.dot(t)))
            if sin_a > 1e-7:
                axis_n = axis / sin_a
                angle = math.atan2(sin_a, cos_a)
                rot = mathutils.Matrix.Rotation(angle, 3, axis_n)
                normal = (rot @ normal).normalized()
            # Re-orthogonalise against the new tangent (numerical drift).
            normal = (normal - t * normal.dot(t)).normalized()
            binormal = t.cross(normal).normalized()
        frames.append({
            "co": sample_points[i],
            "t": t,
            "n": normal.copy(),
            "b": binormal.copy(),
            "tilt": _tilt_at_t(tilts, sample_us[i]),
            "u": sample_us[i],
        })
    return frames


# ────────────────────────────────────────────────────────────────────
# Mesh construction — three cross-section profiles
# ────────────────────────────────────────────────────────────────────


def _build_tube_mesh(
    frames: list[dict], *, radius: float, segments: int, mesh_name: str,
) -> bpy.types.Mesh:
    """Closed cylinder swept along the parallel-transport frame.
    Mirrors ``tunnel.py``'s curve-bevel cylinder but built explicitly
    from the (n, b) frame so the sweep stays orientation-consistent
    even on near-vertical splines — relying on Blender's bevel here
    occasionally produces a 180° flip mid-corkscrew that's a pain to
    undo. The strip is open-ended (no end caps) so the player can
    actually enter / exit the tube."""
    if mesh_name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[mesh_name])
    me = bpy.data.meshes.new(mesh_name)

    verts: list[tuple[float, float, float]] = []
    for f in frames:
        co = f["co"]
        n = f["n"]
        b = f["b"]
        for k in range(segments):
            theta = (k / segments) * math.tau
            # Local frame: cos·n + sin·b. (n, b) is orthonormal so this
            # traces a circle of radius `radius` in the plane perp to t.
            ox = math.cos(theta) * radius
            oy = math.sin(theta) * radius
            p = co + n * ox + b * oy
            verts.append((p.x, p.y, p.z))

    faces: list[tuple[int, int, int, int]] = []
    n_frames = len(frames)
    for i in range(n_frames - 1):
        a = i * segments
        b = (i + 1) * segments
        for k in range(segments):
            k1 = (k + 1) % segments
            faces.append((a + k, a + k1, b + k1, b + k))

    me.from_pydata(verts, [], faces)
    me.update()
    for poly in me.polygons:
        poly.use_smooth = True
    me.materials.append(_ensure_ribbon_material())
    return me


def _build_ribbon_mesh(
    frames: list[dict], *, width: float, thickness: float, mesh_name: str,
) -> bpy.types.Mesh:
    """Flat double-sided strip with optional thickness. Cross-section
    is 2 verts (no thickness) or 4 verts (thickness > 0) per frame. The
    ribbon lays in the plane spanned by the frame's normal — i.e. the
    bike rides on top of the strip in the curve's "up" direction. For
    wall-rides the author rotates the whole curve so the ribbon stands
    vertical. Caps the two ends so the strip reads as a solid slab from
    every angle."""
    if mesh_name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[mesh_name])
    me = bpy.data.meshes.new(mesh_name)
    half_w = width * 0.5
    has_thickness = thickness > 0

    verts: list[tuple[float, float, float]] = []
    for f in frames:
        co = f["co"]
        n = f["n"]
        b = f["b"]
        # Top row: ±half_w along binormal.
        pL = co + b * (-half_w)
        pR = co + b * ( half_w)
        verts.append((pL.x, pL.y, pL.z))
        verts.append((pR.x, pR.y, pR.z))
        if has_thickness:
            # Bottom row: drop along -normal by `thickness`.
            qL = pL + n * (-thickness)
            qR = pR + n * (-thickness)
            verts.append((qL.x, qL.y, qL.z))
            verts.append((qR.x, qR.y, qR.z))

    cols_per = 4 if has_thickness else 2
    faces: list[tuple[int, int, int, int]] = []
    n_frames = len(frames)
    for i in range(n_frames - 1):
        a = i * cols_per
        b = (i + 1) * cols_per
        # Top face (CCW seen from +normal).
        faces.append((a + 0, b + 0, b + 1, a + 1))
        if has_thickness:
            # Bottom face.
            faces.append((a + 2, a + 3, b + 3, b + 2))
            # Left side.
            faces.append((a + 0, a + 2, b + 2, b + 0))
            # Right side.
            faces.append((a + 1, b + 1, b + 3, a + 3))

    # End caps for the slab.
    if has_thickness and n_frames >= 2:
        last = (n_frames - 1) * cols_per
        faces.append((0, 1, 3, 2))                     # front
        faces.append((last + 0, last + 2, last + 3, last + 1))  # back

    me.from_pydata(verts, [], faces)
    me.update()
    for poly in me.polygons:
        poly.use_smooth = not has_thickness
    me.materials.append(_ensure_ribbon_material())
    return me


def _build_banked_strip_mesh(
    frames: list[dict],
    *,
    width: float,
    thickness: float,
    mesh_name: str,
) -> bpy.types.Mesh:
    """Banked road-style slab where the cross-section tilts by the
    curve's per-control-point ``tilt`` around the tangent. Authors set
    tilt = π/2 for a wall, π for a ceiling; flat (0) reads like the
    road tool's slab. Built from the same parallel-transport frame as
    TUBE / RIBBON, with the tilt rotation applied as a per-sample
    rotation matrix that swings the normal / binormal around the
    tangent."""
    if mesh_name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[mesh_name])
    me = bpy.data.meshes.new(mesh_name)
    half_w = width * 0.5
    has_thickness = thickness > 0

    verts: list[tuple[float, float, float]] = []
    for f in frames:
        co = f["co"]
        t = f["t"]
        n = f["n"]
        b = f["b"]
        tilt = float(f["tilt"])
        # Rotate (n, b) around t by `tilt`. Equivalent to laying the
        # cross-section on the (n, b) plane and then twisting the
        # whole slab into a wall / ceiling.
        if abs(tilt) > 1e-7:
            rot = mathutils.Matrix.Rotation(tilt, 3, t)
            n = (rot @ n).normalized()
            b = (rot @ b).normalized()
        pL = co + b * (-half_w)
        pR = co + b * ( half_w)
        verts.append((pL.x, pL.y, pL.z))
        verts.append((pR.x, pR.y, pR.z))
        if has_thickness:
            qL = pL + n * (-thickness)
            qR = pR + n * (-thickness)
            verts.append((qL.x, qL.y, qL.z))
            verts.append((qR.x, qR.y, qR.z))

    cols_per = 4 if has_thickness else 2
    faces: list[tuple[int, int, int, int]] = []
    n_frames = len(frames)
    for i in range(n_frames - 1):
        a = i * cols_per
        b = (i + 1) * cols_per
        faces.append((a + 0, b + 0, b + 1, a + 1))
        if has_thickness:
            faces.append((a + 2, a + 3, b + 3, b + 2))
            faces.append((a + 0, a + 2, b + 2, b + 0))
            faces.append((a + 1, b + 1, b + 3, a + 3))
    if has_thickness and n_frames >= 2:
        last = (n_frames - 1) * cols_per
        faces.append((0, 1, 3, 2))
        faces.append((last + 0, last + 2, last + 3, last + 1))

    me.from_pydata(verts, [], faces)
    me.update()
    for poly in me.polygons:
        poly.use_smooth = True
    me.materials.append(_ensure_ribbon_material())
    return me


# ────────────────────────────────────────────────────────────────────
# Zone empty placement
# ────────────────────────────────────────────────────────────────────


def _make_zone_empty(
    scene,
    *,
    name: str,
    location: mathutils.Vector,
    tangent: mathutils.Vector,
    normal: mathutils.Vector,
    half_extents: tuple[float, float, float],
) -> bpy.types.Object:
    """Drop an ``antigrav_NN_zone_*`` empty oriented so its local +Y
    matches the curve tangent (forward), local +Z matches the frame's
    "up" (the parallel-transport normal). Inside the box the runtime
    anti-grav controller flips gravity to point along −local +Y per
    the existing zone semantics — see ``antigrav.py``.

    Reuses the existing kind=antigrav_zone empty system so no new
    runtime work is needed; the half-extents pick a volume that just
    covers the entry / exit mouth of the ribbon (width × thickness ×
    a short depth) plus a small overrun so a bike already in the
    volume can't pop out the side."""
    obj = bpy.data.objects.get(name)
    if obj is None:
        obj = bpy.data.objects.new(name, None)
        scene.collection.objects.link(obj)
    obj.empty_display_type = "ARROWS"
    obj.empty_display_size = 4.0
    obj["kind"] = "antigrav_zone"
    obj["half_width"] = float(half_extents[0])
    obj["half_height"] = float(half_extents[1])
    obj["half_depth"] = float(half_extents[2])

    obj.location = location.copy()
    # Build a rotation matrix whose local axes are
    #   X = tangent × normal (right)
    #   Y = tangent           (forward / "into the zone")
    #   Z = normal            ("up" — gravity flips toward −Y)
    # Mirrors the convention used by the existing antigrav_NN empties.
    t = tangent.normalized() if tangent.length > 1e-7 else mathutils.Vector((0, 1, 0))
    up = normal.normalized() if normal.length > 1e-7 else mathutils.Vector((0, 0, 1))
    # Re-orthogonalise up against t.
    up = (up - t * up.dot(t))
    if up.length < 1e-6:
        # Fallback if normal collinear with tangent — pick a world axis.
        up = mathutils.Vector((0, 0, 1)) if abs(t.z) < 0.99 else mathutils.Vector((0, 1, 0))
        up = (up - t * up.dot(t)).normalized()
    else:
        up = up.normalized()
    right = t.cross(up).normalized()
    rot = mathutils.Matrix((
        (right.x, t.x, up.x),
        (right.y, t.y, up.y),
        (right.z, t.z, up.z),
    )).to_4x4()
    obj.rotation_euler = rot.to_euler()
    return obj


# ────────────────────────────────────────────────────────────────────
# Build entry point
# ────────────────────────────────────────────────────────────────────


def build_antigrav_ribbon_from_curve(
    scene,
    curve: bpy.types.Object,
    *,
    profile: str,
    width: float,
    thickness: float,
    radius: float,
    samples: int,
    segments: int,
) -> dict:
    """Sample the curve, build the swept surface, and stamp the entry /
    exit zone empties at the endpoints. Public entry point so seed
    scripts can drive the same authoring flow headlessly.

    Returns ``{"surface": Object, "entry": Object, "exit": Object}`` on
    success.

    The curve is left untouched (no bevel set on it, no kind change)
    so re-runs and edit-mode tweaks behave predictably. Prior outputs
    are removed before regeneration via the
    ``antigrav_surface_name`` / ``antigrav_zone_entry_name`` /
    ``antigrav_zone_exit_name`` custom props on the curve."""
    idx = _curve_index(curve)
    if idx is None:
        # Hand-named curve — give it a sensible name so the outputs
        # stay grouped. Doesn't rename the curve to avoid surprising
        # the author; the surface / zones land under a fresh slot.
        idx = _next_curve_index()
    base = f"antigrav_{idx:02d}"
    surface_name = f"{base}{ANTIGRAV_SURFACE_SUFFIX}"
    entry_name = f"{base}{ANTIGRAV_ZONE_ENTRY_SUFFIX}"
    exit_name = f"{base}{ANTIGRAV_ZONE_EXIT_SUFFIX}"

    # Tear down prior outputs from this curve. Read the names off the
    # curve's own custom props so we hit the right objects even when
    # the curve has been renamed since the last build.
    for prop_key in (
        ANTIGRAV_CURVE_SURFACE_PROP,
        ANTIGRAV_CURVE_ENTRY_PROP,
        ANTIGRAV_CURVE_EXIT_PROP,
    ):
        prior_name = curve.get(prop_key)
        if not prior_name:
            continue
        prior = bpy.data.objects.get(prior_name)
        if prior is None:
            continue
        prior_data = prior.data if prior.type == "MESH" else None
        bpy.data.objects.remove(prior, do_unlink=True)
        if isinstance(prior_data, bpy.types.Mesh) and prior_data.users == 0:
            bpy.data.meshes.remove(prior_data)

    # Sample + build frames.
    poly = _sample_curve_polyline(curve)
    if len(poly) < 2:
        raise ValueError(
            f"{curve.name} has too few points to sweep — needs ≥ 2 polyline samples."
        )
    tilts = _curve_tilts(curve)
    frames = _build_frenet_frames(poly, max(2, int(samples)), tilts)
    if len(frames) < 2:
        raise ValueError(f"Could not build a sweep frame for {curve.name}.")

    # Pick the cross-section builder.
    mesh_name = f"{surface_name}_mesh"
    if profile == PROFILE_TUBE:
        me = _build_tube_mesh(
            frames, radius=radius, segments=max(3, int(segments)), mesh_name=mesh_name,
        )
        # Zone half-extents: tube radius for width / height, short depth.
        zone_half = (radius * 1.2, radius * 1.2, max(2.0, radius))
    elif profile == PROFILE_RIBBON:
        me = _build_ribbon_mesh(
            frames, width=width, thickness=thickness, mesh_name=mesh_name,
        )
        zone_half = (width * 0.5 + 1.0, max(2.0, thickness + 1.0), max(2.0, width * 0.25))
    elif profile == PROFILE_BANKED_STRIP:
        me = _build_banked_strip_mesh(
            frames, width=width, thickness=thickness, mesh_name=mesh_name,
        )
        zone_half = (width * 0.5 + 1.0, max(3.0, width * 0.4), max(2.0, width * 0.25))
    else:
        raise ValueError(f"Unknown anti-grav ribbon profile: {profile!r}")

    surface = bpy.data.objects.get(surface_name)
    if surface is None:
        surface = bpy.data.objects.new(surface_name, me)
        scene.collection.objects.link(surface)
    else:
        old_data = surface.data
        surface.data = me
        if isinstance(old_data, bpy.types.Mesh) and old_data.users == 0:
            bpy.data.meshes.remove(old_data)
    surface["kind"] = "track"
    surface["anti_grav"] = True
    surface["antigrav_profile"] = profile
    surface["antigrav_curve"] = curve.name

    # Entry / exit zones at the curve endpoints. The entry zone sits
    # at frames[0], the exit zone at frames[-1]; both are oriented so
    # local +Y points along the curve tangent (i.e. "the direction the
    # bike travels into / out of the zone"). The runtime anti-grav
    # controller treats the zone's local +Z as "up" — gravity flips to
    # point toward −up while a bike is inside.
    first = frames[0]
    last = frames[-1]
    entry = _make_zone_empty(
        scene,
        name=entry_name,
        location=first["co"],
        tangent=first["t"],
        normal=first["n"],
        half_extents=zone_half,
    )
    exit_obj = _make_zone_empty(
        scene,
        name=exit_name,
        location=last["co"],
        # Exit zone points opposite the curve tangent so the bike
        # entering from the *exit* side (running the segment backwards)
        # still triggers the volume correctly.
        tangent=-last["t"],
        normal=last["n"],
        half_extents=zone_half,
    )

    curve[ANTIGRAV_CURVE_SURFACE_PROP] = surface.name
    curve[ANTIGRAV_CURVE_ENTRY_PROP] = entry.name
    curve[ANTIGRAV_CURVE_EXIT_PROP] = exit_obj.name

    # Refresh the antigrav-zone gizmos so the freshly-stamped entry /
    # exit zones get their viewport boxes immediately.
    try:
        from .antigrav import refresh_antigrav_zone_gizmos
        refresh_antigrav_zone_gizmos(scene)
    except (ImportError, RuntimeError):
        pass

    return {"surface": surface, "entry": entry, "exit": exit_obj}


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class KINGTIDE_OT_add_antigrav_curve(Operator):
    """Drop a fresh ``antigrav_curve_NN`` Bezier at the 3D cursor.

    Tab into edit mode to drag control points into the shape you want
    (corkscrew climbing a pillar, ribbon wall-ride, loop, Möbius torch
    arm). Then click *Build Anti-Grav Surface* to sweep the chosen
    cross-section profile into a swept mesh + place the entry / exit
    zone empties at the curve endpoints."""

    bl_idname = "kingtide.add_antigrav_curve"
    bl_label = "Add Anti-Grav Curve"
    bl_description = (
        "Drop a 4-point antigrav_curve_NN Bezier at the 3D cursor. Edit it, "
        "then click Build Anti-Grav Surface to sweep the cross-section profile"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        cursor_loc = context.scene.cursor.location.copy()
        obj = _add_antigrav_curve(scene, location=cursor_loc)

        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj

        self.report(
            {"INFO"},
            f"Created {obj.name}. Tab into edit mode to shape it, "
            "then click Build Anti-Grav Surface.",
        )
        return {"FINISHED"}


class KINGTIDE_OT_build_antigrav_surface(Operator):
    """Sweep the selected ``antigrav_curve_NN`` into a swept anti-grav
    mesh and stamp the entry / exit zone empties at its endpoints.

    The chosen cross-section profile, width / thickness / radius /
    sample density / radial segments are read from the panel scene
    properties. Re-running on the same curve rebuilds its surface +
    zones in place — to add a second anti-grav segment, click *Add
    Anti-Grav Curve* first."""

    bl_idname = "kingtide.build_antigrav_surface"
    bl_label = "Build Anti-Grav Surface"
    bl_description = (
        "Sweep the selected antigrav_curve_NN with the chosen profile "
        "and place entry/exit zone empties"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        active = context.view_layer.objects.active
        if active is None or active.type != "CURVE":
            # Fall back to the first antigrav_curve_NN in the scene.
            for obj in scene.objects:
                if obj.type == "CURVE" and obj.name.startswith(ANTIGRAV_CURVE_PREFIX):
                    active = obj
                    break
        if active is None or active.type != "CURVE":
            self.report(
                {"ERROR"},
                "Select an antigrav_curve_NN (or click Add Anti-Grav Curve first).",
            )
            return {"CANCELLED"}

        profile = str(scene.hoverbike_antigrav_profile)
        width = float(scene.hoverbike_antigrav_width)
        thickness = float(scene.hoverbike_antigrav_thickness)
        radius = float(scene.hoverbike_antigrav_radius)
        samples = int(scene.hoverbike_antigrav_samples)
        segments = int(scene.hoverbike_antigrav_segments)

        try:
            result = build_antigrav_ribbon_from_curve(
                scene,
                active,
                profile=profile,
                width=width,
                thickness=thickness,
                radius=radius,
                samples=samples,
                segments=segments,
            )
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}

        # Pretty-print the dimensions for the chosen profile.
        if profile == PROFILE_TUBE:
            dims = f"r={radius:.1f}m × {segments} sides"
        else:
            dims = f"{width:.1f}m wide × {thickness:.2f}m thick"
        self.report(
            {"INFO"},
            f"Built {result['surface'].name} ({profile}, {dims}, {samples} samples). "
            f"Entry: {result['entry'].name}, Exit: {result['exit'].name}.",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    KINGTIDE_OT_add_antigrav_curve,
    KINGTIDE_OT_build_antigrav_surface,
)

_SCENE_PROP_NAMES: tuple[str, ...] = (
    "hoverbike_antigrav_profile",
    "hoverbike_antigrav_width",
    "hoverbike_antigrav_thickness",
    "hoverbike_antigrav_radius",
    "hoverbike_antigrav_samples",
    "hoverbike_antigrav_segments",
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.Scene.hoverbike_antigrav_profile = EnumProperty(
        name="Profile",
        description=(
            "Cross-section profile swept along the curve. TUBE = closed cylinder "
            "(corkscrews, loops). RIBBON = flat strip (wall-rides, torch undersides). "
            "BANKED_STRIP = slab whose tilt comes from the curve's per-point tilt "
            "field (set tilt = ±π/2 for a wall, ±π for a ceiling)."
        ),
        items=(
            (PROFILE_TUBE, "Tube", "Closed cylinder along the curve — corkscrews, loops"),
            (PROFILE_RIBBON, "Ribbon", "Flat strip with optional thickness — wall-rides"),
            (
                PROFILE_BANKED_STRIP,
                "Banked strip",
                "Strip whose tilt is read from the curve's per-point tilt field",
            ),
        ),
        default=PROFILE_TUBE,
    )
    bpy.types.Scene.hoverbike_antigrav_width = FloatProperty(
        name="Width (m)",
        description=(
            "Cross-section width for RIBBON / BANKED_STRIP profiles. 8 m matches "
            "the road tool's default — comfortable arcade scale for one bike with "
            "room to swerve."
        ),
        default=8.0, min=0.5, max=64.0, precision=2,
    )
    bpy.types.Scene.hoverbike_antigrav_thickness = FloatProperty(
        name="Thickness (m)",
        description=(
            "Slab thickness for RIBBON / BANKED_STRIP profiles. 0 = single-sided "
            "ribbon (zero-thickness double quad). Thickness > 0 adds bottom + side "
            "faces so the strip reads as a solid slab from every angle."
        ),
        default=0.5, min=0.0, max=8.0, precision=2,
    )
    bpy.types.Scene.hoverbike_antigrav_radius = FloatProperty(
        name="Radius (m)",
        description=(
            "Tube radius for the TUBE profile. 8 m = 16 m diameter, matching the "
            "tunnel tool's default. Bike + handlebars fit comfortably inside; "
            "smaller tubes feel claustrophobic at race speed."
        ),
        default=8.0, min=1.0, max=40.0, precision=2,
    )
    bpy.types.Scene.hoverbike_antigrav_samples = IntProperty(
        name="Samples",
        description=(
            "Number of arc-length samples along the curve. 48 reads smooth on "
            "single-loop curves; bump for long corkscrews."
        ),
        default=48, min=4, max=512,
    )
    bpy.types.Scene.hoverbike_antigrav_segments = IntProperty(
        name="Tube sides",
        description=(
            "Number of radial sides per ring on the TUBE profile. 16 reads as a "
            "smooth tube; 6 reads as a hex pipe. Ignored for RIBBON / "
            "BANKED_STRIP."
        ),
        default=16, min=3, max=64,
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
