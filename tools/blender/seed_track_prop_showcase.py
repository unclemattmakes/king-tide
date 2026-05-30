"""Build ``tracks-src/prop-showcase.blend`` + GLB/JSON exports.

Run via:
    pnpm seed:track-prop-showcase

(equivalent to
``"C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
   --background --python tools/blender/seed_track_prop_showcase.py``)

This is **not a content track** — it's the in-engine *review stage* for
the props pipeline. A simple oval loop on the island template's water
basin, with one "station" of each procedural prop family from
``tracks-src/props-library.blend`` placed just off the racing line, so
you load ``?track=prop-showcase`` and fly past every prop at race pace
(the real "reads correctly at 40 m/s" test from
``docs/props-production-plan.md``).

As new prop families get the AI-accelerated / procedural treatment, add
a station here and re-seed — this map is the standing visual-QA harness
for the whole props effort. The hero camera frames the upgraded
``prop_sea_stack`` cluster at the start line.

Re-running the seed nuke-and-paves the showcase .blend + its exports.
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
_sample_anchor_polyline_at_t = _lib._sample_anchor_polyline_at_t

PROPS_LIBRARY = os.path.join(REPO_ROOT, "tracks-src", "props-library.blend")


# ────────────────────────────────────────────────────────────────────
# Spec — a clean oval loop on the island template's water basin
# ────────────────────────────────────────────────────────────────────

# Oval centred on the island, radius ~ (235, 205) so the racing line
# sits on the open-water basin around the central land mass (same basin
# the Sandbar tutorial uses). Props get placed on the *outer* side of
# the ring (open water) so the bike threads the inside and the gallery
# stations sweep past on the right.
_RX, _RY, _N = 235.0, 205.0, 12
SPLINE_ANCHORS: list[tuple[float, float, float]] = [
    (_RX * math.cos(2 * math.pi * i / _N),
     _RY * math.sin(2 * math.pi * i / _N),
     -2.0)
    for i in range(_N)
]


SPEC = TrackSpec(
    track_id="prop-showcase",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-island.blend"),
    spline_anchors=SPLINE_ANCHORS,
    checkpoint_ts=(0.25, 0.50, 0.75, 0.95),
    road_width=12.0,
    road_lift=0.25,
    road_blend_radius=8.0,
    road_samples=120,
    road_smooth_passes=5,
    road_thickness=0.5,
    gate_spacing_m=60.0,
    water_preview_size=700.0,
    water_preview_subdivisions=110,
)


# ────────────────────────────────────────────────────────────────────
# Deterministic per-instance jitter (no Math.random — CI-reproducible)
# ────────────────────────────────────────────────────────────────────

def _r01(a: int, b: int) -> float:
    n = (a * 374761393 + b * 668265263) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return (n & 0xFFFF) / 65535.0


# ────────────────────────────────────────────────────────────────────
# Prop sampler — one station per family, placed just off the line
# ────────────────────────────────────────────────────────────────────

# (mesh_datablock, t along loop, count, z, scale_min, scale_max)
# Only bmesh-baked families (full geometry in the mesh) — prop_rock is
# skipped because its shape lives in the HV_Prop_Rock GN group, not the
# base icosphere, so the bare mesh wouldn't carry the displacement.
STATIONS: list[tuple[str, float, int, float, float, float]] = [
    ("prop_sea_stack_mesh",        0.02, 6, -1.0, 0.85, 1.55),  # HERO (start line)
    ("prop_buoy_mesh",             0.11, 4,  0.0, 0.90, 1.20),
    ("prop_nav_marker_mesh",       0.19, 3,  0.0, 1.00, 1.00),
    ("prop_palm_mesh",             0.28, 5,  0.0, 0.85, 1.25),
    ("prop_container_mesh",        0.37, 4,  0.0, 0.90, 1.10),
    ("prop_oil_drum_mesh",         0.45, 5,  0.0, 1.00, 1.00),
    ("prop_basalt_boulder_mesh",   0.54, 5, -0.3, 0.80, 1.70),
    ("prop_mooring_bollard_mesh",  0.62, 4,  0.0, 1.00, 1.00),
    ("prop_lamp_post_mesh",        0.70, 3,  0.0, 1.00, 1.00),
    ("prop_gull_crag_mesh",        0.79, 4, -0.3, 0.90, 1.40),
    ("prop_kelp_strand_mesh",      0.87, 6, -1.4, 0.90, 1.30),
    ("prop_ash_heap_mesh",         0.94, 4,  0.0, 0.90, 1.35),
]


def _append_prop_meshes(names: list[str]) -> dict[str, bpy.types.Mesh]:
    """Append the requested mesh datablocks (with their materials) from
    the props library. Returns {requested_name: mesh}. A fresh template
    scene has no name collisions, so appended names match 1:1."""
    wanted = list(dict.fromkeys(names))
    with bpy.data.libraries.load(PROPS_LIBRARY, link=False) as (src, dst):
        avail = set(src.meshes)
        missing = [n for n in wanted if n not in avail]
        if missing:
            print(f"[seed-track-prop-showcase] WARN missing meshes: {missing}")
        dst.meshes = [n for n in wanted if n in avail]
    return {m.name: m for m in dst.meshes}


def _place_station(scene, mesh: bpy.types.Mesh, t0: float, count: int,
                   z: float, smin: float, smax: float) -> int:
    """Drop ``count`` instances of one prop family just outside the loop
    at parameter ``t0``, fanned along the tangent with per-instance yaw +
    scale. Tagged ``kind=decoration`` so the runtime renders but never
    collides with them (they sit clear of the racing line either way)."""
    (x, y), (tx, ty) = _sample_anchor_polyline_at_t(SPLINE_ANCHORS, t0)
    rl = math.hypot(x, y) or 1.0
    ox, oy = x / rl, y / rl                      # outward (away from island)
    tl = math.hypot(tx, ty) or 1.0
    ux, uy = tx / tl, ty / tl                    # along the line
    salt = int(t0 * 1000)
    placed = 0
    for k in range(count):
        off = 24.0 + 8.0 * k                     # step outward into open water
        along = (k - (count - 1) / 2.0) * 9.0    # fan along the tangent
        yaw = _r01(salt, k) * math.tau
        sc = smin + (smax - smin) * _r01(salt + 7, k * 3 + 1)
        px = x + ox * off + ux * along
        py = y + oy * off + uy * along
        obj = bpy.data.objects.new(f"showcase_{mesh.name}_{k}", mesh)
        obj.location = (px, py, z)
        obj.rotation_euler = (0.0, 0.0, yaw)
        obj.scale = (sc, sc, sc)
        obj["kind"] = "decoration"
        scene.collection.objects.link(obj)
        placed += 1
    return placed


def _add_camera_hero(scene) -> None:
    """Hero camera framing the upgraded sea-stack cluster at the start
    line (t≈0.02). Parked out over the open water, looking back at the
    island so the stacks read against the land backdrop."""
    import mathutils

    cam_data = bpy.data.cameras.new("camera_hero")
    cam_data.lens = 50.0
    cam_data.clip_start = 0.1
    cam_data.clip_end = 5000.0
    cam = bpy.data.objects.new("camera_hero", cam_data)
    cam["kind"] = "camera_hero"

    (x, y), _t = _sample_anchor_polyline_at_t(SPLINE_ANCHORS, 0.02)
    rl = math.hypot(x, y) or 1.0
    ox, oy = x / rl, y / rl
    target = mathutils.Vector((x + ox * 34.0, y + oy * 34.0, 4.0))
    cam_pos = mathutils.Vector((x + ox * 90.0 + 30.0, y + oy * 90.0 - 30.0, 26.0))
    cam.location = cam_pos
    cam.rotation_euler = (target - cam_pos).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(cam)


def _apply_open_sea_sky(scene) -> None:
    """A light open-water palette so the gallery reads under nice light.
    Every write is guarded — the scene props only exist when the addon
    registered them, which it has by the time we run."""
    try:
        from hoverbike_addon.sky_preset import set_sky_tint_from_hex
        set_sky_tint_from_hex("#cfe3f2")
    except Exception:
        pass
    for prop, val in (
        ("hoverbike_sky_cloudiness", 0.3),
        ("hoverbike_sky_sun_intensity", 1.15),
        ("hoverbike_sky_fog_near", 350.0),
        ("hoverbike_sky_fog_far", 1400.0),
        ("hoverbike_sky_time_of_day", 90.0),
        ("hoverbike_sky_color_grade", "big_sur_golden"),
        ("hoverbike_sky_bloom", 0.5),
        ("hoverbike_sky_sea_state", 3),
    ):
        if hasattr(scene, prop):
            try:
                setattr(scene, prop, val)
            except Exception:
                pass


# ────────────────────────────────────────────────────────────────────
# Augment + re-export
# ────────────────────────────────────────────────────────────────────

def _augment_and_reexport() -> None:
    scene = bpy.context.scene
    output_blend = os.path.join(REPO_ROOT, "tracks-src", f"{SPEC.track_id}.blend")

    if hasattr(scene, "hoverbike_laps_to_finish"):
        scene.hoverbike_laps_to_finish = 1
    _apply_open_sea_sky(scene)

    meshes = _append_prop_meshes([s[0] for s in STATIONS])
    total = 0
    for mesh_name, t0, count, z, smin, smax in STATIONS:
        mesh = meshes.get(mesh_name)
        if mesh is None:
            continue
        total += _place_station(scene, mesh, t0, count, z, smin, smax)
    print(f"[seed-track-prop-showcase] placed {total} props across {len(STATIONS)} stations")

    _add_camera_hero(scene)

    bpy.ops.wm.save_as_mainfile(filepath=output_blend)

    result = bpy.ops.hoverbike.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(f"[seed-track-prop-showcase] re-export failed: {result}")


# ────────────────────────────────────────────────────────────────────
# Entry
# ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        build_track_from_spec(SPEC)
        _augment_and_reexport()
        print(f"[seed-track-prop-showcase] done — {SPEC.track_id}")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-prop-showcase] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
