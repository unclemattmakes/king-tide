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


def _is_build_helper(name: str) -> bool:
    """``mount_*`` and ``anchor*`` empties carry build-time positioning
    data (see ``mounts.py``). Their transforms are the *payload* the
    builder reads — never reset them on append."""
    return (
        name.startswith("mount_")
        or name == "anchor"
        or name.startswith("anchor.")
    )


def _reset_transform(obj: bpy.types.Object) -> None:
    """Snap an appended kit object back to the identity transform.

    Authors lay kit parts out in context positions in the .blend so the
    assembled bike/prop is visible while editing. Those positions are
    layout-only — builders position parts themselves, so we strip the
    transform on append. Mesh data is preserved verbatim.

    Build-time helpers (``mount_*``, ``anchor*``) are skipped — their
    transforms are exactly the data the builder needs to read."""
    if _is_build_helper(obj.name):
        return
    obj.location = (0.0, 0.0, 0.0)
    # Cover both rotation modes — Blender keeps both attributes around
    # regardless of the active mode, so always-zero on both is safe.
    obj.rotation_euler = (0.0, 0.0, 0.0)
    obj.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
    obj.scale = (1.0, 1.0, 1.0)


def append_objects(blend_path: str, names: Iterable[str]) -> list[bpy.types.Object]:
    """Append named objects from a .blend file into the current scene.

    Returns the list of imported objects in the same order as ``names``.
    Each requested object's transform is reset to the identity (see
    module docstring re: edit-in-context); ``mount_*``/``anchor*``
    helpers are exempt — their kit transforms are the data the builder
    reads.

    Uses ``bpy.data.libraries.load`` rather than ``bpy.ops.wm.append``:
    a single library-load preserves parent relationships across the
    loaded set, while ``wm.append`` runs once per name and brings a
    fresh duplicate of every parent it depends on. With a single load,
    requesting ``chassis_base`` plus four ``mount_*`` empties yields
    one chassis with four child mounts — exactly what the kit author
    laid out.

    Raises if any requested name is missing in the source file.
    """
    if not os.path.exists(blend_path):
        raise FileNotFoundError(f"kit blend not found: {blend_path}")

    requested = list(names)

    pre_existing = set(bpy.data.objects.keys())
    with bpy.data.libraries.load(blend_path, link=False) as (data_from, data_to):
        missing = [n for n in requested if n not in data_from.objects]
        if missing:
            raise RuntimeError(
                f"append failed: {missing!r} not found in {blend_path}"
            )
        # NB: pass a *fresh copy*. After the with-block exits Blender
        # replaces the list contents with the loaded Object instances,
        # which would corrupt our `requested` name list if shared.
        data_to.objects = list(requested)

    # libraries.load creates the datablocks but doesn't link them into a
    # scene collection. Walk every newly-created object and link it.
    scene_collection = bpy.context.scene.collection
    new_object_names = [
        n for n in bpy.data.objects.keys() if n not in pre_existing
    ]
    for n in new_object_names:
        obj = bpy.data.objects[n]
        # Could already be linked if Blender chose to do so; skip duplicates.
        try:
            scene_collection.objects.link(obj)
        except RuntimeError:
            pass

    # libraries.load follows parent → child links to keep the loaded
    # set self-consistent — so when we ask for ``fairing_swept`` (kit-
    # parented to ``mount_fairing`` to drive the in-Blender preview),
    # Blender also pulls in fresh ``mount_fairing.NNN`` and
    # ``chassis_base.NNN`` copies. The build doesn't need that chain;
    # it positions parts via ``snap_to_mount`` against the chassis it
    # appended separately. Unparent the requested object from any
    # transitive dep, then sweep dep dupes out of the scene so they
    # don't leak into the GLB.
    requested_set = set(requested)
    for r_name in requested_set:
        r_obj = bpy.data.objects.get(r_name)
        if r_obj is None:
            continue
        if r_obj.parent is not None and r_obj.parent.name not in requested_set:
            r_obj.parent = None
    for n in list(new_object_names):
        if n in requested_set:
            continue
        # Not requested — a transitive dep that snuck in. Drop it.
        # Use ``do_unlink=True`` so any remaining scene collection
        # references release before removal.
        obj = bpy.data.objects.get(n)
        if obj is not None:
            bpy.data.objects.remove(obj, do_unlink=True)
    # Refresh the new-names list to only the survivors so the
    # downstream loop doesn't try to dereference a removed object.
    new_object_names = [n for n in new_object_names if n in requested_set]

    out: list[bpy.types.Object] = []
    for name in requested:
        obj = bpy.data.objects.get(name)
        if obj is None or obj.name in pre_existing:
            # Either missing (shouldn't happen — checked above) or the
            # scene already had this name. ``libraries.load`` renames
            # collisions with ``.NNN``; pick the freshest one.
            candidates = sorted(
                n for n in new_object_names if n.split(".")[0] == name
            )
            if not candidates:
                raise RuntimeError(
                    f"append failed: {name!r} not present after load"
                )
            obj = bpy.data.objects[candidates[-1]]
        _reset_transform(obj)
        out.append(obj)

    return out
