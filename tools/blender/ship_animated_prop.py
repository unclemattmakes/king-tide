"""Ship a rigged / skeletally-animated GLB as a pipeline-legal *animated* prop.

The CC0 keep_material conditioner (``condition_ai_mesh`` /
``condition_ai_batch``) is built for **static** meshes — it decimates,
recenters the origin to bottom-centre, rescales, and bakes a primitive
collider. Every one of those steps destroys an armature's skin weights / bind
pose (the shipped ``clownfish`` came out with 0 skins / 0 animations). Rigged
library props — the Quaternius **Animated Fish Pack** (Shark, Whale, Fish1-3,
Dolphin, Manta ray), each carrying an armature skin + a ``Swim`` clip — need a
**skinning-preserving** lane instead.

This lane is deliberately minimal: it keeps the armature + skin + animation
clip exactly as authored and only

  1. renames the primary material to ``mat_<family>_<id>`` and repairs any
     degenerate alpha (the keep_material convention — multi-tone round-trips),
  2. stamps a **neutral white** ``COLOR_0`` so the attribute is present without
     tinting the preserved material (same reason as the static keep_material
     lane — the runtime multiplies albedo by COLOR_0),
  3. wraps the rig under a ``prop_<id>_root`` empty (``kind=prop``) the runtime
     prop-loader recognises,
  4. exports GLB with **skins + animations ON**.

No decimate, no recenter, no rescale (placement scale is the JSON ``size``
field), no collider — animated props are render-only decoration. The runtime
side that drives them is ``src/engine/render/animated-props.ts`` (a
``THREE.AnimationMixer`` per placement).

Run (batch, like condition_ai_batch)::

    blender --background --python tools/blender/ship_animated_prop.py \\
        -- --spec <path-to-spec>.json

Spec = a JSON list of ``{input, prop_id, output, family?, clip_name?}``.
``input`` is the source rigged GLB; ``output`` the repo-relative
``public/assets/props/cc0/<id>.glb``. Or run a single asset via env vars
(KINGTIDE_INPUT / KINGTIDE_PROP_ID / KINGTIDE_OUTPUT [/ KINGTIDE_FAMILY /
KINGTIDE_CLIP_NAME]).
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
    _preserve_material,
    _stamp_color0,
)
from tools.blender.kingtide_kinds import ExportedKind  # noqa: E402


def _import_gltf(path: str) -> list[bpy.types.Object]:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def ship_animated_prop(
    input_path: str,
    prop_id: str,
    output_path: str,
    *,
    family: str = "fauna",
    clip_name: str = "Swim",
) -> None:
    reset_scene()
    # reset_scene() purges meshes/materials/armatures/etc. but NOT actions, so
    # in a batch the previous asset's clip leaks into this one — the glTF
    # exporter emits every orphan action as a stray animation, and the runtime
    # defaults to clip[0] (which would then be the wrong fish). Clear them.
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    imported = _import_gltf(input_path)
    meshes = [o for o in imported if o.type == "MESH"]
    armatures = [o for o in imported if o.type == "ARMATURE"]
    if not meshes:
        raise ValueError(f"{input_path}: no mesh imported")
    if not armatures:
        raise ValueError(
            f"{input_path}: no armature imported — this is the *animated* lane; "
            f"use condition_ai_batch (keep_material) for static props."
        )
    # Parentless imported objects (typically just the Armature, with the mesh as
    # its child). Reparent these under the prop_root so the rig moves as one.
    roots = [o for o in imported if o.parent is None]

    # Rename the single imported action to a clean clip name so the exported
    # glTF animation is named predictably (Blender imports it as
    # "Armature|Armature|Swim"). The runtime defaults to clip[0] when the JSON
    # omits a clip, so this is for legibility, not correctness.
    actions = list(bpy.data.actions)
    if len(actions) == 1 and clip_name:
        actions[0].name = clip_name
    # Ensure each armature has its action assigned so the exporter emits it.
    for arm in armatures:
        if arm.animation_data is None:
            arm.animation_data_create()
        if arm.animation_data.action is None and actions:
            arm.animation_data.action = actions[0]

    # keep_material (rename primary + repair alpha) + neutral COLOR_0. These
    # touch only materials + the color attribute — skin weights (vertex groups)
    # and the armature modifier are left intact.
    for m in meshes:
        _preserve_material(m, prop_id, family)
        _stamp_color0(m, foliage=False, neutral_albedo=True)

    # Wrap the rig under a prop_root the loader recognises (kind=prop).
    root = bpy.data.objects.new(f"prop_{prop_id}_root", None)
    root.empty_display_type = "PLAIN_AXES"
    root["kind"] = ExportedKind.PROP
    root["prop_id"] = prop_id
    root["category"] = family
    root["animated"] = True
    bpy.context.scene.collection.objects.link(root)
    for o in roots:
        o.parent = root  # root is at origin/identity → world transform preserved

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    export_glb(
        output_path,
        export_animations=True,
        export_skins=True,
        single_color0=True,
    )
    clips = [a.name for a in bpy.data.actions]
    print(
        f"[ship-animated] {prop_id}: meshes={len(meshes)} armatures={len(armatures)} "
        f"clips={clips} → {output_path}"
    )


def _spec_path() -> str | None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--spec" in argv:
        return argv[argv.index("--spec") + 1]
    return None


def main() -> None:
    spec_path = _spec_path()
    if spec_path:
        with open(spec_path, "r", encoding="utf-8") as f:
            spec = json.load(f)
        failures = []
        for entry in spec:
            pid = entry["prop_id"]
            try:
                out = entry["output"]
                if not os.path.isabs(out):
                    out = os.path.join(_REPO_ROOT, out)
                ship_animated_prop(
                    entry["input"],
                    pid,
                    out,
                    family=entry.get("family", "fauna"),
                    clip_name=entry.get("clip_name", "Swim"),
                )
            except Exception as e:  # noqa: BLE001
                print(f"[ship-animated] ✗ {pid}: {e}", file=sys.stderr)
                failures.append(pid)
        if failures:
            raise SystemExit(f"[ship-animated] FAILED: {', '.join(failures)}")
        print(f"[ship-animated] done — {len(spec)} prop(s) shipped.")
        return

    # Single-asset env path.
    inp = os.environ["KINGTIDE_INPUT"]
    prop_id = os.environ["KINGTIDE_PROP_ID"]
    out = os.environ["KINGTIDE_OUTPUT"]
    if not os.path.isabs(out):
        out = os.path.join(_REPO_ROOT, out)
    ship_animated_prop(
        inp,
        prop_id,
        out,
        family=os.environ.get("KINGTIDE_FAMILY", "fauna"),
        clip_name=os.environ.get("KINGTIDE_CLIP_NAME", "Swim"),
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"[ship-animated] FAILED: {e}", file=sys.stderr)
        raise
