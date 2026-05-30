"""Seed tools/blender/lib/prop_kit.blend with placeholder prop geometry.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_prop_kit.py

The kit is *placeholder* geometry — primitive proxies so build_prop.py
has something to append. Replace with hand-sculpted parts later.

**Non-destructive (merge mode).** Re-running OPENS the existing kit and
refreshes only the objects this seed owns (the five parts below),
preserving anything an author added by hand — most importantly the
``buoy`` part seeded by ``seed_buoy_kit_part.py``, which lives in the
same .blend under a name this seed never emits. To keep a hand-edited
version of a *seed* part across re-seeds, freeze it by setting an
``hv_locked`` custom property on that object. The per-owned-name wipe
mirrors ``seed_buoy_kit_part.py``; the merge + lock helpers are shared
via ``seed_merge.py``. A ``.seedbak`` copy is written before every save
(the .blend is Drive-only — no git history). See "Locking a hand-edited
prop" in docs/asset-pipeline-guide.md.

Authoring convention (Blender axes; the yup glTF exporter rotates them):
  Blender +X = right       → three +X (right)
  Blender +Z = up          → three +Y (up)
  Blender -Y = "forward"   → three +Z (forward)

For props the orientation matters less than for bikes (most are
symmetric), but we still author Z-up so kit objects align with the
runtime's gravity axis after export.

Named objects produced (materials prefixed ``mat_kit_prop_*``). Each
part's *mesh data* is authored origin-centred (or bottom-on-floor for
upright shapes); the **object transform** spreads the parts along
+X with bottoms on z=0 so authors can see every variant side-by-side.
The transform is reset on append (see ``lib_loader.append_objects``),
so the layout is purely cosmetic — only mesh edits ride through.

  barrier_a      — short rectangular barrier (low + wide).
  barrier_b      — taller curved barrier suggestion.
  lamppost       — vertical post with a small head.
  crate          — cube crate.
  pylon          — pyramidal cone-shaped pylon.
"""

from __future__ import annotations

import os
import sys

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from tools.blender.seed_merge import (  # noqa: E402
    is_locked_object,
    is_seed_owned,
    open_or_empty,
    purge_orphan_meshes,
    remove_owned_objects_by_name,
    stamp_owned,
    write_seedbak,
)

OUTPUT_PATH = os.path.join(REPO_ROOT, "tools", "blender", "lib", "prop_kit.blend")

# The object names this seed owns. Anything else in the kit (e.g. the
# author-added ``buoy`` from seed_buoy_kit_part.py) is left untouched.
SEED_OBJECTS = ["barrier_a", "barrier_b", "lamppost", "crate", "pylon"]

# Names skipped (locked / author-owned) during the current run, so the
# summary reports a preserved part as preserved rather than refreshed.
_SKIPPED_RUN: set = set()


def reset_scene() -> None:
    """Non-destructive: OPEN the existing kit if present (so author parts
    like ``buoy`` survive into memory), else start from empty. The per-name
    merge in ``main`` then refreshes only the seed-owned, unlocked parts."""
    open_or_empty(OUTPUT_PATH, log="[seed-prop-kit]")


def _claim_object(name: str) -> bool:
    """Merge gate for a seed-owned kit part. Returns ``True`` if the caller
    should (re)build it, ``False`` if an author version must be preserved.

    A locked or author-owned (non-``_seed_owned``) object of this name is
    preserved and recorded in ``_SKIPPED_RUN``; otherwise the seed-owned
    object (and any ``name.NNN`` duplicate) is wiped so the builder can
    recreate it fresh — mirroring ``seed_buoy_kit_part.py``'s per-name
    wipe. Author parts under *other* names are never seen here."""
    existing = bpy.data.objects.get(name)
    if existing is not None and (is_locked_object(existing) or not is_seed_owned(existing)):
        reason = "hv_locked" if is_locked_object(existing) else "author-owned"
        print(f"[seed-prop-kit]   SKIP {name} ({reason}) — preserving hand-authored version")
        _SKIPPED_RUN.add(name)
        return False
    remove_owned_objects_by_name(name)
    return True


def get_or_create_material(
    name: str, color: tuple[float, float, float, float]
) -> bpy.types.Material:
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = color
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = 0.6
    return mat


def add_box(name: str, size: tuple[float, float, float], material: bpy.types.Material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, size[2] * 0.5))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0] * 0.5, size[1] * 0.5, size[2] * 0.5)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
    obj.data.name = name + "_mesh"
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def add_cylinder_z(
    name: str, radius: float, height: float, material: bpy.types.Material
):
    bpy.ops.mesh.primitive_cylinder_add(
        radius=radius, depth=height, vertices=20, location=(0, 0, height * 0.5)
    )
    obj = bpy.context.active_object
    obj.name = name
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    obj.data.name = name + "_mesh"
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def make_barrier_a(material: bpy.types.Material):
    """Low wide barrier — 2m long, 1m tall, 0.4m thick."""
    return add_box("barrier_a", (2.0, 0.4, 1.0), material)


def make_barrier_b(material: bpy.types.Material):
    """Taller barrier — 1.5m long, 1.5m tall, 0.3m thick."""
    return add_box("barrier_b", (1.5, 0.3, 1.5), material)


def make_lamppost(material: bpy.types.Material):
    """Vertical post — 0.2m radius, 4m tall."""
    return add_cylinder_z("lamppost", radius=0.15, height=4.0, material=material)


def make_crate(material: bpy.types.Material):
    """Unit-ish crate."""
    return add_box("crate", (1.0, 1.0, 1.0), material)


def make_pylon(material: bpy.types.Material):
    """Cone-shaped pylon."""
    bpy.ops.mesh.primitive_cone_add(
        radius1=0.6,
        radius2=0.0,
        depth=1.5,
        vertices=12,
        location=(0, 0, 0.75),
    )
    obj = bpy.context.active_object
    obj.name = "pylon"
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    obj.data.name = "pylon_mesh"
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def lay_out_in_row(names: set[str] | list[str] | None = None) -> None:
    """Spread parts along +X so authors can see every variant. Object
    transforms are layout-only; ``lib_loader.append_objects`` resets
    them on append so the build is unaffected.

    Only repositions parts in ``names`` (the parts this run actually
    rebuilt) so a preserved / locked part keeps the position the author
    left it at. Each part keeps its canonical slot for stable spacing."""
    spacing = 3.0
    order = ["barrier_a", "barrier_b", "lamppost", "crate", "pylon"]
    for i, name in enumerate(order):
        if names is not None and name not in names:
            continue
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        obj.location = (i * spacing, 0.0, obj.location.z)


def main() -> None:
    _SKIPPED_RUN.clear()
    print(f"[seed-prop-kit] writing {OUTPUT_PATH}")
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    reset_scene()

    # First-run migration: a kit built before the merge convention has no
    # _seed_owned markers, so back-stamp the seed's own parts (unlocked) —
    # otherwise the merge would mistake them for author content and skip
    # refreshing them. Author parts (other names, e.g. ``buoy``) stay
    # unmarked and are left alone.
    seed_names = set(SEED_OBJECTS)
    _migrated = 0
    for obj in list(bpy.data.objects):
        if obj.name in seed_names and not is_seed_owned(obj) and not is_locked_object(obj):
            stamp_owned(obj)
            _migrated += 1
    if _migrated:
        print(f"[seed-prop-kit] first merge run: back-stamped {_migrated} pre-convention "
              f"part(s) as seed-owned — they will be REFRESHED. Lock (hv_locked) any you "
              f"hand-edited and re-run if you need to keep them.")

    barrier_mat = get_or_create_material("mat_kit_prop_barrier", (0.55, 0.50, 0.45, 1.0))
    metal_mat = get_or_create_material("mat_kit_prop_metal", (0.30, 0.32, 0.34, 1.0))
    crate_mat = get_or_create_material("mat_kit_prop_wood", (0.45, 0.30, 0.18, 1.0))
    pylon_mat = get_or_create_material("mat_kit_prop_pylon", (0.85, 0.45, 0.10, 1.0))

    builders = [
        ("barrier_a", lambda: make_barrier_a(barrier_mat)),
        ("barrier_b", lambda: make_barrier_b(barrier_mat)),
        ("lamppost", lambda: make_lamppost(metal_mat)),
        ("crate", lambda: make_crate(crate_mat)),
        ("pylon", lambda: make_pylon(pylon_mat)),
    ]
    built: list[str] = []
    for name, build in builders:
        if not _claim_object(name):
            continue  # locked / author-owned — preserved, not refreshed
        obj = build()
        stamp_owned(obj)
        built.append(name)

    lay_out_in_row(built)

    # Safety net: back up the on-disk kit before overwriting it (it's
    # gitignored / Drive-only — no git history to recover from), then purge
    # any mesh orphaned by a wiped part.
    write_seedbak(OUTPUT_PATH)
    purge_orphan_meshes()

    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    print(
        f"[seed-prop-kit] done — {len(bpy.data.objects)} objects: "
        f"{', '.join(o.name for o in bpy.data.objects)}"
    )
    if _SKIPPED_RUN:
        print(f"[seed-prop-kit] preserved (locked/author): {', '.join(sorted(_SKIPPED_RUN))}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[seed-prop-kit] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
