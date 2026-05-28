"""Seed ``tracks-src/template-terrain.blend`` — unified four-style terrain wrapper.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_template_terrain.py

Bundles the four per-style terrain templates (Island, Alpine, Dunes,
Mesa) under one ``HV_TemplateTerrain`` Geometry Nodes group. A menu
socket picks which style drives the terrain; an ``Additive`` toggle
controls whether every sub-group's Z displacement is clamped to
``max(0, z)`` before being added as an Offset (default True — the
intended stacking semantics for layering styles on top of each other).

### Refusal guard

This script REFUSES to overwrite an existing ``template-terrain.blend``.
Delete or rename the file first; the wrapper is meant to be re-seeded
manually rather than churned on every CI run.

### What lives in the produced .blend

* The four wrapper node groups: ``HV_TemplateIsland``,
  ``HV_TemplateAlpine``, ``HV_TemplateDunes``, ``HV_TemplateMesa``
  — built by calling each per-style seed module's
  ``build_template_*_group`` helper.
* Their three sub-profile groups: ``HV_PeakProfile``,
  ``HV_RidgeProfile``, ``HV_MesaProfile``.
* ``HV_TemplateTerrain`` — the new wrapper.
* A 1024 m × 1024 m subdivided plane named ``terrain`` carrying the
  ``HV_TemplateTerrain`` modifier, with ``Style`` defaulting to ``Island``.
* Driver empties seeded from each style's defaults:
  - 4 peak pairs (``peak_00_base`` / ``peak_00_top`` … ``peak_03_*``)
  - 2 ridge pairs (``ridge_00_a`` / ``ridge_00_b``, ``ridge_01_a/b``)
  - 1 oasis empty (``oasis_center``)
  - 4 mesa empties (``mesa_00`` … ``mesa_03``)

### Authoring loop

Open the blend, flip ``Style`` between Island / Alpine / Dunes / Mesa on
the modifier panel to swap heightfields. Toggle ``Additive`` to compare
destructive vs. additive offset. Drag the relevant style's empties to
reshape — peaks for Island, ridges for Alpine, the oasis for Dunes,
mesas for Mesa.
"""

from __future__ import annotations

import importlib
import os
import sys

import bmesh
import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

# Per-style seed modules. Each exposes ``build_*_group`` helpers we call
# inline so the produced .blend is self-contained (no library links).
seed_template_island = importlib.import_module("seed_template_island")
seed_template_alpine = importlib.import_module("seed_template_alpine")
seed_template_dunes  = importlib.import_module("seed_template_dunes")
seed_template_mesa   = importlib.import_module("seed_template_mesa")

OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "template-terrain.blend")

# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

TILE_SIZE = 1024.0
SUBDIV = 384

NODE_GROUP_NAME = "HV_TemplateTerrain"

STYLE_ITEMS = ("Island", "Alpine", "Dunes", "Mesa")
DEFAULT_STYLE = "Island"
DEFAULT_ADDITIVE = True

# Subsets of each per-style script's starter empties — the brief calls
# for 4 peak pairs, 2 ridge pairs, 1 oasis, 4 mesas in the combined
# scene. Drawn directly from the source modules' module-level defaults
# so any tweaks to those defaults flow through here automatically.
PEAKS_USED = seed_template_island.PEAKS[:4]
RIDGES_USED = seed_template_alpine.RIDGES[:2]
MESAS_USED = seed_template_mesa.MESAS[:4]
OASIS_CENTER = seed_template_dunes.OASIS_CENTER_DEFAULT


# ────────────────────────────────────────────────────────────────────
# Scene setup
# ────────────────────────────────────────────────────────────────────

def reset_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


def build_terrain_mesh() -> bpy.types.Object:
    """1024 m subdivided plane. Shape matches the per-style templates
    so authoring tools (terrain material, bake passes) work unchanged."""
    mesh = bpy.data.meshes.new("terrain_mesh")
    bm = bmesh.new()
    half = TILE_SIZE * 0.5
    v00 = bm.verts.new((-half, -half, 0))
    v10 = bm.verts.new(( half, -half, 0))
    v11 = bm.verts.new(( half,  half, 0))
    v01 = bm.verts.new((-half,  half, 0))
    bm.faces.new([v00, v10, v11, v01])
    bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=SUBDIV - 1, use_grid_fill=True)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    for poly in mesh.polygons:
        poly.use_smooth = True

    terrain = bpy.data.objects.new("terrain", mesh)
    bpy.context.scene.collection.objects.link(terrain)
    terrain["kind"] = "track"

    ao = mesh.attributes.new(name="baked_ao", type="FLOAT", domain="POINT")
    for i in range(len(ao.data)):
        ao.data[i].value = 1.0
    path = mesh.attributes.new(name="baked_path", type="FLOAT", domain="POINT")
    for i in range(len(path.data)):
        path.data[i].value = 0.0
    anchor = mesh.color_attributes.new(name="COLOR_0", type="FLOAT_COLOR", domain="POINT")
    for i in range(len(anchor.data)):
        anchor.data[i].color = (1.0, 1.0, 1.0, 1.0)
    mesh.color_attributes.active_color = anchor
    mesh.color_attributes.render_color_index = mesh.color_attributes.find("COLOR_0")
    return terrain


# ────────────────────────────────────────────────────────────────────
# Wrapper node group: HV_TemplateTerrain
# ────────────────────────────────────────────────────────────────────

def _add_node(group, kind, x, y, **kw):
    n = group.nodes.new(kind)
    n.location = (x, y)
    for k, v in kw.items():
        setattr(n, k, v)
    return n


def _copy_interface_to_panel(
    src_group: bpy.types.NodeTree,
    dst_group: bpy.types.NodeTree,
    panel: bpy.types.NodeTreeInterfacePanel,
    *,
    skip_names: set[str],
) -> dict[str, bpy.types.NodeTreeInterfaceSocket]:
    """Pass-through every non-Geometry INPUT socket from ``src_group``'s
    interface into ``dst_group``'s ``panel``, preserving name, type,
    default, and (where present) min/max. Returns a name → new-socket
    map so callers can wire by source name.

    ``skip_names`` filters out sockets that are handled at the wrapper
    level instead — Noise Seed (Shared panel) and Additive (top-level)
    are pulled out of every per-style panel so a single wrapper knob
    drives them all in parallel."""
    out: dict[str, bpy.types.NodeTreeInterfaceSocket] = {}
    for item in src_group.interface.items_tree:
        if getattr(item, "item_type", None) != "SOCKET":
            continue
        if getattr(item, "in_out", None) != "INPUT":
            continue
        if item.socket_type == "NodeSocketGeometry":
            continue
        if item.name in skip_names:
            continue
        new = dst_group.interface.new_socket(
            item.name,
            in_out="INPUT",
            socket_type=item.socket_type,
            parent=panel,
        )
        # Defaults / ranges — only the property types we use across the
        # four per-style interfaces (float, bool, object).
        if hasattr(item, "default_value") and hasattr(new, "default_value"):
            try:
                new.default_value = item.default_value
            except (TypeError, AttributeError):
                pass
        for attr in ("min_value", "max_value"):
            if hasattr(item, attr) and hasattr(new, attr):
                try:
                    setattr(new, attr, getattr(item, attr))
                except (TypeError, AttributeError):
                    pass
        out[item.name] = new
    return out


def _input_socket_by_identifier(p_in_node, identifier: str):
    """Look up an output socket on a NodeGroupInput node by interface
    identifier. We can't use ``p_in.outputs[name]`` because the wrapper
    has many sockets sharing display names across panels (e.g., both
    Island and Alpine declare "Cliff Width")."""
    for s in p_in_node.outputs:
        if s.identifier == identifier:
            return s
    raise KeyError(f"NodeGroupInput has no output with identifier {identifier!r}")


def build_template_terrain_group(
    ng_island: bpy.types.NodeTree,
    ng_alpine: bpy.types.NodeTree,
    ng_dunes:  bpy.types.NodeTree,
    ng_mesa:   bpy.types.NodeTree,
) -> bpy.types.NodeTree:
    """Construct the wrapper. Each per-style group is instanced once;
    a Menu Switch on Style picks which sub-group's geometry reaches the
    output. Additive and Noise Seed are wired in parallel to every
    sub-group so toggling them changes every style consistently."""
    if NODE_GROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[NODE_GROUP_NAME])
    g = bpy.data.node_groups.new(NODE_GROUP_NAME, "GeometryNodeTree")
    # Required for the GN modifier dropdown to show this group. The
    # four wrapped sub-groups stay is_modifier=True too (set in their
    # own builders) — that's fine, they just won't be attached as
    # modifiers in this scene.
    g.is_modifier = True

    # ── Top-level sockets ───────────────────────────────────────────
    g.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")

    style_socket = g.interface.new_socket(
        "Style", in_out="INPUT", socket_type="NodeSocketMenu",
    )
    style_socket.description = "Heightfield style: Island, Alpine, Dunes, or Mesa"

    additive_socket = g.interface.new_socket(
        "Additive", in_out="INPUT", socket_type="NodeSocketBool",
    )
    additive_socket.default_value = DEFAULT_ADDITIVE
    additive_socket.description = (
        "Clamp every sub-group's Z displacement to max(0, z) before "
        "applying as Offset, so styles can stack without mutual carving"
    )

    # ── Per-style panels ────────────────────────────────────────────
    # Each panel mirrors its source group's interface verbatim — same
    # socket names, same defaults, same ranges — minus the two sockets
    # that the wrapper exposes globally (Noise Seed under Shared,
    # Additive at top level).
    style_skip = {"Noise Seed", "Additive"}
    panel_island = g.interface.new_panel("Island", default_closed=True)
    sockets_island = _copy_interface_to_panel(ng_island, g, panel_island,
                                              skip_names=style_skip)
    panel_alpine = g.interface.new_panel("Alpine", default_closed=True)
    sockets_alpine = _copy_interface_to_panel(ng_alpine, g, panel_alpine,
                                              skip_names=style_skip)
    panel_dunes = g.interface.new_panel("Dunes", default_closed=True)
    sockets_dunes = _copy_interface_to_panel(ng_dunes, g, panel_dunes,
                                              skip_names=style_skip)
    panel_mesa = g.interface.new_panel("Mesa", default_closed=True)
    sockets_mesa = _copy_interface_to_panel(ng_mesa, g, panel_mesa,
                                              skip_names=style_skip)

    # ── Shared panel ────────────────────────────────────────────────
    # One Noise Seed feeds every sub-group's Noise Seed input so noise
    # variation is correlated across styles. Each sub-group still
    # offsets the seed internally for its own component noise layers.
    panel_shared = g.interface.new_panel("Shared")
    seed_socket = g.interface.new_socket(
        "Noise Seed", in_out="INPUT",
        socket_type="NodeSocketFloat", parent=panel_shared,
    )
    seed_socket.default_value = 0.0
    seed_socket.min_value = 0.0
    seed_socket.max_value = 1000.0

    g.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")

    # ── Nodes ───────────────────────────────────────────────────────
    p_in  = _add_node(g, "NodeGroupInput",   -1600,    0)
    p_out = _add_node(g, "NodeGroupOutput",   1600,    0)

    # Helper closure: resolve a (panel-namespaced) interface socket on
    # the wrapper to the corresponding output on this group's input
    # node. Used to feed every per-style sub-group instance.
    def out(socket) -> object:
        return _input_socket_by_identifier(p_in, socket.identifier)

    # One GeometryNodeGroup per style. They all receive the same input
    # geometry, the shared Noise Seed, and the same Additive toggle.
    sub_geom_outs: list = []
    for ng_sub, sockets_map, x, y_offset in [
        (ng_island, sockets_island, -1000,   400),
        (ng_alpine, sockets_alpine, -1000,   100),
        (ng_dunes,  sockets_dunes,  -1000,  -200),
        (ng_mesa,   sockets_mesa,   -1000,  -500),
    ]:
        inst = _add_node(g, "GeometryNodeGroup", x, y_offset)
        inst.node_tree = ng_sub
        # Input geometry — same plane for every sub-group; the Menu
        # Switch chooses the winner downstream.
        g.links.new(p_in.outputs["Geometry"], inst.inputs["Geometry"])
        # Wire each pass-through socket from the wrapper into the
        # corresponding input on the sub-group instance. We resolve the
        # wrapper-side socket by identifier (panel-namespaced) and the
        # sub-group-side input by name (the per-style interfaces have
        # no internal name collisions).
        for name, wrapper_socket in sockets_map.items():
            if name not in inst.inputs:
                # Defensive: a copy-through socket that the sub-group
                # doesn't actually expose. Shouldn't happen given how
                # _copy_interface_to_panel is built, but skip rather
                # than raise so a forward-compatible interface change
                # doesn't break the seed.
                continue
            g.links.new(out(wrapper_socket), inst.inputs[name])
        # Shared Noise Seed → every sub-group's Noise Seed.
        if "Noise Seed" in inst.inputs:
            g.links.new(out(seed_socket), inst.inputs["Noise Seed"])
        # Additive toggle → every sub-group's Additive.
        if "Additive" in inst.inputs:
            g.links.new(out(additive_socket), inst.inputs["Additive"])
        sub_geom_outs.append(inst.outputs["Geometry"])

    # ── Menu Switch ─────────────────────────────────────────────────
    # data_type="GEOMETRY" makes inputs[1..N] geometry sockets, one per
    # enum item, in the order they were added. The Menu input lives at
    # inputs[0] and accepts our wrapper's Style socket.
    n_menu = _add_node(g, "GeometryNodeMenuSwitch", 800, 0, data_type="GEOMETRY")
    # Wipe any defaults Blender created with the node, then add our four
    # styles in the order matching sub_geom_outs above.
    n_menu.enum_items.clear()
    for label in STYLE_ITEMS:
        n_menu.enum_items.new(label)
    # Wire the Style menu socket into the Menu input. Identifier-keyed
    # because we have many same-named sockets across panels.
    g.links.new(out(style_socket), n_menu.inputs[0])
    # Each enum item adds a typed input after the Menu socket (so the
    # geometry inputs are inputs[1..4]).
    for i, geom_out in enumerate(sub_geom_outs):
        g.links.new(geom_out, n_menu.inputs[i + 1])

    g.links.new(n_menu.outputs[0], p_out.inputs["Geometry"])

    # Set the default-displayed style AFTER the menu switch has its
    # enum items (the menu socket validates against the linked switch's
    # items, so setting it earlier risks a "value not in enum" error in
    # some Blender 4.x point releases).
    try:
        style_socket.default_value = DEFAULT_STYLE
    except (TypeError, AttributeError):
        # Older Blender 4.2 builds may not accept default_value on a
        # NodeSocketMenu interface socket — the modifier panel falls
        # back to the menu switch's active_index instead, so we set
        # that as a belt-and-braces default too.
        pass
    # active_index controls what shows when the modifier is first
    # added; default-display in the modifier panel keys off both this
    # and style_socket.default_value depending on Blender version.
    for i, label in enumerate(STYLE_ITEMS):
        if label == DEFAULT_STYLE:
            n_menu.active_index = i
            break

    return g


# ────────────────────────────────────────────────────────────────────
# Driver empties — copied from the per-style seed scripts
# ────────────────────────────────────────────────────────────────────

def add_peak_empties() -> None:
    """4 peak base/top pairs — same shape as seed_template_island.add_peaks
    but only the first 4 entries of PEAKS_USED."""
    for idx, base_loc, radius, top_local, crater in PEAKS_USED:
        base = bpy.data.objects.new(f"peak_{idx}_base", None)
        base.empty_display_type = "SPHERE"
        base.empty_display_size = 1.0
        base.location = base_loc
        base.scale = (radius, radius, 0.0)
        base["kind"] = "peak_base"
        bpy.context.scene.collection.objects.link(base)

        top = bpy.data.objects.new(f"peak_{idx}_top", None)
        top.empty_display_type = "SPHERE"
        top.empty_display_size = 5.0
        top.location = top_local
        top.scale = (1.0, 1.0, crater)
        top["kind"] = "peak_top"
        bpy.context.scene.collection.objects.link(top)

        # Copy-location so dragging the base moves the top with it (same
        # constraint setup as the standalone island seed).
        con = top.constraints.new("COPY_LOCATION")
        con.target = base
        con.use_offset = True
        con.use_x = True; con.use_y = True; con.use_z = True


def add_ridge_empties() -> None:
    """2 ridge pairs — first 2 entries of RIDGES_USED."""
    for idx, a_xyz, b_xyz, half_w in RIDGES_USED:
        a = bpy.data.objects.new(f"ridge_{idx}_a", None)
        a.empty_display_type = "CONE"
        a.empty_display_size = 8.0
        a.location = a_xyz
        a.scale = (half_w, half_w, 1.0)
        a["kind"] = "ridge_a"
        bpy.context.scene.collection.objects.link(a)

        b = bpy.data.objects.new(f"ridge_{idx}_b", None)
        b.empty_display_type = "CONE"
        b.empty_display_size = 8.0
        b.location = b_xyz
        b.scale = (half_w, half_w, 1.0)
        b["kind"] = "ridge_b"
        bpy.context.scene.collection.objects.link(b)


def add_oasis_empty() -> None:
    obj = bpy.data.objects.new("oasis_center", None)
    obj.empty_display_type = "SPHERE"
    obj.empty_display_size = 30.0
    obj.location = OASIS_CENTER
    obj["kind"] = "oasis_center"
    bpy.context.scene.collection.objects.link(obj)


def add_mesa_empties() -> None:
    """4 mesa empties — first 4 entries of MESAS_USED."""
    for idx, loc, radius in MESAS_USED:
        obj = bpy.data.objects.new(f"mesa_{idx}", None)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 5.0
        obj.location = loc
        obj.scale = (radius, radius, 1.0)
        obj["kind"] = "mesa"
        bpy.context.scene.collection.objects.link(obj)


# ────────────────────────────────────────────────────────────────────
# Modifier wiring
# ────────────────────────────────────────────────────────────────────

def attach_modifier(terrain: bpy.types.Object, ng: bpy.types.NodeTree) -> bpy.types.Modifier:
    for m in list(terrain.modifiers):
        if m.type == "NODES":
            terrain.modifiers.remove(m)
    mod = terrain.modifiers.new("HV_TemplateTerrain", "NODES")
    mod.node_group = ng
    return mod


def _socket_id_map(ng: bpy.types.NodeTree) -> dict[str, str]:
    """Flatten the wrapper's interface to a (panel-or-toplevel-name → identifier)
    map. Name collisions across panels are resolved by panel prefix:
    "Island/Cliff Width", "Alpine/Cliff Width". Top-level sockets keep
    their bare name."""
    out: dict[str, str] = {}
    panel_stack: list[bpy.types.NodeTreeInterfacePanel | None] = []

    def walk(items, panel_name: str | None):
        for item in items:
            if getattr(item, "item_type", None) == "PANEL":
                # Panels nest; recurse with the panel's name as prefix.
                walk(item.interface_items, item.name)
            elif (getattr(item, "item_type", None) == "SOCKET"
                  and getattr(item, "in_out", None) == "INPUT"):
                key = f"{panel_name}/{item.name}" if panel_name else item.name
                out[key] = item.identifier
    walk(ng.interface.items_tree, None)
    return out


def bind_modifier_inputs(mod: bpy.types.Modifier, ng: bpy.types.NodeTree) -> None:
    """Bind starter driver empties to the corresponding wrapper sockets.
    The wrapper exposes per-style sockets under panels (Island/Base 0,
    Alpine/Ridge 0A, etc.); ``_socket_id_map`` produces the lookup keys."""
    ids = _socket_id_map(ng)

    def bind(key: str, obj_name: str):
        obj = bpy.data.objects.get(obj_name)
        if obj is None or key not in ids:
            return
        mod[ids[key]] = obj

    # Island peaks
    for i, (idx, _, _, _, _) in enumerate(PEAKS_USED):
        bind(f"Island/Base {i}", f"peak_{idx}_base")
        bind(f"Island/Top {i}",  f"peak_{idx}_top")

    # Alpine ridges
    for i, (idx, _, _, _) in enumerate(RIDGES_USED):
        bind(f"Alpine/Ridge {i}A", f"ridge_{idx}_a")
        bind(f"Alpine/Ridge {i}B", f"ridge_{idx}_b")

    # Dunes oasis
    bind("Dunes/Oasis Center", "oasis_center")

    # Mesa plateaus
    for i, (idx, _, _) in enumerate(MESAS_USED):
        bind(f"Mesa/Mesa {i}", f"mesa_{idx}")


# ────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────

def seed() -> None:
    # Refuse to clobber an existing file. The wrapper bundles authoring
    # state from four sub-templates plus any in-place tuning the user
    # has done; we don't want a stray run to nuke that. Delete the
    # target file manually to opt in to a rebuild.
    if os.path.exists(OUTPUT_PATH):
        print(
            f"[seed-template-terrain] {OUTPUT_PATH} already exists; "
            "refusing to overwrite (delete or rename it to re-seed).",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"[seed-template-terrain] writing {OUTPUT_PATH}")

    reset_scene()
    terrain = build_terrain_mesh()

    # Build the per-style sub-groups and their wrapper groups by
    # delegating to each per-style module's helpers. They mutate
    # bpy.data.node_groups directly, so after these four calls the
    # .blend contains:
    #   HV_PeakProfile, HV_TemplateIsland,
    #   HV_RidgeProfile, HV_TemplateAlpine,
    #   HV_TemplateDunes (monolithic, no sub-group),
    #   HV_MesaProfile, HV_TemplateMesa.
    peak_sub  = seed_template_island.build_peak_profile_group()
    ng_island = seed_template_island.build_template_island_group(peak_sub)
    ridge_sub = seed_template_alpine.build_ridge_profile_group()
    ng_alpine = seed_template_alpine.build_template_alpine_group(ridge_sub)
    ng_dunes  = seed_template_dunes.build_template_dunes_group()
    mesa_sub  = seed_template_mesa.build_mesa_profile_group()
    ng_mesa   = seed_template_mesa.build_template_mesa_group(mesa_sub)

    ng_terrain = build_template_terrain_group(ng_island, ng_alpine, ng_dunes, ng_mesa)

    mod = attach_modifier(terrain, ng_terrain)

    add_peak_empties()
    add_ridge_empties()
    add_oasis_empty()
    add_mesa_empties()

    bind_modifier_inputs(mod, ng_terrain)

    bpy.context.view_layer.update()

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    print(f"[seed-template-terrain] done")


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        print(f"[seed-template-terrain] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
