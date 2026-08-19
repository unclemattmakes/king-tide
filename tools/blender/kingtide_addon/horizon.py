"""Per-track horizon authoring.

The runtime ships a procedural horizon ring (192-segment layered-sine
cylinder, see ``src/engine/render/horizon-ring.ts``) that camera-locks
to the player so the far field has a tangible silhouette. By default
every track gets a unique procedural ring seeded off its track id —
no authoring needed.

When a track wants a *recognisable* skyline silhouette (Skytree poking
above Shibuya's rooftops, Table Mountain behind Cape Town, the
Manhattan grid behind Liberty), the author drops a starter horizon
mesh via ``Add Horizon Ring`` and reshapes it in edit mode. The
runtime extracts it on GLB load and uses it directly — same shader,
author-controlled silhouette.

Two things live here:

  * ``horizon_ring`` — the optional author-edited mesh, tagged
    ``kind="horizon"``. Exported into the track GLB; the runtime's
    GLB loader plucks it out before terrain shading / collider attach.
    Skipped by the trimesh-collider attach step (declared in
    ``src/engine/render/glb-track.ts``).

  * Add Horizon Ring operator + sub-panel. Mirrors the procedural
    runtime starter so authors begin from a familiar 192-segment ring
    and push verts around with proportional editing.

Per-module ``register()`` / ``unregister()`` so the package init just
imports this module. The sub-panel is in ``panel.py`` next to the other
``KINGTIDE_PT_track_*`` sub-panels.
"""

from __future__ import annotations

import math

import bmesh
import bpy
from bpy.props import FloatProperty, IntProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

HORIZON_MESH_NAME = "horizon_ring"
HORIZON_KIND = "horizon"

# Mirrors ``RING_SEGMENTS`` + defaults in ``horizon-ring.ts``. Authors can
# resample at a different density (the runtime doesn't care), but keeping
# the starter shape identical to the procedural fallback means
# proportional-edit nudges read at runtime exactly as they do in viewport.
DEFAULT_SEGMENTS = 192
DEFAULT_RADIUS_M = 1400.0
DEFAULT_PEAK_M = 300.0
DEFAULT_BASE_M = -40.0  # well below the water plane — fog hides the seam
DEFAULT_SEED = 1337


# ────────────────────────────────────────────────────────────────────
# Procedural starter shape
# ────────────────────────────────────────────────────────────────────


def _height_at(theta: float, seed: int) -> float:
    """Mirror of ``heightAt`` in ``horizon-ring.ts``. Five octaves of
    sine with geometric amp/freq decay, plus an occasional sharp spike,
    seeded so different starter rings get different silhouettes. Returns
    a value in [0, 1.2]."""
    h = 0.0
    amp = 1.0
    freq = 1.7
    total = 0.0
    for i in range(5):
        h += amp * (0.5 + 0.5 * math.sin(theta * freq + seed * (i + 1) * 1.731 + i * 0.91))
        total += amp
        amp *= 0.55
        freq *= 2.05
    v = h / total
    spike = math.sin(theta * 11.3 + seed * 0.71) - 0.6
    if spike > 0:
        v += (spike / 0.4) * (spike / 0.4) * 0.35
    return max(0.0, min(1.2, v))


def _build_horizon_starter_mesh(
    name: str,
    *,
    segments: int,
    radius: float,
    peak: float,
    base: float,
    seed: int,
) -> bpy.types.Mesh:
    """Author-side twin of ``buildProceduralHorizonGeometry``. Same vert
    layout (top edge + bottom edge per angle), same shape — so the
    Blender viewport starting point matches what an un-authored track
    will look like in-game.

    Verts are emitted in Blender's Z-up frame (XY plane horizontal, Z
    vertical), and the glTF exporter flips to Y-up on export — so
    `peak` lands on the Y axis in the GLB the runtime loads."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)

    cols = segments + 1
    verts: list[tuple[float, float, float]] = []
    for i in range(cols):
        theta = (i / segments) * math.tau
        cos_t = math.cos(theta)
        sin_t = math.sin(theta)
        top_z = _height_at(theta, seed) * peak
        # (x, y, z) — Blender Z-up. Author-axis radius in XY,
        # silhouette height in Z. glTF export rotates to Y-up.
        verts.append((cos_t * radius, sin_t * radius, top_z))
        verts.append((cos_t * radius, sin_t * radius, base))

    faces: list[tuple[int, int, int, int]] = []
    for i in range(segments):
        a = i * 2
        b = i * 2 + 1
        c = (i + 1) * 2
        d = (i + 1) * 2 + 1
        # Outward-facing winding (the ring is read from inside). Runtime
        # uses DoubleSide on its material so the winding only matters for
        # the optional Blender viewport shading.
        faces.append((a, c, d, b))

    me.from_pydata(verts, [], faces)
    me.update()
    for poly in me.polygons:
        poly.use_smooth = True
    return me


def _ensure_horizon_object(scene: bpy.types.Scene, **kwargs) -> bpy.types.Object:
    """Return the canonical horizon mesh, creating it from the seeded
    layered-sine starter if missing. Re-running on an existing object
    leaves the (possibly hand-edited) mesh alone and only refreshes
    the ``kind`` extras."""
    obj = bpy.data.objects.get(HORIZON_MESH_NAME)
    if obj is not None:
        obj["kind"] = HORIZON_KIND
        return obj
    me = _build_horizon_starter_mesh(HORIZON_MESH_NAME, **kwargs)
    obj = bpy.data.objects.new(HORIZON_MESH_NAME, me)
    obj["kind"] = HORIZON_KIND
    obj.location = (0.0, 0.0, 0.0)
    # Hide from selection-via-click in viewport by default — authors who
    # want to edit it click through the outliner or use the panel. Stops
    # accidental selection while editing track geometry up close.
    obj.hide_select = False  # selectable; just not opt-in-hidden
    scene.collection.objects.link(obj)
    return obj


def _wipe_horizon_object() -> None:
    obj = bpy.data.objects.get(HORIZON_MESH_NAME)
    if obj is not None:
        me = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        if me and me.users == 0:
            bpy.data.meshes.remove(me)


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class KINGTIDE_OT_add_horizon_ring(Operator):
    """Drop a ``horizon_ring`` mesh at world origin with the same
    layered-sine starter shape the runtime's procedural fallback uses.
    Tag with ``kind=horizon`` so the GLB loader extracts it. Tab into
    edit mode to push verts into your skyline (Skytree, lighthouse,
    mountain).

    Re-running on an existing ring is a no-op (just re-stamps the
    ``kind`` extras) so the operator stays safe to hit twice; use
    *Reset Horizon Ring* to start over from the procedural starter."""

    bl_idname = "kingtide.add_horizon_ring"
    bl_label = "Add Horizon Ring"
    bl_description = (
        "Drop a procedural starter horizon ring at origin. Edit-mode verts to author "
        "your skyline silhouette; the runtime extracts the mesh on GLB load."
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        existed = bpy.data.objects.get(HORIZON_MESH_NAME) is not None
        obj = _ensure_horizon_object(
            scene,
            segments=int(scene.hoverbike_horizon_segments),
            radius=float(scene.hoverbike_horizon_radius),
            peak=float(scene.hoverbike_horizon_peak),
            base=DEFAULT_BASE_M,
            seed=int(scene.hoverbike_horizon_seed),
        )
        if existed:
            self.report(
                {"INFO"},
                f"{HORIZON_MESH_NAME} already exists; refreshed kind=horizon (mesh untouched)",
            )
        else:
            self.report(
                {"INFO"},
                f"Created {HORIZON_MESH_NAME} ({obj.data.vertices.__len__()} verts) — Tab to edit",
            )
        return {"FINISHED"}


class KINGTIDE_OT_reset_horizon_ring(Operator):
    """Replace any existing ``horizon_ring`` with a freshly-generated
    procedural starter at the current panel knobs. Destructive — any
    hand-edited silhouette is lost."""

    bl_idname = "kingtide.reset_horizon_ring"
    bl_label = "Reset Horizon Ring"
    bl_description = "Regenerate the horizon ring from the procedural starter (loses hand edits)"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        _wipe_horizon_object()
        obj = _ensure_horizon_object(
            scene,
            segments=int(scene.hoverbike_horizon_segments),
            radius=float(scene.hoverbike_horizon_radius),
            peak=float(scene.hoverbike_horizon_peak),
            base=DEFAULT_BASE_M,
            seed=int(scene.hoverbike_horizon_seed),
        )
        self.report(
            {"INFO"},
            f"Reset {HORIZON_MESH_NAME} from procedural starter "
            f"(r={scene.hoverbike_horizon_radius:.0f} m, peak={scene.hoverbike_horizon_peak:.0f} m, "
            f"seed={int(scene.hoverbike_horizon_seed)})",
        )
        _ = obj  # silence unused
        return {"FINISHED"}


class KINGTIDE_OT_edit_horizon_ring(Operator):
    """One-click "select horizon_ring and tab into edit mode" so authors
    don't have to fish for the object in the outliner. No-op if the ring
    doesn't exist yet — surfaces a hint in the status bar."""

    bl_idname = "kingtide.edit_horizon_ring"
    bl_label = "Edit Horizon Ring"
    bl_description = "Select horizon_ring and enter Edit mode"
    bl_options = {"REGISTER"}

    def execute(self, context):
        obj = bpy.data.objects.get(HORIZON_MESH_NAME)
        if obj is None:
            self.report({"WARNING"}, "No horizon_ring — click Add Horizon Ring first")
            return {"CANCELLED"}
        for o in bpy.data.objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj
        if context.mode != "EDIT_MESH":
            bpy.ops.object.mode_set(mode="EDIT")
        return {"FINISHED"}


class KINGTIDE_OT_delete_horizon_ring(Operator):
    """Remove the ``horizon_ring`` mesh entirely. The runtime falls back
    to the procedural seeded silhouette on the next export."""

    bl_idname = "kingtide.delete_horizon_ring"
    bl_label = "Delete Horizon Ring"
    bl_description = "Remove horizon_ring (runtime falls back to procedural silhouette)"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        if bpy.data.objects.get(HORIZON_MESH_NAME) is None:
            self.report({"INFO"}, "No horizon_ring to delete")
            return {"CANCELLED"}
        _wipe_horizon_object()
        self.report({"INFO"}, f"Removed {HORIZON_MESH_NAME} (runtime uses procedural fallback)")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# bmesh helpers (used by tests + headless scripts)
# ────────────────────────────────────────────────────────────────────


def make_horizon_bmesh(
    *,
    segments: int = DEFAULT_SEGMENTS,
    radius: float = DEFAULT_RADIUS_M,
    peak: float = DEFAULT_PEAK_M,
    base: float = DEFAULT_BASE_M,
    seed: int = DEFAULT_SEED,
) -> bmesh.types.BMesh:
    """Headless analogue of ``_build_horizon_starter_mesh`` for use in
    test fixtures + ``seed_*`` scripts that need a horizon mesh without
    spinning up the operator. Returns a bmesh the caller can write into
    any bpy mesh."""
    bm = bmesh.new()
    cols = segments + 1
    verts_top = []
    verts_bot = []
    for i in range(cols):
        theta = (i / segments) * math.tau
        cx = math.cos(theta) * radius
        cy = math.sin(theta) * radius
        verts_top.append(bm.verts.new((cx, cy, _height_at(theta, seed) * peak)))
        verts_bot.append(bm.verts.new((cx, cy, base)))
    bm.verts.ensure_lookup_table()
    for i in range(segments):
        bm.faces.new(
            (
                verts_top[i],
                verts_top[i + 1],
                verts_bot[i + 1],
                verts_bot[i],
            )
        )
    return bm


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


_CLASSES: tuple[type, ...] = (
    KINGTIDE_OT_add_horizon_ring,
    KINGTIDE_OT_reset_horizon_ring,
    KINGTIDE_OT_edit_horizon_ring,
    KINGTIDE_OT_delete_horizon_ring,
)

_SCENE_PROP_NAMES: tuple[str, ...] = (
    "hoverbike_horizon_segments",
    "hoverbike_horizon_radius",
    "hoverbike_horizon_peak",
    "hoverbike_horizon_seed",
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.Scene.hoverbike_horizon_segments = IntProperty(
        name="Segments",
        description=(
            "Angular subdivisions of the starter ring. 192 matches the runtime's procedural "
            "fallback — authors who want more vert density for proportional-edit sculpting can "
            "bump it. Each segment adds 2 verts."
        ),
        default=DEFAULT_SEGMENTS,
        min=24,
        max=768,
    )
    bpy.types.Scene.hoverbike_horizon_radius = FloatProperty(
        name="Radius (m)",
        description=(
            "Ring radius in metres. Default 1400 — close enough that the silhouette survives "
            "the scene fog and large enough that bike traverse parallax is negligible. The "
            "runtime camera-locks the ring's XZ to the player, so this is effectively the "
            "world-far-distance the silhouette sits at."
        ),
        default=DEFAULT_RADIUS_M,
        min=200.0,
        max=5000.0,
        precision=0,
    )
    bpy.types.Scene.hoverbike_horizon_peak = FloatProperty(
        name="Peak (m)",
        description=(
            "Tallest silhouette peak above y=0 in metres. Drives how big distant landmarks "
            "read against the sky."
        ),
        default=DEFAULT_PEAK_M,
        min=20.0,
        max=2000.0,
        precision=0,
    )
    bpy.types.Scene.hoverbike_horizon_seed = IntProperty(
        name="Seed",
        description=(
            "PRNG seed for the procedural starter shape — re-roll for a different silhouette. "
            "Ignored once you've hand-edited the mesh (your verts win)."
        ),
        default=DEFAULT_SEED,
        min=0,
        max=99999,
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
