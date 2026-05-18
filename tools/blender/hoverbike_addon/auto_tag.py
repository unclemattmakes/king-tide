"""Auto-tag custom data when an object's name matches a canonical pattern.

The export pipeline keys everything off the ``kind`` extras (plus a few
companion props like ``index`` / ``branch`` / ``start_t``). Authors who
rename a plain Empty to ``start_00`` or a Curve to ``ai_spline_main``
hit two failure modes if they forget to add those extras by hand:

  1. The lint passes because ``bpy.data.objects.get("start_00")`` finds
     them — but the GLB export later drops them because ``kind != "start"``.
  2. The runtime spawns a malformed scene with starts that aren't
     starts, gates that aren't gates, etc.

This module watches for object name changes via a persistent
``depsgraph_update_post`` handler and applies the matching ``kind`` +
default props as soon as the rename happens. It also runs a one-shot
sweep on ``load_post`` so a .blend authored before auto-tag was added
gets its objects tagged on first open, and exposes a manual
``hoverbike.retag_scene`` operator so authors can force a re-run after
bulk renames.

Idempotency: a rule only fires when ``obj.get("kind")`` is not already
set, so existing authored data is never overwritten. If the user
clears ``kind`` and the name still matches, we re-tag — which is the
desired round-trip behaviour.

Infinite-loop safety: setting a custom property re-fires the depsgraph
handler, but the "kind already set" guard ensures the second pass is a
fast no-op.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

import bpy
from bpy.app.handlers import persistent
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Rule table
# ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _AutoTagRule:
    """One name → extras mapping.

    Attributes:
        name_re: Regex matched against ``obj.name``. Capture groups
            are passed to ``extras`` so e.g. ``start_03`` can populate
            ``index=3``.
        object_type: Required Blender object type ("EMPTY" / "CURVE" /
            "MESH"); ``None`` allows any type. Type-gating stops us
            from auto-tagging a Mesh named ``start_00`` — that's
            almost certainly an authoring accident, not a real start.
        kind: Value to write into ``obj["kind"]``.
        extras: Callable returning the extra props (``{"index": 3}``
            etc.) to set alongside ``kind``. Takes the regex match
            object so digits in the name can become numeric props.
        visual: Optional callable that gets passed the object and can
            tweak its viewport display (empty_display_type / size).
            Skipped if the rule's object type isn't EMPTY.
    """

    name_re: re.Pattern[str]
    object_type: str | None
    kind: str
    extras: Callable[[re.Match[str]], dict[str, object]]
    visual: Callable[[bpy.types.Object], None] | None = None


def _empty_visual(display: str, size: float) -> Callable[[bpy.types.Object], None]:
    """Build a visual setter that adjusts empty_display_type / size.
    Closures over the constants so each rule reads as data, not code.
    Setter is a no-op for non-EMPTY objects so it's safe even if the
    rule's type-gate is loosened."""

    def _apply(obj: bpy.types.Object) -> None:
        if obj.type != "EMPTY":
            return
        obj.empty_display_type = display
        obj.empty_display_size = size

    return _apply


# Patterns + canonical extras. Mirror the seed_template_*.py /
# add-* operator conventions so an auto-tagged object is
# indistinguishable from one created by the addon's "Add" button.
#
# Note on defaults: when there's already an addon Add operator that
# stamps these props, use the same numeric values so a renamed empty
# behaves identically to one the operator created.
_RULES: tuple[_AutoTagRule, ...] = (
    _AutoTagRule(
        name_re=re.compile(r"^ai_spline_main$"),
        object_type="CURVE",
        kind="ai_spline",
        extras=lambda m: {"branch": "main"},
    ),
    _AutoTagRule(
        name_re=re.compile(r"^start_(\d+)$"),
        object_type="EMPTY",
        kind="start",
        extras=lambda m: {"index": int(m.group(1)), "start_t": 0.0},
        visual=_empty_visual("ARROWS", 6.0),
    ),
    _AutoTagRule(
        name_re=re.compile(r"^cp_(\d+)$"),
        object_type="EMPTY",
        kind="checkpoint",
        extras=lambda m: {
            "index": int(m.group(1)),
            "half_width": 14.0,
            "height": 8.0,
        },
        visual=_empty_visual("SINGLE_ARROW", 4.0),
    ),
    _AutoTagRule(
        name_re=re.compile(r"^boost_(\d+)$"),
        object_type="EMPTY",
        kind="boost_pad",
        extras=lambda m: {
            "half_width": 3.0,
            "half_depth": 6.0,
            "strength": 1.5,
        },
        visual=_empty_visual("ARROWS", 4.0),
    ),
    _AutoTagRule(
        name_re=re.compile(r"^antigrav_(\d+)$"),
        object_type="EMPTY",
        kind="antigrav_zone",
        extras=lambda m: {
            "half_width": 8.0,
            "half_height": 5.0,
            "half_depth": 12.0,
        },
        visual=_empty_visual("ARROWS", 4.0),
    ),
    # Anti-grav ribbon authoring curve. The Build Anti-Grav Surface
    # operator sweeps the curve into a kind=track mesh and stamps the
    # zone empties at the endpoints — this rule just makes sure a
    # rename / paste of an antigrav_curve_NN bezier gets the right
    # AuthoringKind so the export pipeline strips it.
    _AutoTagRule(
        name_re=re.compile(r"^antigrav_curve_(\d+)$"),
        object_type="CURVE",
        kind="antigrav_curve",
        extras=lambda m: {},
    ),
    _AutoTagRule(
        name_re=re.compile(r"^wave_zone_(\d+)$"),
        object_type="EMPTY",
        kind="wave_zone",
        extras=lambda m: {
            "half_width": 30.0,
            "half_height": 20.0,
            "half_depth": 30.0,
            "height_mult": 1.5,
            "freq_mult": 1.0,
            "blend_radius_m": 20.0,
        },
        visual=_empty_visual("CUBE", 6.0),
    ),
    _AutoTagRule(
        name_re=re.compile(r"^pickup_(?:\d+|main)$"),
        object_type="EMPTY",
        kind="pickup_spawn",
        extras=lambda m: {},
        visual=_empty_visual("SPHERE", 2.0),
    ),
    _AutoTagRule(
        name_re=re.compile(r"^water_volume_main$"),
        object_type="EMPTY",
        kind="water",
        extras=lambda m: {"wave_height": 1.0, "wave_freq": 0.5},
        visual=_empty_visual("CUBE", 1.0),
    ),
    # The terrain mesh is the only kind=track rule — we don't auto-tag
    # arbitrary meshes since kind=track has runtime + shader semantics
    # that propagate to anything carrying it. Authors who want a
    # custom-named terrain still set kind=track by hand (or use the
    # Add Terrain operator).
    _AutoTagRule(
        name_re=re.compile(r"^terrain$"),
        object_type="MESH",
        kind="track",
        extras=lambda m: {},
    ),
    # Per-track horizon silhouette mesh — exists when the author drops a
    # starter ring via *Add Horizon Ring* and (typically) reshapes it.
    # Auto-tag picks up renames or copy-paste from another .blend so the
    # mesh round-trips through the GLB loader's `kind=horizon` extraction.
    _AutoTagRule(
        name_re=re.compile(r"^horizon_ring$"),
        object_type="MESH",
        kind="horizon",
        extras=lambda m: {},
    ),
    # Hero camera used by the headless track-thumbnail render. The
    # camera_hero Camera object is read by the addon's *Render Track
    # Hero* operator + the standalone CLI script and never reaches the
    # GLB (the export pass strips cameras). Tagging it lets the
    # thumbnail tooling pick it out by kind instead of name in case the
    # author later renames or duplicates it.
    _AutoTagRule(
        name_re=re.compile(r"^camera_hero$"),
        object_type="CAMERA",
        kind="camera_hero",
        extras=lambda m: {},
    ),
    # Particle-emitter empty. Defaults match
    # ``hoverbike_addon/emitter.py`` exactly — the rule re-stamps them
    # so a renamed / pasted empty behaves identically to one created
    # via *Add Emitter*. Visual hint matches the operator (SPHERE,
    # size 1.2) so the empties are easy to pick out.
    _AutoTagRule(
        name_re=re.compile(r"^emitter_(\d+)$"),
        object_type="EMPTY",
        kind="emitter",
        extras=lambda m: {
            "atlas_cell": 0,
            "emit_rate": 30.0,
            "lifetime_s": 1.5,
            "velocity_cone_deg": 25.0,
            "speed_min": 0.8,
            "speed_max": 2.5,
            "size_start": 0.4,
            "size_end": 1.2,
            "color_start": [1.0, 1.0, 1.0, 1.0],
            "color_end": [1.0, 1.0, 1.0, 0.0],
            "gravity": 0.0,
            "max_particles": 256,
        },
        visual=_empty_visual("SPHERE", 1.2),
    ),
)


# ────────────────────────────────────────────────────────────────────
# Tagging
# ────────────────────────────────────────────────────────────────────


def _maybe_auto_tag(obj: bpy.types.Object) -> bool:
    """Apply the first matching rule to `obj` if its ``kind`` isn't
    already set. Returns True if a tag was applied. Used by the
    depsgraph handler, the load_post sweep, and the manual re-tag
    operator. Cheap enough to call on every depsgraph update — at
    most one regex match per rule plus a single dict lookup."""
    if obj is None:
        return False
    existing = obj.get("kind")
    if existing not in (None, ""):
        return False
    for rule in _RULES:
        m = rule.name_re.match(obj.name)
        if m is None:
            continue
        if rule.object_type is not None and obj.type != rule.object_type:
            continue
        obj["kind"] = rule.kind
        for key, value in rule.extras(m).items():
            obj[key] = value
        if rule.visual is not None:
            try:
                rule.visual(obj)
            except (AttributeError, RuntimeError):
                pass
        return True
    return False


# ────────────────────────────────────────────────────────────────────
# Handlers
# ────────────────────────────────────────────────────────────────────


@persistent
def _hoverbike_auto_tag_depsgraph_post(_scene, depsgraph):
    """Run the auto-tagger over every object touched by the current
    depsgraph evaluation. Renames land here, as do new-object events
    and property edits — the "kind already set" guard inside
    ``_maybe_auto_tag`` keeps us idempotent across the noise."""
    try:
        updates = depsgraph.updates
    except AttributeError:
        return
    for upd in updates:
        try:
            orig = getattr(upd.id, "original", upd.id)
        except (AttributeError, ReferenceError):
            continue
        if not isinstance(orig, bpy.types.Object):
            continue
        try:
            _maybe_auto_tag(orig)
        except (AttributeError, RuntimeError):
            # An object can be freed mid-iteration if the user is
            # deleting; swallow + carry on rather than aborting the
            # whole sweep.
            continue


@persistent
def _hoverbike_auto_tag_load_post(*_args):
    """One-shot sweep on file load. Tags pre-existing objects whose
    names match canonical patterns but didn't yet carry a ``kind``
    — useful both for .blends authored before auto-tag was added and
    for scenes imported from elsewhere."""
    for obj in bpy.data.objects:
        try:
            _maybe_auto_tag(obj)
        except (AttributeError, RuntimeError):
            continue


# ────────────────────────────────────────────────────────────────────
# Manual re-tag operator
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_retag_scene(Operator):
    """Force a re-run of the auto-tagger over every object in the
    scene. Skips anything that already carries a ``kind`` so existing
    authored data is never overwritten. Useful after a bulk rename
    (e.g. find-and-replace in the Outliner) or after pasting in
    objects from another file."""

    bl_idname = "hoverbike.retag_scene"
    bl_label = "Re-tag Scene by Name"
    bl_description = (
        "Apply canonical kind + default props to every object whose name matches "
        "a known pattern (start_NN, cp_NN, ai_spline_main, water_volume_main, "
        "boost_NN, antigrav_NN, wave_zone_NN, pickup_NN, terrain) and doesn't "
        "already carry a kind"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        tagged: list[str] = []
        for obj in bpy.data.objects:
            try:
                if _maybe_auto_tag(obj):
                    tagged.append(obj.name)
            except (AttributeError, RuntimeError):
                continue
        if not tagged:
            self.report(
                {"INFO"},
                "Nothing to tag — every name-matched object already has a kind set.",
            )
            return {"FINISHED"}
        preview = ", ".join(tagged[:6])
        more = f" (+{len(tagged) - 6} more)" if len(tagged) > 6 else ""
        self.report({"INFO"}, f"Tagged {len(tagged)} object(s): {preview}{more}.")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (HOVERBIKE_OT_retag_scene,)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    if _hoverbike_auto_tag_depsgraph_post not in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.append(_hoverbike_auto_tag_depsgraph_post)
    if _hoverbike_auto_tag_load_post not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(_hoverbike_auto_tag_load_post)


def unregister() -> None:
    # Detach handlers first so a partially-unregistered state can't
    # fire a callback into a half-torn-down module.
    try:
        bpy.app.handlers.depsgraph_update_post.remove(_hoverbike_auto_tag_depsgraph_post)
    except ValueError:
        pass
    try:
        bpy.app.handlers.load_post.remove(_hoverbike_auto_tag_load_post)
    except ValueError:
        pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
