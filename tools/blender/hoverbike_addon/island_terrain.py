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
import sys

import bpy
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
            f"Spawned {terrain.name} with HV_Island modifier and "
            f"{spawned_peaks} new peak control(s) "
            f"(total {_peak_pair_count()} peak pair(s) in scene).",
        )
        return {"FINISHED"}


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
# Registration
# ────────────────────────────────────────────────────────────────────


_CLASSES: tuple[type, ...] = (HOVERBIKE_OT_add_island_terrain,)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
