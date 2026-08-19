"""Shared scatter-zone helpers for per-track seed scripts.

Phase β of [docs/level-visual-quality-research.md](../../docs/level-visual-quality-research.md):
the foliage / rock scatter system that turns barren tracks into populated
ones. The Geometry Nodes graph (``HV_Scatter``) lives in
``tracks-src/props-library.blend``; this module is the headless equivalent
of the addon's *Add Scatter Zone* operator.

A scatter zone is a tuple of inputs (centre, half-extents, density,
source prop collection, seed, plus optional slope/altitude/size knobs)
that materialises in the .blend as:

* a ``scatter_NN`` Empty (cube display, ``kind=decoration``,
  ``scatter_zone=True``), used by authoring as the organizer + the
  source-of-truth for the per-zone knobs;
* a ``scatter_NN_surf`` Mesh child — a flat grid sized to the zone's
  half-extents — carrying the ``HV_Scatter`` Geometry Nodes modifier
  with the zone's inputs wired through.

The graph's ``Instance on Points`` output ships through the glTF
exporter as ``EXT_mesh_gpu_instancing`` (closed by the realize pass in
``kingtide_addon/export.py``) and the runtime lifts it into one
``THREE.InstancedMesh`` per source archetype.

The per-track ``seed_track_<id>.py`` declares its scatter zones as a
tuple of dicts and calls :func:`drop_scatter_zones` from ``augment``.
South Beach is the reference implementation; Hatteras / Cape Town /
The Maw join it as Phase β step 7.
"""

from __future__ import annotations

import os

import bmesh
import bpy

# The default knob set, applied per-zone unless overridden. These mirror
# the addon operator's defaults so headless seeds match what an author
# would get clicking *Add Scatter Zone*.
DEFAULT_SLOPE_MAX_DEG = 90.0   # flat target — no slope filtering
DEFAULT_Z_MIN = -100.0
DEFAULT_Z_MAX = 500.0
DEFAULT_SIZE_MIN = 0.85
DEFAULT_SIZE_MAX = 1.20


def _link_collection(library_path: str, collection_name: str) -> bpy.types.Collection | None:
    """Link ``collection_name`` from ``library_path`` (if not already
    linked) and return it. Idempotent — re-runs return the existing
    linked block. Returns ``None`` if the library or collection is
    missing (caller logs + skips)."""
    existing = bpy.data.collections.get(collection_name)
    if existing is not None and existing.library is not None:
        return existing
    if not os.path.isfile(library_path):
        print(f"  WARN: library not found, skipping link: {library_path}")
        return None
    with bpy.data.libraries.load(library_path, link=True) as (data_from, data_to):
        if collection_name not in data_from.collections:
            print(f"  WARN: {collection_name!r} not in {library_path}, skipping")
            return None
        data_to.collections = [collection_name]
    return bpy.data.collections.get(collection_name)


def _ensure_scatter_node_group(props_library_path: str) -> bpy.types.NodeTree | None:
    """Link the shared ``HV_Scatter`` Geometry Nodes group from the props
    library if not already present. Linked-in graphs survive a save +
    re-open; ``Reload Library`` picks up edits without rewiring the
    per-zone modifiers."""
    g = bpy.data.node_groups.get("HV_Scatter")
    if g is not None:
        return g
    if not os.path.isfile(props_library_path):
        return None
    with bpy.data.libraries.load(props_library_path, link=True) as (data_from, data_to):
        if "HV_Scatter" not in data_from.node_groups:
            return None
        data_to.node_groups = ["HV_Scatter"]
    return bpy.data.node_groups.get("HV_Scatter")


def drop_scatter_zone(
    scene: bpy.types.Scene,
    props_library_path: str,
    spec: dict,
) -> bool:
    """Build a single ``scatter_NN`` Empty + target plane child driven by
    the shared ``HV_Scatter`` Geometry Nodes graph.

    ``spec`` keys:
      * ``name`` (str): unique empty name, e.g. ``"scatter_00"``.
      * ``location`` (3-tuple): world XYZ of the zone centre.
      * ``half_width`` / ``half_depth`` (float): zone footprint in m.
      * ``density`` (float): instances per m² fed into the GN graph.
      * ``source`` (str): props-library collection name
        (``"prop_palm"``, ``"prop_rock"``, ...).
      * ``seed`` (int): per-zone deterministic seed.
      * ``slope_max_deg`` (optional float, default 90): skip faces
        whose normal tilts past this angle.
      * ``z_min`` / ``z_max`` (optional float): altitude filter on the
        target surface.
      * ``size_min`` / ``size_max`` (optional float): per-instance
        random scale range.
      * ``rotation_deg`` (optional float, default 0): yaw of the zone
        empty so the surface grid can align to landmarks.

    Returns ``True`` if both the source collection and the ``HV_Scatter``
    graph linked successfully and the zone got built; ``False`` and a
    warning if either is missing (the rest of the augment pass keeps
    going)."""
    group = _ensure_scatter_node_group(props_library_path)
    if group is None:
        print(f"  WARN: HV_Scatter not available, skipping {spec['name']}")
        return False
    source = _link_collection(props_library_path, spec["source"])
    if source is None:
        print(f"  WARN: source collection {spec['source']!r} unavailable, skipping {spec['name']}")
        return False

    import math

    cx, cy, cz = spec["location"]
    hw = float(spec["half_width"])
    hd = float(spec["half_depth"])
    rotation_deg = float(spec.get("rotation_deg", 0.0))
    slope_max = float(spec.get("slope_max_deg", DEFAULT_SLOPE_MAX_DEG))
    z_min = float(spec.get("z_min", DEFAULT_Z_MIN))
    z_max = float(spec.get("z_max", DEFAULT_Z_MAX))
    size_min = float(spec.get("size_min", DEFAULT_SIZE_MIN))
    size_max = float(spec.get("size_max", DEFAULT_SIZE_MAX))

    # Empty — organizer + custom-prop knobs. These are the source of
    # truth for the addon's per-zone N-panel; the modifier inputs are
    # a parallel set of values driven from the same numbers.
    empty = bpy.data.objects.new(spec["name"], None)
    empty.empty_display_type = "CUBE"
    empty.empty_display_size = 4.0
    empty["kind"] = "decoration"
    empty["scatter_zone"] = True
    empty["density"] = float(spec["density"])
    empty["slope_max_deg"] = slope_max
    empty["z_min"] = z_min
    empty["z_max"] = z_max
    empty["size_min"] = size_min
    empty["size_max"] = size_max
    empty["seed"] = int(spec["seed"])
    empty["source_collection"] = spec["source"]
    empty.location = (cx, cy, cz)
    empty.rotation_euler = (0.0, 0.0, math.radians(rotation_deg))
    scene.collection.objects.link(empty)

    # Target surface — flat grid sized to half_width × half_depth. The
    # GN graph's *Distribute Points on Faces* uses this mesh as its
    # surface input; a 4×4 grid gives the distributor enough resolution
    # to vary point counts across the zone without going overboard on
    # vertex count.
    me = bpy.data.meshes.new(f"{spec['name']}_surf_mesh")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=4, y_segments=4, size=1.0, calc_uvs=False)
    bmesh.ops.scale(bm, vec=(hw, hd, 1.0), verts=bm.verts)
    bm.to_mesh(me)
    bm.free()
    me.update()
    surf = bpy.data.objects.new(f"{spec['name']}_surf", me)
    surf.parent = empty
    surf.matrix_parent_inverse.identity()
    surf["kind"] = "decoration"
    scene.collection.objects.link(surf)

    # Attach HV_Scatter and wire the inputs by *name* — the underlying
    # interface item identifiers (the keys Blender uses on the modifier)
    # are autogenerated and not stable across re-creations of the graph,
    # but the *labels* in the interface are author-controlled and stable.
    mod = surf.modifiers.new(name="HV_Scatter", type="NODES")
    mod.node_group = group
    interface = group.interface
    name_to_id = {}
    for item in interface.items_tree:
        if (
            getattr(item, "in_out", None) == "INPUT"
            and getattr(item, "item_type", None) == "SOCKET"
        ):
            name_to_id[item.name] = item.identifier

    def _set(label: str, value):
        ident = name_to_id.get(label)
        if ident is not None:
            try:
                mod[ident] = value
            except (TypeError, ValueError):
                pass

    _set("Source", source)
    _set("Density", float(spec["density"]))
    _set("Slope Max (deg)", slope_max)
    _set("Z Min", z_min)
    _set("Z Max", z_max)
    _set("Size Min", size_min)
    _set("Size Max", size_max)
    _set("Seed", int(spec["seed"]))
    return True


def drop_scatter_zones(
    scene: bpy.types.Scene,
    props_library_path: str,
    zones: tuple[dict, ...],
) -> int:
    """Drop every zone in ``zones`` via :func:`drop_scatter_zone`, returning
    the count of zones that actually built. A missing source collection
    or missing ``HV_Scatter`` group skips that zone with a warning rather
    than failing the whole augment pass — common when seeding against
    a stale props-library checkout."""
    placed = 0
    for spec in zones:
        if drop_scatter_zone(scene, props_library_path, spec):
            placed += 1
    return placed
