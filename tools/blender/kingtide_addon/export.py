"""Asset export operators: track / bike GLB export, the spec / track
JSON writers, plus the lightweight URL / Play helpers that pair with
them.

The actual validation, JSON derivation, and manifest-upsert logic
still live in `_legacy.py` (they cross-cut everything else in the
addon's plumbing). This module owns only the user-facing operators
so the export commands have a clear home in the package.

  * ``KINGTIDE_OT_export_track``      — validate + write track GLB
    + merge parametric scene fields into public/tracks/<id>.json.
  * ``KINGTIDE_OT_export_bike``       — validate + write bike GLB,
    materialise specs/bikes/<id>.json on first export.
  * ``KINGTIDE_OT_open_play_url``     — open the dev-server URL in
    a browser.
  * ``KINGTIDE_OT_reload_track_json`` — pull scalar / parametric
    fields from the JSON back into scene props.
  * ``KINGTIDE_OT_copy_track_url`` / ``copy_bike_url`` — clipboard
    helpers.
"""

from __future__ import annotations

import contextlib
import json
import os
import re

import bpy
from bpy.props import BoolProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Geometry-Nodes scatter realize pass
# ────────────────────────────────────────────────────────────────────
#
# Blender 5.1's glTF exporter only collapses sibling nodes into
# ``EXT_mesh_gpu_instancing`` when they (a) share the same mesh id, and
# (b) have no children of their own — see ``manage_gpu_instancing`` in
# ``io_scene_gltf2/blender/exp/exporter.py``. A Geometry-Nodes scatter
# graph whose ``Instance on Points`` source is a *Collection* generates
# nested instance subtrees (one per collection child), so the exporter
# silently drops the entire scatter — the ``scatter_*_surf`` node ships
# as an Empty with no mesh and the per-instance transforms vanish.
# This is the gap 990b2b7 flagged as "scatter zones show up in the
# .blend but the runtime drops them"; this realize pass closes it.
#
# Instead of contorting the graph (single-Mesh source, hand-tuned
# Realize Instances toggles), this context manager converts every
# scatter modifier into the pattern the exporter already handles
# cleanly: a flat fan of leaf Mesh objects sharing one frozen mesh
# data block. ``gather_mesh`` dedupes them to one id; ``manage_gpu_-
# instancing`` collapses them. The original surf is hidden for the
# duration of the export so its GN output doesn't ship as a duplicate
# realized blob. State is restored on exit.
#
# A scatter modifier is identified by node-group name prefix
# ``HV_Scatter`` — the canonical group from ``seed_props_library.
# build_scatter_group``, plus any author forks (``HV_Scatter_Reef``,
# ``HV_Scatter_Alpine``, …). Name-prefix discrimination keeps the
# convention explicit and avoids requiring a sidecar tag on every
# fork. The realize pass also tolerates the ``hb_scatter_ng`` custom
# property on the group as an alternate signal for graphs that don't
# follow the naming convention.

_HB_SCATTER_NG_PREFIX = "HV_Scatter"
_HB_SCATTER_NG_TAG = "hb_scatter_ng"


def _is_scatter_modifier(mod: bpy.types.Modifier) -> bool:
    """True if ``mod`` is a Geometry-Nodes modifier whose node group
    is one of the HV_Scatter family (by name prefix or explicit tag)."""
    if mod.type != "NODES":
        return False
    ng = mod.node_group
    if ng is None:
        return False
    if ng.name.startswith(_HB_SCATTER_NG_PREFIX):
        return True
    if ng.get(_HB_SCATTER_NG_TAG, False):
        return True
    return False


@contextlib.contextmanager
def _RealizedScatterInstances(scene: bpy.types.Scene):
    """Walk every mesh whose Nodes modifier uses an ``HV_Scatter*``
    node group (see ``_is_scatter_modifier``), evaluate the depsgraph,
    and spawn one fresh leaf Mesh object per generated instance.
    Frozen-mesh data blocks are shared across same-source instances
    so the glTF exporter dedupes them to one mesh id and folds them
    into a single ``EXT_mesh_gpu_instancing`` block per scatter parent.

    Yields the total number of realized instances spawned, for logging.
    """
    depsgraph = bpy.context.evaluated_depsgraph_get()

    candidates = [
        o for o in scene.objects
        if o.type == "MESH" and any(_is_scatter_modifier(m) for m in o.modifiers)
    ]
    if not candidates:
        yield 0
        return

    # Phase 1 — read-only depsgraph walk. Collect (surf, [(src_obj,
    # matrix_world), ...]) up front so we don't mutate the scene
    # while iterating ``depsgraph.object_instances`` (which would
    # invalidate the iterator).
    #
    # Identity matching: ``depsgraph.object_instances`` is iterated
    # once per export and yields ``DepsgraphObjectInstance`` rows for
    # every instance in the scene. Each row's ``parent`` is the
    # *evaluated* version of the instancer object, but Python-side
    # equality against ``surf.evaluated_get(depsgraph)`` doesn't
    # reliably hold (the same evaluated id-block can return distinct
    # Python wrappers across calls). Match by ``inst.parent.original
    # == surf`` instead — that's the pattern the Blender glTF exporter
    # itself uses in ``tree.py``.
    # ``inst.parent.original`` returns a fresh Python wrapper around the
    # underlying id-block each call, so ``id()``-based matching against
    # ``candidates`` is unreliable. Key by object name instead — names
    # are unique within a scene, which is enough to associate a
    # depsgraph instance row with its source surf.
    candidate_set = {o.name: o for o in candidates}
    by_surf: dict[str, list[tuple[bpy.types.Object, "mathutils.Matrix"]]] = {
        o.name: [] for o in candidates
    }
    # Three flavours of GN-scatter output we need to handle:
    #
    # 1. ``Pick Instance=True`` with the source Collection's "Reset
    #    Children" toggled ON — the picker yields the leaf *meshes*
    #    directly, ``inst.object.data`` is the Mesh, and we use it.
    #
    # 2. ``Pick Instance=True`` with "Reset Children" OFF — the picker
    #    yields the collection's *root Empty* (e.g. ``prop_palm_root``).
    #    The evaluated empty has no children, no instance_collection.
    #    We have to look at ``src.original`` and walk *its* children
    #    in the source .blend to find a mesh-bearing one. Today's
    #    ``prop_<id>`` libraries are organised as
    #    ``prop_<id>_root (Empty) → prop_<id>_mesh (Mesh)``, so the
    #    first mesh child is the right pick. Multi-prop collections
    #    would land on the first one — acceptable for now, revisit
    #    when biome kits ship multiple meshes per source collection.
    #
    # 3. ``inst.object`` is a Collection-Instance Empty (the hand-
    #    placed ``palm_NN`` pattern): its ``instance_collection`` is
    #    set; we descend into ``all_objects`` to find a mesh.
    def _resolve_mesh_source(src: bpy.types.Object | None) -> bpy.types.Object | None:
        if src is None:
            return None
        # Always return ``.original`` (the source-blend datablock),
        # never the depsgraph-evaluated proxy ``src`` itself. Storing
        # the proxy across the realize-pass mutation phase
        # (link new objects / hide surfs / etc.) leaves it pointing
        # at memory the depsgraph may reuse for a different evaluation
        # output. Symptom: with per-point random ``Instance Index``
        # picking Pick Instance archetypes across both Empty and Mesh
        # children of a prop_* collection, case 1 hits this path with
        # an evaluated Mesh and case 2 with a source-blend Mesh. Same
        # underlying mesh data, but different Python wrapper IDs, so
        # ``mesh_cache`` misses, two frozen meshes get baked, and the
        # spawned-leaves bookkeeping ends with the glTF exporter
        # reporting random leaf objects as "not in Scene Collection".
        # Returning ``.original`` collapses both cases to a single
        # stable cache entry per source mesh.
        if isinstance(src.data, bpy.types.Mesh) and len(src.data.vertices) > 0:
            return src.original if src.original is not None else src
        # Hand-placed Collection-Instance Empty path (case 3).
        if src.data is None and src.instance_type == "COLLECTION" and src.instance_collection:
            for child in src.instance_collection.all_objects:
                if (
                    child.type == "MESH"
                    and child.data is not None
                    and len(child.data.vertices) > 0
                ):
                    return child
        # GN-Pick-Instance-of-Empty path (case 2). The evaluated
        # empty has no children; look at the original.
        original = src.original
        if original is not None and original is not src:
            for child in original.children:
                if (
                    child.type == "MESH"
                    and child.data is not None
                    and len(child.data.vertices) > 0
                ):
                    return child
        return None

    for inst in depsgraph.object_instances:
        if not inst.is_instance:
            continue
        parent = inst.parent
        if parent is None or parent.original is None:
            continue
        surf_name = parent.original.name
        if surf_name not in candidate_set:
            continue
        mesh_src = _resolve_mesh_source(inst.object)
        if mesh_src is None:
            continue
        # Defensive: ``_resolve_mesh_source`` always *intends* to return
        # an Object (or None), but the depsgraph occasionally hands
        # back generic ID wrappers (linked-from-library curve children
        # walked via ``original.children`` is the case I've hit). Pass
        # those to ``new_from_object`` and you get
        # ``"Function.object expected a Object type, not ID"`` mid-
        # export. Skipping non-Objects is the safest path: we lose
        # that one instance row but the rest of the scatter survives.
        if not isinstance(mesh_src, bpy.types.Object):
            continue
        by_surf[surf_name].append((mesh_src, inst.matrix_world.copy()))

    plan: list[tuple[bpy.types.Object, list[tuple[bpy.types.Object, "mathutils.Matrix"]]]] = [
        (candidate_set[sname], captured)
        for sname, captured in by_surf.items()
        if captured
    ]

    spawned: list[bpy.types.Object] = []
    frozen_meshes: list[bpy.types.Mesh] = []
    hidden_surfs: list[bpy.types.Object] = []
    mesh_cache: dict[int, bpy.types.Mesh] = {}

    try:
        for surf, captured in plan:
            parent = surf.parent or surf
            target_coll = (
                surf.users_collection[0]
                if surf.users_collection
                else scene.collection
            )
            for src_original, mw in captured:
                cache_key = id(src_original)
                frozen = mesh_cache.get(cache_key)
                if frozen is None:
                    # Two-tier bake. First try the modifier-aware path
                    # via ``new_from_object`` — works for local objects
                    # whose modifier stack the depsgraph has evaluated.
                    # Fall back to a plain ``.copy()`` of the source
                    # mesh datablock if that fails: linked-from-library
                    # sources (every ``prop_<id>`` in the seeded props
                    # library) aren't auto-evaluated by the depsgraph
                    # when they're only referenced via Collection Info
                    # → Instance on Points, so ``new_from_object``
                    # raises "Object does not have geometry data".
                    # ``mesh.copy()`` always works, and the linked
                    # mesh's stored data IS the final shape — any
                    # HV_Prop modifier ran at seed time and got baked
                    # into the saved mesh — so the copy carries
                    # everything the exporter needs.
                    #
                    # Cleanup detail: ``.copy()`` returns a local
                    # datablock (library=None) even when the source is
                    # linked, so ``frozen_meshes.append`` + the finally-
                    # block's ``bpy.data.meshes.remove`` correctly
                    # disposes of it. Pointing leaf objects at the
                    # *linked* datablock directly was the previous
                    # attempt's crash: the glTF exporter writes
                    # internal metadata onto the mesh during gather,
                    # which trips read-only enforcement on linked IDs.
                    eval_src = src_original.evaluated_get(depsgraph)
                    try:
                        frozen = bpy.data.meshes.new_from_object(eval_src)
                    except RuntimeError:
                        frozen = None
                    if frozen is None or len(frozen.vertices) == 0:
                        if frozen is not None:
                            bpy.data.meshes.remove(frozen)
                        src_mesh = (
                            src_original.data
                            if isinstance(src_original.data, bpy.types.Mesh)
                            else None
                        )
                        if src_mesh is None or len(src_mesh.vertices) == 0:
                            print(
                                f"[kingtide] WARN realize: {src_original.name!r} "
                                f"yielded no geometry — skipping"
                            )
                            continue
                        frozen = src_mesh.copy()
                    frozen.name = f"_hb_scatter_frozen_{src_original.name}"
                    mesh_cache[cache_key] = frozen
                    frozen_meshes.append(frozen)
                new_obj = bpy.data.objects.new(
                    f"{surf.name}_inst_{len(spawned):04d}", frozen,
                )
                target_coll.objects.link(new_obj)
                # Setting parent doesn't recompute matrix_basis, and
                # then writing matrix_world rebuilds matrix_basis from
                # parent_world.inverted() @ new_world for us.
                if parent is not surf:
                    new_obj.parent = parent
                new_obj.matrix_world = mw
                spawned.append(new_obj)

            # Hide the original surf so the exporter (a) filters it
            # out under ``use_visible=True`` and (b) doesn't re-emit
            # its GN output as a parallel set of broken instance
            # children. The realized objects we just spawned live as
            # siblings of the surf under the scatter parent empty,
            # so the surf going missing doesn't orphan them.
            if not surf.hide_viewport:
                surf.hide_viewport = True
                hidden_surfs.append(surf)

        yield len(spawned)

    finally:
        for obj in spawned:
            for c in list(obj.users_collection):
                c.objects.unlink(obj)
            bpy.data.objects.remove(obj, do_unlink=True)
        for m in frozen_meshes:
            bpy.data.meshes.remove(m)
        for surf in hidden_surfs:
            surf.hide_viewport = False


# ────────────────────────────────────────────────────────────────────
# Dock export meshes (realize curve-GN docks to clean frozen meshes)
# ────────────────────────────────────────────────────────────────────
#
# Authors build a dock as ONE object (a curve + the HV_Dock GN modifier).
# Exporting that curve directly is broken two ways, so at export we replace
# each visible dock with two REALIZED plain-mesh objects and hide the curve:
#
#   * <name>_deck    — the evaluated HV_Dock mesh, kind="decoration"
#                      (renders planks + pylons; opts out of collision).
#   * <name>_autocol — an HV_DockCollider smooth swept slab, kind="collider_mesh"
#                      (collides, hidden from render) so the bike rides a clean
#                      surface instead of every floating plank.
#
# Why realize instead of exporting the curve + a sibling proxy curve: with
# ``export_gn_mesh=True`` (which we need so the GN-assigned plank/pylon
# materials ship at all) the exporter emits a curve-GN object as a child
# "GN Instance" mesh carrying the real materials PLUS the original curve node
# carrying a SECOND copy of the geometry with NULL materials. That null-material
# copy renders as a gray slab z-fighting the visible deck. A plain frozen mesh
# has no GN modifier, so the exporter writes ONE clean node per object — no gray
# duplicate, no per-plank collider, and (filtering on ``visible_get()``) no
# phantom collider for an eye-hidden dock. Mesh-based GN tools (sea stacks,
# palms) don't hit the duplication; only curve-driven ones do.
# (See docs / the dock_smooth_collider memory for the collider rationale.)

# HV_Dock inputs whose values must be mirrored onto the collider so the
# proxy lines up with the visible deck + pylons.
_DOCK_SHARED_INPUTS = (
    "Deck Width",
    "Plank Thickness",
    "Pylon Spacing",
    "Pylon Radius",
    "Pylon Above",
    "Pylon Drop",
)


def _is_dock_modifier(m: bpy.types.Modifier) -> bool:
    return m.type == "NODES" and m.node_group is not None and m.node_group.name == "HV_Dock"


def _gn_inputs_by_name(node_group) -> dict[str, str]:
    """Map an exposed GN input socket name → its identifier (for ``mod[id]``)."""
    return {
        it.name: it.identifier
        for it in node_group.interface.items_tree
        if getattr(it, "item_type", "") == "SOCKET" and it.in_out == "INPUT"
    }


def _ensure_dock_collider_group():
    """Return the ``HV_DockCollider`` node group, building it from the
    canonical tool (``tools/blender/build_geonode_props.py``) if the file
    doesn't already carry it. Returns None if it can't be resolved — the
    caller then leaves the docks untouched rather than ship a collider-less
    deck."""
    g = bpy.data.node_groups.get("HV_DockCollider")
    if g is not None:
        return g
    from ._legacy import find_repo_root

    repo = find_repo_root(bpy.data.filepath)
    if not repo:
        return None
    path = os.path.join(repo, "tools", "blender", "build_geonode_props.py")
    if not os.path.isfile(path):
        return None
    import importlib.util as _ilu

    spec = _ilu.spec_from_file_location("hv_build_geonode_props", path)
    if spec is None or spec.loader is None:
        return None
    try:
        m = _ilu.module_from_spec(spec)
        spec.loader.exec_module(m)
        m.build_dock_collider()
    except Exception:  # noqa: BLE001 — best effort; warn at the call site
        return None
    return bpy.data.node_groups.get("HV_DockCollider")


def _mark_color0_active(me: bpy.types.Mesh) -> None:
    """Make ``COLOR_0`` the active color attribute on a realized mesh.

    ``new_from_object`` keeps the COLOR_0 attribute itself but can drop the
    active-color flag, and the exporter ships only the *active* color under
    ``export_vertex_color="ACTIVE"``. Without COLOR_0 the runtime vinyl pass
    reads a fully-absent buffer as 0 on every channel (AO=0 → the dock
    darkens). See the reference_tsl_attribute_padding memory."""
    names = [a.name for a in me.color_attributes]
    if "COLOR_0" in names:
        try:
            me.color_attributes.active_color_index = names.index("COLOR_0")
        except Exception:  # noqa: BLE001
            pass


@contextlib.contextmanager
def _RealizedDockMeshes(scene: bpy.types.Scene):
    """Replace every visible HV_Dock curve with two realized frozen-mesh
    objects for the duration of the export (see the section header for why):

      * ``<name>_deck``    — the evaluated HV_Dock mesh, ``kind="decoration"``.
      * ``<name>_autocol`` — the HV_DockCollider swept slab,
                             ``kind="collider_mesh"`` (skipped if the collider
                             group can't be built — degrades to no collider).

    The original curve is hidden so ``use_visible=True`` skips it; everything is
    removed and the originals un-hidden on exit, so the author's scene is
    unchanged. Yields the dock count for logging.

    Each collider proxy gets its OWN copy of the dock's curve — a shared
    data-block would make the exporter dedup it to the deck mesh."""
    docks = [
        o
        for o in scene.objects
        if o.type == "CURVE"
        and o.visible_get()
        and any(_is_dock_modifier(m) for m in o.modifiers)
    ]
    if not docks:
        yield 0
        return

    ctree = _ensure_dock_collider_group()
    if ctree is None:
        print(
            "[kingtide-addon] WARNING: HV_Dock object(s) present but "
            "HV_DockCollider could not be built — docks exported WITHOUT a "
            "collider. Run the geonode toolkit (build_geonode_props) once."
        )

    spawned: list[bpy.types.Object] = []
    spawned_meshes: list[bpy.types.Mesh] = []
    proxy_curves: list[tuple[bpy.types.Object, bpy.types.Curve]] = []
    hide_restore: list[tuple[bpy.types.Object, bool]] = []
    try:
        cby = _gn_inputs_by_name(ctree) if ctree is not None else {}

        # Phase 1 — a private collider-proxy curve per dock, with the dock's
        # deck/pylon inputs mirrored across so the swept slab matches.
        proxies: dict[str, bpy.types.Object] = {}
        for ob in docks:
            if ctree is None:
                continue
            vals: dict[str, object] = {}
            for m in ob.modifiers:
                if _is_dock_modifier(m):
                    dby = _gn_inputs_by_name(m.node_group)
                    for k in _DOCK_SHARED_INPUTS:
                        ident = dby.get(k)
                        if ident is not None:
                            try:
                                vals[k] = m[ident]
                            except Exception:  # noqa: BLE001
                                pass
                    break

            curve_copy = ob.data.copy()
            curve_copy.name = f"{ob.name}_autocol_curve"
            pc = bpy.data.objects.new(f"{ob.name}_autocol_curve", curve_copy)
            pc.matrix_world = ob.matrix_world.copy()
            for c in ob.users_collection or (scene.collection,):
                c.objects.link(pc)
            cmod = pc.modifiers.new("HV_DockCollider", "NODES")
            cmod.node_group = ctree
            for k, v in vals.items():
                ident = cby.get(k)
                if ident is not None:
                    try:
                        cmod[ident] = v
                    except Exception:  # noqa: BLE001
                        pass
            proxies[ob.name] = pc
            proxy_curves.append((pc, curve_copy))

        # Phase 2 — refresh the depsgraph so the freshly-linked proxy curves
        # evaluate, then freeze each dock + proxy to a plain mesh datablock.
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        realized: list[tuple[bpy.types.Object, bpy.types.Mesh, bpy.types.Mesh | None]] = []
        for ob in docks:
            deck_me = bpy.data.meshes.new_from_object(
                ob.evaluated_get(depsgraph),
                preserve_all_data_layers=True,
                depsgraph=depsgraph,
            )
            deck_me.name = f"{ob.name}_deck"
            _mark_color0_active(deck_me)
            spawned_meshes.append(deck_me)

            col_me = None
            pc = proxies.get(ob.name)
            if pc is not None:
                col_me = bpy.data.meshes.new_from_object(
                    pc.evaluated_get(depsgraph),
                    preserve_all_data_layers=True,
                    depsgraph=depsgraph,
                )
                col_me.name = f"{ob.name}_autocol"
                spawned_meshes.append(col_me)
            realized.append((ob, deck_me, col_me))

        # Phase 3 — spawn the realized objects, tag kinds, hide the originals.
        for ob, deck_me, col_me in realized:
            deck = bpy.data.objects.new(f"{ob.name}_deck", deck_me)
            deck.matrix_world = ob.matrix_world.copy()
            deck["kind"] = "decoration"
            for c in ob.users_collection or (scene.collection,):
                c.objects.link(deck)
            spawned.append(deck)

            if col_me is not None:
                col = bpy.data.objects.new(f"{ob.name}_autocol", col_me)
                col.matrix_world = ob.matrix_world.copy()
                col["kind"] = "collider_mesh"
                for c in ob.users_collection or (scene.collection,):
                    c.objects.link(col)
                spawned.append(col)

            hide_restore.append((ob, ob.hide_get()))
            ob.hide_set(True)

        # The proxy curves were only needed to evaluate the swept slab — drop
        # them (object + curve datablock) before the export walk so they don't
        # ship as stray curve nodes.
        for pc, cu in proxy_curves:
            for c in list(pc.users_collection):
                c.objects.unlink(pc)
            bpy.data.objects.remove(pc, do_unlink=True)
            try:
                bpy.data.curves.remove(cu)
            except Exception:  # noqa: BLE001
                pass
        proxy_curves = []

        yield len(docks)
    finally:
        for o in spawned:
            for c in list(o.users_collection):
                c.objects.unlink(o)
            bpy.data.objects.remove(o, do_unlink=True)
        for me in spawned_meshes:
            try:
                bpy.data.meshes.remove(me)
            except Exception:  # noqa: BLE001
                pass
        for pc, cu in proxy_curves:
            for c in list(pc.users_collection):
                c.objects.unlink(pc)
            bpy.data.objects.remove(pc, do_unlink=True)
            try:
                bpy.data.curves.remove(cu)
            except Exception:  # noqa: BLE001
                pass
        for ob, h in hide_restore:
            try:
                ob.hide_set(h)
            except Exception:  # noqa: BLE001
                pass


# ────────────────────────────────────────────────────────────────────
# Shared helpers
# ────────────────────────────────────────────────────────────────────


def _ensure_active_object(context) -> bpy.types.Object | None:
    """Blender 5.1's glTF exporter touches ``context.active_object``
    unconditionally — if nothing is active it raises a confusing
    ``Context has no attribute 'active_object'`` mid-export. Pick any
    visible mesh as a fallback and return whatever was active before
    so the caller can restore. The active object isn't used by the
    exporter for anything when ``use_selection=False``."""
    prev = context.view_layer.objects.active
    if prev is not None:
        return prev
    for obj in context.view_layer.objects:
        if obj.type == "MESH" and not obj.hide_get():
            context.view_layer.objects.active = obj
            return prev
    return prev


# ────────────────────────────────────────────────────────────────────
# Playtest / URL helpers
# ────────────────────────────────────────────────────────────────────

# Vite serves on 5191 with strictPort OFF (see vite.config.ts), so a second
# clone / branch with its own `pnpm dev` falls through to 5192, 5193, … The
# addon used to hard-code 5191, which opened whichever clone grabbed it first
# — often the wrong version. These helpers probe the range and find the port
# actually serving THIS repo's track JSON.
_DEV_SERVER_PORTS = (5191, 5192, 5193, 5194, 5195)


def _probe_dev_port(port: int, track_id: str, local_canon: str | None, timeout: float) -> str | None:
    """Classify a localhost port: ``"this"`` (serves the same ``track_id``
    JSON this repo exports — the right clone), ``"game"`` (a King Tide dev
    server, but a different clone / no match), or ``None`` (not the game)."""
    import json
    import urllib.request

    try:
        with urllib.request.urlopen(
            f"http://localhost:{port}/tracks/{track_id}.json", timeout=timeout
        ) as resp:
            body = resp.read().decode("utf-8")
        try:
            if local_canon is not None and json.dumps(json.loads(body), sort_keys=True) == local_canon:
                return "this"
        except Exception:
            pass
        return "game"
    except Exception:
        pass
    # No track JSON here — still a King Tide dev server? (title signature)
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/", timeout=timeout) as resp:
            if "<title>King Tide</title>" in resp.read(4096).decode("utf-8", "ignore"):
                return "game"
    except Exception:
        pass
    return None


def _detect_dev_servers(track_id: str, repo_root: str | None, timeout: float = 0.4) -> list[tuple[int, str]]:
    """Probe the Vite port range for running King Tide dev servers. Returns
    ``[(port, "this"|"game"), …]``. ``"this"`` flags the port whose served
    ``track_id`` JSON matches this repo's file — i.e. the clone you want."""
    import json
    import os

    local_canon: str | None = None
    if repo_root:
        p = os.path.join(repo_root, "public", "tracks", f"{track_id}.json")
        if os.path.exists(p):
            try:
                with open(p, encoding="utf-8") as f:
                    local_canon = json.dumps(json.load(f), sort_keys=True)
            except Exception:
                local_canon = None
    found: list[tuple[int, str]] = []
    for port in _DEV_SERVER_PORTS:
        kind = _probe_dev_port(port, track_id, local_canon, timeout)
        if kind:
            found.append((port, kind))
    return found


def _best_dev_port(servers: list[tuple[int, str]], default: int = 5191) -> int:
    """Pick the port to open: this-repo first, then any game server, else 5191."""
    for port, kind in servers:
        if kind == "this":
            return port
    return servers[0][0] if servers else default


def _fmt_servers(servers: list[tuple[int, str]]) -> str:
    if not servers:
        return "none detected"
    return ", ".join(f":{p}{' (this repo)' if k == 'this' else ''}" for p, k in servers)


def _resolve_repo_root_safe() -> str | None:
    """Best-effort repo root for the dev-server JSON comparison (never raises)."""
    try:
        from ._legacy import find_repo_root

        return str(find_repo_root(bpy.data.filepath))
    except Exception:
        return None


class KINGTIDE_OT_open_play_url(Operator):
    """Open the current track's Play URL in the default browser. The
    addon already has *Copy Play URL*; this is the one-click version
    that skips clipboard + paste. Assumes the dev server is running at
    `http://localhost:5191` (Vite's default for the project)."""

    bl_idname = "kingtide.open_play_url"
    bl_label = "Open in Browser"
    bl_description = "Open the dev server's Play URL for this track"
    bl_options = {"REGISTER"}

    edit: BoolProperty(  # type: ignore[valid-type]
        name="Edit mode",
        description="Append `&edit=1` to open the in-app editor for this track instead of racing it",
        default=False,
    )

    def execute(self, context):
        from ._legacy import derive_asset_id

        track_id = derive_asset_id("hoverbike_track_id")
        if not track_id:
            self.report({"ERROR"}, "Couldn't derive a track id from the .blend filename.")
            return {"CANCELLED"}
        # Find the dev server actually serving THIS repo (multiple clones each
        # run their own `pnpm dev` on 5191/5192/…) instead of blindly using 5191.
        servers = _detect_dev_servers(track_id, _resolve_repo_root_safe())
        port = _best_dev_port(servers)
        url = f"http://localhost:{port}/?track={track_id}"
        if self.edit:
            url += "&edit=1"
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception as e:  # noqa: BLE001 — webbrowser fallbacks vary by platform
            self.report({"ERROR"}, f"Couldn't launch browser: {e}")
            return {"CANCELLED"}
        if not servers:
            self.report(
                {"WARNING"},
                f"No dev server on :{_DEV_SERVER_PORTS[0]}–:{_DEV_SERVER_PORTS[-1]} — opened :{port} anyway "
                f"(run `pnpm dev` in this repo).",
            )
        elif not any(k == "this" for _, k in servers):
            self.report(
                {"WARNING"},
                f"This repo's dev server wasn't found — opened :{port}. Running: {_fmt_servers(servers)}. "
                f"Start `pnpm dev` in this clone for an exact match.",
            )
        else:
            self.report({"INFO"}, f"Opened :{port} (this repo). Dev servers: {_fmt_servers(servers)}")
        return {"FINISHED"}


class KINGTIDE_OT_reload_track_json(Operator):
    """Pull scalar / parametric fields from ``public/tracks/<id>.json``
    into the scene's custom properties (gate spacing, terrain shader,
    water knobs, start pose). Lets edits made in the in-app editor
    flow back into the .blend without re-launching the addon."""

    bl_idname = "kingtide.reload_track_json"
    bl_label = "Reload from JSON"
    bl_description = (
        "Sync gate spacing, terrain shader, water knobs, and the start "
        "pose from public/tracks/<id>.json into the .blend"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from ._legacy import derive_asset_id, find_repo_root, reload_track_from_json

        blend = bpy.data.filepath
        if not blend:
            self.report({"ERROR"}, "Save your .blend first (Ctrl+S).")
            return {"CANCELLED"}
        repo = find_repo_root(blend)
        if not repo:
            self.report({"ERROR"}, "No repo root found — .blend isn't inside a king-tide clone.")
            return {"CANCELLED"}
        track_id = derive_asset_id("hoverbike_track_id")
        if not track_id:
            self.report({"ERROR"}, "Couldn't derive a track id from the .blend filename.")
            return {"CANCELLED"}
        json_path = os.path.join(repo, "public", "tracks", f"{track_id}.json")
        if not os.path.isfile(json_path):
            self.report({"WARNING"}, f"No JSON yet at public/tracks/{track_id}.json — export once to create it.")
            return {"CANCELLED"}
        try:
            summary = reload_track_from_json(json_path)
        except (RuntimeError, ValueError) as e:
            self.report({"ERROR"}, f"Reload failed: {e}")
            return {"CANCELLED"}
        # Also refresh the props preview from props[] so Reload from JSON syncs
        # placed asset props too (deferred via a timer; best-effort).
        try:
            from .prop_placements import schedule_auto_import

            schedule_auto_import()
        except Exception as e:  # noqa: BLE001 — informational only
            print(f"[kingtide] prop auto-sync schedule skipped: {e}")
        synced = [k for k in ("gateSpacing", "terrainShader", "water", "start") if k in summary]
        self.report({"INFO"}, f"Reloaded {summary['json']}: {', '.join(synced) or 'no syncable fields'}")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Track export
# ────────────────────────────────────────────────────────────────────


class KINGTIDE_OT_export_track(Operator):
    """Validate the track scene, write
    ``public/assets/tracks/<id>.glb``, and rewrite
    ``public/tracks/<id>.json`` with the .blend's parametric state
    merged on top of the existing JSON. Editor-owned fields (hand-
    placed gates, pickups, props) are preserved; Blender-owned fields
    (gate spacing, terrain shader, water, spline anchors, start) come
    from the .blend."""

    bl_idname = "kingtide.export_track"
    bl_label = "Export Track to Game"
    bl_description = (
        "Validate scene, export track GLB, and merge Blender-side "
        "parametric fields into public/tracks/<id>.json"
    )
    bl_options = {"REGISTER"}

    def invoke(self, context: bpy.types.Context, event: bpy.types.Event) -> set[str]:
        return self.execute(context)

    def execute(self, context: bpy.types.Context) -> set[str]:
        from ._legacy import (
            _PreviewCollectionsHidden,
            _merge_export_json,
            _upsert_manifest_track,
            bake_ai_splines,
            derive_asset_id,
            derive_track_json,
            find_repo_root,
            validate_track_scene,
        )

        blend = bpy.data.filepath
        if not blend:
            self.report({"ERROR"}, "Save your .blend first (Ctrl+S).")
            return {"CANCELLED"}

        repo = find_repo_root(blend)
        if not repo:
            self.report(
                {"ERROR"},
                f"No package.json + public/ found in any ancestor of {blend}. "
                "Save your .blend inside a king-tide clone (typically tracks-src/).",
            )
            return {"CANCELLED"}

        track_id = derive_asset_id("hoverbike_track_id")
        if not track_id:
            self.report({"ERROR"}, "Couldn't derive a track id from the .blend filename.")
            return {"CANCELLED"}
        if not re.fullmatch(r"[a-z0-9-]+", track_id):
            self.report(
                {"ERROR"},
                f"Track id '{track_id}' must be lowercase letters, digits, or dashes. "
                "Rename the .blend or set the scene custom property 'hoverbike_track_id'.",
            )
            return {"CANCELLED"}

        glb_path = os.path.join(repo, "public", "assets", "tracks", f"{track_id}.glb")
        json_path = os.path.join(repo, "public", "tracks", f"{track_id}.json")

        bake_ai_splines()
        errors = validate_track_scene()
        if errors:
            for e in errors:
                self.report({"ERROR"}, f"validation: {e}")
            return {"CANCELLED"}

        # Auto-bake path-worn into ``baked_path`` so authors who never
        # touched the bake button still ship with a worn racing line.
        # The GN graph reads ``baked_path`` into ``COLOR_0.B`` during
        # export-time eval, so this has to happen *before* the GLB
        # write. Non-fatal — missing terrain / spline downgrades to a
        # WARNING and the export continues with whatever was last baked.
        from .bake import auto_bake_path_wear_for_export

        ok, msg = auto_bake_path_wear_for_export(context.scene)
        if not ok:
            self.report({"WARNING"}, msg)

        os.makedirs(os.path.dirname(glb_path), exist_ok=True)
        _ensure_active_object(context)
        try:
            with _PreviewCollectionsHidden(context.view_layer), \
                 _RealizedScatterInstances(context.scene) as scatter_count, \
                 _RealizedDockMeshes(context.scene) as dock_collider_count:
                if scatter_count:
                    print(f"[kingtide-addon] realized {scatter_count} scatter instance(s) for GLB export")
                if dock_collider_count:
                    print(f"[kingtide-addon] realized {dock_collider_count} dock(s) to clean deck + collider meshes for GLB export")
                bpy.ops.export_scene.gltf(
                    filepath=glb_path,
                    export_format="GLB",
                    export_extras=True,
                    export_yup=True,
                    export_apply=True,
                    use_selection=False,
                    use_visible=True,
                    use_renderable=False,
                    use_active_collection=False,
                    export_cameras=False,
                    export_lights=False,
                    export_gpu_instances=True,
                    export_gn_mesh=True,
                    # Force the active vertex-colour through even when
                    # the Eevee material doesn't reference it. The
                    # GN-stamped COLOR_0 (R=0, G=AO, B=path-worn,
                    # A=biome) is the active color on the source mesh.
                    export_vertex_color="ACTIVE",
                    export_all_vertex_colors=False,
                    export_active_vertex_color_when_no_material=True,
                )
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"GLB export failed: {e}")
            return {"CANCELLED"}

        json_existed = os.path.exists(json_path)
        existing: dict | None = None
        if json_existed:
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            except (OSError, ValueError):
                existing = None
        os.makedirs(os.path.dirname(json_path), exist_ok=True)
        derived = derive_track_json(track_id, f"/assets/tracks/{track_id}.glb")
        body = _merge_export_json(derived, existing)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(body, f, indent=2)
            f.write("\n")

        # Auto-render the track hero + tile thumbnail if the author has
        # parked a ``camera_hero`` in the scene. Non-fatal: a missing
        # camera, render failure, or non-EEVEE state issue downgrades to
        # a WARNING and the export still completes. The hero render fires
        # BEFORE the manifest upsert so the resulting JPGs exist on disk
        # by the time ``_upsert_manifest_track`` decides whether to stamp
        # a ``heroUrl`` field.
        from .thumbnail import find_camera_hero, render_track_hero

        if find_camera_hero() is not None:
            try:
                hero, tile, ths, tts = render_track_hero(render_tile=True)
                rel_hero = os.path.relpath(hero, repo).replace("\\", "/")
                msg = f"Rendered hero {rel_hero} in {ths:.2f}s"
                if tile:
                    rel_tile = os.path.relpath(tile, repo).replace("\\", "/")
                    msg += f" + tile {rel_tile} in {tts:.2f}s"
                self.report({"INFO"}, msg)
                print(f"[kingtide-addon] {msg}")
            except Exception as e:  # noqa: BLE001 — render failures vary by GPU / state
                self.report({"WARNING"}, f"track-hero render skipped: {e}")
        else:
            self.report(
                {"WARNING"},
                "no camera_hero — track exported without a hero image (Add Camera Hero to fix)",
            )

        # Make sure the in-game level picker sees this track. The menu
        # reads `public/assets/manifest.json`; tracks authored
        # interactively in Blender (vs. via `pnpm gen:tracks`) need
        # their entry upserted here.
        try:
            _upsert_manifest_track(
                repo,
                track_id=track_id,
                glb_url=f"/assets/tracks/{track_id}.glb",
                json_path=json_path,
            )
        except Exception as e:  # noqa: BLE001 — informational; export still succeeded
            self.report({"WARNING"}, f"manifest update skipped: {e}")

        rel_glb = os.path.relpath(glb_path, repo).replace("\\", "/")
        rel_json = os.path.relpath(json_path, repo).replace("\\", "/")
        tag = "merged" if json_existed else "created"
        msg = f"Exported → {rel_glb} ({tag} {rel_json})"
        self.report({"INFO"}, msg)
        print(f"[kingtide-addon] {msg}")

        # Optional one-click playtest: open the dev server's Play URL
        # in the browser as soon as the export lands. Gated on the
        # Auto-open scene prop so authors who don't have the dev server
        # running aren't ambushed by a doomed browser tab on every
        # export. Failure of the browser launch is non-fatal — the
        # export already succeeded by the time we get here.
        if bool(getattr(context.scene, "hoverbike_export_and_play", False)):
            try:
                bpy.ops.kingtide.open_play_url(edit=False)
            except (RuntimeError, AttributeError) as e:  # noqa: BLE001
                self.report({"WARNING"}, f"Auto-open after export skipped: {e}")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Bike export
# ────────────────────────────────────────────────────────────────────


class KINGTIDE_OT_export_bike(Operator):
    """Validate the bike scene, write
    ``public/assets/bikes/<id>.glb``, and on first export materialise
    a starter ``specs/bikes/<id>.json`` from ``bike_root`` extras +
    the bike's authored materials. Subsequent exports preserve the
    spec; Shift-click rewrites it from the .blend."""

    bl_idname = "kingtide.export_bike"
    bl_label = "Export Bike to Game"
    bl_description = (
        "Validate scene, export bike GLB, and (on first export) write a starter spec JSON. "
        "Hold Shift to force-rewrite the spec from the .blend."
    )
    bl_options = {"REGISTER"}

    force_spec: BoolProperty(  # type: ignore[valid-type]
        name="Overwrite spec",
        description=(
            "Rewrite specs/bikes/<id>.json from the .blend, even if one already "
            "exists. Off by default so JSON-side tuning isn't blown away by a "
            "re-export of the .blend."
        ),
        default=False,
    )

    def invoke(self, context: bpy.types.Context, event: bpy.types.Event) -> set[str]:
        if event.shift:
            self.force_spec = True
        return self.execute(context)

    def execute(self, context: bpy.types.Context) -> set[str]:
        from ._legacy import (
            _PreviewCollectionsHidden,
            derive_asset_id,
            derive_bike_spec,
            find_repo_root,
            validate_bike_scene,
        )

        blend = bpy.data.filepath
        if not blend:
            self.report({"ERROR"}, "Save your .blend first (Ctrl+S).")
            return {"CANCELLED"}

        repo = find_repo_root(blend)
        if not repo:
            self.report(
                {"ERROR"},
                f"No package.json + public/ found in any ancestor of {blend}. "
                "Save your .blend inside a king-tide clone (typically bikes-src/).",
            )
            return {"CANCELLED"}

        bike_id = derive_asset_id("hoverbike_bike_id")
        if not bike_id:
            self.report({"ERROR"}, "Couldn't derive a bike id from the .blend filename.")
            return {"CANCELLED"}
        if not re.fullmatch(r"[a-z0-9-]+", bike_id):
            self.report(
                {"ERROR"},
                f"Bike id '{bike_id}' must be lowercase letters, digits, or dashes. "
                "Rename the .blend or set the scene custom property 'hoverbike_bike_id'.",
            )
            return {"CANCELLED"}

        # If bike_root.extras.bike_id is missing, fill it in from the
        # filename — saves a manual step on the first export of a
        # freshly-renamed variant.
        bike_root = bpy.data.objects.get("bike_root")
        if bike_root is not None and not bike_root.get("bike_id"):
            bike_root["bike_id"] = bike_id

        glb_path = os.path.join(repo, "public", "assets", "bikes", f"{bike_id}.glb")
        spec_path = os.path.join(repo, "specs", "bikes", f"{bike_id}.json")

        errors = validate_bike_scene()
        # Cross-check the bike_root's bike_id against the filename id.
        if bike_root is not None:
            stored = bike_root.get("bike_id")
            if isinstance(stored, str) and stored != bike_id:
                errors.append(
                    f"bike_root.extras.bike_id={stored!r} does not match "
                    f"derived id '{bike_id}'. Rename the .blend or update the "
                    f"custom property."
                )
        if errors:
            for e in errors:
                self.report({"ERROR"}, f"validation: {e}")
            return {"CANCELLED"}

        os.makedirs(os.path.dirname(glb_path), exist_ok=True)
        _ensure_active_object(context)
        try:
            with _PreviewCollectionsHidden(context.view_layer):
                bpy.ops.export_scene.gltf(
                    filepath=glb_path,
                    export_format="GLB",
                    export_extras=True,
                    export_yup=True,
                    export_apply=True,
                    use_selection=False,
                    use_visible=True,
                    use_renderable=False,
                    use_active_collection=False,
                    export_cameras=False,
                    export_lights=False,
                    export_gpu_instances=True,
                    export_gn_mesh=True,
                )
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"GLB export failed: {e}")
            return {"CANCELLED"}

        spec_existed = os.path.exists(spec_path)
        wrote_spec = False
        if not spec_existed or self.force_spec:
            os.makedirs(os.path.dirname(spec_path), exist_ok=True)
            body = derive_bike_spec(bike_id)
            with open(spec_path, "w", encoding="utf-8") as f:
                json.dump(body, f, indent=2)
                f.write("\n")
            wrote_spec = True

        rel_glb = os.path.relpath(glb_path, repo).replace("\\", "/")
        rel_spec = os.path.relpath(spec_path, repo).replace("\\", "/")
        if wrote_spec:
            tag = "rewrote" if spec_existed else "created"
            msg = f"Exported → {rel_glb} ({tag} {rel_spec})"
        else:
            msg = f"Exported → {rel_glb} (kept {rel_spec})"
        self.report({"INFO"}, msg)
        print(f"[kingtide-addon] {msg}")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Rider rig export
# ────────────────────────────────────────────────────────────────────


def find_rider_root() -> bpy.types.Object | None:
    """The prop-root empty wrapping a rideable character rig — ``kind=prop``,
    ``category=character``, with an Armature somewhere beneath it. The rider
    scene also holds a *reference* bike (its own ``bike_root``), so we key off
    these extras rather than "an armature exists". Returns the first match
    (there's normally exactly one), or None."""
    for obj in bpy.data.objects:
        if obj.get("kind") != "prop" or obj.get("category") != "character":
            continue
        if any(c.type == "ARMATURE" for c in obj.children_recursive):
            return obj
    return None


class KINGTIDE_OT_export_rider_pose(Operator):
    """Export the posed rider rig to
    ``public/assets/props/cc0/<prop_id>.glb`` with skins + animation clips +
    the neutral ``COLOR_0`` + the prop extras preserved. Exports the rig
    hierarchy *only* (selection-scoped), so the reference bike and any hidden
    helpers/junk in the posing scene are left out."""

    bl_idname = "kingtide.export_rider_pose"
    bl_label = "Export Ride Pose to Game"
    bl_description = (
        "Export the rider rig (and its animation clips) to props/cc0/<id>.glb, "
        "keeping skins + COLOR_0 + extras. The reference bike and hidden "
        "helpers are excluded — only the prop_*_root rig is written."
    )
    bl_options = {"REGISTER"}

    def execute(self, context: bpy.types.Context) -> set[str]:
        from ._legacy import find_repo_root

        blend = bpy.data.filepath
        if not blend:
            self.report({"ERROR"}, "Save your .blend first (Ctrl+S).")
            return {"CANCELLED"}

        repo = find_repo_root(blend)
        if not repo:
            self.report(
                {"ERROR"},
                "No king-tide clone found. Set 'Project root' in the addon "
                "preferences (or $KINGTIDE_REPO_ROOT) to your repo clone.",
            )
            return {"CANCELLED"}

        root = find_rider_root()
        if root is None:
            self.report(
                {"ERROR"},
                "No rider rig found — need a prop_*_root empty with kind=prop, "
                "category=character, and an Armature beneath it.",
            )
            return {"CANCELLED"}

        prop_id = root.get("prop_id")
        if not isinstance(prop_id, str) or not re.fullmatch(r"[a-z0-9_]+", prop_id):
            self.report(
                {"ERROR"},
                f"prop_id {prop_id!r} on {root.name} must be lowercase "
                "letters, digits, or underscores.",
            )
            return {"CANCELLED"}

        rig = [root, *root.children_recursive]
        meshes = [o for o in rig if o.type == "MESH"]
        arms = [o for o in rig if o.type == "ARMATURE"]
        if not meshes or not arms:
            self.report(
                {"ERROR"},
                f"Rig under {root.name} needs ≥1 mesh and ≥1 armature "
                f"(found {len(meshes)} mesh, {len(arms)} armature).",
            )
            return {"CANCELLED"}

        glb_path = os.path.join(repo, "public", "assets", "props", "cc0", f"{prop_id}.glb")
        os.makedirs(os.path.dirname(glb_path), exist_ok=True)

        # Leave Pose/Edit mode so the export + selection ops have a clean
        # Object-mode context.
        if context.object is not None and context.object.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")

        # Selection-scoped export — the reference bike + hidden junk stay out.
        bpy.ops.object.select_all(action="DESELECT")
        for o in rig:
            o.select_set(True)
        context.view_layer.objects.active = root

        try:
            bpy.ops.export_scene.gltf(
                filepath=glb_path,
                export_format="GLB",
                use_selection=True,
                export_extras=True,  # keep kind / prop_id / animated
                export_yup=True,
                export_apply=True,
                export_skins=True,
                export_animations=True,
                export_vertex_color="ACTIVE",  # keep the neutral COLOR_0…
                export_all_vertex_colors=False,  # …and nothing else as COLOR_1
                export_cameras=False,
                export_lights=False,
            )
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"GLB export failed: {e}")
            return {"CANCELLED"}

        rel = os.path.relpath(glb_path, repo).replace("\\", "/")
        n = len(bpy.data.actions)
        msg = f"Exported rider → {rel} ({n} clip{'' if n == 1 else 's'})"
        self.report({"INFO"}, msg)
        print(f"[kingtide-addon] {msg}")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Seat-offset read-back
# ────────────────────────────────────────────────────────────────────
#
# The runtime positions the mannequin itself — it places the rig ROOT at
# bike-local ``SEAT_LOCAL + SEAT_OFFSET`` (three.js Y-up) every frame, so a
# moved root in Blender does NOT travel through the GLB export. To seat the
# rider interactively we instead READ the root's current bike-local position
# back out as the matching engine ``SEAT_OFFSET``: grab (G) the root on the
# bike, then copy the value into rider-mannequin.ts (it's HMR-live).

# Mirrors SEAT_LOCAL in src/game/entities/rider.ts (three-space, bike-local).
_RIDER_SEAT_LOCAL = (0.0, 0.6, -0.05)


def seat_offset_from_root() -> dict | None:
    """The engine ``SEAT_OFFSET`` (rider-mannequin.ts) that reproduces the rider
    root's current position on the bike. None if no rig is in the scene.

    Blender is Z-up; the glTF importer maps three ``(x,y,z) → (x,-z,y)``, so the
    inverse (Blender bike-local → three) is ``(bx, bz, -by)``. The position is
    taken relative to ``bike_root`` so it's correct even if the reference bike
    was nudged."""
    import mathutils  # noqa: F401  (local — keeps module import light)

    root = find_rider_root()
    if root is None:
        return None
    bike = bpy.data.objects.get("bike_root")
    if bike is not None:
        local = bike.matrix_world.inverted() @ root.matrix_world.to_translation()
    else:
        local = root.matrix_world.to_translation()
    three = (local.x, local.z, -local.y)  # bike-local root position, three-space
    offset = tuple(three[i] - _RIDER_SEAT_LOCAL[i] for i in range(3))
    return {"root_three": three, "seat_offset": offset, "has_bike": bike is not None}


class KINGTIDE_OT_copy_seat_offset(Operator):
    """Copy the engine ``SEAT_OFFSET`` (rider-mannequin.ts) that puts the rider
    where its root sits on the bike right now. Grab (G) the rider root to
    reseat first, then click — paste the line into rider-mannequin.ts (HMR-live,
    so the running game reloads onto the real bike)."""

    bl_idname = "kingtide.copy_seat_offset"
    bl_label = "Copy Seat Offset"
    bl_description = (
        "Copy the SEAT_OFFSET (rider-mannequin.ts) matching the rider root's "
        "current spot on the bike. Grab (G) the root to reseat first."
    )
    bl_options = {"REGISTER"}

    def execute(self, context: bpy.types.Context) -> set[str]:
        data = seat_offset_from_root()
        if data is None:
            self.report({"ERROR"}, "No rider rig (prop_*_root) in the scene.")
            return {"CANCELLED"}
        x, y, z = data["seat_offset"]
        line = f"const SEAT_OFFSET = {{ x: {x:.3f}, y: {y:.3f}, z: {z:.3f} }}"
        context.window_manager.clipboard = line
        tail = "" if data["has_bike"] else "  (no bike_root — used world origin)"
        self.report({"INFO"}, f"Copied → {line}{tail}")
        print(f"[kingtide-addon] seat offset copied: {line}{tail}")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Bike-reference refresh (rider posing bench)
# ────────────────────────────────────────────────────────────────────
#
# The rider posing scene shows each bike as an IMPORTED COPY of its exported
# GLB (not a live link), positioned so the bike's socket_seat lands on the rig
# root — i.e. exactly where the runtime seats the rider (rider-mannequin.ts).
# After re-exporting a bike from bikes-src/, run this to pull the updated shapes
# back in. The refs are selection-locked (hide_select) so they can't be
# accidentally edited: pose work happens on the rig, geometry in bikes-src/.

_BIKE_REF_PARENT = "_posing_refs"
# GLBs in public/assets/bikes/ that aren't rideable ship bikes.
_BIKE_REF_SKIP = {"calibration", "bike-validation", "bike-autogen"}


def _refresh_bike_refs(repo: str) -> dict:
    """Rebuild ``_posing_refs/ref_<id>`` from the current bike GLBs, each aligned
    so its ``socket_seat`` sits on the rider rig root. Returns a report dict;
    raises ``ValueError`` with a user-facing message on setup problems."""
    root = find_rider_root()
    if root is None:
        raise ValueError("No rider rig (prop_*_root) in the scene.")
    bikes_dir = os.path.join(repo, "public", "assets", "bikes")
    if not os.path.isdir(bikes_dir):
        raise ValueError(f"No bikes folder at {bikes_dir} (export a bike first).")
    glbs = sorted(
        f[:-4]
        for f in os.listdir(bikes_dir)
        if f.lower().endswith(".glb") and f[:-4] not in _BIKE_REF_SKIP
    )
    if not glbs:
        raise ValueError("No bike GLBs found to reference.")

    anchor = root.matrix_world.translation.copy()

    parent = bpy.data.collections.get(_BIKE_REF_PARENT)
    if parent is None:
        parent = bpy.data.collections.new(_BIKE_REF_PARENT)
        bpy.context.scene.collection.children.link(parent)

    # Remember which bike was on screen so the rebuild doesn't change the view.
    prev_shown = next(
        (c.name[4:] for c in parent.children if c.name.startswith("ref_") and not c.hide_viewport),
        None,
    )

    imported_per = {}
    for bid in glbs:
        old = bpy.data.collections.get(f"ref_{bid}")
        if old is not None:
            for o in list(old.objects):
                bpy.data.objects.remove(o, do_unlink=True)
            try:
                parent.children.unlink(old)
            except Exception:  # noqa: BLE001
                pass
            bpy.data.collections.remove(old)
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(bikes_dir, f"{bid}.glb"))
        imported = [o for o in bpy.data.objects if o not in before]
        bpy.context.view_layer.update()
        sock = next(
            (o for o in imported if (o.get("slot") == "seat") or o.name.startswith("socket_seat")),
            None,
        )
        roots = [o for o in imported if o.parent not in imported]
        if sock is not None:
            offset = anchor - sock.matrix_world.translation
            for r in roots:
                r.location = r.location + offset
        bpy.context.view_layer.update()
        col = bpy.data.collections.new(f"ref_{bid}")
        parent.children.link(col)
        for o in imported:
            for c in list(o.users_collection):
                c.objects.unlink(o)
            col.objects.link(o)
            o.hide_select = True  # reference geometry: visible, not grabbable
        imported_per[bid] = len(imported)

    # Restore which ref is shown: previously-shown bike, else racer, else first.
    shown = prev_shown if prev_shown in glbs else ("racer" if "racer" in glbs else glbs[0])
    for bid in glbs:
        c = bpy.data.collections.get(f"ref_{bid}")
        if c is not None:
            c.hide_viewport = bid != shown

    # Purge data orphaned by the removed copies (incl. any accidental edits).
    purged = 0
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for d in list(coll):
            if d.users == 0:
                coll.remove(d)
                purged += 1

    return {"bikes": list(glbs), "shown": shown, "imported": imported_per, "purged": purged}


class KINGTIDE_OT_refresh_bike_refs(Operator):
    """Re-import every bike's current GLB into the posing scene as a
    selection-locked, socket-aligned reference (rig root = where the runtime
    seats the rider). Run after re-exporting a bike from ``bikes-src/``."""

    bl_idname = "kingtide.refresh_bike_refs"
    bl_label = "Refresh Bike Refs"
    bl_description = (
        "Re-import all bikes' current GLBs as selection-locked, socket-aligned "
        "posing references. Run after re-exporting a bike. Save to keep."
    )
    bl_options = {"REGISTER"}

    def execute(self, context: bpy.types.Context) -> set[str]:
        from ._legacy import find_repo_root

        blend = bpy.data.filepath
        if not blend:
            self.report({"ERROR"}, "Save your .blend first (Ctrl+S).")
            return {"CANCELLED"}
        repo = find_repo_root(blend)
        if not repo:
            self.report(
                {"ERROR"},
                "No king-tide clone found. Set 'Project root' in the addon "
                "preferences (or $KINGTIDE_REPO_ROOT).",
            )
            return {"CANCELLED"}
        try:
            rep = _refresh_bike_refs(repo)
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"Refresh failed: {e}")
            return {"CANCELLED"}
        n = len(rep["bikes"])
        msg = f"Refreshed {n} bike ref{'' if n == 1 else 's'} (showing {rep['shown']}). Save to keep."
        self.report({"INFO"}, msg)
        print(f"[kingtide-addon] {msg}: {rep}")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# URL helpers
# ────────────────────────────────────────────────────────────────────


class KINGTIDE_OT_copy_track_url(Operator):
    """Copy ``http://localhost:5191/?track=<id>`` (optionally
    ``&edit=1``) to the clipboard. Doesn't open a browser itself."""

    bl_idname = "kingtide.copy_track_url"
    bl_label = "Copy Play URL"
    bl_description = "Copy the dev-server URL for this track to the clipboard."
    bl_options = {"REGISTER"}

    edit: BoolProperty(  # type: ignore[valid-type]
        name="Edit mode",
        description="Append &edit=1 so the URL opens the in-app editor.",
        default=False,
    )

    def execute(self, context: bpy.types.Context) -> set[str]:
        from ._legacy import derive_asset_id

        track_id = derive_asset_id("hoverbike_track_id")
        if not track_id:
            self.report({"ERROR"}, "Save your .blend first to derive a track id.")
            return {"CANCELLED"}
        servers = _detect_dev_servers(track_id, _resolve_repo_root_safe())
        port = _best_dev_port(servers)
        url = f"http://localhost:{port}/?track={track_id}"
        if self.edit:
            url += "&edit=1"
        context.window_manager.clipboard = url
        self.report({"INFO"}, f"Copied: {url}  (dev servers: {_fmt_servers(servers)})")
        return {"FINISHED"}


class KINGTIDE_OT_copy_bike_url(Operator):
    """Copy ``http://localhost:5191/?bike=<id>`` (or
    ``?viewer=<id>``) to the clipboard."""

    bl_idname = "kingtide.copy_bike_url"
    bl_label = "Copy Play URL"
    bl_description = "Copy the dev-server URL for this bike to the clipboard."
    bl_options = {"REGISTER"}

    viewer: BoolProperty(  # type: ignore[valid-type]
        name="Viewer mode",
        description=(
            "Use ?viewer=<id> instead of ?bike=<id> so the URL opens the "
            "stand-alone bike viewer instead of a full game."
        ),
        default=False,
    )

    def execute(self, context: bpy.types.Context) -> set[str]:
        from ._legacy import derive_asset_id

        bike_id = derive_asset_id("hoverbike_bike_id")
        if not bike_id:
            self.report({"ERROR"}, "Save your .blend first to derive a bike id.")
            return {"CANCELLED"}
        param = "viewer" if self.viewer else "bike"
        url = f"http://localhost:5191/?{param}={bike_id}"
        context.window_manager.clipboard = url
        self.report({"INFO"}, f"Copied to clipboard: {url}")
        return {"FINISHED"}


class KINGTIDE_OT_detect_dev_servers(Operator):
    """Scan localhost for running King Tide dev servers and report which
    ports they're on — flagging the one serving THIS repo's track. Handy
    when several clones / branches each run ``pnpm dev``: Vite falls through
    5191 → 5192 → … so "Play in Browser" can otherwise land on a stale one."""

    bl_idname = "kingtide.detect_dev_servers"
    bl_label = "Find Dev Servers"
    bl_description = (
        "Scan localhost:5191-5195 for running King Tide dev servers; flags the "
        "port serving this repo so you open the right clone"
    )
    bl_options = {"REGISTER"}

    def execute(self, context: bpy.types.Context) -> set[str]:
        from ._legacy import derive_asset_id

        track_id = derive_asset_id("hoverbike_track_id") or "the-maw"
        servers = _detect_dev_servers(track_id, _resolve_repo_root_safe())
        if not servers:
            self.report(
                {"WARNING"},
                f"No King Tide dev server on :{_DEV_SERVER_PORTS[0]}-:{_DEV_SERVER_PORTS[-1]} "
                "— start one with `pnpm dev`.",
            )
        else:
            self.report({"INFO"}, f"Dev servers: {_fmt_servers(servers)}")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    KINGTIDE_OT_open_play_url,
    KINGTIDE_OT_detect_dev_servers,
    KINGTIDE_OT_reload_track_json,
    KINGTIDE_OT_export_track,
    KINGTIDE_OT_export_bike,
    KINGTIDE_OT_export_rider_pose,
    KINGTIDE_OT_copy_seat_offset,
    KINGTIDE_OT_refresh_bike_refs,
    KINGTIDE_OT_copy_track_url,
    KINGTIDE_OT_copy_bike_url,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.Scene.hoverbike_export_and_play = BoolProperty(
        name="Auto-open browser after export",
        description=(
            "When set, a successful Export Track to Game opens the dev "
            "server's Play URL for this track in the default browser. "
            "Skipped on validation / GLB-write failures so a failed export "
            "doesn't pop a window over a still-broken scene"
        ),
        default=False,
    )


def unregister() -> None:
    try:
        delattr(bpy.types.Scene, "hoverbike_export_and_play")
    except AttributeError:
        pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
