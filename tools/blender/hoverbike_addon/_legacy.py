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
    (re.compile(r"^boost_(\d+)$"), "boost_pad"),
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

    # Boost pad sanity. Each boost_NN empty needs positive half_width /
    # half_depth — the runtime's `boostPadSystem` rejects non-positive
    # dimensions. Strength can be ≥1 (≤1 is a no-op pad which is silly
    # but not invalid).
    for bp in by_kind.get("boost_pad", []):
        for prop in ("half_width", "half_depth", "strength"):
            if bp.get(prop) is None:
                errors.append(f"{bp.name}: missing custom property '{prop}'")
        hw = bp.get("half_width")
        hd = bp.get("half_depth")
        if isinstance(hw, (int, float)) and hw <= 0:
            errors.append(f"{bp.name}: half_width must be > 0 (got {hw}).")
        if isinstance(hd, (int, float)) and hd <= 0:
            errors.append(f"{bp.name}: half_depth must be > 0 (got {hd}).")

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
        # Build a runtime quaternion from the gate's Blender Z-euler so
        # the gate's "forward" axis (cp.rotation · +Z in the runtime
        # frame) matches the racing-line tangent the author set up.
        # Without this, every template-authored checkpoint defaulted to
        # facing three.js +Z (= Blender -Y, south) and the AI couldn't
        # cross any gate whose tangent had a non-south component —
        # i.e., every east/west-running stretch.
        yaw = _yaw_from_z_euler(cp)
        half = 0.5 * yaw
        checkpoints.append(
            {
                "index": i,
                "position": _b2t(loc.x, loc.y, loc.z),
                # Blender +X / +Y / +Z → three.js +X / +Z / -Y; a rotation
                # around Blender +Z (the yaw axis) becomes a rotation around
                # three.js +Y of the same magnitude.
                "rotation": {
                    "x": 0.0,
                    "y": float(math.sin(half)),
                    "z": 0.0,
                    "w": float(math.cos(half)),
                },
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

    # Boost pads. Empty's +Y axis (Blender forward) maps to three.js +Z
    # (the runtime "boost direction" axis); rotation_euler.z is the yaw
    # in the horizontal plane. Right-handed rotation around Blender +Z by
    # `yaw` is identical to right-handed rotation around three.js +Y by
    # the same angle (both up axes; XY plane is preserved through the
    # b2t mapping), so the quaternion is `(0, sin(y/2), 0, cos(y/2))`
    # without a sign flip — same convention used by `start.yaw` so the
    # bike spawn pose and pad-direction code agree on what "yaw" means.
    boost_pads: list[dict[str, Any]] = []
    for bp in by_kind.get("boost_pad", []):
        loc = bp.matrix_world.translation
        yaw = float(bp.rotation_euler.z)
        half = yaw * 0.5
        qy = math.sin(half)
        qw = math.cos(half)
        boost_pads.append(
            {
                "position": _b2t(loc.x, loc.y, loc.z),
                "rotation": {"x": 0.0, "y": qy, "z": 0.0, "w": qw},
                "halfWidth": float(bp.get("half_width", 3.0)),
                "halfDepth": float(bp.get("half_depth", 6.0)),
                "strength": float(bp.get("strength", 1.5)),
            }
        )

    water = next(iter(by_kind.get("water", [])), None)
    # Water surface y comes from the water_volume_main empty's Z position
    # (Blender Z is the same up axis as three.js Y after the yup export),
    # so authors drag the empty up/down in the viewport to change the
    # sea level. Wave parameters live as custom props on the same empty.
    water_height = (
        float(water.matrix_world.translation.z) if water is not None else 0.0
    )
    water_block: dict[str, float] = {
        "height": water_height,
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
        # State-of-the-art coloration extras. Optional in the runtime
        # (terrain-shader.ts falls back to defaults), so we only emit
        # them when the new properties exist on the scene — older
        # .blends opened in this addon get fresh defaults the moment
        # they're saved, but never emit garbage values.
        if hasattr(scn, "hoverbike_shader_warp_strength"):
            shader_block["warpStrength"] = float(scn.hoverbike_shader_warp_strength)
            shader_block["macroScale"] = float(scn.hoverbike_shader_macro_scale)
            shader_block["microScale"] = float(scn.hoverbike_shader_micro_scale)
            shader_block["altJitter"] = float(scn.hoverbike_shader_alt_jitter)
            shader_block["screeBand"] = float(scn.hoverbike_shader_scree_band)
            shader_block["saturation"] = float(scn.hoverbike_shader_saturation)
            shader_block["triplanar"] = float(scn.hoverbike_shader_triplanar)

    laps = int(getattr(scn, "hoverbike_laps_to_finish", 3) or 3)
    body: dict[str, Any] = {
        "id": track_id,
        "name": track_id,
        "lapsToFinish": laps,
        "environmentGlb": glb_url,
        "water": water_block,
        "start": {"position": start_pos, "yaw": start_yaw},
        "checkpoints": checkpoints,
        "aiSplines": [{"id": "main", "points": [], "anchors": anchors}],
        "pickupSpawns": pickups,
        "boostPads": boost_pads,
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
    "lapsToFinish",
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

    laps = data.get("lapsToFinish")
    if isinstance(laps, int) and laps > 0 and hasattr(scene, "hoverbike_laps_to_finish"):
        scene.hoverbike_laps_to_finish = int(laps)
        summary["lapsToFinish"] = int(laps)

    ts = data.get("terrainShader")
    if isinstance(ts, dict):
        for key, prop in (
            ("altMin", "hoverbike_shader_alt_min"),
            ("altMax", "hoverbike_shader_alt_max"),
            ("slopeStart", "hoverbike_shader_slope_start"),
            ("slopeEnd", "hoverbike_shader_slope_end"),
            ("variation", "hoverbike_shader_variation"),
            ("wetBand", "hoverbike_shader_wet_band"),
            ("warpStrength", "hoverbike_shader_warp_strength"),
            ("macroScale", "hoverbike_shader_macro_scale"),
            ("microScale", "hoverbike_shader_micro_scale"),
            ("altJitter", "hoverbike_shader_alt_jitter"),
            ("screeBand", "hoverbike_shader_scree_band"),
            ("saturation", "hoverbike_shader_saturation"),
            ("triplanar", "hoverbike_shader_triplanar"),
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
        # JSON height → Blender Z (both are world-up). The empty's
        # transform is the source of truth in the .blend; custom props
        # carry wave amp / freq.
        h = water.get("height")
        if isinstance(h, (int, float)):
            vol.location.z = float(h)
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
    # Same opt-in rule for boost pads: if the .blend has any `boost_NN`
    # empties, Blender owns the boostPads list. Otherwise the editor's
    # pad placements stay intact through re-exports.
    has_boost_empties = any(
        re.match(r"^boost_\d+$", o.name) and is_object_visible(o)
        for o in bpy.data.objects
    )
    if has_cp_empties and "checkpoints" in derived:
        merged["checkpoints"] = derived["checkpoints"]
    if has_pickup_empties and "pickupSpawns" in derived:
        merged["pickupSpawns"] = derived["pickupSpawns"]
    if has_boost_empties and "boostPads" in derived:
        merged["boostPads"] = derived["boostPads"]
    # `lapsToFinish` defaults to 3 in `derive_track_json`; keep an
    # existing JSON value if the editor set something else.
    if "lapsToFinish" not in merged and "lapsToFinish" in derived:
        merged["lapsToFinish"] = derived["lapsToFinish"]
    return merged


def _id_to_display_name(track_id: str) -> str:
    """Title-case a dashed id for the menu's track-picker card.

    `oval-loop` → `Oval Loop`. The Blender export doesn't have a place
    for the author to type a display name yet; the id is the only signal.
    """
    return " ".join(part.capitalize() for part in track_id.split("-") if part)


def _upsert_manifest_track(repo_root: str, track_id: str, glb_url: str, json_path: str) -> None:
    """Add or refresh the track's entry in `public/assets/manifest.json`.

    The manifest is the canonical track list the in-game menu reads
    (via `loadManifest()` → `buildTrackList()`). Tracks authored
    headlessly by `pnpm gen:tracks` get listed automatically because the
    builder writes the manifest. Tracks authored interactively in
    Blender used to *not* show up — the user had to remember to manually
    edit manifest.json or live with `?track=<id>` URLs. This helper
    closes that gap by upserting the entry after every Export.

    Existing entries by the same `id` are replaced; entries for other
    tracks are preserved. The on-disk write uses a deterministic JSON
    layout (`indent=2`, trailing newline) so diffs stay clean.
    """
    manifest_path = os.path.join(repo_root, "public", "assets", "manifest.json")
    data: dict[str, Any] = {
        "schemaVersion": 1,
        "bikes": [],
        "props": [],
        "riders": [],
        "tracks": [],
    }
    if os.path.isfile(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as fh:
                existing = json.load(fh)
            if isinstance(existing, dict):
                data = existing
        except (OSError, ValueError):
            # Fall through with the empty default; the next write fixes
            # the file even if it was corrupt.
            pass
    data.setdefault("bikes", [])
    data.setdefault("props", [])
    data.setdefault("riders", [])
    tracks = data.setdefault("tracks", [])
    spec_path_rel = os.path.relpath(json_path, repo_root).replace("\\", "/")
    new_entry = {
        "id": track_id,
        "displayName": _id_to_display_name(track_id),
        "url": glb_url,
        "specPath": spec_path_rel,
    }
    # Preserve a hand-edited displayName if the entry already has one
    # (the auto-derived `_id_to_display_name` is just a fallback).
    for entry in tracks:
        if entry.get("id") == track_id:
            existing_name = entry.get("displayName")
            if isinstance(existing_name, str) and existing_name and existing_name != track_id:
                new_entry["displayName"] = existing_name
            break
    tracks = [e for e in tracks if e.get("id") != track_id]
    tracks.append(new_entry)
    tracks.sort(key=lambda e: e.get("id", ""))
    data["tracks"] = tracks
    data["schemaVersion"] = 1
    os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")


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


# ── Water (moved) ──────────────────────────────────────────────────────────
#
# Water authoring + preview live in `hoverbike_addon/water.py`. Constants
# re-exported below so the centralised debounce timer in this file can
# refer to them without a load-time cycle.

from . import water as _water_mod
from .water import WATER_PREVIEW_COLLECTION, WATER_VOLUME_NAME  # noqa: E402



# ── Turn indicators (Item 3 — turn-indicator sub-piece) ───────────────────
#
# Samples the AI spline's polyline, finds peaks of signed curvature in
# the horizontal plane, and places chevron-shaped arrow gizmos at those
# points facing in the direction of the bend. The math is sim-safe and
# could mirror to TS later if we ever want auto-placed turn arrows in
# the runtime, but today this is preview-only.

TURN_PREVIEW_COLLECTION = "_hoverbike_turn_preview"
TURN_PREVIEW_MESH = "_hoverbike_turn_chevron"

# Default curvature threshold in radians-per-metre. ~0.02 ≈ 50 m corner
# radius; tighter than that gets an indicator. The previous default of
# 0.02 missed gentle ovals (200-400 m anchor spacing → broad arcs that
# never crossed the threshold) so authors saw zero chevrons placed and
# assumed the operator was broken. Lowering to 0.01 picks up ~100 m
# radius bends, which is the smallest sweep most JetMoto-style tracks
# author. Authors tune up if a track has too many indicators.
DEFAULT_TURN_KAPPA = 0.01
DEFAULT_TURN_LOOKAHEAD = 20.0  # min metres between consecutive markers
TURN_INDICATOR_MATERIAL_NAME = "mat_turn_indicator_preview"


def _turn_indicator_material() -> bpy.types.Material:
    """Bright orange unshaded material so the chevron reads against any
    terrain colour at any time of day in the viewport. Same family as
    `mat_track_ramp` so the eye groups them as track features."""
    mat = bpy.data.materials.get(TURN_INDICATOR_MATERIAL_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(TURN_INDICATOR_MATERIAL_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (1.0, 0.42, 0.05, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.4
        # Self-emit a little so the chevron stays visible in shaded
        # viewport without depending on scene lighting.
        try:
            bsdf.inputs["Emission Color"].default_value = (1.0, 0.42, 0.05, 1.0)
            bsdf.inputs["Emission Strength"].default_value = 1.5
        except KeyError:
            pass
    return mat


def _turn_chevron_mesh(
    name: str,
    *,
    width: float = 12.0,
    depth: float = 6.0,
    height: float = 2.5,
    thickness: float = 0.4,
):
    """Solid chevron arrow that points along local +X (the bend
    direction). Width = wingspan across, depth = how far the tip
    extends ahead of the wing roots, height = vertical extrusion so the
    sign reads as a 3D pylon rather than a flat decal lying on the
    ground.

    Earlier iterations of this gizmo were a 2.5 m wireframe lying flat
    in XY, invisible against terrain at track scale. Solidifying and
    standing it upright closes the "I rebuilt the indicators but
    don't see them" complaint."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    hw = width * 0.5
    d = depth
    t = thickness
    h = height
    # Footprint (top view, +X to the right = bend direction):
    #
    #   wing-back-T ────────── wing-tip-T
    #         │                       \
    #         │           tip-T ─────── tip-T+depth
    #         │                       /
    #   wing-back-B ────────── wing-tip-B
    #
    # 8 verts on each Z slab (low + high) → 16 total. Twelve quads:
    # top, bottom, and outer rim.
    base = [
        (-d * 0.4, -hw,        0.0),  # 0 back-left
        ( 0.0,     -hw * 0.55, 0.0),  # 1 wing-root-left
        ( d,        0.0,       0.0),  # 2 tip
        ( 0.0,      hw * 0.55, 0.0),  # 3 wing-root-right
        (-d * 0.4,  hw,        0.0),  # 4 back-right
        (-d * 0.1,  hw * 0.45, 0.0),  # 5 inner-right
        (-d * 0.1,  0.0,       0.0),  # 6 inner-tail
        (-d * 0.1, -hw * 0.45, 0.0),  # 7 inner-left
    ]
    verts: list[tuple[float, float, float]] = []
    # Bottom slab at z=0, top slab at z=h. Pylon stands +Z up.
    for x, y, _z in base:
        verts.append((x, y, 0.0))
    for x, y, _z in base:
        verts.append((x, y, h))
    # Faces: top + bottom + 8 side rims
    n = 8
    faces: list[tuple[int, ...]] = []
    # Top face (CCW seen from +Z)
    faces.append((n + 0, n + 1, n + 2, n + 3, n + 4, n + 5, n + 6, n + 7))
    # Bottom face (reverse winding)
    faces.append((7, 6, 5, 4, 3, 2, 1, 0))
    # Side quads — one per outer edge of the chevron silhouette
    for i in range(n):
        a = i
        b = (i + 1) % n
        faces.append((a, b, n + b, n + a))
    me.from_pydata(verts, [], faces)
    me.update()
    for poly in me.polygons:
        poly.use_smooth = False
    me.materials.append(_turn_indicator_material())
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
        # Sit the pylon's base on (or just above) the spline's z so it
        # reads as planted on the surface. The chevron mesh is built
        # standing upright (+Z height), so no extra fix-up rotation is
        # needed beyond the in-plane bend-direction rotation.
        obj.location = (p["position"][0], p["position"][1], p["position"][2] + 0.1)
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = _chevron_rotation(p["perp"])
        obj.hide_render = True
        # Don't ghost-through-terrain by default. The chevron is solid
        # and big enough to be legible without the X-ray hack.
        obj.show_in_front = False
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
        threshold = float(scene.hoverbike_turn_kappa)
        summary = _rebuild_turn_indicators(
            scene,
            kappa_threshold=threshold,
            min_spacing_m=float(scene.hoverbike_turn_min_spacing),
        )
        if summary["peak_count"] == 0:
            # Common cause: threshold higher than the track's tightest
            # corner. Surface the hint so the author isn't left
            # wondering why nothing appeared.
            max_k = summary["max_abs_kappa"]
            self.report(
                {"WARNING"},
                f"No turns placed — strongest curvature on ai_spline_main is "
                f"|κ|={max_k:.4f} 1/m, below threshold {threshold:.4f}. Lower "
                f"the |κ| min in the panel, or sharpen the spline's bends.",
            )
        else:
            self.report(
                {"INFO"},
                f"Placed {summary['peak_count']} turn indicators "
                f"(max |κ|={summary['max_abs_kappa']:.3f}, threshold {threshold:.3f}).",
            )
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


# ── Terrain sculpt helpers ─────────────────────────────────────────────────
#
# The bigger templates (HV_Island, HV_Dunes, HV_Mesa) author terrain
# parametrically through Geometry Nodes. Sculpting that procedural output
# is a no-op because the GN graph re-evaluates after every brush stroke.
# These operators flip the workflow to be sculpt-friendly: apply the
# modifier stack so the verts become editable, then drop the user into
# Sculpt Mode on the resulting mesh.
#
# Smooth-pass operator gives a one-click way to soften an entire terrain
# without learning Blender's brush UI. Useful right after `Apply Mods`
# when the procedural sliver-noise looks too aggressive at race scale.


def _sculptable_terrain(context) -> bpy.types.Object | None:
    """Pick the terrain mesh sculpt operations should target. Prefers the
    user's active selection if it's a `kind=track` mesh; falls back to
    the largest one in the scene. Returns None if no candidate is found."""
    ao = context.active_object
    if (
        ao is not None
        and ao.type == "MESH"
        and ao.get("kind") == "track"
    ):
        return ao
    return _largest_terrain_mesh()


class HOVERBIKE_OT_apply_terrain_modifiers(Operator):
    """Bake every viewport-enabled modifier on the terrain mesh into its
    vertex data. After this, the `HV_Island` (or any other procedural)
    GN graph stops contributing — the mesh is a plain editable surface
    and Sculpt Mode brushes work as expected. One-way: re-tuning the
    procedural sliders is no longer possible. Save the .blend first."""

    bl_idname = "hoverbike.apply_terrain_modifiers"
    bl_label = "Apply Terrain Modifiers"
    bl_description = (
        "Bake all viewport-enabled modifiers (HV_Island, etc.) into the "
        "terrain mesh so vertex edits / sculpt brushes survive evaluation"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        terrain = _sculptable_terrain(context)
        if terrain is None:
            self.report({"ERROR"}, "No `kind=track` terrain mesh found. Select your terrain first.")
            return {"CANCELLED"}
        active_mods = _terrain_active_modifiers(terrain)
        if not active_mods:
            self.report({"INFO"}, f"{terrain.name}: no active modifiers to apply.")
            return {"FINISHED"}
        applied = _apply_all_viewport_modifiers(terrain)
        self.report({"INFO"}, f"Applied {len(applied)} modifier(s) on {terrain.name}: {', '.join(applied)}.")
        return {"FINISHED"}


class HOVERBIKE_OT_enter_sculpt_mode(Operator):
    """Switch into Sculpt Mode on the active terrain. If the terrain
    still has procedural modifiers in the stack, this errors out — the
    GN output would overwrite every brush stroke. Run *Apply Terrain
    Modifiers* first.

    Sculpt Mode unlocks Blender's full brush set: Draw, Smooth,
    Flatten, Inflate, Grab, Crease. The Hoverbike addon doesn't ship
    custom brushes; the goal here is just to remove the friction of
    finding the right object + mode for terrain shaping."""

    bl_idname = "hoverbike.enter_sculpt_mode"
    bl_label = "Sculpt Terrain"
    bl_description = "Select the terrain and switch into Sculpt Mode for hand-shaping"
    bl_options = {"REGISTER"}

    def execute(self, context):
        terrain = _sculptable_terrain(context)
        if terrain is None:
            self.report({"ERROR"}, "No `kind=track` terrain mesh found.")
            return {"CANCELLED"}
        if _terrain_active_modifiers(terrain):
            self.report(
                {"ERROR"},
                f"{terrain.name} has active modifiers — sculpt brushes won't stick. "
                "Click *Apply Terrain Modifiers* first.",
            )
            return {"CANCELLED"}
        # Make sure the terrain is the active + selected object — Sculpt
        # Mode operates on the active object only.
        for o in context.selected_objects:
            o.select_set(False)
        terrain.select_set(True)
        context.view_layer.objects.active = terrain
        try:
            bpy.ops.object.mode_set(mode="SCULPT")
        except RuntimeError as e:
            self.report({"ERROR"}, f"Couldn't enter Sculpt Mode: {e}")
            return {"CANCELLED"}
        self.report(
            {"INFO"},
            f"Sculpt Mode on {terrain.name}: F=brush size, Shift+F=strength, Ctrl=invert.",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_smooth_terrain(Operator):
    """Run a Laplacian-smoothing pass over every vertex on the terrain.
    Cheaper than a manual smooth-brush sweep when you just want to
    soften the entire heightfield by one notch.

    Iteration count and per-pass weight are scene properties so the
    user can dial in subtle (1 iter, 0.3 weight) vs. heavy (8 iters,
    0.8 weight) smoothing without leaving the panel."""

    bl_idname = "hoverbike.smooth_terrain"
    bl_label = "Smooth Terrain"
    bl_description = "Apply a global Laplacian smoothing pass to the terrain mesh"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        terrain = _sculptable_terrain(context)
        if terrain is None:
            self.report({"ERROR"}, "No `kind=track` terrain mesh found.")
            return {"CANCELLED"}
        if _terrain_active_modifiers(terrain):
            self.report(
                {"ERROR"},
                f"{terrain.name} has active modifiers — smooth would be overwritten. Apply first.",
            )
            return {"CANCELLED"}
        scene = context.scene
        iters = max(1, int(scene.hoverbike_sculpt_smooth_iters))
        weight = max(0.0, min(1.0, float(scene.hoverbike_sculpt_smooth_weight)))

        # Build a vertex-neighbour map once — one pass over the edges.
        me = terrain.data
        neighbours: list[list[int]] = [[] for _ in range(len(me.vertices))]
        for e in me.edges:
            a, b = e.vertices
            neighbours[a].append(b)
            neighbours[b].append(a)
        # Z-only smoothing: keep XY locked so the heightfield stays a
        # heightfield (no horizontal drift). Each pass averages each
        # vertex's Z toward the mean of its neighbours.
        zs = [v.co.z for v in me.vertices]
        for _ in range(iters):
            new_zs = list(zs)
            for i, nbrs in enumerate(neighbours):
                if not nbrs:
                    continue
                avg = sum(zs[j] for j in nbrs) / len(nbrs)
                new_zs[i] = zs[i] * (1.0 - weight) + avg * weight
            zs = new_zs
        for i, v in enumerate(me.vertices):
            v.co.z = zs[i]
        me.update()
        self.report({"INFO"}, f"Smoothed {terrain.name}: {iters} pass(es) × {weight:.2f} weight.")
        return {"FINISHED"}


class HOVERBIKE_OT_subdivide_terrain(Operator):
    """Subdivide the terrain mesh once (each face becomes 4). Useful
    after `Apply Terrain Modifiers` if the procedural mesh is too coarse
    to sculpt detail at race scale. Doubles vertex count per click."""

    bl_idname = "hoverbike.subdivide_terrain"
    bl_label = "Subdivide Terrain"
    bl_description = "Subdivide the terrain mesh once (each face → 4)"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        terrain = _sculptable_terrain(context)
        if terrain is None:
            self.report({"ERROR"}, "No `kind=track` terrain mesh found.")
            return {"CANCELLED"}
        if _terrain_active_modifiers(terrain):
            self.report(
                {"ERROR"},
                f"{terrain.name} has active modifiers — subdivide first applies them.",
            )
            return {"CANCELLED"}
        for o in context.selected_objects:
            o.select_set(False)
        terrain.select_set(True)
        context.view_layer.objects.active = terrain
        prev_mode = terrain.mode
        try:
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.mesh.subdivide(number_cuts=1)
        except RuntimeError as e:
            self.report({"ERROR"}, f"Subdivide failed: {e}")
            return {"CANCELLED"}
        finally:
            try:
                bpy.ops.object.mode_set(mode=prev_mode)
            except RuntimeError:
                pass
        self.report({"INFO"}, f"Subdivided {terrain.name} → {len(terrain.data.vertices)} verts.")
        return {"FINISHED"}


class HOVERBIKE_OT_raise_lower_terrain(Operator):
    """Raise (or lower) the terrain inside a circle around the 3D cursor.
    Falls off with smoothstep from the cursor's XY position out to the
    configured radius. Quick way to bump up a hill or carve a basin
    without learning the brush UI.

    Direction (raise vs. lower) is the operator's `lower` argument,
    bound from the panel via two operator instances. Magnitude and
    radius are scene properties shared with the smooth tool."""

    bl_idname = "hoverbike.raise_lower_terrain"
    bl_label = "Raise/Lower Terrain"
    bl_description = "Raise or lower the terrain inside a circle around the 3D cursor"
    bl_options = {"REGISTER", "UNDO"}

    lower: BoolProperty(  # type: ignore[valid-type]
        name="Lower",
        description="Push terrain DOWN by `Δz` instead of up. Same falloff.",
        default=False,
    )

    def execute(self, context):
        terrain = _sculptable_terrain(context)
        if terrain is None:
            self.report({"ERROR"}, "No `kind=track` terrain mesh found.")
            return {"CANCELLED"}
        if _terrain_active_modifiers(terrain):
            self.report(
                {"ERROR"},
                f"{terrain.name} has active modifiers — apply them before raising/lowering.",
            )
            return {"CANCELLED"}
        scene = context.scene
        radius = float(scene.hoverbike_sculpt_radius)
        magnitude = float(scene.hoverbike_sculpt_magnitude)
        if self.lower:
            magnitude = -magnitude
        cursor = scene.cursor.location
        cx, cy = float(cursor.x), float(cursor.y)
        me = terrain.data
        mw = terrain.matrix_world
        mw_inv = mw.inverted_safe()
        moved = 0
        for v in me.vertices:
            world = mw @ v.co
            d = math.hypot(world.x - cx, world.y - cy)
            if d >= radius:
                continue
            t = max(0.0, min(1.0, (radius - d) / radius))
            falloff = t * t * (3.0 - 2.0 * t)  # smoothstep
            new_world = mathutils.Vector((world.x, world.y, world.z + magnitude * falloff))
            v.co = mw_inv @ new_world
            moved += 1
        me.update()
        verb = "Lowered" if self.lower else "Raised"
        self.report(
            {"INFO"},
            f"{verb} {moved} verts within {radius:.1f}m of cursor (Δz peak {magnitude:+.2f}m).",
        )
        return {"FINISHED"}


# ── Spline-aligned cursor + ramp placement helpers ────────────────────────
#
# Authoring ramps along a spline used to mean computing the tangent in
# Python and setting the 3D cursor's rotation by hand. These operators
# replace that ritual:
#
#   - HOVERBIKE_OT_cursor_snap_to_spline_t  → moves the 3D cursor to a
#     parameter t in [0, 1] on `ai_spline_main` (or another curve via
#     scene prop), with rotation aligned to the racing tangent.
#   - HOVERBIKE_OT_add_ramp_at_spline_t     → snaps the cursor, then
#     immediately drops a ramp via `hoverbike.add_ramp`. One-click.
#   - HOVERBIKE_OT_auto_place_ramps         → reuses the curvature-peak
#     detector from the turn-indicator operator to spread ramps across
#     the spline at the corners that need them most.


def _yaw_from_tangent_xy(tx: float, ty: float) -> float:
    """Z-axis rotation that makes Blender's +Y (ramp / asset forward)
    align with the (tx, ty) tangent. Identity rotation maps +Y to
    world +Y; we want +Y to map to (tx, ty), so α = atan2(-tx, ty)."""
    return math.atan2(-tx, ty)


def _sample_curve_at_t(curve_obj: bpy.types.Object, t: float) -> dict | None:
    """Return {x, y, z, tx, ty} at parameter t in [0, 1] along the
    horizontal arc length of `curve_obj`'s first spline. Same sampling
    as the road tool so cursor / ramp placement lines up with the
    road. Returns None for degenerate curves."""
    raw = _sample_curve_to_polyline(curve_obj)
    if len(raw) < 2:
        return None
    cum = [0.0]
    for i in range(len(raw) - 1):
        a, b = raw[i], raw[i + 1]
        cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    total = cum[-1]
    if total <= 0:
        return None
    t = max(0.0, min(1.0 - 1e-6, float(t)))
    target = t * total
    j = 0
    while j < len(cum) - 1 and cum[j + 1] < target:
        j += 1
    seg_len = cum[j + 1] - cum[j] if (j + 1) < len(cum) else 1.0
    frac = (target - cum[j]) / seg_len if seg_len > 0 else 0.0
    a = raw[j]
    b = raw[j + 1] if (j + 1) < len(raw) else raw[j]
    x = a[0] + (b[0] - a[0]) * frac
    y = a[1] + (b[1] - a[1]) * frac
    z = a[2] + (b[2] - a[2]) * frac
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    tl = math.hypot(dx, dy) or 1.0
    return {"x": x, "y": y, "z": z, "tx": dx / tl, "ty": dy / tl}


def _spline_source_for_placement(scene) -> bpy.types.Object | None:
    """Resolve the curve placement operators should sample. Mirrors the
    road tool's preference order so `ai_spline_main` is the natural
    racing-line source when the user hasn't authored a separate road."""
    name = getattr(scene, "hoverbike_placement_curve_name", "") or "ai_spline_main"
    obj = bpy.data.objects.get(name)
    if obj is not None and obj.type == "CURVE":
        return obj
    # Fall back to the road curve if the AI spline isn't there.
    return _resolve_road_curve()


def _cursor_road_z_at(scene, x: float, y: float, fallback_z: float) -> float:
    """Cast down at (x, y) to find what the bike would land on. Used
    to seat a ramp's base on the road's surface (so the wedge isn't
    floating mid-air, and isn't buried in the slab either)."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    origin = mathutils.Vector((x, y, 10000.0))
    down = mathutils.Vector((0.0, 0.0, -1.0))
    hit, loc, *_ = scene.ray_cast(depsgraph, origin, down)
    return float(loc.z) if hit else fallback_z


class HOVERBIKE_OT_cursor_snap_to_spline(Operator):
    """Move the 3D cursor to `ai_spline_main` at the configured
    parameter `t` in [0, 1], with rotation_z aligned to the racing
    tangent. Useful for placing props, decorations, gates, or anything
    else that should sit on the racing line at a known fraction along
    the lap. Cursor Z lands on the road / terrain surface beneath
    the sample so the wedge sits flush."""

    bl_idname = "hoverbike.cursor_snap_to_spline"
    bl_label = "Cursor → Spline"
    bl_description = "Move the 3D cursor to a parameter t on the racing line, aligned tangent-forward"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        curve = _spline_source_for_placement(scene)
        if curve is None:
            self.report({"ERROR"}, "No source curve found (need `ai_spline_main` or `road_curve_main`).")
            return {"CANCELLED"}
        t = float(scene.hoverbike_placement_t)
        s = _sample_curve_at_t(curve, t)
        if s is None:
            self.report({"ERROR"}, f"Couldn't sample {curve.name!r} at t={t}.")
            return {"CANCELLED"}
        z = _cursor_road_z_at(scene, s["x"], s["y"], s["z"])
        scene.cursor.location = (s["x"], s["y"], z)
        scene.cursor.rotation_euler = (0.0, 0.0, _yaw_from_tangent_xy(s["tx"], s["ty"]))
        self.report({"INFO"}, f"Cursor → {curve.name} @ t={t:.3f} ({s['x']:.1f}, {s['y']:.1f}, {z:.2f}).")
        return {"FINISHED"}


class HOVERBIKE_OT_snap_starts_to_spline(Operator):
    """Reposition ``start_00`` and ``start_01`` on the racing line at
    the configured parameter ``t``, lined up perpendicular to the
    spline tangent with the configured grid spacing between them.

    Replaces the per-track Python boilerplate every headless track
    seeder used to re-implement to seed a start line. Picks the
    parameter from ``Spline t`` and the lateral spacing from
    ``Start spacing (m)`` (both in the Spline tools panel).

    Honors the runtime yaw convention used by the existing seed
    templates (``yaw = atan2(tx, ty)``) — the empty's visual
    orientation in Blender will not point along the racing tangent
    because of the Blender↔three.js axis-frame mismatch, but the
    exported JSON yaw is correct.

    Same water-aware surface rule as ``snap_spline_to_terrain``: the
    start's Z lands at ``max(terrain_z, water_z) + hover``. Tracks
    that race through a canyon below water (alpine-sprint,
    canyon-run) spawn cleanly on the river surface rather than below
    it. Preview gizmo collections are excluded during the raycast so
    the cast can't catch a water-preview mesh."""

    bl_idname = "hoverbike.snap_starts_to_spline"
    bl_label = "Snap Starts to Spline"
    bl_description = (
        "Re-derive start_00 / start_01 positions from ai_spline_main at "
        "parameter t, perpendicular to the racing tangent"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        curve = _spline_source_for_placement(scene)
        if curve is None:
            self.report({"ERROR"}, "No source curve found (need `ai_spline_main` or `road_curve_main`).")
            return {"CANCELLED"}
        t = float(scene.hoverbike_placement_t)
        s = _sample_curve_at_t(curve, t)
        if s is None:
            self.report({"ERROR"}, f"Couldn't sample {curve.name!r} at t={t}.")
            return {"CANCELLED"}

        spacing = float(getattr(scene, "hoverbike_start_grid_spacing", 4.0) or 4.0)
        z_hover = float(scene.hoverbike_snap_hover_height)

        # Find the drivable Z beneath the spline sample. Hide preview
        # collections so the cast can't catch a water-preview mesh, then
        # clamp the result to max(terrain, water) — same rule as
        # snap_spline_to_terrain, so a start in an underwater canyon
        # spawns on the river surface instead of below it.
        vol = bpy.data.objects.get("water_volume_main")
        water_z = float(vol.matrix_world.translation.z) if vol is not None else float("-inf")
        origin = mathutils.Vector((s["x"], s["y"], 10000.0))
        down = mathutils.Vector((0.0, 0.0, -1.0))
        with _PreviewCollectionsHidden(bpy.context.view_layer):
            bpy.context.view_layer.update()
            depsgraph = bpy.context.evaluated_depsgraph_get()
            hit, loc, *_ = scene.ray_cast(depsgraph, origin, down)
        terrain_z = float(loc.z) if hit else s["z"]
        surface_z = max(terrain_z, water_z)
        if surface_z == float("-inf"):
            surface_z = s["z"]
        clamped_to_water = water_z > terrain_z and hit
        target_z = surface_z + z_hover

        tx, ty = s["tx"], s["ty"]
        rx, ry = ty, -tx
        # Runtime yaw convention (see template-island docstring). This
        # value, written into start.rotation_euler.z, round-trips through
        # `_yaw_from_z_euler` → JSON → runtime, where the bike spawns
        # facing along (tx, ty).
        yaw = math.atan2(tx, ty)

        snapped = 0
        for i, off in enumerate([-spacing * 0.5, +spacing * 0.5]):
            name = f"start_{i:02d}"
            obj = bpy.data.objects.get(name)
            if obj is None:
                continue
            obj.location = (s["x"] + rx * off, s["y"] + ry * off, target_z)
            obj.rotation_euler = (0.0, 0.0, yaw)
            obj["start_t"] = float(t)
            snapped += 1

        if snapped == 0:
            self.report({"ERROR"}, "No `start_00` / `start_01` empties found in the scene.")
            return {"CANCELLED"}
        water_note = " (clamped to water surface)" if clamped_to_water else ""
        self.report(
            {"INFO"},
            f"Snapped {snapped} starts to {curve.name} @ t={t:.3f}"
            f"{water_note} ({spacing:.1f}m apart, hover {z_hover:.1f}m).",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_add_ramp_at_spline_t(Operator):
    """Combine *Cursor → Spline* with *Add Ramp*. Snaps the cursor to
    the configured parameter t on the racing line, then drops a ramp
    aligned to the tangent. Repeated invocations with different `t`
    values are the fastest way to litter a track with jumps."""

    bl_idname = "hoverbike.add_ramp_at_spline_t"
    bl_label = "Add Ramp at t"
    bl_description = "Snap cursor to t on the racing line, then drop a tangent-aligned ramp"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        # Just delegate — Blender's undo wraps both into a single step.
        snap = bpy.ops.hoverbike.cursor_snap_to_spline()
        if snap != {"FINISHED"}:
            return snap
        return bpy.ops.hoverbike.add_ramp()


class HOVERBIKE_OT_auto_place_ramps(Operator):
    """Place ramps automatically at the high-curvature points along
    `ai_spline_main`. Reuses the same signed-curvature peak detector
    that powers the Turn Indicators preview, so ramps land at the
    same hand-of-god corners the chevrons mark. Each ramp is rotated
    tangent to the racing line at its anchor.

    Re-runs delete prior auto-placed ramps (named `ramp_auto_NN`) but
    leave hand-placed ramps (`ramp_NN` / any other prefix) intact.
    """

    bl_idname = "hoverbike.auto_place_ramps"
    bl_label = "Auto-place Ramps"
    bl_description = "Drop tangent-aligned ramps at every curvature peak above |κ|"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        sp = bpy.data.objects.get("ai_spline_main")
        if sp is None or sp.type != "CURVE":
            self.report({"ERROR"}, "Auto-place ramps needs `ai_spline_main` in the scene.")
            return {"CANCELLED"}

        # Wipe prior auto-placed ramps so re-runs don't pile up.
        for name in list(bpy.data.objects.keys()):
            if name.startswith("ramp_auto_"):
                d = bpy.data.objects[name].data
                bpy.data.objects.remove(bpy.data.objects[name], do_unlink=True)
                if isinstance(d, bpy.types.Mesh) and d.users == 0:
                    bpy.data.meshes.remove(d)

        points = _sample_curve_to_polyline(sp)
        peaks = _signed_curvature_peaks(
            points,
            kappa_threshold=float(scene.hoverbike_auto_ramp_kappa),
            min_spacing_m=float(scene.hoverbike_auto_ramp_min_spacing),
        )
        if not peaks:
            self.report({"WARNING"}, "No curvature peaks above threshold — no ramps placed.")
            return {"CANCELLED"}

        # Read shared dimensions for every auto-placed ramp from the
        # standard ramp sliders. Per-instance tweaks happen after the
        # fact via the GN modifier on each ramp's mesh.
        length = float(scene.hoverbike_ramp_length)
        width  = float(scene.hoverbike_ramp_width)
        height = float(scene.hoverbike_ramp_height)
        if length <= 0 or width <= 0 or height <= 0:
            self.report({"ERROR"}, "Invalid ramp dimensions — fix length/width/height first.")
            return {"CANCELLED"}

        # _create_gn_ramp picks `ramp_NN`. Auto-placed ramps used to
        # carry the `ramp_auto_NN` prefix so re-runs could wipe just
        # those; with the unified GN-ramp pipeline they share the
        # `ramp_NN` namespace. Re-runs leave prior placements alone —
        # delete them by hand if you want a clean re-roll.
        placed = 0
        for p in peaks:
            x, y, _ = p["position"]
            tx, ty, _ = p["tangent"]
            yaw = _yaw_from_tangent_xy(tx, ty)
            z = _cursor_road_z_at(scene, x, y, float(p["position"][2])) + 0.01
            _create_gn_ramp(
                scene,
                location=(x, y, z),
                rotation_z=yaw,
                length=length, width=width, height=height,
            )
            placed += 1

        self.report({"INFO"}, f"Placed {placed} auto-ramps at curvature peaks (|κ| > {scene.hoverbike_auto_ramp_kappa:.3f}).")
        return {"FINISHED"}


# ── Placement helper ───────────────────────────────────────────────────────
#
# A persistent, curve-constrained empty that lives in the scene and acts as
# the "place this here" reference for ramps, boost pads, props, decorations
# — anything that needs to land on or beside the racing line.
#
# Pose comes from the same `_sample_curve_at_t` family the cursor-snap and
# auto-ramp operators use, so the helper, the cursor-snap, and the ramp
# placer all agree on what `t = 0.27` means on a given curve.
#
# Two driving knobs:
#   - `hoverbike_helper_t`      ∈ [0, 1]  — parameter along the curve.
#   - `hoverbike_helper_offset` ∈ [-200, 200] m — lateral offset to the
#                                                left (-) or right (+)
#                                                of the curve, perpendicular
#                                                to the tangent in XY.
#
# Re-pose runs through the existing debounce timer on prop changes, so
# scrubbing either slider live-updates the helper without per-frame churn.
# The helper also seats to whatever the bike would land on at (x, y),
# matching `cursor_snap_to_spline`.
#
# The helper is just a regular empty so any operator that reads world
# transforms (Add Ramp, Add Boost Pad, the GLB exporter — anything) can
# pick it up by name without reaching into a constraint stack. Operators
# `cursor_to_helper`, `add_ramp_at_helper`, and `add_boost_pad_at_helper`
# wrap the common one-click flows.

PLACEMENT_HELPER_NAME = "placement_helper"


def _ensure_placement_helper(scene) -> bpy.types.Object:
    """Return the singleton placement-helper empty, creating it if missing.
    The empty's pose is whatever ``_repose_placement_helper`` last wrote;
    the operator below re-poses on demand and the prop-update callback
    re-poses on every slider scrub."""
    obj = bpy.data.objects.get(PLACEMENT_HELPER_NAME)
    if obj is not None:
        return obj
    obj = bpy.data.objects.new(PLACEMENT_HELPER_NAME, None)
    obj.empty_display_type = "ARROWS"
    obj.empty_display_size = 4.0
    obj["kind"] = "placement_helper"
    obj.hide_render = True
    scene.collection.objects.link(obj)
    return obj


def _repose_placement_helper(scene) -> dict | None:
    """Recompute the helper's world transform from the configured curve,
    parameter t, and lateral offset. Returns the sample dict on success
    or None if there's no curve / sample is degenerate.

    Z lands on max(terrain, water) + hover so the helper sits at the
    same surface a cursor-snap would. Yaw aligns +Y with the tangent
    (Blender ramp/asset forward convention)."""
    obj = bpy.data.objects.get(PLACEMENT_HELPER_NAME)
    if obj is None:
        return None
    curve = _spline_source_for_placement(scene)
    if curve is None:
        return None
    t = float(getattr(scene, "hoverbike_helper_t", 0.0))
    s = _sample_curve_at_t(curve, t)
    if s is None:
        return None
    # Perpendicular to (tx, ty) in XY, right-hand. Positive offset = right
    # of the tangent direction (matches the snap-starts grid offset sign).
    tx, ty = s["tx"], s["ty"]
    rx, ry = ty, -tx
    off = float(getattr(scene, "hoverbike_helper_offset", 0.0))
    x = s["x"] + rx * off
    y = s["y"] + ry * off
    # Surface seat — same rule as snap_starts_to_spline.
    vol = bpy.data.objects.get("water_volume_main")
    water_z = float(vol.matrix_world.translation.z) if vol is not None else float("-inf")
    hover = float(getattr(scene, "hoverbike_snap_hover_height", 0.0))
    origin = mathutils.Vector((x, y, 10000.0))
    down = mathutils.Vector((0.0, 0.0, -1.0))
    with _PreviewCollectionsHidden(bpy.context.view_layer):
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        hit, loc, *_ = scene.ray_cast(depsgraph, origin, down)
    terrain_z = float(loc.z) if hit else s["z"]
    surface_z = max(terrain_z, water_z)
    if surface_z == float("-inf"):
        surface_z = s["z"]
    z = surface_z + hover
    obj.location = (x, y, z)
    obj.rotation_euler = (0.0, 0.0, _yaw_from_tangent_xy(tx, ty))
    obj["helper_t"] = float(t)
    obj["helper_offset"] = float(off)
    return {"x": x, "y": y, "z": z, "tx": tx, "ty": ty}


def _on_helper_prop_changed(self, context):
    """FloatProperty update callback — re-poses the helper whenever the
    user scrubs t or offset. No-ops if the helper hasn't been spawned."""
    if bpy.data.objects.get(PLACEMENT_HELPER_NAME) is not None:
        _schedule_rebuild("helper")


class HOVERBIKE_OT_add_placement_helper(Operator):
    """Spawn (or reveal) the singleton ``placement_helper`` empty on the
    racing line at the configured ``t`` / ``offset``. The helper is a
    persistent reference object — drag it indirectly by scrubbing the
    sliders, or read its world transform from any other operator that
    wants a placement anchor."""

    bl_idname = "hoverbike.add_placement_helper"
    bl_label = "Add Placement Helper"
    bl_description = "Spawn the curve-constrained placement helper at t / offset"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        curve = _spline_source_for_placement(scene)
        if curve is None:
            self.report({"ERROR"}, "No source curve found (need `ai_spline_main` or `road_curve_main`).")
            return {"CANCELLED"}
        obj = _ensure_placement_helper(scene)
        s = _repose_placement_helper(scene)
        if s is None:
            self.report({"ERROR"}, f"Couldn't sample {curve.name!r}.")
            return {"CANCELLED"}
        # Make the helper the active selection so the next G/R/S keystroke
        # lands on it (rare — the sliders are the canonical control).
        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj
        self.report(
            {"INFO"},
            f"{PLACEMENT_HELPER_NAME} → {curve.name} @ t={float(scene.hoverbike_helper_t):.3f}, "
            f"offset={float(scene.hoverbike_helper_offset):+.1f} m.",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_remove_placement_helper(Operator):
    """Delete the singleton ``placement_helper`` empty. Equivalent to
    selecting it in the outliner and pressing X — provided as a button so
    the helper can be removed without leaving the panel."""

    bl_idname = "hoverbike.remove_placement_helper"
    bl_label = "Remove Helper"
    bl_description = "Delete the placement_helper empty"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        obj = bpy.data.objects.get(PLACEMENT_HELPER_NAME)
        if obj is None:
            self.report({"INFO"}, "No placement helper to remove.")
            return {"CANCELLED"}
        bpy.data.objects.remove(obj, do_unlink=True)
        self.report({"INFO"}, "Removed placement_helper.")
        return {"FINISHED"}


class HOVERBIKE_OT_cursor_to_helper(Operator):
    """Snap the 3D cursor to the placement helper's pose. One-click way
    to jump the cursor to a known anchor before invoking *Add Ramp*,
    *Add Boost Pad*, or any other cursor-driven add operator."""

    bl_idname = "hoverbike.cursor_to_helper"
    bl_label = "Cursor → Helper"
    bl_description = "Move the 3D cursor to the placement helper's transform"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        obj = bpy.data.objects.get(PLACEMENT_HELPER_NAME)
        if obj is None:
            self.report({"ERROR"}, "No placement_helper. Click *Add Placement Helper* first.")
            return {"CANCELLED"}
        loc = obj.matrix_world.translation
        context.scene.cursor.location = (float(loc.x), float(loc.y), float(loc.z))
        context.scene.cursor.rotation_euler = (
            float(obj.rotation_euler.x),
            float(obj.rotation_euler.y),
            float(obj.rotation_euler.z),
        )
        return {"FINISHED"}


class HOVERBIKE_OT_add_ramp_at_helper(Operator):
    """Drop a wedge ramp at the placement helper's pose. Snaps the
    cursor first so undo collapses both into a single step."""

    bl_idname = "hoverbike.add_ramp_at_helper"
    bl_label = "Add Ramp at Helper"
    bl_description = "Snap cursor to the placement helper, then drop a tangent-aligned ramp"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        snap = bpy.ops.hoverbike.cursor_to_helper()
        if snap != {"FINISHED"}:
            return snap
        return bpy.ops.hoverbike.add_ramp()


class HOVERBIKE_OT_add_boost_pad_at_helper(Operator):
    """Drop a boost pad at the placement helper's pose. Snaps the
    cursor first so the pad inherits the helper's yaw."""

    bl_idname = "hoverbike.add_boost_pad_at_helper"
    bl_label = "Add Boost at Helper"
    bl_description = "Snap cursor to the placement helper, then drop a tangent-aligned boost pad"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        snap = bpy.ops.hoverbike.cursor_to_helper()
        if snap != {"FINISHED"}:
            return snap
        return bpy.ops.hoverbike.add_boost_pad()


# ── Downtown generator ─────────────────────────────────────────────────────
#
# Drops a placeholder dense-urban city block at the 3D cursor: a
# rectangular grid of mid-rise towers separated by streets and a flat
# sidewalk plinth, all parented to a `downtown_NN` empty for one-click
# move/delete.
#
# Geometry is intentionally placeholder — boxy buildings of varied heights
# with simple top-floor setbacks, two grey/tan/blue tints alternating per
# building, and asphalt streets. Good enough to read as a city from a
# hoverbike at speed; refine later by swapping the per-building mesh for
# a richer GN graph or imported asset.
#
# Each building mesh carries `kind="track"` so the runtime trimesh
# collider attaches at GLB-load time (you can fly through them otherwise).
# The street plinth is also kind="track" so the bike can rake across it.
#
# Reproducibility: the grid layout, building heights, footprints, and
# tints all come from a seeded RNG keyed off `seed`. Two downtowns with
# the same seed + dimensions are identical.

DOWNTOWN_OBJECT_PREFIX = "downtown_"
DOWNTOWN_BUILDING_MAT_PREFIX = "mat_track_downtown_"
DOWNTOWN_SIDEWALK_MAT_NAME = "mat_track_downtown_sidewalk"
DOWNTOWN_ROAD_MAT_NAME = "mat_track_downtown_road"


def _next_downtown_object_name() -> str:
    i = 0
    while True:
        name = f"{DOWNTOWN_OBJECT_PREFIX}{i:02d}"
        if name not in bpy.data.objects:
            return name
        i += 1


def _ensure_downtown_building_material(variant: int) -> bpy.types.Material:
    """Return one of N flat tints used to alternate building colours so a
    block doesn't read as a single grey mass. Variants cycle deterministic
    per-building from the layout RNG."""
    palette = [
        (0.62, 0.60, 0.57),  # warm concrete
        (0.45, 0.48, 0.52),  # cool steel
        (0.38, 0.34, 0.32),  # dark glass / brown brick
        (0.72, 0.68, 0.58),  # tan stone
        (0.30, 0.36, 0.42),  # navy spandrel glass
        (0.55, 0.52, 0.48),  # mid grey
    ]
    idx = int(variant) % len(palette)
    name = f"{DOWNTOWN_BUILDING_MAT_PREFIX}{idx:02d}"
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        r, g, b = palette[idx]
        bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.6
        spec = bsdf.inputs.get("Specular IOR Level") or bsdf.inputs.get("Specular")
        if spec is not None:
            spec.default_value = 0.4
    return mat


def _ensure_downtown_sidewalk_material() -> bpy.types.Material:
    """Sidewalk / lot plinth surface — light warm concrete. This is the
    "ground around the buildings" colour, the lighter half of the
    sidewalk/road contrast that makes the street grid read at speed.
    Material-slot 0 on every plinth."""
    mat = bpy.data.materials.get(DOWNTOWN_SIDEWALK_MAT_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(DOWNTOWN_SIDEWALK_MAT_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.52, 0.50, 0.46, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.82
        spec = bsdf.inputs.get("Specular IOR Level") or bsdf.inputs.get("Specular")
        if spec is not None:
            spec.default_value = 0.2
    return mat


def _ensure_downtown_road_material() -> bpy.types.Material:
    """Asphalt road surface — dark grey, slightly bluer than the
    sidewalk so the contrast doesn't read as "dirty concrete" but as
    "different surface". Material-slot 1 on every plinth; assigned to
    faces that fall in the inter-block street strips, so the road
    network reads as a darker grid against the lighter sidewalk
    fabric without a second mesh / z-fight."""
    mat = bpy.data.materials.get(DOWNTOWN_ROAD_MAT_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(DOWNTOWN_ROAD_MAT_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.10, 0.10, 0.12, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.88
        spec = bsdf.inputs.get("Specular IOR Level") or bsdf.inputs.get("Specular")
        if spec is not None:
            spec.default_value = 0.22
    return mat


def _build_downtown_building_mesh(
    name: str,
    *,
    footprint: tuple[float, float],
    height: float,
    has_setback: bool,
    extra_depth: float = 0.0,
) -> bpy.types.Mesh:
    """Build a single placeholder building. A box of ``footprint`` X×Y by
    ``height`` Z, optionally with an inset top-floor setback that gives
    the silhouette a stepped look at speed.

    ``extra_depth`` (m) sinks the bottom face below the building's local
    z=0 — used by the terrain-conform pass to bury the downhill side
    into the slope so a building on a hill looks like it's stepping
    into the grade instead of floating on stilts. The exposed silhouette
    above z=0 is unchanged.

    Origin sits on the building's base centre at z=0 = "uphill ground"."""
    me = bpy.data.meshes.new(name)
    fx, fy = footprint
    hx, hy = fx * 0.5, fy * 0.5
    bz = -float(max(extra_depth, 0.0))

    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []

    if has_setback and height > 8.0:
        body_h = height * 0.78
        top_h = height - body_h
        sx, sy = hx * 0.78, hy * 0.78
        # Bottom box (8 verts) — bottom face at bz, top of body at body_h.
        verts.extend([
            (-hx, -hy, bz), (hx, -hy, bz), (hx, hy, bz), (-hx, hy, bz),
            (-hx, -hy, body_h), (hx, -hy, body_h), (hx, hy, body_h), (-hx, hy, body_h),
        ])
        # Setback box (8 verts) — sits on top of the body box.
        verts.extend([
            (-sx, -sy, body_h), (sx, -sy, body_h), (sx, sy, body_h), (-sx, sy, body_h),
            (-sx, -sy, height), (sx, -sy, height), (sx, sy, height), (-sx, sy, height),
        ])
        # Bottom box faces (skip the top — the setback covers most of it,
        # and we add an annular cap below).
        faces.extend([
            (0, 1, 2, 3),                # bottom
            (0, 1, 5, 4), (1, 2, 6, 5),  # sides
            (2, 3, 7, 6), (3, 0, 4, 7),
        ])
        # Setback box faces.
        faces.extend([
            (8, 9, 13, 12), (9, 10, 14, 13),  # sides
            (10, 11, 15, 14), (11, 8, 12, 15),
            (12, 13, 14, 15),                  # roof
        ])
        # Annular roof of the body box around the setback (4 quads).
        faces.extend([
            (0 + 4, 1 + 4, 9, 8),
            (1 + 4, 2 + 4, 10, 9),
            (2 + 4, 3 + 4, 11, 10),
            (3 + 4, 0 + 4, 8, 11),
        ])
    else:
        verts.extend([
            (-hx, -hy, bz), (hx, -hy, bz), (hx, hy, bz), (-hx, hy, bz),
            (-hx, -hy, height), (hx, -hy, height), (hx, hy, height), (-hx, hy, height),
        ])
        faces.extend([
            (0, 1, 2, 3),                  # bottom
            (4, 7, 6, 5),                  # roof (reversed for upward normal)
            (0, 1, 5, 4), (1, 2, 6, 5),
            (2, 3, 7, 6), (3, 0, 4, 7),
        ])

    me.from_pydata(verts, [], faces)
    me.update(calc_edges=True)
    me.shade_flat()
    return me


def _block_aligned_axis_positions(
    blocks: int,
    block_size: float,
    street_width: float,
    *,
    cells_per_block: int = 4,
    cells_per_street: int = 2,
) -> tuple[list[float], list[bool]]:
    """Return ``(positions, cell_is_street)`` for a per-axis vertex layout
    that pins subdivisions to block/street boundaries.

    Length of ``positions`` is ``blocks * cells_per_block +
    (blocks - 1) * cells_per_street + 1``. Length of ``cell_is_street``
    is one less than that (a flag per cell between two positions). Each
    cell is unambiguously inside either a block zone (False) or a
    street zone (True), so face-level material assignment falls out
    naturally without straddling-cell artefacts."""
    pitch = block_size + street_width
    span = blocks * pitch - street_width
    positions: list[float] = [-span * 0.5]
    cell_is_street: list[bool] = []
    cur = -span * 0.5
    for b in range(blocks):
        for c in range(1, cells_per_block + 1):
            positions.append(cur + c * block_size / cells_per_block)
            cell_is_street.append(False)
        cur += block_size
        if b < blocks - 1:
            for c in range(1, cells_per_street + 1):
                positions.append(cur + c * street_width / cells_per_street)
                cell_is_street.append(True)
            cur += street_width
    return positions, cell_is_street


# Material slot indices on every plinth mesh — same on all downtowns so
# downstream tools can swap the materials by slot index without having
# to look up which downtown they're editing.
DOWNTOWN_PLINTH_SIDEWALK_SLOT = 0
DOWNTOWN_PLINTH_ROAD_SLOT = 1


def _build_downtown_plinth_mesh(
    name: str,
    *,
    blocks_x: int,
    blocks_y: int,
    block_size: float,
    street_width: float,
    vertex_z: list[float] | None = None,
) -> tuple[bpy.types.Mesh, list[tuple[float, float]]]:
    """Plinth: streets + sidewalks as a single mesh with two material
    slots. Returns ``(mesh, vert_positions_xy)`` so the caller can
    raycast each vertex to the terrain (then re-call this with the
    resulting ``vertex_z``).

    Vertex layout is *block-aligned* — subdivisions land exactly on
    every block/street boundary so each face is unambiguously a
    sidewalk cell or a road cell, and we can assign per-face
    ``material_index`` without straddling artefacts.

    Material slot 0 → sidewalk material, slot 1 → road material. The
    caller appends both materials in that order before linking the
    mesh into the scene.

    Lifted +0.05 m at construction so the plinth sits visibly above
    terrain rather than z-fighting on flat ground."""
    me = bpy.data.meshes.new(name)
    x_pos, x_is_street = _block_aligned_axis_positions(blocks_x, block_size, street_width)
    y_pos, y_is_street = _block_aligned_axis_positions(blocks_y, block_size, street_width)
    nx = len(x_pos)
    ny = len(y_pos)
    base_lift = 0.05

    verts: list[tuple[float, float, float]] = []
    vert_positions_xy: list[tuple[float, float]] = []
    for j in range(ny):
        for i in range(nx):
            idx = j * nx + i
            if vertex_z is not None and idx < len(vertex_z):
                z = float(vertex_z[idx]) + base_lift
            else:
                z = base_lift
            verts.append((x_pos[i], y_pos[j], z))
            vert_positions_xy.append((x_pos[i], y_pos[j]))

    faces: list[tuple[int, ...]] = []
    mat_idx: list[int] = []
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = j * nx + i
            b = a + 1
            c = a + nx + 1
            d = a + nx
            faces.append((a, b, c, d))
            is_road = x_is_street[i] or y_is_street[j]
            mat_idx.append(
                DOWNTOWN_PLINTH_ROAD_SLOT if is_road else DOWNTOWN_PLINTH_SIDEWALK_SLOT
            )

    me.from_pydata(verts, [], faces)
    me.update(calc_edges=True)
    me.shade_flat()
    for fi, slot in enumerate(mat_idx):
        me.polygons[fi].material_index = slot
    return me, vert_positions_xy


def _terrain_raycast_batch(
    scene,
    points_xy: list[tuple[float, float]],
) -> list[tuple[float, bool]]:
    """Cast straight down at every (x_world, y_world) and return
    ``[(z_world, hit)]``. Casts against *only* the largest visible
    ``kind="track"`` mesh (the terrain), not against the whole scene
    — so existing downtown buildings, water previews, gates, racer
    previews, and the like never catch the cast.

    Why a per-mesh cast rather than ``scene.ray_cast``: even with
    every other mesh hide_viewport-toggled, ``scene.ray_cast`` was
    still picking up sibling-downtown plinths in multi-city scenes.
    Casting against a single named mesh sidesteps that whole class
    of "what's in the depsgraph right now" question and is plenty
    fast — a single BVH walk per point on a ~37 k vert plane.

    Returns ``(0.0, False)`` for any point that doesn't hit the
    terrain — typically points outside the terrain tile, or scenes
    with no terrain mesh present yet."""
    target = _largest_terrain_mesh()
    if target is None:
        return [(0.0, False)] * len(points_xy)
    # Force BVH freshness by casting against the *evaluated* mesh from
    # the depsgraph, not the source object. Without this, a freshly
    # built / edited terrain mesh hands ``obj.ray_cast`` a stale BVH
    # that misses every cast or returns the pre-edit z plane —
    # symptom: a downtown built in the same script run that builds the
    # terrain ends up with plinth verts at unrelated z values.
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    eval_obj = target.evaluated_get(depsgraph)
    mw = eval_obj.matrix_world
    mw_inv = mw.inverted_safe()
    # Local-space cast direction. Terrain matrix is normally identity
    # but we transform anyway in case the user's tilted the terrain.
    down_local = mw_inv.to_3x3() @ mathutils.Vector((0.0, 0.0, -1.0))
    results: list[tuple[float, bool]] = []
    for x, y in points_xy:
        origin_world = mathutils.Vector((float(x), float(y), 10000.0))
        origin_local = mw_inv @ origin_world
        hit, loc_local, *_ = eval_obj.ray_cast(origin_local, down_local)
        if hit:
            results.append((float((mw @ loc_local).z), True))
        else:
            results.append((0.0, False))
    return results


def _hash_cell(seed: int, gx: int, gy: int) -> float:
    """Cheap deterministic [0,1) per (seed, gx, gy). Avoids importing
    Python ``random`` so we don't disturb the user's RNG state."""
    h = (seed * 73856093) ^ (gx * 19349663) ^ (gy * 83492791)
    h = (h ^ (h >> 13)) & 0xFFFFFFFF
    h = (h * 1274126177) & 0xFFFFFFFF
    return ((h >> 8) & 0xFFFFFF) / float(1 << 24)


def _generate_downtown(
    scene,
    *,
    location: tuple[float, float, float],
    rotation_z: float,
    blocks_x: int,
    blocks_y: int,
    block_size: float,
    street_width: float,
    height_min: float,
    height_max: float,
    seed: int,
    conform_to_terrain: bool = True,
) -> tuple[bpy.types.Object, int]:
    """Spawn a parented downtown block. Returns (parent_empty,
    n_buildings_built).

    With ``conform_to_terrain=True`` (default), each building's base is
    raycast onto whatever terrain mesh the scene contains and its
    bottom face is sunk to the lowest of its four footprint corners —
    so a building on a slope reads as stepping into the hill instead of
    floating on stilts. The plinth is also subdivided + per-vertex
    conformed so the streets follow the grade between buildings. With
    ``False`` (legacy), everything sits at z=0 and the plinth is a
    single quad.

    The parent's location.z still places the entire downtown vertically
    — terrain conformance is applied as an offset on top of that. So
    parking the empty above sea level + conforming gives you a city
    sitting on rolling hills; setting parent.z = 0 in a flat scene
    collapses to the legacy look."""
    name = _next_downtown_object_name()
    parent = bpy.data.objects.new(name, None)
    parent.empty_display_type = "CUBE"
    parent.empty_display_size = max(2.0, block_size * 0.4)
    parent["kind"] = "downtown"
    parent["seed"] = int(seed)
    parent["blocks_x"] = int(blocks_x)
    parent["blocks_y"] = int(blocks_y)
    parent["block_size"] = float(block_size)
    parent["street_width"] = float(street_width)
    parent["conform_to_terrain"] = bool(conform_to_terrain)
    parent.location = location
    parent.rotation_euler = (0.0, 0.0, float(rotation_z))
    scene.collection.objects.link(parent)

    # Total footprint in metres, centred on the parent.
    pitch = block_size + street_width
    span_x = blocks_x * pitch - street_width
    span_y = blocks_y * pitch - street_width

    # Pre-compute every (gx, gy) cell's layout decision so the same RNG
    # rolls drive both the building geometry below AND the (x, y) point
    # set we batch-raycast for the conform pass. Keeps geometry +
    # raycasts in lock-step without re-rolling hashes.
    cell_specs: list[dict] = []
    for gx in range(blocks_x):
        for gy in range(blocks_y):
            cx = -span_x * 0.5 + gx * pitch + block_size * 0.5
            cy = -span_y * 0.5 + gy * pitch + block_size * 0.5
            r0 = _hash_cell(seed, gx, gy)
            if r0 < 0.12:
                # Empty plaza — record so we can skip building emission.
                cell_specs.append({"gx": gx, "gy": gy, "skip": True})
                continue
            if r0 < 0.47:
                quarter = block_size * 0.5
                half_q = quarter * 0.5
                quads = []
                for dx, dy, idx in (
                    (-half_q, -half_q, 0), (half_q, -half_q, 1),
                    (half_q, half_q, 2), (-half_q, half_q, 3),
                ):
                    rh = _hash_cell(seed * 7 + idx, gx, gy)
                    rv = _hash_cell(seed * 13 + idx, gx, gy)
                    h = height_min + rh * (height_max - height_min) * 0.7
                    fp = (
                        quarter * (0.78 + 0.18 * rv),
                        quarter * (0.78 + 0.18 * (1.0 - rv)),
                    )
                    quads.append({"local_xy": (cx + dx, cy + dy), "footprint": fp,
                                  "height": h, "rh": rh, "idx": idx})
                cell_specs.append({"gx": gx, "gy": gy, "skip": False, "sub": True, "quads": quads})
            else:
                rh = _hash_cell(seed * 17, gx, gy)
                rv = _hash_cell(seed * 23, gx, gy)
                h = height_min + rh * (height_max - height_min)
                fp = (
                    block_size * (0.82 + 0.14 * rv),
                    block_size * (0.82 + 0.14 * (1.0 - rv)),
                )
                cell_specs.append({"gx": gx, "gy": gy, "skip": False, "sub": False,
                                   "local_xy": (cx, cy), "footprint": fp,
                                   "height": h, "rh": rh})

    # Helper to convert a parent-local (x, y) into world (x, y). We
    # compute the 2D rotate+translate manually from parent.location +
    # parent.rotation_euler.z rather than using ``parent.matrix_world``
    # because the latter is identity-at-read until a view_layer.update()
    # has fired — and we're called inside the same script step that
    # just set parent.location, so the matrix is stale. Manual math is
    # faster and bulletproof against that timing trap.
    p_x = float(parent.location.x)
    p_y = float(parent.location.y)
    p_yaw = float(parent.rotation_euler.z)
    cos_y = math.cos(p_yaw)
    sin_y = math.sin(p_yaw)

    def _local_xy_to_world(lx: float, ly: float) -> tuple[float, float]:
        return (p_x + lx * cos_y - ly * sin_y,
                p_y + lx * sin_y + ly * cos_y)

    # Pre-compute the block-aligned plinth axis positions so we can
    # raycast them in the same batch as building corners. With the
    # same axis layout used by ``_build_downtown_plinth_mesh`` below,
    # the per-vertex Z values from the batch slot back into the mesh
    # build in one shot.
    plinth_x_pos, _ = _block_aligned_axis_positions(blocks_x, block_size, street_width)
    plinth_y_pos, _ = _block_aligned_axis_positions(blocks_y, block_size, street_width)

    # Build the (x, y) world-space point list we need to raycast: every
    # plinth grid vertex + four corners of every building footprint.
    # We track index ranges so we can demux the results back into
    # plinth-vert and per-building lookups.
    raycast_points: list[tuple[float, float]] = []
    plinth_idx_range: tuple[int, int] = (0, 0)
    if conform_to_terrain:
        for ly in plinth_y_pos:
            for lx in plinth_x_pos:
                raycast_points.append(_local_xy_to_world(lx, ly))
        plinth_idx_range = (0, len(raycast_points))

    # Track each building's slot in the raycast results so we can read
    # back its 4 corner Zs after the batch.
    building_corner_slots: list[tuple[int, int]] = []  # (start_idx, count=4)
    if conform_to_terrain:
        for cell in cell_specs:
            if cell["skip"]:
                building_corner_slots.append((-1, 0))
                continue
            if cell["sub"]:
                slots: list[int] = []
                for q in cell["quads"]:
                    slots.append(len(raycast_points))
                    cx, cy = q["local_xy"]
                    fx, fy = q["footprint"]
                    hx, hy = fx * 0.5, fy * 0.5
                    for ox, oy in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)):
                        raycast_points.append(_local_xy_to_world(cx + ox, cy + oy))
                cell["_slots"] = slots
            else:
                cell["_slot"] = len(raycast_points)
                cx, cy = cell["local_xy"]
                fx, fy = cell["footprint"]
                hx, hy = fx * 0.5, fy * 0.5
                for ox, oy in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)):
                    raycast_points.append(_local_xy_to_world(cx + ox, cy + oy))

    # One batched raycast for the whole downtown.
    casts = _terrain_raycast_batch(scene, raycast_points) if raycast_points else []

    # Plinth: subdivided + per-vertex Z-conformed when conforming, single
    # quad otherwise (the legacy flat behaviour).
    plinth_vertex_z: list[float] | None = None
    if conform_to_terrain:
        parent_z = float(parent.location.z)
        plinth_vertex_z = []
        for k in range(plinth_idx_range[0], plinth_idx_range[1]):
            world_z, hit = casts[k]
            # Convert world Z back to parent-local Z. Parent has only
            # translation + Z-rotation so Z-axis transform is just a
            # subtract of parent.location.z.
            plinth_vertex_z.append((world_z if hit else 0.0) - parent_z)

    plinth_mesh, _ = _build_downtown_plinth_mesh(
        f"{name}_plinth_data",
        blocks_x=blocks_x,
        blocks_y=blocks_y,
        block_size=block_size,
        street_width=street_width,
        vertex_z=plinth_vertex_z,
    )
    plinth_obj = bpy.data.objects.new(f"{name}_plinth", plinth_mesh)
    plinth_obj.parent = parent
    plinth_obj.matrix_parent_inverse.identity()
    plinth_obj["kind"] = "track"
    # Slot 0 = sidewalk, slot 1 = road — matches the material_index
    # assignment in _build_downtown_plinth_mesh.
    plinth_obj.data.materials.append(_ensure_downtown_sidewalk_material())
    plinth_obj.data.materials.append(_ensure_downtown_road_material())
    scene.collection.objects.link(plinth_obj)

    def _seat_for_corners(slot: int) -> tuple[float, float]:
        """Return ``(local_base_z, extra_depth)`` for the 4 corners
        starting at ``slot``. Base sits at the highest corner so the
        building's exposed silhouette starts at the uphill grade;
        extra_depth sinks the bottom face below the lowest corner so
        the downhill side is buried in the slope."""
        if slot < 0:
            return 0.0, 0.0
        zs = [casts[slot + i][0] for i in range(4) if casts[slot + i][1]]
        if not zs:
            return -float(parent.location.z), 0.0  # land at world Z=0
        lowest = min(zs)
        highest = max(zs)
        local_base = highest - float(parent.location.z)
        extra = highest - lowest + 0.5  # 0.5m safety into terrain
        return local_base, max(extra, 0.0)

    # Per-block buildings. Same loop structure as before, but each
    # building's location.z + mesh extra_depth come from the raycast
    # results when conforming.
    n_buildings = 0
    for cell in cell_specs:
        if cell["skip"]:
            continue
        gx, gy = cell["gx"], cell["gy"]
        if cell["sub"]:
            slots = cell.get("_slots", [-1] * 4)
            for q, slot in zip(cell["quads"], slots):
                local_base = 0.0
                extra = 0.0
                if conform_to_terrain:
                    local_base, extra = _seat_for_corners(slot)
                bname = f"{name}_b{gx:02d}_{gy:02d}_{q['idx']}"
                me = _build_downtown_building_mesh(
                    f"{bname}_data",
                    footprint=q["footprint"],
                    height=q["height"],
                    has_setback=q["rh"] > 0.6,
                    extra_depth=extra,
                )
                obj = bpy.data.objects.new(bname, me)
                obj.parent = parent
                obj.matrix_parent_inverse.identity()
                obj.location = (q["local_xy"][0], q["local_xy"][1], local_base)
                obj["kind"] = "track"
                obj.data.materials.append(
                    _ensure_downtown_building_material(int(q["rh"] * 60) + q["idx"])
                )
                scene.collection.objects.link(obj)
                n_buildings += 1
        else:
            local_base = 0.0
            extra = 0.0
            if conform_to_terrain:
                local_base, extra = _seat_for_corners(cell.get("_slot", -1))
            bname = f"{name}_b{gx:02d}_{gy:02d}"
            me = _build_downtown_building_mesh(
                f"{bname}_data",
                footprint=cell["footprint"],
                height=cell["height"],
                has_setback=cell["rh"] > 0.45,
                extra_depth=extra,
            )
            obj = bpy.data.objects.new(bname, me)
            obj.parent = parent
            obj.matrix_parent_inverse.identity()
            obj.location = (cell["local_xy"][0], cell["local_xy"][1], local_base)
            obj["kind"] = "track"
            obj.data.materials.append(
                _ensure_downtown_building_material(int(cell["rh"] * 60))
            )
            scene.collection.objects.link(obj)
            n_buildings += 1

    return parent, n_buildings


class HOVERBIKE_OT_add_downtown(Operator):
    """Spawn a procedural downtown city-block at the 3D cursor.

    Builds a parent ``downtown_NN`` empty plus a flat plinth + a grid of
    placeholder building boxes (mixed heights, occasional top-floor
    setbacks, a handful of empty plazas to break the silhouette). All
    children carry ``kind="track"`` so the runtime collider attaches
    at GLB-load time — the bike can rake across the streets and slap
    into the towers.

    Pulls all dimensions from the panel:

      Blocks X/Y      — grid extent in city blocks.
      Block size (m)  — edge length of each block (bigger = bigger towers).
      Street (m)      — gap between adjacent blocks.
      Min/Max h (m)   — random height range per building.
      Seed            — integer that drives layout randomness.

    Re-poses to (and rotates by) the 3D cursor so a Cursor → Spline (or
    Cursor → Helper) before invocation drops the city centred on the
    racing line."""

    bl_idname = "hoverbike.add_downtown"
    bl_label = "Add Downtown"
    bl_description = "Spawn a placeholder city-block grid at the 3D cursor"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        bx = int(getattr(scene, "hoverbike_downtown_blocks_x", 6))
        by = int(getattr(scene, "hoverbike_downtown_blocks_y", 6))
        block_size = float(getattr(scene, "hoverbike_downtown_block_size", 30.0))
        street = float(getattr(scene, "hoverbike_downtown_street_width", 8.0))
        h_min = float(getattr(scene, "hoverbike_downtown_height_min", 18.0))
        h_max = float(getattr(scene, "hoverbike_downtown_height_max", 80.0))
        seed = int(getattr(scene, "hoverbike_downtown_seed", 1))
        conform = bool(getattr(scene, "hoverbike_downtown_conform", True))
        if bx <= 0 or by <= 0 or block_size <= 0 or h_max <= h_min:
            self.report({"ERROR"}, "Invalid downtown dimensions — fix grid / size / height range first.")
            return {"CANCELLED"}

        cursor = scene.cursor
        parent, n = _generate_downtown(
            scene,
            location=tuple(cursor.location),
            rotation_z=float(cursor.rotation_euler.z),
            blocks_x=bx,
            blocks_y=by,
            block_size=block_size,
            street_width=street,
            height_min=h_min,
            height_max=h_max,
            seed=seed,
            conform_to_terrain=conform,
        )

        # Select the parent so the next G/R/S keystroke moves the whole
        # downtown at once.
        for o in context.selected_objects:
            o.select_set(False)
        parent.select_set(True)
        context.view_layer.objects.active = parent

        span_x = bx * (block_size + street) - street
        span_y = by * (block_size + street) - street
        self.report(
            {"INFO"},
            f"Added {parent.name}: {bx}×{by} blocks, {n} buildings, footprint ~{span_x:.0f}×{span_y:.0f} m.",
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
    """Asphalt road surface. Layered: a value-noise texture darkens the
    base colour slightly so the road doesn't read as a single flat
    tint, and a low-frequency Voronoi pattern adds tire-groove streaks
    when viewed up close. Aesthetic baseline only — hand-tune the
    shader graph in Blender after first generation for production polish."""
    mat = bpy.data.materials.get(ROAD_MATERIAL_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(ROAD_MATERIAL_NAME)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    output = nt.nodes.get("Material Output")
    if bsdf is None or output is None:
        return mat

    bsdf.inputs["Base Color"].default_value = (0.11, 0.11, 0.12, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.85
    spec = bsdf.inputs.get("Specular IOR Level") or bsdf.inputs.get("Specular")
    if spec is not None:
        spec.default_value = 0.2

    # Grain: a stretchy Noise → BrightContrast → ColorRamp chain darkens
    # the asphalt non-uniformly. UV-less so the noise samples in world
    # space and tiles naturally as the road bends.
    tex_coord = nt.nodes.new(type="ShaderNodeTexCoord")
    tex_coord.location = (-900, 0)
    noise = nt.nodes.new(type="ShaderNodeTexNoise")
    noise.location = (-700, 0)
    noise.inputs["Scale"].default_value = 8.0
    noise.inputs["Detail"].default_value = 4.0
    noise.inputs["Roughness"].default_value = 0.65
    ramp = nt.nodes.new(type="ShaderNodeValToRGB")
    ramp.location = (-450, 0)
    # Two-stop ramp: most asphalt mid-grey, dark patches a notch darker.
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (0.08, 0.08, 0.09, 1.0)
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (0.13, 0.13, 0.14, 1.0)
    nt.links.new(tex_coord.outputs["Object"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


ROAD_UNDERSIDE_MATERIAL_NAME = "mat_track_road_underside"


def _ensure_road_underside_material() -> bpy.types.Material:
    """Bridge / underside material — flat concrete grey, lighter than the
    asphalt so the underside reads as structure rather than disappearing
    into ground shadow on cross-valley shots."""
    mat = bpy.data.materials.get(ROAD_UNDERSIDE_MATERIAL_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(ROAD_UNDERSIDE_MATERIAL_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.30, 0.29, 0.27, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.7
    return mat


def _ensure_curb_material(*, red: bool) -> bpy.types.Material:
    """F1-style curb material — saturated red or white, mat-prefixed so
    it groups with the other track materials. Two-tone alternation
    happens at the mesh level via `material_index` on each curb quad."""
    name = "mat_track_curb_red" if red else "mat_track_curb_white"
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        if red:
            bsdf.inputs["Base Color"].default_value = (0.85, 0.08, 0.10, 1.0)
        else:
            bsdf.inputs["Base Color"].default_value = (0.92, 0.92, 0.92, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.6
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


def _resolve_road_curve() -> bpy.types.Object | None:
    """Pick the curve the road tool should follow. Prefers the dedicated
    `road_curve_main` if it exists, falls back to `ai_spline_main` so
    authors who don't want two curves with the same shape can just
    author the racing line and have the road follow it. Returns None
    if neither is present."""
    for name in (ROAD_CURVE_NAME, "ai_spline_main"):
        obj = bpy.data.objects.get(name)
        if obj is not None and obj.type == "CURVE":
            return obj
    return None


def _curve_control_radii(curve_obj: bpy.types.Object) -> tuple[list[float], bool]:
    """Return (radii, cyclic) for the curve's first spline. NURBS
    `point.radius` and Bezier `bezier_point.radius` both live in [0, ∞);
    Blender defaults to 1.0. Authors can set per-point radius in edit
    mode (N-panel → Curve → Radius). The road tool reads these as a
    width multiplier so apexes can be wider than straights."""
    if not curve_obj.data.splines:
        return [], False
    spline = curve_obj.data.splines[0]
    if spline.type == "BEZIER":
        radii = [float(bp.radius) for bp in spline.bezier_points]
    else:
        radii = [float(pt.radius) for pt in spline.points]
    return radii, bool(spline.use_cyclic_u)


def _curve_control_tilts(curve_obj: bpy.types.Object) -> list[float]:
    """Return per-control-point tilt (radians) for the curve's first
    spline. Blender exposes `tilt` on both NURBS / Bezier points; the
    road tool reads it as an *additive* bank angle on top of the auto
    bank from curvature, so an author can hand-tune corners without
    fighting the curvature-driven default. Empty list when the spline
    has no points."""
    if not curve_obj.data.splines:
        return []
    spline = curve_obj.data.splines[0]
    if spline.type == "BEZIER":
        return [float(bp.tilt) for bp in spline.bezier_points]
    return [float(pt.tilt) for pt in spline.points]


def _radius_at_t(radii: list[float], t: float, cyclic: bool) -> float:
    """Linearly interpolate a control-point radius array at parameter
    t in [0, 1]. Cyclic splines wrap around; open splines clamp at
    both ends."""
    n = len(radii)
    if n == 0:
        return 1.0
    if n == 1:
        return radii[0]
    if cyclic:
        f = (t * n) % n
        i0 = int(f) % n
        i1 = (i0 + 1) % n
    else:
        f = t * (n - 1)
        i0 = min(int(f), n - 1)
        i1 = min(i0 + 1, n - 1)
    frac = f - int(f)
    return radii[i0] * (1.0 - frac) + radii[i1] * frac


def _tilt_at_t(tilts: list[float], t: float, cyclic: bool) -> float:
    """Linearly interpolate a control-point tilt array (radians) at
    parameter t in [0, 1]. Same wrap rules as `_radius_at_t` so a
    radius / tilt pair on the same control point land at the same
    sample. Returns 0.0 when no tilts are set (preserving backwards
    compat with curves that predate this knob)."""
    n = len(tilts)
    if n == 0:
        return 0.0
    if n == 1:
        return tilts[0]
    if cyclic:
        f = (t * n) % n
        i0 = int(f) % n
        i1 = (i0 + 1) % n
    else:
        f = t * (n - 1)
        i0 = min(int(f), n - 1)
        i1 = min(i0 + 1, n - 1)
    frac = f - int(f)
    return tilts[i0] * (1.0 - frac) + tilts[i1] * frac


def _compute_per_sample_bank(
    samples: list[dict],
    *,
    bank_strength: float,
    bank_max_rad: float,
    cyclic: bool = False,
    smoothing_passes: int = 6,
) -> None:
    """Stamp `bank` (signed radians around the road tangent) onto each
    sample. Positive bank tilts the cross-section so the *inside* of the
    corner is lower than the outside — racing-game banking convention,
    matches what JetMoto / WipEout players expect.

    Per-sample curvature is the signed angle between the tangent at i-1
    and the tangent at i+1, divided by the local arc length. Multiply by
    `bank_strength`, clamp to `bank_max_rad`, then smooth so the bank
    transitions in/out of corners are gentle (a hard step would pinch
    the road mesh).

    Per-control-point `tilt` is added on top so authors who want to
    hand-tune a specific corner can edit the bezier point's tilt and
    have it stack with the curvature-driven default.

    `cyclic` controls how the endpoint samples are handled. Open curves
    (default) duplicate the endpoint tangent so the first/last samples
    don't pick up a bogus curvature from wrapping around. Closed loops
    wrap so the join doesn't get a fake straight bit."""
    n = len(samples)
    if n < 3 or bank_strength <= 0:
        for s in samples:
            s["bank"] = float(s.get("tilt", 0.0))
        return

    def neighbour_indices(i: int) -> tuple[int, int]:
        if cyclic:
            return (i - 1) % n, (i + 1) % n
        # Open: clamp to endpoints. The endpoint sample's curvature
        # then collapses to 0 (consecutive segments are identical),
        # so banks ease to neutral at the road ends.
        return max(0, i - 1), min(n - 1, i + 1)

    raw_bank: list[float] = [0.0] * n
    for i in range(n):
        i_prev, i_next = neighbour_indices(i)
        ax = samples[i]["x"] - samples[i_prev]["x"]
        ay = samples[i]["y"] - samples[i_prev]["y"]
        bx = samples[i_next]["x"] - samples[i]["x"]
        by = samples[i_next]["y"] - samples[i]["y"]
        la = math.hypot(ax, ay) or 1e-6
        lb = math.hypot(bx, by) or 1e-6
        cross = ax * by - ay * bx
        dot = ax * bx + ay * by
        angle = math.atan2(cross, dot)
        seg = 0.5 * (la + lb)
        kappa = angle / seg if seg > 0 else 0.0
        # bank_strength has units of seconds² (effectively v² × time-of-bank);
        # using a sane physical scale for "speed" — bikes settle around
        # 50 m/s on straights — gives kappa * v² ≈ comfortable bank rad.
        ref_v_sq = 50.0 * 50.0
        bank = kappa * ref_v_sq * bank_strength * 0.001
        # Clamp signed.
        if bank > bank_max_rad:
            bank = bank_max_rad
        elif bank < -bank_max_rad:
            bank = -bank_max_rad
        raw_bank[i] = bank

    # Smooth with a 1-2-1 binomial pass — bank should ease into corners,
    # not snap. Open-ended profiles use clamped boundaries; closed loops
    # wrap. Authors typically work with open road_curve_main, but the AI
    # spline (which can drive the road in single-curve mode) is usually
    # cyclic.
    smoothed = list(raw_bank)
    for _ in range(max(0, int(smoothing_passes))):
        new = [0.0] * n
        for i in range(n):
            if cyclic:
                l = smoothed[(i - 1) % n]
                r = smoothed[(i + 1) % n]
            else:
                l = smoothed[i - 1] if i > 0 else smoothed[i]
                r = smoothed[i + 1] if i < n - 1 else smoothed[i]
            new[i] = (l + 2.0 * smoothed[i] + r) * 0.25
        smoothed = new

    for i, s in enumerate(samples):
        author_tilt = float(s.get("tilt", 0.0))
        s["bank"] = smoothed[i] + author_tilt


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

    radii, cyclic = _curve_control_radii(curve_obj)
    tilts = _curve_control_tilts(curve_obj)
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
        t_norm = i / denom
        r = _radius_at_t(radii, t_norm, cyclic)
        tilt = _tilt_at_t(tilts, t_norm, cyclic)
        samples.append({
            "x": x, "y": y, "z": 0.0,
            "tx": dx / tl, "ty": dy / tl,
            "r": r, "t": t_norm, "tilt": tilt,
        })

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


def _build_road_strip_mesh(
    samples: list[dict],
    *,
    width: float,
    lift: float,
    thickness: float = 0.0,
    curb_width: float = 0.0,
    curb_height: float = 0.0,
    curb_stripe_length: float = 2.0,
) -> bpy.types.Mesh:
    """Build a road-slab mesh from the (x, y, z, tx, ty) samples.

    Top-face column layout (left to right):

        curb_L_outer ─ curb_L_inner = road_L ──── road_R = curb_R_inner ─ curb_R_outer
                       (when curb_width > 0)               (when curb_width > 0)

    The curb verts are elevated by `curb_height` above the road surface;
    each curb stripe (one quad along the road's tangent) gets a
    `material_index` of 1 (white) or 2 (red) on an alternating
    `curb_stripe_length`-metre cadence, producing F1-style serrated
    rumble strips.

    When `thickness > 0` the strip is extruded downward into a slab —
    two extra outer-edge verts per sample at `z_road - thickness`, plus
    side / bottom / end-cap faces. The thicker silhouette reads as a
    real banked road (vs. a paper ribbon) and pushes the road's
    underside well below the conformed terrain so Z-fighting along the
    flattened band is gone.
    """
    if ROAD_MESH_NAME in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[ROAD_MESH_NAME])
    me = bpy.data.meshes.new(ROAD_MESH_NAME)
    half_w = width / 2.0
    has_curbs = curb_width > 0 and curb_height >= 0
    has_thickness = thickness > 0
    outer_half = half_w + (curb_width if has_curbs else 0.0)

    # Per-sample TOP cols: 2 (no curb) or 4 (with curb).
    top_cols = 4 if has_curbs else 2
    # Per-sample BOTTOM cols when thickness > 0: 2 at the outer edges.
    bot_cols = 2 if has_thickness else 0
    cols_per_sample = top_cols + bot_cols

    verts: list[tuple[float, float, float]] = []
    for s in samples:
        nx = -s["ty"]
        ny = s["tx"]
        z_road = s["z"] + lift
        # Per-sample radius from the curve's control-point `radius`
        # field (linearly interpolated, default 1.0). Scales width and
        # curb-band horizontally so apexes can be wider than straights.
        r = float(s.get("r", 1.0))
        hw = half_w * r
        outer_h = outer_half * r
        # Bank: rotate the cross-section around the tangent axis so the
        # outside edge of a corner lifts and the inside drops. `bank`
        # is signed radians; positive bank corresponds to a positive
        # signed-curvature corner (CCW / left turn in Blender XY where
        # the cross product of consecutive segments is positive).
        #
        # Geometry: for tangent (tx, ty), the cross-section perp
        # `(nx, ny) = (-ty, tx)` points toward the LEFT side of the
        # road (the *inside* of a left turn). Racing-line banking
        # convention: tilt so the inside is LOWER than the outside.
        # Therefore positive bank should LOWER the +nx side and LIFT
        # the -nx side — opposite the naive "lat * bank" lift.
        #
        # We use the linear-tangent approximation (sin ≈ bank) since
        # at the configured 25° max the error is < 3% and it's one
        # less trig per vertex.
        bank = float(s.get("bank", 0.0))

        def _lift_for(lat: float) -> float:
            # `lat` positive = +nx side (left / inside of left turn);
            # negative = -nx side (right / outside of left turn).
            # Negating ensures positive bank tilts the road INTO the
            # corner as authors expect.
            return -lat * bank

        if has_curbs:
            z_curb = z_road + curb_height
            verts.append((
                s["x"] - nx * outer_h,
                s["y"] - ny * outer_h,
                z_curb + _lift_for(-outer_h),
            ))
            verts.append((
                s["x"] - nx * hw,
                s["y"] - ny * hw,
                z_road + _lift_for(-hw),
            ))
            verts.append((
                s["x"] + nx * hw,
                s["y"] + ny * hw,
                z_road + _lift_for(hw),
            ))
            verts.append((
                s["x"] + nx * outer_h,
                s["y"] + ny * outer_h,
                z_curb + _lift_for(outer_h),
            ))
        else:
            verts.append((
                s["x"] - nx * outer_h,
                s["y"] - ny * outer_h,
                z_road + _lift_for(-outer_h),
            ))
            verts.append((
                s["x"] + nx * outer_h,
                s["y"] + ny * outer_h,
                z_road + _lift_for(outer_h),
            ))
        if has_thickness:
            z_bot = z_road - thickness
            verts.append((
                s["x"] - nx * outer_h,
                s["y"] - ny * outer_h,
                z_bot + _lift_for(-outer_h),
            ))
            verts.append((
                s["x"] + nx * outer_h,
                s["y"] + ny * outer_h,
                z_bot + _lift_for(outer_h),
            ))

    faces: list[tuple[int, int, int, int]] = []
    face_mats: list[int] = []

    # Indices within a sample's column block. The bottom row sits after
    # whatever top cols are present, so its slot indices are fixed
    # relative to `top_cols`.
    L_OUT_TOP = 0
    R_OUT_TOP = top_cols - 1  # last top col is always the right outer edge
    L_BOT = top_cols          # first bottom col
    R_BOT = top_cols + 1

    arc = 0.0
    for i in range(len(samples) - 1):
        a = i * cols_per_sample
        b = (i + 1) * cols_per_sample
        seg_len = math.hypot(
            samples[i + 1]["x"] - samples[i]["x"],
            samples[i + 1]["y"] - samples[i]["y"],
        )
        stripe_idx = int(arc // max(curb_stripe_length, 0.01)) if has_curbs else 0
        curb_mat = 1 + (stripe_idx % 2)
        if has_curbs:
            faces.append((a + 0, b + 0, b + 1, a + 1)); face_mats.append(curb_mat)
            faces.append((a + 1, b + 1, b + 2, a + 2)); face_mats.append(0)
            faces.append((a + 2, b + 2, b + 3, a + 3)); face_mats.append(curb_mat)
        else:
            faces.append((a + 0, b + 0, b + 1, a + 1)); face_mats.append(0)
        if has_thickness:
            # Slab sides and bottom use the underside material (slot 3
            # when curbs are present, slot 1 when they aren't). The
            # underside reads as concrete bridge structure on
            # cross-valley shots instead of disappearing into asphalt.
            underside_slot = 3 if has_curbs else 1
            # Left side: outer-top → bottom-left, span sample i→i+1.
            faces.append((a + L_OUT_TOP, a + L_BOT, b + L_BOT, b + L_OUT_TOP))
            face_mats.append(underside_slot)
            # Right side: bottom-right → outer-top.
            faces.append((a + R_OUT_TOP, b + R_OUT_TOP, b + R_BOT, a + R_BOT))
            face_mats.append(underside_slot)
            # Bottom face — normal faces -Z (CCW seen from below).
            faces.append((a + L_BOT, a + R_BOT, b + R_BOT, b + L_BOT))
            face_mats.append(underside_slot)
        arc += seg_len

    # End caps so the slab reads as solid from the front/back. Skipped
    # when thickness == 0 (the ribbon doesn't need them).
    if has_thickness and len(samples) >= 2:
        first = 0
        last = (len(samples) - 1) * cols_per_sample
        underside_slot = 3 if has_curbs else 1
        # Front cap at sample 0: outer-L-top → outer-R-top → bottom-R → bottom-L.
        # Winding so the normal points OPPOSITE the road tangent.
        faces.append((first + L_OUT_TOP, first + L_BOT, first + R_BOT, first + R_OUT_TOP))
        face_mats.append(underside_slot)
        # Back cap at last sample: reversed winding.
        faces.append((last + L_OUT_TOP, last + R_OUT_TOP, last + R_BOT, last + L_BOT))
        face_mats.append(underside_slot)

    me.from_pydata(verts, [], faces)
    me.update()
    for i, poly in enumerate(me.polygons):
        poly.use_smooth = False
        poly.material_index = face_mats[i]
    return me


def _conform_terrain_to_road(
    terrain_obj: bpy.types.Object,
    samples: list[dict],
    *,
    width: float,
    blend_radius: float,
    lift: float,
    curb_width: float = 0.0,
    clearance: float = 0.05,
) -> dict:
    """Push each terrain vertex within `(width/2 + curb_width + blend_radius)`
    of the road centerline toward the road's local Z. Inside the road
    footprint (`d ≤ width/2`) the vertex snaps to the road's reference
    altitude (`sample_z`), so the road strip mesh sits `lift` metres
    above. Inside the curb band (`d ≤ width/2 + curb_width`) the same
    snap applies — the curbs themselves rise `curb_height` above the
    road, so terrain can't pop through them. The outer band smoothsteps
    back to natural terrain.

    A `clearance` cap (default 5 cm) clamps the result so a steep
    hillside can never poke up *through* the drivable surface — the
    earlier "terrain jumped" symptom on the template island was a
    coarse-grid vertex inside the blend band ending up above the road
    surface and slicing through the strip mesh. The cap follows the
    same smoothstep so the visual transition stays seamless.

    Returns a summary `{flattened, blended}` count for the report."""
    from mathutils.kdtree import KDTree

    if not samples:
        return {"flattened": 0, "blended": 0}

    half_w = width / 2.0
    # The "fully flattened" zone now spans the road *plus* the curbs so
    # the curb stripes themselves don't fight the terrain.
    inner = half_w + max(0.0, curb_width)
    outer = inner + max(0.0, blend_radius)
    # Cap ceiling: clamped to the *road* surface (= sample_z + lift),
    # NOT the curb top. Curbs rise above the road and we want terrain
    # to sit below the lowest drivable point so nothing pokes through
    # the road quad. Curbs themselves are a separate elevated mesh and
    # their bases meet flush with the terrain at the road edge.
    surface_lift = lift

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
        # Cap: never let the terrain rise above the drivable surface.
        # The cap rises with (1 - blend) so it disappears at d=outer.
        surface_z = target_z + surface_lift - clearance
        max_allowed = surface_z + (world.z - surface_z) * (1.0 - blend)
        if new_world_z > max_allowed:
            new_world_z = max_allowed
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
        # Single-curve mode: prefer `road_curve_main` if present, else
        # fall back to `ai_spline_main`. Authors who want one curve for
        # both racing line and road can author only the AI spline and
        # the road follows it; authors who want a different road shape
        # (e.g., wider apex) add a separate `road_curve_main`.
        curve_obj = _resolve_road_curve()
        if curve_obj is None:
            self.report(
                {"ERROR"},
                "No road curve found — click *Add Road Curve* or "
                "create an `ai_spline_main` curve.",
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
        # Wipe any prior road_main BEFORE sampling — _sample_road_path's
        # downward raycast would otherwise hit the existing road strip
        # and treat it as terrain. Each re-run would then lift the road
        # by another `lift` metres, racing the terrain up.
        old_road = bpy.data.objects.get(ROAD_OBJECT_NAME)
        if old_road is not None:
            old_road_mesh = old_road.data
            bpy.data.objects.remove(old_road, do_unlink=True)
            if isinstance(old_road_mesh, bpy.types.Mesh) and old_road_mesh.users == 0:
                bpy.data.meshes.remove(old_road_mesh)

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
        curb_width = float(scene.hoverbike_road_curb_width)
        curb_height = float(scene.hoverbike_road_curb_height)
        curb_stripe = float(scene.hoverbike_road_curb_stripe_length)
        thickness = float(scene.hoverbike_road_thickness)
        bank_strength = float(scene.hoverbike_road_bank_strength)
        bank_max_rad = math.radians(float(scene.hoverbike_road_bank_max_deg))

        # Stamp the bank angle on each sample. Mutates `samples` in
        # place to add an `s["bank"]` field that `_build_road_strip_mesh`
        # consumes when laying out the cross-section. The curve's
        # cyclic flag matters here — a closed loop wraps so the join
        # doesn't get a fake straight, while an open road clamps so
        # the endpoints don't pick up a wrap-around bogus curvature.
        curve_cyclic = bool(curve_obj.data.splines and curve_obj.data.splines[0].use_cyclic_u)
        _compute_per_sample_bank(
            samples,
            bank_strength=bank_strength,
            bank_max_rad=bank_max_rad,
            cyclic=curve_cyclic,
        )

        # Deform terrain first, then build the road strip — that way the
        # road's Z (sampled before deformation) sits on the *original*
        # surface and the terrain rises/falls to meet it. The conform
        # treats the curb band as part of the road footprint so curbs
        # don't fight the surrounding terrain.
        deform_summary = _conform_terrain_to_road(
            terrain,
            samples,
            width=width,
            blend_radius=blend_radius,
            lift=lift,
            curb_width=curb_width,
        )

        # Build the road strip mesh (the prior `road_main`, if any, was
        # removed before sampling above so the raycast saw fresh terrain).
        me = _build_road_strip_mesh(
            samples,
            width=width,
            lift=lift,
            thickness=thickness,
            curb_width=curb_width,
            curb_height=curb_height,
            curb_stripe_length=curb_stripe,
        )
        # Slot order MUST match the face material_index values emitted
        # by `_build_road_strip_mesh`:
        #   curbs ON:  0 asphalt | 1 curb-white | 2 curb-red | 3 underside
        #   curbs OFF: 0 asphalt | 1 underside
        me.materials.append(_ensure_road_material())
        if curb_width > 0:
            me.materials.append(_ensure_curb_material(red=False))
            me.materials.append(_ensure_curb_material(red=True))
        if thickness > 0:
            me.materials.append(_ensure_road_underside_material())
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


# ── Tunnel tool ────────────────────────────────────────────────────────────
#
# A tunnel is three things in lockstep:
#
#   tunnel_curve_main           — user-edited Bezier through the hill.
#   tunnel_main_cutter          — closed manifold cylinder swept along
#                                  the curve. Hidden from viewport +
#                                  export, lives in a dedicated
#                                  ``_hoverbike_tunnel_cutters``
#                                  collection.
#   tunnel_main_interior        — inward-facing cylindrical shell along
#                                  the same curve. ``kind="track"`` so
#                                  the runtime trimesh collider
#                                  attaches → the player can slap into
#                                  the walls. Slightly smaller radius
#                                  than the cutter so the shell sits
#                                  inside the hole.
#
# The terrain mesh carries a single Boolean DIFFERENCE modifier whose
# operand is the cutters *collection* (not a single object), so a
# second tunnel just drops another cutter into the collection and the
# modifier picks it up. ``export_apply=True`` on the glTF exporter
# bakes the modifier so the GLB carries the actually-carved geometry —
# the game side needs zero new code to make the bike pass through.
#
# Why a cutter mesh instead of directly modifying the terrain: keeping
# the cut as a modifier means the user can move the tunnel curve and
# rebuild without re-baking terrain. The Boolean modifier re-evaluates
# from the current cutter on every depsgraph update; viewport shows the
# carved hole live.

TUNNEL_CURVE_NAME = "tunnel_curve_main"
TUNNEL_PARENT_PREFIX = "tunnel_"
TUNNEL_CUTTERS_COLLECTION = "_hoverbike_tunnel_cutters"
TUNNEL_BOOLEAN_MOD_NAME = "HV_Tunnel_Cut"
TUNNEL_SOLIDIFY_MOD_NAME = "HV_Tunnel_Solidify"
TUNNEL_SOLIDIFY_THICKNESS = 200.0  # m — terrain extruded down by this much
TUNNEL_MATERIAL_NAME = "mat_track_tunnel"


def _ensure_tunnel_material() -> bpy.types.Material:
    """Concrete-liner material for the inside of a tunnel. Dark
    enough to read as "inside a hill" against the brighter outside
    terrain, with a slight blue cast so it doesn't disappear into the
    runtime fog. Same material shared by every tunnel; the runtime
    trimesh collider attaches automatically via the standard
    kind="track" rule."""
    mat = bpy.data.materials.get(TUNNEL_MATERIAL_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(TUNNEL_MATERIAL_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.18, 0.19, 0.22, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.78
        spec = bsdf.inputs.get("Specular IOR Level") or bsdf.inputs.get("Specular")
        if spec is not None:
            spec.default_value = 0.3
    return mat


def _ensure_tunnel_cutters_collection(scene) -> bpy.types.Collection:
    """Get-or-create the hidden collection that holds every tunnel
    cutter. Hidden in the viewport + render so the closed cylinder
    doesn't show, but the collection still exists in the depsgraph so
    the terrain's Boolean modifier evaluates against it."""
    col = bpy.data.collections.get(TUNNEL_CUTTERS_COLLECTION)
    if col is None:
        col = bpy.data.collections.new(TUNNEL_CUTTERS_COLLECTION)
        scene.collection.children.link(col)
    col.hide_render = True
    # Hide the collection from the active view layer so the cutter
    # cylinders don't clutter the viewport. The boolean modifier
    # still resolves against the collection's objects in the
    # depsgraph regardless of LayerCollection.exclude state.
    vl = bpy.context.view_layer
    lc = _find_layer_collection(vl.layer_collection, TUNNEL_CUTTERS_COLLECTION)
    if lc is not None:
        lc.hide_viewport = True
    return col


def _sample_tunnel_curve(curve_obj: bpy.types.Object, n_samples: int) -> list[dict]:
    """Arc-length sampling of the tunnel curve. Returns
    ``[{x, y, z, tx, ty, tz}, ...]`` in world coordinates. Unlike the
    road sampler, we keep the curve's authored Z (the whole point of
    a tunnel is to dive *below* terrain) — no terrain raycast."""
    raw = _sample_curve_to_polyline(curve_obj)
    if len(raw) < 2:
        return []
    # 3D arc length so steep tunnels are sampled at uniform travel
    # distance, not horizontal distance.
    cum = [0.0]
    for i in range(len(raw) - 1):
        a, b = raw[i], raw[i + 1]
        cum.append(cum[-1] + math.sqrt(
            (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2
        ))
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
        z = a[2] + (b[2] - a[2]) * frac
        dx = b[0] - a[0]
        dy = b[1] - a[1]
        dz = b[2] - a[2]
        tl = math.sqrt(dx * dx + dy * dy + dz * dz) or 1.0
        samples.append({
            "x": x, "y": y, "z": z,
            "tx": dx / tl, "ty": dy / tl, "tz": dz / tl,
        })
    return samples


def _tunnel_ring_basis(tx: float, ty: float, tz: float) -> tuple[
    tuple[float, float, float], tuple[float, float, float]
]:
    """Pick a (right, up) basis perpendicular to a tangent so each
    ring around the tunnel sits flat against the tube direction.

    Strategy: keep ``up`` as world-up unless the tangent is nearly
    vertical (steep tunnel), in which case fall back to world-+X to
    avoid a degenerate basis. The two basis vectors are orthonormalised
    against the tangent so the ring stays planar even when the tunnel
    pitches up or down."""
    t = mathutils.Vector((tx, ty, tz)).normalized()
    world_up = mathutils.Vector((0.0, 0.0, 1.0))
    if abs(t.dot(world_up)) > 0.95:
        world_up = mathutils.Vector((1.0, 0.0, 0.0))
    right = t.cross(world_up).normalized()
    up = right.cross(t).normalized()
    return (right.x, right.y, right.z), (up.x, up.y, up.z)


def _build_tunnel_interior_mesh(
    name: str, samples: list[dict], *, radius: float, segments: int
) -> bpy.types.Mesh:
    """Inward-facing cylindrical shell along the sampled curve. No end
    caps — the tunnel is open at entrance + exit so the player can
    drive in/out. Inward winding means the visible faces (when looking
    along the tunnel) are the inner walls; the outer surface faces
    into the boolean-cut hole and is hidden.

    Generated with shade_smooth so the cylinder reads as a rounded
    tube rather than a faceted prism."""
    me = bpy.data.meshes.new(name)
    if len(samples) < 2 or segments < 3:
        me.from_pydata([], [], [])
        return me

    verts: list[tuple[float, float, float]] = []
    for s in samples:
        right, up = _tunnel_ring_basis(s["tx"], s["ty"], s["tz"])
        rx, ry, rz = right
        ux, uy, uz = up
        cx, cy, cz = s["x"], s["y"], s["z"]
        for i in range(segments):
            theta = 2.0 * math.pi * i / segments
            cs = math.cos(theta)
            sn = math.sin(theta)
            ox = rx * cs * radius + ux * sn * radius
            oy = ry * cs * radius + uy * sn * radius
            oz = rz * cs * radius + uz * sn * radius
            verts.append((cx + ox, cy + oy, cz + oz))

    faces: list[tuple[int, ...]] = []
    for j in range(len(samples) - 1):
        for i in range(segments):
            i_next = (i + 1) % segments
            a = j * segments + i
            b = j * segments + i_next
            c = (j + 1) * segments + i_next
            d = (j + 1) * segments + i
            # Reverse winding (a,d,c,b instead of a,b,c,d) so the
            # mesh's normals point inward toward the tunnel axis.
            faces.append((a, d, c, b))

    me.from_pydata(verts, [], faces)
    me.update(calc_edges=True)
    me.shade_smooth()
    return me


def _build_tunnel_cutter_mesh(
    name: str,
    samples: list[dict],
    *,
    radius: float,
    segments: int,
    end_extend: float,
) -> bpy.types.Mesh:
    """Closed manifold cylinder swept along the samples, used as the
    Boolean DIFFERENCE operand on the terrain. Slightly larger radius
    than the interior shell so the carved hole is clear of the visible
    walls.

    The cylinder is extended past the sampled endpoints by ``end_extend``
    metres along the local tangent so the cut clears the terrain
    surface even if the user's curve endpoints land right *on* the
    hillside (otherwise the boolean leaves a thin terrain shell
    capping the tunnel mouth).

    Closed manifold = end caps included. The Boolean modifier requires
    a closed shape to compute volume difference correctly."""
    me = bpy.data.meshes.new(name)
    if len(samples) < 2 or segments < 3:
        me.from_pydata([], [], [])
        return me

    extended: list[dict] = []
    s0 = samples[0]
    extended.append({
        **s0,
        "x": s0["x"] - s0["tx"] * end_extend,
        "y": s0["y"] - s0["ty"] * end_extend,
        "z": s0["z"] - s0["tz"] * end_extend,
    })
    extended.extend(samples)
    sN = samples[-1]
    extended.append({
        **sN,
        "x": sN["x"] + sN["tx"] * end_extend,
        "y": sN["y"] + sN["ty"] * end_extend,
        "z": sN["z"] + sN["tz"] * end_extend,
    })

    verts: list[tuple[float, float, float]] = []
    for s in extended:
        right, up = _tunnel_ring_basis(s["tx"], s["ty"], s["tz"])
        rx, ry, rz = right
        ux, uy, uz = up
        cx, cy, cz = s["x"], s["y"], s["z"]
        for i in range(segments):
            theta = 2.0 * math.pi * i / segments
            cs = math.cos(theta)
            sn = math.sin(theta)
            ox = rx * cs * radius + ux * sn * radius
            oy = ry * cs * radius + uy * sn * radius
            oz = rz * cs * radius + uz * sn * radius
            verts.append((cx + ox, cy + oy, cz + oz))

    faces: list[tuple[int, ...]] = []
    # Outward-facing cylinder walls.
    for j in range(len(extended) - 1):
        for i in range(segments):
            i_next = (i + 1) % segments
            a = j * segments + i
            b = j * segments + i_next
            c = (j + 1) * segments + i_next
            d = (j + 1) * segments + i
            faces.append((a, b, c, d))
    # Front cap: the segments-vert ring at the start, wound CW from
    # outside so the cap face points away from the cylinder body.
    front_cap = tuple(range(segments - 1, -1, -1))
    faces.append(front_cap)
    # Back cap: the segments-vert ring at the end, wound CCW.
    back_start = (len(extended) - 1) * segments
    back_cap = tuple(range(back_start, back_start + segments))
    faces.append(back_cap)

    me.from_pydata(verts, [], faces)
    me.update(calc_edges=True)
    return me


def _next_tunnel_index() -> int:
    """First free index NN such that ``tunnel_NN_*`` isn't used yet."""
    i = 0
    while True:
        name = f"{TUNNEL_PARENT_PREFIX}{i:02d}_interior"
        if name not in bpy.data.objects:
            return i
        i += 1


def _ensure_terrain_tunnel_boolean(terrain: bpy.types.Object, cutters: bpy.types.Collection) -> None:
    """Make sure ``terrain`` has a Solidify+Boolean modifier pair so
    cutters can carve a real tube through it.

    Why Solidify first: terrain meshes are 2-D sheets (a heightfield
    plane). Boolean DIFFERENCE on a sheet by a 3-D cylinder only
    intersects the sheet where the cylinder *crosses* it — i.e. at
    the mouth rim — not through the volume between the surface and
    the tunnel axis. The visible result is a small ring at each mouth
    with no actual tube through the mountain.

    With a Solidify pre-pass (offset=-1, thickness=200 m, downward
    extrusion only), the terrain becomes a thick crust 200 m deep.
    The Boolean then carves the cylinder volume out of that crust,
    producing the expected cylindrical tube through the hill that
    you can see / fly through.

    Both modifiers are named (``HV_Tunnel_Solidify``,
    ``HV_Tunnel_Cut``) so authors can spot + tune them in the
    Properties panel without breaking the addon's bookkeeping. The
    modifier order matters: Solidify must come *before* Boolean so
    the boolean operates on the thickened mesh."""
    sol = terrain.modifiers.get(TUNNEL_SOLIDIFY_MOD_NAME)
    if sol is None:
        sol = terrain.modifiers.new(name=TUNNEL_SOLIDIFY_MOD_NAME, type="SOLIDIFY")
    sol.thickness = TUNNEL_SOLIDIFY_THICKNESS
    # offset=-1 extrudes only on the *negative-normal* side. With the
    # heightfield's normals pointing up (the standard Blender plane
    # orientation), this means downward — the crust extends from the
    # surface down by `thickness`. The original surface stays put;
    # nothing visible changes from above.
    sol.offset = -1.0
    # Disable rim filling so the open edges of the original sheet
    # don't seal closed (would otherwise create a giant box).
    sol.use_rim = False

    mod = terrain.modifiers.get(TUNNEL_BOOLEAN_MOD_NAME)
    if mod is None:
        mod = terrain.modifiers.new(name=TUNNEL_BOOLEAN_MOD_NAME, type="BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.operand_type = "COLLECTION"
    mod.collection = cutters
    # 'EXACT' produces clean cuts on the high-poly terrain mesh; 'FAST'
    # is meaningfully faster but sometimes misses overlapping faces at
    # the tunnel mouth. EXACT it is.
    mod.solver = "EXACT"

    # Belt-and-braces: ensure modifier order is Solidify → Boolean.
    # If the user reordered them in the Properties panel, fix it.
    names = [m.name for m in terrain.modifiers]
    sol_idx = names.index(TUNNEL_SOLIDIFY_MOD_NAME)
    cut_idx = names.index(TUNNEL_BOOLEAN_MOD_NAME)
    if sol_idx > cut_idx:
        # Move the Boolean down past Solidify by re-creating it last.
        # bpy.ops.object.modifier_move_to_index needs the object to be
        # active; the no-ops bail-out path above means we only hit this
        # branch on the rare reorder case, so the active-object dance
        # is acceptable.
        prev_active = bpy.context.view_layer.objects.active
        bpy.context.view_layer.objects.active = terrain
        try:
            bpy.ops.object.modifier_move_to_index(
                modifier=TUNNEL_BOOLEAN_MOD_NAME,
                index=len(terrain.modifiers) - 1,
            )
        except RuntimeError:
            pass
        finally:
            bpy.context.view_layer.objects.active = prev_active


def _add_tunnel_starter_curve(scene) -> bpy.types.Object:
    """Create a 4-point Bezier curve named ``tunnel_curve_main``
    starting near the world origin, ready for the user to edit into
    place. Picks a length / depth that's reasonable for the default
    8 m tunnel radius — long enough to actually thread through a
    hill, short enough that the user can grab the handles without
    pulling them off-screen.

    Picks a horizontal default; user lifts the middle two handles or
    drops the entire curve into the hill they're tunneling through."""
    existing = bpy.data.objects.get(TUNNEL_CURVE_NAME)
    if existing is not None:
        return existing
    curve_data = bpy.data.curves.new(TUNNEL_CURVE_NAME, type="CURVE")
    curve_data.dimensions = "3D"
    spline = curve_data.splines.new(type="BEZIER")
    spline.bezier_points.add(3)  # 1 implicit + 3 new = 4 total
    # ~120 m long, sat at z=10 m so it threads through the middle of a
    # typical 20-50 m hill on the existing templates. The user G/R/S
    # the curve into their hill before clicking Build.
    coords = [(-60, 0, 10), (-20, 0, 12), (20, 0, 12), (60, 0, 10)]
    for bp, (x, y, z) in zip(spline.bezier_points, coords):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    spline.use_cyclic_u = False
    curve_data.resolution_u = 24
    obj = bpy.data.objects.new(TUNNEL_CURVE_NAME, curve_data)
    obj["kind"] = "tunnel_curve"
    scene.collection.objects.link(obj)
    return obj


def _wipe_tunnel(index: int) -> None:
    """Delete the cutter + interior meshes for tunnel index ``NN``.
    Used by *Build Tunnel* so a rebuild from the same curve replaces
    rather than stacking. The boolean modifier is left in place — it
    just operates on the (now smaller) cutters collection."""
    for suffix in ("_cutter", "_interior"):
        name = f"{TUNNEL_PARENT_PREFIX}{index:02d}{suffix}"
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        data = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        if isinstance(data, bpy.types.Mesh) and data.users == 0:
            bpy.data.meshes.remove(data)


class HOVERBIKE_OT_add_tunnel_starter_curve(Operator):
    """Spawn a ready-to-edit ``tunnel_curve_main`` Bezier through the
    middle of the scene. The user drags its control points into / out
    of a hillside, then clicks *Build Tunnel* to drill through."""

    bl_idname = "hoverbike.add_tunnel_starter_curve"
    bl_label = "Add Tunnel Starter Curve"
    bl_description = "Create a starter Bezier curve for the tunnel tool"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        obj = _add_tunnel_starter_curve(context.scene)
        # Select + activate so the user can immediately Tab into edit
        # mode and start shaping.
        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj
        self.report({"INFO"}, f"Created {obj.name}. Edit the curve, then click Build Tunnel.")
        return {"FINISHED"}


class HOVERBIKE_OT_build_tunnel(Operator):
    """Sweep a cutter cylinder + an interior shell along the active
    tunnel curve, and ensure the terrain mesh's Boolean DIFFERENCE
    modifier targets the cutters collection. Re-runs replace the
    most-recent tunnel rather than stacking (delete + re-build); to
    keep an existing tunnel, manually rename its cutter + interior
    before re-running.

    Default radius (8 m → 16 m wide × 16 m tall tube) is sized
    generously for arcade racing where the bike weaves through
    AI traffic; tighten it for "barely fit" claustrophobic feel."""

    bl_idname = "hoverbike.build_tunnel"
    bl_label = "Build Tunnel"
    bl_description = "Carve a tunnel through the terrain along tunnel_curve_main"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        curve = bpy.data.objects.get(TUNNEL_CURVE_NAME)
        if curve is None or curve.type != "CURVE":
            self.report({"ERROR"}, f"No {TUNNEL_CURVE_NAME} in scene. Click *Add Tunnel Starter Curve* first.")
            return {"CANCELLED"}
        terrain = _largest_terrain_mesh()
        if terrain is None:
            self.report({"ERROR"}, "No terrain mesh found (largest visible kind='track' mesh).")
            return {"CANCELLED"}

        radius = float(getattr(scene, "hoverbike_tunnel_radius", 8.0))
        wall_thickness = float(getattr(scene, "hoverbike_tunnel_wall_thickness", 1.0))
        n_samples = int(getattr(scene, "hoverbike_tunnel_samples", 32))
        segments = int(getattr(scene, "hoverbike_tunnel_segments", 14))
        end_extend = float(getattr(scene, "hoverbike_tunnel_end_extend", 4.0))
        if radius <= 0 or n_samples < 2 or segments < 3:
            self.report({"ERROR"}, "Invalid tunnel parameters — fix radius / samples / segments.")
            return {"CANCELLED"}

        samples = _sample_tunnel_curve(curve, n_samples)
        if not samples:
            self.report({"ERROR"}, f"Couldn't sample {curve.name!r} (need at least 2 control points).")
            return {"CANCELLED"}

        idx = _next_tunnel_index()
        # If the user wants the existing single-tunnel slot reused,
        # they'd rename the curve to free up tunnel_curve_main. For now
        # we always pick the next free slot, so re-runs from the same
        # curve stack new tunnels — handy when iterating placement.
        # If you want a clean rebuild, delete the prior tunnel_NN_*
        # objects by hand or via the panel button.

        cutter_mesh = _build_tunnel_cutter_mesh(
            f"{TUNNEL_PARENT_PREFIX}{idx:02d}_cutter_mesh",
            samples,
            radius=radius + wall_thickness,
            segments=segments,
            end_extend=end_extend,
        )
        cutter_obj = bpy.data.objects.new(f"{TUNNEL_PARENT_PREFIX}{idx:02d}_cutter", cutter_mesh)
        cutter_obj["kind"] = "tunnel_cutter"
        cutter_obj.display_type = "WIRE"
        # Park the cutter in the dedicated hidden collection so it's
        # out of sight but still in the depsgraph.
        cutters_col = _ensure_tunnel_cutters_collection(scene)
        cutters_col.objects.link(cutter_obj)
        # Belt-and-braces hide so the cutter doesn't appear in the
        # viewport, render, or GLB export even if the user un-hides
        # the collection.
        cutter_obj.hide_render = True
        cutter_obj.hide_set(True)

        interior_mesh = _build_tunnel_interior_mesh(
            f"{TUNNEL_PARENT_PREFIX}{idx:02d}_interior_mesh",
            samples,
            radius=radius,
            segments=segments,
        )
        interior_obj = bpy.data.objects.new(
            f"{TUNNEL_PARENT_PREFIX}{idx:02d}_interior", interior_mesh
        )
        interior_obj["kind"] = "track"
        interior_obj["tunnel_curve"] = curve.name
        interior_obj.data.materials.append(_ensure_tunnel_material())
        scene.collection.objects.link(interior_obj)

        _ensure_terrain_tunnel_boolean(terrain, cutters_col)

        self.report(
            {"INFO"},
            f"Built {interior_obj.name}: {len(samples)} samples, radius {radius:.1f}m. "
            f"Terrain boolean cut via {cutters_col.name}.",
        )
        return {"FINISHED"}


# ── Ramp tool ──────────────────────────────────────────────────────────────
#
# Geometry-Nodes-driven simple wedge ramp. Each ramp is an empty + child
# mesh:
#
#   ramp_NN       — parent empty. G/R/S in the viewport positions /
#                    aims / scales the whole ramp. The empty's Z-axis
#                    rotation aims the ramp's launch direction.
#                    kind="ramp" so Blender-side tooling reads it as one
#                    logical thing.
#   ramp_NN_mesh  — child mesh with the HV_Ramp Geometry-Nodes modifier.
#                    Three inputs (Length, Width, Height) drive a clean
#                    linear wedge — sharp leading edge at z=0, vertical
#                    back wall of height = Height. Mesh updates live as
#                    the sliders / empty transform change.
#                    kind="track" so the runtime trimesh-collider
#                    attaches at GLB-load time.

HV_RAMP_GROUP_NAME = "HV_Ramp"


def _ensure_hv_ramp_group() -> bpy.types.NodeTree:
    """Construct the `HV_Ramp` Geometry-Nodes group from scratch and
    return the NodeTree. Idempotent — drops the prior group first so
    we always rebuild from the current code.

    Topology: build a Mesh Cube sized (Width, Length, Height), shift it
    so the bottom face sits at z=0, then per-vertex move TOP verts to
    z = Height × ((y + L/2) / L). This collapses the front-top edge to
    the front-bottom edge (z=0 at the leading edge) and leaves the
    back-top edge at z=Height. Result: a clean linear wedge with no
    foundation slab, no profile curve, no taper math.

    The graph was iterated live in Blender via MCP and verified
    numerically before being baked here."""
    if HV_RAMP_GROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[HV_RAMP_GROUP_NAME])
    g = bpy.data.node_groups.new(HV_RAMP_GROUP_NAME, "GeometryNodeTree")

    def add_socket(name, in_out, stype, default=None, mn=None, mx=None):
        s = g.interface.new_socket(name, in_out=in_out, socket_type=stype)
        if default is not None: s.default_value = default
        if mn is not None: s.min_value = mn
        if mx is not None: s.max_value = mx
        return s

    add_socket("Geometry", "INPUT",  "NodeSocketGeometry")
    add_socket("Length",   "INPUT",  "NodeSocketFloat", 12.0, 0.1, 500.0)
    add_socket("Width",    "INPUT",  "NodeSocketFloat",  8.0, 0.1, 200.0)
    add_socket("Height",   "INPUT",  "NodeSocketFloat",  3.0, 0.0, 200.0)
    add_socket("Geometry", "OUTPUT", "NodeSocketGeometry")

    def add(kind, x, y, **kw):
        n = g.nodes.new(kind); n.location = (x, y)
        for k, v in kw.items():
            setattr(n, k, v)
        return n

    gi = add("NodeGroupInput",  -1500, 0)
    go = add("NodeGroupOutput",  1200, 0)

    # Mesh Cube (W, L, H). Vertices Z=2 keeps it a hollow shell; the
    # top + bottom faces are single quads, no interior subdivisions.
    n_size = add("ShaderNodeCombineXYZ", -1300, 200)
    g.links.new(gi.outputs["Width"],  n_size.inputs["X"])
    g.links.new(gi.outputs["Length"], n_size.inputs["Y"])
    g.links.new(gi.outputs["Height"], n_size.inputs["Z"])
    n_cube = add("GeometryNodeMeshCube", -1100, 0)
    g.links.new(n_size.outputs[0], n_cube.inputs["Size"])
    n_cube.inputs["Vertices X"].default_value = 2
    n_cube.inputs["Vertices Y"].default_value = 2
    n_cube.inputs["Vertices Z"].default_value = 2

    # Shift so the bottom face sits at z=0 (offset by +Height/2).
    n_half_h = add("ShaderNodeMath", -1100, -250, operation="DIVIDE")
    n_half_h.inputs[1].default_value = 2.0
    g.links.new(gi.outputs["Height"], n_half_h.inputs[0])
    n_shift_vec = add("ShaderNodeCombineXYZ", -900, -250)
    g.links.new(n_half_h.outputs[0], n_shift_vec.inputs["Z"])
    n_shift = add("GeometryNodeSetPosition", -700, 0)
    g.links.new(n_cube.outputs["Mesh"], n_shift.inputs["Geometry"])
    g.links.new(n_shift_vec.outputs[0], n_shift.inputs["Offset"])

    # Per-vertex Position + classifier (is_top = z > Height/2).
    n_pos = add("GeometryNodeInputPosition", -500, -200)
    n_xyz = add("ShaderNodeSeparateXYZ",     -300, -200)
    g.links.new(n_pos.outputs["Position"], n_xyz.inputs["Vector"])
    n_is_top = add("FunctionNodeCompare", -100, -300, data_type="FLOAT", operation="GREATER_THAN")
    g.links.new(n_xyz.outputs["Z"], n_is_top.inputs["A"])
    g.links.new(n_half_h.outputs[0], n_is_top.inputs["B"])

    # factor = (y + L/2) / L  (per-vertex normalized arc-length)
    n_half_l = add("ShaderNodeMath", -500, -500, operation="DIVIDE")
    n_half_l.inputs[1].default_value = 2.0
    g.links.new(gi.outputs["Length"], n_half_l.inputs[0])
    n_yshift = add("ShaderNodeMath", -300, -500, operation="ADD")
    g.links.new(n_xyz.outputs["Y"], n_yshift.inputs[0])
    g.links.new(n_half_l.outputs[0], n_yshift.inputs[1])
    n_factor = add("ShaderNodeMath", -100, -500, operation="DIVIDE", use_clamp=True)
    g.links.new(n_yshift.outputs[0], n_factor.inputs[0])
    g.links.new(gi.outputs["Length"], n_factor.inputs[1])

    # top_z = Height × factor — linear ramp from 0 (entry) to Height (back).
    n_top_z = add("ShaderNodeMath", 100, -500, operation="MULTIPLY")
    g.links.new(gi.outputs["Height"], n_top_z.inputs[0])
    g.links.new(n_factor.outputs[0],  n_top_z.inputs[1])

    # Switch z by is_top: top verts → top_z, bottom verts → 0 (literal default)
    n_switch = add("GeometryNodeSwitch", 400, -300, input_type="FLOAT")
    g.links.new(n_is_top.outputs["Result"], n_switch.inputs["Switch"])
    n_switch.inputs["False"].default_value = 0.0
    g.links.new(n_top_z.outputs[0], n_switch.inputs["True"])

    # Final position: keep X/Y, replace Z.
    n_combine = add("ShaderNodeCombineXYZ", 600, -200)
    g.links.new(n_xyz.outputs["X"], n_combine.inputs["X"])
    g.links.new(n_xyz.outputs["Y"], n_combine.inputs["Y"])
    g.links.new(n_switch.outputs["Output"], n_combine.inputs["Z"])
    n_setpos = add("GeometryNodeSetPosition", 800, 0)
    g.links.new(n_shift.outputs["Geometry"], n_setpos.inputs["Geometry"])
    g.links.new(n_combine.outputs[0], n_setpos.inputs["Position"])

    g.links.new(n_setpos.outputs["Geometry"], go.inputs["Geometry"])
    return g


def _socket_id_map(node_tree: bpy.types.NodeTree) -> dict[str, str]:
    """Map socket display name → identifier for a GN group's INPUT
    sockets. GN modifier inputs are addressed by `mod[identifier]`,
    not by display name; identifiers are auto-generated like
    `Socket_2` and survive across reloads but read poorly. This
    helper hides the identifier dance from the rest of the code."""
    out: dict[str, str] = {}
    for s in node_tree.interface.items_tree:
        if s.in_out == "INPUT":
            out[s.name] = s.identifier
    return out


def _create_gn_ramp(
    scene,
    *,
    location: tuple[float, float, float],
    rotation_z: float,
    length: float,
    width: float,
    height: float,
) -> tuple[bpy.types.Object, bpy.types.Object]:
    """Spawn a GN-driven ramp pair (empty + mesh) at `location`, with
    the empty's Z-axis rotated by `rotation_z` so G/R/S on the empty
    positions/aims the ramp.

    Returns (empty, mesh_obj) so callers can wire them up further
    (e.g. select the empty for the user)."""
    group = _ensure_hv_ramp_group()
    name = _next_ramp_object_name()

    empty = bpy.data.objects.new(name, None)
    empty.empty_display_type = "ARROWS"
    empty.empty_display_size = max(2.0, min(6.0, length * 0.3))
    empty["kind"] = "ramp"
    empty["ramp_height"] = float(height)
    empty["ramp_length"] = float(length)
    empty.location = location
    empty.rotation_euler = (0.0, 0.0, float(rotation_z))
    scene.collection.objects.link(empty)

    me = bpy.data.meshes.new(f"{name}_mesh_data")
    mesh_obj = bpy.data.objects.new(f"{name}_mesh", me)
    mesh_obj.parent = empty
    mesh_obj.matrix_parent_inverse.identity()
    # Mesh inherits the empty's transform via parenting. Empty carries
    # kind=ramp; the mesh ships into the GLB with kind=track so the
    # runtime collider attaches.
    mesh_obj["kind"] = "track"
    mesh_obj.data.materials.append(_ramp_material())
    scene.collection.objects.link(mesh_obj)

    mod = mesh_obj.modifiers.new(name="HV_Ramp", type="NODES")
    mod.node_group = group
    ids = _socket_id_map(group)
    mod[ids["Length"]] = float(length)
    mod[ids["Width"]]  = float(width)
    mod[ids["Height"]] = float(height)

    mesh_obj.update_tag()
    return empty, mesh_obj


class HOVERBIKE_OT_add_ramp(Operator):
    """Drop a wedge ramp at the 3D cursor. Two objects appear:

        ramp_NN       — parent empty. G/R/S to position / aim / scale.
                         Empty's Z-axis rotation aims the ramp.
        ramp_NN_mesh  — kind=track mesh with the HV_Ramp GN modifier.
                         Three sliders (Length, Width, Height) drive a
                         clean linear wedge: sharp leading edge at
                         ground level, vertical back wall = Height.
                         Mesh re-evaluates live when sliders change.

    Tune Length / Width / Height from the panel BEFORE clicking. To
    retune a placed ramp without affecting siblings, open the
    Modifiers tab on its mesh and edit the inputs directly."""

    bl_idname = "hoverbike.add_ramp"
    bl_label = "Add Ramp"
    bl_description = "Drop a parametric wedge ramp at the 3D cursor"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        length = float(scene.hoverbike_ramp_length)
        width  = float(scene.hoverbike_ramp_width)
        height = float(scene.hoverbike_ramp_height)

        if length <= 0 or width <= 0 or height <= 0:
            self.report({"ERROR"}, "Length / width / height must be positive.")
            return {"CANCELLED"}

        cursor = scene.cursor
        empty, mesh_obj = _create_gn_ramp(
            scene,
            location=tuple(cursor.location),
            rotation_z=float(cursor.rotation_euler.z),
            length=length, width=width, height=height,
        )

        # Select the empty so the next G/R/S keystroke moves the whole
        # ramp without the user having to click in the outliner.
        for o in context.selected_objects:
            o.select_set(False)
        empty.select_set(True)
        context.view_layer.objects.active = empty

        self.report(
            {"INFO"},
            f"Added {empty.name}: {length:.1f}m × {width:.1f}m × {height:.1f}m. "
            f"Edit dimensions on the mesh's HV_Ramp modifier.",
        )
        return {"FINISHED"}


RAMP_OBJECT_PREFIX = "ramp_"


def _next_ramp_object_name() -> str:
    """First free `ramp_NN` name. Avoids stomping prior ramps the user
    has placed and tuned, while keeping the numbering tidy."""
    i = 0
    while True:
        candidate = f"{RAMP_OBJECT_PREFIX}{i:02d}"
        if candidate not in bpy.data.objects:
            return candidate
        i += 1


# ── Boost pads ─────────────────────────────────────────────────────────────
#
# Author boost pads as `boost_NN` empties — same hybrid-pipeline pattern as
# `cp_NN` checkpoints. Each empty's local +Y axis is the boost direction
# (matches three.js +Z forward via the b2t mapping), Z position is the
# pad's height in world coords, custom props carry the runtime knobs.
#
# Visual: a flat slab mesh, child of the empty so it transforms with it.
# The slab's geometry tracks `half_width` / `half_depth` so authors can
# scrub those sliders and watch the pad resize in the viewport.

BOOST_PAD_OBJECT_PREFIX = "boost_"
BOOST_PAD_GIZMO_MATERIAL = "mat_boost_pad_preview"


def _boost_pad_material() -> bpy.types.Material:
    """Cyan emissive slab material so the pad reads as a glowing boost
    plate against any terrain. Same colour family as the in-game
    boost-pad helper (`makePadHelper` in editor-helpers.ts)."""
    mat = bpy.data.materials.get(BOOST_PAD_GIZMO_MATERIAL)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(BOOST_PAD_GIZMO_MATERIAL)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.20, 0.85, 1.0, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.4
        try:
            bsdf.inputs["Emission Color"].default_value = (0.20, 0.85, 1.0, 1.0)
            bsdf.inputs["Emission Strength"].default_value = 1.5
        except KeyError:
            pass
    return mat


def _build_boost_pad_gizmo_mesh(name: str, *, half_width: float, half_depth: float) -> bpy.types.Mesh:
    """Pad slab in local +Y-forward coords: a flat rectangle in the XY
    plane (slab thickness ~0.1 m) with a forward-pointing arrow on top
    so the boost direction is unambiguous in the viewport. The slab
    matches the runtime collider's `halfWidth × halfDepth` bounds so
    visual placement reflects the actual trigger volume."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    hw = half_width
    hd = half_depth
    z_lo = 0.0
    z_hi = 0.1
    arr_len = hd * 0.6
    arr_w = hw * 0.4
    verts = [
        # Slab bottom rect (4)
        (-hw, -hd, z_lo), ( hw, -hd, z_lo),
        ( hw,  hd, z_lo), (-hw,  hd, z_lo),
        # Slab top rect (4)
        (-hw, -hd, z_hi), ( hw, -hd, z_hi),
        ( hw,  hd, z_hi), (-hw,  hd, z_hi),
        # Top-face arrow (3) — points along +Y so the empty's +Y
        # carries the visual direction.
        (-arr_w, -arr_len * 0.4, z_hi + 0.02),
        ( arr_w, -arr_len * 0.4, z_hi + 0.02),
        ( 0.0,    arr_len,        z_hi + 0.02),
    ]
    faces = [
        (0, 1, 2, 3),       # bottom
        (4, 7, 6, 5),       # top (CCW from +Z)
        (0, 4, 5, 1),       # -Y side
        (1, 5, 6, 2),       # +X side
        (2, 6, 7, 3),       # +Y side
        (3, 7, 4, 0),       # -X side
        (8, 9, 10),         # arrow on top
    ]
    me.from_pydata(verts, [], faces)
    me.update()
    me.materials.append(_boost_pad_material())
    return me


def _next_boost_pad_name() -> str:
    """First free `boost_NN` slot. Zero-padded to two digits to match
    the `cp_NN` / `start_NN` convention (lexicographic sort = numeric)."""
    i = 0
    while True:
        name = f"{BOOST_PAD_OBJECT_PREFIX}{i:02d}"
        if name not in bpy.data.objects:
            return name
        i += 1


BOOST_PAD_PREVIEW_COLLECTION = "_hoverbike_boost_pad_preview"


def _refresh_boost_pad_gizmos(scene) -> int:
    """Rebuild every `boost_NN` empty's child slab so the visual
    geometry tracks the empty's `half_width` / `half_depth` props after
    they're scrubbed. Gizmos live in `_hoverbike_boost_pad_preview` so
    `_PreviewCollectionsHidden` scrubs them at export time — only the
    boost_NN empty itself round-trips through the JSON, and the runtime
    builds its own visual via `makePadHelper`. Safe no-op if there are
    no boost pads in the scene."""
    coll = bpy.data.collections.get(BOOST_PAD_PREVIEW_COLLECTION)
    boost_empties = [
        o for o in scene.objects if re.match(r"^boost_(\d+)$", o.name)
    ]
    if not boost_empties:
        # Tear down the empty preview collection so it doesn't dangle.
        if coll is not None:
            for o in list(coll.objects):
                bpy.data.objects.remove(o, do_unlink=True)
            bpy.data.collections.remove(coll)
        return 0
    if coll is None:
        coll = bpy.data.collections.new(BOOST_PAD_PREVIEW_COLLECTION)
        scene.collection.children.link(coll)

    # Drop gizmos that no longer correspond to any empty (renames /
    # deletes leave orphans otherwise).
    valid_gizmo_names = {f"{o.name}_gizmo" for o in boost_empties}
    for o in list(coll.objects):
        if o.name not in valid_gizmo_names:
            data = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if isinstance(data, bpy.types.Mesh) and data.users == 0:
                bpy.data.meshes.remove(data)

    refreshed = 0
    for obj in boost_empties:
        hw = float(obj.get("half_width", 3.0))
        hd = float(obj.get("half_depth", 6.0))
        gizmo_name = f"{obj.name}_gizmo"
        mesh_name = f"{obj.name}_gizmo_mesh"
        mesh = _build_boost_pad_gizmo_mesh(mesh_name, half_width=hw, half_depth=hd)
        gizmo = bpy.data.objects.get(gizmo_name)
        if gizmo is None:
            gizmo = bpy.data.objects.new(gizmo_name, mesh)
            coll.objects.link(gizmo)
        else:
            # Gizmo exists but might be in the wrong collection (e.g. an
            # earlier addon revision parked it in scene.collection).
            for c in list(gizmo.users_collection):
                c.objects.unlink(gizmo)
            coll.objects.link(gizmo)
            old_mesh = gizmo.data
            gizmo.data = mesh
            if isinstance(old_mesh, bpy.types.Mesh) and old_mesh.users == 0 and old_mesh.name != mesh.name:
                bpy.data.meshes.remove(old_mesh)
        if gizmo.parent != obj:
            gizmo.parent = obj
            gizmo.matrix_parent_inverse.identity()
            gizmo.location = (0.0, 0.0, 0.0)
            gizmo.rotation_euler = (0.0, 0.0, 0.0)
        gizmo.hide_render = True
        gizmo.hide_select = True
        refreshed += 1
    return refreshed


def _on_boost_pad_prop_changed(self, context):
    """Custom-property update callback fires when half_width / half_depth
    / strength are scrubbed on a `boost_NN` empty. Rebuild the gizmos so
    the visual matches the new bounds immediately."""
    scene = context.scene if context is not None else bpy.context.scene
    if scene is not None:
        _refresh_boost_pad_gizmos(scene)


class HOVERBIKE_OT_add_boost_pad(Operator):
    """Drop a `boost_NN` empty at the 3D cursor. The empty carries the
    pad's runtime knobs as custom properties (`half_width`, `half_depth`,
    `strength`) and exports as one entry in `boostPads[]` on the next
    *Export Track to Game*. Boost direction is the empty's local +Y
    (Blender forward → three.js +Z); rotate the empty around Z to aim it.

    A flat cyan slab mesh is parented to the empty as a viewport gizmo
    so authors can see the pad's footprint and direction at a glance.
    The gizmo is tagged `kind=decoration` so the export keeps it as
    visible chrome but never registers a collider for it; the actual
    boost trigger is the JSON-side overlap test in `boostPadSystem`."""

    bl_idname = "hoverbike.add_boost_pad"
    bl_label = "Add Boost Pad"
    bl_description = "Drop a boost_NN empty at the 3D cursor (boost direction = local +Y)"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        name = _next_boost_pad_name()
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 4.0
        obj["kind"] = "boost_pad"
        # Defaults match the editor's `placement.ts` boost-pad defaults
        # so a Blender-authored pad behaves identically to one placed in
        # the in-app editor.
        obj["half_width"] = 3.0
        obj["half_depth"] = 6.0
        obj["strength"] = 1.5
        cursor = context.scene.cursor
        obj.location = cursor.location.copy()
        obj.rotation_euler = cursor.rotation_euler.copy()
        scene.collection.objects.link(obj)

        # Build the visual slab now so the pad reads in the viewport.
        _refresh_boost_pad_gizmos(scene)

        # Select the new empty so the user can immediately rotate (R) or
        # drag (G) it without picking it from the outliner.
        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj

        self.report({"INFO"}, f"Added {name} (strength {obj['strength']}, {obj['half_width']*2:.1f}m × {obj['half_depth']*2:.1f}m). Rotate around Z to aim.")
        return {"FINISHED"}


class HOVERBIKE_OT_refresh_boost_pads(Operator):
    """Rebuild every boost_NN empty's child slab gizmo. Use after editing
    `half_width` / `half_depth` custom props directly on a pad in the
    Properties panel — the panel doesn't trigger the auto-refresh that
    addon-managed sliders do."""

    bl_idname = "hoverbike.refresh_boost_pads"
    bl_label = "Refresh Boost Pad Visuals"
    bl_description = "Rebuild every boost_NN gizmo to match its current half_width / half_depth"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        n = _refresh_boost_pad_gizmos(context.scene)
        self.report({"INFO"}, f"Refreshed {n} boost pad gizmo(s).")
        return {"FINISHED"}


def _snap_spline_to_terrain(curve_obj: bpy.types.Object, *, hover_m: float) -> dict:
    """Drop each control point of `curve_obj` straight down onto the
    nearest drivable surface and lift by `hover_m`.

    Two surfaces are considered drivable: solid terrain *above* the
    water level, and the water surface itself (the hover bike rides
    waves). Solid terrain *below* water (seafloor) is NOT drivable —
    the bike sinks through it. Earlier versions of this operator
    snapped to whatever the ray hit first, which dragged spline points
    down onto the seafloor wherever the racing line crossed open
    water. The current rule:

      hit terrain at z = h
      water surface at z = w
      target = max(h, w) + hover_m

    so off-shore points clamp to the wave surface and on-shore points
    sit above the actual ground. Returns counts of hits / misses /
    water-snaps for the operator report.

    Preview collections are excluded during the raycast so the gate /
    racer / water gizmos never catch the ray. `road_main` (if present)
    is temporarily hidden during the cast too so the spline lands on
    terrain rather than on the road slab it lives above. The
    depsgraph has to be re-fetched *inside* the `with` block:
    capturing it before the exclusion takes effect leaves the cast
    still hitting gizmos."""
    scene = bpy.context.scene
    hits = 0
    misses = 0
    water_snaps = 0
    high_z = 0.0
    for *_rest, world_co, _ in _spline_iter_points(curve_obj):
        if world_co.z > high_z:
            high_z = world_co.z
    origin_z = high_z + 1000.0
    down = mathutils.Vector((0.0, 0.0, -1.0))

    # Water surface y comes from `water_volume_main`'s Z (the empty's
    # position is the source of truth — see derive_track_json /
    # reload_track_from_json). Tracks without a water volume default
    # to water_z = -inf so the max() check collapses to terrain only.
    vol = bpy.data.objects.get("water_volume_main")
    water_z = float(vol.matrix_world.translation.z) if vol is not None else float("-inf")

    road_obj = bpy.data.objects.get(ROAD_OBJECT_NAME)
    prior_road_hidden = road_obj.hide_viewport if road_obj is not None else None

    try:
        if road_obj is not None:
            road_obj.hide_viewport = True
        with _PreviewCollectionsHidden(bpy.context.view_layer):
            bpy.context.view_layer.update()
            depsgraph = bpy.context.evaluated_depsgraph_get()
            for _spline, _pt, world_co, setter in _spline_iter_points(curve_obj):
                origin = mathutils.Vector((world_co.x, world_co.y, origin_z))
                result, location, _normal, _index, _obj, _matrix = scene.ray_cast(
                    depsgraph, origin, down
                )
                terrain_z = float(location.z) if result else float("-inf")
                # Clamp to the water surface where terrain is below it.
                # `target_surface` is the drivable Y at this xy.
                target_surface = max(terrain_z, water_z)
                if target_surface == float("-inf"):
                    # No terrain hit AND no water — leave the point alone.
                    misses += 1
                    continue
                new_co = mathutils.Vector(
                    (world_co.x, world_co.y, target_surface + hover_m)
                )
                setter(new_co)
                hits += 1
                if water_z > terrain_z:
                    water_snaps += 1
    finally:
        if road_obj is not None and prior_road_hidden is not None:
            road_obj.hide_viewport = prior_road_hidden

    # Force a depsgraph refresh so the spline polyline samples the new
    # control points immediately (the gate/turn previews will follow via
    # the auto-rebuild handler).
    curve_obj.data.update_tag()
    return {"hits": hits, "misses": misses, "water_snaps": water_snaps}


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
        water_note = (
            f" ({summary.get('water_snaps', 0)} clamped to water surface)"
            if summary.get("water_snaps", 0) > 0 else ""
        )
        if summary["misses"]:
            self.report(
                {"WARNING"},
                f"Snapped {summary['hits']} points{water_note}; "
                f"{summary['misses']} missed (no terrain or water below).",
            )
        else:
            self.report(
                {"INFO"},
                f"Snapped {summary['hits']} spline points{water_note} (+{hover:.1f}m hover).",
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


# ── Track lint ─────────────────────────────────────────────────────────────
#
# Pre-export sanity checks. Pure inspection — never mutates the scene.
# Each check returns (severity, message) tuples; the operator surfaces
# them via Blender's report system. Authors can lint before export to
# catch the "why doesn't my track work in-game" failures (no road
# under start, racing line dives underwater, etc.) without having to
# launch the runtime first.


def _lint_track(scene) -> tuple[list[str], list[str]]:
    """Return (errors, warnings) for the current track scene. ERRORS
    are blockers (won't drive); WARNINGS are smells (might race oddly).
    Cheap — no Cycles bake, no GLB export. ~10 raycasts + spline math.

    Preview gizmos (`_hoverbike_*_preview` collections) are hidden
    during the raycasts so we lint against the *exported* state, not
    against gate / water / racer previews that get scrubbed at export."""
    errors: list[str] = []
    warnings: list[str] = []

    sp = bpy.data.objects.get("ai_spline_main")
    start_00 = bpy.data.objects.get("start_00")
    terrain = _largest_terrain_mesh()

    down = mathutils.Vector((0.0, 0.0, -1.0))
    water_h = 0.0
    vol = bpy.data.objects.get("water_volume_main")
    if vol is not None:
        water_h = float(vol.matrix_world.translation.z)

    with _PreviewCollectionsHidden(bpy.context.view_layer):
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()

        if sp is None or sp.type != "CURVE":
            errors.append("Missing `ai_spline_main` — no racing line authored.")
        else:
            arc_m = _spline_arc_length(sp)
            if arc_m < 60.0:
                warnings.append(f"AI spline arc length is {arc_m:.0f} m (very short — laps will be < 3s).")
            gate_spacing = float(getattr(scene, "hoverbike_gate_spacing", 60.0) or 60.0)
            gate_count = max(1, round(arc_m / gate_spacing))
            if gate_count < 4:
                warnings.append(
                    f"Gate spacing {gate_spacing:.0f} m × {gate_count} gates is sparse for a "
                    f"{arc_m:.0f} m lap — consider tightening spacing."
                )
            elif gate_count > 40:
                warnings.append(
                    f"{gate_count} gates at {gate_spacing:.0f} m spacing is busy for a "
                    f"{arc_m:.0f} m lap."
                )

            underwater_count = 0
            miss_count = 0
            wrong_kind_count = 0
            mw = sp.matrix_world
            for spline in sp.data.splines:
                pts = spline.bezier_points if spline.type == "BEZIER" else spline.points
                for pt in pts:
                    if spline.type == "BEZIER":
                        local = pt.co
                    else:
                        local = mathutils.Vector((pt.co[0], pt.co[1], pt.co[2]))
                    w = mw @ local
                    if w.z < water_h - 0.5:
                        underwater_count += 1
                    origin = mathutils.Vector((w.x, w.y, max(w.z, 0.0) + 1000.0))
                    hit, _loc, _n, _i, hit_obj, _ = bpy.context.scene.ray_cast(depsgraph, origin, down)
                    if not hit:
                        miss_count += 1
                    elif hit_obj is not None and hit_obj.get("kind") != "track":
                        wrong_kind_count += 1
            if underwater_count > 0:
                warnings.append(
                    f"{underwater_count} spline point(s) sit below the water surface "
                    f"(z < {water_h - 0.5:.1f}). The racing line will dive underwater unless you "
                    f"snap it back up or lift `water_volume_main`."
                )
            if miss_count > 0:
                errors.append(
                    f"{miss_count} spline point(s) have no terrain or track beneath — bikes will fall."
                )
            if wrong_kind_count > 0:
                warnings.append(
                    f"{wrong_kind_count} spline point(s) sit above a non-`kind=track` mesh; "
                    f"the runtime won't collide with decoration."
                )

        if start_00 is None:
            errors.append("Missing `start_00` — no player spawn authored.")
        else:
            sloc = start_00.matrix_world.translation
            origin = mathutils.Vector((sloc.x, sloc.y, max(sloc.z, 0.0) + 1000.0))
            hit, _loc, _n, _i, hit_obj, _ = bpy.context.scene.ray_cast(depsgraph, origin, down)
            if not hit:
                errors.append("No surface beneath `start_00` — the player will spawn in the void.")
            elif hit_obj is not None and hit_obj.get("kind") != "track":
                warnings.append(
                    f"`start_00` sits above {hit_obj.name!r} which isn't kind=track; "
                    f"the bike may sink or fall through."
                )

    if terrain is None:
        warnings.append("No `kind=track` terrain mesh found. Tag your terrain mesh's `kind` to `track`.")

    return errors, warnings


class HOVERBIKE_OT_lint_track(Operator):
    """Pre-export sanity check. Walks the spline, the start pose, and
    the terrain looking for the playability traps that hit the runtime
    after authors haven't double-checked: spline points underwater,
    starts in the void, no kind=track terrain, weird gate density."""

    bl_idname = "hoverbike.lint_track"
    bl_label = "Lint Track"
    bl_description = "Sanity-check the scene for common playability issues before export"
    bl_options = {"REGISTER"}

    def execute(self, context):
        errors, warnings = _lint_track(context.scene)
        if not errors and not warnings:
            self.report({"INFO"}, "Lint: scene looks playable — nothing flagged.")
            return {"FINISHED"}
        for w in warnings:
            self.report({"WARNING"}, w)
        for e in errors:
            self.report({"ERROR"}, e)
        self.report(
            {"INFO"},
            f"Lint: {len(errors)} error(s), {len(warnings)} warning(s). See the info bar.",
        )
        return {"FINISHED"} if not errors else {"CANCELLED"}


# ── Playtest button ────────────────────────────────────────────────────────


class HOVERBIKE_OT_open_play_url(Operator):
    """Open the current track's Play URL in the default browser. The
    addon already has *Copy Play URL*; this is the one-click version
    that skips clipboard + paste. Assumes the dev server is running at
    `http://localhost:5191` (Vite's default for the project)."""

    bl_idname = "hoverbike.open_play_url"
    bl_label = "Open in Browser"
    bl_description = "Open the dev server's Play URL for this track"
    bl_options = {"REGISTER"}

    edit: BoolProperty(  # type: ignore[valid-type]
        name="Edit mode",
        description="Append `&edit=1` to open the in-app editor for this track instead of racing it",
        default=False,
    )

    def execute(self, context):
        track_id = derive_asset_id("hoverbike_track_id")
        if not track_id:
            self.report({"ERROR"}, "Couldn't derive a track id from the .blend filename.")
            return {"CANCELLED"}
        url = f"http://localhost:5191/?track={track_id}"
        if self.edit:
            url += "&edit=1"
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception as e:  # noqa: BLE001 — webbrowser fallbacks vary by platform
            self.report({"ERROR"}, f"Couldn't launch browser: {e}")
            return {"CANCELLED"}
        self.report({"INFO"}, f"Opened {url}")
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

        # Make sure the in-game level picker sees this track. The menu
        # reads `public/assets/manifest.json`; tracks authored
        # interactively in Blender (vs. via `pnpm gen:tracks`) need
        # their entry upserted here.
        try:
            _upsert_manifest_track(
                repo,
                track_id=track_id,
                glb_url=f"/assets/tracks/{track_id}.glb",
                json_path=json_path,
            )
        except Exception as e:  # noqa: BLE001 — informational; export still succeeded
            self.report({"WARNING"}, f"manifest update skipped: {e}")

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
            _refresh_boost_pad_gizmos(scene)
        except (RuntimeError, AttributeError):
            pass

    if "helper" in pending and bpy.data.objects.get(PLACEMENT_HELPER_NAME) is not None:
        try:
            _repose_placement_helper(scene)
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


def _on_gate_prop_changed(self, context):
    """FloatProperty update callback — fires when the user scrubs gate
    spacing / half-width / height in the panel."""
    _schedule_rebuild("gates")


def _on_turn_prop_changed(self, context):
    _schedule_rebuild("turns")


# (_on_water_prop_changed moved to water.py)


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
        """Parent-panel content for track-mode .blends. The bulk of the
        UI lives in sub-panels (HOVERBIKE_PT_track_*) so authors can
        collapse the sections they aren't currently using. This method
        just shows the always-relevant header: track id, big Export
        button, lint / reload / play / URL actions."""
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

        col = layout.column(align=True)
        col.scale_y = 0.85
        col.label(text="Tools below; collapse any section.", icon="INFO")

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


# ── Track sub-panels ────────────────────────────────────────────────────────
#
# Each sub-panel is a child of HOVERBIKE_PT_panel and only renders in
# track mode. Splitting the original wall-of-tools into collapsible
# sections lets authors hide whatever they aren't using on a given pass
# (e.g. shader knobs are once-per-track so they stay default-closed).
# All sub-panels share the same `poll()` so adding a new one is just a
# matter of subclassing _HoverbikeTrackSubPanelBase + implementing draw.


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
        return detect_mode(bpy.data.filepath) == "track"


class HOVERBIKE_PT_track_spline(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: AI-spline editing helpers + start placement + the
    spline-aligned cursor / ramp-at-t / auto-ramp operators."""
    bl_label = "Spline tools"
    bl_idname = "HOVERBIKE_PT_track_spline"

    def draw(self, context):
        layout = self.layout
        scene = context.scene
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


class HOVERBIKE_PT_track_road(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: road-curve authoring + width / banking / curb knobs +
    Build Road. Long enough to deserve its own collapsible section."""
    bl_label = "Road tool"
    bl_idname = "HOVERBIKE_PT_track_road"

    def draw(self, context):
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
        layout.label(text="(per-point: edit Tilt in N→Curve)", icon="INFO")
        layout.separator()
        layout.label(text="F1 curbs:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_road_curb_width", text="Curb w")
        row.prop(scene, "hoverbike_road_curb_height", text="Curb h")
        layout.prop(scene, "hoverbike_road_curb_stripe_length", text="Stripe (m)")
        layout.operator("hoverbike.build_road", icon="MESH_PLANE")
        if bpy.data.objects.get(ROAD_CURVE_NAME):
            layout.label(text="Edit road_curve_main, then Build", icon="INFO")


class HOVERBIKE_PT_track_tunnels(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: tunnel through the terrain. Bezier curve along the
    intended path → Build → terrain gets a Boolean DIFFERENCE modifier
    against a cylindrical cutter + an inward-facing interior shell is
    spawned with ``kind="track"``. Default-closed since most tracks
    won't use it."""
    bl_label = "Tunnels"
    bl_idname = "HOVERBIKE_PT_track_tunnels"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        layout.operator("hoverbike.add_tunnel_starter_curve", icon="CURVE_BEZCURVE")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_tunnel_radius", text="Radius")
        row.prop(scene, "hoverbike_tunnel_wall_thickness", text="Wall")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_tunnel_samples", text="Samples")
        row.prop(scene, "hoverbike_tunnel_segments", text="Sides")
        layout.prop(scene, "hoverbike_tunnel_end_extend", text="End extend (m)")
        layout.operator("hoverbike.build_tunnel", icon="MESH_CYLINDER")
        if bpy.data.objects.get(TUNNEL_CURVE_NAME):
            layout.label(text="Edit tunnel_curve_main, then Build", icon="INFO")
        # Count existing tunnels for quick visual feedback.
        n_tunnels = sum(
            1 for o in bpy.data.objects
            if o.name.startswith(TUNNEL_PARENT_PREFIX) and o.name.endswith("_interior")
        )
        if n_tunnels > 0:
            layout.label(text=f"{n_tunnels} tunnel(s) built", icon="MOD_BOOLEAN")


class HOVERBIKE_PT_track_placement(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: persistent placement helper — a curve-constrained empty
    that the author parks at any (t, lateral offset) and uses as a
    placement anchor for ramps, boost pads, props, etc. Sliders re-pose
    live; one-click *Add Ramp at Helper* / *Add Boost at Helper* drop
    items at the helper's pose without needing to snap the cursor first.
    """
    bl_label = "Placement helper"
    bl_idname = "HOVERBIKE_PT_track_placement"

    def draw(self, context):
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


class HOVERBIKE_PT_track_downtown(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: placeholder downtown city-block generator. Drops a
    parented grid of mid-rise tower meshes (kind="track") at the 3D
    cursor. Default-closed since most tracks won't use it."""
    bl_label = "Downtown"
    bl_idname = "HOVERBIKE_PT_track_downtown"
    bl_options = {"DEFAULT_CLOSED"}

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


class HOVERBIKE_PT_track_ramps(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: simple wedge ramp. Three sliders set the next ramp's
    dimensions; clicking *Add Ramp* drops it at the 3D cursor.

    Each ramp is a parent empty (G/R/S to position/aim) plus a child
    mesh driven by the HV_Ramp Geometry-Nodes modifier. To resize a
    placed ramp, open its mesh's Modifiers tab and edit Length /
    Width / Height directly — the mesh re-evaluates live."""
    bl_label = "Ramps"
    bl_idname = "HOVERBIKE_PT_track_ramps"

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


class HOVERBIKE_PT_track_terrain(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: heightmap import, sculpt entry-points, AO/path-wear
    bakers. Anything that touches the terrain mesh's geometry."""
    bl_label = "Terrain"
    bl_idname = "HOVERBIKE_PT_track_terrain"

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


class HOVERBIKE_PT_track_water(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: sea-level slider (proxies water_volume_main.z) + the
    Gerstner-wave preview plane controls."""
    bl_label = "Water"
    bl_idname = "HOVERBIKE_PT_track_water"

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        if bpy.data.objects.get(WATER_VOLUME_NAME) is None:
            layout.label(text="No water_volume_main", icon="ERROR")
            layout.operator("hoverbike.add_water_volume", icon="ADD")
        else:
            layout.prop(scene, "hoverbike_water_height", text="Sea level (m)")
        layout.separator()
        layout.label(text="Wave preview:", icon="HIDE_OFF")
        layout.prop(scene, "hoverbike_water_size", text="Size (m)")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_water_subdivisions", text="Subdiv")
        row.prop(scene, "hoverbike_water_time", text="Time (s)")
        row = layout.row(align=True)
        row.operator("hoverbike.rebuild_water_preview", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_water_preview", icon="HIDE_ON")


class HOVERBIKE_PT_track_gameplay(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: gates + boost pads + racers + turn indicators. The
    high-level "what does the player interact with" placement section."""
    bl_label = "Gameplay"
    bl_idname = "HOVERBIKE_PT_track_gameplay"

    def draw(self, context):
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
        if bpy.data.collections.get(GATE_PREVIEW_COLLECTION):
            layout.label(text="Live: follows spline edits", icon="LINKED")
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


class HOVERBIKE_PT_track_stats(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: read-only counts + spline-length / lap-time estimate +
    terrain min/max + water coverage. Helpful for sanity-checking before
    export. Default-closed."""
    bl_label = "Track stats"
    bl_idname = "HOVERBIKE_PT_track_stats"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
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


# ── Registration ───────────────────────────────────────────────────────────

_classes = (
    HOVERBIKE_OT_rebuild_gate_preview,
    HOVERBIKE_OT_hide_gate_preview,
    HOVERBIKE_OT_rebuild_racer_preview,
    HOVERBIKE_OT_hide_racer_preview,
    # (water OTs moved to water.py)
    HOVERBIKE_OT_rebuild_turn_indicators,
    HOVERBIKE_OT_hide_turn_indicators,
    HOVERBIKE_OT_rebuild_ghost_lap,
    HOVERBIKE_OT_hide_ghost_lap,
    HOVERBIKE_OT_snap_spline_to_terrain,
    HOVERBIKE_OT_cursor_snap_to_spline,
    HOVERBIKE_OT_snap_starts_to_spline,
    HOVERBIKE_OT_add_ramp_at_spline_t,
    HOVERBIKE_OT_auto_place_ramps,
    HOVERBIKE_OT_add_placement_helper,
    HOVERBIKE_OT_remove_placement_helper,
    HOVERBIKE_OT_cursor_to_helper,
    HOVERBIKE_OT_add_ramp_at_helper,
    HOVERBIKE_OT_add_boost_pad_at_helper,
    HOVERBIKE_OT_add_downtown,
    HOVERBIKE_OT_add_road_starter_curve,
    HOVERBIKE_OT_build_road,
    HOVERBIKE_OT_add_tunnel_starter_curve,
    HOVERBIKE_OT_build_tunnel,
    HOVERBIKE_OT_add_ramp,
    HOVERBIKE_OT_import_heightmap,
    HOVERBIKE_OT_apply_terrain_modifiers,
    HOVERBIKE_OT_enter_sculpt_mode,
    HOVERBIKE_OT_smooth_terrain,
    HOVERBIKE_OT_subdivide_terrain,
    HOVERBIKE_OT_raise_lower_terrain,
    HOVERBIKE_OT_add_boost_pad,
    HOVERBIKE_OT_refresh_boost_pads,
    HOVERBIKE_OT_lint_track,
    HOVERBIKE_OT_open_play_url,
    HOVERBIKE_OT_reload_track_json,
    HOVERBIKE_OT_bake_terrain_attrs,
    HOVERBIKE_OT_refresh_track_stats,
    HOVERBIKE_OT_export_track,
    HOVERBIKE_OT_export_bike,
    HOVERBIKE_OT_copy_track_url,
    HOVERBIKE_OT_copy_bike_url,
    HOVERBIKE_PT_panel,
    HOVERBIKE_PT_track_spline,
    HOVERBIKE_PT_track_placement,
    HOVERBIKE_PT_track_road,
    HOVERBIKE_PT_track_tunnels,
    HOVERBIKE_PT_track_ramps,
    HOVERBIKE_PT_track_downtown,
    HOVERBIKE_PT_track_terrain,
    HOVERBIKE_PT_track_water,
    HOVERBIKE_PT_track_gameplay,
    HOVERBIKE_PT_track_ghost,
    HOVERBIKE_PT_track_shader,
    HOVERBIKE_PT_track_stats,
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
    # (water scene properties moved to water.py)
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

    # Terrain sculpt knobs — drive the bulk-shape and smooth operators.
    # Radius / magnitude are world-space metres so they scale predictably
    # with the rest of the addon's authoring UI.
    bpy.types.Scene.hoverbike_sculpt_radius = FloatProperty(
        name="Radius (m)",
        description="Radius of the raise/lower brush, centred on the 3D cursor.",
        default=20.0, min=0.5, max=2000.0, precision=2,
    )
    bpy.types.Scene.hoverbike_sculpt_magnitude = FloatProperty(
        name="Δz peak (m)",
        description="Maximum vertical displacement at the brush centre. Smoothstep falloff to zero at the edge.",
        default=4.0, min=0.01, max=200.0, precision=2,
    )
    bpy.types.Scene.hoverbike_sculpt_smooth_iters = IntProperty(
        name="Smooth iters",
        description="Number of Laplacian smoothing passes. 1 = subtle; 8 = heavy.",
        default=2, min=1, max=64,
    )
    bpy.types.Scene.hoverbike_sculpt_smooth_weight = FloatProperty(
        name="Smooth weight",
        description="Per-pass blend weight toward the neighbour mean. 0 = no smoothing; 1 = collapse onto mean each pass.",
        default=0.5, min=0.0, max=1.0, precision=2,
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
    bpy.types.Scene.hoverbike_road_curb_width = FloatProperty(
        name="Curb width (m)",
        description="Width of each F1-style curb strip. 0 disables curbs entirely.",
        default=0.6, min=0.0, max=5.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_curb_height = FloatProperty(
        name="Curb height (m)",
        description="Vertical rise of the curbs above the road surface.",
        default=0.12, min=0.0, max=1.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_curb_stripe_length = FloatProperty(
        name="Stripe length (m)",
        description="Length of each red/white stripe along the road. Shorter = busier rumble.",
        default=2.0, min=0.2, max=20.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_thickness = FloatProperty(
        name="Slab thickness (m)",
        description="Vertical extrusion of the road into a solid slab. 0 keeps the legacy paper-thin ribbon.",
        default=0.6, min=0.0, max=10.0, precision=2,
    )
    # Road banking — auto-tilt cross-section based on per-sample
    # curvature. Bank strength is a multiplier on the (kappa × ref_v²)
    # product; max-deg caps the total signed angle so steep corners
    # don't roll the road past comfortable racing angles. 0 strength
    # disables auto-bank entirely (per-control-point Tilt still
    # contributes).
    bpy.types.Scene.hoverbike_road_bank_strength = FloatProperty(
        name="Bank strength",
        description="Auto-bank multiplier driven by curvature. 0 disables auto-bank; 0.5 = subtle; 1.0 = pronounced; >1 = aggressive.",
        default=0.6, min=0.0, max=4.0, precision=2,
    )
    bpy.types.Scene.hoverbike_road_bank_max_deg = FloatProperty(
        name="Bank max (deg)",
        description="Hard cap on the road's bank angle in degrees. 25° is a typical road race banking; 45° is NASCAR-superspeedway extreme.",
        default=25.0, min=0.0, max=80.0, precision=1,
    )

    # Tunnel-tool settings.
    bpy.types.Scene.hoverbike_tunnel_radius = FloatProperty(
        name="Tunnel radius (m)",
        description="Inner radius of the tunnel — half the tube diameter. 8 m = 16 m wide and 16 m tall, comfortably arcade-sized.",
        default=8.0, min=1.0, max=40.0, precision=2,
    )
    bpy.types.Scene.hoverbike_tunnel_wall_thickness = FloatProperty(
        name="Tunnel wall (m)",
        description="Extra radius on the boolean cutter beyond the interior shell. Becomes the apparent thickness of the concrete liner at the tunnel mouth — 1 m reads as a real engineered tunnel; 0.1 m reads as a clean drilled hole.",
        default=1.0, min=0.0, max=8.0, precision=2,
    )
    bpy.types.Scene.hoverbike_tunnel_samples = IntProperty(
        name="Tunnel samples",
        description="Number of arc-length samples along the tunnel curve. Higher = smoother tube, denser cutter, slower boolean.",
        default=32, min=4, max=256,
    )
    bpy.types.Scene.hoverbike_tunnel_segments = IntProperty(
        name="Tunnel segments",
        description="Number of radial sides per cross-section ring. 12-16 reads as a smooth tube; 6 reads as a hex pipe.",
        default=14, min=3, max=64,
    )
    bpy.types.Scene.hoverbike_tunnel_end_extend = FloatProperty(
        name="Tunnel end extend (m)",
        description="Distance the cutter pushes past the curve's endpoints along the tangent. Ensures the boolean cut clears the terrain surface at the tunnel mouth even when the user's endpoints land right on the hillside.",
        default=4.0, min=0.0, max=50.0, precision=2,
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
        name="Ramp height (m)",
        description="Height of the back edge — the linear wedge rises from 0 at the leading edge to this value at the back.",
        default=3.0, min=0.1, max=50.0, precision=2,
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

    # Spline-aligned placement helpers.
    bpy.types.Scene.hoverbike_placement_t = FloatProperty(
        name="Spline t",
        description="Parameter in [0, 1] along the racing line. 0 = first control point; 0.5 = halfway around the lap.",
        default=0.25, min=0.0, max=1.0, precision=3,
    )
    bpy.types.Scene.hoverbike_placement_curve_name = StringProperty(
        name="Source curve",
        description="Object name to sample for cursor / ramp-at-t placement. Defaults to `ai_spline_main`.",
        default="ai_spline_main",
    )
    bpy.types.Scene.hoverbike_auto_ramp_kappa = FloatProperty(
        name="Auto-ramp |κ| min (1/m)",
        description="Curvature threshold for auto-placed ramps. Same family as turn indicators; lower = more ramps.",
        default=0.025, min=0.001, max=2.0, precision=4,
    )
    bpy.types.Scene.hoverbike_auto_ramp_min_spacing = FloatProperty(
        name="Auto-ramp min spacing (m)",
        description="Minimum arc-length distance between consecutive auto-placed ramps.",
        default=40.0, min=1.0, max=500.0, precision=1,
    )
    # Lateral spacing between start_00 and start_01 (used by the
    # Snap Starts to Spline operator). Matches the typical 4 m grid
    # offset every existing seed template uses.
    bpy.types.Scene.hoverbike_start_grid_spacing = FloatProperty(
        name="Start spacing (m)",
        description="Lateral distance between start_00 and start_01 when snapped to the racing line.",
        default=4.0, min=0.5, max=20.0, precision=1,
    )

    # Per-track lap count — round-trips through track JSON.
    bpy.types.Scene.hoverbike_laps_to_finish = IntProperty(
        name="Laps to finish",
        description="Number of laps required to finish the race. Round-trips through public/tracks/<id>.json.",
        default=3, min=1, max=99,
    )

    # Placement helper — curve-constrained anchor empty for one-click
    # placement of ramps, boosts, props, anything else that needs to
    # land on the racing line at a known parameter + lateral offset.
    bpy.types.Scene.hoverbike_helper_t = FloatProperty(
        name="Helper t",
        description="Parameter [0,1] along the source curve where the placement helper sits.",
        default=0.0, min=0.0, max=1.0, precision=3,
        update=_on_helper_prop_changed,
    )
    bpy.types.Scene.hoverbike_helper_offset = FloatProperty(
        name="Helper offset (m)",
        description="Lateral offset from the curve centre. Positive = right of the racing tangent, negative = left.",
        default=0.0, min=-200.0, max=200.0, precision=2,
        update=_on_helper_prop_changed,
    )

    # Downtown generator — placeholder dense-urban city block. All
    # parameters drive the next *Add Downtown* invocation; existing
    # downtowns are unaffected (delete + re-add to retune).
    bpy.types.Scene.hoverbike_downtown_blocks_x = IntProperty(
        name="Blocks X",
        description="Number of city blocks along the parent's local +X.",
        default=6, min=1, max=40,
    )
    bpy.types.Scene.hoverbike_downtown_blocks_y = IntProperty(
        name="Blocks Y",
        description="Number of city blocks along the parent's local +Y.",
        default=6, min=1, max=40,
    )
    bpy.types.Scene.hoverbike_downtown_block_size = FloatProperty(
        name="Block size (m)",
        description="Edge length of one city block (the building footprint envelope per cell).",
        default=30.0, min=4.0, max=200.0, precision=1,
    )
    bpy.types.Scene.hoverbike_downtown_street_width = FloatProperty(
        name="Street (m)",
        description="Gap between adjacent blocks. Plinth + asphalt fills these.",
        default=8.0, min=1.0, max=40.0, precision=1,
    )
    bpy.types.Scene.hoverbike_downtown_height_min = FloatProperty(
        name="Min h (m)",
        description="Lower bound on per-building height. ~10 m = three storeys.",
        default=18.0, min=2.0, max=500.0, precision=1,
    )
    bpy.types.Scene.hoverbike_downtown_height_max = FloatProperty(
        name="Max h (m)",
        description="Upper bound on per-building height. ~80 m = ~25-storey mid-rise.",
        default=80.0, min=4.0, max=2000.0, precision=1,
    )
    bpy.types.Scene.hoverbike_downtown_seed = IntProperty(
        name="Seed",
        description="Layout seed. Same seed + dimensions produces identical city blocks.",
        default=1, min=0, max=10000,
    )
    bpy.types.Scene.hoverbike_downtown_conform = BoolProperty(
        name="Conform to terrain",
        description="Raycast each building onto the terrain mesh; sink the bottom face below the lowest footprint corner so a building on a slope steps into the hill instead of floating on stilts. Plinth subdivides + per-vertex follows the grade. Off = legacy flat behaviour.",
        default=True,
    )

    # Extra terrain-shader knobs (state-of-the-art coloration pass).
    # See terrain-shader.ts for the matching uniforms.
    bpy.types.Scene.hoverbike_shader_warp_strength = FloatProperty(
        name="Domain warp",
        description="Strength of the low-freq noise that warps the colour-noise UVs. 0 = stock, 0.5 = subtle, 1.5 = strong organic veining.",
        default=0.5, min=0.0, max=4.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_macro_scale = FloatProperty(
        name="Macro scale",
        description="World-space scale (m) of the macro biome variation. 50 m ≈ smooth rolling tints; 200 m ≈ continent-scale bands.",
        default=120.0, min=10.0, max=1000.0, precision=1,
    )
    bpy.types.Scene.hoverbike_shader_micro_scale = FloatProperty(
        name="Micro scale",
        description="World-space scale (m) of the micro detail variation. 4 m ≈ pebbly, 16 m ≈ shrubs.",
        default=8.0, min=0.5, max=40.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_alt_jitter = FloatProperty(
        name="Alt jitter (m)",
        description="Vertical jitter added to the altitude band per fragment so contour lines aren't perfectly level. 0 = banded, 6 = naturally feathered.",
        default=4.0, min=0.0, max=30.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_scree_band = FloatProperty(
        name="Scree band",
        description="Width of the scree (intermediate slope) band between flat and cliff ramps. 0 = hard cut to cliff, 0.4 = wide gravel scree transition.",
        default=0.25, min=0.0, max=1.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_saturation = FloatProperty(
        name="Saturation",
        description="Output saturation multiplier. 1 = neutral, 1.2 = punchier biome reads, 0.7 = washed-out / stylised.",
        default=1.05, min=0.0, max=2.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_triplanar = FloatProperty(
        name="Triplanar",
        description="Blend factor between top-down (XZ-only) sampling and triplanar XYZ sampling for cliffs. 0 = stock, 1 = fully triplanar (no stretching on vertical faces).",
        default=0.6, min=0.0, max=1.0, precision=2,
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
        # (water scene properties handled by water.py's unregister)
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
        "hoverbike_sculpt_radius", "hoverbike_sculpt_magnitude",
        "hoverbike_sculpt_smooth_iters", "hoverbike_sculpt_smooth_weight",
        "hoverbike_ghost_speed", "hoverbike_ghost_fps",
        "hoverbike_road_width", "hoverbike_road_lift",
        "hoverbike_road_blend_radius", "hoverbike_road_samples",
        "hoverbike_road_smooth_passes",
        "hoverbike_road_curb_width", "hoverbike_road_curb_height",
        "hoverbike_road_curb_stripe_length", "hoverbike_road_thickness",
        "hoverbike_road_bank_strength", "hoverbike_road_bank_max_deg",
        "hoverbike_tunnel_radius", "hoverbike_tunnel_wall_thickness",
        "hoverbike_tunnel_samples", "hoverbike_tunnel_segments",
        "hoverbike_tunnel_end_extend",
        "hoverbike_ramp_length", "hoverbike_ramp_width", "hoverbike_ramp_height",
        "hoverbike_placement_t", "hoverbike_placement_curve_name",
        "hoverbike_auto_ramp_kappa", "hoverbike_auto_ramp_min_spacing",
        "hoverbike_start_grid_spacing",
        "hoverbike_laps_to_finish",
        "hoverbike_helper_t", "hoverbike_helper_offset",
        "hoverbike_downtown_blocks_x", "hoverbike_downtown_blocks_y",
        "hoverbike_downtown_block_size", "hoverbike_downtown_street_width",
        "hoverbike_downtown_height_min", "hoverbike_downtown_height_max",
        "hoverbike_downtown_seed", "hoverbike_downtown_conform",
        "hoverbike_shader_warp_strength", "hoverbike_shader_macro_scale",
        "hoverbike_shader_micro_scale", "hoverbike_shader_alt_jitter",
        "hoverbike_shader_scree_band", "hoverbike_shader_saturation",
        "hoverbike_shader_triplanar",
    ):
        if hasattr(bpy.types.Scene, prop):
            try:
                delattr(bpy.types.Scene, prop)
            except Exception:
                pass


if __name__ == "__main__":
    register()
