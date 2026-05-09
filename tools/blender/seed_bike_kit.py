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

### Outliner layout

The kit is organized into collections so the outliner reads like the
in-game ``?viewer=<id>`` page — flick a collection visible to switch
which bike you're previewing.

  Source                         (canonical parts; hidden by default)
    ├── chassis_base + mounts
    ├── fairing_bare / swept / full
    ├── fork_single / dual
    ├── thruster_unit
    └── fin_marker, tail_marker
  Bike: Calibration Bike         (hidden)
  Bike: Cruiser                  (hidden)
  Bike: Racer                    (hidden)
  Bike: Scout                    (visible by default)
  Bike: Stunt                    (hidden)

Each ``Bike: <name>`` collection contains *linked-data instances* of
the canonical parts, scaled and positioned per the spec at
``specs/bikes/<id>.json``. Mesh data is shared with Source — edit a
mesh in Source and every preview updates. Toggle Source visible when
you want to add a part or rework a variant; otherwise leave it off
and treat the bike collections as a read-only preview gallery.

### Canonical part list

Named objects produced (materials prefixed ``mat_kit_bike_*`` so the
renamer in build_bike.py can find them). Each part's *mesh data* is
authored origin-centred; the **object transform** places parts at
their exact assembled-bike positions so editing in the Source
collection reads as a real bike. The transform is reset on append
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

import json
import os
import sys
from typing import Any

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

# Blender runs this script via ``--python`` with the parent dir off
# sys.path, so import via the package path rooted at REPO_ROOT.
from tools.blender.mounts import add_mount  # noqa: E402

OUTPUT_PATH = os.path.join(REPO_ROOT, "tools", "blender", "lib", "bike_parts.blend")
SPECS_DIR = os.path.join(REPO_ROOT, "specs", "bikes")

# Collection visible by default in the kit's outliner. Pick the bike
# whose silhouette best represents the canonical "this is what the
# bike looks like" pose. Authors flick visibility to switch previews.
DEFAULT_VISIBLE_BIKE_ID = "scout"


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


def hex_to_linear_rgba(hex_str: str) -> tuple[float, float, float, float]:
    """``#rrggbb`` → linear-space RGBA. Mirrors ``build_bike.hex_to_rgba``
    so the kit's placeholder materials render the same way the built
    bike's spec-driven materials will."""
    s = hex_str.lstrip("#")
    r = int(s[0:2], 16) / 255.0
    g = int(s[2:4], 16) / 255.0
    b = int(s[4:6], 16) / 255.0
    return (r ** 2.2, g ** 2.2, b ** 2.2, 1.0)


def get_or_create_material(
    name: str,
    color: tuple[float, float, float, float],
    *,
    metallic: float = 0.2,
    roughness: float = 0.5,
    emissive: tuple[float, float, float, float] | None = None,
    emissive_intensity: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = color
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = roughness
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = metallic
        if emissive is not None:
            for em_input in ("Emission", "Emission Color"):
                if em_input in bsdf.inputs:
                    bsdf.inputs[em_input].default_value = emissive
            if "Emission Strength" in bsdf.inputs:
                bsdf.inputs["Emission Strength"].default_value = emissive_intensity
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
    """Place each kit part at its **exact** assembled-bike position
    so the kit reads as the built **scout** bike when opened — the
    spec the layout is tuned to (W=0.6, L=2.5, H=0.4, fairingStyle=
    "swept", fork="single", thrusterCount=2, thrusterSpacing=0.4).

    Variant parts (`fairing_bare`, `fairing_full`, `fork_dual`) are
    parked at the same world position as their primary but flagged
    ``hide_viewport`` / ``hide_render`` so only the active variant
    is visible. Toggle visibility in the outliner to edit a variant.

    A second thruster, ``thruster_unit_preview_l``, is created as a
    sibling at the mirrored X position so the kit shows scout's
    2-thruster layout. The preview shares the canonical thruster's
    mesh data and is *not* loaded by ``build_bike.py`` (which appends
    by exact name "thruster_unit"), so it never reaches the GLB.

    Only the object transform is moved; mesh data is untouched. On
    append, ``lib_loader`` resets the transform — these positions
    are purely an authoring convenience."""
    W, L, H = 0.6, 2.5, 0.4
    nose_y = -L * 0.5 + 0.1
    tail_y = L * 0.5 - 0.15
    thruster_z = H * 0.35
    # Scout: 2 thrusters at ±s/2 along X — see build_bike.py.
    thruster_count = 2
    thruster_spacing = 0.4
    thruster_x_r = thruster_spacing * 0.5
    thruster_x_l = -thruster_spacing * 0.5

    fairing_pos = (0.0, 0.0, H + 0.15)
    fork_pos = (0.0, nose_y, H * 0.4)

    placements: dict[str, tuple[float, float, float]] = {
        "chassis_base": (0.0, 0.0, H * 0.5),
        "fairing_bare": fairing_pos,
        "fairing_swept": fairing_pos,
        "fairing_full": fairing_pos,
        # Canonical thruster_unit at the +X (right) thruster position;
        # the matching `thruster_unit_preview_l` mirror is created
        # below in clone_thruster_preview().
        "thruster_unit": (thruster_x_r, tail_y, thruster_z),
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

    # The kit's per-bike preview collections (built later in
    # build_per_bike_collections) supply spec-correct multi-thruster
    # previews via linked-data instances. The standalone
    # ``thruster_unit_preview_l`` mirror is redundant once those exist.
    # Variants live in the Source collection; per-bike collections
    # show only the active variant, so we don't hide-by-name here —
    # collection visibility handles it.


def _ensure_collection(name: str) -> bpy.types.Collection:
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    return coll


def _move_obj_to_collection(obj: bpy.types.Object, target: bpy.types.Collection) -> None:
    """Unlink an object from every collection it's in, then link to ``target``.

    Children parented to ``obj`` are NOT auto-moved — Blender's parenting
    is independent of collection membership. Caller can pass children
    separately if it wants them to ride along."""
    for coll in list(obj.users_collection):
        coll.objects.unlink(obj)
    target.objects.link(obj)


def _set_collection_visibility(coll: bpy.types.Collection, *, hidden: bool) -> None:
    """Hide/show a collection at both the data level (eye-with-monitor
    icon) and the layer-collection level (outliner eye icon). Both
    flags need flipping for an "off by default" experience."""
    coll.hide_viewport = hidden
    coll.hide_render = hidden
    layer = bpy.context.view_layer.layer_collection.children.get(coll.name)
    if layer is not None:
        layer.hide_viewport = hidden


def organize_canonical_into_source() -> bpy.types.Collection:
    """Move every object currently in the scene into a ``Source``
    collection so per-bike preview collections can be added alongside
    without crowding the outliner. The Source collection holds the
    *editable* canonical parts (chassis_base, fairings, forks,
    thrusters, fin, tail, mounts). It's hidden by default — toggle it
    on when you want to edit a part."""
    src = _ensure_collection("Source")
    for obj in list(bpy.data.objects):
        _move_obj_to_collection(obj, src)
    return src


def _read_bike_specs() -> list[dict[str, Any]]:
    """Load every JSON spec under ``specs/bikes/`` so we can build a
    preview collection per bike. Returns specs sorted by id."""
    if not os.path.isdir(SPECS_DIR):
        print(f"[seed-bike-kit] no specs dir at {SPECS_DIR}; skipping per-bike previews")
        return []
    specs: list[dict[str, Any]] = []
    for fname in sorted(os.listdir(SPECS_DIR)):
        if not fname.endswith(".json"):
            continue
        path = os.path.join(SPECS_DIR, fname)
        try:
            with open(path, "r", encoding="utf-8") as f:
                specs.append(json.load(f))
        except (json.JSONDecodeError, OSError) as e:
            print(f"[seed-bike-kit] skipping {fname}: {e}")
    specs.sort(key=lambda s: s.get("id", ""))
    return specs


def _link_instance(
    coll: bpy.types.Collection,
    name: str,
    source: bpy.types.Object,
    *,
    location: tuple[float, float, float] = (0.0, 0.0, 0.0),
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
) -> bpy.types.Object | None:
    """Create a new object that **shares mesh data** with ``source``,
    place it, and link it into ``coll``. Mesh edits to source ride
    through to every instance."""
    if source is None or source.data is None:
        return None
    obj = bpy.data.objects.new(name, source.data)
    obj.location = location
    obj.scale = scale
    obj.rotation_euler = source.rotation_euler.copy()
    coll.objects.link(obj)
    return obj


def build_preview_collection_for_spec(spec: dict[str, Any]) -> bpy.types.Collection | None:
    """Build a ``Bike: <DisplayName>`` collection containing linked-
    data instances of the canonical parts, scaled and positioned per
    ``spec``. The result is what the ?viewer=<id> page would render —
    a ready-to-eyeball assembled bike for that spec.

    Mesh data is shared with the canonical parts in the Source
    collection, so any mesh edit you make in the Source collection
    propagates into every preview instantly."""
    bike_id = spec.get("id")
    geom = spec.get("geometry")
    if not isinstance(bike_id, str) or not isinstance(geom, dict):
        return None

    display = spec.get("displayName", bike_id)
    coll_name = f"Bike: {display}"
    coll = _ensure_collection(coll_name)
    # Wipe any stale objects from a prior seed run so re-seeding is
    # idempotent.
    for obj in list(coll.objects):
        coll.objects.unlink(obj)
        if obj.users == 0:
            bpy.data.objects.remove(obj, do_unlink=True)

    W = float(geom.get("chassisWidth", 0.6))
    L = float(geom.get("chassisLength", 2.5))
    H = float(geom.get("chassisHeight", 0.4))
    nose_y = -L * 0.5 + 0.1
    tail_y = L * 0.5 - 0.15
    thruster_z = H * 0.35
    thruster_count = int(geom.get("thrusterCount", 2))
    thruster_spacing = float(geom.get("thrusterSpacing", 0.4))
    fairing_style = str(geom.get("fairingStyle", "swept"))
    fork_kind = str(geom.get("fork", "single"))

    chassis_src = bpy.data.objects.get("chassis_base")
    if chassis_src is None:
        return coll  # nothing to instance against; bail gracefully

    _link_instance(
        coll, f"preview_{bike_id}_chassis", chassis_src,
        location=(0.0, 0.0, H * 0.5),
        scale=(W, L, H),
    )

    fairing_src = bpy.data.objects.get(f"fairing_{fairing_style}")
    _link_instance(
        coll, f"preview_{bike_id}_fairing", fairing_src,
        location=(0.0, 0.0, H + 0.15),
        scale=(W, L, 1.0),
    )

    fork_src = bpy.data.objects.get(f"fork_{fork_kind}")
    _link_instance(
        coll, f"preview_{bike_id}_fork", fork_src,
        location=(0.0, nose_y, H * 0.4),
    )

    thruster_src = bpy.data.objects.get("thruster_unit")
    for i in range(thruster_count):
        offset_x = thruster_spacing * (i - (thruster_count - 1) / 2.0)
        _link_instance(
            coll, f"preview_{bike_id}_thruster_{i}", thruster_src,
            location=(offset_x, tail_y, thruster_z),
        )

    fin_src = bpy.data.objects.get("fin_marker")
    _link_instance(
        coll, f"preview_{bike_id}_fin", fin_src,
        location=(0.0, -L * 0.5 + 0.05, H + 0.35),
    )

    tail_src = bpy.data.objects.get("tail_marker")
    _link_instance(
        coll, f"preview_{bike_id}_tail", tail_src,
        location=(0.0, L * 0.5 - 0.05, H + 0.05),
    )

    return coll


def build_per_bike_collections() -> None:
    """Top-level: move canonical parts into Source, then build a
    preview collection per spec. Hides Source + every bike collection
    except DEFAULT_VISIBLE_BIKE_ID so opening the kit shows one bike
    at a time, like the ?viewer=<id> page."""
    src = organize_canonical_into_source()
    _set_collection_visibility(src, hidden=True)

    specs = _read_bike_specs()
    for spec in specs:
        coll = build_preview_collection_for_spec(spec)
        if coll is None:
            continue
        is_default = spec.get("id") == DEFAULT_VISIBLE_BIKE_ID
        _set_collection_visibility(coll, hidden=not is_default)


def main() -> None:
    print(f"[seed-bike-kit] writing {OUTPUT_PATH}")
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    reset_scene()

    # Kit placeholder materials are dressed in **scout** livery so the
    # in-Blender preview matches what `?bike=scout` looks like in-game.
    # Numbers track ``specs/bikes/scout.json``. The build replaces
    # these with spec-driven materials per bike, so editing them only
    # affects the in-Blender preview.
    livery = hex_to_linear_rgba("#ff6633")
    metal = hex_to_linear_rgba("#222428")
    glow = hex_to_linear_rgba("#5cf2ff")
    glow_intensity = 1.4
    tail_red = hex_to_linear_rgba("#ff3333")

    chassis_mat = get_or_create_material(
        "mat_kit_bike_chassis", metal, metallic=0.6, roughness=0.4,
    )
    fairing_mat = get_or_create_material(
        "mat_kit_bike_fairing", livery, metallic=0.3, roughness=0.45,
    )
    thruster_mat = get_or_create_material(
        "mat_kit_bike_thruster", glow,
        emissive=glow, emissive_intensity=glow_intensity,
        metallic=0.1, roughness=0.3,
    )
    fork_mat = get_or_create_material(
        "mat_kit_bike_fork", metal, metallic=0.7, roughness=0.35,
    )
    fin_mat = get_or_create_material(
        "mat_kit_bike_fin", livery,
        emissive=livery, emissive_intensity=0.5,
        metallic=0.2, roughness=0.4,
    )
    tail_mat = get_or_create_material(
        "mat_kit_bike_tail", tail_red,
        emissive=tail_red, emissive_intensity=1.0,
        metallic=0.0, roughness=0.4,
    )

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
    build_per_bike_collections()

    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    collections = ", ".join(c.name for c in bpy.data.collections)
    print(
        f"[seed-bike-kit] done — {len(bpy.data.objects)} objects, "
        f"collections: [{collections}]"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[seed-bike-kit] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
