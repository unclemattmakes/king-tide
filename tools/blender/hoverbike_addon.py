"""Hoverbike — in-Blender "Export to Game" addon.

Single-file addon. Install once via:

    Edit → Preferences → Add-ons → Install…
    pick: tools/blender/hoverbike_addon.py
    enable the checkbox next to "Hoverbike: Export to Game"

After installing, the 3D viewport sidebar (press N) shows a
"Hoverbike" tab with two buttons:

    [ Export to Game ]   ← validate + write GLB + (if missing) starter JSON
    [ Open Game in Browser ]  ← copies the playtest URL to the clipboard

The addon does NOT need a running Vite dev server. It writes files
directly into the cloned repo. Repo root is auto-detected by walking
up from the currently-open .blend until a `package.json` is found.

The validation rules + GLB export options match the legacy
`tools/export_track.py` script (which is still supported for headless
CI / scripted runs). On first export of a track, a starter JSON is
written to `public/tracks/<id>.json` so the in-app editor can open
it. Subsequent exports do NOT overwrite that JSON — once you've
edited gameplay placement in the in-app editor, that file is the
source of truth, and only the GLB rebuilds. To force-rewrite the
JSON from the .blend, hold Shift while clicking the button (or set
the operator's "force_json" toggle from the Adjust Last Operation
panel).

Track id is derived from the .blend filename, e.g.
`tracks-src/my-track.blend` → id `my-track`. Override per-scene by
adding a string Custom Property `hoverbike_track_id` to the scene.
"""

from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from typing import Any

import bpy
from bpy.props import BoolProperty
from bpy.types import Operator, Panel

bl_info = {
    "name": "Hoverbike: Export to Game",
    "author": "Hoverbike",
    "version": (1, 0, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > Hoverbike",
    "description": "One-click export from Blender to the running hoverbike game.",
    "category": "Import-Export",
}


# ── Repo discovery ──────────────────────────────────────────────────────────


def find_repo_root(start: str | None) -> str | None:
    """Walk up from `start` looking for a directory containing
    package.json + a `public/` folder. Returns the absolute path or
    None if the .blend isn't inside a hoverbike clone.
    """
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


def derive_track_id() -> str | None:
    """Pick the track id from a scene custom property, falling back
    to the .blend filename's basename. Returns None if no .blend is
    saved (operator refuses to run in that case)."""
    scene_id = bpy.context.scene.get("hoverbike_track_id")
    if isinstance(scene_id, str) and scene_id.strip():
        return scene_id.strip()
    blend = bpy.data.filepath
    if not blend:
        return None
    base = os.path.splitext(os.path.basename(blend))[0]
    return base or None


# ── Validation (mirrors tools/export_track.py) ──────────────────────────────

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
    layer. Combines the eye icon (`hide_get()`), the monitor icon
    (`hide_viewport`), and ancestor-collection visibility.

    Hidden objects are skipped by validation, baking, JSON
    derivation, and the GLB export — letting authors stage WIP or
    decorative geometry in the .blend without it leaking into the
    game build.
    """
    try:
        return bool(obj.visible_get())
    except RuntimeError:
        # `visible_get()` raises if the object isn't in the current
        # view layer at all (e.g. linked-data corner cases). Treat
        # those as not-exported.
        return False


def bake_ai_splines() -> None:
    """Sample every visible ai_spline_* curve into a flat
    [x0,y0,z0,...] custom property on the same object. Hidden curves
    are skipped (mirrors the export filter)."""
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


def validate_scene() -> list[str]:
    errors: list[str] = []
    by_kind: dict[str, list[bpy.types.Object]] = defaultdict(list)

    for obj in bpy.data.objects:
        kind = expected_kind(obj.name)
        if kind is None:
            continue
        # Hidden objects are not part of the export — don't validate
        # them. This lets authors keep WIP / reference cp_* / spline
        # objects parked in a hidden collection without tripping the
        # contiguous-index or single-spline checks.
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


# ── JSON derivation (mirrors tools/blender/build_track.py::emit_gameplay_json) ──


def _b2t(x: float, y: float, z: float) -> dict[str, float]:
    """Blender (X right, Y forward, Z up) → three.js (X right, Y up, Z forward).

    Blender +Y forward maps to three.js +Z forward via -Y, matching
    what gltf export does with `export_yup=True`.
    """
    return {"x": float(x), "y": float(z), "z": -float(y)}


def _yaw_from_z_euler(obj: bpy.types.Object) -> float:
    """A start_NN empty stores its facing direction as a Z-axis
    Euler rotation. Convert to the runtime yaw (rotation around
    three's +Y, sign convention matches createBike())."""
    return float(obj.rotation_euler.z)


def derive_track_json(track_id: str, glb_url: str) -> dict[str, Any]:
    """Build a runtime gameplay JSON from the currently-open .blend's
    metadata objects.

    Mirrors `tools/blender/build_track.py::emit_gameplay_json` but
    sources its data from `bpy.data.objects` rather than a spec file.
    The output matches the schema in `src/game/tracks/json-loader.ts`.
    """
    by_kind: dict[str, list[bpy.types.Object]] = defaultdict(list)
    for obj in bpy.data.objects:
        if not is_object_visible(obj):
            continue
        kind = expected_kind(obj.name)
        if kind:
            by_kind[kind].append(obj)

    # Checkpoints — sorted by name for stable cp_00, cp_01, ... order.
    cps = sorted(by_kind.get("checkpoint", []), key=lambda o: o.name)
    checkpoints: list[dict[str, Any]] = []
    for i, cp in enumerate(cps):
        loc = cp.matrix_world.translation
        checkpoints.append(
            {
                "index": i,
                "position": _b2t(loc.x, loc.y, loc.z),
                # No rotation conversion yet — the empty's rotation is
                # ignored on first import; spline-bound gates get their
                # facing from the spline tangent at boot. Authors
                # tweak gate yaw in the in-app editor.
                "rotation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
                "halfWidth": float(cp.get("half_width", 6.0)),
                "height": float(cp.get("height", 4.0)),
            }
        )

    # Starts — pick start_00 if present, else any start, else origin.
    starts = sorted(by_kind.get("start", []), key=lambda o: o.name)
    if starts:
        s0 = starts[0]
        s_loc = s0.matrix_world.translation
        start_pos = _b2t(s_loc.x, s_loc.y, s_loc.z)
        start_yaw = _yaw_from_z_euler(s0)
    else:
        start_pos = {"x": 0.0, "y": 0.5, "z": 0.0}
        start_yaw = 0.0

    # AI spline — sample the dense vertex list from the curve and
    # emit it as `anchors` (Catmull-Rom control points). 12 anchors is
    # a good starting point for a stadium-style loop; the editor lets
    # the author add/remove/move them later. We sample evenly across
    # the dense polyline rather than using all of it (would produce
    # ~50+ anchors which is unwieldy in the editor).
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

    # Pickup spawns.
    pickups: list[dict[str, float]] = []
    for p in by_kind.get("pickup_spawn", []):
        loc = p.matrix_world.translation
        pickups.append(_b2t(loc.x, loc.y, loc.z))

    # Water volume tuning.
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


# ── Operators ──────────────────────────────────────────────────────────────


class HOVERBIKE_OT_export_to_game(Operator):
    """Validate the scene, export the GLB into the cloned repo's
    public/assets/tracks/, and on first export write a starter JSON
    to public/tracks/. Subsequent exports preserve the JSON (the
    in-app editor owns it). Hold Shift to overwrite the JSON."""

    bl_idname = "hoverbike.export_to_game"
    bl_label = "Export to Game"
    bl_description = (
        "Validate scene, export GLB, and (on first export) write a starter JSON. "
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
        # Shift-click in the UI → set force_json=True.
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

        track_id = derive_track_id()
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

        # 1. Validate (after baking the ai splines so the validator
        #    has the points to count).
        bake_ai_splines()
        errors = validate_scene()
        if errors:
            for e in errors:
                self.report({"ERROR"}, f"validation: {e}")
            return {"CANCELLED"}

        # 2. Export GLB. Visible-only: the eye icon in Blender's
        #    outliner toggles inclusion in the export. Mirrors what
        #    validation + JSON derivation already filter on, so an
        #    object hidden in the viewport disappears from the GLB,
        #    the gameplay JSON, and the validator equally.
        os.makedirs(os.path.dirname(glb_path), exist_ok=True)
        try:
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
            )
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"GLB export failed: {e}")
            return {"CANCELLED"}

        # 3. JSON: starter on first export, preserved on subsequent
        #    exports unless force_json is set.
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


class HOVERBIKE_OT_copy_play_url(Operator):
    """Copy http://localhost:5191/?track=<id>&edit=1 to the clipboard
    so the user can paste it into a browser. Doesn't open a browser
    itself — playtests should run in the user's already-open dev
    browser, not a fresh one launched by Blender."""

    bl_idname = "hoverbike.copy_play_url"
    bl_label = "Copy Play URL"
    bl_description = "Copy the dev-server URL for this track to the clipboard."
    bl_options = {"REGISTER"}

    edit: BoolProperty(  # type: ignore[valid-type]
        name="Edit mode",
        description="Append &edit=1 so the URL opens the in-app editor.",
        default=False,
    )

    def execute(self, context: bpy.types.Context) -> set[str]:
        track_id = derive_track_id()
        if not track_id:
            self.report({"ERROR"}, "Save your .blend first to derive a track id.")
            return {"CANCELLED"}
        url = f"http://localhost:5191/?track={track_id}"
        if self.edit:
            url += "&edit=1"
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

        track_id = derive_track_id() or "<unknown>"
        repo = find_repo_root(blend)

        box = layout.box()
        box.label(text=f"Track: {track_id}", icon="WORLD_DATA")
        if repo:
            box.label(text=f"Repo: {os.path.basename(repo)}", icon="FILE_FOLDER")
        else:
            box.label(text="Repo not found", icon="ERROR")
            box.label(text="Save .blend inside a hoverbike/ clone.")

        # Big primary button.
        row = layout.row()
        row.scale_y = 1.6
        row.operator("hoverbike.export_to_game", icon="EXPORT")

        # URL helpers.
        col = layout.column(align=True)
        op_play = col.operator(
            "hoverbike.copy_play_url",
            text="Copy Play URL",
            icon="URL",
        )
        op_play.edit = False
        op_edit = col.operator(
            "hoverbike.copy_play_url",
            text="Copy Edit URL",
            icon="GREASEPENCIL",
        )
        op_edit.edit = True

        # Hint about Shift-click.
        layout.separator()
        col = layout.column(align=True)
        col.scale_y = 0.85
        col.label(text="Shift-click Export:", icon="INFO")
        col.label(text="overwrite the JSON")
        col.label(text="from the .blend.")


# ── Registration ───────────────────────────────────────────────────────────

_classes = (
    HOVERBIKE_OT_export_to_game,
    HOVERBIKE_OT_copy_play_url,
    HOVERBIKE_PT_panel,
)


def register() -> None:
    for cls in _classes:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(_classes):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass


if __name__ == "__main__":
    register()
