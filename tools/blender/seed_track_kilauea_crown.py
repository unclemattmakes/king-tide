"""Build ``tracks-src/kilauea-crown.blend`` + GLB/JSON exports.

Run (after ``seed_template_island.py`` + ``seed_landmarks_library.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_kilauea_crown.py

Or via the pnpm wrapper:
    pnpm seed:track-kilauea-crown

Reshape: a 50/50 land+water lap through a Kilauea that's actively
erupting in 2026. The mountain is the new high ground; the surrounding
lowlands are flooded ocean. Layout:

  * **Windward ascent** (E coast, ~400 m, climbs from sea level
    z=-2 up through old lava fields to z≈45 m at the caldera rim NE).
  * **Caldera-rim loop** (~315° CCW around the enlarged caldera at
    z≈45 m, ~100 m radius). The rim is **banked inward** — anti-grav
    BANKED_STRIP profile so the bike rides the inside of the bowl.
  * **Leeward descent** (SE, ~400 m, drops from rim back to sea level
    alongside the **lava waterfall** — molten rock spilling into ocean
    as the set-piece). Ends at the freshly-formed black-sand lava
    beach where steam plumes meet the new shoreline.
  * **Coastal recovery** (E coast, ~325 m, back to the start).

Continental Cup race per
[docs/track-themes.md § Kilauea Crown](../../docs/track-themes.md).
Phase D Sprint 2 of [docs/v1-asset-pipeline-plan.md](../../docs/v1-asset-pipeline-plan.md).

After ``build_track_from_spec(SPEC)`` returns this script augments
the scene with:

  * **Lava waterfall**          — 1 × ``landmark_lava_river_strip``
                                  library-linked instance, stretched
                                  ~120 m × 6 m, oriented from rim down
                                  to lava-lake shore alongside the
                                  racing line on the leeward descent.
                                  Tagged ``kind = "decoration"`` — the
                                  bike rides ALONGSIDE the channel, not
                                  on it.
  * **Caldera rim ring**        — inline-built basalt rim mesh,
                                  ~100 m radius, 5 m tall, with an
                                  inward-banked inner face for "you
                                  ride the inside of the bowl" reading.
                                  Tagged ``kind = "track"`` so the
                                  outer face is collidable.
  * **Anti-grav rim loop**      — ``antigrav_curve_00`` Bezier sweeping
                                  once around the caldera (full 360°
                                  closed loop, 12 control points,
                                  100 m radius, z=45 m). Built via
                                  ``build_antigrav_ribbon_from_curve``
                                  with ``PROFILE_BANKED_STRIP`` and a
                                  curve tilt of +π/4 so the strip banks
                                  inward toward the caldera centre.
  * **Lava-beach wave zone**    — single moderate wave zone at the
                                  black-sand shore. height_mult 1.3,
                                  freq_mult 1.0, 25 m blend. Reads as
                                  "the lava boils the water locally."
  * **6 pickups + 2 boost pads** — pickups spaced along the loop
                                  (including one at caldera-rim
                                  altitude); boost pads on the
                                  windward ascent + the recovery
                                  straight.
  * **camera_hero**             — 35 mm parked offshore SE of the
                                  lava-beach shore, ~150 m offshore,
                                  ~40 m elevation, framing the lava
                                  waterfall + caldera silhouette +
                                  steam plumes against tropical sky.

The augmentation walks the same Blender API as the sibling track seeds
in ``tools/blender/`` so re-running ``pnpm seed:track-kilauea-crown``
stomps the .blend deterministically.
"""

from __future__ import annotations

import importlib.util
import math
import os
import sys

import bmesh
import bpy
import mathutils

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "track_build_lib", os.path.join(SCRIPT_DIR, "track_build_lib.py"),
)
_lib = importlib.util.module_from_spec(spec)
sys.modules["track_build_lib"] = _lib  # @dataclass needs us pre-registered
spec.loader.exec_module(_lib)

TrackSpec = _lib.TrackSpec
REPO_ROOT = _lib.REPO_ROOT
build_track_from_spec = _lib.build_track_from_spec

# Library paths — appender + collection-instance flows pull from these.
LANDMARKS_LIBRARY = os.path.join(REPO_ROOT, "tracks-src", "landmarks-library.blend")


# ────────────────────────────────────────────────────────────────────
# TrackSpec — racing line + road params
# ────────────────────────────────────────────────────────────────────
#
# Caldera centred on the world origin at z≈45 m (the "new high ground"
# of a Kilauea that built itself taller through the 2026 eruption).
# Spline traverses an east-coast ascent, ~315° CCW around the rim,
# then a SE leeward descent to the lava-lake shore, then a short east-
# coast recovery back to the start.
#
# Total arc length ≈ 1688 m. Anchor segments roughly:
#   ascent  (anchors 0..5)  ≈ 408 m   target ≈ 400 m
#   rim     (anchors 5..11) ≈ 459 m   315° CCW at r≈100 m
#                                     (full 360° antigrav ribbon ~628 m)
#   descent (anchors 11..15) ≈ 378 m  target ≈ 400 m
#   recovery (anchors 15..17→0) ≈ 444 m  target ≈ 325 m
# At a Continental Cup pace of ~25 m/s the lap clocks roughly 67–68 s,
# bracketing the 65 s target listed in track-themes.

SPEC = TrackSpec(
    track_id="kilauea-crown",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-island.blend"),
    spline_anchors=[
        # ── Windward ascent — east coast NW up the old lava fields
        (460.0,   20.0, -2.0),   # 0  start, sea-level east coast
        (380.0,   60.0,  6.0),   # 1
        (290.0,   80.0, 18.0),   # 2
        (200.0,   90.0, 30.0),   # 3
        (130.0,   90.0, 42.0),   # 4  approach NE rim
        # ── Caldera rim — ~315° CCW around the bowl at z≈45 m
        ( 70.7,   70.7, 45.0),   # 5  rim NE entry
        (  0.0,  100.0, 45.0),   # 6  rim N
        (-70.7,   70.7, 45.0),   # 7  rim NW
        (-100.0,   0.0, 45.0),   # 8  rim W
        (-70.7,  -70.7, 45.0),   # 9  rim SW
        (  0.0, -100.0, 45.0),   # 10 rim S
        ( 70.7,  -70.7, 45.0),   # 11 rim SE exit
        # ── Leeward descent — SE down to the lava-lake shore
        (130.0, -140.0, 32.0),   # 12
        (200.0, -220.0, 18.0),   # 13
        (280.0, -290.0,  4.0),   # 14
        (330.0, -340.0, -2.0),   # 15 black-beach / lava-lake shore
        # ── Coastal recovery — east coast back N to the start
        (430.0, -300.0, -2.0),   # 16
        (490.0, -180.0, -2.0),   # 17
    ],
    # Five checkpoints. cp_02 sits mid-rim (anchor 8, west apex) so the
    # caldera-loop apex is gated; cp_03 lands on the descent crest so the
    # leeward drop is timed against the lava waterfall.
    checkpoint_ts=(0.18, 0.36, 0.56, 0.74, 0.92),
    # Mid difficulty + wave-mastery + anti-grav apex — keep the road
    # forgiving enough that the rim loop reads cleanly at race pace.
    road_width=12.0,
    road_lift=0.3,
    road_blend_radius=7.0,
    road_samples=160,            # caldera rim wants extra samples for smoothness
    road_smooth_passes=5,
    road_curb_width=0.7,
    road_curb_height=0.16,
    road_curb_stripe=2.0,
    road_thickness=0.6,
    gate_spacing_m=65.0,
    water_preview_size=900.0,
    water_preview_subdivisions=140,
)


# ────────────────────────────────────────────────────────────────────
# Caldera geometry — inline procedural ring, mirrors the Cape-Town
# container-scatter pattern (bmesh primitives + custom-prop kind tag).
# ────────────────────────────────────────────────────────────────────

# Caldera rim — ~100 m outer radius, 5 m tall basalt cap, with an
# inward-tilted inner face so the visual reads as a banked bowl even
# without ray-cast confirmation. The anti-grav ribbon sweeps inside
# this ring; the ring itself is the dressed silhouette + outer-face
# collider so the player physically can't fall off the rim's back side.
CALDERA_CENTRE = (0.0, 0.0, 45.0)   # rim crest altitude matches spline rim section
CALDERA_OUTER_R_M = 110.0           # outer radius — bike rides between r=100 (spline) and r=110
CALDERA_INNER_R_TOP_M = 95.0        # inner edge at rim crest — bowl opens to ~95 m radius
CALDERA_INNER_R_BOTTOM_M = 85.0     # inner edge 5 m below — bowl narrows downward (banked inward)
CALDERA_HEIGHT_M = 5.0              # rim thickness vertical
CALDERA_SEGMENTS = 96               # smooth read at race pace


def _ensure_material(name: str, hex_color: str, *, roughness: float = 0.7,
                     emission_strength: float = 0.0) -> bpy.types.Material:
    """Kilauea palette materials — black basalt, hot red-orange lava
    glow, steam-white. Idempotent on name. Same gamma 2.2 → linear
    convention as the sibling Cape-Town seed."""
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        return mat
    h = hex_color.lstrip("#")
    r = int(h[0:2], 16) / 255.0
    g = int(h[2:4], 16) / 255.0
    b = int(h[4:6], 16) / 255.0
    bsdf.inputs["Base Color"].default_value = (r ** 2.2, g ** 2.2, b ** 2.2, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    if emission_strength > 0.0:
        try:
            bsdf.inputs["Emission Color"].default_value = (r ** 2.2, g ** 2.2, b ** 2.2, 1.0)
            bsdf.inputs["Emission Strength"].default_value = emission_strength
        except KeyError:
            pass
    return mat


def _build_caldera_rim(scene) -> bpy.types.Object:
    """Procedural caldera ring built with bmesh — a 96-segment basalt
    band whose inner face tilts inward by ~10 m radial offset over its
    5 m vertical span. Output is one collidable mesh tagged
    ``kind = "track"`` so the runtime trimesh attacher treats the outer
    face as a collidable wall the bike can slap into on a bad line.

    Geometry: 4 vertex rings per segment column.
      ring_top_outer:    z = z0 + H,  r = outer
      ring_top_inner:    z = z0 + H,  r = inner_top
      ring_bottom_inner: z = z0,      r = inner_bottom
      ring_bottom_outer: z = z0,      r = outer
    The inner face slopes outward as we go up, so the inside of the
    bowl banks the bike toward the caldera centre — the same read the
    anti-grav strip enforces physically.
    """
    cx, cy, cz = CALDERA_CENTRE
    z_bottom = cz - CALDERA_HEIGHT_M * 0.5
    z_top = cz + CALDERA_HEIGHT_M * 0.5
    n = CALDERA_SEGMENTS

    bm = bmesh.new()

    # Four rings of n verts each, stored as flat lists for face-building.
    ring_TO: list[bmesh.types.BMVert] = []  # top outer
    ring_TI: list[bmesh.types.BMVert] = []  # top inner
    ring_BI: list[bmesh.types.BMVert] = []  # bottom inner
    ring_BO: list[bmesh.types.BMVert] = []  # bottom outer
    for i in range(n):
        theta = (i / n) * math.tau
        c, s = math.cos(theta), math.sin(theta)
        ring_TO.append(bm.verts.new((
            cx + c * CALDERA_OUTER_R_M,
            cy + s * CALDERA_OUTER_R_M,
            z_top,
        )))
        ring_TI.append(bm.verts.new((
            cx + c * CALDERA_INNER_R_TOP_M,
            cy + s * CALDERA_INNER_R_TOP_M,
            z_top,
        )))
        ring_BI.append(bm.verts.new((
            cx + c * CALDERA_INNER_R_BOTTOM_M,
            cy + s * CALDERA_INNER_R_BOTTOM_M,
            z_bottom,
        )))
        ring_BO.append(bm.verts.new((
            cx + c * CALDERA_OUTER_R_M,
            cy + s * CALDERA_OUTER_R_M,
            z_bottom,
        )))

    # Faces — wrap by modulo so the ring closes cleanly.
    # Each column has 4 quads: top cap, outer wall, inner wall, bottom cap.
    for i in range(n):
        j = (i + 1) % n
        # Top cap quad (TO_i, TO_j, TI_j, TI_i) — winding so the +Z face
        # points up (visible from above).
        bm.faces.new([ring_TO[i], ring_TO[j], ring_TI[j], ring_TI[i]])
        # Outer wall (TO_j, TO_i, BO_i, BO_j) — visible from outside.
        bm.faces.new([ring_TO[j], ring_TO[i], ring_BO[i], ring_BO[j]])
        # Inner wall — slopes inward as we go down (TI_i, TI_j, BI_j, BI_i)
        # so the inside-of-bowl face is visible from the caldera centre.
        bm.faces.new([ring_TI[i], ring_TI[j], ring_BI[j], ring_BI[i]])
        # Bottom cap (BO_j, BI_j, BI_i, BO_i) — winding so −Z face points
        # down. Bike never sees this; kept for closed-mesh sanity.
        bm.faces.new([ring_BO[j], ring_BI[j], ring_BI[i], ring_BO[i]])

    bm.normal_update()
    mesh = bpy.data.meshes.new("kilauea_caldera_rim_mesh")
    bm.to_mesh(mesh)
    bm.free()

    mat_basalt = _ensure_material("mat_kilauea_basalt", "#1c1815", roughness=0.85)
    mat_basalt_warm = _ensure_material(
        "mat_kilauea_basalt_warm", "#3a2620", roughness=0.7, emission_strength=0.0,
    )
    mesh.materials.append(mat_basalt)
    mesh.materials.append(mat_basalt_warm)

    obj = bpy.data.objects.new("kilauea_caldera_rim", mesh)
    obj["kind"] = "track"   # outer face is collidable per ExportedKind.TRACK
    obj["hb_landmark"] = "caldera_rim"
    obj.location = (0.0, 0.0, 0.0)
    scene.collection.objects.link(obj)
    print(
        f"  caldera rim       → {obj.name} @ centre={CALDERA_CENTRE} "
        f"R_outer={CALDERA_OUTER_R_M}m R_inner_top={CALDERA_INNER_R_TOP_M}m "
        f"R_inner_bot={CALDERA_INNER_R_BOTTOM_M}m H={CALDERA_HEIGHT_M}m"
    )
    return obj


# ────────────────────────────────────────────────────────────────────
# Library-linked landmark — lava waterfall strip
# ────────────────────────────────────────────────────────────────────


def _link_collection(library_path: str, collection_name: str) -> bpy.types.Collection | None:
    """Link ``collection_name`` from ``library_path`` into the current
    scene. Mirrors ``seed_track_south_beach_sunken._link_collection``.
    Idempotent — repeated calls return the existing linked datablock."""
    existing = bpy.data.collections.get(collection_name)
    if existing is not None and existing.library is not None:
        return existing
    if not os.path.isfile(library_path):
        print(f"  WARN: library not found, skipping link: {library_path}")
        return None
    with bpy.data.libraries.load(library_path, link=True) as (data_from, data_to):
        if collection_name not in data_from.collections:
            print(f"  WARN: {collection_name!r} not in {library_path}, skipping")
            return None
        data_to.collections = [collection_name]
    return bpy.data.collections.get(collection_name)


def _spawn_instance(
    coll: bpy.types.Collection,
    name: str,
    location: tuple[float, float, float],
    rotation_euler: tuple[float, float, float] = (0.0, 0.0, 0.0),
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
    kind: str = "decoration",
) -> bpy.types.Object:
    """Collection-instance empty referencing ``coll`` — drops the
    landmark archetype at world coords without copying its geometry."""
    inst = bpy.data.objects.new(name, None)
    inst.instance_type = "COLLECTION"
    inst.instance_collection = coll
    inst.empty_display_size = 1.0
    inst.location = location
    inst.rotation_euler = rotation_euler
    inst.scale = scale
    inst["kind"] = kind
    bpy.context.scene.collection.objects.link(inst)
    return inst


def _spawn_lava_waterfall(scene) -> bpy.types.Object | None:
    """One ``landmark_lava_river_strip`` library-linked instance shaped
    into the leeward-side lava waterfall. The archetype ships as a
    flat 60 m × 4 m strip oriented along +X; we scale X 2.0× and
    Y 1.5× to land at the brief's 120 m × 6 m channel size.

    Placed on the leeward descent so the channel runs roughly from the
    SE rim exit (anchor 11 area) down toward the lava-lake shore
    (anchor 15 area). The strip is rotated to follow the descent's
    bearing and tilted in pitch so it visually pours from rim height
    (~45 m) down to sea level. Tagged ``kind = "decoration"`` — the
    bike rides ALONGSIDE the channel, not on it; runtime treats the
    strip as render-only.

    Returns the instance empty, or None if the landmarks library is
    unavailable.
    """
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_lava_river_strip")
    if coll is None:
        return None

    # Descent vector: from a point ~10 m offset from the SE rim
    # (anchor 11 at ~(71, -71, 45)) down to the lava-lake shore
    # (~(330, -340, -2)). Offset perpendicular to the racing line so
    # the channel runs ALONGSIDE, not on top of it.
    rim_exit = mathutils.Vector((71.0, -71.0, 45.0))
    shore = mathutils.Vector((330.0, -340.0, -2.0))
    descent = shore - rim_exit
    horizontal = mathutils.Vector((descent.x, descent.y, 0.0))
    horizontal_len = horizontal.length or 1.0
    # Lateral offset of 18 m to the +Y side of the descent (player rides
    # on the road, lava sits beside them to the left).
    lateral = mathutils.Vector((-descent.y, descent.x, 0.0)) / horizontal_len * 18.0
    midpoint = (rim_exit + shore) * 0.5 + lateral

    # Strip is authored along +X local; rotate around world Z so local
    # +X aligns with the descent's horizontal projection. The pitch
    # tilt (around the strip's local Y) drops the downhill end so the
    # strip reads as a flow rather than a flat ribbon.
    yaw = math.atan2(descent.y, descent.x)
    pitch = -math.atan2(descent.z, horizontal_len)  # negative = downward

    # Scales: 120 m × 6 m × default thickness. Strip Z=0 in source so
    # the Z scale doesn't matter, but keep it 1 for consistency.
    inst = _spawn_instance(
        coll,
        name="kilauea_lava_waterfall",
        location=(midpoint.x, midpoint.y, midpoint.z),
        rotation_euler=(0.0, pitch, yaw),
        scale=(2.0, 1.5, 1.0),
        kind="decoration",
    )
    inst["hb_landmark"] = "lava_waterfall"
    inst["set_piece"] = "black_beach"
    print(
        f"  lava waterfall    → {inst.name} @ {tuple(round(c, 1) for c in inst.location)} "
        f"yaw={math.degrees(yaw):.0f}° pitch={math.degrees(pitch):.0f}° "
        f"scale=(2.0, 1.5, 1.0) → ~120 m × 6 m"
    )
    return inst


# ────────────────────────────────────────────────────────────────────
# Anti-grav banked-strip — closed-loop circle around the caldera rim
# ────────────────────────────────────────────────────────────────────

# Anti-grav ribbon — closed Bezier circle around the caldera rim.
# 12 control points evenly distributed gives a smooth circle without
# ringing artefacts. Radius matches the caldera-rim outer edge so the
# ribbon sits in the rim plane (z=45 m) on the inside of the bowl.
ANTIGRAV_LOOP_RADIUS_M = 100.0
ANTIGRAV_LOOP_Z_M = 45.0
ANTIGRAV_LOOP_CONTROL_POINTS = 12
ANTIGRAV_STRIP_WIDTH_M = 10.0
ANTIGRAV_STRIP_THICKNESS_M = 0.5
# The rim is banked INWARD — toward the caldera centre. For a
# BANKED_STRIP profile that means the strip tilts around its tangent
# so its "up" leans toward the centre. The curve's parallel-transport
# frame has its normal pointing roughly outward / upward at a sample
# on a horizontal CCW circle, so a positive tilt of ~+π/4 (45°)
# banks the strip inward — bike clings to the inside of the bowl.
ANTIGRAV_STRIP_TILT_RAD = math.pi / 4.0
ANTIGRAV_LOOP_SAMPLES = 192   # smooth read at race speed around the full circle
ANTIGRAV_LOOP_SEGMENTS = 16   # ignored for BANKED_STRIP but threaded through API


def _antigrav_loop_control_points() -> list[tuple[float, float, float]]:
    """12 (x, y, z) anchors evenly distributed around a horizontal
    circle of radius ANTIGRAV_LOOP_RADIUS_M at z=ANTIGRAV_LOOP_Z_M.
    Start angle 0° (east) so the loop's "front" matches the spline's
    east-rim entry — handy mental model when debugging in the viewport.
    """
    points: list[tuple[float, float, float]] = []
    n = ANTIGRAV_LOOP_CONTROL_POINTS
    for i in range(n):
        theta = (i / n) * math.tau
        x = math.cos(theta) * ANTIGRAV_LOOP_RADIUS_M
        y = math.sin(theta) * ANTIGRAV_LOOP_RADIUS_M
        points.append((x, y, ANTIGRAV_LOOP_Z_M))
    return points


def _add_antigrav_caldera_loop(scene) -> bool:
    """Programmatically create ``antigrav_curve_00`` (a closed Bezier
    with 12 AUTO-handle control points sweeping a circle around the
    caldera rim) and call ``build_antigrav_ribbon_from_curve`` with the
    BANKED_STRIP profile to sweep an inward-banked anti-grav strip
    around the full ring.

    The curve is **closed** (``spline_obj.use_cyclic_u = True``) so the
    sweep meets cleanly at the seam. Per-control-point tilt is set to
    a constant +π/4 so the strip banks uniformly inward around the
    whole circle — this is exactly the read the brief asks for
    ("rim is banked inward, you ride the inside of the bowl").

    Returns True on success, False (with a console warning) if
    antigrav_ribbon isn't reachable. Mirrors the corkscrew pattern in
    ``seed_track_hatteras_light.py::_add_antigrav_corkscrew`` with the
    profile + closed-loop tweaks for this track.
    """
    # 1. Create the Bezier curve directly.
    curve_data = bpy.data.curves.new("antigrav_curve_00", type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 32  # smooth caldera-rim sample
    spline_obj = curve_data.splines.new(type="BEZIER")
    cps = _antigrav_loop_control_points()
    spline_obj.bezier_points.add(len(cps) - 1)  # 1 implicit + N-1 new
    for bp, (x, y, z) in zip(spline_obj.bezier_points, cps):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
        # Per-control-point tilt drives BANKED_STRIP — constant +π/4
        # around the loop banks the strip uniformly inward.
        bp.tilt = ANTIGRAV_STRIP_TILT_RAD
    # Closed loop — joins control point N-1 back to 0 so the swept
    # strip meets cleanly at the seam (no gap on the east-rim entry).
    spline_obj.use_cyclic_u = True

    curve_obj = bpy.data.objects.new("antigrav_curve_00", curve_data)
    curve_obj["kind"] = "antigrav_curve"
    scene.collection.objects.link(curve_obj)

    # 2. Sweep the banked strip. Public entry from antigrav_ribbon so
    # we don't need GUI context. Falls back to the operator if the
    # direct import path isn't reachable.
    try:
        from hoverbike_addon.antigrav_ribbon import (
            build_antigrav_ribbon_from_curve,
            PROFILE_BANKED_STRIP,
        )
    except ImportError:
        try:
            result = bpy.ops.hoverbike.build_antigrav_surface()
            if "FINISHED" in result:
                return True
        except (AttributeError, RuntimeError) as e:
            print(
                f"[seed-track-kilauea-crown] WARN: antigrav_ribbon not "
                f"reachable headless ({e}); curve placed but not swept. "
                "Open the .blend, select antigrav_curve_00, click "
                "'Build Anti-Grav Surface' (profile = Banked strip)."
            )
            return False
        return False

    build_antigrav_ribbon_from_curve(
        scene,
        curve_obj,
        profile=PROFILE_BANKED_STRIP,
        width=ANTIGRAV_STRIP_WIDTH_M,
        thickness=ANTIGRAV_STRIP_THICKNESS_M,
        radius=ANTIGRAV_STRIP_WIDTH_M,  # ignored for BANKED_STRIP, threaded for API
        samples=ANTIGRAV_LOOP_SAMPLES,
        segments=ANTIGRAV_LOOP_SEGMENTS,
    )
    return True


# ────────────────────────────────────────────────────────────────────
# Wave zone — the lava boils the water at the black-sand shore
# ────────────────────────────────────────────────────────────────────

# Wave zone covering the lava-lake shore where the leeward descent
# meets the new shoreline. Reads as "the lava boils the water locally".
# Moderate intensity per the brief — height_mult 1.3 isn't a wave-
# mastery teach moment (the caldera loop is the hero), it's a flavour
# beat for the set-piece's final beat.
LAVA_BEACH_WAVE = {
    "name": "wave_zone_00",
    "display_name": "wave_zone_lava_beach",
    "position": (330.0, -340.0, 0.0),
    "rotation_deg": 35.0,           # swell direction roughly parallel to the descent vector
    "half_width": 80.0,             # along local +X (swell direction)
    "half_height": 30.0,
    "half_depth": 60.0,             # cross-swell
    "height_mult": 1.3,
    "freq_mult": 1.0,
    "blend_radius_m": 25.0,
}


def _spawn_lava_beach_wave_zone(scene) -> bpy.types.Object:
    """Stamp the single lava-beach wave zone. Mirrors the wave_zone
    empty contract in ``hoverbike_addon.wave_zone`` so the addon's
    gizmo + export pass round-trip cleanly."""
    z = LAVA_BEACH_WAVE
    obj = bpy.data.objects.new(z["name"], None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 6.0
    obj["kind"] = "wave_zone"
    obj["display_name"] = z["display_name"]
    obj["half_width"] = float(z["half_width"])
    obj["half_height"] = float(z["half_height"])
    obj["half_depth"] = float(z["half_depth"])
    obj["height_mult"] = float(z["height_mult"])
    obj["freq_mult"] = float(z["freq_mult"])
    obj["blend_radius_m"] = float(z["blend_radius_m"])
    obj.location = z["position"]
    obj.rotation_euler = (0.0, 0.0, math.radians(z["rotation_deg"]))
    scene.collection.objects.link(obj)
    print(
        f"  wave zone (lava)  → {obj.name} @ {tuple(round(c, 1) for c in obj.location)} "
        f"× ({z['half_width']}×{z['half_depth']}), height_mult={z['height_mult']}"
    )
    return obj


# ────────────────────────────────────────────────────────────────────
# Pickups + boost pads + hero camera
# ────────────────────────────────────────────────────────────────────

# Six pickups along the racing line. One sits mid-anti-grav at caldera-
# rim altitude (z=45) so the loop has a temptation; the other five
# distribute across the climb, descent, and recovery.
PICKUP_POSITIONS: tuple[tuple[str, float, float, float], ...] = (
    ("pickup_00",  400.0,   40.0, 1.0),   # start straight
    ("pickup_01",  240.0,   85.0, 22.0),  # mid-windward climb
    ("pickup_02",    0.0,  100.0, 48.0),  # mid-rim at caldera-rim altitude (anti-grav apex)
    ("pickup_03", -100.0,    0.0, 48.0),  # west rim apex
    ("pickup_04",  220.0, -250.0, 14.0),  # leeward descent mid
    ("pickup_05",  460.0, -240.0,  1.0),  # recovery straight
)

# Boost pads — one rewards committing to the windward climb (placed on
# the early ascent where pumping the gas matters), one rewards the
# recovery straight back into the start (carry speed into the climb).
BOOST_PADS: tuple[tuple[str, float, float, float, float, float, float], ...] = (
    # (name, x, y, z, half_width, half_depth, yaw_deg)
    # Boost yaw aims along the local racing-line tangent. Ascent
    # heading is roughly NW (≈ -25° from -X), recovery heading is
    # roughly N (≈ +90° world Y from world X).
    ("boost_00", 330.0,   70.0,  9.0, 3.5, 7.0, 155.0),  # windward ascent — commit to the climb
    ("boost_01", 470.0, -240.0,  0.5, 3.5, 7.0,  95.0),  # recovery straight — carry speed back
)


def _drop_pickups(scene) -> int:
    """Six ``pickup_NN`` empties tagged ``kind = "pickup_spawn"`` — NOT
    ``"pickup"``. Auto-tag would correct on next scene update but we
    set the kind explicitly so a headless seed run is correct even
    without the depsgraph callback firing."""
    for name, x, y, z in PICKUP_POSITIONS:
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 2.0
        obj["kind"] = "pickup_spawn"
        obj.location = (x, y, z)
        scene.collection.objects.link(obj)
    return len(PICKUP_POSITIONS)


def _drop_boost_pads(scene) -> int:
    """Two ``boost_NN`` empties. Each carries ``strength = 1.5`` plus
    half_width / half_depth / rotation_z per the kind-registry
    contract — the missing strength is the gotcha that bit the
    Reef Cup seeds before."""
    for name, x, y, z, hw, hd, yaw_deg in BOOST_PADS:
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 4.0
        obj["kind"] = "boost_pad"
        obj["half_width"] = hw
        obj["half_depth"] = hd
        obj["strength"] = 1.5
        obj.location = (x, y, z)
        obj.rotation_euler = (0.0, 0.0, math.radians(yaw_deg))
        scene.collection.objects.link(obj)
    return len(BOOST_PADS)


# Hero camera — parked offshore SE of the lava-beach shore so the
# frame walks lava waterfall → caldera silhouette → steam plumes in
# left-to-right composition against tropical sky. 35 mm for tropical-
# bright depth (same as Hatteras Light's Atlantic loneliness lens).
CAMERA_HERO_LOCATION = (470.0, -460.0, 40.0)
CAMERA_HERO_TARGET = (150.0, -180.0, 30.0)   # mid-waterfall, frames caldera behind
CAMERA_HERO_FOCAL_MM = 35.0


def _add_camera_hero(scene) -> bpy.types.Object:
    """Drop ``camera_hero`` SE of the shoreline looking NW. 35 mm
    wide-angle to fit the waterfall + caldera silhouette + steam
    plumes in one frame, framed against the tropical-bright sky."""
    cam_data = bpy.data.cameras.new("camera_hero")
    cam_data.lens = CAMERA_HERO_FOCAL_MM
    cam_data.clip_start = 0.1
    cam_data.clip_end = 5000.0

    obj = bpy.data.objects.new("camera_hero", cam_data)
    obj["kind"] = "camera_hero"
    obj.location = CAMERA_HERO_LOCATION

    target = mathutils.Vector(CAMERA_HERO_TARGET)
    delta = target - mathutils.Vector(CAMERA_HERO_LOCATION)
    if delta.length > 1e-4:
        obj.rotation_euler = delta.to_track_quat("-Z", "Y").to_euler()

    scene.collection.objects.link(obj)
    print(
        f"  camera_hero       → @ {tuple(round(c, 1) for c in obj.location)} "
        f"→ {tuple(round(c, 1) for c in CAMERA_HERO_TARGET)} ({CAMERA_HERO_FOCAL_MM} mm)"
    )
    return obj


# ────────────────────────────────────────────────────────────────────
# JSON merge — sky / audio / wave / anti-grav blocks
# ────────────────────────────────────────────────────────────────────
#
# The brief asks for sky + audio + waveZones + antiGravZones blocks
# specific to Kilauea. The track-export operator writes the GLB-derived
# JSON (start, checkpoints, splines, pickups, boosts, wave zones, anti-
# grav zones) but it does NOT author sky / audio fields — those come
# from a per-track stub we merge after the export pass. This function
# loads any sky / audio block already in the JSON (idempotent
# behaviour) and overwrites them with the Kilauea palette, then re-
# saves the JSON so the runtime picks them up on next load.


KILAUEA_SKY = {
    "tint": "#fff2dd",
    "cloudiness": 0.4,
    "sunIntensity": 1.2,
    "fogNear": 600.0,
    "fogFar": 2400.0,
    "timeOfDay": 50.0,
    "colorGrade": "kilauea_volcanic",
    "bloom": 0.5,
    "seaStateBeaufort": 3,
}


KILAUEA_AUDIO = {
    "ambient": [
        "volcano-rumble.opus",
        "surf-light.opus",
        "jungle-birds.opus",
    ],
    "ambientGains": [0.5, 0.45, 0.3],
    "music3dEffects": {
        "duckOnPump": 0.3,
    },
}


def _merge_track_json() -> None:
    """Merge the per-track sky / audio blocks into the exported JSON.
    The export operator writes the runtime fields (start, checkpoints,
    pickups, etc.); this function rewrites only the sky / audio entries
    so re-running the seed converges to the same JSON without losing
    the export's gameplay state.

    Wave zones + anti-grav zones already round-trip through the export
    via the wave_zone_NN / antigrav_NN_zone_* empties in the .blend,
    so we don't re-author them here; they appear in the JSON because
    the export pass picked them up."""
    import json
    json_path = os.path.join(REPO_ROOT, "public", "tracks", f"{SPEC.track_id}.json")
    if not os.path.isfile(json_path):
        # Export must have failed; nothing to merge into.
        print(f"  WARN: {json_path} not found post-export; sky/audio merge skipped.")
        return
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["sky"] = KILAUEA_SKY
    data["audio"] = KILAUEA_AUDIO
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"  JSON merged       → {json_path} (sky + audio overrides)")


# ────────────────────────────────────────────────────────────────────
# Top-level augmentation orchestrator
# ────────────────────────────────────────────────────────────────────


def augment_scene() -> None:
    """Layer the caldera ring + lava waterfall + anti-grav loop +
    lava-beach wave zone + pickups + boost pads + hero camera onto
    the road-built scene. Called after ``build_track_from_spec``
    returns — at that point ``terrain``, ``ai_spline_main``, the road
    mesh and the start/checkpoint empties are placed."""
    tag = "[seed-track-kilauea-crown]"
    print(f"{tag} augmenting scene with caldera + waterfall + anti-grav + lava beach")
    scene = bpy.context.scene

    _build_caldera_rim(scene)
    _spawn_lava_waterfall(scene)
    loop_ok = _add_antigrav_caldera_loop(scene)
    if loop_ok:
        print(f"{tag}   anti-grav caldera loop surface built")
    else:
        print(f"{tag}   anti-grav caldera curve placed (sweep deferred)")
    _spawn_lava_beach_wave_zone(scene)
    pickups = _drop_pickups(scene)
    boosts = _drop_boost_pads(scene)
    _add_camera_hero(scene)
    print(f"{tag}   {pickups} pickups + {boosts} boost pads")

    # Save the .blend with augmentation in place so the next manual
    # *Export Track to Game* picks up the new objects.
    output_blend = os.path.join(REPO_ROOT, "tracks-src", f"{SPEC.track_id}.blend")
    print(f"{tag} saving {output_blend}")
    bpy.ops.wm.save_as_mainfile(filepath=output_blend)

    # Re-export so the GLB picks up the augmentation (caldera, waterfall,
    # anti-grav surface, wave zone, pickups, boost pads, hero camera)
    # and the JSON merges the wave/anti-grav zone blocks. Without this
    # step the GLB only matches the post-build state.
    print(f"{tag} re-exporting GLB + JSON + manifest")
    result = bpy.ops.hoverbike.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(
            f"{tag} export_track (post-augment) failed: {result}"
        )

    # Merge per-track JSON overrides (sky + audio) on top of the
    # exported JSON so the runtime sees the Kilauea palette next load.
    _merge_track_json()


if __name__ == "__main__":
    try:
        build_track_from_spec(SPEC)
        augment_scene()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-kilauea-crown] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
