"""Hoverbike — in-Blender "Export to Game" addon.

Package layout (mid-refactor — the 8 k-line monolith is being split into
per-domain modules; this is the scaffolding PR with the split not yet
underway):

  hoverbike_addon/
    __init__.py    — bl_info + package register()/unregister(). This
                     is what Blender sees as the addon.
    _legacy.py     — Everything that used to be in
                     hoverbike_addon.py, untouched. Subsequent PRs will
                     carve sibling modules out of this file (one
                     domain at a time: water.py, boost_pad.py, road.py,
                     etc.) until _legacy.py is empty and gets deleted.

Each new sibling module follows the standard Blender-addon-package
pattern: exposes its own ``register()`` and ``unregister()`` so this
file just iterates the modules. Per-module register lets each module
keep its constants, helpers, operators, panels, AND scene properties
co-located.

Install once via ``pnpm install:blender-addon`` (symlinks this
directory into Blender's user scripts dir). After an addon edit,
F3 → "Reload Scripts" picks up the change.
"""

from __future__ import annotations

bl_info = {
    "name": "Hoverbike: Export to Game",
    "author": "Hoverbike",
    "version": (2, 0, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > Hoverbike",
    "description": "One-click export of bikes and tracks from Blender to the running hoverbike game.",
    "category": "Import-Export",
}


# Per-module register/unregister entry points. Modules are listed in
# the order they should register; unregister walks the same list in
# reverse so dependencies tear down cleanly. Each module is a normal
# Python module exposing top-level ``register()`` and ``unregister()``.
#
# During the migration, ``_legacy`` is the catch-all — it still
# contains everything that hasn't been carved out yet. As sibling
# modules are added below, the same code is removed from ``_legacy``,
# and the smoke test catches any drift in the total registered class
# count.
from . import _legacy, boost_pad, water

# Order: domain modules first, _legacy catch-all last. As more modules
# carve out of _legacy the tuple grows; _legacy eventually empties and
# the last carve-out PR drops it from this tuple and deletes the file.
_MODULES = (water, boost_pad, _legacy)


def register() -> None:
    for mod in _MODULES:
        mod.register()


def unregister() -> None:
    for mod in reversed(_MODULES):
        mod.unregister()


if __name__ == "__main__":
    register()
