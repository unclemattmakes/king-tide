"""Phase C of make-level-props — batch-condition raw AI meshes to GLBs.

Runs inside Blender headless. Reads a JSON spec (a list of prop entries)
and, for each, imports the raw Hunyuan mesh, runs the shared
``condition_ai_mesh.condition_object`` conditioner (decimate → orient →
recenter → rescale → ``mat_<family>`` → ``COLOR_0`` → collider), and
exports a pipeline-legal ``prop_<id>`` GLB. These GLBs are the committed
(Git LFS), reviewable source of truth for the AI output — eyeball them in
``?viewer=<id>`` before the separate ``integrate`` step locks them into the
library.

This is the orchestrated sibling of ``condition_ai_mesh.main()``: same
conditioner, but it loops over a whole level's approved meshes in one
Blender launch and honours the per-prop ``smooth`` flag (organic meshes
read better smooth — see docs/ai-prop-pipeline.md).

Invoked by tools/make_level_props.py as::

    blender --background --python tools/blender/condition_ai_batch.py \
        -- --spec <run>/_condition_spec.json

Spec entry fields: input, prop_id, family, target_tris, target_height,
collider, tint, smooth, output.
"""

from __future__ import annotations

import json
import os
import sys

import bpy

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(_SCRIPT_DIR))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from tools.blender.common import export_glb, reset_scene  # noqa: E402
from tools.blender.condition_ai_mesh import (  # noqa: E402
    _import_any,
    condition_object,
)


def _spec_path() -> str:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--spec" not in argv:
        raise SystemExit("[condition-batch] missing --spec <path>")
    return argv[argv.index("--spec") + 1]


def main() -> None:
    with open(_spec_path(), "r", encoding="utf-8") as f:
        spec = json.load(f)

    failures = []
    for entry in spec:
        pid = entry["prop_id"]
        try:
            reset_scene()
            obj = _import_any(entry["input"])
            condition_object(
                obj,
                prop_id=pid,
                family=entry.get("family", "prop"),
                target_tris=int(entry.get("target_tris", 2000)),
                target_height=entry.get("target_height"),
                source_up=entry.get("source_up", "Z"),
                collider=entry.get("collider", "box"),
                tint=entry.get("tint"),
                smooth=bool(entry.get("smooth", False)),
            )
            out = entry["output"]
            os.makedirs(os.path.dirname(out), exist_ok=True)
            export_glb(out, single_color0=True)   # one COLOR_0, no stray COLOR_1
            print(f"[condition-batch] ✓ {pid} → {out}")
        except Exception as e:  # noqa: BLE001
            print(f"[condition-batch] ✗ {pid}: {e}", file=sys.stderr)
            failures.append(pid)

    if failures:
        raise SystemExit(f"[condition-batch] FAILED: {', '.join(failures)}")
    print(f"[condition-batch] done — {len(spec)} prop(s) conditioned.")


if __name__ == "__main__":
    main()
