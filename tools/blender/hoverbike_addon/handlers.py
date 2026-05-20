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
    ("ai_spline_main",   ("gates", "turns", "helper")),
    ("start_00",         ("racer",)),
    ("water_volume_main", ("water",)),
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

    if "helper" in pending and bpy.data.objects.get(PLACEMENT_HELPER_NAME) is not None:
        try:
            _placement_helper_mod.repose_placement_helper(scene)
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

    # 2. JSON sync — track .blends only.
    if detect_mode(blend) != "track":
        return
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


@persistent
def _hoverbike_depsgraph_post(scene, depsgraph):
    """Run on every depsgraph evaluation; cheap unless something we
    care about just changed. The actual rebuild runs from a debounced
    timer outside this callback, so we never block evaluation."""
    try:
        updates = depsgraph.updates
    except AttributeError:
        return
    for upd in updates:
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
