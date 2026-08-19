"""Build ``tracks-src/shibuya-submerged.blend`` + GLB/JSON exports.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_shibuya_submerged.py

Or via the pnpm wrapper:
    pnpm seed:track-shibuya-submerged

Reshape: a drowned-Tokyo loop that threads between skyscraper rooftops on
the north half, dives down across the **Shibuya Crossing cable bridge**
on the south half (toppled neon signage + powerline cables at water
level, intersection 10 storeys below visible through broken glass),
then climbs the **Cocoon Tower wall-ride** on the final beat.

Built on ``template-downtown`` for the dense-rooftop biome the brief
demands. The Skytree silhouette reads via an oversized
``landmark_tower_cylinder_spiral`` parked ~2.5 km north of the racing
line; Cocoon Tower is a 3× hero instance of the same archetype with
``stripe_pattern="criss_cross"`` placed where the climb apex lands.

After ``build_track_from_spec(SPEC)`` returns this script augments the
scene with:

  * Cocoon Tower            — 1× ``landmark_tower_cylinder_spiral``
                              criss-cross instance at the climb base,
                              ~3× scale (~180 m tall).
  * Shibuya Crossing window — 1× ``landmark_glass_tank_broken`` flat-
                              scaled (Z 0.2) to read as a wide
                              underwater skylight over the crossing.
  * Drowned Shinjuku tops   — 3× ``landmark_drowned_facade_tokyo``
                              instances rotated/scaled around the
                              rooftop section.
  * Skytree backdrop        — 1× extra ``landmark_tower_cylinder_spiral``
                              scaled tall+thin, ~2.5 km north, decoration.
  * Anti-grav wall-ride     — ``antigrav_curve_00`` Bezier climbing
                              the Cocoon Tower face; ``PROFILE_RIBBON``
                              ~10 m wide, ~10 s climb at race pace.
  * Wave zones              — calm rooftop spray + sharp crossing chop.
  * Pickups + boost pads    — 6 pickups, 2 boost pads.
  * camera_hero             — 28 mm wide-angle SE of Cocoon Tower
                              looking NW so the frame catches
                              Cocoon + Crossing + Skytree backdrop.

Open Sea Cup race per
[docs/track-themes.md § 5 Shibuya Submerged](../../docs/track-themes.md).
Phase D Sprint 2 of the v1 asset pipeline.
"""

from __future__ import annotations

import importlib.util
import math
import os
import sys

import bpy
from mathutils import Vector

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

LANDMARKS_LIBRARY = os.path.join(REPO_ROOT, "tracks-src", "landmarks-library.blend")
PROPS_LIBRARY = os.path.join(REPO_ROOT, "tracks-src", "props-library.blend")

# Shared scatter helpers (Phase β/γ of docs/level-visual-quality-research.md).
_scatter_spec = importlib.util.spec_from_file_location(
    "scatter_lib", os.path.join(SCRIPT_DIR, "scatter_lib.py"),
)
_scatter = importlib.util.module_from_spec(_scatter_spec)
sys.modules["scatter_lib"] = _scatter
_scatter_spec.loader.exec_module(_scatter)
drop_scatter_zones = _scatter.drop_scatter_zones


# Test scatter — Phase γ verification pass for the urban prop kit.
# Placement is throwaway pending the level rework; goal here is just
# to prove `prop_lamp_post` / `prop_antenna_mast` / `prop_vent_stack`
# / `prop_ac_unit` / `prop_signage_panel` flow through scatter_lib +
# EXT_mesh_gpu_instancing into the runtime.
SCATTER_ZONES: tuple[dict, ...] = (
    # NE rooftop antenna cluster — tall thin masts on the rooftop band
    # east of the racing line.
    {
        "name": "scatter_00",
        "location": (160.0, 90.0, 12.0),
        "half_width": 40.0,
        "half_depth": 30.0,
        "density": 0.010,
        "source": "prop_antenna_mast",
        "seed": 11,
    },
    # N rooftop vent / AC cluster — denser, smaller silhouettes
    # filling out the rooftop band.
    {
        "name": "scatter_01",
        "location": (-30.0, 110.0, 12.0),
        "half_width": 60.0,
        "half_depth": 30.0,
        "density": 0.022,
        "source": "prop_vent_stack",
        "seed": 19,
    },
    # Outer east signage cluster — neon billboards visible from the
    # racing line.
    {
        "name": "scatter_02",
        "location": (210.0, -30.0, 4.0),
        "half_width": 30.0,
        "half_depth": 80.0,
        "density": 0.008,
        "source": "prop_signage_panel",
        "seed": 23,
    },
)


def _drop_scatter_zones(scene) -> int:
    """Drop the Shibuya test scatter zones via the shared helper."""
    return drop_scatter_zones(scene, PROPS_LIBRARY, SCATTER_ZONES)


# ─────────────────────────────────────────────────────────────────────
# Track spec — 1437 m loop, ~58 s @ ~25 m/s
# ─────────────────────────────────────────────────────────────────────
#
# Layout sketch (XY, Z-up Blender world; sea surface at z=0):
#
#                ╭───── 3 ─── 4 ─────╮              (rooftop section,
#               2                     5             z ≈ +6..+12 m,
#              /                       \            above-water deck
#             1                         6           bridges)
#             |     COCOON TOWER         |
#             |     @ (110, -60)         |
#             10        12 ──── 13       |
#              \      / 11 \    \\       /
#               \    /      \    \\     /
#                ╰─ 9        ╰── 0 ──╯
#                  \                /
#                   8 ── (-10,-180) 7
#                   Shibuya Crossing cables
#                   (z = -2, low above flooded
#                    intersection 10 storeys down)
#
# t-distribution puts the cable crossing at t ≈ 0.5..0.65 (mid-lap
# spectacle), the anti-grav wall-ride climb at anchor 11 (t=0.74) →
# anchor 12 (t=0.91), spanning the brief's t≈0.7-0.85 climb beat.
# Total arc length 1436.6 m → 57.5 s at 25 m/s.

SPEC = TrackSpec(
    track_id="shibuya-submerged",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-downtown.blend"),
    spline_anchors=[
        (  60.0,  -10.0,   6.0),   # 0  start — east of Cocoon Tower base
        ( -30.0,   20.0,   8.0),   # 1  west arc into rooftop section
        (-120.0,   60.0,  12.0),   # 2  NW rooftop apex
        ( -50.0,  110.0,  10.0),   # 3  N rooftop bridge
        (  60.0,  120.0,   8.0),   # 4  NE rooftop bridge
        ( 150.0,   50.0,   6.0),   # 5  E rooftop turn
        ( 160.0,  -70.0,   4.0),   # 6  drop-in toward crossing
        (  90.0, -150.0,   0.0),   # 7  approach Shibuya Crossing cables
        ( -10.0, -180.0,  -2.0),   # 8  CROSSING MIDPOINT — Hachiko below
        (-130.0, -150.0,  -2.0),   # 9  exit crossing west
        (-170.0,  -50.0,   2.0),   # 10 west bend, climb-out begins
        ( -50.0,  -70.0,   8.0),   # 11 Cocoon Tower wall-ride BASE (t≈0.74)
        (  60.0,  -30.0,  50.0),   # 12 Cocoon Tower wall-ride TOP  (t≈0.91)
        ( 100.0,   20.0,  15.0),   # 13 rooftop landing east of Cocoon
    ],
    # Five checkpoints — cp_03 lands on the cable crossing midpoint
    # (the postcard) and cp_04 on the Cocoon climb top so the climb
    # gates the lap. cp_00..cp_02 spread across the rooftop section.
    checkpoint_ts=(0.13, 0.28, 0.42, 0.58, 0.88),
    # 11 m wide — generous for the rooftop section but the cable bridge
    # reads narrow against the surrounding water mass.
    road_width=11.0,
    road_lift=0.3,
    road_blend_radius=7.0,
    road_samples=144,        # extra samples for the climb arc
    road_smooth_passes=5,
    road_curb_width=0.7,
    road_curb_height=0.15,
    road_curb_stripe=2.0,
    road_thickness=0.6,
    gate_spacing_m=58.0,
    # Wider water preview — drowned Tokyo flood plane reads to the
    # horizon, not a contained lagoon.
    water_preview_size=1000.0,
    water_preview_subdivisions=160,
)


# ─────────────────────────────────────────────────────────────────────
# Library linking helpers — mirrors seed_track_south_beach_sunken.py
# ─────────────────────────────────────────────────────────────────────


def _link_collection(library_path: str, collection_name: str) -> bpy.types.Collection | None:
    """Link ``collection_name`` from the landmarks library into the
    current scene. Returns the linked Collection datablock. Re-runs are
    idempotent — an existing linked collection by the same name is
    reused. Returns None if the library or collection is missing."""
    existing = bpy.data.collections.get(collection_name)
    if existing is not None and existing.library is not None:
        return existing
    if not os.path.isfile(library_path):
        print(f"  WARN: landmarks library not found at {library_path}; "
              f"skipping {collection_name}.")
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
    *,
    rotation_z_deg: float = 0.0,
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
    kind: str = "track",
    landmark_tag: str | None = None,
) -> bpy.types.Object:
    """Create a collection-instance empty referencing ``coll`` at
    world coords ``location``. Anisotropic scaling is supported (the
    Cocoon Tower wants a 3× uniform scale but the Skytree-backdrop
    needs tall+thin and the Crossing-glass needs flat-wide)."""
    inst = bpy.data.objects.new(name, None)
    inst.instance_type = "COLLECTION"
    inst.instance_collection = coll
    inst.empty_display_size = 1.0
    inst.location = location
    inst.rotation_euler = (0.0, 0.0, math.radians(rotation_z_deg))
    inst.scale = scale
    inst["kind"] = kind
    if landmark_tag is not None:
        inst["hb_landmark"] = landmark_tag
    bpy.context.scene.collection.objects.link(inst)
    return inst


# ─────────────────────────────────────────────────────────────────────
# Hero landmarks — Cocoon Tower, Crossing glass, Skytree backdrop
# ─────────────────────────────────────────────────────────────────────

# Cocoon Tower position — placed ~30 m west of the anti-grav climb top
# (anchor 12 at x=60, z=50). The hero tower stands at the climb root.
# Real Cocoon Tower is ~204 m; archetype default 60 m × 3.0 = ~180 m.
COCOON_LOCATION = (110.0, -60.0, 0.0)
COCOON_SCALE = (3.0, 3.0, 3.0)
COCOON_ROTATION_DEG = 35.0   # criss-cross face oriented toward the climb line

# Shibuya Crossing broken-glass skylight — flat-scaled wide. The tank
# archetype is 20 × 14 × 10 m; (3.0, 3.0, 0.2) blows it to 60 × 42 × 2 m,
# reading as a wide shattered skylight over the underwater intersection.
CROSSING_GLASS_LOCATION = (-10.0, -180.0, -1.0)
CROSSING_GLASS_SCALE = (3.0, 3.0, 0.2)
CROSSING_GLASS_ROTATION_DEG = 8.0  # tilt away from the racing line tangent

# Skytree silhouette — far north, tall + thin. Real Skytree is 634 m;
# archetype default 60 m × 10× height = ~600 m. XY left near 1.0 so the
# silhouette stays needle-thin.
SKYTREE_LOCATION = (0.0, 2500.0, -30.0)
SKYTREE_SCALE = (1.0, 1.0, 10.0)

# Drowned-Shinjuku rooftop facades around the rooftop section. The
# facade archetype is 24 × 80 m (tokyo style is tall — that's the
# point). Vary scale + rotation per instance so the cluster reads as a
# distinct neighbourhood rather than a copy-paste.
SHINJUKU_FACADES: tuple[tuple[str, tuple[float, float, float], float, tuple[float, float, float]], ...] = (
    # (instance_name, location, rotation_z_deg, scale)
    ("shinjuku_tower_01",   (-160.0,  100.0,   -8.0),   25.0, (1.0, 1.0, 1.0)),
    ("shinjuku_tower_02",   (   0.0,  180.0,  -10.0),  -15.0, (1.15, 1.0, 0.85)),
    ("shinjuku_tower_03",   ( 130.0,  130.0,   -6.0),   80.0, (0.9, 1.05, 1.1)),
)


def _build_cocoon_tower(scene) -> None:
    """One ``landmark_tower_cylinder_spiral`` instance with the
    criss-cross face palette (the archetype's per-face material slots
    receive the criss_cross stripe pattern via face-index tagging in
    the library mesh). At 3× scale the tower silhouette dominates the
    final beat of the lap — exactly the brief's "anti-grav wall-ride
    against the Cocoon Tower face"."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_tower_cylinder_spiral")
    if coll is None:
        return
    inst = _spawn_instance(
        coll,
        "shibuya_cocoon_tower",
        COCOON_LOCATION,
        rotation_z_deg=COCOON_ROTATION_DEG,
        scale=COCOON_SCALE,
        kind="track",
        landmark_tag="cocoon_tower",
    )
    print(f"  Cocoon Tower    → {inst.name} @ {tuple(round(c, 1) for c in inst.location)} "
          f"scale={COCOON_SCALE}")


def _build_crossing_glass(scene) -> None:
    """One ``landmark_glass_tank_broken`` flattened wide to read as the
    broken skylight over Shibuya Crossing. Tagged ``kind=decoration``
    so the runtime won't spawn a trimesh collider — the player races
    *over* it (the cable bridge sits a metre above), not through it.
    The visual job is to frame the underwater intersection + Hachiko
    statue as seen from the racing line."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_glass_tank_broken")
    if coll is None:
        return
    inst = _spawn_instance(
        coll,
        "shibuya_crossing_glass",
        CROSSING_GLASS_LOCATION,
        rotation_z_deg=CROSSING_GLASS_ROTATION_DEG,
        scale=CROSSING_GLASS_SCALE,
        kind="decoration",
        landmark_tag="shibuya_crossing",
    )
    print(f"  Crossing glass  → {inst.name} @ {tuple(round(c, 1) for c in inst.location)} "
          f"scale={CROSSING_GLASS_SCALE} (decoration)")


def _build_skytree_backdrop(scene) -> None:
    """One extra ``landmark_tower_cylinder_spiral`` parked 2.5 km north
    of the racing line, scaled 1×1×10 so the silhouette reads needle-
    thin against the horizon. Decoration kind — too far away to need a
    collider, and we don't want the GLB lint to flag a 6 km-distant
    trimesh."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_tower_cylinder_spiral")
    if coll is None:
        return
    inst = _spawn_instance(
        coll,
        "shibuya_skytree_backdrop",
        SKYTREE_LOCATION,
        rotation_z_deg=0.0,
        scale=SKYTREE_SCALE,
        kind="decoration",
        landmark_tag="skytree",
    )
    print(f"  Skytree backdrop→ {inst.name} @ {tuple(round(c, 1) for c in inst.location)} "
          f"scale={SKYTREE_SCALE} (decoration)")


def _build_shinjuku_facades(scene) -> None:
    """Three ``landmark_drowned_facade_tokyo`` instances around the
    rooftop section so the player threads between recognisable Shinjuku
    skyscraper tops, not generic blocks. Z-offset down so the bases
    rest below the waterline (the facade rises from the flood plane —
    rooftops sit above)."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_drowned_facade_tokyo")
    if coll is None:
        return
    placed = 0
    for name, loc, rot, sc in SHINJUKU_FACADES:
        inst = _spawn_instance(
            coll,
            name,
            loc,
            rotation_z_deg=rot,
            scale=sc,
            kind="track",
            landmark_tag="shinjuku_top",
        )
        placed += 1
        print(f"  Shinjuku[{placed}]    → {inst.name} @ {tuple(round(c, 1) for c in inst.location)} "
              f"yaw={rot:.0f}° scale={sc}")


# ─────────────────────────────────────────────────────────────────────
# Anti-grav wall-ride — Bezier curve up the Cocoon Tower face
# ─────────────────────────────────────────────────────────────────────
#
# Six Bezier control points sweep up one face of the Cocoon Tower. The
# climb is roughly vertical (not corkscrewed) — the bike enters near
# the west face at z≈3 and arcs up to z≈55 across a horizontal span of
# ~70 m. ~250 m of climb arc at race pace (~25 m/s) ≈ 10 s, matching
# the brief's "~10 s of climb at race pace".
#
# The face we wall-ride is the SW face of the Cocoon Tower (the climb
# entry is at the spline anchor 11 region at x ≈ -50, y ≈ -70). The
# control points stand just outside the tower radius so the swept
# ribbon's centreline rides along the criss-cross stripes.

COCOON_RADIUS_M = 4.5 * 3.0    # archetype base radius × Cocoon scale
RIBBON_CLEARANCE_M = 1.0       # half ribbon width offset from wall

# Compute the climb anchors. Use a 5-point ascent that starts at the
# climb-base spline anchor 11 (rough world coords) and ends at the
# climb-top spline anchor 12. The ribbon hugs the SW face of the
# Cocoon Tower (centred at COCOON_LOCATION).
def _wall_ride_control_points() -> list[tuple[float, float, float]]:
    """Six (x, y, z) anchors for a roughly-vertical wall-ride up the
    Cocoon Tower face. The first two points hug the SW face climbing
    in altitude; the next three arc around to the SE face as altitude
    builds; the last point sits above the lamp room ready to drop
    into anchor 12 (the rooftop landing).

    Curve runs in Blender world coords (Z-up); the glTF exporter
    rotates to runtime Y-up at export time."""
    cx, cy = COCOON_LOCATION[0], COCOON_LOCATION[1]
    r = COCOON_RADIUS_M + RIBBON_CLEARANCE_M  # ~14.5 m from tower axis
    points: list[tuple[float, float, float]] = []
    # Entry — SW face of Cocoon Tower, low above water. Bike arrives
    # along the spline's W-bend approach (anchor 10→11), turns into
    # the wall, and the ribbon catches them at this point.
    points.append((cx + math.cos(math.radians(220.0)) * r,
                   cy + math.sin(math.radians(220.0)) * r,
                   4.0))
    # Lower wall — west face, climbing.
    points.append((cx + math.cos(math.radians(200.0)) * r,
                   cy + math.sin(math.radians(200.0)) * r,
                   14.0))
    # Mid wall — south face, mid altitude.
    points.append((cx + math.cos(math.radians(245.0)) * r,
                   cy + math.sin(math.radians(245.0)) * r,
                   26.0))
    # Upper wall — SE face, high altitude.
    points.append((cx + math.cos(math.radians(285.0)) * r,
                   cy + math.sin(math.radians(285.0)) * r,
                   40.0))
    # Crest — east face, lamp-room altitude.
    points.append((cx + math.cos(math.radians(330.0)) * r,
                   cy + math.sin(math.radians(330.0)) * r,
                   52.0))
    # Exit — clearing the tower top, drops into the landing anchor.
    points.append((cx + 12.0, cy + 30.0, 50.0))
    return points


def _add_antigrav_wall_ride(scene) -> bool:
    """Programmatically author ``antigrav_curve_00`` (Bezier with 6
    AUTO control points climbing the Cocoon Tower face) and call
    ``build_antigrav_ribbon_from_curve`` headlessly with
    ``PROFILE_RIBBON`` so the swept surface is a flat strip — the
    canonical wall-ride profile. Mirrors
    ``seed_track_hatteras_light.py::_add_antigrav_corkscrew`` but swaps
    TUBE → RIBBON and a corkscrew → a roughly-vertical climb.

    Returns True if the ribbon swept; False (with a console warning)
    if the antigrav_ribbon module isn't reachable — the curve is still
    placed so authors can finish the sweep manually."""
    # 1. Create the Bezier curve directly. Same pattern as Hatteras.
    curve_data = bpy.data.curves.new("antigrav_curve_00", type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 32
    spline_obj = curve_data.splines.new(type="BEZIER")
    cps = _wall_ride_control_points()
    spline_obj.bezier_points.add(len(cps) - 1)
    for bp, (x, y, z) in zip(spline_obj.bezier_points, cps):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    spline_obj.use_cyclic_u = False

    curve_obj = bpy.data.objects.new("antigrav_curve_00", curve_data)
    curve_obj["kind"] = "antigrav_curve"
    scene.collection.objects.link(curve_obj)

    # 2. Sweep the ribbon via the public entry point. Falls back to
    # the GUI operator if the direct import fails (shouldn't happen
    # under the seed harness, but matches Hatteras's safety net).
    try:
        from kingtide_addon.antigrav_ribbon import (
            build_antigrav_ribbon_from_curve,
            PROFILE_RIBBON,
        )
    except ImportError:
        try:
            result = bpy.ops.kingtide.build_antigrav_surface()
            if "FINISHED" in result:
                return True
        except (AttributeError, RuntimeError) as e:
            print(
                f"[seed-track-shibuya-submerged] WARN: antigrav_ribbon not "
                f"reachable headless ({e}); curve placed but not swept. "
                "Open the .blend, select antigrav_curve_00, click "
                "'Build Anti-Grav Surface'."
            )
            return False
        return False

    build_antigrav_ribbon_from_curve(
        scene,
        curve_obj,
        profile=PROFILE_RIBBON,
        width=10.0,       # brief asks for ~10 m wide
        thickness=0.5,
        radius=8.0,       # ignored for RIBBON
        samples=64,
        segments=16,
    )
    return True


# ─────────────────────────────────────────────────────────────────────
# Wave zones — calm rooftop spray + sharper crossing chop
# ─────────────────────────────────────────────────────────────────────
#
# 1. wave_zone_rooftop_calm — covers the rooftop section. Rooftops
#    sit at z≈+6..+12 m so any wave field there is decorative spray
#    only; height_mult 0.5 keeps the global field gentle around the
#    rooftop deck bridges. Soft 15 m blend so the boundary isn't
#    visible from the rooftop straight.
#
# 2. wave_zone_crossing_surge — bigger OBB over the flooded Shibuya
#    Crossing intersection. height_mult 1.4 + freq_mult 1.1 produces
#    sharp urban-flood chop; 30 m blend keeps the transition off the
#    rooftops above.
#
# Position uses world XY; the local +X axis is the dominant swell
# direction (rotation_z_deg yaws that local axis).

WAVE_ZONES: tuple[dict, ...] = (
    {
        "name": "wave_zone_rooftop_calm",
        "position": (0.0, 80.0, 0.0),
        "rotation_z_deg": 0.0,
        "half_width": 220.0,
        "half_height": 15.0,
        "half_depth": 90.0,
        "height_mult": 0.5,
        "freq_mult": 0.95,
        "blend_radius_m": 15.0,
    },
    {
        "name": "wave_zone_crossing_surge",
        "position": (-10.0, -170.0, 0.0),
        "rotation_z_deg": 30.0,  # swell rolls in from the NW across the crossing
        "half_width": 200.0,
        "half_height": 20.0,
        "half_depth": 100.0,
        "height_mult": 1.4,
        "freq_mult": 1.1,
        "blend_radius_m": 30.0,
    },
)


def _build_wave_zones(scene) -> int:
    """Drop the two wave-zone empties with their tuning props. The
    addon's depsgraph handler rebuilds the gizmo geometry next tick;
    we don't import the addon-internal refresh here so the seed stays
    decoupled from the GUI side."""
    count = 0
    for i, z in enumerate(WAVE_ZONES):
        # Use the canonical wave_zone_NN slot so the addon's exporter
        # picks it up by name pattern. display_name preserves the
        # author-readable label for the panel.
        slot_name = f"wave_zone_{i:02d}"
        obj = bpy.data.objects.new(slot_name, None)
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
        scene.collection.objects.link(obj)
        count += 1
        print(f"  wave_zone[{i}]   → {slot_name} ({z['name']}) @ {z['position']} "
              f"height_mult={z['height_mult']} blend={z['blend_radius_m']}")
    return count


# ─────────────────────────────────────────────────────────────────────
# Authored empties — pickups, boost pads, hero camera
# ─────────────────────────────────────────────────────────────────────
#
# Six pickups along the racing line, balanced between the rooftop
# section and the crossing. Two boost pads — one on the rooftop
# straight, one on the run-in to the wall-ride.

PICKUP_POSITIONS: tuple[tuple[str, tuple[float, float, float]], ...] = (
    ("pickup_00", ( -80.0,   50.0,  12.0)),   # NW rooftop bridge
    ("pickup_01", (  20.0,  130.0,  10.0)),   # N rooftop straight
    ("pickup_02", ( 150.0,    0.0,   8.0)),   # E rooftop drop-in
    ("pickup_03", (  40.0, -170.0,   2.0)),   # Crossing approach (over the broken glass)
    ("pickup_04", (-140.0, -100.0,   4.0)),   # Crossing exit
    ("pickup_05", ( -50.0,  -40.0,  12.0)),   # Climb run-up (commits to the wall-ride)
)

# Boost pads — each carries the required half_width / half_depth /
# strength contract from the kind registry. strength 1.5 matches the
# Reef Cup convention.
BOOST_PADS: tuple[tuple[str, tuple[float, float, float], float, float, float], ...] = (
    # (name, position, half_width, half_depth, rotation_z_deg)
    ("boost_00", (   0.0,  125.0,  10.0), 3.5, 7.0,  85.0),   # N rooftop straight — points east
    ("boost_01", (-110.0, -120.0,  -1.0), 3.5, 7.0,  30.0),   # Crossing exit — points NE into climb run-up
)


def _add_pickups(scene) -> int:
    """Drop six ``pickup_NN`` empties with ``kind="pickup_spawn"`` —
    NOT ``"pickup"``. The Reef Cup seed runs taught us this one bites
    if you typo it; the runtime walks the JSON's pickupSpawns array
    only when the kind matches exactly."""
    for name, pos in PICKUP_POSITIONS:
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 2.0
        obj["kind"] = "pickup_spawn"      # NOTE: NOT "pickup"
        obj.location = pos
        scene.collection.objects.link(obj)
    return len(PICKUP_POSITIONS)


def _add_boost_pads(scene) -> int:
    """Drop two ``boost_NN`` empties. ``strength`` is mandatory — the
    addon's track_meta validator rejects pads without it."""
    for name, pos, hw, hd, rz in BOOST_PADS:
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 3.0
        obj["kind"] = "boost_pad"
        obj["half_width"] = float(hw)
        obj["half_depth"] = float(hd)
        obj["strength"] = 1.5            # mandatory — kind=boost_pad contract
        obj.location = pos
        obj.rotation_euler = (0.0, 0.0, math.radians(rz))
        scene.collection.objects.link(obj)
    return len(BOOST_PADS)


# Hero camera — 28 mm wide-angle, SE of the Cocoon Tower at ~80 m
# elevation, aimed NW so the frame catches Cocoon + Crossing + Skytree
# in one shot. The Wipeout-bright palette wants a wider lens than the
# cinematic 50 mm The Maw uses.
CAMERA_HERO_LOCATION = (260.0, -210.0, 80.0)
CAMERA_HERO_TARGET = (0.0, 100.0, 30.0)   # NW into the rooftop band + Skytree backdrop
CAMERA_HERO_FOCAL_MM = 28.0


def _add_camera_hero(scene) -> None:
    """Drop the ``camera_hero`` Camera. Read by the thumbnail renderer
    + ignored by the GLB export. 28 mm captures the postcard moment
    (Cocoon Tower mid-frame, Crossing glow lower-left, Skytree
    silhouette on the horizon)."""
    name = "camera_hero"
    existing = bpy.data.objects.get(name)
    if existing is not None:
        cam_data = existing.data if isinstance(existing.data, bpy.types.Camera) else None
        bpy.data.objects.remove(existing, do_unlink=True)
        if cam_data is not None and cam_data.users == 0:
            bpy.data.cameras.remove(cam_data)

    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = CAMERA_HERO_FOCAL_MM
    cam_data.clip_start = 0.1
    cam_data.clip_end = 6000.0     # Skytree at 2.5 km must be in view

    obj = bpy.data.objects.new(name, cam_data)
    obj["kind"] = "camera_hero"
    obj.location = CAMERA_HERO_LOCATION

    target = Vector(CAMERA_HERO_TARGET)
    delta = target - Vector(CAMERA_HERO_LOCATION)
    if delta.length > 1e-4:
        obj.rotation_euler = delta.to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(obj)
    print(f"  camera_hero     → @ {tuple(round(c, 1) for c in obj.location)} "
          f"lens={CAMERA_HERO_FOCAL_MM}mm aimed NW")


# ─────────────────────────────────────────────────────────────────────
# Sky preset — push tokyo_neon palette into scene props so the export
# pass derives the right sky block. Without this push the export would
# emit template-island's `neutral` defaults and Shibuya would lose its
# hot-pink-and-electric-blue palette story.
# ─────────────────────────────────────────────────────────────────────

SKY_PRESET = {
    "tint":          "#ff80c8",      # hot pink — wet asphalt + kanji neon reflection
    "cloudiness":    0.55,           # overcast Tokyo night
    "sun_intensity": 0.85,           # low sun (it's after dusk)
    "fog_near":      200.0,          # urban night — closer fog cocoons the rooftops
    "fog_far":       1100.0,
    "time_of_day":   240.0,          # dusk transitioning to night (240s / 360s = 6 PM-ish)
    "color_grade":   "tokyo_neon",   # the canonical Shibuya preset
    "bloom":         1.0,            # neon needs the halation
    "sea_state":     3,              # mild urban chop at the flooded crossing
}


def _apply_sky_preset(scene: bpy.types.Scene) -> None:
    """Push Shibuya's tokyo_neon sky preset into scene props so
    ``derive_sky_block`` emits the right JSON on export. Mirrors the
    Maw / Kilauea / Sandbar pattern. Lazy-import keeps the seed
    decoupled from the addon's per-module register order."""
    try:
        from kingtide_addon.sky_preset import set_sky_tint_from_hex
    except ImportError:
        try:
            from kingtide_addon_disk.sky_preset import set_sky_tint_from_hex
        except ImportError:
            print("  WARN: sky_preset module not reachable headless — "
                  "JSON stub's sky block will survive instead of being "
                  "overwritten by scene defaults.")
            return

    if hasattr(scene, "hoverbike_sky_color_grade"):
        scene.hoverbike_sky_color_grade = SKY_PRESET["color_grade"]
        scene.hoverbike_sky_cloudiness = SKY_PRESET["cloudiness"]
        scene.hoverbike_sky_sun_intensity = SKY_PRESET["sun_intensity"]
        scene.hoverbike_sky_fog_near = SKY_PRESET["fog_near"]
        scene.hoverbike_sky_fog_far = SKY_PRESET["fog_far"]
        scene.hoverbike_sky_time_of_day = SKY_PRESET["time_of_day"]
        scene.hoverbike_sky_bloom = SKY_PRESET["bloom"]
        scene.hoverbike_sky_sea_state = SKY_PRESET["sea_state"]
        set_sky_tint_from_hex(SKY_PRESET["tint"])
        print(f"  sky preset: tokyo_neon (Beaufort-{SKY_PRESET['sea_state']}, "
              f"{SKY_PRESET['color_grade']}, bloom={SKY_PRESET['bloom']})")


# ─────────────────────────────────────────────────────────────────────
# Top-level augmentation orchestrator
# ─────────────────────────────────────────────────────────────────────


def augment_scene() -> None:
    """Layer landmarks, anti-grav wall-ride, wave zones, pickups,
    boost pads, hero camera onto the road-built scene. After this
    returns we save + re-export so the GLB / JSON pick up the
    augmentation — without the re-export the augmentation only lives
    in the .blend, never reaching the runtime."""
    print("[shibuya-submerged] augmenting scene with landmarks + props")
    scene = bpy.context.scene
    _build_cocoon_tower(scene)
    _build_crossing_glass(scene)
    _build_skytree_backdrop(scene)
    _build_shinjuku_facades(scene)
    scatter = _drop_scatter_zones(scene)
    print(f"[shibuya-submerged] scatter: {scatter} zone(s) placed")
    print("[shibuya-submerged] adding anti-grav wall-ride")
    ribbon_ok = _add_antigrav_wall_ride(scene)
    if ribbon_ok:
        print("[shibuya-submerged]   wall-ride ribbon built")
    else:
        print("[shibuya-submerged]   wall-ride curve placed (sweep deferred)")
    print("[shibuya-submerged] stamping wave zones")
    waves = _build_wave_zones(scene)
    print("[shibuya-submerged] adding pickups + boost pads")
    pickups = _add_pickups(scene)
    boosts = _add_boost_pads(scene)
    _add_camera_hero(scene)
    _apply_sky_preset(scene)
    print(
        f"[shibuya-submerged] augment summary: "
        f"{waves} wave zones + {pickups} pickups + {boosts} boost pads"
    )

    # Nudge any spline control point that clips into a downtown plinth /
    # facade / tower base out of the obstacle's footprint. The downtown
    # template's procedural building plinths are tall enough to register
    # as obstacles, so the spline's anchors that pass through a building
    # footprint need to be pushed perpendicular to the nearest bbox edge
    # before export. Runs twice in case overlapping clearance bands
    # leave a point inside a second obstacle after the first push.
    print("[shibuya-submerged] shifting spline off downtown obstacles")
    bpy.ops.kingtide.shift_spline_off_obstacles(margin=4.0)
    bpy.ops.kingtide.shift_spline_off_obstacles(margin=4.0)
    # Re-snap to terrain to recover any z drift caused by the XY push.
    bpy.ops.kingtide.snap_spline_to_terrain()

    # Save .blend with augmentation, then re-export so the GLB +
    # public/tracks/<id>.json pick up the new objects. Mirrors the
    # post-augment re-export in seed_track_hatteras_light.py /
    # seed_track_cape_town_drift.py.
    output_blend = os.path.join(REPO_ROOT, "tracks-src", "shibuya-submerged.blend")
    bpy.ops.wm.save_as_mainfile(filepath=output_blend)
    print(f"[shibuya-submerged] saved {output_blend} with augmentation")

    print("[shibuya-submerged] re-exporting GLB + JSON + manifest")
    result = bpy.ops.kingtide.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(
            f"[shibuya-submerged] export_track (post-augment) failed: {result}"
        )


if __name__ == "__main__":
    try:
        build_track_from_spec(SPEC)
        augment_scene()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-shibuya-submerged] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
