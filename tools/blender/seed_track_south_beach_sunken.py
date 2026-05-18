"""Build ``tracks-src/south-beach-sunken.blend`` + GLB/JSON exports.

Run (after ``seed_template_island.py`` and ``seed_landmarks_library.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_south_beach_sunken.py

Or via pnpm:
    pnpm seed:track-south-beach-sunken

Reshape: drowned Miami Beach. An ~1125 m elongated loop with the flooded
**Ocean Drive** stretch on the south side (Art Deco hotel facades poking
through as a chain of rooftop islands) and an **open-bay** stretch on
the north side (first taste of wave-mastery — heavier swell zone). Hero
set-piece is the **Versace Steps** on the SE leg: Casa Casuarina's
front steps emerging from the water with a half-buried seaplane fuselage
acting as a natural ramp.

Pipeline structure mirrors ``seed_track_canyon_run.py`` /
``seed_track_dune_rally.py``: a ~50-line :class:`TrackSpec` drives
``build_track_from_spec()`` for the spline + road + checkpoints + export,
then this script augments the resulting .blend with the South Beach
dressing — Art Deco facades, the seaplane ramp, wave zones, palms,
pickups, boost pads, and the hero camera.

Reef Cup race #1 per
[docs/track-themes.md § South Beach Sunken](../../docs/track-themes.md).
Phase C Sprint 1 of [docs/v1-asset-pipeline-plan.md](../../docs/v1-asset-pipeline-plan.md).
"""

from __future__ import annotations

import importlib.util
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


# ─────────────────────────────────────────────────────────────────────
# Track shape — elongated east-west loop, ~1130 m arc → ~45 s lap @ 25 m/s.
# ─────────────────────────────────────────────────────────────────────
#
# Layout reads as a flattened rectangle, ~520 m east-west × ~260 m
# north-south. The south leg is the **Ocean Drive stretch** (flooded
# pastel boulevard); the north leg is the **open bay** (gentle swell,
# first wave-mastery taste). Three rooftop clusters anchor the corners:
#   SW (-180,-100) ── Ocean Drive west island
#   SE ( 180,-100) ── Versace Steps + Casa Casuarina cluster
#   NE ( 180, 100) ── Open-bay buoy / rooftop cluster
#   NW (-200, 100) ── west rooftop cluster
# Loop hugs the inside of these clusters at z = -2 (lagoon surface).
SPEC = TrackSpec(
    track_id="south-beach-sunken",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-island.blend"),
    spline_anchors=[
        (-180.0, -100.0, -2.0),  # SW — Ocean Drive west entry / start
        ( -60.0, -120.0, -2.0),  # Ocean Drive straight, first hotel cluster
        (  60.0, -120.0, -2.0),  # Ocean Drive straight, second hotel cluster
        ( 180.0, -100.0, -2.0),  # SE — Versace Steps + seaplane ramp lands
        ( 230.0,    0.0, -2.0),  # East turn — past the SE rooftop island
        ( 180.0,  100.0, -2.0),  # NE — open-bay corner
        (  60.0,  120.0, -2.0),  # Open bay straight, heavier swell
        (-100.0,  120.0, -2.0),  # Open bay straight, mid-bay
        (-200.0,  100.0, -2.0),  # NW corner
        (-235.0,    0.0, -2.0),  # West turn — back toward start straight
    ],
    # Five checkpoints. cp_03 sits right on the Versace Steps so the
    # set-piece hit is timed; everything else is roughly evenly spaced.
    checkpoint_ts=(0.18, 0.30, 0.50, 0.70, 0.90),
    # Art Deco wide-boulevard feel — 12 m road keeps Ocean Drive
    # readable as a former 4-lane road while the open-bay side still
    # feels open.
    road_width=12.0,
    road_lift=0.25,
    road_blend_radius=8.0,
    road_samples=128,
    road_smooth_passes=5,
    road_curb_width=0.7,
    road_curb_height=0.14,
    road_curb_stripe=2.5,
    road_thickness=0.6,
    gate_spacing_m=60.0,
    # Lagoon-sized water preview — South Beach is gentle, not Atlantic.
    water_preview_size=600.0,
    water_preview_subdivisions=120,
)


# ─────────────────────────────────────────────────────────────────────
# Library linking helpers — pull facades + palms from the shared
# landmarks-library / props-library .blends.
# ─────────────────────────────────────────────────────────────────────

LANDMARKS_LIBRARY = os.path.join(REPO_ROOT, "tracks-src", "landmarks-library.blend")
PROPS_LIBRARY = os.path.join(REPO_ROOT, "tracks-src", "props-library.blend")


def _link_collection(library_path: str, collection_name: str) -> bpy.types.Collection | None:
    """Link ``collection_name`` from ``library_path`` into the current
    scene, returning the linked Collection datablock. The collection
    itself isn't placed in any scene; callers create instance-empties
    that reference it via ``instance_collection``. Idempotent — re-runs
    return the existing linked block."""
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
    rotation_z_deg: float = 0.0,
    scale: float = 1.0,
    parent_collection: bpy.types.Collection | None = None,
) -> bpy.types.Object:
    """Create a collection-instance empty referencing ``coll`` at
    world coords ``location``. Used to drop facades / palms onto the
    track without copying their geometry into the .blend."""
    inst = bpy.data.objects.new(name, None)
    inst.instance_type = "COLLECTION"
    inst.instance_collection = coll
    inst.empty_display_size = 1.0
    inst.location = location
    inst.rotation_euler = (0.0, 0.0, math.radians(rotation_z_deg))
    inst.scale = (scale, scale, scale)
    target = parent_collection or bpy.context.scene.collection
    target.objects.link(inst)
    return inst


# ─────────────────────────────────────────────────────────────────────
# Facade + palm placements
# ─────────────────────────────────────────────────────────────────────
#
# Three rooftop clusters dressed with Art Deco facades. Each cluster is
# a handful of ``landmark_drowned_facade_art_deco`` instances at varied
# rotation + scale; the procedural geometry handles the silhouette and
# we lean on placement variety for visual rhythm.
#
# Coordinates are in world XY (Blender Z-up); facades sit just outside
# the racing line (≥ 30 m from spline anchors) so the player threads
# *between* the clusters rather than scraping their roofs. Z is left at
# 0 — the facade geometry rises from the waterline by design.
FACADE_INSTANCES: tuple[tuple[str, float, float, float, float], ...] = (
    # (instance_name, x, y, rotation_z_deg, scale)
    # ── Ocean Drive cluster 1 (south-west, between SW corner and mid)
    ("hotel_deco_01",   -130.0,  -180.0,    8.0, 1.0),
    ("hotel_deco_02",    -50.0,  -195.0,   -4.0, 1.15),
    ("hotel_deco_03",    -90.0,  -160.0,   18.0, 0.9),
    # ── Ocean Drive cluster 2 (south-east, Versace Steps neighbourhood)
    ("hotel_deco_04",    40.0,  -195.0,    2.0, 1.1),
    ("hotel_deco_05",   140.0,  -175.0,  -22.0, 1.0),
    # ── NE rooftop cluster (open-bay side)
    ("hotel_deco_06",   170.0,   180.0,  175.0, 1.05),
    ("hotel_deco_07",    50.0,   195.0, -170.0, 0.95),
    # ── NW rooftop cluster (open-bay side)
    ("hotel_deco_08",  -180.0,   175.0,  190.0, 1.1),
)

# Palms — small clusters on each rooftop island. Tighter formations than
# the facades; rotation is purely visual variety. Z-offset of +6 lifts
# them onto the rooftop islands' visible surface (the facades are 12 m
# tall, palms sit on top).
PALM_INSTANCES: tuple[tuple[str, float, float, float, float], ...] = (
    # SW Ocean Drive island
    ("palm_01",  -150.0, -170.0,  20.0, 1.0),
    ("palm_02",  -110.0, -185.0,  60.0, 1.1),
    ("palm_03",   -70.0, -175.0, 110.0, 0.9),
    # SE Ocean Drive / Versace island
    ("palm_04",    20.0, -180.0,   0.0, 1.05),
    ("palm_05",    90.0, -190.0,  45.0, 1.0),
    ("palm_06",   155.0, -160.0, 200.0, 0.95),
    # East rooftop spit
    ("palm_07",   260.0,   30.0, 130.0, 1.0),
    ("palm_08",   265.0,  -25.0, 250.0, 1.1),
    # NE open-bay cluster
    ("palm_09",   180.0,  175.0, 170.0, 1.0),
    ("palm_10",   140.0,  195.0, 215.0, 0.9),
    ("palm_11",    70.0,  180.0, 305.0, 1.0),
    # NW open-bay cluster
    ("palm_12",   -60.0,  185.0,  90.0, 1.0),
    ("palm_13",  -130.0,  195.0,  20.0, 1.05),
    ("palm_14",  -190.0,  165.0, 280.0, 0.95),
    # West spit
    ("palm_15",  -270.0,   30.0, 100.0, 1.0),
    ("palm_16",  -275.0,  -25.0, 200.0, 1.0),
)

# Pickups along the racing line — six positions, two per straight + one
# in each rounded turn. Lifted ~2.5 m so they float above the waterline.
PICKUP_POSITIONS: tuple[tuple[str, float, float, float], ...] = (
    ("pickup_00",  -120.0, -110.0, 2.5),  # Ocean Drive west, after start
    ("pickup_01",     0.0, -120.0, 2.5),  # Ocean Drive mid
    ("pickup_02",   220.0,  -50.0, 2.5),  # SE → east turn exit
    ("pickup_03",   140.0,  110.0, 2.5),  # Open bay east
    ("pickup_04",   -50.0,  125.0, 2.5),  # Open bay mid
    ("pickup_05",  -225.0,  -50.0, 2.5),  # West turn exit
)

# Boost pads — two, on the long straights. Position + half-extents only;
# rotation gets aimed along the local racing-line tangent below.
BOOST_PADS: tuple[tuple[str, float, float, float, float, float, float], ...] = (
    # (name, x, y, z, half_width, half_depth, rotation_z_deg)
    # Ocean Drive eastbound — points toward the Versace approach.
    ("boost_00",  -10.0, -120.0, 0.1, 3.5, 7.0,  85.0),
    # Open bay westbound — points back toward the start line.
    ("boost_01",   10.0,  120.0, 0.1, 3.5, 7.0, -95.0),
)


# ─────────────────────────────────────────────────────────────────────
# Set-piece — Versace Steps seaplane ramp
# ─────────────────────────────────────────────────────────────────────
#
# Half-buried seaplane fuselage at the Versace Steps. Implemented as an
# ``arch_ruin`` instance — the archetype's decay-amount + low-arc
# silhouette reads cleanly as a beached fuselage at race-pace, and we
# avoid bespoke modelling for a one-shot prop. The instance is tagged
# ``kind = track`` directly on the empty so the runtime's collider attach
# treats it like terrain; the player launches off the swept arch back
# the lagoon.
#
# Position: (130, -110, 0) — sits between the Ocean Drive mid anchor
# and the SE corner, right on the spline crossing. cp_03 lands here.
SEAPLANE_NAME = "versace_seaplane_ramp"
SEAPLANE_LOCATION = (130.0, -110.0, 0.0)
SEAPLANE_ROTATION_DEG = 25.0      # angled across racing line so the ramp aims into the bay
SEAPLANE_SCALE = (0.45, 0.55, 0.35)  # arch_ruin defaults are ~60 m span — scale down to ~25 m fuselage


def _spawn_seaplane_ramp() -> bpy.types.Object | None:
    """Drop a small, scaled-down ``arch_ruin`` as the Versace Steps
    seaplane ramp. Tagged ``kind=track`` so the runtime spawns a trimesh
    collider against it (the player jumps the wing). Returns the
    spawned instance empty, or None if the landmarks library is
    unavailable."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_arch_ruin")
    if coll is None:
        return None
    inst = bpy.data.objects.new(SEAPLANE_NAME, None)
    inst.instance_type = "COLLECTION"
    inst.instance_collection = coll
    inst.location = SEAPLANE_LOCATION
    inst.rotation_euler = (0.0, 0.0, math.radians(SEAPLANE_ROTATION_DEG))
    inst.scale = SEAPLANE_SCALE
    # kind=track so the runtime treats the swept geometry as collidable
    # surface — the ramp has to push the bike up, not pass through.
    inst["kind"] = "track"
    inst["set_piece"] = "versace_seaplane"
    bpy.context.scene.collection.objects.link(inst)
    return inst


# ─────────────────────────────────────────────────────────────────────
# Wave zones — three flavours per the track-themes brief
# ─────────────────────────────────────────────────────────────────────
#
# 1. ``wave_zone_00`` — Lagoon (Ocean Drive + rooftop loop). Calm; the
#    intro track shouldn't punish the player with chop on lap 1.
# 2. ``wave_zone_01`` — Open bay (north straight). First taste of
#    wave-mastery — moderate swell so pump timing matters but isn't
#    punishing. Saved for The Maw later in the sprint.
# 3. ``wave_zone_02`` — Versace approach. Bumps amplitude on the run-up
#    to the seaplane ramp so the ramp launch reads as "timed".
#
# Empties are oriented with local +X = dominant swell direction. The
# open-bay zone aims a Z+ (north) swell at the player; the Versace
# approach zone aims its swell east (away from the racing line so the
# bike rides over a transverse swell into the ramp).
WAVE_ZONES: tuple[dict, ...] = (
    {
        "name": "wave_zone_00",
        "location": (0.0, -110.0, 0.0),
        "rotation_deg": 0.0,
        "half_width": 270.0,   # spans Ocean Drive + south rooftop area
        "half_depth": 80.0,
        "half_height": 8.0,
        "height_mult": 0.7,    # calm lagoon
        "freq_mult": 1.0,
        "blend_radius_m": 25.0,
    },
    {
        "name": "wave_zone_01",
        "location": (-20.0, 110.0, 0.0),
        "rotation_deg": 90.0,  # swell rolls north → south
        "half_width": 230.0,
        "half_depth": 80.0,
        "half_height": 8.0,
        "height_mult": 1.4,    # heavier swell — first wave-mastery taste
        "freq_mult": 1.1,
        "blend_radius_m": 25.0,
    },
    {
        "name": "wave_zone_02",
        "location": (90.0, -110.0, 0.0),
        "rotation_deg": 110.0,  # transverse to racing line
        "half_width": 55.0,
        "half_depth": 35.0,
        "half_height": 8.0,
        "height_mult": 1.2,     # amplify the ramp-timing feel
        "freq_mult": 1.0,
        "blend_radius_m": 12.0,
    },
)


def _spawn_wave_zones(scene: bpy.types.Scene) -> int:
    """Drop the three South Beach wave-zone empties with their tuning
    custom properties. Mirrors the addon's *Add Wave Zone* operator —
    we build the gizmo geometry later via ``refresh_wave_zone_gizmos``
    so the live viewport preview matches the runtime sample volume."""
    count = 0
    for spec_ in WAVE_ZONES:
        obj = bpy.data.objects.new(spec_["name"], None)
        obj.empty_display_type = "CUBE"
        obj.empty_display_size = 6.0
        obj["kind"] = "wave_zone"
        obj["half_width"] = spec_["half_width"]
        obj["half_height"] = spec_["half_height"]
        obj["half_depth"] = spec_["half_depth"]
        obj["height_mult"] = spec_["height_mult"]
        obj["freq_mult"] = spec_["freq_mult"]
        obj["blend_radius_m"] = spec_["blend_radius_m"]
        obj.location = spec_["location"]
        obj.rotation_euler = (0.0, 0.0, math.radians(spec_["rotation_deg"]))
        scene.collection.objects.link(obj)
        count += 1
    return count


# ─────────────────────────────────────────────────────────────────────
# Augmentation — runs after build_track_from_spec()
# ─────────────────────────────────────────────────────────────────────

def _drop_facades(scene: bpy.types.Scene) -> int:
    """Link the Art Deco facade collection and spawn instances around
    the four rooftop clusters. Returns the number placed."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_drowned_facade_art_deco")
    if coll is None:
        return 0
    placed = 0
    for name, x, y, rz, sc in FACADE_INSTANCES:
        _spawn_instance(coll, name, (x, y, 0.0), rotation_z_deg=rz, scale=sc)
        placed += 1
    return placed


def _drop_palms(scene: bpy.types.Scene) -> int:
    """Link the palm prop collection and spawn instances on the four
    rooftop clusters + the east/west spits. Z=6 to lift palms onto
    rooftop island level — the procedural facades rise from the
    waterline so the palm bases visually sit on a 'roof'."""
    coll = _link_collection(PROPS_LIBRARY, "prop_palm")
    if coll is None:
        return 0
    placed = 0
    for name, x, y, rz, sc in PALM_INSTANCES:
        _spawn_instance(coll, name, (x, y, 6.0), rotation_z_deg=rz, scale=sc)
        placed += 1
    return placed


def _drop_pickups(scene: bpy.types.Scene) -> int:
    """Place pickup spawn empties along the racing line. Auto-tag will
    recognise the ``pickup_NN`` name pattern and stamp kind=pickup_spawn
    + the sphere visual on the next scene update; we still set the kind
    explicitly so a headless run that skips the auto-tag depsgraph
    callback still ships them correctly."""
    for name, x, y, z in PICKUP_POSITIONS:
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 2.0
        obj["kind"] = "pickup_spawn"
        obj.location = (x, y, z)
        scene.collection.objects.link(obj)
    return len(PICKUP_POSITIONS)


def _drop_boost_pads(scene: bpy.types.Scene) -> int:
    """Drop two boost pads on the long straights. Same custom-prop
    contract as the addon's *Add Boost Pad* operator — half_width /
    half_depth / strength drive the trigger volume; the gizmo refresh
    rebuilds the visual slab next time the addon ticks."""
    for name, x, y, z, hw, hd, rz in BOOST_PADS:
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 3.0
        obj["kind"] = "boost_pad"
        obj["half_width"] = hw
        obj["half_depth"] = hd
        obj["strength"] = 1.4
        obj.location = (x, y, z)
        obj.rotation_euler = (0.0, 0.0, math.radians(rz))
        scene.collection.objects.link(obj)
    return len(BOOST_PADS)


# Hero camera — frames the Versace Steps + seaplane silhouette against
# the Ocean Drive facades and the pastel sky.
CAMERA_HERO_LOCATION = (215.0, -210.0, 28.0)
CAMERA_HERO_TARGET = (130.0, -110.0, 4.0)   # seaplane ramp midpoint
CAMERA_HERO_FOCAL_MM = 50.0


def _drop_camera_hero(scene: bpy.types.Scene) -> bpy.types.Object:
    """Add a ``camera_hero`` Camera aimed at the Versace Steps from a
    south-east elevated angle. 50 mm — wide enough to fit the seaplane
    silhouette + two facades + the pastel-pink sky band above without
    flattening the composition. Skipped by the GLB export (cameras are
    excluded); read by the headless thumbnail renderer."""
    import mathutils

    cam_data = bpy.data.cameras.new("camera_hero")
    cam_data.lens = CAMERA_HERO_FOCAL_MM
    cam_data.clip_start = 0.1
    cam_data.clip_end = 5000.0

    obj = bpy.data.objects.new("camera_hero", cam_data)
    obj["kind"] = "camera_hero"
    obj.location = CAMERA_HERO_LOCATION

    # Aim -Z toward the target, +Y world-up. Same convention as the
    # addon's *Add Camera Hero* operator (thumbnail.py::_aim_camera_at).
    target = mathutils.Vector(CAMERA_HERO_TARGET)
    delta = target - mathutils.Vector(CAMERA_HERO_LOCATION)
    if delta.length > 1e-4:
        obj.rotation_euler = delta.to_track_quat("-Z", "Y").to_euler()

    scene.collection.objects.link(obj)
    return obj


def _augment(scene: bpy.types.Scene) -> None:
    """Run after ``build_track_from_spec``. Adds the South Beach-specific
    dressing on top of the road + spline + checkpoints the lib produced.
    Saves the .blend at the end so the augmentation survives the next
    re-export."""
    tag = "[seed-track-south-beach-sunken]"

    facades = _drop_facades(scene)
    palms = _drop_palms(scene)
    seaplane = _spawn_seaplane_ramp()
    waves = _spawn_wave_zones(scene)
    pickups = _drop_pickups(scene)
    boosts = _drop_boost_pads(scene)
    _drop_camera_hero(scene)

    # Wave-zone gizmo geometry rebuilds automatically the next time the
    # addon's depsgraph handler ticks (on file load or on the first
    # selection change). Skipped here so the seed script stays free of
    # addon-internal imports; authors who open the .blend immediately
    # after a headless seed run can hit *Refresh Wave Zone Visuals* in
    # the addon panel to surface the cyan boxes without waiting for the
    # auto-refresh.

    print(
        f"{tag} augment: {facades} facades + {palms} palms + "
        f"{1 if seaplane else 0} seaplane + {waves} wave zones + "
        f"{pickups} pickups + {boosts} boost pads + camera_hero"
    )


def main() -> None:
    # Step 1: lib does the heavy lifting (spline → road → checkpoints
    # → snap → preview → save → lint → export).
    build_track_from_spec(SPEC)

    # Step 2: re-open the saved .blend so we can augment + re-save it
    # without racing the export's manifest write. build_track_from_spec
    # leaves the .blend open at exit; bpy.context.scene is the right
    # scene already.
    scene = bpy.context.scene
    _augment(scene)

    output_blend = os.path.join(REPO_ROOT, "tracks-src", f"{SPEC.track_id}.blend")
    bpy.ops.wm.save_as_mainfile(filepath=output_blend)

    # Step 3: re-export so the augmentation (facades, seaplane, waves,
    # palms, pickups, boost pads) ships in the GLB / JSON. The addon's
    # export operator regenerates both files plus the manifest entry.
    print("[seed-track-south-beach-sunken] re-exporting with augmentation")
    result = bpy.ops.hoverbike.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(
            f"export_track failed after augmentation: {result}"
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-south-beach-sunken] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
