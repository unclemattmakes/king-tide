"""Append named objects from a kit ``.blend`` file.

Builders pull placeholder geometry (or hand-sculpted parts later) from
``tools/blender/lib/<kit>.blend`` files. This module wraps Blender's
append API with a duplicate-safe per-object call.

The kit files are committed to the repo and treated as source art. The
builders never modify them; they read-only-append into a fresh scene.

### Edit-in-context

Kit objects can be laid out in their assembled positions in the kit
``.blend`` (chassis at the bike's centre, fairing on top, fork at the
nose, etc.) so authors can see parts in context while editing. The
viewport position of an object in the kit is **purely an authoring
convenience** — on append, location/rotation/scale are reset to the
identity so the builder always sees the part in a clean local frame
and positions it programmatically. Edit mesh data, not the object
transform, if you want geometry changes to ride through to the build.
"""

from __future__ import annotations

import os
from typing import Iterable

import bpy


def _reset_transform(obj: bpy.types.Object) -> None:
    """Snap an appended kit object back to the identity transform.

    Authors lay kit parts out in context positions in the .blend so the
    assembled bike/prop is visible while editing. Those positions are
    layout-only — builders position parts themselves, so we strip the
    transform on append. Mesh data is preserved verbatim."""
    obj.location = (0.0, 0.0, 0.0)
    # Cover both rotation modes — Blender keeps both attributes around
    # regardless of the active mode, so always-zero on both is safe.
    obj.rotation_euler = (0.0, 0.0, 0.0)
    obj.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
    obj.scale = (1.0, 1.0, 1.0)


def append_objects(blend_path: str, names: Iterable[str]) -> list[bpy.types.Object]:
    """Append named objects from a .blend file into the current scene.

    Returns the list of imported objects in the same order as ``names``.
    Each appended object's transform is reset to the identity (see
    module docstring re: edit-in-context).

    Raises if any name is missing in the source file.
    """
    if not os.path.exists(blend_path):
        raise FileNotFoundError(f"kit blend not found: {blend_path}")

    out: list[bpy.types.Object] = []
    for name in names:
        # Blender's append API expects the directory inside the .blend
        # ("Object/", "Material/", etc.) and the leaf name. We always
        # append objects.
        before = set(bpy.data.objects.keys())
        bpy.ops.wm.append(
            filepath=os.path.join(blend_path, "Object", name),
            directory=os.path.join(blend_path, "Object") + os.sep,
            filename=name,
            link=False,
            autoselect=False,
            instance_collections=False,
        )
        after = set(bpy.data.objects.keys())
        new_names = after - before
        # Blender renames duplicates with .001 suffix when the name
        # already exists in the scene; pick the freshest one we just
        # imported. If multiple appended (parented hierarchy), prefer
        # the exact-name match.
        if not new_names:
            raise RuntimeError(
                f"append failed: {name!r} not found in {blend_path}"
            )
        chosen = next((n for n in new_names if n == name), None)
        if chosen is None:
            # Pick the longest-named match that starts with the requested name —
            # accommodates Blender's .001 suffix on collision.
            chosen = sorted(new_names)[0]
        obj = bpy.data.objects[chosen]
        _reset_transform(obj)
        out.append(obj)

    return out
