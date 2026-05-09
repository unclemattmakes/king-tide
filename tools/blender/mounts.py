"""Build-time **mount** and **anchor** empties.

Distinct from runtime ``socket_*`` empties (see ``sockets.py``):

- **Sockets** ride into the GLB. The runtime resolves them by name to
  attach the rider, place the chase camera, spawn FX emitters, etc.
- **Mounts** and **anchors** are *build-time only*. They tell the kit
  assembler "fairing attaches HERE on the chassis", "this point on the
  fairing snaps to the chassis mount." They are stripped from the
  scene before export — the GLB never sees them.

### Convention

- ``mount_<role>`` — empty parented to a kit "parent" part (chassis_base
  has ``mount_fairing``, ``mount_fork``, etc.). Marks an attachment
  point in parent-local space. The world position is parent-scale-aware:
  if you scale the chassis at build time, mounts scale with it.

- ``anchor`` — empty parented to a kit "child" part (a fairing has a
  child empty named ``anchor`` if it wants to snap by something other
  than its origin). Optional — if a part has no ``anchor`` child, the
  part's origin is used as the anchor.

The naming choice avoids collision with ``socket_*`` (runtime) so a
single ``strip_build_helpers()`` call can prune mounts/anchors without
touching sockets.
"""

from __future__ import annotations

import bpy
from mathutils import Vector

MOUNT_PREFIX = "mount_"
ANCHOR_NAME = "anchor"


def add_mount(
    parent: bpy.types.Object,
    role: str,
    location: tuple[float, float, float],
) -> bpy.types.Object:
    """Create a ``mount_<role>`` empty parented to ``parent`` at the
    given parent-local location. Used by seed scripts to author the kit.

    The empty is a small Plain Axes gizmo so authors can see it in the
    viewport but it doesn't dominate the silhouette.
    """
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0.0, 0.0, 0.0))
    e = bpy.context.active_object
    e.name = f"{MOUNT_PREFIX}{role}"
    e.empty_display_size = 0.08
    e.parent = parent
    # Make matrix_parent_inverse identity so e.location is purely
    # parent-local. (Default Blender parenting bakes the world position
    # into matrix_parent_inverse, which we don't want here.)
    e.matrix_parent_inverse.identity()
    e.location = location
    return e


def _find_child(parent: bpy.types.Object, predicate) -> bpy.types.Object | None:
    for c in parent.children:
        if predicate(c):
            return c
    return None


def _find_mount(parent: bpy.types.Object, role: str) -> bpy.types.Object | None:
    expected = f"{MOUNT_PREFIX}{role}"
    # Tolerate Blender's ``.001`` collision suffix from previous appends.
    return _find_child(
        parent, lambda c: c.name == expected or c.name.startswith(expected + ".")
    )


def _find_anchor(part: bpy.types.Object) -> bpy.types.Object | None:
    return _find_child(
        part, lambda c: c.name == ANCHOR_NAME or c.name.startswith(ANCHOR_NAME + ".")
    )


def snap_to_mount(
    part: bpy.types.Object, parent: bpy.types.Object, role: str
) -> None:
    """Position ``part`` so its ``anchor`` child sits at ``parent``'s
    ``mount_<role>`` world position.

    Caller is expected to have already set ``part.scale`` to whatever
    the build needs (e.g. fairings scale to chassis footprint). This
    helper only writes ``part.location``.

    Assumes ``part.rotation`` is identity. If the kit needs oriented
    attachment later (e.g. a fork that pitches relative to a tilted
    chassis), extend this to read mount rotation.

    If the part has no ``anchor`` child, the part's origin is used.
    """
    mount = _find_mount(parent, role)
    if mount is None:
        raise RuntimeError(
            f"snap_to_mount: parent {parent.name!r} has no mount_{role!r} child"
        )

    # Force a depsgraph update so ``mount.matrix_world`` reflects any
    # transform changes the caller just made on ``parent``. Blender
    # batches matrix_world recomputation lazily; without this flush the
    # mount would still report its pre-update world position.
    bpy.context.view_layer.update()

    target = mount.matrix_world.translation
    anchor = _find_anchor(part)
    if anchor is None:
        part.location = (target.x, target.y, target.z)
        return

    # Anchor world position (assuming identity rotation on the part) is
    # ``part.location + part.scale * anchor_local``. Solve for location.
    al = anchor.matrix_local.translation
    s = part.scale
    part.location = (
        target.x - s.x * al.x,
        target.y - s.y * al.y,
        target.z - s.z * al.z,
    )


def strip_build_helpers() -> None:
    """Delete every ``mount_*`` and ``anchor*`` empty in the scene.

    Called once before export so the GLB doesn't ship build-time helper
    nodes. Runtime ``socket_*`` empties are NOT touched (different
    prefix) — they stay and ride into the export.
    """
    to_remove: list[bpy.types.Object] = []
    for obj in bpy.data.objects:
        name = obj.name
        if name.startswith(MOUNT_PREFIX) or name == ANCHOR_NAME or name.startswith(ANCHOR_NAME + "."):
            to_remove.append(obj)
    for obj in to_remove:
        bpy.data.objects.remove(obj, do_unlink=True)
