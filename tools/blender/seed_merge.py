"""Shared non-destructive **merge + author-lock** helpers for the
hand-editable seed scripts.

Used by:
  * ``seed_props_library.py``     → ``tracks-src/props-library.blend``
  * ``seed_landmarks_library.py`` → ``tracks-src/landmarks-library.blend``
  * ``seed_prop_kit.py``          → ``tools/blender/lib/prop_kit.blend``

These seeds used to nuke-and-pave their ``.blend`` on every run, destroying
any hand-authored edit (it once cost us a geometry-nodes gate). The
convention here makes a re-seed **merge-based** instead:

  * The seed OPENS the existing ``.blend`` (so author datablocks survive
    into memory) rather than starting from an empty file.
  * Everything the seed creates is stamped ``_seed_owned``. On re-seed the
    seed refreshes only the datablocks it owns.
  * An author freezes an asset by setting ``hv_locked`` on it — on the
    collection, its ``*_root`` empty, or (for object-based kits) the
    object. The seed never regenerates a locked asset.
  * Author-added datablocks — a name the seed never emits, with no
    ``_seed_owned`` marker — are left untouched.
  * A ``.seedbak`` copy is written before every save as a one-deep safety
    net (these ``.blend``\\s are gitignored / Drive-only — there's no git
    history to recover from).

Both markers are authoring-only metadata on ``.blend`` datablocks. The
runtime never reads them — it only looks at known keys (see
``src/engine/asset-kinds.ts``) — so even if the glTF exporter passes them
through as ``extras`` on an exported asset they are inert.

See "Locking a hand-edited prop" in ``docs/asset-pipeline-guide.md``.

Two granularities of the lock/skip check ship here because the libraries
differ in shape: the prop / landmark libraries wrap each asset in a
``prop_<id>`` / ``landmark_<id>`` *collection*, while the prop kit is a
flat set of top-level *objects*. Use :func:`is_locked` for the former and
:func:`is_locked_object` for the latter; the remaining helpers are shared.
"""

from __future__ import annotations

import os
import shutil

import bpy


# Custom-property markers. ``_seed_owned`` is stamped BY THE SEED on every
# datablock it creates; ``hv_locked`` is set BY THE AUTHOR to freeze an
# asset against the next re-seed.
SEED_OWNED = "_seed_owned"
LOCK = "hv_locked"


def is_truthy(v) -> bool:
    """Fail-safe truthiness for the lock prop: any present value counts as
    a lock unless it is an explicit false-y ``0`` / ``''`` / ``'false'``.
    (Fail SAFE — when in doubt, treat as locked; never silently
    overwrite.)"""
    if v is None:
        return False
    if isinstance(v, str):
        return v.strip().lower() not in ("", "0", "false")
    try:
        return bool(v)
    except Exception:
        return True


def is_seed_owned(db) -> bool:
    """True if a datablock carries the seed-owned marker."""
    return is_truthy(db.get(SEED_OWNED))


def is_locked(coll: bpy.types.Collection) -> bool:
    """Locked if the collection OR a child ``*_root`` empty carries
    ``hv_locked``. Use for collection-based libraries (props, landmarks)."""
    if is_truthy(coll.get(LOCK)):
        return True
    for o in coll.objects:
        if o.name.endswith("_root") and is_truthy(o.get(LOCK)):
            return True
    return False


def is_locked_object(obj: bpy.types.Object) -> bool:
    """Locked if the object carries ``hv_locked``. Use for object-based
    kits (the prop kit), where each asset is a top-level object rather
    than a collection."""
    return is_truthy(obj.get(LOCK))


def stamp_owned(db) -> None:
    """Mark a datablock as seed-owned. Best-effort — silently no-ops on
    anything that rejects custom properties."""
    try:
        db[SEED_OWNED] = True
    except Exception:
        pass


def _purge_orphan_mesh(mesh) -> None:
    if isinstance(mesh, bpy.types.Mesh) and mesh.users == 0:
        bpy.data.meshes.remove(mesh)


def remove_object(obj: bpy.types.Object) -> None:
    """Remove a single seed-owned object + its now-orphan mesh. Use for
    object-based kits where assets aren't wrapped in a collection."""
    mesh = obj.data if obj.type == "MESH" else None
    bpy.data.objects.remove(obj, do_unlink=True)
    _purge_orphan_mesh(mesh)


def remove_collection(coll: bpy.types.Collection) -> None:
    """Remove a seed-owned collection + its objects, purging any mesh left
    with no users, so the seed can rebuild it fresh. Same-name recreate is
    safe: links from other ``.blend``\\s re-resolve by name on their next
    open."""
    for obj in list(coll.objects):
        mesh = obj.data if obj.type == "MESH" else None
        bpy.data.objects.remove(obj, do_unlink=True)
        _purge_orphan_mesh(mesh)
    bpy.data.collections.remove(coll)


def remove_owned_objects_by_name(name: str) -> None:
    """Wipe the seed-owned object(s) of this exact ``name`` (plus Blender's
    ``name.NNN`` duplicates) and their orphan meshes, so a builder can
    recreate the part fresh. Mirrors ``seed_buoy_kit_part.py``'s per-name
    wipe, but — true to its name — skips any matched object an author
    locked or that the seed doesn't own, so a hand-made or hand-locked
    ``name.NNN`` sibling is never collateral damage. The caller gates the
    canonical name first; the first-run back-stamp marks pre-convention
    seed parts owned before this runs, so they are still swept."""
    for obj in list(bpy.data.objects):
        matches = obj.name == name or obj.name.startswith(name + ".")
        if matches and is_seed_owned(obj) and not is_locked_object(obj):
            remove_object(obj)


def open_or_empty(output_path: str, *, log: str = "[seed]") -> None:
    """Non-destructive scene reset: OPEN the existing ``.blend`` if present
    (so author datablocks survive into memory), else start from an empty
    file. The per-asset merge then refreshes only the seed-owned, unlocked
    assets."""
    if os.path.isfile(output_path):
        print(f"{log} opening existing library (merge mode) → {output_path}")
        bpy.ops.wm.open_mainfile(filepath=output_path)
    else:
        print(f"{log} no existing library — building from empty")
        bpy.ops.wm.read_homefile(use_empty=True)


def write_seedbak(output_path: str) -> None:
    """Back up the on-disk ``.blend`` before overwriting it (it's
    gitignored / Drive-only — no git history to recover from). One-deep."""
    if os.path.isfile(output_path):
        shutil.copy2(output_path, output_path + ".seedbak")


def purge_orphan_meshes() -> None:
    """Remove meshes left with no users — e.g. a freshly-built mesh for an
    asset that turned out to be locked and was never linked."""
    for m in list(bpy.data.meshes):
        if m.users == 0:
            bpy.data.meshes.remove(m)
