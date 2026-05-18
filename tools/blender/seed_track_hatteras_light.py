"""Build ``tracks-src/hatteras-light.blend`` + GLB/JSON exports.

Run (after ``seed_template_island.py`` + ``seed_landmarks_library.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_hatteras_light.py

Reshape: a wider racetrack-oval loop around Cape Hatteras lighthouse on
open Atlantic. The southern half of the lap dips toward the lighthouse
base where the anti-grav corkscrew climbs up the outside of the spiral
to the open lamp room. Authoring is driven by ``track_build_lib``.

Reef Cup race #2. Lap target 50 s @ ~25 m/s → ~1250 m arc length. The
outer oval half-axes are ~190 m (E-W) × ~170 m (N-S); the last quarter
of the loop dips inward to the lighthouse to fit the corkscrew climb,
giving a 3-D arc length of ~1262 m → 50.5 s at lap pace.

After the spec-driven build returns, this script augments the .blend
with:

  * the lighthouse mesh (``build_tower_cylinder_spiral_mesh`` from
    ``seed_landmarks_library``, ``stripe_pattern="spiral"``,
    ``aperture=True``). Scaled to ~50 m tall; placed at the origin with
    a -15 m drop so the bottom third sits underwater (sea level y=0).
  * one ``antigrav_curve_00`` Bezier spiralling once around the
    lighthouse from y≈5 to y≈35. Calls
    ``build_antigrav_ribbon_from_curve(..., profile=PROFILE_TUBE)`` to
    sweep the corkscrew tube — the headless code-path that the GUI
    *Build Anti-Grav Surface* operator goes through.
  * three ``wave_zone_NN`` empties — heavy Atlantic chop covering the
    full loop, a calmer pocket on the lighthouse shelter side, and an
    open-swell zone with long rolling waves on the windward side.
  * a ``camera_hero`` camera NE of the lighthouse, looking SW, 35 mm
    lens — wide-angle to capture the loneliness of the Atlantic.
  * 6 pickup empties + 2 boost pads spaced around the loop.

If ``build_antigrav_ribbon_from_curve`` can't be reached (for example
because the addon package failed to register in this Blender session),
the augmentation step prints a warning and continues — the curve and
its zone empties are still authored, so an author can click *Build
Anti-Grav Surface* from the sidebar to finish the corkscrew. Re-running
the seed will pick the tube up the next time the lib is healthy.
"""

from __future__ import annotations

import importlib.util
import math
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))

# track_build_lib uses @dataclass and needs to be visible to typing /
# importlib by the time we reference TrackSpec — mirror the canyon-run /
# alpine-sprint loader pattern verbatim.
spec = importlib.util.spec_from_file_location(
    "track_build_lib", os.path.join(SCRIPT_DIR, "track_build_lib.py"),
)
_lib = importlib.util.module_from_spec(spec)
sys.modules["track_build_lib"] = _lib
spec.loader.exec_module(_lib)

TrackSpec = _lib.TrackSpec
build_track_from_spec = _lib.build_track_from_spec


# ────────────────────────────────────────────────────────────────────
# Track spec — racetrack oval around the lighthouse
# ────────────────────────────────────────────────────────────────────
#
# The oval is centred on the origin (where the lighthouse sits). The
# start straight runs east along the south edge; the corkscrew climb
# sits on the W/SW arc — the last quarter of the loop — so the final
# checkpoint lands mid-climb. Finishing the corkscrew completes the
# checkpoint set, making the climb the narrative climax of the lap.
#
# Half-axes: ~210 m along X, ~185 m along Y. Polyline arc length on
# this oval is ~1253 m — bang on the 1250 m / 50 s lap target at the
# Reef Cup pace of ~25 m/s.

SPEC = TrackSpec(
    track_id="hatteras-light",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-island.blend"),
    spline_anchors=[
        # Start/finish at the south apex; lap runs CCW (east first).
        # First 3/4 stays on the open Atlantic at water level (z=-2).
        # Last 1/4 detours inward toward the lighthouse — the bike runs
        # in past the W apex, over the top of the corkscrew (anchor 10
        # at z=18 m, just above the lamp-room gallery), then drops back
        # out to rejoin the south straight.
        (   0.0, -170.0, -2.0),  # 0  t=0.000  south apex (start)
        (  85.0, -160.0, -2.0),  # 1  t=0.068
        ( 160.0, -100.0, -2.0),  # 2  t=0.144
        ( 190.0,    0.0, -2.0),  # 3  t=0.227  east apex
        ( 160.0,  100.0, -2.0),  # 4  t=0.310
        (  85.0,  160.0, -2.0),  # 5  t=0.386
        (   0.0,  170.0, -2.0),  # 6  t=0.454  north apex
        ( -85.0,  160.0, -2.0),  # 7  t=0.522
        (-160.0,  100.0, -2.0),  # 8  t=0.598  NW
        (-185.0,    0.0, -2.0),  # 9  t=0.680  W apex / corkscrew entry approach
        ( -25.0,  -15.0, 18.0),  # 10 t=0.808  TOP OF CORKSCREW — lamp-room altitude
        ( -85.0, -160.0, -2.0),  # 11 t=0.932  rejoin south straight entry
    ],
    # cp_03 at t=0.81 lands on the mid-corkscrew anchor 10 — hitting
    # the last gate IS hitting the climb apex. cp_00..cp_02 are evenly
    # spaced across the water section (south straight exit, east apex
    # approach, north apex).
    checkpoint_ts=(0.18, 0.40, 0.62, 0.81),
    # Atlantic coastline feel — narrower than South Beach.
    road_width=10.0,
    road_lift=0.35,
    road_blend_radius=6.0,
    road_samples=128,
    road_smooth_passes=5,
    road_curb_width=0.6,
    road_curb_height=0.15,
    road_curb_stripe=2.0,
    road_thickness=0.55,
    gate_spacing_m=65.0,
    water_preview_size=800.0,
    water_preview_subdivisions=140,
)


# ────────────────────────────────────────────────────────────────────
# Post-build augmentation — lighthouse, corkscrew, wave zones, camera
# ────────────────────────────────────────────────────────────────────
#
# Everything below runs after ``build_track_from_spec`` returns, against
# the open .blend file. The lighthouse + corkscrew + wave zones land in
# the same scene so a single ``save_as_mainfile`` at the end preserves
# them. The final export pass is triggered manually so the GLB/JSON pick
# up the new geometry + zones.

# Lighthouse silhouette dimensions — slightly de-scaled from the real
# Cape Hatteras (64 m) so the silhouette reads at race-pace from across
# the oval without dominating the camera.
LIGHTHOUSE_HEIGHT_M = 50.0
LIGHTHOUSE_BASE_R_M = 4.5
LIGHTHOUSE_CAP_R_M = 3.6
LIGHTHOUSE_BASE_Y_M = -15.0   # bottom third submerged at sea level y=0

# Corkscrew geometry. Six Bezier control points wind once (2π) up the
# outside of the lighthouse cylinder. Radius is the lighthouse mid-shaft
# radius plus the antigrav-tube radius plus a small clearance — the tube
# clings to the cylinder face without intersecting it.
#
# Curve z is absolute (world) Blender Z = runtime Y. The lighthouse
# mesh's base sits at world z=-15 and its top reaches world z=+35; the
# corkscrew starts at z=5 (5 m above sea level, well above the
# bottom-third waterline where the bike isn't underwater) and climbs to
# z=35 (lamp-room gallery altitude). Five seconds of climb at lap pace.
CORKSCREW_CONTROL_POINTS = 6
CORKSCREW_RADIUS_M = LIGHTHOUSE_BASE_R_M + 8.0 + 1.5  # 14 m from lighthouse axis
CORKSCREW_Z_MIN_M = 5.0   # world Z (Blender) / world Y (runtime), above water
CORKSCREW_Z_MAX_M = 35.0  # world Z at lamp-room altitude
CORKSCREW_TUBE_RADIUS_M = 8.0  # matches antigrav tool default
CORKSCREW_SAMPLES = 96         # smooth read at race speed


def _corkscrew_control_points() -> list[tuple[float, float, float]]:
    """Six (x, y, z) anchors winding once around the lighthouse axis,
    climbing from CORKSCREW_Z_MIN_M to CORKSCREW_Z_MAX_M. The angle
    sweeps 0 → 2π; the start angle is chosen so the entry sits SE of
    the lighthouse, matching the spline's SE approach.

    Note: Blender is Z-up here in the seed-time world. The seed scripts
    use Z-up coordinates; the glTF exporter rotates to Y-up at export.
    To match what the spline anchors do (they use the runtime Y-up
    convention), this returns (x, y, z) tuples where z is the climb
    axis — Blender's vertical."""
    points: list[tuple[float, float, float]] = []
    # Entry angle: SE of the lighthouse (~-π/4 in world XY). The bike
    # approaches from the SE corkscrew-entry checkpoint, runs once
    # around the lighthouse, and exits at the lamp room on the opposite
    # side of the same approach (~3π/4 + 2π in absolute terms, i.e. one
    # full winding from the entry).
    theta_start = -math.pi / 4.0
    theta_end = theta_start + math.tau
    for i in range(CORKSCREW_CONTROL_POINTS):
        t = i / (CORKSCREW_CONTROL_POINTS - 1)
        theta = theta_start + (theta_end - theta_start) * t
        z = CORKSCREW_Z_MIN_M + (CORKSCREW_Z_MAX_M - CORKSCREW_Z_MIN_M) * t
        x = math.cos(theta) * CORKSCREW_RADIUS_M
        y = math.sin(theta) * CORKSCREW_RADIUS_M
        points.append((x, y, z))
    return points


def _add_lighthouse(scene) -> None:
    """Build the Cape Hatteras lighthouse mesh inline via the landmark
    library's builder, drop it at the origin with its base submerged
    one third (bottom of mesh at y=-15 m, top at y=+35 m). The library
    seeds materials (mat_landmark_white, mat_landmark_stripe,
    mat_landmark_steel) so we instantiate them here too — runtime
    material overrides are a polish-pass concern."""
    import bpy
    # Late-import the library so we don't load it until the addon has
    # registered + the template has loaded. Same pattern as
    # seed_landmarks_showcase.
    if REPO_ROOT not in sys.path:
        sys.path.insert(0, REPO_ROOT)
    from tools.blender import seed_landmarks_library as lib

    # Stripe + white + steel materials — re-create here in case the
    # template doesn't already carry them (template-island doesn't).
    mat_white = lib.make_material(
        "mat_landmark_white", "#d8d6d2", roughness=0.5,
    )
    mat_stripe = lib.make_material(
        "mat_landmark_stripe", "#22231f", roughness=0.6,
    )
    mat_steel = lib.make_material(
        "mat_landmark_steel", "#7b7d80", roughness=0.4,
    )

    mesh = lib.build_tower_cylinder_spiral_mesh(
        "hatteras_lighthouse_mesh",
        height=LIGHTHOUSE_HEIGHT_M,
        r_base=LIGHTHOUSE_BASE_R_M,
        r_cap=LIGHTHOUSE_CAP_R_M,
        stripe_pattern="spiral",
        aperture=True,
    )
    for mat in (mat_white, mat_stripe, mat_steel):
        if mat.name not in mesh.materials:
            mesh.materials.append(mat)

    obj = bpy.data.objects.new("hatteras_lighthouse", mesh)
    obj["kind"] = "track"  # collidable hero geometry
    obj["landmark_id"] = "tower_cylinder_spiral"
    obj.location = (0.0, 0.0, LIGHTHOUSE_BASE_Y_M)
    scene.collection.objects.link(obj)


def _add_antigrav_corkscrew(scene) -> bool:
    """Programmatically create ``antigrav_curve_00`` (a Bezier with 6
    AUTO-handle control points spiralling up the lighthouse) and call
    the headless ``build_antigrav_ribbon_from_curve`` to sweep a TUBE
    surface + stamp the entry/exit zone empties.

    Returns True on success. Returns False (with a console warning) if
    the antigrav_ribbon module isn't reachable — the curve stays in the
    scene so an author can click *Build Anti-Grav Surface* in the
    sidebar to finish the job."""
    import bpy

    # 1. Create the Bezier curve directly. (We don't call the operator
    # ``hoverbike.add_antigrav_curve`` because operators bake in GUI
    # context: ``context.scene.cursor.location`` etc. Programmatic
    # creation is robust headless.)
    curve_data = bpy.data.curves.new("antigrav_curve_00", type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 32  # smooth corkscrew sample
    spline_obj = curve_data.splines.new(type="BEZIER")
    cps = _corkscrew_control_points()
    spline_obj.bezier_points.add(len(cps) - 1)  # 1 implicit + N-1 new
    for bp, (x, y, z) in zip(spline_obj.bezier_points, cps):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    spline_obj.use_cyclic_u = False

    curve_obj = bpy.data.objects.new("antigrav_curve_00", curve_data)
    curve_obj["kind"] = "antigrav_curve"
    scene.collection.objects.link(curve_obj)

    # 2. Sweep the tube. Use the public entry point from antigrav_ribbon
    # rather than the operator so we don't need GUI context. Falls back
    # to the operator if direct import fails.
    try:
        from hoverbike_addon.antigrav_ribbon import (
            build_antigrav_ribbon_from_curve,
            PROFILE_TUBE,
        )
    except ImportError:
        # The track_build_lib loads "hoverbike_addon_disk" under a
        # bespoke module name — the package import path may not be
        # established. Try the operator path as a fallback.
        try:
            result = bpy.ops.hoverbike.build_antigrav_surface()
            if "FINISHED" in result:
                return True
        except (AttributeError, RuntimeError) as e:
            print(
                f"[seed-track-hatteras-light] WARN: antigrav_ribbon not "
                f"reachable headless ({e}); curve placed but not swept. "
                "Open the .blend, select antigrav_curve_00, click "
                "'Build Anti-Grav Surface'."
            )
            return False
        return False

    build_antigrav_ribbon_from_curve(
        scene,
        curve_obj,
        profile=PROFILE_TUBE,
        width=8.0,        # ignored for TUBE
        thickness=0.5,    # ignored for TUBE
        radius=CORKSCREW_TUBE_RADIUS_M,
        samples=CORKSCREW_SAMPLES,
        segments=16,
    )
    return True


# Wave-zone tunings — three Atlantic moods around the lighthouse:
#
# 1. ``wave_zone_atlantic_chop`` — full-loop default chop. height_mult
#    1.4 makes the global field noticeably heavier than the South Beach
#    lagoon's calm.
# 2. ``wave_zone_lighthouse_shelter`` — the water close to the
#    lighthouse breaks against the base; downwind it's calmer. Small
#    inner zone with height_mult 0.8.
# 3. ``wave_zone_open_swell`` — the windward NW quadrant gets long
#    rolling swells (freq_mult 0.8 = longer wavelengths, height_mult
#    1.7 = bigger amplitude). First real wave-reading test in the
#    Reef Cup.
WAVE_ZONES = (
    {
        "name": "wave_zone_atlantic_chop",
        # Full Atlantic over the loop — generously oversized so the
        # blend envelope keeps amplitude continuous past the oval edge.
        "position": (0.0, 0.0, 0.0),
        "rotation_z_deg": 0.0,
        "half_width": 280.0,
        "half_height": 30.0,
        "half_depth": 260.0,
        "height_mult": 1.4,
        "freq_mult": 1.0,
        "blend_radius_m": 40.0,
    },
    {
        "name": "wave_zone_lighthouse_shelter",
        # Tight pocket around the base — water visibly breaks against
        # the spiral and falls calmer immediately downwind.
        "position": (0.0, 0.0, 0.0),
        "rotation_z_deg": 0.0,
        "half_width": 35.0,
        "half_height": 20.0,
        "half_depth": 35.0,
        "height_mult": 0.8,
        "freq_mult": 1.1,
        "blend_radius_m": 18.0,
    },
    {
        "name": "wave_zone_open_swell",
        # Windward NE quadrant — long rolling swell aimed at the
        # lighthouse from offshore. Sits over the NE arc of the loop
        # (anchors 3..5), the first place the player meets the
        # heavy-swell read on their second lap. Rotation 225° aligns
        # local +X with a SW-bearing world direction (swell rolling
        # *toward* the lighthouse).
        "position": (140.0, 0.0, 90.0),
        "rotation_z_deg": 225.0,
        "half_width": 130.0,
        "half_height": 30.0,
        "half_depth": 90.0,
        "height_mult": 1.7,
        "freq_mult": 0.8,
        "blend_radius_m": 30.0,
    },
)


def _add_wave_zones(scene) -> None:
    """Stamp three ``wave_zone_NN`` empties matching the WAVE_ZONES
    spec. Mirrors the pattern in ``hoverbike_addon.wave_zone`` so the
    zones round-trip through the addon's gizmo / export path."""
    import bpy
    for i, z in enumerate(WAVE_ZONES):
        # Use the spec's NN slot (matches export ordering); the runtime
        # cares about the array order, not the name suffix.
        name = f"wave_zone_{i:02d}"
        obj = bpy.data.objects.get(name)
        if obj is None:
            obj = bpy.data.objects.new(name, None)
            scene.collection.objects.link(obj)
        obj.empty_display_type = "CUBE"
        obj.empty_display_size = 6.0
        obj["kind"] = "wave_zone"
        obj["display_name"] = z["name"]
        obj["half_width"] = float(z["half_width"])
        obj["half_height"] = float(z["half_height"])
        obj["half_depth"] = float(z["half_depth"])
        obj["height_mult"] = float(z["height_mult"])
        obj["freq_mult"] = float(z["freq_mult"])
        obj["blend_radius_m"] = float(z["blend_radius_m"])
        obj.location = z["position"]
        obj.rotation_euler = (0.0, 0.0, math.radians(z["rotation_z_deg"]))

    # Refresh the visual box gizmos so a follow-up Blender session opens
    # the .blend with the zones already drawn.
    try:
        from hoverbike_addon.wave_zone import refresh_wave_zone_gizmos
        refresh_wave_zone_gizmos(scene)
    except ImportError:
        pass


def _add_camera_hero(scene) -> None:
    """Drop the ``camera_hero`` Camera NE of the lighthouse, looking
    SW. 35 mm lens — wider than the 50 mm default — so the frame
    captures the lighthouse silhouette against a wide swath of fog.

    The thumbnail render reads ``kind=camera_hero`` to find this; the
    runtime ignores it (it's pure authoring metadata)."""
    import bpy
    import mathutils

    name = "camera_hero"
    existing = bpy.data.objects.get(name)
    if existing is not None:
        # Idempotent re-runs: nuke the prior camera so the seed is the
        # source of truth.
        cam_data = existing.data if isinstance(existing.data, bpy.types.Camera) else None
        bpy.data.objects.remove(existing, do_unlink=True)
        if cam_data is not None and cam_data.users == 0:
            bpy.data.cameras.remove(cam_data)

    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = 35.0  # wide — Atlantic loneliness
    cam_data.clip_start = 0.1
    cam_data.clip_end = 5000.0

    obj = bpy.data.objects.new(name, cam_data)
    obj["kind"] = "camera_hero"
    # NE of the lighthouse, ~200 m back, ~55 m up. The 35 mm lens at
    # this distance frames the full lighthouse spiral with a generous
    # band of fog/horizon around it. Aim at the lamp-room centre
    # (lighthouse top is at world z=35 m; gallery centre ≈ z=20 m).
    cam_pos = mathutils.Vector((150.0, 140.0, 55.0))
    obj.location = cam_pos
    target = mathutils.Vector((0.0, 0.0, 20.0))
    direction = target - cam_pos
    # Blender cameras look down their local -Z; ``to_track_quat('-Z','Y')``
    # builds a rotation aiming -Z at the target with +Y as up.
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(obj)


# Pickup empties + boost pads. Six pickups along the loop give riders a
# steady drip of items per lap (~one every 8 seconds at lap pace). Two
# boost pads — one before the east apex (rewards the line that holds
# the outside), one on the corkscrew approach (commits to the climb).
PICKUP_POSITIONS = (
    (  90.0, -150.0, -2.0),  # south straight exit
    ( 175.0,  -50.0, -2.0),  # SE
    ( 175.0,   50.0, -2.0),  # NE
    (  90.0,  150.0, -2.0),  # north straight entry
    ( -90.0,  150.0, -2.0),  # north straight exit
    ( -25.0,  -15.0, 18.0),  # mid-corkscrew (lamp-room altitude)
)
BOOST_PAD_POSITIONS = (
    ( 130.0,  -75.0, -2.0),  # SE — into the east apex
    (-160.0,  -50.0,  0.0),  # corkscrew approach — commit to the climb
)


def _add_pickups_and_boosts(scene) -> None:
    """Drop pickup_NN empties + boost_NN empties at the configured
    positions. The addon's export pass walks these (``kind=pickup_spawn`` /
    ``kind=boost_pad``) into the JSON ``pickupSpawns`` / ``boostPads``
    arrays. Kind values + extras must match the addon's validator in
    ``track_meta.py::validate_track_scene`` — boost pads need
    ``strength`` per the kind registry contract."""
    import bpy
    for i, pos in enumerate(PICKUP_POSITIONS):
        name = f"pickup_{i:02d}"
        obj = bpy.data.objects.get(name)
        if obj is None:
            obj = bpy.data.objects.new(name, None)
            scene.collection.objects.link(obj)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 2.0
        obj["kind"] = "pickup_spawn"
        obj.location = pos
    for i, pos in enumerate(BOOST_PAD_POSITIONS):
        name = f"boost_{i:02d}"
        obj = bpy.data.objects.get(name)
        if obj is None:
            obj = bpy.data.objects.new(name, None)
            scene.collection.objects.link(obj)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 4.0
        obj["kind"] = "boost_pad"
        obj["half_width"] = 4.0
        obj["half_depth"] = 4.0
        obj["strength"] = 1.5
        obj.location = pos
        # Aim boost along the spline tangent at this point — for now
        # leave at world-Z up; an author tunes per-pad direction in the
        # sidebar. (Track_meta export reads rotation_euler.)
        obj.rotation_euler = (0.0, 0.0, 0.0)


# ────────────────────────────────────────────────────────────────────
# Entry point
# ────────────────────────────────────────────────────────────────────


def _augment_and_reexport() -> None:
    """Open .blend → drop lighthouse + corkscrew + wave zones + camera
    + pickups → save → re-export the GLB/JSON so the new geometry +
    zones are picked up. The track_build_lib already invokes
    ``hoverbike.export_track`` once; we re-run it after our edits."""
    import bpy

    scene = bpy.context.scene
    output_blend = os.path.join(REPO_ROOT, "tracks-src", "hatteras-light.blend")

    print("[seed-track-hatteras-light] dropping lighthouse")
    _add_lighthouse(scene)

    print("[seed-track-hatteras-light] dropping anti-grav corkscrew")
    corkscrew_ok = _add_antigrav_corkscrew(scene)
    if corkscrew_ok:
        print("[seed-track-hatteras-light]   corkscrew surface built")
    else:
        print("[seed-track-hatteras-light]   corkscrew curve placed (sweep deferred)")

    print("[seed-track-hatteras-light] stamping wave zones")
    _add_wave_zones(scene)

    print("[seed-track-hatteras-light] adding camera_hero")
    _add_camera_hero(scene)

    print("[seed-track-hatteras-light] adding pickups + boost pads")
    _add_pickups_and_boosts(scene)

    print(f"[seed-track-hatteras-light] saving {output_blend}")
    bpy.ops.wm.save_as_mainfile(filepath=output_blend)

    # Re-export so the GLB picks up the new objects + the JSON picks up
    # the wave / anti-grav zones. The lint pass runs again inside the
    # export operator.
    print("[seed-track-hatteras-light] re-exporting GLB + JSON + manifest")
    result = bpy.ops.hoverbike.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(
            f"[seed-track-hatteras-light] export_track (post-augment) failed: {result}"
        )


if __name__ == "__main__":
    try:
        build_track_from_spec(SPEC)
        _augment_and_reexport()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-hatteras-light] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
