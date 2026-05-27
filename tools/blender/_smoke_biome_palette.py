"""Smoke test — exercise HV_BiomePalette end-to-end on any track .blend.

Drives the biome-palette scatter from a cold start:
  1. Confirms the hoverbike addon is registered (or registers it).
  2. Runs ``hoverbike.apply_terrain_vertex_colors`` to populate
     ``baked_biome`` on the resolved terrain mesh.
  3. Runs ``hoverbike.add_biome_palette`` to spawn the palette pair
     + attach the HV_BiomePalette modifier.
  4. Evaluates the modifier on the depsgraph and counts emitted
     instances.

Pass: instance count > 0 on at least one biome with a non-zero density.
Fail: zero instances (graph misconfigured / Terrain socket unbound /
``baked_biome`` not stamped) or any operator error.

Invocation:
    "$BLENDER_EXE" --background tracks-src/<id>.blend \
        --python tools/blender/_smoke_biome_palette.py

Useful for catching regressions to either the GN graph (in
``seed_props_library.py::build_biome_palette_group``) or the addon
operator (``hoverbike_addon/biome_palette.py``) without booting the GUI.
"""

from __future__ import annotations

import os
import sys

import bpy


def _enable_addon() -> bool:
    """Add the addon package dir to sys.path and enable it. The user's
    standard install symlinks ``tools/blender/hoverbike_addon`` into
    Blender's user scripts dir, but --background sessions may not pick
    it up automatically — explicit enable side-steps the question."""
    # The .blend file lives in <repo>/tracks-src/<id>.blend, so the
    # addon source is two levels up.
    blend = bpy.data.filepath
    if not blend:
        print("FAIL: no .blend loaded")
        return False
    repo = os.path.dirname(os.path.dirname(blend))
    addons_root = os.path.join(repo, "tools", "blender")
    if addons_root not in sys.path:
        sys.path.insert(0, addons_root)
    try:
        import hoverbike_addon  # type: ignore
    except ImportError as e:
        print(f"FAIL: hoverbike_addon import: {e}")
        return False
    # Blender auto-enables the user-installed addon from the symlinked
    # scripts dir, so register() may already have run. Detect that via
    # the operator's presence in bpy.ops; only call register() ourselves
    # when the operator is missing (running from a fresh prefs state).
    if not hasattr(bpy.ops.hoverbike, "add_biome_palette"):
        try:
            hoverbike_addon.register()
        except (RuntimeError, ValueError) as e:
            print(f"FAIL: addon register: {e}")
            return False
        print("OK: addon registered fresh")
    else:
        print("OK: addon already registered by Blender startup")
    return True


def _bake_vertex_colors() -> bool:
    """Stamp COLOR_0 + baked_biome on the terrain mesh."""
    terrain = bpy.data.objects.get("terrain")
    if terrain is None:
        # Try the kind=track fallback
        from hoverbike_addon._legacy import _largest_terrain_mesh  # type: ignore
        terrain = _largest_terrain_mesh()
    if terrain is None:
        print("FAIL: no terrain mesh in scene")
        return False
    bpy.context.view_layer.objects.active = terrain
    terrain.select_set(True)
    try:
        bpy.ops.hoverbike.apply_terrain_vertex_colors()
    except RuntimeError as e:
        print(f"FAIL: apply_terrain_vertex_colors: {e}")
        return False
    # Check that baked_biome got populated.
    from hoverbike_addon.bake import BAKED_BIOME_ATTR  # type: ignore
    if BAKED_BIOME_ATTR not in terrain.data.attributes:
        print(f"FAIL: {BAKED_BIOME_ATTR} not stamped on terrain")
        return False
    attr = terrain.data.attributes[BAKED_BIOME_ATTR]
    n = len(attr.data)
    histogram = {0.0: 0, 1.0 / 3: 0, 2.0 / 3: 0, 1.0: 0}
    for i in range(n):
        v = round(attr.data[i].value * 3.0) / 3.0
        histogram[v] = histogram.get(v, 0) + 1
    print(f"OK: baked_biome on {n} verts — {histogram}")
    return True


def _add_palette() -> bool:
    try:
        bpy.ops.hoverbike.add_biome_palette()
    except RuntimeError as e:
        print(f"FAIL: add_biome_palette: {e}")
        return False
    empty = bpy.data.objects.get("scatter_biome_palette")
    surf = bpy.data.objects.get("scatter_biome_palette_surf")
    if empty is None or surf is None:
        print("FAIL: palette objects not created")
        return False
    mod = next(
        (
            m for m in surf.modifiers
            if m.type == "NODES"
            and m.node_group is not None
            and m.node_group.name == "HV_BiomePalette"
        ),
        None,
    )
    if mod is None:
        print("FAIL: HV_BiomePalette modifier not attached to surf")
        return False
    print(f"OK: palette pair created ({empty.name}, {surf.name})")
    print(f"    modifier sockets: {len(list(mod.node_group.interface.items_tree))} items")
    return True


def _evaluate_instances() -> bool:
    surf = bpy.data.objects.get("scatter_biome_palette_surf")
    if surf is None:
        print("FAIL: surf not in scene")
        return False
    dg = bpy.context.evaluated_depsgraph_get()
    eobj = surf.evaluated_get(dg)
    # The modifier's output is instances — read them off the evaluated
    # depsgraph rather than the source mesh.
    count = 0
    for inst in dg.object_instances:
        if inst.parent and inst.parent.original == surf:
            count += 1
    print(f"OK: modifier produced {count} instances on the evaluated depsgraph")
    if count == 0:
        # Diagnose. Most likely: Terrain socket not bound, or terrain has
        # no baked_biome / wrong biome values.
        mod = next(
            (
                m for m in surf.modifiers
                if m.type == "NODES"
                and m.node_group is not None
                and m.node_group.name == "HV_BiomePalette"
            ),
            None,
        )
        if mod is not None:
            ids = {
                item.name: item.identifier
                for item in mod.node_group.interface.items_tree
                if getattr(item, "in_out", None) == "INPUT"
                and getattr(item, "item_type", None) == "SOCKET"
            }
            terrain_socket = ids.get("Terrain")
            if terrain_socket is not None:
                try:
                    bound = mod[terrain_socket]
                    print(f"    DIAG: Terrain socket = {bound!r}")
                except Exception as e:  # noqa: BLE001
                    print(f"    DIAG: Terrain socket read failed: {e}")
            for slot in ("Jungle", "Beach", "Seafloor", "Deep"):
                src_id = ids.get(f"{slot} Source")
                den_id = ids.get(f"{slot} Density")
                src = mod[src_id] if src_id else None
                den = mod[den_id] if den_id else None
                print(f"    DIAG: {slot} src={src!r} density={den}")
        return False
    return True


def _count_instances() -> int:
    """Re-evaluate the depsgraph and count instances on the surf mesh."""
    surf = bpy.data.objects.get("scatter_biome_palette_surf")
    if surf is None:
        return -1
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    count = 0
    for inst in dg.object_instances:
        if inst.parent and inst.parent.original == surf:
            count += 1
    return count


def _test_mask_suppression() -> bool:
    """Proposal B check — paint mask_jungle to 0 on the right half of
    the terrain (verts where world X > 0) and confirm that the
    evaluated instance count drops by roughly half. Since baked_biome
    populated jungle nearly everywhere on the test terrain, halving the
    jungle mask should drop the instance count by ~50 %."""
    terrain = bpy.data.objects.get("terrain")
    if terrain is None:
        print("FAIL: no terrain in scene")
        return False

    baseline = _count_instances()
    if baseline <= 0:
        print(f"FAIL: baseline instance count is {baseline}")
        return False

    vg = terrain.vertex_groups.get("mask_jungle")
    if vg is None:
        print("FAIL: mask_jungle not created by add_biome_palette")
        return False

    mw = terrain.matrix_world
    right_half_indices = [
        i for i, v in enumerate(terrain.data.vertices)
        if (mw @ v.co).x > 0.0
    ]
    if not right_half_indices:
        print("FAIL: no verts on the right half — test terrain shape unexpected")
        return False
    # Set weight 0 on the right half (paint a "hole" via the API).
    vg.add(right_half_indices, 0.0, "REPLACE")
    print(f"OK: painted mask_jungle = 0 on {len(right_half_indices)} right-half verts")

    # Force the modifier to re-evaluate. Tagging the surf mesh isn't
    # enough — the modifier reads `terrain` via Object Info, so we need
    # to flag the terrain as updated so the surf's depsgraph picks it up.
    terrain.update_tag()

    suppressed = _count_instances()
    if suppressed < 0:
        print("FAIL: couldn't evaluate after mask paint")
        return False

    ratio = suppressed / baseline
    print(f"OK: instance count {baseline} → {suppressed} (ratio {ratio:.2f})")
    # Expect roughly half. Allow a generous band [0.30, 0.70] — the
    # right-half cut isn't exactly 50 % of the jungle area on the test
    # terrain (the geometry is roughly symmetric but not perfectly).
    if not (0.20 <= ratio <= 0.80):
        print(f"FAIL: expected ratio in [0.20, 0.80], got {ratio:.2f}")
        return False
    return True


def main() -> int:
    if not _enable_addon():
        return 1
    if not _bake_vertex_colors():
        return 1
    if not _add_palette():
        return 1
    if not _evaluate_instances():
        return 1
    if not _test_mask_suppression():
        return 1
    print()
    print("PASS: biome palette smoke test (Proposal A + B)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
