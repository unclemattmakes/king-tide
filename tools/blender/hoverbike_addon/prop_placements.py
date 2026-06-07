"""Prop-placement round-trip — make ``props[]`` editable in Blender.

A track's placed props live in ``public/tracks/<id>.json`` ``props[]`` and are
*editor-canonical* — the normal Export Track never derives them from the .blend
(see ``track-art-pass-playbook.md`` §1), which is why placed props are invisible
in Blender. This module adds an **opt-in** round-trip so a designer can see and
move the real props in the viewport:

* **Import Prop Placements** — reads ``props[]``, imports each unique ``assetId``'s
  shipping GLB once (``public/assets/props/<assetId>.glb``) and drops one instance
  per placement (shared mesh datablock) into a hidden ``_hoverbike_props_preview``
  collection at the exact runtime pose. The instances *are* the shipping GLB, so
  what you move is what ships, and a regen of the GLB shows up here on the next
  import — i.e. the preview is authored *relative to the GLB*.
* **Write Prop Placements → JSON** — reads those instances back and splices
  ``props[]`` into the track JSON, leaving the rest of the file byte-for-byte
  untouched (a value-stable round-trip).

The preview collection is prefixed ``_hoverbike_`` so ``export_track`` hides it —
these previews never leak into the environment GLB. This module is deliberately
self-contained (no imports from sibling modules) so it can't break when the addon
package is refactored: coordinate maths and JSON IO are duplicated here on
purpose.

Coordinate convention (verified against authored empties): three.js ``(x,y,z)`` =
Blender ``(x, -z, y)``; the inverse is ``(bx, bz, -by)``. This is the same Y-up →
Z-up map Blender's glTF importer applies, and matches ``_legacy._b2t``.
"""
from __future__ import annotations

import json
import os
import re

import bpy

PREVIEW_COLLECTION = "_hoverbike_props_preview"
ASSET_ID_KEY = "hb_asset_id"
PROP_INDEX_KEY = "hb_prop_index"
KIND_KEY = "kind"
KIND_VALUE = "prop_preview"
MESH_PREFIX = "hbprop::"
TRACK_ID_SCENE_PROP = "hoverbike_track_id"

# Per-instance "float on waves" tags carried on each preview object so the
# round-trip can write them back into ``props[].waveRider``. WAVE_RIDER_KEY
# is a bool ("does this instance float"); WAVE_RIDER_DOF_KEY is the motion
# DOF ("locked" | "yaw"). Mirror of ``Prop.waveRider`` in
# ``src/game/tracks/types.ts`` — a floated prop becomes a kinematic body
# at runtime that tracks the swell using the prop's own collider.
WAVE_RIDER_KEY = "hb_wave_rider"
WAVE_RIDER_DOF_KEY = "hb_wave_rider_dof"
WAVE_RIDER_DOFS = ("locked", "yaw")


# ── repo / track resolution ──────────────────────────────────────────────────


def _repo_root() -> str | None:
    """Resolve the git-clone root that holds ``public/`` — same precedence as
    the addon's exporter: project-root preference → ``$HOVERBIKE_REPO_ROOT`` →
    walk up from the .blend looking for ``package.json``."""
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


# ── coordinate conversion (three.js ⇄ Blender) ───────────────────────────────


def _blender_from_three(x: float, y: float, z: float) -> tuple[float, float, float]:
    return (x, -z, y)


def _three_from_blender(v) -> tuple[float, float, float]:
    return (v[0], v[2], -v[1])


def _quat_blender_from_three(x: float, y: float, z: float, w: float):
    """three.js quaternion (x,y,z,w) → Blender mathutils order (w,x,y,z)."""
    return (w, x, -z, y)


def _quat_three_from_blender(q) -> tuple[float, float, float, float]:
    """Blender mathutils.Quaternion (.w/.x/.y/.z) → three.js (x,y,z,w)."""
    return (q.x, q.z, -q.y, q.w)


def _r(x: float, ndigits: int) -> float:
    """Round and normalize -0.0 → 0.0 (the +0.0 flips signed zero) so a
    no-op re-export is byte-identical instead of churning ``0.0``↔``-0.0``."""
    return round(x, ndigits) + 0.0


def _same_pose(orig: dict | None, fresh: dict) -> bool:
    """True if ``orig`` (a source props[] entry) describes the same placement as
    the freshly-decomposed ``fresh`` — same assetId, position/size within a
    half-rounding-unit, and the same *rotation* (quaternion dot ≈ ±1, so q and
    −q count as equal). Used to re-emit the original entry verbatim for unmoved
    props and keep the diff tight."""
    if not isinstance(orig, dict) or orig.get("assetId") != fresh.get("assetId"):
        return False
    for axis in ("x", "y", "z"):
        if abs(orig.get("position", {}).get(axis, 0.0) - fresh["position"][axis]) > 5e-4:
            return False
        if abs(orig.get("size", {}).get(axis, 1.0) - fresh["size"][axis]) > 5e-4:
            return False
    oq, fq = orig.get("rotation", {}), fresh["rotation"]
    dot = sum(oq.get(c, 0.0) * fq[c] for c in ("x", "y", "z", "w"))
    if abs(dot) <= 1.0 - 1e-5:
        return False
    # Treat a changed "float on waves" flag as a change too, so toggling
    # float on a prop that hasn't moved still writes a fresh entry.
    return orig.get("waveRider") == fresh.get("waveRider")


# ── props[] JSON splice (preserves the rest of the file verbatim) ─────────────


def _serialize_props_block(props: list) -> str:
    """Serialize ``props`` as the value of a 2-space-indented ``"props":`` key so
    it nests cleanly and matches the existing file formatting."""
    raw = json.dumps(props, indent=2)
    lines = raw.split("\n")
    if len(lines) == 1:
        return lines[0]
    return lines[0] + "\n" + "\n".join("  " + ln for ln in lines[1:])


def _splice_props_into_json(json_path: str, props: list) -> None:
    with open(json_path, "r", encoding="utf-8", newline="") as f:
        text = f.read()
    newline = "\r\n" if "\r\n" in text else "\n"
    flat = text.replace("\r\n", "\n")

    m = re.search(r'"props"\s*:\s*', flat)
    if not m or m.end() >= len(flat) or flat[m.end()] != "[":
        raise RuntimeError('track JSON has no "props": [ ... ] array to splice')
    arr_start = m.end()

    depth = 0
    in_str = False
    esc = False
    arr_end = None
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
                arr_end = i + 1
                break
        i += 1
    if arr_end is None:
        raise RuntimeError("unterminated props array in track JSON")

    new_flat = flat[:arr_start] + _serialize_props_block(props) + flat[arr_end:]
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


def _import_glb_mesh(repo_root: str, asset_id: str) -> bpy.types.Mesh:
    """Import ``public/assets/props/<asset_id>.glb`` and return a single mesh
    datablock baked into Blender's Z-up frame with identity object transform —
    an upright prop == three.js identity rotation. Collider_* nodes are dropped;
    only the visual mesh is kept."""
    glb = os.path.join(repo_root, "public", "assets", "props", f"{asset_id}.glb")
    if not os.path.isfile(glb):
        raise RuntimeError(f"missing GLB: {glb}")
    if os.path.getsize(glb) < 1024:
        raise RuntimeError(
            f"{os.path.basename(glb)} looks like a Git LFS stub "
            f"({os.path.getsize(glb)} B) — run `git lfs pull` for the real bytes."
        )

    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=glb)
    new = [o for o in bpy.data.objects if o not in before]
    visual = [o for o in new if o.type == "MESH" and not o.name.lower().startswith("collider")]
    extras = [o for o in new if o not in visual]

    if not visual:
        for o in new:
            bpy.data.objects.remove(o, do_unlink=True)
        raise RuntimeError(f"no visual mesh in {os.path.basename(glb)}")

    bpy.ops.object.select_all(action="DESELECT")
    for o in visual:
        o.select_set(True)
    bpy.context.view_layer.objects.active = visual[0]
    if len(visual) > 1:
        bpy.ops.object.join()
    proto = bpy.context.view_layer.objects.active

    # Bake the importer's Y-up→Z-up root + any local transform into the mesh,
    # so the datablock is upright with an identity object transform.
    bpy.ops.object.select_all(action="DESELECT")
    proto.select_set(True)
    bpy.context.view_layer.objects.active = proto
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


# ── shared import core + auto-sync ────────────────────────────────────────────


def _import_into_scene(repo_root: str, track_id: str) -> tuple[int, int]:
    """(Re)build the ``_hoverbike_props_preview`` collection from the track
    JSON's ``props[]``: import each unique asset GLB once and drop one shared-
    mesh instance per placement at the runtime pose. Returns
    ``(placements_made, unique_props)``. A track with no asset props returns
    ``(0, 0)`` after clearing any stale preview. Raises ``RuntimeError`` on a
    hard error (missing GLB / LFS stub).

    Uses ``bpy.ops`` (glTF import / join / transform_apply), so it must run with
    a real window context — handler callers defer it via ``schedule_auto_import``.
    Shared by the *Import Prop Placements* operator and the auto-sync hooks so a
    button click and an auto-open stay byte-for-byte identical."""
    json_path = _track_json_path(repo_root, track_id)
    if not os.path.isfile(json_path):
        raise RuntimeError(f"no track JSON: {json_path}")
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    all_props = data.get("props", [])
    asset_props = [p for p in all_props if p.get("type") == "asset" and p.get("assetId")]

    _ensure_object_mode()
    coll = _ensure_preview_collection()
    _clear_preview(coll)
    if not asset_props:
        return (0, 0)

    mesh_cache: dict[str, bpy.types.Mesh] = {}
    for asset_id in sorted({p["assetId"] for p in asset_props}):
        mesh_cache[asset_id] = _import_glb_mesh(repo_root, asset_id)

    made = 0
    for i, p in enumerate(all_props):
        if p.get("type") != "asset" or not p.get("assetId"):
            continue
        mesh = mesh_cache.get(p["assetId"])
        if mesh is None:
            continue
        obj = bpy.data.objects.new(f"prop_{p['assetId'].split('/')[-1]}_{i:03d}", mesh)
        coll.objects.link(obj)

        pos = p.get("position", {})
        obj.location = _blender_from_three(
            float(pos.get("x", 0.0)), float(pos.get("y", 0.0)), float(pos.get("z", 0.0))
        )
        rot = p.get("rotation", {})
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = _quat_blender_from_three(
            float(rot.get("x", 0.0)),
            float(rot.get("y", 0.0)),
            float(rot.get("z", 0.0)),
            float(rot.get("w", 1.0)),
        )
        sz = p.get("size", {})
        # three.js size axes (x,y,z) → Blender scale (x,z,y); unsigned.
        obj.scale = (float(sz.get("x", 1.0)), float(sz.get("z", 1.0)), float(sz.get("y", 1.0)))

        obj[ASSET_ID_KEY] = p["assetId"]
        obj[PROP_INDEX_KEY] = i
        obj[KIND_KEY] = KIND_VALUE
        wr = p.get("waveRider")
        if isinstance(wr, dict):
            obj[WAVE_RIDER_KEY] = True
            dof = wr.get("dof")
            obj[WAVE_RIDER_DOF_KEY] = dof if dof in WAVE_RIDER_DOFS else "locked"
        made += 1
    return (made, len(mesh_cache))


def schedule_auto_import(delay: float = 0.0) -> None:
    """Best-effort, deferred prop-placement import for the auto-sync hooks (the
    ``load_post`` handler and the *Reload from JSON* operator). The real import
    is deferred onto a one-shot ``bpy.app.timers`` callback so the GLB-import
    ``bpy.ops`` run with a valid window context instead of inside a handler.
    No-op in background/headless Blender (no window). Errors are swallowed and
    logged — auto-sync must never break opening a file."""
    if bpy.app.background:
        return

    def _run():
        try:
            repo_root = _repo_root()
            track_id = _track_id()
            if repo_root and track_id and os.path.isfile(_track_json_path(repo_root, track_id)):
                made, n_unique = _import_into_scene(repo_root, track_id)
                print(
                    f"[hoverbike] auto-synced {made} prop placement(s) "
                    f"({n_unique} unique) into {PREVIEW_COLLECTION}"
                )
        except Exception as e:  # noqa: BLE001 — informational; never block load
            print(f"[hoverbike] prop-placement auto-sync skipped: {e}")
        return None  # one-shot timer

    try:
        bpy.app.timers.register(_run, first_interval=delay)
    except Exception as e:  # noqa: BLE001
        print(f"[hoverbike] could not schedule prop auto-sync: {e}")


# ── operators ────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_import_prop_placements(bpy.types.Operator):
    """Import the track's placed props (props[]) as movable mesh instances of
    their shipping GLBs into a hidden preview collection."""

    bl_idname = "hoverbike.import_prop_placements"
    bl_label = "Import Prop Placements"
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
        try:
            made, n_unique = _import_into_scene(repo_root, track_id)
        except RuntimeError as exc:
            self.report({"ERROR"}, str(exc))
            return {"CANCELLED"}
        if made == 0:
            self.report({"WARNING"}, "no asset props in track JSON")
            return {"CANCELLED"}
        self.report({"INFO"}, f"imported {made} placements ({n_unique} unique props)")
        return {"FINISHED"}


class HOVERBIKE_OT_write_prop_placements(bpy.types.Operator):
    """Write the preview instances back into the track JSON props[] array,
    preserving any non-asset props and the rest of the file verbatim."""

    bl_idname = "hoverbike.write_prop_placements"
    bl_label = "Write Prop Placements → JSON"
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

        coll = bpy.data.collections.get(PREVIEW_COLLECTION)
        if coll is None:
            self.report({"ERROR"}, f"no '{PREVIEW_COLLECTION}' collection — import first")
            return {"CANCELLED"}

        with open(json_path, "r", encoding="utf-8") as f:
            existing = json.load(f).get("props", [])
        # Preserve anything the preview doesn't represent (procedural / non-ai props).
        preserved = [p for p in existing if not (p.get("type") == "asset" and p.get("assetId"))]

        objs = [o for o in coll.objects if o.get(ASSET_ID_KEY)]
        objs.sort(key=lambda o: (o.get(PROP_INDEX_KEY, 1_000_000), o.name))

        asset_props = []
        for obj in objs:
            loc, quat, scale = obj.matrix_basis.decompose()
            px, py, pz = _three_from_blender(loc)
            rx, ry, rz, rw = _quat_three_from_blender(quat)
            fresh = {
                "type": "asset",
                "assetId": obj[ASSET_ID_KEY],
                "position": {"x": _r(px, 3), "y": _r(py, 3), "z": _r(pz, 3)},
                "rotation": {"x": _r(rx, 6), "y": _r(ry, 6), "z": _r(rz, 6), "w": _r(rw, 6)},
                # Blender scale (x,y,z) → three.js size (x,z,y); unsigned.
                "size": {"x": _r(scale.x, 3), "y": _r(scale.z, 3), "z": _r(scale.y, 3)},
            }
            if obj.get(WAVE_RIDER_KEY):
                dof = obj.get(WAVE_RIDER_DOF_KEY)
                fresh["waveRider"] = {"dof": dof if dof in WAVE_RIDER_DOFS else "locked"}
            # If this instance hasn't actually moved since import, re-emit the
            # ORIGINAL entry verbatim. The decompose() above canonicalises the
            # quaternion sign (q and -q are the same rotation), so an unmoved
            # prop with an original w<0 would otherwise churn the diff. Reusing
            # the source entry keeps a no-op write byte-identical and a single
            # moved prop a one-prop diff.
            idx = obj.get(PROP_INDEX_KEY)
            orig = existing[idx] if isinstance(idx, int) and 0 <= idx < len(existing) else None
            asset_props.append(orig if _same_pose(orig, fresh) else fresh)

        _splice_props_into_json(json_path, preserved + asset_props)
        self.report({"INFO"}, f"wrote {len(asset_props)} placements ({len(preserved)} preserved)")
        return {"FINISHED"}


class HOVERBIKE_OT_set_prop_float(bpy.types.Operator):
    """Tag the selected prop-placement previews to float on waves (or clear
    the tag), using the panel's Float + Motion settings. Stamped onto the
    preview objects and written into ``props[].waveRider`` by the next
    *Write Prop Placements → JSON*. At runtime a floated prop becomes a
    kinematic body that tracks the swell using the prop's own collider."""

    bl_idname = "hoverbike.set_prop_float"
    bl_label = "Apply Float to Selected"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scn = context.scene
        enabled = bool(getattr(scn, "hb_wave_rider_enabled", True))
        dof = getattr(scn, "hb_wave_rider_dof", "locked")
        n = 0
        for obj in context.selected_objects:
            if obj.get(ASSET_ID_KEY) is None:
                continue  # only prop-placement previews carry the asset id
            if enabled:
                obj[WAVE_RIDER_KEY] = True
                obj[WAVE_RIDER_DOF_KEY] = dof
            else:
                for key in (WAVE_RIDER_KEY, WAVE_RIDER_DOF_KEY):
                    if key in obj.keys():
                        del obj[key]
            n += 1
        if n == 0:
            self.report({"WARNING"}, "no prop-placement previews selected (Import first)")
            return {"CANCELLED"}
        self.report({"INFO"}, f"set {n} prop(s) → {'floating' if enabled else 'static'}")
        return {"FINISHED"}


class HOVERBIKE_PT_props(bpy.types.Panel):
    bl_label = "Prop Placements"
    bl_idname = "HOVERBIKE_PT_props"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Hoverbike"
    bl_parent_id = "HOVERBIKE_PT_panel"

    def draw(self, context):
        col = self.layout.column(align=True)
        col.operator("hoverbike.import_prop_placements", icon="IMPORT")
        col.operator("hoverbike.write_prop_placements", icon="EXPORT")

        box = self.layout.box()
        box.label(text="Float on Waves", icon="MOD_OCEAN")
        box.prop(context.scene, "hb_wave_rider_enabled")
        sub = box.column()
        sub.enabled = bool(getattr(context.scene, "hb_wave_rider_enabled", True))
        sub.prop(context.scene, "hb_wave_rider_dof")
        box.operator("hoverbike.set_prop_float", icon="CHECKMARK")


_CLASSES = (
    HOVERBIKE_OT_import_prop_placements,
    HOVERBIKE_OT_write_prop_placements,
    HOVERBIKE_OT_set_prop_float,
    HOVERBIKE_PT_props,
)


def register() -> None:
    bpy.types.Scene.hb_wave_rider_enabled = bpy.props.BoolProperty(
        name="Float",
        description="Tag selected prop instances to float on the wave surface",
        default=True,
    )
    bpy.types.Scene.hb_wave_rider_dof = bpy.props.EnumProperty(
        name="Motion",
        description="Degrees of freedom for the float",
        items=[
            ("locked", "Heave + tilt", "Vertical bob + pitch/roll; authored heading held"),
            ("yaw", "+ Yaw", "Also yaw gently with the swell"),
        ],
        default="locked",
    )
    for cls in _CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except Exception:
            pass
    for attr in ("hb_wave_rider_enabled", "hb_wave_rider_dof"):
        if hasattr(bpy.types.Scene, attr):
            delattr(bpy.types.Scene, attr)
