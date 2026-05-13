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
import math
import os
import re
from collections import defaultdict
from typing import Any

import bpy
import mathutils
from bpy.app.handlers import persistent
from bpy.props import BoolProperty, FloatProperty, IntProperty, StringProperty
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

    # Runtime terrain-shader knobs (Item 3). Live on the scene; the
    # runtime applies them as uniforms when it builds the terrain
    # material. Omitted entirely when no scene props are set so older
    # tracks keep their stock shader defaults.
    scn = bpy.context.scene
    shader_block: dict[str, Any] | None = None
    if hasattr(scn, "hoverbike_shader_slope_start"):
        shader_block = {
            "altMin": float(scn.hoverbike_shader_alt_min),
            "altMax": float(scn.hoverbike_shader_alt_max),
            "slopeStart": float(scn.hoverbike_shader_slope_start),
            "slopeEnd": float(scn.hoverbike_shader_slope_end),
            "variation": float(scn.hoverbike_shader_variation),
            "wetBand": float(scn.hoverbike_shader_wet_band),
            "pathTint": [
                float(scn.hoverbike_shader_path_tint_r),
                float(scn.hoverbike_shader_path_tint_g),
                float(scn.hoverbike_shader_path_tint_b),
            ],
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
    # gateSpacing round-trips through the JSON so the in-app editor's
    # "Auto-place gates from spline" and Blender's gate preview see the
    # same number. The runtime falls back to DEFAULT_GATE_SPACING_M
    # when the field is absent.
    if hasattr(scn, "hoverbike_gate_spacing"):
        body["gateSpacing"] = float(scn.hoverbike_gate_spacing)
    if shader_block is not None:
        body["terrainShader"] = shader_block
    return body


# ── JSON ↔ Blender sync ────────────────────────────────────────────────────
#
# `derive_track_json` above goes Blender → JSON. The mirror direction
# (JSON → Blender) lives here: pull scalar / parametric fields from
# `public/tracks/<id>.json` into the scene's custom properties so the
# .blend reflects whatever the in-app editor most recently saved.
#
# Scope is intentionally narrow — we only sync data that has an obvious
# Blender home (scene properties or named-object customs). We do NOT
# rebuild the AI spline from JSON anchors (the Blender NURBS is richer
# than the sampled polyline), and we do NOT recreate cp_NN / pickup_*
# empties (the hybrid pipeline retired them; the in-app editor owns
# gate / pickup positions in the JSON).

# Fields that are Blender-canonical at export time. Whatever the .blend
# holds for these wins; existing JSON values are overwritten. Everything
# *outside* this set (checkpoints, pickupSpawns, boostPads, props, sky,
# lapsToFinish) is editor-canonical — we merge into the existing JSON
# rather than clobber. See `_merge_export_json` for the exact merge.
BLENDER_OWNED_JSON_KEYS = (
    "id",
    "name",
    "environmentGlb",
    "water",
    "terrainShader",
    "aiSplines",
    "gateSpacing",
    "start",
)


def _three_to_blender(pos: dict) -> tuple[float, float, float]:
    """three.js (Y up, +Z forward) → Blender (Z up, +Y forward)."""
    return (float(pos.get("x", 0.0)), -float(pos.get("z", 0.0)), float(pos.get("y", 0.0)))


def reload_track_from_json(json_path: str) -> dict:
    """Pull scalar / parametric track data from `json_path` into the
    current Blender scene. Returns a summary dict of what was synced.

    Behaviour:
      - `gateSpacing` → `scene.hoverbike_gate_spacing` (triggers the
        live gate-preview rebuild via the existing update callback).
      - `terrainShader.*` → `scene.hoverbike_shader_*`.
      - `water.{waveHeight, waveFreq}` → `water_volume_main` custom
        props (the runtime reads these from extras at GLB-load time).
      - `start.{position, yaw}` → `start_00` transform.

    Silently skips fields that aren't present in the JSON or whose
    Blender targets are absent."""
    if not os.path.isfile(json_path):
        raise RuntimeError(f"track JSON not found: {json_path}")
    with open(json_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    scene = bpy.context.scene
    if scene is None:
        return {}

    summary: dict[str, Any] = {"json": os.path.basename(json_path)}

    gs = data.get("gateSpacing")
    if isinstance(gs, (int, float)) and gs > 0 and hasattr(scene, "hoverbike_gate_spacing"):
        scene.hoverbike_gate_spacing = float(gs)
        summary["gateSpacing"] = float(gs)

    ts = data.get("terrainShader")
    if isinstance(ts, dict):
        for key, prop in (
            ("altMin", "hoverbike_shader_alt_min"),
            ("altMax", "hoverbike_shader_alt_max"),
            ("slopeStart", "hoverbike_shader_slope_start"),
            ("slopeEnd", "hoverbike_shader_slope_end"),
            ("variation", "hoverbike_shader_variation"),
            ("wetBand", "hoverbike_shader_wet_band"),
        ):
            v = ts.get(key)
            if isinstance(v, (int, float)) and hasattr(scene, prop):
                setattr(scene, prop, float(v))
        tint = ts.get("pathTint")
        if (
            isinstance(tint, list)
            and len(tint) == 3
            and all(isinstance(c, (int, float)) for c in tint)
            and hasattr(scene, "hoverbike_shader_path_tint_r")
        ):
            scene.hoverbike_shader_path_tint_r = float(tint[0])
            scene.hoverbike_shader_path_tint_g = float(tint[1])
            scene.hoverbike_shader_path_tint_b = float(tint[2])
        summary["terrainShader"] = True

    water = data.get("water")
    vol = bpy.data.objects.get("water_volume_main")
    if isinstance(water, dict) and vol is not None:
        wh = water.get("waveHeight")
        if isinstance(wh, (int, float)):
            vol["wave_height"] = float(wh)
        wf = water.get("waveFreq")
        if isinstance(wf, (int, float)):
            vol["wave_freq"] = float(wf)
        summary["water"] = True

    start = data.get("start")
    s0 = bpy.data.objects.get("start_00")
    if isinstance(start, dict) and s0 is not None:
        pos = start.get("position")
        if isinstance(pos, dict):
            s0.location = _three_to_blender(pos)
        yaw = start.get("yaw")
        if isinstance(yaw, (int, float)):
            s0.rotation_euler = (0.0, 0.0, float(yaw))
        summary["start"] = True

    return summary


def _merge_export_json(derived: dict, existing: dict | None) -> dict:
    """Build the final track JSON for export. Blender wins on
    parametric / geometry-shaped fields; the editor wins on hand-tuned
    placement (checkpoints, pickups, boost pads, props, sky) unless the
    .blend explicitly authors those via cp_NN / pickup_NN empties (the
    legacy pipeline).

    `existing` is the JSON that's already on disk, if any."""
    if not existing:
        return dict(derived)
    merged = dict(existing)
    for key in BLENDER_OWNED_JSON_KEYS:
        if key in derived:
            merged[key] = derived[key]
        elif key in merged and key not in derived:
            # If derive_track_json deliberately omits a key (e.g. no
            # terrainShader scene props) we keep whatever the JSON had.
            pass
    # Hybrid-pipeline guard: if the .blend authors checkpoints /
    # pickups locally (the legacy `cp_NN` / `pickup_*` empties), let
    # them overwrite the JSON. Otherwise preserve the editor's saves.
    has_cp_empties = any(
        o.name.startswith("cp_") and is_object_visible(o) for o in bpy.data.objects
    )
    has_pickup_empties = any(
        o.name.startswith("pickup") and is_object_visible(o) for o in bpy.data.objects
    )
    if has_cp_empties and "checkpoints" in derived:
        merged["checkpoints"] = derived["checkpoints"]
    if has_pickup_empties and "pickupSpawns" in derived:
        merged["pickupSpawns"] = derived["pickupSpawns"]
    # `lapsToFinish` defaults to 3 in `derive_track_json`; keep an
    # existing JSON value if the editor set something else.
    if "lapsToFinish" not in merged and "lapsToFinish" in derived:
        merged["lapsToFinish"] = derived["lapsToFinish"]
    return merged


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


PROP_GATE_MESH_NAME = "prop_gate_mesh"
# Author dims of prop_gate_mesh in tracks-src/props-library.blend: posts at
# ±14m along X, crossbar at z=6m. The mesh sits in Blender Z-up so we
# fix-up rotate by Rx(-90°) before placing so author +Z (height) maps to
# the gate gizmo's local +Y (world up) and author +Y (post thickness)
# maps to local +Z (along the racing-line tangent). Same orientation the
# wireframe `_gate_gizmo_mesh` uses, so the wireframe fallback below
# reads identical to the real prop.
PROP_GATE_AUTHOR_HALF_WIDTH = 14.0
PROP_GATE_AUTHOR_HEIGHT = 6.0


def _ensure_prop_gate_mesh_linked(repo_root: str | None) -> bpy.types.Mesh | None:
    """Link `prop_gate_mesh` from `tracks-src/props-library.blend` so the
    gate-preview gizmos can render as the real prop instead of the
    wireframe placeholder. Idempotent — returns the existing local /
    linked datablock if it's already present.

    Returns None if the library file is missing — callers fall back to
    `_gate_gizmo_mesh`. Linking (rather than appending) keeps a single
    source of truth: re-running `tools/blender/seed_props_library.py`
    re-flows every track .blend that's been opened since."""
    me = bpy.data.meshes.get(PROP_GATE_MESH_NAME)
    if me is not None:
        return me
    if not repo_root:
        return None
    library_path = os.path.join(repo_root, "tracks-src", "props-library.blend")
    if not os.path.isfile(library_path):
        return None
    try:
        with bpy.data.libraries.load(library_path, link=True) as (data_from, data_to):
            if PROP_GATE_MESH_NAME in data_from.meshes:
                data_to.meshes = [PROP_GATE_MESH_NAME]
    except Exception:  # noqa: BLE001 — library load can throw a wide range
        return None
    return bpy.data.meshes.get(PROP_GATE_MESH_NAME)


def _rebuild_gate_preview(scene, *, spacing: float, half_width: float, height: float) -> int:
    """Rebuild the gate-preview collection in the scene. Returns the
    number of gates placed."""
    import math
    sp = bpy.data.objects.get("ai_spline_main")
    if sp is None or sp.type != "CURVE":
        raise RuntimeError(
            "Gate preview needs an `ai_spline_main` curve in the scene."
        )
    points = _sample_curve_to_polyline(sp)
    placements = _resample_by_arc_length(points, spacing, vertical_axis=2)

    _wipe_gate_preview()
    coll = bpy.data.collections.new(GATE_PREVIEW_COLLECTION)
    scene.collection.children.link(coll)

    # Prefer the real prop_gate mesh if the props library is available;
    # otherwise fall back to the wireframe gizmo so the preview still
    # works in fresh .blends that don't yet see the library.
    repo = find_repo_root(bpy.data.filepath) if bpy.data.filepath else None
    prop_me = _ensure_prop_gate_mesh_linked(repo)
    using_prop = prop_me is not None
    if using_prop:
        me = prop_me
        # Rx(-π/2): author +Z (height) → local +Y (up), author +Y → local +Z.
        fix_up = mathutils.Quaternion((1.0, 0.0, 0.0), -math.pi / 2.0)
        scale = (
            half_width / PROP_GATE_AUTHOR_HALF_WIDTH,
            1.0,
            height / PROP_GATE_AUTHOR_HEIGHT,
        )
    else:
        me = _gate_gizmo_mesh(half_width, height)
        fix_up = None
        scale = (1.0, 1.0, 1.0)

    for i, p in enumerate(placements):
        obj = bpy.data.objects.new(f"gate_preview_{i:02d}", me)
        obj.location = p["position"]
        obj.rotation_mode = "QUATERNION"
        if fix_up is not None:
            obj.rotation_quaternion = _gate_rotation(p["tangent"]) @ fix_up
        else:
            obj.rotation_quaternion = _gate_rotation(p["tangent"])
        obj.scale = scale
        obj.hide_render = True
        # Real prop reads in the regular shaded view; the wireframe gizmo
        # needs X-ray to stay visible against terrain.
        obj.show_in_front = not using_prop
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
    """Wireframe bike silhouette in Blender-native local coords: length
    along local +Y (Blender forward), width along ±X, height along +Z.
    A `start_NN` empty in Blender carries a pure rotation around world
    Z (yaw), so inheriting that rotation rotates the bike correctly in
    the horizontal plane while it remains upright.

    Earlier versions of this mesh used the runtime (Y-up, +Z forward)
    convention, which caused the preview to appear vertical — Blender's
    +Z is up, so a length axis along +Z made the bike stand on its tail.
    """
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    # Bike body box: 2.5m long × 1m wide × 0.6m tall.
    half_w = 0.5
    z_lo = 0.0          # ground-skimming hover deck
    z_hi = 0.6
    y_tail = -1.25
    y_nose_base = 1.0
    y_nose_tip = 1.5
    verts = [
        (-half_w, y_tail,      z_lo),  # 0 bottom tail-L
        ( half_w, y_tail,      z_lo),  # 1 bottom tail-R
        ( half_w, y_nose_base, z_lo),  # 2 bottom nose-base-R
        (-half_w, y_nose_base, z_lo),  # 3 bottom nose-base-L
        (-half_w, y_tail,      z_hi),  # 4 top tail-L
        ( half_w, y_tail,      z_hi),  # 5 top tail-R
        ( half_w, y_nose_base, z_hi),  # 6 top nose-base-R
        (-half_w, y_nose_base, z_hi),  # 7 top nose-base-L
        ( 0,      y_nose_tip,  z_lo),  # 8 nose tip (bottom)
        ( 0,      y_nose_tip,  z_hi),  # 9 nose tip (top)
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
        hump_top = (0, 0,    z_hi + 0.55)
        hump_back = (0, -0.5, z_hi + 0.1)
        hump_front = (0, 0.5,  z_hi + 0.1)
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
    # `slot.dx` and `slot.dz` come from specs/grid-offsets.json in the
    # runtime frame (three Y-up, +Z forward). Map to Blender (Z-up,
    # +Y forward): three +X → Blender +X, three +Z → Blender −Y, three
    # +Y → Blender +Z. The grid is purely horizontal so we leave the
    # vertical Z alone — earlier versions added dz to Blender Z, stacking
    # the AI bikes above/below the player instead of behind them.
    for i, slot in enumerate(slots):
        obj = bpy.data.objects.new(f"racer_preview_ai_{i:02d}", me_ai)
        obj.location = (
            start_loc.x + float(slot.get("dx", 0)),
            start_loc.y - float(slot.get("dz", 0)),
            start_loc.z,
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


# ── Ghost lap overlay + chase cam ──────────────────────────────────────────
#
# Animate a bike silhouette along `ai_spline_main` at a constant target
# speed and attach a chase camera so the author can hit Spacebar and see
# the lap as the player will. The ghost lives in `_hoverbike_ghost_lap`
# (a preview collection that the export scrubs out), uses a Follow Path
# constraint so the curve's actual NURBS shape drives the motion, and
# parents the camera to the ghost with a back-and-up offset.
#
# Why Follow Path over per-frame keyframes: the spline is already the
# source of truth — Follow Path automatically interpolates between
# control points and reuses Blender's existing path-animation evaluator.
# Frame keyframes would diverge if the spline were re-edited mid-lap.

GHOST_LAP_COLLECTION = "_hoverbike_ghost_lap_preview"
GHOST_BIKE_NAME = "ghost_bike"
GHOST_CAMERA_NAME = "ghost_chase_cam"
GHOST_DEFAULT_SPEED_MS = 25.0  # constant target speed for the lap


def _ghost_bike_mesh(name: str) -> bpy.types.Mesh:
    """Wireframe bike for the ghost — same geometry as the racer
    preview but slightly larger so it reads at viewport scale during
    the fly-around."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    half_w = 0.7
    z_lo = 0.0
    z_hi = 0.8
    y_tail = -1.5
    y_nose_base = 1.2
    y_nose_tip = 1.8
    verts = [
        (-half_w, y_tail,      z_lo), ( half_w, y_tail,      z_lo),
        ( half_w, y_nose_base, z_lo), (-half_w, y_nose_base, z_lo),
        (-half_w, y_tail,      z_hi), ( half_w, y_tail,      z_hi),
        ( half_w, y_nose_base, z_hi), (-half_w, y_nose_base, z_hi),
        ( 0,      y_nose_tip,  z_lo), ( 0,      y_nose_tip,  z_hi),
        (0, 0,    z_hi + 0.65),   # rider hump top
        (0, -0.6, z_hi + 0.15),
        (0,  0.6, z_hi + 0.15),
    ]
    edges = [
        (0, 1), (1, 2), (2, 3), (3, 0),
        (4, 5), (5, 6), (6, 7), (7, 4),
        (0, 4), (1, 5), (2, 6), (3, 7),
        (2, 8), (3, 8), (6, 9), (7, 9), (8, 9),
        (10, 11), (10, 12), (11, 12),
    ]
    me.from_pydata(verts, edges, [])
    me.update()
    return me


def _wipe_ghost_lap() -> None:
    coll = bpy.data.collections.get(GHOST_LAP_COLLECTION)
    if coll:
        for obj in list(coll.objects):
            # Drop the camera datablock too so the file doesn't accumulate
            # stale orphan cameras after repeated rebuilds.
            data = obj.data
            bpy.data.objects.remove(obj, do_unlink=True)
            if isinstance(data, (bpy.types.Camera, bpy.types.Mesh)) and data.users == 0:
                if isinstance(data, bpy.types.Camera):
                    bpy.data.cameras.remove(data)
                else:
                    bpy.data.meshes.remove(data)
        bpy.data.collections.remove(coll)


def _rebuild_ghost_lap(scene, *, target_speed_ms: float, fps: int) -> dict:
    """Build (or rebuild) the ghost-lap collection: one bike silhouette
    bound to `ai_spline_main` via Follow Path, plus a chase camera
    parented behind it. Sets the scene frame range to one full lap at
    constant speed.

    Returns a summary for the operator report."""
    sp = bpy.data.objects.get("ai_spline_main")
    if sp is None or sp.type != "CURVE":
        raise RuntimeError("Ghost lap needs an `ai_spline_main` curve in the scene.")
    if not (target_speed_ms > 0):
        raise RuntimeError("Target speed must be positive (m/s).")

    arc = _spline_arc_length(sp)
    if arc <= 0:
        raise RuntimeError("`ai_spline_main` has zero arc length — can't animate.")

    lap_seconds = arc / target_speed_ms
    fps_safe = max(1, int(fps))
    lap_frames = max(2, int(round(lap_seconds * fps_safe)))

    _wipe_ghost_lap()
    coll = bpy.data.collections.new(GHOST_LAP_COLLECTION)
    scene.collection.children.link(coll)

    # Configure the curve for animation. `use_path` enables the eval-
    # time animation; we keyframe `eval_time` from 0 to `path_duration`
    # over the scene frame range so the ghost sweeps the whole loop.
    sp.data.use_path = True
    sp.data.path_duration = lap_frames
    # `use_path_follow` makes Follow Path rotate the bike to match the
    # curve tangent — without it the bike would slide sideways.
    sp.data.use_radius = False

    # Ghost bike — empty mesh + Follow Path constraint.
    bike_mesh = _ghost_bike_mesh(GHOST_BIKE_NAME + "_mesh")
    bike = bpy.data.objects.new(GHOST_BIKE_NAME, bike_mesh)
    bike.hide_render = True
    coll.objects.link(bike)
    follow = bike.constraints.new(type="FOLLOW_PATH")
    follow.target = sp
    # Blender's Follow Path forward / up convention: forward is the
    # constraint's `forward_axis`. Our bike silhouette's length runs
    # along +Y, so set forward = +Y, up = +Z.
    follow.forward_axis = "FORWARD_Y"
    follow.up_axis = "UP_Z"
    follow.use_curve_follow = True

    # Animate the curve's eval_time: 0 at frame 1 → path_duration at
    # frame 1 + lap_frames. Linear interpolation = constant speed.
    # Blender 4.4+ replaced the legacy `Action.fcurves.new(...)` API
    # with the slot-aware `fcurve_ensure_for_datablock(...)` helper;
    # we go through it so the action's layer + slot + channelbag are
    # all created correctly.
    sp.data.animation_data_clear()
    sp.data.animation_data_create()
    action = bpy.data.actions.new(name="hoverbike_ghost_lap")
    sp.data.animation_data.action = action
    fcu = action.fcurve_ensure_for_datablock(sp.data, "eval_time")
    # Clear any prior keys (re-runs reuse the same fcurve via slot).
    while len(fcu.keyframe_points) > 0:
        fcu.keyframe_points.remove(fcu.keyframe_points[0])
    kp0 = fcu.keyframe_points.insert(frame=1.0, value=0.0)
    kp0.interpolation = "LINEAR"
    kp1 = fcu.keyframe_points.insert(frame=1.0 + lap_frames, value=float(lap_frames))
    kp1.interpolation = "LINEAR"

    # Chase camera — parented to the ghost so it inherits the spline
    # follow. Offset: 8m back along bike's -Y (tail), 3m up Z. A Track-To
    # constraint keeps it pointed at the bike no matter how the spline
    # twists, with the world-Z "up" guard so the horizon doesn't roll
    # through banked corners.
    cam_data = bpy.data.cameras.new(GHOST_CAMERA_NAME)
    cam_data.lens = 28.0
    cam_data.clip_start = 0.5
    cam_data.clip_end = 2000.0
    cam = bpy.data.objects.new(GHOST_CAMERA_NAME, cam_data)
    cam.parent = bike
    cam.location = (0.0, -8.0, 3.0)
    coll.objects.link(cam)
    track = cam.constraints.new(type="TRACK_TO")
    track.target = bike
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"

    # Snap the scene's playback range to the ghost lap so Spacebar
    # plays exactly one lap, looping at the end.
    scene.frame_start = 1
    scene.frame_end = 1 + lap_frames
    scene.frame_set(1)
    scene.render.fps = fps_safe

    # Make the chase cam the active scene camera so View → Cameras →
    # Active Camera frames the lap immediately.
    scene.camera = cam

    # Reveal the ghost-lap collection (clear stale exclusion).
    lc = _find_layer_collection(
        bpy.context.view_layer.layer_collection, GHOST_LAP_COLLECTION
    )
    if lc:
        lc.exclude = False

    return {
        "arc_m": arc,
        "lap_seconds": lap_seconds,
        "lap_frames": lap_frames,
        "fps": fps_safe,
        "speed_ms": target_speed_ms,
    }


class HOVERBIKE_OT_rebuild_ghost_lap(Operator):
    """Animate a bike silhouette along `ai_spline_main` at the configured
    target speed and attach a chase camera. Hit Spacebar in the viewport
    afterwards to play one lap; the chase camera is automatically set
    as the scene's active camera."""

    bl_idname = "hoverbike.rebuild_ghost_lap"
    bl_label = "Rebuild Ghost Lap"
    bl_description = (
        "Set up a ghost-bike + chase cam that fly the AI spline at a "
        "constant target speed"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        try:
            summary = _rebuild_ghost_lap(
                scene,
                target_speed_ms=float(scene.hoverbike_ghost_speed),
                fps=int(scene.hoverbike_ghost_fps),
            )
        except RuntimeError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        self.report(
            {"INFO"},
            f"Ghost lap: {summary['arc_m']:.0f}m @ {summary['speed_ms']:.0f}m/s = "
            f"{summary['lap_seconds']:.1f}s ({summary['lap_frames']} frames @ {summary['fps']} fps)",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_hide_ghost_lap(Operator):
    """Hide the ghost-lap collection without deleting it. Re-run Rebuild
    to bring it back, or *Wipe* to fully tear it down (the underlying
    animation lingers on `ai_spline_main` either way)."""

    bl_idname = "hoverbike.hide_ghost_lap"
    bl_label = "Hide Ghost Lap"
    bl_description = "Hide the ghost-lap preview without deleting it"
    bl_options = {"REGISTER"}

    def execute(self, context):
        lc = _find_layer_collection(
            context.view_layer.layer_collection, GHOST_LAP_COLLECTION
        )
        if lc:
            lc.exclude = True
        return {"FINISHED"}


# ── Heightmap import ───────────────────────────────────────────────────────
#
# Read a greyscale PNG/EXR and emit a subdivided plane mesh whose
# vertices are displaced by the image's luminance. Useful for
# prototyping real-world coastlines or hand-painted terrain without
# building a Geometry Nodes graph from scratch.

HEIGHTMAP_TERRAIN_NAME = "terrain_heightmap"
HEIGHTMAP_MATERIAL_NAME = "mat_terrain_heightmap"


def _import_heightmap(
    image_path: str,
    *,
    map_size_m: float,
    height_scale_m: float,
    base_elevation_m: float,
    subdivisions: int,
) -> dict:
    """Load `image_path` as a Blender Image and build a subdivided plane
    whose verts are displaced by the image's luminance. Returns a summary
    dict for the operator report.

    Sampling is point-bilinear: each vertex looks up four nearest pixels
    and blends. Image alpha / colour channels are reduced to luminance
    (R * 0.299 + G * 0.587 + B * 0.114). Out-of-bounds reads clamp to
    the edge, so the plane's border matches the image border."""
    import math
    if not os.path.isfile(image_path):
        raise RuntimeError(f"Heightmap file not found: {image_path}")
    img = bpy.data.images.load(image_path, check_existing=False)
    try:
        img.colorspace_settings.name = "Non-Color"
        width = img.size[0]
        height = img.size[1]
        if width < 2 or height < 2:
            raise RuntimeError(
                f"Heightmap is {width}×{height}px — needs ≥ 2 px each side."
            )
        channels = img.channels
        # img.pixels is a flat float array (R, G, B, A, R, G, B, A, ...).
        # Pull it into a Python list once — Blender's Image.pixels access
        # is *very* slow when subscripted per-element.
        pixels = list(img.pixels[:])

        def sample(u: float, v: float) -> float:
            x = max(0.0, min(width - 1.0001, u * (width - 1)))
            y = max(0.0, min(height - 1.0001, v * (height - 1)))
            x0 = int(x)
            y0 = int(y)
            tx = x - x0
            ty = y - y0
            x1 = min(x0 + 1, width - 1)
            y1 = min(y0 + 1, height - 1)

            def lum(px: int, py: int) -> float:
                idx = (py * width + px) * channels
                r = pixels[idx]
                g = pixels[idx + 1] if channels >= 2 else r
                b = pixels[idx + 2] if channels >= 3 else r
                return 0.299 * r + 0.587 * g + 0.114 * b

            l00 = lum(x0, y0)
            l10 = lum(x1, y0)
            l01 = lum(x0, y1)
            l11 = lum(x1, y1)
            top = l00 * (1.0 - tx) + l10 * tx
            bot = l01 * (1.0 - tx) + l11 * tx
            return top * (1.0 - ty) + bot * ty

        # Wipe any prior heightmap-imported terrain (idempotent
        # re-import).
        old = bpy.data.objects.get(HEIGHTMAP_TERRAIN_NAME)
        if old is not None:
            old_data = old.data
            bpy.data.objects.remove(old, do_unlink=True)
            if isinstance(old_data, bpy.types.Mesh) and old_data.users == 0:
                bpy.data.meshes.remove(old_data)

        n = max(2, int(subdivisions))
        step = map_size_m / n
        half = map_size_m / 2.0
        me = bpy.data.meshes.new(f"{HEIGHTMAP_TERRAIN_NAME}_mesh")
        verts: list[tuple[float, float, float]] = []
        for j in range(n + 1):
            for i in range(n + 1):
                u = i / n
                v = j / n
                x = -half + i * step
                y = -half + j * step
                z = base_elevation_m + sample(u, v) * height_scale_m
                verts.append((x, y, z))
        faces: list[tuple[int, int, int, int]] = []
        for j in range(n):
            for i in range(n):
                a = j * (n + 1) + i
                b = a + 1
                c = a + (n + 1)
                d = c + 1
                faces.append((a, b, d, c))
        me.from_pydata(verts, [], faces)
        me.update()
        for poly in me.polygons:
            poly.use_smooth = True
        # Tag the mesh as a terrain track surface so the export picks it
        # up with kind="track" (collidable). Authors can override the
        # material name; the gltf exporter doesn't care.
        obj = bpy.data.objects.new(HEIGHTMAP_TERRAIN_NAME, me)
        obj["kind"] = "track"
        bpy.context.scene.collection.objects.link(obj)

        # Bare placeholder material so the mesh shows up shaded; authors
        # tune via the terrain-shader scene props on export.
        if HEIGHTMAP_MATERIAL_NAME not in bpy.data.materials:
            mat = bpy.data.materials.new(HEIGHTMAP_MATERIAL_NAME)
            mat.use_nodes = True
        me.materials.append(bpy.data.materials[HEIGHTMAP_MATERIAL_NAME])

        return {
            "image": os.path.basename(image_path),
            "image_px": (width, height),
            "vert_count": len(verts),
            "face_count": len(faces),
            "extent_m": map_size_m,
            "height_m": height_scale_m,
        }
    finally:
        # Keep the image loaded so re-imports are cheap. Image datablocks
        # are tiny compared to terrain meshes.
        pass


class HOVERBIKE_OT_import_heightmap(Operator):
    """Read a greyscale PNG/EXR and emit a subdivided plane whose verts
    are luminance-displaced. Replaces any prior `terrain_heightmap`
    object. The mesh ships out as `kind=track` so it's collidable at
    runtime."""

    bl_idname = "hoverbike.import_heightmap"
    bl_label = "Import Heightmap"
    bl_description = "Build a displaced-plane terrain from a greyscale PNG/EXR"
    bl_options = {"REGISTER", "UNDO"}

    filepath: StringProperty(  # type: ignore[valid-type]
        name="Heightmap",
        description="Path to a greyscale PNG/EXR. Luminance drives Z displacement.",
        subtype="FILE_PATH",
    )

    def invoke(self, context, event):
        # Pre-fill from the scene's last-used path so re-imports don't
        # need to navigate from scratch each time.
        last = getattr(context.scene, "hoverbike_heightmap_path", "") or ""
        if last:
            self.filepath = last
        context.window_manager.fileselect_add(self)
        return {"RUNNING_MODAL"}

    def execute(self, context):
        scene = context.scene
        if not self.filepath:
            self.report({"ERROR"}, "Pick a heightmap file first.")
            return {"CANCELLED"}
        try:
            summary = _import_heightmap(
                self.filepath,
                map_size_m=float(scene.hoverbike_heightmap_size),
                height_scale_m=float(scene.hoverbike_heightmap_height),
                base_elevation_m=float(scene.hoverbike_heightmap_base),
                subdivisions=int(scene.hoverbike_heightmap_subdivisions),
            )
        except RuntimeError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        scene.hoverbike_heightmap_path = self.filepath
        self.report(
            {"INFO"},
            f"Imported {summary['image']} ({summary['image_px'][0]}×{summary['image_px'][1]}px) → "
            f"{summary['vert_count']} verts, {summary['extent_m']:.0f}×{summary['extent_m']:.0f}m, "
            f"Δz={summary['height_m']:.1f}m",
        )
        return {"FINISHED"}


# ── Snap spline to terrain ─────────────────────────────────────────────────
#
# Raycasts each ai_spline_main control point straight down and lifts it
# by a configurable hover height. Drops the "edit terrain, then walk the
# spline by hand to re-fit it" loop. Skips preview collections during the
# cast so the gizmos themselves don't catch the ray.


def _spline_iter_points(curve_obj: bpy.types.Object):
    """Yield (spline, point, world_coord_setter) for every NURBS / poly /
    bezier control point on a curve. The setter takes a world-space
    Vector and writes the matrix-inverse local position back into the
    point — so callers can move points without juggling matrix math."""
    mw = curve_obj.matrix_world
    mw_inv = mw.inverted_safe()
    for spline in curve_obj.data.splines:
        if spline.type == "BEZIER":
            for bp in spline.bezier_points:
                def make_setter(point=bp):
                    def setter(world_co):
                        # Shift the handles along with the control point
                        # so the curve's local shape is preserved.
                        old_local = point.co.copy()
                        new_local = mw_inv @ world_co
                        delta = new_local - old_local
                        point.co = new_local
                        point.handle_left = point.handle_left + delta
                        point.handle_right = point.handle_right + delta
                    return setter
                world_co = mw @ bp.co
                yield spline, bp, world_co, make_setter()
        else:
            # NURBS / POLY: spline.points carries 4D coords (x, y, z, w).
            for sp_pt in spline.points:
                def make_setter(point=sp_pt):
                    def setter(world_co):
                        local = mw_inv @ world_co
                        point.co = (local.x, local.y, local.z, point.co[3])
                    return setter
                local_co = mathutils.Vector(
                    (sp_pt.co[0], sp_pt.co[1], sp_pt.co[2])
                )
                world_co = mw @ local_co
                yield spline, sp_pt, world_co, make_setter()


# ── Road tool ──────────────────────────────────────────────────────────────
#
# The road tool turns a Bezier curve (`road_curve_main`) into two things
# at once:
#   1. A drivable road strip mesh tagged ``kind=track`` that sits a hair
#      above the terrain along the curve. Material `mat_track_road` is
#      a saturated asphalt grey so the road reads against the natural
#      ground colours.
#   2. A deformation pass that pushes terrain vertices within
#      ``half_width + blend_radius`` of the road toward the road's local
#      altitude profile, with a smoothstep falloff so the outer band
#      eases off rather than producing a hard step.
#
# Caveat: this works on the *source* terrain mesh, not on a procedural
# modifier output. If the terrain has an active Geometry Nodes modifier
# (the `HV_Island` graph on the template), the modifier will overwrite
# the deformation on next evaluation. Apply the modifier first
# (Object → Apply → Visual Geometry to Mesh) before building a road on
# a procedural island.

ROAD_CURVE_NAME = "road_curve_main"
ROAD_OBJECT_NAME = "road_main"
ROAD_MESH_NAME = "road_main_mesh"
ROAD_MATERIAL_NAME = "mat_track_road"


def _ensure_road_material() -> bpy.types.Material:
    mat = bpy.data.materials.get(ROAD_MATERIAL_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(ROAD_MATERIAL_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.10, 0.10, 0.11, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.85
        spec = bsdf.inputs.get("Specular IOR Level") or bsdf.inputs.get("Specular")
        if spec is not None:
            spec.default_value = 0.2
    return mat


def _ramp_material() -> bpy.types.Material:
    name = "mat_track_ramp"
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        # Saturated orange — same family as turn-indicator chevrons so
        # the eye reads it as a "track feature" by colour family.
        bsdf.inputs["Base Color"].default_value = (0.92, 0.45, 0.08, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.5
    return mat


def _largest_terrain_mesh() -> bpy.types.Object | None:
    """Pick the most likely terrain target: largest visible mesh whose
    ``kind`` custom prop is ``"track"``. Used as a fallback when the
    user hasn't explicitly selected a terrain object."""
    best: bpy.types.Object | None = None
    best_verts = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        if obj.get("kind") != "track":
            continue
        if not is_object_visible(obj):
            continue
        n = len(obj.data.vertices)
        if n > best_verts:
            best_verts = n
            best = obj
    return best


def _add_road_starter_curve(scene) -> bpy.types.Object:
    """Create a 4-point Bezier curve named ``road_curve_main`` straddling
    the centre of the scene. The user edits it (Tab into edit mode, move
    handles) before clicking Build Road."""
    existing = bpy.data.objects.get(ROAD_CURVE_NAME)
    if existing is not None:
        return existing
    curve_data = bpy.data.curves.new(ROAD_CURVE_NAME, type="CURVE")
    curve_data.dimensions = "3D"
    spline = curve_data.splines.new(type="BEZIER")
    # 4 control points spanning ~80m along Y with a gentle S-curve.
    spline.bezier_points.add(3)  # we start with 1 implicit point
    coords = [(-40, -40, 0), (-15, -10, 0), (15, 10, 0), (40, 40, 0)]
    for bp, (x, y, z) in zip(spline.bezier_points, coords):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    spline.use_cyclic_u = False
    curve_data.resolution_u = 24
    obj = bpy.data.objects.new(ROAD_CURVE_NAME, curve_data)
    obj["kind"] = "road_curve"
    scene.collection.objects.link(obj)
    return obj


def _sample_road_path(
    curve_obj: bpy.types.Object,
    terrain_obj: bpy.types.Object,
    *,
    n_samples: int,
    smooth_passes: int,
) -> list[dict]:
    """Sample `curve_obj` at `n_samples` arc-length steps, raycast each
    sample down onto the scene's terrain, smooth the resulting Z
    profile, and return a list of {x, y, z, tx, ty} dicts. The Z values
    are world-space terrain heights with `smooth_passes` of 1-2-1
    binomial smoothing applied so the road doesn't follow every bump.

    Preview collections are hidden during the raycast so gizmos can't
    catch the ray. The terrain object is preferred but any other
    `kind=track` mesh under the curve will also produce hits."""
    raw = _sample_curve_to_polyline(curve_obj)
    if len(raw) < 2:
        return []
    # Cumulative arc length in the horizontal plane.
    cum = [0.0]
    for i in range(len(raw) - 1):
        a, b = raw[i], raw[i + 1]
        cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    total = cum[-1]
    if total <= 0:
        return []

    samples: list[dict] = []
    denom = max(1, n_samples - 1)
    j = 0
    for i in range(n_samples):
        target = (i / denom) * total
        while j < len(cum) - 1 and cum[j + 1] < target:
            j += 1
        seg_len = (cum[j + 1] - cum[j]) if (j + 1 < len(cum)) else 1.0
        frac = (target - cum[j]) / seg_len if seg_len > 0 else 0.0
        a = raw[j]
        b = raw[j + 1] if (j + 1 < len(raw)) else raw[j]
        x = a[0] + (b[0] - a[0]) * frac
        y = a[1] + (b[1] - a[1]) * frac
        dx = b[0] - a[0]
        dy = b[1] - a[1]
        tl = math.hypot(dx, dy) or 1.0
        samples.append({"x": x, "y": y, "z": 0.0, "tx": dx / tl, "ty": dy / tl})

    # Raycast each sample's (x, y) downward onto the scene. The depsgraph
    # has to be re-fetched *after* the preview collections are hidden,
    # otherwise it still references them and the cast lands on gate /
    # racer / water gizmos instead of the real terrain underneath.
    scene = bpy.context.scene
    down = mathutils.Vector((0.0, 0.0, -1.0))
    ray_origin_z = 10000.0
    misses = 0
    with _PreviewCollectionsHidden(bpy.context.view_layer):
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        for s in samples:
            origin = mathutils.Vector((s["x"], s["y"], ray_origin_z))
            result, location, _normal, _index, hit_obj, _matrix = scene.ray_cast(
                depsgraph, origin, down
            )
            if result:
                s["z"] = float(location.z)
                if terrain_obj is not None and hit_obj != terrain_obj:
                    # Hit a prop or another track mesh; still useful but
                    # we count it for the report.
                    pass
            else:
                misses += 1

    # Smooth the height profile (1-2-1 binomial, in place).
    for _ in range(max(0, int(smooth_passes))):
        new_z = []
        n = len(samples)
        for i in range(n):
            zp = samples[max(0, i - 1)]["z"]
            zn = samples[min(n - 1, i + 1)]["z"]
            new_z.append((zp + samples[i]["z"] * 2 + zn) / 4.0)
        for i, z in enumerate(new_z):
            samples[i]["z"] = z

    return samples


def _build_road_strip_mesh(samples: list[dict], width: float, lift: float) -> bpy.types.Mesh:
    """Build a road-strip mesh from the (x, y, z, tx, ty) samples. Each
    sample emits a pair of verts perpendicular to its tangent in the
    horizontal plane (left and right), elevated by `lift`."""
    if ROAD_MESH_NAME in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[ROAD_MESH_NAME])
    me = bpy.data.meshes.new(ROAD_MESH_NAME)
    verts: list[tuple[float, float, float]] = []
    half_w = width / 2.0
    for s in samples:
        # Horizontal perpendicular = 90° CCW rotation of the tangent.
        # +X-right when the road goes "north", which feels natural.
        nx = -s["ty"]
        ny = s["tx"]
        z = s["z"] + lift
        verts.append((s["x"] - nx * half_w, s["y"] - ny * half_w, z))
        verts.append((s["x"] + nx * half_w, s["y"] + ny * half_w, z))
    faces: list[tuple[int, int, int, int]] = []
    for i in range(len(samples) - 1):
        a = i * 2
        # Wind CCW so the normal faces +Z up.
        faces.append((a, a + 2, a + 3, a + 1))
    me.from_pydata(verts, [], faces)
    me.update()
    for poly in me.polygons:
        poly.use_smooth = False  # roads read better with hard shading
    return me


def _conform_terrain_to_road(
    terrain_obj: bpy.types.Object,
    samples: list[dict],
    *,
    width: float,
    blend_radius: float,
) -> dict:
    """Push each terrain vertex within `(width/2 + blend_radius)` of the
    road centerline toward the road's local Z. Within the inner band
    (`d < width/2`) the vertex snaps fully; the outer band falls off
    with a smoothstep so the join is seamless.

    Returns a summary `{flattened, blended}` count for the report."""
    from mathutils.kdtree import KDTree

    if not samples:
        return {"flattened": 0, "blended": 0}

    inner = width / 2.0
    outer = inner + max(0.0, blend_radius)

    # KDTree over (x, y) samples, Z zero so 2D lookups in the horizontal
    # plane are exact.
    kd = KDTree(len(samples))
    for i, s in enumerate(samples):
        kd.insert((s["x"], s["y"], 0.0), i)
    kd.balance()

    me = terrain_obj.data
    mw = terrain_obj.matrix_world
    mw_inv = mw.inverted_safe()

    flattened = 0
    blended = 0
    for v in me.vertices:
        world = mw @ v.co
        _, idx, _ = kd.find((world.x, world.y, 0.0))
        s = samples[idx]
        d = math.hypot(world.x - s["x"], world.y - s["y"])
        if d >= outer:
            continue
        target_z = s["z"]
        if d <= inner:
            blend = 1.0
            flattened += 1
        else:
            t = (outer - d) / (outer - inner)
            blend = t * t * (3.0 - 2.0 * t)  # smoothstep
            blended += 1
        new_world_z = world.z * (1.0 - blend) + target_z * blend
        v.co = mw_inv @ mathutils.Vector((world.x, world.y, new_world_z))

    me.update()
    me.calc_loop_triangles()
    return {"flattened": flattened, "blended": blended}


def _terrain_active_modifiers(obj: bpy.types.Object) -> list[str]:
    """Return names of every viewport-enabled modifier on `obj`. The
    road tool conforms by writing to source-mesh verts; any active
    modifier (Geometry Nodes, Subsurf, Displace) overrides them on
    next evaluation — *or worse*, adds its own displacement on top so
    the terrain spikes wildly where the road wrote a non-zero Z."""
    return [m.name for m in obj.modifiers if m.show_viewport] if obj.modifiers else []


def _apply_all_viewport_modifiers(obj: bpy.types.Object) -> list[str]:
    """Apply every viewport-enabled modifier on `obj` in stack order,
    using the user's selection context. Returns the list of applied
    modifier names so callers can include it in their status report.

    The modifier operator needs the object to be active and selected,
    so we snapshot selection state and restore it on exit."""
    applied: list[str] = []
    view_layer = bpy.context.view_layer
    prev_active = view_layer.objects.active
    prev_selection = [o for o in view_layer.objects if o.select_get()]
    try:
        for o in prev_selection:
            o.select_set(False)
        view_layer.objects.active = obj
        obj.select_set(True)
        # `modifier_apply` removes the modifier from the stack, so we
        # iterate over a snapshot of names rather than the live list.
        names_to_apply = [m.name for m in obj.modifiers if m.show_viewport]
        for name in names_to_apply:
            try:
                bpy.ops.object.modifier_apply(modifier=name)
                applied.append(name)
            except RuntimeError:
                # Some modifiers can't be applied (e.g., Armature
                # without pose data); skip but report.
                pass
    finally:
        obj.select_set(False)
        for o in prev_selection:
            if o.name in view_layer.objects:
                o.select_set(True)
        view_layer.objects.active = prev_active
    return applied


class HOVERBIKE_OT_add_road_starter_curve(Operator):
    """Create a 4-point Bezier curve named ``road_curve_main`` straddling
    the scene centre. Tab into edit mode to drag the handles into the
    road shape you want, then click *Build Road*."""

    bl_idname = "hoverbike.add_road_starter_curve"
    bl_label = "Add Road Curve"
    bl_description = "Drop a 4-point starter Bezier curve for the road tool to follow"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        obj = _add_road_starter_curve(context.scene)
        self.report({"INFO"}, f"Created {obj.name}. Tab into edit mode to shape it, then Build Road.")
        return {"FINISHED"}


class HOVERBIKE_OT_build_road(Operator):
    """Sample `road_curve_main` along its arc length, raycast onto the
    terrain to get each sample's altitude, smooth the height profile,
    build a road-strip mesh with `mat_track_road`, and deform the
    terrain so it conforms to the road in a `width + blend_radius` band.
    Re-runs replace any prior road mesh; the terrain deformation
    accumulates, so undo (Ctrl+Z) is your friend during iteration.

    If the terrain has active modifiers (e.g. a Geometry Nodes
    procedural island), they'd override the road's vertex edits — or
    worse, add their displacement on top so the terrain spikes upward.
    Toggle *Apply modifiers first* to bake them in before deforming
    (one-way: GN parametric tunability is lost in exchange for a
    drivable road)."""

    bl_idname = "hoverbike.build_road"
    bl_label = "Build Road"
    bl_description = (
        "Conform terrain to road_curve_main and build a kind=track road strip"
    )
    bl_options = {"REGISTER", "UNDO"}

    apply_modifiers: BoolProperty(  # type: ignore[valid-type]
        name="Apply modifiers first",
        description=(
            "Bake terrain modifiers (e.g. Geometry Nodes island) into the "
            "mesh before deforming. Required to deform procedural terrain; "
            "loses parametric tunability of the source modifier."
        ),
        default=False,
    )

    def execute(self, context):
        curve_obj = bpy.data.objects.get(ROAD_CURVE_NAME)
        if curve_obj is None or curve_obj.type != "CURVE":
            self.report(
                {"ERROR"},
                f"{ROAD_CURVE_NAME!r} not found — click *Add Road Curve* first.",
            )
            return {"CANCELLED"}

        # Pick terrain: the active mesh, else the largest kind=track mesh.
        terrain = context.active_object
        if terrain is None or terrain.type != "MESH" or terrain.get("kind") != "track":
            terrain = _largest_terrain_mesh()
        if terrain is None:
            self.report(
                {"ERROR"},
                "No terrain mesh found. Select a kind=track mesh, or set kind='track' on your terrain.",
            )
            return {"CANCELLED"}

        active_mods = _terrain_active_modifiers(terrain)
        applied_mods: list[str] = []
        if active_mods:
            if self.apply_modifiers:
                applied_mods = _apply_all_viewport_modifiers(terrain)
            else:
                self.report(
                    {"ERROR"},
                    f"{terrain.name} has active modifiers ({', '.join(active_mods)}) — they'd "
                    "spike the terrain wildly because GN adds its displacement on top of the "
                    "road's vertex edits. Toggle *Apply modifiers first* in the redo panel, or "
                    "apply them manually (Object → Apply → Visual Geometry to Mesh) and re-run.",
                )
                return {"CANCELLED"}

        scene = context.scene
        samples = _sample_road_path(
            curve_obj,
            terrain,
            n_samples=int(scene.hoverbike_road_samples),
            smooth_passes=int(scene.hoverbike_road_smooth_passes),
        )
        if len(samples) < 2:
            self.report({"ERROR"}, "Couldn't sample road curve — does it have ≥ 2 control points?")
            return {"CANCELLED"}

        width = float(scene.hoverbike_road_width)
        lift = float(scene.hoverbike_road_lift)
        blend_radius = float(scene.hoverbike_road_blend_radius)

        # Deform terrain first, then build the road strip — that way the
        # road's Z (sampled before deformation) sits on the *original*
        # surface and the terrain rises/falls to meet it.
        deform_summary = _conform_terrain_to_road(
            terrain, samples, width=width, blend_radius=blend_radius
        )

        # Build / replace the road strip mesh.
        old = bpy.data.objects.get(ROAD_OBJECT_NAME)
        if old is not None:
            bpy.data.objects.remove(old, do_unlink=True)
        me = _build_road_strip_mesh(samples, width=width, lift=lift)
        me.materials.append(_ensure_road_material())
        obj = bpy.data.objects.new(ROAD_OBJECT_NAME, me)
        obj["kind"] = "track"
        scene.collection.objects.link(obj)

        applied_msg = f" (applied {', '.join(applied_mods)})" if applied_mods else ""
        self.report(
            {"INFO"},
            f"Road built: {len(samples)} samples, width {width:.1f}m. "
            f"Terrain: {deform_summary['flattened']} verts flattened, "
            f"{deform_summary['blended']} blended{applied_msg}.",
        )
        return {"FINISHED"}


# ── Ramp tool ──────────────────────────────────────────────────────────────
#
# Build a parametric stunt ramp at the 3D cursor. The ramp is a solid
# wedge with an optional flat run-up before the launch kicker, tagged
# `kind=track` so it ships out as a collidable surface, and shaded with
# `mat_track_ramp` (saturated orange — same colour family as the turn-
# indicator chevrons so the eye reads "track feature" instantly).
#
# Geometry: subdivided along ±Y (travel direction). Width is along ±X.
# The bottom face stays at z=0; the top face rises along a smoothstep
# curve from the end of the approach to the launch lip. Use the
# `Curved kicker` toggle off for a plain linear wedge instead.

RAMP_OBJECT_PREFIX = "ramp_"


def _ramp_height_profile(y: float, *, length: float, approach: float, peak: float, curved: bool) -> float:
    """Z elevation of the top face at distance `y` along the ramp.
    Approach run-up stays at 0; the kicker rises to `peak` at y=length.
    Smoothstep curve makes the launch lip naturally tangent to vertical
    so the bike's nose lofts cleanly off the end."""
    if y <= approach or length <= approach:
        return 0.0
    t = (y - approach) / (length - approach)
    t = max(0.0, min(1.0, t))
    if curved:
        return peak * t * t * (3.0 - 2.0 * t)
    return peak * t


def _build_ramp_mesh(
    name: str,
    *,
    length: float,
    width: float,
    peak_height: float,
    approach: float,
    segments: int,
    curved: bool,
) -> bpy.types.Mesh:
    """Build a wedge-shaped ramp mesh in local coords (length along +Y,
    width along ±X, height along +Z). Z-up, matches Blender world axes."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    half_w = width / 2.0
    n = max(2, int(segments))

    verts: list[tuple[float, float, float]] = []
    # Bottom verts (row by row along +Y).
    for i in range(n + 1):
        y = (i / n) * length
        verts.append((-half_w, y, 0.0))
        verts.append(( half_w, y, 0.0))
    top_start = len(verts)
    # Top verts (same XY columns, elevated by the height profile).
    for i in range(n + 1):
        y = (i / n) * length
        z = _ramp_height_profile(
            y, length=length, approach=approach, peak=peak_height, curved=curved
        )
        verts.append((-half_w, y, z))
        verts.append(( half_w, y, z))

    faces: list[tuple[int, ...]] = []
    # Bottom face (one big n-gon? simpler as a strip of quads CCW).
    for i in range(n):
        a = i * 2
        # Reverse winding so the normal faces -Z.
        faces.append((a, a + 1, a + 3, a + 2))
    # Top (drivable surface) — winding so normal faces +Z.
    for i in range(n):
        a = top_start + i * 2
        faces.append((a, a + 2, a + 3, a + 1))
    # Left side (x = -half_w): rows i and i+1, top + bottom.
    for i in range(n):
        bot_a = i * 2
        bot_b = bot_a + 2
        top_a = top_start + i * 2
        top_b = top_a + 2
        faces.append((bot_a, top_a, top_b, bot_b))
    # Right side (x = +half_w).
    for i in range(n):
        bot_a = i * 2 + 1
        bot_b = bot_a + 2
        top_a = top_start + i * 2 + 1
        top_b = top_a + 2
        faces.append((bot_a, bot_b, top_b, top_a))
    # End caps. Back (y=0): bottom verts 0/1 and top verts at top_start/+1.
    # Skip if top verts coincide with bottom (z=0 at y=0 always — degenerate quad).
    if peak_height > 0 and approach < length:
        # Front cap at y=length: last 4 verts.
        last_bot = n * 2
        last_top = top_start + n * 2
        faces.append((last_bot, last_top, last_top + 1, last_bot + 1))
    # Back cap (y=0) — degenerate at z=0; only emit if approach > 0 and
    # we want a visible vertical face. With z=0 at i=0 the back is
    # naturally flush with the ground, so skip.

    me.from_pydata(verts, [], faces)
    me.update()
    for poly in me.polygons:
        poly.use_smooth = False  # crisp wedge silhouette
    return me


def _next_ramp_object_name() -> str:
    """First free `ramp_NN` name. Avoids stomping prior ramps the user
    has placed and tuned, while keeping the numbering tidy."""
    i = 0
    while True:
        candidate = f"{RAMP_OBJECT_PREFIX}{i:02d}"
        if candidate not in bpy.data.objects:
            return candidate
        i += 1


class HOVERBIKE_OT_add_ramp(Operator):
    """Drop a parametric stunt-ramp wedge at the 3D cursor. Solid mesh
    tagged `kind=track` so it's collidable on export. Tune length /
    width / peak height / approach run-up in the panel; toggle *Curved
    kicker* for a smoothstep launch profile vs. a flat linear wedge."""

    bl_idname = "hoverbike.add_ramp"
    bl_label = "Add Ramp"
    bl_description = "Place a kind=track stunt ramp at the 3D cursor"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        length = float(scene.hoverbike_ramp_length)
        width = float(scene.hoverbike_ramp_width)
        peak = float(scene.hoverbike_ramp_height)
        approach = float(scene.hoverbike_ramp_approach)
        segments = int(scene.hoverbike_ramp_segments)
        curved = bool(scene.hoverbike_ramp_curved)

        if length <= 0 or width <= 0 or peak <= 0:
            self.report({"ERROR"}, "Ramp dimensions must all be positive.")
            return {"CANCELLED"}
        if approach >= length:
            self.report({"ERROR"}, "Approach must be shorter than total length.")
            return {"CANCELLED"}

        name = _next_ramp_object_name()
        mesh_name = f"{name}_mesh"
        me = _build_ramp_mesh(
            mesh_name,
            length=length,
            width=width,
            peak_height=peak,
            approach=approach,
            segments=segments,
            curved=curved,
        )
        me.materials.append(_ramp_material())
        obj = bpy.data.objects.new(name, me)
        obj["kind"] = "track"
        obj["ramp_height"] = peak
        obj["ramp_length"] = length
        # Drop at 3D cursor with no extra rotation — user can R/G to
        # align after placement. The cursor already encodes their
        # intended position from viewport interaction.
        cursor = context.scene.cursor
        obj.location = cursor.location.copy()
        obj.rotation_euler = cursor.rotation_euler.copy()
        scene.collection.objects.link(obj)
        # Select + activate the new ramp so the user can immediately
        # rotate it with R or fine-tune the transform.
        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj

        self.report(
            {"INFO"},
            f"Added {name}: {length:.1f}m × {width:.1f}m, peak {peak:.1f}m "
            f"(approach {approach:.1f}m, {'curved' if curved else 'linear'}).",
        )
        return {"FINISHED"}


def _snap_spline_to_terrain(curve_obj: bpy.types.Object, *, hover_m: float) -> dict:
    """Drop each control point of `curve_obj` straight down onto the
    nearest mesh under it (via Blender's scene ray-cast), then lift by
    `hover_m`. Returns counts of hits/misses for the operator report.

    Preview collections are excluded during the raycast so the gate /
    racer / water gizmos never catch the ray — only authored terrain
    can land a hit. The depsgraph has to be re-fetched *inside* the
    `with` block: capturing it before the exclusion takes effect leaves
    the cast still hitting gizmos."""
    scene = bpy.context.scene
    hits = 0
    misses = 0
    # Start the ray well above the highest currently-authored vertex on
    # the curve so we never start inside terrain.
    high_z = 0.0
    for *_rest, world_co, _ in _spline_iter_points(curve_obj):
        if world_co.z > high_z:
            high_z = world_co.z
    origin_z = high_z + 1000.0
    down = mathutils.Vector((0.0, 0.0, -1.0))

    with _PreviewCollectionsHidden(bpy.context.view_layer):
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        for _spline, _pt, world_co, setter in _spline_iter_points(curve_obj):
            origin = mathutils.Vector((world_co.x, world_co.y, origin_z))
            result, location, _normal, _index, _obj, _matrix = scene.ray_cast(
                depsgraph, origin, down
            )
            if result:
                new_co = mathutils.Vector(
                    (world_co.x, world_co.y, location.z + hover_m)
                )
                setter(new_co)
                hits += 1
            else:
                misses += 1

    # Force a depsgraph refresh so the spline polyline samples the new
    # control points immediately (the gate/turn previews will follow via
    # the auto-rebuild handler).
    curve_obj.data.update_tag()
    return {"hits": hits, "misses": misses}


class HOVERBIKE_OT_snap_spline_to_terrain(Operator):
    """Drop every control point on ai_spline_main onto the nearest
    surface below it, then lift by the configured hover height. Pairs
    with the live gate preview — re-snapping after a terrain edit slides
    the racing line back onto the terrain in one click."""

    bl_idname = "hoverbike.snap_spline_to_terrain"
    bl_label = "Snap Spline to Terrain"
    bl_description = (
        "Raycast each ai_spline_main control point onto the terrain and "
        "lift by the configured hover height"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        sp = bpy.data.objects.get("ai_spline_main")
        if sp is None or sp.type != "CURVE":
            self.report({"ERROR"}, "ai_spline_main not found.")
            return {"CANCELLED"}
        hover = float(getattr(context.scene, "hoverbike_snap_hover_height", 3.0))
        summary = _snap_spline_to_terrain(sp, hover_m=hover)
        if summary["misses"]:
            self.report(
                {"WARNING"},
                f"Snapped {summary['hits']} points; {summary['misses']} missed (no terrain below).",
            )
        else:
            self.report(
                {"INFO"},
                f"Snapped {summary['hits']} spline points to terrain (+{hover:.1f}m hover).",
            )
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


# ── Terrain attribute bakers ────────────────────────────────────────────────
#
# Fill the `baked_ao` (FLOAT_COLOR) and `baked_path` (FLOAT) attributes on
# the source terrain mesh so the GN graph can route them into COLOR_0.G
# (AO multiplier) and COLOR_0.B (racing-line wear). The seeded GN graph
# samples these as Named Attributes; the runtime terrain shader reads
# both channels and uses them to darken cavities and tint a worn dirt
# line into the surface where the racing line runs.
#
# AO uses Cycles' vertex-colour bake — fastest path on consumer GPUs and
# handles the GN-evaluated terrain geometry correctly (Cycles internally
# applies modifiers before baking). Path-worn uses a KDTree over a
# densely sampled spline polyline — pure Python, ~1 s on a 150 k-vert
# terrain.

BAKED_AO_ATTR = "baked_ao"
BAKED_PATH_ATTR = "baked_path"
BAKE_TEMP_ATTR = "_hoverbike_bake_target"
PATH_WEAR_INNER_M = 4.0      # full wear within this distance of the spline
PATH_WEAR_OUTER_M = 14.0     # zero wear beyond this distance


def _ensure_baked_attrs(terrain: bpy.types.Object) -> None:
    """Make sure the source terrain mesh has the baked-* attributes the
    GN graph reads. Both stored as plain FLOAT so glTF's vertex-colour
    heuristic doesn't pick them up and stomp the GN-stamped COLOR_0 in
    the export. Idempotent — pre-existing attributes are left alone."""
    me = terrain.data
    if BAKED_AO_ATTR not in me.attributes:
        attr = me.attributes.new(name=BAKED_AO_ATTR, type="FLOAT", domain="POINT")
        for i in range(len(attr.data)):
            attr.data[i].value = 1.0  # default = no occlusion
    if BAKED_PATH_ATTR not in me.attributes:
        attr = me.attributes.new(name=BAKED_PATH_ATTR, type="FLOAT", domain="POINT")
        for i in range(len(attr.data)):
            attr.data[i].value = 0.0  # default = no wear


def _bake_ao_cycles(terrain: bpy.types.Object, samples: int = 16, distance: float = 30.0) -> None:
    """Bake Cycles AO into the terrain's ``baked_ao`` FLOAT attribute.
    Cycles needs a vertex *colour* attribute as its target, but a
    FLOAT_COLOR on the source mesh would be picked up by glTF's
    auto-export heuristic and shipped as COLOR_0, fighting the
    GN-stamped COLOR_0. We work around that by creating a throwaway
    FLOAT_COLOR (``_hoverbike_bake_target``) for Cycles to write into,
    copying the R channel into the persistent ``baked_ao`` float, and
    deleting the temporary attribute on the way out. Net effect: the
    source mesh ships with only FLOAT attributes, and the GN graph's
    ``Named Attribute`` sampler reads ``baked_ao`` for COLOR_0.G."""
    scene = bpy.context.scene
    me = terrain.data
    prev_engine = scene.render.engine

    # Create the throwaway bake target.
    if BAKE_TEMP_ATTR in me.color_attributes:
        me.color_attributes.remove(me.color_attributes[BAKE_TEMP_ATTR])
    target = me.color_attributes.new(name=BAKE_TEMP_ATTR, type="FLOAT_COLOR", domain="POINT")
    me.color_attributes.active_color_index = me.color_attributes.find(BAKE_TEMP_ATTR)

    scene.render.engine = "CYCLES"
    scene.cycles.bake_type = "AO"
    scene.cycles.samples = samples
    scene.render.bake.target = "VERTEX_COLORS"
    if scene.world is not None:
        try:
            scene.world.light_settings.use_ambient_occlusion = True
            scene.world.light_settings.distance = distance
        except AttributeError:
            pass

    prev_active_obj = bpy.context.view_layer.objects.active
    # ``selected_objects`` isn't available on every context (e.g. when
    # the operator runs from a non-VIEW_3D context like MCP/headless).
    prev_selection = list(getattr(bpy.context, "selected_objects", []))
    for o in prev_selection:
        o.select_set(False)
    bpy.context.view_layer.objects.active = terrain
    terrain.select_set(True)
    try:
        bpy.ops.object.bake(type="AO")
        # Transfer Cycles' RGB output (greyscale, R == G == B for AO)
        # into the persistent FLOAT attribute.
        ao_attr = me.attributes[BAKED_AO_ATTR]
        for i in range(len(target.data)):
            ao_attr.data[i].value = float(target.data[i].color[0])
    finally:
        terrain.select_set(False)
        for o in prev_selection:
            o.select_set(True)
        bpy.context.view_layer.objects.active = prev_active_obj
        scene.render.engine = prev_engine
        if BAKE_TEMP_ATTR in me.color_attributes:
            me.color_attributes.remove(me.color_attributes[BAKE_TEMP_ATTR])


def _bake_path_wear(terrain: bpy.types.Object, spline: bpy.types.Object) -> int:
    """Compute per-vertex distance from the AI spline, run it through a
    smoothstep falloff, and write the result to ``baked_path`` on the
    source terrain. Reads the *evaluated* terrain mesh (post-GN) so
    vertex world positions reflect the actual displaced terrain —
    distance-from-spline only makes sense in the played world, not on a
    flat undisplaced plane. The vertex-index mapping back to the source
    mesh is one-to-one because the GN graph doesn't add/remove verts."""
    import math
    from mathutils import Vector
    from mathutils.kdtree import KDTree

    if spline is None or spline.type != "CURVE":
        raise RuntimeError("path-wear bake needs an ai_spline_main curve")

    dg = bpy.context.evaluated_depsgraph_get()

    # Dense polyline samples from the spline. Step ~1 m so a KDTree
    # nearest-neighbour is a very tight distance estimate.
    cobj = spline.evaluated_get(dg)
    cme = cobj.to_mesh()
    try:
        sw = spline.matrix_world
        spline_pts = [sw @ Vector(v.co) for v in cme.vertices]
    finally:
        try:
            cobj.to_mesh_clear()
        except ReferenceError:
            pass
    if len(spline_pts) < 2:
        raise RuntimeError("ai_spline_main has too few sampled points")

    tree = KDTree(len(spline_pts))
    for i, p in enumerate(spline_pts):
        tree.insert(p, i)
    tree.balance()

    eobj = terrain.evaluated_get(dg)
    eme = eobj.to_mesh()
    n_verts = 0
    try:
        if len(eme.vertices) != len(terrain.data.vertices):
            raise RuntimeError(
                f"vertex-count mismatch (source {len(terrain.data.vertices)}, "
                f"evaluated {len(eme.vertices)}) — GN graph appears to add/remove verts"
            )
        mw = terrain.matrix_world
        path_attr = terrain.data.attributes[BAKED_PATH_ATTR]
        outer = float(PATH_WEAR_OUTER_M)
        inner = float(PATH_WEAR_INNER_M)
        span = max(outer - inner, 1e-6)
        n_verts = len(eme.vertices)
        for i, v in enumerate(eme.vertices):
            world = mw @ Vector(v.co)
            _, _, dist = tree.find(world)
            # Smoothstep from outer (wear=0) to inner (wear=1).
            t = max(0.0, min(1.0, (outer - dist) / span))
            wear = t * t * (3.0 - 2.0 * t)
            path_attr.data[i].value = wear
    finally:
        try:
            eobj.to_mesh_clear()
        except ReferenceError:
            # Cycles' bake can invalidate the cached evaluated mesh
            # mid-operator; the per-vertex writes above already happened
            # so the bake is complete — we just can't clean up the cache
            # reference any more. Safe to swallow.
            pass
    return n_verts


class HOVERBIKE_OT_bake_terrain_attrs(Operator):
    """Bake AO + racing-line wear into the source terrain's
    ``baked_ao`` / ``baked_path`` attributes. The HV_Island GN graph
    samples both via Named Attribute nodes and routes them into
    COLOR_0.G (AO multiplier) and COLOR_0.B (path-worn), which the
    runtime terrain shader reads to darken cavities and stamp a worn
    dirt line into the racing surface."""

    bl_idname = "hoverbike.bake_terrain_attrs"
    bl_label = "Bake AO + Path Wear"
    bl_description = (
        "Bake ambient occlusion (Cycles) and AI-spline path wear (Python KDTree) "
        "into the terrain's baked_ao + baked_path attributes. ~10-20 s on a 150k-vert terrain."
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        terrain = bpy.data.objects.get("terrain")
        if terrain is None or terrain.type != "MESH":
            self.report({"ERROR"}, "no `terrain` mesh in scene")
            return {"CANCELLED"}
        spline = bpy.data.objects.get("ai_spline_main")
        if spline is None or spline.type != "CURVE":
            self.report({"ERROR"}, "no `ai_spline_main` curve in scene")
            return {"CANCELLED"}

        _ensure_baked_attrs(terrain)
        try:
            _bake_ao_cycles(terrain)
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"AO bake failed: {e}")
            return {"CANCELLED"}
        try:
            n = _bake_path_wear(terrain, spline)
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"path-wear bake failed: {e}")
            return {"CANCELLED"}
        self.report({"INFO"}, f"Baked AO + path wear over {n} vertices")
        return {"FINISHED"}


# ── Track stats panel ───────────────────────────────────────────────────────


def _spline_arc_length(spline_obj: bpy.types.Object) -> float:
    """Sum the straight-line distances between consecutive sampled
    points on the spline's polyline. Closes the loop for cyclic
    splines — most race tracks are cyclic."""
    import math
    if spline_obj is None or spline_obj.type != "CURVE":
        return 0.0
    pts = _sample_curve_to_polyline(spline_obj)
    if len(pts) < 2:
        return 0.0
    total = 0.0
    for i in range(len(pts) - 1):
        a = pts[i]
        b = pts[i + 1]
        total += math.hypot(b[0] - a[0], b[1] - a[1])
    # Cyclic close.
    cyclic = any(
        getattr(sp, "use_cyclic_u", False) for sp in spline_obj.data.splines
    )
    if cyclic:
        a = pts[-1]
        b = pts[0]
        total += math.hypot(b[0] - a[0], b[1] - a[1])
    return total


def _terrain_height_extents() -> tuple[float, float, float] | None:
    """Min Y / max Y / under-water fraction for the evaluated terrain
    mesh. Returns None if the terrain isn't present. Heavy enough
    (~150 k verts) that we only call this on demand via the panel's
    Refresh button, not on every redraw."""
    terrain = bpy.data.objects.get("terrain")
    if terrain is None or terrain.type != "MESH":
        return None
    dg = bpy.context.evaluated_depsgraph_get()
    eobj = terrain.evaluated_get(dg)
    me = eobj.to_mesh()
    try:
        if not me.vertices:
            return None
        mw = terrain.matrix_world
        zmin = float("inf")
        zmax = float("-inf")
        below = 0
        for v in me.vertices:
            wz = (mw @ v.co).z
            if wz < zmin:
                zmin = wz
            if wz > zmax:
                zmax = wz
            if wz < 0.0:
                below += 1
        frac = below / len(me.vertices)
        return zmin, zmax, frac
    finally:
        eobj.to_mesh_clear()


class HOVERBIKE_OT_refresh_track_stats(Operator):
    """Recompute the terrain min/max y + water-coverage stats and stash
    them on scene custom properties so the panel can show them. Splits
    out from the cheap counts (gates, starts, …) which the panel
    recomputes on every redraw."""

    bl_idname = "hoverbike.refresh_track_stats"
    bl_label = "Refresh Terrain Stats"
    bl_description = "Evaluate the terrain mesh and update the min/max y + water-coverage readouts."
    bl_options = {"REGISTER"}

    def execute(self, context):
        ext = _terrain_height_extents()
        scene = context.scene
        if ext is None:
            scene["_hoverbike_stats_terrain_min_y"] = 0.0
            scene["_hoverbike_stats_terrain_max_y"] = 0.0
            scene["_hoverbike_stats_terrain_water_frac"] = 0.0
            self.report({"WARNING"}, "no terrain mesh — stats reset")
            return {"FINISHED"}
        zmin, zmax, frac = ext
        scene["_hoverbike_stats_terrain_min_y"] = float(zmin)
        scene["_hoverbike_stats_terrain_max_y"] = float(zmax)
        scene["_hoverbike_stats_terrain_water_frac"] = float(frac)
        self.report(
            {"INFO"},
            f"Terrain: y∈[{zmin:.1f}, {zmax:.1f}] m, water coverage {frac * 100:.0f}%",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_reload_track_json(Operator):
    """Pull scalar / parametric fields from ``public/tracks/<id>.json``
    into the scene's custom properties (gate spacing, terrain shader,
    water knobs, start pose). Lets edits made in the in-app editor
    flow back into the .blend without re-launching the addon."""

    bl_idname = "hoverbike.reload_track_json"
    bl_label = "Reload from JSON"
    bl_description = (
        "Sync gate spacing, terrain shader, water knobs, and the start "
        "pose from public/tracks/<id>.json into the .blend"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        blend = bpy.data.filepath
        if not blend:
            self.report({"ERROR"}, "Save your .blend first (Ctrl+S).")
            return {"CANCELLED"}
        repo = find_repo_root(blend)
        if not repo:
            self.report({"ERROR"}, "No repo root found — .blend isn't inside a hoverbike clone.")
            return {"CANCELLED"}
        track_id = derive_asset_id("hoverbike_track_id")
        if not track_id:
            self.report({"ERROR"}, "Couldn't derive a track id from the .blend filename.")
            return {"CANCELLED"}
        json_path = os.path.join(repo, "public", "tracks", f"{track_id}.json")
        if not os.path.isfile(json_path):
            self.report({"WARNING"}, f"No JSON yet at public/tracks/{track_id}.json — export once to create it.")
            return {"CANCELLED"}
        try:
            summary = reload_track_from_json(json_path)
        except (RuntimeError, ValueError) as e:
            self.report({"ERROR"}, f"Reload failed: {e}")
            return {"CANCELLED"}
        synced = [k for k in ("gateSpacing", "terrainShader", "water", "start") if k in summary]
        self.report({"INFO"}, f"Reloaded {summary['json']}: {', '.join(synced) or 'no syncable fields'}")
        return {"FINISHED"}


class HOVERBIKE_OT_export_track(Operator):
    """Validate the track scene, write
    ``public/assets/tracks/<id>.glb``, and rewrite
    ``public/tracks/<id>.json`` with the .blend's parametric state
    merged on top of the existing JSON. Editor-owned fields (hand-
    placed gates, pickups, props) are preserved; Blender-owned fields
    (gate spacing, terrain shader, water, spline anchors, start) come
    from the .blend."""

    bl_idname = "hoverbike.export_track"
    bl_label = "Export Track to Game"
    bl_description = (
        "Validate scene, export track GLB, and merge Blender-side "
        "parametric fields into public/tracks/<id>.json"
    )
    bl_options = {"REGISTER"}

    def invoke(self, context: bpy.types.Context, event: bpy.types.Event) -> set[str]:
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
                    # Force the active vertex-colour through even when
                    # the Eevee material doesn't reference it. The
                    # GN-stamped COLOR_0 (R=0, G=AO, B=path-worn,
                    # A=biome) is the active color on the source mesh.
                    export_vertex_color="ACTIVE",
                    export_all_vertex_colors=False,
                    export_active_vertex_color_when_no_material=True,
                )
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"GLB export failed: {e}")
            return {"CANCELLED"}

        json_existed = os.path.exists(json_path)
        existing: dict | None = None
        if json_existed:
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            except (OSError, ValueError):
                existing = None
        os.makedirs(os.path.dirname(json_path), exist_ok=True)
        derived = derive_track_json(track_id, f"/assets/tracks/{track_id}.glb")
        body = _merge_export_json(derived, existing)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(body, f, indent=2)
            f.write("\n")

        rel_glb = os.path.relpath(glb_path, repo).replace("\\", "/")
        rel_json = os.path.relpath(json_path, repo).replace("\\", "/")
        tag = "merged" if json_existed else "created"
        msg = f"Exported → {rel_glb} ({tag} {rel_json})"
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


# ── Live preview auto-rebuild ──────────────────────────────────────────────
#
# Make the spline-driven previews (gates, turn indicators, racer grid,
# water plane) follow their source edits without the author having to
# click Rebuild after every move. We watch the source objects via a
# persistent depsgraph_update_post handler, plus the relevant scene
# props via FloatProperty `update=` callbacks, debounce both into a
# single deferred batch via a one-shot bpy.app.timer (~0.2s), and only
# rebuild a preview if its collection already exists — so the user
# still opts in explicitly by clicking *Rebuild* once, then enjoys
# automatic updates.

# Names of source objects whose edits should trigger a rebuild. Any
# datablock update that matches one of these (object or its data —
# moving a curve's control points updates the Curve, not the Object)
# schedules the listed preview kinds.
_WATCHED_SOURCES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("ai_spline_main",   ("gates", "turns")),
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
    global _rebuild_timer_scheduled
    _rebuild_timer_scheduled = False
    pending = set(_pending_rebuilds)
    _pending_rebuilds.clear()

    scene = bpy.context.scene
    if scene is None:
        return None

    if "gates" in pending and bpy.data.collections.get(GATE_PREVIEW_COLLECTION):
        try:
            _rebuild_gate_preview(
                scene,
                spacing=float(scene.hoverbike_gate_spacing),
                half_width=float(scene.hoverbike_gate_half_width),
                height=float(scene.hoverbike_gate_height),
            )
        except (RuntimeError, AttributeError):
            pass

    if "turns" in pending and bpy.data.collections.get(TURN_PREVIEW_COLLECTION):
        try:
            _rebuild_turn_indicators(
                scene,
                kappa_threshold=float(scene.hoverbike_turn_kappa),
                min_spacing_m=float(scene.hoverbike_turn_min_spacing),
            )
        except (RuntimeError, AttributeError):
            pass

    if "racer" in pending and bpy.data.collections.get(RACER_PREVIEW_COLLECTION):
        try:
            _rebuild_racer_preview(scene)
        except (RuntimeError, AttributeError):
            pass

    if "water" in pending and bpy.data.collections.get(WATER_PREVIEW_COLLECTION):
        try:
            _rebuild_water_preview(
                scene,
                size=float(scene.hoverbike_water_size),
                subdivisions=int(scene.hoverbike_water_subdivisions),
                time=float(scene.hoverbike_water_time),
            )
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


@persistent
def _hoverbike_load_post(*_args):
    """Auto-sync the track .blend with its JSON when the file is
    opened. Silently no-ops outside of `tracks-src/` so bike .blends and
    arbitrary scenes are unaffected. Runs after the file's data is in
    memory so `bpy.data.objects` is populated."""
    blend = bpy.data.filepath
    if not blend or detect_mode(blend) != "track":
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


def _on_gate_prop_changed(self, context):
    """FloatProperty update callback — fires when the user scrubs gate
    spacing / half-width / height in the panel."""
    _schedule_rebuild("gates")


def _on_turn_prop_changed(self, context):
    _schedule_rebuild("turns")


def _on_water_prop_changed(self, context):
    _schedule_rebuild("water")


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
        col.operator("hoverbike.reload_track_json", icon="FILE_REFRESH")
        op_play = col.operator(
            "hoverbike.copy_track_url", text="Copy Play URL", icon="URL"
        )
        op_play.edit = False
        op_edit = col.operator(
            "hoverbike.copy_track_url", text="Copy Edit URL", icon="GREASEPENCIL"
        )
        op_edit.edit = True

        layout.separator()
        sp_box = layout.box()
        sp_box.label(text="Spline tools", icon="CURVE_NCURVE")
        sp_box.prop(context.scene, "hoverbike_snap_hover_height", text="Hover (m)")
        sp_box.operator("hoverbike.snap_spline_to_terrain", icon="SNAP_FACE")

        road_box = layout.box()
        road_box.label(text="Road tool", icon="MOD_CURVE")
        road_box.operator("hoverbike.add_road_starter_curve", icon="CURVE_BEZCURVE")
        row = road_box.row(align=True)
        row.prop(context.scene, "hoverbike_road_width", text="Width")
        row.prop(context.scene, "hoverbike_road_lift", text="Lift")
        row = road_box.row(align=True)
        row.prop(context.scene, "hoverbike_road_blend_radius", text="Blend")
        row.prop(context.scene, "hoverbike_road_samples", text="Samples")
        road_box.prop(context.scene, "hoverbike_road_smooth_passes", text="Smooth passes")
        road_box.operator("hoverbike.build_road", icon="MESH_PLANE")
        if bpy.data.objects.get(ROAD_CURVE_NAME):
            road_box.label(text="Edit road_curve_main, then Build", icon="INFO")

        ramp_box = layout.box()
        ramp_box.label(text="Ramp tool", icon="EVENT_R")
        row = ramp_box.row(align=True)
        row.prop(context.scene, "hoverbike_ramp_length", text="Length")
        row.prop(context.scene, "hoverbike_ramp_width", text="Width")
        row = ramp_box.row(align=True)
        row.prop(context.scene, "hoverbike_ramp_height", text="Peak")
        row.prop(context.scene, "hoverbike_ramp_approach", text="Approach")
        row = ramp_box.row(align=True)
        row.prop(context.scene, "hoverbike_ramp_segments", text="Segments")
        row.prop(context.scene, "hoverbike_ramp_curved", text="Curved")
        ramp_box.operator("hoverbike.add_ramp", icon="ADD")

        hm_box = layout.box()
        hm_box.label(text="Heightmap import", icon="IMAGE_DATA")
        row = hm_box.row(align=True)
        row.prop(context.scene, "hoverbike_heightmap_size", text="Size")
        row.prop(context.scene, "hoverbike_heightmap_subdivisions", text="Subdiv")
        row = hm_box.row(align=True)
        row.prop(context.scene, "hoverbike_heightmap_height", text="Δz (m)")
        row.prop(context.scene, "hoverbike_heightmap_base", text="Base z")
        hm_box.operator("hoverbike.import_heightmap", icon="IMPORT")

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
        # Live-follow signal: once the user clicks Rebuild, edits to the
        # spline or to these knobs auto-refresh the gates.
        if bpy.data.collections.get(GATE_PREVIEW_COLLECTION):
            gp_box.label(text="Live: follows spline edits", icon="LINKED")

        rp_box = layout.box()
        rp_box.label(text="Racer preview", icon="AUTO")
        row = rp_box.row(align=True)
        row.operator("hoverbike.rebuild_racer_preview", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_racer_preview", icon="HIDE_ON")

        gl_box = layout.box()
        gl_box.label(text="Ghost lap + chase cam", icon="CAMERA_DATA")
        row = gl_box.row(align=True)
        row.prop(context.scene, "hoverbike_ghost_speed", text="Speed (m/s)")
        row.prop(context.scene, "hoverbike_ghost_fps", text="FPS")
        row = gl_box.row(align=True)
        row.operator("hoverbike.rebuild_ghost_lap", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_ghost_lap", icon="HIDE_ON")
        gl_box.label(text="Press Spacebar to fly the lap", icon="PLAY")

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

        # Vertex-attribute bakers — fill COLOR_0.G + .B with real AO and
        # racing-line wear data. The runtime terrain shader reads both.
        bake_box = layout.box()
        bake_box.label(text="Terrain bakes", icon="MATERIAL")
        bake_box.label(text="Fills baked_ao + baked_path", icon="NODE_TEXTURE")
        bake_box.operator("hoverbike.bake_terrain_attrs", icon="MOD_NOISE")

        # Item 3 — runtime terrain-shader knobs. These are written into
        # public/tracks/<id>.json on export and read as uniforms by
        # src/engine/render/terrain-shader.ts. Changing them re-tunes the
        # in-game terrain without a code edit.
        sh_box = layout.box()
        sh_box.label(text="Terrain shader (runtime)", icon="SHADING_RENDERED")
        row = sh_box.row(align=True)
        row.prop(context.scene, "hoverbike_shader_alt_min", text="Alt min")
        row.prop(context.scene, "hoverbike_shader_alt_max", text="Alt max")
        row = sh_box.row(align=True)
        row.prop(context.scene, "hoverbike_shader_slope_start", text="Slope start")
        row.prop(context.scene, "hoverbike_shader_slope_end", text="Slope end")
        row = sh_box.row(align=True)
        row.prop(context.scene, "hoverbike_shader_variation", text="Variation")
        row.prop(context.scene, "hoverbike_shader_wet_band", text="Wet band")
        sh_box.label(text="Path tint:")
        row = sh_box.row(align=True)
        row.prop(context.scene, "hoverbike_shader_path_tint_r", text="R")
        row.prop(context.scene, "hoverbike_shader_path_tint_g", text="G")
        row.prop(context.scene, "hoverbike_shader_path_tint_b", text="B")

        # Item 2 — track stats. Cheap counts + spline length recompute
        # every redraw; min/max Y + water-coverage require an evaluated
        # mesh (~150 k verts) so they're behind an explicit refresh.
        stats_box = layout.box()
        stats_box.label(text="Track stats", icon="INFO")
        sp = bpy.data.objects.get("ai_spline_main")
        arc_len = _spline_arc_length(sp) if sp else 0.0
        lap_25 = arc_len / 25.0 if arc_len > 0 else 0.0
        stats_box.label(text=f"Spline length: {arc_len:,.1f} m")
        stats_box.label(text=f"Lap estimate @25 m/s: {lap_25:.1f} s")
        # Cheap counts from object names.
        counts = {"starts": 0, "checkpoints": 0, "pickups": 0, "boosts": 0}
        for obj in bpy.context.scene.objects:
            n = obj.name
            if n.startswith("start_"): counts["starts"] += 1
            elif n.startswith("cp_"): counts["checkpoints"] += 1
            elif n.startswith("pickup"): counts["pickups"] += 1
            elif n.startswith("boost"): counts["boosts"] += 1
        row = stats_box.row(align=True)
        row.label(text=f"Starts: {counts['starts']}")
        row.label(text=f"Gates: {counts['checkpoints']}")
        row = stats_box.row(align=True)
        row.label(text=f"Pickups: {counts['pickups']}")
        row.label(text=f"Boosts: {counts['boosts']}")
        # Cached terrain stats (require depsgraph eval).
        scn = bpy.context.scene
        zmin = scn.get("_hoverbike_stats_terrain_min_y")
        zmax = scn.get("_hoverbike_stats_terrain_max_y")
        frac = scn.get("_hoverbike_stats_terrain_water_frac")
        if zmin is not None and zmax is not None and frac is not None:
            stats_box.label(text=f"Terrain y: [{float(zmin):,.1f}, {float(zmax):,.1f}] m")
            stats_box.label(text=f"Water coverage: {float(frac) * 100:.0f}%")
        else:
            stats_box.label(text="Terrain y / water: refresh below", icon="QUESTION")
        stats_box.operator("hoverbike.refresh_track_stats", icon="FILE_REFRESH")

        layout.separator()
        col = layout.column(align=True)
        col.scale_y = 0.85
        col.label(text="Export merges Blender knobs", icon="INFO")
        col.label(text="(spacing, water, shader, start)")
        col.label(text="onto the existing JSON;")
        col.label(text="editor-placed gates stay.")

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
    HOVERBIKE_OT_rebuild_ghost_lap,
    HOVERBIKE_OT_hide_ghost_lap,
    HOVERBIKE_OT_snap_spline_to_terrain,
    HOVERBIKE_OT_add_road_starter_curve,
    HOVERBIKE_OT_build_road,
    HOVERBIKE_OT_add_ramp,
    HOVERBIKE_OT_import_heightmap,
    HOVERBIKE_OT_reload_track_json,
    HOVERBIKE_OT_bake_terrain_attrs,
    HOVERBIKE_OT_refresh_track_stats,
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
        update=_on_gate_prop_changed,
    )
    bpy.types.Scene.hoverbike_gate_half_width = FloatProperty(
        name="Gate half-width (m)",
        default=14.0,
        min=1.0,
        max=200.0,
        precision=1,
        update=_on_gate_prop_changed,
    )
    bpy.types.Scene.hoverbike_gate_height = FloatProperty(
        name="Gate height (m)",
        default=6.0,
        min=1.0,
        max=100.0,
        precision=1,
        update=_on_gate_prop_changed,
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
        description="Per-edge subdivisions of the water plane. Higher = smoother waves, slower rebuild.",
        default=80,
        min=8,
        max=400,
        update=_on_water_prop_changed,
    )
    bpy.types.Scene.hoverbike_water_time = FloatProperty(
        name="Wave time (s)",
        description="Simulation time the wave field is sampled at — 0 for canonical pose, scrub for variety.",
        default=0.0,
        min=-60.0,
        max=60.0,
        precision=2,
        update=_on_water_prop_changed,
    )
    bpy.types.Scene.hoverbike_turn_kappa = FloatProperty(
        name="Turn |κ| min (1/m)",
        description="Curvature threshold for a turn indicator. ~0.05 ≈ 20m-radius corner; lower = more indicators.",
        default=DEFAULT_TURN_KAPPA,
        min=0.001,
        max=2.0,
        precision=4,
        update=_on_turn_prop_changed,
    )
    bpy.types.Scene.hoverbike_turn_min_spacing = FloatProperty(
        name="Turn min spacing (m)",
        description="Minimum arc distance between consecutive turn indicators; collapses adjacent peaks.",
        default=DEFAULT_TURN_LOOKAHEAD,
        min=1.0,
        max=200.0,
        precision=1,
        update=_on_turn_prop_changed,
    )

    # Runtime terrain-shader tuning. These mirror constants in
    # ``src/engine/render/terrain-shader.ts``; ``hoverbike.export_track``
    # writes them into ``public/tracks/<id>.json`` so the runtime can
    # rebuild the material with the author's chosen values without
    # touching the .ts.
    bpy.types.Scene.hoverbike_shader_slope_start = FloatProperty(
        name="Slope start (cos θ)",
        description="Cosine of the slope angle below which terrain reads as the flat (sand/grass) ramp. 0.85 ≈ 30°.",
        default=0.85, min=0.0, max=1.0, precision=3,
    )
    bpy.types.Scene.hoverbike_shader_slope_end = FloatProperty(
        name="Slope end (cos θ)",
        description="Cosine of the slope angle above which terrain reads as full cliff/rock. 0.55 ≈ 55°.",
        default=0.55, min=0.0, max=1.0, precision=3,
    )
    bpy.types.Scene.hoverbike_shader_variation = FloatProperty(
        name="Variation strength",
        description="±brightness perturbation from the per-vertex value-noise. 0 = flat ramps, 0.3 = soft, 0.6 = strong.",
        default=0.30, min=0.0, max=1.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_wet_band = FloatProperty(
        name="Wet band (m)",
        description="Half-height of the |y|-mask that darkens the terrain colour around the waterline.",
        default=2.0, min=0.0, max=20.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_alt_min = FloatProperty(
        name="Altitude band min (m)",
        description="World-Y mapped to ramp position 0 (deepest abyssal blue / dark rock).",
        default=-50.0, min=-500.0, max=0.0, precision=1,
    )
    bpy.types.Scene.hoverbike_shader_alt_max = FloatProperty(
        name="Altitude band max (m)",
        description="World-Y mapped to ramp position 1 (volcanic top / brightest alpine).",
        default=120.0, min=0.0, max=500.0, precision=1,
    )
    bpy.types.Scene.hoverbike_shader_path_tint_r = FloatProperty(
        name="Path tint R", default=0.30, min=0.0, max=2.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_path_tint_g = FloatProperty(
        name="Path tint G", default=0.24, min=0.0, max=2.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_path_tint_b = FloatProperty(
        name="Path tint B", default=0.18, min=0.0, max=2.0, precision=2,
    )

    # Snap-spline-to-terrain hover height. Matches a typical hoverbike
    # ride height so the racing line sits just above the surface.
    bpy.types.Scene.hoverbike_snap_hover_height = FloatProperty(
        name="Snap hover (m)",
        description="Vertical clearance to lift each control point above the surface it lands on.",
        default=3.0, min=0.0, max=50.0, precision=2,
    )

    # Heightmap importer settings.
    bpy.types.Scene.hoverbike_heightmap_path = StringProperty(
        name="Last heightmap",
        description="Most recently imported heightmap file (pre-fills the file picker).",
        default="", subtype="FILE_PATH",
    )
    bpy.types.Scene.hoverbike_heightmap_size = FloatProperty(
        name="Map size (m)",
        description="Edge length of the imported terrain plane.",
        default=1024.0, min=16.0, max=8192.0, precision=1,
    )
    bpy.types.Scene.hoverbike_heightmap_height = FloatProperty(
        name="Δz (m)",
        description="Maximum vertical displacement at image luminance = 1.0.",
        default=120.0, min=1.0, max=2000.0, precision=1,
    )
    bpy.types.Scene.hoverbike_heightmap_base = FloatProperty(
        name="Base elevation (m)",
        description="World-Z offset applied to every vertex (use a negative value to seat the terrain below sea level).",
        default=-30.0, min=-500.0, max=500.0, precision=1,
    )
    bpy.types.Scene.hoverbike_heightmap_subdivisions = IntProperty(
        name="Subdivisions",
        description="Per-edge subdivisions of the imported plane. Higher = more terrain detail, more verts.",
        default=256, min=8, max=2048,
    )

    # Road-tool settings.
    bpy.types.Scene.hoverbike_road_width = FloatProperty(
        name="Road width (m)",
        description="Total width of the road strip; terrain inside this band flattens fully to the road.",
        default=8.0, min=0.5, max=80.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_lift = FloatProperty(
        name="Road lift (m)",
        description="Small vertical offset above terrain so the road's surface is visible against the ground.",
        default=0.15, min=0.0, max=5.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_blend_radius = FloatProperty(
        name="Blend radius (m)",
        description="Outer falloff band where terrain blends from flattened to natural via smoothstep.",
        default=6.0, min=0.0, max=50.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_samples = IntProperty(
        name="Samples",
        description="Number of arc-length samples along the road curve. Higher = smoother road, slower build.",
        default=64, min=4, max=512,
    )
    bpy.types.Scene.hoverbike_road_smooth_passes = IntProperty(
        name="Smoothing passes",
        description="1-2-1 binomial passes applied to the height profile so the road doesn't follow every terrain bump.",
        default=4, min=0, max=32,
    )

    # Ramp-tool settings.
    bpy.types.Scene.hoverbike_ramp_length = FloatProperty(
        name="Ramp length (m)",
        description="Total length of the ramp along its travel axis (+Y).",
        default=12.0, min=1.0, max=200.0, precision=2,
    )
    bpy.types.Scene.hoverbike_ramp_width = FloatProperty(
        name="Ramp width (m)",
        description="Width of the ramp along ±X.",
        default=8.0, min=0.5, max=80.0, precision=2,
    )
    bpy.types.Scene.hoverbike_ramp_height = FloatProperty(
        name="Peak height (m)",
        description="Height of the launch lip at the end of the ramp.",
        default=3.0, min=0.1, max=50.0, precision=2,
    )
    bpy.types.Scene.hoverbike_ramp_approach = FloatProperty(
        name="Approach (m)",
        description="Flat run-up at the start of the ramp before the kicker rises. 0 = wedge from y=0.",
        default=4.0, min=0.0, max=100.0, precision=2,
    )
    bpy.types.Scene.hoverbike_ramp_segments = IntProperty(
        name="Segments",
        description="Subdivisions along the ramp's length. More = smoother kicker curve.",
        default=12, min=2, max=128,
    )
    bpy.types.Scene.hoverbike_ramp_curved = BoolProperty(
        name="Curved kicker",
        description="Smoothstep height profile (natural launch tangent). Off = linear wedge.",
        default=True,
    )

    # Ghost-lap settings.
    bpy.types.Scene.hoverbike_ghost_speed = FloatProperty(
        name="Target speed (m/s)",
        description="Constant speed at which the ghost-bike traverses ai_spline_main.",
        default=GHOST_DEFAULT_SPEED_MS, min=1.0, max=200.0, precision=1,
    )
    bpy.types.Scene.hoverbike_ghost_fps = IntProperty(
        name="Playback FPS",
        description="Scene frame rate while ghost-lap is active. 24 fps reads as cinematic; 60 is buttery for tuning.",
        default=30, min=12, max=120,
    )

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

    for cls in reversed(_classes):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
    for prop in (
        "hoverbike_gate_spacing", "hoverbike_gate_half_width", "hoverbike_gate_height",
        "hoverbike_water_size", "hoverbike_water_subdivisions", "hoverbike_water_time",
        "hoverbike_turn_kappa", "hoverbike_turn_min_spacing",
        "hoverbike_shader_slope_start", "hoverbike_shader_slope_end",
        "hoverbike_shader_variation", "hoverbike_shader_wet_band",
        "hoverbike_shader_alt_min", "hoverbike_shader_alt_max",
        "hoverbike_shader_path_tint_r", "hoverbike_shader_path_tint_g",
        "hoverbike_shader_path_tint_b",
        "hoverbike_snap_hover_height",
        "hoverbike_heightmap_path", "hoverbike_heightmap_size",
        "hoverbike_heightmap_height", "hoverbike_heightmap_base",
        "hoverbike_heightmap_subdivisions",
        "hoverbike_ghost_speed", "hoverbike_ghost_fps",
        "hoverbike_road_width", "hoverbike_road_lift",
        "hoverbike_road_blend_radius", "hoverbike_road_samples",
        "hoverbike_road_smooth_passes",
        "hoverbike_ramp_length", "hoverbike_ramp_width",
        "hoverbike_ramp_height", "hoverbike_ramp_approach",
        "hoverbike_ramp_segments", "hoverbike_ramp_curved",
    ):
        if hasattr(bpy.types.Scene, prop):
            try:
                delattr(bpy.types.Scene, prop)
            except Exception:
                pass


if __name__ == "__main__":
    register()
