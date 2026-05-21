"""Water authoring + preview.

Three things live here:

  * **Sea level** — the scene prop ``hoverbike_water_height`` is the
    canonical source of truth. The N-panel slider writes it; the JSON
    exporter reads it; the JSON-reload writes it back; every other
    addon site that needs "the water height" goes through
    :func:`current_water_height_m`. Old ``water_volume_main``-based
    .blends migrate transparently on first read.

  * **Wave preview** — a subdivided plane displaced by a Gerstner sum,
    re-evaluated whenever sea level / time / size changes. Lives in
    ``_hoverbike_water_preview`` (hidden from render, never exported).
    The collection itself is reused across rebuilds so the Outliner's
    expanded/collapsed state survives debounced changes.

  * **Legacy water volume** — ``water_volume_main`` is still spawnable
    via :class:`HOVERBIKE_OT_add_water_volume`, but is now optional:
    its only purpose is to carry ``wave_height`` / ``wave_freq`` custom
    props that override the runtime's default Gerstner amplitude /
    frequency. The empty's transform is no longer consulted for sea
    level.

Per-module ``register()`` / ``unregister()`` so the package init just
calls them. Operators are referenced from the panel by ``bl_idname``.
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


def current_water_height_m(scene) -> float:
    """Canonical sea level in metres. The :scene prop:`hoverbike_water_height`
    is now the source of truth; everything that needs "the height of
    the water surface" should call into here rather than reading
    ``water_volume_main.location.z`` directly.

    Reads via ``getattr`` rather than ``scene.get()`` because registered
    ``FloatProperty`` values written by the UI slider live in the RNA
    descriptor path, NOT the underlying ID-property dict that ``.get()``
    reads from. The two only agree once the value has been explicitly
    written through the dict path (which never happens for slider edits).
    This caused snap_starts_to_spline + the HV_RoadConform default seed
    to read sea level = 0 even when the slider clearly showed -3.5, so
    bridges over open water dropped to the seafloor.

    One-time fallback: if the scene prop is at its default 0 *and* a
    legacy ``water_volume_main`` carries a non-zero Z (a .blend saved
    before the migration), promote the volume's Z into the scene prop
    and return it. Subsequent calls see the scene-prop value and
    skip the lookup, so the migration costs one dict read per .blend
    open."""
    raw = getattr(scene, "hoverbike_water_height", None)
    if isinstance(raw, (int, float)) and float(raw) != 0.0:
        return float(raw)
    vol = bpy.data.objects.get(WATER_VOLUME_NAME)
    if vol is not None:
        legacy_z = float(vol.location.z)
        if legacy_z != 0.0:
            scene["hoverbike_water_height"] = legacy_z
            return legacy_z
    return float(raw) if isinstance(raw, (int, float)) else 0.0


def rebuild_water_preview(scene, *, size: float, subdivisions: int, time: float) -> dict:
    """Create / refresh the water-preview collection. Returns a summary
    for the operator's status report.

    Public (no leading underscore) because the package-level debounce
    timer in ``_legacy._run_pending_rebuilds`` calls back into it when
    the user drags the slider or the legacy volume.

    The preview mesh's Z is set from :func:`current_water_height_m`
    (i.e. the ``hoverbike_water_height`` scene prop) — the slider /
    JSON-reload are the canonical control, not the volume's transform.
    The collection itself is reused if already present so the
    Outliner's expanded/collapsed state survives debounced rebuilds."""
    from ._legacy import _find_layer_collection  # imported lazily to avoid cycle at module load

    sea_level = current_water_height_m(scene)
    center = (0.0, 0.0, sea_level)

    # Recycle the existing preview mesh + collection so collapse state
    # in the Outliner doesn't reset every time the slider scrubs.
    me = _build_water_plane_mesh(
        WATER_PREVIEW_MESH, size=size, subdivisions=subdivisions, t=time
    )
    coll = bpy.data.collections.get(WATER_PREVIEW_COLLECTION)
    if coll is None:
        coll = bpy.data.collections.new(WATER_PREVIEW_COLLECTION)
        scene.collection.children.link(coll)

    obj = bpy.data.objects.get("water_preview")
    if obj is None:
        obj = bpy.data.objects.new("water_preview", me)
        coll.objects.link(obj)
    else:
        old_mesh = obj.data
        obj.data = me
        if isinstance(old_mesh, bpy.types.Mesh) and old_mesh.users == 0 and old_mesh.name != me.name:
            bpy.data.meshes.remove(old_mesh)
    obj.location = center
    obj.hide_render = True

    lc = _find_layer_collection(
        bpy.context.view_layer.layer_collection, WATER_PREVIEW_COLLECTION
    )
    if lc:
        lc.exclude = False

    return {
        "centered_on": "scene.hoverbike_water_height",
        "vert_count": (subdivisions + 1) ** 2,
        "face_count": subdivisions**2,
        "preview_at": center,
        "time_s": time,
    }


# ────────────────────────────────────────────────────────────────────
# Sea level (canonical) + legacy water volume
# ────────────────────────────────────────────────────────────────────
#
# Sea level lives on the scene as ``hoverbike_water_height`` — see
# :func:`current_water_height_m` above. The slider in the N-panel
# writes the scene prop directly; the preview mesh's Z is recomputed
# from it on every rebuild. The exporter + JSON-reload both go
# through ``current_water_height_m``.
#
# ``water_volume_main`` is still optional: when present it carries
# the ``wave_height`` / ``wave_freq`` custom props the exporter uses
# for the Gerstner amplitude / frequency overrides. Its transform is
# no longer load-bearing for sea level — old .blends migrate
# lazily via the helper. Authors who don't override wave parameters
# don't need a volume in the scene at all.


def _ensure_water_volume(scene) -> bpy.types.Object:
    """Return the legacy water-volume empty, creating it if missing.
    Used by :class:`HOVERBIKE_OT_add_water_volume` (still around for
    authors who want to tune ``wave_height`` / ``wave_freq``)."""
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


def _on_water_prop_changed(self, context):
    from .handlers import _schedule_rebuild

    _schedule_rebuild("water")


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_rebuild_water_preview(Operator):
    """Build a vertex-displaced water plane at the scene-wide sea
    level (``hoverbike_water_height``) using the same Gerstner wave
    parameters the runtime's ``defaultWaves()`` uses. Pure preview —
    the plane lives in a render-disabled collection and never reaches
    the .glb export."""

    bl_idname = "hoverbike.rebuild_water_preview"
    bl_label = "Add Water Preview"
    bl_description = (
        "Add (or rebuild) a wave-displaced water plane at the current Sea "
        "level. Idempotent — re-run to refresh after editing Sea level / "
        "wave params"
    )
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
    scene doesn't already have one. The empty's ``wave_height`` /
    ``wave_freq`` custom props ship into the JSON's water block on
    export — use this when you want to override the runtime's default
    Gerstner amplitude / frequency. Sea level itself comes from the
    scene-wide *Sea level* slider, NOT from the empty's transform."""

    bl_idname = "hoverbike.add_water_volume"
    bl_label = "Add Water Volume (legacy / wave overrides)"
    bl_description = (
        "Create a `water_volume_main` empty (optional — only useful if you want to "
        "override `wave_height` / `wave_freq` per-track). Sea level lives on the slider."
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        existed = bpy.data.objects.get(WATER_VOLUME_NAME) is not None
        obj = _ensure_water_volume(context.scene)
        if existed:
            self.report(
                {"INFO"}, f"{WATER_VOLUME_NAME} already exists."
            )
        else:
            self.report(
                {"INFO"},
                f"Created {WATER_VOLUME_NAME}. Edit wave_height / wave_freq on its Custom Properties.",
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

    # Sea level — canonical scene-wide value. Used to be a proxy for
    # water_volume_main.location.z; flipped in 2026-05 so the scene
    # prop IS the source of truth and the preview mesh's height tracks
    # it. Legacy .blends migrate via current_water_height_m's
    # one-time fallback. The update callback fires a debounced
    # water-preview rebuild so the surface tracks the slider.
    bpy.types.Scene.hoverbike_water_height = FloatProperty(
        name="Sea level (m)",
        description=(
            "World sea level. Drives the water-preview mesh's Z and ships out as "
            "`water.height` in the JSON on export. Old `water_volume_main` empties are "
            "no longer load-bearing — they're optional for `wave_height` / `wave_freq` overrides only."
        ),
        default=0.0,
        min=-500.0,
        max=500.0,
        precision=2,
        update=_on_water_prop_changed,
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
