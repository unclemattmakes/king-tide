"""Track-hero thumbnail / loading-screen render.

Each ship-quality track ships with two pieces of UI art:

  * A 1280×720 **hero image** for the loading screen.
  * A 320×180 **tile thumbnail** for the track-select grid.

Both are author-controlled but reproducible: authors park a single
``camera_hero`` Camera in the .blend pointing at the track's set-piece,
and the runtime never sees it (the GLB export strips cameras, and the
chase cam is procedural anyway). The thumbnail render is driven by the
*Render Track Hero* button in the addon's Track thumbnail sub-panel,
and is auto-fired after every track export so the loading screen and
tile preview stay in sync with the latest .blend.

EEVEE is the render engine of choice — Cycles is overkill for a
loading-screen tile (we need readable composition, not photorealism)
and EEVEE typically renders both sizes in well under a second. The
output format is JPG at quality 85, which keeps 12 tracks worth of art
small enough to ship in ``public/assets/tracks/`` without bloating the
initial site download.

Per-module ``register()`` / ``unregister()`` so the package init just
imports this module. The sub-panel itself is registered alongside the
other ``KINGTIDE_PT_track_*`` sub-panels by ``panel.py``.
"""

from __future__ import annotations

import os
import time

import bpy
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

CAMERA_HERO_NAME = "camera_hero"
CAMERA_HERO_KIND = "camera_hero"

# Hero image — sized to match the loading-screen overlay design. 16:9
# at 720p reads cleanly through the radial-vignette + scanline UI
# decorations layered on top of it at runtime.
HERO_WIDTH = 1280
HERO_HEIGHT = 720

# Tile thumbnail — 16:9 at 320×180 (¼ the hero linear dims) is the size
# of one cell in the track-select grid layout. The same camera frames
# both: a 1280×720 JPG re-sampled to 320×180 looks slightly softer than
# rendering directly at the tile size, so we render twice rather than
# downscale. The cost is negligible (EEVEE renders the tile in <100 ms
# on a modern GPU).
TILE_WIDTH = 320
TILE_HEIGHT = 180

# JPG quality. 85 is the sweet spot — the loading-screen image is shown
# briefly, and lower quality is hard to spot at the rendered size.
JPG_QUALITY = 85

# Output suffixes inside ``public/assets/tracks/``.
HERO_SUFFIX = "-hero.jpg"
TILE_SUFFIX = "-thumb.jpg"

# Camera defaults — a sensible loading-screen starting point that
# authors then aim however they want.
DEFAULT_FOCAL_LENGTH_MM = 50.0


# ────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────


def _resolve_repo_paths(track_id: str) -> tuple[str, str] | None:
    """Return ``(hero_abs_path, tile_abs_path)`` for the given track id,
    or ``None`` if the .blend isn't inside a king-tide clone. Lifted
    out of the operator so the auto-render hook in ``export.py`` can
    share the same path-derivation."""
    from ._legacy import find_repo_root

    blend = bpy.data.filepath
    if not blend:
        return None
    repo = find_repo_root(blend)
    if not repo:
        return None
    tracks_dir = os.path.join(repo, "public", "assets", "tracks")
    return (
        os.path.join(tracks_dir, f"{track_id}{HERO_SUFFIX}"),
        os.path.join(tracks_dir, f"{track_id}{TILE_SUFFIX}"),
    )


def find_camera_hero() -> bpy.types.Object | None:
    """Locate the hero camera in the scene. Prefers ``kind=camera_hero``
    so an author who renamed the empty isn't blocked, falls back to the
    canonical name. Returns the first match — there should never be
    more than one."""
    for obj in bpy.data.objects:
        if obj.type == "CAMERA" and obj.get("kind") == CAMERA_HERO_KIND:
            return obj
    return bpy.data.objects.get(CAMERA_HERO_NAME)


def _ensure_eevee_engine(scene: bpy.types.Scene) -> str:
    """Switch the scene render engine to EEVEE (Blender 4.x calls it
    ``BLENDER_EEVEE_NEXT``; older versions called it ``BLENDER_EEVEE``).
    Returns the previously-set engine so the caller can restore it
    after the render. Falls back to whatever's installed if neither
    EEVEE name is available — Cycles will still produce the image, just
    slower."""
    prev = scene.render.engine
    for candidate in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = candidate
            return prev
        except (TypeError, ValueError):
            continue
    # Either name failed (truly weird Blender install) — leave it alone.
    return prev


def _aim_camera_at(
    cam: bpy.types.Object,
    target_co: tuple[float, float, float],
) -> None:
    """Aim ``cam`` at ``target_co`` by computing a -Z look direction
    (Blender's camera shoots down -Z) and writing a rotation_euler that
    matches. No constraint plumbing — we just stamp the rotation so the
    operator stays single-shot. World-space throughout."""
    import mathutils

    target = mathutils.Vector(target_co)
    pos = cam.matrix_world.translation
    # If the camera is sitting on the target (no direction to aim) just
    # leave it alone — author's already in trouble; the rotation matrix
    # would be undefined.
    delta = target - pos
    if delta.length < 1e-4:
        return
    # ``to_track_quat`` does the camera-axis convention for us: -Z
    # towards the target, +Y up.
    quat = delta.to_track_quat("-Z", "Y")
    cam.rotation_euler = quat.to_euler()


def _default_target_location() -> tuple[float, float, float]:
    """Best-effort guess for "where the set-piece is" so the first
    Add Camera Hero click parks the camera looking at something useful.
    Order: first start position → AI spline midpoint → world origin."""
    start = bpy.data.objects.get("start_00")
    if start is not None:
        co = start.matrix_world.translation
        return (co.x, co.y, co.z + 1.5)
    spline = bpy.data.objects.get("ai_spline_main")
    if spline is not None and spline.type == "CURVE":
        # Sample the curve roughly mid-arc by averaging the first two
        # control points — cheap and dependency-free vs. importing the
        # arc-length helper from track_meta.
        for spl in spline.data.splines:
            if spl.type == "BEZIER" and len(spl.bezier_points) > 0:
                bp = spl.bezier_points[len(spl.bezier_points) // 2]
                co = spline.matrix_world @ bp.co
                return (co.x, co.y, co.z)
            if spl.type != "BEZIER" and len(spl.points) > 0:
                p = spl.points[len(spl.points) // 2]
                co = spline.matrix_world @ p.co.xyz
                return (co.x, co.y, co.z)
    return (0.0, 0.0, 0.0)


def _render_at_size(
    scene: bpy.types.Scene,
    cam: bpy.types.Object,
    out_path: str,
    width: int,
    height: int,
) -> float:
    """Configure scene render settings + invoke ``render.render`` once.
    Returns the wall-clock duration in seconds. The caller is
    responsible for engine selection + restoring any state we mutate
    here (resolution + camera + output path); we save/restore so a
    render initiated from an authored scene doesn't leak settings."""
    prev_cam = scene.camera
    prev_res_x = scene.render.resolution_x
    prev_res_y = scene.render.resolution_y
    prev_res_pct = scene.render.resolution_percentage
    prev_filepath = scene.render.filepath
    prev_format = scene.render.image_settings.file_format
    prev_quality = scene.render.image_settings.quality
    prev_film_transparent = scene.render.film_transparent

    try:
        scene.camera = cam
        scene.render.resolution_x = width
        scene.render.resolution_y = height
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "JPEG"
        scene.render.image_settings.quality = JPG_QUALITY
        # Opaque background for a loading-screen tile — the JPG format
        # doesn't carry alpha anyway, but turning off film transparency
        # avoids the EEVEE "black background where the sky should be"
        # case some templates show.
        scene.render.film_transparent = False
        scene.render.filepath = out_path

        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        t0 = time.monotonic()
        bpy.ops.render.render(write_still=True)
        return time.monotonic() - t0
    finally:
        scene.camera = prev_cam
        scene.render.resolution_x = prev_res_x
        scene.render.resolution_y = prev_res_y
        scene.render.resolution_percentage = prev_res_pct
        scene.render.image_settings.file_format = prev_format
        scene.render.image_settings.quality = prev_quality
        scene.render.film_transparent = prev_film_transparent
        scene.render.filepath = prev_filepath


def render_track_hero(
    *,
    render_tile: bool = True,
) -> tuple[str, str | None, float, float]:
    """Render the hero image (+ optional tile thumbnail) for the active
    .blend. Headless-safe; shared by the addon operator and the
    standalone CLI script.

    Returns ``(hero_path, tile_path_or_None, hero_seconds, tile_seconds)``
    on success. Raises ``RuntimeError`` if anything blocks the render
    (no camera, no repo root, unsaved .blend). The caller decides
    whether that's a hard or soft failure.
    """
    from ._legacy import derive_asset_id

    blend = bpy.data.filepath
    if not blend:
        raise RuntimeError("save the .blend first — track id is derived from the filename")

    track_id = derive_asset_id("hoverbike_track_id")
    if not track_id:
        raise RuntimeError("couldn't derive a track id from the .blend filename")

    paths = _resolve_repo_paths(track_id)
    if paths is None:
        raise RuntimeError(
            f"no repo root for {blend} — save the .blend inside a king-tide clone"
        )
    hero_path, tile_path = paths

    cam = find_camera_hero()
    if cam is None:
        raise RuntimeError(
            "no camera_hero in the scene — click Add Camera Hero in the Track thumbnail sub-panel"
        )

    scene = bpy.context.scene
    prev_engine = _ensure_eevee_engine(scene)
    try:
        hero_seconds = _render_at_size(scene, cam, hero_path, HERO_WIDTH, HERO_HEIGHT)
        tile_seconds = 0.0
        if render_tile:
            tile_seconds = _render_at_size(scene, cam, tile_path, TILE_WIDTH, TILE_HEIGHT)
    finally:
        scene.render.engine = prev_engine

    scene["_hoverbike_track_hero_rendered_at"] = time.time()
    return (hero_path, tile_path if render_tile else None, hero_seconds, tile_seconds)


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class KINGTIDE_OT_add_camera_hero(Operator):
    """Drop a ``camera_hero`` Camera at the 3D cursor pointing at a
    sensible default target (start_00, the AI-spline mid-point, or the
    world origin). Sets focal length to 50 mm for a cinematic-ish
    framing; authors then move/aim it manually for the final shot.

    Re-running with an existing ``camera_hero`` is a no-op — surfaces a
    hint and bails out, mirroring the *Add Horizon Ring* pattern."""

    bl_idname = "kingtide.add_camera_hero"
    bl_label = "Add Camera Hero"
    bl_description = (
        "Drop a camera_hero Camera at the 3D cursor, aimed at the track's set-piece. "
        "Used by the headless thumbnail render — runtime never sees it."
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        existing = find_camera_hero()
        if existing is not None:
            self.report(
                {"INFO"},
                f"{existing.name} already exists — move it instead of re-adding",
            )
            return {"CANCELLED"}

        cam_data = bpy.data.cameras.new(CAMERA_HERO_NAME)
        cam_data.lens = DEFAULT_FOCAL_LENGTH_MM
        cam_data.clip_start = 0.1
        cam_data.clip_end = 5000.0

        obj = bpy.data.objects.new(CAMERA_HERO_NAME, cam_data)
        obj["kind"] = CAMERA_HERO_KIND
        obj.location = context.scene.cursor.location.copy()
        _aim_camera_at(obj, _default_target_location())
        context.scene.collection.objects.link(obj)

        # Select the new camera so the next thing the author does is
        # frame it (matches the boost-pad / emitter pattern).
        for o in bpy.data.objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj

        self.report(
            {"INFO"},
            f"Added {CAMERA_HERO_NAME} — frame the shot, then Render Hero",
        )
        return {"FINISHED"}


class KINGTIDE_OT_render_track_hero(Operator):
    """Render the 1280×720 hero image (and the 320×180 tile thumbnail)
    for the current track using ``camera_hero``. Output lands at
    ``public/assets/tracks/<id>-hero.jpg`` + ``-thumb.jpg``.

    Uses EEVEE for speed — the typical render time is well under a
    second per frame on a modern GPU. The track export hook fires this
    automatically after every GLB write, so manual invocation is only
    needed when the camera moves but the GLB hasn't been re-exported."""

    bl_idname = "kingtide.render_track_hero"
    bl_label = "Render Track Hero"
    bl_description = (
        "Render the loading-screen hero (1280×720) and the track-select tile "
        "(320×180) JPGs using camera_hero. Auto-fires on track export."
    )
    bl_options = {"REGISTER"}

    def execute(self, context):
        try:
            hero, tile, ths, tts = render_track_hero(render_tile=True)
        except RuntimeError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        except Exception as e:  # noqa: BLE001 — render failures vary by GPU / state
            self.report({"ERROR"}, f"render failed: {e}")
            return {"CANCELLED"}

        from ._legacy import find_repo_root

        repo = find_repo_root(bpy.data.filepath) or ""
        rel_hero = os.path.relpath(hero, repo).replace("\\", "/") if repo else hero
        rel_tile = (
            os.path.relpath(tile, repo).replace("\\", "/") if (repo and tile) else (tile or "")
        )
        msg = f"Rendered hero {rel_hero} in {ths:.2f}s"
        if tile:
            msg += f" + tile {rel_tile} in {tts:.2f}s"
        self.report({"INFO"}, msg)
        print(f"[kingtide-addon] {msg}")

        # Refresh the manifest so the new heroUrl is picked up without
        # waiting for the next full track export.
        try:
            from ._legacy import _upsert_manifest_track, derive_asset_id

            track_id = derive_asset_id("hoverbike_track_id")
            if track_id:
                repo_root = find_repo_root(bpy.data.filepath)
                if repo_root:
                    json_path = os.path.join(
                        repo_root, "public", "tracks", f"{track_id}.json"
                    )
                    _upsert_manifest_track(
                        repo_root,
                        track_id=track_id,
                        glb_url=f"/assets/tracks/{track_id}.glb",
                        json_path=json_path,
                    )
        except Exception as e:  # noqa: BLE001 — informational; render still succeeded
            self.report({"WARNING"}, f"manifest update skipped: {e}")
        return {"FINISHED"}


class KINGTIDE_OT_render_track_thumbnail(Operator):
    """Render only the 320×180 tile thumbnail. Useful when the author
    has just tweaked the camera framing and wants to refresh the tile
    without paying for the full-size hero render. Almost identical to
    Render Track Hero but skips the larger render and the manifest
    update."""

    bl_idname = "kingtide.render_track_thumbnail"
    bl_label = "Render Track Thumbnail"
    bl_description = (
        "Render just the 320×180 track-select tile JPG using camera_hero. "
        "Cheaper than the full hero — useful when iterating on framing."
    )
    bl_options = {"REGISTER"}

    def execute(self, context):
        from ._legacy import derive_asset_id, find_repo_root

        blend = bpy.data.filepath
        if not blend:
            self.report({"ERROR"}, "save the .blend first")
            return {"CANCELLED"}
        track_id = derive_asset_id("hoverbike_track_id")
        if not track_id:
            self.report({"ERROR"}, "couldn't derive a track id from the .blend filename")
            return {"CANCELLED"}
        paths = _resolve_repo_paths(track_id)
        if paths is None:
            self.report({"ERROR"}, "no repo root — save inside a king-tide clone")
            return {"CANCELLED"}
        _, tile_path = paths

        cam = find_camera_hero()
        if cam is None:
            self.report(
                {"ERROR"},
                "no camera_hero — click Add Camera Hero first",
            )
            return {"CANCELLED"}

        scene = context.scene
        prev_engine = _ensure_eevee_engine(scene)
        try:
            elapsed = _render_at_size(
                scene, cam, tile_path, TILE_WIDTH, TILE_HEIGHT
            )
        except Exception as e:  # noqa: BLE001
            scene.render.engine = prev_engine
            self.report({"ERROR"}, f"render failed: {e}")
            return {"CANCELLED"}
        scene.render.engine = prev_engine

        repo = find_repo_root(blend) or ""
        rel = os.path.relpath(tile_path, repo).replace("\\", "/") if repo else tile_path
        self.report({"INFO"}, f"Rendered tile {rel} in {elapsed:.2f}s")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


_CLASSES: tuple[type, ...] = (
    KINGTIDE_OT_add_camera_hero,
    KINGTIDE_OT_render_track_hero,
    KINGTIDE_OT_render_track_thumbnail,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
