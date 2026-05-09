"""Collider helpers — primitive boxes/capsules/cylinders/spheres.

The runtime reads ``extras.shape`` and ``extras.half_extents | radius |
height`` directly off these objects rather than reading mesh data, so
the visible Blender geometry on a collider empty is purely cosmetic
(authors see the bounding shape in viewport).

Convex-hull and trimesh colliders use a real mesh — ``shape="convex"``
or implicitly via the existing track-mesh ``kind="track"`` path.
"""

from __future__ import annotations

import bpy

from .common import apply_extras


def add_box_collider(
    name: str,
    parent: bpy.types.Object | None,
    location: tuple[float, float, float],
    half_extents: tuple[float, float, float],
) -> bpy.types.Object:
    """Box primitive collider. ``half_extents`` is per-axis half-size."""
    bpy.ops.object.empty_add(type="CUBE", location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = half_extents
    if parent is not None:
        obj.parent = parent
    apply_extras(
        obj,
        kind="collider",
        shape="box",
        half_extents=list(half_extents),
    )
    return obj


def add_capsule_collider(
    name: str,
    parent: bpy.types.Object | None,
    location: tuple[float, float, float],
    radius: float,
    height: float,
) -> bpy.types.Object:
    """Capsule. ``height`` is the cylinder portion (excluding hemispheres)."""
    bpy.ops.object.empty_add(type="SPHERE", location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (radius, radius, height * 0.5 + radius)
    if parent is not None:
        obj.parent = parent
    apply_extras(
        obj,
        kind="collider",
        shape="capsule",
        radius=float(radius),
        height=float(height),
    )
    return obj


def add_cylinder_collider(
    name: str,
    parent: bpy.types.Object | None,
    location: tuple[float, float, float],
    radius: float,
    height: float,
) -> bpy.types.Object:
    bpy.ops.object.empty_add(type="CIRCLE", location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (radius, radius, height * 0.5)
    if parent is not None:
        obj.parent = parent
    apply_extras(
        obj,
        kind="collider",
        shape="cylinder",
        radius=float(radius),
        height=float(height),
    )
    return obj


def add_sphere_collider(
    name: str,
    parent: bpy.types.Object | None,
    location: tuple[float, float, float],
    radius: float,
) -> bpy.types.Object:
    bpy.ops.object.empty_add(type="SPHERE", location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (radius, radius, radius)
    if parent is not None:
        obj.parent = parent
    apply_extras(obj, kind="collider", shape="sphere", radius=float(radius))
    return obj
