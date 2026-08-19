"""Smoke test for the in-app multi-biome terrain operator.

Registers the King Tide addon, runs ``kingtide.add_multibiome_terrain``
in an empty scene, and checks that:

  - the operator returns FINISHED
  - a ``terrain`` mesh carries a NODES modifier whose group is
    ``HV_TemplateTerrain``
  - the wrapper exposes the ``Style`` menu + the ``Additive`` toggle, and
    Additive now defaults to **False**
  - with the default (Additive off) the evaluated Island-style terrain
    keeps its negative seafloor (min Z well below 0)
  - flipping Additive on clamps the displacement to >= 0 (the only-raise
    pass still works)
  - ``find_island_modifier`` recognises the wrapper so mod zones apply

No .blend needed — the operator resolves the seed script relative to the
addon source. Invocation:

    "$BLENDER_EXE" --background \
        --python tools/blender/_smoke_multibiome_terrain.py
"""

from __future__ import annotations

import os
import sys

import bpy

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _fail(msg: str) -> None:
    print(f"FAIL: {msg}", flush=True)
    sys.exit(1)


def _enable_addon() -> None:
    addons_root = os.path.join(REPO_ROOT, "tools", "blender")
    if addons_root not in sys.path:
        sys.path.insert(0, addons_root)
    try:
        import kingtide_addon  # type: ignore  # noqa: F401
    except ImportError as e:
        _fail(f"kingtide_addon import: {e}")
    if not hasattr(bpy.ops.kingtide, "add_multibiome_terrain"):
        try:
            kingtide_addon.register()
        except (RuntimeError, ValueError) as e:
            _fail(f"addon register: {e}")
    if not hasattr(bpy.ops.kingtide, "add_multibiome_terrain"):
        _fail("operator kingtide.add_multibiome_terrain not registered")


def _input_identifier(ng, name: str) -> str | None:
    for item in ng.interface.items_tree:
        if getattr(item, "item_type", None) != "SOCKET":
            continue
        if getattr(item, "in_out", None) != "INPUT":
            continue
        if item.name == name:
            return item.identifier
    return None


def _socket_default(ng, name: str):
    for item in ng.interface.items_tree:
        if getattr(item, "item_type", None) != "SOCKET":
            continue
        if getattr(item, "in_out", None) != "INPUT":
            continue
        if item.name == name:
            return getattr(item, "default_value", None)
    return None


def _eval_min_z(obj) -> float:
    deps = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(deps)
    me = ev.to_mesh()
    try:
        return min(v.co.z for v in me.vertices)
    finally:
        ev.to_mesh_clear()


def main() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)
    _enable_addon()

    res = bpy.ops.kingtide.add_multibiome_terrain()
    if res != {"FINISHED"}:
        _fail(f"operator returned {res}, expected FINISHED")

    terrain = bpy.data.objects.get("terrain")
    if terrain is None:
        _fail("no 'terrain' object after operator")

    mod = next((m for m in terrain.modifiers if m.type == "NODES"), None)
    if mod is None or mod.node_group is None:
        _fail("terrain has no NODES modifier with a node group")
    ng = mod.node_group
    if ng.name != "HV_TemplateTerrain":
        _fail(f"modifier group is {ng.name!r}, expected 'HV_TemplateTerrain'")

    # Interface: Style menu + Additive toggle, Additive defaults False.
    if _input_identifier(ng, "Style") is None:
        _fail("wrapper has no 'Style' input socket")
    add_default = _socket_default(ng, "Additive")
    if add_default is not False:
        _fail(f"Additive default is {add_default!r}, expected False")

    # find_island_modifier must accept the wrapper (mod zones / COLOR_0).
    from kingtide_addon.island_terrain import find_island_modifier  # type: ignore

    if find_island_modifier(terrain) is None:
        _fail("find_island_modifier did not recognise HV_TemplateTerrain")

    # Driver empties for every style should have spawned.
    for expected in ("peak_00_base", "peak_00_top", "ridge_00_a", "oasis_center", "mesa_00"):
        if expected not in bpy.data.objects:
            _fail(f"missing driver empty {expected!r}")

    # Default (Additive off, Style=Island): seafloor stays negative.
    bpy.context.view_layer.update()
    min_z_off = _eval_min_z(terrain)
    if min_z_off > -5.0:
        _fail(f"Additive-off min Z is {min_z_off:.2f}, expected a seafloor well below 0")

    # Flip Additive on → only-raise clamp pulls everything to >= ~0.
    add_id = _input_identifier(ng, "Additive")
    mod[add_id] = True
    terrain.update_tag()
    bpy.context.view_layer.update()
    min_z_on = _eval_min_z(terrain)
    if min_z_on < -0.5:
        _fail(f"Additive-on min Z is {min_z_on:.2f}, expected clamp to >= 0")

    print(
        "PASS: multi-biome terrain spawned; Style menu + Additive(False default) "
        f"present; seafloor min Z {min_z_off:.1f} m (off) -> {min_z_on:.1f} m (on)",
        flush=True,
    )


if __name__ == "__main__":
    main()
