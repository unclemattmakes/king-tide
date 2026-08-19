"""Geometry-Nodes-driven wedge ramp tool.

Each ramp is an empty + child mesh:

  * ``ramp_NN``        — parent empty. G/R/S in the viewport positions /
                         aims / scales the whole ramp. The empty's Z-axis
                         rotation aims the ramp's launch direction.
                         ``kind="ramp"`` so Blender-side tooling reads it
                         as one logical thing.
  * ``ramp_NN_mesh``   — child mesh with the ``HV_Ramp`` Geometry-Nodes
                         modifier. Three inputs (Length, Width, Height)
                         drive a clean linear wedge — sharp leading
                         edge at z=0, vertical back wall of height =
                         Height. Mesh updates live as the sliders /
                         empty transform change. ``kind="track"`` so the
                         runtime trimesh-collider attaches at GLB-load
                         time.

``_create_gn_ramp`` is also called from ``spline.auto_place_ramps`` —
it's exported (no leading underscore on the GN-group helpers below
would conflict with the rest of the addon's naming convention; we
keep the leading underscore since this is an internal API used by one
sibling module).
"""

from __future__ import annotations

import bpy
from bpy.props import FloatProperty
from bpy.types import Operator


HV_RAMP_GROUP_NAME = "HV_Ramp"
RAMP_OBJECT_PREFIX = "ramp_"
RAMP_MATERIAL_NAME = "mat_track_ramp"


# ────────────────────────────────────────────────────────────────────
# Material + naming
# ────────────────────────────────────────────────────────────────────


def _ramp_material() -> bpy.types.Material:
    mat = bpy.data.materials.get(RAMP_MATERIAL_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(RAMP_MATERIAL_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        # Saturated orange — same family as turn-indicator chevrons so
        # the eye reads it as a "track feature" by colour family.
        bsdf.inputs["Base Color"].default_value = (0.92, 0.45, 0.08, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.5
    return mat


def _next_ramp_object_name() -> str:
    """First free ``ramp_NN`` name. Avoids stomping prior ramps the
    user has placed and tuned, while keeping the numbering tidy."""
    i = 0
    while True:
        candidate = f"{RAMP_OBJECT_PREFIX}{i:02d}"
        if candidate not in bpy.data.objects:
            return candidate
        i += 1


# ────────────────────────────────────────────────────────────────────
# Geometry-Nodes group
# ────────────────────────────────────────────────────────────────────


def _ensure_hv_ramp_group() -> bpy.types.NodeTree:
    """Construct the ``HV_Ramp`` Geometry-Nodes group from scratch and
    return the NodeTree. Idempotent — drops the prior group first so
    we always rebuild from the current code.

    Topology: build a Mesh Cube sized (Width, Length, Height), shift
    it so the bottom face sits at z=0, then per-vertex move TOP verts
    to z = Height × ((y + L/2) / L). This collapses the front-top
    edge to the front-bottom edge (z=0 at the leading edge) and
    leaves the back-top edge at z=Height. Result: a clean linear
    wedge with no foundation slab, no profile curve, no taper math.

    The graph was iterated live in Blender via MCP and verified
    numerically before being baked here."""
    if HV_RAMP_GROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[HV_RAMP_GROUP_NAME])
    g = bpy.data.node_groups.new(HV_RAMP_GROUP_NAME, "GeometryNodeTree")
    # Required so the group is selectable in the GN modifier dropdown.
    # See seed_template_island.py for the full rationale.
    g.is_modifier = True

    def add_socket(name, in_out, stype, default=None, mn=None, mx=None):
        s = g.interface.new_socket(name, in_out=in_out, socket_type=stype)
        if default is not None:
            s.default_value = default
        if mn is not None:
            s.min_value = mn
        if mx is not None:
            s.max_value = mx
        return s

    add_socket("Geometry", "INPUT",  "NodeSocketGeometry")
    add_socket("Length",   "INPUT",  "NodeSocketFloat", 12.0, 0.1, 500.0)
    add_socket("Width",    "INPUT",  "NodeSocketFloat",  8.0, 0.1, 200.0)
    add_socket("Height",   "INPUT",  "NodeSocketFloat",  3.0, 0.0, 200.0)
    add_socket("Geometry", "OUTPUT", "NodeSocketGeometry")

    def add(kind, x, y, **kw):
        n = g.nodes.new(kind)
        n.location = (x, y)
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

    # top_z = Height × factor — linear ramp from 0 (entry) to Height
    # (back).
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
    sockets. GN modifier inputs are addressed by ``mod[identifier]``,
    not by display name; identifiers are auto-generated like
    ``Socket_2`` and survive across reloads but read poorly. This
    helper hides the identifier dance from the rest of the code."""
    out: dict[str, str] = {}
    for s in node_tree.interface.items_tree:
        if s.in_out == "INPUT":
            out[s.name] = s.identifier
    return out


# ────────────────────────────────────────────────────────────────────
# Spawn helper + operator
# ────────────────────────────────────────────────────────────────────


def create_gn_ramp(
    scene,
    *,
    location: tuple[float, float, float],
    rotation_z: float,
    length: float,
    width: float,
    height: float,
) -> tuple[bpy.types.Object, bpy.types.Object]:
    """Spawn a GN-driven ramp pair (empty + mesh) at ``location``,
    with the empty's Z-axis rotated by ``rotation_z`` so G/R/S on the
    empty positions/aims the ramp.

    Returns (empty, mesh_obj) so callers can wire them up further
    (e.g. select the empty for the user). Public because
    ``spline.auto_place_ramps`` calls it directly."""
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


class KINGTIDE_OT_add_ramp(Operator):
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

    bl_idname = "kingtide.add_ramp"
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
        empty, _mesh_obj = create_gn_ramp(
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


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (KINGTIDE_OT_add_ramp,)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

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
        description=(
            "Height of the back edge — the linear wedge rises from 0 at the leading edge to this value at the back."
        ),
        default=3.0, min=0.1, max=50.0, precision=2,
    )


def unregister() -> None:
    for prop in ("hoverbike_ramp_length", "hoverbike_ramp_width", "hoverbike_ramp_height"):
        try:
            delattr(bpy.types.Scene, prop)
        except AttributeError:
            pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
