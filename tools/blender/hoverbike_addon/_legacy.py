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


# ── Gate + racer preview (moved) ──────────────────────────────────────────
#
# Gate gizmos, racer-at-start silhouettes, and the snap-spline-to-terrain
# operator live in hoverbike_addon/previews.py — they share the
# _PreviewCollectionsHidden infrastructure (still hosted here for now)
# and the centralised debounce timer below.


from . import previews as _previews_mod  # noqa: E402
from .previews import (  # noqa: E402
    GATE_PREVIEW_COLLECTION,
    RACER_PREVIEW_COLLECTION,
    DEFAULT_GATE_SPACING_M,
)


# ── Water (moved) ──────────────────────────────────────────────────────────
#
# Water authoring + preview live in `hoverbike_addon/water.py`. Constants
# re-exported below so the centralised debounce timer in this file can
# refer to them without a load-time cycle.

from . import water as _water_mod
from .water import WATER_PREVIEW_COLLECTION, WATER_VOLUME_NAME  # noqa: E402



# ── Turn indicators (moved) ────────────────────────────────────────────────
#
# Turn-indicator chevrons live in `hoverbike_addon/turn_indicators.py`.

from . import turn_indicators as _turn_indicators_mod  # noqa: E402
from .turn_indicators import TURN_PREVIEW_COLLECTION  # noqa: E402




# ── Ghost lap (moved) ──────────────────────────────────────────────────────
#
# Ghost-lap overlay + chase cam live in `hoverbike_addon/ghost_lap.py`.

# ── Heightmap import + terrain sculpt (moved) ──────────────────────────────
#
# Both live in `hoverbike_addon/terrain.py`.




# ── Spline placement (moved) ───────────────────────────────────────────────
#
# Spline-aligned cursor + ramp placement ops live in
# `hoverbike_addon/spline.py`.


# ── Placement helper (moved) ───────────────────────────────────────────────
#
# Placement-helper empty + ramp/boost-pad attach ops live in
# `hoverbike_addon/placement_helper.py`. The constant is re-exported so the
# debounce timer in this file can refer to it.

from .placement_helper import PLACEMENT_HELPER_NAME  # noqa: E402
from . import placement_helper as _placement_helper_mod  # noqa: E402


# ── Downtown generator (moved) ─────────────────────────────────────────────
#
# Downtown placeholder city-block generator lives in
# `hoverbike_addon/downtown.py`.



# ── Snap spline + gate preview OTs (moved) ────────────────────────────────
#
# HOVERBIKE_OT_snap_spline_to_terrain, _rebuild_gate_preview, and
# _hide_gate_preview moved to hoverbike_addon/previews.py.


# ── Terrain attribute bakers (moved) ───────────────────────────────────────
#
# AO + path-wear bake live in `hoverbike_addon/bake.py`.



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
            _previews_mod._rebuild_gate_preview(
                scene,
                spacing=float(scene.hoverbike_gate_spacing),
                half_width=float(scene.hoverbike_gate_half_width),
                height=float(scene.hoverbike_gate_height),
            )
        except (RuntimeError, AttributeError):
            pass

    if "turns" in pending and bpy.data.collections.get(TURN_PREVIEW_COLLECTION):
        try:
            _turn_indicators_mod.rebuild_turn_indicators(
                scene,
                kappa_threshold=float(scene.hoverbike_turn_kappa),
                min_spacing_m=float(scene.hoverbike_turn_min_spacing),
            )
        except (RuntimeError, AttributeError):
            pass

    if "racer" in pending and bpy.data.collections.get(RACER_PREVIEW_COLLECTION):
        try:
            _previews_mod._rebuild_racer_preview(scene)
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
            _boost_pad_mod.refresh_boost_pad_gizmos(scene)
        except (RuntimeError, AttributeError):
            pass

    if "helper" in pending and bpy.data.objects.get(PLACEMENT_HELPER_NAME) is not None:
        try:
            _placement_helper_mod.repose_placement_helper(scene)
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


# (_on_gate_prop_changed moved to previews.py)


# (_on_turn_prop_changed moved to turn_indicators.py)


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
    # (gate + racer preview OTs moved to previews.py)
    # (water OTs moved to water.py)
    # (turn-indicator OTs moved to turn_indicators.py)
    # (ghost-lap OTs moved to ghost_lap.py)
    # (snap_spline_to_terrain moved to previews.py)
    # (spline-placement OTs moved to spline.py)
    # (placement-helper OTs moved to placement_helper.py)
    # (HOVERBIKE_OT_add_downtown moved to downtown.py)
    # (road OTs moved to road.py)
    # (tunnel OTs moved to tunnel.py)
    # (HOVERBIKE_OT_add_ramp moved to ramp.py)
    # (terrain heightmap + sculpt OTs moved to terrain.py)
    # (boost pad OTs moved to boost_pad.py)
    HOVERBIKE_OT_lint_track,
    HOVERBIKE_OT_open_play_url,
    HOVERBIKE_OT_reload_track_json,
    # (bake OT moved to bake.py)
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
    # (gate + snap-hover scene properties moved to previews.py)
    # (water + turn-indicator scene properties moved to their modules)

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

    # (hoverbike_snap_hover_height moved to previews.py)

    # (heightmap + sculpt scene properties moved to terrain.py)

    # (road scene properties moved to road.py)

    # (tunnel scene properties moved to tunnel.py)

    # (ramp scene properties moved to ramp.py)

    # (ghost-lap scene properties moved to ghost_lap.py)

    # (spline-placement + start-grid scene properties moved to spline.py)

    # Per-track lap count — round-trips through track JSON.
    bpy.types.Scene.hoverbike_laps_to_finish = IntProperty(
        name="Laps to finish",
        description="Number of laps required to finish the race. Round-trips through public/tracks/<id>.json.",
        default=3, min=1, max=99,
    )

    # (placement-helper scene properties moved to placement_helper.py)

    # (downtown scene properties moved to downtown.py)

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
        # (gate + snap-hover scene properties handled by previews.py)
        # (water + turn-indicator scene properties handled by their modules)
        "hoverbike_shader_slope_start", "hoverbike_shader_slope_end",
        "hoverbike_shader_variation", "hoverbike_shader_wet_band",
        "hoverbike_shader_alt_min", "hoverbike_shader_alt_max",
        "hoverbike_shader_path_tint_r", "hoverbike_shader_path_tint_g",
        "hoverbike_shader_path_tint_b",
        # (heightmap + sculpt scene properties handled by terrain.py)
        # (ghost-lap scene properties handled by ghost_lap.py's unregister)
        # (road scene properties handled by road.py)
        # (tunnel scene properties handled by tunnel.py)
        # (ramp scene properties handled by ramp.py)
        # (spline-placement + start-grid scene properties handled by spline.py)
        "hoverbike_laps_to_finish",
        # (placement-helper scene properties handled by placement_helper.py)
        # (downtown scene properties handled by downtown.py)
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
