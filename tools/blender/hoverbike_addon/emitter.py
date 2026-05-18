"""Particle-emitter authoring.

Single empty + extras block per emitter, registered at runtime by the
unified particle system (``src/engine/render/particle-system.ts``).
The runtime reads:

  * ``atlas_cell``        — 0..15, picks a 256x256 tile from the
                            shared particle atlas
                            (``public/assets/fx/particle-atlas.png``).
  * ``emit_rate``         — particles per second
  * ``lifetime_s``        — seconds before a particle is recycled
  * ``velocity_cone_deg`` — half-angle of the emission cone around
                            the empty's local +Y axis
  * ``speed_min``/``speed_max`` — uniform-random initial speed (m/s)
  * ``size_start``/``size_end`` — world-space sprite size, lerped over age
  * ``color_start``/``color_end`` — RGBA, lerped over age
  * ``gravity``           — Y-axis acceleration (m/s²). 0 = drift,
                            negative = fall, positive = rise
  * ``max_particles``     — buffer cap contributed to the per-cell pool

The empty's transform is the spawn pose. ``+Y`` (Blender Z-up) becomes
the runtime emission direction (Y-up after the glTF exporter swap).

Authoring loop:

  1. Place 3D cursor where you want the effect.
  2. Click **Add Emitter** in the Hoverbike panel's *Emitters*
     sub-section.
  3. With the new ``emitter_NN`` selected, tweak its custom properties
     in the N-panel → Object → Custom Properties. The atlas cell
     legend lives in the Add operator's tooltip + the build-script
     docstring.
  4. Re-export the track — the GLB carries the empty's pose +
     extras; the runtime particle system handles the rest.

Per-module ``register()`` / ``unregister()`` so the package init just
imports this module. Mirrors ``horizon.py`` exactly.
"""

from __future__ import annotations

import re

import bpy
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

EMITTER_NAME_PREFIX = "emitter_"
EMITTER_NAME_RE = re.compile(r"^emitter_(\d+)$")
EMITTER_KIND = "emitter"

# Defaults — must mirror DEFAULT_EMITTER_CONFIG in
# ``src/engine/render/particle-system.ts``. The unit test
# ``tests/unit/particle-system.test.ts`` covers the runtime side; the
# Blender-only constants here are duplicated by hand because the addon
# can't import TypeScript at registration time.
DEFAULT_ATLAS_CELL = 0
DEFAULT_EMIT_RATE = 30.0
DEFAULT_LIFETIME_S = 1.5
DEFAULT_CONE_DEG = 25.0
DEFAULT_SPEED_MIN = 0.8
DEFAULT_SPEED_MAX = 2.5
DEFAULT_SIZE_START = 0.4
DEFAULT_SIZE_END = 1.2
DEFAULT_COLOR_START = (1.0, 1.0, 1.0, 1.0)
DEFAULT_COLOR_END = (1.0, 1.0, 1.0, 0.0)
DEFAULT_GRAVITY = 0.0
DEFAULT_MAX_PARTICLES = 256


# Atlas cell index → human-readable name. Lives here so the addon
# tooltip and the in-panel reminder stay in sync with the build script.
ATLAS_CELL_NAMES: tuple[str, ...] = (
    "0 soft round spark",
    "1 smoke puff",
    "2 ember",
    "3 foam droplet",
    "4 dust mote",
    "5 gull silhouette",
    "6 leaf",
    "7 neon glare",
    "8 ash",
    "9 water spray",
    "10 glow halo",
    "11 motion streak",
    "12 spare",
    "13 spare",
    "14 spare",
    "15 spare",
)


# ────────────────────────────────────────────────────────────────────
# Authoring helpers
# ────────────────────────────────────────────────────────────────────


def _next_emitter_index() -> int:
    """Smallest non-negative integer NN such that no ``emitter_NN``
    object exists in the current scene. Walking object names instead
    of bpy.data.objects.keys() so renamed-but-zeroed slots are seen."""
    used: set[int] = set()
    for obj in bpy.data.objects:
        m = EMITTER_NAME_RE.match(obj.name)
        if m is not None:
            used.add(int(m.group(1)))
    n = 0
    while n in used:
        n += 1
    return n


def _stamp_default_extras(obj: bpy.types.Object) -> None:
    """Write the canonical extras block onto ``obj``. Idempotent — only
    writes a key if it's not already set, so re-running on a hand-tweaked
    emitter doesn't trample author edits. ``kind`` is always
    overwritten (cheap, and keeps auto-tag in sync)."""
    obj["kind"] = EMITTER_KIND

    def _set_default(key: str, value):
        if key not in obj:
            obj[key] = value

    _set_default("atlas_cell", DEFAULT_ATLAS_CELL)
    _set_default("emit_rate", DEFAULT_EMIT_RATE)
    _set_default("lifetime_s", DEFAULT_LIFETIME_S)
    _set_default("velocity_cone_deg", DEFAULT_CONE_DEG)
    _set_default("speed_min", DEFAULT_SPEED_MIN)
    _set_default("speed_max", DEFAULT_SPEED_MAX)
    _set_default("size_start", DEFAULT_SIZE_START)
    _set_default("size_end", DEFAULT_SIZE_END)
    _set_default("color_start", list(DEFAULT_COLOR_START))
    _set_default("color_end", list(DEFAULT_COLOR_END))
    _set_default("gravity", DEFAULT_GRAVITY)
    _set_default("max_particles", DEFAULT_MAX_PARTICLES)


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_add_emitter(Operator):
    """Drop a particle emitter empty at the 3D cursor.

    The new empty is named ``emitter_NN`` (next free NN), tagged
    ``kind=emitter``, and stamped with the default extras block. With
    it selected, tweak ``atlas_cell``, ``emit_rate``, etc. in the
    N-panel → Object → Custom Properties — see the addon docstring or
    the build-script docstring for the cell-index legend.

    The empty's local +Y axis is the emission direction. Rotate the
    empty (G/R) to aim. ``velocity_cone_deg`` sets the cone half-angle
    around +Y; speed is uniform-random in [``speed_min``, ``speed_max``].
    """

    bl_idname = "hoverbike.add_emitter"
    bl_label = "Add Emitter"
    bl_description = (
        "Drop a particle emitter empty at the 3D cursor. Tweak atlas_cell + "
        "emit_rate + lifetime_s in custom properties; +Y is the emission axis. "
        "Atlas cells: 0=soft spark, 1=smoke, 2=ember, 3=foam, 4=dust mote, "
        "5=gull, 6=leaf, 7=neon glare, 8=ash, 9=water spray, 10=glow halo, "
        "11=motion streak."
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        n = _next_emitter_index()
        name = f"{EMITTER_NAME_PREFIX}{n:02d}"
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 1.2
        obj.location = context.scene.cursor.location.copy()
        _stamp_default_extras(obj)
        context.scene.collection.objects.link(obj)

        # Select the new emitter so the next thing the author touches is
        # the empty they just dropped (matches the boost-pad / antigrav
        # pattern).
        for o in bpy.data.objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj

        self.report(
            {"INFO"},
            f"Added {name} — local +Y is emission axis; tweak custom props",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Panel
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_PT_track_emitters(bpy.types.Panel):
    """Sub-panel: particle-emitter authoring. Count of emitters in the
    scene + Add button + cell-index quick reference. Lives next to the
    Horizon sub-panel since both shape the atmosphere.

    Defined here (not in panel.py) since the cell-legend list and the
    add operator both belong to this module — keeping them together
    means the panel reflects whatever the operator + constants do."""

    bl_label = "Emitters"
    bl_idname = "HOVERBIKE_PT_track_emitters"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Hoverbike"
    bl_parent_id = "HOVERBIKE_PT_panel"
    bl_options = {"DEFAULT_CLOSED"}

    @classmethod
    def poll(cls, context):
        from ._legacy import detect_mode

        return detect_mode(bpy.data.filepath) == "track"

    def draw(self, context):
        layout = self.layout
        # Count emitters live so authors see the running total update
        # as they Add / Delete.
        n_emitters = sum(
            1 for obj in bpy.data.objects if EMITTER_NAME_RE.match(obj.name) is not None
        )
        if n_emitters > 0:
            layout.label(text=f"{n_emitters} emitter(s) in scene", icon="PARTICLES")
        else:
            layout.label(text="No emitters yet — drop one with +", icon="PARTICLES")
        layout.operator("hoverbike.add_emitter", icon="ADD")
        layout.separator()
        layout.label(text="Atlas cells (set atlas_cell):", icon="TEXTURE")
        # Two-column legend so the panel doesn't get a vertical stripe
        # of 12 single-line labels.
        col_a = layout.column(align=True)
        col_a.scale_y = 0.8
        for label in ATLAS_CELL_NAMES[:8]:
            col_a.label(text=label)
        col_b = layout.column(align=True)
        col_b.scale_y = 0.8
        for label in ATLAS_CELL_NAMES[8:]:
            col_b.label(text=label)
        layout.separator()
        layout.label(text="Tweak in N → Object → Custom Props", icon="INFO")
        layout.label(text="See: build_sprite_atlas.py docstring", icon="INFO")


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


# Note: HOVERBIKE_PT_track_emitters is registered by panel.py (alongside
# the other HOVERBIKE_PT_track_* sub-panels) so the parent panel
# HOVERBIKE_PT_panel is in bpy.types before any child tries to attach.
# Registering it here would race with panel.py's registration order,
# since `panel` is the last module in `_MODULES`.
_CLASSES: tuple[type, ...] = (HOVERBIKE_OT_add_emitter,)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
