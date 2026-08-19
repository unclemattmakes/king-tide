"""Build ``tracks-src/angkor-drowned.blend`` + GLB/JSON exports.

Run (after ``seed_template_alpine.py`` and ``seed_landmarks_library.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_angkor_drowned.py

Or via pnpm:
    pnpm seed:track-angkor-drowned

Reshape: drowned Angkor Wat. The ocean reached this far inland. The
massive temple complex stands half-submerged with jungle reclaiming
the upper levels — Bayon's smiling faces still watch from their
towers, Ta Prohm's strangler-fig roots squeeze the inner courtyards,
and the central spire of Angkor Wat itself is the structural
surprise: this track *climbs* more than the others do. The anti-grav
segment is a corkscrew up the outside of the spire (mirror Doge's
Drift's Campanile climb, ochre temple stone in place of Venetian
brick).

Drowned Cup race #2. 62 s lap target @ ~25 m/s → ~1550 m arc length
(close to Doge's Drift's 1511 m). Built on ``template-alpine`` —
the alpine template ships a sheltered river-valley basin that maps
cleanly to a flooded jungle interior; the canopy + ochre stone come
in as dressing rather than from the template.

After ``build_track_from_spec(SPEC)`` returns this script augments
the scene with:

  * **Bayon faces × 16**         — 16 × ``landmark_carved_face_block``
                                   library-linked instances along the
                                   opening straight (anchors 0→3),
                                   alternating sides of the racing
                                   line, varying scale + rotation +
                                   tower-base height so the row reads
                                   as a sequence of weathered watchers
                                   rather than a clone parade.
                                   Tagged ``kind = "decoration"`` —
                                   the player rides PAST the faces.
  * **Angkor central spire**     — 1 × ``landmark_tower_cylinder_spiral``
                                   library-linked instance at the spine
                                   centre, scaled ×0.7 (the real
                                   Angkor Wat spire is ~43 m; archetype
                                   default is ~60 m → 0.7× lands ~42 m).
                                   Tagged ``kind = "decoration"`` — the
                                   anti-grav tube does the actual ride;
                                   the spire is the silhouette.
  * **Jungle hills × 3**         — inline bmesh cones at the loop
                                   perimeter to break the horizon.
                                   ~20 m radius × ~15 m tall, deep
                                   jungle green. ``kind = "decoration"``.
  * **Courtyard walls × 5**      — short ochre laterite cuboids inside
                                   the inner-courtyard section, partial
                                   enclosure for the Ta Prohm beat.
                                   ``kind = "decoration"``.
  * **Strangler-fig roots × 3**  — clustered vertical bmesh cylinders
                                   rooted at one of the courtyard
                                   walls. Mossy-stone grey-green.
                                   ``kind = "decoration"``.
  * **Spire climb**              — ``antigrav_curve_00`` Bezier helix
                                   around the spire's axis, z=2 → z=45,
                                   ~12 m radius. Swept with
                                   ``PROFILE_TUBE``.
  * **Jungle-interior wave zone** — single calm pond zone over the
                                    Ta Prohm courtyards. height_mult
                                    0.6, freq_mult 1.2, 18 m blend.
  * **Jungle motes emitter**     — soft yellow flecks of dust /
                                   pollen above the inner courtyards.
                                   ``kind = "emitter"`` empty.
  * **7 pickups + 2 boost pads** — pickups around the loop incl. one
                                   mid-spire at z≈22 m (anti-grav apex
                                   temptation); boost pads on the
                                   smiling-face straight + the recovery
                                   straight.
  * **camera_hero**              — 35 mm parked SW of the spire,
                                   ~80 m offset, ~30 m elevation,
                                   framing spire + smiling-face row +
                                   jungle ochre sky in left-to-right
                                   composition.

The augmentation walks the same Blender API as the sibling track seeds
in ``tools/blender/`` so re-running ``pnpm seed:track-angkor-drowned``
stomps the .blend deterministically. Hand-tuned tweaks belong on a
separate one-off pass after this seed runs once.

Phase E Sprint 3 (Drowned Cup) of
[docs/v1-asset-pipeline-plan.md](../../docs/v1-asset-pipeline-plan.md);
content brief at [docs/track-themes.md § Angkor Drowned](../../docs/track-themes.md).
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


# ─────────────────────────────────────────────────────────────────────
# Track shape — flooded-temple loop, ~1541 m arc → ~61.6 s lap @ 25 m/s.
# ─────────────────────────────────────────────────────────────────────
#
# Layout (XY world coords; Z is the climb axis; flood level z=-1 for
# the entry approach). The central spire sits near the world origin so
# the anti-grav helix maths stay clean. Verticality is the structural
# surprise — the spline rises from z=-1 (entry) through z=+15 (jungle
# hill mid-section) and the anti-grav peak reaches z=+45 around the
# spire. Closed loop runs CCW (south → east → north → west → spire →
# south).
#
#   start straight (south)
#       │
#       └─→ SMILING-FACES ROW (anchors 0-3, the postcard moment)
#                  │
#                  └─→ CP0 east turn into inner courtyards
#                              │
#                              └─→ TA PROHM COURTYARDS (anchors 4-7)
#                                              │
#                                              ▼
#                                  CP1 NE jungle apex
#                                              │
#                                  CP2 NW return ─────┘
#                                              │
#                                              ▼
#                                  WSW spire approach (anchor 9)
#                                              │
#                                              └─→ SPIRE CLIMB
#                                                  (anchors 10-11, z=4→25)
#                                                              │
#                                                              ▼
#                                              CP3 mid-spire belfry
#                                                              │
#                                  descending recovery straight│
#                                              │
#                                              └─→ rejoin start
#
# Total polyline arc ≈ 1541 m. Catmull-Rom smoothing pulls anchors in
# slightly so the final arc is closer to 1530 m at lap pace.
SPEC = TrackSpec(
    track_id="angkor-drowned",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-alpine.blend"),
    spline_anchors=[
        # Opening straight south of the temple — entry approach
        # threading the Bayon smiling-face row. Flood surface at z=-1.
        (   0.0, -360.0, -1.0),  # 0  t=0.000  start (south straight)
        (   5.0, -240.0, -1.0),  # 1  t=0.078  smiling-face row begins
        (  10.0, -120.0,  0.0),  # 2  t=0.156  smiling-face row mid (climb begins)
        (  20.0,    0.0,  2.0),  # 3  t=0.234  end of smiling faces, into temple
        # Ta Prohm strangler-fig courtyards — east weave, modest climb
        # over a jungle hill outcrop. Verticality from z=2 → z=15.
        (  80.0,   80.0,  6.0),  # 4  t=0.314  east turn into courtyards
        ( 130.0,  140.0, 10.0),  # 5  t=0.389  east courtyard apex
        ( 100.0,  220.0, 12.0),  # 6  t=0.456  weave to NE corner
        (   0.0,  240.0, 15.0),  # 7  t=0.521  N apex (mid altitude on hill)
        # NW return + WSW approach to spire base.
        (-120.0,  200.0, 12.0),  # 8  t=0.604  NW return
        (-160.0,   60.0,  8.0),  # 9  t=0.703  WSW spire approach
        # SPIRE CLIMB — anchors climb from z=4 (base) through z=25 (mid
        # ascent). The anti-grav curve sweep below builds the actual
        # ridable helix surface up to z=45; these anchors place the AI
        # spline + checkpoint set at the right altitudes for the gate
        # placer + camera framing.
        ( -60.0,    5.0,  4.0),  # 10 t=0.808  spire base (climb start)
        ( -10.0,  -10.0, 25.0),  # 11 t=0.851  mid-spire altitude (post anti-grav apex)
        # Descending recovery straight back to the south start.
        ( -30.0, -180.0, 10.0),  # 12 t=0.949  descending recovery
        ( -50.0, -300.0, -1.0),  # 13 t=0.975  rejoin start straight
    ],
    # Five checkpoints. cp_00 sits early on the opening straight before
    # the face row; cp_01 sits at the face-row exit (between anchors
    # 2-3); cp_02 lands at the smiling-faces postcard middle so
    # threading IS hitting a gate (per the brief's "cp_02 at the
    # smiling-faces row"). cp_03 sits in the Ta Prohm courtyards;
    # cp_04 lands at the spire base entry (per the brief's "cp_04 at
    # the spire base") so the climb is its own final-gate beat.
    checkpoint_ts=(0.05, 0.12, 0.20, 0.55, 0.78),
    # Jungle-canopy road. 11 m matches Doge's Drift — narrower than a
    # boulevard, wider than an Alpine river trail, suits a flooded
    # temple corridor.
    road_width=11.0,
    road_lift=0.4,
    road_blend_radius=6.0,
    road_samples=140,
    road_smooth_passes=5,
    road_curb_width=0.6,
    road_curb_height=0.14,
    road_thickness=0.6,
    gate_spacing_m=60.0,
    water_preview_size=1200.0,
)


# ─────────────────────────────────────────────────────────────────────
# Library linking helpers — copied from seed_track_south_beach_sunken
#                          and seed_track_doges_drift.
# ─────────────────────────────────────────────────────────────────────

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


# Test scatter — Phase γ verification pass for the jungle prop kit.
# Throwaway placement pending the level rework; goal is to prove
# `prop_fern_clump` / `prop_mossy_boulder` / `prop_fallen_pillar` flow
# through scatter_lib + EXT_mesh_gpu_instancing into the runtime.
SCATTER_ZONES: tuple[dict, ...] = (
    # East courtyards — dense fern undergrowth in the Ta Prohm region.
    # Fern is foliage; the runtime sway shader picks it up via the
    # `mat_foliage_fern` material name + COLOR_0.R gradient.
    {
        "name": "scatter_00",
        "location": (110.0, 130.0, 7.0),
        "half_width": 50.0,
        "half_depth": 40.0,
        "density": 0.030,
        "source": "prop_fern_clump",
        "seed": 11,
    },
    # NW return slope — mossy boulders on the descent.
    {
        "name": "scatter_01",
        "location": (-110.0, 200.0, 10.0),
        "half_width": 40.0,
        "half_depth": 40.0,
        "density": 0.016,
        "source": "prop_mossy_boulder",
        "seed": 19,
    },
    # South approach — fallen pillars on the entry straight, framing
    # the smiling-face row.
    {
        "name": "scatter_02",
        "location": (-30.0, -290.0, 0.0),
        "half_width": 25.0,
        "half_depth": 60.0,
        "density": 0.010,
        "source": "prop_fallen_pillar",
        "seed": 23,
    },
)


def _drop_scatter_zones(scene) -> int:
    """Drop the Angkor test scatter zones via the shared helper."""
    return drop_scatter_zones(scene, PROPS_LIBRARY, SCATTER_ZONES)


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
    kind: str = "decoration",
) -> bpy.types.Object:
    """Create a collection-instance empty referencing ``coll`` at world
    ``location``. Collection-instance empties are EMPTY-typed so the
    lint's obstacle collector skips them — set-piece geometry is
    immune to the post-augment spline-shift pass (desirable for the
    Bayon faces + spire). ``kind`` lands on the empty as a custom
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


def _ensure_material(name: str, hex_color: str, *, roughness: float = 0.75,
                     emission_strength: float = 0.0) -> bpy.types.Material:
    """Angkor palette materials — ochre sandstone, deep jungle green,
    mossy stone grey, warm laterite brick. Idempotent on name. Same
    gamma 2.2 → linear convention as the sibling Cape-Town + Kilauea
    seeds."""
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


# ─────────────────────────────────────────────────────────────────────
# Bayon smiling-face row (anchors 0→3, opening straight)
# ─────────────────────────────────────────────────────────────────────
#
# 16 × landmark_carved_face_block library-linked instances along the
# opening straight. The faces sit roughly every ~8 m of arc length,
# alternating sides of the racing line at ~6 m offset. Each face is
# rotated so its +Y (relief face) points AWAY from the racing line —
# the player races past them and the watching gaze is in the rear-
# view. Per-instance scale + base-height variety so the row reads as
# weathered set-pieces rather than a clone parade. Two of the 16 are
# upscaled to 1.2× for tower-base mass.

# Opening-straight bearing — anchors 0→3 are roughly +Y aligned (going
# north). The Bayon faces line up perpendicular to that bearing — east
# side faces rotate so their +Y faces +X (outward east); west side
# faces rotate +Y → -X.
#
# Generated row sits between y=-360 (anchor 0) and y=-30 (just before
# anchor 3). 16 faces over ~330 m → ~22 m spacing. The brief asks for
# ~8 m spacing but 16 faces packed at 8 m would only cover 128 m of
# straight which is too dense for race-pace reads — 22 m spacing keeps
# the row going for the duration of the opening straight.

FACE_ROW_Y_START = -340.0
FACE_ROW_Y_END   =  -30.0
FACE_ROW_LATERAL_OFFSET = 9.0   # m to either side of racing line
FACE_COUNT = 16

# Per-instance variety overrides — (rotation_jitter_deg, scale, base_z).
# A handful intentionally land at 1.2× for tower-base mass; most stay
# at 1.0 (default). Z varies between 2.0 and 4.5 to read as the upper
# slabs of towers of differing heights peeking above the flooded
# courtyards.
_FACE_VARIETY: tuple[tuple[float, float, float], ...] = (
    (  4.0, 1.0, 2.0),
    ( -7.0, 1.0, 3.0),
    (  2.0, 1.2, 2.5),  # tower base — bigger
    (  6.0, 1.0, 4.0),
    ( -3.0, 1.0, 2.0),
    (  8.0, 1.0, 4.5),
    ( -5.0, 1.0, 3.5),
    (  3.0, 1.2, 2.0),  # tower base — bigger
    ( -9.0, 1.0, 4.0),
    (  5.0, 1.0, 2.5),
    ( -2.0, 1.0, 3.0),
    (  7.0, 1.0, 4.5),
    ( -8.0, 1.0, 2.0),
    (  4.0, 1.0, 3.5),
    ( -6.0, 1.0, 4.0),
    (  2.0, 1.0, 2.5),
)


def _build_bayon_faces(scene) -> int:
    """Drop 16 × ``landmark_carved_face_block`` library-linked instances
    along the opening straight. Returns the placed count.

    The relief face on the archetype is on +Y. Faces on the east side
    of the racing line rotate so +Y → +X (relief points east); west
    side rotate +Y → -X. Plus a ±10° jitter per instance for weathering
    variety."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_carved_face_block")
    if coll is None:
        print("  WARN: landmark_carved_face_block not available, skipping Bayon row")
        return 0
    placed = 0
    for i in range(FACE_COUNT):
        # Linear interpolation along the opening straight Y range.
        t = i / (FACE_COUNT - 1)
        y = FACE_ROW_Y_START + (FACE_ROW_Y_END - FACE_ROW_Y_START) * t
        # Alternate east/west of the racing line. Racing line on this
        # stretch sits roughly at x ≈ 0..20 (anchors 0→3 are at x=0,5,10,20),
        # so use the per-anchor approximate x as a rough offset reference.
        # Linear interp the racing-line x too.
        racing_x = 0.0 + 20.0 * t
        side = 1.0 if (i % 2 == 0) else -1.0   # +X east, -X west
        x = racing_x + side * FACE_ROW_LATERAL_OFFSET
        jitter_deg, scale, base_z = _FACE_VARIETY[i]
        # Relief on +Y. East-side faces point relief +X (yaw -90°),
        # west-side faces point relief -X (yaw +90°). Plus jitter.
        base_yaw_deg = -90.0 if side > 0 else 90.0
        yaw_deg = base_yaw_deg + jitter_deg
        inst = _spawn_instance(
            coll,
            name=f"angkor_face_{i:02d}",
            location=(x, y, base_z),
            rotation_z_deg=yaw_deg,
            scale=scale,
            kind="decoration",  # ride past, not into
        )
        inst["hb_landmark"] = "bayon_face"
        inst["set_piece"] = "smiling_faces_row"
        placed += 1
    print(
        f"  Bayon faces   → {placed} × landmark_carved_face_block along "
        f"opening straight y={FACE_ROW_Y_START}→{FACE_ROW_Y_END} "
        f"(±{FACE_ROW_LATERAL_OFFSET} m lateral)"
    )
    return placed


# ─────────────────────────────────────────────────────────────────────
# Angkor central spire (the hero set-piece)
# ─────────────────────────────────────────────────────────────────────
#
# 1 × landmark_tower_cylinder_spiral library-linked instance scaled
# ×0.7 so the 60 m archetype lands at ~42 m, matching the real Angkor
# Wat central spire (~43 m). Placed at the spine centre (anchor 10
# vicinity), raised to z=2 to perch on the jungle-hill outcrop the
# spire actually sat on. Tagged kind=decoration — the anti-grav tube
# does the actual ride; the spire is the silhouette.

SPIRE_LOCATION = (-30.0, -5.0, 2.0)
SPIRE_SCALE = 0.7
SPIRE_ROTATION_DEG = 0.0


def _build_angkor_spire(scene) -> bpy.types.Object | None:
    """Drop the Angkor Wat central spire as a library-linked tower
    instance. Tagged kind=decoration (the anti-grav tube is the
    collidable surface the bike rides; the spire is render-only)."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_tower_cylinder_spiral")
    if coll is None:
        return None
    inst = _spawn_instance(
        coll, "angkor_central_spire",
        location=SPIRE_LOCATION,
        rotation_z_deg=SPIRE_ROTATION_DEG,
        scale=SPIRE_SCALE,
        kind="decoration",
    )
    inst["hb_landmark"] = "angkor_central_spire"
    inst["set_piece"] = "central_spire"
    print(
        f"  Angkor spire  → {inst.name} @ {SPIRE_LOCATION} "
        f"scale=×{SPIRE_SCALE} (~{60 * SPIRE_SCALE:.0f} m tall)"
    )
    return inst


# ─────────────────────────────────────────────────────────────────────
# Inline procedural geometry — jungle hills, courtyard walls, roots
# ─────────────────────────────────────────────────────────────────────
#
# Mirrors the Cape Town mountain_cone decoration + Kilauea caldera-rim
# patterns: bmesh meshes built inline so we don't ship another kit
# blend dependency. All tagged kind=decoration (render-only; the
# obstacle-shift pass skips empties + decoration objects).

# (x, y, base_radius_m, height_m) — three low rounded cones at the
# loop perimeter to break the horizon under the jungle canopy.
_JUNGLE_HILLS: tuple[tuple[float, float, float, float], ...] = (
    (-260.0,  -60.0, 22.0, 16.0),  # west perimeter
    ( 250.0,  280.0, 24.0, 18.0),  # NE perimeter
    (  80.0, -460.0, 20.0, 14.0),  # south perimeter
)


def _build_jungle_hills(scene) -> int:
    """Three low rounded cones at the loop perimeter. ``bmesh.ops.
    create_cone`` builds them; we add a soft top by subdividing + small
    bevel on the apex ring so the silhouette reads as a jungle hill
    rather than a sharp cone."""
    mat_jungle = _ensure_material("mat_angkor_jungle", "#3a5a32", roughness=0.85)
    placed = 0
    for i, (x, y, r, h) in enumerate(_JUNGLE_HILLS):
        name = f"angkor_jungle_hill_{i:02d}"
        mesh = bpy.data.meshes.new(f"{name}_mesh")
        bm = bmesh.new()
        try:
            bmesh.ops.create_cone(
                bm,
                cap_ends=True,
                cap_tris=False,
                segments=18,
                radius1=r,
                radius2=r * 0.35,   # rounded top — not a sharp cone
                depth=h,
            )
            # bmesh cone is centred at origin, axis along Z, depth/2
            # above and below. Lift it so the base sits at z=0.
            for v in bm.verts:
                v.co.z += h * 0.5
            bm.to_mesh(mesh)
        finally:
            bm.free()
        mesh.materials.append(mat_jungle)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = (x, y, 0.0)
        obj["kind"] = "decoration"
        obj["hb_landmark"] = "jungle_hill"
        placed += 1
        print(f"  jungle hill[{i}] → {name} @ ({x}, {y}) r={r}m h={h}m")
    return placed


# (x, y, z, half_x, half_y, half_z, yaw_deg) — 5 short cuboid courtyard
# walls forming partial enclosures around the Ta Prohm beat (anchors
# 4-7 area).
_COURTYARD_WALLS: tuple[tuple[float, float, float, float, float, float, float], ...] = (
    # half-extents — full size W×D×H = (2×3, 2×0.5, 2×1.5) m = 6×1×3 m
    ( 100.0,   60.0,  6.0, 3.0, 0.5, 1.5,   20.0),
    ( 160.0,  120.0, 10.0, 3.0, 0.5, 1.5,  -45.0),
    ( 120.0,  180.0, 11.0, 3.0, 0.5, 1.5,   80.0),
    (  50.0,  220.0, 13.0, 3.0, 0.5, 1.5,  120.0),
    ( -30.0,  255.0, 14.0, 3.0, 0.5, 1.5,  150.0),
)


def _build_courtyard_walls(scene) -> int:
    """5 × ochre laterite walls around the inner-courtyard section.
    Each is a 6 m × 1 m × 3 m cuboid (half-extents 3 × 0.5 × 1.5)
    rotated to form a partial enclosure. Tagged kind=decoration."""
    mat_laterite = _ensure_material("mat_angkor_laterite", "#b56a3a", roughness=0.78)
    placed = 0
    for i, (x, y, z, hx, hy, hz, yaw) in enumerate(_COURTYARD_WALLS):
        name = f"angkor_courtyard_wall_{i:02d}"
        mesh = bpy.data.meshes.new(f"{name}_mesh")
        bm = bmesh.new()
        try:
            bmesh.ops.create_cube(bm, size=1.0)
            for v in bm.verts:
                v.co.x *= hx
                v.co.y *= hy
                v.co.z *= hz
            bm.to_mesh(mesh)
        finally:
            bm.free()
        mesh.materials.append(mat_laterite)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = (x, y, z + hz)   # base sits at z (z is courtyard floor altitude)
        obj.rotation_euler = (0.0, 0.0, math.radians(yaw))
        obj["kind"] = "decoration"
        obj["hb_landmark"] = "courtyard_wall"
        placed += 1
        print(
            f"  courtyard wall[{i}] → {name} @ ({x}, {y}, {z}) "
            f"size=({hx*2:.1f}×{hy*2:.1f}×{hz*2:.1f}) yaw={yaw:.0f}°"
        )
    return placed


def _build_strangler_fig_roots(scene) -> int:
    """3 × vertical mossy cylinder clusters rooted near one of the
    courtyard walls — visually reads as a strangler-fig sucker mass
    holding up the masonry. Each cylinder is ~0.5 m radius × ~4 m
    tall, tilted ~10° in different directions for organic feel."""
    mat_mossy = _ensure_material("mat_angkor_mossy", "#566655", roughness=0.85)
    # Cluster around the wall at (120, 180, 11) — anchor[6] vicinity.
    cluster_centre = (120.0, 180.0, 11.0)
    placements = (
        # (dx, dy, dz, radius, height, tilt_x_deg, tilt_y_deg)
        ( 2.5,  1.0, 0.0, 0.55, 4.2,   6.0,  -4.0),
        (-1.0,  2.5, 0.0, 0.45, 3.6,  -8.0,   3.0),
        ( 0.5, -1.5, 0.0, 0.50, 4.0,   2.0,   9.0),
    )
    placed = 0
    for i, (dx, dy, dz, r, h, tx, ty) in enumerate(placements):
        name = f"angkor_root_{i:02d}"
        mesh = bpy.data.meshes.new(f"{name}_mesh")
        bm = bmesh.new()
        try:
            bmesh.ops.create_cone(
                bm,
                cap_ends=True,
                cap_tris=False,
                segments=10,
                radius1=r,
                radius2=r * 0.85,   # slightly tapered at top
                depth=h,
            )
            for v in bm.verts:
                v.co.z += h * 0.5   # base at z=0
            bm.to_mesh(mesh)
        finally:
            bm.free()
        mesh.materials.append(mat_mossy)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = (cluster_centre[0] + dx,
                        cluster_centre[1] + dy,
                        cluster_centre[2] + dz)
        obj.rotation_euler = (math.radians(tx), math.radians(ty), 0.0)
        obj["kind"] = "decoration"
        obj["hb_landmark"] = "strangler_fig_root"
        placed += 1
    print(f"  strangler roots → {placed} cylinder cluster around courtyard wall_02")
    return placed


# ─────────────────────────────────────────────────────────────────────
# Anti-grav spire climb — helix up the outside of the central spire
# ─────────────────────────────────────────────────────────────────────
#
# Direct port of seed_track_doges_drift._add_antigrav_campanile_climb,
# tuned for the smaller (×0.7) Angkor spire and a higher peak (z=45).
# The spire's base radius is roughly archetype_default × 0.7 ≈ 5.6 m;
# the anti-grav tube clings to the outside with a ~7 m clearance.

SPIRE_BASE_R_M = 8.0 * 0.7         # archetype base × spire scale → ~5.6 m
HELIX_RADIUS_M = SPIRE_BASE_R_M + 7.5  # ~13 m from spire axis
HELIX_Z_MIN_M = 2.0                # spire base altitude
HELIX_Z_MAX_M = 45.0               # peak — verticality is the surprise
HELIX_TUBE_RADIUS_M = 5.0
HELIX_CONTROL_POINTS = 8
HELIX_SAMPLES = 64
HELIX_SEGMENTS = 12

# Spire axis in world coords (matches SPIRE_LOCATION X/Y).
HELIX_AXIS_XY = (SPIRE_LOCATION[0], SPIRE_LOCATION[1])


def _spire_climb_control_points() -> list[tuple[float, float, float]]:
    """Eight (x, y, z) anchors winding ~1.25 turns around the spire,
    climbing from HELIX_Z_MIN_M to HELIX_Z_MAX_M. Entry angle is chosen
    so the curve starts WSW of the spire — matching the spline approach
    from anchor[9]."""
    cx, cy = HELIX_AXIS_XY
    points: list[tuple[float, float, float]] = []
    # Entry angle: WSW of the spire (~5π/4). Sweep through ~1.25 turns
    # so the exit lands NE of the spire — same hand-off pattern as
    # Doge's Drift's campanile climb.
    theta_start = math.radians(225.0)
    theta_end = theta_start + math.tau * 1.25
    for i in range(HELIX_CONTROL_POINTS):
        t = i / (HELIX_CONTROL_POINTS - 1)
        theta = theta_start + (theta_end - theta_start) * t
        z = HELIX_Z_MIN_M + (HELIX_Z_MAX_M - HELIX_Z_MIN_M) * t
        x = cx + math.cos(theta) * HELIX_RADIUS_M
        y = cy + math.sin(theta) * HELIX_RADIUS_M
        points.append((x, y, z))
    return points


def _add_antigrav_spire_climb(scene) -> bool:
    """Programmatically create ``antigrav_curve_00`` (Bezier with 8
    AUTO-handle control points spiralling up the central spire) and
    call ``build_antigrav_ribbon_from_curve`` to sweep a TUBE surface
    + stamp the entry / exit zone empties. Direct port of
    seed_track_doges_drift._add_antigrav_campanile_climb with the
    Angkor-tuned radius + Z range.

    Returns True on success, False (with a console warning) if the
    antigrav_ribbon module isn't reachable headlessly — the curve
    stays in the scene so an author can click *Build Anti-Grav Surface*
    in the sidebar to finish the job."""
    curve_data = bpy.data.curves.new("antigrav_curve_00", type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 32  # smooth read at race speed
    spline_obj = curve_data.splines.new(type="BEZIER")
    cps = _spire_climb_control_points()
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
        from kingtide_addon.antigrav_ribbon import (
            build_antigrav_ribbon_from_curve,
            PROFILE_TUBE,
        )
    except ImportError:
        try:
            result = bpy.ops.kingtide.build_antigrav_surface()
            if "FINISHED" in result:
                return True
        except (AttributeError, RuntimeError) as e:
            print(
                f"[seed-track-angkor-drowned] WARN: antigrav_ribbon not "
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
        width=10.0,       # ignored for TUBE
        thickness=0.5,    # ignored for TUBE
        radius=HELIX_TUBE_RADIUS_M,
        samples=HELIX_SAMPLES,
        segments=HELIX_SEGMENTS,
    )
    return True


# ─────────────────────────────────────────────────────────────────────
# Wave zone — calm jungle-interior pond over the Ta Prohm courtyards
# ─────────────────────────────────────────────────────────────────────
#
# Per the brief, Angkor gets ONE wave zone: the flooded jungle
# interior. height_mult 0.6 (sheltered pond — the canopy + temple walls
# block any incoming swell), freq_mult 1.2 (shorter wavelengths read as
# a small enclosed body of water rather than open sea), 18 m blend.
# OBB centred on the inner-courtyard section (anchors 4-7 area).

WAVE_ZONE: dict = {
    "name": "wave_zone_00",
    "display_name": "wave_zone_jungle_interior",
    # Centre roughly on the courtyard section midpoint.
    "location": (60.0, 150.0, 0.0),
    "rotation_deg": 0.0,
    # Half-extents wrap the inner courtyards generously.
    "half_width": 160.0,
    "half_depth": 160.0,
    "half_height": 20.0,
    "height_mult": 0.6,
    "freq_mult": 1.2,
    "blend_radius_m": 18.0,
}


def _spawn_wave_zone(scene: bpy.types.Scene) -> bpy.types.Object:
    """Drop the one jungle-interior wave-zone empty. Same custom-prop
    contract as the addon's *Add Wave Zone* operator."""
    spec_ = WAVE_ZONE
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
    print(
        f"  wave_zone     → {obj.name} @ {spec_['location']} "
        f"× ({spec_['half_width']}×{spec_['half_depth']}) "
        f"height_mult={spec_['height_mult']} freq_mult={spec_['freq_mult']}"
    )
    return obj


# ─────────────────────────────────────────────────────────────────────
# Jungle motes emitter (optional, low-risk) — soft yellow flecks
# ─────────────────────────────────────────────────────────────────────
#
# Per the brief: "jungle motes emitter — use the existing emitter
# authoring kind from Phase A." `emitter` is a valid ExportedKind
# (kingtide_kinds.py::ExportedKind.EMITTER). Drop ONE emitter empty
# over the inner courtyards with conservative tunables — slow yellow
# motes that fade. Schema mirrors the comment block in kingtide_kinds.

EMITTER_CONFIG: dict = {
    "name": "emitter_00_jungle_motes",
    "location": (60.0, 150.0, 6.0),  # over the courtyards, mid-canopy
    "count": 200,
    "max_particles": 200,
    "lifetime_s": 4.0,
    "emit_rate": 50.0,
    "color_start": "#fff8c8",
    "color_end": "#888858",
    "size_start": 0.3,
    "size_end": 0.1,
    "velocity_cone_deg": 30.0,
    "speed_min": 0.05,
    "speed_max": 0.20,
    "gravity": 0.0,
    "sprite_atlas": "default",
    "atlas_cell": 4,
}


def _spawn_motes_emitter(scene: bpy.types.Scene) -> bpy.types.Object:
    """Drop the jungle-motes emitter empty. kind=emitter so the
    runtime registers it with createParticleSystem at GLB load. The
    empty's transform is the spawn pose; particles emit along the
    empty's local +Y."""
    spec_ = EMITTER_CONFIG
    obj = bpy.data.objects.new(spec_["name"], None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 2.0
    obj["kind"] = "emitter"
    obj["count"] = spec_["count"]
    obj["max_particles"] = spec_["max_particles"]
    obj["lifetime_s"] = spec_["lifetime_s"]
    obj["emit_rate"] = spec_["emit_rate"]
    obj["color_start"] = spec_["color_start"]
    obj["color_end"] = spec_["color_end"]
    obj["size_start"] = spec_["size_start"]
    obj["size_end"] = spec_["size_end"]
    obj["velocity_cone_deg"] = spec_["velocity_cone_deg"]
    obj["speed_min"] = spec_["speed_min"]
    obj["speed_max"] = spec_["speed_max"]
    obj["gravity"] = spec_["gravity"]
    obj["sprite_atlas"] = spec_["sprite_atlas"]
    obj["atlas_cell"] = spec_["atlas_cell"]
    obj.location = spec_["location"]
    scene.collection.objects.link(obj)
    print(
        f"  emitter       → {obj.name} @ {spec_['location']} "
        f"count={spec_['count']} lifetime={spec_['lifetime_s']}s"
    )
    return obj


# ─────────────────────────────────────────────────────────────────────
# Pickups + boost pads
# ─────────────────────────────────────────────────────────────────────
#
# 7 pickups around the loop. One sits mid-spire at z≈22 m as the
# anti-grav apex temptation (mirrors Doge's Drift's mid-Campanile
# pickup + Hatteras's mid-corkscrew). Two boost pads: one on the
# smiling-face straight (commits the rider to the postcard line), one
# on the descending recovery straight (rewards the climb finish).

PICKUP_POSITIONS: tuple[tuple[str, float, float, float], ...] = (
    ("pickup_00",   0.0, -300.0,  2.0),   # opening straight, mid-face row
    ("pickup_01",  15.0,  -60.0,  3.0),   # end of face row
    ("pickup_02", 130.0,  140.0, 12.0),   # east courtyard apex
    ("pickup_03",   0.0,  240.0, 17.0),   # N apex jungle hill
    ("pickup_04",-140.0,  140.0, 11.0),   # NW return
    ("pickup_05", -10.0,    5.0, 22.0),   # mid-spire (anti-grav apex)
    ("pickup_06", -40.0, -240.0,  6.0),   # recovery straight
)

BOOST_PADS: tuple[tuple[str, float, float, float, float, float, float], ...] = (
    # (name, x, y, z, half_width, half_depth, rotation_z_deg)
    # Smiling-face straight — tangent is roughly +Y (north), so yaw
    # ≈ 90° to align the pad's forward direction with +Y.
    ("boost_00",   5.0, -200.0, 0.5, 3.5, 7.0,  90.0),
    # Recovery straight — anchors 12→13 are roughly SW-bound. Tangent
    # (anchor[13] - anchor[12]) = (-20, -120), yaw ≈ -100° (south-
    # southwest). Pad sits on the descent at z=4 m above flood.
    ("boost_01", -40.0, -240.0, 4.0, 3.5, 7.0, -100.0),
)


def _drop_pickups(scene: bpy.types.Scene) -> int:
    """Place pickup_NN spawn empties. kind=pickup_spawn (NOT 'pickup' —
    the addon's validator rejects that and the runtime would silently
    drop them)."""
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
    doges-drift seeds. Without strength on the empty the validator
    flags the pad and the runtime defaults to 1.0 (no actual boost)."""
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
# Hero camera — 35 mm parked SW of the spire, looking NE
# ─────────────────────────────────────────────────────────────────────
#
# 35 mm — wider than 50 mm to fit spire + smiling-face row + jungle
# canopy + ochre sky in one frame. Position SW of the spire at ~30 m
# elevation; aim NE through a target ~25 m up the spire shaft so the
# spire silhouette reads against the warm ochre horizon, with the
# smiling-face row leading the eye left-to-right.
CAMERA_HERO_LOCATION = (-90.0, -75.0, 30.0)
CAMERA_HERO_TARGET = (-20.0,   5.0, 25.0)  # mid-spire altitude
CAMERA_HERO_FOCAL_MM = 35.0


def _drop_camera_hero(scene: bpy.types.Scene) -> bpy.types.Object:
    """Add a ``camera_hero`` Camera framed on the spire silhouette +
    smiling-face row + ochre sky. 35 mm — wider than 40 mm so the full
    skyline fits left-to-right."""
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

    target = Vector(CAMERA_HERO_TARGET)
    delta = target - Vector(CAMERA_HERO_LOCATION)
    if delta.length > 1e-4:
        obj.rotation_euler = delta.to_track_quat("-Z", "Y").to_euler()

    scene.collection.objects.link(obj)
    print(
        f"  camera_hero    → @ {tuple(round(c, 1) for c in obj.location)} "
        f"aimed at {tuple(round(c, 1) for c in target)} ({CAMERA_HERO_FOCAL_MM} mm)"
    )
    return obj


# ─────────────────────────────────────────────────────────────────────
# Sky preset — jungle-ochre afternoon. Reuses the bundled venice_warm
# colorGrade (closest enum value for an ochre-warm afternoon palette;
# adding a new color-grade preset is a separate shader-side change).
# ─────────────────────────────────────────────────────────────────────

ANGKOR_SKY = {
    "tint":          "#e6cfa0",       # warm ochre afternoon under canopy
    "cloudiness":    0.5,             # broken canopy + scattered cloud
    "sunIntensity":  1.0,
    "fogNear":       400.0,
    "fogFar":        2000.0,
    "timeOfDay":     60.0,            # late afternoon — shafts through canopy
    "colorGrade":    "venice_warm",   # closest match for jungle-ochre warm-tone
    "bloom":         0.35,
    "seaStateBeaufort": 2,            # calm jungle-interior pond
}


ANGKOR_AUDIO = {
    "ambient": [
        "jungle-birds.opus",
        "wind-canopy.opus",
        "temple-bells.opus",
    ],
    "ambientGains": [0.55, 0.4, 0.3],
    "music3dEffects": {
        "duckOnPump": 0.3,
    },
    # NOTE: no `music` key. The json-loader at json-loader.ts:681
    # rejects `music: null` and demands a non-empty string when the
    # key is present. We OMIT it entirely until a licensed track lands;
    # the procedural pad bed stays as the music fallback meanwhile.
}


def _apply_sky_preset(scene: bpy.types.Scene) -> None:
    """Push Angkor's jungle-ochre sky preset into scene props so
    ``derive_sky_block`` emits the right JSON on export. Mirrors the
    Doge's Drift / Marina / Kilauea pattern."""
    try:
        from kingtide_addon.sky_preset import set_sky_tint_from_hex
    except ImportError:
        try:
            from kingtide_addon_disk.sky_preset import set_sky_tint_from_hex
        except ImportError:
            print("  WARN: sky_preset module not reachable headless — "
                  "JSON-merge step below will land the sky block anyway.")
            return

    if hasattr(scene, "hoverbike_sky_color_grade"):
        scene.hoverbike_sky_color_grade = ANGKOR_SKY["colorGrade"]
        scene.hoverbike_sky_cloudiness = ANGKOR_SKY["cloudiness"]
        scene.hoverbike_sky_sun_intensity = ANGKOR_SKY["sunIntensity"]
        scene.hoverbike_sky_fog_near = ANGKOR_SKY["fogNear"]
        scene.hoverbike_sky_fog_far = ANGKOR_SKY["fogFar"]
        scene.hoverbike_sky_time_of_day = ANGKOR_SKY["timeOfDay"]
        scene.hoverbike_sky_bloom = ANGKOR_SKY["bloom"]
        scene.hoverbike_sky_sea_state = ANGKOR_SKY["seaStateBeaufort"]
        set_sky_tint_from_hex(ANGKOR_SKY["tint"])
        print(
            f"  sky preset    → {ANGKOR_SKY['colorGrade']} "
            f"(Beaufort-{ANGKOR_SKY['seaStateBeaufort']}, bloom={ANGKOR_SKY['bloom']})"
        )


def _merge_track_json() -> None:
    """Merge the per-track sky + audio blocks into the exported JSON.
    The export operator writes the runtime fields (start, checkpoints,
    pickups, etc.); this function rewrites only the sky / audio entries
    so re-running the seed converges to the same JSON without losing
    the export's gameplay state. Wave zones + anti-grav zones already
    round-trip via the wave_zone_NN / antigrav_NN_zone_* empties in
    the .blend.

    Belt-and-suspenders relative to ``_apply_sky_preset``: that path
    stamps scene props so ``derive_sky_block`` writes the JSON during
    export; this path overwrites unconditionally so a partial export
    (sky props unset) still lands the Angkor palette."""
    import json
    json_path = os.path.join(REPO_ROOT, "public", "tracks", f"{SPEC.track_id}.json")
    if not os.path.isfile(json_path):
        # Export must have failed; nothing to merge into.
        print(f"  WARN: {json_path} not found post-export; sky/audio merge skipped.")
        return
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["sky"] = ANGKOR_SKY
    data["audio"] = ANGKOR_AUDIO
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"  JSON merged   → {json_path} (sky + audio overrides)")


# ─────────────────────────────────────────────────────────────────────
# Augmentation orchestrator — runs after build_track_from_spec()
# ─────────────────────────────────────────────────────────────────────


def augment_scene() -> None:
    """Layer Bayon faces + spire + jungle hills + courtyard walls +
    strangler-fig roots + anti-grav climb + wave zone + emitter +
    pickups + boost pads + hero camera onto the road-built scene.
    Called after ``build_track_from_spec`` returns — at that point the
    terrain, AI spline, road mesh, and checkpoint empties all exist.
    We save the .blend then re-export so the GLB + JSON pick up the
    augmentation."""
    tag = "[seed-track-angkor-drowned]"
    print(f"{tag} augmenting scene with Angkor dressing")
    scene = bpy.context.scene

    _build_bayon_faces(scene)
    _build_angkor_spire(scene)
    _build_jungle_hills(scene)
    _build_courtyard_walls(scene)
    _build_strangler_fig_roots(scene)

    print(f"{tag} dropping anti-grav spire climb")
    climb_ok = _add_antigrav_spire_climb(scene)
    if climb_ok:
        print(f"{tag}   spire climb surface built")
    else:
        print(f"{tag}   spire climb curve placed (sweep deferred)")

    print(f"{tag} stamping wave zone")
    _spawn_wave_zone(scene)

    print(f"{tag} adding jungle-motes emitter")
    _spawn_motes_emitter(scene)

    print(f"{tag} adding pickups + boost pads")
    pickups = _drop_pickups(scene)
    boosts = _drop_boost_pads(scene)

    scatter = _drop_scatter_zones(scene)
    print(f"{tag} scatter: {scatter} zone(s) placed")

    print(f"{tag} adding camera_hero")
    _drop_camera_hero(scene)

    _apply_sky_preset(scene)

    print(
        f"{tag} augment summary: 16 faces + spire + 3 hills + 5 walls + "
        f"3 roots + climb({HELIX_CONTROL_POINTS} cps, "
        f"z={HELIX_Z_MIN_M}→{HELIX_Z_MAX_M}m) + 1 wave zone + 1 emitter + "
        f"{scatter} scatter zones + {pickups} pickups + {boosts} boost pads "
        f"+ camera_hero"
    )

    # Nudge spline control points off any alpine outcrop the racing
    # line passes through. Library-linked landmarks (Bayon faces +
    # spire) are collection-instance EMPTY objects that the obstacle
    # collector skips by type — only template-baked MESH outcrops from
    # template-alpine reach the shift. Two passes catch overlapping-
    # bbox secondaries. Then snap the spline back onto terrain.
    print(f"{tag} shifting spline off template-alpine obstacles")
    bpy.ops.kingtide.shift_spline_off_obstacles(margin=4.0)
    bpy.ops.kingtide.shift_spline_off_obstacles(margin=4.0)
    bpy.ops.kingtide.snap_spline_to_terrain()

    output_blend = os.path.join(REPO_ROOT, "tracks-src", f"{SPEC.track_id}.blend")
    bpy.ops.wm.save_as_mainfile(filepath=output_blend)
    print(f"{tag} saved {output_blend} with augmentation")

    # Re-export so the GLB picks up the augmentation (landmarks, anti-
    # grav curve + tube, wave zone, emitter, camera_hero) and the JSON
    # merges the new wave / anti-grav zone blocks. Without this step
    # the GLB only matches the post-build state — none of the
    # augmentation lands at runtime until the user clicks
    # *Export Track to Game* manually. Mirrors the pattern in
    # seed_track_doges_drift / seed_track_kilauea_crown.
    print(f"{tag} re-exporting GLB + JSON + manifest")
    result = bpy.ops.kingtide.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(
            f"{tag} export_track (post-augment) failed: {result}"
        )

    # Merge per-track JSON overrides (sky + audio) on top of the
    # exported JSON so the runtime sees the Angkor palette next load.
    _merge_track_json()


def main() -> None:
    build_track_from_spec(SPEC)
    augment_scene()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-angkor-drowned] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
