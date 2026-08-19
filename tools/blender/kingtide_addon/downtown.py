"""Downtown generator — placeholder dense-urban city block.

Drops a rectangular grid of mid-rise towers separated by streets and
a flat sidewalk plinth, all parented to a ``downtown_NN`` empty for
one-click move/delete.

Geometry is intentionally placeholder — boxy buildings of varied
heights with simple top-floor setbacks, two grey/tan/blue tints
alternating per building, and asphalt streets. Good enough to read
as a city from a hoverbike at speed; refine later by swapping the
per-building mesh for a richer GN graph or imported asset.

Each building mesh carries ``kind="track"`` so the runtime trimesh
collider attaches at GLB-load time (you can fly through them
otherwise). The street plinth is also kind="track" so the bike can
rake across it.

Reproducibility: the grid layout, building heights, footprints, and
tints all come from a seeded RNG keyed off ``seed``. Two downtowns
with the same seed + dimensions are identical.
"""

from __future__ import annotations

import math

import bpy
import mathutils
from bpy.props import BoolProperty, FloatProperty, IntProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

DOWNTOWN_OBJECT_PREFIX = "downtown_"
DOWNTOWN_BUILDING_MAT_PREFIX = "mat_track_downtown_"
DOWNTOWN_SIDEWALK_MAT_NAME = "mat_track_downtown_sidewalk"
DOWNTOWN_ROAD_MAT_NAME = "mat_track_downtown_road"

# Material slot indices on every plinth mesh — same on all downtowns
# so downstream tools can swap the materials by slot index without
# having to look up which downtown they're editing.
DOWNTOWN_PLINTH_SIDEWALK_SLOT = 0
DOWNTOWN_PLINTH_ROAD_SLOT = 1


# ────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────


def _next_downtown_object_name() -> str:
    i = 0
    while True:
        name = f"{DOWNTOWN_OBJECT_PREFIX}{i:02d}"
        if name not in bpy.data.objects:
            return name
        i += 1


def _ensure_downtown_building_material(variant: int) -> bpy.types.Material:
    """Return one of N flat tints used to alternate building colours
    so a block doesn't read as a single grey mass. Variants cycle
    deterministic per-building from the layout RNG."""
    palette = [
        (0.62, 0.60, 0.57),  # warm concrete
        (0.45, 0.48, 0.52),  # cool steel
        (0.38, 0.34, 0.32),  # dark glass / brown brick
        (0.72, 0.68, 0.58),  # tan stone
        (0.30, 0.36, 0.42),  # navy spandrel glass
        (0.55, 0.52, 0.48),  # mid grey
    ]
    idx = int(variant) % len(palette)
    name = f"{DOWNTOWN_BUILDING_MAT_PREFIX}{idx:02d}"
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        r, g, b = palette[idx]
        bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.6
        spec = bsdf.inputs.get("Specular IOR Level") or bsdf.inputs.get("Specular")
        if spec is not None:
            spec.default_value = 0.4
    return mat


def _ensure_downtown_sidewalk_material() -> bpy.types.Material:
    """Sidewalk / lot plinth surface — light warm concrete. This is
    the "ground around the buildings" colour, the lighter half of the
    sidewalk/road contrast that makes the street grid read at speed.
    Material-slot 0 on every plinth."""
    mat = bpy.data.materials.get(DOWNTOWN_SIDEWALK_MAT_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(DOWNTOWN_SIDEWALK_MAT_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.52, 0.50, 0.46, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.82
        spec = bsdf.inputs.get("Specular IOR Level") or bsdf.inputs.get("Specular")
        if spec is not None:
            spec.default_value = 0.2
    return mat


def _ensure_downtown_road_material() -> bpy.types.Material:
    """Asphalt road surface — dark grey, slightly bluer than the
    sidewalk so the contrast doesn't read as "dirty concrete" but as
    "different surface". Material-slot 1 on every plinth; assigned to
    faces that fall in the inter-block street strips, so the road
    network reads as a darker grid against the lighter sidewalk
    fabric without a second mesh / z-fight."""
    mat = bpy.data.materials.get(DOWNTOWN_ROAD_MAT_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(DOWNTOWN_ROAD_MAT_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.10, 0.10, 0.12, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.88
        spec = bsdf.inputs.get("Specular IOR Level") or bsdf.inputs.get("Specular")
        if spec is not None:
            spec.default_value = 0.22
    return mat


def _build_downtown_building_mesh(
    name: str,
    *,
    footprint: tuple[float, float],
    height: float,
    has_setback: bool,
    extra_depth: float = 0.0,
) -> bpy.types.Mesh:
    """Build a single placeholder building. A box of ``footprint`` X×Y
    by ``height`` Z, optionally with an inset top-floor setback that
    gives the silhouette a stepped look at speed.

    ``extra_depth`` (m) sinks the bottom face below the building's
    local z=0 — used by the terrain-conform pass to bury the downhill
    side into the slope so a building on a hill looks like it's
    stepping into the grade instead of floating on stilts. The
    exposed silhouette above z=0 is unchanged.

    Origin sits on the building's base centre at z=0 = "uphill
    ground"."""
    me = bpy.data.meshes.new(name)
    fx, fy = footprint
    hx, hy = fx * 0.5, fy * 0.5
    bz = -float(max(extra_depth, 0.0))

    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []

    if has_setback and height > 8.0:
        body_h = height * 0.78
        sx, sy = hx * 0.78, hy * 0.78
        verts.extend([
            (-hx, -hy, bz), (hx, -hy, bz), (hx, hy, bz), (-hx, hy, bz),
            (-hx, -hy, body_h), (hx, -hy, body_h), (hx, hy, body_h), (-hx, hy, body_h),
        ])
        verts.extend([
            (-sx, -sy, body_h), (sx, -sy, body_h), (sx, sy, body_h), (-sx, sy, body_h),
            (-sx, -sy, height), (sx, -sy, height), (sx, sy, height), (-sx, sy, height),
        ])
        faces.extend([
            (0, 1, 2, 3),
            (0, 1, 5, 4), (1, 2, 6, 5),
            (2, 3, 7, 6), (3, 0, 4, 7),
        ])
        faces.extend([
            (8, 9, 13, 12), (9, 10, 14, 13),
            (10, 11, 15, 14), (11, 8, 12, 15),
            (12, 13, 14, 15),
        ])
        faces.extend([
            (0 + 4, 1 + 4, 9, 8),
            (1 + 4, 2 + 4, 10, 9),
            (2 + 4, 3 + 4, 11, 10),
            (3 + 4, 0 + 4, 8, 11),
        ])
    else:
        verts.extend([
            (-hx, -hy, bz), (hx, -hy, bz), (hx, hy, bz), (-hx, hy, bz),
            (-hx, -hy, height), (hx, -hy, height), (hx, hy, height), (-hx, hy, height),
        ])
        faces.extend([
            (0, 1, 2, 3),
            (4, 7, 6, 5),
            (0, 1, 5, 4), (1, 2, 6, 5),
            (2, 3, 7, 6), (3, 0, 4, 7),
        ])

    me.from_pydata(verts, [], faces)
    me.update(calc_edges=True)
    me.shade_flat()
    return me


def _block_aligned_axis_positions(
    blocks: int,
    block_size: float,
    street_width: float,
    *,
    cells_per_block: int = 4,
    cells_per_street: int = 2,
) -> tuple[list[float], list[bool]]:
    """Return ``(positions, cell_is_street)`` for a per-axis vertex
    layout that pins subdivisions to block/street boundaries."""
    pitch = block_size + street_width
    span = blocks * pitch - street_width
    positions: list[float] = [-span * 0.5]
    cell_is_street: list[bool] = []
    cur = -span * 0.5
    for b in range(blocks):
        for c in range(1, cells_per_block + 1):
            positions.append(cur + c * block_size / cells_per_block)
            cell_is_street.append(False)
        cur += block_size
        if b < blocks - 1:
            for c in range(1, cells_per_street + 1):
                positions.append(cur + c * street_width / cells_per_street)
                cell_is_street.append(True)
            cur += street_width
    return positions, cell_is_street


def _build_downtown_plinth_mesh(
    name: str,
    *,
    blocks_x: int,
    blocks_y: int,
    block_size: float,
    street_width: float,
    vertex_z: list[float] | None = None,
) -> tuple[bpy.types.Mesh, list[tuple[float, float]]]:
    """Plinth: streets + sidewalks as a single mesh with two material
    slots. Returns ``(mesh, vert_positions_xy)`` so the caller can
    raycast each vertex to the terrain (then re-call this with the
    resulting ``vertex_z``)."""
    me = bpy.data.meshes.new(name)
    x_pos, x_is_street = _block_aligned_axis_positions(blocks_x, block_size, street_width)
    y_pos, y_is_street = _block_aligned_axis_positions(blocks_y, block_size, street_width)
    nx = len(x_pos)
    ny = len(y_pos)
    base_lift = 0.05

    verts: list[tuple[float, float, float]] = []
    vert_positions_xy: list[tuple[float, float]] = []
    for j in range(ny):
        for i in range(nx):
            idx = j * nx + i
            if vertex_z is not None and idx < len(vertex_z):
                z = float(vertex_z[idx]) + base_lift
            else:
                z = base_lift
            verts.append((x_pos[i], y_pos[j], z))
            vert_positions_xy.append((x_pos[i], y_pos[j]))

    faces: list[tuple[int, ...]] = []
    mat_idx: list[int] = []
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = j * nx + i
            b = a + 1
            c = a + nx + 1
            d = a + nx
            faces.append((a, b, c, d))
            is_road = x_is_street[i] or y_is_street[j]
            mat_idx.append(
                DOWNTOWN_PLINTH_ROAD_SLOT if is_road else DOWNTOWN_PLINTH_SIDEWALK_SLOT
            )

    me.from_pydata(verts, [], faces)
    me.update(calc_edges=True)
    me.shade_flat()
    for fi, slot in enumerate(mat_idx):
        me.polygons[fi].material_index = slot
    return me, vert_positions_xy


def _terrain_raycast_batch(
    scene,
    points_xy: list[tuple[float, float]],
) -> list[tuple[float, bool]]:
    """Cast straight down at every (x_world, y_world) and return
    ``[(z_world, hit)]``. Casts against *only* the largest visible
    ``kind="track"`` mesh (the terrain), not against the whole scene
    — so existing downtown buildings, water previews, gates, racer
    previews, and the like never catch the cast."""
    from ._legacy import _largest_terrain_mesh

    target = _largest_terrain_mesh()
    if target is None:
        return [(0.0, False)] * len(points_xy)
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    eval_obj = target.evaluated_get(depsgraph)
    mw = eval_obj.matrix_world
    mw_inv = mw.inverted_safe()
    down_local = mw_inv.to_3x3() @ mathutils.Vector((0.0, 0.0, -1.0))
    results: list[tuple[float, bool]] = []
    for x, y in points_xy:
        origin_world = mathutils.Vector((float(x), float(y), 10000.0))
        origin_local = mw_inv @ origin_world
        hit, loc_local, *_ = eval_obj.ray_cast(origin_local, down_local)
        if hit:
            results.append((float((mw @ loc_local).z), True))
        else:
            results.append((0.0, False))
    return results


def _hash_cell(seed: int, gx: int, gy: int) -> float:
    """Cheap deterministic [0,1) per (seed, gx, gy). Avoids importing
    Python ``random`` so we don't disturb the user's RNG state."""
    h = (seed * 73856093) ^ (gx * 19349663) ^ (gy * 83492791)
    h = (h ^ (h >> 13)) & 0xFFFFFFFF
    h = (h * 1274126177) & 0xFFFFFFFF
    return ((h >> 8) & 0xFFFFFF) / float(1 << 24)


def _generate_downtown(
    scene,
    *,
    location: tuple[float, float, float],
    rotation_z: float,
    blocks_x: int,
    blocks_y: int,
    block_size: float,
    street_width: float,
    height_min: float,
    height_max: float,
    seed: int,
    conform_to_terrain: bool = True,
    existing_parent: bpy.types.Object | None = None,
) -> tuple[bpy.types.Object, int]:
    """Spawn a parented downtown block. Returns (parent_empty,
    n_buildings_built).

    Pass ``existing_parent`` to rebuild in place at that empty's
    current transform — useful for Rebuild Downtown after the user
    tweaks the panel sliders. The caller is responsible for purging
    the old children first."""
    if existing_parent is None:
        name = _next_downtown_object_name()
        parent = bpy.data.objects.new(name, None)
        parent.empty_display_type = "CUBE"
        parent.location = location
        parent.rotation_euler = (0.0, 0.0, float(rotation_z))
        scene.collection.objects.link(parent)
    else:
        parent = existing_parent
        name = parent.name
    parent.empty_display_size = max(2.0, block_size * 0.4)
    parent["kind"] = "downtown"
    parent["seed"] = int(seed)
    parent["blocks_x"] = int(blocks_x)
    parent["blocks_y"] = int(blocks_y)
    parent["block_size"] = float(block_size)
    parent["street_width"] = float(street_width)
    parent["height_min"] = float(height_min)
    parent["height_max"] = float(height_max)
    parent["conform_to_terrain"] = bool(conform_to_terrain)

    pitch = block_size + street_width
    span_x = blocks_x * pitch - street_width
    span_y = blocks_y * pitch - street_width

    cell_specs: list[dict] = []
    for gx in range(blocks_x):
        for gy in range(blocks_y):
            cx = -span_x * 0.5 + gx * pitch + block_size * 0.5
            cy = -span_y * 0.5 + gy * pitch + block_size * 0.5
            r0 = _hash_cell(seed, gx, gy)
            if r0 < 0.12:
                cell_specs.append({"gx": gx, "gy": gy, "skip": True})
                continue
            if r0 < 0.47:
                quarter = block_size * 0.5
                half_q = quarter * 0.5
                quads = []
                for dx, dy, idx in (
                    (-half_q, -half_q, 0), (half_q, -half_q, 1),
                    (half_q, half_q, 2), (-half_q, half_q, 3),
                ):
                    rh = _hash_cell(seed * 7 + idx, gx, gy)
                    rv = _hash_cell(seed * 13 + idx, gx, gy)
                    h = height_min + rh * (height_max - height_min) * 0.7
                    fp = (
                        quarter * (0.78 + 0.18 * rv),
                        quarter * (0.78 + 0.18 * (1.0 - rv)),
                    )
                    quads.append({"local_xy": (cx + dx, cy + dy), "footprint": fp,
                                  "height": h, "rh": rh, "idx": idx})
                cell_specs.append({"gx": gx, "gy": gy, "skip": False, "sub": True, "quads": quads})
            else:
                rh = _hash_cell(seed * 17, gx, gy)
                rv = _hash_cell(seed * 23, gx, gy)
                h = height_min + rh * (height_max - height_min)
                fp = (
                    block_size * (0.82 + 0.14 * rv),
                    block_size * (0.82 + 0.14 * (1.0 - rv)),
                )
                cell_specs.append({"gx": gx, "gy": gy, "skip": False, "sub": False,
                                   "local_xy": (cx, cy), "footprint": fp,
                                   "height": h, "rh": rh})

    # Manual rotate+translate of parent-local to world. parent.matrix_world
    # is identity-at-read until view_layer.update() fires; we're called
    # in the same script step that set parent.location, so the matrix
    # is stale. Manual math is faster and bulletproof.
    p_x = float(parent.location.x)
    p_y = float(parent.location.y)
    p_yaw = float(parent.rotation_euler.z)
    cos_y = math.cos(p_yaw)
    sin_y = math.sin(p_yaw)

    def _local_xy_to_world(lx: float, ly: float) -> tuple[float, float]:
        return (p_x + lx * cos_y - ly * sin_y,
                p_y + lx * sin_y + ly * cos_y)

    plinth_x_pos, _ = _block_aligned_axis_positions(blocks_x, block_size, street_width)
    plinth_y_pos, _ = _block_aligned_axis_positions(blocks_y, block_size, street_width)

    raycast_points: list[tuple[float, float]] = []
    plinth_idx_range: tuple[int, int] = (0, 0)
    if conform_to_terrain:
        for ly in plinth_y_pos:
            for lx in plinth_x_pos:
                raycast_points.append(_local_xy_to_world(lx, ly))
        plinth_idx_range = (0, len(raycast_points))

    building_corner_slots: list[tuple[int, int]] = []
    if conform_to_terrain:
        for cell in cell_specs:
            if cell["skip"]:
                building_corner_slots.append((-1, 0))
                continue
            if cell["sub"]:
                slots: list[int] = []
                for q in cell["quads"]:
                    slots.append(len(raycast_points))
                    cx, cy = q["local_xy"]
                    fx, fy = q["footprint"]
                    hx, hy = fx * 0.5, fy * 0.5
                    for ox, oy in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)):
                        raycast_points.append(_local_xy_to_world(cx + ox, cy + oy))
                cell["_slots"] = slots
            else:
                cell["_slot"] = len(raycast_points)
                cx, cy = cell["local_xy"]
                fx, fy = cell["footprint"]
                hx, hy = fx * 0.5, fy * 0.5
                for ox, oy in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)):
                    raycast_points.append(_local_xy_to_world(cx + ox, cy + oy))

    casts = _terrain_raycast_batch(scene, raycast_points) if raycast_points else []

    plinth_vertex_z: list[float] | None = None
    if conform_to_terrain:
        parent_z = float(parent.location.z)
        plinth_vertex_z = []
        for k in range(plinth_idx_range[0], plinth_idx_range[1]):
            world_z, hit = casts[k]
            plinth_vertex_z.append((world_z if hit else 0.0) - parent_z)

    plinth_mesh, _ = _build_downtown_plinth_mesh(
        f"{name}_plinth_data",
        blocks_x=blocks_x,
        blocks_y=blocks_y,
        block_size=block_size,
        street_width=street_width,
        vertex_z=plinth_vertex_z,
    )
    plinth_obj = bpy.data.objects.new(f"{name}_plinth", plinth_mesh)
    plinth_obj.parent = parent
    plinth_obj.matrix_parent_inverse.identity()
    plinth_obj["kind"] = "track"
    plinth_obj.data.materials.append(_ensure_downtown_sidewalk_material())
    plinth_obj.data.materials.append(_ensure_downtown_road_material())
    scene.collection.objects.link(plinth_obj)

    def _seat_for_corners(slot: int) -> tuple[float, float]:
        """Return ``(local_base_z, extra_depth)`` for the 4 corners
        starting at ``slot``. Base sits at the highest corner so the
        building's exposed silhouette starts at the uphill grade;
        extra_depth sinks the bottom face below the lowest corner so
        the downhill side is buried in the slope."""
        if slot < 0:
            return 0.0, 0.0
        zs = [casts[slot + i][0] for i in range(4) if casts[slot + i][1]]
        if not zs:
            return -float(parent.location.z), 0.0
        lowest = min(zs)
        highest = max(zs)
        local_base = highest - float(parent.location.z)
        extra = highest - lowest + 0.5
        return local_base, max(extra, 0.0)

    n_buildings = 0
    for cell in cell_specs:
        if cell["skip"]:
            continue
        gx, gy = cell["gx"], cell["gy"]
        if cell["sub"]:
            slots = cell.get("_slots", [-1] * 4)
            for q, slot in zip(cell["quads"], slots):
                local_base = 0.0
                extra = 0.0
                if conform_to_terrain:
                    local_base, extra = _seat_for_corners(slot)
                bname = f"{name}_b{gx:02d}_{gy:02d}_{q['idx']}"
                me = _build_downtown_building_mesh(
                    f"{bname}_data",
                    footprint=q["footprint"],
                    height=q["height"],
                    has_setback=q["rh"] > 0.6,
                    extra_depth=extra,
                )
                obj = bpy.data.objects.new(bname, me)
                obj.parent = parent
                obj.matrix_parent_inverse.identity()
                obj.location = (q["local_xy"][0], q["local_xy"][1], local_base)
                obj["kind"] = "track"
                obj.data.materials.append(
                    _ensure_downtown_building_material(int(q["rh"] * 60) + q["idx"])
                )
                scene.collection.objects.link(obj)
                n_buildings += 1
        else:
            local_base = 0.0
            extra = 0.0
            if conform_to_terrain:
                local_base, extra = _seat_for_corners(cell.get("_slot", -1))
            bname = f"{name}_b{gx:02d}_{gy:02d}"
            me = _build_downtown_building_mesh(
                f"{bname}_data",
                footprint=cell["footprint"],
                height=cell["height"],
                has_setback=cell["rh"] > 0.45,
                extra_depth=extra,
            )
            obj = bpy.data.objects.new(bname, me)
            obj.parent = parent
            obj.matrix_parent_inverse.identity()
            obj.location = (cell["local_xy"][0], cell["local_xy"][1], local_base)
            obj["kind"] = "track"
            obj.data.materials.append(
                _ensure_downtown_building_material(int(cell["rh"] * 60))
            )
            scene.collection.objects.link(obj)
            n_buildings += 1

    return parent, n_buildings


# ────────────────────────────────────────────────────────────────────
# Operator
# ────────────────────────────────────────────────────────────────────


class KINGTIDE_OT_add_downtown(Operator):
    """Spawn a procedural downtown city-block at the 3D cursor.

    Builds a parent ``downtown_NN`` empty plus a flat plinth + a grid
    of placeholder building boxes (mixed heights, occasional top-
    floor setbacks, a handful of empty plazas to break the
    silhouette). All children carry ``kind="track"`` so the runtime
    collider attaches at GLB-load time — the bike can rake across the
    streets and slap into the towers.

    Pulls all dimensions from the panel:

      Blocks X/Y      — grid extent in city blocks.
      Block size (m)  — edge length of each block (bigger = bigger towers).
      Street (m)      — gap between adjacent blocks.
      Min/Max h (m)   — random height range per building.
      Seed            — integer that drives layout randomness.

    Re-poses to (and rotates by) the 3D cursor so a Cursor → Spline
    (or Cursor → Helper) before invocation drops the city centred on
    the racing line."""

    bl_idname = "kingtide.add_downtown"
    bl_label = "Add Downtown"
    bl_description = "Spawn a placeholder city-block grid at the 3D cursor"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        bx = int(getattr(scene, "hoverbike_downtown_blocks_x", 6))
        by = int(getattr(scene, "hoverbike_downtown_blocks_y", 6))
        block_size = float(getattr(scene, "hoverbike_downtown_block_size", 30.0))
        street = float(getattr(scene, "hoverbike_downtown_street_width", 8.0))
        h_min = float(getattr(scene, "hoverbike_downtown_height_min", 18.0))
        h_max = float(getattr(scene, "hoverbike_downtown_height_max", 80.0))
        seed = int(getattr(scene, "hoverbike_downtown_seed", 1))
        conform = bool(getattr(scene, "hoverbike_downtown_conform", True))
        if bx <= 0 or by <= 0 or block_size <= 0 or h_max <= h_min:
            self.report(
                {"ERROR"},
                "Invalid downtown dimensions — fix grid / size / height range first.",
            )
            return {"CANCELLED"}

        cursor = scene.cursor
        parent, n = _generate_downtown(
            scene,
            location=tuple(cursor.location),
            rotation_z=float(cursor.rotation_euler.z),
            blocks_x=bx,
            blocks_y=by,
            block_size=block_size,
            street_width=street,
            height_min=h_min,
            height_max=h_max,
            seed=seed,
            conform_to_terrain=conform,
        )

        # Select the parent so the next G/R/S keystroke moves the whole
        # downtown at once.
        for o in context.selected_objects:
            o.select_set(False)
        parent.select_set(True)
        context.view_layer.objects.active = parent

        span_x = bx * (block_size + street) - street
        span_y = by * (block_size + street) - street
        self.report(
            {"INFO"},
            f"Added {parent.name}: {bx}×{by} blocks, {n} buildings, "
            f"footprint ~{span_x:.0f}×{span_y:.0f} m.",
        )
        return {"FINISHED"}


def _find_downtown_parent(context) -> bpy.types.Object | None:
    """Walk up parents from the active object until we find a
    ``kind="downtown"`` empty. Returns the empty, or ``None`` if the
    user has nothing downtown-adjacent selected."""
    obj = context.view_layer.objects.active
    while obj is not None:
        if obj.get("kind") == "downtown":
            return obj
        obj = obj.parent
    return None


def _purge_downtown_children(parent: bpy.types.Object) -> None:
    """Delete every child of ``parent`` (plinths + buildings) plus any
    orphaned meshes they leave behind. Leaves the parent empty intact
    so its transform + custom props can be reused."""
    children = list(parent.children_recursive)
    meshes: list[bpy.types.Mesh] = []
    for ch in children:
        if ch.type == "MESH" and ch.data is not None:
            meshes.append(ch.data)
        bpy.data.objects.remove(ch, do_unlink=True)
    for me in meshes:
        if me.users == 0:
            bpy.data.meshes.remove(me)


class KINGTIDE_OT_pick_downtown_settings(Operator):
    """Load the active downtown's stored parameters into the panel
    sliders so the user can edit from current values rather than from
    defaults. Reads from custom properties stamped on the parent
    ``downtown_NN`` empty (``seed``, ``blocks_x``, ``blocks_y``,
    ``block_size``, ``street_width``, ``height_min``, ``height_max``,
    ``conform_to_terrain``).

    Works from any descendant — selecting a building, plinth, or the
    empty itself all resolve to the same downtown."""

    bl_idname = "kingtide.pick_downtown_settings"
    bl_label = "Pick Downtown Settings"
    bl_description = (
        "Load the active downtown's stored params (blocks/spacing/heights/seed) "
        "into the panel sliders so they can be edited before clicking Rebuild"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        parent = _find_downtown_parent(context)
        if parent is None:
            self.report({"ERROR"}, "Select a downtown block first (parent empty or any child).")
            return {"CANCELLED"}
        scene = context.scene
        for src_key, dst_attr, caster in (
            ("blocks_x",           "hoverbike_downtown_blocks_x",      int),
            ("blocks_y",           "hoverbike_downtown_blocks_y",      int),
            ("block_size",         "hoverbike_downtown_block_size",    float),
            ("street_width",       "hoverbike_downtown_street_width",  float),
            ("height_min",         "hoverbike_downtown_height_min",    float),
            ("height_max",         "hoverbike_downtown_height_max",    float),
            ("seed",               "hoverbike_downtown_seed",          int),
            ("conform_to_terrain", "hoverbike_downtown_conform",       bool),
        ):
            if src_key in parent.keys():
                try:
                    setattr(scene, dst_attr, caster(parent[src_key]))
                except (TypeError, ValueError):
                    pass
        self.report({"INFO"}, f"Loaded settings from {parent.name}.")
        return {"FINISHED"}


class KINGTIDE_OT_rebuild_downtown(Operator):
    """Regenerate the active downtown using the panel's current
    spacing / block-size / height / seed values, preserving the
    parent empty's location + rotation. Deletes the existing
    children, builds fresh ones, stamps new params back onto the
    parent.

    Works from any descendant — select a building, a plinth, or the
    empty itself. Combine with *Pick Settings* to grab the current
    values, tweak a slider, then Rebuild."""

    bl_idname = "kingtide.rebuild_downtown"
    bl_label = "Rebuild Downtown"
    bl_description = (
        "Regenerate the selected downtown's buildings + plinth using the "
        "current panel sliders, keeping the parent empty's position + rotation"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        parent = _find_downtown_parent(context)
        if parent is None:
            self.report({"ERROR"}, "Select a downtown block first (parent empty or any child).")
            return {"CANCELLED"}

        scene = context.scene
        bx = int(getattr(scene, "hoverbike_downtown_blocks_x", 6))
        by = int(getattr(scene, "hoverbike_downtown_blocks_y", 6))
        block_size = float(getattr(scene, "hoverbike_downtown_block_size", 30.0))
        street = float(getattr(scene, "hoverbike_downtown_street_width", 8.0))
        h_min = float(getattr(scene, "hoverbike_downtown_height_min", 18.0))
        h_max = float(getattr(scene, "hoverbike_downtown_height_max", 80.0))
        seed = int(getattr(scene, "hoverbike_downtown_seed", 1))
        conform = bool(getattr(scene, "hoverbike_downtown_conform", True))
        if bx <= 0 or by <= 0 or block_size <= 0 or h_max <= h_min:
            self.report(
                {"ERROR"},
                "Invalid downtown dimensions — fix grid / size / height range first.",
            )
            return {"CANCELLED"}

        _purge_downtown_children(parent)
        _, n = _generate_downtown(
            scene,
            location=tuple(parent.location),
            rotation_z=float(parent.rotation_euler.z),
            blocks_x=bx,
            blocks_y=by,
            block_size=block_size,
            street_width=street,
            height_min=h_min,
            height_max=h_max,
            seed=seed,
            conform_to_terrain=conform,
            existing_parent=parent,
        )

        for o in context.selected_objects:
            o.select_set(False)
        parent.select_set(True)
        context.view_layer.objects.active = parent

        self.report(
            {"INFO"},
            f"Rebuilt {parent.name}: {bx}×{by} blocks, {n} buildings.",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    KINGTIDE_OT_add_downtown,
    KINGTIDE_OT_pick_downtown_settings,
    KINGTIDE_OT_rebuild_downtown,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.Scene.hoverbike_downtown_blocks_x = IntProperty(
        name="Blocks X",
        description="Number of city blocks along the parent's local +X.",
        default=6, min=1, max=40,
    )
    bpy.types.Scene.hoverbike_downtown_blocks_y = IntProperty(
        name="Blocks Y",
        description="Number of city blocks along the parent's local +Y.",
        default=6, min=1, max=40,
    )
    bpy.types.Scene.hoverbike_downtown_block_size = FloatProperty(
        name="Block size (m)",
        description="Edge length of one city block (the building footprint envelope per cell).",
        default=30.0, min=4.0, max=200.0, precision=1,
    )
    bpy.types.Scene.hoverbike_downtown_street_width = FloatProperty(
        name="Street (m)",
        description="Gap between adjacent blocks. Plinth + asphalt fills these.",
        default=8.0, min=1.0, max=40.0, precision=1,
    )
    bpy.types.Scene.hoverbike_downtown_height_min = FloatProperty(
        name="Min h (m)",
        description="Lower bound on per-building height. ~10 m = three storeys.",
        default=18.0, min=2.0, max=500.0, precision=1,
    )
    bpy.types.Scene.hoverbike_downtown_height_max = FloatProperty(
        name="Max h (m)",
        description="Upper bound on per-building height. ~80 m = ~25-storey mid-rise.",
        default=80.0, min=4.0, max=2000.0, precision=1,
    )
    bpy.types.Scene.hoverbike_downtown_seed = IntProperty(
        name="Seed",
        description="Layout seed. Same seed + dimensions produces identical city blocks.",
        default=1, min=0, max=10000,
    )
    bpy.types.Scene.hoverbike_downtown_conform = BoolProperty(
        name="Conform to terrain",
        description=(
            "Raycast each building onto the terrain mesh; sink the bottom face below the lowest "
            "footprint corner so a building on a slope steps into the hill instead of floating "
            "on stilts. Plinth subdivides + per-vertex follows the grade. Off = legacy flat behaviour."
        ),
        default=True,
    )


def unregister() -> None:
    for prop in (
        "hoverbike_downtown_blocks_x",
        "hoverbike_downtown_blocks_y",
        "hoverbike_downtown_block_size",
        "hoverbike_downtown_street_width",
        "hoverbike_downtown_height_min",
        "hoverbike_downtown_height_max",
        "hoverbike_downtown_seed",
        "hoverbike_downtown_conform",
    ):
        try:
            delattr(bpy.types.Scene, prop)
        except AttributeError:
            pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
