"""Spawn a procedural-island template terrain in-place.

This is the addon-side companion to ``tools/blender/seed_template_island.py``.
The seed script is a stand-alone scaffolder that nukes the scene and
writes ``tracks-src/template-island.blend`` from scratch (run via
``blender --background --python ...``). That's the right tool when
you want a *fresh* island map.

This module wraps the seed script's individual builders so an author
can drop a fresh island terrain into an *existing* scene without
losing their current work — pick the operator, get a 1024×1024 m
subdivided plane with the ``HV_Island`` Geometry Nodes modifier and
four default peak control empties. Material + node groups + peaks
are reused if they're already present from a prior run.

Loads the seed module lazily by file path. Two resolution strategies:

1. Walk up from this file's ``__file__`` to find ``tools/blender/``
   in the same tree — works when the addon is symlinked to the repo
   (the standard ``pnpm install:blender-addon`` install).
2. Fall back to ``find_repo_root(bpy.data.filepath)`` — works when
   the addon was copy-installed but the .blend is saved inside a
   hoverbike clone.

If neither resolves, the operator reports an error explaining why
and refuses to run.
"""

from __future__ import annotations

import importlib.util
import os
import random
import sys

import bpy
from bpy.props import FloatProperty, IntProperty
from bpy.types import Operator


SEED_MODULE_NAME = "hoverbike_seed_template_island"
SEED_FILE_BASENAME = "seed_template_island.py"

# Names the seed script writes — used by the operator to detect prior
# runs and reuse existing assets rather than spawn .001 duplicates.
TERRAIN_OBJECT_NAME = "terrain"
HV_PEAK_PROFILE_GROUP = "HV_PeakProfile"
HV_TEMPLATE_ISLAND_GROUP = "HV_TemplateIsland"


# ────────────────────────────────────────────────────────────────────
# Seed-script loader
# ────────────────────────────────────────────────────────────────────


def _candidate_seed_paths() -> list[str]:
    """Return ordered list of paths where the seed script might live.
    First entry is the most reliable (relative to this file); subsequent
    entries are fallbacks for the copy-install case."""
    paths: list[str] = []

    # Strategy 1 — relative to the addon module's own real path.
    # Symlink installs resolve back to the repo's tools/blender/
    # directory; copy installs don't, but this is cheap to try first.
    try:
        addon_real = os.path.realpath(__file__)
        # __file__ → .../tools/blender/hoverbike_addon/island_terrain.py
        # parent[2] → .../tools/blender/
        seed = os.path.join(os.path.dirname(os.path.dirname(addon_real)), SEED_FILE_BASENAME)
        paths.append(seed)
    except OSError:
        pass

    # Strategy 2 — climb from the open .blend's path to a repo root.
    blend = bpy.data.filepath
    if blend:
        from ._legacy import find_repo_root

        repo = find_repo_root(blend)
        if repo:
            paths.append(os.path.join(repo, "tools", "blender", SEED_FILE_BASENAME))

    return paths


def _load_seed_module() -> object | None:
    """Import the seed script as a Python module. Cached in
    ``sys.modules`` under :data:`SEED_MODULE_NAME` so subsequent calls
    are cheap.

    Returns the loaded module or ``None`` if no candidate path resolves
    to an existing file.

    The seed script is guarded by ``if __name__ == "__main__":`` so
    importing it doesn't fire ``seed()`` — we only get the builder
    functions and the module-level constants (``PEAKS``, ``TILE_SIZE``)."""
    existing = sys.modules.get(SEED_MODULE_NAME)
    if existing is not None:
        return existing

    for candidate in _candidate_seed_paths():
        if not os.path.isfile(candidate):
            continue
        spec = importlib.util.spec_from_file_location(SEED_MODULE_NAME, candidate)
        if spec is None or spec.loader is None:
            continue
        mod = importlib.util.module_from_spec(spec)
        sys.modules[SEED_MODULE_NAME] = mod
        try:
            spec.loader.exec_module(mod)
        except Exception:
            # Clean up the partial entry so a later call can try again.
            sys.modules.pop(SEED_MODULE_NAME, None)
            raise
        return mod

    return None


# ────────────────────────────────────────────────────────────────────
# Operator
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_add_island_terrain(Operator):
    """Spawn a 1024×1024 m subdivided plane with the ``HV_Island``
    Geometry Nodes modifier attached, plus four default peak control
    empties (one central volcano w/ crater, two flanking peaks, one
    submerged shoal). Same procedural setup ``template-island.blend``
    ships with — but dropped into the current scene rather than a
    fresh .blend.

    Idempotent on parts that already exist:

    * Refuses to run if an object named ``terrain`` is already in the
      scene. (Delete or rename the existing one first.)
    * Reuses ``HV_PeakProfile`` + ``HV_TemplateIsland`` node groups if
      already present (saves the ~700-line rebuild).
    * Skips peak empties that already exist with the expected names.

    After it finishes the new terrain is selected + active so the
    Terrain N-panel opens for follow-up sculpting / shader knobs."""

    bl_idname = "hoverbike.add_island_terrain"
    bl_label = "Add Island Terrain (template)"
    bl_description = (
        "Spawn a procedural volcanic-island terrain in the current scene: "
        "1024×1024 m plane + HV_Island modifier + 4 peak control empties"
    )
    bl_options = {"REGISTER", "UNDO"}

    # Re-rolled in ``invoke`` so every fresh menu / button click produces a
    # different-looking island. Exposed on the F9 redo panel so authors can
    # type a specific value (or just dial through with the arrow keys) when
    # they want a repeatable seed. Matches the modifier socket's [0, 999]
    # range so any seed the operator picks is also reachable from the
    # modifier panel afterward.
    seed: IntProperty(
        name="Noise Seed",
        description=(
            "Initial value written into the HV_Island modifier's Noise Seed "
            "input. Decorrelates global background noise, cone erosion, ring "
            "break, seafloor billow and land billow so two terrains with "
            "identical peaks still look different. Re-rolled randomly on each "
            "fresh invocation; adjust via F9 to lock in a specific value"
        ),
        default=0, min=0, max=999,
    )  # type: ignore[valid-type]

    def invoke(self, context: bpy.types.Context, event) -> set[str]:
        # Fresh click → fresh seed. The F9 redo panel keeps whatever value
        # ``execute`` ran with, so users can tune after the fact.
        self.seed = random.randint(0, 999)
        return self.execute(context)

    def execute(self, context: bpy.types.Context) -> set[str]:
        # Block obvious foot-guns up-front so a half-built result isn't
        # left behind on failure.
        if bpy.data.objects.get(TERRAIN_OBJECT_NAME) is not None:
            self.report(
                {"ERROR"},
                f"An object named '{TERRAIN_OBJECT_NAME}' already exists. "
                "Delete or rename it before adding a new template terrain.",
            )
            return {"CANCELLED"}

        try:
            seed = _load_seed_module()
        except Exception as e:  # noqa: BLE001 — surface whatever the loader raised
            self.report({"ERROR"}, f"Loading seed_template_island.py failed: {e}")
            return {"CANCELLED"}

        if seed is None:
            self.report(
                {"ERROR"},
                "Could not locate seed_template_island.py. Save the .blend "
                "inside a hoverbike clone, or re-run `pnpm install:blender-addon` "
                "to symlink the addon to the repo.",
            )
            return {"CANCELLED"}

        # Build the terrain mesh first — the seed's helper handles the
        # subdivided plane, the kind="track" tag, and the COLOR_0 /
        # baked_ao / baked_path vertex attributes the GN graph reads.
        try:
            terrain = seed.build_terrain_mesh()
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"build_terrain_mesh() failed: {e}")
            return {"CANCELLED"}

        # Node groups — reuse if already present (a prior run, or the
        # author imported them from another .blend). The seed's
        # build_*_group functions unconditionally make new ones, which
        # would produce .001-suffixed duplicates and break the modifier
        # wiring; bypass them when reuse is possible.
        existing_sub = bpy.data.node_groups.get(HV_PEAK_PROFILE_GROUP)
        sub = existing_sub if existing_sub is not None else seed.build_peak_profile_group()

        existing_ng = bpy.data.node_groups.get(HV_TEMPLATE_ISLAND_GROUP)
        ng = existing_ng if existing_ng is not None else seed.build_template_island_group(sub)

        mod = seed.attach_modifier(terrain, ng)

        # Spawn the default peak empties — skip any that already exist
        # so a re-run on a partially-built scene doesn't double-stamp.
        # The seed's add_peaks() walks PEAKS unconditionally, so we
        # replicate the loop here with the existence check inline.
        spawned_peaks = _add_missing_peaks(seed)
        seed.bind_peak_inputs(mod, ng)
        _set_modifier_input(mod, ng, "Noise Seed", float(self.seed))

        # Slap on the preview material so the new terrain doesn't read
        # default-pink while the author is iterating. The runtime
        # ships its own terrain shader — this is author-only.
        try:
            seed.build_terrain_material(terrain)
        except Exception as e:  # noqa: BLE001
            # Material is preview-only — a failure here shouldn't tear
            # down the whole operator. Log and continue.
            self.report(
                {"WARNING"},
                f"Built terrain but preview material failed: {e}",
            )

        # Make the new terrain the active selection so the Terrain
        # N-panel opens automatically and Sculpt Mode entry is one
        # click away.
        for o in context.view_layer.objects:
            o.select_set(False)
        terrain.select_set(True)
        context.view_layer.objects.active = terrain

        self.report(
            {"INFO"},
            f"Spawned {terrain.name} with HV_Island modifier (seed={self.seed}) "
            f"and {spawned_peaks} new peak control(s) "
            f"(total {_peak_pair_count()} peak pair(s) in scene).",
        )
        return {"FINISHED"}


def _set_modifier_input(
    mod: bpy.types.Modifier,
    ng: bpy.types.NodeTree,
    socket_name: str,
    value,
) -> bool:
    """Write ``value`` into the NodesModifier's input matching ``socket_name``.

    Modifier inputs aren't keyed by name — they're keyed by the socket's
    auto-generated identifier (e.g. ``"Input_42"``). Mirrors the same
    interface walk that ``seed.bind_peak_inputs`` does. Returns False if
    the socket isn't found, so a later refactor that renames sockets
    doesn't silently no-op."""
    for item in ng.interface.items_tree:
        if getattr(item, "item_type", None) != "SOCKET":
            continue
        if getattr(item, "in_out", None) != "INPUT":
            continue
        if item.name == socket_name:
            mod[item.identifier] = value
            return True
    return False


def _add_missing_peaks(seed) -> int:
    """Spawn any of the seed's default peak pairs that don't already
    exist. Returns the count of newly-spawned base/top pairs.

    Mirrors the body of ``seed.add_peaks()`` but guards each pair with
    an existence check so re-running the operator on a partially-built
    scene doesn't double-stamp. The constraint wiring (top.location is
    additive to base via Copy Location) matches the seed exactly so
    the resulting empties behave the same as a fresh seed run."""
    spawned = 0
    for idx, base_loc, radius, top_local, crater in seed.PEAKS:
        base_name = f"peak_{idx}_base"
        top_name = f"peak_{idx}_top"
        if base_name in bpy.data.objects or top_name in bpy.data.objects:
            continue

        base = bpy.data.objects.new(base_name, None)
        base.empty_display_type = "SPHERE"
        base.empty_display_size = 1.0
        base.location = base_loc
        base.scale = (radius, radius, 0.0)
        base["kind"] = "peak_base"
        bpy.context.scene.collection.objects.link(base)

        top = bpy.data.objects.new(top_name, None)
        top.empty_display_type = "SPHERE"
        top.empty_display_size = 5.0
        top.location = top_local
        top.scale = (1.0, 1.0, crater)
        top["kind"] = "peak_top"
        bpy.context.scene.collection.objects.link(top)

        con = top.constraints.new("COPY_LOCATION")
        con.target = base
        con.use_offset = True
        con.use_x = True
        con.use_y = True
        con.use_z = True
        spawned += 1
    return spawned


def _peak_pair_count() -> int:
    """Count of peak_NN_base/_top pairs (matched names) in the scene."""
    bases = {n[5:-5] for n in bpy.data.objects.keys() if n.startswith("peak_") and n.endswith("_base")}
    tops = {n[5:-4] for n in bpy.data.objects.keys() if n.startswith("peak_") and n.endswith("_top")}
    return len(bases & tops)


# ────────────────────────────────────────────────────────────────────
# Mod zone — non-destructive local bump
# ────────────────────────────────────────────────────────────────────


def find_island_modifier(obj: bpy.types.Object | None) -> bpy.types.Modifier | None:
    """First NODES modifier on ``obj`` whose node group is HV_TemplateIsland,
    or None. Used by the mod-zone operator to confirm the active terrain
    actually runs the procedural-island graph (vs. a heightmap-imported
    mesh with no procedural layer to wire mod zones into).

    Tolerates ``obj is None`` so the panel can use it as a one-liner
    visibility check without guarding the lookup itself."""
    if obj is None:
        return None
    for m in obj.modifiers:
        if m.type != "NODES":
            continue
        ng = m.node_group
        if ng is not None and ng.name == HV_TEMPLATE_ISLAND_GROUP:
            return m
    return None


def _collect_mod_slots(ng: bpy.types.NodeTree) -> dict[int, str]:
    """Map ``Mod N`` socket index → identifier. Empty dict means the node
    group predates the mod-zone refactor and needs re-seeding."""
    out: dict[int, str] = {}
    for item in ng.interface.items_tree:
        if getattr(item, "item_type", None) != "SOCKET":
            continue
        if getattr(item, "in_out", None) != "INPUT":
            continue
        name = item.name
        if not name.startswith("Mod "):
            continue
        suffix = name[4:]
        if not suffix.isdigit():
            continue
        out[int(suffix)] = item.identifier
    return out


class HOVERBIKE_OT_add_island_mod_zone(Operator):
    """Spawn a ``mod_NN`` empty at the 3D cursor and auto-bind it to the
    next free ``Mod N`` slot on the active terrain's HV_Island modifier.

    Mod zones are the non-destructive way to fine-tune local features
    without touching the procedural base — drop one to raise a hidden
    sandbar, carve a tucked-away lagoon, or soften a peak's shoreline.
    The encoding on each empty:

    * ``location.xy`` — zone centre (worldspace).
    * ``location.z`` — bump amplitude in metres (positive raises,
      negative carves). The empty floats at +amplitude metres above the
      cursor on spawn, which makes the effect direction visually obvious.
    * ``scale.x`` — zone radius in metres (smoothstep falloff to 0).

    Drag the empty to move the zone, scale it to widen the radius, or
    drag its Z to retune the amplitude live. Delete the empty (or
    unbind its slot in the modifier panel) to revert with zero
    residue."""

    bl_idname = "hoverbike.add_island_mod_zone"
    bl_label = "Add Mod Zone"
    bl_description = (
        "Add a non-destructive local-bump empty at the 3D cursor and auto-bind it "
        "to the next free Mod N slot on the active terrain's HV_Island modifier"
    )
    bl_options = {"REGISTER", "UNDO"}

    amplitude: FloatProperty(
        name="Amplitude (m)",
        description=(
            "Bump height in metres. Positive raises the terrain (hill), negative "
            "carves it (basin / lagoon). Stored as the empty's location.z so the "
            "spawned empty floats at this height above the cursor — drag the empty "
            "in Z afterwards to tweak"
        ),
        default=10.0, min=-200.0, max=200.0, precision=1,
    )  # type: ignore[valid-type]
    radius: FloatProperty(
        name="Radius (m)",
        description=(
            "Zone radius in metres. Stored as the empty's scale.x; falloff is a "
            "smoothstep from full amplitude at the centre to zero at the radius"
        ),
        default=80.0, min=1.0, max=1000.0, precision=1,
    )  # type: ignore[valid-type]

    def execute(self, context: bpy.types.Context) -> set[str]:
        from ._legacy import _largest_terrain_mesh

        terrain = _largest_terrain_mesh()
        if terrain is None:
            self.report({"ERROR"}, "No terrain mesh found (kind=track).")
            return {"CANCELLED"}

        mod = find_island_modifier(terrain)
        if mod is None:
            self.report(
                {"ERROR"},
                f"'{terrain.name}' has no HV_Island modifier — mod zones only "
                "work on procedural-island terrains. Spawn one via 'Add Island "
                "Terrain' first.",
            )
            return {"CANCELLED"}

        slots = _collect_mod_slots(mod.node_group)
        if not slots:
            self.report(
                {"ERROR"},
                "HV_TemplateIsland node group has no Mod N slots — it predates "
                "the mod-zone refactor. Delete the node group (and HV_PeakProfile) "
                "and re-run 'Add Island Terrain' to rebuild with the new sockets, "
                "or re-seed the .blend via seed_template_island.py.",
            )
            return {"CANCELLED"}

        # Pick the lowest unbound slot so empties allocate predictably.
        free_slot = None
        for i in sorted(slots.keys()):
            if mod[slots[i]] is None:
                free_slot = i
                break
        if free_slot is None:
            self.report(
                {"ERROR"},
                f"All {len(slots)} Mod slots are bound. Clear one in the modifier "
                "panel (or delete its empty) before adding another.",
            )
            return {"CANCELLED"}

        # Find a free mod_NN name. Existing-name collisions just bump
        # the index — keeps the names stable even when slots get reused.
        idx = 0
        while bpy.data.objects.get(f"mod_{idx:02d}") is not None:
            idx += 1
        name = f"mod_{idx:02d}"

        cursor = context.scene.cursor.location
        empty = bpy.data.objects.new(name, None)
        empty.empty_display_type = "SPHERE"
        empty.empty_display_size = 1.0
        empty.location = (cursor.x, cursor.y, cursor.z + self.amplitude)
        empty.scale = (self.radius, self.radius, 1.0)
        empty["kind"] = "mod_zone"
        context.scene.collection.objects.link(empty)

        mod[slots[free_slot]] = empty

        # Mod empties belong in the Peaks collection alongside the other
        # terrain-shape controls if one exists; otherwise leave them in
        # the scene root.
        peaks_coll = bpy.data.collections.get("Peaks")
        if peaks_coll is not None and peaks_coll.name not in (c.name for c in empty.users_collection):
            for c in list(empty.users_collection):
                c.objects.unlink(empty)
            peaks_coll.objects.link(empty)

        for o in context.view_layer.objects:
            o.select_set(False)
        empty.select_set(True)
        context.view_layer.objects.active = empty

        self.report(
            {"INFO"},
            f"Added {name} → Mod {free_slot} "
            f"(amplitude {self.amplitude:+.1f} m, radius {self.radius:.0f} m). "
            f"Drag the empty to move / scale / re-amplify the zone live.",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_add_island_terrain,
    HOVERBIKE_OT_add_island_mod_zone,
)


_SCENE_PROP_NAMES: tuple[str, ...] = (
    "hoverbike_mod_zone_amplitude",
    "hoverbike_mod_zone_radius",
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.hoverbike_mod_zone_amplitude = FloatProperty(
        name="Mod zone Δz (m)",
        description=(
            "Default bump amplitude used by Add Mod Zone @ Cursor. Positive raises, "
            "negative carves. Stored as the empty's location.z so the spawned empty "
            "floats at this height above the cursor"
        ),
        default=10.0, min=-200.0, max=200.0, precision=1,
    )
    bpy.types.Scene.hoverbike_mod_zone_radius = FloatProperty(
        name="Mod zone radius (m)",
        description=(
            "Default zone radius used by Add Mod Zone @ Cursor. Stored as the "
            "empty's scale.x; smoothstep falloff to zero at the radius"
        ),
        default=80.0, min=1.0, max=1000.0, precision=1,
    )


def unregister() -> None:
    for prop in _SCENE_PROP_NAMES:
        try:
            delattr(bpy.types.Scene, prop)
        except AttributeError:
            pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
