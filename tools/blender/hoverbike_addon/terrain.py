"""Heightmap import + terrain sculpt helpers.

Two related groups of operators live here:

  * **Heightmap import** — load a greyscale PNG/EXR and emit a
    subdivided plane whose verts are displaced by the image's
    luminance. Useful for prototyping real-world coastlines or
    hand-painted terrain without building a Geometry Nodes graph
    from scratch.

  * **Sculpt helpers** — the bigger templates (HV_Island, HV_Dunes,
    HV_Mesa) author terrain parametrically through Geometry Nodes.
    Sculpting that procedural output is a no-op because the GN graph
    re-evaluates after every brush stroke. These operators flip the
    workflow to sculpt-friendly: apply the modifier stack so the
    verts become editable, then drop the user into Sculpt Mode on
    the resulting mesh. Plus a global Laplacian smoothing pass and a
    radial raise/lower brush for one-click bulk shaping.
"""

from __future__ import annotations

import math
import os

import bpy
import mathutils
from bpy.props import BoolProperty, FloatProperty, IntProperty, StringProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

HEIGHTMAP_TERRAIN_NAME = "terrain_heightmap"
HEIGHTMAP_MATERIAL_NAME = "mat_terrain_heightmap"


# ────────────────────────────────────────────────────────────────────
# Heightmap import
# ────────────────────────────────────────────────────────────────────


def _import_heightmap(
    image_path: str,
    *,
    map_size_m: float,
    height_scale_m: float,
    base_elevation_m: float,
    subdivisions: int,
) -> dict:
    """Load ``image_path`` as a Blender Image and build a subdivided
    plane whose verts are displaced by the image's luminance. Returns
    a summary dict for the operator report.

    Sampling is point-bilinear: each vertex looks up four nearest
    pixels and blends. Image alpha / colour channels are reduced to
    luminance (R * 0.299 + G * 0.587 + B * 0.114). Out-of-bounds
    reads clamp to the edge, so the plane's border matches the
    image border."""
    if not os.path.isfile(image_path):
        raise RuntimeError(f"Heightmap file not found: {image_path}")
    img = bpy.data.images.load(image_path, check_existing=False)
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

    # Wipe any prior heightmap-imported terrain (idempotent re-import).
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


class HOVERBIKE_OT_import_heightmap(Operator):
    """Read a greyscale PNG/EXR and emit a subdivided plane whose
    verts are luminance-displaced. Replaces any prior
    ``terrain_heightmap`` object. The mesh ships out as
    ``kind=track`` so it's collidable at runtime."""

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


# ────────────────────────────────────────────────────────────────────
# Sculpt helpers
# ────────────────────────────────────────────────────────────────────


def _sculptable_terrain(context) -> bpy.types.Object | None:
    """Pick the terrain mesh sculpt operations should target. Prefers
    the user's active selection if it's a ``kind=track`` mesh; falls
    back to the largest one in the scene. Returns None if no
    candidate is found."""
    from ._legacy import _largest_terrain_mesh

    ao = context.active_object
    if ao is not None and ao.type == "MESH" and ao.get("kind") == "track":
        return ao
    return _largest_terrain_mesh()


class HOVERBIKE_OT_apply_terrain_modifiers(Operator):
    """Bake every viewport-enabled modifier on the terrain mesh into
    its vertex data. After this, the ``HV_Island`` (or any other
    procedural) GN graph stops contributing — the mesh is a plain
    editable surface and Sculpt Mode brushes work as expected.
    One-way: re-tuning the procedural sliders is no longer possible.
    Save the .blend first."""

    bl_idname = "hoverbike.apply_terrain_modifiers"
    bl_label = "Apply Terrain Modifiers"
    bl_description = (
        "Bake all viewport-enabled modifiers (HV_Island, etc.) into the "
        "terrain mesh so vertex edits / sculpt brushes survive evaluation"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from ._legacy import _apply_all_viewport_modifiers, _terrain_active_modifiers

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
    still has procedural modifiers in the stack, this errors out —
    the GN output would overwrite every brush stroke. Run *Apply
    Terrain Modifiers* first.

    Sculpt Mode unlocks Blender's full brush set: Draw, Smooth,
    Flatten, Inflate, Grab, Crease. The Hoverbike addon doesn't ship
    custom brushes; the goal here is just to remove the friction of
    finding the right object + mode for terrain shaping."""

    bl_idname = "hoverbike.enter_sculpt_mode"
    bl_label = "Sculpt Terrain"
    bl_description = "Select the terrain and switch into Sculpt Mode for hand-shaping"
    bl_options = {"REGISTER"}

    def execute(self, context):
        from ._legacy import _terrain_active_modifiers

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
        # Make sure the terrain is the active + selected object —
        # Sculpt Mode operates on the active object only.
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
    """Run a Laplacian-smoothing pass over every vertex on the
    terrain. Cheaper than a manual smooth-brush sweep when you just
    want to soften the entire heightfield by one notch.

    Iteration count and per-pass weight are scene properties so the
    user can dial in subtle (1 iter, 0.3 weight) vs. heavy (8 iters,
    0.8 weight) smoothing without leaving the panel."""

    bl_idname = "hoverbike.smooth_terrain"
    bl_label = "Smooth Terrain"
    bl_description = "Apply a global Laplacian smoothing pass to the terrain mesh"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from ._legacy import _terrain_active_modifiers

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
    after *Apply Terrain Modifiers* if the procedural mesh is too
    coarse to sculpt detail at race scale. Doubles vertex count per
    click."""

    bl_idname = "hoverbike.subdivide_terrain"
    bl_label = "Subdivide Terrain"
    bl_description = "Subdivide the terrain mesh once (each face → 4)"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from ._legacy import _terrain_active_modifiers

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
    """Raise (or lower) the terrain inside a circle around the 3D
    cursor. Falls off with smoothstep from the cursor's XY position
    out to the configured radius. Quick way to bump up a hill or
    carve a basin without learning the brush UI.

    Direction (raise vs. lower) is the operator's ``lower`` argument,
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
        from ._legacy import _terrain_active_modifiers

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


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_import_heightmap,
    HOVERBIKE_OT_apply_terrain_modifiers,
    HOVERBIKE_OT_enter_sculpt_mode,
    HOVERBIKE_OT_smooth_terrain,
    HOVERBIKE_OT_subdivide_terrain,
    HOVERBIKE_OT_raise_lower_terrain,
)

_SCENE_PROP_NAMES: tuple[str, ...] = (
    "hoverbike_heightmap_path",
    "hoverbike_heightmap_size",
    "hoverbike_heightmap_height",
    "hoverbike_heightmap_base",
    "hoverbike_heightmap_subdivisions",
    "hoverbike_sculpt_radius",
    "hoverbike_sculpt_magnitude",
    "hoverbike_sculpt_smooth_iters",
    "hoverbike_sculpt_smooth_weight",
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    # Heightmap importer settings.
    bpy.types.Scene.hoverbike_heightmap_path = StringProperty(
        name="Last heightmap",
        description="Most recently imported heightmap file (pre-fills the file picker).",
        default="",
        subtype="FILE_PATH",
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
        description=(
            "World-Z offset applied to every vertex (use a negative value to seat the terrain below sea level)."
        ),
        default=-30.0, min=-500.0, max=500.0, precision=1,
    )
    bpy.types.Scene.hoverbike_heightmap_subdivisions = IntProperty(
        name="Subdivisions",
        description="Per-edge subdivisions of the imported plane. Higher = more terrain detail, more verts.",
        default=256, min=8, max=2048,
    )

    # Terrain sculpt knobs — drive the bulk-shape and smooth operators.
    # Radius / magnitude are world-space metres so they scale
    # predictably with the rest of the addon's authoring UI.
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
        description=(
            "Per-pass blend weight toward the neighbour mean. 0 = no smoothing; 1 = collapse onto mean each pass."
        ),
        default=0.5, min=0.0, max=1.0, precision=2,
    )


def unregister() -> None:
    for prop in _SCENE_PROP_NAMES:
        try:
            delattr(bpy.types.Scene, prop)
        except AttributeError:
            pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
