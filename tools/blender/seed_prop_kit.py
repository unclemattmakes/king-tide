"""Seed tools/blender/lib/prop_kit.blend with placeholder prop geometry.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_prop_kit.py

The kit is *placeholder* geometry — primitive proxies so build_prop.py
has something to append. Replace with hand-sculpted parts later.

Authoring convention (Blender axes; the yup glTF exporter rotates them):
  Blender +X = right       → three +X (right)
  Blender +Z = up          → three +Y (up)
  Blender -Y = "forward"   → three +Z (forward)

For props the orientation matters less than for bikes (most are
symmetric), but we still author Z-up so kit objects align with the
runtime's gravity axis after export.

Named objects produced (all at origin, materials prefixed
``mat_kit_prop_*``):

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
OUTPUT_PATH = os.path.join(REPO_ROOT, "tools", "blender", "lib", "prop_kit.blend")


def reset_scene() -> None:
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.curves,
        bpy.data.lights,
        bpy.data.cameras,
    ):
        for item in list(block):
            try:
                block.remove(item)
            except RuntimeError:
                pass


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


def main() -> None:
    print(f"[seed-prop-kit] writing {OUTPUT_PATH}")
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    reset_scene()

    barrier_mat = get_or_create_material("mat_kit_prop_barrier", (0.55, 0.50, 0.45, 1.0))
    metal_mat = get_or_create_material("mat_kit_prop_metal", (0.30, 0.32, 0.34, 1.0))
    crate_mat = get_or_create_material("mat_kit_prop_wood", (0.45, 0.30, 0.18, 1.0))
    pylon_mat = get_or_create_material("mat_kit_prop_pylon", (0.85, 0.45, 0.10, 1.0))

    make_barrier_a(barrier_mat)
    make_barrier_b(barrier_mat)
    make_lamppost(metal_mat)
    make_crate(crate_mat)
    make_pylon(pylon_mat)

    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    print(
        f"[seed-prop-kit] done — {len(bpy.data.objects)} objects: "
        f"{', '.join(o.name for o in bpy.data.objects)}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[seed-prop-kit] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
