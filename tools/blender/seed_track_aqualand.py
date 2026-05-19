"""Build ``tracks-src/aqualand.blend`` + GLB/JSON exports.

Run (after the templates are seeded):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_aqualand.py

Or via the pnpm wrapper:
    pnpm seed:track-aqualand

Reshape: a short Baby-Park-style chaos loop through an abandoned
Florida waterpark, doubly drowned. 22 s lap × 5 laps = ~1:50 race
per [docs/track-themes.md § Aqualand](../../docs/track-themes.md).
Sprint 3 of [docs/v1-asset-pipeline-plan.md](../../docs/v1-asset-pipeline-plan.md)
(Drowned Cup race #1).

Layout (Blender Z-up world coords):

    lazy river (N) → NW corner → half-pipe slide (W) → wave pool (S)
    → main concourse (centre, flooded by The Tsunami) → back to lazy
    river.

There is no waterpark biome template, so this seed builds the pool
basins, slides, lifeguard towers and concourse inline via bmesh
(mirrors the beached-tanker / container-scatter pattern in
``seed_track_marina_bay_7.py`` and the inline-caldera-ring pattern
in ``seed_track_kilauea_crown.py``). Built on
``template-island.blend`` as the closest baseline — flat shallow
island with lots of water; the inline waterpark structures stack
above the template terrain at z>=0 so the bike never sees the
template's sand floor.

After ``build_track_from_spec(SPEC)`` returns this script augments
the scene with:

  * Wave pool basin            — 50 m × 30 m inline cuboid walls
                                 (``kind = "decoration"``) ringing a
                                 sunken floor; floor is left flush
                                 with template water so the bike reads
                                 it as ocean inside the basin.
  * Wave-generator wall        — tall slightly-angled cuboid forming
                                 the north edge of the wave pool, the
                                 visual source of The Tsunami.
                                 ``kind = "decoration"``.
  * Lazy river curbs           — 2 long curved cuboid walls defining
                                 the lazy-river channel along the NE
                                 quadrant. ``kind = "decoration"``.
  * Half-pipe slide            — bmesh half-pipe ~4 m radius, ~20 m
                                 long, tilted ~15° downward. Optional
                                 wall-ride opportunity per the brief;
                                 we DO NOT add an anti-grav segment
                                 in Sprint 3 (Aqualand is the chaos
                                 slot, not the anti-grav showcase).
                                 ``kind = "track"`` — bike rides it.
  * 3 lifeguard towers         — bmesh cuboids ~3 m × 3 m × 12 m, each
                                 tilted at a different angle for the
                                 brief's "lifeguard towers at angles"
                                 visual. ``kind = "decoration"``.
  * Main concourse slab        — flat slab ~30 m × 20 m × 0.3 m, the
                                 lowest concourse where The Tsunami
                                 floods every 30 s. ``kind = "track"``.
  * Wave zones                 — TWO zones (the hero feature):
                                   - **The Tsunami** over the
                                     concourse + wave pool: ``height_mult
                                     2.5``, ``freq_mult 0.8``, ``surge_period_s
                                     30.0``, ``surge_amplitude 4.0``,
                                     20 m blend. Runtime turns the
                                     surge fields into the periodic
                                     flood beat (see
                                     ``src/game/tracks/types.ts::WaveZone``).
                                   - **Lazy river** covering the
                                     channel: ``height_mult 0.3``,
                                     ``freq_mult 1.5``, 12 m blend —
                                     the calm pole.
  * 6 pickups + 2 boost pads   — pickups along the loop, boost pads
                                 on the lazy-river exit + the
                                 concourse-approach commit lines.
  * camera_hero                — 35 mm parked elevated SW of the wave
                                 pool, looking NE so the frame walks
                                 wave-generator wall → lifeguard
                                 towers → concourse against the faded
                                 miami_pastel sky.

The augmentation walks the same pattern as
``seed_track_kilauea_crown::augment_scene`` — re-running
``pnpm seed:track-aqualand`` stomps the .blend deterministically.
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


# ────────────────────────────────────────────────────────────────────
# TrackSpec — racing line + road params
# ────────────────────────────────────────────────────────────────────
#
# Baby-Park-style short loop centred near the world origin. Eight
# anchors trace lazy-river → NW corner → half-pipe slide → wave pool
# → main concourse → back to lazy river. Polyline arc ≈ 636 m;
# Catmull-Rom smoothing pulls it to ≈ 580 m — at the Drowned Cup
# casual pace of ~26 m/s that lands a ~22 s lap, matching the
# track-themes target.
#
# All anchors stay inside ±150 m of origin so the chaos read is
# tight (constant proximity = constant chaos per the brief). The
# slide entry (anchor 4) sits a couple of metres above sea level
# so the descent into the wave pool reads as a drop; the rest of
# the loop hugs sea level z≈0.
#
# Layout:
#
#                 lazy river N
#                  ┌───────┐
#                  │ ◄─ 2  │  (anchor 2: lazy-river N apex)
#         3 ──◄─── │       │
#         │  NW corner     │
#         │                │  ◄── 1 (NE lazy-river bend)
#         │                │
#         ▼  half-pipe     │
#         4 slide W        ─── 0 start, east edge of concourse
#         │                │
#         ▼                ▲
#         5 ───►─ 6 ─►─ 7 ─┘
#         SW    wave pool S
#               + main concourse

SPEC = TrackSpec(
    track_id="aqualand",
    # No waterpark template — template-island is the closest baseline
    # (flat shallow island with surrounding water). Inline waterpark
    # geometry from augment_scene sits on top; road_lift=0.5 keeps the
    # road comfortably above the template's water table so the bike
    # rides on concourse / slide surfaces rather than dipping under.
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-island.blend"),
    spline_anchors=[
        # 0  start — east edge of the main concourse
        (  90.0,    0.0, 0.0),
        # 1  NE — entering lazy-river bend
        (  60.0,   60.0, 1.0),
        # 2  lazy river N apex
        ( -20.0,   90.0, 1.0),
        # 3  NW corner — exit lazy river
        (-100.0,   50.0, 0.5),
        # 4  W — half-pipe slide entry (slightly elevated, drops to 5)
        (-120.0,  -30.0, 2.5),
        # 5  SW — bottom of slide / wave-pool entry
        ( -60.0,  -90.0, 0.5),
        # 6  S — wave pool centre (Tsunami flood zone)
        (  30.0, -100.0, 0.0),
        # 7  SE — back onto concourse heading to start
        ( 100.0,  -50.0, 0.0),
    ],
    # 3 checkpoints for a 22 s lap (per design-targets band — short laps
    # get fewer gates). cp_00 lands mid-lazy-river so a clean line
    # commit is gated; cp_01 sits at the bottom of the half-pipe slide
    # so the chaos-line read is timed; cp_02 sits on the concourse so
    # the Tsunami zone clear is gated.
    checkpoint_ts=(0.25, 0.55, 0.85),
    # Tighter than the big tracks — chaos read demands the bike feel
    # the walls. 8 m matches the Baby-Park-style brief.
    road_width=8.0,
    # Lift the road a comfortable amount above the template-island
    # water table so inline pool geometry sits below the road and the
    # bike never sees the template sand floor.
    road_lift=0.5,
    road_blend_radius=5.0,
    road_samples=140,           # tight loop wants extra samples
    road_smooth_passes=5,
    road_curb_width=0.6,
    road_curb_height=0.14,
    road_curb_stripe=1.8,
    road_thickness=0.5,
    gate_spacing_m=50.0,        # tighter spacing for the short lap
    water_preview_size=500.0,
    water_preview_subdivisions=120,
)


# ────────────────────────────────────────────────────────────────────
# Materials — Aqualand sun-bleached primaries palette
# ────────────────────────────────────────────────────────────────────

def _ensure_material(name: str, hex_color: str, *, roughness: float = 0.75,
                     emission_strength: float = 0.0) -> bpy.types.Material:
    """Aqualand palette materials — faded sun-bleached primaries and
    algae greens. Idempotent on name. Same gamma 2.2 → linear convention
    as the sibling Kilauea / Marina Bay seeds."""
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


# Aqualand palette — faded primaries + algae greens per the brief.
# Each name doubles as the material slot label in Blender so an artist
# can swap textures into specific surfaces later.
_PALETTE_ORANGE = ("aqualand_faded_orange", "#e58a4a")
_PALETTE_BLUE   = ("aqualand_faded_blue",   "#5c8eb5")
_PALETTE_ALGAE  = ("aqualand_algae_green",  "#7ba364")
_PALETTE_GRIME  = ("aqualand_grime_white",  "#9d9483")


# ────────────────────────────────────────────────────────────────────
# Inline bmesh primitives — pool basin, lazy-river curbs, slide,
# towers, concourse. Mirrors the Marina Bay 7 + Kilauea Crown patterns.
# ────────────────────────────────────────────────────────────────────


def _add_cuboid(
    name: str,
    location: tuple[float, float, float],
    half_extents: tuple[float, float, float],
    *,
    rotation_euler_deg: tuple[float, float, float] = (0.0, 0.0, 0.0),
    material: bpy.types.Material,
    kind: str = "decoration",
    landmark_id: str | None = None,
) -> bpy.types.Object:
    """Build one cuboid mesh via bmesh, tag it with ``kind`` + optional
    ``hb_landmark``, link it to the scene. Returns the object.

    ``half_extents`` are local-space half-sizes in metres. ``location``
    is the world-space centre. ``rotation_euler_deg`` is XYZ-Euler in
    degrees (Blender Z-up). Mirrors
    ``seed_track_marina_bay_7._build_beached_tanker`` for the bmesh
    cuboid pattern."""
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    bm = bmesh.new()
    try:
        bmesh.ops.create_cube(bm, size=1.0)
        sx, sy, sz = half_extents
        for v in bm.verts:
            v.co.x *= sx
            v.co.y *= sy
            v.co.z *= sz
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (
        math.radians(rotation_euler_deg[0]),
        math.radians(rotation_euler_deg[1]),
        math.radians(rotation_euler_deg[2]),
    )
    obj["kind"] = kind
    if landmark_id is not None:
        obj["hb_landmark"] = landmark_id
    return obj


# ── Wave pool basin ─────────────────────────────────────────────────
# 50 m × 30 m rectangular pool centred near anchor 6 (the S wave pool
# point). Outer walls form a 1 m-thick decorative ring at z=0..4 so
# the bike sees a basin silhouette but rides over the flooded floor
# (which is below the road and reads as ocean via the template
# water table + the Tsunami wave zone).
#
# Centre slightly offset to the south so the pool sits between
# anchors 5 and 6, leaving anchor 7's return-to-concourse run free.

WAVE_POOL_CENTRE = (30.0, -100.0, 0.0)
WAVE_POOL_HALF_X = 25.0     # 50 m long (east-west)
WAVE_POOL_HALF_Y = 15.0     # 30 m wide (north-south)
WAVE_POOL_WALL_HEIGHT = 2.0  # half-extent — 4 m tall walls
WAVE_POOL_WALL_THICK = 0.5   # half-extent — 1 m thick walls


def _build_wave_pool_basin() -> None:
    """Four outer walls + the wave-generator wall at the N edge. Walls
    are tagged ``kind = "decoration"`` so the bike collides with them
    but the runtime doesn't try to apply the road shader. The floor is
    left implicit — the template water table fills the basin and the
    Tsunami wave zone surges 4 m of additional height every 30 s."""
    mat = _ensure_material(*_PALETTE_BLUE, roughness=0.8)
    cx, cy, cz = WAVE_POOL_CENTRE
    z = cz + WAVE_POOL_WALL_HEIGHT  # wall centre at half-height above ground
    hx = WAVE_POOL_HALF_X
    hy = WAVE_POOL_HALF_Y
    t = WAVE_POOL_WALL_THICK
    h = WAVE_POOL_WALL_HEIGHT

    # Four walls forming the rectangular ring. Walls extend slightly
    # past the corners for a clean silhouette read.
    _add_cuboid(
        "aqualand_wave_pool_wall_e",
        (cx + hx, cy, z),
        (t, hy + t, h),
        material=mat,
        landmark_id="wave_pool_wall_e",
    )
    _add_cuboid(
        "aqualand_wave_pool_wall_w",
        (cx - hx, cy, z),
        (t, hy + t, h),
        material=mat,
        landmark_id="wave_pool_wall_w",
    )
    _add_cuboid(
        "aqualand_wave_pool_wall_s",
        (cx, cy - hy, z),
        (hx, t, h),
        material=mat,
        landmark_id="wave_pool_wall_s_beach_entry",
    )

    # Wave-generator wall — the N edge, taller (8 m), slightly tilted
    # backwards (pitch around X). This is the visual source of The
    # Tsunami; faded-orange paint job.
    mat_gen = _ensure_material(*_PALETTE_ORANGE, roughness=0.7)
    gen_h = 4.0  # half-extent → 8 m tall
    _add_cuboid(
        "aqualand_wave_pool_wall_n_generator",
        (cx, cy + hy, cz + gen_h),
        (hx, t, gen_h),
        rotation_euler_deg=(-8.0, 0.0, 0.0),  # slight backward lean
        material=mat_gen,
        landmark_id="wave_generator_wall",
    )
    print(
        f"  wave pool basin   → centre={WAVE_POOL_CENTRE} "
        f"size=({hx*2:.0f}×{hy*2:.0f}m) walls h={h*2:.0f}m "
        f"generator h={gen_h*2:.0f}m"
    )


# ── Lazy-river curbs ────────────────────────────────────────────────
# Two curved cuboid walls defining the lazy-river channel along the
# NE quadrant (between anchors 1 and 3). Each is one long cuboid
# (~50 m × 1 m × 1 m) rotated so its long axis follows the channel
# bearing. Inner curb at the racing-line side, outer curb further
# off so the bike feels enclosed by the river banks.

LAZY_RIVER_CURBS: tuple[
    tuple[str, tuple[float, float, float], tuple[float, float, float], float, str],
    ...,
] = (
    # (name, centre, half_extents, yaw_deg, landmark_id)
    # Inner curb — sits just outside the racing line on the south side
    # of the lazy river channel. Bearing follows the NE → N → NW arc.
    ("aqualand_lazy_river_curb_inner_e",
     (40.0, 40.0, 0.5),
     (24.0, 0.5, 0.6),     # 48 m long, 1 m wide, 1.2 m tall
     45.0,
     "lazy_river_curb_inner_e"),
    ("aqualand_lazy_river_curb_inner_w",
     (-50.0, 60.0, 0.5),
     (22.0, 0.5, 0.6),
     -30.0,
     "lazy_river_curb_inner_w"),
    # Outer curb — sits past the racing line on the north side of the
    # channel, parallel to inner curbs.
    ("aqualand_lazy_river_curb_outer_e",
     (60.0, 80.0, 0.5),
     (26.0, 0.5, 0.6),
     45.0,
     "lazy_river_curb_outer_e"),
    ("aqualand_lazy_river_curb_outer_w",
     (-70.0, 90.0, 0.5),
     (24.0, 0.5, 0.6),
     -25.0,
     "lazy_river_curb_outer_w"),
)


def _build_lazy_river_curbs() -> None:
    """Four sun-bleached blue cuboid walls defining the lazy-river
    channel. Inner curbs sit between the racing line and the basin
    floor; outer curbs sit past the line. All tagged
    ``kind = "decoration"`` — visual + collision, not road surface."""
    mat = _ensure_material(*_PALETTE_BLUE, roughness=0.85)
    for name, centre, half_extents, yaw_deg, label in LAZY_RIVER_CURBS:
        _add_cuboid(
            name,
            centre,
            half_extents,
            rotation_euler_deg=(0.0, 0.0, yaw_deg),
            material=mat,
            landmark_id=label,
        )
    print(f"  lazy river curbs  → {len(LAZY_RIVER_CURBS)} channel walls")


# ── Half-pipe slide ─────────────────────────────────────────────────
# Inline bmesh half-pipe ~4 m radius, 20 m long, tilted ~15° downward.
# The brief flags this as an OPTIONAL anti-grav opportunity, but the
# Sprint 3 plan explicitly excludes anti-grav from Aqualand — the
# chaos slot doesn't share runtime budget with the showcase tracks.
# We build it as decorative geometry the player CAN ride
# (``kind = "track"`` so the bike collides with the curve).

SLIDE_NAME = "aqualand_halfpipe_slide"
SLIDE_CENTRE = (-110.0, -60.0, 0.5)  # roughly between anchors 4 and 5
SLIDE_LENGTH = 20.0
SLIDE_RADIUS = 4.0
SLIDE_WALL_THICK = 0.4
SLIDE_SEGMENTS = 32
SLIDE_YAW_DEG = 60.0      # along the descent vector (from anchor 4 → 5)
SLIDE_PITCH_DEG = -15.0   # downward tilt


def _build_halfpipe_slide() -> None:
    """A half-pipe sweep — open-top tube oriented along local +X. We
    rebuild bmesh as a 180° arc swept ``SLIDE_LENGTH`` along +X. The
    bike rides the inside concave surface (``kind = "track"``).
    Mirrors the inline half-pipe approach without depending on the
    addon's halfpipe operator (which expects GUI context)."""
    mat = _ensure_material(*_PALETTE_ORANGE, roughness=0.7)
    n = SLIDE_SEGMENTS
    bm = bmesh.new()
    # Ring of bottom-half verts on the YZ plane (X = ±L/2). Tube
    # spans angles π (down) → 0 (right) → 0 wait: build the open-top
    # tube as the LOWER semicircle so its concave face points up.
    # Sweep along +X by extruding from -L/2 to +L/2.
    half_L = SLIDE_LENGTH * 0.5
    ring_minus: list[bmesh.types.BMVert] = []
    ring_plus: list[bmesh.types.BMVert] = []
    for i in range(n + 1):
        # angle from π (left rim) down through 3π/2 (bottom) to 2π (right rim)
        # ≡ -π/2 .. π/2 wrap, but we want the BOTTOM half so theta
        # sweeps from π (180°) to 2π (360°) i.e. y goes -R..+R via z=-R.
        # Parametrise: theta ∈ [π, 2π]; y = R·cos(theta) → -R..+R,
        # z = R·sin(theta) → 0..-R..0. That's the bottom half.
        t = i / n
        theta = math.pi + t * math.pi
        y = SLIDE_RADIUS * math.cos(theta)
        z = SLIDE_RADIUS * math.sin(theta)
        ring_minus.append(bm.verts.new((-half_L, y, z)))
        ring_plus.append(bm.verts.new((+half_L, y, z)))
    # Stitch quads between the two rings.
    for i in range(n):
        bm.faces.new([
            ring_minus[i], ring_plus[i], ring_plus[i + 1], ring_minus[i + 1],
        ])
    # Add a thin outer skin so the half-pipe doesn't read paper-thin
    # from below. Extrude radially outward by SLIDE_WALL_THICK.
    bm.normal_update()
    outer_ring_minus: list[bmesh.types.BMVert] = []
    outer_ring_plus: list[bmesh.types.BMVert] = []
    for i in range(n + 1):
        v_m = ring_minus[i]
        v_p = ring_plus[i]
        # Radial direction in YZ from origin (0, 0)
        ry = v_m.co.y
        rz = v_m.co.z
        rlen = math.hypot(ry, rz) or 1.0
        ny = ry / rlen
        nz = rz / rlen
        outer_ring_minus.append(bm.verts.new((
            v_m.co.x, v_m.co.y + ny * SLIDE_WALL_THICK,
            v_m.co.z + nz * SLIDE_WALL_THICK,
        )))
        outer_ring_plus.append(bm.verts.new((
            v_p.co.x, v_p.co.y + ny * SLIDE_WALL_THICK,
            v_p.co.z + nz * SLIDE_WALL_THICK,
        )))
    for i in range(n):
        # outer skin (opposite winding so normals point outward)
        bm.faces.new([
            outer_ring_minus[i + 1], outer_ring_plus[i + 1],
            outer_ring_plus[i], outer_ring_minus[i],
        ])
        # End caps at both X faces — close the tube wall thickness
        bm.faces.new([
            ring_minus[i], ring_minus[i + 1],
            outer_ring_minus[i + 1], outer_ring_minus[i],
        ])
        bm.faces.new([
            outer_ring_plus[i], outer_ring_plus[i + 1],
            ring_plus[i + 1], ring_plus[i],
        ])

    bm.normal_update()
    mesh = bpy.data.meshes.new(f"{SLIDE_NAME}_mesh")
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(mat)

    obj = bpy.data.objects.new(SLIDE_NAME, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = SLIDE_CENTRE
    obj.rotation_euler = (
        math.radians(SLIDE_PITCH_DEG),
        0.0,
        math.radians(SLIDE_YAW_DEG),
    )
    obj["kind"] = "track"   # rideable curve per the brief
    obj["hb_landmark"] = "halfpipe_slide"
    print(
        f"  half-pipe slide   → @ {SLIDE_CENTRE} "
        f"L={SLIDE_LENGTH}m R={SLIDE_RADIUS}m yaw={SLIDE_YAW_DEG}° "
        f"pitch={SLIDE_PITCH_DEG}°"
    )


# ── Lifeguard towers ────────────────────────────────────────────────
# Three tilted cuboid towers per the brief's "lifeguard towers at
# angles" visual. Each tilts on a different axis so the lopsided read
# carries from any angle.

LIFEGUARD_TOWERS: tuple[
    tuple[str, tuple[float, float, float], tuple[float, float, float], str],
    ...,
] = (
    # (name, location, rotation_euler_deg, hex_color_palette_entry_label)
    # NE tower — tilts forward (pitch around X) per the brief.
    ("aqualand_lifeguard_tower_ne",
     (75.0, 70.0, 6.0),
     (10.0, 0.0, 12.0),
     "lifeguard_tower_ne"),
    # SW tower — leans backward.
    ("aqualand_lifeguard_tower_sw",
     (-60.0, -40.0, 6.0),
     (-8.0, 0.0, -8.0),
     "lifeguard_tower_sw"),
    # SE tower — sideways lean.
    ("aqualand_lifeguard_tower_se",
     (80.0, -70.0, 6.0),
     (0.0, 5.0, 25.0),
     "lifeguard_tower_se"),
)

LIFEGUARD_TOWER_HALF_EXTENTS = (1.5, 1.5, 6.0)  # 3 m × 3 m × 12 m


def _build_lifeguard_towers() -> None:
    """Three faded-orange cuboid towers at deliberate-mistake angles.
    ``kind = "decoration"`` so the bike collides but they don't read
    as road surface."""
    mat = _ensure_material(*_PALETTE_ORANGE, roughness=0.75)
    for name, location, rot_deg, label in LIFEGUARD_TOWERS:
        _add_cuboid(
            name,
            location,
            LIFEGUARD_TOWER_HALF_EXTENTS,
            rotation_euler_deg=rot_deg,
            material=mat,
            landmark_id=label,
        )
    print(f"  lifeguard towers  → {len(LIFEGUARD_TOWERS)} tilted towers")


# ── Main concourse slab ─────────────────────────────────────────────
# Flat rectangular slab centred near the world origin, the lowest
# concourse where The Tsunami floods. Slab top at z=0.3 m so it sits
# just above the template water table at z=0 — bike rides it dry
# until the surge term in the wave zone adds the 4 m flood.

CONCOURSE_NAME = "aqualand_main_concourse"
CONCOURSE_CENTRE = (10.0, -30.0, 0.15)   # centred between concourse anchors
CONCOURSE_HALF_EXTENTS = (15.0, 10.0, 0.15)  # 30 m × 20 m × 0.3 m


def _build_main_concourse() -> None:
    """Algae-green concrete slab. ``kind = "track"`` so it reads as
    road surface during the dry beat of the Tsunami cycle."""
    mat = _ensure_material(*_PALETTE_ALGAE, roughness=0.9)
    _add_cuboid(
        CONCOURSE_NAME,
        CONCOURSE_CENTRE,
        CONCOURSE_HALF_EXTENTS,
        material=mat,
        kind="track",
        landmark_id="main_concourse",
    )
    print(
        f"  main concourse    → @ {CONCOURSE_CENTRE} "
        f"size=({CONCOURSE_HALF_EXTENTS[0]*2:.0f}×{CONCOURSE_HALF_EXTENTS[1]*2:.0f}m)"
    )


# ────────────────────────────────────────────────────────────────────
# Wave zones — TWO zones (The Tsunami + the lazy river)
# ────────────────────────────────────────────────────────────────────
#
# 1. The Tsunami — gameplay hero. Surge fields trigger the periodic
#    flood beat the brief calls out: every surge_period_s seconds the
#    zone adds surge_amplitude metres of additional height for half
#    the period (max(0, sin(2π·t / surgePeriodS)) is positive over
#    half the cycle). 30 s period + 4 m amplitude per the brief.
#    Covers the wave pool + main concourse so both flood together —
#    matching the brief's "surge floods the lowest concourse section".
#
# 2. Lazy river — gentle counterpoint. height_mult 0.3 + freq_mult
#    1.5 reads as small ripples on calmer water (the "lazy" pole of
#    the chaos / calm spectrum).

TSUNAMI_ZONE = {
    "name": "wave_zone_00",
    "display_name": "wave_zone_tsunami",
    "position": (20.0, -65.0, 0.0),    # centred between concourse + wave pool
    "rotation_deg": 0.0,
    "half_width": 50.0,                # spans concourse → wave pool E-W
    "half_height": 30.0,               # vertical extent (mostly informational)
    "half_depth": 60.0,                # spans concourse N → wave pool S
    "height_mult": 2.5,                # bigger baseline waves
    "freq_mult": 0.8,                  # longer wavelength (rolling, not choppy)
    "surge_period_s": 30.0,            # the Tsunami timer
    "surge_amplitude": 4.0,            # 4 m flood
    "blend_radius_m": 20.0,            # generous edge softening
}

LAZY_RIVER_ZONE = {
    "name": "wave_zone_01",
    "display_name": "wave_zone_lazy_river",
    "position": (-10.0, 70.0, 0.0),    # centred over the NE lazy-river arc
    "rotation_deg": -15.0,             # rough channel bearing
    "half_width": 60.0,                # along channel
    "half_height": 20.0,
    "half_depth": 30.0,                # cross-channel
    "height_mult": 0.3,                # calmer than baseline
    "freq_mult": 1.5,                  # small ripples on top
    "blend_radius_m": 12.0,
}


def _spawn_wave_zone(scene, zone: dict) -> bpy.types.Object:
    """Stamp one wave-zone empty matching the addon's empty contract
    (mirrors ``seed_track_kilauea_crown._spawn_lava_beach_wave_zone``).
    All numeric extras are float-cast — Blender custom-prop types are
    sticky on first write and the export validator rejects int where
    float is expected."""
    obj = bpy.data.objects.new(zone["name"], None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 6.0
    obj["kind"] = "wave_zone"
    obj["display_name"] = zone["display_name"]
    obj["half_width"] = float(zone["half_width"])
    obj["half_height"] = float(zone["half_height"])
    obj["half_depth"] = float(zone["half_depth"])
    obj["height_mult"] = float(zone["height_mult"])
    obj["freq_mult"] = float(zone["freq_mult"])
    obj["blend_radius_m"] = float(zone["blend_radius_m"])
    # Surge fields — only stamped when both are present (the runtime
    # requires they ship together; see WaveZone in types.ts).
    if "surge_period_s" in zone and "surge_amplitude" in zone:
        obj["surge_period_s"] = float(zone["surge_period_s"])
        obj["surge_amplitude"] = float(zone["surge_amplitude"])
    obj.location = zone["position"]
    obj.rotation_euler = (0.0, 0.0, math.radians(zone["rotation_deg"]))
    scene.collection.objects.link(obj)
    surge = ""
    if "surge_period_s" in zone:
        surge = (
            f" surge_period={zone['surge_period_s']}s "
            f"surge_amp={zone['surge_amplitude']}m"
        )
    print(
        f"  wave zone         → {obj.name} ({zone['display_name']}) "
        f"@ {zone['position']} height_mult={zone['height_mult']} "
        f"freq_mult={zone['freq_mult']}{surge}"
    )
    return obj


def _build_wave_zones(scene) -> None:
    _spawn_wave_zone(scene, TSUNAMI_ZONE)
    _spawn_wave_zone(scene, LAZY_RIVER_ZONE)


# ────────────────────────────────────────────────────────────────────
# Pickups + boost pads
# ────────────────────────────────────────────────────────────────────
#
# Six pickups spaced around the loop; two boost pads positioned at
# commit lines (lazy-river exit + concourse approach). Pickups carry
# ``kind = "pickup_spawn"`` (NOT ``"pickup"``); boost pads carry
# ``kind = "boost_pad"`` plus ``strength = 1.5`` per the kind-registry
# contract — the missing-``strength`` gotcha that bit prior seeds.

PICKUP_POSITIONS: tuple[tuple[str, float, float, float], ...] = (
    ("pickup_00",   80.0,   20.0, 1.0),  # start straight, leaving concourse
    ("pickup_01",   30.0,   75.0, 1.5),  # mid lazy river NE
    ("pickup_02",  -60.0,   80.0, 1.5),  # mid lazy river NW
    ("pickup_03", -100.0,   10.0, 1.5),  # half-pipe slide entry
    ("pickup_04",  -20.0,  -85.0, 1.0),  # wave pool centre (Tsunami clear reward)
    ("pickup_05",   80.0,  -40.0, 1.0),  # concourse approach
)

BOOST_PADS: tuple[tuple[str, float, float, float, float, float, float], ...] = (
    # (name, x, y, z, half_width, half_depth, yaw_deg)
    # Boost yaw aims along the local racing-line tangent at the pad.
    # ── Lazy-river exit — commit into the slide drop carrying speed.
    ("boost_00", -90.0,   30.0,  1.0, 2.5, 5.0, -60.0),
    # ── Concourse approach (pre-Tsunami zone entry) — carry speed
    #    into the flood beat so the player commits to riding through.
    ("boost_01",  60.0,  -75.0,  0.6, 2.5, 5.0,  35.0),
)


def _drop_pickups(scene) -> int:
    """Six ``pickup_NN`` empties tagged ``kind = "pickup_spawn"`` — NOT
    ``"pickup"``. The validator rejects the latter (see kind registry)."""
    for name, x, y, z in PICKUP_POSITIONS:
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 2.0
        obj["kind"] = "pickup_spawn"
        obj.location = (x, y, z)
        scene.collection.objects.link(obj)
    return len(PICKUP_POSITIONS)


def _drop_boost_pads(scene) -> int:
    """Two ``boost_NN`` empties carrying ``strength = 1.5`` plus
    half_width / half_depth / rotation_z per the kind-registry contract."""
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


# ────────────────────────────────────────────────────────────────────
# Hero camera — 35 mm framing wave-generator + towers + concourse
# ────────────────────────────────────────────────────────────────────
#
# Park elevated SW of the wave pool looking NE so the frame walks
# wave-generator wall (foreground) → lifeguard towers (mid-ground) →
# concourse + lazy river (background) against the faded miami_pastel
# sky. 35 mm matches the Kilauea Crown framing — wider than 50 mm to
# fit the cluttered waterpark silhouette in one frame.

CAMERA_HERO_LOCATION = (-90.0, -150.0, 28.0)
CAMERA_HERO_TARGET = (40.0, -50.0, 4.0)
CAMERA_HERO_FOCAL_MM = 35.0


def _add_camera_hero(scene) -> bpy.types.Object:
    """Drop ``camera_hero`` SW of the wave pool, looking NE. 35 mm wide
    angle frames the entire waterpark silhouette in one shot."""
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
# Sky preset — faded sun-bleached Florida miami_pastel.
# Stamped onto scene properties BEFORE re-export so the addon's
# ``derive_sky_block`` picks them up. Property names verified against
# ``tools/blender/hoverbike_addon/sky_preset.py``.
# ────────────────────────────────────────────────────────────────────

SKY_PRESET = {
    "tint":          "#ffd9b8",       # faded sun-bleached peach
    "cloudiness":    0.3,             # partly sunny
    "sun_intensity": 1.3,             # bright Florida sun
    "fog_near":      200.0,
    "fog_far":       1200.0,
    "time_of_day":   56.0,            # afternoon
    "color_grade":   "miami_pastel",  # faded waterpark primaries
    "bloom":         0.3,
    "sea_state":     3,
}


def _apply_sky_preset(scene: bpy.types.Scene) -> None:
    """Push Aqualand's faded-Florida sky preset into scene props so
    ``derive_sky_block`` emits the right JSON. Mirrors the Marina Bay /
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
        print(f"  sky preset: miami_pastel (Beaufort-{SKY_PRESET['sea_state']}, "
              f"{SKY_PRESET['color_grade']}, bloom={SKY_PRESET['bloom']})")


# ────────────────────────────────────────────────────────────────────
# JSON merge — sky / audio overrides on top of the exported JSON.
# Wave zones round-trip through the export pass already (via the
# wave_zone_NN empties); we only own sky + audio here.
# ────────────────────────────────────────────────────────────────────

AQUALAND_SKY = {
    "tint": "#ffd9b8",
    "cloudiness": 0.3,
    "sunIntensity": 1.3,
    "fogNear": 200.0,
    "fogFar": 1200.0,
    "timeOfDay": 56.0,
    "colorGrade": "miami_pastel",
    "bloom": 0.3,
    "seaStateBeaufort": 3,
}


# Audio block — OMIT the `music` key entirely. The procedural pad bed
# plays instead until a licensed track lands. The json-loader
# validator at src/game/tracks/json-loader.ts:681 rejects
# `music: null` or `music: ""` ("audio.music must be a non-empty
# string if present"), so we must not write the key at all.
AQUALAND_AUDIO = {
    "ambient": [
        "waterpark-edm.opus",
        "pa-loop.opus",
        "gulls.opus",
    ],
    "ambientGains": [0.55, 0.35, 0.3],
    "music3dEffects": {
        "duckOnPump": 0.35,
    },
}


def _merge_track_json() -> None:
    """Merge the per-track sky / audio blocks into the exported JSON.
    The export operator writes the runtime fields (start, checkpoints,
    pickups, etc.); this function rewrites only the sky / audio entries
    so re-running the seed converges to the same JSON without losing
    the export's gameplay state. Mirrors
    ``seed_track_kilauea_crown._merge_track_json`` exactly."""
    import json
    json_path = os.path.join(REPO_ROOT, "public", "tracks", f"{SPEC.track_id}.json")
    if not os.path.isfile(json_path):
        # Export must have failed; nothing to merge into.
        print(f"  WARN: {json_path} not found post-export; sky/audio merge skipped.")
        return
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["sky"] = AQUALAND_SKY
    data["audio"] = AQUALAND_AUDIO
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"  JSON merged       → {json_path} (sky + audio overrides)")


# ────────────────────────────────────────────────────────────────────
# Top-level augmentation orchestrator
# ────────────────────────────────────────────────────────────────────


def augment_scene() -> None:
    """Layer the waterpark inline geometry + wave zones + pickups +
    boost pads + hero camera onto the road-built scene. Called after
    ``build_track_from_spec`` returns — at that point ``terrain``,
    ``ai_spline_main``, the road mesh and the start/checkpoint empties
    are placed."""
    tag = "[seed-track-aqualand]"
    print(f"{tag} augmenting scene with waterpark geometry + Tsunami zone")
    scene = bpy.context.scene

    _build_wave_pool_basin()
    _build_lazy_river_curbs()
    _build_halfpipe_slide()
    _build_lifeguard_towers()
    _build_main_concourse()
    _build_wave_zones(scene)
    pickups = _drop_pickups(scene)
    boosts = _drop_boost_pads(scene)
    _add_camera_hero(scene)
    _apply_sky_preset(scene)
    print(f"{tag}   {pickups} pickups + {boosts} boost pads")

    # Save the .blend with augmentation in place so the next manual
    # *Export Track to Game* picks up the new objects.
    output_blend = os.path.join(REPO_ROOT, "tracks-src", f"{SPEC.track_id}.blend")
    print(f"{tag} saving {output_blend}")
    bpy.ops.wm.save_as_mainfile(filepath=output_blend)

    # Re-export so the GLB picks up the augmentation (pool basin, lazy-
    # river curbs, slide, towers, concourse, both wave zones, pickups,
    # boost pads, hero camera) and the JSON merges the new wave-zone
    # blocks. Without this step the GLB only matches the post-build
    # state — none of the augmentation lands at runtime until the user
    # manually clicks Export Track to Game.
    print(f"{tag} re-exporting GLB + JSON + manifest")
    result = bpy.ops.hoverbike.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(
            f"{tag} export_track (post-augment) failed: {result}"
        )

    # Merge per-track JSON overrides (sky + audio) on top of the
    # exported JSON so the runtime sees the Aqualand palette next load.
    _merge_track_json()


if __name__ == "__main__":
    try:
        build_track_from_spec(SPEC)
        augment_scene()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-aqualand] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
