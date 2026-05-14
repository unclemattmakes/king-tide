"""Build ``tracks-src/canyon-run.blend`` + GLB/JSON exports.

Run (after ``seed_template_mesa.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_canyon_run.py

Reshape: an inter-mesa figure-8 that threads the canyon channels
between the SE / NE / NW / SW mesas, climbing partway up the SE
plateau approach. Authoring is driven by ``track_build_lib``.
"""

from __future__ import annotations

import importlib.util
import os
import sys

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


SPEC = TrackSpec(
    track_id="canyon-run",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-mesa.blend"),
    # start_z is implicit — the snap-starts operator picks the right
    # altitude from the surface beneath the spline + the hover height.
    spline_anchors=[
        (   0.0, -380.0, -2.0),  # south canyon entrance
        ( 160.0, -340.0, -2.0),
        ( 280.0, -220.0, 12.0),  # climbing onto SE plateau approach
        ( 360.0,  -40.0, -2.0),  # dropping back into NE canyon channel
        ( 280.0,  150.0, -2.0),
        (  80.0,  300.0, -2.0),  # N canyon between center spire + NE
        (-100.0,  320.0, -2.0),
        (-260.0,  220.0, -2.0),  # NW canyon
        (-380.0,    0.0, -2.0),  # W canyon
        (-300.0, -180.0, -2.0),  # SW canyon
        (-120.0, -340.0, -2.0),  # rejoin start straight
    ],
    checkpoint_ts=(0.25, 0.5, 0.75, 0.9),
    # Narrower than dunes — canyon trail feel.
    road_width=12.0,
    road_lift=0.3,
    road_blend_radius=7.0,
    road_samples=128,
    road_smooth_passes=6,  # canyon transitions are steep; smooth aggressively
    road_curb_width=0.7,
    road_curb_height=0.16,
    road_curb_stripe=2.0,
    road_thickness=0.7,
    gate_spacing_m=65.0,
    water_preview_size=700.0,
    water_preview_subdivisions=120,
)


if __name__ == "__main__":
    try:
        build_track_from_spec(SPEC)
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-canyon-run] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
