"""Build ``tracks-src/sandbar.blend`` + GLB/JSON exports.

Run via:
    pnpm seed:track-sandbar

(equivalent to invoking
``"C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
   --background --python tools/blender/seed_track_sandbar.py``)

This is the **tutorial track** — the first track a new player touches.
Per ``docs/track-themes.md`` § Sandbar: a fictional sheltered training
cove on a retrofitted post-flood marina. Calm water, small island, one
ramp area, one anti-grav arch, single 60-second scripted lap that
teaches one mechanic per beat (throttle → swell pumping → drift
corner → pickup grab → ramp jump → anti-grav arch).

Reshape: a small asymmetric loop tucked into the south-west quadrant
of ``template-island.blend``. Polyline arc length ≈ 1530 m → ~61 s at
25 m/s, with the racing-line bow making the curve a touch longer in
practice. Generous road width (13 m) and gate spacing (50 m) so the
beats land in the right rhythm without crowding.

Authoring is driven by ``track_build_lib`` for the spline + road + snap
+ export pipeline; this script then augments the resulting .blend with
the per-beat empties (one wave zone, one anti-grav zone, four pickups,
one boost pad, one camera_hero) and the warm pastel sky preset before
re-firing the addon's export so the freshly authored objects make it
into the JSON. Audio metadata is non-Blender-owned and is merged into
the JSON via a final post-pass — paths are forward-looking and 404
gracefully until the licensed assets land.
"""

from __future__ import annotations

import importlib.util
import json
import math
import os
import sys

import bpy

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
_sample_anchor_polyline_at_t = _lib._sample_anchor_polyline_at_t


# ────────────────────────────────────────────────────────────────────
# Spec — the spline, road, gate cadence
# ────────────────────────────────────────────────────────────────────

# Cove shape: a kidney-bean loop hugging the SE/E/N/W of the island
# template, leaving the inner island as the "land" and the surrounding
# basin as the cove water. Anchor Z = -2 (just below the island's
# starting altitude); the snap-to-terrain pass pushes the racing line
# onto whatever surface is beneath each sample.
#
# The set-piece beats (one mechanic per ~10 s) map to these spline t
# bands; the wave_zone / anti-grav / pickup / boost / camera empties
# below get positioned by sampling the polyline at the band centres.
#
#   t ≈ 0.00 → start straight ........ throttle teaching
#   t ≈ 0.18 → E shoulder ............ first swell + pump prompt
#   t ≈ 0.48 → E apex ................ drift corner
#   t ≈ 0.65 → N straight ............ pickup grab
#   t ≈ 0.82 → NW ramp approach ...... ramp jump
#   t ≈ 0.94 → W anti-grav arch ...... anti-grav entry / exit
#
SPLINE_ANCHORS: list[tuple[float, float, float]] = [
    (   0.0, -240.0, -2.0),  # start straight (S of island)
    ( 170.0, -220.0, -2.0),  # SE turn-in (gentle right)
    ( 250.0, -100.0, -2.0),  # E shoulder (swell intro)
    ( 260.0,   20.0, -2.0),  # E apex (drift teaching corner)
    ( 200.0,  130.0, -2.0),  # NE exit
    (  60.0,  210.0, -2.0),  # N pickup zone
    (-110.0,  210.0, -2.0),  # NW straight
    (-220.0,  130.0, -2.0),  # ramp approach
    (-240.0,    0.0, -2.0),  # anti-grav arch crossing (W)
    (-200.0, -120.0, -2.0),  # SW exit
    (-100.0, -220.0, -2.0),  # rejoin start straight
]


SPEC = TrackSpec(
    track_id="sandbar",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-island.blend"),
    spline_anchors=SPLINE_ANCHORS,
    # Checkpoint t-values aligned with the teaching beats — gate 0 just
    # past the first swell, gate 1 just past the drift corner, gate 2
    # in the pickup zone, gate 3 just past the ramp. Lap completes after
    # crossing back through the start at t≈0.
    checkpoint_ts=(0.22, 0.50, 0.70, 0.92),
    # Tutorial-friendly road: wide enough that a new player rarely
    # falls off, low curbs so the surface reads as a beach service road
    # rather than a race-spec track.
    road_width=13.0,
    road_lift=0.25,
    road_blend_radius=8.0,
    road_samples=112,
    road_smooth_passes=5,
    road_curb_width=0.6,
    road_curb_height=0.14,
    road_curb_stripe=2.5,
    road_thickness=0.5,
    # 50 m spacing on a ~1500 m lap → ~30 gate beats — generous; players
    # see lots of gates pass quickly which sells "you're moving fast"
    # without the tight pressure of a 35 m cadence.
    gate_spacing_m=50.0,
    water_preview_size=600.0,
    water_preview_subdivisions=100,
)


# ────────────────────────────────────────────────────────────────────
# Per-beat empties
# ────────────────────────────────────────────────────────────────────


def _sample_xy(t: float) -> tuple[float, float, float]:
    """Convenience over ``_sample_anchor_polyline_at_t`` that returns a
    Z=0 world position. The augment pass uses these to seed empty
    positions; Blender's snap pipeline already ran by the time we get
    here, so absolute Z on a marker empty rarely matters (the runtime
    samples the water surface for the wave zone, and the anti-grav
    zone overrides its own gravity)."""
    (x, y), _tan = _sample_anchor_polyline_at_t(SPLINE_ANCHORS, t)
    return (x, y, 0.0)


def _add_wave_zone_calm(scene) -> bpy.types.Object:
    """Drop a single ``wave_zone_00`` covering the whole cove with
    half the global wave amplitude. The tutorial is the calmest sea
    in the v1 lineup — Beaufort 1 globally, plus a 0.5× multiplier
    inside the cove so the first 60 s of any save file plays on
    glass-flat water that the rest of the cup will then escalate from.

    The zone is sized to comfortably wrap the entire racing line
    (the loop spans roughly ±260 m on X and -240..+230 on Y) with a
    20 m blend radius so the boundary is invisible at the cove's edge.
    """
    obj = bpy.data.objects.new("wave_zone_00", None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 6.0
    obj["kind"] = "wave_zone"
    obj["half_width"] = 320.0
    obj["half_height"] = 30.0
    obj["half_depth"] = 280.0
    obj["height_mult"] = 0.5
    obj["freq_mult"] = 1.0
    obj["blend_radius_m"] = 30.0
    # Centred on the cove (roughly the centroid of the polyline).
    obj.location = (0.0, 0.0, 0.0)
    scene.collection.objects.link(obj)
    return obj


def _add_antigrav_zone(scene) -> bpy.types.Object:
    """Drop ``antigrav_00`` at the W apex (t≈0.94), oriented along the
    racing-line tangent so the bike enters the arch with its forward
    axis aligned. The zone covers a short ~25 m stretch — the arch is
    a single "moment" beat, not a long anti-grav segment, so we don't
    need the full ribbon tool here. Authors who want to swap in a real
    geometry arch later can either keep this zone as the gameplay
    trigger or replace it with a ribbon-built ``kind=track`` mesh.
    """
    obj = bpy.data.objects.new("antigrav_00", None)
    obj.empty_display_type = "ARROWS"
    obj.empty_display_size = 4.0
    obj["kind"] = "antigrav_zone"
    obj["half_width"] = 8.0
    obj["half_height"] = 5.0
    obj["half_depth"] = 12.0

    (x, y), (tx, ty) = _sample_anchor_polyline_at_t(SPLINE_ANCHORS, 0.94)
    # Local +Y of an antigrav zone is the road normal (= world +Z on a
    # flat tutorial track — no banking). Z-yaw rotates the zone so its
    # local +X follows the racing-line tangent, matching the road's
    # forward axis.
    yaw = math.atan2(ty, tx)
    obj.location = (x, y, 2.0)
    obj.rotation_euler = (0.0, 0.0, yaw)
    scene.collection.objects.link(obj)
    return obj


def _add_pickup(scene, name: str, t: float) -> bpy.types.Object:
    """Drop a ``pickup_NN`` empty on the racing line at parameter t.
    The auto-tag rule (``^pickup_(?:\\d+|main)$``) stamps kind=
    pickup_spawn at export, so we just create the empty.
    """
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "SPHERE"
    obj.empty_display_size = 2.0
    obj["kind"] = "pickup_spawn"
    (x, y), _tan = _sample_anchor_polyline_at_t(SPLINE_ANCHORS, t)
    obj.location = (x, y, 1.5)
    scene.collection.objects.link(obj)
    return obj


def _add_boost_pad(scene) -> bpy.types.Object:
    """One boost pad just before the ramp (t≈0.78) so the player gets
    a small speed bump into the jump beat. Local +Y is the boost
    direction; we yaw it to match the racing-line tangent there.
    Defaults mirror the boost_pad add operator (3 m × 6 m, 1.5× speed).
    """
    obj = bpy.data.objects.new("boost_00", None)
    obj.empty_display_type = "ARROWS"
    obj.empty_display_size = 4.0
    obj["kind"] = "boost_pad"
    obj["half_width"] = 3.0
    obj["half_depth"] = 6.0
    obj["strength"] = 1.4  # Tutorial-friendly nudge, not a full boost
    (x, y), (tx, ty) = _sample_anchor_polyline_at_t(SPLINE_ANCHORS, 0.78)
    yaw = math.atan2(ty, tx) - math.pi / 2.0  # +Y → tangent
    obj.location = (x, y, 0.5)
    obj.rotation_euler = (0.0, 0.0, yaw)
    scene.collection.objects.link(obj)
    return obj


def _add_camera_hero(scene) -> bpy.types.Object:
    """Drop a ``camera_hero`` Camera pointing at the cove's central
    feature (the anti-grav arch crossing at t≈0.94, plus the inner
    island as the backdrop). Parked back and up so the 50 mm framing
    captures the full arch silhouette + the open water. The thumbnail
    render pass uses this camera for the loading-screen hero JPG.
    """
    import mathutils

    cam_data = bpy.data.cameras.new("camera_hero")
    cam_data.lens = 50.0
    cam_data.clip_start = 0.1
    cam_data.clip_end = 5000.0

    cam = bpy.data.objects.new("camera_hero", cam_data)
    cam["kind"] = "camera_hero"

    # Target = anti-grav arch position, lifted a little so the camera
    # reads the volume of the arch rather than its base.
    tx, ty, _tz = _sample_xy(0.94)
    target = mathutils.Vector((tx, ty, 4.0))

    # Park the camera out over the water 80 m south + west of the arch,
    # 28 m up. Far enough away that the 50 mm lens captures the arch
    # and a slice of inner island; high enough that the horizon line
    # reads as a soft band, not a hard cut.
    cam_pos = mathutils.Vector((tx - 80.0, ty - 80.0, 28.0))
    cam.location = cam_pos

    delta = target - cam_pos
    quat = delta.to_track_quat("-Z", "Y")
    cam.rotation_euler = quat.to_euler()

    scene.collection.objects.link(cam)
    return cam


# ────────────────────────────────────────────────────────────────────
# Sky preset + audio post-merge
# ────────────────────────────────────────────────────────────────────


def _apply_sandbar_sky(scene) -> None:
    """Stamp the Sandbar palette onto the scene's sky scene-properties
    so the export's ``derive_sky_block`` picks them up. The values
    match the design brief: warm pastel tint, soft cloudiness, mid-
    morning sun, Beaufort 1 (the tutorial's calmest sea before the
    cove's own ``wave_zone_00`` 0.5× multiplier scales it further
    down). ``miami_pastel`` is the closest bundled colour-grade preset
    to the "training cove, low-stakes" mood.

    Scene properties live on ``scene.hoverbike_sky_*``; the hex tint
    helper lives in the sky_preset module.
    """
    from kingtide_addon.sky_preset import set_sky_tint_from_hex

    set_sky_tint_from_hex("#ffe0c8")
    scene.hoverbike_sky_cloudiness = 0.2
    scene.hoverbike_sky_sun_intensity = 1.1
    scene.hoverbike_sky_fog_near = 300.0
    scene.hoverbike_sky_fog_far = 1200.0
    scene.hoverbike_sky_time_of_day = 60.0
    scene.hoverbike_sky_color_grade = "miami_pastel"
    scene.hoverbike_sky_bloom = 0.6
    scene.hoverbike_sky_sea_state = 1


def _merge_audio_into_json(track_id: str) -> None:
    """Post-pass: drop a forward-looking ``audio`` block into the
    track JSON after the addon export. The merge logic in
    ``_merge_export_json`` doesn't own ``audio``, so a hand-edited
    block survives every subsequent Blender re-export. Paths target
    real basenames under ``public/audio/{music,ambient}/`` — missing
    files load gracefully (warned, never crashed) so the schema can
    ship ahead of the licensed assets.
    """
    json_path = os.path.join(REPO_ROOT, "public", "tracks", f"{track_id}.json")
    if not os.path.isfile(json_path):
        print(f"[seed-track-sandbar] WARN: no JSON at {json_path}, skipping audio merge")
        return
    with open(json_path, "r", encoding="utf-8") as fh:
        body = json.load(fh)

    body["audio"] = {
        "music": "sandbar-pad-bed.opus",
        "ambient": ["gulls.opus", "surf-light.opus"],
        "ambientGains": [0.3, 0.5],
        "music3dEffects": {"duckOnPump": 0.5},
    }
    # Tutorial is one lap — the export's scene prop also writes this,
    # but stamp it here too as a safety so the JSON on disk is
    # unambiguously one lap regardless of whether
    # ``hoverbike_laps_to_finish`` was set before the export ran.
    body["lapsToFinish"] = 1

    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(body, fh, indent=2)
        fh.write("\n")
    print(f"[seed-track-sandbar] merged audio + lapsToFinish=1 into {json_path}")


# ────────────────────────────────────────────────────────────────────
# Augment + re-export
# ────────────────────────────────────────────────────────────────────


def _augment_and_reexport() -> None:
    """After ``build_track_from_spec`` returns, the .blend is open with
    the road + spline + checkpoints in place. We add the per-beat
    empties, stamp the sky preset onto scene props, save, and re-fire
    the addon's ``export_track`` so the JSON picks up:

      * ``waveZones[]`` from ``wave_zone_00``
      * ``antiGravZones[]`` from ``antigrav_00``
      * ``pickupSpawns[]`` from ``pickup_00..03``
      * ``boostPads[]`` from ``boost_00``
      * ``sky{}`` from the scene props
      * a camera_hero-rendered hero JPG side-effect (the export hook
        auto-fires the thumbnail render when a ``camera_hero`` exists).
    """
    scene = bpy.context.scene
    output_blend = os.path.join(REPO_ROOT, "tracks-src", f"{SPEC.track_id}.blend")

    # Set tutorial-specific scene flags before the augments so the
    # JSON written by the re-export picks them up.
    if hasattr(scene, "hoverbike_laps_to_finish"):
        scene.hoverbike_laps_to_finish = 1
    _apply_sandbar_sky(scene)

    # Per-beat empties.
    _add_wave_zone_calm(scene)
    _add_antigrav_zone(scene)
    _add_pickup(scene, "pickup_00", 0.30)  # first swell exit — pump reward
    _add_pickup(scene, "pickup_01", 0.55)  # post-drift apex — ribbon line
    _add_pickup(scene, "pickup_02", 0.65)  # N straight — pickup-grab beat
    _add_pickup(scene, "pickup_03", 0.88)  # post-ramp landing — recovery
    _add_boost_pad(scene)
    _add_camera_hero(scene)

    # Refresh the wave-zone and anti-grav gizmos so the saved .blend
    # contains the visual previews authors expect to see when they
    # open the file later. The refresh helpers are no-ops if the
    # collection / mesh doesn't already exist (they build it).
    try:
        from kingtide_addon.wave_zone import refresh_wave_zone_gizmos
        refresh_wave_zone_gizmos(scene)
    except ImportError:
        pass
    try:
        from kingtide_addon.antigrav import refresh_antigrav_zone_gizmos
        refresh_antigrav_zone_gizmos(scene)
    except ImportError:
        pass

    bpy.ops.wm.save_as_mainfile(filepath=output_blend)

    # Re-export the track. The first export inside build_track_from_spec
    # ran before any of the per-beat empties existed, so the JSON it
    # wrote is missing wave_zones / antigrav_zones / pickups / boost
    # pads / sky. This second export writes the complete picture.
    result = bpy.ops.kingtide.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(f"[seed-track-sandbar] re-export failed: {result}")


# ────────────────────────────────────────────────────────────────────
# Entry
# ────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    try:
        build_track_from_spec(SPEC)
        _augment_and_reexport()
        _merge_audio_into_json(SPEC.track_id)
        print(f"[seed-track-sandbar] done — {SPEC.track_id}")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-sandbar] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
