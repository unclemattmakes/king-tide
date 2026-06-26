"""PropLine round-trip — author parametric "asset along a curve" lines in
Blender, round-tripped with the in-app editor through ``propLines[]`` in
``public/tracks/<id>.json``.

Mirrors ``prop_placements.py`` (the ``props[]`` round-trip) one-to-one:

* **Import PropLines** — reads ``propLines[]``; for each line builds an editable
  ``propLine_<id>`` POLY curve whose control points ARE the Catmull-Rom anchors
  (three→Blender axis swap) and stamps the params as custom props, then spawns a
  hidden ``_hoverbike_proplines_preview`` collection of shared-GLB instances at
  the EXACT poses the runtime produces (via the shared deterministic
  ``propline_expand`` port). So the Blender preview == the game.
* **Write PropLines → JSON** — reads each curve's control points + params back
  into ``propLines[]`` and splices it into the JSON, leaving the rest of the
  file byte-for-byte untouched.

``propLines`` is **editor-canonical** (NOT a ``BLENDER_OWNED_JSON_KEY``): a plain
Export Track never touches it, so author-tuned lines survive a geometry
re-export — only *Write PropLines → JSON* rewrites them.

Coordinate convention matches ``prop_placements.py``: three.js ``(x,y,z)`` =
Blender ``(x, -z, y)``; inverse ``(bx, bz, -by)``.
"""
from __future__ import annotations

import json
import os
import re

import bpy
import mathutils

# The expansion math is the bpy-free port shared with the drift test + runtime.
from . import propline_expand

PREVIEW_COLLECTION = "_hoverbike_proplines_preview"
CURVE_PREFIX = "propLine_"
MESH_PREFIX = "hbpropline::"
ASSET_ID_KEY = "hb_assetid"
TRACK_ID_SCENE_PROP = "hoverbike_track_id"

# Per-line params stamped as custom props on the curve object.
P_SPACING_MODE = "hb_spacing_mode"
P_COUNT = "hb_count"
P_SPACING_M = "hb_spacing_m"
P_OFFSET_M = "hb_offset_m"
P_NORMAL_OFFSET_M = "hb_normal_offset_m"
P_ALIGN_TANGENT = "hb_align_tangent"
P_SEAT_TERRAIN = "hb_seat_terrain"
P_BIND = "hb_bind"
P_BIND_T0 = "hb_bind_t0"
P_BIND_T1 = "hb_bind_t1"
P_YAW_DEG = "hb_yaw_deg"
P_SCALE = "hb_scale"
P_SURFACE = "hb_surface"
P_WAVE_RIDER = "hb_wave_rider"
P_WAVE_RIDER_DOF = "hb_wave_rider_dof"
P_WATERLINE = "hb_waterline"
P_CLOSED = "hb_closed"
P_JITTER_POS = "hb_jitter_pos_m"
P_JITTER_YAW = "hb_jitter_yaw_deg"
P_JITTER_SMIN = "hb_jitter_scale_min"
P_JITTER_SMAX = "hb_jitter_scale_max"
WAVE_RIDER_DOFS = ("locked", "yaw")


# ── repo / track resolution (self-contained, same as prop_placements.py) ─────
def _repo_root() -> str | None:
    addon = bpy.context.preferences.addons.get(__package__) or bpy.context.preferences.addons.get(
        "hoverbike_addon"
    )
    pref = getattr(addon.preferences, "project_root", "") if addon else ""
    if isinstance(pref, str) and pref.strip() and os.path.isdir(pref):
        return os.path.abspath(pref)
    env = os.environ.get("HOVERBIKE_REPO_ROOT")
    if env and os.path.isdir(env):
        return os.path.abspath(env)
    cur = os.path.dirname(bpy.data.filepath)
    while cur:
        if os.path.isfile(os.path.join(cur, "package.json")):
            return cur
        nxt = os.path.dirname(cur)
        if nxt == cur:
            break
        cur = nxt
    return None


def _track_id() -> str | None:
    tid = bpy.context.scene.get(TRACK_ID_SCENE_PROP)
    if isinstance(tid, str) and tid.strip():
        return tid.strip()
    blend = bpy.data.filepath
    return os.path.splitext(os.path.basename(blend))[0] if blend else None


def _track_json_path(repo_root: str, track_id: str) -> str:
    return os.path.join(repo_root, "public", "tracks", f"{track_id}.json")


# ── coordinate conversion ────────────────────────────────────────────────────
def _blender_from_three(x: float, y: float, z: float):
    return (x, -z, y)


def _three_from_blender(v):
    return (v[0], v[2], -v[1])


def _r(x: float, ndigits: int) -> float:
    return round(x, ndigits) + 0.0


# ── main-spline derivation (for spline-bound lines) ──────────────────────────
def _main_spline_points(data: dict):
    """Dense points of the track's main AI spline, in three space — the source a
    spline-bound (`bind`) prop-line slices. Derived identically to the JSON
    loader (sample the anchors via the shared Catmull-Rom port), so a bound
    expansion stays cross-language deterministic. Returns None if absent."""
    splines = data.get("aiSplines") or []
    main = next((s for s in splines if s.get("id") == "main"), None)
    if main is None:
        return None
    anchors = main.get("anchors")
    if anchors and len(anchors) >= 2:
        # json-loader: sampleCatmullRom(anchors, { divisionsPerSegment: 12, closed: true })
        # (default tension 0.5) → mirror exactly.
        return propline_expand.sample_catmull_rom(anchors, 12, True, 0.5)
    pts = main.get("points")
    if pts and len(pts) >= 2:
        return pts
    return None


# ── terrain raycast (for seatToTerrain previews) ─────────────────────────────
def _terrain_raycast_z(scene, depsgraph, bx: float, by: float):
    """Cast straight down through the scene at Blender XY (bx, by) and return the
    first terrain hit Z, skipping our own prop-line preview instances + prop
    meshes. None when nothing is hit (no terrain imported / off the map) — the
    caller then leaves the instance at its curve Y. The author must have the
    track's environment GLB in the .blend for this to bite; it degrades to a
    no-op otherwise."""
    direction = mathutils.Vector((0.0, 0.0, -1.0))
    z = 100000.0
    for _ in range(8):
        hit, loc, _normal, _idx, obj, _mat = scene.ray_cast(
            depsgraph, mathutils.Vector((bx, by, z)), direction
        )
        if not hit:
            return None
        name = obj.name if obj else ""
        mesh_name = getattr(getattr(obj, "data", None), "name", "") or ""
        if name.startswith(CURVE_PREFIX) or mesh_name.startswith(MESH_PREFIX):
            # Our own geometry — drop below this hit and keep looking for terrain.
            z = loc.z - 0.01
            continue
        return loc.z
    return None


# ── propLines[] JSON splice (preserves the rest of the file verbatim) ─────────
def _serialize_block(key: str, arr: list) -> str:
    raw = json.dumps(arr, indent=2)
    lines = raw.split("\n")
    body = lines[0] if len(lines) == 1 else lines[0] + "\n" + "\n".join("  " + ln for ln in lines[1:])
    return f'"{key}": {body}'


def _find_array_span(flat: str, key: str):
    """Return (key_start, arr_end) of an existing top-level ``"key": [ ... ]``,
    or None. Depth-aware so nested brackets inside the array don't fool it."""
    m = re.search(rf'"{re.escape(key)}"\s*:\s*', flat)
    if not m or m.end() >= len(flat) or flat[m.end()] != "[":
        return None
    arr_start = m.end()
    depth = 0
    in_str = False
    esc = False
    i = arr_start
    while i < len(flat):
        c = flat[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return (m.start(), i + 1)
        i += 1
    raise RuntimeError(f"unterminated {key} array in track JSON")


def _splice_proplines_into_json(json_path: str, lines: list) -> None:
    with open(json_path, "r", encoding="utf-8", newline="") as f:
        text = f.read()
    newline = "\r\n" if "\r\n" in text else "\n"
    flat = text.replace("\r\n", "\n")

    block = _serialize_block("propLines", lines)
    span = _find_array_span(flat, "propLines")
    if span is not None:
        new_flat = flat[: span[0]] + block + flat[span[1] :]
    else:
        # Insert a new key right after the props array (always present), so the
        # editor-canonical blocks stay grouped.
        props_span = _find_array_span(flat, "props")
        if props_span is None:
            raise RuntimeError('track JSON has no "props" array to anchor "propLines" after')
        insert_at = props_span[1]
        new_flat = flat[:insert_at] + ",\n  " + block + flat[insert_at:]

    out = new_flat.replace("\n", newline) if newline == "\r\n" else new_flat
    with open(json_path, "w", encoding="utf-8", newline="") as f:
        f.write(out)


# ── scene helpers ────────────────────────────────────────────────────────────
def _ensure_object_mode() -> None:
    obj = bpy.context.view_layer.objects.active
    if obj is not None and obj.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")


def _ensure_preview_collection() -> bpy.types.Collection:
    coll = bpy.data.collections.get(PREVIEW_COLLECTION)
    if coll is None:
        coll = bpy.data.collections.new(PREVIEW_COLLECTION)
        bpy.context.scene.collection.children.link(coll)
    return coll


def _clear_preview(coll: bpy.types.Collection) -> None:
    for obj in list(coll.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for mesh in list(bpy.data.meshes):
        if mesh.name.startswith(MESH_PREFIX) and mesh.users == 0:
            bpy.data.meshes.remove(mesh)


def _import_glb_mesh(repo_root: str, asset_id: str):
    """Import + bake an asset GLB to a single upright mesh datablock (shared by
    all instances). Returns None on a missing / stub GLB (preview just skips
    that line rather than aborting the whole import)."""
    existing = bpy.data.meshes.get(f"{MESH_PREFIX}{asset_id}")
    if existing is not None:
        return existing
    glb = os.path.join(repo_root, "public", "assets", "props", f"{asset_id}.glb")
    if not os.path.isfile(glb) or os.path.getsize(glb) < 1024:
        return None
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=glb)
    new = [o for o in bpy.data.objects if o not in before]
    visual = [o for o in new if o.type == "MESH" and not o.name.lower().startswith("collider")]
    extras = [o for o in new if o not in visual]
    if not visual:
        for o in new:
            bpy.data.objects.remove(o, do_unlink=True)
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for o in visual:
        o.select_set(True)
    bpy.context.view_layer.objects.active = visual[0]
    if len(visual) > 1:
        bpy.ops.object.join()
    proto = bpy.context.view_layer.objects.active
    if proto.parent is not None:
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    mesh = proto.data
    mesh.name = f"{MESH_PREFIX}{asset_id}"
    bpy.data.objects.remove(proto, do_unlink=True)
    for o in extras:
        try:
            bpy.data.objects.remove(o, do_unlink=True)
        except Exception:
            pass
    return mesh


# ── JSON ⇄ curve ─────────────────────────────────────────────────────────────
def _stamp_params(obj, line: dict) -> None:
    obj[ASSET_ID_KEY] = line["assetId"]
    obj[P_SPACING_MODE] = line.get("spacingMode", "arcLength")
    obj[P_COUNT] = int(line.get("count", 0) or 0)
    obj[P_SPACING_M] = float(line.get("spacingM", 0.0) or 0.0)
    obj[P_OFFSET_M] = float(line.get("offsetM", 0.0) or 0.0)
    obj[P_NORMAL_OFFSET_M] = float(line.get("normalOffsetM", 0.0) or 0.0)
    obj[P_ALIGN_TANGENT] = bool(line.get("alignToTangent", True))
    obj[P_SEAT_TERRAIN] = bool(line.get("seatToTerrain", False))
    # `is not None`, NOT truthiness — a full-loop bind is `{}` (falsy in Python).
    bind = line.get("bind")
    obj[P_BIND] = bind is not None
    b = bind if bind is not None else {}
    t0 = b.get("t0")
    t1 = b.get("t1")
    obj[P_BIND_T0] = float(t0 if t0 is not None else 0.0)
    obj[P_BIND_T1] = float(t1 if t1 is not None else 1.0)
    obj[P_YAW_DEG] = float(line.get("yawDeg", 0.0) or 0.0)
    obj[P_SCALE] = float(line.get("scale", 1.0) or 1.0)
    obj[P_SURFACE] = line.get("surface", "")
    wr = line.get("waveRider") or None
    obj[P_WAVE_RIDER] = bool(wr)
    obj[P_WAVE_RIDER_DOF] = (wr or {}).get("dof", "locked")
    obj[P_WATERLINE] = bool(line.get("waterline", True))
    obj[P_CLOSED] = bool(line.get("closed", False))
    j = line.get("jitter") or {}
    obj[P_JITTER_POS] = float(j.get("posM", 0.0) or 0.0)
    obj[P_JITTER_YAW] = float(j.get("yawDeg", 0.0) or 0.0)
    obj[P_JITTER_SMIN] = float(j.get("scaleMin", 1.0) or 1.0)
    obj[P_JITTER_SMAX] = float(j.get("scaleMax", 1.0) or 1.0)


def _line_from_curve(obj) -> dict:
    """Read a propLine_* curve object back into a PropLine dict (three space)."""
    line_id = obj.name[len(CURVE_PREFIX) :] if obj.name.startswith(CURVE_PREFIX) else obj.name
    is_bind = bool(obj.get(P_BIND))
    anchors = []
    # Bound lines take their source from the racing line (t0/t1), NOT the curve
    # control points (which are just a derived visualization of the slice).
    if not is_bind and obj.type == "CURVE" and obj.data.splines:
        spline = obj.data.splines[0]
        pts = spline.points if spline.type == "POLY" else spline.bezier_points
        for p in pts:
            co = p.co if spline.type == "POLY" else p.co
            # World-space control point → three.
            world = obj.matrix_world @ (co.to_3d() if hasattr(co, "to_3d") else co)
            tx, ty, tz = _three_from_blender(world)
            anchors.append({"x": _r(tx, 4), "y": _r(ty, 4), "z": _r(tz, 4)})
    line: dict = {"id": line_id, "assetId": obj.get(ASSET_ID_KEY, "prop"), "anchors": anchors}
    if is_bind:
        t0 = float(obj.get(P_BIND_T0, 0.0))
        t1 = float(obj.get(P_BIND_T1, 1.0))
        line["bind"] = {"t0": _r(t0, 4), "t1": _r(t1, 4)}
    mode = obj.get(P_SPACING_MODE, "arcLength")
    if mode == "count":
        line["spacingMode"] = "count"
        line["count"] = int(obj.get(P_COUNT, 1) or 1)
    else:
        line["spacingMode"] = "arcLength"
        line["spacingM"] = _r(float(obj.get(P_SPACING_M, 8.0) or 8.0), 3)
    if obj.get(P_CLOSED):
        line["closed"] = True
    if float(obj.get(P_OFFSET_M, 0.0) or 0.0):
        line["offsetM"] = _r(float(obj[P_OFFSET_M]), 3)
    if float(obj.get(P_NORMAL_OFFSET_M, 0.0) or 0.0):
        line["normalOffsetM"] = _r(float(obj[P_NORMAL_OFFSET_M]), 3)
    if obj.get(P_ALIGN_TANGENT, True) is False:
        line["alignToTangent"] = False
    if obj.get(P_SEAT_TERRAIN):
        line["seatToTerrain"] = True
    if float(obj.get(P_YAW_DEG, 0.0) or 0.0):
        line["yawDeg"] = _r(float(obj[P_YAW_DEG]), 3)
    if float(obj.get(P_SCALE, 1.0) or 1.0) != 1.0:
        line["scale"] = _r(float(obj[P_SCALE]), 4)
    surf = obj.get(P_SURFACE, "")
    if surf:
        line["surface"] = surf
    if obj.get(P_WAVE_RIDER):
        dof = obj.get(P_WAVE_RIDER_DOF, "locked")
        line["waveRider"] = {"dof": dof if dof in WAVE_RIDER_DOFS else "locked"}
    if obj.get(P_WATERLINE, True) is False:
        line["waterline"] = False
    jit = {}
    if float(obj.get(P_JITTER_POS, 0.0) or 0.0):
        jit["posM"] = _r(float(obj[P_JITTER_POS]), 3)
    if float(obj.get(P_JITTER_YAW, 0.0) or 0.0):
        jit["yawDeg"] = _r(float(obj[P_JITTER_YAW]), 3)
    if float(obj.get(P_JITTER_SMIN, 1.0) or 1.0) != 1.0:
        jit["scaleMin"] = _r(float(obj[P_JITTER_SMIN]), 4)
    if float(obj.get(P_JITTER_SMAX, 1.0) or 1.0) != 1.0:
        jit["scaleMax"] = _r(float(obj[P_JITTER_SMAX]), 4)
    if jit:
        line["jitter"] = jit
    return line


def _build_curve(line: dict, main_points: list | None = None):
    """Create/replace the ``propLine_<id>`` POLY curve (three → Blender). For an
    anchor line the control points ARE the editable anchors; for a spline-bound
    line they're the sliced racing-line polyline (a derived visualization — the
    bind is edited via the t0/t1 custom props, not the curve points)."""
    name = f"{CURVE_PREFIX}{line['id']}"
    old = bpy.data.objects.get(name)
    if old is not None:
        bpy.data.objects.remove(old, do_unlink=True)
    data = bpy.data.curves.new(name, type="CURVE")
    data.dimensions = "3D"
    spline = data.splines.new("POLY")
    if line.get("bind") is not None:  # `{}` (full loop) is falsy in Python
        src = propline_expand.resolve_prop_line_source(line, main_points)
        pts = (src or {}).get("points", [])
    else:
        pts = line.get("anchors") or []
    if pts:
        spline.points.add(max(0, len(pts) - 1))
        for i, a in enumerate(pts):
            bx, by, bz = _blender_from_three(a["x"], a["y"], a["z"])
            spline.points[i].co = (bx, by, bz, 1.0)
    obj = bpy.data.objects.new(name, data)
    _stamp_params(obj, line)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _spawn_preview(
    repo_root: str,
    line: dict,
    coll: bpy.types.Collection,
    main_points: list | None = None,
    scene=None,
    depsgraph=None,
) -> int:
    """Drop shared-GLB instances at the deterministic expanded poses. Spline-bound
    lines slice ``main_points``; ``seatToTerrain`` lines raycast the scene terrain
    (excluding our own previews) so the Blender preview matches the runtime seat."""
    mesh = _import_glb_mesh(repo_root, line["assetId"])
    if mesh is None:
        return 0
    seat = bool(line.get("seatToTerrain")) and scene is not None and depsgraph is not None
    normal_offset = float(line.get("normalOffsetM", 0.0) or 0.0)
    n = 0
    for inst in propline_expand.expand_prop_line(line, main_points):
        ob = bpy.data.objects.new(f"{CURVE_PREFIX}{line['id']}_inst{n}", mesh)
        pos = inst["position"]
        bx, by, bz = _blender_from_three(pos["x"], pos["y"], pos["z"])
        if seat:
            tz = _terrain_raycast_z(scene, depsgraph, bx, by)
            if tz is not None:
                # Blender Z == three Y, so terrain-Z + offset == terrainY + offset.
                bz = tz + normal_offset
        ob.location = (bx, by, bz)
        rot = inst["rotation"]
        # three quat (x,y,z,w) → Blender (w, x, -z, y).
        ob.rotation_mode = "QUATERNION"
        ob.rotation_quaternion = (rot["w"], rot["x"], -rot["z"], rot["y"])
        s = inst["size"]
        ob.scale = (s["x"], s["z"], s["y"])
        ob.hide_select = True
        coll.objects.link(ob)
        n += 1
    return n


# ── operators ────────────────────────────────────────────────────────────────
class HOVERBIKE_OT_import_prop_lines(bpy.types.Operator):
    """Import the track's parametric prop-lines (propLines[]) as editable curves
    + a deterministic shared-GLB instance preview."""

    bl_idname = "hoverbike.import_prop_lines"
    bl_label = "Import PropLines"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        repo_root = _repo_root()
        if repo_root is None:
            self.report({"ERROR"}, "repo root not found (set the addon's Project root)")
            return {"CANCELLED"}
        track_id = _track_id()
        if not track_id:
            self.report({"ERROR"}, "no track id (save the .blend or set hoverbike_track_id)")
            return {"CANCELLED"}
        json_path = _track_json_path(repo_root, track_id)
        if not os.path.isfile(json_path):
            self.report({"ERROR"}, f"no track JSON: {json_path}")
            return {"CANCELLED"}
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        lines = data.get("propLines", []) or []
        if not lines:
            self.report({"WARNING"}, "no propLines in track JSON")
            return {"CANCELLED"}

        _ensure_object_mode()
        coll = _ensure_preview_collection()
        _clear_preview(coll)
        # Racing line for any spline-bound lines + a depsgraph snapshot for any
        # terrain-seated lines (captured before we add curves/instances so the
        # raycast sees the imported terrain, not our own previews).
        main_points = _main_spline_points(data)
        depsgraph = context.evaluated_depsgraph_get()
        scene = context.scene
        instances = 0
        for line in lines:
            _build_curve(line, main_points)
            instances += _spawn_preview(repo_root, line, coll, main_points, scene, depsgraph)
        self.report({"INFO"}, f"imported {len(lines)} prop-line(s), {instances} preview instance(s)")
        return {"FINISHED"}


class HOVERBIKE_OT_write_prop_lines(bpy.types.Operator):
    """Write every propLine_* curve back into the track JSON propLines[],
    preserving the rest of the file verbatim."""

    bl_idname = "hoverbike.write_prop_lines"
    bl_label = "Write PropLines → JSON"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        repo_root = _repo_root()
        if repo_root is None:
            self.report({"ERROR"}, "repo root not found (set the addon's Project root)")
            return {"CANCELLED"}
        track_id = _track_id()
        if not track_id:
            self.report({"ERROR"}, "no track id")
            return {"CANCELLED"}
        json_path = _track_json_path(repo_root, track_id)
        if not os.path.isfile(json_path):
            self.report({"ERROR"}, f"no track JSON: {json_path}")
            return {"CANCELLED"}

        curves = [
            o
            for o in bpy.data.objects
            if o.name.startswith(CURVE_PREFIX) and o.type == "CURVE" and "_inst" not in o.name
        ]
        curves.sort(key=lambda o: o.name)
        lines = [_line_from_curve(o) for o in curves]
        _splice_proplines_into_json(json_path, lines)
        self.report({"INFO"}, f"wrote {len(lines)} prop-line(s)")
        return {"FINISHED"}


class HOVERBIKE_PT_prop_lines(bpy.types.Panel):
    bl_label = "Prop Lines"
    bl_idname = "HOVERBIKE_PT_prop_lines"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Hoverbike"
    bl_parent_id = "HOVERBIKE_PT_panel"

    def draw(self, context):
        col = self.layout.column(align=True)
        col.operator("hoverbike.import_prop_lines", icon="IMPORT")
        col.operator("hoverbike.write_prop_lines", icon="EXPORT")
        self.layout.label(text="Edit a propLine_* curve, then Write.", icon="INFO")


_CLASSES = (
    HOVERBIKE_OT_import_prop_lines,
    HOVERBIKE_OT_write_prop_lines,
    HOVERBIKE_PT_prop_lines,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except Exception:
            pass
