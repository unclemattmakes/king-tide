"""Build ``tracks-src/liberty-drowned.blend`` + GLB/JSON exports.

Run (after ``seed_landmarks_library.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_liberty_drowned.py

Or via the pnpm wrapper:
    pnpm seed:track-liberty-drowned

Reshape: the **v1 finale** — drowned Manhattan harbour with the Statue
of Liberty half-submerged and her broken torch arm collapsed forward
onto Liberty Island's old battlements. Three sections:

  1. **Open harbor** — Manhattan rooftop landmarks dressing the racing
     line on the south + west approach. Brooklyn-Bridge-as-ruin reads
     in the far distance.
  2. **Torch-arm anti-grav climb** — the brief's "postcard moment".
     Bezier sweep along the underside of Liberty's collapsed torch
     arm with a half-twist (Möbius) tilt. Ships if the time budget
     allows; otherwise deferred with a follow-up comment.
  3. **Crown-interior anti-grav loop** — small closed-loop tube
     spline inside Liberty's head sphere; bike phases through the
     decoration mesh to enter / exit via the "crown windows".

Liberty herself is built inline via ``bmesh`` as a low-poly
silhouette — pedestal cuboid + truncated-cone body + sphere head +
broken-arm L-cuboids + tablet. A future hand-modelling pass can
replace the silhouette with sculpted geometry; for now the read
from harbour distance (≈40 m/s viewing) is the contract.

Continental / Drowned Cup race per
[docs/track-themes.md § 11 Liberty Drowned](../../docs/track-themes.md).
Phase E Sprint 3 of [docs/v1-asset-pipeline-plan.md](../../docs/v1-asset-pipeline-plan.md).

After ``build_track_from_spec(SPEC)`` returns this script augments
the scene with:

  * **Statue of Liberty silhouette** — inline-bmesh pedestal +
                                       robe + head + broken torch
                                       arm + flame + tablet. Tagged
                                       ``kind = "decoration"`` per
                                       component (collidable but
                                       not part of the racing road).
  * **Manhattan rooftop facades**    — 4× ``landmark_drowned_facade_nyc``
                                       library-linked instances at
                                       squat Z-scales (0.4..0.7) so
                                       they read as half-submerged
                                       Manhattan tower-tops.
  * **Brooklyn Bridge ruin**          — 1× ``landmark_arch_ruin``
                                       stretched wide+short so the
                                       silhouette reads as a sagging
                                       cable bridge in the distance.
  * **Manhattan rooftop scatter**     — 7× inline bmesh cuboids
                                       (granite gray + oxidized red
                                       mix) on the harbour side
                                       opposite the statue.
  * **Crown-interior anti-grav loop** — ``antigrav_curve_00`` closed
                                       Bezier with PROFILE_TUBE inside
                                       Liberty's head sphere.
  * **Torch-arm Möbius anti-grav**    — ``antigrav_curve_01`` Bezier
                                       sweeping the broken-torch
                                       underside with a half-twist
                                       tilt (PROFILE_BANKED_STRIP).
                                       Ships if antigrav_ribbon
                                       reaches both curves; degrades
                                       to "curve only" gracefully.
  * **3 wave zones**                  — open Atlantic swell at the
                                       harbour mouth, sheltered cove
                                       at Liberty's pedestal, harbour
                                       swell in the mid-lap.
  * **8 pickups + 2 boost pads**      — including a pair at crown-
                                       interior altitude (z=+52).
  * **camera_hero**                   — 35 mm wide-angle east of the
                                       statue, framing the full
                                       silhouette + broken arm
                                       against the orange nyc_sunset
                                       sky. This is the trailer's
                                       last shot.

The augmentation walks the same Blender API as the sibling track seeds
in ``tools/blender/`` so re-running ``pnpm seed:track-liberty-drowned``
stomps the .blend deterministically. Hand-tuned polish (sculpting
Liberty's crown rays + folds of her robe + riveted torch-arm panels)
belongs on a follow-up pass after this seed runs once.
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

# Shared landmarks library — built by seed_landmarks_library.py.
LANDMARKS_LIBRARY = os.path.join(REPO_ROOT, "tracks-src", "landmarks-library.blend")


# ─────────────────────────────────────────────────────────────────────
# Statue of Liberty — world-space placement constants
# ─────────────────────────────────────────────────────────────────────
#
# Liberty stands at (0, -100, 0). Pedestal centred there, body rises
# from z = +15 (top of pedestal) to z = +45 (top of robe shoulders),
# head sphere at z = +52, crown interior accessible at z = +55. Broken
# torch arm collapsed FORWARD (toward +X = east) per the brief: torch
# "resting on Liberty Island's old battlements" lands at z ≈ +1 on the
# east edge of the pedestal at (X_LIBERTY + 25, Y_LIBERTY - 5, +1).

X_LIBERTY = 0.0
Y_LIBERTY = -100.0
WATER_LEVEL_Z = 0.0   # sea surface — pedestal base sits 3 m below

# Pedestal — 25 × 25 × 18 m cuboid, centred so its top is at z = +15.
PEDESTAL_HALF_W = 12.5
PEDESTAL_HALF_D = 12.5
PEDESTAL_HEIGHT = 18.0
PEDESTAL_BASE_Z = -3.0  # base sits 3 m below water (half-submerged feel)
PEDESTAL_CENTER_Z = PEDESTAL_BASE_Z + PEDESTAL_HEIGHT * 0.5  # = 6.0
PEDESTAL_TOP_Z = PEDESTAL_BASE_Z + PEDESTAL_HEIGHT           # = 15.0

# Body — truncated cone, 30 m tall, base r=7, top r=3. Centred on the
# pedestal top so its origin matches PEDESTAL_TOP_Z.
BODY_BASE_R = 7.0
BODY_TOP_R = 3.0
BODY_HEIGHT = 30.0
BODY_BASE_Z = PEDESTAL_TOP_Z                       # = 15.0
BODY_TOP_Z = BODY_BASE_Z + BODY_HEIGHT             # = 45.0
BODY_FORWARD_TILT_DEG = 4.0  # subtle forward lean — Liberty's iconic stance

# Head — low-poly sphere r=4, sitting on top of the body shoulders.
HEAD_RADIUS = 4.0
HEAD_CENTER_Z = BODY_TOP_Z + HEAD_RADIUS + 1.0     # = 50.0

# Crown interior — small anti-grav loop runs around the head sphere
# interior at this altitude. Slightly above head centre so the loop's
# tube reads as "passing through her crown".
CROWN_CENTER_Z = HEAD_CENTER_Z + 2.0               # = 52.0
CROWN_LOOP_RADIUS = 5.0

# Broken torch arm — L-shape of two cuboids, collapsed forward toward
# +X. Upper arm juts from her RIGHT shoulder (player-east = +X side
# of statue when she faces +Y) at ~30° downward; forearm continues
# steeper until it lands near the pedestal east edge.
SHOULDER_X = X_LIBERTY + 4.0   # right shoulder offset (Liberty faces +Y)
SHOULDER_Y = Y_LIBERTY
SHOULDER_Z = BODY_TOP_Z - 2.0  # shoulder = 43 m

# Upper-arm cuboid — 8 m long × 1.5 m × 1.5 m, jutting forward+down.
# We rotate it about its midpoint so the local +X axis runs along the
# arm length. Angle from horizontal = -30° (going down).
UPPER_ARM_LENGTH = 8.0
UPPER_ARM_HALF_THICK = 0.75
UPPER_ARM_ANGLE_DEG = -30.0    # below-horizontal, falling forward
# Compute mid-point and end-point of upper arm so the forearm's start
# joins the upper arm's end cleanly.
_ua_dir = Vector((math.cos(math.radians(UPPER_ARM_ANGLE_DEG)),
                  0.0,
                  math.sin(math.radians(UPPER_ARM_ANGLE_DEG))))
UPPER_ARM_MID = (
    SHOULDER_X + _ua_dir.x * (UPPER_ARM_LENGTH * 0.5),
    SHOULDER_Y + _ua_dir.y * (UPPER_ARM_LENGTH * 0.5),
    SHOULDER_Z + _ua_dir.z * (UPPER_ARM_LENGTH * 0.5),
)
UPPER_ARM_END = (
    SHOULDER_X + _ua_dir.x * UPPER_ARM_LENGTH,
    SHOULDER_Y + _ua_dir.y * UPPER_ARM_LENGTH,
    SHOULDER_Z + _ua_dir.z * UPPER_ARM_LENGTH,
)

# Forearm cuboid — 6 m long × 1.2 m × 1.2 m, continuing at a steeper
# downward angle (-60°) until the torch end rests near the pedestal.
FOREARM_LENGTH = 6.0
FOREARM_HALF_THICK = 0.6
FOREARM_ANGLE_DEG = -60.0
_fa_dir = Vector((math.cos(math.radians(FOREARM_ANGLE_DEG)),
                  0.0,
                  math.sin(math.radians(FOREARM_ANGLE_DEG))))
FOREARM_MID = (
    UPPER_ARM_END[0] + _fa_dir.x * (FOREARM_LENGTH * 0.5),
    UPPER_ARM_END[1] + _fa_dir.y * (FOREARM_LENGTH * 0.5),
    UPPER_ARM_END[2] + _fa_dir.z * (FOREARM_LENGTH * 0.5),
)
FOREARM_END = (
    UPPER_ARM_END[0] + _fa_dir.x * FOREARM_LENGTH,
    UPPER_ARM_END[1] + _fa_dir.y * FOREARM_LENGTH,
    UPPER_ARM_END[2] + _fa_dir.z * FOREARM_LENGTH,
)

# Torch flame — small cone ~2 m tall × 1.5 m base, at the far end of
# the forearm. Centre is +1 m along the forearm's downward direction
# from FOREARM_END so the cone's base sits on the forearm tip.
TORCH_FLAME_HEIGHT = 2.0
TORCH_FLAME_BASE_R = 0.75
TORCH_FLAME_CENTER = (
    FOREARM_END[0] + _fa_dir.x * 0.5,
    FOREARM_END[1] + _fa_dir.y * 0.5,
    FOREARM_END[2] + _fa_dir.z * 0.5,
)

# Tablet — held in the LEFT arm (opposite side from broken right arm).
# Small cuboid 2.5 × 2 × 0.4 at chest height, tilted slightly.
TABLET_HALF_W = 1.25
TABLET_HALF_D = 1.0
TABLET_HALF_T = 0.2
TABLET_CENTER = (X_LIBERTY - 5.0, Y_LIBERTY + 2.0, 34.0)
TABLET_PITCH_DEG = 25.0   # tilted backward toward face — reading pose


# ─────────────────────────────────────────────────────────────────────
# TrackSpec — 14-anchor harbour loop ≈ 1750 m arc, ~70 s @ 25 m/s
# ─────────────────────────────────────────────────────────────────────
#
# Layout sketch (Blender Z-up world coords; runtime swaps Z↔Y on export;
# Liberty stands at world (0, -100, 0) facing +Y / harbour mouth):
#
#                                    NORTH (open harbour)
#                                          ▲
#                       (-240, 20) 4 ──── 5 (-100, 80)
#                        │                  ╲
#                        │                   ╲   approach torch
#                        │       ┌─────┐      ╲    arm root
#                       3 (-280, -180)                 6 (90, 50)
#                        ╲   ┌─Liberty (0,-100)─┐      │ climb begins
#                         ╲   ╲   pedestal       ╲     │
#               west       ╲   ╲   body+head    ╲ 9 (25,-100,56)
#               harbour     ╲   ╲                 ╲ ▲  crown loop
#                            ╲   ╲   ↓ torch arm   ╲│  z=+55
#                             2   ╲    falls       ▼
#                             (-180,-340)         7,8 — torch-arm
#                          11,12 west of Liberty    z=+25..+50
#                          12 (-80,-270)
#                                ╲       ┌────────┐
#                                 ╲      │ start  │ 13 (120,-310)
#                                  ╲ 1   │ 0 (250,-300)
#                                   ╲(50,-380)
#                                   south straight
#
# Three sections:
#   open harbour (anchors 0..5)   t=0.00..0.55 — Manhattan rooftops
#   torch arm anti-grav (6..8)    t=0.55..0.78 — climb up under-arm
#   crown interior (9..10)        t=0.78..0.85 — phase through head
#   harbour return (11..13)       t=0.85..1.00 — back to start
#
# Approx polyline length 1980 m; Catmull-Rom smoothing pulls to ~1780 m
# arc. At Drowned-Cup pace ~25 m/s the lap clocks ~71 s — bracketing
# the 70 s brief.

SPEC = TrackSpec(
    track_id="liberty-drowned",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-downtown.blend"),
    spline_anchors=[
        # ── Open harbour section (anchors 0..5) ─────────────────────
        (  250.0, -300.0,  0.0),   #  0 start — east end of south harbour
        (   50.0, -380.0,  0.0),   #  1 mid-south straight
        ( -180.0, -340.0,  0.0),   #  2 SW harbour turn
        ( -280.0, -180.0,  0.0),   #  3 W harbour
        ( -240.0,   20.0,  0.0),   #  4 NW harbour approach
        ( -100.0,   80.0,  0.0),   #  5 N harbour (above-and-east of Liberty)
        # ── Torch-arm anti-grav climb (anchors 6..8) ────────────────
        (   90.0,   50.0,  1.0),   #  6 approach torch-arm root (z lifts slightly)
        (  140.0,  -30.0, 25.0),   #  7 torch-arm bridge mid (climbing under arm)
        (   90.0,  -85.0, 50.0),   #  8 torch-arm tip (near upper-arm/forearm joint)
        # ── Crown interior loop (anchors 9..10) ─────────────────────
        (   25.0, -100.0, 56.0),   #  9 crown-interior entry (east side of head)
        (  -15.0, -110.0, 56.0),   # 10 crown-interior exit (west side of head)
        # ── Harbour return (anchors 11..13) ─────────────────────────
        (  -60.0, -150.0, 32.0),   # 11 descent behind statue (drops from crown)
        (  -80.0, -270.0,  2.0),   # 12 SW back into harbour
        (  120.0, -310.0,  0.0),   # 13 rejoin south straight (loops back to anchor 0)
    ],
    # Five checkpoints distributed across the three sections.
    #   cp_00 — mid-harbour (south straight, ~t=0.14)
    #   cp_01 — entry to torch-arm anti-grav (~t=0.50)
    #   cp_02 — torch-arm tip / exit (~t=0.65)
    #   cp_03 — crown-interior entry (~t=0.75)
    #   cp_04 — crown-interior exit + descent (~t=0.85)
    checkpoint_ts=(0.14, 0.50, 0.65, 0.75, 0.85),
    road_width=13.0,
    road_lift=0.3,
    road_blend_radius=7.0,
    road_samples=170,            # extra samples for the climb arc + crown loop
    road_smooth_passes=5,
    road_curb_width=0.7,
    road_curb_height=0.16,
    road_curb_stripe=2.0,
    road_thickness=0.6,
    gate_spacing_m=70.0,
    water_preview_size=1500.0,
    water_preview_subdivisions=200,
)


# ─────────────────────────────────────────────────────────────────────
# Materials — NYC palette
# ─────────────────────────────────────────────────────────────────────

def _ensure_material(name: str, hex_color: str, *, roughness: float = 0.7,
                     emission_strength: float = 0.0) -> bpy.types.Material:
    """Liberty palette materials — copper-green oxidation, granite gray,
    warm gold torch flame, oxidized-red NYC brick. Idempotent on name.
    Same gamma 2.2 → linear convention as the sibling seeds."""
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
# Library-link helpers — mirrors seed_track_marina_bay_7.py
# ─────────────────────────────────────────────────────────────────────

def _link_collection(library_path: str, collection_name: str) -> bpy.types.Collection | None:
    """Link ``collection_name`` from the landmarks library into the
    current scene. Idempotent — re-runs return the existing linked
    block. Returns None if the library or collection is missing."""
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
    kind: str = "decoration",
    landmark_tag: str | None = None,
) -> bpy.types.Object:
    """Create a collection-instance empty referencing ``coll`` at world
    coords ``location``. Anisotropic scaling supported for the sagging
    Brooklyn-Bridge ruin stretch."""
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
    inst["kind"] = kind
    if landmark_tag is not None:
        inst["hb_landmark"] = landmark_tag
    bpy.context.scene.collection.objects.link(inst)
    return inst


# ─────────────────────────────────────────────────────────────────────
# Statue of Liberty silhouette — inline bmesh procedural construction
# ─────────────────────────────────────────────────────────────────────
#
# Hand-modelling Liberty is the ~3-day Phase-E task. This seed produces
# the low-poly silhouette that the harbour-approach camera reads at
# 40 m/s. Each component is its own object so a follow-up sculpt pass
# can replace any one piece without touching the others.

def _build_liberty_pedestal(scene) -> bpy.types.Object:
    """NYC granite-gray cuboid 25 × 25 × 18 m. Base sits 3 m below water
    (half-submerged feel). Top is the platform her robe rises from."""
    mat = _ensure_material("mat_liberty_granite", "#7a7a78", roughness=0.85)
    mesh = bpy.data.meshes.new("liberty_pedestal_mesh")
    bm = bmesh.new()
    try:
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co.x *= PEDESTAL_HALF_W
            v.co.y *= PEDESTAL_HALF_D
            v.co.z *= PEDESTAL_HEIGHT * 0.5
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.materials.append(mat)
    obj = bpy.data.objects.new("liberty_pedestal", mesh)
    obj.location = (X_LIBERTY, Y_LIBERTY, PEDESTAL_CENTER_Z)
    obj["kind"] = "decoration"
    obj["hb_landmark"] = "liberty_pedestal"
    scene.collection.objects.link(obj)
    return obj


def _build_liberty_body(scene) -> bpy.types.Object:
    """Truncated cone (robe) ~30 m tall. Built via bmesh cone_create with
    a top cap radius distinct from base — gives Liberty her tapered
    silhouette. Subtle forward tilt suggests the iconic stance."""
    mat = _ensure_material("mat_liberty_copper", "#3aa882", roughness=0.55)
    mesh = bpy.data.meshes.new("liberty_body_mesh")
    bm = bmesh.new()
    try:
        # bmesh.ops.create_cone supports separate top + bottom radii via
        # diameter1 (bottom) + diameter2 (top). 16 segments reads smooth
        # enough at harbour distance without exploding poly count.
        bmesh.ops.create_cone(
            bm,
            cap_ends=True,
            segments=16,
            radius1=BODY_BASE_R,
            radius2=BODY_TOP_R,
            depth=BODY_HEIGHT,
        )
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.materials.append(mat)
    obj = bpy.data.objects.new("liberty_body", mesh)
    # bmesh cones are centred on local origin with their axis along +Z,
    # so place the body so its midpoint sits halfway between BODY_BASE_Z
    # and BODY_TOP_Z.
    obj.location = (X_LIBERTY, Y_LIBERTY,
                    BODY_BASE_Z + BODY_HEIGHT * 0.5)
    # Subtle forward tilt (around world X axis, leaning toward +Y per
    # Liberty's stance). Tilt around +X = rotation_euler.x.
    obj.rotation_euler = (math.radians(BODY_FORWARD_TILT_DEG), 0.0, 0.0)
    obj["kind"] = "decoration"
    obj["hb_landmark"] = "liberty_body"
    scene.collection.objects.link(obj)
    return obj


def _build_liberty_head(scene) -> bpy.types.Object:
    """Low-poly sphere (icosphere subdivisions=2 → 42 verts) for the
    head. Same copper-green material. The crown rays are skipped — the
    sphere silhouette reads enough from harbour distance, and the rays
    add detail for the hand-modelling follow-up."""
    mat = _ensure_material("mat_liberty_copper", "#3aa882", roughness=0.55)
    mesh = bpy.data.meshes.new("liberty_head_mesh")
    bm = bmesh.new()
    try:
        bmesh.ops.create_icosphere(
            bm,
            subdivisions=2,    # 42 verts — silhouette + crown read
            radius=HEAD_RADIUS,
        )
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.materials.append(mat)
    obj = bpy.data.objects.new("liberty_head", mesh)
    obj.location = (X_LIBERTY, Y_LIBERTY, HEAD_CENTER_Z)
    obj["kind"] = "decoration"
    obj["hb_landmark"] = "liberty_head"
    scene.collection.objects.link(obj)
    return obj


def _build_oriented_cuboid(
    name: str,
    midpoint: tuple[float, float, float],
    length: float,
    half_thick: float,
    direction: Vector,
    material: bpy.types.Material,
    landmark_tag: str,
    scene,
) -> bpy.types.Object:
    """Build a long cuboid centred at ``midpoint`` whose local +X axis
    aligns with ``direction``. Used for both upper-arm and forearm
    segments of the broken torch arm.

    The cuboid's local extents are (length/2, half_thick, half_thick).
    A rotation matrix oriented from local +X to ``direction`` is baked
    into ``rotation_euler``."""
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    bm = bmesh.new()
    try:
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co.x *= length * 0.5
            v.co.y *= half_thick
            v.co.z *= half_thick
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    obj.location = midpoint
    # Build a rotation that takes local +X to direction. Use
    # Vector.to_track_quat with track axis 'X' and up axis 'Z'.
    dir_n = direction.normalized()
    obj.rotation_euler = dir_n.to_track_quat("X", "Z").to_euler()
    obj["kind"] = "decoration"
    obj["hb_landmark"] = landmark_tag
    scene.collection.objects.link(obj)
    return obj


def _build_liberty_torch_arm(scene) -> list[bpy.types.Object]:
    """Broken torch arm: upper-arm + forearm L-shape ending in a flame
    cone. The arm has fallen forward (toward +X) so the torch rests
    near the pedestal east edge — the iconic post-flood silhouette per
    the track-themes brief.

    Returns the list of created objects so the caller can report counts."""
    mat_copper = _ensure_material("mat_liberty_copper", "#3aa882", roughness=0.55)
    mat_gold = _ensure_material("mat_liberty_torch_gold", "#d4a02e",
                                roughness=0.4, emission_strength=0.8)
    objs: list[bpy.types.Object] = []

    # Upper arm — 8 m × 1.5 m × 1.5 m, jutting from shoulder.
    upper = _build_oriented_cuboid(
        "liberty_upper_arm",
        midpoint=UPPER_ARM_MID,
        length=UPPER_ARM_LENGTH,
        half_thick=UPPER_ARM_HALF_THICK,
        direction=_ua_dir,
        material=mat_copper,
        landmark_tag="liberty_torch_arm_upper",
        scene=scene,
    )
    objs.append(upper)

    # Forearm — 6 m × 1.2 m × 1.2 m, continuing at steeper angle.
    forearm = _build_oriented_cuboid(
        "liberty_forearm",
        midpoint=FOREARM_MID,
        length=FOREARM_LENGTH,
        half_thick=FOREARM_HALF_THICK,
        direction=_fa_dir,
        material=mat_copper,
        landmark_tag="liberty_torch_arm_fore",
        scene=scene,
    )
    objs.append(forearm)

    # Torch flame — small cone at forearm tip.
    flame_mesh = bpy.data.meshes.new("liberty_torch_flame_mesh")
    bm = bmesh.new()
    try:
        bmesh.ops.create_cone(
            bm,
            cap_ends=True,
            segments=12,
            radius1=TORCH_FLAME_BASE_R,
            radius2=0.0,           # pointed top
            depth=TORCH_FLAME_HEIGHT,
        )
        bm.to_mesh(flame_mesh)
    finally:
        bm.free()
    flame_mesh.materials.append(mat_gold)
    flame = bpy.data.objects.new("liberty_torch_flame", flame_mesh)
    flame.location = TORCH_FLAME_CENTER
    # Flame's local +Z should point along the forearm's direction +
    # extend further — we want the flame to "stand up" relative to the
    # cone's local axis. The forearm direction is mostly downward, but
    # the flame visually points UP from the torch (it's a flame!). So
    # align +Z to global +Z but tilt slightly along the forearm's
    # forward direction so the flame "leans" away from the statue.
    flame.rotation_euler = (0.0, math.radians(15.0), 0.0)
    flame["kind"] = "decoration"
    flame["hb_landmark"] = "liberty_torch_flame"
    scene.collection.objects.link(flame)
    objs.append(flame)
    return objs


def _build_liberty_tablet(scene) -> bpy.types.Object:
    """Small cuboid held in Liberty's LEFT arm (opposite the broken
    right arm) at chest height. Tilted slightly back so the face reads
    as "being read" — iconic stance complement."""
    mat = _ensure_material("mat_liberty_copper", "#3aa882", roughness=0.55)
    mesh = bpy.data.meshes.new("liberty_tablet_mesh")
    bm = bmesh.new()
    try:
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co.x *= TABLET_HALF_W
            v.co.y *= TABLET_HALF_D
            v.co.z *= TABLET_HALF_T
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.materials.append(mat)
    obj = bpy.data.objects.new("liberty_tablet", mesh)
    obj.location = TABLET_CENTER
    # Pitch around Y so the tablet tilts back toward the head.
    obj.rotation_euler = (0.0, math.radians(TABLET_PITCH_DEG), 0.0)
    obj["kind"] = "decoration"
    obj["hb_landmark"] = "liberty_tablet"
    scene.collection.objects.link(obj)
    return obj


def _build_liberty_statue(scene) -> int:
    """Build the full low-poly Liberty silhouette: pedestal, body,
    head, broken torch arm, tablet. Returns total number of component
    objects created so the caller can report.

    This is the v1 finale's signature visual — but explicitly LOW-POLY
    here so a follow-up hand-modelling pass can sculpt over each
    component without competing with detailed inline geometry."""
    print("  Liberty silhouette — building inline bmesh components")
    created: list[bpy.types.Object] = []
    created.append(_build_liberty_pedestal(scene))
    created.append(_build_liberty_body(scene))
    created.append(_build_liberty_head(scene))
    created.extend(_build_liberty_torch_arm(scene))
    created.append(_build_liberty_tablet(scene))
    print(f"  Liberty silhouette → {len(created)} components @ "
          f"({X_LIBERTY}, {Y_LIBERTY}, 0) — pedestal+body+head+arm+flame+tablet")
    return len(created)


# ─────────────────────────────────────────────────────────────────────
# Manhattan rooftop landmarks — library-linked drowned NYC facades
# ─────────────────────────────────────────────────────────────────────
#
# 4× ``landmark_drowned_facade_nyc`` instances along the open-harbour
# section (anchors 1..4 region). Each at z = -10..-15 so the bases sit
# below water and the rooftop tiers rise to ~+5..+10 (the facade
# archetype is 30 × 90 m — at full Z scale the rooftop sits 90 m up;
# we squat the Z scale to 0.4–0.7 so rooftops land at the right
# half-submerged altitude).

NYC_FACADE_PLACEMENTS: tuple[tuple[str, float, float, float, float, float, float], ...] = (
    # (name, x, y, scale_x, scale_y, scale_z, yaw_deg)
    # ── East harbour Manhattan rooftops (Lower East Side / Wall Street)
    ("manhattan_facade_se",  340.0, -180.0, 1.0, 1.2, 0.55,  -15.0),
    ("manhattan_facade_e",   320.0,  -20.0, 1.1, 1.0, 0.65,  -85.0),
    # ── West harbour Manhattan rooftops (Battery Park / Hoboken angle)
    ("manhattan_facade_nw", -100.0,  220.0, 1.3, 1.0, 0.45,    0.0),
    ("manhattan_facade_w",  -380.0,  -80.0, 0.9, 1.2, 0.40,   90.0),
)


def _build_manhattan_facades(scene) -> int:
    """4× ``landmark_drowned_facade_nyc`` rooftops around the open
    harbour. Squat Z-scales (0.40..0.65) place the rooftop tiers at
    half-submerged altitude — Manhattan towers with their bases below
    water. Tagged ``kind="decoration"`` (the racing line stays in the
    harbour; rooftops are dressing the silhouette, not collidable
    walls)."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_drowned_facade_nyc")
    if coll is None:
        return 0
    placed = 0
    for name, x, y, sx, sy, sz, yaw in NYC_FACADE_PLACEMENTS:
        inst = _spawn_instance(
            coll,
            name,
            (x, y, -8.0),       # base 8 m below water so rooftop tier emerges
            rotation_z_deg=yaw,
            scale=(sx, sy, sz),
            kind="decoration",
            landmark_tag="manhattan_rooftop",
        )
        placed += 1
        print(f"  manhattan[{name}] → ({x}, {y}) scale=({sx}, {sy}, {sz:.2f}) yaw={yaw}°")
    return placed


# ─────────────────────────────────────────────────────────────────────
# Brooklyn Bridge ruin — 1× landmark_arch_ruin scaled wide+short
# ─────────────────────────────────────────────────────────────────────
#
# The brief asks for the "sagging Brooklyn Bridge". landmark_arch_ruin
# is a 60 m span arch — closest shape we have to a suspension bridge.
# Stretching it (3.0× X, 1.0× Y, 0.8× Z) gives a ~180 m span that
# reads as a sagging cable bridge from race-line distance. Parked
# 250 m east of Liberty, beyond the racing line, as horizon dressing.

BROOKLYN_BRIDGE_LOCATION = (380.0, -80.0, -2.0)   # 250 m east of Liberty
BROOKLYN_BRIDGE_SCALE = (3.0, 1.0, 0.8)
BROOKLYN_BRIDGE_YAW = 25.0   # angled toward the racing line


def _build_brooklyn_bridge(scene) -> None:
    """One ``landmark_arch_ruin`` instance stretched wide+short to
    silhouette as the sagging Brooklyn Bridge in the far distance.
    ``kind="decoration"`` — the runtime treats it as render-only
    background, no collider built. Placement is beyond the racing
    line so even at race pace the player never reaches it; the
    silhouette is the entire visual job."""
    coll = _link_collection(LANDMARKS_LIBRARY, "landmark_arch_ruin")
    if coll is None:
        return
    inst = _spawn_instance(
        coll,
        "liberty_brooklyn_bridge",
        BROOKLYN_BRIDGE_LOCATION,
        rotation_z_deg=BROOKLYN_BRIDGE_YAW,
        scale=BROOKLYN_BRIDGE_SCALE,
        kind="decoration",
        landmark_tag="brooklyn_bridge",
    )
    print(f"  brooklyn bridge → {inst.name} @ "
          f"{tuple(round(c, 1) for c in inst.location)} "
          f"scale={BROOKLYN_BRIDGE_SCALE} yaw={BROOKLYN_BRIDGE_YAW}°")


# ─────────────────────────────────────────────────────────────────────
# Manhattan rooftop scatter — inline bmesh cuboids
# ─────────────────────────────────────────────────────────────────────
#
# 7× simple cuboid "rooftops" scattered on the harbour side opposite
# the statue (south + west sides). Each ~8m × 6m × 2m tall, varying
# tilts. Mix of NYC granite gray + oxidized-red brick for the
# Manhattan colour story. Tagged kind=decoration so the runtime
# doesn't build colliders — the racing line skims past them.

ROOFTOP_SCATTER: tuple[tuple[str, float, float, float, float, float, float, str], ...] = (
    # (name, x, y, half_w, half_d, half_h, yaw_deg, mat_key)
    ("rooftop_00",  170.0, -260.0, 4.0, 3.0, 1.5,  12.0, "granite"),
    ("rooftop_01",   60.0, -340.0, 5.0, 4.0, 1.8,  -8.0, "brick"),
    ("rooftop_02",  -80.0, -350.0, 4.0, 3.0, 1.2,  20.0, "granite"),
    ("rooftop_03", -200.0, -260.0, 4.5, 3.5, 2.0,  35.0, "brick"),
    ("rooftop_04", -230.0,  -70.0, 5.0, 4.0, 1.5,  90.0, "granite"),
    ("rooftop_05", -170.0,  -10.0, 3.5, 3.0, 1.0,  60.0, "granite"),
    ("rooftop_06",   30.0, -250.0, 4.0, 3.0, 1.8,   0.0, "brick"),
)


def _build_rooftop_scatter(scene) -> int:
    """7× cuboid rooftops scattered on the open-harbour side. Mix of
    granite-gray + oxidized-red brick. Base at z=0 (waterline) so
    each box reads as a half-submerged rooftop poking through the
    flood plane."""
    mat_granite = _ensure_material("mat_liberty_granite", "#7a7a78", roughness=0.85)
    mat_brick = _ensure_material("mat_liberty_brick", "#8a4530", roughness=0.8)
    placed = 0
    for name, x, y, hw, hd, hh, yaw, mat_key in ROOFTOP_SCATTER:
        mat = mat_brick if mat_key == "brick" else mat_granite
        mesh = bpy.data.meshes.new(f"liberty_{name}_mesh")
        bm = bmesh.new()
        try:
            bmesh.ops.create_cube(bm, size=1.0)
            for v in bm.verts:
                v.co.x *= hw
                v.co.y *= hd
                v.co.z *= hh
            bm.to_mesh(mesh)
        finally:
            bm.free()
        mesh.materials.append(mat)
        obj = bpy.data.objects.new(f"liberty_{name}", mesh)
        obj.location = (x, y, hh)  # base at waterline
        obj.rotation_euler = (0.0, 0.0, math.radians(yaw))
        obj["kind"] = "decoration"
        obj["hb_landmark"] = "manhattan_rooftop_scatter"
        scene.collection.objects.link(obj)
        placed += 1
    print(f"  rooftop scatter → {placed} cuboids (granite + brick mix)")
    return placed


# ─────────────────────────────────────────────────────────────────────
# Crown-interior anti-grav loop — small closed-loop PROFILE_TUBE
# ─────────────────────────────────────────────────────────────────────
#
# Tight horizontal circle inside Liberty's head sphere. 8 control
# points around a ~5 m radius circle at z=+52. PROFILE_TUBE gives a
# tunnel feel — bike phases through the (decoration) head mesh,
# rides around the crown interior loop, exits the other side.

CROWN_LOOP_RADIUS_M = 5.0
CROWN_LOOP_Z_M = CROWN_CENTER_Z          # = 52.0
CROWN_LOOP_CONTROL_POINTS = 8
CROWN_LOOP_TUBE_RADIUS = 3.0
CROWN_LOOP_WIDTH = 6.0
CROWN_LOOP_THICKNESS = 0.4


def _crown_loop_control_points() -> list[tuple[float, float, float]]:
    """8 (x, y, z) anchors evenly distributed around a horizontal
    circle of radius CROWN_LOOP_RADIUS_M centred on Liberty's head."""
    points: list[tuple[float, float, float]] = []
    n = CROWN_LOOP_CONTROL_POINTS
    for i in range(n):
        theta = (i / n) * math.tau
        x = X_LIBERTY + math.cos(theta) * CROWN_LOOP_RADIUS_M
        y = Y_LIBERTY + math.sin(theta) * CROWN_LOOP_RADIUS_M
        points.append((x, y, CROWN_LOOP_Z_M))
    return points


def _add_antigrav_crown_loop(scene) -> bool:
    """Programmatically create ``antigrav_curve_00`` (closed Bezier
    with 8 AUTO-handle control points around the crown interior) and
    call ``build_antigrav_ribbon_from_curve`` with PROFILE_TUBE for
    the tunnel feel. Returns True on success, False (with a console
    warning) if antigrav_ribbon isn't reachable headless — the curve
    is still placed so authors can finish the sweep manually.

    Mirrors the closed-loop pattern from
    ``seed_track_kilauea_crown._add_antigrav_caldera_loop`` but swaps
    BANKED_STRIP → TUBE for the crown-interior read."""
    curve_data = bpy.data.curves.new("antigrav_curve_00", type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 32
    spline_obj = curve_data.splines.new(type="BEZIER")
    cps = _crown_loop_control_points()
    spline_obj.bezier_points.add(len(cps) - 1)
    for bp, (x, y, z) in zip(spline_obj.bezier_points, cps):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    # Closed loop so the swept tube meets cleanly at the seam.
    spline_obj.use_cyclic_u = True

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
                f"[seed-track-liberty-drowned] WARN: antigrav_ribbon not "
                f"reachable headless ({e}); crown-loop curve placed but "
                "not swept. Open the .blend, select antigrav_curve_00, "
                "click 'Build Anti-Grav Surface' (profile = Tube)."
            )
            return False
        return False

    build_antigrav_ribbon_from_curve(
        scene,
        curve_obj,
        profile=PROFILE_TUBE,
        width=CROWN_LOOP_WIDTH,             # ignored for TUBE
        thickness=CROWN_LOOP_THICKNESS,     # ignored for TUBE
        radius=CROWN_LOOP_TUBE_RADIUS,
        samples=64,
        segments=16,
    )
    return True


# ─────────────────────────────────────────────────────────────────────
# Torch-arm Möbius anti-grav — closed Bezier with half-twist tilt
# ─────────────────────────────────────────────────────────────────────
#
# 10-point Bezier sweeping along the broken torch arm's underside,
# with per-control-point tilt rising linearly 0..π (one half-twist)
# across the path. PROFILE_BANKED_STRIP, width 8 m, thickness 0.5 m.
# This is the brief's "postcard moment" — a Möbius read on the broken
# arm's underside.
#
# Control points trace a curve that hugs the underside of the L-shaped
# arm. Start: just under the upper arm's shoulder end. Mid: under
# upper-arm/forearm joint (the L bend). End: just past the torch tip
# (so the strip exits onto the harbour-return descent).
#
# If antigrav_ribbon isn't reachable headless OR the curve build
# fails, we degrade gracefully — the crown-interior loop is the
# must-ship; the Möbius arm is the polish layer.

TORCH_ARM_TILT_END_RAD = math.pi   # one half-twist across the path

def _torch_arm_control_points() -> list[tuple[float, float, float]]:
    """10 (x, y, z) anchors traced along the broken-arm underside.
    Walks from shoulder→upper-arm tip→forearm tip (torch end). Stays
    ~1 m beneath the arm centreline so the ribbon visually attaches
    to the arm's underside, not its top."""
    points: list[tuple[float, float, float]] = []
    # Underside offset — the ribbon hugs ~1.5 m below the arm centre.
    underside_z_offset = -1.5

    # Sample 4 points along the upper arm.
    for t in (0.0, 0.33, 0.66, 1.0):
        x = SHOULDER_X + _ua_dir.x * (UPPER_ARM_LENGTH * t)
        y = SHOULDER_Y + _ua_dir.y * (UPPER_ARM_LENGTH * t)
        z = SHOULDER_Z + _ua_dir.z * (UPPER_ARM_LENGTH * t) + underside_z_offset
        points.append((x, y, z))

    # Sample 5 more points along the forearm (start matches upper-arm
    # end implicitly via the L bend).
    for t in (0.2, 0.4, 0.6, 0.8, 1.0):
        x = UPPER_ARM_END[0] + _fa_dir.x * (FOREARM_LENGTH * t)
        y = UPPER_ARM_END[1] + _fa_dir.y * (FOREARM_LENGTH * t)
        z = UPPER_ARM_END[2] + _fa_dir.z * (FOREARM_LENGTH * t) + underside_z_offset
        points.append((x, y, z))

    # 10th point — exit clear of the torch tip, pointing down toward
    # the racing-line descent at anchor 11. Drops 5 m below torch end.
    points.append((
        FOREARM_END[0] + 2.0,
        FOREARM_END[1] - 4.0,
        FOREARM_END[2] - 5.0,
    ))
    return points


def _add_antigrav_torch_arm(scene) -> bool:
    """Programmatically create ``antigrav_curve_01`` (Bezier with 10
    AUTO-handle control points along the torch arm's underside) and
    sweep PROFILE_BANKED_STRIP with a linear tilt rise 0..π for the
    half-twist (Möbius) read. Returns True on success; False if
    antigrav_ribbon isn't reachable.

    Decoupled from the crown loop so a failure here doesn't take the
    must-ship crown-interior anti-grav with it."""
    curve_data = bpy.data.curves.new("antigrav_curve_01", type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 32
    spline_obj = curve_data.splines.new(type="BEZIER")
    cps = _torch_arm_control_points()
    spline_obj.bezier_points.add(len(cps) - 1)
    n_minus_1 = max(1, len(cps) - 1)
    for i, (bp, (x, y, z)) in enumerate(zip(spline_obj.bezier_points, cps)):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
        # Linear ramp 0..π across the path — one half-twist (Möbius).
        bp.tilt = (i / n_minus_1) * TORCH_ARM_TILT_END_RAD
    # Open curve — the arm doesn't loop back to its start.
    spline_obj.use_cyclic_u = False

    curve_obj = bpy.data.objects.new("antigrav_curve_01", curve_data)
    curve_obj["kind"] = "antigrav_curve"
    scene.collection.objects.link(curve_obj)

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
                f"[seed-track-liberty-drowned] WARN: antigrav_ribbon not "
                f"reachable headless ({e}); torch-arm curve placed but "
                "not swept. Open the .blend, select antigrav_curve_01, "
                "click 'Build Anti-Grav Surface' (profile = Banked strip)."
            )
            return False
        return False

    build_antigrav_ribbon_from_curve(
        scene,
        curve_obj,
        profile=PROFILE_BANKED_STRIP,
        width=8.0,
        thickness=0.5,
        radius=8.0,        # ignored for BANKED_STRIP, threaded for API
        samples=96,
        segments=16,
    )
    return True


# ─────────────────────────────────────────────────────────────────────
# Wave zones — 3 zones per the brief
# ─────────────────────────────────────────────────────────────────────
#
# 1. Open Atlantic — harbour mouth (south corner of spline). Big OBB,
#    westerly swell, heaviest amplitude. Reads as ocean coming in.
# 2. Sheltered cove — near Liberty's pedestal. Smaller OBB, calmest
#    amplitude. Reads as wind shadow behind the statue.
# 3. Harbour swell — mid-harbour. Default-feel zone; the lap's main
#    stretch.

WAVE_ZONES: tuple[dict, ...] = (
    {
        "name": "wave_zone_open_atlantic",
        "position": (100.0, -380.0, 0.0),
        "rotation_z_deg": 0.0,
        "half_width": 80.0,
        "half_height": 60.0,
        "half_depth": 60.0,
        "height_mult": 1.4,
        "freq_mult": 0.9,
        "direction_deg": 270.0,   # westerly swell coming in from harbour mouth
        "blend_radius_m": 30.0,
    },
    {
        "name": "wave_zone_sheltered_cove",
        "position": (0.0, -100.0, 0.0),   # at Liberty's pedestal
        "rotation_z_deg": 0.0,
        "half_width": 50.0,
        "half_height": 30.0,
        "half_depth": 50.0,
        "height_mult": 0.6,
        "freq_mult": 1.1,
        "blend_radius_m": 20.0,
    },
    {
        "name": "wave_zone_harbour_swell",
        "position": (-50.0, -200.0, 0.0),   # mid-harbour
        "rotation_z_deg": 30.0,
        "half_width": 140.0,
        "half_height": 30.0,
        "half_depth": 100.0,
        "height_mult": 1.1,
        "freq_mult": 1.0,
        "blend_radius_m": 25.0,
    },
)


def _build_wave_zones(scene) -> int:
    """Drop 3 wave-zone empties with their tuning props. Mirrors the
    Kilauea wave-zone pattern: each empty uses the canonical
    ``wave_zone_NN`` slot name so the addon's exporter picks it up by
    name pattern; ``display_name`` preserves the author-readable
    label for the panel."""
    count = 0
    for i, z in enumerate(WAVE_ZONES):
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
        if "direction_deg" in z:
            obj["direction_deg"] = float(z["direction_deg"])
        obj.location = z["position"]
        obj.rotation_euler = (0.0, 0.0, math.radians(z["rotation_z_deg"]))
        scene.collection.objects.link(obj)
        count += 1
        print(f"  wave_zone[{i}]   → {slot_name} ({z['name']}) @ {z['position']} "
              f"height_mult={z['height_mult']} blend={z['blend_radius_m']}")
    return count


# ─────────────────────────────────────────────────────────────────────
# Pickups + boost pads — 8 + 2 per the brief
# ─────────────────────────────────────────────────────────────────────
#
# 8 pickups distributed across the loop, including 2 at crown-interior
# altitude (z = +52) so the anti-grav loop is rewarded.
# 2 boost pads commit the player into the climb run-up and into the
# south-straight return.

PICKUP_POSITIONS: tuple[tuple[str, tuple[float, float, float]], ...] = (
    ("pickup_00", ( 200.0, -340.0,  1.0)),    # south straight, east end
    ("pickup_01", (   0.0, -360.0,  1.0)),    # south straight, mid
    ("pickup_02", (-200.0, -300.0,  1.0)),    # SW harbour
    ("pickup_03", (-250.0,  -80.0,  1.0)),    # W harbour back-haul
    ("pickup_04", (   0.0,   60.0,  2.0)),    # N harbour above-and-east of Liberty
    ("pickup_05", ( 100.0,  -50.0, 28.0)),    # mid-torch-arm climb
    ("pickup_06", (  10.0, -100.0, 54.0)),    # crown-interior altitude (in head)
    ("pickup_07", ( -30.0, -110.0, 54.0)),    # crown-interior altitude (exit side)
)

BOOST_PADS: tuple[tuple[str, tuple[float, float, float], float, float, float], ...] = (
    # (name, position, half_width, half_depth, rotation_z_deg)
    # ── Climb run-up — commits the player into the torch-arm anti-grav.
    ("boost_00", (  60.0,   30.0,  1.0), 3.5, 7.0,  -55.0),
    # ── Return straight — commits the player back into the start line
    #    after the crown-exit descent. Aims roughly east.
    ("boost_01", (   0.0, -300.0,  1.0), 3.5, 7.0,   75.0),
)


def _add_pickups(scene) -> int:
    """Drop 8 ``pickup_NN`` empties with ``kind="pickup_spawn"`` —
    NOT ``"pickup"``. Gotcha #1: the runtime walks the JSON's
    pickupSpawns array only when the kind matches exactly."""
    for name, pos in PICKUP_POSITIONS:
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 2.0
        obj["kind"] = "pickup_spawn"      # NOTE: NOT "pickup"
        obj.location = pos
        scene.collection.objects.link(obj)
    return len(PICKUP_POSITIONS)


def _add_boost_pads(scene) -> int:
    """Drop 2 ``boost_NN`` empties. ``strength = 1.5`` is mandatory
    (gotcha #2) — the addon's track_meta validator rejects pads
    without it."""
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


# ─────────────────────────────────────────────────────────────────────
# Hero camera — 35 mm wide-angle east of Liberty, framing the trailer
# ─────────────────────────────────────────────────────────────────────
#
# This is the trailer's last shot. Park east of Liberty looking west
# into the orange `nyc_sunset` sky. Frame the full silhouette — head,
# body, broken torch arm, pedestal — against the sunset. 35 mm gives
# a wider-than-portrait read that captures the broken arm spreading
# forward without losing the head silhouette to the frame edge.

CAMERA_HERO_LOCATION = (250.0, -100.0, 35.0)
CAMERA_HERO_TARGET = (0.0, -100.0, 25.0)
CAMERA_HERO_FOCAL_MM = 35.0


def _add_camera_hero(scene) -> None:
    """Drop the ``camera_hero`` Camera east of Liberty looking west.
    35 mm wide-angle so the trailer frame catches head + broken torch
    arm + pedestal silhouette against the nyc_sunset sky in one
    composition. Polished framing — this is THE trailer shot."""
    name = "camera_hero"
    existing = bpy.data.objects.get(name)
    if existing is not None:
        cam_data_old = existing.data if isinstance(existing.data, bpy.types.Camera) else None
        bpy.data.objects.remove(existing, do_unlink=True)
        if cam_data_old is not None and cam_data_old.users == 0:
            bpy.data.cameras.remove(cam_data_old)

    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = CAMERA_HERO_FOCAL_MM
    cam_data.clip_start = 0.1
    cam_data.clip_end = 6000.0

    obj = bpy.data.objects.new(name, cam_data)
    obj["kind"] = "camera_hero"
    obj.location = CAMERA_HERO_LOCATION

    target = Vector(CAMERA_HERO_TARGET)
    delta = target - Vector(CAMERA_HERO_LOCATION)
    if delta.length > 1e-4:
        obj.rotation_euler = delta.to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(obj)
    print(f"  camera_hero     → @ {tuple(round(c, 1) for c in obj.location)} "
          f"→ {tuple(round(c, 1) for c in CAMERA_HERO_TARGET)} "
          f"lens={CAMERA_HERO_FOCAL_MM}mm (TRAILER SHOT)")


# ─────────────────────────────────────────────────────────────────────
# Sky preset — nyc_sunset (literally the brief)
# ─────────────────────────────────────────────────────────────────────
#
# Stamp via the addon's sky_preset module so derive_sky_block emits
# the right JSON on export, AND merge a freshly-authored sky block on
# top via _merge_track_json so the JSON survives the export's
# template-defaults overwrite.

SKY_PRESET = {
    "tint":          "#ffae6a",     # sunset orange
    "cloudiness":    0.4,
    "sun_intensity": 1.1,
    "fog_near":      700.0,
    "fog_far":       3000.0,
    "time_of_day":   70.0,          # late afternoon → dusk
    "color_grade":   "nyc_sunset",
    "bloom":         0.6,
    "sea_state":     4,             # harbour chop
}


def _apply_sky_preset(scene: bpy.types.Scene) -> None:
    """Push Liberty's nyc_sunset sky preset into scene props so
    ``derive_sky_block`` emits the right JSON on export. Mirrors the
    Shibuya / Marina Bay / Kilauea pattern."""
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
        print(f"  sky preset: nyc_sunset (Beaufort-{SKY_PRESET['sea_state']}, "
              f"{SKY_PRESET['color_grade']}, bloom={SKY_PRESET['bloom']})")


# ─────────────────────────────────────────────────────────────────────
# JSON merge — sky + audio overrides (no `music` key — gotcha #7)
# ─────────────────────────────────────────────────────────────────────
#
# Mirrors seed_track_kilauea_crown::_merge_track_json. The export
# writes the runtime fields (start, checkpoints, splines, pickups,
# boosts, wave zones, anti-grav zones); we overwrite only the sky /
# audio blocks so the runtime sees the Liberty palette + harbour
# ambience next load.

LIBERTY_SKY = {
    "tint": "#ffae6a",
    "cloudiness": 0.4,
    "sunIntensity": 1.1,
    "fogNear": 700.0,
    "fogFar": 3000.0,
    "timeOfDay": 70.0,
    "colorGrade": "nyc_sunset",
    "bloom": 0.6,
    "seaStateBeaufort": 4,
}


# IMPORTANT: NO `music` key (gotcha #7) — the runtime rejects
# `music: null`; omitting the field means the default per-cup track
# plays. The brief's "hip-hop and orchestral hybrid" arrangement is
# wired through the audio system's cup-default music, not here.
LIBERTY_AUDIO = {
    "ambient": [
        "harbour-swell.opus",
        "city-distant.opus",
        "gulls-bridge.opus",
    ],
    "ambientGains": [0.5, 0.4, 0.3],
    "music3dEffects": {
        "duckOnPump": 0.35,
    },
}


def _merge_track_json() -> None:
    """Merge the per-track sky / audio blocks into the exported JSON.
    The export operator writes the runtime fields (start, checkpoints,
    pickups, etc.); this function rewrites only the sky / audio entries
    so re-running the seed converges deterministically.

    Wave zones + anti-grav zones already round-trip through the export
    via the wave_zone_NN / antigrav_curve_NN empties in the .blend, so
    we don't re-author them here."""
    import json
    json_path = os.path.join(REPO_ROOT, "public", "tracks", f"{SPEC.track_id}.json")
    if not os.path.isfile(json_path):
        print(f"  WARN: {json_path} not found post-export; sky/audio merge skipped.")
        return
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["sky"] = LIBERTY_SKY
    data["audio"] = LIBERTY_AUDIO
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"  JSON merged       → {json_path} (sky + audio overrides; "
          f"no `music` key per gotcha #7)")


# ─────────────────────────────────────────────────────────────────────
# Top-level augmentation orchestrator
# ─────────────────────────────────────────────────────────────────────


def augment_scene() -> None:
    """Layer Liberty silhouette + Manhattan rooftops + Brooklyn Bridge
    ruin + crown-interior anti-grav + torch-arm Möbius anti-grav +
    wave zones + pickups + boost pads + hero camera onto the road-
    built scene. After this returns we save + re-export so the GLB /
    JSON pick up the augmentation."""
    tag = "[seed-track-liberty-drowned]"
    print(f"{tag} augmenting scene — finale dressing pass")
    scene = bpy.context.scene

    # ── Liberty silhouette (inline bmesh) ─────────────────────────
    n_liberty = _build_liberty_statue(scene)

    # ── Manhattan rooftop dressing (linked + inline) ──────────────
    n_facades = _build_manhattan_facades(scene)
    _build_brooklyn_bridge(scene)
    n_rooftops = _build_rooftop_scatter(scene)

    # ── Anti-grav curves — crown loop (must ship) + torch arm ─────
    print(f"{tag} adding crown-interior anti-grav loop (PROFILE_TUBE)")
    crown_ok = _add_antigrav_crown_loop(scene)
    if crown_ok:
        print(f"{tag}   crown-loop tube built")
    else:
        print(f"{tag}   crown-loop curve placed (sweep deferred)")

    print(f"{tag} adding torch-arm Möbius anti-grav (PROFILE_BANKED_STRIP)")
    torch_ok = _add_antigrav_torch_arm(scene)
    if torch_ok:
        print(f"{tag}   torch-arm ribbon built (Möbius half-twist)")
    else:
        print(f"{tag}   torch-arm curve placed (sweep deferred — "
              "crown loop is the must-ship; torch arm is polish)")

    # ── Wave zones, pickups, boost pads, camera, sky ──────────────
    waves = _build_wave_zones(scene)
    pickups = _add_pickups(scene)
    boosts = _add_boost_pads(scene)
    _add_camera_hero(scene)
    _apply_sky_preset(scene)
    print(f"{tag} augment summary: liberty={n_liberty} components + "
          f"{n_facades} NYC facades + Brooklyn Bridge + {n_rooftops} rooftop scatter + "
          f"{waves} wave zones + {pickups} pickups + {boosts} boost pads + camera_hero")

    # ── Spline shift off downtown obstacles (gotcha #9) ───────────
    #
    # Liberty uses the downtown template, so the Manhattan rooftop
    # plinths the template generates will overlap the spline. Push
    # any anchor that lands inside a downtown bbox perpendicular to
    # the nearest edge; re-snap to terrain to recover Z drift. Two
    # shift passes catch overlapping clearance bands. Wrapped in
    # try/except so the seed degrades gracefully if the operators
    # aren't reachable in this Blender session.
    print(f"{tag} shifting spline off downtown obstacles")
    try:
        bpy.ops.hoverbike.shift_spline_off_obstacles(margin=4.0)
        bpy.ops.hoverbike.shift_spline_off_obstacles(margin=4.0)
        bpy.ops.hoverbike.snap_spline_to_terrain()
    except (AttributeError, RuntimeError) as e:
        print(f"{tag} WARN: spline-shift not reachable headless ({e})")

    # ── Save augmented .blend ─────────────────────────────────────
    output_blend = os.path.join(REPO_ROOT, "tracks-src", f"{SPEC.track_id}.blend")
    bpy.ops.wm.save_as_mainfile(filepath=output_blend)
    print(f"{tag} saved {output_blend} with augmentation")

    # ── Re-export (gotcha #3) — without this the GLB/JSON misses
    # everything we just authored ────────────────────────────────
    print(f"{tag} re-exporting GLB + JSON + manifest")
    result = bpy.ops.hoverbike.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(
            f"{tag} export_track (post-augment) failed: {result}"
        )

    # ── Merge sky + audio JSON overrides on top of the export ─────
    _merge_track_json()


if __name__ == "__main__":
    try:
        build_track_from_spec(SPEC)
        augment_scene()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-liberty-drowned] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
