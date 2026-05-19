"""Build ``tracks-src/marina-bay-7.blend`` + GLB/JSON exports.

Run (after ``seed_landmarks_library.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_marina_bay_7.py

Or via the pnpm wrapper:
    pnpm seed:track-marina-bay-7

Reshape: a flat-water industrial loop through the drowned Tuas
container terminal. The racing line threads from a south start
straight, through a container-street SE corner, up the east side
of the harbour as **The Gauntlet** — a ~200 m straight under five
gantry cranes swinging shipping containers across the lane at
chest-height — past a beached supertanker on the north side
(brief ramp onto the deck as a shortcut, anti-pickup territory),
and back down a west back-haul to start. Mostly flat-water
(60/40 water/land) with no anti-grav; mid difficulty.

Built on ``template-downtown`` because the harbour reads as
industrial concrete + steel, not the bright island sand of
template-island. Continental Cup race #7 per
[docs/track-themes.md § Marina Bay 7](../../docs/track-themes.md).

After ``build_track_from_spec(SPEC)`` returns this script augments
the scene with:

  * The Gauntlet               — 5× ``landmark_mechanical_rig``
                                 (40 m tall gantry cranes) library-
                                 linked, spaced ~25 m along the east-
                                 side gauntlet straight. Per-instance
                                 swing-period values (3.0..4.2 s)
                                 spread the rhythm so the runtime
                                 animation lands as 5-against-1 phase
                                 chaos. Archetype's swing extras live
                                 on the linked subtree's arm child —
                                 we just place + orient the instance
                                 empty.
  * Beached supertanker        — one inline procedural box
                                 (~80×18×12 m) tagged kind=track.
                                 Deck top sits at z=8 m so the racing
                                 line briefly rises onto it as a
                                 shortcut. Oxidized-red hull material.
  * Container scatter          — 12 inline procedural boxes along
                                 the container-street section. Orange
                                 / sodium-yellow / dirty white / rust
                                 palette per the track-themes brief.
                                 kind=track so the bike collides.
  * Distant warehouse facades  — 3× ``landmark_drowned_facade_nyc``
                                 around the harbour perimeter at
                                 squat Z-scale (0.18–0.25) so they
                                 read as warehouse blocks, not
                                 Manhattan towers.
  * Wave zone                  — one ``wave_zone_murky_harbour``
                                 covering the whole loop. height_mult
                                 0.7 (sheltered + murky-flat),
                                 freq_mult 1.2 (small choppy ripples
                                 on top), 30 m blend.
  * 6 pickups + 2 boost pads   — pickups deliberately routed off the
                                 freighter deck shortcut (track-themes
                                 calls it anti-pickup territory).
                                 Boost pads commit the player to the
                                 gauntlet entry + the freighter-deck
                                 approach.
  * camera_hero                — 50 mm parked west of the beached
                                 tanker at ~30 m elevation, looking
                                 east so the tanker silhouette
                                 frames the five cranes receding
                                 behind it + the harbour beyond.

The augmentation walks the same pattern as ``seed_track_cape_town_drift``
so re-running ``pnpm seed:track-marina-bay-7`` stomps the .blend
deterministically. Hand-tuned tweaks belong on a separate one-off
pass after this seed runs once.
"""

from __future__ import annotations

import importlib.util
import math
import os
import sys

import bmesh
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

# Shared landmarks library — built by seed_landmarks_library.py. We
# library-link collections out of this file so multiple gantry cranes
# share one geometry datablock + carry their swing-period extras on
# the linked subtree.
LANDMARKS_LIBRARY = os.path.join(REPO_ROOT, "tracks-src", "landmarks-library.blend")


# ────────────────────────────────────────────────────────────────────
# TrackSpec — racing line + road params
# ────────────────────────────────────────────────────────────────────
#
# Layout (Blender Z-up world coords; runtime swaps Z↔Y on export):
#
#                          tanker deck shortcut (z=8 m)
#                                  ▲ ▲ ▲
#                               ──▶┘ │ └◀── NW corner
#                                     │ NE corner
#                                     │
#                                     ▼ Gauntlet (5 cranes, z=0..3 m)
#                          west back-haul          │
#                                  │           gauntlet straight
#                                  │              200 m
#                                  │                │
#                                  └──── south straight ────┘
#                                        (container street)
#
# Total polyline ~1500 m → Catmull-Rom smoothing pulls to ~1375 m
# arc → 55 s lap at the Continental-cup pace of ~25 m/s.
#
# Flat-water sections live at z=-2 (matches the other Reef-cup tracks;
# the road_lift parameter brings the road surface up to ~+0.3 m above
# water). Gauntlet runs slightly elevated (z=0..3) to clear the bike
# under chest-height swinging containers. Tanker shortcut climbs to
# z=8 m at the deck apex, then drops back down to z=-2 on exit.

SPEC = TrackSpec(
    track_id="marina-bay-7",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-downtown.blend"),
    spline_anchors=[
        # 0  south start straight, west end
        (-180.0, -190.0, -2.0),
        # 1  south straight mid (container street)
        (  20.0, -210.0, -2.0),
        # 2  SE corner approach
        ( 175.0, -160.0, -2.0),
        # 3  gauntlet entry — racing line lifts onto industrial deck
        ( 230.0, -100.0,  0.0),
        # 4  gauntlet mid (cranes 2-4 region) — chest-height z
        ( 230.0,    0.0,  2.5),
        # 5  gauntlet exit — drop back toward harbour
        ( 230.0,  100.0,  0.0),
        # 6  NE corner approach
        ( 175.0,  170.0, -2.0),
        # 7  tanker ramp-up — rising onto deck
        (  80.0,  225.0,  4.0),
        # 8  tanker deck apex — the shortcut peak
        (   0.0,  235.0,  8.0),
        # 9  tanker ramp-down — leaving deck
        ( -80.0,  220.0,  4.0),
        # 10 NW corner
        (-180.0,  175.0, -2.0),
        # 11 W back-haul north end
        (-220.0,   40.0, -2.0),
        # 12 W back-haul south end
        (-215.0, -100.0, -2.0),
        # 13 rejoin south straight
        (-200.0, -180.0, -2.0),
    ],
    # Five checkpoints. cp_02 lands mid-Gauntlet so hitting the
    # gauntlet IS hitting a gate; cp_03 sits on the tanker deck
    # so the shortcut commit is a checkpoint hit, not a detour.
    checkpoint_ts=(0.18, 0.36, 0.58, 0.72, 0.92),
    # Wide enough for industrial container-street feel; the gauntlet
    # arms swing the full lane width so 11 m gives a believable
    # "duck under" rather than "thread the needle".
    road_width=11.0,
    road_lift=0.3,
    road_blend_radius=7.0,
    road_samples=160,         # extra samples for the tanker climb
    road_smooth_passes=5,
    road_curb_width=0.7,
    road_curb_height=0.15,
    road_curb_stripe=2.5,
    road_thickness=0.6,
    gate_spacing_m=60.0,
    water_preview_size=900.0,
    water_preview_subdivisions=140,
)


# ────────────────────────────────────────────────────────────────────
# Materials — Marina Bay industrial palette
# ────────────────────────────────────────────────────────────────────

def _ensure_material(name: str, hex_color: str, *, roughness: float = 0.65,
                     emission: bool = False) -> bpy.types.Material:
    """Marina Bay palette materials — orange containers, oxidized
    hull reds, sodium yellow, gray steel. Idempotent on name.
    Mirrors the gamma-2.2 → linear convention from
    seed_track_cape_town_drift._ensure_material."""
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
    if emission:
        try:
            bsdf.inputs["Emission Color"].default_value = (r ** 2.2, g ** 2.2, b ** 2.2, 1.0)
            bsdf.inputs["Emission Strength"].default_value = 0.6
        except KeyError:
            pass
    return mat


# Container palette — track-themes brief: orange container stacks,
# oxidized red, sodium yellow, dirty white, deep rust.
_CONTAINER_PALETTE = (
    ("#d96625", "container_orange"),
    ("#a53a26", "oxidized_red"),
    ("#d4a437", "sodium_yellow"),
    ("#c8c0b2", "dirty_white"),
    ("#7e3a25", "deep_rust"),
)


# ────────────────────────────────────────────────────────────────────
# Library-link helpers — mirrors seed_track_south_beach_sunken
# ────────────────────────────────────────────────────────────────────

def _link_collection(library_path: str, collection_name: str) -> bpy.types.Collection | None:
    """Link ``collection_name`` from ``library_path`` into the current
    scene. The collection itself isn't placed in any scene; callers
    create instance-empties that reference it via
    ``instance_collection``. Idempotent — re-runs return the existing
    linked block. Returns None if the library hasn't been built yet
    or the collection isn't present."""
    existing = bpy.data.collections.get(collection_name)
    if existing is not None and existing.library is not None:
        return existing
    if not os.path.isfile(library_path):
        print(f"  WARN: landmarks library not found at {library_path}; "
              f"skipping {collection_name}. Run `pnpm seed:landmarks-library` first.")
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
    scale: tuple[float, float, float] | float = 1.0,
) -> bpy.types.Object:
    """Create a collection-instance empty referencing ``coll`` at
    world coords ``location``. Used to drop gantry cranes / facade
    landmarks without copying their geometry into the .blend."""
    inst = bpy.data.objects.new(name, None)
    inst.instance_type = "COLLECTION"
    inst.instance_collection = coll
    inst.empty_display_size = 1.0
    inst.location = location
    inst.rotation_euler = (0.0, 0.0, math.radians(rotation_z_deg))
    if isinstance(scale, tuple):
        inst.scale = scale
    else:
        inst.scale = (scale, scale, scale)
    bpy.context.scene.collection.objects.link(inst)
    return inst


# ────────────────────────────────────────────────────────────────────
# The Gauntlet — 5× landmark_mechanical_rig along the east straight
# ────────────────────────────────────────────────────────────────────
#
# The gauntlet straight runs from (230, -100) to (230, 100), 200 m
# along world +Y. Five cranes spaced 25 m apart at y=-50, -25, 0, +25,
# +50 — keeping a 50 m run-in + run-out from the gauntlet end-anchors.
# Each crane is the 40 m tall ``landmark_mechanical_rig`` archetype;
# its swinging arm sits at z=41.7 m on the linked subtree, so the
# swung containers will sweep across the road from ~chest height
# when the arm rotates around its local +Z (the swing_axis the
# archetype carries).
#
# Per-instance swing periods are intentionally out of phase
# (3.0, 3.6, 4.2, 3.3, 3.8 s). LCM math: with all five awake the
# pattern repeats roughly every 12 s — far longer than the ~8 s
# gauntlet transit at lap pace, so the player gets a fresh rhythm
# each lap.
#
# IMPORTANT: the archetype already carries swing_period_s /
# swing_amplitude_deg / swing_axis extras on its arm child. We
# DON'T overwrite those — they live on the linked subtree and the
# runtime animation pass (future) will walk the GLB scene graph
# for them. We just set position + orientation on the instance
# empty. The track-level swing variation is captured in the
# instance's own ``swing_period_s_override`` extra so a future
# animation pass that wants per-instance values can read it without
# editing the (shared) archetype.
GAUNTLET_CRANES: tuple[tuple[str, float, float, float, float], ...] = (
    # (name, x, y, rotation_z_deg, swing_period_s)
    # Cranes sit ~12 m off the racing line to the east (x=242) so
    # the swung containers cross from the harbour side; +180° rotation
    # faces the gantry beam toward the racing line (-X).
    ("gantry_crane_00", 242.0, -50.0, 180.0, 3.0),
    ("gantry_crane_01", 242.0, -25.0, 180.0, 3.6),
    ("gantry_crane_02", 242.0,   0.0, 180.0, 4.2),
    ("gantry_crane_03", 242.0,  25.0, 180.0, 3.3),
    ("gantry_crane_04", 242.0,  50.0, 180.0, 3.8),
)


def _build_gauntlet_cranes() -> int:
    """Stamp 5× ``landmark_mechanical_rig`` instance empties along
    the east gauntlet straight, varying swing-period per instance
    via an override extra. Each instance carries the archetype's
    swing extras through its collection-instance link; we tag the
    instance empty with a side-car override so a future runtime
    animation pass can read per-crane timing without editing the
    shared archetype."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_mechanical_rig")
    if coll is None:
        return 0
    placed = 0
    for name, x, y, rz, period in GAUNTLET_CRANES:
        inst = _spawn_instance(coll, name, (x, y, 0.0), rotation_z_deg=rz)
        # Tag the instance kind so the export's auto-tag path treats
        # the linked geometry as collidable — without this the
        # instance-empty falls through to the kind=decoration default
        # for empties with collection instances.
        inst["kind"] = "track"
        inst["landmark_id"] = "mechanical_rig"
        inst["hb_landmark"] = "gantry_crane"
        # Per-instance swing period override. The runtime animation
        # pass (future) reads the archetype's swing_period_s for the
        # default; this override surfaces the rhythm-puzzle intent
        # without rewriting the shared collection. swing_axis stays
        # "Z" (matches archetype default).
        inst["swing_period_s_override"] = period
        placed += 1
        print(f"  gantry_crane[{placed-1:02d}]  → ({x}, {y}) "
              f"yaw={rz}° swing_period={period}s")
    return placed


# ────────────────────────────────────────────────────────────────────
# Beached supertanker — inline procedural box
# ────────────────────────────────────────────────────────────────────
#
# No supertanker archetype exists in the landmarks library, and a
# bespoke kit-blend is overkill for a one-shot prop — we build the
# hull inline as a long cuboid. ~80 m × 18 m × 12 m matches a small
# beached freighter silhouette. Deck (top face) sits at z=8 m so the
# racing-line apex anchor (anchor 8) lands cleanly on the deck. The
# box is parented to nothing — it's authoring intent that an artist
# replaces the placeholder with a sculpted hull in a follow-up pass.

TANKER_NAME = "marina_bay_beached_tanker"
TANKER_LOCATION = (0.0, 230.0, 2.0)     # centre y matches anchor 8; centre z = (deck-bottom)/2
TANKER_HALF_EXTENTS = (40.0, 9.0, 6.0)  # 80 m long × 18 m wide × 12 m tall
TANKER_ROTATION_DEG = 5.0               # slight yaw so the hull doesn't look perfectly aligned to grid


def _build_beached_tanker() -> None:
    """Build the beached supertanker as one long cuboid kind=track.
    Deck top sits at z=8 m so the racing-line anchor at z=8 (anchor
    8 — the shortcut apex) lands flush on the deck surface. Hull
    material is oxidized red per the track-themes brief."""
    mat = _ensure_material("mat_marina_bay_tanker_hull", "#7e3225",
                           roughness=0.7)
    mesh = bpy.data.meshes.new(f"{TANKER_NAME}_mesh")
    bm = bmesh.new()
    try:
        bmesh.ops.create_cube(bm, size=1.0)
        sx, sy, sz = TANKER_HALF_EXTENTS
        for v in bm.verts:
            v.co.x *= sx
            v.co.y *= sy
            v.co.z *= sz
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(TANKER_NAME, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = TANKER_LOCATION
    obj.rotation_euler = (0.0, 0.0, math.radians(TANKER_ROTATION_DEG))
    obj["kind"] = "track"  # collidable deck — bike runs over the top face
    obj["hb_landmark"] = "beached_tanker"
    print(f"  beached_tanker → @ {TANKER_LOCATION} "
          f"({TANKER_HALF_EXTENTS[0]*2:.0f}×{TANKER_HALF_EXTENTS[1]*2:.0f}×"
          f"{TANKER_HALF_EXTENTS[2]*2:.0f}m) yaw={TANKER_ROTATION_DEG}°")


# ────────────────────────────────────────────────────────────────────
# Container scatter — 12× inline procedural boxes
# ────────────────────────────────────────────────────────────────────
#
# Half-submerged shipping containers ringing the south-side container
# street + a few scattered along the west back-haul. Heights vary
# 6–12 m (exaggerated past the real 2.6 m container height for visual
# weight — the racing line reads them as cargo stacks, not single
# boxes). Mirrors seed_track_cape_town_drift::_build_containers
# directly — that pattern is the exact reference the spec calls out.

def _build_containers() -> None:
    """12× cuboid kind=track boxes scattered along the container
    street + west back-haul. Heights vary 6–12 m; palette cycles
    through orange / rust / sodium yellow / dirty white / deep rust.
    Bike collides with them per kind=track."""
    container_mats = [
        _ensure_material(f"mat_marina_bay_container_{label}", hex_color,
                         roughness=0.7)
        for hex_color, label in _CONTAINER_PALETTE
    ]
    # Placements: south-side container street (rings anchors 0..2) +
    # west back-haul (rings anchors 11..12). Stay ≥ 25 m off the
    # racing line so the bike threads BETWEEN stacks, not into them.
    # Z is the container's half-height so its base sits at z=0
    # (water surface — half-submerged).
    placements = [
        # (x, y, sx, sy, sz, yaw_deg) — sx/sy/sz are HALF-extents in m.
        # ── South container street, north side of racing line
        (-120.0, -170.0, 3.0, 1.4, 4.0,   8.0),
        ( -40.0, -170.0, 6.0, 1.4, 3.5,  -5.0),
        (  60.0, -170.0, 3.0, 1.4, 5.0,  12.0),
        ( 140.0, -130.0, 6.0, 1.4, 3.0,  25.0),
        # ── South container street, south side of racing line
        (-100.0, -250.0, 3.0, 1.4, 5.5, -10.0),
        (   0.0, -260.0, 6.0, 1.4, 3.5,   5.0),
        ( 100.0, -255.0, 3.0, 1.4, 6.0,  18.0),
        # ── West back-haul, harbour side
        (-260.0,   80.0, 3.0, 1.4, 4.5,  85.0),
        (-265.0,  -20.0, 6.0, 1.4, 3.0,  90.0),
        (-260.0, -140.0, 3.0, 1.4, 5.0,  88.0),
        # ── Stragglers along the SE corner
        ( 190.0, -210.0, 3.0, 1.4, 4.5,  40.0),
        ( 270.0, -150.0, 3.0, 1.4, 6.0, -30.0),
    ]
    for i, (x, y, sx, sy, sz, yaw) in enumerate(placements):
        mat = container_mats[i % len(container_mats)]
        name = f"marina_bay_container_{i:02d}"
        mesh = bpy.data.meshes.new(f"{name}_mesh")
        bm = bmesh.new()
        try:
            bmesh.ops.create_cube(bm, size=1.0)
            for v in bm.verts:
                v.co.x *= sx
                v.co.y *= sy
                v.co.z *= sz
            bm.to_mesh(mesh)
        finally:
            bm.free()
        mesh.materials.append(mat)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = (x, y, sz)  # base sits at z=0 (water surface)
        obj.rotation_euler = (0.0, 0.0, math.radians(yaw))
        obj["kind"] = "track"  # collidable per ExportedKind.TRACK
        obj["hb_landmark"] = "harbor_container"
        print(f"  container[{i:02d}] → ({x}, {y}) "
              f"size=({sx*2:.1f}×{sy*2:.1f}×{sz*2:.1f}) {mat.name}")


# ────────────────────────────────────────────────────────────────────
# Distant warehouse facades — 3× landmark_drowned_facade_nyc
# ────────────────────────────────────────────────────────────────────
#
# Singapore's port has industrial buildings — nyc-style facades at
# squat Z-scale read as warehouse blocks at race-line distance. Drop
# three around the harbour perimeter for far-silhouette dressing.

FACADE_PLACEMENTS: tuple[tuple[str, float, float, float, float, float, float, float], ...] = (
    # (name, x, y, scale_x, scale_y, scale_z, yaw_deg, label)
    # ── East warehouse — behind the gauntlet line of sight
    ("warehouse_e", 360.0,   0.0, 1.0, 1.5, 0.20, -90.0, "harbor_warehouse_e"),
    # ── North warehouse — past the tanker, completing the harbour wall
    ("warehouse_n",   0.0, 360.0, 1.4, 1.0, 0.25,   0.0, "harbor_warehouse_n"),
    # ── SW warehouse — anchors the south-west corner perimeter
    ("warehouse_sw",-340.0,-220.0, 1.0, 1.2, 0.18,  35.0, "harbor_warehouse_sw"),
)


def _build_harbour_facades() -> int:
    """3× ``landmark_drowned_facade_nyc`` instances at squat Z-scale
    (0.18–0.25) so they read as warehouse blocks at race-line
    distance — Singapore's port silhouette, not Manhattan towers.
    Mirrors the placement pattern from
    seed_track_cape_town_drift::_build_harbor_facades but uses
    library-linked instances rather than appended duplicates."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_drowned_facade_nyc")
    if coll is None:
        return 0
    placed = 0
    for name, x, y, sx, sy, sz, yaw, label in FACADE_PLACEMENTS:
        inst = _spawn_instance(coll, f"marina_bay_facade_{name}",
                               (x, y, -1.0),
                               rotation_z_deg=yaw, scale=(sx, sy, sz))
        inst["hb_landmark"] = label
        placed += 1
        print(f"  facade[{name}]  → ({x}, {y}) "
              f"scale=({sx}, {sy}, {sz:.2f}) yaw={yaw}°")
    return placed


# ────────────────────────────────────────────────────────────────────
# Wave zone — single murky-harbour zone covering the loop
# ────────────────────────────────────────────────────────────────────
#
# Marina Bay is sheltered + murky-flat per the track-themes brief:
# one wave zone covers the whole loop with height_mult 0.7 (lower
# amplitude than open sea) and freq_mult 1.2 (small choppy ripples
# riding on top of the low amplitude — reads as harbour wake, not
# Atlantic swell). 30 m blend keeps the edge invisible past the
# south perimeter.

WAVE_ZONE = {
    "name": "wave_zone_murky_harbour",
    "position": (0.0, 0.0, 0.0),
    "rotation_z_deg": 0.0,
    "half_width": 320.0,      # spans east container-street to west back-haul
    "half_height": 30.0,      # vertical extent (Blender Z)
    "half_depth": 300.0,      # spans south straight to tanker shortcut
    "height_mult": 0.7,
    "freq_mult": 1.2,
    "blend_radius_m": 30.0,
}


def _build_wave_zone(scene: bpy.types.Scene) -> None:
    """Drop the single murky-harbour wave-zone empty covering the
    full loop. Same custom-prop contract as the addon's *Add Wave
    Zone* operator — half_width / half_depth / height_mult / freq_mult
    / blend_radius_m drive the runtime sample volume."""
    z = WAVE_ZONE
    obj = bpy.data.objects.new("wave_zone_00", None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 8.0
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
    print(f"  wave_zone harbour → @ {z['position']} "
          f"× ({z['half_width']}×{z['half_depth']}), height_mult={z['height_mult']}, "
          f"freq_mult={z['freq_mult']}")


# ────────────────────────────────────────────────────────────────────
# Pickups + boost pads
# ────────────────────────────────────────────────────────────────────
#
# Six pickup empties along the racing line, deliberately NOT placed
# on the freighter-deck shortcut (anchors 7..9, x=-80..+80 / y≈220..235)
# — track-themes calls the freighter "anti-pickup territory" so the
# shortcut commits the player away from items as a tradeoff.
#
# Two boost pads: one before gauntlet entry (commit to ducking the
# arms instead of slowing through), one on the freighter-deck approach
# (commit to the shortcut climb instead of staying low).

PICKUP_POSITIONS = (
    ( -80.0, -200.0,  3.0),   # south straight, west end
    ( 100.0, -210.0,  3.0),   # south straight, east end
    ( 230.0,  -75.0,  5.0),   # gauntlet entry (slight reward for ducking arm 1)
    ( 230.0,   75.0,  5.0),   # gauntlet exit (reward for clean run)
    (-220.0,  -30.0,  3.0),   # west back-haul mid
    (-210.0, -150.0,  3.0),   # west back-haul south
)

BOOST_PADS = (
    # (name, x, y, z, half_width, half_depth, yaw_deg)
    # ── Before gauntlet entry — aims along +Y, committing the player
    #    into the gauntlet at speed (better to duck-and-go than coast).
    ("boost_00",  225.0, -135.0,  0.1, 3.5, 6.0,  85.0),
    # ── Tanker-deck approach — aims toward (0, 235, 8). Pad sits
    #    pre-ramp at the harbour-side of anchor 6 → 7 transition.
    ("boost_01",  130.0,  200.0,  0.5, 3.5, 6.0, 150.0),
)


def _build_pickups_and_boosts(scene: bpy.types.Scene) -> None:
    """Drop 6 pickup_NN + 2 boost_NN empties at the configured
    positions. Pickups carry kind="pickup_spawn" (NOT "pickup");
    boost pads carry kind="boost_pad" PLUS strength + half-extents
    per the validator contract in track_meta.py."""
    for i, pos in enumerate(PICKUP_POSITIONS):
        obj = bpy.data.objects.new(f"pickup_{i:02d}", None)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 2.0
        obj["kind"] = "pickup_spawn"
        obj.location = pos
        scene.collection.objects.link(obj)
        print(f"  pickup[{i:02d}]   → @ {pos}")
    for name, x, y, z, hw, hd, yaw in BOOST_PADS:
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 4.0
        obj["kind"] = "boost_pad"
        obj["half_width"] = hw
        obj["half_depth"] = hd
        obj["strength"] = 1.5
        obj.location = (x, y, z)
        obj.rotation_euler = (0.0, 0.0, math.radians(yaw))
        scene.collection.objects.link(obj)
        print(f"  {name}        → @ ({x}, {y}, {z}) yaw={yaw}° strength=1.5")


# ────────────────────────────────────────────────────────────────────
# Hero camera — 50 mm framing the tanker + gauntlet
# ────────────────────────────────────────────────────────────────────
#
# Park west of the beached tanker, ~30 m elevation, looking east
# along the tanker's long axis. From this pose the camera frames:
#   - the oxidized-red tanker silhouette (foreground hero)
#   - the five gantry cranes receding behind the tanker (mid-ground)
#   - harbour ambient + east warehouse facade (background)
#
# 50 mm matches the cape-town-drift framing — wider than the
# hatteras 35 mm because we have multiple silhouettes to compose,
# not a single isolated tower.

CAMERA_HERO_LOCATION = (-90.0, 240.0, 30.0)
CAMERA_HERO_TARGET   = (150.0, 235.0,  6.0)


def _add_camera_hero(scene: bpy.types.Scene) -> None:
    """Drop the ``camera_hero`` Camera west of the tanker, looking
    east along its length. Same camera-axis convention as the other
    seed scripts (-Z looks at target, +Y world-up)."""
    cam_data = bpy.data.cameras.new("camera_hero")
    cam_data.lens = 50.0
    cam_data.clip_start = 0.1
    cam_data.clip_end = 6000.0
    obj = bpy.data.objects.new("camera_hero", cam_data)
    obj["kind"] = "camera_hero"
    cam_pos = Vector(CAMERA_HERO_LOCATION)
    target = Vector(CAMERA_HERO_TARGET)
    obj.location = cam_pos
    delta = target - cam_pos
    obj.rotation_euler = delta.to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(obj)
    print(f"  camera_hero    → @ {tuple(round(c, 1) for c in cam_pos)} "
          f"aimed at {tuple(round(c, 1) for c in target)}")


# ────────────────────────────────────────────────────────────────────
# Sky preset — sodium-dusk industrial harbour. Without this push the
# export emits template-island's neutral defaults; with it, the JSON
# carries the warm-orange sodium-lamp tint the track-themes brief calls
# for. `nyc_sunset` is the closest bundled `colorGrade` to the
# track-themes "orange container stacks, sodium-lamp yellow" palette;
# no `industrial_haze` preset exists yet.
# ────────────────────────────────────────────────────────────────────

SKY_PRESET = {
    "tint":          "#ffb866",     # sodium-lamp warm orange
    "cloudiness":    0.5,           # overcast harbour
    "sun_intensity": 0.75,          # low — the sun is below the cranes
    "fog_near":      180.0,         # harbour haze closes in fast
    "fog_far":       900.0,
    "time_of_day":   320.0,         # late dusk (320 / 360 → just past sunset)
    "color_grade":   "nyc_sunset",  # closest bundled preset
    "bloom":         0.55,
    "sea_state":     2,             # sheltered harbour — small chop
}


def _apply_sky_preset(scene: bpy.types.Scene) -> None:
    """Push Marina Bay 7's sodium-dusk sky preset into scene props so
    ``derive_sky_block`` emits the right JSON. Mirrors the Maw / Kilauea
    / Sandbar pattern."""
    try:
        from hoverbike_addon.sky_preset import set_sky_tint_from_hex
    except ImportError:
        try:
            from hoverbike_addon_disk.sky_preset import set_sky_tint_from_hex
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
        print(f"  sky preset: sodium_dusk (Beaufort-{SKY_PRESET['sea_state']}, "
              f"{SKY_PRESET['color_grade']}, bloom={SKY_PRESET['bloom']})")


# ────────────────────────────────────────────────────────────────────
# Top-level augmentation orchestrator
# ────────────────────────────────────────────────────────────────────

def augment_scene() -> None:
    """Layer landmarks, decorations, the wave zone, pickups, boost
    pads and the hero camera onto the road-built scene. Called after
    ``build_track_from_spec`` returns — at that point ``terrain``,
    ``ai_spline_main``, the road mesh and the start/checkpoint
    empties all exist and are properly placed."""
    print("[marina-bay-7] augmenting scene with landmarks + props")
    scene = bpy.context.scene
    n_cranes = _build_gauntlet_cranes()
    _build_beached_tanker()
    _build_containers()
    n_facades = _build_harbour_facades()
    _build_wave_zone(scene)
    _build_pickups_and_boosts(scene)
    _add_camera_hero(scene)
    _apply_sky_preset(scene)
    print(f"[marina-bay-7] augment: {n_cranes} cranes + tanker + 12 containers + "
          f"{n_facades} facades + 1 wave zone + 6 pickups + 2 boost pads + camera_hero")

    # The spline brushes the beached tanker's deck-shortcut footprint;
    # the auto-shift nudges that one anchor off without disturbing the
    # gauntlet straight. Snapped back to terrain afterwards to recover
    # any z drift from the XY push.
    print("[marina-bay-7] shifting spline off industrial obstacles")
    bpy.ops.hoverbike.shift_spline_off_obstacles(margin=4.0)
    bpy.ops.hoverbike.snap_spline_to_terrain()

    # Save .blend with augmentation in place. build_track_from_spec
    # already saved + exported before we got here; this second save
    # captures the augmentation. The export below picks it all up.
    output_blend = os.path.join(REPO_ROOT, "tracks-src", "marina-bay-7.blend")
    bpy.ops.wm.save_as_mainfile(filepath=output_blend)
    print(f"[marina-bay-7] saved {output_blend} with augmentation")

    # Re-export so the GLB picks up the gantry cranes + tanker +
    # containers + facades + wave zone, and the JSON merges the new
    # wave-zone block. Without this step the GLB only matches the
    # post-build state — none of the augmentation lands at runtime
    # until the user manually clicks Export Track to Game. Mirrors
    # the pattern in seed_track_cape_town_drift::augment_scene.
    print("[marina-bay-7] re-exporting GLB + JSON + manifest")
    result = bpy.ops.hoverbike.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(
            f"[marina-bay-7] export_track (post-augment) failed: {result}"
        )


if __name__ == "__main__":
    try:
        build_track_from_spec(SPEC)
        augment_scene()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-marina-bay-7] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
