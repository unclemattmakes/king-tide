"""Hoverbike — in-Blender "Export to Game" addon.

Single-file addon. Install once via:

    Edit → Preferences → Add-ons → Install…
    pick: tools/blender/hoverbike_addon.py
    enable the checkbox next to "Hoverbike: Export to Game"

The 3D viewport sidebar (press N) shows a "Hoverbike" tab whose UI
adapts to which kind of asset you're editing — detected from the
``.blend``'s parent directory:

  ``tracks-src/<id>.blend`` → track mode
  ``bikes-src/<id>.blend``  → bike mode

In track mode the button is **Export Track to Game**: validates the
scene, writes the GLB into ``public/assets/tracks/``, and on first
export materialises a starter ``public/tracks/<id>.json`` from the
.blend's checkpoints / spline / pickups / start. Subsequent exports
preserve the JSON so in-app editor saves aren't blown away;
Shift-click rewrites it.

In bike mode the button is **Export Bike to Game**: validates the
scene, writes the GLB into ``public/assets/bikes/``, and on first
export materialises a starter ``specs/bikes/<id>.json`` derived from
``bike_root``'s extras + the bike's authored materials. Subsequent
exports preserve the spec; Shift-click rewrites it.

Both modes share repo-root discovery (walk up to the first dir
containing ``package.json`` + ``public/``) and asset-id derivation
(.blend basename, overridable via the scene custom property
``hoverbike_track_id`` or ``hoverbike_bike_id``).

The addon does NOT require a running Vite dev server — it writes
files straight into the cloned repo.
"""

from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from typing import Any

import bpy
import mathutils
from bpy.props import BoolProperty, FloatProperty, IntProperty
from bpy.types import Operator, Panel

bl_info = {
    "name": "Hoverbike: Export to Game",
    "author": "Hoverbike",
    "version": (2, 0, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > Hoverbike",
    "description": "One-click export of bikes and tracks from Blender to the running hoverbike game.",
    "category": "Import-Export",
}


# ── Repo discovery ──────────────────────────────────────────────────────────


def find_repo_root(start: str | None) -> str | None:
    """Walk up from ``start`` looking for a directory containing
    ``package.json`` + a ``public/`` folder. Returns the absolute
    path or None if the .blend isn't inside a hoverbike clone."""
    if not start:
        return None
    cur = os.path.dirname(os.path.abspath(start))
    seen: set[str] = set()
    while cur and cur not in seen:
        seen.add(cur)
        pkg = os.path.join(cur, "package.json")
        public = os.path.join(cur, "public")
        if os.path.isfile(pkg) and os.path.isdir(public):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return None


# ── Mode detection ──────────────────────────────────────────────────────────


def detect_mode(blend_path: str | None) -> str | None:
    """Returns ``'track'`` if the .blend lives in ``tracks-src/``,
    ``'bike'`` if it lives in ``bikes-src/``, or ``None`` otherwise.

    Mode dictates which validator + exporter the panel uses. We key
    off the parent directory rather than scene contents so an empty
    .blend in the right folder still surfaces the right UI.
    """
    if not blend_path:
        return None
    parent = os.path.basename(os.path.dirname(os.path.abspath(blend_path)))
    if parent == "tracks-src":
        return "track"
    if parent == "bikes-src":
        return "bike"
    return None


def derive_asset_id(scene_prop: str) -> str | None:
    """Pick the asset id from a scene custom property
    (``hoverbike_track_id`` / ``hoverbike_bike_id``), falling back to
    the .blend filename basename. None if no .blend is saved."""
    scene_id = bpy.context.scene.get(scene_prop)
    if isinstance(scene_id, str) and scene_id.strip():
        return scene_id.strip()
    blend = bpy.data.filepath
    if not blend:
        return None
    base = os.path.splitext(os.path.basename(blend))[0]
    return base or None


# ── Track validation (mirrors tools/export_track.py) ────────────────────────

NAME_PATTERNS = [
    (re.compile(r"^water_volume(_.*)?$"), "water"),
    (re.compile(r"^cp_(\d+)$"), "checkpoint"),
    (re.compile(r"^ai_spline_(.+)$"), "ai_spline"),
    (re.compile(r"^pickup(_.*)?$"), "pickup_spawn"),
    (re.compile(r"^start_(\d+)$"), "start"),
]


def expected_kind(name: str) -> str | None:
    for pat, kind in NAME_PATTERNS:
        if pat.match(name):
            return kind
    return None


def is_object_visible(obj: bpy.types.Object) -> bool:
    """True iff the object is currently visible in the active view
    layer. Combines the eye icon (``hide_get()``), the monitor icon
    (``hide_viewport``), and ancestor-collection visibility.

    Hidden objects are skipped by validation, baking, JSON
    derivation, and the GLB export — letting authors stage WIP or
    decorative geometry in the .blend without it leaking into the
    game build."""
    try:
        return bool(obj.visible_get())
    except RuntimeError:
        return False


def bake_ai_splines() -> None:
    """Sample every visible ``ai_spline_*`` curve into a flat
    ``[x0,y0,z0,...]`` custom property on the same object. Hidden
    curves are skipped."""
    for obj in list(bpy.data.objects):
        if not obj.name.startswith("ai_spline_") or obj.type != "CURVE":
            continue
        if not is_object_visible(obj):
            continue
        mesh = obj.to_mesh()
        try:
            mw = obj.matrix_world
            verts = [mw @ v.co for v in mesh.vertices]
        finally:
            obj.to_mesh_clear()
        flat: list[float] = []
        for v in verts:
            flat.extend([float(v.x), float(v.y), float(v.z)])
        obj["points"] = flat


def validate_track_scene() -> list[str]:
    errors: list[str] = []
    by_kind: dict[str, list[bpy.types.Object]] = defaultdict(list)

    for obj in bpy.data.objects:
        kind = expected_kind(obj.name)
        if kind is None:
            continue
        if not is_object_visible(obj):
            continue
        if "kind" not in obj.keys():
            errors.append(f"{obj.name}: missing custom property 'kind'")
            continue
        if obj["kind"] != kind:
            errors.append(
                f"{obj.name}: kind='{obj['kind']}' does not match name pattern (expected '{kind}')"
            )
        by_kind[kind].append(obj)

    cps = sorted(by_kind.get("checkpoint", []), key=lambda o: o.name)
    for i, cp in enumerate(cps):
        if cp.get("index") != i:
            errors.append(f"{cp.name}: index={cp.get('index')} does not match position {i}")

    splines = by_kind.get("ai_spline", [])
    main = next((o for o in splines if o.name == "ai_spline_main"), None)
    if main is None:
        errors.append("missing required object: ai_spline_main")
    else:
        pts = main.get("points")
        if pts is None or len(pts) < 6:
            errors.append(
                f"ai_spline_main: needs at least 2 points (got {len(pts) if pts else 0} floats)"
            )

    for cp in by_kind.get("checkpoint", []):
        for prop in ("half_width", "height"):
            if cp.get(prop) is None:
                errors.append(f"{cp.name}: missing custom property '{prop}'")

    return errors


# ── Bike validation ─────────────────────────────────────────────────────────

REQUIRED_BIKE_SLOTS = (
    "seat",
    "nose_cam",
    "fx_thruster_l",
    "fx_thruster_r",
    "fx_exhaust",
)


def validate_bike_scene() -> list[str]:
    """Required-shape check: exactly one ``bike_root``, every required
    socket present, at least one collider. Mirrors the headless
    ``build_bike.py`` validators_factory so addon-exported GLBs and
    ``pnpm gen:bikes`` outputs validate identically.
    """
    errors: list[str] = []
    by_kind: dict[str, list[bpy.types.Object]] = defaultdict(list)
    sockets_by_slot: dict[str, list[bpy.types.Object]] = defaultdict(list)

    for obj in bpy.data.objects:
        if not is_object_visible(obj):
            continue
        kind = obj.get("kind")
        if isinstance(kind, str):
            by_kind[kind].append(obj)
            if kind == "socket":
                slot = obj.get("slot")
                if isinstance(slot, str):
                    sockets_by_slot[slot].append(obj)

    bike_count = len(by_kind.get("bike", []))
    if bike_count != 1:
        errors.append(
            f"expected exactly 1 bike_root (kind=bike); found {bike_count}. "
            f"Add a top-level empty named 'bike_root' with custom property kind='bike'."
        )

    if len(by_kind.get("collider", [])) < 1:
        errors.append(
            "missing collider (kind='collider'). Add an empty named 'collider_body' "
            "with extras kind='collider', shape='box', half_extents=[w/2, h/2, l/2]."
        )

    for slot in REQUIRED_BIKE_SLOTS:
        n = len(sockets_by_slot.get(slot, []))
        if n == 0:
            errors.append(
                f"missing socket: slot='{slot}'. Add an empty named 'socket_{slot}' "
                f"with extras kind='socket', slot='{slot}'."
            )
        elif n > 1:
            errors.append(f"duplicate socket: slot='{slot}' (count={n})")

    bike_root = next(iter(by_kind.get("bike", [])), None)
    if bike_root is not None:
        bike_id_prop = bike_root.get("bike_id")
        if not isinstance(bike_id_prop, str) or not bike_id_prop.strip():
            errors.append(
                "bike_root: missing or empty extras.bike_id (set custom property 'bike_id')."
            )

    return errors


# ── Track JSON derivation (mirrors build_track.py::emit_gameplay_json) ──────


def _b2t(x: float, y: float, z: float) -> dict[str, float]:
    """Blender (X right, Y forward, Z up) → three.js (X right, Y up, Z forward)."""
    return {"x": float(x), "y": float(z), "z": -float(y)}


def _yaw_from_z_euler(obj: bpy.types.Object) -> float:
    return float(obj.rotation_euler.z)


def derive_track_json(track_id: str, glb_url: str) -> dict[str, Any]:
    by_kind: dict[str, list[bpy.types.Object]] = defaultdict(list)
    for obj in bpy.data.objects:
        if not is_object_visible(obj):
            continue
        kind = expected_kind(obj.name)
        if kind:
            by_kind[kind].append(obj)

    cps = sorted(by_kind.get("checkpoint", []), key=lambda o: o.name)
    checkpoints: list[dict[str, Any]] = []
    for i, cp in enumerate(cps):
        loc = cp.matrix_world.translation
        checkpoints.append(
            {
                "index": i,
                "position": _b2t(loc.x, loc.y, loc.z),
                "rotation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
                "halfWidth": float(cp.get("half_width", 6.0)),
                "height": float(cp.get("height", 4.0)),
            }
        )

    starts = sorted(by_kind.get("start", []), key=lambda o: o.name)
    if starts:
        s0 = starts[0]
        s_loc = s0.matrix_world.translation
        start_pos = _b2t(s_loc.x, s_loc.y, s_loc.z)
        start_yaw = _yaw_from_z_euler(s0)
    else:
        start_pos = {"x": 0.0, "y": 0.5, "z": 0.0}
        start_yaw = 0.0

    anchors: list[dict[str, float]] = []
    main = next(
        (o for o in by_kind.get("ai_spline", []) if o.name == "ai_spline_main"), None
    )
    if main is not None and main.type == "CURVE":
        mesh = main.to_mesh()
        try:
            mw = main.matrix_world
            dense = [mw @ v.co for v in mesh.vertices]
        finally:
            main.to_mesh_clear()
        if len(dense) >= 2:
            target = min(12, len(dense))
            step = max(1, len(dense) // target)
            sampled = [dense[i] for i in range(0, len(dense), step)][:target]
            anchors = [_b2t(p.x, p.y, p.z) for p in sampled]

    pickups: list[dict[str, float]] = []
    for p in by_kind.get("pickup_spawn", []):
        loc = p.matrix_world.translation
        pickups.append(_b2t(loc.x, loc.y, loc.z))

    water = next(iter(by_kind.get("water", [])), None)
    water_block: dict[str, float] = {
        "height": 0.0,
        "waveHeight": (
            float(water.get("wave_height", 1.0)) if water is not None else 1.0
        ),
        "waveFreq": (
            float(water.get("wave_freq", 0.5)) if water is not None else 0.5
        ),
    }

    body: dict[str, Any] = {
        "id": track_id,
        "name": track_id,
        "lapsToFinish": 3,
        "environmentGlb": glb_url,
        "water": water_block,
        "start": {"position": start_pos, "yaw": start_yaw},
        "checkpoints": checkpoints,
        "aiSplines": [{"id": "main", "points": [], "anchors": anchors}],
        "pickupSpawns": pickups,
        "boostPads": [],
    }
    return body


# ── Bike spec derivation ────────────────────────────────────────────────────


def _read_principled_basecolor_hex(mat: bpy.types.Material) -> str | None:
    """Pull a #rrggbb base-colour string out of a Principled BSDF.
    Inverts the linear-space → sRGB approximation used by the
    seeder/builder (``c**(1/2.2)``) so the round-trip lands close to
    the original hex authored in the spec."""
    if not mat.use_nodes or mat.node_tree is None:
        return None
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None or "Base Color" not in bsdf.inputs:
        return None
    rgba = bsdf.inputs["Base Color"].default_value
    r, g, b = rgba[0], rgba[1], rgba[2]
    inv = 1.0 / 2.2
    r8 = max(0, min(255, int(round(pow(max(0.0, r), inv) * 255))))
    g8 = max(0, min(255, int(round(pow(max(0.0, g), inv) * 255))))
    b8 = max(0, min(255, int(round(pow(max(0.0, b), inv) * 255))))
    return f"#{r8:02x}{g8:02x}{b8:02x}"


def _read_emission_strength(mat: bpy.types.Material) -> float | None:
    if not mat.use_nodes or mat.node_tree is None:
        return None
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None or "Emission Strength" not in bsdf.inputs:
        return None
    return float(bsdf.inputs["Emission Strength"].default_value)


def derive_bike_spec(bike_id: str) -> dict[str, Any]:
    """Build a runtime spec from ``bike_root`` extras + the materials
    in the scene. Only the fields the manifest + viewer surface get
    emitted; the geometry block is intentionally omitted (the .blend
    is the source of truth for geometry in the new pipeline)."""
    bike_root = bpy.data.objects.get("bike_root")
    extras = bike_root.items() if bike_root is not None else []
    extras_dict = {k: v for k, v in extras}

    display_name = extras_dict.get("display_name") or bike_id.title()

    livery_mat = bpy.data.materials.get(f"mat_bike_{bike_id}_livery")
    metal_mat = bpy.data.materials.get(f"mat_bike_{bike_id}_chassis")
    glow_mat = bpy.data.materials.get(f"mat_bike_{bike_id}_glow")

    appearance: dict[str, Any] = {}
    if livery_mat is not None:
        hex_ = _read_principled_basecolor_hex(livery_mat)
        if hex_:
            appearance["liveryColor"] = hex_
    if metal_mat is not None:
        hex_ = _read_principled_basecolor_hex(metal_mat)
        if hex_:
            appearance["metalColor"] = hex_
    if glow_mat is not None:
        hex_ = _read_principled_basecolor_hex(glow_mat)
        if hex_:
            appearance["glowColor"] = hex_
        gi = _read_emission_strength(glow_mat)
        if gi is not None:
            appearance["glowIntensity"] = gi

    physics: dict[str, Any] = {}
    if "mass_kg" in extras_dict:
        physics["massKg"] = float(extras_dict["mass_kg"])
    if "top_speed_mps" in extras_dict:
        physics["topSpeedMps"] = float(extras_dict["top_speed_mps"])
    if "hover_height" in extras_dict:
        physics["hoverHeight"] = float(extras_dict["hover_height"])

    spec: dict[str, Any] = {
        "$schema": "../_schema/bike.json",
        "id": bike_id,
        "displayName": str(display_name),
    }
    if physics:
        spec["physics"] = physics
    if appearance:
        spec["appearance"] = appearance
    return spec


# ── Track operator (existing) ───────────────────────────────────────────────


# ── Preview-collection bookkeeping ──────────────────────────────────────────
#
# All "*_preview" collections built by the addon (gate gizmos, water plane,
# racer silhouettes, turn indicators) share the ``_hoverbike_*_preview``
# prefix so the export operator can scrub them in one pass. The GLB export
# is configured with ``use_visible=True, use_renderable=False`` — viewport-
# hidden objects are excluded but per-object ``hide_render`` is not. Without
# this scrubbing the wave-displaced water plane (and any other visible
# preview) would ride into the .glb and stomp the runtime water layer.

PREVIEW_COLLECTION_PREFIX = "_hoverbike_"
PREVIEW_COLLECTION_SUFFIX = "_preview"


def _iter_preview_layer_collections(view_layer):
    """Yield every LayerCollection under ``view_layer`` whose name marks
    it as an addon-built preview."""

    def walk(lc):
        name = lc.collection.name
        if name.startswith(PREVIEW_COLLECTION_PREFIX) and name.endswith(
            PREVIEW_COLLECTION_SUFFIX
        ):
            yield lc
        for child in lc.children:
            yield from walk(child)

    yield from walk(view_layer.layer_collection)


class _PreviewCollectionsHidden:
    """Context manager that excludes every preview LayerCollection in the
    active view layer for the duration of the ``with`` block, then
    restores each one's prior ``exclude`` state on exit."""

    def __init__(self, view_layer):
        self._view_layer = view_layer
        self._prior: list[tuple[Any, bool]] = []

    def __enter__(self):
        for lc in _iter_preview_layer_collections(self._view_layer):
            self._prior.append((lc, lc.exclude))
            lc.exclude = True
        return self

    def __exit__(self, exc_type, exc, tb):
        for lc, prior in self._prior:
            lc.exclude = prior
        self._prior.clear()
        return False


# ── Gate placement (Item 2 from docs/blender-wishlist.md) ────────────────
#
# Mirror of `src/game/tracks/gate-placement.ts`. The TypeScript runtime
# uses Y-up arc length (xz); Blender's authoring world is Z-up so we
# measure in xy. Both sides round to the integer gate count that best
# matches the requested spacing — this keeps closed-loop spacing exact
# and avoids a ragged remainder at the loop join.

DEFAULT_GATE_SPACING_M = 60.0
GATE_PREVIEW_COLLECTION = "_hoverbike_gate_preview"
GATE_PREVIEW_MESH = "_hoverbike_gate_gizmo"


def _resample_by_arc_length(points, spacing, vertical_axis=2):
    if len(points) < 2 or not (spacing > 0):
        return []
    import math
    horiz = [i for i in range(3) if i != vertical_axis]
    n = len(points)
    cum = [0.0] * (n + 1)
    for i in range(n):
        a, b = points[i], points[(i + 1) % n]
        cum[i + 1] = cum[i] + math.hypot(
            b[horiz[0]] - a[horiz[0]], b[horiz[1]] - a[horiz[1]]
        )
    total = cum[n]
    if total == 0:
        return []
    gate_count = max(1, round(total / spacing))
    out = []
    seg = 0
    for i in range(gate_count):
        target = (i / gate_count) * total
        while seg < n - 1 and cum[seg + 1] < target:
            seg += 1
        seg_len = cum[seg + 1] - cum[seg]
        frac = (target - cum[seg]) / seg_len if seg_len > 0 else 0.0
        t = (seg + frac) / n
        f = (((t % 1) + 1) % 1) * n
        i0 = int(f) % n
        i1 = (i0 + 1) % n
        ff = f - int(f)
        a, b = points[i0], points[i1]
        pos = (
            a[0] + (b[0] - a[0]) * ff,
            a[1] + (b[1] - a[1]) * ff,
            a[2] + (b[2] - a[2]) * ff,
        )
        d0 = b[horiz[0]] - a[horiz[0]]
        d1 = b[horiz[1]] - a[horiz[1]]
        L = math.hypot(d0, d1) or 1.0
        tan = [0.0, 0.0, 0.0]
        tan[horiz[0]] = d0 / L
        tan[horiz[1]] = d1 / L
        out.append({"t": t, "position": pos, "tangent": tuple(tan)})
    return out


def _sample_curve_to_polyline(curve_obj):
    """World-space polyline samples of a curve object, using its
    `resolution_u` setting. Mirrors what `tools/export_track.py` does
    when baking AI splines."""
    mesh = curve_obj.to_mesh()
    try:
        mw = curve_obj.matrix_world
        return [tuple(mw @ v.co) for v in mesh.vertices]
    finally:
        curve_obj.to_mesh_clear()


def _gate_gizmo_mesh(half_width: float, height: float, arrow_len: float = 4.0):
    """Build (or rebuild) the shared gate-gizmo mesh — a rectangle in the
    local XY plane plus a short tick along local +Z showing the tangent
    direction the racer crosses through."""
    if GATE_PREVIEW_MESH in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[GATE_PREVIEW_MESH])
    me = bpy.data.meshes.new(GATE_PREVIEW_MESH)
    verts = [
        (-half_width, 0, 0),
        ( half_width, 0, 0),
        ( half_width, height, 0),
        (-half_width, height, 0),
        (0, 0, 0),
        (0, 0, arrow_len),
    ]
    edges = [(0, 1), (1, 2), (2, 3), (3, 0), (4, 5)]
    me.from_pydata(verts, edges, [])
    me.update()
    return me


def _gate_rotation(tangent_xy):
    """Quaternion that maps local +Z to the tangent direction (horizontal),
    local +Y to world up. Gate frame ends up vertical, perpendicular to
    the racing line."""
    z_axis = mathutils.Vector((tangent_xy[0], tangent_xy[1], 0)).normalized()
    y_axis = mathutils.Vector((0, 0, 1))
    x_axis = y_axis.cross(z_axis).normalized()
    y_axis = z_axis.cross(x_axis)
    mat = mathutils.Matrix((
        (x_axis.x, y_axis.x, z_axis.x, 0),
        (x_axis.y, y_axis.y, z_axis.y, 0),
        (x_axis.z, y_axis.z, z_axis.z, 0),
        (0, 0, 0, 1),
    ))
    return mat.to_quaternion()


def _find_layer_collection(layer_coll, name):
    if layer_coll.collection.name == name:
        return layer_coll
    for c in layer_coll.children:
        hit = _find_layer_collection(c, name)
        if hit:
            return hit
    return None


def _set_gate_preview_visible(context, visible: bool) -> None:
    lc = _find_layer_collection(
        context.view_layer.layer_collection, GATE_PREVIEW_COLLECTION
    )
    if lc:
        lc.exclude = not visible


def _wipe_gate_preview() -> None:
    coll = bpy.data.collections.get(GATE_PREVIEW_COLLECTION)
    if coll:
        for obj in list(coll.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(coll)


def _rebuild_gate_preview(scene, *, spacing: float, half_width: float, height: float) -> int:
    """Rebuild the gate-preview collection in the scene. Returns the
    number of gates placed."""
    sp = bpy.data.objects.get("ai_spline_main")
    if sp is None or sp.type != "CURVE":
        raise RuntimeError(
            "Gate preview needs an `ai_spline_main` curve in the scene."
        )
    points = _sample_curve_to_polyline(sp)
    placements = _resample_by_arc_length(points, spacing, vertical_axis=2)

    _wipe_gate_preview()
    me = _gate_gizmo_mesh(half_width, height)
    coll = bpy.data.collections.new(GATE_PREVIEW_COLLECTION)
    scene.collection.children.link(coll)

    for i, p in enumerate(placements):
        obj = bpy.data.objects.new(f"gate_preview_{i:02d}", me)
        obj.location = p["position"]
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = _gate_rotation(p["tangent"])
        obj.hide_render = True
        obj.show_in_front = True
        coll.objects.link(obj)

    return len(placements)


# ── Racer-at-start preview (Item 7 from docs/blender-wishlist.md) ────────
#
# Shows a bike silhouette at start_00 (player) plus instances at each AI
# grid offset, sourced from `specs/grid-offsets.json` (the same file the
# runtime reads in `src/boot/spawn-bikes.ts`). Designed for visual sanity-
# checking grid spacing and first-frame views — gizmos live in a
# render-disabled collection that the GLB export skips.

RACER_PREVIEW_COLLECTION = "_hoverbike_racer_preview"
RACER_PREVIEW_MESH_PLAYER = "_hoverbike_racer_player"
RACER_PREVIEW_MESH_AI = "_hoverbike_racer_ai"


def _bike_silhouette_mesh(name: str, with_rider_hump: bool):
    """Wireframe bike silhouette in local coords. Length along local +Z
    (matches the project convention: +Z forward through the racing
    direction). Width along ±X. Height along +Y."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    # Bike body box: 2.5m long × 1m wide × 0.6m tall.
    half_w = 0.5
    half_h_lo = 0.0
    half_h_hi = 0.6
    z_tail = -1.25
    z_nose_base = 1.0
    z_nose_tip = 1.5
    verts = [
        (-half_w, half_h_lo, z_tail),       # 0 bottom tail-L
        ( half_w, half_h_lo, z_tail),       # 1 bottom tail-R
        ( half_w, half_h_lo, z_nose_base),  # 2 bottom nose-base-R
        (-half_w, half_h_lo, z_nose_base),  # 3 bottom nose-base-L
        (-half_w, half_h_hi, z_tail),       # 4 top tail-L
        ( half_w, half_h_hi, z_tail),       # 5 top tail-R
        ( half_w, half_h_hi, z_nose_base),  # 6 top nose-base-R
        (-half_w, half_h_hi, z_nose_base),  # 7 top nose-base-L
        ( 0,      half_h_lo, z_nose_tip),   # 8 nose tip (bottom)
        ( 0,      half_h_hi, z_nose_tip),   # 9 nose tip (top)
    ]
    edges = [
        # bottom rect
        (0, 1), (1, 2), (2, 3), (3, 0),
        # top rect
        (4, 5), (5, 6), (6, 7), (7, 4),
        # verticals
        (0, 4), (1, 5), (2, 6), (3, 7),
        # nose
        (2, 8), (3, 8), (6, 9), (7, 9), (8, 9),
    ]
    if with_rider_hump:
        # A small hump above the body to mark the player visually.
        hump_top = (0, half_h_hi + 0.55, 0)
        hump_back = (0, half_h_hi + 0.1, -0.5)
        hump_front = (0, half_h_hi + 0.1, 0.5)
        base_idx = len(verts)
        verts.extend([hump_top, hump_back, hump_front])
        edges.extend([
            (base_idx, base_idx + 1),
            (base_idx, base_idx + 2),
            (base_idx + 1, base_idx + 2),
        ])
    me.from_pydata(verts, edges, [])
    me.update()
    return me


def _load_grid_offsets(repo_root: str | None) -> list[dict]:
    """Read specs/grid-offsets.json from disk. Falls back to a hardcoded
    grid if the file is missing so the preview still works in scratch
    .blends opened outside a repo clone."""
    fallback = [
        {"dx": -6, "dz": -5,  "lineOffset": -6},
        {"dx": -2, "dz": -10, "lineOffset": -2},
        {"dx":  2, "dz": -10, "lineOffset":  2},
        {"dx":  6, "dz": -5,  "lineOffset":  6},
    ]
    if not repo_root:
        return fallback
    spec_path = os.path.join(repo_root, "specs", "grid-offsets.json")
    if not os.path.isfile(spec_path):
        return fallback
    try:
        with open(spec_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        slots = data.get("slots")
        if isinstance(slots, list) and slots:
            return slots
    except (OSError, ValueError):
        pass
    return fallback


def _wipe_racer_preview() -> None:
    coll = bpy.data.collections.get(RACER_PREVIEW_COLLECTION)
    if coll:
        for obj in list(coll.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(coll)


def _rebuild_racer_preview(scene) -> dict:
    """Build / refresh the racer-at-start preview collection. Returns a
    summary dict for the operator's status report."""
    start = bpy.data.objects.get("start_00")
    if start is None:
        raise RuntimeError(
            "Racer preview needs a `start_00` empty in the scene."
        )

    repo_root = find_repo_root(bpy.data.filepath) if bpy.data.filepath else None
    slots = _load_grid_offsets(repo_root)
    grid_source = "specs/grid-offsets.json" if (
        repo_root and os.path.isfile(os.path.join(repo_root, "specs", "grid-offsets.json"))
    ) else "fallback (hardcoded)"

    _wipe_racer_preview()
    me_player = _bike_silhouette_mesh(RACER_PREVIEW_MESH_PLAYER, with_rider_hump=True)
    me_ai = _bike_silhouette_mesh(RACER_PREVIEW_MESH_AI, with_rider_hump=False)
    coll = bpy.data.collections.new(RACER_PREVIEW_COLLECTION)
    scene.collection.children.link(coll)

    start_loc = start.matrix_world.translation
    # Inherit start_00's rotation so the bike points the way the player
    # will face on race-start. AI grid is laid out in world coords
    # relative to that origin (matches spawn-bikes.ts exactly — no yaw
    # rotation applied to slot offsets).
    start_rot = start.matrix_world.to_quaternion()

    player = bpy.data.objects.new("racer_preview_player", me_player)
    player.location = start_loc
    player.rotation_mode = "QUATERNION"
    player.rotation_quaternion = start_rot
    player.hide_render = True
    player.show_in_front = True
    coll.objects.link(player)

    ai_objs = []
    for i, slot in enumerate(slots):
        obj = bpy.data.objects.new(f"racer_preview_ai_{i:02d}", me_ai)
        obj.location = (
            start_loc.x + float(slot.get("dx", 0)),
            start_loc.y,
            start_loc.z + float(slot.get("dz", 0)),
        )
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = start_rot
        obj.hide_render = True
        obj.show_in_front = True
        coll.objects.link(obj)
        ai_objs.append(obj)

    # Reveal the collection (clear any stale view-layer exclusion).
    lc = _find_layer_collection(
        bpy.context.view_layer.layer_collection, RACER_PREVIEW_COLLECTION
    )
    if lc:
        lc.exclude = False

    return {
        "player_at": tuple(start_loc),
        "ai_count": len(ai_objs),
        "grid_source": grid_source,
    }


class HOVERBIKE_OT_rebuild_racer_preview(Operator):
    """Drop a bike silhouette at `start_00` and at each AI grid offset
    from `specs/grid-offsets.json`. Pure preview — the collection is
    render-disabled and never reaches the .glb export."""

    bl_idname = "hoverbike.rebuild_racer_preview"
    bl_label = "Rebuild Racer Preview"
    bl_description = (
        "Spawn placeholder bikes at the player start + AI grid positions"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        try:
            summary = _rebuild_racer_preview(context.scene)
        except RuntimeError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        self.report(
            {"INFO"},
            f"Placed 1 player + {summary['ai_count']} AI bikes ({summary['grid_source']})",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_hide_racer_preview(Operator):
    """Toggle the racer-preview collection's visibility off without
    deleting it. Re-run Rebuild to bring it back."""

    bl_idname = "hoverbike.hide_racer_preview"
    bl_label = "Hide Racer Preview"
    bl_description = "Hide racer previews without deleting them"
    bl_options = {"REGISTER"}

    def execute(self, context):
        lc = _find_layer_collection(
            context.view_layer.layer_collection, RACER_PREVIEW_COLLECTION
        )
        if lc:
            lc.exclude = True
        return {"FINISHED"}


# ── Water preview (Item 5 from docs/blender-wishlist.md) ──────────────────
#
# Builds a vertex-displaced water plane around `water_volume_main` so the
# shape of the in-game wave field is visible in Blender. The wave
# parameters mirror `defaultWaves()` in `src/engine/sim/water/wave-field.ts`
# — keep in sync if you change either side. Per-bike wakes are omitted
# (there's no moving bike at author time).

WATER_PREVIEW_COLLECTION = "_hoverbike_water_preview"
WATER_PREVIEW_MESH = "_hoverbike_water_surface"

# Mirror of defaultWaves() in src/engine/sim/water/wave-field.ts. Tuple
# layout: (dirX, dirZ, amplitude, wavelength, speed, phase). Update both
# sides together when tuning.
DEFAULT_WAVES = (
    # Swells
    (0.92, 0.39, 0.55, 60.0, 10.0, 0.4),
    (0.60, 0.80, 0.40, 85.0, 11.0, 2.2),
    # Chop
    (1.00, 0.00, 0.65, 22.0,  4.0, 0.0),
    (0.707, 0.707, 0.44, 14.0, 3.6, 1.1),
    (0.30, -0.954, 0.29, 9.0,  3.0, 2.3),
    (-0.50, 0.866, 0.16, 5.5,  2.4, 3.7),
)


def _sample_water_height(x: float, z: float, t: float) -> float:
    """Sum-of-sines vertical Gerstner — same formula as `sampleHeight`
    in wave-field.ts. Returns water surface y at (x, z, t)."""
    import math
    y = 0.0
    for (dx, dz, amp, wavelength, speed, phase) in DEFAULT_WAVES:
        k = (2.0 * math.pi) / wavelength
        omega = speed * k
        p = k * (dx * x + dz * z) - omega * t + phase
        y += amp * math.sin(p)
    return y


def _wipe_water_preview() -> None:
    coll = bpy.data.collections.get(WATER_PREVIEW_COLLECTION)
    if coll:
        for obj in list(coll.objects):
            if obj.data and obj.data.users == 1:
                # Release the mesh data too so reruns don't leak.
                pass
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(coll)
    if WATER_PREVIEW_MESH in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[WATER_PREVIEW_MESH])


def _build_water_plane_mesh(name: str, size: float, subdivisions: int, t: float):
    """Build a subdivided plane mesh and displace each vertex by the
    wave function evaluated at world (x, z, t). The plane sits at world
    y = 0; the operator translates it to the volume's y after assignment."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)

    n = max(2, int(subdivisions))
    step = size / n
    half = size / 2.0
    # Blender is Z-up: horizontal plane is XY, wave displacement is Z.
    # The runtime wave function expects (x, z) in its Y-up world; we feed
    # Blender's (x, y) into those slots so the wave shape reads the same
    # in viewport as it will in-game (modulo the Z-up→Y-up swap that the
    # glTF exporter handles at export time).
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
    # Smooth shading + auto-smooth so the surface reads as wavy water,
    # not faceted geometry.
    for poly in me.polygons:
        poly.use_smooth = True
    return me


def _rebuild_water_preview(scene, *, size: float, subdivisions: int, time: float) -> dict:
    """Create / replace the water-preview collection. Returns a summary
    for the operator's status report."""
    vol = bpy.data.objects.get("water_volume_main")
    # If no water volume is authored, the preview still works — it just
    # centers at world origin. Authors can move the resulting object
    # manually.
    center = (0.0, 0.0, 0.0)
    if vol is not None:
        loc = vol.matrix_world.translation
        center = (loc.x, loc.y, loc.z)

    _wipe_water_preview()
    me = _build_water_plane_mesh(WATER_PREVIEW_MESH, size=size, subdivisions=subdivisions, t=time)
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
        "face_count": subdivisions ** 2,
        "preview_at": center,
        "time_s": time,
    }


class HOVERBIKE_OT_rebuild_water_preview(Operator):
    """Build a vertex-displaced water plane around `water_volume_main`
    using the same Gerstner wave parameters the runtime's
    `defaultWaves()` uses. Pure preview — the plane lives in a
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
        summary = _rebuild_water_preview(
            scene, size=size, subdivisions=subdivisions, time=time
        )
        self.report(
            {"INFO"},
            f"Water preview: {summary['vert_count']} verts at t={summary['time_s']:.2f}s ({summary['centered_on']})",
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
        lc = _find_layer_collection(
            context.view_layer.layer_collection, WATER_PREVIEW_COLLECTION
        )
        if lc:
            lc.exclude = True
        return {"FINISHED"}


# ── Turn indicators (Item 3 — turn-indicator sub-piece) ───────────────────
#
# Samples the AI spline's polyline, finds peaks of signed curvature in
# the horizontal plane, and places chevron-shaped arrow gizmos at those
# points facing in the direction of the bend. The math is sim-safe and
# could mirror to TS later if we ever want auto-placed turn arrows in
# the runtime, but today this is preview-only.

TURN_PREVIEW_COLLECTION = "_hoverbike_turn_preview"
TURN_PREVIEW_MESH = "_hoverbike_turn_chevron"

# Default curvature threshold in radians-per-metre. ~0.05 ≈ 50m radius
# corner; tighter than that gets an indicator. Authors tune via the
# scene property.
DEFAULT_TURN_KAPPA = 0.02
DEFAULT_TURN_LOOKAHEAD = 20.0  # min metres between consecutive markers


def _turn_chevron_mesh(name: str, size: float = 2.5):
    """Chevron arrow that points along local +X. The local +Y axis runs
    along the curve's tangent; the operator rotates each instance so
    local +X aligns with the bend direction."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    s = size
    verts = [
        (0,        0,    0),       # 0 tail centre
        (s,        0,    0),       # 1 head tip
        (s * 0.6,  s * 0.4, 0),    # 2 wing top-front
        (s * 0.6, -s * 0.4, 0),    # 3 wing bottom-front
        (s * 0.3,  s * 0.4, 0),    # 4 wing top-back (parallels for chunk)
        (s * 0.3, -s * 0.4, 0),    # 5 wing bottom-back
    ]
    # Edges: shaft + chevron wings
    edges = [
        (0, 1),       # shaft tail→tip
        (1, 2), (1, 3),  # head wings outwards
        (4, 2), (5, 3),  # closing the chevron bracket
    ]
    me.from_pydata(verts, edges, [])
    me.update()
    return me


def _signed_curvature_peaks(
    points,
    *,
    kappa_threshold: float,
    min_spacing_m: float,
):
    """Walk the closed polyline and return a list of dicts with
    ``index`` (peak index), ``position`` (world Vector3 tuple),
    ``tangent`` (unit XY tuple), ``perp`` (unit XY tuple pointing in
    the bend direction; positive curvature → left turn in xy, perp
    points right of the tangent), ``kappa`` (signed rad/m).

    Curvature is approximated as the signed angle between adjacent
    polyline segments divided by the local segment length. Local
    maxima of |kappa| above ``kappa_threshold`` are kept, with adjacent
    candidates within ``min_spacing_m`` collapsed to the strongest.
    """
    import math
    n = len(points)
    if n < 3:
        return []

    kappas = []
    arc_pos = []
    cumulative = 0.0
    for i in range(n):
        p_prev = points[(i - 1) % n]
        p_cur = points[i]
        p_next = points[(i + 1) % n]
        # In Blender Z-up, racing-line lives in XY; ignore Z for curvature.
        ax = p_cur[0] - p_prev[0]; ay = p_cur[1] - p_prev[1]
        bx = p_next[0] - p_cur[0]; by = p_next[1] - p_cur[1]
        la = math.hypot(ax, ay) or 1e-6
        lb = math.hypot(bx, by) or 1e-6
        # Signed turn angle (atan2 of cross / dot in 2D).
        cross = ax * by - ay * bx
        dot = ax * bx + ay * by
        angle = math.atan2(cross, dot * la * lb / (la * lb))  # numerical helper
        # Simpler form: atan2(cross / (la*lb), dot / (la*lb)) is equivalent.
        angle = math.atan2(cross, dot)
        # Normalize cross/dot first so atan2 is on unit-vector terms.
        # Use small segment length for the divisor.
        seg = 0.5 * (la + lb)
        kappa = angle / seg if seg > 0 else 0.0
        kappas.append(kappa)
        cumulative += la
        arc_pos.append(cumulative - la)  # arc position at p_cur

    # Find local maxima of |kappa| above threshold.
    candidates = []
    for i in range(n):
        if abs(kappas[i]) < kappa_threshold:
            continue
        # Local max compared to immediate neighbours.
        prev_k = abs(kappas[(i - 1) % n])
        next_k = abs(kappas[(i + 1) % n])
        cur_k = abs(kappas[i])
        if cur_k < prev_k or cur_k < next_k:
            continue
        candidates.append((i, cur_k, kappas[i]))

    # Greedy collapse — sort by strength descending, keep peaks at least
    # min_spacing_m apart in arc length.
    candidates.sort(key=lambda c: -c[1])
    kept_indices = []
    for (idx, _, _) in candidates:
        too_close = False
        for kept_idx in kept_indices:
            d = abs(arc_pos[idx] - arc_pos[kept_idx])
            d = min(d, cumulative - d)  # closed-loop wrap
            if d < min_spacing_m:
                too_close = True
                break
        if not too_close:
            kept_indices.append(idx)

    kept_indices.sort()

    out = []
    import math
    for i in kept_indices:
        # Tangent at i: forward-difference unit.
        p_cur = points[i]
        p_next = points[(i + 1) % n]
        tx = p_next[0] - p_cur[0]
        ty = p_next[1] - p_cur[1]
        tl = math.hypot(tx, ty) or 1.0
        tx /= tl; ty /= tl
        # Perp = +90° rotation (CCW) of tangent in xy. Sign flipped by κ's sign.
        sign = 1.0 if kappas[i] > 0 else -1.0
        perp_x = -ty * sign
        perp_y = tx * sign
        out.append({
            "index": i,
            "position": (p_cur[0], p_cur[1], p_cur[2]),
            "tangent": (tx, ty, 0.0),
            "perp": (perp_x, perp_y, 0.0),
            "kappa": kappas[i],
        })
    return out


def _chevron_rotation(perp_xy):
    """Quaternion that maps local +X to the perp direction (bend
    direction) and local +Z to world +Z (up). Chevron lies flat on the
    horizontal plane."""
    x_axis = mathutils.Vector((perp_xy[0], perp_xy[1], 0)).normalized()
    z_axis = mathutils.Vector((0, 0, 1))
    y_axis = z_axis.cross(x_axis).normalized()
    mat = mathutils.Matrix((
        (x_axis.x, y_axis.x, z_axis.x, 0),
        (x_axis.y, y_axis.y, z_axis.y, 0),
        (x_axis.z, y_axis.z, z_axis.z, 0),
        (0, 0, 0, 1),
    ))
    return mat.to_quaternion()


def _rebuild_turn_indicators(scene, *, kappa_threshold: float, min_spacing_m: float) -> dict:
    sp = bpy.data.objects.get("ai_spline_main")
    if sp is None or sp.type != "CURVE":
        raise RuntimeError("Turn indicators need `ai_spline_main` curve in the scene.")
    points = _sample_curve_to_polyline(sp)
    peaks = _signed_curvature_peaks(
        points,
        kappa_threshold=kappa_threshold,
        min_spacing_m=min_spacing_m,
    )

    # Wipe prior
    old = bpy.data.collections.get(TURN_PREVIEW_COLLECTION)
    if old:
        for o in list(old.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.collections.remove(old)

    me = _turn_chevron_mesh(TURN_PREVIEW_MESH)
    coll = bpy.data.collections.new(TURN_PREVIEW_COLLECTION)
    scene.collection.children.link(coll)

    for i, p in enumerate(peaks):
        obj = bpy.data.objects.new(f"turn_indicator_{i:02d}", me)
        # Position a little above the spline so the arrow is readable.
        obj.location = (p["position"][0], p["position"][1], p["position"][2] + 0.5)
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = _chevron_rotation(p["perp"])
        obj.hide_render = True
        obj.show_in_front = True
        coll.objects.link(obj)

    lc = _find_layer_collection(
        bpy.context.view_layer.layer_collection, TURN_PREVIEW_COLLECTION
    )
    if lc:
        lc.exclude = False

    return {
        "peak_count": len(peaks),
        "max_abs_kappa": max((abs(p["kappa"]) for p in peaks), default=0.0),
    }


class HOVERBIKE_OT_rebuild_turn_indicators(Operator):
    """Find peaks of signed curvature along `ai_spline_main` and drop
    chevron arrows pointing in the bend direction. Pure preview —
    collection is render-disabled and never exports."""

    bl_idname = "hoverbike.rebuild_turn_indicators"
    bl_label = "Rebuild Turn Indicators"
    bl_description = "Place chevron arrows at high-curvature points along ai_spline_main"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        summary = _rebuild_turn_indicators(
            scene,
            kappa_threshold=float(scene.hoverbike_turn_kappa),
            min_spacing_m=float(scene.hoverbike_turn_min_spacing),
        )
        self.report({"INFO"}, f"Placed {summary['peak_count']} turn indicators (max |κ|={summary['max_abs_kappa']:.3f})")
        return {"FINISHED"}


class HOVERBIKE_OT_hide_turn_indicators(Operator):
    """Hide the turn-indicator collection without deleting it."""

    bl_idname = "hoverbike.hide_turn_indicators"
    bl_label = "Hide Turn Indicators"
    bl_description = "Hide turn indicators without deleting them"
    bl_options = {"REGISTER"}

    def execute(self, context):
        lc = _find_layer_collection(
            context.view_layer.layer_collection, TURN_PREVIEW_COLLECTION
        )
        if lc:
            lc.exclude = True
        return {"FINISHED"}


class HOVERBIKE_OT_rebuild_gate_preview(Operator):
    """Sample `ai_spline_main`, resample by arc length at the scene's
    `hoverbike_gate_spacing` (metres), and rebuild a preview collection of
    rectangle-outline gate gizmos along the racing line. The preview lives
    in `_hoverbike_gate_preview`, which is render-disabled and never reaches
    the .glb export."""

    bl_idname = "hoverbike.rebuild_gate_preview"
    bl_label = "Rebuild Gate Preview"
    bl_description = "Place gate gizmos every gateSpacing metres along ai_spline_main"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        spacing = float(scene.hoverbike_gate_spacing)
        half_width = float(scene.hoverbike_gate_half_width)
        height = float(scene.hoverbike_gate_height)
        try:
            n = _rebuild_gate_preview(
                scene,
                spacing=spacing,
                half_width=half_width,
                height=height,
            )
        except RuntimeError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        _set_gate_preview_visible(context, True)
        self.report({"INFO"}, f"Placed {n} gate previews at {spacing:.1f}m spacing")
        return {"FINISHED"}


class HOVERBIKE_OT_hide_gate_preview(Operator):
    """Toggle the gate-preview collection's view-layer visibility off without
    deleting it. Re-run Rebuild to bring it back."""

    bl_idname = "hoverbike.hide_gate_preview"
    bl_label = "Hide Gate Preview"
    bl_description = "Hide gate previews without deleting them"
    bl_options = {"REGISTER"}

    def execute(self, context):
        _set_gate_preview_visible(context, False)
        return {"FINISHED"}


class HOVERBIKE_OT_export_track(Operator):
    """Validate the track scene, write
    ``public/assets/tracks/<id>.glb``, and on first export materialise
    a starter ``public/tracks/<id>.json`` from the .blend's metadata
    objects. Subsequent exports preserve the JSON (the in-app editor
    owns it). Hold Shift to overwrite the JSON."""

    bl_idname = "hoverbike.export_track"
    bl_label = "Export Track to Game"
    bl_description = (
        "Validate scene, export track GLB, and (on first export) write a starter JSON. "
        "Hold Shift to force-rewrite the JSON from the .blend."
    )
    bl_options = {"REGISTER"}

    force_json: BoolProperty(  # type: ignore[valid-type]
        name="Overwrite JSON",
        description=(
            "Rewrite public/tracks/<id>.json from the .blend, even if a tuned "
            "version exists. Off by default so the in-app editor's saves are "
            "never blown away by a re-export of the .blend."
        ),
        default=False,
    )

    def invoke(self, context: bpy.types.Context, event: bpy.types.Event) -> set[str]:
        if event.shift:
            self.force_json = True
        return self.execute(context)

    def execute(self, context: bpy.types.Context) -> set[str]:
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

        os.makedirs(os.path.dirname(glb_path), exist_ok=True)
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

        json_existed = os.path.exists(json_path)
        wrote_json = False
        if not json_existed or self.force_json:
            os.makedirs(os.path.dirname(json_path), exist_ok=True)
            body = derive_track_json(track_id, f"/assets/tracks/{track_id}.glb")
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(body, f, indent=2)
                f.write("\n")
            wrote_json = True

        rel_glb = os.path.relpath(glb_path, repo).replace("\\", "/")
        rel_json = os.path.relpath(json_path, repo).replace("\\", "/")
        if wrote_json:
            tag = "rewrote" if json_existed else "created"
            msg = f"Exported → {rel_glb} ({tag} {rel_json})"
        else:
            msg = f"Exported → {rel_glb} (kept {rel_json})"
        self.report({"INFO"}, msg)
        print(f"[hoverbike-addon] {msg}")
        return {"FINISHED"}


# ── Bike operator (new) ─────────────────────────────────────────────────────


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


# ── URL helpers ─────────────────────────────────────────────────────────────


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
        bike_id = derive_asset_id("hoverbike_bike_id")
        if not bike_id:
            self.report({"ERROR"}, "Save your .blend first to derive a bike id.")
            return {"CANCELLED"}
        param = "viewer" if self.viewer else "bike"
        url = f"http://localhost:5191/?{param}={bike_id}"
        context.window_manager.clipboard = url
        self.report({"INFO"}, f"Copied to clipboard: {url}")
        return {"FINISHED"}


# ── Sidebar panel ──────────────────────────────────────────────────────────


class HOVERBIKE_PT_panel(Panel):
    bl_label = "Hoverbike"
    bl_idname = "HOVERBIKE_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Hoverbike"

    def draw(self, context: bpy.types.Context) -> None:
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
        track_id = derive_asset_id("hoverbike_track_id") or "<unknown>"

        box = layout.box()
        box.label(text=f"Track: {track_id}", icon="WORLD_DATA")
        if repo:
            box.label(text=f"Repo: {os.path.basename(repo)}", icon="FILE_FOLDER")
        else:
            box.label(text="Repo not found", icon="ERROR")
            box.label(text="Save .blend inside a hoverbike/ clone.")

        row = layout.row()
        row.scale_y = 1.6
        row.operator("hoverbike.export_track", icon="EXPORT")

        col = layout.column(align=True)
        op_play = col.operator(
            "hoverbike.copy_track_url", text="Copy Play URL", icon="URL"
        )
        op_play.edit = False
        op_edit = col.operator(
            "hoverbike.copy_track_url", text="Copy Edit URL", icon="GREASEPENCIL"
        )
        op_edit.edit = True

        layout.separator()
        gp_box = layout.box()
        gp_box.label(text="Gate preview", icon="MOD_ARRAY")
        gp_box.prop(context.scene, "hoverbike_gate_spacing", text="Spacing (m)")
        row = gp_box.row(align=True)
        row.prop(context.scene, "hoverbike_gate_half_width", text="Half-width")
        row.prop(context.scene, "hoverbike_gate_height", text="Height")
        row = gp_box.row(align=True)
        row.operator("hoverbike.rebuild_gate_preview", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_gate_preview", icon="HIDE_ON")

        rp_box = layout.box()
        rp_box.label(text="Racer preview", icon="AUTO")
        row = rp_box.row(align=True)
        row.operator("hoverbike.rebuild_racer_preview", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_racer_preview", icon="HIDE_ON")

        wp_box = layout.box()
        wp_box.label(text="Water preview", icon="MOD_OCEAN")
        wp_box.prop(context.scene, "hoverbike_water_size", text="Size (m)")
        row = wp_box.row(align=True)
        row.prop(context.scene, "hoverbike_water_subdivisions", text="Subdiv")
        row.prop(context.scene, "hoverbike_water_time", text="Time (s)")
        row = wp_box.row(align=True)
        row.operator("hoverbike.rebuild_water_preview", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_water_preview", icon="HIDE_ON")

        ti_box = layout.box()
        ti_box.label(text="Turn indicators", icon="TRACKING_FORWARDS")
        row = ti_box.row(align=True)
        row.prop(context.scene, "hoverbike_turn_kappa", text="|κ| min (1/m)")
        row.prop(context.scene, "hoverbike_turn_min_spacing", text="Spacing (m)")
        row = ti_box.row(align=True)
        row.operator("hoverbike.rebuild_turn_indicators", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_turn_indicators", icon="HIDE_ON")

        layout.separator()
        col = layout.column(align=True)
        col.scale_y = 0.85
        col.label(text="Shift-click Export:", icon="INFO")
        col.label(text="overwrite the JSON")
        col.label(text="from the .blend.")

    def _draw_bike(self, context, layout, blend: str, repo: str | None) -> None:
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


# ── Registration ───────────────────────────────────────────────────────────

_classes = (
    HOVERBIKE_OT_rebuild_gate_preview,
    HOVERBIKE_OT_hide_gate_preview,
    HOVERBIKE_OT_rebuild_racer_preview,
    HOVERBIKE_OT_hide_racer_preview,
    HOVERBIKE_OT_rebuild_water_preview,
    HOVERBIKE_OT_hide_water_preview,
    HOVERBIKE_OT_rebuild_turn_indicators,
    HOVERBIKE_OT_hide_turn_indicators,
    HOVERBIKE_OT_export_track,
    HOVERBIKE_OT_export_bike,
    HOVERBIKE_OT_copy_track_url,
    HOVERBIKE_OT_copy_bike_url,
    HOVERBIKE_PT_panel,
)


def register() -> None:
    for cls in _classes:
        bpy.utils.register_class(cls)
    bpy.types.Scene.hoverbike_gate_spacing = FloatProperty(
        name="Gate spacing (m)",
        description="Target spacing between gates along ai_spline_main. "
        "The actual count is rounded to fit the closed loop cleanly.",
        default=DEFAULT_GATE_SPACING_M,
        min=1.0,
        max=1000.0,
        precision=1,
    )
    bpy.types.Scene.hoverbike_gate_half_width = FloatProperty(
        name="Gate half-width (m)",
        default=14.0,
        min=1.0,
        max=200.0,
        precision=1,
    )
    bpy.types.Scene.hoverbike_gate_height = FloatProperty(
        name="Gate height (m)",
        default=6.0,
        min=1.0,
        max=100.0,
        precision=1,
    )
    bpy.types.Scene.hoverbike_water_size = FloatProperty(
        name="Water plane size (m)",
        description="Edge length of the displaced water plane",
        default=300.0,
        min=10.0,
        max=2000.0,
        precision=1,
    )
    bpy.types.Scene.hoverbike_water_subdivisions = IntProperty(
        name="Water subdivisions",
        description="Per-edge subdivisions of the water plane. Higher = smoother waves, slower rebuild.",
        default=80,
        min=8,
        max=400,
    )
    bpy.types.Scene.hoverbike_water_time = FloatProperty(
        name="Wave time (s)",
        description="Simulation time the wave field is sampled at — 0 for canonical pose, scrub for variety.",
        default=0.0,
        min=-60.0,
        max=60.0,
        precision=2,
    )
    bpy.types.Scene.hoverbike_turn_kappa = FloatProperty(
        name="Turn |κ| min (1/m)",
        description="Curvature threshold for a turn indicator. ~0.05 ≈ 20m-radius corner; lower = more indicators.",
        default=DEFAULT_TURN_KAPPA,
        min=0.001,
        max=2.0,
        precision=4,
    )
    bpy.types.Scene.hoverbike_turn_min_spacing = FloatProperty(
        name="Turn min spacing (m)",
        description="Minimum arc distance between consecutive turn indicators; collapses adjacent peaks.",
        default=DEFAULT_TURN_LOOKAHEAD,
        min=1.0,
        max=200.0,
        precision=1,
    )


def unregister() -> None:
    for cls in reversed(_classes):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
    for prop in ("hoverbike_gate_spacing", "hoverbike_gate_half_width", "hoverbike_gate_height", "hoverbike_water_size", "hoverbike_water_subdivisions", "hoverbike_water_time", "hoverbike_turn_kappa", "hoverbike_turn_min_spacing"):
        if hasattr(bpy.types.Scene, prop):
            try:
                delattr(bpy.types.Scene, prop)
            except Exception:
                pass


if __name__ == "__main__":
    register()
