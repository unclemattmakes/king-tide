"""Build ``tracks-src/alpine-sprint.blend`` + GLB/JSON exports.

Run (after ``seed_template_alpine.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_alpine_sprint.py

Reshape: an elongated oval inside the alpine valley with tight
U-turns past the ridge ends. The entire racing line clamps to the
river surface — designed water-only racing. Authoring is driven by
``track_build_lib``.
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
    track_id="alpine-sprint",
    template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-alpine.blend"),
    spline_anchors=[
        (-400.0, +30.0, -2.0),
        (   0.0, +35.0, -2.0),  # slight cross-fade between straights
        ( +400.0, +30.0, -2.0),
        ( +440.0, +15.0, -2.0),  # east U-turn entry
        ( +455.0,   0.0, -2.0),  # east apex
        ( +440.0, -15.0, -2.0),  # east U-turn exit
        ( +400.0, -30.0, -2.0),
        (   0.0, -35.0, -2.0),
        ( -400.0, -30.0, -2.0),
        ( -440.0, -15.0, -2.0),
        ( -455.0,   0.0, -2.0),  # west apex
        ( -440.0, +15.0, -2.0),
    ],
    checkpoint_ts=(0.18, 0.45, 0.70, 0.92),
    # Narrow road for "river canyon trail" feel.
    road_width=11.0,
    road_lift=0.3,
    road_blend_radius=6.0,
    road_samples=128,
    road_smooth_passes=4,
    road_curb_width=0.6,
    road_curb_height=0.15,
    road_curb_stripe=2.0,
    road_thickness=0.55,
    gate_spacing_m=55.0,
    water_preview_size=900.0,
    water_preview_subdivisions=160,
)


if __name__ == "__main__":
    try:
        build_track_from_spec(SPEC)
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-alpine-sprint] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
