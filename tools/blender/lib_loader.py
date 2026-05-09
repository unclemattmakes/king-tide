"""Append named objects from a kit ``.blend`` file.

Builders pull placeholder geometry (or hand-sculpted parts later) from
``tools/blender/lib/<kit>.blend`` files. This module wraps Blender's
append API with a duplicate-safe per-object call.

The kit files are committed to the repo and treated as source art. The
builders never modify them; they read-only-append into a fresh scene.
"""

from __future__ import annotations

import os
from typing import Iterable

import bpy


def append_objects(blend_path: str, names: Iterable[str]) -> list[bpy.types.Object]:
    """Append named objects from a .blend file into the current scene.

    Returns the list of imported objects in the same order as ``names``.
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
        out.append(bpy.data.objects[chosen])

    return out
