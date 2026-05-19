"""Build ``tracks-src/doges-drift.blend`` + GLB/JSON exports.

Run (after ``seed_template_downtown.py`` and ``seed_landmarks_library.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_doges_drift.py

Or via pnpm:
    pnpm seed:track-doges-drift

Reshape: drowned Venice. Acqua alta finally won — the canals are now
just ocean, the Doge's Palace facade is half-submerged, lion-column
tops poke out of the lagoon. The racing line is a winding canal loop
that threads **under the partially-collapsed Rialto arch** at t≈0.3
(racing line dips just below z=0 so the bike threads through the
broken arch like a tunnel), then spirals up the **St. Mark's Campanile
shaft** at t≈0.7–0.85 — the brick exterior is the anti-grav surface,
the bike exits through the open belfry with the gold St Mark's domes
+ drowned palazzi below.

Continental Cup race #4. 60 s lap target @ ~25 m/s → ~1500 m arc
length. 70/30 water/land split (mostly canals, three "land" beats:
Doge's Palace, the Rialto threading, and the Campanile climb itself).
Built on ``template-downtown`` since Venice reads as a dense urban
basin rather than a beach or an open Atlantic — the downtown template
ships flat-water + a low-mountain horizon ring that we override.

After ``build_track_from_spec(SPEC)`` returns this script augments
the scene with:

  * **Campanile**     — 1× ``landmark_tower_cylinder_spiral`` linked
                        instance, scaled Z×1.7 (60 m archetype →
                        ~102 m, matches the real 98.6 m). Tagged
                        ``kind=track`` so the cylindrical shaft is
                        collidable; the spiral stripes re-tint as
                        Venetian brick at runtime.
  * **Rialto arch**   — 1× ``landmark_arch_ruin`` linked instance
                        scaled ×0.5 (60 m archetype span → ~30 m,
                        matches the real ~28 m Rialto span). Straddles
                        the racing line at the t≈0.3 dip so the spline
                        threads under it. Tagged ``kind=track``.
  * **Palazzi belt**  — 3× ``landmark_drowned_facade_venice`` linked
                        instances at varied scale + rotation. The
                        biggest reads as the Doge's Palace facade on
                        the start straight. Tagged ``kind=track``.
  * **Murano bell**   — 1× ``landmark_mechanical_rig`` linked instance
                        at the top of the Campanile (~z=55 m, belfry
                        exit altitude). The archetype carries
                        ``swing_period_s`` / ``swing_amplitude_deg``
                        metadata for the future bell-swing animation.
                        Tagged ``kind=decoration`` — the player rides
                        *past* the bell, doesn't collide with it.
  * **Campanile climb** — programmatic Bezier ``antigrav_curve_00``
                        spiralling once up the outside of the
                        Campanile shaft (z=5 → z=55 over 6 control
                        points). Swept by ``build_antigrav_ribbon_from_curve``
                        with the same ``PROFILE_TUBE`` the Hatteras
                        corkscrew uses.
  * **Adriatic wave**  — 1× ``wave_zone_adriatic_calm`` covering the
                        whole loop; height_mult 0.6 (sheltered lagoon
                        + Adriatic = flat-calm), freq_mult 0.9, 30 m
                        blend radius.
  * **Pickups + boosts** — 6 pickups along the loop (one mid-Campanile
                        at lamp-room altitude, mirroring Hatteras's
                        mid-corkscrew pickup), 2 boost pads (one on
                        the canal straight before the Rialto, one on
                        the recovery straight after the Campanile).
  * **camera_hero**   — 40 mm camera parked SE of the Campanile at
                        ~25 m elevation, looking NW so the frame
                        captures Campanile + Rialto + a couple of
                        palazzi + the Adriatic horizon under a
                        golden-hour ochre warmth.

Phase D Sprint 2 (Continental Cup) of
[docs/v1-asset-pipeline-plan.md](../../docs/v1-asset-pipeline-plan.md);
content brief at [docs/track-themes.md § Doge's Drift](../../docs/track-themes.md).
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
# Track shape — winding canal loop, ~1511 m arc → ~60.5 s lap @ 25 m/s.
# ─────────────────────────────────────────────────────────────────────
#
# Layout (XY world coords; Z is the climb axis in Blender; lagoon level
# is z=-2 to match the drowned-canal brief). The Campanile sits at the
# world origin (0,0,0) so the spiral curve maths stay clean. The Rialto
# bridge straddles the racing line at anchor[4] (~(175, 40), z=-3). The
# Doge's Palace + palazzi sit around the south + east edges. Closed
# loop runs CCW (south → east → north → west → Campanile → south).
#
#   start straight (south)
#       │
#       └─→ SE turn into east canal
#                 │
#                 └─→ CP0 east-canal exit
#                            │
#                            └─→ RIALTO ARCH (anchor 4, z=-3 dip)
#                                          │
#                                          └─→ CP1 NE palazzo bend
#                                                          │
#                                                          ▼
#                                          N apex past palazzi cluster
#                                                          │
#                              ◄──── CP2 NW canal ─────────┘
#                                          │
#                                          ▼
#                              WSW Campanile approach (anchor 9)
#                                          │
#                                          └─→ CAMPANILE CLIMB
#                                              (anchors 10-12, z=6→55)
#                                                          │
#                                                          ▼
#                                          CP3 belfry exit (mid-climb)
#                                                          │
#                              descending recovery straight│
#                                          │
#                                          └─→ rejoin start
#
# Total polyline arc ≈ 1511 m. Catmull-Rom smoothing pulls anchors in
# slightly so the final arc is closer to 1500 m at lap pace.
SPEC = TrackSpec(
    track_id="doges-drift",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-downtown.blend"),
    spline_anchors=[
        # Start straight south of Doge's Palace. Lagoon level z=-2.
        (   0.0, -240.0, -2.0),  # 0  t=0.000  start (south straight)
        ( 120.0, -220.0, -2.0),  # 1  t=0.080  SE turn into east canal
        ( 210.0, -130.0, -2.0),  # 2  t=0.165  east canal straight
        ( 215.0,  -30.0, -2.0),  # 3  t=0.231  Rialto approach
        # RIALTO ARCH — racing line dips below the lagoon surface so
        # the bike threads UNDER the partially-collapsed arch like a
        # tunnel. z=-3 is 1 m below the lagoon surface; the arch's
        # underside clears the road by the arch_ruin's 22 m rise.
        ( 175.0,   40.0, -3.0),  # 4  t=0.284  RIALTO ARCH (the postcard moment)
        ( 110.0,  130.0, -2.0),  # 5  t=0.358  exit Rialto, NE canal
        (  10.0,  200.0, -2.0),  # 6  t=0.439  N apex past palazzi
        (-100.0,  185.0, -2.0),  # 7  t=0.512  NW canal
        (-165.0,   95.0, -2.0),  # 8  t=0.585  WSW Campanile approach
        ( -95.0,  -20.0,  0.0),  # 9  t=0.675  ramp-up entry (z lifts off water)
        # CAMPANILE CLIMB — spline anchors climb from z=6 to z=55 as
        # the bike spirals up the outside of the Campanile shaft. The
        # anti-grav curve sweep below builds the actual ridable tube
        # surface; these anchors place the AI spline + checkpoint set
        # at the right altitudes for the camera and the gate placer.
        ( -25.0,  -10.0,  6.0),  # 10 t=0.722  CAMPANILE BASE (climb start)
        ( -25.0,   15.0, 28.0),  # 11 t=0.744  mid Campanile (lamp-room altitude)
        (  10.0,   20.0, 55.0),  # 12 t=0.773  BELFRY EXIT — top of Campanile
        # Descend into the recovery straight; bike falls back to
        # lagoon level over a long lazy arc, rejoining the start.
        (  55.0,  -55.0, 22.0),  # 13 t=0.835  descending recovery
        ( -55.0, -180.0, -2.0),  # 14 t=0.946  rejoin start straight
    ],
    # Four checkpoints. cp_00 sits in the east canal entry, cp_01 just
    # past the Rialto (so threading the arch IS hitting the gate),
    # cp_02 at the NW canal mid-point, cp_03 at the belfry exit
    # (so finishing the climb is the final-gate moment, mirroring
    # Hatteras's mid-corkscrew cp_03).
    checkpoint_ts=(0.15, 0.32, 0.55, 0.80),
    # Canal-wide road. 11 m matches Cape Town's harbour feel but
    # narrower than South Beach's 12 m boulevard — Venice's canals
    # are tighter, the player should read them as canals not
    # boulevards.
    road_width=11.0,
    road_lift=0.3,
    road_blend_radius=7.0,
    road_samples=144,        # extra samples — the Campanile spiral
                              # needs smooth altitude reads
    road_smooth_passes=5,
    road_curb_width=0.7,
    road_curb_height=0.15,
    road_curb_stripe=2.2,
    road_thickness=0.55,
    gate_spacing_m=60.0,
    # Lagoon-sized water preview — Venice is sheltered, not Atlantic.
    water_preview_size=700.0,
    water_preview_subdivisions=128,
)


# ─────────────────────────────────────────────────────────────────────
# Library linking helpers — copied from seed_track_south_beach_sunken.
# ─────────────────────────────────────────────────────────────────────

LANDMARKS_LIBRARY = os.path.join(REPO_ROOT, "tracks-src", "landmarks-library.blend")


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
    scale: tuple[float, float, float] | float = 1.0,
    kind: str = "track",
) -> bpy.types.Object:
    """Create a collection-instance empty referencing ``coll`` at world
    ``location``. ``scale`` may be a uniform scalar or per-axis triple
    (the Campanile needs non-uniform Z scaling to read as 100 m tall;
    the Rialto stays uniform). ``kind`` lands on the empty as a custom
    property — the runtime walks the empties at GLB load and routes
    each per its kind (track = collidable, decoration = render-only)."""
    inst = bpy.data.objects.new(name, None)
    inst.instance_type = "COLLECTION"
    inst.instance_collection = coll
    inst.empty_display_size = 1.0
    inst.location = location
    inst.rotation_euler = (0.0, 0.0, math.radians(rotation_z_deg))
    if isinstance(scale, (int, float)):
        inst.scale = (float(scale), float(scale), float(scale))
    else:
        inst.scale = scale
    inst["kind"] = kind
    bpy.context.scene.collection.objects.link(inst)
    return inst


# ─────────────────────────────────────────────────────────────────────
# Landmark placements — Campanile, Rialto, Doge's Palace + palazzi, bell
# ─────────────────────────────────────────────────────────────────────

# Campanile geometry. The real St Mark's Campanile is 98.6 m tall; the
# archetype is 60 m → scale Z 1.7× lands ~102 m. The shaft sits at the
# world origin so the anti-grav curve maths below stay clean.
CAMPANILE_LOCATION = (0.0, 0.0, 0.0)
CAMPANILE_SCALE = (1.0, 1.0, 1.7)   # Z×1.7 → ~102 m tall
CAMPANILE_ROTATION_DEG = 0.0

# Rialto. Real bridge span is ~28 m; archetype is 60 m → ×0.5 lands
# ~30 m, with proportional drop in arch rise (from 22 m to 11 m) — the
# 11 m underside still clears the racing line by ~10 m at z=-3.
RIALTO_LOCATION = (175.0, 40.0, 0.0)
RIALTO_SCALE = 0.5
# Rotate so the arch span is perpendicular to the racing line at
# anchor[4]. The local tangent at anchor 4 is (anchor[5] - anchor[3])
# = (110-215, 130-(-30)) = (-105, 160), so the racing line points
# NNW; the arch should run perpendicular (ENE, ~57° from +X).
# We rotate the arch's local X (the span axis) so it lies along ENE,
# which means a yaw of 57° + 90° = 147° around +Z.
RIALTO_ROTATION_DEG = 147.0

# Palazzi placements. Three instances, varied scale + rotation so they
# don't read as clones. The biggest reads as the Doge's Palace facade
# on the start straight (south of the racing line at anchor[0..1]).
PALAZZI_INSTANCES: tuple[tuple[str, float, float, float, float, tuple[float, float, float]], ...] = (
    # (name, x, y, z, rotation_z_deg, scale_xyz)
    # Doge's Palace — start straight south side, biggest. The
    # facade archetype is 40 m × 18 m; scale ×1.4 widens to ~56 m
    # so the Doge's reads as the dominant palazzo.
    ("doges_palace",          50.0, -290.0, -1.0,  -10.0, (1.4, 1.0, 1.3)),
    # NE palazzo — between the Rialto exit and the N apex.
    ("palazzo_san_marco",    100.0,  175.0, -1.0,  165.0, (1.0, 1.1, 1.0)),
    # NW palazzo — across the canal from the Doge's, on the west
    # bank. Smaller, rotated to face the canal.
    ("palazzo_grimani",     -155.0,  145.0, -1.0,  130.0, (1.05, 0.95, 0.9)),
)

# Murano bell — sits at the top of the Campanile, ~55 m altitude, just
# inside the open belfry arch. Scaled small (×0.15) so the 40 m
# archetype reads as a ~6 m bell mechanism. Mechanical-rig archetype
# carries swing_period_s + swing_amplitude_deg extras; we re-tune them
# small + fast so the bell reads as ringing (not as a Marina Bay
# gantry crane swinging across the deck).
BELL_LOCATION = (5.0, 0.0, 55.0)
BELL_SCALE = (0.15, 0.15, 0.18)
BELL_ROTATION_DEG = 0.0
BELL_SWING_PERIOD_S = 2.5      # bell tolls on the half-second
BELL_SWING_AMPLITUDE_DEG = 18.0
BELL_SWING_AXIS = "Y"          # swing toward / away from the rider, not laterally


def _build_campanile(scene) -> None:
    """Drop the Campanile shaft as a library-linked tower instance.
    Tagged kind=track so the cylindrical brick exterior is collidable
    (the bike's anti-grav climb runs against this surface)."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_tower_cylinder_spiral")
    if coll is None:
        return
    inst = _spawn_instance(
        coll, "campanile_san_marco",
        location=CAMPANILE_LOCATION,
        rotation_z_deg=CAMPANILE_ROTATION_DEG,
        scale=CAMPANILE_SCALE,
        kind="track",
    )
    inst["hb_landmark"] = "campanile_san_marco"
    print(
        f"  Campanile     → {inst.name} @ {CAMPANILE_LOCATION} "
        f"scale={CAMPANILE_SCALE} (~{60 * CAMPANILE_SCALE[2]:.0f} m tall)"
    )


def _build_rialto(scene) -> None:
    """Drop the Rialto Bridge arch as a library-linked arch_ruin
    instance, scaled ×0.5 so the 60 m archetype span becomes ~30 m
    (real Rialto is 28.8 m). Positioned to straddle the racing line
    at anchor[4] — the bike threads through the arch like a tunnel.

    Tagged kind=track so the swept arch geometry is collidable; the
    racing line dips 1 m below water level at this anchor to clear
    the arch's underside (11 m at this scale) with ~10 m headroom."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_arch_ruin")
    if coll is None:
        return
    inst = _spawn_instance(
        coll, "rialto_arch",
        location=RIALTO_LOCATION,
        rotation_z_deg=RIALTO_ROTATION_DEG,
        scale=RIALTO_SCALE,
        kind="track",
    )
    inst["hb_landmark"] = "rialto_bridge"
    inst["set_piece"] = "rialto_threading"
    print(
        f"  Rialto        → {inst.name} @ {RIALTO_LOCATION} "
        f"scale=×{RIALTO_SCALE} rot={RIALTO_ROTATION_DEG:.0f}°"
    )


def _build_palazzi(scene) -> None:
    """Drop three drowned-Venice palazzo facades around the loop. The
    biggest reads as the Doge's Palace on the start straight; the
    others are varied along the NE + NW canal banks."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_drowned_facade_venice")
    if coll is None:
        return
    for name, x, y, z, rz, sc in PALAZZI_INSTANCES:
        inst = _spawn_instance(
            coll, name,
            location=(x, y, z),
            rotation_z_deg=rz,
            scale=sc,
            kind="track",
        )
        inst["hb_landmark"] = name
        print(
            f"  palazzo       → {inst.name} @ ({x:.0f}, {y:.0f}, {z:.0f}) "
            f"scale={sc} rot={rz:.0f}°"
        )


def _build_bell(scene) -> None:
    """Drop the Murano bell at the top of the Campanile (~z=55 m, the
    belfry exit altitude). Tagged kind=decoration — the player rides
    past the bell, doesn't collide with it (the Campanile shaft below
    is the actual collidable surface).

    The mechanical_rig archetype's swing_period_s / swing_amplitude_deg
    metadata is re-tuned on this instance for the bell-toll feel; the
    runtime ignores them today but they're in place for the next
    animation pass."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_mechanical_rig")
    if coll is None:
        return
    inst = _spawn_instance(
        coll, "campanile_bell",
        location=BELL_LOCATION,
        rotation_z_deg=BELL_ROTATION_DEG,
        scale=BELL_SCALE,
        kind="decoration",  # ride past, not into
    )
    inst["hb_landmark"] = "campanile_bell"
    inst["set_piece"] = "swinging_bell"
    # Per-instance swing tuning — overrides the archetype defaults
    # (12 s / 40° Marina Bay gantry → 2.5 s / 18° bell toll).
    inst["swing_period_s"] = BELL_SWING_PERIOD_S
    inst["swing_amplitude_deg"] = BELL_SWING_AMPLITUDE_DEG
    inst["swing_axis"] = BELL_SWING_AXIS
    print(
        f"  Murano bell   → {inst.name} @ {BELL_LOCATION} "
        f"scale={BELL_SCALE} "
        f"swing=({BELL_SWING_PERIOD_S}s, {BELL_SWING_AMPLITUDE_DEG}°, {BELL_SWING_AXIS})"
    )


# ─────────────────────────────────────────────────────────────────────
# Anti-grav Campanile climb — vertical tube up the Campanile shaft
# ─────────────────────────────────────────────────────────────────────
#
# Direct port of seed_track_hatteras_light.py::_add_antigrav_corkscrew.
# The Campanile is wider than the Hatteras lighthouse (8 m vs 5 m
# base radius at archetype default), and the climb is longer (5→55 m
# vs 5→35 m), but the spiral-tube structure is identical.

# Campanile shaft has the tower_cylinder_spiral archetype's base
# radius of ~8 m (per seed_landmarks_library; default tower is 60 m
# tall × 16 m diameter ≈ 8 m radius). The anti-grav tube clings to
# the outside of that shaft with a small clearance.
CAMPANILE_BASE_R_M = 8.0
CORKSCREW_RADIUS_M = CAMPANILE_BASE_R_M + 6.0 + 1.5   # ~15.5 m from Campanile axis
CORKSCREW_Z_MIN_M = 5.0    # ~5 m above lagoon — clears the half-submerged base
CORKSCREW_Z_MAX_M = 55.0   # belfry exit altitude (matches anchor[12].z)
CORKSCREW_TUBE_RADIUS_M = 6.0
CORKSCREW_CONTROL_POINTS = 6
CORKSCREW_SAMPLES = 96


def _campanile_climb_control_points() -> list[tuple[float, float, float]]:
    """Six (x, y, z) anchors winding once around the Campanile axis,
    climbing from CORKSCREW_Z_MIN_M to CORKSCREW_Z_MAX_M. Entry angle
    is chosen so the curve starts WSW of the Campanile — matching the
    spline approach from anchor[9] (the WSW approach at (-95,-20))."""
    points: list[tuple[float, float, float]] = []
    # Entry angle: WSW of the Campanile (~π + π/4 = 5π/4 ≈ 225°).
    # The bike approaches from the SW; the spiral runs once around the
    # Campanile and exits at the belfry on the NE side (one full
    # winding from the entry).
    theta_start = math.radians(225.0)
    theta_end = theta_start + math.tau
    for i in range(CORKSCREW_CONTROL_POINTS):
        t = i / (CORKSCREW_CONTROL_POINTS - 1)
        theta = theta_start + (theta_end - theta_start) * t
        z = CORKSCREW_Z_MIN_M + (CORKSCREW_Z_MAX_M - CORKSCREW_Z_MIN_M) * t
        x = math.cos(theta) * CORKSCREW_RADIUS_M
        y = math.sin(theta) * CORKSCREW_RADIUS_M
        points.append((x, y, z))
    return points


def _add_antigrav_campanile_climb(scene) -> bool:
    """Programmatically create ``antigrav_curve_00`` (Bezier with 6
    AUTO-handle control points spiralling up the Campanile) and call
    ``build_antigrav_ribbon_from_curve`` to sweep a TUBE surface +
    stamp the entry / exit zone empties. Direct port of
    seed_track_hatteras_light.py::_add_antigrav_corkscrew with the
    Campanile-tuned radius + Z range.

    Returns True on success, False (with a console warning) if the
    antigrav_ribbon module isn't reachable headlessly — the curve
    stays in the scene so an author can click *Build Anti-Grav Surface*
    in the sidebar to finish the job."""
    curve_data = bpy.data.curves.new("antigrav_curve_00", type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 32  # smooth read at race speed
    spline_obj = curve_data.splines.new(type="BEZIER")
    cps = _campanile_climb_control_points()
    spline_obj.bezier_points.add(len(cps) - 1)  # 1 implicit + N-1 new
    for bp, (x, y, z) in zip(spline_obj.bezier_points, cps):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    spline_obj.use_cyclic_u = False

    curve_obj = bpy.data.objects.new("antigrav_curve_00", curve_data)
    curve_obj["kind"] = "antigrav_curve"
    scene.collection.objects.link(curve_obj)

    try:
        from hoverbike_addon.antigrav_ribbon import (
            build_antigrav_ribbon_from_curve,
            PROFILE_TUBE,
        )
    except ImportError:
        try:
            result = bpy.ops.hoverbike.build_antigrav_surface()
            if "FINISHED" in result:
                return True
        except (AttributeError, RuntimeError) as e:
            print(
                f"[seed-track-doges-drift] WARN: antigrav_ribbon not "
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


# ─────────────────────────────────────────────────────────────────────
# Wave zone — sheltered Adriatic lagoon, one zone covering the loop
# ─────────────────────────────────────────────────────────────────────
#
# Per the brief, Doge's Drift gets ONE wave zone: Adriatic-calm,
# height_mult 0.6 (sheltered lagoon + Adriatic sea state = flat-calm),
# freq_mult 0.9 (slightly longer wavelength than open ocean), 30 m
# blend radius for soft edges past the loop perimeter. The zone
# covers the whole racing loop; the runtime soft-blends past the
# OBB face so the boundary never pops.
WAVE_ZONES: tuple[dict, ...] = (
    {
        "name": "wave_zone_00",
        "display_name": "wave_zone_adriatic_calm",
        "location": (0.0, 0.0, 0.0),
        "rotation_deg": 0.0,
        # Covers the loop perimeter generously — anchors span
        # roughly (-180, -240) → (215, 220), so half-extents of
        # 280 × 280 wrap the racing line + a blend buffer.
        "half_width": 280.0,
        "half_depth": 280.0,
        "half_height": 20.0,
        "height_mult": 0.6,    # Adriatic + sheltered lagoon = flat-calm
        "freq_mult": 0.9,      # slightly longer wavelength
        "blend_radius_m": 30.0,
    },
)


def _spawn_wave_zones(scene: bpy.types.Scene) -> int:
    """Drop the one Adriatic-calm wave-zone empty. Same custom-prop
    contract as the addon's *Add Wave Zone* operator — half_width /
    half_height / half_depth + height_mult / freq_mult + blend_radius_m
    drive the runtime sample volume."""
    count = 0
    for spec_ in WAVE_ZONES:
        obj = bpy.data.objects.new(spec_["name"], None)
        obj.empty_display_type = "CUBE"
        obj.empty_display_size = 8.0
        obj["kind"] = "wave_zone"
        obj["display_name"] = spec_["display_name"]
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
# Pickups + boost pads
# ─────────────────────────────────────────────────────────────────────
#
# Six pickups around the loop — one per major beat (start straight,
# pre-Rialto, post-Rialto, N apex, NW canal, mid-Campanile-climb at
# lamp-room altitude). The mid-climb pickup mirrors Hatteras's
# mid-corkscrew temptation: collect it without breaking the spiral.
#
# Two boost pads: one on the canal straight before the Rialto
# (commits the rider to the threading line), one on the recovery
# straight after the Campanile (rewards the climb finish).

PICKUP_POSITIONS: tuple[tuple[str, float, float, float], ...] = (
    ("pickup_00",   55.0, -230.0,  2.0),   # start straight
    ("pickup_01",  220.0,  -80.0,  2.0),   # east canal, pre-Rialto
    ("pickup_02",  140.0,  100.0,  2.0),   # post-Rialto exit
    ("pickup_03",   40.0,  205.0,  2.0),   # N apex
    ("pickup_04", -140.0,  140.0,  2.0),   # NW canal
    ("pickup_05",  -22.0,    5.0, 28.0),   # mid-Campanile-climb (lamp-room altitude)
)

BOOST_PADS: tuple[tuple[str, float, float, float, float, float, float], ...] = (
    # (name, x, y, z, half_width, half_depth, rotation_z_deg)
    # Canal straight east of Doge's Palace — points NE toward the
    # Rialto approach. Tangent at this stretch is roughly NE
    # (anchor[2]→anchor[3] ≈ (5, 100) ⇒ yaw ~87°).
    ("boost_00",  215.0,  -90.0, 0.1, 3.5, 7.0,  87.0),
    # Recovery straight after the Campanile — points SSE toward the
    # rejoin at anchor[14]. Tangent (anchor[13]→anchor[14]) ≈
    # (-110, -125) ⇒ yaw ~-131° (south-southwest). Pad sits on the
    # mid-air descent path; z=18 m lifts it onto the recovery arc.
    ("boost_01",   30.0,  -90.0, 6.0, 3.5, 7.0, -131.0),
)


def _drop_pickups(scene: bpy.types.Scene) -> int:
    """Place pickup_NN spawn empties. kind=pickup_spawn (NOT 'pickup' —
    the addon's validator rejects that and the runtime would silently
    drop them). Auto-tag stamps the sphere visual on the next scene
    update; we set kind explicitly so a headless run still ships them
    correctly."""
    for name, x, y, z in PICKUP_POSITIONS:
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 2.0
        obj["kind"] = "pickup_spawn"
        obj.location = (x, y, z)
        scene.collection.objects.link(obj)
    return len(PICKUP_POSITIONS)


def _drop_boost_pads(scene: bpy.types.Scene) -> int:
    """Drop two boost pads. strength=1.5 mirrors the cape-town +
    hatteras seeds; per-track tuning lives in the addon panel post-
    drop. Without strength on the empty the validator flags the pad
    and the runtime defaults to 1.0 (no actual boost)."""
    for name, x, y, z, hw, hd, rz in BOOST_PADS:
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 4.0
        obj["kind"] = "boost_pad"
        obj["half_width"] = hw
        obj["half_depth"] = hd
        obj["strength"] = 1.5
        obj.location = (x, y, z)
        obj.rotation_euler = (0.0, 0.0, math.radians(rz))
        scene.collection.objects.link(obj)
    return len(BOOST_PADS)


# ─────────────────────────────────────────────────────────────────────
# Hero camera — 40 mm parked SE of the Campanile, looking NW
# ─────────────────────────────────────────────────────────────────────
#
# 40 mm — slightly wider than 50 mm to fit Campanile + Rialto +
# palazzi + Adriatic horizon in a single frame. Position SE of the
# Campanile at ~25 m elevation; aim NW toward a point ~10 m up the
# Campanile shaft so the gold belfry / domes read against the
# horizon ochre.
CAMERA_HERO_LOCATION = (80.0, -80.0, 25.0)
CAMERA_HERO_TARGET = (-20.0, 30.0, 12.0)   # mid-Campanile altitude
CAMERA_HERO_FOCAL_MM = 40.0


def _drop_camera_hero(scene: bpy.types.Scene) -> bpy.types.Object:
    """Add a ``camera_hero`` Camera framed on the Campanile silhouette
    + Rialto + a couple of palazzi facades with the Adriatic horizon
    behind. 40 mm — wider than the 50 mm default so the full skyline
    fits without flattening the composition."""
    import mathutils

    # Nuke an existing camera_hero so re-runs are idempotent.
    existing = bpy.data.objects.get("camera_hero")
    if existing is not None:
        cam_data_old = existing.data if isinstance(existing.data, bpy.types.Camera) else None
        bpy.data.objects.remove(existing, do_unlink=True)
        if cam_data_old is not None and cam_data_old.users == 0:
            bpy.data.cameras.remove(cam_data_old)

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
    return obj


# ─────────────────────────────────────────────────────────────────────
# Sky preset — Venetian golden-hour. The brief calls for ochre +
# terracotta + Adriatic teal + gold Byzantine accents + warm-orange
# glassblower furnaces. `venice_warm` is the bundled colorGrade made
# for this exact palette.
# ─────────────────────────────────────────────────────────────────────

SKY_PRESET = {
    "tint":          "#ffd28a",       # warm ochre — sunlight on stone
    "cloudiness":    0.3,             # bright Adriatic
    "sun_intensity": 1.0,
    "fog_near":      280.0,
    "fog_far":       1500.0,
    "time_of_day":   30.0,            # late morning / early afternoon
    "color_grade":   "venice_warm",   # the canonical Venice preset
    "bloom":         0.65,            # gilt + glass + water spray
    "sea_state":     3,               # Adriatic — gentle but present swell
}


def _apply_sky_preset(scene: bpy.types.Scene) -> None:
    """Push Doge's Drift's venice_warm sky preset into scene props so
    ``derive_sky_block`` emits the right JSON. Mirrors the Maw /
    Kilauea / Sandbar pattern."""
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
        print(f"  sky preset: venice_warm (Beaufort-{SKY_PRESET['sea_state']}, "
              f"{SKY_PRESET['color_grade']}, bloom={SKY_PRESET['bloom']})")


# ─────────────────────────────────────────────────────────────────────
# Augmentation orchestrator — runs after build_track_from_spec()
# ─────────────────────────────────────────────────────────────────────


def augment_scene() -> None:
    """Layer landmarks, anti-grav climb, wave zone, pickups + boosts,
    and the hero camera onto the road-built scene. Called after
    ``build_track_from_spec`` returns — at that point the terrain,
    AI spline, road mesh, and checkpoint empties all exist. We save
    the .blend then re-export so the GLB / JSON pick up the
    augmentation."""
    tag = "[seed-track-doges-drift]"
    print(f"{tag} augmenting scene with Venice dressing")
    scene = bpy.context.scene

    _build_campanile(scene)
    _build_rialto(scene)
    _build_palazzi(scene)
    _build_bell(scene)

    print(f"{tag} dropping anti-grav Campanile climb")
    climb_ok = _add_antigrav_campanile_climb(scene)
    if climb_ok:
        print(f"{tag}   Campanile climb surface built")
    else:
        print(f"{tag}   Campanile climb curve placed (sweep deferred)")

    print(f"{tag} stamping wave zones")
    waves = _spawn_wave_zones(scene)

    print(f"{tag} adding pickups + boost pads")
    pickups = _drop_pickups(scene)
    boosts = _drop_boost_pads(scene)

    print(f"{tag} adding camera_hero")
    _drop_camera_hero(scene)

    _apply_sky_preset(scene)

    print(
        f"{tag} augment summary: campanile + rialto + 3 palazzi + bell + "
        f"climb({CORKSCREW_CONTROL_POINTS} cps, z={CORKSCREW_Z_MIN_M}→{CORKSCREW_Z_MAX_M}m) + "
        f"{waves} wave zones + {pickups} pickups + {boosts} boost pads + camera_hero"
    )

    # Nudge spline control points off any downtown plinth the racing
    # line passes through. Library-linked landmarks (Rialto, Campanile,
    # palazzi) are collection-instance EMPTY objects that the obstacle
    # collector skips by type — only template-baked MESH plinths from
    # template-downtown reach the shift. The Rialto's "thread under"
    # semantics are preserved without needing a name exclusion.
    # Two passes catch overlapping-bbox secondaries.
    print(f"{tag} shifting spline off Venetian obstacles")
    bpy.ops.hoverbike.shift_spline_off_obstacles(margin=4.0)
    bpy.ops.hoverbike.shift_spline_off_obstacles(margin=4.0)
    bpy.ops.hoverbike.snap_spline_to_terrain()

    output_blend = os.path.join(REPO_ROOT, "tracks-src", f"{SPEC.track_id}.blend")
    bpy.ops.wm.save_as_mainfile(filepath=output_blend)
    print(f"{tag} saved {output_blend} with augmentation")

    # Re-export so the GLB picks up the augmentation (landmarks,
    # anti-grav curve + tube, wave zone, camera_hero) and the JSON
    # merges the new wave / anti-grav zone blocks. Without this step
    # the GLB only matches the post-build state — none of the
    # augmentation lands at runtime until the user clicks
    # *Export Track to Game* manually. Mirrors the pattern in
    # seed_track_hatteras_light.py + seed_track_cape_town_drift.py.
    print(f"{tag} re-exporting GLB + JSON + manifest")
    result = bpy.ops.hoverbike.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(
            f"{tag} export_track (post-augment) failed: {result}"
        )


def main() -> None:
    build_track_from_spec(SPEC)
    augment_scene()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-doges-drift] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
