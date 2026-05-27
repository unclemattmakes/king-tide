"""Live-preview auto-rebuild infrastructure.

Make the spline-driven previews (gates, turn indicators, racer grid,
water plane, boost pads, placement helper) follow their source edits
without the author having to click Rebuild after every move. We watch
the source objects via a persistent depsgraph_update_post handler,
plus the relevant scene props via FloatProperty ``update=`` callbacks
in the per-domain modules, debounce both into a single deferred batch
via a one-shot ``bpy.app.timer`` (~0.2 s), and only rebuild a preview
if its collection already exists — so the user still opts in
explicitly by clicking *Rebuild* once, then enjoys automatic updates.

Also owns the load_post handler that auto-syncs a track .blend with
``public/tracks/<id>.json`` when the file is opened.

The actual rebuild functions live in each preview's home module
(previews.py, turn_indicators.py, water.py, etc.); this module only
hosts the timer/handler plumbing and the dispatch table.
"""

from __future__ import annotations

import os
import re

import bpy
from bpy.app.handlers import persistent


# ────────────────────────────────────────────────────────────────────
# Debounced rebuild dispatch
# ────────────────────────────────────────────────────────────────────

# Names of source objects whose edits should trigger a rebuild. Any
# datablock update that matches one of these (object or its data —
# moving a curve's control points updates the Curve, not the Object)
# schedules the listed preview kinds.
_WATCHED_SOURCES: tuple[tuple[str, tuple[str, ...]], ...] = (
    # ai_spline_main feeds the gameplay previews AND is the fallback
    # road curve when there's no dedicated road_curve_main — edits
    # here rebuild the road mesh too so authors who use a single
    # curve for both racing line and road see the road follow live.
    # "starts" is conditional on the scene's bound flag — the
    # dispatch in _run_pending_rebuilds skips when not bound.
    # "buoys" fires on spline edits because buoys are racing-line
    # markers (gate_buoys.py samples ai_spline_main directly).
    # road_curve_main does NOT fire "buoys" — buoys are decoupled
    # from the road tool entirely.
    ("ai_spline_main",   ("gates", "turns", "helper", "road", "starts", "buoys", "path_wear")),
    ("road_curve_main",  ("road",)),
    ("start_00",         ("racer",)),
    # Editing the legacy water volume changes both the surface and
    # the over-water flag for every buoy sample, so refresh both.
    ("water_volume_main", ("water", "buoys")),
)

_pending_rebuilds: set[str] = set()
_rebuild_timer_scheduled = False
_REBUILD_DEBOUNCE_S = 0.2


def _schedule_rebuild(kind: str) -> None:
    """Mark a preview kind dirty and arm the single shared timer. Safe
    to call from depsgraph handlers and property update callbacks."""
    global _rebuild_timer_scheduled
    _pending_rebuilds.add(kind)
    if _rebuild_timer_scheduled:
        return
    _rebuild_timer_scheduled = True
    bpy.app.timers.register(_run_pending_rebuilds, first_interval=_REBUILD_DEBOUNCE_S)


def _run_pending_rebuilds():
    """Fire each pending rebuild. Only acts on a preview kind if its
    collection already exists — the *Hide* operator only toggles
    view-layer visibility (`exclude=True`) and leaves the collection
    in place, so hidden previews still auto-update silently and become
    fresh when the user un-hides them."""
    from . import boost_pad as _boost_pad_mod
    from . import placement_helper as _placement_helper_mod
    from . import previews as _previews_mod
    from . import turn_indicators as _turn_indicators_mod
    from . import water as _water_mod
    from .placement_helper import PLACEMENT_HELPER_NAME
    from .previews import GATE_PREVIEW_COLLECTION, RACER_PREVIEW_COLLECTION
    from .turn_indicators import TURN_PREVIEW_COLLECTION
    from .water import WATER_PREVIEW_COLLECTION

    global _rebuild_timer_scheduled
    _rebuild_timer_scheduled = False
    pending = set(_pending_rebuilds)
    _pending_rebuilds.clear()

    scene = bpy.context.scene
    if scene is None:
        return None

    if "gates" in pending and bpy.data.collections.get(GATE_PREVIEW_COLLECTION):
        try:
            _previews_mod._rebuild_gate_preview(
                scene,
                spacing=float(scene.hoverbike_gate_spacing),
                half_width=float(scene.hoverbike_gate_half_width),
                height=float(scene.hoverbike_gate_height),
            )
        except (RuntimeError, AttributeError):
            pass

    if "turns" in pending and bpy.data.collections.get(TURN_PREVIEW_COLLECTION):
        try:
            _turn_indicators_mod.rebuild_turn_indicators(
                scene,
                kappa_threshold=float(scene.hoverbike_turn_kappa),
                min_spacing_m=float(scene.hoverbike_turn_min_spacing),
            )
        except (RuntimeError, AttributeError):
            pass

    if "racer" in pending and bpy.data.collections.get(RACER_PREVIEW_COLLECTION):
        try:
            _previews_mod._rebuild_racer_preview(scene)
        except (RuntimeError, AttributeError):
            pass

    # Bound-start re-snap: when the user has bound the start pair to
    # ai_spline_main, edits to the curve (or to hoverbike_start_t /
    # spacing via property update callbacks) should re-derive
    # start_00/01 positions. Calling bpy.ops here is safe — we're on
    # the timer tick, outside the depsgraph update loop.
    if "starts" in pending and bool(getattr(scene, "hoverbike_start_bound_to_spline", False)):
        try:
            bpy.ops.hoverbike.snap_starts_to_spline()
        except (RuntimeError, AttributeError):
            pass

    if "water" in pending and bpy.data.collections.get(WATER_PREVIEW_COLLECTION):
        try:
            _water_mod.rebuild_water_preview(
                scene,
                size=float(scene.hoverbike_water_size),
                subdivisions=int(scene.hoverbike_water_subdivisions),
                time=float(scene.hoverbike_water_time),
            )
        except (RuntimeError, AttributeError):
            pass

    if "boosts" in pending:
        try:
            _boost_pad_mod.refresh_boost_pad_gizmos(scene)
        except (RuntimeError, AttributeError):
            pass

    # Road mesh auto-rebuild — only fires if the user has already run
    # Build Road once (= a road_main exists). Skipping until the
    # explicit first build preserves the "opt-in, then automatic"
    # pattern the other previews use, and avoids spamming rebuilds
    # for authors who only care about the curve, not the asphalt
    # strip.
    has_road = bpy.data.objects.get("road_main") is not None
    if "road" in pending and has_road:
        try:
            from . import road as _road_mod
            _road_mod.rebuild_road_main(scene)
        except (RuntimeError, AttributeError):
            pass

    # Buoy rebuild — fires on spline / water edits via gate_buoys.
    # Decoupled from the road tool: a road rebuild on the same tick
    # used to suppress this, but buoys now follow ai_spline_main
    # directly and never sample road samples, so there's nothing to
    # double-build. The master enable + water-present check live
    # inside rebuild_buoys so this dispatch is cheap when those
    # gates aren't met.
    if "buoys" in pending:
        try:
            from . import gate_buoys as _gate_buoys_mod
            _gate_buoys_mod.rebuild_buoys(scene)
        except (RuntimeError, AttributeError):
            pass

    if "helper" in pending and bpy.data.objects.get(PLACEMENT_HELPER_NAME) is not None:
        try:
            _placement_helper_mod.repose_placement_helper(scene)
        except (RuntimeError, AttributeError):
            pass

    # Path-wear auto-rebake. Self-gated in bake.py: only fires if the
    # terrain already has a baked_path attribute (= user has clicked
    # Bake at least once OR run Apply Vertex Colors). Re-stamps COLOR_0
    # after the bake so the Blender material preview reflects the new
    # band immediately. ~1 s on a 16 k-vert terrain; longer on denser
    # meshes — debounce keeps it tolerable during continuous drags.
    if "path_wear" in pending:
        try:
            from . import bake as _bake_mod
            ok, msg = _bake_mod.auto_rebake_path_wear_on_curve_edit(scene)
            if not ok:
                # Informational only — the export hook will catch it next
                # time the author actually exports. We don't pop a UI
                # error from a timer because that would interrupt their
                # edit flow.
                print(f"[hoverbike] {msg}")
        except (RuntimeError, AttributeError) as e:
            print(f"[hoverbike] auto path-wear rebake errored: {e}")

    # Drag-to-snap path: depsgraph saw the helper move to a position
    # that doesn't match what repose last wrote, so the user grabbed it
    # via the manipulator. Reproject onto the curve — nearest t +
    # signed perpendicular offset — and repose with the proper yaw + Z.
    # The snap function suppresses the prop-update callback while it
    # writes scene props so this stays a single tick of work.
    if "helper_drag" in pending and bpy.data.objects.get(PLACEMENT_HELPER_NAME) is not None:
        try:
            _placement_helper_mod.snap_helper_to_curve_from_world(scene)
        except (RuntimeError, AttributeError):
            pass

    return None  # one-shot — don't reschedule


def _update_matches_source(upd, source_name: str) -> bool:
    """True if a depsgraph update refers to the named object or its
    data datablock. NURBS edits land as Curve-data updates, not Object
    updates, so we have to check both.

    `upd.id` in Blender 4.4+ is the *evaluated* copy; equality against
    the original datablock returns False. `.original` walks back to
    the source so the comparison works."""
    obj = bpy.data.objects.get(source_name)
    if obj is None:
        return False
    orig = getattr(upd.id, "original", upd.id)
    if orig == obj:
        return True
    if obj.data is not None and orig == obj.data:
        return True
    return False


# ────────────────────────────────────────────────────────────────────
# Library reload
# ────────────────────────────────────────────────────────────────────

# Libraries whose content can drift while a track .blend is open in
# another window. The load_post handler force-refreshes these so the
# "I edited props-library.blend in another Blender, opened my track,
# the change isn't there" gotcha can't bite. Authors can add their own
# names here if a new shared library lands.
_RELOADABLE_LIBRARY_BASENAMES: tuple[str, ...] = (
    "props-library.blend",
    "landmarks-library.blend",
)


def reload_hoverbike_libraries() -> list[str]:
    """Reload every linked library whose file basename matches a
    Hoverbike-managed library. Returns the list of basenames actually
    reloaded (empty list if none were linked).

    Shared between the load_post handler (auto-reload on every track
    .blend open) and the *Reload Props / Landmarks Library* operator
    (manual button in the Utility menu)."""
    reloaded: list[str] = []
    for lib in list(bpy.data.libraries):
        try:
            basename = os.path.basename(bpy.path.abspath(lib.filepath))
        except Exception:  # noqa: BLE001 — filepath can be missing
            basename = os.path.basename(lib.filepath or "")
        if basename not in _RELOADABLE_LIBRARY_BASENAMES:
            continue
        try:
            lib.reload()
            reloaded.append(basename)
        except Exception as e:  # noqa: BLE001
            print(f"[hoverbike] library reload failed for {basename}: {e}")
    return reloaded


# ────────────────────────────────────────────────────────────────────
# Persistent handlers
# ────────────────────────────────────────────────────────────────────


@persistent
def _hoverbike_load_post(*_args):
    """On every .blend open: refresh any Hoverbike libraries the file
    links (so edits to props-library.blend or landmarks-library.blend
    made in a separate Blender window show up immediately), then in
    track mode pull scalar fields from the per-track JSON back into
    the scene.

    Runs after the file's data is in memory so `bpy.data.objects` and
    `bpy.data.libraries` are populated."""
    from ._legacy import derive_asset_id, detect_mode, find_repo_root, reload_track_from_json

    blend = bpy.data.filepath
    if not blend:
        return

    # 1. Library reload — runs for any .blend that has linked the
    #    relevant libraries (tracks today, conceivably bike .blends too
    #    if they ever link the props library for emissive decals). Cheap
    #    when nothing is linked.
    reloaded = reload_hoverbike_libraries()
    if reloaded:
        print(f"[hoverbike] auto-reloaded {len(reloaded)} library file(s): {', '.join(reloaded)}")

    # 2. Track-mode-only steps. Bail early on bike .blends and the
    #    asset libraries — they don't carry terrain material or per-
    #    track JSON.
    if detect_mode(blend) != "track":
        return

    # 2a. Terrain material upgrade. Track .blends saved before
    #     ``TERRAIN_MATERIAL_VERSION`` was bumped carry stale
    #     ``mat_terrain_main`` graphs (e.g. v0 has no racing-line wear
    #     visualisation; v2 added the COLOR_0.B → dirt-tint block).
    #     ``ensure_mat_terrain_main`` is the canonical upgrade entry
    #     point; calling it here on every open guarantees a freshly-
    #     opened .blend always shows the current preview without
    #     forcing the author to run an operator manually.
    #
    #     Guarded on "material already exists" so opening a .blend
    #     that never had terrain coloration set up (a hand-authored
    #     scene with no terrain mesh, say) doesn't suddenly grow a
    #     ``mat_terrain_main`` block. ``ensure_mat_terrain_main`` itself
    #     is idempotent on an up-to-date material — its own version
    #     check returns early if nothing needs rebuilding.
    if "mat_terrain_main" in bpy.data.materials:
        try:
            from .terrain_material import ensure_mat_terrain_main

            ensure_mat_terrain_main()
        except Exception as e:  # noqa: BLE001 — informational only
            print(f"[hoverbike] terrain material auto-upgrade skipped: {e}")

    # 2b. JSON sync — track .blends only.
    repo = find_repo_root(blend)
    if not repo:
        return
    track_id = derive_asset_id("hoverbike_track_id")
    if not track_id:
        return
    json_path = os.path.join(repo, "public", "tracks", f"{track_id}.json")
    if not os.path.isfile(json_path):
        return
    try:
        reload_track_from_json(json_path)
    except Exception as e:  # noqa: BLE001 — informational only
        print(f"[hoverbike] auto-reload-from-JSON skipped: {e}")


def _update_is_real_edit(upd) -> bool:
    """Return True only when the depsgraph update represents an
    actual GEOMETRY or TRANSFORM change, not just a re-evaluation or
    a shading-graph touch.

    Blender's ``depsgraph.updates`` lists every node that was
    *evaluated* on the current tick, not only the ones that *changed*
    — so a curve that's read by a downstream Geometry Nodes modifier
    (Object Info on the proxy) shows up in the list even when the
    curve itself wasn't edited.

    Shading also gets excluded specifically: adding a material to the
    rebuilt road mesh fires `is_updated_shading=True` on every object
    in the scene, including the curve. Treating those as edits caused
    the rebuild to self-trigger an infinite loop — symptom was
    modifier-panel sliders flickering and being un-clickable because
    the UI was redrawn every ~0.2 s (the debounce interval). Road
    rebuilds care only about geometry / transform changes; shading
    changes don't reshape the road."""
    return bool(
        getattr(upd, "is_updated_geometry", False)
        or getattr(upd, "is_updated_transform", False)
    )


@persistent
def _hoverbike_depsgraph_post(scene, depsgraph):
    """Run on every depsgraph evaluation; cheap unless something we
    care about just changed. The actual rebuild runs from a debounced
    timer outside this callback, so we never block evaluation."""
    from .placement_helper import (
        PLACEMENT_HELPER_NAME,
        helper_position_matches_last_repose,
    )

    try:
        updates = depsgraph.updates
    except AttributeError:
        return
    for upd in updates:
        if not _update_is_real_edit(upd):
            continue
        for source_name, kinds in _WATCHED_SOURCES:
            if _update_matches_source(upd, source_name):
                for k in kinds:
                    _schedule_rebuild(k)
        # Boost pads use a name pattern (boost_NN) rather than a single
        # canonical name, so we walk the update list separately. The
        # `original` attribute is the source datablock; we match its
        # name against the pad regex.
        try:
            orig = getattr(upd.id, "original", upd.id)
            name = getattr(orig, "name", "") or ""
        except (AttributeError, ReferenceError):
            continue
        if re.match(r"^boost_\d+$", name):
            _schedule_rebuild("boosts")
        # Helper drag-to-snap: when the placement helper's transform
        # updates AND the new position differs from what repose last
        # wrote, treat it as a user drag and schedule a reproject onto
        # the curve. The position check is what breaks the otherwise
        # endless cycle of "repose writes location → depsgraph fires →
        # schedules another drag-snap" — once we're back on the curve
        # the helper's position matches and we stop scheduling.
        if name == PLACEMENT_HELPER_NAME and getattr(upd, "is_updated_transform", False):
            helper_obj = bpy.data.objects.get(PLACEMENT_HELPER_NAME)
            if helper_obj is not None and not helper_position_matches_last_repose(
                helper_obj.matrix_world.translation
            ):
                _schedule_rebuild("helper_drag")


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


def register() -> None:
    # Persistent depsgraph hook so previews follow source edits across
    # file reloads. Idempotent — guard against re-registering if the
    # addon is reloaded.
    if _hoverbike_depsgraph_post not in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.append(_hoverbike_depsgraph_post)
    # Auto-reload track JSON when a track .blend opens.
    if _hoverbike_load_post not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(_hoverbike_load_post)


def unregister() -> None:
    # Detach handlers first so a partially-unregistered state can't fire
    # a callback into nonexistent properties.
    try:
        bpy.app.handlers.depsgraph_update_post.remove(_hoverbike_depsgraph_post)
    except ValueError:
        pass
    try:
        bpy.app.handlers.load_post.remove(_hoverbike_load_post)
    except ValueError:
        pass
    # Drop any pending debounced rebuild so we don't try to fire after
    # the operators / scene props are gone.
    _pending_rebuilds.clear()
    try:
        bpy.app.timers.unregister(_run_pending_rebuilds)
    except (ValueError, TypeError):
        pass
