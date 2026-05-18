"""Build ``tracks-src/cape-town-drift.blend`` + GLB/JSON exports.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_cape_town_drift.py

Or via the pnpm wrapper:
    pnpm seed:track-cape-town-drift

Reshape: a wide harbor loop through the drowned V&A Waterfront. The
racing line dives THROUGH the broken Two Oceans Aquarium roof (the
postcard set-piece), past the leaning Cape Wheel, down a harbor
straight, and back through a container-scattered straight to the
start. Mostly flat-water with one short "land" beat through the
shattered aquarium volume.

Built on ``template-island`` because Cape Town's signature is bright
Atlantic harbor + a far-horizon Table Mountain silhouette; the mesa
template wants its mesas underfoot, which doesn't match a flat
harbor. Table Mountain reads via a single oversized
``landmark_mountain_cone`` parked ~3 km south of the racing line +
scaled flat-on-top, **plus** a JSON ``horizon`` override pinning a
darker, flatter silhouette (so the procedural ring carries the
mountain ridge cleanly even before the GLB landmark resolves).

After ``build_track_from_spec(SPEC)`` returns this script augments
the scene with:

  * Table Mountain backdrop  — ``landmark_mountain_cone`` instance.
  * Cape Wheel               — ``landmark_wheel_ferris`` instance,
                               leaning ~15° to read as "post-flood".
  * Two Oceans Wreck         — ``landmark_glass_tank_broken`` placed
                               so the racing line crosses through the
                               broken roof, plus a small "shark" prop
                               inside (kind=decoration).
  * Drowned facades          — 5× ``landmark_drowned_facade_nyc``
                               around the harbor perimeter.
  * Container scatter        — 10× cuboid kind=track boxes in
                               oxidized red, sodium-yellow, dirty
                               white. Bike can slap into them.
  * Wave zones               — sheltered harbor (height_mult 0.6) and
                               open Atlantic outside the breakwater
                               (height_mult 1.3). Cape Town is intro
                               difficulty per track-themes — keep the
                               chop manageable.
  * Pickups + boost pads     — 6 pickup empties, 2 boost pads on the
                               container straight.
  * camera_hero              — framing the broken aquarium tank with
                               Table Mountain behind, golden-hour'ish
                               lighting, 50 mm.

The augmentation walks the same Blender API as the seed scripts in
``tools/blender/`` so re-running ``pnpm seed:track-cape-town-drift``
stomps the .blend deterministically. Hand-tuned tweaks belong on a
separate one-off pass after this seed runs once.
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

# Path to the landmarks-library blend the appender pulls archetype
# meshes from. The library is built by ``seed_landmarks_library.py``;
# this seed assumes it exists (CI runs it before the track seeds).
LANDMARKS_BLEND = os.path.join(REPO_ROOT, "tracks-src", "landmarks-library.blend")


# ────────────────────────────────────────────────────────────────────
# TrackSpec — the racing line + road params
# ────────────────────────────────────────────────────────────────────

# Layout (XY world coords; Z=-2 keeps the racing line just above the
# default water surface so the snap-spline pass clamps it cleanly):
#
#   start straight (south)
#       │
#       └─→ SE turn-in towards the broken aquarium roof
#                 │
#                 └─→ CP0 aquarium-roof entry (THE postcard moment)
#                            │
#                            └─→ east arc past leaning Cape Wheel  → CP1
#                                                                  │
#                              harbor straight (north side)        ▼
#                              ◄─── CP2 ◄────────────── back-haul
#                                                                  │
#                                                       container straight
#                                                                  │
#                                                                 CP3 → start
#
# Total arc length is roughly 1.2 km — 48 s lap @ 25 m/s.
SPEC = TrackSpec(
    track_id="cape-town-drift",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-island.blend"),
    spline_anchors=[
        (   0.0, -360.0, -2.0),   # south start straight
        ( 140.0, -320.0, -2.0),   # SE turn-in
        ( 230.0, -200.0, -2.0),   # approach to aquarium roof
        ( 250.0,  -60.0, -2.0),   # CP0 region — through broken roof
        ( 230.0,   80.0, -2.0),   # exit aquarium straight
        ( 140.0,  220.0, -2.0),   # past leaning Cape Wheel
        (   0.0,  320.0, -2.0),   # NE harbor apex
        (-160.0,  280.0, -2.0),   # harbor straight crest
        (-300.0,  120.0, -2.0),   # NW breakwater turn
        (-340.0,  -60.0, -2.0),   # W open-water bend
        (-260.0, -240.0, -2.0),   # container straight entry
        (-100.0, -340.0, -2.0),   # rejoin start straight
    ],
    # Four checkpoints, placed so each landmark gates its own beat.
    checkpoint_ts=(0.22, 0.42, 0.62, 0.86),
    # Wide enough for the bright afrobeats energy + forgiving intro
    # difficulty per track-themes.
    road_width=11.0,
    road_lift=0.3,
    road_blend_radius=7.5,
    road_samples=128,
    road_smooth_passes=5,
    road_curb_width=0.7,
    road_curb_height=0.16,
    road_curb_stripe=2.0,
    road_thickness=0.6,
    gate_spacing_m=60.0,
    water_preview_size=900.0,
    water_preview_subdivisions=140,
)


# ────────────────────────────────────────────────────────────────────
# Landmark / decoration augmentation
# ────────────────────────────────────────────────────────────────────


def _ensure_material(name: str, hex_color: str, *, roughness: float = 0.65,
                     emission: bool = False) -> bpy.types.Material:
    """Cape-Town palette materials — bright Atlantic + oxidized
    container reds. Idempotent on name."""
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
    # Gamma 2.2 to linear (matches make_material in seed_landmarks_library).
    bsdf.inputs["Base Color"].default_value = (r ** 2.2, g ** 2.2, b ** 2.2, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        try:
            bsdf.inputs["Emission Color"].default_value = (r ** 2.2, g ** 2.2, b ** 2.2, 1.0)
            bsdf.inputs["Emission Strength"].default_value = 0.6
        except KeyError:
            pass
    return mat


def _append_landmark_mesh(name: str) -> bpy.types.Object | None:
    """Append a single ``landmark_<archetype>_mesh`` object from the
    landmarks-library .blend into the current scene. Returns the new
    object with its transform reset, or None if the library hasn't
    been built yet (seed runs in CI before the track seeds)."""
    if not os.path.exists(LANDMARKS_BLEND):
        print(f"  WARN: landmarks library not found at {LANDMARKS_BLEND}; "
              f"skipping {name}. Run `pnpm seed:landmarks-library` first.")
        return None
    pre_existing = set(bpy.data.objects.keys())
    with bpy.data.libraries.load(LANDMARKS_BLEND, link=False) as (data_from, data_to):
        if name not in data_from.objects:
            print(f"  WARN: {name} not in {LANDMARKS_BLEND}; library may be stale.")
            return None
        data_to.objects = [name]
    # Link the freshly loaded object into the scene collection. The
    # library load may have brought in materials + nested objects too —
    # we leave those alone; they share by name.
    scene_collection = bpy.context.scene.collection
    new_names = [n for n in bpy.data.objects.keys() if n not in pre_existing]
    obj = None
    for n in new_names:
        candidate = bpy.data.objects[n]
        # Match by basename — ``libraries.load`` appends ``.NNN`` on
        # name collision, but the basename comparison still resolves to
        # our archetype.
        if candidate.name == name or candidate.name.split(".")[0] == name:
            obj = candidate
        try:
            scene_collection.objects.link(candidate)
        except RuntimeError:
            pass
    if obj is None:
        return None
    obj.location = (0.0, 0.0, 0.0)
    obj.rotation_euler = (0.0, 0.0, 0.0)
    obj.scale = (1.0, 1.0, 1.0)
    return obj


def _duplicate_object(src: bpy.types.Object, new_name: str) -> bpy.types.Object:
    """Make a fresh Object sharing src's mesh datablock so we can stamp
    many instances of a landmark archetype without duplicating geometry.
    The new object inherits the source's ``kind`` extras so collider
    classification still fires at runtime."""
    obj = bpy.data.objects.new(new_name, src.data)
    bpy.context.scene.collection.objects.link(obj)
    obj["kind"] = src.get("kind", "track")
    landmark_id = src.get("landmark_id")
    if landmark_id is not None:
        obj["landmark_id"] = landmark_id
    return obj


def _build_table_mountain(scene) -> None:
    """One ``landmark_mountain_cone`` parked ~3 km south of the racing
    line, scaled flat-top to read as Table Mountain. The mountain_cone
    archetype is ``~840 m × 420 m`` per the library description; we
    scale Z down hard so the silhouette reads as a flat-top mesa, not
    a Mt-Fuji cone."""
    src = _append_landmark_mesh("landmark_mountain_cone_mesh")
    if src is None:
        return
    obj = _duplicate_object(src, "cape_town_table_mountain")
    # Remove the originally-appended pristine copy so we don't end up
    # with the source landmark sitting at world origin (its LAYOUT
    # position from the library is irrelevant to this scene).
    bpy.data.objects.remove(src, do_unlink=True)
    # Park ~3 km south on the world axis so the silhouette dominates
    # the south horizon when the racing line faces south. Lift slightly
    # so the base sits below sea level (the mountain reads as rising
    # *out* of the ocean).
    obj.location = (-200.0, -3000.0, -30.0)
    # Flat-top — scale Z to ~0.45 so 420 m tall mountain becomes ~190 m,
    # widen XY slightly so the silhouette stretches into a Table-
    # Mountain plateau rather than a cone.
    obj.scale = (1.6, 1.6, 0.45)
    # Mountain cones are decoration-scale — not collidable in practice,
    # but the library tags them kind=track. Re-tag here so the runtime
    # doesn't waste a trimesh on a 3 km-distant horizon prop.
    obj["kind"] = "decoration"
    obj["hb_landmark"] = "table_mountain"
    print(f"  Table Mountain  → {obj.name} @ {tuple(round(c, 1) for c in obj.location)}")


def _build_cape_wheel(scene) -> None:
    """``landmark_wheel_ferris`` instance positioned near the racing
    line on the east side, leaning ~15° around the world X axis to
    read as "the Cape Wheel survived the flood but didn't survive
    intact". The library's default is 50 m diameter — Cape Town's
    real wheel is 40 m, but the brief asks for ~50 m for visibility."""
    src = _append_landmark_mesh("landmark_wheel_ferris_mesh")
    if src is None:
        return
    obj = _duplicate_object(src, "cape_town_cape_wheel")
    bpy.data.objects.remove(src, do_unlink=True)
    # The library's ferris wheel is built with the rim in the XZ plane
    # facing +Y. Place near anchor[5] (~140, 220) on the east side of
    # the harbor, hub centred ~28 m above the water (matches the
    # library's 28 m centre-height note).
    obj.location = (180.0, 235.0, 5.0)
    # Lean ~15° around world +X so the wheel tilts toward the racing
    # line; small Z rotation so the rim faces obliquely.
    lean = math.radians(15.0)
    yaw = math.radians(-25.0)
    obj.rotation_euler = (lean, 0.0, yaw)
    # Slight upscale (×1.05) so the wheel reads dominant at race pace.
    obj.scale = (1.05, 1.05, 1.05)
    obj["kind"] = "track"
    obj["hb_landmark"] = "cape_wheel"
    print(f"  Cape Wheel       → {obj.name} @ {tuple(round(c, 1) for c in obj.location)} (lean 15°)")


def _build_two_oceans_wreck(scene) -> None:
    """The hero set-piece. Drop a ``landmark_glass_tank_broken`` so the
    racing line passes through the broken +Y face. Tank is 20×14×10 m
    per the library; scale up modestly so the broken roof is wide
    enough for the road to thread through cleanly. Then add a small
    shark prop inside, oriented to "patrol"."""
    src = _append_landmark_mesh("landmark_glass_tank_broken_mesh")
    if src is None:
        return
    obj = _duplicate_object(src, "cape_town_two_oceans_tank")
    bpy.data.objects.remove(src, do_unlink=True)
    # Position the tank's centre at the postcard moment (anchor[3]
    # area: ~250, -60). Rotate the tank so its shattered +Y face opens
    # roughly +Y in scene coords — that's the direction the racing
    # line is heading at this spline arc-length (south-to-north).
    obj.location = (250.0, -60.0, 1.5)
    # Library tank is 20×14×10 (W×D×H). Scale x2 so the broken roof
    # spans ~40 m — wider than the 11 m road, with 14 m clearance to
    # spare on each side for the bike + camera.
    obj.scale = (2.0, 2.0, 1.6)
    # Rotate 180° around Z so the shattered +Y face points back into
    # the approach direction; the racing line enters via the shatter,
    # exits cleanly through the (intact) opposite wall as authored
    # geometry — the road tool will have cut a clean channel below.
    obj.rotation_euler = (0.0, 0.0, math.radians(180.0))
    obj["kind"] = "track"
    obj["hb_landmark"] = "two_oceans_wreck"
    print(f"  Two Oceans Wreck → {obj.name} @ {tuple(round(c, 1) for c in obj.location)}")

    # Shark prop — stretched ellipsoid + dorsal fin. Procedural so we
    # don't add a kit dependency. The runtime treats kind=decoration as
    # "render, don't collide" since it's not in ExportedKind.
    shark_mat = _ensure_material("mat_cape_town_shark", "#4a5a64", roughness=0.55)
    shark = _build_shark_prop("cape_town_shark", shark_mat)
    shark.parent = obj  # tag-along with the tank so the postcard moves as one
    shark.matrix_parent_inverse.identity()
    shark.location = (4.0, -2.0, 0.5)  # inside the tank's interior
    shark.rotation_euler = (0.0, 0.0, math.radians(35.0))  # mid-patrol
    shark.scale = (0.9, 0.9, 0.9)
    shark["kind"] = "decoration"
    shark["hb_landmark"] = "great_white"
    print(f"    + shark prop   → {shark.name} (decoration)")


def _build_shark_prop(name: str, material: bpy.types.Material) -> bpy.types.Object:
    """Stretched ellipsoid body + triangular dorsal fin. Built with
    bmesh so we don't have to ship a kit blend. Roughly 4 m long, 1 m
    tall, 0.8 m wide — readable from race-line distance as a great
    white silhouette."""
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    bm = bmesh.new()
    try:
        # Body — UV sphere, then non-uniform scale in bmesh space.
        bmesh.ops.create_uvsphere(
            bm, u_segments=16, v_segments=10, radius=1.0,
        )
        # Stretch along +X.
        for v in bm.verts:
            v.co.x *= 2.0   # 4 m long
            v.co.y *= 0.45  # 0.9 m wide
            v.co.z *= 0.55  # 1.1 m tall
        # Dorsal fin — triangle on top, centred slightly forward of
        # midbody. Author it in bmesh as three loose verts + one face.
        fin_z = 0.55
        v1 = bm.verts.new((-0.1, 0.0, fin_z))
        v2 = bm.verts.new(( 0.7, 0.0, fin_z))
        v3 = bm.verts.new(( 0.3, 0.0, fin_z + 0.6))
        bm.faces.new([v1, v2, v3])
        bm.normal_update()
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _build_harbor_facades(scene) -> None:
    """5× ``landmark_drowned_facade_nyc`` around the harbor perimeter.
    Mass-vary by scale (warehouses are short + wide; hotel silhouettes
    are tall + thin). The library's nyc-style facade is 30 m × 90 m;
    scale Z down for warehouse silhouettes."""
    src = _append_landmark_mesh("landmark_drowned_facade_nyc_mesh")
    if src is None:
        return
    # Five positions around the harbor perimeter, each with a unique
    # scale/yaw so they don't read as clones at race pace.
    placements = [
        # (x, y, z, scale_x, scale_y, scale_z, yaw_deg, label)
        ( 320.0,   60.0, -1.0, 1.0, 1.2, 0.18, -85.0, "harbor_warehouse_e"),
        ( 100.0,  360.0, -1.0, 1.2, 1.0, 0.22, -15.0, "harbor_warehouse_n"),
        (-220.0,  340.0, -1.0, 1.0, 1.0, 0.30,  30.0, "harbor_hotel_nw"),
        (-380.0,   40.0, -1.0, 0.9, 1.1, 0.40,  85.0, "harbor_hotel_w"),
        (-200.0, -300.0, -1.0, 1.1, 0.9, 0.18, 150.0, "harbor_warehouse_sw"),
    ]
    for i, (x, y, z, sx, sy, sz, yaw, label) in enumerate(placements):
        obj = _duplicate_object(src, f"cape_town_facade_{i:02d}")
        obj.location = (x, y, z)
        obj.scale = (sx, sy, sz)
        obj.rotation_euler = (0.0, 0.0, math.radians(yaw))
        obj["hb_landmark"] = label
        print(f"  facade[{i}]      → {obj.name} @ ({x}, {y}) "
              f"scale=({sx}, {sy}, {sz:.2f})")
    # Remove the pristine source — we only kept it to duplicate from.
    bpy.data.objects.remove(src, do_unlink=True)


# Container palette + sizes, cycled across the 10 instances. Oxidized
# reds, sodium-yellows, dirty whites — the colour story from
# track-themes' "oxidized container reds".
_CONTAINER_PALETTE = (
    ("#a53a26", "oxidized_red"),
    ("#c87320", "rust_orange"),
    ("#d4a437", "sodium_yellow"),
    ("#c8c0b2", "dirty_white"),
    ("#7e3a25", "deep_rust"),
)


def _build_containers(scene) -> None:
    """10× cuboid kind=track boxes scattered around the harbor as cargo
    containers. Heights vary 6–12 m; widths roughly match a real
    20-foot container (6 m × 2.4 m × 2.6 m) but exaggerated for visual
    weight. Bike collides with them per kind=track."""
    container_mats = [
        _ensure_material(f"mat_cape_town_container_{label}", hex_color, roughness=0.7)
        for hex_color, label in _CONTAINER_PALETTE
    ]
    # Positions chosen to ring the container straight (anchors 10-11)
    # and seed a few stragglers near the harbor centre. Z=0 puts the
    # base of each box at water surface — they'll read as floating /
    # half-submerged.
    placements = [
        # (x, y, sx, sy, sz, yaw_deg) — sx/sy/sz are half-extents in m.
        (-220.0, -260.0, 3.0, 1.4, 3.0,  10.0),
        (-180.0, -290.0, 3.0, 1.4, 4.5,  -5.0),
        (-150.0, -310.0, 6.0, 1.4, 3.0,  30.0),
        (-260.0, -190.0, 3.0, 1.4, 5.0,  20.0),
        (-290.0, -150.0, 6.0, 1.4, 3.5,  60.0),
        (-130.0, -250.0, 3.0, 1.4, 6.0,   0.0),
        (-330.0, -100.0, 3.0, 1.4, 4.0, -40.0),
        ( -70.0, -290.0, 3.0, 1.4, 5.0,  15.0),
        (-300.0,  -30.0, 6.0, 1.4, 3.0,  85.0),
        (-360.0,  -60.0, 3.0, 1.4, 4.5, -75.0),
    ]
    for i, (x, y, sx, sy, sz, yaw) in enumerate(placements):
        mat = container_mats[i % len(container_mats)]
        name = f"cape_town_container_{i:02d}"
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
        obj.location = (x, y, sz)  # base touches z=0
        obj.rotation_euler = (0.0, 0.0, math.radians(yaw))
        obj["kind"] = "track"  # collidable per ExportedKind.TRACK
        obj["hb_landmark"] = "harbor_container"
        print(f"  container[{i:02d}] → ({x}, {y}) "
              f"size=({sx*2:.1f}×{sy*2:.1f}×{sz*2:.1f}) {mat.name}")


# ────────────────────────────────────────────────────────────────────
# Authored empties (wave zones, pickups, boost pads, hero camera)
# ────────────────────────────────────────────────────────────────────


def _add_wave_zone(name: str, *, position: tuple[float, float, float],
                   half_extents: tuple[float, float, float],
                   yaw_deg: float, height_mult: float, freq_mult: float = 1.0,
                   blend_radius_m: float = 30.0) -> bpy.types.Object:
    """Create a ``wave_zone_NN`` empty. The empty's local +X is the
    dominant swell direction (yaw_deg=0 → swell rolls along world +X)."""
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 8.0
    obj["kind"] = "wave_zone"
    obj["half_width"] = half_extents[0]
    obj["half_height"] = half_extents[1]  # vertical extent (Blender Z)
    obj["half_depth"] = half_extents[2]
    obj["height_mult"] = height_mult
    obj["freq_mult"] = freq_mult
    obj["blend_radius_m"] = blend_radius_m
    obj.location = position
    obj.rotation_euler = (0.0, 0.0, math.radians(yaw_deg))
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _build_wave_zones(scene) -> None:
    """Two zones: sheltered harbor (calmer) + open Atlantic outside the
    breakwater (forgiving but bigger swell). Cape Town is intro
    difficulty — both zones stay close to neutral. The runtime soft-
    blends across blend_radius_m so the OBB face never pops."""
    # Sheltered harbor — covers most of the inner racing line. height
    # mult 0.6 gives a noticeably calm wave field.
    inner = _add_wave_zone(
        "wave_zone_00_harbor_calm",
        position=(0.0, 0.0, 0.0),
        half_extents=(280.0, 30.0, 220.0),
        yaw_deg=0.0,
        height_mult=0.6,
        freq_mult=0.95,
        blend_radius_m=35.0,
    )
    # Open sea outside the breakwater — wraps the W / SW arc where the
    # racing line dips closest to "open Atlantic". 1.3× amp keeps it
    # forgiving (intro difficulty) while still adding pump opportunities.
    outer = _add_wave_zone(
        "wave_zone_01_open_sea",
        position=(-380.0, -100.0, 0.0),
        half_extents=(180.0, 30.0, 200.0),
        yaw_deg=70.0,  # swell rolls from the SW toward the harbor mouth
        height_mult=1.3,
        freq_mult=1.05,
        blend_radius_m=40.0,
    )
    print(f"  wave_zone harbor → {inner.name} @ {tuple(round(c, 1) for c in inner.location)} "
          f"× ({inner['half_width']}×{inner['half_depth']}), height_mult={inner['height_mult']}")
    print(f"  wave_zone sea    → {outer.name} @ {tuple(round(c, 1) for c in outer.location)} "
          f"× ({outer['half_width']}×{outer['half_depth']}), height_mult={outer['height_mult']}")


def _add_pickup(name: str, position: tuple[float, float, float]) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "SPHERE"
    obj.empty_display_size = 2.0
    obj["kind"] = "pickup_spawn"
    obj.location = position
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _add_boost_pad(name: str, position: tuple[float, float, float],
                   *, yaw_deg: float, half_width: float = 3.0,
                   half_depth: float = 6.0, strength: float = 1.5) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "ARROWS"
    obj.empty_display_size = 4.0
    obj["kind"] = "boost_pad"
    obj["half_width"] = half_width
    obj["half_depth"] = half_depth
    obj["strength"] = strength
    obj.location = position
    obj.rotation_euler = (0.0, 0.0, math.radians(yaw_deg))
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _build_pickups_and_boosts(scene) -> None:
    """6 pickups along the racing line; 2 boost pads on the container
    straight + the harbor straight."""
    # Pickups — sample the racing line at sensible t's so the empties
    # sit near the bike's average altitude (the editor's auto-snap
    # will pull them down to the road surface on next save).
    pickups = [
        ( 100.0, -310.0,  4.0),  # start straight
        ( 235.0,  -60.0,  6.0),  # by the aquarium wreck — temptation
        ( 200.0,  120.0,  4.0),  # post-aquarium recovery
        (   0.0,  300.0,  4.0),  # north apex
        (-280.0,  140.0,  4.0),  # breakwater entry
        (-260.0, -160.0,  4.0),  # open-sea wave-zone hotspot
    ]
    for i, p in enumerate(pickups):
        obj = _add_pickup(f"pickup_{i:02d}", p)
        print(f"  pickup[{i:02d}]   → {obj.name} @ {p}")
    # Two boost pads — one rewards the open-sea pump line, one rewards
    # the container straight finish.
    pads = [
        # (name, position, yaw_deg-along-racing-line)
        ("boost_00", (-310.0,   40.0,  2.0), -10.0),   # NW breakwater straight
        ("boost_01", ( -50.0, -340.0,  2.0),  80.0),   # rejoin into start
    ]
    for name, pos, yaw in pads:
        obj = _add_boost_pad(name, pos, yaw_deg=yaw)
        print(f"  {name}        → @ {pos} yaw={yaw}°")


def _add_camera_hero(scene) -> None:
    """50 mm camera framed on the broken aquarium with Table Mountain
    in the background. Authors can tweak after the seed runs; the
    initial pose just has to be sane enough for the headless render."""
    cam_data = bpy.data.cameras.new("camera_hero")
    cam_data.lens = 50.0
    cam_data.clip_start = 0.1
    cam_data.clip_end = 6000.0
    obj = bpy.data.objects.new("camera_hero", cam_data)
    obj["kind"] = "camera_hero"
    # Park behind the racing line entry to the aquarium, slightly
    # above water so Table Mountain (3 km south) sits on the horizon
    # behind the broken roof. The aquarium target is (250, -60, 1.5);
    # camera offsets +X (right) and -Y (south) so we look NE through
    # the broken roof toward Table Mountain on the south horizon.
    cam_pos = Vector((320.0, -130.0, 32.0))
    target = Vector((250.0, -60.0, 6.0))
    obj.location = cam_pos
    # Aim the camera at `target`. ``to_track_quat("-Z", "Y")`` is the
    # canonical Blender camera-axis convention: camera shoots down -Z
    # with +Y up. Matches ``_aim_camera_at`` in the addon's thumbnail
    # module without taking the import dependency here.
    delta = target - cam_pos
    obj.rotation_euler = delta.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(obj)
    print(f"  camera_hero    → @ {tuple(round(c, 1) for c in obj.location)} "
          f"aimed at {tuple(round(c, 1) for c in target)}")


# ────────────────────────────────────────────────────────────────────
# Top-level augmentation orchestrator
# ────────────────────────────────────────────────────────────────────


def augment_scene() -> None:
    """Layer landmarks, decorations, wave zones, pickups, boost pads
    and the hero camera onto the road-built scene. Called after
    ``build_track_from_spec`` returns — at that point ``terrain``,
    ``ai_spline_main``, the road mesh and the start/checkpoint empties
    all exist and are properly placed."""
    print("[cape-town-drift] augmenting scene with landmarks + props")
    scene = bpy.context.scene
    _build_table_mountain(scene)
    _build_cape_wheel(scene)
    _build_two_oceans_wreck(scene)
    _build_harbor_facades(scene)
    _build_containers(scene)
    _build_wave_zones(scene)
    _build_pickups_and_boosts(scene)
    _add_camera_hero(scene)
    # Save .blend with augmentation in place. The build_track pipeline
    # already saved + exported before we got here, so the .blend is up
    # to date with the road; we need one more save now that the
    # landmarks + zones are in. The export will rerun on the next
    # manual `Export Track to Game` pass — for now the .blend is the
    # source of truth.
    output_blend = os.path.join(REPO_ROOT, "tracks-src", "cape-town-drift.blend")
    bpy.ops.wm.save_as_mainfile(filepath=output_blend)
    print(f"[cape-town-drift] saved {output_blend} with augmentation")


if __name__ == "__main__":
    try:
        build_track_from_spec(SPEC)
        augment_scene()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-cape-town-drift] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
