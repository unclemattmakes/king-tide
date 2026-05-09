"""Socket-empty creation and validation.

Sockets are zero-rotation empties named ``socket_<slot>`` with custom
properties ``kind="socket"`` and ``slot=<slot>``. Runtime callers do
``glb.getObjectByName('socket_<slot>')`` to resolve attach points (e.g.
where a rider parents to a bike, where a thruster FX emitter spawns).
"""

from __future__ import annotations

from typing import Iterable

import bpy

from .common import apply_extras


def add_socket(
    name: str,
    parent: bpy.types.Object,
    slot: str,
    location: tuple[float, float, float] = (0.0, 0.0, 0.0),
    rotation_euler: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    """Create a socket empty and parent it.

    The empty is rendered as ARROWS so authors editing kit files in
    Blender can see attach orientation visually.
    """
    bpy.ops.object.empty_add(type="ARROWS", location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rotation_euler
    obj.parent = parent
    apply_extras(obj, kind="socket", slot=slot)
    return obj


def validate_sockets(required_slots: Iterable[str]) -> list[str]:
    """Confirm every required slot is present exactly once."""
    seen: dict[str, int] = {}
    for obj in bpy.data.objects:
        if obj.get("kind") != "socket":
            continue
        slot = obj.get("slot")
        if not isinstance(slot, str):
            continue
        seen[slot] = seen.get(slot, 0) + 1

    errors: list[str] = []
    for slot in required_slots:
        n = seen.get(slot, 0)
        if n == 0:
            errors.append(f"missing socket: slot={slot!r}")
        elif n > 1:
            errors.append(f"duplicate socket: slot={slot!r} (count={n})")
    return errors
