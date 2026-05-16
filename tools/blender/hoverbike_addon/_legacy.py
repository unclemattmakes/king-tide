"""Shared addon infrastructure — repo discovery, validation, JSON sync,
bike spec derivation, preview-collection bookkeeping, and a handful
of cross-cutting helpers (`_largest_terrain_mesh`,
`_sample_curve_to_polyline`, `_spline_iter_points`, `_find_layer_collection`).

Originally the whole addon lived in a single file at
``tools/blender/hoverbike_addon.py``; the refactor split user-facing
operators, panels, scene properties, and per-domain helpers into the
sibling modules of this package. Everything that's still here is
pipeline infrastructure shared across sibling modules (and, for
validation / JSON derivation, with the CLI exporters in
``tools/build_track.py``). A follow-up refactor can split this file
further (``_io.py``, ``_validation.py``, ``_export_json.py``,
``_shared.py``); for now the helpers stay co-located and siblings
lazy-import them by name.

``register()`` / ``unregister()`` are no-ops — every addon class and
scene property is now owned by a per-domain module.
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



# ── Track stats + lint (moved) ─────────────────────────────────────────
#
# Track-introspection operators (HOVERBIKE_OT_refresh_track_stats,
# HOVERBIKE_OT_lint_track) live in hoverbike_addon/track_meta.py.


from . import track_meta as _track_meta_mod  # noqa: E402


# ── Export + URL OTs (moved) ──────────────────────────────────────────────
#
# Track / bike export operators, play-URL helpers, and the JSON
# reload OT live in hoverbike_addon/export.py. Validation, JSON
# derivation, and manifest-upsert helpers stay here (used by the
# CLI exporter in tools/build_track.py too).


from . import export as _export_mod  # noqa: E402


# ── Live preview auto-rebuild (moved) ─────────────────────────────────────
#
# Debounced rebuild dispatch + persistent depsgraph / load handlers
# live in hoverbike_addon/handlers.py. Property update callbacks in
# each per-domain module call .handlers._schedule_rebuild directly.


from . import handlers as _handlers_mod  # noqa: E402


# ── Sidebar panel + sub-panels (moved) ─────────────────────────────────
#
# All UI panel classes live in hoverbike_addon/panel.py.


from . import panel as _panel_mod  # noqa: E402


# ── Registration ───────────────────────────────────────────────────────────

# All addon classes (operators + panels) are now registered by their
# per-domain modules. _legacy only owns the runtime terrain-shader
# scene properties below — those will move to their own module in a
# follow-up. No classes to register here.


def register() -> None:
    # All scene properties are now registered by their per-domain
    # modules (previews, water, turn_indicators, terrain, road, tunnel,
    # ramp, ghost_lap, spline, placement_helper, downtown,
    # terrain_shader). _legacy is shrinking into pure infrastructure
    # (validation, JSON sync, repo discovery, shared helpers) and no
    # longer owns user-facing knobs.
    pass


def unregister() -> None:
    pass


if __name__ == "__main__":
    register()
