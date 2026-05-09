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

Named objects produced (materials prefixed ``mat_kit_bike_*`` so the
renamer in build_bike.py can find them). Each part's *mesh data* is
authored origin-centred; the **object transform** places parts at
their exact assembled-bike positions so authors see a fully-built
bike when opening the kit. Variants overlap their primary (both forks
at the nose, all fairings on top of the chassis); hide the ones you
don't care about in the outliner. The transform is reset on append
(see ``lib_loader.append_objects``), so kit-file positions are purely
an authoring convenience — only mesh edits ride through to the build.

  chassis_base       — 1x1x1 cube; builder scales per spec. Centered
                       on the bike's chassis volume.
  fairing_bare       — minimal flat fairing (low + thin); on top of
                       the chassis.
  fairing_swept      — wedge with the front edge tilted down. Same
                       on-top-of-chassis position as fairing_bare.
  fairing_full       — bulkier box that wraps more of the chassis.
                       Same position as the other fairings.
  thruster_unit      — short cylinder along Blender +Y (bike-length);
                       at the bike's tail (+Y), centreline. Builder
                       duplicates per spec.thrusterCount.
  fork_single        — single vertical column; at the bike's nose (-Y).
  fork_dual          — two parallel vertical columns (joined mesh).
                       Same position as fork_single.
  fin_marker         — small cone, builder places at chassis nose (-Y)
                       with a livery-colored material. Restores the
                       visual "this end is forward" cue the procedural
                       bike-mesh.ts had.
  tail_marker        — small sphere, builder places at chassis tail
                       (+Y) with a red emissive material. Mirror of
                       the procedural tail-light.
"""

from __future__ import annotations

import os
import sys

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

# Blender runs this script via ``--python`` with the parent dir off
# sys.path, so import via the package path rooted at REPO_ROOT.
from tools.blender.mounts import add_mount  # noqa: E402

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


def make_fin_marker(material: bpy.types.Material) -> bpy.types.Object:
    """Small cone pointing along Blender -Y so after yup export its
    apex points at three +Z (forward). Cone primitive's apex is at
    local +Z by default; rotating -90° about X aligns it with -Y."""
    bpy.ops.mesh.primitive_cone_add(
        radius1=0.18, radius2=0.0, depth=0.6, vertices=8, location=(0, 0, 0)
    )
    obj = bpy.context.active_object
    obj.name = "fin_marker"
    obj.rotation_euler = (-1.5707963, 0.0, 0.0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    obj.data.name = "fin_marker_mesh"
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def make_tail_marker(material: bpy.types.Material) -> bpy.types.Object:
    """Small sphere — emissive in the builder via material override."""
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.12, segments=12, ring_count=8, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = "tail_marker"
    obj.data.name = "tail_marker_mesh"
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


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


def lay_out_in_context() -> None:
    """Place each kit part at its **exact** assembled-bike position so
    the kit reads as a fully-built bike when opened. Only the object
    transform is moved; mesh data is untouched. ``lib_loader.append_
    objects`` resets the transform on append, so these positions are
    purely an authoring convenience.

    The layout mirrors the placement logic in ``build_bike.py`` using
    representative geometry numbers from ``specs/bikes/scout.json``
    (W=0.6, L=2.5, H=0.4). **Variants overlap their primary** — both
    forks live at the same nose position; all three fairings sit on
    top of the chassis. Hide the variants you don't care about in the
    outliner if you need to see only the active one."""
    W, L, H = 0.6, 2.5, 0.4
    nose_y = -L * 0.5 + 0.1
    tail_y = L * 0.5 - 0.15

    fairing_pos = (0.0, 0.0, H + 0.15)
    fork_pos = (0.0, nose_y, H * 0.4)

    placements: dict[str, tuple[float, float, float]] = {
        "chassis_base": (0.0, 0.0, H * 0.5),
        "fairing_bare": fairing_pos,
        "fairing_swept": fairing_pos,
        "fairing_full": fairing_pos,
        # Single thruster_unit at the centreline — build_bike.py
        # duplicates and offsets per spec.thrusterCount/Spacing.
        "thruster_unit": (0.0, tail_y, H * 0.35),
        "fork_single": fork_pos,
        "fork_dual": fork_pos,
        "fin_marker": (0.0, -L * 0.5 + 0.05, H + 0.35),
        "tail_marker": (0.0, L * 0.5 - 0.05, H + 0.05),
    }

    # Match build_bike.py: chassis is a unit cube the builder scales to
    # (W, L, H) at build time. Author-time we apply the same scale to
    # the kit object so the visual silhouette reads as a real bike.
    # The build resets all kit transforms on append, so this is layout-
    # only — the mesh is still a 1m cube.
    obj_scales: dict[str, tuple[float, float, float]] = {
        "chassis_base": (W, L, H),
    }

    for name, loc in placements.items():
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        obj.location = loc
        if name in obj_scales:
            obj.scale = obj_scales[name]

    # Mount empties on the chassis. Positions are in chassis-LOCAL
    # space (unit cube spanning ±0.5 along each axis). At build time
    # the chassis is scaled by (W, L, H) and lifted by H/2, so a
    # mount at chassis-local (lx, ly, lz) ends up at world
    # (W*lx, L*ly, H*lz + H/2). The values below were chosen to
    # reproduce the world positions that ``build_bike.py`` previously
    # hardcoded for the scout bike (W=0.6, L=2.5, H=0.4):
    #
    #   mount_fairing  →  world (0,    0,     H+0.15) = (0,    0,    0.55)
    #   mount_fork     →  world (0,   -L/2+0.1, H*0.4) = (0, -1.15, 0.16)
    #   mount_fin      →  world (0,   -L/2+0.05, H+0.35) = (0, -1.20, 0.75)
    #   mount_tail     →  world (0,    L/2-0.05, H+0.05) = (0,  1.20, 0.45)
    #
    # Behaviour change vs. the previous baked math: world positions
    # now scale strictly with chassis dims. Old code mixed scaled
    # (H*0.4) and absolute (H+0.15) terms, so non-scout bikes drift
    # by a few millimetres. Authors can re-tune any mount in the kit.
    chassis = bpy.data.objects["chassis_base"]
    add_mount(chassis, "fairing", (0.0, 0.0, 0.875))
    add_mount(chassis, "fork", (0.0, -0.46, -0.1))
    add_mount(chassis, "fin", (0.0, -0.48, 1.375))
    add_mount(chassis, "tail", (0.0, 0.48, 0.625))


def main() -> None:
    print(f"[seed-bike-kit] writing {OUTPUT_PATH}")
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    reset_scene()

    chassis_mat = get_or_create_material("mat_kit_bike_chassis", (0.13, 0.14, 0.16, 1.0))
    fairing_mat = get_or_create_material("mat_kit_bike_fairing", (0.85, 0.40, 0.20, 1.0))
    thruster_mat = get_or_create_material("mat_kit_bike_thruster", (0.36, 0.94, 1.00, 1.0))
    fork_mat = get_or_create_material("mat_kit_bike_fork", (0.20, 0.20, 0.22, 1.0))
    fin_mat = get_or_create_material("mat_kit_bike_fin", (1.00, 0.80, 0.30, 1.0))
    tail_mat = get_or_create_material("mat_kit_bike_tail", (1.00, 0.20, 0.20, 1.0))

    make_chassis_base(chassis_mat)
    make_fairing_bare(fairing_mat)
    make_fairing_swept(fairing_mat)
    make_fairing_full(fairing_mat)
    make_thruster_unit(thruster_mat)
    make_fork_single(fork_mat)
    make_fork_dual(fork_mat)
    make_fin_marker(fin_mat)
    make_tail_marker(tail_mat)

    lay_out_in_context()

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
