"""Seed tools/blender/lib/bike_parts.blend with placeholder kit geometry.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_bike_kit.py

The kit is *placeholder* geometry — primitive proxies so build_bike.py
has something to append. Replace with hand-sculpted parts later.

Authoring convention (matters because the builder relies on it):

  Blender +X = right (= three +X)
  Blender +Y = bike "tail" direction. The yup glTF exporter maps
              Blender +Y to glTF -Z. Runtime convention is "+Z is
              forward" (see docs/status.md), so the builder places the
              bike NOSE at Blender -Y (tail at +Y) — exported nose
              ends up at three +Z. Inside *this kit* we don't pick a
              forward; objects are centered along Y and the builder
              positions instances.
  Blender +Z = up. Maps to three +Y (up).

Named objects produced (all at origin, all materials prefixed
``mat_kit_bike_*`` so the renamer in build_bike.py can find them):

  chassis_base       — 1x1x1 cube; builder scales per spec.
  fairing_bare       — minimal flat fairing (low + thin).
  fairing_swept      — wedge with the front edge tilted down.
  fairing_full       — bulkier box that wraps more of the chassis.
  thruster_unit      — short cylinder along Blender +Y (bike-length).
  fork_single        — single vertical column.
  fork_dual          — two parallel vertical columns (joined mesh).
"""

from __future__ import annotations

import os
import sys

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
OUTPUT_PATH = os.path.join(REPO_ROOT, "tools", "blender", "lib", "bike_parts.blend")


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
            bsdf.inputs["Roughness"].default_value = 0.5
    return mat


def add_box(
    name: str, size: tuple[float, float, float], material: bpy.types.Material
) -> bpy.types.Object:
    """Box centered at origin. ``size`` is full dimensions along (X, Y, Z) Blender."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0] * 0.5, size[1] * 0.5, size[2] * 0.5)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.name = name + "_mesh"
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def add_cylinder(
    name: str,
    radius: float,
    depth: float,
    axis: str,
    material: bpy.types.Material,
) -> bpy.types.Object:
    """Cylinder centered at origin. ``axis`` rotates the default-Z cylinder
    so its long dimension lies on the named Blender axis."""
    bpy.ops.mesh.primitive_cylinder_add(
        radius=radius, depth=depth, vertices=16, location=(0, 0, 0)
    )
    obj = bpy.context.active_object
    obj.name = name
    if axis == "Y":
        obj.rotation_euler = (1.5707963, 0.0, 0.0)
    elif axis == "X":
        obj.rotation_euler = (0.0, 1.5707963, 0.0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    obj.data.name = name + "_mesh"
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def make_chassis_base(material: bpy.types.Material) -> bpy.types.Object:
    """Unit cube — builder scales by spec.chassisWidth/Length/Height."""
    return add_box("chassis_base", (1.0, 1.0, 1.0), material)


def make_fairing_bare(material: bpy.types.Material) -> bpy.types.Object:
    """Thin low fairing: full chassis width, full length, low Z."""
    return add_box("fairing_bare", (1.0, 1.0, 0.3), material)


def make_fairing_swept(material: bpy.types.Material) -> bpy.types.Object:
    """Mid-tall fairing with the front edge tilted down.

    The bike's nose is at Blender -Y; lowering the top vertices on the
    -Y side gives a swept-back canopy silhouette."""
    obj = add_box("fairing_swept", (1.0, 1.0, 0.6), material)
    mesh = obj.data
    for v in mesh.vertices:
        if v.co.z > 0 and v.co.y < 0:
            v.co.z -= 0.25
    return obj


def make_fairing_full(material: bpy.types.Material) -> bpy.types.Object:
    """Taller, fuller fairing that wraps the chassis."""
    return add_box("fairing_full", (1.0, 1.0, 0.9), material)


def make_thruster_unit(material: bpy.types.Material) -> bpy.types.Object:
    """Single thruster nozzle — short cylinder along Blender +Y so its
    long axis sits in the bike-length direction. Builder places one
    per `spec.thrusterCount` at the tail."""
    return add_cylinder(
        "thruster_unit", radius=0.14, depth=0.5, axis="Y", material=material
    )


def make_fork_single(material: bpy.types.Material) -> bpy.types.Object:
    """Single vertical column (Z up). Builder positions at the chassis nose."""
    return add_box("fork_single", (0.1, 0.1, 0.6), material)


def make_fork_dual(material: bpy.types.Material) -> bpy.types.Object:
    """Two parallel vertical columns (Z up). Joined into one mesh."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0.18, 0.0, 0.0))
    a = bpy.context.active_object
    a.scale = (0.05, 0.05, 0.3)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(-0.18, 0.0, 0.0))
    b = bpy.context.active_object
    b.scale = (0.05, 0.05, 0.3)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
    bpy.ops.object.select_all(action="DESELECT")
    a.select_set(True)
    b.select_set(True)
    bpy.context.view_layer.objects.active = a
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = "fork_dual"
    obj.data.name = "fork_dual_mesh"
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def main() -> None:
    print(f"[seed-bike-kit] writing {OUTPUT_PATH}")
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    reset_scene()

    chassis_mat = get_or_create_material("mat_kit_bike_chassis", (0.13, 0.14, 0.16, 1.0))
    fairing_mat = get_or_create_material("mat_kit_bike_fairing", (0.85, 0.40, 0.20, 1.0))
    thruster_mat = get_or_create_material("mat_kit_bike_thruster", (0.36, 0.94, 1.00, 1.0))
    fork_mat = get_or_create_material("mat_kit_bike_fork", (0.20, 0.20, 0.22, 1.0))

    make_chassis_base(chassis_mat)
    make_fairing_bare(fairing_mat)
    make_fairing_swept(fairing_mat)
    make_fairing_full(fairing_mat)
    make_thruster_unit(thruster_mat)
    make_fork_single(fork_mat)
    make_fork_dual(fork_mat)

    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    print(
        f"[seed-bike-kit] done — {len(bpy.data.objects)} objects: "
        f"{', '.join(o.name for o in bpy.data.objects)}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[seed-bike-kit] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
