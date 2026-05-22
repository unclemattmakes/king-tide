"""Build ``tracks-src/the-maw.blend`` + GLB/JSON exports.

Run (after ``seed_template_island.py`` + ``seed_landmarks_library.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_the_maw.py

Or via pnpm:
    pnpm seed:track-the-maw

The trailer-shot hero track of v1 (Open Sea Cup #1). Race through three
rock arches in series on open Pacific off the (drowned) Big Sur coast.
Bixby Bridge collapsed in the floods; three rock arches form a natural
tunnel system. The middle arch — **The Maw** — is the largest, and the
hero set-piece: on the right swell you launch through with the crest;
wrong swell, a wall of water hits the arch as you enter.

Per [docs/track-themes.md § 4 The Maw](../../docs/track-themes.md):

  * Cup: Open Sea | Lap target: 60 s | Laps: 3
  * Water/Land: 100/0 — all-ocean, no land contact
  * Anti-grav: **none** — pure open-water wave-mastery test
  * Difficulty: showcase
  * Palette: golden-hour Pacific. Deep navy ocean, gold rocks, white
    foam, dramatic cloud shadows.
  * Audio: cinematic surf-rock. The music swells with the actual swells.

After ``build_track_from_spec(SPEC)`` returns, this script augments the
.blend with:

  * **3 × `landmark_arch_ruin` library-linked instances** at the arch
    positions. The middle (The Maw) is scaled ~1.6× with high decay;
    entry/exit arches scaled ~0.85× / ~1.0×. Each is tagged
    ``kind="track"`` so the racing line collides with the rock — the
    player threads *under* the arches, not through their bulk.
  * **4 × wave-zone empties** matching the brief: full-Pacific Beaufort-5
    swell, a tight directional swell at the Maw aimed into the arch
    entrance, a modest amplitude bump at the entry arch, and a calmer
    pocket downwind of the exit arch.
  * **6 pickup empties** + **2 boost pads** (kind=pickup_spawn,
    kind=boost_pad with strength=1.5).
  * **camera_hero** parked SE of the Maw at ~120 m elevation, 35 mm
    wide-angle, framing all three arches receding into a golden-hour
    sky.

Spline arc length is ~1423 m (closed-loop polyline; the NURBS smoothing
expands it ~3-5%, → ~1465-1495 m) → ~58-60 s at the open-sea target pace
of 25 m/s, hitting the 60 s lap target. The start sits mid-back-stretch
so the lap rotates the racing line through:

  start (back-loop midpoint) → SW return → S apex → forward stretch
  → entry arch (t≈0.29) → THE MAW (t≈0.45 — lap midpoint) → exit arch
  (t≈0.55) → NW corner → back-stretch → start

i.e. the hero set-piece (The Maw) is genuinely at the lap midpoint,
with the entry + exit arches flanking it on either side of t=0.5.
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

# Shared scatter helpers (Phase β of docs/level-visual-quality-research.md).
_scatter_spec = importlib.util.spec_from_file_location(
    "scatter_lib", os.path.join(SCRIPT_DIR, "scatter_lib.py"),
)
_scatter = importlib.util.module_from_spec(_scatter_spec)
sys.modules["scatter_lib"] = _scatter
_scatter_spec.loader.exec_module(_scatter)
drop_scatter_zones = _scatter.drop_scatter_zones

LANDMARKS_LIBRARY = os.path.join(REPO_ROOT, "tracks-src", "landmarks-library.blend")
PROPS_LIBRARY = os.path.join(REPO_ROOT, "tracks-src", "props-library.blend")


# ─────────────────────────────────────────────────────────────────────
# Track spec — threaded-arch loop, ~1423 m → 57-60 s lap @ 25 m/s
# ─────────────────────────────────────────────────────────────────────
#
# The forward stretch threads through three arches in series along a
# south→north corridor (X = 0±40). The back stretch is a wide open-
# Pacific loop with no landmarks. Start is parked mid-back-stretch so
# the hero set-piece (The Maw) lands at the lap midpoint:
#
#   ARCH_00_ENTRY  ( 40, -120)   t ≈ 0.291   smaller, scaled ~0.85×
#   ARCH_01_MAW    (  0,   40)   t ≈ 0.449   largest, scaled ~1.6× — HERO
#   ARCH_02_EXIT   (-40,  200)   t ≈ 0.549   medium, scaled ~1.0×
#
# No anti-grav curves — 100% open-water racing per the Cup brief.
#
# Per-segment XY arc lengths (snap_spline_to_terrain refines z):
#   start→close ≈ 164+190+40+80+82.5+82.5+82.5+82.5+63+140+215+200 ≈ 1423 m
# At the open-sea pace of 25 m/s that's ~57 s/lap polyline. Catmull-Rom
# smoothing adds 3-5% on the corners, landing at ~58-60 s — within the
# brief's 60 s target window.
SPEC = TrackSpec(
    track_id="the-maw",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-island.blend"),
    spline_anchors=[
        # ── Back-stretch midpoint — START here. Rotates the loop so the
        # hero Maw arch falls at the lap midpoint, not at t≈0.2.
        (-280.0, -140.0, -2.0),  # 0  t=0.000  start (mid-back-stretch)
        (-150.0, -240.0, -2.0),  # 1  t=0.115
        # ── Forward stretch — south-to-north through the three arches.
        (  40.0, -240.0, -2.0),  # 2  t=0.249  south apex (just past start lap)
        (  40.0, -200.0, -2.0),  # 3  t=0.277
        (  40.0, -120.0, -2.0),  # 4  t=0.333  ARCH_00 ENTRY (small)
        (  20.0,  -40.0, -2.0),  # 5  t=0.391
        (   0.0,   40.0, -2.0),  # 6  t=0.449  ARCH_01 THE MAW (hero, lap midpoint)
        ( -20.0,  120.0, -2.0),  # 7  t=0.507
        ( -40.0,  200.0, -2.0),  # 8  t=0.565  ARCH_02 EXIT (medium)
        ( -60.0,  260.0, -2.0),  # 9  t=0.609
        # ── Back stretch — wide open Pacific, no landmarks.
        (-200.0,  260.0, -2.0),  # 10 t=0.708
        (-280.0,   60.0, -2.0),  # 11 t=0.860
    ],
    # Four checkpoints — cp_01 lands on The Maw (t=0.45, hero gate);
    # cp_00 on the entry arch, cp_02 on the exit arch, cp_03 mid-back
    # straight as the rhythm anchor. cp_03's looser placement keeps the
    # back stretch readable as a single recovery beat.
    checkpoint_ts=(0.33, 0.45, 0.57, 0.85),
    # Open-Pacific feel — narrower than harbour tracks but generous
    # enough to thread cleanly under a 60 m arch span.
    road_width=11.0,
    road_lift=0.35,
    road_blend_radius=7.0,
    road_samples=128,
    road_smooth_passes=5,
    road_curb_width=0.6,
    road_curb_height=0.15,
    road_curb_stripe=2.0,
    road_thickness=0.55,
    gate_spacing_m=70.0,
    water_preview_size=900.0,
    water_preview_subdivisions=140,
)


# ─────────────────────────────────────────────────────────────────────
# Library linking helpers (mirrors seed_track_south_beach_sunken.py)
# ─────────────────────────────────────────────────────────────────────


def _link_collection(library_path: str, collection_name: str) -> bpy.types.Collection | None:
    """Link ``collection_name`` from ``library_path`` into the current
    scene, returning the linked Collection datablock. Idempotent — re-
    runs return the existing linked block."""
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
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
    kind: str = "decoration",
    extras: dict | None = None,
) -> bpy.types.Object:
    """Create a collection-instance empty referencing ``coll`` at world
    ``location``. The ``kind`` extra controls runtime collider attach
    — ``"track"`` makes the bike physically interact with the swept
    rock arch geometry (which is what we want for the three arches the
    player threads under)."""
    inst = bpy.data.objects.new(name, None)
    inst.instance_type = "COLLECTION"
    inst.instance_collection = coll
    inst.empty_display_size = 1.0
    inst.location = location
    inst.rotation_euler = (0.0, 0.0, math.radians(rotation_z_deg))
    inst.scale = scale
    inst["kind"] = kind
    if extras:
        for k, v in extras.items():
            inst[k] = v
    bpy.context.scene.collection.objects.link(inst)
    return inst


# ─────────────────────────────────────────────────────────────────────
# Arch placements
# ─────────────────────────────────────────────────────────────────────
#
# Each arch is a ``landmark_arch_ruin`` library instance. The library
# default is span ~60 m, rise ~22 m — the opening faces +Y, so we
# rotate the empty around Z so the opening faces along the racing-line
# tangent at that point (racing line is heading roughly +Y at all three
# arches, so a small offset rotation is enough for visual interest).
#
# The Maw (centre) is scaled 1.6× → ~96 m span — the bike threads
# through a generous opening but the surface curvature is still real.
# Entry arch is 0.85× → ~51 m span (rhythm-setting beat), exit 1.0×
# → ~60 m (recovery beat). All three carry kind="track" so the runtime
# stamps trimesh colliders against the swept arch surface — the player
# *can* hit a chip if they line up badly.
ARCH_INSTANCES: tuple[tuple[str, float, float, float, float, float, float, float, str], ...] = (
    # (instance_name, x, y, z, scale_xy, scale_z, rotation_z_deg, decay_amount, role)
    # Z=-3 puts the foot of the arch ~3 m below sea level so the base
    # disappears underwater (the rock rises from the swell).
    ("the_maw_arch_entry",   40.0, -120.0, -3.0, 0.85, 0.85,  -8.0, 0.30, "entry"),
    ("the_maw_arch_maw",      0.0,   40.0, -3.0, 1.60, 1.55,   4.0, 0.55, "maw"),
    ("the_maw_arch_exit",   -40.0,  200.0, -3.0, 1.00, 1.00,  12.0, 0.40, "exit"),
)


# ─────────────────────────────────────────────────────────────────────
# Scatter zones — sea-stack rocks flanking the three arches
# ─────────────────────────────────────────────────────────────────────
#
# Phase β step 7 of [docs/level-visual-quality-research.md](../../docs/level-visual-quality-research.md):
# extend the South Beach scatter pattern onto the existing-tropical
# tracks. The Maw's brief is open-Pacific with three rocky arches —
# so rocks (not palms) on the rocky outcrops that flank each arch.
# Each zone sits laterally offset from the racing line, far enough
# that the GN distribute-points won't touch the racing surface; the
# z_min altitude filter is a secondary safety, only seeding faces
# above the waterline.
#
# Five zones — one on each flank of each arch except the back-stretch
# (which the brief explicitly keeps "wide open Pacific, no landmarks").
SCATTER_ZONES: tuple[dict, ...] = (
    # Entry arch east flank — first rocky beat the player threads past.
    # ``location.z = 2.0`` puts the rock bases ~4 m above the racing
    # line (z=-2), visually "emerging from the swell". The default
    # ``z_min = -100`` from scatter_lib effectively disables the
    # altitude filter — the target plane is flat at zone.z so every
    # point passes; no need to constrain further.
    {
        "name": "scatter_00",
        "location": (110.0, -150.0, 2.0),
        "half_width": 50.0,
        "half_depth": 35.0,
        "density": 0.018,
        "source": "prop_rock",
        "seed": 11,
    },
    # Entry arch west flank.
    {
        "name": "scatter_01",
        "location": (-50.0, -150.0, 2.0),
        "half_width": 45.0,
        "half_depth": 35.0,
        "density": 0.014,
        "source": "prop_rock",
        "seed": 19,
    },
    # Hero Maw arch east flank — densest cluster on the track, the
    # rocky outcrop that frames the centre-arch silhouette in the hero
    # camera composition.
    {
        "name": "scatter_02",
        "location": (100.0, 40.0, 2.0),
        "half_width": 50.0,
        "half_depth": 55.0,
        "density": 0.022,
        "source": "prop_rock",
        "seed": 29,
    },
    # Hero Maw arch west flank — mirror of scatter_02.
    {
        "name": "scatter_03",
        "location": (-100.0, 40.0, 2.0),
        "half_width": 50.0,
        "half_depth": 55.0,
        "density": 0.022,
        "source": "prop_rock",
        "seed": 37,
    },
    # Exit arch east flank — fades the rocky chain back into open sea.
    {
        "name": "scatter_04",
        "location": (60.0, 220.0, 2.0),
        "half_width": 50.0,
        "half_depth": 40.0,
        "density": 0.014,
        "source": "prop_rock",
        "seed": 43,
    },
)


def _drop_scatter_zones(scene: bpy.types.Scene) -> int:
    """Drop the five Maw rock-scatter zones via the shared helper."""
    return drop_scatter_zones(scene, PROPS_LIBRARY, SCATTER_ZONES)


def _drop_arches(scene: bpy.types.Scene) -> int:
    """Link the ``landmark_arch_ruin`` collection and spawn the three
    arch instances. Returns the count placed (0 if library missing)."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_arch_ruin")
    if coll is None:
        return 0
    placed = 0
    for name, x, y, z, sxy, sz, rz, decay, role in ARCH_INSTANCES:
        inst = _spawn_instance(
            coll, name, (x, y, z),
            rotation_z_deg=rz,
            scale=(sxy, sxy, sz),
            # kind=track so the racing line collides with the rock arch
            # — the player threads under, not through, them.
            kind="track",
            extras={
                "set_piece": role,
                # decay_amount surfaces through to the runtime as
                # authoring metadata. The library's mesh decay is
                # baked at library-build time; this extra is purely a
                # readability hint for editors who open the .blend.
                "decay_amount": decay,
                "hb_landmark": "arch_ruin",
            },
        )
        print(f"  arch[{role:6s}]  → {inst.name} @ ({x}, {y}) "
              f"scale=({sxy:.2f}×{sxy:.2f}×{sz:.2f}) rot_z={rz}° decay={decay}")
        placed += 1
    return placed


# ─────────────────────────────────────────────────────────────────────
# Wave zones — four moods per the brief
# ─────────────────────────────────────────────────────────────────────
#
# 1. ``wave_zone_00`` (logical: pacific_swell) — full-track open-Pacific
#    Beaufort-5 swell. Big OBB covering the whole loop with a generous
#    40 m blend so the field reads continuous everywhere.
# 2. ``wave_zone_01`` (logical: maw_directional) — the wave-mastery
#    hero zone. Tight OBB centred at the Maw, rotated so local +X
#    (dominant swell) rolls *into* the arch entrance — i.e. swell
#    train comes from the SE / approach direction. height_mult 1.8,
#    freq_mult 0.7 (long fat rollers), 25 m soft blend.
# 3. ``wave_zone_02`` (logical: entry_arch) — modest amplitude bump
#    on the run-in to arch 1, teaches the rhythm before The Maw hits.
# 4. ``wave_zone_03`` (logical: exit_arch) — calmer pocket downwind
#    of the exit arch, recovery beat after the Maw moment.
#
# Naming: the runtime-side opt-in regex requires ``wave_zone_\d+$``
# (see ``_legacy.py::_merge_export_json``), so the names must be the
# numeric ``wave_zone_NN`` form. The brief's friendly names ride along
# as the ``display_name`` extra for editors.
#
# Local-axis convention: empty's +X is the dominant swell direction;
# yaw rotates that around world Z. The brief's "swell rolls into the
# arch entrance" maps to yaw_deg pointing local +X toward the arch
# entry — at the Maw the entry approach is from -Y (south) heading
# +Y, so a swell rolling into the arch entrance means local +X aligned
# with world +Y → yaw_deg = 90.
WAVE_ZONES: tuple[dict, ...] = (
    {
        "name": "wave_zone_00",
        "display_name": "wave_zone_pacific_swell",
        # Centred on the loop centroid; sized to envelope the whole
        # racing line + a generous margin so the blend envelope holds
        # amplitude continuous across the OBB face.
        "position": (-60.0, 0.0, 0.0),
        "rotation_z_deg": 90.0,    # ambient swell rolls roughly N-S (with the racing line)
        "half_width": 320.0,        # X half — long swell axis
        "half_height": 40.0,        # vertical clearance, mostly informational
        "half_depth": 300.0,        # Z half
        "height_mult": 1.5,         # Beaufort-5 baseline — heavy but readable
        "freq_mult": 0.85,          # longer wavelengths = rolling swells
        "blend_radius_m": 40.0,
    },
    {
        "name": "wave_zone_01",
        "display_name": "wave_zone_maw_directional",
        # Tight box around The Maw (arch_01 at world XY (0, 40)). Local
        # +X (swell direction) aligned with world +Y (the approach
        # direction) so the swell rolls *into* the arch from the south.
        "position": (0.0, 40.0, 0.0),
        "rotation_z_deg": 90.0,
        "half_width": 70.0,          # along swell train
        "half_height": 25.0,
        "half_depth": 45.0,          # across swell train (narrow)
        "height_mult": 1.8,          # hero swell — biggest amplitude on the track
        "freq_mult": 0.7,            # longest wavelengths — fat directional rollers
        "blend_radius_m": 25.0,      # soft 25 m blend back to ambient
    },
    {
        "name": "wave_zone_02",
        "display_name": "wave_zone_entry_arch",
        # Approach to the entry arch (arch_00 at world XY (40, -120)).
        # Modest amplitude bump to teach the rhythm before the Maw.
        "position": (40.0, -120.0, 0.0),
        "rotation_z_deg": 90.0,
        "half_width": 50.0,
        "half_height": 20.0,
        "half_depth": 40.0,
        "height_mult": 1.3,
        "freq_mult": 0.9,
        "blend_radius_m": 20.0,
    },
    {
        "name": "wave_zone_03",
        "display_name": "wave_zone_exit_arch",
        # Downwind of the exit arch (arch_02 at world XY (-40, 200)) —
        # calmer recovery pocket after the Maw moment. height_mult<1
        # lets the player breathe before the back-stretch loop.
        "position": (-40.0, 250.0, 0.0),
        "rotation_z_deg": 90.0,
        "half_width": 50.0,
        "half_height": 20.0,
        "half_depth": 50.0,
        "height_mult": 0.85,
        "freq_mult": 1.0,
        "blend_radius_m": 22.0,
    },
)


def _spawn_wave_zones(scene: bpy.types.Scene) -> int:
    """Drop the four wave-zone empties with their tuning custom props.
    Mirrors the addon's *Add Wave Zone* operator — names follow the
    ``wave_zone_NN`` regex so the export merge opt-in fires."""
    count = 0
    for z in WAVE_ZONES:
        obj = bpy.data.objects.get(z["name"])
        if obj is None:
            obj = bpy.data.objects.new(z["name"], None)
            scene.collection.objects.link(obj)
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
        obj.rotation_euler = (0.0, 0.0, math.radians(z["rotation_z_deg"]))
        count += 1
        print(f"  wave_zone[{z['display_name']:30s}] → {obj.name} "
              f"@ ({z['position'][0]}, {z['position'][1]}) "
              f"height_mult={z['height_mult']} freq_mult={z['freq_mult']}")

    # Refresh the visual gizmos so a follow-up Blender session opens
    # the .blend with the zones already drawn. Best-effort — silent on
    # ImportError because the seed runs against ``hoverbike_addon_disk``
    # under a bespoke module name.
    try:
        from hoverbike_addon.wave_zone import refresh_wave_zone_gizmos
        refresh_wave_zone_gizmos(scene)
    except ImportError:
        pass
    return count


# ─────────────────────────────────────────────────────────────────────
# Pickups + boost pads
# ─────────────────────────────────────────────────────────────────────
#
# Six pickups spaced along the racing line — roughly one every 10 s at
# lap pace. Two boost pads:
#   * approach to the Maw — rewards committing to the hero arch line
#   * exit straight — propels the player onto the back-stretch return
#
# CRITICAL contracts (validator rejects otherwise):
#   * pickup empties use ``kind = "pickup_spawn"`` (NOT "pickup")
#   * boost pads need ``strength`` extra (not just half_width/half_depth)

PICKUP_POSITIONS: tuple[tuple[str, float, float, float], ...] = (
    ("pickup_00",    40.0, -200.0, 3.0),  # start straight
    ("pickup_01",    40.0,  -60.0, 3.0),  # post-entry-arch
    ("pickup_02",     0.0,   40.0, 6.0),  # threading the Maw — lifted to clear the arch
    ("pickup_03",   -40.0,  200.0, 3.0),  # at the exit arch
    ("pickup_04",  -260.0,  180.0, 3.0),  # NW open-water turn
    ("pickup_05",  -260.0, -100.0, 3.0),  # SW open-water straight
)

# Boost pads — half_width × half_depth in metres; rotation_z aimed along
# the local racing-line tangent so the boost vector pushes the bike
# forward along the line.
#
# Pad 0 — Maw approach: racing line heads roughly +Y, so boost vector
# (= rotation·+Z) needs yaw such that rotation·(+Z) points world +Y.
# In the addon's convention (used by South Beach + Hatteras) we
# author rotation_z_deg in plain world degrees; the export pass
# converts to a quat aligned with this convention. The South Beach
# seed used yaw 85° / -95° to aim +Z forward along the racing line;
# we'll match that pattern.
BOOST_PADS: tuple[tuple[str, float, float, float, float, float, float], ...] = (
    # (name, x, y, z, half_width, half_depth, rotation_z_deg)
    # Maw approach — racing line heading +Y, boost vector +Y.
    ("boost_00",  20.0,  -20.0, 0.5, 3.0, 6.0,  0.0),
    # Exit-straight rejoin — back-stretch heading SW from (-60, 260) →
    # (-200, 260) → (-280, 60), so the boost is roughly aimed -Y here.
    ("boost_01", -130.0, 260.0, 0.5, 3.0, 6.0, 180.0),
)


def _drop_pickups(scene: bpy.types.Scene) -> int:
    """Place pickup spawn empties along the racing line. ``kind`` is
    explicitly set so a headless run that skips the auto-tag depsgraph
    callback still ships them correctly. **Must be "pickup_spawn", not
    "pickup"** — the validator rejects bare "pickup"."""
    for name, x, y, z in PICKUP_POSITIONS:
        obj = bpy.data.objects.get(name)
        if obj is None:
            obj = bpy.data.objects.new(name, None)
            scene.collection.objects.link(obj)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 2.0
        obj["kind"] = "pickup_spawn"  # NOT "pickup" — validator-critical
        obj.location = (x, y, z)
    return len(PICKUP_POSITIONS)


def _drop_boost_pads(scene: bpy.types.Scene) -> int:
    """Drop two boost pads on the racing line — one before the Maw,
    one on the exit straight. All three of ``half_width``,
    ``half_depth``, and ``strength`` are required by the kind=boost_pad
    validator contract."""
    for name, x, y, z, hw, hd, rz in BOOST_PADS:
        obj = bpy.data.objects.get(name)
        if obj is None:
            obj = bpy.data.objects.new(name, None)
            scene.collection.objects.link(obj)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 4.0
        obj["kind"] = "boost_pad"
        obj["half_width"] = float(hw)
        obj["half_depth"] = float(hd)
        obj["strength"] = 1.5   # validator-critical; boost pads w/o this fail export
        obj.location = (x, y, z)
        obj.rotation_euler = (0.0, 0.0, math.radians(rz))
    return len(BOOST_PADS)


# ─────────────────────────────────────────────────────────────────────
# Hero camera — frames all three arches in receding scale
# ─────────────────────────────────────────────────────────────────────
#
# Parked SE of the Maw at ~120 m elevation looking NW. From (180,
# -100, 120) the three arches recede along the line of sight: the
# entry arch (40, -120) is closest at ~145 m, the Maw (0, 40) is mid-
# ground at ~245 m, and the exit arch (-40, 200) is the farthest at
# ~370 m. 35 mm focal length keeps the wide-angle dramatic feel the
# brief asks for ("cinematic open-Pacific arch racing").
CAMERA_HERO_LOCATION = (180.0, -100.0, 120.0)
CAMERA_HERO_TARGET = (-20.0, 100.0, 20.0)  # roughly between the Maw and exit arch
CAMERA_HERO_FOCAL_MM = 35.0


def _drop_camera_hero(scene: bpy.types.Scene) -> bpy.types.Object:
    """Add a ``camera_hero`` Camera SE of the Maw at ~120 m altitude
    looking NW, 35 mm wide. The thumbnail render reads ``kind=camera_hero``
    to find this; the runtime ignores it."""
    import mathutils

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
    cam_data.clip_end = 6000.0

    obj = bpy.data.objects.new(name, cam_data)
    obj["kind"] = "camera_hero"
    obj.location = CAMERA_HERO_LOCATION

    # Aim -Z toward the target, +Y world-up. Same convention as the
    # addon's *Add Camera Hero* operator (thumbnail.py::_aim_camera_at).
    target = mathutils.Vector(CAMERA_HERO_TARGET)
    delta = target - mathutils.Vector(CAMERA_HERO_LOCATION)
    if delta.length > 1e-4:
        obj.rotation_euler = delta.to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(obj)
    print(f"  camera_hero    → @ {tuple(round(c, 1) for c in CAMERA_HERO_LOCATION)} "
          f"aim {tuple(round(c, 1) for c in CAMERA_HERO_TARGET)} "
          f"lens={CAMERA_HERO_FOCAL_MM} mm")
    return obj


# ─────────────────────────────────────────────────────────────────────
# Sky preset — push golden-hour Pacific into the scene props so the
# export pass derives the right sky block. ``derive_sky_block`` always
# emits a populated block from the scene props (treating Blender as
# canonical for sky); without this push the exporter would overwrite
# our JSON stub's golden-hour values with the template's neutral
# defaults.
# ─────────────────────────────────────────────────────────────────────

SKY_PRESET = {
    "tint":             "#ffdb8a",          # warm golden tint
    "cloudiness":       0.45,
    "sun_intensity":    1.05,
    "fog_near":         400.0,
    "fog_far":          2000.0,
    "time_of_day":      0.0,
    "color_grade":      "big_sur_golden",   # the canonical Big Sur preset
    "bloom":            0.7,
    "sea_state":        5,                  # Beaufort-5 — open Pacific
}


def _apply_sky_preset(scene: bpy.types.Scene) -> None:
    """Push the golden-hour Pacific sky preset into scene props so
    ``derive_sky_block`` emits the right JSON. The sky_preset module
    owns the tint↔RGB conversion; we lazy-import it so the seed isn't
    coupled to the addon load order beyond what build_track_from_spec
    already established."""
    try:
        from hoverbike_addon.sky_preset import set_sky_tint_from_hex
    except ImportError:
        # The track_build_lib loads the addon under "hoverbike_addon_disk".
        # Try that path before giving up.
        try:
            from hoverbike_addon_disk.sky_preset import set_sky_tint_from_hex
        except ImportError:
            print("  WARN: sky_preset module not reachable headless — "
                  "JSON stub's sky block will survive instead of being "
                  "overwritten by scene defaults. (acceptable: stub has "
                  "the right values.)")
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
        print(f"  sky preset: golden_hour Pacific (Beaufort-5, "
              f"big_sur_golden, bloom={SKY_PRESET['bloom']})")


# ─────────────────────────────────────────────────────────────────────
# Top-level augmentation orchestrator
# ─────────────────────────────────────────────────────────────────────


def augment_scene() -> None:
    """Layer arches, wave zones, pickups, boost pads, hero camera onto
    the road-built scene. Called after ``build_track_from_spec`` returns
    — at that point ``terrain``, ``ai_spline_main``, the road mesh and
    the start / checkpoint empties all exist."""
    tag = "[seed-track-the-maw]"
    print(f"{tag} augmenting scene with arches + wave zones + props")
    scene = bpy.context.scene

    arches = _drop_arches(scene)
    scatter = _drop_scatter_zones(scene)
    waves = _spawn_wave_zones(scene)
    pickups = _drop_pickups(scene)
    boosts = _drop_boost_pads(scene)
    _drop_camera_hero(scene)
    _apply_sky_preset(scene)

    print(
        f"{tag} augment: {arches} arches + {scatter} scatter zones + "
        f"{waves} wave zones + {pickups} pickups + {boosts} boost pads "
        f"+ camera_hero"
    )

    # Save .blend with the augmentation in place — build_track_from_spec
    # already saved the road state earlier; we need this second save so
    # the .blend matches the GLB we're about to re-export.
    output_blend = os.path.join(REPO_ROOT, "tracks-src", "the-maw.blend")
    bpy.ops.wm.save_as_mainfile(filepath=output_blend)
    print(f"{tag} saved {output_blend} with augmentation")

    # Re-export so the GLB picks up the arches (kind=track collidable)
    # and the JSON merges the new wave-zone block + boost pads. Without
    # this step the GLB only matches the post-build state — none of the
    # augmentation lands at runtime until the user manually clicks
    # Export Track to Game.
    print(f"{tag} re-exporting GLB + JSON + manifest")
    result = bpy.ops.hoverbike.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(f"{tag} export_track (post-augment) failed: {result}")


if __name__ == "__main__":
    try:
        build_track_from_spec(SPEC)
        augment_scene()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-the-maw] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
