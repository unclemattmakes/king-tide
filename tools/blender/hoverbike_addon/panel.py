"""Sidebar panel + track sub-panels.

All the UI definitions — what the author sees in the View3D N-panel
under the "Hoverbike" tab — live here. The parent ``HOVERBIKE_PT_panel``
dispatches between track / bike / unknown asset modes; track .blends
get a collapsible sub-panel per domain (spline, road, tunnels, ramps,
terrain, water, gameplay, ghost lap, shader, stats).

Most per-domain sub-panels are **selection-driven**: they only appear
when the active object is the one the panel acts on (the spline panel
shows up when ``ai_spline_main`` is selected, the road panel when
``road_curve_main`` or a road mesh is selected, and so on). The
scene-wide knobs (Stats, Sky, Shader, Hero) stay always-visible at
the bottom of the stack — there's no object to "select" to bring them
up. The top-bar Hoverbike menu (``menu.py``) is the always-available
discovery surface for adding new objects or running an operator when
nothing relevant is selected.

This module is pure UI: it consumes operators + scene props registered
by the per-domain modules and arranges them into a usable interface.
No business logic here.
"""

from __future__ import annotations

import os
import re

import bpy
from bpy.types import Panel

# HOVERBIKE_PT_track_emitters lives in emitter.py (panel draw uses
# module-local helpers there) but registers via this module so its
# parent panel HOVERBIKE_PT_panel is in bpy.types first — panel runs
# last in addon._MODULES.
from .emitter import HOVERBIKE_PT_track_emitters


# ────────────────────────────────────────────────────────────────────
# Top-level sidebar panel
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_PT_panel(Panel):
    bl_label = "Hoverbike"
    bl_idname = "HOVERBIKE_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Hoverbike"

    def draw(self, context: bpy.types.Context) -> None:
        from ._legacy import detect_mode, find_repo_root

        layout = self.layout
        blend = bpy.data.filepath
        if not blend:
            layout.label(text="Save your .blend first.", icon="ERROR")
            return

        repo = find_repo_root(blend)
        mode = detect_mode(blend)

        if mode == "track":
            self._draw_track(context, layout, blend, repo)
        elif mode == "bike":
            self._draw_bike(context, layout, blend, repo)
        else:
            self._draw_unknown(context, layout, blend, repo)

    def _draw_track(self, context, layout, blend: str, repo: str | None) -> None:
        """Parent-panel content for track-mode .blends. The bulk of the
        UI lives in sub-panels (HOVERBIKE_PT_track_*) so authors can
        collapse the sections they aren't currently using. This method
        just shows the always-relevant header: track id, big Export
        button, lint / reload / play / URL actions."""
        from ._legacy import derive_asset_id

        track_id = derive_asset_id("hoverbike_track_id") or "<unknown>"

        box = layout.box()
        box.label(text=f"Track: {track_id}", icon="WORLD_DATA")
        if repo:
            box.label(text=f"Repo: {os.path.basename(repo)}", icon="FILE_FOLDER")
        else:
            box.label(text="Repo not found", icon="ERROR")
            box.label(text="Save .blend inside a hoverbike/ clone.")

        # First-time scaffolding — surface missing essentials prominently
        # so authoring a from-scratch .blend doesn't dead-end on the two
        # lint errors that block every export (no ai_spline_main / no
        # start_00). The box collapses itself once both pieces exist, so
        # mature tracks don't see this clutter. Cheap to check on every
        # redraw — just two dict lookups in bpy.data.objects.
        have_sp = bpy.data.objects.get("ai_spline_main") is not None
        have_s0 = bpy.data.objects.get("start_00") is not None
        have_s1 = bpy.data.objects.get("start_01") is not None
        if not (have_sp and have_s0 and have_s1):
            sbox = layout.box()
            sbox.alert = True
            sbox.label(text="Missing track essentials:", icon="ERROR")
            if not have_sp:
                sbox.label(text="  • no ai_spline_main (racing line)")
            if not have_s0 or not have_s1:
                missing_starts = [
                    n for n, ok in (("start_00", have_s0), ("start_01", have_s1))
                    if not ok
                ]
                sbox.label(text=f"  • no {' / '.join(missing_starts)} (spawn)")
            row = sbox.row()
            row.scale_y = 1.4
            row.operator(
                "hoverbike.scaffold_track_essentials",
                text="Scaffold Missing Essentials",
                icon="ADD",
            )
            srow = sbox.row(align=True)
            if not have_sp:
                srow.operator(
                    "hoverbike.add_ai_spline",
                    text="Add Spline",
                    icon="CURVE_NCURVE",
                )
            if not have_s0 or not have_s1:
                srow.operator(
                    "hoverbike.add_starts",
                    text="Add Starts",
                    icon="EMPTY_ARROWS",
                )

        # Terrain hint — separate from the alert box above because
        # terrain isn't *required* (a track could be all anti-grav
        # ribbon over open water), but the overwhelming majority of
        # tracks need one. Surface the procedural-island spawn one
        # click away when there's no kind=track mesh in the scene.
        from ._legacy import _largest_terrain_mesh as _lt_for_hint

        if _lt_for_hint() is None:
            tbox = layout.box()
            tbox.label(text="No terrain mesh in scene", icon="INFO")
            row = tbox.row()
            row.scale_y = 1.2
            row.operator(
                "hoverbike.add_island_terrain",
                text="Add Island Terrain (procedural)",
                icon="RNDCURVE",
            )
            tbox.label(
                text="Or: Hoverbike → Terrain → Import Heightmap…",
                icon="INFO",
            )

        # Live lap snapshot — arc-length of `ai_spline_main`, projected
        # lap time at the racer top speed, and gate count derived from
        # the same spacing the exporter will use. All three update on
        # every panel redraw (which Blender already triggers on spline
        # edits via the depsgraph callback in handlers.py), so authors
        # see the lap re-shape live as they drag bezier handles instead
        # of finding out at export time that the route is twice the
        # length they thought. Heavier stats (terrain extents, water
        # coverage) stay in the collapsible Track stats sub-panel.
        from .track_meta import _spline_arc_length, _spline_obstacle_clearance
        from ._legacy import _largest_terrain_mesh

        sp = bpy.data.objects.get("ai_spline_main")
        if sp is not None and sp.type == "CURVE":
            arc_m = _spline_arc_length(sp)
            if arc_m > 0:
                # Race pace is closer to 25 m/s through corners than the
                # racer's 28-32 top speed, so use 25 as the "feel" baseline.
                lap_s = arc_m / 25.0
                gate_spacing = float(
                    getattr(context.scene, "hoverbike_gate_spacing", 60.0) or 60.0
                )
                n_gates = max(1, round(arc_m / gate_spacing))
                stat_box = layout.box()
                stat_box.label(
                    text=f"Lap: {arc_m:,.0f} m  ~{lap_s:.0f}s @25m/s",
                    icon="DRIVER_DISTANCE",
                )
                stat_box.label(text=f"{n_gates} gates @ {gate_spacing:.0f} m spacing")
                # Live obstacle-clearance count — same bbox math the
                # lint runs, but surfaced passively so authors see
                # building / pylon clips appear and disappear as they
                # drag the spline. Bbox math only (no raycasts), so
                # it's cheap enough to run on every panel redraw.
                clip_hits = _spline_obstacle_clearance(sp, _largest_terrain_mesh())
                if clip_hits:
                    distinct = len({h[1] for h in clip_hits})
                    stat_box.label(
                        text=f"{len(clip_hits)} spline clip(s) into {distinct} obstacle(s)",
                        icon="ERROR",
                    )
                    stat_box.operator(
                        "hoverbike.shift_spline_off_obstacles",
                        text="Shift Off Obstacles",
                        icon="MOD_PUSH",
                    )
                # Comfort-band nudge — racing-feel sweet spot is roughly
                # 30-180 s. Outside that the lap is either too punchy to
                # read or long enough to drag.
                if lap_s < 30:
                    stat_box.label(text="Very short lap — under 30 s", icon="ERROR")
                elif lap_s > 180:
                    stat_box.label(text="Long lap — over 3 min", icon="ERROR")

        row = layout.row()
        row.scale_y = 1.6
        row.operator("hoverbike.export_track", icon="EXPORT")

        col = layout.column(align=True)
        col.prop(context.scene, "hoverbike_laps_to_finish", text="Laps")
        col.operator("hoverbike.lint_track", icon="CHECKMARK")
        col.operator("hoverbike.reload_track_json", icon="FILE_REFRESH")
        row = col.row(align=True)
        op_play_open = row.operator("hoverbike.open_play_url", text="Play", icon="PLAY")
        op_play_open.edit = False
        op_edit_open = row.operator("hoverbike.open_play_url", text="Edit", icon="GREASEPENCIL")
        op_edit_open.edit = True
        row = col.row(align=True)
        op_play = row.operator(
            "hoverbike.copy_track_url", text="Copy Play URL", icon="URL"
        )
        op_play.edit = False
        op_edit = row.operator(
            "hoverbike.copy_track_url", text="Copy Edit URL", icon="URL"
        )
        op_edit.edit = True

        # Active-object hint — clues the author in that the sub-panels
        # below are gated by selection. Reduces "where did the road
        # tools go?" confusion after the move from always-on panels.
        active = context.view_layer.objects.active
        hint_box = layout.box()
        hint_box.scale_y = 0.85
        if active is not None:
            kind = _active_kind_label(active)
            if kind:
                hint_box.label(
                    text=f"Active: {active.name} — {kind}", icon="OBJECT_DATAMODE"
                )
            else:
                hint_box.label(
                    text=f"Active: {active.name} (no panel)",
                    icon="OBJECT_DATAMODE",
                )
        else:
            hint_box.label(text="Select an object to see its tools.", icon="INFO")
        hint_box.label(text="Top-bar Hoverbike menu = all tools", icon="MENU_PANEL")
        hint_box.label(text="Shift+W = quick pie menu", icon="MESH_CIRCLE")

        # Small "start another map" affordance at the bottom — out of
        # the way of the active-track UI but discoverable for authors
        # who finish a map and want to jump to a fresh template without
        # the file-browser dance.
        layout.operator(
            "hoverbike.new_map_from_template",
            text="New Map from Template…",
            icon="FILE_NEW",
        )

    def _draw_bike(self, context, layout, blend: str, repo: str | None) -> None:
        from ._legacy import derive_asset_id

        bike_id = derive_asset_id("hoverbike_bike_id") or "<unknown>"

        box = layout.box()
        box.label(text=f"Bike: {bike_id}", icon="AUTO")
        if repo:
            box.label(text=f"Repo: {os.path.basename(repo)}", icon="FILE_FOLDER")
        else:
            box.label(text="Repo not found", icon="ERROR")
            box.label(text="Save .blend inside a hoverbike/ clone.")

        row = layout.row()
        row.scale_y = 1.6
        row.operator("hoverbike.export_bike", icon="EXPORT")

        col = layout.column(align=True)
        op_play = col.operator(
            "hoverbike.copy_bike_url", text="Copy Play URL", icon="URL"
        )
        op_play.viewer = False
        op_view = col.operator(
            "hoverbike.copy_bike_url", text="Copy Viewer URL", icon="HIDE_OFF"
        )
        op_view.viewer = True

        layout.separator()
        col = layout.column(align=True)
        col.scale_y = 0.85
        col.label(text="Shift-click Export:", icon="INFO")
        col.label(text="overwrite the spec")
        col.label(text="from the .blend.")

    def _draw_unknown(self, context, layout, blend: str, repo: str | None) -> None:
        box = layout.box()
        box.label(text="Unknown asset type", icon="QUESTION")
        box.label(text="Save your .blend in:")
        box.label(text="  • tracks-src/<id>.blend")
        box.label(text="  • bikes-src/<id>.blend")
        if repo:
            box.label(text=f"Repo: {os.path.basename(repo)}", icon="FILE_FOLDER")
        else:
            box.label(text="Repo not found", icon="ERROR")
            box.label(text="Save .blend inside a hoverbike/ clone.")
        # New Map shortcut — only useful when we can resolve a repo
        # root, since the operator targets tracks-src/<id>.blend. Surfaces
        # the existing template-*.blend collection without making authors
        # find them in the file browser by hand.
        if repo:
            layout.separator()
            box = layout.box()
            box.label(text="Start from a template:", icon="FILE_NEW")
            row = box.row()
            row.scale_y = 1.4
            row.operator(
                "hoverbike.new_map_from_template",
                text="New Map from Template…",
                icon="DUPLICATE",
            )


# ────────────────────────────────────────────────────────────────────
# Track sub-panels
# ────────────────────────────────────────────────────────────────────
#
# Each sub-panel is a child of HOVERBIKE_PT_panel and only renders in
# track mode. Splitting the original wall-of-tools into collapsible
# sections lets authors hide whatever they aren't using on a given pass
# (e.g. shader knobs are once-per-track so they stay default-closed).
# All sub-panels share the same `poll()` so adding a new one is just a
# matter of subclassing _HoverbikeTrackSubPanelBase + implementing draw.


# ────────────────────────────────────────────────────────────────────
# Selection helpers
# ────────────────────────────────────────────────────────────────────
#
# The selection-driven sub-panels each ask one of the helpers below
# whether the active object is "their" object. Centralising the
# matching keeps the per-panel poll() bodies one-line and stops the
# rules from drifting across files (e.g. "what counts as the road
# curve" lives in one place).


def _ancestor_with_kind(obj: bpy.types.Object | None, kind: str) -> bpy.types.Object | None:
    """Climb the parent chain looking for an object tagged with the
    given ``kind`` custom property. Used by sub-panels whose active
    object is usually a child of the conceptual "thing" (e.g. selecting
    a tower mesh inside ``downtown_03`` should activate the Downtown
    panel)."""
    cur = obj
    while cur is not None:
        if cur.get("kind") == kind:
            return cur
        cur = cur.parent
    return None


def _is_spline_active(obj: bpy.types.Object | None) -> bool:
    if obj is None:
        return False
    if obj.name == "ai_spline_main":
        return True
    if obj.name.startswith("start_") or obj.name.startswith("cp_"):
        # Start posers + hand-placed gate empties are "of the spline"
        # — surfacing the spline tools when you click one keeps the
        # snap-to-spline buttons one click away.
        return True
    return False


def _is_start_active(obj: bpy.types.Object | None) -> bool:
    """Start sub-panel surfaces when ``start_00`` / ``start_01`` (or
    anything tagged ``kind=start``) is the active object. Mirrors the
    web editor's "click the start helper → selection panel populates
    with bind/t/unbind" flow."""
    if obj is None:
        return False
    if obj.name in ("start_00", "start_01"):
        return True
    if obj.get("kind") == "start":
        return True
    return False


def _is_road_active(obj: bpy.types.Object | None) -> bool:
    """Road tool sub-panel surfaces when the user is poking at any
    part of the road/conform setup — the curve, the road mesh, the
    HV_RoadConform proxy (``terrain_conformed``), or the now-hidden
    source terrain that the proxy reads from. Otherwise authors who
    open the modifier panel on the proxy to tweak conform settings
    can't find Width / Curbs / Bank in the sidebar."""
    from .road import ROAD_CURVE_NAME
    from .road_conform_gn import PROXY_OBJECT_NAME

    if obj is None:
        return False
    if obj.name in (ROAD_CURVE_NAME, PROXY_OBJECT_NAME):
        return True
    if obj.name.startswith("road_"):
        return True
    if obj.get("kind") == "terrain_source":
        return True
    return False


def _is_tunnel_active(obj: bpy.types.Object | None) -> bool:
    from .tunnel import TUNNEL_CURVE_NAME, TUNNEL_PARENT_PREFIX

    if obj is None:
        return False
    if obj.name == TUNNEL_CURVE_NAME or obj.name.startswith(TUNNEL_PARENT_PREFIX):
        return True
    return False


def _is_antigrav_curve_active(obj: bpy.types.Object | None) -> bool:
    from .antigrav_ribbon import ANTIGRAV_CURVE_PREFIX, ANTIGRAV_SURFACE_SUFFIX

    if obj is None:
        return False
    if obj.name.startswith(ANTIGRAV_CURVE_PREFIX):
        return True
    if obj.name.endswith(ANTIGRAV_SURFACE_SUFFIX):
        return True
    return False


def _is_placement_helper_active(obj: bpy.types.Object | None) -> bool:
    from .placement_helper import PLACEMENT_HELPER_NAME

    if obj is None:
        return False
    return obj.name == PLACEMENT_HELPER_NAME


def _is_downtown_active(obj: bpy.types.Object | None) -> bool:
    return _ancestor_with_kind(obj, "downtown") is not None


def _is_terrain_active(obj: bpy.types.Object | None) -> bool:
    """True when the active object is the (largest) terrain mesh."""
    from ._legacy import _largest_terrain_mesh

    if obj is None or obj.type != "MESH":
        return False
    terrain = _largest_terrain_mesh()
    return terrain is not None and obj.name == terrain.name


def _is_water_active(obj: bpy.types.Object | None) -> bool:
    """Active selection is "water-ish" — either the legacy
    ``water_volume_main`` empty (still useful for wave-param custom
    props) or the preview surface mesh that visualises the sea level."""
    from .water import WATER_VOLUME_NAME

    if obj is None:
        return False
    return obj.name == WATER_VOLUME_NAME or obj.name == "water_preview"


def _is_horizon_active(obj: bpy.types.Object | None) -> bool:
    from .horizon import HORIZON_MESH_NAME

    if obj is None:
        return False
    return obj.name == HORIZON_MESH_NAME


def _is_wave_zone_active(obj: bpy.types.Object | None) -> bool:
    if obj is None:
        return False
    return bool(re.match(r"^wave_zone_(\d+)$", obj.name))


def _is_ramp_active(obj: bpy.types.Object | None) -> bool:
    """Ramps are an Empty parent named ``ramp`` (or its mesh child)."""
    if obj is None:
        return False
    if obj.name.startswith("ramp") or (obj.parent is not None and obj.parent.name.startswith("ramp")):
        return True
    return False


def _is_gameplay_active(obj: bpy.types.Object | None) -> bool:
    """Show the Gameplay panel when ai_spline_main (gates/turn/racer
    derive from it) or any per-item gameplay empty is selected."""
    if obj is None:
        return False
    if obj.name == "ai_spline_main":
        return True
    if re.match(r"^(boost|antigrav|cp)_\d+$", obj.name):
        return True
    if obj.name in ("racer_preview", "racer_origin"):
        return True
    if obj.name.startswith("turn_arrow_"):
        return True
    return False


_KIND_LABELS: tuple[tuple[str, callable], ...] = (
    ("AI spline", _is_spline_active),
    ("start gate", _is_start_active),
    ("road curve", _is_road_active),
    ("tunnel curve", _is_tunnel_active),
    ("anti-grav curve", _is_antigrav_curve_active),
    ("placement helper", _is_placement_helper_active),
    ("downtown", _is_downtown_active),
    ("terrain", _is_terrain_active),
    ("water volume", _is_water_active),
    ("horizon ring", _is_horizon_active),
    ("wave zone", _is_wave_zone_active),
    ("ramp", _is_ramp_active),
    ("gameplay item", _is_gameplay_active),
)


def _active_kind_label(obj: bpy.types.Object | None) -> str | None:
    """Returns the first matching kind name, for the header hint."""
    for label, pred in _KIND_LABELS:
        if pred(obj):
            return label
    return None


class _HoverbikeTrackSubPanelBase:
    """Mixin: panel constants + poll() shared by every track sub-panel.
    Sub-panels live under the parent `HOVERBIKE_PT_panel` and only render
    in track mode (.blend in `tracks-src/`)."""
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Hoverbike"
    bl_parent_id = "HOVERBIKE_PT_panel"

    @classmethod
    def poll(cls, context):
        from ._legacy import detect_mode

        return detect_mode(bpy.data.filepath) == "track"


class _SelectionDrivenPanel(_HoverbikeTrackSubPanelBase):
    """Mixin: gate panel visibility by the active object. Subclasses
    override the class attribute ``_active_pred`` to a function that
    takes the active object (may be None) and returns whether the panel
    should appear. Keeps the per-panel boilerplate to one line."""

    _active_pred: staticmethod = staticmethod(lambda obj: False)

    @classmethod
    def poll(cls, context):
        if not super().poll(context):
            return False
        active = context.view_layer.objects.active
        return bool(cls._active_pred(active))


class HOVERBIKE_PT_track_spline(_SelectionDrivenPanel, Panel):
    """Sub-panel: AI-spline editing helpers + start placement + the
    spline-aligned cursor / ramp-at-t / auto-ramp operators.

    Visible when ``ai_spline_main`` / a ``start_NN`` / a ``cp_NN`` is
    the active object."""
    bl_label = "Spline tools"
    bl_idname = "HOVERBIKE_PT_track_spline"
    _active_pred = staticmethod(_is_spline_active)

    def draw(self, context):
        layout = self.layout
        scene = context.scene

        # First-time scaffolding row — always visible in this sub-panel
        # so authors who go looking under "Spline tools" find the
        # create-from-nothing affordances next to the snap-to-spline
        # ones. Each operator no-ops when its target already exists,
        # so re-clicks on mature tracks are harmless.
        have_sp = bpy.data.objects.get("ai_spline_main") is not None
        have_s0 = bpy.data.objects.get("start_00") is not None
        have_s1 = bpy.data.objects.get("start_01") is not None
        scaffold_row = layout.row(align=True)
        if not have_sp:
            scaffold_row.operator(
                "hoverbike.add_ai_spline",
                text="Add ai_spline_main",
                icon="CURVE_NCURVE",
            )
        if not (have_s0 and have_s1):
            scaffold_row.operator(
                "hoverbike.add_starts",
                text="Add start_00 / 01",
                icon="EMPTY_ARROWS",
            )
        if have_sp and have_s0 and have_s1:
            scaffold_row.label(text="Essentials present", icon="CHECKMARK")
        layout.separator()

        layout.prop(scene, "hoverbike_snap_hover_height", text="Hover (m)")
        layout.operator("hoverbike.snap_spline_to_terrain", icon="SNAP_FACE")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_placement_t", text="t")
        row.operator("hoverbike.cursor_snap_to_spline", text="Cursor →", icon="PIVOT_CURSOR")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_start_grid_spacing", text="Start gap")
        row.operator("hoverbike.snap_starts_to_spline", text="Snap Starts", icon="EMPTY_ARROWS")
        layout.separator()
        layout.label(text="Auto-ramp from curvature:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_auto_ramp_kappa", text="|κ|")
        row.prop(scene, "hoverbike_auto_ramp_min_spacing", text="Spacing")
        layout.operator("hoverbike.add_ramp_at_spline_t", icon="ADD")
        layout.operator("hoverbike.auto_place_ramps", icon="MOD_PARTICLES")


class HOVERBIKE_PT_track_start(_SelectionDrivenPanel, Panel):
    """Sub-panel: bind / unbind / slide the player-start pair along
    ``ai_spline_main``. Ports the web editor's *Snap to spline* +
    t-slider + *Unbind* flow into Blender. Surfaces whenever a start
    empty is the active object so authors who click the start gate get
    the same experience the in-app editor offers.

    The 2x4 grid preview is rebuilt automatically by the existing
    racer-preview handler whenever ``start_00`` moves — no extra
    wiring needed here."""

    bl_label = "Start gate"
    bl_idname = "HOVERBIKE_PT_track_start"
    _active_pred = staticmethod(_is_start_active)

    def draw(self, context):
        layout = self.layout
        scene = context.scene

        have_sp = bpy.data.objects.get("ai_spline_main") is not None
        have_s0 = bpy.data.objects.get("start_00") is not None
        have_s1 = bpy.data.objects.get("start_01") is not None

        # Scaffolding row — surfaced here too so a user who selects a
        # half-set-up start finds the *Add* button without bouncing to
        # the Spline panel.
        if not (have_s0 and have_s1):
            layout.operator(
                "hoverbike.add_starts",
                text="Add start_00 / 01",
                icon="EMPTY_ARROWS",
            )

        bound = bool(getattr(scene, "hoverbike_start_bound_to_spline", False))

        layout.label(
            text=(
                "⚓ Bound to ai_spline_main" if bound
                else "Free placement (drag empties to pose)"
            ),
            icon=("LOCKED" if bound else "UNLOCKED"),
        )

        if bound:
            # Bound mode: the t slider is the primary control. Editing
            # it fires the live re-snap via _on_start_t_changed → the
            # handlers module's debounced timer. Spacing edits do the
            # same.
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_start_t", text="t", slider=True)
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_start_grid_spacing", text="Spacing")
            row.prop(scene, "hoverbike_snap_hover_height", text="Hover")
            row = layout.row(align=True)
            row.operator(
                "hoverbike.unbind_start_from_spline",
                text="Unbind from Spline",
                icon="UNLINKED",
            )
            layout.label(text="Edit ai_spline_main → start follows", icon="INFO")
        elif have_sp and have_s0:
            # Not bound, but everything needed for a bind is in place.
            row = layout.row(align=True)
            row.scale_y = 1.2
            row.operator(
                "hoverbike.bind_start_to_spline",
                text="Bind to Spline",
                icon="LINKED",
            )
            # One-shot snap is also surfaced — same operator the Spline
            # panel exposes, but here it uses hoverbike_placement_t (the
            # shared prop) to avoid surprising authors who have a t
            # they want to apply once without binding.
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_start_grid_spacing", text="Spacing")
            row.operator(
                "hoverbike.snap_starts_to_spline",
                text="Snap (once)",
                icon="EMPTY_ARROWS",
            )
        elif not have_sp:
            layout.label(
                text="Add ai_spline_main first to enable spline binding",
                icon="INFO",
            )
            layout.operator(
                "hoverbike.add_ai_spline",
                text="Add ai_spline_main",
                icon="CURVE_NCURVE",
            )

        # Racer preview: hint at the live 2x4 grid preview that
        # follows the start. The actual operator lives in previews.py.
        layout.separator()
        layout.label(text="2x4 grid preview:", icon="GROUP")
        row = layout.row(align=True)
        row.operator(
            "hoverbike.rebuild_racer_preview",
            text="Show / Refresh Grid",
            icon="FILE_REFRESH",
        )
        row.operator(
            "hoverbike.hide_racer_preview",
            text="Hide",
            icon="HIDE_ON",
        )


class HOVERBIKE_PT_track_road(_SelectionDrivenPanel, Panel):
    """Sub-panel: road-curve authoring + width / banking / curb knobs +
    Build Road. Visible when ``road_curve_main`` or a road mesh is the
    active object."""
    bl_label = "Road tool"
    bl_idname = "HOVERBIKE_PT_track_road"
    _active_pred = staticmethod(_is_road_active)

    def draw(self, context):
        from .road import ROAD_CURVE_NAME

        layout = self.layout
        scene = context.scene
        layout.operator("hoverbike.add_road_starter_curve", icon="CURVE_BEZCURVE")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_road_width", text="Width")
        row.prop(scene, "hoverbike_road_lift", text="Lift")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_road_blend_radius", text="Blend")
        row.prop(scene, "hoverbike_road_samples", text="Samples")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_road_smooth_passes", text="Smooth")
        row.prop(scene, "hoverbike_road_thickness", text="Slab (m)")
        layout.separator()
        layout.label(text="Banking:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_road_bank_strength", text="Bank")
        row.prop(scene, "hoverbike_road_bank_max_deg", text="Max°")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_road_bank_smooth_passes", text="Bank smoothing")
        layout.label(text="Auto-bank scales from curvature × Bank",
                     icon="INFO")
        layout.label(text="Per-point: select CP, N→Item→Curve→Tilt",
                     icon="INFO")
        layout.label(text="(per-point Tilt drives terrain conform too)",
                     icon="BLANK1")
        layout.separator()
        layout.label(text="F1 curbs:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_road_curb_width", text="Curb w")
        row.prop(scene, "hoverbike_road_curb_height", text="Curb h")
        layout.prop(scene, "hoverbike_road_curb_stripe_length", text="Stripe (m)")
        layout.separator()
        # Auto buoys — F1-curb-style marker buoys at the road edges
        # wherever the road sits above open water (terrain raycast
        # below sea level). Disabled cheaply via the master toggle so
        # inland tracks pay nothing.
        layout.label(text="Buoys (auto, over water):", icon="MOD_OCEAN")
        layout.prop(scene, "hoverbike_road_buoys_enabled", text="Enable")
        if scene.hoverbike_road_buoys_enabled:
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_road_buoy_spacing_mult", text="Spacing ×gw")
            row.prop(scene, "hoverbike_road_buoy_side_offset_mult", text="Offset ×gw")
        layout.separator()
        # Auto guardrails — Armco rail on the outside of contiguous
        # sharp-corner runs. Reads the smoothed kappa stamp the bank
        # calc already drives off, so threshold reads as "minimum
        # |kappa| (1/m) for a sample to be fenced".
        layout.label(text="Guardrails (auto, sharp corners):", icon="MOD_LATTICE")
        layout.prop(scene, "hoverbike_road_guardrails_enabled", text="Enable")
        if scene.hoverbike_road_guardrails_enabled:
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_road_guardrail_kappa", text="Kappa")
            row.prop(scene, "hoverbike_road_guardrail_height", text="Rail h")
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_road_guardrail_top_offset", text="Top off")
            row.prop(scene, "hoverbike_road_guardrail_side_offset", text="Side off")
        layout.separator()
        # Per-point conform — toggle whether a road segment grabs its Z from
        # the terrain (default) or floats at the bezier point's authored Z
        # (bridges, ramps over water). Stored in `weight_softbody` so it
        # survives copy/paste and is editable in Blender's N → Curve panel.
        layout.label(text="Per-point conform:")
        row = layout.row(align=True)
        row.operator("hoverbike.mark_selected_floating", text="Float", icon="ORIENTATION_VIEW")
        row.operator("hoverbike.mark_selected_conforming", text="Conform", icon="OUTLINER_OB_FORCE_FIELD")
        # Live readout of the active curve's float/conform mix
        active = context.active_object
        curve_for_readout = active if (active and active.type == "CURVE") else bpy.data.objects.get(ROAD_CURVE_NAME)
        if curve_for_readout is not None and curve_for_readout.data.splines:
            sp = curve_for_readout.data.splines[0]
            if sp.type == "BEZIER":
                pts = list(sp.bezier_points)
            else:
                pts = list(sp.points)
            n_total = len(pts)
            # weight_softbody stores float weight (1 = floating);
            # default 0 means conforming, so a point counts as floating
            # only when its weight is meaningfully above zero.
            n_float = sum(1 for p in pts if p.weight_softbody > 0.5)
            if n_total:
                layout.label(
                    text=f"{curve_for_readout.name}: {n_float}/{n_total} floating",
                    icon="INFO",
                )
        layout.separator()
        # Conform clearance + fill shelf — exposed here next to width /
        # blend so authors tuning the terrain interaction see all the
        # relevant knobs together. Fill shelf hides the road slab's
        # underside on downhill traverses (wider flat embankment).
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_road_conform_clearance", text="Clearance")
        row.prop(scene, "hoverbike_road_fill_shelf_width", text="Fill shelf")
        # Water-level gate is on the GN modifier itself (Properties →
        # Modifiers → HV_RoadConform). Default seeds from the scene's
        # `hoverbike_water_height` so bridges over ocean don't lift
        # the seafloor. Hint here so authors find it.
        layout.label(text="Water gate: HV_RoadConform → Water Level",
                     icon="MOD_FLUIDSIM")
        # Non-destructive iteration flow.
        # 1. Snap Curve — one-shot raycast that drops each curve CP
        #    onto the terrain surface (= seeds sane Z values).
        # 2. Build Road — builds the road strip mesh AND auto-attaches
        #    the live HV_RoadConform modifier on the terrain. Re-run
        #    as often as you like — never mutates terrain verts.
        # Attach Conform stays surfaced separately for cases where the
        # author wants to wire the modifier without rebuilding the road
        # mesh (rare — e.g. resuming live editing after a destructive
        # bake disabled the modifier).
        layout.separator()
        layout.label(text="Build (non-destructive):")
        row = layout.row(align=True)
        row.operator(
            "hoverbike.snap_curve_to_terrain",
            text="Snap Curve",
            icon="SNAP_ON",
        )
        row.operator(
            "hoverbike.attach_road_conform",
            text="Attach Conform",
            icon="GEOMETRY_NODES",
        )
        row = layout.row(align=True)
        row.scale_y = 1.2
        row.operator("hoverbike.build_road", icon="MESH_PLANE")
        # Destructive bake — for the rare export-time pass when the
        # destructive flow's extra features (multi-segment push-down,
        # auto-bank, fill shelf) need to land in the .blend mesh.
        layout.separator()
        layout.label(text="Bake to mesh (destructive — for export polish):")
        row = layout.row(align=True)
        row.operator(
            "hoverbike.bake_terrain_to_road",
            text="Bake Terrain to Road",
            icon="MOD_SHRINKWRAP",
        )
        row.operator(
            "hoverbike.reconform_terrain_to_road",
            text="Re-conform",
            icon="MOD_SHRINKWRAP",
        )
        if bpy.data.objects.get(ROAD_CURVE_NAME):
            layout.label(text="Edit road_curve_main, then Build", icon="INFO")


class HOVERBIKE_PT_track_tunnels(_SelectionDrivenPanel, Panel):
    """Sub-panel: tunnel through the terrain. Bezier curve along the
    intended path → Build → terrain gets a Boolean DIFFERENCE modifier
    against a cylindrical cutter + an inward-facing interior shell is
    spawned with ``kind="track"``.

    Visible when ``tunnel_curve_main`` or any ``tunnel_*`` object is
    the active object."""
    bl_label = "Tunnels"
    bl_idname = "HOVERBIKE_PT_track_tunnels"
    _active_pred = staticmethod(_is_tunnel_active)

    def draw(self, context):
        from ._legacy import _largest_terrain_mesh
        from .tunnel import (
            TUNNEL_CURVE_NAME,
            TUNNEL_PARENT_PREFIX,
            _is_in_tunnel_edit_mode,
        )

        layout = self.layout
        scene = context.scene

        # Top-of-panel edit-mode toggle: removing the terrain's tunnel
        # Booleans cuts curve-edit cost from ~2 s to ~1 ms by breaking
        # the depsgraph edge between cutter mesh and terrain.
        terrain = _largest_terrain_mesh()
        in_edit_mode = _is_in_tunnel_edit_mode(terrain)
        edit_row = layout.row(align=True)
        if in_edit_mode:
            edit_row.alert = True
            edit_row.operator(
                "hoverbike.toggle_tunnel_edit_mode",
                text="Re-attach Cuts (preview)",
                icon="MOD_BOOLEAN",
            )
            layout.label(text="Edit mode — curve edits are fast,", icon="INFO")
            layout.label(text="terrain boolean is off until you toggle.")
        else:
            edit_row.operator(
                "hoverbike.toggle_tunnel_edit_mode",
                text="Edit Curves (fast)",
                icon="OUTLINER_DATA_CURVE",
            )

        gn_cutter = bpy.data.objects.get("tunnels_cutter")
        if gn_cutter is not None and any(m.type == "NODES" for m in gn_cutter.modifiers):
            layout.separator()
            layout.label(text="GN rig detected — add curves to", icon="INFO")
            layout.label(text="'Tunnel Curves' (Shift-D a curve).")
            n_curves = 0
            curves_col = bpy.data.collections.get("Tunnel Curves")
            if curves_col is not None:
                n_curves = sum(1 for o in curves_col.objects if o.type == "CURVE")
            if n_curves > 0:
                layout.label(text=f"{n_curves} tunnel curve(s) in scene", icon="MOD_BOOLEAN")
            return

        layout.separator()
        layout.operator("hoverbike.add_tunnel_starter_curve", icon="CURVE_BEZCURVE")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_tunnel_radius", text="Radius")
        row.prop(scene, "hoverbike_tunnel_wall_thickness", text="Wall")
        layout.prop(scene, "hoverbike_tunnel_segments", text="Sides")
        layout.prop(scene, "hoverbike_tunnel_end_extend", text="End extend (m)")
        layout.operator("hoverbike.build_tunnel", icon="MESH_CYLINDER")
        if bpy.data.objects.get(TUNNEL_CURVE_NAME):
            layout.label(text="Edit the curve, then Build", icon="INFO")
        n_tunnels = sum(
            1 for o in bpy.data.objects
            if o.name.startswith(TUNNEL_PARENT_PREFIX) and o.name.endswith("_cutter")
        )
        if n_tunnels > 0:
            layout.label(text=f"{n_tunnels} tunnel(s) built", icon="MOD_BOOLEAN")


class HOVERBIKE_PT_track_placement(_SelectionDrivenPanel, Panel):
    """Sub-panel: persistent placement helper — a curve-constrained empty
    that the author parks at any (t, lateral offset) and uses as a
    placement anchor for ramps, boost pads, props, etc. Sliders re-pose
    live; one-click *Add Ramp at Helper* / *Add Boost at Helper* drop
    items at the helper's pose without needing to snap the cursor first.

    Visible when the ``placement_helper`` empty is the active object.
    Create one via the Hoverbike → Add menu (or Utility → Placement
    Helper)."""
    bl_label = "Placement helper"
    bl_idname = "HOVERBIKE_PT_track_placement"
    _active_pred = staticmethod(_is_placement_helper_active)

    def draw(self, context):
        from .placement_helper import PLACEMENT_HELPER_NAME

        layout = self.layout
        scene = context.scene
        helper = bpy.data.objects.get(PLACEMENT_HELPER_NAME)
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_helper_t", text="t")
        row.prop(scene, "hoverbike_helper_offset", text="Offset")
        row = layout.row(align=True)
        if helper is None:
            row.operator("hoverbike.add_placement_helper", icon="EMPTY_ARROWS")
        else:
            row.operator("hoverbike.add_placement_helper", text="Re-pose Helper", icon="FILE_REFRESH")
            row.operator("hoverbike.remove_placement_helper", text="", icon="X")
            layout.label(text=f"@ {helper.location.x:+.1f}, {helper.location.y:+.1f}, {helper.location.z:+.1f}",
                         icon="OBJECT_DATAMODE")
            layout.separator()
            layout.label(text="One-click drop:")
            layout.operator("hoverbike.cursor_to_helper", icon="PIVOT_CURSOR")
            row = layout.row(align=True)
            row.operator("hoverbike.add_ramp_at_helper", icon="ADD")
            row.operator("hoverbike.add_boost_pad_at_helper", icon="FORCE_FORCE")


class HOVERBIKE_PT_track_downtown(_SelectionDrivenPanel, Panel):
    """Sub-panel: placeholder downtown city-block generator. Drops a
    parented grid of mid-rise tower meshes (kind="track") at the 3D
    cursor.

    Visible when any descendant of a ``downtown_NN`` is the active
    object. Use Hoverbike → Add → Downtown Block to drop a fresh one."""
    bl_label = "Downtown"
    bl_idname = "HOVERBIKE_PT_track_downtown"
    _active_pred = staticmethod(_is_downtown_active)

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_downtown_blocks_x", text="X")
        row.prop(scene, "hoverbike_downtown_blocks_y", text="Y")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_downtown_block_size", text="Block")
        row.prop(scene, "hoverbike_downtown_street_width", text="Street")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_downtown_height_min", text="Min h")
        row.prop(scene, "hoverbike_downtown_height_max", text="Max h")
        layout.prop(scene, "hoverbike_downtown_seed", text="Seed")
        layout.prop(scene, "hoverbike_downtown_conform", text="Conform to terrain")
        layout.operator("hoverbike.add_downtown", icon="MESH_CUBE")
        layout.label(text="Spawns at the 3D cursor.", icon="INFO")

        # Edit-in-place row: when a downtown_NN (or any child) is
        # selected, the user can pull its current params into these
        # sliders, tweak, and rebuild without losing the placement.
        active = context.view_layer.objects.active
        active_dt: bpy.types.Object | None = None
        cur = active
        while cur is not None:
            if cur.get("kind") == "downtown":
                active_dt = cur
                break
            cur = cur.parent
        if active_dt is not None:
            layout.separator()
            layout.label(text=f"Edit: {active_dt.name}", icon="MOD_BUILD")
            row = layout.row(align=True)
            row.operator("hoverbike.pick_downtown_settings", text="Pick Settings", icon="EYEDROPPER")
            row.operator("hoverbike.rebuild_downtown", text="Rebuild", icon="FILE_REFRESH")


class HOVERBIKE_PT_track_antigrav_ribbon(_SelectionDrivenPanel, Panel):
    """Sub-panel: curve-driven anti-grav surface authoring. Pick a
    profile (tube / ribbon / banked-strip), drop a Bezier curve through
    the intended path, hit *Build Anti-Grav Surface* — the operator
    sweeps the cross-section, drops the entry / exit zone empties at
    the curve endpoints, and tags the surface ``kind=track``.

    Visible when an ``antigrav_curve_NN`` or the resulting surface mesh
    is the active object. Use Hoverbike → Add → Anti-Grav Curve to
    spawn the first one."""
    bl_label = "Anti-grav surfaces"
    bl_idname = "HOVERBIKE_PT_track_antigrav_ribbon"
    _active_pred = staticmethod(_is_antigrav_curve_active)

    def draw(self, context):
        from .antigrav_ribbon import (
            ANTIGRAV_CURVE_PREFIX,
            ANTIGRAV_SURFACE_SUFFIX,
            PROFILE_TUBE,
        )

        layout = self.layout
        scene = context.scene

        layout.label(text="Cross-section profile:", icon="MOD_ARRAY")
        layout.prop(scene, "hoverbike_antigrav_profile", text="")
        profile = str(scene.hoverbike_antigrav_profile)

        if profile == PROFILE_TUBE:
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_antigrav_radius", text="Radius")
            row.prop(scene, "hoverbike_antigrav_segments", text="Sides")
        else:
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_antigrav_width", text="Width")
            row.prop(scene, "hoverbike_antigrav_thickness", text="Thick")
        layout.prop(scene, "hoverbike_antigrav_samples", text="Samples")
        layout.separator()

        # Curve-count summary so authors see at-a-glance how many
        # anti-grav segments the track has and which one is active.
        n_curves = sum(
            1 for obj in bpy.data.objects
            if obj.type == "CURVE" and obj.name.startswith(ANTIGRAV_CURVE_PREFIX)
        )
        n_surfaces = sum(
            1 for obj in bpy.data.objects
            if obj.type == "MESH" and obj.name.endswith(ANTIGRAV_SURFACE_SUFFIX)
        )
        if n_curves > 0:
            layout.label(text=f"{n_curves} curve(s), {n_surfaces} built", icon="CURVE_BEZCURVE")

        row = layout.row(align=True)
        row.operator("hoverbike.add_antigrav_curve", icon="CURVE_BEZCURVE")
        row.operator("hoverbike.build_antigrav_surface", icon="MOD_PARTICLES")

        active = context.active_object
        if active is not None and active.type == "CURVE" and active.name.startswith(ANTIGRAV_CURVE_PREFIX):
            layout.label(text=f"Active: {active.name}", icon="OBJECT_DATAMODE")
            layout.label(text="Edit the curve, then Build", icon="INFO")
            if profile == "BANKED_STRIP":
                layout.label(
                    text="Set per-point Tilt in N→Item to bank/wall/ceiling",
                    icon="DRIVER_ROTATIONAL_DIFFERENCE",
                )
        else:
            layout.label(text="Select an antigrav_curve_NN to build", icon="INFO")


class HOVERBIKE_PT_track_ramps(_SelectionDrivenPanel, Panel):
    """Sub-panel: simple wedge ramp. Three sliders set the next ramp's
    dimensions; clicking *Add Ramp* drops it at the 3D cursor.

    Each ramp is a parent empty (G/R/S to position/aim) plus a child
    mesh driven by the HV_Ramp Geometry-Nodes modifier. To resize a
    placed ramp, open its mesh's Modifiers tab and edit Length /
    Width / Height directly — the mesh re-evaluates live.

    Visible when a ramp empty or its mesh child is the active object.
    Hoverbike → Add → Ramp is the spawn entry."""
    bl_label = "Ramps"
    bl_idname = "HOVERBIKE_PT_track_ramps"
    _active_pred = staticmethod(_is_ramp_active)

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_ramp_length", text="Length")
        row.prop(scene, "hoverbike_ramp_width", text="Width")
        layout.prop(scene, "hoverbike_ramp_height", text="Height")
        layout.operator("hoverbike.add_ramp", icon="ADD")
        layout.label(text="Edit Length/Width/Height on the", icon="INFO")
        layout.label(text="mesh's HV_Ramp modifier to resize.")


class HOVERBIKE_PT_track_terrain(_SelectionDrivenPanel, Panel):
    """Sub-panel: heightmap import, sculpt entry-points, AO/path-wear
    bakers. Anything that touches the terrain mesh's geometry.

    Visible when the (largest) terrain mesh is the active object.
    Hoverbike → Terrain → Import Heightmap creates the first one."""
    bl_label = "Terrain"
    bl_idname = "HOVERBIKE_PT_track_terrain"
    _active_pred = staticmethod(_is_terrain_active)

    def draw(self, context):
        layout = self.layout
        scene = context.scene

        layout.label(text="Heightmap import:", icon="IMAGE_DATA")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_heightmap_size", text="Size")
        row.prop(scene, "hoverbike_heightmap_subdivisions", text="Subdiv")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_heightmap_height", text="Δz (m)")
        row.prop(scene, "hoverbike_heightmap_base", text="Base z")
        layout.operator("hoverbike.import_heightmap", icon="IMPORT")
        layout.separator()

        layout.label(text="Sculpt:", icon="SCULPTMODE_HLT")
        layout.operator("hoverbike.apply_terrain_modifiers", icon="MODIFIER_DATA")
        layout.operator("hoverbike.subdivide_terrain", icon="MOD_SUBSURF")
        layout.operator("hoverbike.enter_sculpt_mode", icon="BRUSH_DATA")
        layout.separator()

        # Procedural-island mod zones — only relevant when the active
        # terrain still carries a live HV_Island modifier. After Apply
        # (above) the modifier's gone and mod zones can't reach the
        # mesh, so hide the section to avoid offering a dead button.
        from .island_terrain import find_island_modifier
        if find_island_modifier(context.active_object) is not None:
            layout.label(text="Mod zones (non-destructive bumps):", icon="MOD_DISPLACE")
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_mod_zone_amplitude", text="Δz (m)")
            row.prop(scene, "hoverbike_mod_zone_radius", text="Radius (m)")
            op = layout.operator(
                "hoverbike.add_island_mod_zone",
                text="Add Mod Zone @ Cursor",
                icon="ADD",
            )
            op.amplitude = scene.hoverbike_mod_zone_amplitude
            op.radius = scene.hoverbike_mod_zone_radius
            layout.separator()

        layout.label(text="Bulk shape @ cursor:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_sculpt_radius", text="Radius (m)")
        row.prop(scene, "hoverbike_sculpt_magnitude", text="Δz (m)")
        row = layout.row(align=True)
        op_up = row.operator("hoverbike.raise_lower_terrain", text="Raise", icon="TRIA_UP")
        op_up.lower = False
        op_dn = row.operator("hoverbike.raise_lower_terrain", text="Lower", icon="TRIA_DOWN")
        op_dn.lower = True
        layout.separator()

        layout.label(text="Smooth:", icon="MOD_SMOOTH")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_sculpt_smooth_iters", text="Iters")
        row.prop(scene, "hoverbike_sculpt_smooth_weight", text="Weight")
        layout.operator("hoverbike.smooth_terrain", icon="MOD_SMOOTH")
        layout.separator()

        layout.label(text="Vertex bakes:", icon="MATERIAL")
        layout.label(text="Fills baked_ao + baked_path", icon="NODE_TEXTURE")
        layout.operator("hoverbike.bake_terrain_attrs", icon="MOD_NOISE")
        # Path-worn standalone — separate knobs + faster bake (no
        # Cycles round-trip) so authors can iterate on falloff width /
        # intensity without paying the AO cost on every click. The
        # auto-bake-on-export hook reads the same three scene props,
        # so the values dialled in here ship with the GLB even if the
        # author never clicks the button.
        layout.separator()
        layout.label(text="Path-worn falloff:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_path_wear_inner", text="Inner")
        row.prop(scene, "hoverbike_path_wear_outer", text="Outer")
        layout.prop(scene, "hoverbike_path_wear_intensity", text="Intensity")
        layout.operator("hoverbike.bake_path_worn", icon="MOD_CURVE")


class HOVERBIKE_PT_track_water(_SelectionDrivenPanel, Panel):
    """Sub-panel: sea-level slider, wave-shape sliders
    (``hoverbike_water_wave_height`` / ``wave_freq``, both ship to
    JSON), and Gerstner-wave preview plane controls. All values are
    scene-wide; the preview mesh redisplaces live as the sliders move
    via the debounced rebuild.

    Visible when the legacy ``water_volume_main`` empty *or* the
    ``water_preview`` mesh is the active object. (Volume is no longer
    required — the scene-prop sliders are the canonical UI.)"""
    bl_label = "Water"
    bl_idname = "HOVERBIKE_PT_track_water"
    _active_pred = staticmethod(_is_water_active)

    def draw(self, context):
        from .water import WATER_VOLUME_NAME

        layout = self.layout
        scene = context.scene

        # Sea level is always editable now — the slider writes the
        # scene prop directly, regardless of whether a volume exists.
        layout.prop(scene, "hoverbike_water_height", text="Sea level (m)")

        # Wave shape — both sliders ship to JSON (water.waveHeight /
        # waveFreq) AND drive the preview's amp/freq multipliers in
        # real time via the debounced rebuild.
        layout.separator()
        layout.label(text="Wave shape (ships to JSON):", icon="MOD_OCEAN")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_water_wave_height", text="Height")
        row.prop(scene, "hoverbike_water_wave_freq", text="Freq")
        layout.separator()

        layout.label(text="Wave preview:", icon="HIDE_OFF")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_water_size", text="Size (m)")
        row.operator("hoverbike.fit_water_preview_to_scene", text="Fit", icon="FULLSCREEN_ENTER")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_water_subdivisions", text="Subdiv")
        row.prop(scene, "hoverbike_water_time", text="Time (s)")
        row = layout.row(align=True)
        row.operator("hoverbike.rebuild_water_preview", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_water_preview", icon="HIDE_ON")

        # Legacy volume affordance — the empty stops being load-bearing
        # for either sea level or wave_height / wave_freq in 2026-05;
        # the scene-prop sliders above are the canonical UI. Kept so
        # older .blends that still have the empty can be inspected.
        vol = bpy.data.objects.get(WATER_VOLUME_NAME)
        layout.separator()
        if vol is None:
            row = layout.row()
            row.scale_y = 0.85
            row.label(
                text="Legacy: water_volume_main is no longer required",
                icon="INFO",
            )
            layout.operator(
                "hoverbike.add_water_volume",
                text="Add Water Volume (legacy / for older tooling)",
                icon="ADD",
            )
        else:
            row = layout.row()
            row.scale_y = 0.85
            row.label(
                text=f"Legacy volume present (wave_height/freq mirror sliders on next reload)",
                icon="INFO",
            )


class HOVERBIKE_PT_track_horizon(_SelectionDrivenPanel, Panel):
    """Sub-panel: per-track distant-horizon silhouette. Drops a
    procedural starter ring authors can hand-edit into recognisable
    skylines (Skytree, Table Mountain, the Manhattan grid). When the
    GLB ships a ``horizon_ring`` mesh, the runtime uses it directly;
    otherwise the procedural fallback (seeded off the track id) runs.

    Visible when ``horizon_ring`` is the active object. Use Hoverbike
    → Add → Horizon Ring to spawn the starter shape."""

    bl_label = "Horizon"
    bl_idname = "HOVERBIKE_PT_track_horizon"
    _active_pred = staticmethod(_is_horizon_active)

    def draw(self, context):
        from .horizon import HORIZON_MESH_NAME

        layout = self.layout
        scene = context.scene
        ring = bpy.data.objects.get(HORIZON_MESH_NAME)

        if ring is None:
            layout.label(text="No horizon_ring (runtime uses procedural)", icon="WORLD")
            layout.label(text="Starter shape:", icon="MESH_CIRCLE")
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_horizon_radius", text="Radius")
            row.prop(scene, "hoverbike_horizon_peak", text="Peak")
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_horizon_segments", text="Segments")
            row.prop(scene, "hoverbike_horizon_seed", text="Seed")
            layout.operator("hoverbike.add_horizon_ring", icon="ADD")
        else:
            v = len(ring.data.vertices)
            f = len(ring.data.polygons)
            layout.label(text=f"horizon_ring: {v} verts, {f} faces", icon="WORLD")
            row = layout.row(align=True)
            row.operator("hoverbike.edit_horizon_ring", icon="EDITMODE_HLT")
            row.operator("hoverbike.delete_horizon_ring", icon="X")
            layout.separator()
            layout.label(text="Re-roll starter (loses edits):", icon="FILE_REFRESH")
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_horizon_seed", text="Seed")
            row.prop(scene, "hoverbike_horizon_peak", text="Peak")
            layout.operator("hoverbike.reset_horizon_ring", icon="LOOP_BACK")


class HOVERBIKE_PT_track_sky(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: per-track sky / atmosphere preset. Authors tint /
    cloudiness / sun intensity / fog distances / time-of-day, plus the
    sky-grade LUT preset, the renderer bloom intensity (currently
    round-trips only — no bloom pass is wired yet), and the Beaufort
    sea-state that scales the wave field at boot.

    Lives between Horizon and Waves because all three shape the
    far-field atmosphere. Default-closed since these are usually set
    once per track and the author is unlikely to be tweaking them
    while editing geometry.
    """

    bl_label = "Sky preset"
    bl_idname = "HOVERBIKE_PT_track_sky"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        scene = context.scene

        # Palette + sun
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_sky_tint", text="Tint")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_sky_cloudiness", text="Cloudiness")
        row.prop(scene, "hoverbike_sky_sun_intensity", text="Sun")
        # Time of day picks where on the 360 s cycle the (frozen) sun
        # sits — the most-tweaked knob since it owns the whole mood.
        layout.prop(scene, "hoverbike_sky_time_of_day", text="Time of day (s)")

        layout.separator()
        layout.label(text="Fog distances:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_sky_fog_near", text="Near")
        row.prop(scene, "hoverbike_sky_fog_far", text="Far")
        # Visible-only nudge — fog ordering is enforced at JSON validate
        # time. Surfacing it here avoids the round-trip surprise.
        if (
            getattr(scene, "hoverbike_sky_fog_near", 0.0)
            >= getattr(scene, "hoverbike_sky_fog_far", 0.0)
        ):
            layout.label(text="Near must be < Far", icon="ERROR")

        layout.separator()
        layout.label(text="Color grade (LUT preset):")
        layout.prop(scene, "hoverbike_sky_color_grade", text="")
        # Bloom + sea state — round-trip-only / wave-field one-shot.
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_sky_bloom", text="Bloom")
        row.prop(scene, "hoverbike_sky_sea_state", text="Sea (Bft)")
        bloom_val = float(getattr(scene, "hoverbike_sky_bloom", 0.0) or 0.0)
        if bloom_val > 0:
            layout.label(text="Bloom: no pass yet, value still ships", icon="INFO")


class HOVERBIKE_PT_track_waves(_SelectionDrivenPanel, Panel):
    """Sub-panel: wave-mastery zones. Each ``wave_zone_NN`` empty in the
    scene multiplies the global Gerstner wave amplitude / frequency
    inside its oriented bounding box, with optional periodic surge for
    tsunami timers and an optional dominant-swell direction override.
    The runtime evaluates zones via ``sampleZoneFactors`` in
    ``wave-field.ts``.

    Visible when a ``wave_zone_NN`` empty is the active object."""
    bl_label = "Wave zones"
    bl_idname = "HOVERBIKE_PT_track_waves"
    _active_pred = staticmethod(_is_wave_zone_active)

    def draw(self, context):
        layout = self.layout
        layout.operator("hoverbike.add_wave_zone", icon="ADD")
        n_zones = sum(
            1 for obj in bpy.data.objects if re.match(r"^wave_zone_(\d+)$", obj.name)
        )
        if n_zones > 0:
            layout.label(text=f"{n_zones} zone(s) — drag, R to aim swell")
            layout.operator("hoverbike.refresh_wave_zones", icon="FILE_REFRESH")
            layout.label(text="Custom Properties tunes each zone:", icon="INFO")
            layout.label(text="  height_mult, freq_mult, blend_radius_m")
            layout.label(text="  + optional surge_period_s/_amplitude")
            layout.label(text="  + optional direction_deg")
        else:
            layout.label(text="No zones — global Gerstner only", icon="INFO")
        layout.label(text="Local +X = dominant swell direction", icon="ORIENTATION_LOCAL")


class HOVERBIKE_PT_track_gameplay(_SelectionDrivenPanel, Panel):
    """Sub-panel: gates + boost pads + racers + turn indicators. The
    high-level "what does the player interact with" placement section.

    Visible when any gameplay-related object is the active object —
    ``ai_spline_main`` (gates / racer / turn indicators all derive from
    the spline), a ``boost_NN``, ``antigrav_NN``, ``cp_NN``, racer
    preview, or a ``turn_arrow_NN``. Use Hoverbike → Add for spawn
    actions when nothing relevant is selected."""
    bl_label = "Gameplay"
    bl_idname = "HOVERBIKE_PT_track_gameplay"
    _active_pred = staticmethod(_is_gameplay_active)

    def draw(self, context):
        from .previews import GATE_PREVIEW_COLLECTION

        layout = self.layout
        scene = context.scene

        layout.label(text="Gates:", icon="MOD_ARRAY")
        layout.prop(scene, "hoverbike_gate_spacing", text="Spacing (m)")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_gate_half_width", text="Half-width")
        row.prop(scene, "hoverbike_gate_height", text="Height")
        row = layout.row(align=True)
        row.operator("hoverbike.rebuild_gate_preview", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_gate_preview", icon="HIDE_ON")
        # Gate authoring model: the spline is the source of truth. The
        # export step re-samples `ai_spline_main` at this spacing on every
        # Export Track to Game, so nothing in the .blend "freezes" gate
        # positions — they always reflect the latest spline shape. The
        # preview is the canonical visualisation. Authors who need a
        # hand-placed gate (e.g. just past a jump where arc length puts
        # it in the wrong spot) drop a `cp_NN` empty and that takes over
        # for the whole array.
        n_cp = sum(1 for obj in bpy.data.objects if re.match(r"^cp_\d+$", obj.name))
        if n_cp > 0:
            layout.label(
                text=f"Override: {n_cp} cp_NN empties win over the spline",
                icon="ANCHOR_TOP",
            )
            layout.operator(
                "hoverbike.demote_gates_to_spline",
                text="Demote to Spline (wipe cp_NN)",
                icon="X",
            )
        elif bpy.data.collections.get(GATE_PREVIEW_COLLECTION):
            layout.label(text="Spline-driven, live preview", icon="LINKED")
        else:
            layout.label(text="Spline-driven; click Rebuild to preview", icon="INFO")
        # Pin-to-empty button — works whether you're spline-driven or
        # already overriding; in spline-driven mode it forks into
        # editable empties so you can tweak one corner, in override
        # mode it re-stamps from the current spline.
        layout.operator(
            "hoverbike.materialize_gates_to_cp_empties",
            text=("Re-stamp from Spline" if n_cp > 0 else "Materialise to cp_NN (for hand-edit)"),
            icon="OUTLINER_OB_EMPTY",
        )
        layout.separator()

        # Buoys — F1-curb-style markers along the racing-line edges
        # wherever the spline crosses open water. Lives in the gameplay
        # panel because it's spline-driven (works on water-only tracks
        # like Sandbar with no road_main); the road panel also exposes
        # the same toggles for road-having tracks where authors tune
        # them alongside the road width.
        layout.label(text="Buoys (auto, over water):", icon="MOD_OCEAN")
        layout.prop(scene, "hoverbike_road_buoys_enabled", text="Enable")
        if scene.hoverbike_road_buoys_enabled:
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_road_buoy_spacing_mult", text="Spacing ×gw")
            row.prop(scene, "hoverbike_road_buoy_side_offset_mult", text="Offset ×gw")
            row = layout.row(align=True)
            row.prop(scene, "hoverbike_road_width", text="Track width")
            row.prop(scene, "hoverbike_road_curb_width", text="Curb w")
        layout.operator("hoverbike.rebuild_buoys", icon="FILE_REFRESH")
        if bpy.data.objects.get("road_buoys") is not None:
            layout.label(text="Live; auto-rebuild follows spline edits", icon="LINKED")
        layout.separator()

        layout.label(text="Boost pads:", icon="FORCE_FORCE")
        layout.operator("hoverbike.add_boost_pad", icon="ADD")
        n_pads = sum(
            1 for obj in bpy.data.objects if re.match(r"^boost_(\d+)$", obj.name)
        )
        if n_pads > 0:
            layout.label(text=f"{n_pads} pad(s) — drag, R to aim")
            layout.operator("hoverbike.refresh_boost_pads", icon="FILE_REFRESH")
            layout.label(text="Custom Properties tunes each pad", icon="INFO")
        layout.separator()

        # Anti-grav: spline banking (per-anchor tilt) drives the main
        # route; antigrav_NN empties cover off-route stretches. Both
        # round-trip through derive_track_json.
        layout.label(text="Anti-grav:", icon="ORIENTATION_GIMBAL")
        sp = bpy.data.objects.get("ai_spline_main")
        if sp is not None:
            flag = bool(sp.get("anti_grav", False))
            row = layout.row(align=True)
            row.label(
                text=f"ai_spline_main: {'ON' if flag else 'off'}",
                icon="CHECKBOX_HLT" if flag else "CHECKBOX_DEHLT",
            )
            row.operator("hoverbike.toggle_spline_antigrav", text="Toggle")
        if context.mode == "EDIT_CURVE":
            layout.label(text="Selected anchor tilt:", icon="DRIVER_ROTATIONAL_DIFFERENCE")
            row = layout.row(align=True)
            row.operator("hoverbike.set_spline_tilt_flat", text="Flat")
            row.operator("hoverbike.set_spline_tilt_bank_l", text="L 45°")
            row.operator("hoverbike.set_spline_tilt_bank_r", text="R 45°")
            row = layout.row(align=True)
            row.operator("hoverbike.set_spline_tilt_wall_l", text="Wall L")
            row.operator("hoverbike.set_spline_tilt_wall_r", text="Wall R")
            row.operator("hoverbike.set_spline_tilt_ceiling", text="Ceiling")
            layout.label(text="Or set Tilt in N-panel → Item", icon="INFO")
        else:
            layout.label(
                text="Tab into Edit Mode on the spline to set tilt",
                icon="INFO",
            )
        layout.operator("hoverbike.add_antigrav_zone", icon="ADD", text="+ Anti-Grav Zone")
        n_zones = sum(
            1 for obj in bpy.data.objects if re.match(r"^antigrav_(\d+)$", obj.name)
        )
        if n_zones > 0:
            layout.label(text=f"{n_zones} zone(s) — drag, R to align +Y to road normal")
            layout.operator("hoverbike.refresh_antigrav_zones", icon="FILE_REFRESH")
        layout.separator()

        layout.label(text="Racer preview:", icon="AUTO")
        row = layout.row(align=True)
        row.operator("hoverbike.rebuild_racer_preview", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_racer_preview", icon="HIDE_ON")
        layout.separator()

        layout.label(text="Turn indicators:", icon="TRACKING_FORWARDS")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_turn_kappa", text="|κ| min (1/m)")
        row.prop(scene, "hoverbike_turn_min_spacing", text="Spacing (m)")
        row = layout.row(align=True)
        row.operator("hoverbike.rebuild_turn_indicators", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_turn_indicators", icon="HIDE_ON")


class HOVERBIKE_PT_track_ghost(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: ghost-lap preview cinematic. Default-closed since it's
    a once-per-session 'play the lap to feel it' tool, not part of the
    core authoring loop."""
    bl_label = "Ghost lap + chase cam"
    bl_idname = "HOVERBIKE_PT_track_ghost"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_ghost_speed", text="Speed (m/s)")
        row.prop(scene, "hoverbike_ghost_fps", text="FPS")
        row = layout.row(align=True)
        row.operator("hoverbike.rebuild_ghost_lap", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_ghost_lap", icon="HIDE_ON")
        layout.label(text="Press Spacebar to fly the lap", icon="PLAY")


class HOVERBIKE_PT_track_shader(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: runtime terrain-shader knobs that round-trip through
    `terrainShader` in the JSON. Default-closed since these are usually
    set once per track."""
    bl_label = "Terrain shader (runtime)"
    bl_idname = "HOVERBIKE_PT_track_shader"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_alt_min", text="Alt min")
        row.prop(scene, "hoverbike_shader_alt_max", text="Alt max")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_slope_start", text="Slope start")
        row.prop(scene, "hoverbike_shader_slope_end", text="Slope end")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_variation", text="Variation")
        row.prop(scene, "hoverbike_shader_wet_band", text="Wet band")
        layout.label(text="Path tint:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_path_tint_r", text="R")
        row.prop(scene, "hoverbike_shader_path_tint_g", text="G")
        row.prop(scene, "hoverbike_shader_path_tint_b", text="B")
        layout.separator()
        layout.label(text="Detail / variation:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_macro_scale", text="Macro (m)")
        row.prop(scene, "hoverbike_shader_micro_scale", text="Micro (m)")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_warp_strength", text="Warp")
        row.prop(scene, "hoverbike_shader_alt_jitter", text="Alt jitter")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_scree_band", text="Scree")
        row.prop(scene, "hoverbike_shader_triplanar", text="Triplanar")
        layout.prop(scene, "hoverbike_shader_saturation", text="Saturation")


class HOVERBIKE_PT_track_thumbnail(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: track-hero / loading-screen render. Lives next to
    Stats because both are pre-export sanity checks rather than core
    authoring loops. Shows whether a ``camera_hero`` is present, an
    Add Camera button when it isn't, a Render Hero button when it is,
    and a last-rendered timestamp once a render has fired in the
    current session. Default-closed since the render auto-fires on
    track export — most authors only open this section when iterating
    on framing."""

    bl_label = "Track hero render"
    bl_idname = "HOVERBIKE_PT_track_thumbnail"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        from .thumbnail import (
            CAMERA_HERO_NAME,
            HERO_HEIGHT,
            HERO_WIDTH,
            TILE_HEIGHT,
            TILE_WIDTH,
            find_camera_hero,
        )

        layout = self.layout
        cam = find_camera_hero()

        if cam is None:
            layout.label(text="No camera_hero in scene", icon="OUTLINER_OB_CAMERA")
            layout.label(text="Loading-screen render is skipped on export.")
            layout.operator(
                "hoverbike.add_camera_hero",
                text="Add Camera Hero",
                icon="ADD",
            )
            return

        layout.label(
            text=f"{cam.name} ({cam.data.lens:.0f} mm)",
            icon="OUTLINER_OB_CAMERA",
        )
        layout.label(
            text=f"Hero {HERO_WIDTH}×{HERO_HEIGHT} + Tile {TILE_WIDTH}×{TILE_HEIGHT}",
            icon="IMAGE",
        )
        if cam.name != CAMERA_HERO_NAME:
            layout.label(
                text=f"(renamed from {CAMERA_HERO_NAME})",
                icon="INFO",
            )
        row = layout.row(align=True)
        row.scale_y = 1.3
        row.operator(
            "hoverbike.render_track_hero",
            text="Render Hero",
            icon="RENDER_STILL",
        )
        row.operator(
            "hoverbike.render_track_thumbnail",
            text="Tile only",
            icon="IMAGE",
        )

        last = context.scene.get("_hoverbike_track_hero_rendered_at")
        if isinstance(last, (int, float)) and last > 0:
            import time

            age_s = max(0.0, time.time() - float(last))
            if age_s < 60:
                age_label = f"{age_s:.0f}s ago"
            elif age_s < 3600:
                age_label = f"{age_s / 60:.0f}m ago"
            else:
                age_label = f"{age_s / 3600:.1f}h ago"
            layout.label(text=f"Last render: {age_label}", icon="TIME")
        else:
            layout.label(
                text="Auto-fires on track export",
                icon="INFO",
            )


class HOVERBIKE_PT_track_stats(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: read-only counts + spline-length / lap-time estimate +
    terrain min/max + water coverage. Helpful for sanity-checking before
    export. Default-closed."""
    bl_label = "Track stats"
    bl_idname = "HOVERBIKE_PT_track_stats"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        from .track_meta import _spline_arc_length

        layout = self.layout
        sp = bpy.data.objects.get("ai_spline_main")
        arc_len = _spline_arc_length(sp) if sp else 0.0
        lap_25 = arc_len / 25.0 if arc_len > 0 else 0.0
        layout.label(text=f"Spline length: {arc_len:,.1f} m")
        layout.label(text=f"Lap estimate @25 m/s: {lap_25:.1f} s")
        counts = {"starts": 0, "checkpoints": 0, "pickups": 0, "boosts": 0}
        for obj in context.scene.objects:
            n = obj.name
            if n.startswith("start_"): counts["starts"] += 1
            elif n.startswith("cp_"): counts["checkpoints"] += 1
            elif n.startswith("pickup"): counts["pickups"] += 1
            elif n.startswith("boost") and "_gizmo" not in n: counts["boosts"] += 1
        row = layout.row(align=True)
        row.label(text=f"Starts: {counts['starts']}")
        row.label(text=f"Gates: {counts['checkpoints']}")
        row = layout.row(align=True)
        row.label(text=f"Pickups: {counts['pickups']}")
        row.label(text=f"Boosts: {counts['boosts']}")
        scn = context.scene
        zmin = scn.get("_hoverbike_stats_terrain_min_y")
        zmax = scn.get("_hoverbike_stats_terrain_max_y")
        frac = scn.get("_hoverbike_stats_terrain_water_frac")
        if zmin is not None and zmax is not None and frac is not None:
            layout.label(text=f"Terrain y: [{float(zmin):,.1f}, {float(zmax):,.1f}] m")
            layout.label(text=f"Water coverage: {float(frac) * 100:.0f}%")
        else:
            layout.label(text="Terrain y / water: refresh below", icon="QUESTION")
        layout.operator("hoverbike.refresh_track_stats", icon="FILE_REFRESH")
        layout.separator()
        # Manual re-tag — depsgraph auto-tags on rename, but bulk
        # operations (Outliner find-and-replace, pasted-in objects)
        # can land without a depsgraph fire; this button forces a sweep.
        layout.operator("hoverbike.retag_scene", icon="OUTLINER_DATA_FONT")


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_PT_panel,
    # ── Selection-driven sub-panels ───────────────────────────────
    # Only visible when their target object is the active selection.
    # When nothing relevant is selected, none of these appear — the
    # always-on cluster below carries the rest of the sidebar.
    HOVERBIKE_PT_track_spline,
    HOVERBIKE_PT_track_start,
    HOVERBIKE_PT_track_road,
    HOVERBIKE_PT_track_tunnels,
    HOVERBIKE_PT_track_antigrav_ribbon,
    HOVERBIKE_PT_track_ramps,
    HOVERBIKE_PT_track_downtown,
    HOVERBIKE_PT_track_terrain,
    HOVERBIKE_PT_track_water,
    HOVERBIKE_PT_track_horizon,
    HOVERBIKE_PT_track_waves,
    HOVERBIKE_PT_track_gameplay,
    HOVERBIKE_PT_track_placement,
    # ── Always-on scene-wide cluster ───────────────────────────────
    # These don't have a single "thing" to select for, so they sit
    # below the selection-driven block. All open default-closed.
    HOVERBIKE_PT_track_emitters,
    HOVERBIKE_PT_track_sky,
    HOVERBIKE_PT_track_ghost,
    HOVERBIKE_PT_track_shader,
    HOVERBIKE_PT_track_thumbnail,
    HOVERBIKE_PT_track_stats,
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
