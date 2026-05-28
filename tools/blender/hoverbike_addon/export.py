"""Asset export operators: track / bike GLB export, the spec / track
JSON writers, plus the lightweight URL / Play helpers that pair with
them.

The actual validation, JSON derivation, and manifest-upsert logic
still live in `_legacy.py` (they cross-cut everything else in the
addon's plumbing). This module owns only the user-facing operators
so the export commands have a clear home in the package.

  * ``HOVERBIKE_OT_export_track``      — validate + write track GLB
    + merge parametric scene fields into public/tracks/<id>.json.
  * ``HOVERBIKE_OT_export_bike``       — validate + write bike GLB,
    materialise specs/bikes/<id>.json on first export.
  * ``HOVERBIKE_OT_open_play_url``     — open the dev-server URL in
    a browser.
  * ``HOVERBIKE_OT_reload_track_json`` — pull scalar / parametric
    fields from the JSON back into scene props.
  * ``HOVERBIKE_OT_copy_track_url`` / ``copy_bike_url`` — clipboard
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
        if isinstance(src.data, bpy.types.Mesh) and len(src.data.vertices) > 0:
            return src
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
                    # Try to bake the evaluated source (modifiers
                    # applied) into a fresh mesh datablock. Works for
                    # local objects with modifiers.
                    eval_src = src_original.evaluated_get(depsgraph)
                    try:
                        baked = bpy.data.meshes.new_from_object(eval_src)
                    except RuntimeError:
                        # ``new_from_object`` raises "Object does not
                        # have geometry data" for linked-from-library
                        # sources whose modifier stack isn't being
                        # evaluated by the depsgraph (it isn't when
                        # the source is only referenced via a
                        # Collection Info → Instance on Points chain
                        # and never placed directly in the scene).
                        baked = None

                    if baked is not None and len(baked.vertices) > 0:
                        baked.name = f"_hb_scatter_frozen_{src_original.name}"
                        frozen = baked
                        frozen_meshes.append(frozen)
                    else:
                        # Bake produced no geometry — fall back to
                        # reusing the source mesh datablock directly.
                        # The linked mesh's stored data IS the final
                        # shape (any HV_Prop modifier ran at seed time
                        # and got baked into the saved mesh), and the
                        # glTF exporter dedupes by mesh-data id, so all
                        # leaf objects pointing at the same source mesh
                        # collapse into EXT_mesh_gpu_instancing. We
                        # don't add this to frozen_meshes — the
                        # finally-block cleanup leaves it alone, which
                        # is exactly right because we don't own it.
                        if baked is not None:
                            bpy.data.meshes.remove(baked)
                        src_mesh = (
                            src_original.data
                            if isinstance(src_original.data, bpy.types.Mesh)
                            else None
                        )
                        if src_mesh is None or len(src_mesh.vertices) == 0:
                            print(
                                f"[hoverbike] WARN realize: {src_original.name!r} "
                                f"yielded no geometry — skipping"
                            )
                            continue
                        frozen = src_mesh
                    mesh_cache[cache_key] = frozen
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


class HOVERBIKE_OT_open_play_url(Operator):
    """Open the current track's Play URL in the default browser. The
    addon already has *Copy Play URL*; this is the one-click version
    that skips clipboard + paste. Assumes the dev server is running at
    `http://localhost:5191` (Vite's default for the project)."""

    bl_idname = "hoverbike.open_play_url"
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
        url = f"http://localhost:5191/?track={track_id}"
        if self.edit:
            url += "&edit=1"
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception as e:  # noqa: BLE001 — webbrowser fallbacks vary by platform
            self.report({"ERROR"}, f"Couldn't launch browser: {e}")
            return {"CANCELLED"}
        self.report({"INFO"}, f"Opened {url}")
        return {"FINISHED"}


class HOVERBIKE_OT_reload_track_json(Operator):
    """Pull scalar / parametric fields from ``public/tracks/<id>.json``
    into the scene's custom properties (gate spacing, terrain shader,
    water knobs, start pose). Lets edits made in the in-app editor
    flow back into the .blend without re-launching the addon."""

    bl_idname = "hoverbike.reload_track_json"
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
            self.report({"ERROR"}, "No repo root found — .blend isn't inside a hoverbike clone.")
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
        synced = [k for k in ("gateSpacing", "terrainShader", "water", "start") if k in summary]
        self.report({"INFO"}, f"Reloaded {summary['json']}: {', '.join(synced) or 'no syncable fields'}")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Track export
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_export_track(Operator):
    """Validate the track scene, write
    ``public/assets/tracks/<id>.glb``, and rewrite
    ``public/tracks/<id>.json`` with the .blend's parametric state
    merged on top of the existing JSON. Editor-owned fields (hand-
    placed gates, pickups, props) are preserved; Blender-owned fields
    (gate spacing, terrain shader, water, spline anchors, start) come
    from the .blend."""

    bl_idname = "hoverbike.export_track"
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
                "Save your .blend inside a hoverbike clone (typically tracks-src/).",
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
                 _RealizedScatterInstances(context.scene) as scatter_count:
                if scatter_count:
                    print(f"[hoverbike-addon] realized {scatter_count} scatter instance(s) for GLB export")
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
                print(f"[hoverbike-addon] {msg}")
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
        print(f"[hoverbike-addon] {msg}")

        # Optional one-click playtest: open the dev server's Play URL
        # in the browser as soon as the export lands. Gated on the
        # Auto-open scene prop so authors who don't have the dev server
        # running aren't ambushed by a doomed browser tab on every
        # export. Failure of the browser launch is non-fatal — the
        # export already succeeded by the time we get here.
        if bool(getattr(context.scene, "hoverbike_export_and_play", False)):
            try:
                bpy.ops.hoverbike.open_play_url(edit=False)
            except (RuntimeError, AttributeError) as e:  # noqa: BLE001
                self.report({"WARNING"}, f"Auto-open after export skipped: {e}")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Bike export
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_export_bike(Operator):
    """Validate the bike scene, write
    ``public/assets/bikes/<id>.glb``, and on first export materialise
    a starter ``specs/bikes/<id>.json`` from ``bike_root`` extras +
    the bike's authored materials. Subsequent exports preserve the
    spec; Shift-click rewrites it from the .blend."""

    bl_idname = "hoverbike.export_bike"
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
                "Save your .blend inside a hoverbike clone (typically bikes-src/).",
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
        print(f"[hoverbike-addon] {msg}")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# URL helpers
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_copy_track_url(Operator):
    """Copy ``http://localhost:5191/?track=<id>`` (optionally
    ``&edit=1``) to the clipboard. Doesn't open a browser itself."""

    bl_idname = "hoverbike.copy_track_url"
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
        url = f"http://localhost:5191/?track={track_id}"
        if self.edit:
            url += "&edit=1"
        context.window_manager.clipboard = url
        self.report({"INFO"}, f"Copied to clipboard: {url}")
        return {"FINISHED"}


class HOVERBIKE_OT_copy_bike_url(Operator):
    """Copy ``http://localhost:5191/?bike=<id>`` (or
    ``?viewer=<id>``) to the clipboard."""

    bl_idname = "hoverbike.copy_bike_url"
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


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_open_play_url,
    HOVERBIKE_OT_reload_track_json,
    HOVERBIKE_OT_export_track,
    HOVERBIKE_OT_export_bike,
    HOVERBIKE_OT_copy_track_url,
    HOVERBIKE_OT_copy_bike_url,
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
