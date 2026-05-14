"""Build ``tracks-src/dune-rally.blend`` + GLB/JSON exports.

Run (after ``seed_template_dunes.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_dune_rally.py

Reshape: a wide asymmetric oval that hugs the south + east of the
oasis, climbs the western dune ridge, and dives back through a sandy
choke at the north. Authoring is driven by ``track_build_lib``.
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
# @dataclass needs the module registered in sys.modules before exec_module,
# otherwise the decorator's _is_type lookup blows up trying to read the
# (still-being-loaded) module's __dict__.
sys.modules["track_build_lib"] = _lib
spec.loader.exec_module(_lib)

TrackSpec = _lib.TrackSpec
REPO_ROOT = _lib.REPO_ROOT
build_track_from_spec = _lib.build_track_from_spec


SPEC = TrackSpec(
    track_id="dune-rally",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-dunes.blend"),
    spline_anchors=[
        (   0.0, -300.0, 24.0),  # south straight
        ( 220.0, -240.0, 24.0),  # SE turn-in
        ( 340.0,  -80.0, 28.0),  # east shoulder (high)
        ( 320.0,  120.0, 28.0),  # east apex
        ( 180.0,  300.0, 24.0),  # north straight
        ( -60.0,  340.0, 24.0),  # north choke
        (-260.0,  240.0, 28.0),  # west shoulder (high)
        (-360.0,    0.0, 28.0),  # west apex
        (-280.0, -200.0, 24.0),  # SW turn
        ( -80.0, -310.0, 24.0),  # back to start straight
    ],
    checkpoint_ts=(0.25, 0.5, 0.75, 0.9),
    # Road tool — wider than default to read as a desert highway.
    road_width=14.0,
    road_lift=0.25,
    road_blend_radius=8.0,
    road_samples=96,
    road_smooth_passes=5,
    road_curb_width=0.8,
    road_curb_height=0.18,
    road_curb_stripe=2.5,
    road_thickness=0.6,
    gate_spacing_m=70.0,
    water_preview_size=360.0,
    water_preview_subdivisions=80,
)


if __name__ == "__main__":
    try:
        build_track_from_spec(SPEC)
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-dune-rally] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
