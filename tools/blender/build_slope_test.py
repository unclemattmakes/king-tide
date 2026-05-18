"""Slope-test track builder. Six parallel ramps at 10°/15°/20°/25°/30°/35°,
each with a flat plateau on top, sharing a wide base pad you spawn on.

Drive forward from spawn to pick a ramp, climb it, look at the speedometer
when you reach the plateau. Backspace respawns. Then repeat on the next
ramp. Anti-target: violent pitch whip, lost ground contact mid-climb, or
inability to crest the steeper grades.

Run headless so it doesn't disturb a running Blender session:

    pnpm gen:slope-test          # via npm alias
    # or directly:
    blender --background --python tools/blender/build_slope_test.py

Writes:
    tracks-src/slope-test.blend
    public/assets/tracks/slope-test.glb
    public/tracks/slope-test.json
"""

from __future__ import annotations

import json
import math
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(_SCRIPT_DIR))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import bpy  # noqa: E402

from tools.blender.common import REPO_ROOT, reset_scene  # noqa: E402

TRACK_ID = "slope-test"

# --- Layout knobs --------------------------------------------------------

RAMP_ANGLES_DEG = [10, 20, 25, 30, 35]  # middle entry sits at x=0
RAMP_RUN_M = 25.0           # horizontal distance covered by each ramp
RAMP_WIDTH_M = 12.0         # ramp + plateau width
RAMP_SPACING_M = 14.0       # center-to-center distance between adjacent ramps
PLATEAU_LEN_M = 20.0        # flat region beyond each ramp's top
# Base pad spans from behind the spawn point through the ramps' baseline, so
# the runway is continuous and the player can drive straight from spawn into
# the centerline ramp (RAMP_ANGLES_DEG[len/2]) without falling off the edge.
BASE_PAD_WIDTH_M = len(RAMP_ANGLES_DEG) * RAMP_SPACING_M + 8.0
BASE_PAD_DEPTH_M = 50.0     # extends from behind spawn forward past the ramp bases
PAD_THICKNESS_M = 1.0


def add_slab(name: str, center, size, rot_euler=(0.0, 0.0, 0.0), kind: str = "track"):
    """Add a rectangular slab via primitive_cube_add. `size` is full edge
    length (width, depth, height); the slab's extents are ±size/2. Center
    is the slab's center in world coords. Tags with `kind` so the runtime
    trimesh attaches.

    Implementation note: Blender's `primitive_cube_add(size=1)` yields a
    cube with edges of length 1 (extents ±0.5). Scaling by `size[i]` then
    gives final edges of `size[i]`. (Don't fall into the `size[i]*0.5`
    trap — that halves every dimension; build_track.py's calibration
    surface is sized in that frame and looks fine because its `spec.size`
    is already pre-doubled.)"""
    bpy.ops.mesh.primitive_cube_add(size=1, location=center, rotation=rot_euler)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0], size[1], size[2])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj["kind"] = kind
    return obj


def add_base_pad() -> bpy.types.Object:
    """Flat starting pad you spawn on. Top face at z=0, slab extends to
    z=-thickness so the trimesh has volume (Rapier discrete broadphase
    can tunnel through a zero-thickness plane at speed)."""
    half_t = PAD_THICKNESS_M * 0.5
    # Center pad at y = -BASE_PAD_DEPTH/2 so its leading edge sits at y=0.
    cy = -BASE_PAD_DEPTH_M * 0.5
    return add_slab(
        "base_pad",
        center=(0.0, cy, -half_t),
        size=(BASE_PAD_WIDTH_M, BASE_PAD_DEPTH_M, PAD_THICKNESS_M),
    )


def add_ramp_and_plateau(angle_deg: float, x_offset: float) -> list[bpy.types.Object]:
    """Build a single ramp (sloped slab) + plateau (flat slab at the ramp's
    top height). Bike enters from the base pad (y=0), climbs to y=RAMP_RUN,
    then continues on the plateau out to y = RAMP_RUN + PLATEAU_LEN.

    The ramp slab is rotated around its X axis so the top face matches the
    intended grade. Slab is 1m thick along the surface normal."""
    angle_rad = math.radians(angle_deg)
    rise = RAMP_RUN_M * math.tan(angle_rad)
    out: list[bpy.types.Object] = []

    # Ramp dimensions before rotation: width × hypotenuse × thickness.
    # Slab lies flat on XY before rotation; we rotate it around +X by
    # +angle so its forward (+Y) edge tilts UP into +Z (right-hand rule:
    # thumb along +X, fingers curl +Y→+Z). After the rotation:
    #   local +Y axis maps to world (0, cos θ,  sin θ)
    #   local +Z axis maps to world (0, -sin θ, cos θ)
    # so the slab's TOP face center (slab-local +Z by half_t) lives at
    # world (slab_center.x, -sin θ · half_t, +cos θ · half_t) relative
    # to slab_center.
    hyp = RAMP_RUN_M / math.cos(angle_rad)
    half_t = PAD_THICKNESS_M * 0.5

    # We want the slab's TOP face to span from (x_off, 0, 0) at the base
    # to (x_off, RAMP_RUN, rise) at the peak. Top face center should be
    # at (x_off, RAMP_RUN/2, rise/2). Subtracting the rotated thickness
    # offset gives the slab center.
    cx = x_offset
    cy = RAMP_RUN_M * 0.5 + math.sin(angle_rad) * half_t
    cz = rise * 0.5 - math.cos(angle_rad) * half_t
    ramp = add_slab(
        f"ramp_{int(angle_deg):02d}deg",
        center=(cx, cy, cz),
        size=(RAMP_WIDTH_M, hyp, PAD_THICKNESS_M),
        rot_euler=(angle_rad, 0.0, 0.0),
    )
    out.append(ramp)

    # Plateau on top: flat slab from y = RAMP_RUN to y = RAMP_RUN + PLATEAU_LEN,
    # at z = rise. Same thickness/centering trick as base pad.
    plateau_cy = RAMP_RUN_M + PLATEAU_LEN_M * 0.5
    plateau_cz = rise - half_t
    plateau = add_slab(
        f"plateau_{int(angle_deg):02d}deg",
        center=(x_offset, plateau_cy, plateau_cz),
        size=(RAMP_WIDTH_M, PLATEAU_LEN_M, PAD_THICKNESS_M),
    )
    out.append(plateau)

    # Floating label — a thin vertical text-like slab at the foot of the
    # ramp. Skip for now to keep the build simple; visual differentiation
    # comes from the spacing + angle.
    return out


def add_checkpoint(index: int, x: float, y: float, z: float = 1.5,
                    half_width: float = 6.0, height: float = 4.0):
    bpy.ops.object.empty_add(type="ARROWS", location=(x, y, z))
    obj = bpy.context.active_object
    obj.name = f"cp_{index:02d}"
    obj["kind"] = "checkpoint"
    obj["index"] = index
    obj["half_width"] = float(half_width)
    obj["height"] = float(height)
    return obj


def add_start(x: float, y: float, z: float = 0.5, yaw: float = 0.0):
    bpy.ops.object.empty_add(type="ARROWS", location=(x, y, z))
    obj = bpy.context.active_object
    obj.name = "start_00"
    obj["kind"] = "start"
    obj["index"] = 0
    obj.rotation_euler = (0.0, 0.0, yaw)
    return obj


def add_ai_spline(points: list[tuple[float, float, float]]):
    curve_data = bpy.data.curves.new(name="ai_spline_main", type="CURVE")
    curve_data.dimensions = "3D"
    spline = curve_data.splines.new(type="NURBS")
    spline.points.add(len(points) - 1)
    for i, p in enumerate(points):
        spline.points[i].co = (p[0], p[1], p[2], 1.0)
    spline.use_endpoint_u = True
    obj = bpy.data.objects.new("ai_spline_main", curve_data)
    bpy.context.collection.objects.link(obj)
    obj["kind"] = "ai_spline"
    obj["branch"] = "main"
    return obj


def add_lighting():
    bpy.ops.object.light_add(type="SUN", location=(10, 10, 20))
    sun = bpy.context.active_object
    sun.name = "sun"
    sun.data.energy = 4.0


def emit_gameplay_json(starts_b: list[tuple[float, float, float, float]],
                        checkpoints_b: list[dict],
                        ai_points_b: list[tuple[float, float, float]]) -> dict:
    """Build the runtime JSON. Spec coords are Blender (X right, Y forward,
    Z up). Convert to three.js (X right, Y up, Z forward; Blender +Y → three -Z)."""

    def b2t(p):
        return {"x": float(p[0]), "y": float(p[2]), "z": -float(p[1])}

    sx, sy, sz, syaw = starts_b[0]
    cps_out = []
    for i, cp in enumerate(checkpoints_b):
        cps_out.append({
            "index": i,
            "position": {"x": float(cp["x"]), "y": float(cp["z"]), "z": -float(cp["y"])},
            "rotation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
            "halfWidth": float(cp["halfWidth"]),
            "height": float(cp["height"]),
        })
    return {
        "id": TRACK_ID,
        "name": "Slope Test",
        "lapsToFinish": 1,
        "environmentGlb": f"/assets/tracks/{TRACK_ID}.glb",
        "water": {"height": -20.0, "waveHeight": 0.0, "waveFreq": 0.0},
        "start": {"position": b2t((sx, sy, sz)), "yaw": float(syaw)},
        "checkpoints": cps_out,
        "aiSplines": [{
            "id": "main",
            "points": [],
            "anchors": [b2t(p) for p in ai_points_b],
        }],
        "pickupSpawns": [],
        "boostPads": [],
    }


def build():
    print(f"[build-slope-test] generating {TRACK_ID}")
    reset_scene()
    add_base_pad()

    # Lay out ramps centered on x=0, evenly spaced.
    n = len(RAMP_ANGLES_DEG)
    span = (n - 1) * RAMP_SPACING_M
    x0 = -span * 0.5
    for i, angle in enumerate(RAMP_ANGLES_DEG):
        x_off = x0 + i * RAMP_SPACING_M
        add_ramp_and_plateau(angle, x_off)

    # Start point sits near the back of the base pad, facing +Y (toward
    # the ramps). Yaw=π means the bike's forward (three +Z) points to
    # three -Z, which is Blender +Y after the yup conversion. Confirmed
    # against test-ring.json which also faces +Y via yaw=π.
    start_b = (0.0, -BASE_PAD_DEPTH_M + 4.0, 0.5, math.pi)
    add_start(*start_b)

    # One checkpoint behind the start (so any race-system queries have
    # something to chew on — a slope test doesn't really race). Wide
    # gate so the bike crosses regardless of which ramp it picks.
    cp = {
        "x": 0, "y": -BASE_PAD_DEPTH_M + 1.0, "z": 1.5,
        "halfWidth": BASE_PAD_WIDTH_M * 0.5,
        "height": 4.0,
    }
    add_checkpoint(0, cp["x"], cp["y"], cp["z"], cp["halfWidth"], cp["height"])

    # Trivial AI spline. Slope test isn't an AI-racing scenario but the
    # loader still expects one to exist.
    ai_pts = [
        (0.0, -BASE_PAD_DEPTH_M + 4.0, 0.5),
        (0.0, 0.0, 0.5),
        (0.0, RAMP_RUN_M * 0.5, RAMP_RUN_M * 0.5 * math.tan(math.radians(20))),
    ]
    add_ai_spline(ai_pts)

    add_lighting()

    # Save the .blend so it shows up alongside the other tracks-src
    # entries (so it can be opened by hand if anyone wants to tweak).
    blend_path = os.path.join(REPO_ROOT, "tracks-src", f"{TRACK_ID}.blend")
    os.makedirs(os.path.dirname(blend_path), exist_ok=True)
    print(f"[build-slope-test] saving {blend_path}")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)

    # Export GLB via the canonical exporter.
    glb_out = os.path.join(REPO_ROOT, "public", "assets", "tracks", f"{TRACK_ID}.glb")
    os.makedirs(os.path.dirname(glb_out), exist_ok=True)
    os.environ["HOVERBIKE_OUTPUT"] = glb_out
    export_path = os.path.join(REPO_ROOT, "tools", "export_track.py")
    with open(export_path, "r", encoding="utf-8") as f:
        code = compile(f.read(), export_path, "exec")
    glb_ns: dict = {"__name__": "__main__", "__file__": export_path}
    try:
        exec(code, glb_ns)
    except SystemExit as e:
        if e.code not in (0, None):
            raise
    print(f"[build-slope-test] glb -> {glb_out}")

    # Emit the runtime JSON. Force-overwrite — the test track is a
    # generated artifact and has no in-editor tweaks worth preserving.
    json_out = os.path.join(REPO_ROOT, "public", "tracks", f"{TRACK_ID}.json")
    os.makedirs(os.path.dirname(json_out), exist_ok=True)
    body = emit_gameplay_json(
        starts_b=[start_b],
        checkpoints_b=[cp],
        ai_points_b=ai_pts,
    )
    with open(json_out, "w", encoding="utf-8") as f:
        json.dump(body, f, indent=2)
    print(f"[build-slope-test] json -> {json_out}")


if __name__ == "__main__":
    build()
