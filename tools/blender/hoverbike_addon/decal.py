"""Decal authoring.

Decals are thin alpha-blended quads pasted on top of terrain / road
geometry — racing-line wear, lane stripes, oil stains, sponsor posters,
neon-reflection puddles, etc. Authored as ``decal_NN`` meshes in
Blender; the runtime walks all ``kind=decal`` meshes on load
(``src/engine/render/decal-system.ts``) and applies the decal material
profile (alpha-blend, depth-test on / write off, slight polygon offset,
no shadow cast/receive).

The shared atlas lives at ``public/assets/decals/atlas.png`` — a 4×4
grid of 256×256 cells. Rebuild it with::

    python tools/blender/build_decal_atlas.py

The same script's ``CELL_LEGEND`` is the authoritative list of cell
indices ↔ pattern names; the cell-picker enum below mirrors it so the
Blender N-panel and the build script stay in sync.

Authoring loop:

  1. Place the 3D cursor where you want the decal centred.
  2. Click **Add Decal** in the Hoverbike panel's *Decals* sub-section.
     A 1 m × 1 m quad named ``decal_NN`` appears at the cursor, lying
     flat on the XY plane.
  3. With the new decal selected, tweak ``atlas_cell`` in the
     N-panel → Object → Custom Properties (or use the enum picker on
     the Decals sub-panel).
  4. Reposition / scale / rotate normally. The quad's Z normal is the
     "up" direction; orient it so it faces away from the surface
     beneath.
  5. Re-export the track — the GLB carries the mesh; the runtime
     picks it up via the ``kind=decal`` tag and the shared atlas.

The UVs are unwrapped at creation time onto the chosen ``atlas_cell``,
and re-unwrapped whenever you change the cell via the panel enum.
"""

from __future__ import annotations

import re

import bmesh
import bpy
from bpy.props import IntProperty
from bpy.types import Operator


DECAL_NAME_PREFIX = "decal_"
DECAL_NAME_RE = re.compile(r"^decal_(\d+)$")
DECAL_KIND = "decal"

# Mirror of tools/blender/build_decal_atlas.py::CELL_LEGEND. Adding a
# cell to the atlas must also add it here so the picker stays useful.
ATLAS_CELL_NAMES: tuple[str, ...] = (
    "0 road-wear streak",
    "1 lane stripe",
    "2 fade line",
    "3 oil stain",
    "4 water splash",
    "5 graffiti tag",
    "6 sponsor poster",
    "7 crack web",
    "8 moss patch",
    "9 neon-reflection puddle",
    "10 tire skid",
    "11 paint smear",
    "12 corner-exit smear",
    "13 leaked fluid pool",
    "14 burn mark",
    "15 chalk arrow",
)

ATLAS_GRID = 4   # 4 × 4 cells
ATLAS_CELLS = ATLAS_GRID * ATLAS_GRID

DEFAULT_ATLAS_CELL = 0
DECAL_MAT_NAME = "mat_decal_atlas"


def _next_decal_index() -> int:
    used: set[int] = set()
    for obj in bpy.data.objects:
        m = DECAL_NAME_RE.match(obj.name)
        if m is not None:
            used.add(int(m.group(1)))
    n = 0
    while n in used:
        n += 1
    return n


def _ensure_decal_material() -> bpy.types.Material:
    """Lazily create the shared ``mat_decal_atlas`` material. All decals
    point at this single material so the runtime's atlas swap touches one
    Three.js material instance, not N."""
    mat = bpy.data.materials.get(DECAL_MAT_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name=DECAL_MAT_NAME)
    mat.use_nodes = True
    mat.blend_method = "BLEND"
    # White base — the runtime tints per-decal via the diffuse color (or
    # leaves white to use the atlas as-authored).
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = 0.6
    return mat


def _build_decal_mesh(name: str, atlas_cell: int) -> bpy.types.Mesh:
    """1 × 1 m flat XY quad with UVs spanning the chosen atlas cell.
    Author rescales / rotates as needed afterwards."""
    bm = bmesh.new()
    v0 = bm.verts.new((-0.5, -0.5, 0.0))
    v1 = bm.verts.new(( 0.5, -0.5, 0.0))
    v2 = bm.verts.new(( 0.5,  0.5, 0.0))
    v3 = bm.verts.new((-0.5,  0.5, 0.0))
    face = bm.faces.new([v0, v1, v2, v3])
    # UV layer + per-loop UVs pointing at the chosen atlas cell.
    uv_layer = bm.loops.layers.uv.verify()
    _assign_uvs_to_cell(face, uv_layer, atlas_cell)

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me


def _cell_uv_bounds(atlas_cell: int) -> tuple[float, float, float, float]:
    """Return (u0, v0, u1, v1) for the given atlas cell. Blender V axis
    increases upward, image V axis increases downward — we follow the
    Blender convention; the runtime atlas was painted so cells are
    indexed in row-major order from top-left, so we map cell_y to
    V = 1 - (row + 0..1) / grid."""
    cell = max(0, min(ATLAS_CELLS - 1, int(atlas_cell)))
    col = cell % ATLAS_GRID
    row = cell // ATLAS_GRID
    u0 = col / ATLAS_GRID
    u1 = (col + 1) / ATLAS_GRID
    v0 = 1.0 - (row + 1) / ATLAS_GRID
    v1 = 1.0 - row / ATLAS_GRID
    return (u0, v0, u1, v1)


def _assign_uvs_to_cell(face: bmesh.types.BMFace, uv_layer, atlas_cell: int) -> None:
    """Stamp the four loops of `face` with the UVs spanning `atlas_cell`.
    Vertex order matches `_build_decal_mesh`'s quad: bottom-left,
    bottom-right, top-right, top-left."""
    u0, v0, u1, v1 = _cell_uv_bounds(atlas_cell)
    uvs = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    for loop, uv in zip(face.loops, uvs):
        loop[uv_layer].uv = uv


def _reassign_decal_uvs(obj: bpy.types.Object, atlas_cell: int) -> bool:
    """Walk the decal's first face and stamp it with the cell UVs. Used
    by the cell-picker enum so changing the cell on an existing decal
    just rewrites the UVs in-place (no mesh rebuild). Returns True when
    something changed, False if the mesh wasn't compatible."""
    if obj is None or obj.type != "MESH" or obj.data is None:
        return False
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    if not bm.faces:
        bm.free()
        return False
    bm.faces.ensure_lookup_table()
    uv_layer = bm.loops.layers.uv.verify()
    _assign_uvs_to_cell(bm.faces[0], uv_layer, atlas_cell)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return True


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_add_decal(Operator):
    """Drop a decal quad at the 3D cursor.

    The new mesh is named ``decal_NN`` (next free NN), tagged
    ``kind=decal``, given an ``atlas_cell`` extra, and pointed at the
    shared ``mat_decal_atlas`` material. The mesh is a 1 × 1 m flat
    XY quad; rotate / scale / move it onto the surface you want it
    pasted onto. The runtime applies the alpha-blend + polygon-offset
    profile on load.
    """

    bl_idname = "hoverbike.add_decal"
    bl_label = "Add Decal"
    bl_description = (
        "Drop a 1×1 m decal quad at the 3D cursor. Tweak atlas_cell in the "
        "Decals sub-panel or as a custom property; reposition / scale / "
        "rotate onto the target surface. Runtime applies alpha-blend + "
        "polygon-offset on load."
    )
    bl_options = {"REGISTER", "UNDO"}

    atlas_cell: IntProperty(  # type: ignore[valid-type]
        name="Atlas cell",
        description="Index into the decal atlas (0..15). See Decals sub-panel for legend.",
        default=DEFAULT_ATLAS_CELL,
        min=0,
        max=ATLAS_CELLS - 1,
    )

    def execute(self, context):
        n = _next_decal_index()
        name = f"{DECAL_NAME_PREFIX}{n:02d}"
        me = _build_decal_mesh(f"{name}_mesh", self.atlas_cell)
        # Attach the shared material once at creation; the runtime
        # swaps in the atlas texture at GLB-load time.
        mat = _ensure_decal_material()
        if not me.materials:
            me.materials.append(mat)
        obj = bpy.data.objects.new(name, me)
        obj["kind"] = DECAL_KIND
        obj["atlas_cell"] = int(self.atlas_cell)
        obj.location = context.scene.cursor.location.copy()
        context.scene.collection.objects.link(obj)

        for o in bpy.data.objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj

        self.report(
            {"INFO"},
            f"Added {name} — atlas cell {self.atlas_cell} ({ATLAS_CELL_NAMES[self.atlas_cell]})",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_decal_set_cell(Operator):
    """Re-UV-unwrap the active decal onto a new atlas cell. Pure mesh
    edit — no rebuild — so authored scale / rotation / position survive."""

    bl_idname = "hoverbike.decal_set_cell"
    bl_label = "Set Decal Cell"
    bl_description = "Re-UV-unwrap the active decal onto the chosen atlas cell."
    bl_options = {"REGISTER", "UNDO"}

    atlas_cell: IntProperty(  # type: ignore[valid-type]
        name="Atlas cell",
        default=DEFAULT_ATLAS_CELL,
        min=0,
        max=ATLAS_CELLS - 1,
    )

    @classmethod
    def poll(cls, context):
        obj = context.active_object
        return (
            obj is not None
            and obj.type == "MESH"
            and DECAL_NAME_RE.match(obj.name) is not None
        )

    def execute(self, context):
        obj = context.active_object
        if not _reassign_decal_uvs(obj, self.atlas_cell):
            self.report({"WARNING"}, f"{obj.name}: could not re-UV (no faces?)")
            return {"CANCELLED"}
        obj["atlas_cell"] = int(self.atlas_cell)
        self.report({"INFO"}, f"{obj.name} → cell {self.atlas_cell} ({ATLAS_CELL_NAMES[self.atlas_cell]})")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Panel
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_PT_track_decals(bpy.types.Panel):
    """Sub-panel: decal authoring. Count of decals in the scene + Add
    button + cell-index quick reference + a re-cell picker for the
    active decal. Lives next to the Emitters sub-panel since both shape
    surface dressing."""

    bl_label = "Decals"
    bl_idname = "HOVERBIKE_PT_track_decals"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Hoverbike"
    bl_parent_id = "HOVERBIKE_PT_panel"
    bl_options = {"DEFAULT_CLOSED"}

    @classmethod
    def poll(cls, context):
        from ._legacy import detect_mode
        return detect_mode(bpy.data.filepath) == "track"

    def draw(self, context):
        layout = self.layout
        n_decals = sum(
            1 for obj in bpy.data.objects if DECAL_NAME_RE.match(obj.name) is not None
        )
        if n_decals > 0:
            layout.label(text=f"{n_decals} decal(s) in scene", icon="TEXTURE")
        else:
            layout.label(text="No decals yet — drop one with +", icon="TEXTURE")
        layout.operator("hoverbike.add_decal", icon="ADD")
        layout.separator()

        # Active-decal cell picker
        obj = context.active_object
        is_decal = (
            obj is not None
            and obj.type == "MESH"
            and DECAL_NAME_RE.match(obj.name) is not None
        )
        if is_decal:
            current = int(obj.get("atlas_cell", DEFAULT_ATLAS_CELL))
            layout.label(text=f"Active: {obj.name} (cell {current})", icon="OUTLINER_OB_MESH")
            # Two-column grid of cell buttons.
            grid = layout.grid_flow(row_major=True, columns=2, even_columns=True, even_rows=False, align=True)
            for ci, label in enumerate(ATLAS_CELL_NAMES):
                op = grid.operator(
                    "hoverbike.decal_set_cell",
                    text=label,
                    depress=(ci == current),
                )
                op.atlas_cell = ci
        else:
            layout.label(text="Select a decal_* mesh to re-cell", icon="INFO")
        layout.separator()
        layout.label(text="Atlas: public/assets/decals/atlas.png", icon="INFO")
        layout.label(text="Rebuild: python build_decal_atlas.py", icon="INFO")


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_add_decal,
    HOVERBIKE_OT_decal_set_cell,
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
