"""Biome-palette scatter (Proposal A from the scatter redesign).

A single scene-wide scatter that reads the terrain's painted biome map
(``COLOR_0.A`` mirrored into the ``baked_biome`` FLOAT attribute) and
routes points into per-biome prop collections. One palette per track;
the author picks a source collection + density for each of deep /
seafloor / beach / jungle, and the GN graph does the rest — no
``scatter_NN`` empties to position, no flat surface plane to shrinkwrap.

  scatter_biome_palette         (Empty, organiser + Add-op target)
   └─ scatter_biome_palette_surf (Mesh, near-empty; HV_BiomePalette mod)

The modifier reads geometry from the terrain object via the GN graph's
``Terrain`` Object socket — the surf mesh exists only so the modifier
has an owner and the InstanceOnPoints output rides through
``EXT_mesh_gpu_instancing`` at export (the glTF extension requires the
instanced mesh to be a child of an Empty).

Live editing: per-biome density / source / size / path-wear-avoid live
directly on the modifier sockets. The panel writes them via
``layout.prop(modifier, '["<socket>"]')`` so edits re-evaluate the
viewport immediately — no Refresh button, unlike the older
``HV_Scatter`` flow.

Prerequisite: ``baked_biome`` exists on the terrain mesh. The Add
operator creates it with a default value of 1.0 (jungle) so a fresh
terrain scatters *something* on day one; running *Apply Terrain Vertex
Colors* on the terrain populates the real per-vertex biome from world Z.
"""

from __future__ import annotations

import os

import bpy
from bpy.props import StringProperty
from bpy.types import Operator, Panel


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

BIOME_PALETTE_EMPTY_NAME = "scatter_biome_palette"
BIOME_PALETTE_SURF_NAME = "scatter_biome_palette_surf"
BIOME_PALETTE_GROUP_NAME = "HV_BiomePalette"
BIOME_PALETTE_MOD_NAME = "HV_BiomePalette"
PROPS_LIBRARY_RELPATH = os.path.join("tracks-src", "props-library.blend")

# Ordered to match BIOME_PALETTE_BUCKETS in seed_props_library.py — the
# panel walks this list and the operator seeds defaults from it.
#
# Defaults pick palms for jungle (tropical island default), no source
# for the other three so an author hasn't accidentally seeded a track
# with kelp before they've thought about it. They get a stub row on the
# panel that says "Pick a source ▾".
BIOMES = (
    # (display, default source collection name, default density)
    #
    # Densities are per m² of terrain face area — so a 1 km² terrain
    # sees ~5000 jungle palms at the default 0.005 jungle density,
    # sparse-forest feel. Defaults match the seed's
    # BIOME_PALETTE_BUCKETS; bumping them in one place without the
    # other is harmless (the seed sets the socket default, this table
    # is what the Add operator writes), but the seed values are what
    # an author sees in a freshly-linked HV_BiomePalette modifier
    # before the operator runs, so keep them in lock-step.
    ("Deep",     None,        0.000),
    ("Seafloor", None,        0.005),
    ("Beach",    "prop_palm", 0.002),
    ("Jungle",   "prop_palm", 0.005),
)


# Proposal B — per-biome paint masks. The GN graph in
# seed_props_library.py reads ``mask_<biome>`` via Named Attribute and
# multiplies it into the per-biome density factor. Initialising each
# group to weight 1.0 on every vert at palette-creation time means
# unpainted terrain scatters A's density unchanged; painting reduces
# scatter in that region without touching A's biome routing.
#
# Names mirror BIOME_PALETTE_BUCKETS[..][5] in seed_props_library.py;
# bumping one without the other breaks the live link.
BIOME_MASK_NAMES = {
    "Deep":     "mask_deep",
    "Seafloor": "mask_seafloor",
    "Beach":    "mask_beach",
    "Jungle":   "mask_jungle",
}


# ────────────────────────────────────────────────────────────────────
# Helpers — link the library group + ensure prereq attributes exist
# ────────────────────────────────────────────────────────────────────


def _repo_root_from_blend() -> str | None:
    """The dir holding ``tracks-src/`` (where ``props-library.blend`` lives),
    derived from the open .blend. Returns ``None`` if it can't be resolved —
    every caller treats that as "library unreachable" and bails with a clear
    error. Honors authoring outside the repo, e.g. a Drive-synced
    ``tracks-src/``. See ``_legacy.assets_root_from_blend``."""
    from ._legacy import assets_root_from_blend

    return assets_root_from_blend(bpy.data.filepath)


def _ensure_node_group() -> bpy.types.NodeTree | None:
    """Link ``HV_BiomePalette`` from ``tracks-src/props-library.blend``.
    Returns the existing block if already linked or local."""
    existing = bpy.data.node_groups.get(BIOME_PALETTE_GROUP_NAME)
    if existing is not None:
        return existing
    repo = _repo_root_from_blend()
    if repo is None:
        return None
    library_path = os.path.join(repo, PROPS_LIBRARY_RELPATH)
    if not os.path.isfile(library_path):
        return None
    with bpy.data.libraries.load(library_path, link=True) as (data_from, data_to):
        if BIOME_PALETTE_GROUP_NAME not in data_from.node_groups:
            return None
        data_to.node_groups = [BIOME_PALETTE_GROUP_NAME]
    return bpy.data.node_groups.get(BIOME_PALETTE_GROUP_NAME)


def _ensure_source_collection(name: str | None) -> bpy.types.Collection | None:
    """Link a ``prop_*`` collection from the props library. ``None``
    name means "this biome has no default source" — return None and the
    operator leaves the socket empty."""
    if not name:
        return None
    existing = bpy.data.collections.get(name)
    if existing is not None:
        return existing
    repo = _repo_root_from_blend()
    if repo is None:
        return None
    library_path = os.path.join(repo, PROPS_LIBRARY_RELPATH)
    if not os.path.isfile(library_path):
        return None
    with bpy.data.libraries.load(library_path, link=True) as (data_from, data_to):
        if name not in data_from.collections:
            return None
        data_to.collections = [name]
    return bpy.data.collections.get(name)


def _resolve_terrain(context: bpy.types.Context) -> bpy.types.Object | None:
    """Pick the terrain mesh the palette should read from. Prefer the
    active selection when it's a MESH so an author can target an
    alternate terrain explicitly; fall back to bake.py's resolver so
    `terrain` / largest kind=track mesh works without re-selecting."""
    ao = context.active_object
    if ao is not None and ao.type == "MESH" and ao.name not in (
        BIOME_PALETTE_SURF_NAME,
        BIOME_PALETTE_EMPTY_NAME,
    ):
        return ao
    # Lazy import — bake.py is already a sibling module so this is free
    # at register-time; just avoiding a load-order knot.
    from .bake import _resolve_terrain as _bake_resolve

    return _bake_resolve()


def _ensure_mask_groups(terrain: bpy.types.Object) -> int:
    """Make sure the four per-biome paint-mask vertex groups exist on
    ``terrain``, initialised to weight 1.0 on every vertex. The GN
    graph reads them as FLOAT named attributes and multiplies them into
    the per-biome density factor — weight 1.0 means "A unchanged,"
    weight 0.0 means "no scatter here," anywhere between thins.

    Idempotent — pre-existing groups are left alone (so an author's
    painted suppression survives palette re-adds). Returns the number
    of groups freshly created on this call.

    Vertex groups (not arbitrary FLOAT attributes) because Blender's
    Weight Paint mode is the canonical "paint a scalar on a mesh" UX,
    and the GN graph reads vertex groups by name through the same
    Named Attribute node it'd use for any FLOAT — the only difference
    visible from the graph side is which mesh-data slot the values
    live in.
    """
    created = 0
    n_verts = len(terrain.data.vertices)
    all_indices = list(range(n_verts))
    for group_name in BIOME_MASK_NAMES.values():
        vg = terrain.vertex_groups.get(group_name)
        if vg is not None:
            continue
        vg = terrain.vertex_groups.new(name=group_name)
        # REPLACE = set the weight outright (vs ADD which accumulates).
        # An unweighted vert reads as 0 through Named Attribute, so we
        # need every vert in the group at 1.0 for the unpainted default
        # to be "A unchanged."
        if n_verts:
            vg.add(all_indices, 1.0, "REPLACE")
        created += 1
    return created


def _ensure_baked_biome(terrain: bpy.types.Object) -> bool:
    """Make sure ``baked_biome`` exists on the terrain mesh so the GN
    graph reads non-default values. Returns True if the attribute was
    already present, False if we had to create a default stub.

    The default stub is biome=1.0 (jungle) for every vertex — the same
    convention ``_ensure_baked_attrs`` uses, so a fresh terrain scatters
    the Jungle slot until the author runs *Apply Terrain Vertex Colors*
    to compute the real per-vert biome from world-Z."""
    from .bake import BAKED_BIOME_ATTR, _ensure_baked_attrs

    me = terrain.data
    if BAKED_BIOME_ATTR in me.attributes:
        return True
    _ensure_baked_attrs(terrain)
    return False


# ────────────────────────────────────────────────────────────────────
# Spawn / bind / apply defaults
# ────────────────────────────────────────────────────────────────────


def _socket_name_map(group: bpy.types.NodeTree) -> dict[str, str]:
    """Map the GN group's input socket *names* to their *identifiers*
    (``Input_3`` etc.) so the caller can use ``modifier[ident] = value``
    to write socket defaults. Same trick scatter.py uses."""
    out: dict[str, str] = {}
    for item in group.interface.items_tree:
        if (
            getattr(item, "in_out", None) == "INPUT"
            and getattr(item, "item_type", None) == "SOCKET"
        ):
            out[item.name] = item.identifier
    return out


def _apply_palette_inputs(
    modifier: bpy.types.NodesModifier,
    *,
    terrain: bpy.types.Object,
    seed_defaults: bool,
) -> None:
    """Bind the modifier's Terrain socket to ``terrain``. When
    ``seed_defaults`` is True, also seed every per-biome Source +
    Density socket with the BIOMES table — used the first time the
    palette is created. Subsequent operator runs (re-adds) leave the
    sockets alone so an author's tuning isn't blown away."""
    group = modifier.node_group
    if group is None:
        return
    ids = _socket_name_map(group)

    def _set(name: str, value) -> None:
        ident = ids.get(name)
        if ident is None:
            return
        try:
            modifier[ident] = value
        except (TypeError, ValueError, RuntimeError):
            pass

    _set("Terrain", terrain)
    if not seed_defaults:
        return

    for display, default_source_name, default_density in BIOMES:
        source = _ensure_source_collection(default_source_name)
        _set(f"{display} Source", source)
        _set(f"{display} Density", float(default_density))
    _set("Size Min", 0.85)
    _set("Size Max", 1.20)
    _set("Path Wear Avoid", 1.0)
    _set("AO Floor", 0.0)
    _set("Seed", 0)


def _ensure_palette(
    context: bpy.types.Context,
    terrain: bpy.types.Object,
) -> tuple[bpy.types.Object, bpy.types.Object, bpy.types.NodesModifier, bool] | None:
    """Return ``(empty, surf, modifier, was_created)`` for the palette
    pair, creating it if missing. ``None`` means the props library
    couldn't be linked (caller surfaces an error).
    """
    group = _ensure_node_group()
    if group is None:
        return None

    empty = bpy.data.objects.get(BIOME_PALETTE_EMPTY_NAME)
    surf = bpy.data.objects.get(BIOME_PALETTE_SURF_NAME)
    was_created = empty is None

    if empty is None:
        empty = bpy.data.objects.new(BIOME_PALETTE_EMPTY_NAME, None)
        empty.empty_display_type = "ARROWS"
        empty.empty_display_size = 6.0
        # Mirror scatter.py's conventions — the empty itself ships as a
        # decoration node (so the runtime doesn't try to collide with
        # it) and carries a marker custom prop the panel/test can find.
        empty["kind"] = "decoration"
        empty["biome_palette"] = True
        context.scene.collection.objects.link(empty)

    if surf is None:
        # Near-empty single-vertex mesh — the modifier reads the terrain
        # via Object Info, not from this mesh's data. A non-empty mesh
        # would risk Distribute Points sampling on it instead.
        me = bpy.data.meshes.new(f"{BIOME_PALETTE_SURF_NAME}_mesh")
        me.vertices.add(1)
        surf = bpy.data.objects.new(BIOME_PALETTE_SURF_NAME, me)
        surf.parent = empty
        surf.matrix_parent_inverse.identity()
        # kind=decoration so attachTrackColliders skips the surf at runtime.
        surf["kind"] = "decoration"
        context.scene.collection.objects.link(surf)

    # Ensure the modifier exists and points at HV_BiomePalette.
    mod = next(
        (
            m for m in surf.modifiers
            if m.type == "NODES"
            and getattr(m, "node_group", None) is not None
            and m.node_group.name == BIOME_PALETTE_GROUP_NAME
        ),
        None,
    )
    if mod is None:
        mod = surf.modifiers.new(name=BIOME_PALETTE_MOD_NAME, type="NODES")
        mod.node_group = group

    _apply_palette_inputs(mod, terrain=terrain, seed_defaults=was_created)
    return empty, surf, mod, was_created


# ────────────────────────────────────────────────────────────────────
# Operator — add or refresh the palette
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_add_biome_palette(Operator):
    """Drop the ``scatter_biome_palette`` Empty + sibling surf mesh and
    attach the HV_BiomePalette geometry-nodes modifier. Reads the
    terrain's painted biome map (``baked_biome``) and scatters one prop
    collection per biome bucket.

    Re-running on a scene that already has a palette re-binds the
    modifier's Terrain pointer to the currently active mesh, but leaves
    per-biome source / density settings alone — so an author tuning the
    palette can re-click without losing their work.

    Prerequisite: ``baked_biome`` exists on the terrain. The operator
    creates a default-1.0 stub when missing so the panel surfaces
    immediately; clicking *Apply Terrain Vertex Colors* on the terrain
    populates the real per-vert biome from world-Z.
    """

    bl_idname = "hoverbike.add_biome_palette"
    bl_label = "Add Biome Palette Scatter"
    bl_description = (
        "Drop a scene-wide biome palette scatter — reads COLOR_0.A on the "
        "terrain and routes Distribute Points samples into per-biome prop "
        "collections. Live-editable from the sidebar; no per-zone empties"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        terrain = _resolve_terrain(context)
        if terrain is None:
            self.report(
                {"ERROR"},
                "No terrain mesh found. Select a terrain mesh first, or "
                "make sure the scene has a 'terrain' object / a "
                "kind=track mesh.",
            )
            return {"CANCELLED"}

        had_biome = _ensure_baked_biome(terrain)
        masks_created = _ensure_mask_groups(terrain)

        result = _ensure_palette(context, terrain)
        if result is None:
            self.report(
                {"ERROR"},
                "Couldn't link HV_BiomePalette from "
                "tracks-src/props-library.blend. Run `pnpm seed:props` "
                "(or re-save this .blend inside a hoverbike clone) and "
                "try again.",
            )
            return {"CANCELLED"}
        empty, surf, _mod, was_created = result

        for o in context.selected_objects:
            o.select_set(False)
        empty.select_set(True)
        context.view_layer.objects.active = empty

        verb = "Added" if was_created else "Re-bound"
        biome_note = (
            ""
            if had_biome
            else " — baked_biome stub created (default jungle); "
            "click Apply Terrain Vertex Colors to populate per-vert biomes from Z"
        )
        mask_note = (
            f", {masks_created} mask group(s) initialised at 1.0"
            if masks_created
            else ""
        )
        self.report(
            {"INFO"},
            f"{verb} biome palette on {terrain.name!r}{mask_note}{biome_note}.",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Mask paint operators (Proposal B)
# ────────────────────────────────────────────────────────────────────


def _resolve_terrain_for_mask() -> bpy.types.Object | None:
    """The mask operators need to find *the* terrain rather than the
    currently-active mesh — clicking "Edit Jungle mask" while the
    palette empty is selected should still drop you into paint mode on
    the terrain. Prefer the Terrain socket the palette modifier already
    binds; fall back to the standard resolver."""
    surf = bpy.data.objects.get(BIOME_PALETTE_SURF_NAME)
    if surf is not None:
        for mod in surf.modifiers:
            if (
                mod.type == "NODES"
                and getattr(mod, "node_group", None) is not None
                and mod.node_group.name == BIOME_PALETTE_GROUP_NAME
            ):
                ids = _socket_name_map(mod.node_group)
                t_ident = ids.get("Terrain")
                if t_ident is not None:
                    try:
                        bound = mod[t_ident]
                    except (KeyError, RuntimeError):
                        bound = None
                    if isinstance(bound, bpy.types.Object) and bound.type == "MESH":
                        return bound
    from .bake import _resolve_terrain as _bake_resolve

    return _bake_resolve()


class HOVERBIKE_OT_edit_biome_mask(Operator):
    """Switch to Weight Paint mode on the named biome's mask vertex
    group. Defaults to weight 1.0 everywhere ("A unchanged"); paint
    down to suppress scatter in that region, paint up to restore.

    Multi-biome painting workflow: clicking Edit mask on a different
    biome row swaps the active group (no need to exit paint mode
    first). Press Tab in the viewport to return to Object Mode."""

    bl_idname = "hoverbike.edit_biome_mask"
    bl_label = "Edit Biome Mask"
    bl_description = (
        "Switch to Weight Paint on this biome's mask vertex group. "
        "Paint to thin or remove scatter in that region — unpainted "
        "(weight 1) leaves the biome palette's density untouched"
    )
    bl_options = {"REGISTER", "UNDO"}

    biome: StringProperty(  # type: ignore[valid-type]
        name="Biome",
        description="Display name of the biome row (Deep / Seafloor / Beach / Jungle)",
    )

    def execute(self, context):
        group_name = BIOME_MASK_NAMES.get(self.biome)
        if group_name is None:
            self.report({"ERROR"}, f"unknown biome row {self.biome!r}")
            return {"CANCELLED"}

        terrain = _resolve_terrain_for_mask()
        if terrain is None:
            self.report({"ERROR"}, "no terrain mesh resolved")
            return {"CANCELLED"}

        # Lazy-init the group on demand if the palette was added before
        # mask support landed (a track .blend saved with v1 then opened
        # under v2). Idempotent on the common path.
        _ensure_mask_groups(terrain)

        # Select + activate the terrain so the mode switch lands on it.
        for o in context.selected_objects:
            o.select_set(False)
        terrain.select_set(True)
        context.view_layer.objects.active = terrain

        # Make the right vertex group active before entering the mode —
        # Weight Paint reads `vertex_groups.active_index` to choose what
        # the brush writes into.
        group_idx = terrain.vertex_groups.find(group_name)
        if group_idx >= 0:
            terrain.vertex_groups.active_index = group_idx

        if context.mode != "PAINT_WEIGHT":
            try:
                bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
            except RuntimeError as e:
                self.report({"WARNING"}, f"couldn't enter Weight Paint: {e}")
                return {"CANCELLED"}

        self.report(
            {"INFO"},
            f"Editing {group_name} on {terrain.name!r} — paint down to suppress, "
            "Tab returns to Object Mode",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_clear_biome_mask(Operator):
    """Reset a biome row's paint mask to weight 1.0 on every vertex —
    same effect as "no mask" but keeps the vertex group around so the
    GN graph's Named Attribute still resolves."""

    bl_idname = "hoverbike.clear_biome_mask"
    bl_label = "Clear Biome Mask"
    bl_description = "Reset this biome's mask to weight 1.0 everywhere (undo all paint)"
    bl_options = {"REGISTER", "UNDO"}

    biome: StringProperty()  # type: ignore[valid-type]

    def execute(self, context):
        group_name = BIOME_MASK_NAMES.get(self.biome)
        if group_name is None:
            self.report({"ERROR"}, f"unknown biome row {self.biome!r}")
            return {"CANCELLED"}

        terrain = _resolve_terrain_for_mask()
        if terrain is None:
            self.report({"ERROR"}, "no terrain mesh resolved")
            return {"CANCELLED"}

        n_verts = len(terrain.data.vertices)
        vg = terrain.vertex_groups.get(group_name)
        if vg is None:
            # Missing group — create it at the default (no-op suppression).
            _ensure_mask_groups(terrain)
            self.report({"INFO"}, f"Created {group_name} at weight 1.0 on {n_verts} verts")
            return {"FINISHED"}

        vg.add(list(range(n_verts)), 1.0, "REPLACE")
        self.report({"INFO"}, f"Reset {group_name} to 1.0 on {n_verts} verts")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Panel — selection-driven (terrain or the palette empty/surf)
# ────────────────────────────────────────────────────────────────────


def _resolve_palette_modifier() -> bpy.types.NodesModifier | None:
    """Look up the active HV_BiomePalette modifier in the scene, or
    None if no palette exists yet. Called by the panel's draw() to
    decide between the empty-state ("Add palette") and live-edit UIs."""
    surf = bpy.data.objects.get(BIOME_PALETTE_SURF_NAME)
    if surf is None:
        return None
    return next(
        (
            m for m in surf.modifiers
            if m.type == "NODES"
            and getattr(m, "node_group", None) is not None
            and m.node_group.name == BIOME_PALETTE_GROUP_NAME
        ),
        None,
    )


def _is_palette_selection_target(obj: bpy.types.Object | None) -> bool:
    """True when the active selection should surface the biome-palette
    panel: the palette empty, the surf, or any plausible terrain mesh.
    The panel still draws an empty-state placeholder when no palette
    exists yet, so we surface generously on MESH selections."""
    if obj is None:
        return False
    if obj.name in (BIOME_PALETTE_EMPTY_NAME, BIOME_PALETTE_SURF_NAME):
        return True
    if obj.type != "MESH":
        return False
    # Mesh selections: surface for likely-terrain objects (named
    # 'terrain', or kind=track). Otherwise stay quiet — selecting an
    # unrelated mesh shouldn't open the palette panel.
    if obj.name == "terrain":
        return True
    return str(obj.get("kind", "")) == "track"


class HOVERBIKE_PT_track_biome_palette(Panel):
    """Sidebar panel for the biome-palette scatter. Surfaces when the
    user has a terrain mesh selected (or the palette objects). Lets the
    author pick a source collection + density per biome, plus the global
    path-wear / AO gates."""

    bl_label = "Biome scatter"
    bl_idname = "HOVERBIKE_PT_track_biome_palette"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Hoverbike"
    bl_parent_id = "HOVERBIKE_PT_panel"
    bl_options = {"DEFAULT_CLOSED"}

    @classmethod
    def poll(cls, context):
        from ._legacy import detect_mode

        if detect_mode(bpy.data.filepath) != "track":
            return False
        return _is_palette_selection_target(context.active_object)

    def draw(self, context):
        layout = self.layout
        modifier = _resolve_palette_modifier()

        if modifier is None:
            # Empty state: no palette in the scene yet.
            box = layout.box()
            col = box.column(align=True)
            col.label(text="No biome palette in scene.", icon="OUTLINER_OB_POINTCLOUD")
            col.label(text="Auto-scatter per painted biome.")
            col.separator(factor=0.5)
            col.operator(
                "hoverbike.add_biome_palette",
                text="Add Biome Palette Scatter",
                icon="ADD",
            )
            return

        group = modifier.node_group
        if group is None:
            layout.label(text="Modifier has no node group", icon="ERROR")
            return

        ids = _socket_name_map(group)

        def _row(label: str, key: str, *, icon: str = "NONE", text: str | None = None) -> None:
            """Draw one modifier-socket row. ``text=""`` suppresses the
            stock label so the row's icon + caller's label do the talking."""
            ident = ids.get(key)
            if ident is None:
                return
            r = layout.row(align=True)
            if icon != "NONE":
                r.label(text=label, icon=icon)
            else:
                r.label(text=label)
            r.prop(modifier, f'["{ident}"]', text=text if text is not None else "")

        # ── Header: which terrain is bound, missing-biome hint ──────
        terrain_ident = ids.get("Terrain")
        terrain_obj = None
        if terrain_ident is not None:
            try:
                terrain_obj = modifier[terrain_ident]
            except (KeyError, RuntimeError):
                terrain_obj = None
        header = layout.row(align=True)
        if terrain_obj is None:
            header.alert = True
            header.label(text="Terrain not bound", icon="ERROR")
            header.operator(
                "hoverbike.add_biome_palette",
                text="Re-bind",
                icon="FILE_REFRESH",
            )
        else:
            header.label(text=f"Terrain: {terrain_obj.name}", icon="MESH_GRID")
            header.operator(
                "hoverbike.add_biome_palette",
                text="",
                icon="FILE_REFRESH",
            )

        # Prereq hint — baked_biome must be present on the terrain.
        if terrain_obj is not None:
            from .bake import BAKED_BIOME_ATTR

            if BAKED_BIOME_ATTR not in terrain_obj.data.attributes:
                hint = layout.box()
                hint.alert = True
                col = hint.column(align=True)
                col.label(text="baked_biome attribute missing", icon="INFO")
                col.label(text="Apply Vertex Colors first → real biome map")

        # ── Mode hint when actively painting ────────────────────────
        if context.mode == "PAINT_WEIGHT":
            active_obj = context.active_object
            active_vg = (
                active_obj.vertex_groups.active.name
                if active_obj is not None and active_obj.vertex_groups.active is not None
                else "<none>"
            )
            paint_box = layout.box()
            paint_box.label(
                text=f"Painting: {active_vg}",
                icon="BRUSH_DATA",
            )
            paint_box.label(
                text="Tab in viewport → back to Object Mode",
                icon="INFO",
            )

        # ── Per-biome rows ──────────────────────────────────────────
        layout.separator()
        layout.label(text="Per-biome scatter sources", icon="OUTLINER_COLLECTION")
        for display, _default_src, _default_density in BIOMES:
            box = layout.box()
            row = box.row(align=True)
            row.label(text=display, icon=_BIOME_ICONS.get(display, "WORLD"))
            sub = box.row(align=True)
            sub.scale_y = 0.9
            _row("Source", f"{display} Source", text="")
            _row("Density (/m²)", f"{display} Density", text="")
            # Per-biome paint mask (Proposal B) — multiplies into the
            # row's density factor. The Edit button switches to Weight
            # Paint with the right vertex group active; Clear resets
            # the group to 1.0 on every vert.
            mask_row = box.row(align=True)
            mask_row.scale_y = 0.9
            op = mask_row.operator(
                "hoverbike.edit_biome_mask",
                text="Edit mask",
                icon="BRUSH_DATA",
            )
            op.biome = display
            op = mask_row.operator(
                "hoverbike.clear_biome_mask",
                text="Clear",
                icon="X",
            )
            op.biome = display

        # ── Globals ─────────────────────────────────────────────────
        layout.separator()
        layout.label(text="Globals", icon="SETTINGS")
        _row("Size min", "Size Min", text="")
        _row("Size max", "Size Max", text="")
        _row("Path-wear avoid", "Path Wear Avoid", text="")
        _row("AO floor", "AO Floor", text="")
        _row("Seed", "Seed", text="")


# Tiny visual cue per biome — icons that read at-a-glance from the
# stock Blender icon set. Tuned for readability inside small panel
# rows; no perfect mapping (Blender doesn't ship a "beach" icon) but
# good enough for the row identification its job is.
_BIOME_ICONS = {
    "Deep":     "MOD_OCEAN",
    "Seafloor": "MOD_SMOOTH",
    "Beach":    "MESH_PLANE",
    "Jungle":   "OUTLINER_OB_GREASEPENCIL",
}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_add_biome_palette,
    HOVERBIKE_OT_edit_biome_mask,
    HOVERBIKE_OT_clear_biome_mask,
    HOVERBIKE_PT_track_biome_palette,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
