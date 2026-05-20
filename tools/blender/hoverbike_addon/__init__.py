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
from . import (
    _legacy,
    antigrav,
    antigrav_ribbon,
    auto_tag,
    bake,
    boost_pad,
    downtown,
    emitter,
    export,
    ghost_lap,
    handlers,
    horizon,
    menu,
    new_map,
    panel,
    placement_helper,
    previews,
    ramp,
    road,
    sky_preset,
    spline,
    terrain,
    terrain_shader,
    thumbnail,
    track_meta,
    tunnel,
    turn_indicators,
    water,
    wave_zone,
)

# Order: domain modules first, _legacy catch-all last. As more modules
# carve out of _legacy the tuple grows; _legacy eventually empties and
# the last carve-out PR drops it from this tuple and deletes the file.
# spline registers BEFORE placement_helper because placement_helper.py
# lazily imports the spline-sampling helpers.
_MODULES = (
    water,
    wave_zone,
    horizon,
    sky_preset,
    emitter,
    boost_pad,
    antigrav,
    antigrav_ribbon,
    ghost_lap,
    turn_indicators,
    bake,
    ramp,
    spline,
    placement_helper,
    terrain,
    terrain_shader,
    downtown,
    tunnel,
    road,
    previews,
    thumbnail,
    export,
    track_meta,
    new_map,
    handlers,
    # auto_tag runs alongside handlers — both attach depsgraph hooks;
    # order between them doesn't matter, but keeping them adjacent
    # makes the "depsgraph plumbing" section easy to find.
    auto_tag,
    _legacy,
    # panel registers near-last so every operator + scene prop it
    # references already exists in bpy.types when its draw() methods
    # run.
    panel,
    # menu registers absolute-last — its submenu/pie classes call into
    # operators registered by every module above, and its
    # VIEW3D_MT_editor_menus append needs to land after Blender's stock
    # menus are set up so our entry sits at the end of the bar.
    menu,
)


def register() -> None:
    for mod in _MODULES:
        mod.register()


def unregister() -> None:
    for mod in reversed(_MODULES):
        mod.unregister()


# ────────────────────────────────────────────────────────────────────
# Back-compat shim for pre-package-refactor seed scripts.
#
# Before the 2026-05 carve-out, the addon was a single
# ``hoverbike_addon.py`` file and ``seed_template_*.py`` /
# ``track_build_lib.py`` reached in by name to call helpers directly:
# ``addon._rebuild_water_preview(...)``, ``addon._generate_downtown(...)``,
# etc. The carve-out moved those into per-domain submodules — water.py,
# previews.py, downtown.py, etc. The seeds still load the addon via
# ``spec_from_file_location`` and call the legacy names, so without
# these aliases the next seed-script run fails with
# ``AttributeError: '_rebuild_water_preview'``.
#
# Two rules govern this shim:
#   1. Every legacy ``addon._foo`` call site that survives gets a
#      one-line re-export here (or, where the submodule already
#      preserved the underscore, the from-import is enough).
#   2. New seed scripts should call the public submodule API directly
#      (``addon.water.rebuild_water_preview`` etc.) instead of relying
#      on this shim. The aliases stay until every old caller is migrated.
# ────────────────────────────────────────────────────────────────────

from ._legacy import (  # noqa: E402,F401
    _PreviewCollectionsHidden,
    _upsert_manifest_track,
    bake_ai_splines,
    derive_track_json,
    validate_track_scene,
)
from .boost_pad import refresh_boost_pad_gizmos as _refresh_boost_pad_gizmos  # noqa: E402
from .downtown import _generate_downtown  # noqa: E402,F401
from .placement_helper import (  # noqa: E402
    _ensure_placement_helper,
    repose_placement_helper as _repose_placement_helper,
)
from .previews import (  # noqa: E402,F401
    _rebuild_gate_preview,
    _rebuild_racer_preview,
)
from .track_meta import _lint_track  # noqa: E402,F401
from .turn_indicators import rebuild_turn_indicators as _rebuild_turn_indicators  # noqa: E402
from .water import rebuild_water_preview as _rebuild_water_preview  # noqa: E402


if __name__ == "__main__":
    register()
