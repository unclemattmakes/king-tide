"""Water authoring + preview.

Four things live here:

  * **Sea level** — the scene prop ``hoverbike_water_height`` is the
    canonical source of truth. The N-panel slider writes it; the JSON
    exporter reads it; the JSON-reload writes it back; every other
    addon site that needs "the water height" goes through
    :func:`current_water_height_m`. Old ``water_volume_main``-based
    .blends migrate transparently on first read.

  * **Wave shape** — the scene props ``hoverbike_water_wave_height``
    and ``hoverbike_water_wave_freq`` are amplitude / frequency scalars
    for the in-viewport wave PREVIEW only. They used to ship out as
    ``water.waveHeight`` / ``water.waveFreq`` in the per-track JSON, but
    the runtime never read those keys (real amplitude comes from
    ``sky.seaStateBeaufort`` + ``waveZones``), so the exporter stopped
    emitting them (P0.3 hygiene, docs/water-next-research.md §4.5).
    Dragging a slider still redisplaces the preview surface live. Same
    promote-on-first-read pattern as sea level: legacy
    ``water_volume_main.wave_height`` / ``wave_freq`` custom props are
    pulled into the scene props on .blend open.

  * **Wave preview** — a subdivided plane displaced by a Gerstner sum,
    re-evaluated whenever sea level / time / size / wave-shape changes.
    Lives in ``_hoverbike_water_preview`` (hidden from render, never
    exported). The collection itself is reused across rebuilds so the
    Outliner's expanded/collapsed state survives debounced changes.
    *Fit to Scene* auto-sizes it to the world bbox.

  * **Legacy water volume** — ``water_volume_main`` is still spawnable
    via :class:`KINGTIDE_OT_add_water_volume` for back-compat with
    older tooling that reads its custom props. Nothing inside the
    addon depends on it any more — the scene-prop sliders are the
    canonical UI.

Per-module ``register()`` / ``unregister()`` so the package init just
calls them. Operators are referenced from the panel by ``bl_idname``.
"""

from __future__ import annotations

import math

import bpy
import mathutils
from bpy.props import FloatProperty, IntProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

WATER_VOLUME_NAME = "water_volume_main"
WATER_PREVIEW_COLLECTION = "_hoverbike_water_preview"
WATER_PREVIEW_MESH = "_hoverbike_water_surface"
WATER_PREVIEW_MATERIAL = "mat_water_preview"

# Mirror of ``defaultWaves()`` in ``src/engine/sim/water/wave-field.ts``.
# Tuple layout: (dirX, dirZ, amplitude, wavelength, speed, phase). Keep
# both sides together when tuning — the preview is only useful as a
# preview if it matches the runtime. Last synced 2026-05 to the coherent
# ±25° swell-fan preset (two long swells + four chop bands).
DEFAULT_WAVES: tuple[tuple[float, float, float, float, float, float], ...] = (
    # Primary swell — dominant set rolling toward the bike.
    (1.000,  0.000, 0.50, 50.0, 8.6, 0.4),
    # Secondary swell — same direction, beats with the primary every ~24 s.
    (0.985,  0.174, 0.35, 85.0, 11.2, 2.2),
    # Mid-band chop along the bearing.
    (1.000,  0.000, 0.22, 16.0, 5.0, 0.0),
    # Cross-chop fanned ±25° around bearing for surface variety.
    (0.906,  0.423, 0.16, 10.0, 4.0, 1.1),
    (0.940, -0.342, 0.10,  6.0, 3.1, 2.3),
    (0.985,  0.174, 0.06,  4.0, 2.5, 3.7),
)


# ────────────────────────────────────────────────────────────────────
# Wave preview
# ────────────────────────────────────────────────────────────────────


def _ensure_water_preview_material() -> bpy.types.Material:
    """Authoring-only material for the wave preview plane.

    Deep-ocean blue with ~55% alpha so terrain underneath stays legible
    while the surface reads as water instead of a featureless grey plane.
    Runtime water shading lives in ``src/engine/render/water.ts`` — this
    material never reaches the GLB because the preview lives in a
    render-disabled collection.

    Idempotent — re-runs return the existing datablock so re-builds
    don't pile up duplicate materials in the .blend."""
    mat = bpy.data.materials.get(WATER_PREVIEW_MATERIAL)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(WATER_PREVIEW_MATERIAL)
    mat.use_nodes = True
    mat.blend_method = "BLEND"
    mat.show_transparent_back = False
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.06, 0.32, 0.55, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.15
        alpha_in = bsdf.inputs.get("Alpha")
        if alpha_in is not None:
            alpha_in.default_value = 0.55
        spec = bsdf.inputs.get("Specular IOR Level") or bsdf.inputs.get("Specular")
        if spec is not None:
            spec.default_value = 0.5
    mat["hoverbike_preview_only"] = True
    return mat


def _sample_water_height(
    x: float,
    z: float,
    t: float,
    *,
    amp_mult: float = 1.0,
    freq_mult: float = 1.0,
) -> float:
    """Sum-of-sines vertical Gerstner — same formula as ``sampleHeight``
    in ``wave-field.ts``. Returns water surface y at (x, z, t).

    ``amp_mult`` scales every wave's amplitude (so 0 → flat ocean,
    2 → twice the chop). ``freq_mult`` multiplies the wavenumber k
    (so 0.5 → wavelengths doubled, 2.0 → wavelengths halved). Both are
    PREVIEW-ONLY scalars (the old ``water.waveHeight`` / ``waveFreq``
    JSON keys are dead and no longer exported); the runtime's actual
    amplitude driver is ``sky.seaStateBeaufort`` + ``waveZones``."""
    y = 0.0
    for dx, dz, amp, wavelength, speed, phase in DEFAULT_WAVES:
        k = ((2.0 * math.pi) / wavelength) * freq_mult
        omega = speed * k
        p = k * (dx * x + dz * z) - omega * t + phase
        y += amp_mult * amp * math.sin(p)
    return y


def _wipe_water_preview() -> None:
    coll = bpy.data.collections.get(WATER_PREVIEW_COLLECTION)
    if coll:
        for obj in list(coll.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(coll)
    if WATER_PREVIEW_MESH in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[WATER_PREVIEW_MESH])


def _build_water_plane_mesh(
    name: str,
    size: float,
    subdivisions: int,
    t: float,
    *,
    amp_mult: float = 1.0,
    freq_mult: float = 1.0,
):
    """Build a subdivided plane mesh and displace each vertex by the
    wave function evaluated at world (x, y, t). The plane sits at world
    z = (sample), then the caller translates it to the volume's z after
    assignment. ``amp_mult`` / ``freq_mult`` are forwarded to
    :func:`_sample_water_height`."""
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
            z = _sample_water_height(x, y, t, amp_mult=amp_mult, freq_mult=freq_mult)
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


def current_wave_height_mult(scene) -> float:
    """Gerstner-amplitude scalar for the in-viewport wave PREVIEW (the
    old ``water.waveHeight`` JSON key is dead — no longer exported, never
    read by the runtime). Reads the scene prop
    ``hoverbike_water_wave_height`` first; falls back to the legacy
    ``water_volume_main.wave_height`` custom prop and promotes it into
    the scene prop on first read so .blends authored before the slider
    landed don't lose their authored amplitude.

    Same pattern as :func:`current_water_height_m` — descriptor-path
    read so slider edits register, dict-path read on the legacy volume
    because custom props live in ID-properties."""
    raw = getattr(scene, "hoverbike_water_wave_height", None)
    if isinstance(raw, (int, float)) and float(raw) != 1.0:
        return float(raw)
    vol = bpy.data.objects.get(WATER_VOLUME_NAME)
    if vol is not None:
        legacy = vol.get("wave_height")
        if isinstance(legacy, (int, float)) and float(legacy) != 1.0:
            scene["hoverbike_water_wave_height"] = float(legacy)
            return float(legacy)
    return float(raw) if isinstance(raw, (int, float)) else 1.0


def current_wave_freq_mult(scene) -> float:
    """Gerstner-frequency scalar for the in-viewport wave PREVIEW (the
    old ``water.waveFreq`` JSON key is dead — no longer exported, never
    read by the runtime). Same promote-on-first-read pattern as
    :func:`current_wave_height_mult`.

    Default is 1.0 ("authored wavelengths, no change"). Note that
    pre-slider .blends had a legacy default of 0.5 — that value gets
    promoted verbatim into the new scene prop, so existing tracks
    keep their historic preview until the author dials it
    deliberately."""
    raw = getattr(scene, "hoverbike_water_wave_freq", None)
    if isinstance(raw, (int, float)) and float(raw) != 1.0:
        return float(raw)
    vol = bpy.data.objects.get(WATER_VOLUME_NAME)
    if vol is not None:
        legacy = vol.get("wave_freq")
        if isinstance(legacy, (int, float)) and float(legacy) != 1.0:
            scene["hoverbike_water_wave_freq"] = float(legacy)
            return float(legacy)
    return float(raw) if isinstance(raw, (int, float)) else 1.0


def rebuild_water_preview(scene, *, size: float, subdivisions: int, time: float) -> dict:
    """Create / refresh the water-preview collection. Returns a summary
    for the operator's status report.

    Public (no leading underscore) because the package-level debounce
    timer in ``_legacy._run_pending_rebuilds`` calls back into it when
    the user drags the slider or the legacy volume.

    The preview mesh's Z is set from :func:`current_water_height_m`
    (i.e. the ``hoverbike_water_height`` scene prop) — the slider /
    JSON-reload are the canonical control, not the volume's transform.
    Wave amplitude / frequency multipliers come from the matching
    scene props via :func:`current_wave_height_mult` /
    :func:`current_wave_freq_mult`, so dragging the wave-height slider
    immediately redisplaces the preview (via the debounced rebuild).

    The collection itself is reused if already present so the
    Outliner's expanded/collapsed state survives debounced rebuilds."""
    from ._legacy import _find_layer_collection  # imported lazily to avoid cycle at module load

    sea_level = current_water_height_m(scene)
    amp_mult = current_wave_height_mult(scene)
    freq_mult = current_wave_freq_mult(scene)
    center = (0.0, 0.0, sea_level)

    # Recycle the existing preview mesh + collection so collapse state
    # in the Outliner doesn't reset every time the slider scrubs.
    me = _build_water_plane_mesh(
        WATER_PREVIEW_MESH,
        size=size,
        subdivisions=subdivisions,
        t=time,
        amp_mult=amp_mult,
        freq_mult=freq_mult,
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

    # Translucent blue material so the preview reads as water in solid /
    # material-preview viewport modes. Reassigned on every rebuild because
    # ``_build_water_plane_mesh`` makes a fresh Mesh datablock — the
    # previous mesh's materials don't carry across.
    preview_mat = _ensure_water_preview_material()
    if me.materials:
        me.materials[0] = preview_mat
    else:
        me.materials.append(preview_mat)

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
        "amp_mult": amp_mult,
        "freq_mult": freq_mult,
    }


# ────────────────────────────────────────────────────────────────────
# Sea level + wave shape (canonical) + legacy water volume
# ────────────────────────────────────────────────────────────────────
#
# All three canonical values live on the scene as float properties:
# ``hoverbike_water_height``, ``hoverbike_water_wave_height``,
# ``hoverbike_water_wave_freq``. The N-panel sliders write them; the
# exporter + JSON-reload + wave preview all go through the
# ``current_*`` helpers above.
#
# ``water_volume_main`` is now purely a legacy compat shim. New
# .blends don't need one. The helpers promote any legacy
# ``location.z`` / ``wave_height`` / ``wave_freq`` custom props on
# the volume into the scene props on first read, so older .blends
# migrate transparently.


def _ensure_water_volume(scene) -> bpy.types.Object:
    """Return the legacy water-volume empty, creating it if missing.
    Used by :class:`KINGTIDE_OT_add_water_volume`. The custom props
    seed from the current scene-prop slider values rather than
    hardcoded defaults, so creating a volume can't surprise the
    author by retroactively halving the slider on next read (via the
    promote-on-default fallback in ``current_wave_freq_mult``)."""
    obj = bpy.data.objects.get(WATER_VOLUME_NAME)
    if obj is not None:
        return obj
    obj = bpy.data.objects.new(WATER_VOLUME_NAME, None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 50.0
    obj["kind"] = "water"
    obj["wave_height"] = current_wave_height_mult(scene)
    obj["wave_freq"] = current_wave_freq_mult(scene)
    obj.location = (0.0, 0.0, 0.0)
    scene.collection.objects.link(obj)
    return obj


def _on_water_prop_changed(self, context):
    from .handlers import _schedule_rebuild

    _schedule_rebuild("water")
    # Sea level / wave height affect which road samples are flagged
    # "over water", so refresh the buoy strip too. Cheap no-op if the
    # buoy master toggle is off or the curve / water isn't authored.
    _schedule_rebuild("buoys")


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class KINGTIDE_OT_rebuild_water_preview(Operator):
    """Build a vertex-displaced water plane at the scene-wide sea
    level (``hoverbike_water_height``) using the same Gerstner wave
    parameters the runtime's ``defaultWaves()`` uses. Pure preview —
    the plane lives in a render-disabled collection and never reaches
    the .glb export."""

    bl_idname = "kingtide.rebuild_water_preview"
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


class KINGTIDE_OT_add_water_volume(Operator):
    """Drop a ``water_volume_main`` empty at the world origin if the
    scene doesn't already have one. The empty's ``wave_height`` /
    ``wave_freq`` custom props ship into the JSON's water block on
    export — use this when you want to override the runtime's default
    Gerstner amplitude / frequency. Sea level itself comes from the
    scene-wide *Sea level* slider, NOT from the empty's transform."""

    bl_idname = "kingtide.add_water_volume"
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


class KINGTIDE_OT_fit_water_preview_to_scene(Operator):
    """Auto-size the water plane to cover every visible mesh in the
    scene plus a margin, so it never reads as smaller than the map.
    Writes the result to ``hoverbike_water_size`` (which triggers a
    debounced rebuild via the slider's ``update`` callback).

    "Visible" = the mesh is in a non-excluded collection. The water
    preview, render-only previews, gates, and other addon-managed
    helpers are skipped so they can't shrink the resulting size below
    what the actual track geometry needs."""

    bl_idname = "kingtide.fit_water_preview_to_scene"
    bl_label = "Fit to Scene"
    bl_description = (
        "Resize the water plane to cover every visible mesh in the scene plus a "
        "10% margin. Skips addon-managed previews so they can't shrink the result"
    )
    bl_options = {"REGISTER", "UNDO"}

    _SKIP_PREFIXES: tuple[str, ...] = (
        "_hoverbike",       # all addon-managed preview collections
        "water_preview",     # the water-plane object itself
    )

    def execute(self, context):
        scene = context.scene
        # Pull every mesh / curve in a non-excluded collection. Walking
        # bpy.data.objects then checking visibility via the layer
        # collections catches link-from-library objects too, and skips
        # things hidden in the viewport via `exclude=True`.
        bounds_min_x = bounds_min_y = float("inf")
        bounds_max_x = bounds_max_y = float("-inf")
        counted = 0
        for obj in scene.objects:
            if obj.type not in {"MESH", "CURVE", "EMPTY", "FONT"}:
                continue
            # Skip addon-managed previews so the water preview can't
            # shrink itself, and skip anything already inside the
            # water-preview collection (re-runs would otherwise pin
            # the size to the last fit value).
            if any(obj.name.startswith(p) for p in self._SKIP_PREFIXES):
                continue
            if not obj.visible_get():
                continue
            for corner in obj.bound_box:
                # bound_box is in local space; transform to world.
                world = obj.matrix_world @ mathutils.Vector(corner)
                bounds_min_x = min(bounds_min_x, world.x)
                bounds_min_y = min(bounds_min_y, world.y)
                bounds_max_x = max(bounds_max_x, world.x)
                bounds_max_y = max(bounds_max_y, world.y)
                counted += 1
        if counted == 0:
            self.report({"WARNING"}, "No visible meshes to fit — leaving size alone.")
            return {"CANCELLED"}
        # The preview is a square centred at origin; use the larger of
        # the two world extents and round up to the nearest 50 m so
        # tiny edits don't keep nudging the size to weird values.
        span_x = bounds_max_x - bounds_min_x
        span_y = bounds_max_y - bounds_min_y
        # The plane straddles the origin (extends ±size/2). If the
        # scene is off-centre, the plane still has to cover the far
        # edge — so the size has to be 2 × max(|coord|) on each axis.
        reach = max(
            abs(bounds_min_x),
            abs(bounds_max_x),
            abs(bounds_min_y),
            abs(bounds_max_y),
        )
        needed = 2.0 * reach * 1.1  # 10% margin past the farthest edge
        # Round up to nearest 50 m for slider readability.
        rounded = max(50.0, math.ceil(needed / 50.0) * 50.0)
        # Clamp to the slider's max so the assignment doesn't raise.
        clamped = min(rounded, 4000.0)
        scene.hoverbike_water_size = clamped
        self.report(
            {"INFO"},
            f"Water size → {clamped:.0f} m (covers {span_x:.0f}×{span_y:.0f} m scene, {counted} obj corners sampled)",
        )
        return {"FINISHED"}


class KINGTIDE_OT_hide_water_preview(Operator):
    """Toggle the water-preview collection's visibility off without
    deleting it. Re-run Rebuild to bring it back."""

    bl_idname = "kingtide.hide_water_preview"
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
    KINGTIDE_OT_rebuild_water_preview,
    KINGTIDE_OT_add_water_volume,
    KINGTIDE_OT_fit_water_preview_to_scene,
    KINGTIDE_OT_hide_water_preview,
)

_SCENE_PROP_NAMES: tuple[str, ...] = (
    "hoverbike_water_height",
    "hoverbike_water_size",
    "hoverbike_water_subdivisions",
    "hoverbike_water_time",
    "hoverbike_water_wave_height",
    "hoverbike_water_wave_freq",
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
        description=(
            "Edge length of the displaced water plane. Default 1200 m covers most "
            "tracks out of the box; use Fit to Scene to auto-size to your map."
        ),
        default=1200.0,
        min=10.0,
        max=4000.0,
        precision=1,
        update=_on_water_prop_changed,
    )
    bpy.types.Scene.hoverbike_water_subdivisions = IntProperty(
        name="Water subdivisions",
        description=(
            "Per-edge subdivisions of the water plane. Higher = smoother waves, slower rebuild. "
            "At default (320) on a 1200 m plane the cell size is ~3.75 m — fine enough to "
            "show every chop band in DEFAULT_WAVES without aliasing."
        ),
        default=320,
        min=8,
        max=800,
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
    # Wave amplitude / frequency multipliers — PREVIEW-ONLY. They used
    # to ship as the JSON `water.waveHeight` / `water.waveFreq` keys,
    # but the runtime never read those (real amplitude comes from
    # `sky.seaStateBeaufort` + `waveZones`), so the exporter dropped
    # them (P0.3 hygiene). Default 1.0 / 1.0 means "ride DEFAULT_WAVES
    # as authored". Legacy `water_volume_main.wave_height` / `wave_freq`
    # custom props get promoted into these on first read (see
    # current_wave_*_mult), so pre-slider .blends keep their authored
    # preview amplitude.
    bpy.types.Scene.hoverbike_water_wave_height = FloatProperty(
        name="Wave height",
        description=(
            "Per-wave amplitude multiplier for the viewport wave preview. 0 → flat ocean, "
            "1 → DEFAULT_WAVES as authored, 2 → twice the chop. Preview-only — NOT exported "
            "(the runtime's amplitude driver is sky.seaStateBeaufort + waveZones)."
        ),
        default=1.0,
        min=0.0,
        max=3.0,
        precision=2,
        update=_on_water_prop_changed,
    )
    bpy.types.Scene.hoverbike_water_wave_freq = FloatProperty(
        name="Wave freq",
        description=(
            "Per-wave frequency multiplier for the viewport wave preview. 0.5 → wavelengths "
            "doubled (slow rolling swell), 1 → DEFAULT_WAVES as authored, 2 → wavelengths "
            "halved (jittery chop). Preview-only — NOT exported."
        ),
        default=1.0,
        min=0.0,
        max=3.0,
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
