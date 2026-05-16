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


# ── Tunnel tool (moved) ────────────────────────────────────────────────────
#
# AI-spline tunnel rig moved to hoverbike_addon/tunnel.py. The
# canonical tunnel implementation is now the seed-driven
# tracks-src/template-tunnels.blend (see
# tools/blender/seed_template_tunnels.py).


from . import tunnel as _tunnel_mod  # noqa: E402
from .tunnel import TUNNEL_CURVE_NAME, TUNNEL_PARENT_PREFIX  # noqa: E402


# ── Ramp tool (moved) ──────────────────────────────────────────────────────
#
# GN wedge ramp lives in `hoverbike_addon/ramp.py`.


# ── Boost pads (moved) ─────────────────────────────────────────────────────
#
# Boost-pad authoring + gizmo refresh live in
# `hoverbike_addon/boost_pad.py`. Re-export the constants the
# centralised debounce timer in this file refers to.

from . import boost_pad as _boost_pad_mod  # noqa: E402
from .boost_pad import BOOST_PAD_PREVIEW_COLLECTION  # noqa: E402


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
            _turn_indicators_mod.rebuild_turn_indicators(
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


def _on_gate_prop_changed(self, context):
    """FloatProperty update callback — fires when the user scrubs gate
    spacing / half-width / height in the panel."""
    _schedule_rebuild("gates")


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
    HOVERBIKE_OT_rebuild_gate_preview,
    HOVERBIKE_OT_hide_gate_preview,
    HOVERBIKE_OT_rebuild_racer_preview,
    HOVERBIKE_OT_hide_racer_preview,
    # (water OTs moved to water.py)
    # (turn-indicator OTs moved to turn_indicators.py)
    # (ghost-lap OTs moved to ghost_lap.py)
    HOVERBIKE_OT_snap_spline_to_terrain,
    # (spline-placement OTs moved to spline.py)
    # (placement-helper OTs moved to placement_helper.py)
    # (HOVERBIKE_OT_add_downtown moved to downtown.py)
    HOVERBIKE_OT_add_road_starter_curve,
    HOVERBIKE_OT_build_road,
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

    # Snap-spline-to-terrain hover height. Matches a typical hoverbike
    # ride height so the racing line sits just above the surface.
    bpy.types.Scene.hoverbike_snap_hover_height = FloatProperty(
        name="Snap hover (m)",
        description="Vertical clearance to lift each control point above the surface it lands on.",
        default=3.0, min=0.0, max=50.0, precision=2,
    )

    # (heightmap + sculpt scene properties moved to terrain.py)

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
        "hoverbike_gate_spacing", "hoverbike_gate_half_width", "hoverbike_gate_height",
        # (water + turn-indicator scene properties handled by their modules)
        "hoverbike_shader_slope_start", "hoverbike_shader_slope_end",
        "hoverbike_shader_variation", "hoverbike_shader_wet_band",
        "hoverbike_shader_alt_min", "hoverbike_shader_alt_max",
        "hoverbike_shader_path_tint_r", "hoverbike_shader_path_tint_g",
        "hoverbike_shader_path_tint_b",
        "hoverbike_snap_hover_height",
        # (heightmap + sculpt scene properties handled by terrain.py)
        # (ghost-lap scene properties handled by ghost_lap.py's unregister)
        "hoverbike_road_width", "hoverbike_road_lift",
        "hoverbike_road_blend_radius", "hoverbike_road_samples",
        "hoverbike_road_smooth_passes",
        "hoverbike_road_curb_width", "hoverbike_road_curb_height",
        "hoverbike_road_curb_stripe_length", "hoverbike_road_thickness",
        "hoverbike_road_bank_strength", "hoverbike_road_bank_max_deg",
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
