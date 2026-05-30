"""Spawn the unified four-style ``HV_TemplateTerrain`` into the current scene.

Addon-side companion to ``tools/blender/seed_template_terrain.py`` — the
CLI seed that nukes the scene and writes ``tracks-src/template-terrain.blend``
from scratch. That seed is the right tool for a *fresh* multi-biome map;
this operator wraps the same builders so an author can drop the unified
terrain into an *existing* scene without losing their current work.

Where the sibling :mod:`island_terrain` operator only builds the island-
only ``HV_TemplateIsland`` group, this one builds the wrapper that holds
all four styles. The result is a single ``terrain`` plane carrying the
``HV_TemplateTerrain`` modifier, whose **Style** menu (Properties →
Modifier) swaps between Island / Alpine / Dunes / Mesa, plus every
style's driver empties (4 peak pairs, 2 ridge pairs, 1 oasis, 4 mesas).

Node groups + empties are reused if a prior run already created them, so
re-running doesn't spawn ``.001`` duplicates or break the modifier wiring.

Seed-module resolution mirrors :mod:`island_terrain` — walk up from this
file (the symlink install case), then fall back to ``find_repo_root`` on
the open ``.blend`` (the copy-install case). The seed script imports the
four per-style modules at load time, so ``tools/blender`` must end up on
``sys.path`` — which ``seed_template_terrain.py`` arranges for itself.
"""

from __future__ import annotations

import importlib.util
import os
import random
import sys

import bpy
from bpy.props import IntProperty
from bpy.types import Operator


SEED_MODULE_NAME = "hoverbike_seed_template_terrain"
SEED_FILE_BASENAME = "seed_template_terrain.py"

TERRAIN_OBJECT_NAME = "terrain"
HV_TEMPLATE_TERRAIN_GROUP = "HV_TemplateTerrain"


# ────────────────────────────────────────────────────────────────────
# Seed-script loader (mirrors island_terrain._load_seed_module)
# ────────────────────────────────────────────────────────────────────


def _candidate_seed_paths() -> list[str]:
    """Ordered paths where ``seed_template_terrain.py`` might live.
    First entry is relative to this file (symlink install); second is
    relative to a repo root resolved from the open ``.blend`` (copy
    install)."""
    paths: list[str] = []

    try:
        addon_real = os.path.realpath(__file__)
        # __file__ → .../tools/blender/hoverbike_addon/multibiome_terrain.py
        # parent[2] → .../tools/blender/
        seed = os.path.join(
            os.path.dirname(os.path.dirname(addon_real)), SEED_FILE_BASENAME
        )
        paths.append(seed)
    except OSError:
        pass

    blend = bpy.data.filepath
    if blend:
        from ._legacy import find_repo_root

        repo = find_repo_root(blend)
        if repo:
            paths.append(os.path.join(repo, "tools", "blender", SEED_FILE_BASENAME))

    return paths


def _load_seed_module() -> object | None:
    """Import ``seed_template_terrain.py`` as a module, cached in
    ``sys.modules`` under :data:`SEED_MODULE_NAME`. The seed is guarded
    by ``if __name__ == "__main__":`` so importing it only exposes the
    builder functions + constants — it doesn't fire ``seed()`` (which
    would reset the scene and write a file).

    Returns the module, or ``None`` if no candidate path resolves."""
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
            sys.modules.pop(SEED_MODULE_NAME, None)
            raise
        return mod

    return None


# ────────────────────────────────────────────────────────────────────
# Node-group reuse
# ────────────────────────────────────────────────────────────────────


def _reuse_or_build(name: str, build):
    """Return the existing node group ``name`` if present, else call
    ``build()`` to make it. The per-style ``build_*`` helpers remove and
    recreate their group unconditionally, which would orphan any modifier
    already pointing at the old datablock — so we skip them on reuse."""
    existing = bpy.data.node_groups.get(name)
    return existing if existing is not None else build()


def _build_or_reuse_groups(seed):
    """Build (or reuse) every node group the wrapper needs and return the
    finished ``HV_TemplateTerrain`` group. Delegates to the per-style
    seed modules the same way ``seed_template_terrain.seed()`` does."""
    si = seed.seed_template_island
    sa = seed.seed_template_alpine
    sd = seed.seed_template_dunes
    sm = seed.seed_template_mesa

    peak_sub = _reuse_or_build(si.PEAK_SUBGROUP_NAME, si.build_peak_profile_group)
    ng_island = _reuse_or_build(
        si.NODE_GROUP_NAME, lambda: si.build_template_island_group(peak_sub)
    )
    ridge_sub = _reuse_or_build(sa.RIDGE_SUBGROUP_NAME, sa.build_ridge_profile_group)
    ng_alpine = _reuse_or_build(
        sa.NODE_GROUP_NAME, lambda: sa.build_template_alpine_group(ridge_sub)
    )
    ng_dunes = _reuse_or_build(sd.NODE_GROUP_NAME, sd.build_template_dunes_group)
    mesa_sub = _reuse_or_build(sm.MESA_SUBGROUP_NAME, sm.build_mesa_profile_group)
    ng_mesa = _reuse_or_build(
        sm.NODE_GROUP_NAME, lambda: sm.build_template_mesa_group(mesa_sub)
    )

    return _reuse_or_build(
        seed.NODE_GROUP_NAME,
        lambda: seed.build_template_terrain_group(
            ng_island, ng_alpine, ng_dunes, ng_mesa
        ),
    )


# ────────────────────────────────────────────────────────────────────
# Driver empties (guarded — skip any that already exist by name)
# ────────────────────────────────────────────────────────────────────


def _spawn_missing_empties(seed) -> int:
    """Spawn the starter driver empties for every style, skipping any
    whose name already exists so a re-run doesn't double-stamp. Mirrors
    ``seed_template_terrain``'s ``add_*_empties`` (same names, transforms,
    ``kind`` tags, and the peak Copy-Location constraint) but with the
    existence guard inline. Returns the count of newly-spawned empties."""
    objs = bpy.data.objects
    link = bpy.context.scene.collection.objects.link
    spawned = 0

    # Island peaks — base footprint + apex, tied by Copy Location so
    # dragging the base drags the apex along.
    for idx, base_loc, radius, top_local, crater in seed.PEAKS_USED:
        base_name, top_name = f"peak_{idx}_base", f"peak_{idx}_top"
        if base_name in objs or top_name in objs:
            continue
        base = bpy.data.objects.new(base_name, None)
        base.empty_display_type = "SPHERE"
        base.empty_display_size = 1.0
        base.location = base_loc
        base.scale = (radius, radius, 0.0)
        base["kind"] = "peak_base"
        link(base)

        top = bpy.data.objects.new(top_name, None)
        top.empty_display_type = "SPHERE"
        top.empty_display_size = 5.0
        top.location = top_local
        top.scale = (1.0, 1.0, crater)
        top["kind"] = "peak_top"
        link(top)

        con = top.constraints.new("COPY_LOCATION")
        con.target = base
        con.use_offset = True
        con.use_x = con.use_y = con.use_z = True
        spawned += 1

    # Alpine ridges — two endpoint cones per ridge.
    for idx, a_xyz, b_xyz, half_w in seed.RIDGES_USED:
        a_name, b_name = f"ridge_{idx}_a", f"ridge_{idx}_b"
        if a_name in objs or b_name in objs:
            continue
        for name, xyz, kind in ((a_name, a_xyz, "ridge_a"), (b_name, b_xyz, "ridge_b")):
            e = bpy.data.objects.new(name, None)
            e.empty_display_type = "CONE"
            e.empty_display_size = 8.0
            e.location = xyz
            e.scale = (half_w, half_w, 1.0)
            e["kind"] = kind
            link(e)
        spawned += 1

    # Dunes oasis — single centre empty.
    if "oasis_center" not in objs:
        oasis = bpy.data.objects.new("oasis_center", None)
        oasis.empty_display_type = "SPHERE"
        oasis.empty_display_size = 30.0
        oasis.location = seed.OASIS_CENTER
        oasis["kind"] = "oasis_center"
        link(oasis)
        spawned += 1

    # Mesa plateaus.
    for idx, loc, radius in seed.MESAS_USED:
        name = f"mesa_{idx}"
        if name in objs:
            continue
        e = bpy.data.objects.new(name, None)
        e.empty_display_type = "SPHERE"
        e.empty_display_size = 5.0
        e.location = loc
        e.scale = (radius, radius, 1.0)
        e["kind"] = "mesa"
        link(e)
        spawned += 1

    return spawned


# ────────────────────────────────────────────────────────────────────
# Operator
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_add_multibiome_terrain(Operator):
    """Spawn a 1024×1024 m subdivided plane with the ``HV_TemplateTerrain``
    modifier — the unified four-style group whose **Style** menu swaps the
    terrain between Island / Alpine / Dunes / Mesa — plus every style's
    starter driver empties.

    Idempotent on parts that already exist:

    * Refuses to run if an object named ``terrain`` is already in the
      scene. (Delete or rename it first.)
    * Reuses the per-style node groups + the wrapper if already present.
    * Skips driver empties that already exist with the expected names.

    After it finishes the new terrain is selected + active. Flip **Style**
    in the modifier panel to compare heightfields; drag the relevant
    style's empties (peaks for Island, ridges for Alpine, the oasis for
    Dunes, mesas for Mesa) to reshape it."""

    bl_idname = "hoverbike.add_multibiome_terrain"
    bl_label = "Add Multi-Biome Terrain (template)"
    bl_description = (
        "Spawn the unified HV_TemplateTerrain in the current scene: a "
        "1024×1024 m plane whose Style menu swaps between Island / Alpine "
        "/ Dunes / Mesa, plus every style's driver empties"
    )
    bl_options = {"REGISTER", "UNDO"}

    # Re-rolled on every fresh invocation (see island_terrain for the same
    # pattern); exposed on the F9 redo panel so a specific seed can be
    # dialled in. Written into the wrapper's shared Noise Seed input.
    seed: IntProperty(
        name="Noise Seed",
        description=(
            "Initial value written into the HV_TemplateTerrain modifier's "
            "shared Noise Seed input. Re-rolled randomly on each fresh "
            "invocation; adjust via F9 to lock in a specific value"
        ),
        default=0, min=0, max=999,
    )  # type: ignore[valid-type]

    def invoke(self, context: bpy.types.Context, event) -> set[str]:
        self.seed = random.randint(0, 999)
        return self.execute(context)

    def execute(self, context: bpy.types.Context) -> set[str]:
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
            self.report({"ERROR"}, f"Loading {SEED_FILE_BASENAME} failed: {e}")
            return {"CANCELLED"}

        if seed is None:
            self.report(
                {"ERROR"},
                f"Could not locate {SEED_FILE_BASENAME}. Save the .blend "
                "inside a hoverbike clone, or re-run `pnpm install:blender-addon` "
                "to symlink the addon to the repo.",
            )
            return {"CANCELLED"}

        try:
            terrain = seed.build_terrain_mesh()
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"build_terrain_mesh() failed: {e}")
            return {"CANCELLED"}

        try:
            ng_terrain = _build_or_reuse_groups(seed)
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"Building HV_TemplateTerrain failed: {e}")
            return {"CANCELLED"}

        mod = seed.attach_modifier(terrain, ng_terrain)

        spawned = _spawn_missing_empties(seed)
        seed.bind_modifier_inputs(mod, ng_terrain)

        # Shared Noise Seed → the wrapper exposes exactly one (the per-style
        # ones are skipped when the panels are built), so a name match is
        # unambiguous. Reuse the island operator's interface walk.
        from .island_terrain import _set_modifier_input

        _set_modifier_input(mod, ng_terrain, "Noise Seed", float(self.seed))

        # Author-only preview material so the new terrain doesn't read
        # default-pink. The island seed module owns the helper.
        try:
            seed.seed_template_island.build_terrain_material(terrain)
        except Exception as e:  # noqa: BLE001 — preview-only, never fatal
            self.report({"WARNING"}, f"Built terrain but preview material failed: {e}")

        context.view_layer.update()

        for o in context.view_layer.objects:
            o.select_set(False)
        terrain.select_set(True)
        context.view_layer.objects.active = terrain

        self.report(
            {"INFO"},
            f"Spawned {terrain.name} with HV_TemplateTerrain modifier "
            f"(Style menu: Island / Alpine / Dunes / Mesa, seed={self.seed}) "
            f"and {spawned} new driver empt{'y' if spawned == 1 else 'ies'}.",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


def register() -> None:
    bpy.utils.register_class(HOVERBIKE_OT_add_multibiome_terrain)


def unregister() -> None:
    try:
        bpy.utils.unregister_class(HOVERBIKE_OT_add_multibiome_terrain)
    except RuntimeError:
        pass
