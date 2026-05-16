"""Seed ``tracks-src/template-tunnels.blend`` — non-destructive tunnel rig.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_template_tunnels.py

This is a **one-shot scaffolder** like its siblings (``seed_template_island.py``
et al). It opens the volcanic-island template and layers a tunnel
authoring rig on top, then writes the result to ``tracks-src/template-tunnels.blend``.
Re-running re-opens template-island from disk so any drift in the
island template is picked up automatically — but the seed is destructive
to ``template-tunnels.blend``: anything you authored interactively in
that .blend (extra tunnels, profile tweaks) will be lost on re-seed.

After the seed, the .blend is the source of truth — iterate from inside
Blender.

### What the seed adds on top of template-island

Two collections + two singleton mesh objects + a shared GN group:

| Object                 | Role                                                     |
|------------------------|----------------------------------------------------------|
| ``Tunnel Curves`` coll | Bezier curves the user edits. One curve = one tunnel.    |
| ``tunnel_profile_in``  | 2-D closed bezier — interior cross-section.              |
| ``tunnel_profile_out`` | 2-D closed bezier — boolean-cutter cross-section.        |
| ``tunnels_interior``   | Single mesh. ``HV_TunnelSweep`` GN reads every curve in  |
|                        | the Tunnel Curves collection and sweeps the *inner*      |
|                        | profile along each → tunnel walls. ``kind=track``.       |
| ``tunnels_cutter``     | Same idea but sweeps the *outer* profile with Fill Caps  |
|                        | → manifold solid. Hidden from render + export.           |
| ``tunnel_00_curve``    | Starter curve threading through peak 00 so the rig has   |
|                        | something to show on first open.                         |

Terrain modifier stack (top → bottom):

  1. ``HV_Island``     — existing GN heightfield (untouched).
  2. ``HV_TunnelCut``  — Boolean Difference vs ``tunnels_cutter``,
                         solver=EXACT. Cuts a ring at each mouth where
                         the cutter pierces the heightfield. We don't
                         carve a 3-D volume through the rock — the
                         heightfield is a sheet, the visible tunnel
                         interior is the ``tunnels_interior`` swept
                         tube that lives behind/inside the mouth.

Why no Solidify: an earlier pass added a 200 m Solidify pre-pass to
turn the sheet into a crust so the boolean could carve a volume. That
worked geometrically but the downward-extruded shell kept poking up
through other cliffs at oblique camera angles and made the whole
terrain look fractured. The bike never goes below the heightfield, so
the carved-volume was decorative anyway — what matters is the mouth
rim cut, and a plain Boolean Difference against a closed cutter tube
delivers that cleanly.

### Adding a tunnel

1. Select ``tunnel_00_curve`` (or any curve under ``Tunnel Curves``).
2. ``Shift-D`` to duplicate. The duplicate is auto-linked into the
   ``Tunnel Curves`` collection (it inherits its parent collection).
3. Reshape — translate / rotate / scale handles, Tab into edit mode for
   per-point work. The sweep + boolean update live.

To remove a tunnel: delete its curve. Both the interior mesh and the
terrain boolean drop the contribution on next evaluation.

### Editing the cross-section

Tab into ``tunnel_profile_in`` and re-shape its closed bezier (default
is a circle of radius 4 m, flattened on the bottom to make a tunnel
floor). The cutter profile ``tunnel_profile_out`` is the same shape
inflated by ``CUTTER_INFLATE`` metres — keep its silhouette larger than
the inner profile so the boolean cut clears the visible walls.

The profile's +Y direction maps to **world -Z** (downward) when swept,
not the other way around. So the bottom-of-tunnel control point lives
at *positive* Y in the profile's edit-mode view, and dragging it
"further down" in the user's sense means dragging it in +Y.

### Performance note

Boolean Exact on a 384² heightfield (~150 k verts) is not interactive.
While reshaping curves, **disable the eye** on the ``HV_TunnelCut``
modifier (Properties → Modifier → eye toggle on ``HV_TunnelCut``). The
interior sweep is cheap and previews live; toggle the cutter back on
when you want to see the cut mouths.
"""

from __future__ import annotations

import os
import sys

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

SOURCE_PATH = os.path.join(REPO_ROOT, "tracks-src", "template-island.blend")
OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "template-tunnels.blend")

# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

SWEEP_GROUP_NAME      = "HV_TunnelSweep"
TUNNELS_COLLECTION    = "Tunnels"
CURVES_COLLECTION     = "Tunnel Curves"
INNER_PROFILE_NAME    = "tunnel_profile_in"
OUTER_PROFILE_NAME    = "tunnel_profile_out"
INTERIOR_MESH_NAME    = "tunnels_interior"
CUTTER_MESH_NAME      = "tunnels_cutter"
BOOLEAN_MOD_NAME      = "HV_TunnelCut"
INTERIOR_MOD_NAME     = "HV_TunnelInterior"
CUTTER_MOD_NAME       = "HV_TunnelCutter"
INTERIOR_MAT_NAME     = "mat_tunnel_interior"

# Interior tunnel cross-section radius. The profile is a closed bezier
# circle of this radius with its bottom arc flattened to give the bike
# a horizontal floor (vs. a perfect-circle floor that would funnel the
# bike towards the centre).
INTERIOR_RADIUS_M     = 4.0
# Cutter inflate: outer profile sits this much further from the curve
# than the inner profile. Big enough that the boolean cut clears the
# visible wall, small enough that the gap between hole edge and wall
# isn't visible from outside.
CUTTER_INFLATE_M      = 0.4

# Starter curve: a 4-point bezier ducking through the central peak
# (peak_00, apex at ≈ (-20, 15, 140), base ≈ 240 m radius around the
# origin). Mouth points were tuned by sampling the actual heightfield
# (the noise stack thins the cone faster than the bare-cone math
# predicts — d=200 m gave only ≈10 m of surface elevation, so a
# cutter at z=5 (top z=9.4) sat fully buried and produced no mouth
# opening). The points below land both mouths well outside the cone
# base where the seafloor is near sea level, so the cutter (r=4.4)
# clearly pokes above the surface and the boolean carves a real
# mouth. Mid-tunnel z=90 leaves 30+ m of rock above the ceiling for
# a solid roof under peak_00's apex.
STARTER_CURVE_NAME    = "tunnel_00_curve"
STARTER_CURVE_POINTS: list[tuple[float, float, float]] = [
    (-230.0, -138.0,   8.0),  # mouth — outside cone base, cutter clears surface
    ( -50.0,  -25.0,  90.0),  # dives under peak_00 from the SW
    (  30.0,   40.0,  90.0),  # exits peak_00 toward the NE
    ( 205.0,  145.0,   8.0),  # mouth — outside cone base, cutter clears surface
]


# ────────────────────────────────────────────────────────────────────
# Scene helpers
# ────────────────────────────────────────────────────────────────────

def _find_terrain() -> bpy.types.Object | None:
    """Pick the biggest mesh tagged kind=track. Mirrors the addon's
    ``_largest_terrain_mesh`` heuristic so the rig latches onto the
    same target the rest of the pipeline considers "the terrain"."""
    best: bpy.types.Object | None = None
    best_verts = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        if obj.get("kind") != "track":
            continue
        n = len(obj.data.vertices)
        if n > best_verts:
            best_verts = n
            best = obj
    return best


def _ensure_collection(name: str, parent: bpy.types.Collection) -> bpy.types.Collection:
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
    if name not in parent.children:
        parent.children.link(coll)
    return coll


def _link_only_to(obj: bpy.types.Object, collection: bpy.types.Collection) -> None:
    """Move obj so its sole collection membership is `collection`. The
    Add Tunnel Curve workflow relies on Blender's "duplicate inherits
    parent collection" rule — for that to land Shift-D'd curves in
    ``Tunnel Curves`` automatically, the source curve must NOT also
    live in the scene root collection."""
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    collection.objects.link(obj)


# ────────────────────────────────────────────────────────────────────
# Profile curves (inner + outer 2-D bezier loops)
# ────────────────────────────────────────────────────────────────────

def _build_profile_curve(name: str, radius: float, *, flat_bottom: bool) -> bpy.types.Object:
    """Build a closed 2-D bezier loop with 4 control points. Optional
    flat-bottom mode squashes the bottom control point upward so the
    swept tunnel has a horizontal floor — bikes can ride flat instead
    of slipping down a curved bowl.

    Orientation note: Curve to Mesh sweeps the profile with its +Y axis
    pointing downward in world space (along the spine's natural frame,
    not world +Z). Empirically: dragging a profile point further in -Y
    raised the tube's ceiling, not its floor. So we author the profile
    with +Y = "floor / world down" and -Y = "ceiling / world up", which
    matches what a user dragging the bottom point downward in the Tab-
    edit view expects.

    The flattened-floor point lands at +Y = radius * 0.6 (world Z = -0.6
    * radius below the spine). Authors who want a perfect circle can
    Tab in and drag the floor point down to +Y = +radius."""
    curve_data = bpy.data.curves.new(name, type="CURVE")
    curve_data.dimensions = "2D"  # 2-D so Curve to Mesh treats it as a profile
    spline = curve_data.splines.new(type="BEZIER")
    spline.bezier_points.add(3)  # implicit first point + 3 = 4 total
    floor_y = radius * 0.6 if flat_bottom else radius
    coords = [
        ( radius,  0.0),       # right (3 o'clock)
        ( 0.0,    -radius),    # ceiling (-Y profile → world +Z)
        (-radius,  0.0),       # left (9 o'clock)
        ( 0.0,     floor_y),   # floor (+Y profile → world -Z) — flattened
    ]
    for bp, (x, y) in zip(spline.bezier_points, coords):
        bp.co = (x, y, 0.0)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    spline.use_cyclic_u = True
    curve_data.resolution_u = 16

    obj = bpy.data.objects.new(name, curve_data)
    obj["kind"] = "tunnel_profile"
    return obj


# ────────────────────────────────────────────────────────────────────
# Starter spine curve
# ────────────────────────────────────────────────────────────────────

def _build_starter_curve() -> bpy.types.Object:
    curve_data = bpy.data.curves.new(STARTER_CURVE_NAME, type="CURVE")
    curve_data.dimensions = "3D"
    spline = curve_data.splines.new(type="BEZIER")
    spline.bezier_points.add(len(STARTER_CURVE_POINTS) - 1)
    for bp, (x, y, z) in zip(spline.bezier_points, STARTER_CURVE_POINTS):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    spline.use_cyclic_u = False
    curve_data.resolution_u = 32  # enough samples to read as smooth at tunnel scale

    obj = bpy.data.objects.new(STARTER_CURVE_NAME, curve_data)
    obj["kind"] = "tunnel_curve"
    return obj


# ────────────────────────────────────────────────────────────────────
# HV_TunnelSweep — GN group that turns a collection of curves into a
# single swept mesh
# ────────────────────────────────────────────────────────────────────

def _build_sweep_group() -> bpy.types.NodeTree:
    """Geometry-Nodes group used by both the interior and the cutter.

    Inputs:
      - Curves    (Collection)  curves to sweep
      - Profile   (Object)      curve object whose first spline is the
                                 cross-section
      - Fill Caps (Bool)        close the swept ends — required for the
                                 cutter (Boolean needs a manifold operand);
                                 disabled for the interior so the player
                                 can ride through.
      - Material  (Material)    optional override

    Output:
      - Geometry  (mesh)

    Pipeline: Collection Info (Separate Children, transform OFF) → Realize
    Instances → Curve to Mesh (Profile from Object Info → Geometry) →
    Set Material. Realize Instances flattens the per-object curve
    instances back to a single curve datablock so Curve to Mesh can
    sweep along every spline in one pass.
    """
    if SWEEP_GROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[SWEEP_GROUP_NAME])
    g = bpy.data.node_groups.new(SWEEP_GROUP_NAME, "GeometryNodeTree")

    def add_socket(n, io, st, default=None):
        s = g.interface.new_socket(n, in_out=io, socket_type=st)
        if default is not None:
            s.default_value = default
        return s

    add_socket("Geometry",  "INPUT",  "NodeSocketGeometry")
    add_socket("Curves",    "INPUT",  "NodeSocketCollection")
    add_socket("Profile",   "INPUT",  "NodeSocketObject")
    add_socket("Fill Caps", "INPUT",  "NodeSocketBool", False)
    add_socket("Material",  "INPUT",  "NodeSocketMaterial")
    add_socket("Geometry",  "OUTPUT", "NodeSocketGeometry")

    def add(kind, x, y, **kw):
        n = g.nodes.new(kind)
        n.location = (x, y)
        for k, v in kw.items():
            setattr(n, k, v)
        return n

    gi = add("NodeGroupInput",  -1400,   0)
    go = add("NodeGroupOutput",  1200,   0)

    # Collection Info: walk every object in the collection. Transform
    # space ORIGINAL so each curve's world transform is honoured (the
    # user G/R/S's the curves directly in the viewport).
    n_coll = add("GeometryNodeCollectionInfo", -1100,  200,
                 transform_space="ORIGINAL")
    n_coll.inputs["Separate Children"].default_value = True
    n_coll.inputs["Reset Children"].default_value = False
    g.links.new(gi.outputs["Curves"], n_coll.inputs["Collection"])

    # Realize Instances: merge per-object curve instances back into a
    # single curve geometry so Curve to Mesh sees every spline. Without
    # this step Curve to Mesh would see Instances (not Curve) and emit
    # nothing.
    n_realize = add("GeometryNodeRealizeInstances", -800, 200)
    g.links.new(n_coll.outputs["Instances"], n_realize.inputs["Geometry"])

    # Profile object → Object Info → curve geometry. Transform ORIGINAL
    # so we get the profile's geometry in its own local space — the
    # profile object can be parked anywhere in the scene without
    # dragging the sweep around. (We park the profiles off-screen below
    # the seafloor; with RELATIVE the swept tube ends up at
    # curve_position + profile_world_position, which translated the
    # entire tunnel by ~470 m on the first attempt.)
    n_prof = add("GeometryNodeObjectInfo", -800, -200,
                 transform_space="ORIGINAL")
    g.links.new(gi.outputs["Profile"], n_prof.inputs["Object"])

    # Curve to Mesh: sweep profile along every spline of the realized
    # curve geometry. Fill Caps wired from the group input — interior
    # passes False (open tube) and cutter passes True (manifold solid).
    n_c2m = add("GeometryNodeCurveToMesh", -400, 0)
    g.links.new(n_realize.outputs["Geometry"], n_c2m.inputs["Curve"])
    g.links.new(n_prof.outputs["Geometry"],    n_c2m.inputs["Profile Curve"])
    g.links.new(gi.outputs["Fill Caps"],       n_c2m.inputs["Fill Caps"])

    # Set Material (optional — pass None to leave material slot empty).
    n_setmat = add("GeometryNodeSetMaterial", 0, 0)
    g.links.new(n_c2m.outputs["Mesh"],     n_setmat.inputs["Geometry"])
    g.links.new(gi.outputs["Material"],    n_setmat.inputs["Material"])

    g.links.new(n_setmat.outputs["Geometry"], go.inputs["Geometry"])
    return g


def _socket_id_map(node_tree: bpy.types.NodeTree) -> dict[str, str]:
    out: dict[str, str] = {}
    for s in node_tree.interface.items_tree:
        if getattr(s, "in_out", None) == "INPUT":
            out[s.name] = s.identifier
    return out


# ────────────────────────────────────────────────────────────────────
# Interior material
# ────────────────────────────────────────────────────────────────────

def _build_interior_material() -> bpy.types.Material:
    """Dark, slightly-blue rock so the inside of the tunnel reads as
    cool / shadowed against the warm island terrain. Keep it boring on
    purpose — the volumetric lighting + bike headlight do the heavy
    visual lifting at runtime."""
    mat = bpy.data.materials.get(INTERIOR_MAT_NAME)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(INTERIOR_MAT_NAME)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.18, 0.18, 0.22, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.85
    return mat


# ────────────────────────────────────────────────────────────────────
# Tunnel meshes (interior + cutter)
# ────────────────────────────────────────────────────────────────────

def _build_tunnel_meshes(
    *,
    sweep_group: bpy.types.NodeTree,
    curves_coll: bpy.types.Collection,
    tunnels_coll: bpy.types.Collection,
    inner_profile: bpy.types.Object,
    outer_profile: bpy.types.Object,
    interior_mat: bpy.types.Material,
) -> tuple[bpy.types.Object, bpy.types.Object]:
    ids = _socket_id_map(sweep_group)

    # Interior — visible, ships with the .glb as kind=track.
    interior_me = bpy.data.meshes.new(f"{INTERIOR_MESH_NAME}_data")
    interior = bpy.data.objects.new(INTERIOR_MESH_NAME, interior_me)
    interior["kind"] = "track"
    interior.data.materials.append(interior_mat)
    tunnels_coll.objects.link(interior)
    imod = interior.modifiers.new(INTERIOR_MOD_NAME, "NODES")
    imod.node_group = sweep_group
    imod[ids["Curves"]]    = curves_coll
    imod[ids["Profile"]]   = inner_profile
    imod[ids["Fill Caps"]] = False
    imod[ids["Material"]]  = interior_mat

    # Cutter — manifold solid used by the terrain's Boolean Difference.
    # Hidden from render and export; viewport visibility stays on so the
    # author can see the swept silhouette while wiring up new tunnels.
    cutter_me = bpy.data.meshes.new(f"{CUTTER_MESH_NAME}_data")
    cutter = bpy.data.objects.new(CUTTER_MESH_NAME, cutter_me)
    cutter["kind"] = "tunnel_cutter"  # NOT "track" — never exported
    cutter.hide_render = True
    cutter.display_type = "WIRE"      # show as wire so it doesn't fight the interior
    tunnels_coll.objects.link(cutter)
    cmod = cutter.modifiers.new(CUTTER_MOD_NAME, "NODES")
    cmod.node_group = sweep_group
    cmod[ids["Curves"]]    = curves_coll
    cmod[ids["Profile"]]   = outer_profile
    cmod[ids["Fill Caps"]] = True
    # Material left None — cutter is invisible at render time.

    return interior, cutter


# ────────────────────────────────────────────────────────────────────
# Terrain boolean
# ────────────────────────────────────────────────────────────────────

def _attach_terrain_boolean(terrain: bpy.types.Object, cutter: bpy.types.Object) -> None:
    """Stack a Boolean Difference modifier on the terrain under the
    existing HV_Island geometry-nodes modifier.

    The heightfield is a 2-D sheet, so this only cuts a ring at each
    mouth where the cutter pierces the surface. That's all the bike
    actually needs — the visible tunnel interior is ``tunnels_interior``,
    not a carved subterranean volume. An earlier pass tried to make the
    boolean carve a 3-D tube via a Solidify pre-pass; it worked
    geometrically but the 200-m downward crust kept popping up through
    other cliffs and made the terrain look fractured. Dropped.

    ``solver=EXACT`` so the rim cut is clean on the HV_Island-generated
    heightfield. We leave ``use_self`` OFF — on a 148k-vert terrain it
    asks the solver for ~58 GB and crashes the seed's auto-eval."""
    mod = terrain.modifiers.new(BOOLEAN_MOD_NAME, "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.object = cutter
    mod.solver = "EXACT"
    # By default the boolean modifier evaluates in the viewport — that's
    # great for inspecting the cut, miserable for editing the curves.
    # The seed leaves it ON so the .blend opens with a visible result;
    # the docstring + the panel hint tell the user to toggle it off
    # while reshaping.
    mod.show_viewport = True


# ────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────

def seed() -> None:
    print(f"[seed-template-tunnels] reading {SOURCE_PATH}")
    if not os.path.exists(SOURCE_PATH):
        raise FileNotFoundError(
            f"{SOURCE_PATH} is missing — run `python tools/blender/seed_template_island.py` first."
        )

    bpy.ops.wm.open_mainfile(filepath=SOURCE_PATH)

    scene = bpy.context.scene
    root = scene.collection
    tunnels_coll = _ensure_collection(TUNNELS_COLLECTION, root)
    curves_coll  = _ensure_collection(CURVES_COLLECTION,  tunnels_coll)

    inner_profile = _build_profile_curve(INNER_PROFILE_NAME, INTERIOR_RADIUS_M,                       flat_bottom=True)
    outer_profile = _build_profile_curve(OUTER_PROFILE_NAME, INTERIOR_RADIUS_M + CUTTER_INFLATE_M,   flat_bottom=True)
    tunnels_coll.objects.link(inner_profile)
    tunnels_coll.objects.link(outer_profile)
    # Stash the profiles off-screen below the seafloor so they don't
    # clutter the viewport. The cross-section is what matters — the
    # curve's world location is irrelevant to the sweep (Object Info is
    # in RELATIVE space).
    inner_profile.location = (-470.0, -470.0, -40.0)
    outer_profile.location = (-460.0, -470.0, -40.0)
    inner_profile.hide_render = True
    outer_profile.hide_render = True

    starter = _build_starter_curve()
    _link_only_to(starter, curves_coll)

    sweep_group   = _build_sweep_group()
    interior_mat  = _build_interior_material()
    interior, cutter = _build_tunnel_meshes(
        sweep_group=sweep_group,
        curves_coll=curves_coll,
        tunnels_coll=tunnels_coll,
        inner_profile=inner_profile,
        outer_profile=outer_profile,
        interior_mat=interior_mat,
    )

    terrain = _find_terrain()
    if terrain is None:
        raise RuntimeError("No kind=track mesh found in template-island.blend — terrain detection failed.")
    _attach_terrain_boolean(terrain, cutter)

    bpy.context.view_layer.update()

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    print(f"[seed-template-tunnels] wrote {OUTPUT_PATH}")
    print(f"[seed-template-tunnels] terrain: {terrain.name} ({len(terrain.data.vertices)} verts)")
    print(f"[seed-template-tunnels] starter curve: {starter.name}, "
          f"profiles: inner r={INTERIOR_RADIUS_M:.1f}m / outer r={INTERIOR_RADIUS_M + CUTTER_INFLATE_M:.1f}m")


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        print(f"[seed-template-tunnels] FAILED: {e}", file=sys.stderr)
        raise
