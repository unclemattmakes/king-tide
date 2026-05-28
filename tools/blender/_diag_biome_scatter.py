"""Diagnose the biome-palette scatter pipeline end-to-end.

Walks: scatter_biome_palette objects exist? Modifier attached? Source
sockets bound to which collections? Are those collections linked or
appended? Does the modifier produce instance output? Are the
instance archetypes actually visible / valid meshes?

Invocation:
    "$BLENDER_EXE" --background tracks-src/<id>.blend \
        --python tools/blender/_diag_biome_scatter.py
"""

from __future__ import annotations

import sys

import bpy


def main() -> int:
    print("=" * 60)
    print("Biome-palette scatter diagnostic")
    print("=" * 60)
    blend = bpy.data.filepath
    print(f"blend file: {blend}")
    print()

    # 1. Palette objects exist?
    empty = bpy.data.objects.get("scatter_biome_palette")
    surf = bpy.data.objects.get("scatter_biome_palette_surf")
    print(f"scatter_biome_palette (empty): {'YES' if empty else 'MISSING'}")
    print(f"scatter_biome_palette_surf (mesh): {'YES' if surf else 'MISSING'}")
    if empty is None or surf is None:
        print("FAIL: palette objects not in scene — click Add Biome Palette Scatter")
        return 1

    # 2. Modifier?
    mod = next(
        (
            m for m in surf.modifiers
            if m.type == "NODES"
            and getattr(m, "node_group", None) is not None
            and m.node_group.name == "HV_BiomePalette"
        ),
        None,
    )
    print(f"HV_BiomePalette modifier on surf: {'YES' if mod else 'MISSING'}")
    if mod is None:
        print("FAIL: surf has no HV_BiomePalette modifier")
        return 1

    # 3. Socket inspection — Terrain + per-biome Source + Density
    group = mod.node_group
    ids = {
        item.name: item.identifier
        for item in group.interface.items_tree
        if getattr(item, "in_out", None) == "INPUT"
        and getattr(item, "item_type", None) == "SOCKET"
    }
    print()
    print("Modifier sockets:")
    for socket_name in ("Terrain",):
        ident = ids.get(socket_name)
        if ident is None:
            print(f"  {socket_name}: <socket missing from group>")
            continue
        try:
            val = mod[ident]
        except (KeyError, RuntimeError):
            val = "<read failed>"
        print(f"  {socket_name}: {val!r}")

    biome_status: list[tuple[str, bool, float]] = []
    for biome in ("Deep", "Seafloor", "Beach", "Jungle"):
        src_ident = ids.get(f"{biome} Source")
        den_ident = ids.get(f"{biome} Density")
        src = None
        den = None
        if src_ident is not None:
            try:
                src = mod[src_ident]
            except (KeyError, RuntimeError):
                pass
        if den_ident is not None:
            try:
                den = mod[den_ident]
            except (KeyError, RuntimeError):
                pass
        present = src is not None
        biome_status.append((biome, present, float(den) if den else 0.0))
        src_label = (
            f"{src.name!r} ({len(src.objects)} children)"
            if isinstance(src, bpy.types.Collection)
            else f"NONE"
        )
        print(f"  {biome} Source: {src_label}  Density: {den}")

    # 4. Linked vs appended source collections
    print()
    print("Source-collection storage:")
    for biome, present, _ in biome_status:
        if not present:
            continue
        src_ident = ids.get(f"{biome} Source")
        src = mod[src_ident]
        lib_path = src.library.filepath if src.library else "<local — appended>"
        n_objs = len(src.objects)
        n_children = len(src.children)
        print(f"  {biome} → {src.name!r}: lib={lib_path}, objs={n_objs}, child_colls={n_children}")
        if n_objs == 0 and n_children == 0:
            print(f"      WARN: collection has no contents — Instance on Points will spawn nothing")
        for obj in src.objects[:3]:
            print(f"      └─ {obj.name!r} (type={obj.type})")
        for child in src.children[:3]:
            print(f"      └─ collection: {child.name!r} ({len(child.objects)} objs)")

    # 5. Evaluate the modifier — count instances by archetype.
    print()
    print("Evaluated instance output:")
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    archetype_counts: dict[str, int] = {}
    total = 0
    for inst in dg.object_instances:
        if not (inst.parent and inst.parent.original == surf):
            continue
        archetype = inst.object.name if inst.object else "<no object>"
        archetype_counts[archetype] = archetype_counts.get(archetype, 0) + 1
        total += 1
    print(f"  Total instances from surf: {total}")
    for arch, n in sorted(archetype_counts.items(), key=lambda kv: -kv[1])[:10]:
        print(f"    {n:>5} × {arch!r}")
    if total == 0:
        print("  FAIL: zero instances produced")
        return 1

    # 6. Check that the instanced objects actually have geometry.
    print()
    print("Instance archetype geometry sanity:")
    seen_archetypes: set[str] = set()
    for inst in dg.object_instances:
        if not (inst.parent and inst.parent.original == surf):
            continue
        obj = inst.object
        if obj is None or obj.name in seen_archetypes:
            continue
        seen_archetypes.add(obj.name)
        if len(seen_archetypes) > 4:
            break
        if obj.type != "MESH":
            print(f"  {obj.name!r}: type={obj.type} — not a mesh, may not render")
            continue
        me = obj.data
        n_verts = len(me.vertices)
        n_polys = len(me.polygons)
        n_mats = len(me.materials)
        print(f"  {obj.name!r}: verts={n_verts}, polys={n_polys}, materials={n_mats}")
        for slot in me.materials:
            if slot is None:
                print(f"      WARN: material slot is None — could render as default grey")
            else:
                print(f"      mat: {slot.name!r}")

    # 7. Scene-collection linkage of source collections (so the Outliner
    #    shows them and the user can see what's being scattered).
    print()
    print("Source collections linked into the scene tree?")
    scene_colls: set[str] = set()
    def _walk(c):
        scene_colls.add(c.name)
        for child in c.children:
            _walk(child)
    _walk(bpy.context.scene.collection)
    for biome, present, _ in biome_status:
        if not present:
            continue
        src = mod[ids[f"{biome} Source"]]
        in_scene = src.name in scene_colls
        print(
            f"  {biome} → {src.name!r}: "
            f"{'in scene Outliner' if in_scene else 'NOT in scene Outliner (linked only via modifier)'}"
        )

    print()
    print(f"OK: {total} instances generated across {len(archetype_counts)} archetype(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
