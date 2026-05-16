"""Water authoring + preview.

Two things live here:

  * ``water_volume_main`` — the empty whose ``location.z`` is the world
    sea level. Carries ``kind="water"`` so the runtime / export pipeline
    can find it. ``wave_height`` + ``wave_freq`` are exported into the
    track JSON's ``water`` block.

  * Wave preview — a subdivided plane displaced by a Gerstner sum,
    re-evaluated whenever the volume moves or the user scrubs the
    wave-time slider. Lives in a ``_hoverbike_water_preview`` collection
    that's hidden from render + never exported.

Per-module ``register()`` / ``unregister()`` so the package init just
calls them. Operators are referenced from the panel by ``bl_idname``,
so the (still-in-``_legacy.py``) ``HOVERBIKE_PT_track_water`` panel
keeps working unchanged.
"""

from __future__ import annotations

import math

import bpy
from bpy.props import FloatProperty, IntProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

WATER_VOLUME_NAME = "water_volume_main"
WATER_PREVIEW_COLLECTION = "_hoverbike_water_preview"
WATER_PREVIEW_MESH = "_hoverbike_water_surface"

# Mirror of ``defaultWaves()`` in ``src/engine/sim/water/wave-field.ts``.
# Tuple layout: (dirX, dirZ, amplitude, wavelength, speed, phase). Keep
# both sides together when tuning — the preview is only useful as a
# preview if it matches the runtime.
DEFAULT_WAVES: tuple[tuple[float, float, float, float, float, float], ...] = (
    # Swells
    (0.92, 0.39, 0.55, 60.0, 10.0, 0.4),
    (0.60, 0.80, 0.40, 85.0, 11.0, 2.2),
    # Chop
    (1.00, 0.00, 0.65, 22.0, 4.0, 0.0),
    (0.707, 0.707, 0.44, 14.0, 3.6, 1.1),
    (0.30, -0.954, 0.29, 9.0, 3.0, 2.3),
    (-0.50, 0.866, 0.16, 5.5, 2.4, 3.7),
)


# ────────────────────────────────────────────────────────────────────
# Wave preview
# ────────────────────────────────────────────────────────────────────


def _sample_water_height(x: float, z: float, t: float) -> float:
    """Sum-of-sines vertical Gerstner — same formula as ``sampleHeight``
    in ``wave-field.ts``. Returns water surface y at (x, z, t)."""
    y = 0.0
    for dx, dz, amp, wavelength, speed, phase in DEFAULT_WAVES:
        k = (2.0 * math.pi) / wavelength
        omega = speed * k
        p = k * (dx * x + dz * z) - omega * t + phase
        y += amp * math.sin(p)
    return y


def _wipe_water_preview() -> None:
    coll = bpy.data.collections.get(WATER_PREVIEW_COLLECTION)
    if coll:
        for obj in list(coll.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(coll)
    if WATER_PREVIEW_MESH in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[WATER_PREVIEW_MESH])


def _build_water_plane_mesh(name: str, size: float, subdivisions: int, t: float):
    """Build a subdivided plane mesh and displace each vertex by the
    wave function evaluated at world (x, y, t). The plane sits at world
    z = (sample), then the caller translates it to the volume's z after
    assignment."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)

    n = max(2, int(subdivisions))
    step = size / n
    half = size / 2.0
    # Blender is Z-up: horizontal plane is XY, wave displacement is Z.
    # The runtime wave function expects (x, z) in its Y-up world; we feed
    # Blender's (x, y) into those slots so the wave shape reads the same
    # in viewport as it will in-game (modulo the Z-up→Y-up swap the glTF
    # exporter handles at export time).
    verts = []
    for j in range(n + 1):
        for i in range(n + 1):
            x = -half + i * step
            y = -half + j * step
            z = _sample_water_height(x, y, t)
            verts.append((x, y, z))
    faces = []
    for j in range(n):
        for i in range(n):
            a = j * (n + 1) + i
            b = a + 1
            c = a + (n + 1)
            d = c + 1
            faces.append((a, b, d, c))
    me.from_pydata(verts, [], faces)
    me.update()
    # Smooth shading so the surface reads as wavy water, not faceted.
    for poly in me.polygons:
        poly.use_smooth = True
    return me


def rebuild_water_preview(scene, *, size: float, subdivisions: int, time: float) -> dict:
    """Create / replace the water-preview collection. Returns a summary
    for the operator's status report.

    Public (no leading underscore) because the package-level debounce
    timer in ``_legacy._run_pending_rebuilds`` calls back into it when
    the user drags the volume in the viewport."""
    from ._legacy import _find_layer_collection  # imported lazily to avoid cycle at module load

    vol = bpy.data.objects.get(WATER_VOLUME_NAME)
    center = (0.0, 0.0, 0.0)
    if vol is not None:
        loc = vol.matrix_world.translation
        center = (loc.x, loc.y, loc.z)

    _wipe_water_preview()
    me = _build_water_plane_mesh(
        WATER_PREVIEW_MESH, size=size, subdivisions=subdivisions, t=time
    )
    coll = bpy.data.collections.new(WATER_PREVIEW_COLLECTION)
    scene.collection.children.link(coll)

    obj = bpy.data.objects.new("water_preview", me)
    obj.location = (center[0], center[1], center[2])
    obj.hide_render = True
    coll.objects.link(obj)

    lc = _find_layer_collection(
        bpy.context.view_layer.layer_collection, WATER_PREVIEW_COLLECTION
    )
    if lc:
        lc.exclude = False

    return {
        "centered_on": "water_volume_main" if vol is not None else "world origin",
        "vert_count": (subdivisions + 1) ** 2,
        "face_count": subdivisions**2,
        "preview_at": center,
        "time_s": time,
    }


# ────────────────────────────────────────────────────────────────────
# Water-volume authoring
# ────────────────────────────────────────────────────────────────────
#
# ``water_volume_main``'s Z position IS the in-game sea level — the
# export already reads it into ``water.height`` and the JSON-reload
# writes it back (see derive_track_json + reload_track_from_json). The
# slider below proxies the empty's Z so authors can scrub the height
# without hunting for the empty in the outliner.


def _ensure_water_volume(scene) -> bpy.types.Object:
    """Return the canonical water volume empty, creating it if missing."""
    obj = bpy.data.objects.get(WATER_VOLUME_NAME)
    if obj is not None:
        return obj
    obj = bpy.data.objects.new(WATER_VOLUME_NAME, None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 50.0
    obj["kind"] = "water"
    obj["wave_height"] = 1.0
    obj["wave_freq"] = 0.5
    obj.location = (0.0, 0.0, 0.0)
    scene.collection.objects.link(obj)
    return obj


def _get_water_height(self) -> float:
    obj = bpy.data.objects.get(WATER_VOLUME_NAME)
    return float(obj.location.z) if obj is not None else 0.0


def _set_water_height(self, value: float) -> None:
    from ._legacy import _schedule_rebuild  # lazy import — debounce lives in _legacy

    obj = bpy.data.objects.get(WATER_VOLUME_NAME)
    if obj is None:
        # Lazily create — first scrub of the slider makes the volume
        # appear, no separate "Add Water" button needed.
        obj = _ensure_water_volume(bpy.context.scene)
    obj.location.z = float(value)
    # Trigger the same debounced rebuild a viewport drag would.
    _schedule_rebuild("water")


def _on_water_prop_changed(self, context):
    from ._legacy import _schedule_rebuild

    _schedule_rebuild("water")


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_rebuild_water_preview(Operator):
    """Build a vertex-displaced water plane around ``water_volume_main``
    using the same Gerstner wave parameters the runtime's
    ``defaultWaves()`` uses. Pure preview — the plane lives in a
    render-disabled collection and never reaches the .glb export."""

    bl_idname = "hoverbike.rebuild_water_preview"
    bl_label = "Rebuild Water Preview"
    bl_description = "Build a wave-displaced water plane around water_volume_main"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        size = float(scene.hoverbike_water_size)
        subdivisions = int(scene.hoverbike_water_subdivisions)
        time = float(scene.hoverbike_water_time)
        summary = rebuild_water_preview(
            scene, size=size, subdivisions=subdivisions, time=time
        )
        self.report(
            {"INFO"},
            f"Water preview: {summary['vert_count']} verts at t={summary['time_s']:.2f}s ({summary['centered_on']})",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_add_water_volume(Operator):
    """Drop a ``water_volume_main`` empty at the world origin if the
    scene doesn't already have one. Sets ``kind=water`` + sane wave
    defaults so the new empty round-trips through derive_track_json on
    the next export. Existing volumes are left alone."""

    bl_idname = "hoverbike.add_water_volume"
    bl_label = "Add Water Volume"
    bl_description = (
        "Create a `water_volume_main` empty at world origin (drag in viewport to set sea level)"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        existed = bpy.data.objects.get(WATER_VOLUME_NAME) is not None
        obj = _ensure_water_volume(context.scene)
        if existed:
            self.report(
                {"INFO"}, f"{WATER_VOLUME_NAME} already exists at z={obj.location.z:.2f}."
            )
        else:
            self.report(
                {"INFO"},
                f"Created {WATER_VOLUME_NAME} at z=0; drag it up/down to set sea level.",
            )
        return {"FINISHED"}


class HOVERBIKE_OT_hide_water_preview(Operator):
    """Toggle the water-preview collection's visibility off without
    deleting it. Re-run Rebuild to bring it back."""

    bl_idname = "hoverbike.hide_water_preview"
    bl_label = "Hide Water Preview"
    bl_description = "Hide water preview without deleting it"
    bl_options = {"REGISTER"}

    def execute(self, context):
        from ._legacy import _find_layer_collection

        lc = _find_layer_collection(
            context.view_layer.layer_collection, WATER_PREVIEW_COLLECTION
        )
        if lc:
            lc.exclude = True
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_rebuild_water_preview,
    HOVERBIKE_OT_add_water_volume,
    HOVERBIKE_OT_hide_water_preview,
)

_SCENE_PROP_NAMES: tuple[str, ...] = (
    "hoverbike_water_height",
    "hoverbike_water_size",
    "hoverbike_water_subdivisions",
    "hoverbike_water_time",
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    # Sea level — proxies water_volume_main.location.z so authors can
    # scrub it from the panel without finding the empty. The setter
    # creates the empty if missing so the slider is always usable.
    bpy.types.Scene.hoverbike_water_height = FloatProperty(
        name="Sea level (m)",
        description=(
            "Z position of `water_volume_main` (= world sea level). Drag the empty in the "
            "viewport or scrub here; both write to `water.height` in the JSON on export."
        ),
        default=0.0,
        min=-500.0,
        max=500.0,
        precision=2,
        get=_get_water_height,
        set=_set_water_height,
    )
    bpy.types.Scene.hoverbike_water_size = FloatProperty(
        name="Water plane size (m)",
        description="Edge length of the displaced water plane",
        default=300.0,
        min=10.0,
        max=2000.0,
        precision=1,
        update=_on_water_prop_changed,
    )
    bpy.types.Scene.hoverbike_water_subdivisions = IntProperty(
        name="Water subdivisions",
        description=(
            "Per-edge subdivisions of the water plane. Higher = smoother waves, slower rebuild."
        ),
        default=80,
        min=8,
        max=400,
        update=_on_water_prop_changed,
    )
    bpy.types.Scene.hoverbike_water_time = FloatProperty(
        name="Wave time (s)",
        description=(
            "Simulation time the wave field is sampled at — 0 for canonical pose, scrub for variety."
        ),
        default=0.0,
        min=-60.0,
        max=60.0,
        precision=2,
        update=_on_water_prop_changed,
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
