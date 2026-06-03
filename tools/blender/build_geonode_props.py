"""Reusable Geometry-Nodes prop toolkit for Hoverbike levels.

Builds a set of parametric, curve- or generator-driven Geometry Nodes
groups that level designers can drop onto an object in Blender and tune
with exposed knobs. Unlike the placeholder props in
``seed_props_library.py`` these are authoring *tools* meant to be reused
across many tracks:

    HV_SeaStack   - tall faceted rocky spire (generator)
    HV_Dock       - irregular planks + weathered pylons along a curve
    HV_Palm       - "drunken" curving palm with green + dead fronds
    HV_Ramp       - sheet-metal panels along a curve, pitch-controlled
    HV_SeaArch    - parametric sea arch (generator)

Each group is flagged ``is_modifier`` so it appears in the GN modifier
menu, carries a ``COLOR_0`` store so realised geometry satisfies the
runtime vertex-attribute contract (docs/vertex-attribute-spec.md), and
assigns a ``mat_<family>_<id>`` material.

Run headless or via the Blender MCP::

    import importlib.util, sys
    p = r"...tools/blender/build_geonode_props.py"
    spec = importlib.util.spec_from_file_location("bgp", p)
    mod = importlib.util.module_from_spec(spec); sys.modules["bgp"] = mod
    spec.loader.exec_module(mod)
    mod.build_all()
"""
from __future__ import annotations

import math
import bpy
from mathutils import Vector

TOOLKIT_COLLECTION = "GeoNode Toolkit"

# Material colours (linear-ish sRGB picks; runtime shaders restyle anyway).
ROCK_RGBA = (0.55, 0.43, 0.27, 1.0)  # warm golden/ochre sandstone, per Maw concept
WOOD_RGBA = (0.28, 0.20, 0.12, 1.0)
PYLON_RGBA = (0.20, 0.17, 0.14, 1.0)
PALM_TRUNK_RGBA = (0.30, 0.22, 0.13, 1.0)
PALM_FROND_RGBA = (0.18, 0.42, 0.14, 1.0)
PALM_DEAD_RGBA = (0.42, 0.30, 0.12, 1.0)
METAL_RGBA = (0.38, 0.39, 0.40, 1.0)


# --------------------------------------------------------------------------
# Low-level helpers
# --------------------------------------------------------------------------
def _purge_group(name: str) -> None:
    g = bpy.data.node_groups.get(name)
    if g is not None:
        bpy.data.node_groups.remove(g)


def _new_tree(name: str) -> bpy.types.GeometryNodeTree:
    _purge_group(name)
    g = bpy.data.node_groups.new(name, "GeometryNodeTree")
    try:
        g.is_modifier = True
    except Exception:
        pass
    return g


def _in(tree, name, socket_type, default=None, mn=None, mx=None, subtype=None):
    s = tree.interface.new_socket(name=name, in_out="INPUT", socket_type=socket_type)
    if subtype is not None:
        try:
            s.subtype = subtype
        except Exception:
            pass
    if mn is not None:
        try:
            s.min_value = mn
        except Exception:
            pass
    if mx is not None:
        try:
            s.max_value = mx
        except Exception:
            pass
    if default is not None and hasattr(s, "default_value"):
        s.default_value = default
    return s


def _out(tree, name, socket_type):
    return tree.interface.new_socket(name=name, in_out="OUTPUT", socket_type=socket_type)


def _n(tree, bl_idname, x=0.0, y=0.0, **props):
    node = tree.nodes.new(bl_idname)
    node.location = (x, y)
    for k, v in props.items():
        try:
            setattr(node, k, v)
        except Exception:
            pass
    return node


def _link(tree, a, b):
    tree.links.new(a, b)


def _mat(name: str, rgba, roughness=0.8, metallic=0.0):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = rgba
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    m.diffuse_color = rgba
    return m


def _store_color0(tree, geo_socket, rgba=(1.0, 1.0, 0.0, 0.0)):
    """Append a Store Named Attribute node writing COLOR_0 (FLOAT_COLOR,
    POINT) so realised geometry satisfies the runtime contract."""
    store = _n(tree, "GeometryNodeStoreNamedAttribute", x=0, y=-400)
    store.data_type = "FLOAT_COLOR"
    store.domain = "POINT"
    store.inputs["Name"].default_value = "COLOR_0"
    col = _n(tree, "FunctionNodeInputColor", x=-200, y=-520)
    try:
        col.value = rgba
    except Exception:
        try:
            col.color = rgba
        except Exception:
            pass
    _link(tree, geo_socket, store.inputs["Geometry"])
    _link(tree, col.outputs[0], store.inputs["Value"])
    return store


def _set_material(tree, geo_socket, mat):
    sm = _n(tree, "GeometryNodeSetMaterial", x=0, y=-650)
    sm.inputs["Material"].default_value = mat
    _link(tree, geo_socket, sm.inputs["Geometry"])
    return sm


def _radius_to_scale(g, ctm, x=0, y=0):
    """Blender 5.1's Curve to Mesh ignores the curve radius attribute and
    sizes the profile by the node's Scale input (default 1.0). Feed the
    curve radius (set upstream via Set Curve Radius) into Scale so the
    profile actually tracks the authored radius."""
    ir = _n(g, "GeometryNodeInputRadius", x=x, y=y)
    _link(g, ir.outputs["Radius"], ctm.inputs["Scale"])
    return ir


def _facet_term(g, pos_socket, facets_socket, scale, x0, y0, thresh=0.17, gain=5.5):
    """Voronoi 'distance-to-edge' facet groove: ~0 inside each cell, carved
    negative at cell boundaries — turns smooth rock into big angular planes
    with sharp fracture seams. Returns a float socket to add into a
    displacement sum (already centred near 0)."""
    vor = _n(g, "ShaderNodeTexVoronoi", x=x0, y=y0)
    vor.voronoi_dimensions = "3D"
    vor.feature = "DISTANCE_TO_EDGE"
    vor.inputs["Scale"].default_value = scale
    try:
        vor.inputs["Randomness"].default_value = 1.0
    except Exception:
        pass
    _link(g, pos_socket, vor.inputs["Vector"])
    mn = _n(g, "ShaderNodeMath", x=x0 + 160, y=y0, operation="MINIMUM"); mn.inputs[1].default_value = thresh
    _link(g, vor.outputs["Distance"], mn.inputs[0])
    grv = _n(g, "ShaderNodeMath", x=x0 + 320, y=y0, operation="SUBTRACT"); grv.inputs[1].default_value = thresh
    _link(g, mn.outputs["Value"], grv.inputs[0])
    g1 = _n(g, "ShaderNodeMath", x=x0 + 480, y=y0, operation="MULTIPLY"); g1.inputs[1].default_value = gain
    _link(g, grv.outputs["Value"], g1.inputs[0])
    g2 = _n(g, "ShaderNodeMath", x=x0 + 640, y=y0, operation="MULTIPLY")
    _link(g, g1.outputs["Value"], g2.inputs[0]); _link(g, facets_socket, g2.inputs[1])
    return g2.outputs["Value"]


def _single_vert_obj(name):
    """A host object (one vertex) for generator-style GN groups."""
    me = bpy.data.meshes.get(name)
    if me:
        bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new(name)
    me.from_pydata([(0.0, 0.0, 0.0)], [], [])
    me.update()
    ob = bpy.data.objects.get(name)
    if ob:
        bpy.data.objects.remove(ob)
    ob = bpy.data.objects.new(name, me)
    return ob


def _curve_obj(name, points):
    """A poly curve host for curve-driven GN groups."""
    cu = bpy.data.curves.get(name)
    if cu:
        bpy.data.curves.remove(cu)
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    sp = cu.splines.new("POLY")
    sp.points.add(len(points) - 1)
    for i, p in enumerate(points):
        sp.points[i].co = (p[0], p[1], p[2], 1.0)
    ob = bpy.data.objects.get(name)
    if ob:
        bpy.data.objects.remove(ob)
    ob = bpy.data.objects.new(name, cu)
    return ob


def _apply(ob, tree, inputs=None):
    """Add a Geometry Nodes modifier using *tree* and set exposed inputs
    by socket name."""
    mod = ob.modifiers.new(tree.name, "NODES")
    mod.node_group = tree
    if inputs:
        by_name = {}
        for item in tree.interface.items_tree:
            if getattr(item, "item_type", "") == "SOCKET" and item.in_out == "INPUT":
                by_name[item.name] = item.identifier
        for k, v in inputs.items():
            ident = by_name.get(k)
            if ident is not None:
                try:
                    mod[ident] = v
                except Exception:
                    pass
    return mod


def _toolkit_collection():
    c = bpy.data.collections.get(TOOLKIT_COLLECTION)
    if c is None:
        c = bpy.data.collections.new(TOOLKIT_COLLECTION)
        bpy.context.scene.collection.children.link(c)
    return c


def _place(ob, location, collection):
    ob.location = location
    for col in list(ob.users_collection):
        col.objects.unlink(ob)
    collection.objects.link(ob)
    return ob


# --------------------------------------------------------------------------
# Shared: boulder-cluster rockifier (used by the sea-stack + sea-arch tools)
# --------------------------------------------------------------------------
def _rock_cluster(g, base_geo, size_sock, spacing_sock, seed_sock, x0=900, y0=-1900):
    """Scatter carved HV_Rock boulders over *base_geo*, then boolean-UNION the
    boulders + base into ONE watertight, faceted rock mass (no interpenetrating
    instances). Returns the flat-shaded mesh socket.

    Reuses the HV_Rock group itself as the boulder source (built on demand if
    it isn't in the file yet) so the scattered chunks match the standalone rock
    tool. Cost: one HV_Rock carve + one exact UNION over every boulder, so keep
    Boulder Density modest on big stacks."""
    rock = bpy.data.node_groups.get("HV_Rock") or build_rock()

    # --- boulder source: one carved HV_Rock, sized to Boulder Size ---
    src = _n(g, "GeometryNodeGroup", x=x0, y=y0 - 240); src.node_tree = rock
    src_in = {s.name for s in src.inputs}
    if "Size" in src_in:
        _link(g, size_sock, src.inputs["Size"])
    # decorrelate the boulder-shape seed from the scatter seed
    bseed = _n(g, "ShaderNodeMath", x=x0 - 180, y=y0 - 360, operation="ADD"); bseed.inputs[1].default_value = 53.0
    _link(g, seed_sock, bseed.inputs[0])
    if "Seed" in src_in:
        _link(g, bseed.outputs["Value"], src.inputs["Seed"])
    # chunky, not gemmy: fewer/larger facets than the standalone defaults
    for nm, val in (("Flatten", 0.9), ("Cut Spacing", 1.9), ("Tilt", 0.5), ("Lumpiness", 0.5)):
        if nm in src_in:
            try:
                src.inputs[nm].default_value = val
            except Exception:
                pass

    # --- scatter on the base surface (Poisson, spacing = Size / Density) ---
    dist = _n(g, "GeometryNodeDistributePointsOnFaces", x=x0 + 220, y=y0 + 100, distribute_method="POISSON")
    _link(g, base_geo, dist.inputs["Mesh"])
    _link(g, spacing_sock, dist.inputs["Distance Min"])
    dist.inputs["Density Max"].default_value = 200.0
    _link(g, seed_sock, dist.inputs["Seed"])
    pidx = _n(g, "GeometryNodeInputIndex", x=x0 + 220, y=y0 - 120)

    # random full tumble + random uniform scale per boulder
    rrot = _n(g, "FunctionNodeRandomValue", x=x0 + 380, y=y0 - 80); rrot.data_type = "FLOAT_VECTOR"
    rrot.inputs[0].default_value = (0.0, 0.0, 0.0); rrot.inputs[1].default_value = (6.2832, 6.2832, 6.2832)
    _link(g, pidx.outputs["Index"], rrot.inputs["ID"]); _link(g, seed_sock, rrot.inputs["Seed"])
    sseed = _n(g, "ShaderNodeMath", x=x0 + 220, y=y0 - 300, operation="ADD"); sseed.inputs[1].default_value = 91.0
    _link(g, seed_sock, sseed.inputs[0])
    rscl = _n(g, "FunctionNodeRandomValue", x=x0 + 380, y=y0 - 260); rscl.data_type = "FLOAT"
    rscl.inputs[2].default_value = 0.6; rscl.inputs[3].default_value = 1.35
    _link(g, pidx.outputs["Index"], rscl.inputs["ID"]); _link(g, sseed.outputs["Value"], rscl.inputs["Seed"])

    iop = _n(g, "GeometryNodeInstanceOnPoints", x=x0 + 560, y=y0 + 100)
    _link(g, dist.outputs["Points"], iop.inputs["Points"])
    _link(g, src.outputs[0], iop.inputs["Instance"])
    _link(g, rrot.outputs[0], iop.inputs["Rotation"])
    _link(g, rscl.outputs[1], iop.inputs["Scale"])
    real = _n(g, "GeometryNodeRealizeInstances", x=x0 + 740, y=y0 + 100)
    _link(g, iop.outputs["Instances"], real.inputs["Geometry"])

    # --- UNION boulders + base -> one shell (self-intersection welds overlaps) ---
    join = _n(g, "GeometryNodeJoinGeometry", x=x0 + 900, y=y0 + 100)
    _link(g, real.outputs["Geometry"], join.inputs["Geometry"])
    _link(g, base_geo, join.inputs["Geometry"])
    boo = _n(g, "GeometryNodeMeshBoolean", x=x0 + 1060, y=y0 + 100); boo.operation = "UNION"
    try:
        boo.inputs["Self Intersection"].default_value = True
    except Exception:
        pass
    _link(g, join.outputs["Geometry"], boo.inputs["Mesh"])
    cflat = _n(g, "GeometryNodeSetShadeSmooth", x=x0 + 1220, y=y0 + 100); cflat.inputs["Shade Smooth"].default_value = False
    _link(g, boo.outputs["Mesh"], cflat.inputs["Geometry"])
    return cflat.outputs["Geometry"]


# --------------------------------------------------------------------------
# Tool 1: Sea Stack — tall faceted rocky spire
# --------------------------------------------------------------------------
def build_sea_stack() -> bpy.types.GeometryNodeTree:
    g = _new_tree("HV_SeaStack")
    _out(g, "Geometry", "NodeSocketGeometry")
    _in(g, "Geometry", "NodeSocketGeometry")  # ignored (generator)
    _in(g, "Height", "NodeSocketFloat", 18.0, mn=2.0, mx=140.0, subtype="DISTANCE")
    _in(g, "Base Radius", "NodeSocketFloat", 2.7, mn=0.2, mx=50.0, subtype="DISTANCE")
    _in(g, "Taper", "NodeSocketFloat", 1.05, mn=0.3, mx=5.0)
    _in(g, "Base Flare", "NodeSocketFloat", 0.4, mn=0.0, mx=2.5)
    _in(g, "Tip", "NodeSocketFloat", 0.12, mn=0.0, mx=0.6)
    _in(g, "Sides", "NodeSocketInt", 7, mn=3, mx=32)
    _in(g, "Lean", "NodeSocketFloat", 0.12, mn=-0.6, mx=0.6)
    _in(g, "Jaggedness", "NodeSocketFloat", 0.5, mn=0.0, mx=1.5)
    _in(g, "Flute Scale", "NodeSocketFloat", 1.4, mn=0.1, mx=6.0)
    _in(g, "Strata", "NodeSocketFloat", 0.17, mn=0.0, mx=1.0)
    _in(g, "Facets", "NodeSocketFloat", 0.7, mn=0.0, mx=1.5)
    _in(g, "Lumpiness", "NodeSocketFloat", 0.4, mn=0.0, mx=1.0)
    _in(g, "Boulder Cluster", "NodeSocketBool", True)
    _in(g, "Boulder Size", "NodeSocketFloat", 2.4, mn=0.3, mx=20.0, subtype="DISTANCE")
    _in(g, "Boulder Density", "NodeSocketFloat", 1.0, mn=0.2, mx=3.0)
    _in(g, "Seed", "NodeSocketFloat", 0.0)

    gin = _n(g, "NodeGroupInput", x=-1700, y=0)
    gout = _n(g, "NodeGroupOutput", x=2840, y=0)

    # --- Spine ---
    end_v = _n(g, "ShaderNodeCombineXYZ", x=-1540, y=-60)
    _link(g, gin.outputs["Height"], end_v.inputs["Z"])
    line = _n(g, "GeometryNodeCurvePrimitiveLine", x=-1380, y=80)
    _link(g, end_v.outputs["Vector"], line.inputs["End"])
    resample = _n(g, "GeometryNodeResampleCurve", x=-1220, y=80)
    resample.inputs["Count"].default_value = 44
    _link(g, line.outputs["Curve"], resample.inputs["Curve"])

    sparam = _n(g, "GeometryNodeSplineParameter", x=-1220, y=-260)

    # store spline factor as 'stack_t' so it survives curve->mesh
    t_store = _n(g, "GeometryNodeStoreNamedAttribute", x=-1060, y=80)
    t_store.data_type = "FLOAT"
    t_store.domain = "POINT"
    t_store.inputs["Name"].default_value = "stack_t"
    _link(g, resample.outputs["Curve"], t_store.inputs["Geometry"])
    _link(g, sparam.outputs["Factor"], t_store.inputs["Value"])

    # lean (X grows with factor) + gentle XY wander
    lean_amt = _n(g, "ShaderNodeMath", x=-1220, y=-420, operation="MULTIPLY")
    _link(g, gin.outputs["Lean"], lean_amt.inputs[0]); _link(g, gin.outputs["Height"], lean_amt.inputs[1])
    lean_x = _n(g, "ShaderNodeMath", x=-1060, y=-380, operation="MULTIPLY")
    _link(g, sparam.outputs["Factor"], lean_x.inputs[0]); _link(g, lean_amt.outputs["Value"], lean_x.inputs[1])
    wnoise = _n(g, "ShaderNodeTexNoise", x=-1060, y=-600); wnoise.noise_dimensions = "4D"
    wnoise.inputs["Scale"].default_value = 1.1
    pos0 = _n(g, "GeometryNodeInputPosition", x=-1380, y=-720)
    _link(g, pos0.outputs["Position"], wnoise.inputs["Vector"]); _link(g, gin.outputs["Seed"], wnoise.inputs["W"])
    wsep = _n(g, "ShaderNodeSeparateXYZ", x=-900, y=-600); _link(g, wnoise.outputs["Color"], wsep.inputs["Vector"])
    wx = _n(g, "ShaderNodeMath", x=-740, y=-540, operation="SUBTRACT"); wx.inputs[1].default_value = 0.5
    _link(g, wsep.outputs["X"], wx.inputs[0])
    wy = _n(g, "ShaderNodeMath", x=-740, y=-700, operation="SUBTRACT"); wy.inputs[1].default_value = 0.5
    _link(g, wsep.outputs["Y"], wy.inputs[0])
    wfac = _n(g, "ShaderNodeMath", x=-740, y=-860, operation="MULTIPLY")
    _link(g, sparam.outputs["Factor"], wfac.inputs[0]); _link(g, gin.outputs["Base Radius"], wfac.inputs[1])
    wxf = _n(g, "ShaderNodeMath", x=-560, y=-540, operation="MULTIPLY")
    _link(g, wx.outputs["Value"], wxf.inputs[0]); _link(g, wfac.outputs["Value"], wxf.inputs[1])
    wyf = _n(g, "ShaderNodeMath", x=-560, y=-700, operation="MULTIPLY")
    _link(g, wy.outputs["Value"], wyf.inputs[0]); _link(g, wfac.outputs["Value"], wyf.inputs[1])
    addx = _n(g, "ShaderNodeMath", x=-400, y=-440, operation="ADD")
    _link(g, lean_x.outputs["Value"], addx.inputs[0]); _link(g, wxf.outputs["Value"], addx.inputs[1])
    off = _n(g, "ShaderNodeCombineXYZ", x=-240, y=-440)
    _link(g, addx.outputs["Value"], off.inputs["X"]); _link(g, wyf.outputs["Value"], off.inputs["Y"])
    setpos_spine = _n(g, "GeometryNodeSetPosition", x=-80, y=80)
    _link(g, t_store.outputs["Geometry"], setpos_spine.inputs["Geometry"])
    _link(g, off.outputs["Vector"], setpos_spine.inputs["Offset"])

    # --- Radius profile: Base * ((1-t)^Taper + Flare * basebump) ---
    omt = _n(g, "ShaderNodeMath", x=-900, y=160, operation="SUBTRACT"); omt.inputs[0].default_value = 1.0
    _link(g, sparam.outputs["Factor"], omt.inputs[1])
    powt = _n(g, "ShaderNodeMath", x=-740, y=160, operation="POWER")
    _link(g, omt.outputs["Value"], powt.inputs[0]); _link(g, gin.outputs["Taper"], powt.inputs[1])
    flare_mask = _n(g, "ShaderNodeMapRange", x=-740, y=-40)  # t:0..0.22 -> 1..0
    flare_mask.inputs["From Min"].default_value = 0.0
    flare_mask.inputs["From Max"].default_value = 0.22
    flare_mask.inputs["To Min"].default_value = 1.0
    flare_mask.inputs["To Max"].default_value = 0.0
    _link(g, sparam.outputs["Factor"], flare_mask.inputs["Value"])
    flare_sq = _n(g, "ShaderNodeMath", x=-580, y=-40, operation="POWER"); flare_sq.inputs[1].default_value = 2.0
    _link(g, flare_mask.outputs["Result"], flare_sq.inputs[0])
    flare_term = _n(g, "ShaderNodeMath", x=-420, y=-40, operation="MULTIPLY")
    _link(g, flare_sq.outputs["Value"], flare_term.inputs[0]); _link(g, gin.outputs["Base Flare"], flare_term.inputs[1])
    rad_factor = _n(g, "ShaderNodeMath", x=-260, y=120, operation="ADD")
    _link(g, powt.outputs["Value"], rad_factor.inputs[0]); _link(g, flare_term.outputs["Value"], rad_factor.inputs[1])
    rad_tip = _n(g, "ShaderNodeMath", x=-180, y=120, operation="MAXIMUM")  # blunt the tip (no needle)
    _link(g, rad_factor.outputs["Value"], rad_tip.inputs[0]); _link(g, gin.outputs["Tip"], rad_tip.inputs[1])
    radmul = _n(g, "ShaderNodeMath", x=-100, y=200, operation="MULTIPLY")
    _link(g, rad_tip.outputs["Value"], radmul.inputs[0]); _link(g, gin.outputs["Base Radius"], radmul.inputs[1])
    radclamp = _n(g, "ShaderNodeMath", x=60, y=200, operation="MAXIMUM"); radclamp.inputs[1].default_value = 0.05
    _link(g, radmul.outputs["Value"], radclamp.inputs[0])
    # large-scale lumps along the height break the clean cone ("witch hat")
    lfac = _n(g, "ShaderNodeMath", x=-260, y=400, operation="MULTIPLY"); lfac.inputs[1].default_value = 3.5
    _link(g, sparam.outputs["Factor"], lfac.inputs[0])
    lvec = _n(g, "ShaderNodeCombineXYZ", x=-100, y=400); _link(g, lfac.outputs["Value"], lvec.inputs["X"])
    lnoise = _n(g, "ShaderNodeTexNoise", x=60, y=400); lnoise.noise_dimensions = "4D"; lnoise.inputs["Scale"].default_value = 1.0
    _link(g, lvec.outputs["Vector"], lnoise.inputs["Vector"]); _link(g, gin.outputs["Seed"], lnoise.inputs["W"])
    lc = _n(g, "ShaderNodeMath", x=220, y=420, operation="SUBTRACT"); lc.inputs[1].default_value = 0.5
    _link(g, lnoise.outputs["Fac"], lc.inputs[0])
    lcl = _n(g, "ShaderNodeMath", x=380, y=420, operation="MULTIPLY")
    _link(g, lc.outputs["Value"], lcl.inputs[0]); _link(g, gin.outputs["Lumpiness"], lcl.inputs[1])
    lump = _n(g, "ShaderNodeMath", x=540, y=420, operation="MULTIPLY_ADD"); lump.inputs[1].default_value = 1.7; lump.inputs[2].default_value = 1.0
    _link(g, lcl.outputs["Value"], lump.inputs[0])
    radlump = _n(g, "ShaderNodeMath", x=160, y=200, operation="MULTIPLY")
    _link(g, radclamp.outputs["Value"], radlump.inputs[0]); _link(g, lump.outputs["Value"], radlump.inputs[1])
    radlump2 = _n(g, "ShaderNodeMath", x=300, y=200, operation="MAXIMUM"); radlump2.inputs[1].default_value = 0.05
    _link(g, radlump.outputs["Value"], radlump2.inputs[0])
    setrad = _n(g, "GeometryNodeSetCurveRadius", x=460, y=80)
    _link(g, setpos_spine.outputs["Geometry"], setrad.inputs["Curve"])
    _link(g, radlump2.outputs["Value"], setrad.inputs["Radius"])

    circle = _n(g, "GeometryNodeCurvePrimitiveCircle", x=220, y=-160); circle.mode = "RADIUS"
    _link(g, gin.outputs["Sides"], circle.inputs["Resolution"])
    circle.inputs["Radius"].default_value = 1.0
    ctm = _n(g, "GeometryNodeCurveToMesh", x=400, y=40)
    _link(g, setrad.outputs["Curve"], ctm.inputs["Curve"])
    _link(g, circle.outputs["Curve"], ctm.inputs["Profile Curve"])
    ctm.inputs["Fill Caps"].default_value = True
    _radius_to_scale(g, ctm, x=240, y=-120)
    subdiv = _n(g, "GeometryNodeSubdivideMesh", x=560, y=40); subdiv.inputs["Level"].default_value = 2
    _link(g, ctm.outputs["Mesh"], subdiv.inputs["Mesh"])

    # --- Displacement (thickness-scaled, multi-octave + strata ledges) ---
    pos = _n(g, "GeometryNodeInputPosition", x=400, y=-340)
    nrm = _n(g, "GeometryNodeInputNormal", x=400, y=-440)
    t_attr = _n(g, "GeometryNodeInputNamedAttribute", x=400, y=-560); t_attr.data_type = "FLOAT"
    t_attr.inputs["Name"].default_value = "stack_t"
    # local radius = Base * (1-t)^Taper ; floor scale so the tip keeps grain
    m_omt = _n(g, "ShaderNodeMath", x=560, y=-560, operation="SUBTRACT"); m_omt.inputs[0].default_value = 1.0
    _link(g, t_attr.outputs["Attribute"], m_omt.inputs[1])
    m_powt = _n(g, "ShaderNodeMath", x=720, y=-560, operation="POWER")
    _link(g, m_omt.outputs["Value"], m_powt.inputs[0]); _link(g, gin.outputs["Taper"], m_powt.inputs[1])
    loc_rad = _n(g, "ShaderNodeMath", x=880, y=-560, operation="MULTIPLY")
    _link(g, m_powt.outputs["Value"], loc_rad.inputs[0]); _link(g, gin.outputs["Base Radius"], loc_rad.inputs[1])
    rad_floor = _n(g, "ShaderNodeMath", x=1040, y=-540, operation="MULTIPLY_ADD")  # 0.5*locrad + 0.12*base
    rad_floor.inputs[1].default_value = 0.5
    _link(g, loc_rad.outputs["Value"], rad_floor.inputs[0])
    base_floor = _n(g, "ShaderNodeMath", x=880, y=-700, operation="MULTIPLY"); base_floor.inputs[1].default_value = 0.12
    _link(g, gin.outputs["Base Radius"], base_floor.inputs[0])
    _link(g, base_floor.outputs["Value"], rad_floor.inputs[2])
    disp_scale = _n(g, "ShaderNodeMath", x=1200, y=-540, operation="MULTIPLY")
    _link(g, rad_floor.outputs["Value"], disp_scale.inputs[0]); _link(g, gin.outputs["Jaggedness"], disp_scale.inputs[1])

    # flute-biased coordinate (high XY freq, low Z freq)
    fxy = _n(g, "ShaderNodeMath", x=560, y=-760, operation="MULTIPLY"); fxy.inputs[1].default_value = 2.2
    _link(g, gin.outputs["Flute Scale"], fxy.inputs[0])
    fz = _n(g, "ShaderNodeMath", x=560, y=-900, operation="MULTIPLY"); fz.inputs[1].default_value = 0.45
    _link(g, gin.outputs["Flute Scale"], fz.inputs[0])
    fscale = _n(g, "ShaderNodeCombineXYZ", x=720, y=-820)
    _link(g, fxy.outputs["Value"], fscale.inputs["X"]); _link(g, fxy.outputs["Value"], fscale.inputs["Y"])
    _link(g, fz.outputs["Value"], fscale.inputs["Z"])
    sp = _n(g, "ShaderNodeVectorMath", x=880, y=-820, operation="MULTIPLY")
    _link(g, pos.outputs["Position"], sp.inputs[0]); _link(g, fscale.outputs["Vector"], sp.inputs[1])
    n1 = _n(g, "ShaderNodeTexNoise", x=1040, y=-820); n1.noise_dimensions = "4D"
    n1.inputs["Scale"].default_value = 1.0; n1.inputs["Detail"].default_value = 8.0; n1.inputs["Roughness"].default_value = 0.72
    _link(g, sp.outputs["Vector"], n1.inputs["Vector"]); _link(g, gin.outputs["Seed"], n1.inputs["W"])
    n2 = _n(g, "ShaderNodeTexNoise", x=1040, y=-1000); n2.noise_dimensions = "4D"
    n2.inputs["Scale"].default_value = 0.5; n2.inputs["Detail"].default_value = 3.0
    _link(g, pos.outputs["Position"], n2.inputs["Vector"]); _link(g, gin.outputs["Seed"], n2.inputs["W"])
    c1 = _n(g, "ShaderNodeMath", x=1200, y=-820, operation="MULTIPLY_ADD")  # (n1-0.5)*0.65
    _link(g, n1.outputs["Fac"], c1.inputs[0]); c1.inputs[1].default_value = 0.3; c1.inputs[2].default_value = -0.15
    c2 = _n(g, "ShaderNodeMath", x=1200, y=-1000, operation="MULTIPLY_ADD")  # (n2-0.5)*0.55
    _link(g, n2.outputs["Fac"], c2.inputs[0]); c2.inputs[1].default_value = 0.22; c2.inputs[2].default_value = -0.11
    dsum = _n(g, "ShaderNodeMath", x=1360, y=-900, operation="ADD")
    _link(g, c1.outputs["Value"], dsum.inputs[0]); _link(g, c2.outputs["Value"], dsum.inputs[1])

    # strata ledges: sawtooth bands along Z
    wave = _n(g, "ShaderNodeTexWave", x=1040, y=-1180)
    wave.wave_type = "BANDS"; wave.bands_direction = "Z"; wave.wave_profile = "SAW"
    wave.inputs["Scale"].default_value = 0.55
    _link(g, pos.outputs["Position"], wave.inputs["Vector"])
    wctr = _n(g, "ShaderNodeMath", x=1200, y=-1180, operation="MULTIPLY_ADD")  # (wave-0.5)*Strata
    _link(g, wave.outputs["Fac"], wctr.inputs[0])
    _link(g, gin.outputs["Strata"], wctr.inputs[1])
    whalf = _n(g, "ShaderNodeMath", x=1200, y=-1320, operation="MULTIPLY"); whalf.inputs[1].default_value = -0.5
    _link(g, gin.outputs["Strata"], whalf.inputs[0])
    _link(g, whalf.outputs["Value"], wctr.inputs[2])
    dtot = _n(g, "ShaderNodeMath", x=1520, y=-980, operation="ADD")
    _link(g, dsum.outputs["Value"], dtot.inputs[0]); _link(g, wctr.outputs["Value"], dtot.inputs[1])
    # angular voronoi facets: sharp crack grooves at the cell boundaries...
    facet = _facet_term(g, pos.outputs["Position"], gin.outputs["Facets"], scale=0.13, x0=820, y0=-1320, gain=3.6)
    dtot2 = _n(g, "ShaderNodeMath", x=1680, y=-980, operation="ADD")
    _link(g, dtot.outputs["Value"], dtot2.inputs[0]); _link(g, facet, dtot2.inputs[1])
    # ...plus a per-cell constant push so each cell offsets as a unit -> flat
    # stepped rock facets (the planar-decimated boulder read).
    vorc = _n(g, "ShaderNodeTexVoronoi", x=820, y=-1560); vorc.voronoi_dimensions = "3D"; vorc.feature = "F1"
    vorc.inputs["Scale"].default_value = 0.13
    _link(g, pos.outputs["Position"], vorc.inputs["Vector"])
    cellsep = _n(g, "ShaderNodeSeparateXYZ", x=980, y=-1560); _link(g, vorc.outputs["Color"], cellsep.inputs["Vector"])
    cellc = _n(g, "ShaderNodeMath", x=1140, y=-1560, operation="MULTIPLY_ADD"); cellc.inputs[1].default_value = 1.5; cellc.inputs[2].default_value = -0.75
    _link(g, cellsep.outputs["X"], cellc.inputs[0])
    cellw = _n(g, "ShaderNodeMath", x=1300, y=-1560, operation="MULTIPLY")
    _link(g, cellc.outputs["Value"], cellw.inputs[0]); _link(g, gin.outputs["Facets"], cellw.inputs[1])
    dtot3 = _n(g, "ShaderNodeMath", x=1840, y=-980, operation="ADD")
    _link(g, dtot2.outputs["Value"], dtot3.inputs[0]); _link(g, cellw.outputs["Value"], dtot3.inputs[1])

    dmag = _n(g, "ShaderNodeMath", x=1840, y=-620, operation="MULTIPLY")
    _link(g, dtot3.outputs["Value"], dmag.inputs[0]); _link(g, disp_scale.outputs["Value"], dmag.inputs[1])
    dvec = _n(g, "ShaderNodeVectorMath", x=1520, y=-440, operation="SCALE")
    _link(g, nrm.outputs["Normal"], dvec.inputs[0]); _link(g, dmag.outputs["Value"], dvec.inputs["Scale"])
    setpos2 = _n(g, "GeometryNodeSetPosition", x=900, y=40)
    _link(g, subdiv.outputs["Mesh"], setpos2.inputs["Geometry"])
    _link(g, dvec.outputs["Vector"], setpos2.inputs["Offset"])

    flat = _n(g, "GeometryNodeSetShadeSmooth", x=1100, y=40); flat.inputs["Shade Smooth"].default_value = False
    _link(g, setpos2.outputs["Geometry"], flat.inputs["Geometry"])

    # optional boulder-cluster pass: scatter HV_Rock chunks over the spire and
    # boolean-union them into one faceted rock mass (toggle, default on).
    bspace = _n(g, "ShaderNodeMath", x=700, y=-1900, operation="DIVIDE")  # spacing = Size / Density
    _link(g, gin.outputs["Boulder Size"], bspace.inputs[0]); _link(g, gin.outputs["Boulder Density"], bspace.inputs[1])
    cluster = _rock_cluster(g, flat.outputs["Geometry"], gin.outputs["Boulder Size"],
                            bspace.outputs["Value"], gin.outputs["Seed"], x0=900, y0=-1900)
    sw = _n(g, "GeometryNodeSwitch", x=2300, y=40); sw.input_type = "GEOMETRY"
    _link(g, gin.outputs["Boulder Cluster"], sw.inputs["Switch"])
    _link(g, flat.outputs["Geometry"], sw.inputs["False"]); _link(g, cluster, sw.inputs["True"])
    store = _store_color0(g, sw.outputs["Output"], rgba=(1.0, 1.0, 0.0, 0.0))
    store.location = (2480, 40)
    mat = _mat("mat_prop_sea_stack", ROCK_RGBA, roughness=0.9)
    sm = _set_material(g, store.outputs["Geometry"], mat)
    sm.location = (2660, 40)
    _link(g, sm.outputs["Geometry"], gout.inputs["Geometry"])
    return g


# --------------------------------------------------------------------------
# Tool 2: Dock — irregular planks + weathered pylons along a curve
# --------------------------------------------------------------------------
def build_dock() -> bpy.types.GeometryNodeTree:
    g = _new_tree("HV_Dock")
    _out(g, "Geometry", "NodeSocketGeometry")
    _in(g, "Geometry", "NodeSocketGeometry")  # the path curve
    _in(g, "Deck Width", "NodeSocketFloat", 3.2, mn=0.4, mx=20.0, subtype="DISTANCE")
    _in(g, "Plank Pitch", "NodeSocketFloat", 0.6, mn=0.1, mx=3.0, subtype="DISTANCE")
    _in(g, "Plank Gap", "NodeSocketFloat", 0.08, mn=0.0, mx=0.6, subtype="DISTANCE")
    _in(g, "Plank Thickness", "NodeSocketFloat", 0.13, mn=0.02, mx=0.6, subtype="DISTANCE")
    _in(g, "Plank Irregular", "NodeSocketFloat", 0.45, mn=0.0, mx=1.0)
    _in(g, "Pylon Spacing", "NodeSocketFloat", 3.2, mn=0.6, mx=12.0, subtype="DISTANCE")
    _in(g, "Pylon Radius", "NodeSocketFloat", 0.24, mn=0.04, mx=1.5, subtype="DISTANCE")
    _in(g, "Pylon Above", "NodeSocketFloat", 0.0, mn=0.0, mx=4.0, subtype="DISTANCE")
    _in(g, "Pylon Drop", "NodeSocketFloat", 4.5, mn=0.2, mx=30.0, subtype="DISTANCE")
    _in(g, "Pylon Lean", "NodeSocketFloat", 0.06, mn=0.0, mx=0.4)
    _in(g, "Weather", "NodeSocketFloat", 0.5, mn=0.0, mx=1.0)
    _in(g, "Seed", "NodeSocketFloat", 0.0)

    gin = _n(g, "NodeGroupInput", x=-1700, y=0)
    gout = _n(g, "NodeGroupOutput", x=1700, y=0)
    plank_mat = _mat("mat_prop_dock_plank", WOOD_RGBA, roughness=0.92)
    pylon_mat = _mat("mat_prop_dock_pylon", PYLON_RGBA, roughness=0.95)

    pos = _n(g, "GeometryNodeInputPosition", x=-1500, y=-700)

    # ============ PLANK DECK ============
    c2p = _n(g, "GeometryNodeCurveToPoints", x=-1400, y=240); c2p.mode = "LENGTH"
    _link(g, gin.outputs["Geometry"], c2p.inputs["Curve"])
    _link(g, gin.outputs["Plank Pitch"], c2p.inputs["Length"])

    # plank board: cube (X along path, Y across deck, Z up)
    plank_sub = _n(g, "ShaderNodeMath", x=-1400, y=20, operation="SUBTRACT")
    _link(g, gin.outputs["Plank Pitch"], plank_sub.inputs[0]); _link(g, gin.outputs["Plank Gap"], plank_sub.inputs[1])
    plank_len = _n(g, "ShaderNodeMath", x=-1240, y=20, operation="MAXIMUM"); plank_len.inputs[1].default_value = 0.05
    _link(g, plank_sub.outputs["Value"], plank_len.inputs[0])
    cube_size = _n(g, "ShaderNodeCombineXYZ", x=-1080, y=20)
    _link(g, plank_len.outputs["Value"], cube_size.inputs["X"])
    _link(g, gin.outputs["Deck Width"], cube_size.inputs["Y"])
    _link(g, gin.outputs["Plank Thickness"], cube_size.inputs["Z"])
    cube = _n(g, "GeometryNodeMeshCube", x=-900, y=20)
    _link(g, cube_size.outputs["Vector"], cube.inputs["Size"])

    # per-plank randomness via white noise on point position
    wn = _n(g, "ShaderNodeTexWhiteNoise", x=-1400, y=-460); wn.noise_dimensions = "4D"
    _link(g, pos.outputs["Position"], wn.inputs["Vector"]); _link(g, gin.outputs["Seed"], wn.inputs["W"])
    wn_col = _n(g, "ShaderNodeSeparateXYZ", x=-1240, y=-520); _link(g, wn.outputs["Color"], wn_col.inputs["Vector"])

    # align X to tangent (Z up) + small random yaw/tilt
    align = _n(g, "FunctionNodeAlignEulerToVector", x=-1080, y=-220); align.axis = "X"; align.pivot_axis = "Z"
    _link(g, c2p.outputs["Tangent"], align.inputs["Vector"])
    # random euler offset = (tilt, tilt, yaw) * Irregular
    rj = _n(g, "ShaderNodeVectorMath", x=-1240, y=-320, operation="MULTIPLY_ADD")  # color*2-1
    _link(g, wn.outputs["Color"], rj.inputs[0]); rj.inputs[1].default_value = (2.0, 2.0, 2.0); rj.inputs[2].default_value = (-1.0, -1.0, -1.0)
    rjs = _n(g, "ShaderNodeVectorMath", x=-1080, y=-380, operation="SCALE")
    _link(g, rj.outputs["Vector"], rjs.inputs[0])
    irreg_small = _n(g, "ShaderNodeMath", x=-1240, y=-440, operation="MULTIPLY"); irreg_small.inputs[1].default_value = 0.14
    _link(g, gin.outputs["Plank Irregular"], irreg_small.inputs[0])
    _link(g, irreg_small.outputs["Value"], rjs.inputs["Scale"])
    euler_add = _n(g, "ShaderNodeVectorMath", x=-900, y=-220, operation="ADD")
    _link(g, align.outputs["Rotation"], euler_add.inputs[0]); _link(g, rjs.outputs["Vector"], euler_add.inputs[1])

    # plank length jitter along path: X scale 1-0.4*Irregular*rand .. 1
    xj = _n(g, "ShaderNodeMath", x=-1080, y=-560, operation="MULTIPLY")
    _link(g, gin.outputs["Plank Irregular"], xj.inputs[0]); xj.inputs[1].default_value = 0.4
    xjr = _n(g, "ShaderNodeMath", x=-920, y=-560, operation="MULTIPLY")
    _link(g, xj.outputs["Value"], xjr.inputs[0]); _link(g, wn_col.outputs["X"], xjr.inputs[1])
    xscale = _n(g, "ShaderNodeMath", x=-760, y=-560, operation="SUBTRACT"); xscale.inputs[0].default_value = 1.0
    _link(g, xjr.outputs["Value"], xscale.inputs[1])
    scale_vec = _n(g, "ShaderNodeCombineXYZ", x=-600, y=-560)
    _link(g, xscale.outputs["Value"], scale_vec.inputs["X"]); scale_vec.inputs["Y"].default_value = 1.0; scale_vec.inputs["Z"].default_value = 1.0

    iop = _n(g, "GeometryNodeInstanceOnPoints", x=-600, y=120)
    _link(g, c2p.outputs["Points"], iop.inputs["Points"])
    _link(g, cube.outputs["Mesh"], iop.inputs["Instance"])
    _link(g, euler_add.outputs["Vector"], iop.inputs["Rotation"])
    _link(g, scale_vec.outputs["Vector"], iop.inputs["Scale"])

    # drop planks so top sits at z=0, plus small height jitter
    hj = _n(g, "ShaderNodeMath", x=-760, y=-680, operation="MULTIPLY_ADD")
    _link(g, wn_col.outputs["Z"], hj.inputs[0])
    hj2 = _n(g, "ShaderNodeMath", x=-920, y=-760, operation="MULTIPLY"); hj2.inputs[1].default_value = 0.05
    _link(g, gin.outputs["Plank Irregular"], hj2.inputs[0])
    _link(g, hj2.outputs["Value"], hj.inputs[1])
    half_th = _n(g, "ShaderNodeMath", x=-760, y=-840, operation="MULTIPLY"); half_th.inputs[1].default_value = -0.5
    _link(g, gin.outputs["Plank Thickness"], half_th.inputs[0])
    _link(g, half_th.outputs["Value"], hj.inputs[2])
    plank_off = _n(g, "ShaderNodeCombineXYZ", x=-600, y=-720)
    _link(g, hj.outputs["Value"], plank_off.inputs["Z"])
    tip = _n(g, "GeometryNodeTranslateInstances", x=-420, y=120)
    _link(g, iop.outputs["Instances"], tip.inputs["Instances"])
    _link(g, plank_off.outputs["Vector"], tip.inputs["Translation"])
    plank_setmat = _n(g, "GeometryNodeSetMaterial", x=-240, y=120)
    plank_setmat.inputs["Material"].default_value = plank_mat
    _link(g, tip.outputs["Instances"], plank_setmat.inputs["Geometry"])

    # ============ PYLONS ============
    c2pp = _n(g, "GeometryNodeCurveToPoints", x=-1400, y=560); c2pp.mode = "LENGTH"
    _link(g, gin.outputs["Geometry"], c2pp.inputs["Curve"])
    _link(g, gin.outputs["Pylon Spacing"], c2pp.inputs["Length"])
    # cross direction (horizontal perpendicular to tangent)
    zup = _n(g, "ShaderNodeCombineXYZ", x=-1400, y=760); zup.inputs["Z"].default_value = 1.0
    cross = _n(g, "ShaderNodeVectorMath", x=-1240, y=620, operation="CROSS_PRODUCT")
    _link(g, c2pp.outputs["Tangent"], cross.inputs[0]); _link(g, zup.outputs["Vector"], cross.inputs[1])
    crossn = _n(g, "ShaderNodeVectorMath", x=-1080, y=620, operation="NORMALIZE")
    _link(g, cross.outputs["Vector"], crossn.inputs[0])
    half_w = _n(g, "ShaderNodeMath", x=-1080, y=760, operation="MULTIPLY_ADD")
    _link(g, gin.outputs["Deck Width"], half_w.inputs[0]); half_w.inputs[1].default_value = 0.5; half_w.inputs[2].default_value = -0.12
    offL = _n(g, "ShaderNodeVectorMath", x=-920, y=620, operation="SCALE")
    _link(g, crossn.outputs["Vector"], offL.inputs[0]); _link(g, half_w.outputs["Value"], offL.inputs["Scale"])
    offR = _n(g, "ShaderNodeVectorMath", x=-920, y=500, operation="SCALE")
    _link(g, crossn.outputs["Vector"], offR.inputs[0])
    negw = _n(g, "ShaderNodeMath", x=-1080, y=480, operation="MULTIPLY"); negw.inputs[1].default_value = -1.0
    _link(g, half_w.outputs["Value"], negw.inputs[0]); _link(g, negw.outputs["Value"], offR.inputs["Scale"])
    ptsL = _n(g, "GeometryNodeSetPosition", x=-760, y=620)
    _link(g, c2pp.outputs["Points"], ptsL.inputs["Geometry"]); _link(g, offL.outputs["Vector"], ptsL.inputs["Offset"])
    ptsR = _n(g, "GeometryNodeSetPosition", x=-760, y=480)
    _link(g, c2pp.outputs["Points"], ptsR.inputs["Geometry"]); _link(g, offR.outputs["Vector"], ptsR.inputs["Offset"])
    ptsJ = _n(g, "GeometryNodeJoinGeometry", x=-600, y=560)
    _link(g, ptsL.outputs["Geometry"], ptsJ.inputs["Geometry"]); _link(g, ptsR.outputs["Geometry"], ptsJ.inputs["Geometry"])

    # pylon base mesh: tapered post (cone), wider at the base. Its top sits at
    # z = Pylon Above (measured from the plank TOP, so 0 = flush with the deck
    # surface and the whole post hangs UNDER the deck); Pylon Above is exactly
    # how far the post pokes above the plank top. Pylon Drop measures the length
    # hanging below the plank BOTTOM. So:
    #   top    z = Above            (0 -> flush with deck surface)
    #   bottom z = -(Thickness + Drop)
    total_h0 = _n(g, "ShaderNodeMath", x=-1500, y=980, operation="ADD")
    _link(g, gin.outputs["Pylon Above"], total_h0.inputs[0]); _link(g, gin.outputs["Pylon Drop"], total_h0.inputs[1])
    total_h = _n(g, "ShaderNodeMath", x=-1340, y=980, operation="ADD")
    _link(g, total_h0.outputs["Value"], total_h.inputs[0]); _link(g, gin.outputs["Plank Thickness"], total_h.inputs[1])
    rtop = _n(g, "ShaderNodeMath", x=-1400, y=1120, operation="MULTIPLY"); rtop.inputs[1].default_value = 0.82
    _link(g, gin.outputs["Pylon Radius"], rtop.inputs[0])
    rbot = _n(g, "ShaderNodeMath", x=-1400, y=1260, operation="MULTIPLY"); rbot.inputs[1].default_value = 1.12
    _link(g, gin.outputs["Pylon Radius"], rbot.inputs[0])
    cone = _n(g, "GeometryNodeMeshCone", x=-1240, y=1040)
    cone.inputs["Vertices"].default_value = 8
    cone.inputs["Side Segments"].default_value = 6
    _link(g, rtop.outputs["Value"], cone.inputs["Radius Top"])
    _link(g, rbot.outputs["Value"], cone.inputs["Radius Bottom"])
    _link(g, total_h.outputs["Value"], cone.inputs["Depth"])
    # The Mesh Cone node is base-at-origin (z: 0..Depth; wide Radius Bottom at
    # z=0, narrow Radius Top at the apex z=Depth). Translate the post DOWN by
    # (Thickness + Drop) so the apex lands at z = Above and the base at
    # z = -(Thickness + Drop):
    #   apex z = Depth - (Thickness+Drop) = (Above+Drop+Thickness) - (Thickness+Drop) = Above
    #   base z = 0     - (Thickness+Drop) = -(Thickness+Drop)
    shsum = _n(g, "ShaderNodeMath", x=-1180, y=1240, operation="ADD")
    _link(g, gin.outputs["Plank Thickness"], shsum.inputs[0]); _link(g, gin.outputs["Pylon Drop"], shsum.inputs[1])
    shift2 = _n(g, "ShaderNodeMath", x=-1020, y=1240, operation="MULTIPLY"); shift2.inputs[1].default_value = -1.0
    _link(g, shsum.outputs["Value"], shift2.inputs[0])
    shiftv = _n(g, "ShaderNodeCombineXYZ", x=-920, y=1240); _link(g, shift2.outputs["Value"], shiftv.inputs["Z"])
    conexf = _n(g, "GeometryNodeTransform", x=-920, y=1040)
    _link(g, cone.outputs["Mesh"], conexf.inputs["Geometry"]); _link(g, shiftv.outputs["Vector"], conexf.inputs["Translation"])
    # weather gnarl
    pos2 = _n(g, "GeometryNodeInputPosition", x=-920, y=900)
    nrm2 = _n(g, "GeometryNodeInputNormal", x=-920, y=820)
    pnoise = _n(g, "ShaderNodeTexNoise", x=-760, y=900); pnoise.inputs["Scale"].default_value = 2.6; pnoise.inputs["Detail"].default_value = 4.0
    _link(g, pos2.outputs["Position"], pnoise.inputs["Vector"])
    pctr = _n(g, "ShaderNodeMath", x=-600, y=900, operation="MULTIPLY_ADD")
    _link(g, pnoise.outputs["Fac"], pctr.inputs[0])
    pw = _n(g, "ShaderNodeMath", x=-760, y=1040, operation="MULTIPLY")
    _link(g, gin.outputs["Weather"], pw.inputs[0]); _link(g, gin.outputs["Pylon Radius"], pw.inputs[1])
    _link(g, pw.outputs["Value"], pctr.inputs[1])
    pwn = _n(g, "ShaderNodeMath", x=-760, y=1180, operation="MULTIPLY"); pwn.inputs[1].default_value = -0.5
    _link(g, pw.outputs["Value"], pwn.inputs[0]); _link(g, pwn.outputs["Value"], pctr.inputs[2])
    pdvec = _n(g, "ShaderNodeVectorMath", x=-440, y=940, operation="SCALE")
    _link(g, nrm2.outputs["Normal"], pdvec.inputs[0]); _link(g, pctr.outputs["Value"], pdvec.inputs["Scale"])
    pyl_disp = _n(g, "GeometryNodeSetPosition", x=-600, y=1040)
    _link(g, conexf.outputs["Geometry"], pyl_disp.inputs["Geometry"]); _link(g, pdvec.outputs["Vector"], pyl_disp.inputs["Offset"])

    # per-pylon random yaw + lean
    wnp = _n(g, "ShaderNodeTexWhiteNoise", x=-600, y=360); wnp.noise_dimensions = "4D"
    _link(g, pos.outputs["Position"], wnp.inputs["Vector"])
    seedp = _n(g, "ShaderNodeMath", x=-760, y=300, operation="ADD"); seedp.inputs[1].default_value = 17.0
    _link(g, gin.outputs["Seed"], seedp.inputs[0]); _link(g, seedp.outputs["Value"], wnp.inputs["W"])
    wnp_c = _n(g, "ShaderNodeSeparateXYZ", x=-440, y=300); _link(g, wnp.outputs["Color"], wnp_c.inputs["Vector"])
    yaw = _n(g, "ShaderNodeMath", x=-280, y=240, operation="MULTIPLY"); yaw.inputs[1].default_value = 6.2832
    _link(g, wnp.outputs["Value"], yaw.inputs[0])
    leanx = _n(g, "ShaderNodeMath", x=-280, y=120, operation="MULTIPLY_ADD")
    _link(g, wnp_c.outputs["X"], leanx.inputs[0]); _link(g, gin.outputs["Pylon Lean"], leanx.inputs[1])
    leanxn = _n(g, "ShaderNodeMath", x=-440, y=60, operation="MULTIPLY"); leanxn.inputs[1].default_value = -0.5
    _link(g, gin.outputs["Pylon Lean"], leanxn.inputs[0]); _link(g, leanxn.outputs["Value"], leanx.inputs[2])
    leany = _n(g, "ShaderNodeMath", x=-280, y=-20, operation="MULTIPLY_ADD")
    _link(g, wnp_c.outputs["Y"], leany.inputs[0]); _link(g, gin.outputs["Pylon Lean"], leany.inputs[1])
    _link(g, leanxn.outputs["Value"], leany.inputs[2])
    pyl_euler = _n(g, "ShaderNodeCombineXYZ", x=-120, y=160)
    _link(g, leanx.outputs["Value"], pyl_euler.inputs["X"]); _link(g, leany.outputs["Value"], pyl_euler.inputs["Y"]); _link(g, yaw.outputs["Value"], pyl_euler.inputs["Z"])

    iopp = _n(g, "GeometryNodeInstanceOnPoints", x=-120, y=560)
    _link(g, ptsJ.outputs["Geometry"], iopp.inputs["Points"])
    _link(g, pyl_disp.outputs["Geometry"], iopp.inputs["Instance"])
    _link(g, pyl_euler.outputs["Vector"], iopp.inputs["Rotation"])
    pyl_setmat = _n(g, "GeometryNodeSetMaterial", x=60, y=560)
    pyl_setmat.inputs["Material"].default_value = pylon_mat
    _link(g, iopp.outputs["Instances"], pyl_setmat.inputs["Geometry"])

    # ============ JOIN / REALIZE / OUTPUT ============
    join = _n(g, "GeometryNodeJoinGeometry", x=320, y=300)
    _link(g, pyl_setmat.outputs["Geometry"], join.inputs["Geometry"])
    _link(g, plank_setmat.outputs["Geometry"], join.inputs["Geometry"])
    realize = _n(g, "GeometryNodeRealizeInstances", x=520, y=300)
    _link(g, join.outputs["Geometry"], realize.inputs["Geometry"])
    store = _store_color0(g, realize.outputs["Geometry"], rgba=(1.0, 1.0, 0.0, 0.0))
    store.location = (720, 300)
    _link(g, store.outputs["Geometry"], gout.inputs["Geometry"])
    return g


# --------------------------------------------------------------------------
# Tool 3: Palm — "drunken" curved trunk, green crown + dead-frond skirt
# --------------------------------------------------------------------------
def _leaflet_blade(g, x0, y0):
    """A unit-length (+X) thin tapered leaflet blade, flat in XY. Scaled
    per-instance later. Returns mesh socket."""
    line = _n(g, "GeometryNodeCurvePrimitiveLine", x=x0, y=y0)
    line.inputs["Start"].default_value = (0.0, 0.0, 0.0)
    line.inputs["End"].default_value = (1.0, 0.0, 0.0)
    rs = _n(g, "GeometryNodeResampleCurve", x=x0 + 160, y=y0); rs.inputs["Count"].default_value = 6
    _link(g, line.outputs["Curve"], rs.inputs["Curve"])
    fp = _n(g, "GeometryNodeSplineParameter", x=x0 + 160, y=y0 - 160)
    # leaflet width: rises fast, tapers to a point  w = sin(f*pi)^0.5 * 0.5, min near base
    fpi = _n(g, "ShaderNodeMath", x=x0 + 320, y=y0 - 120, operation="MULTIPLY"); fpi.inputs[1].default_value = math.pi
    _link(g, fp.outputs["Factor"], fpi.inputs[0])
    fsin = _n(g, "ShaderNodeMath", x=x0 + 480, y=y0 - 120, operation="SINE")
    _link(g, fpi.outputs["Value"], fsin.inputs[0])
    fpow = _n(g, "ShaderNodeMath", x=x0 + 640, y=y0 - 120, operation="POWER"); fpow.inputs[1].default_value = 0.5
    _link(g, fsin.outputs["Value"], fpow.inputs[0])
    wsc = _n(g, "ShaderNodeMath", x=x0 + 800, y=y0 - 120, operation="MULTIPLY"); wsc.inputs[1].default_value = 0.16
    _link(g, fpow.outputs["Value"], wsc.inputs[0])
    setr = _n(g, "GeometryNodeSetCurveRadius", x=x0 + 800, y=y0)
    _link(g, rs.outputs["Curve"], setr.inputs["Curve"]); _link(g, wsc.outputs["Value"], setr.inputs["Radius"])
    pl = _n(g, "GeometryNodeCurvePrimitiveLine", x=x0 + 640, y=y0 + 160)
    pl.inputs["Start"].default_value = (0.0, -1.0, 0.0); pl.inputs["End"].default_value = (0.0, 1.0, 0.0)
    ctm = _n(g, "GeometryNodeCurveToMesh", x=x0 + 980, y=y0)
    _link(g, setr.outputs["Curve"], ctm.inputs["Curve"]); _link(g, pl.outputs["Curve"], ctm.inputs["Profile Curve"])
    _radius_to_scale(g, ctm, x=x0 + 820, y=y0 - 200)
    return ctm.outputs["Mesh"]


def _build_frond(g, length_sock, width_sock, arch, droop, leaf_splay, leaf_droop, x0, curl=0.0):
    """Pinnate frond: an arched central rib with leaflets down both
    sides. Built along +X. Returns the (instanced) geometry socket.

    curl=0 -> rib uses the arch/droop offset (green fronds, gentle arc).
    curl>0 -> rib follows a constant-curvature arc bending downward by
    *curl* radians over its length, coiling COMPACTLY (old/dead fronds)."""
    y0 = 1500
    # --- rib spine (arched / drooping) ---
    line = _n(g, "GeometryNodeCurvePrimitiveLine", x=x0, y=y0)
    end = _n(g, "ShaderNodeCombineXYZ", x=x0 - 160, y=y0 - 40)
    _link(g, length_sock, end.inputs["X"]); _link(g, end.outputs["Vector"], line.inputs["End"])
    rs = _n(g, "GeometryNodeResampleCurve", x=x0 + 160, y=y0); rs.inputs["Count"].default_value = 18
    _link(g, line.outputs["Curve"], rs.inputs["Curve"])
    fparam = _n(g, "GeometryNodeSplineParameter", x=x0 + 160, y=y0 - 220)
    fpi = _n(g, "ShaderNodeMath", x=x0 + 320, y=y0 - 160, operation="MULTIPLY"); fpi.inputs[1].default_value = math.pi * 0.8
    _link(g, fparam.outputs["Factor"], fpi.inputs[0])
    fsin = _n(g, "ShaderNodeMath", x=x0 + 480, y=y0 - 160, operation="SINE")
    _link(g, fpi.outputs["Value"], fsin.inputs[0])
    archt = _n(g, "ShaderNodeMath", x=x0 + 640, y=y0 - 120, operation="MULTIPLY"); archt.inputs[1].default_value = arch
    _link(g, fsin.outputs["Value"], archt.inputs[0])
    fsq = _n(g, "ShaderNodeMath", x=x0 + 480, y=y0 - 320, operation="POWER"); fsq.inputs[1].default_value = 2.0
    _link(g, fparam.outputs["Factor"], fsq.inputs[0])
    droopt = _n(g, "ShaderNodeMath", x=x0 + 640, y=y0 - 320, operation="MULTIPLY"); droopt.inputs[1].default_value = droop
    _link(g, fsq.outputs["Value"], droopt.inputs[0])
    zsum = _n(g, "ShaderNodeMath", x=x0 + 800, y=y0 - 220, operation="SUBTRACT")
    _link(g, archt.outputs["Value"], zsum.inputs[0]); _link(g, droopt.outputs["Value"], zsum.inputs[1])
    zlen = _n(g, "ShaderNodeMath", x=x0 + 960, y=y0 - 220, operation="MULTIPLY")
    _link(g, zsum.outputs["Value"], zlen.inputs[0]); _link(g, length_sock, zlen.inputs[1])
    zoff = _n(g, "ShaderNodeCombineXYZ", x=x0 + 1120, y=y0 - 220)
    _link(g, zlen.outputs["Value"], zoff.inputs["Z"])
    # store factor on rib so leaflet points inherit it
    fstore = _n(g, "GeometryNodeStoreNamedAttribute", x=x0 + 320, y=y0); fstore.data_type = "FLOAT"; fstore.domain = "POINT"
    fstore.inputs["Name"].default_value = "leaf_f"
    _link(g, rs.outputs["Curve"], fstore.inputs["Geometry"]); _link(g, fparam.outputs["Factor"], fstore.inputs["Value"])
    ribpos = _n(g, "GeometryNodeSetPosition", x=x0 + 1120, y=y0)
    _link(g, fstore.outputs["Geometry"], ribpos.inputs["Geometry"])
    if curl and curl > 1e-3:
        # constant-curvature curl: x = (L/curl) sin(curl*f),
        #                          z = -(L/curl) (1 - cos(curl*f))
        cf = _n(g, "ShaderNodeMath", x=x0 + 620, y=y0 - 460, operation="MULTIPLY"); cf.inputs[1].default_value = curl
        _link(g, fparam.outputs["Factor"], cf.inputs[0])
        csin = _n(g, "ShaderNodeMath", x=x0 + 780, y=y0 - 420, operation="SINE"); _link(g, cf.outputs["Value"], csin.inputs[0])
        ccos = _n(g, "ShaderNodeMath", x=x0 + 780, y=y0 - 560, operation="COSINE"); _link(g, cf.outputs["Value"], ccos.inputs[0])
        cx = _n(g, "ShaderNodeMath", x=x0 + 940, y=y0 - 420, operation="MULTIPLY")
        _link(g, csin.outputs["Value"], cx.inputs[0]); _link(g, length_sock, cx.inputs[1])
        cx2 = _n(g, "ShaderNodeMath", x=x0 + 1100, y=y0 - 420, operation="MULTIPLY"); cx2.inputs[1].default_value = 1.0 / curl
        _link(g, cx.outputs["Value"], cx2.inputs[0])
        comc = _n(g, "ShaderNodeMath", x=x0 + 940, y=y0 - 560, operation="SUBTRACT"); comc.inputs[0].default_value = 1.0
        _link(g, ccos.outputs["Value"], comc.inputs[1])
        cz = _n(g, "ShaderNodeMath", x=x0 + 1100, y=y0 - 560, operation="MULTIPLY")
        _link(g, comc.outputs["Value"], cz.inputs[0]); _link(g, length_sock, cz.inputs[1])
        cz2 = _n(g, "ShaderNodeMath", x=x0 + 1260, y=y0 - 560, operation="MULTIPLY"); cz2.inputs[1].default_value = -1.0 / curl
        _link(g, cz.outputs["Value"], cz2.inputs[0])
        cpos = _n(g, "ShaderNodeCombineXYZ", x=x0 + 1420, y=y0 - 480)
        _link(g, cx2.outputs["Value"], cpos.inputs["X"]); _link(g, cz2.outputs["Value"], cpos.inputs["Z"])
        _link(g, cpos.outputs["Vector"], ribpos.inputs["Position"])
    else:
        _link(g, zoff.outputs["Vector"], ribpos.inputs["Offset"])
    # thin rib stem mesh, radius tapering to ~0 at the tip so the spine ends
    # in a point instead of a flat circular cap.
    rr = _n(g, "ShaderNodeMath", x=x0 + 1120, y=y0 + 200, operation="MULTIPLY"); rr.inputs[1].default_value = 0.06
    _link(g, width_sock, rr.inputs[0])
    # taper profile = clamp((1 - factor) * 14, 0, 1): stays 1.0 (full thickness)
    # along the whole rib and only ramps to 0 over the final segment -> a point.
    ribt = _n(g, "ShaderNodeMath", x=x0 + 1080, y=y0 + 320, operation="SUBTRACT"); ribt.inputs[0].default_value = 1.0
    _link(g, fparam.outputs["Factor"], ribt.inputs[1])
    ribt_s = _n(g, "ShaderNodeMath", x=x0 + 1160, y=y0 + 380, operation="MULTIPLY"); ribt_s.inputs[1].default_value = 14.0
    _link(g, ribt.outputs["Value"], ribt_s.inputs[0])
    ribtap = _n(g, "ShaderNodeMath", x=x0 + 1240, y=y0 + 380, operation="MINIMUM"); ribtap.inputs[1].default_value = 1.0
    _link(g, ribt_s.outputs["Value"], ribtap.inputs[0])
    rr2 = _n(g, "ShaderNodeMath", x=x0 + 1320, y=y0 + 260, operation="MULTIPLY")
    _link(g, rr.outputs["Value"], rr2.inputs[0]); _link(g, ribtap.outputs["Value"], rr2.inputs[1])
    ribrad = _n(g, "GeometryNodeSetCurveRadius", x=x0 + 1280, y=y0 + 120)
    _link(g, rr2.outputs["Value"], ribrad.inputs["Radius"])
    _link(g, ribpos.outputs["Geometry"], ribrad.inputs["Curve"])
    ribcirc = _n(g, "GeometryNodeCurvePrimitiveCircle", x=x0 + 1120, y=y0 + 360); ribcirc.mode = "RADIUS"
    ribcirc.inputs["Resolution"].default_value = 4; ribcirc.inputs["Radius"].default_value = 1.0
    ribmesh = _n(g, "GeometryNodeCurveToMesh", x=x0 + 1440, y=y0 + 120)
    _link(g, ribrad.outputs["Curve"], ribmesh.inputs["Curve"]); _link(g, ribcirc.outputs["Curve"], ribmesh.inputs["Profile Curve"])
    _radius_to_scale(g, ribmesh, x=x0 + 1280, y=y0 + 460)

    # --- leaflets along rib ---
    c2p = _n(g, "GeometryNodeCurveToPoints", x=x0 + 1280, y=y0 - 220); c2p.mode = "COUNT"
    c2p.inputs["Count"].default_value = 22
    _link(g, ribpos.outputs["Geometry"], c2p.inputs["Curve"])
    lf = _n(g, "GeometryNodeInputNamedAttribute", x=x0 + 1280, y=y0 - 420); lf.data_type = "FLOAT"
    lf.inputs["Name"].default_value = "leaf_f"
    # leaflet length = width * (0.5 + 1.6 * sin(f*pi)^0.7)
    lfpi = _n(g, "ShaderNodeMath", x=x0 + 1440, y=y0 - 420, operation="MULTIPLY"); lfpi.inputs[1].default_value = math.pi
    _link(g, lf.outputs["Attribute"], lfpi.inputs[0])
    lfsin = _n(g, "ShaderNodeMath", x=x0 + 1600, y=y0 - 420, operation="SINE")
    _link(g, lfpi.outputs["Value"], lfsin.inputs[0])
    lfpow = _n(g, "ShaderNodeMath", x=x0 + 1760, y=y0 - 420, operation="POWER"); lfpow.inputs[1].default_value = 0.7
    _link(g, lfsin.outputs["Value"], lfpow.inputs[0])
    lflen0 = _n(g, "ShaderNodeMath", x=x0 + 1920, y=y0 - 420, operation="MULTIPLY_ADD"); lflen0.inputs[1].default_value = 1.7; lflen0.inputs[2].default_value = 0.5
    _link(g, lfpow.outputs["Value"], lflen0.inputs[0])
    lflen = _n(g, "ShaderNodeMath", x=x0 + 2080, y=y0 - 420, operation="MULTIPLY")
    _link(g, lflen0.outputs["Value"], lflen.inputs[0]); _link(g, width_sock, lflen.inputs[1])
    lscale = _n(g, "ShaderNodeCombineXYZ", x=x0 + 2240, y=y0 - 420)
    _link(g, lflen.outputs["Value"], lscale.inputs["X"]); _link(g, lflen.outputs["Value"], lscale.inputs["Y"]); _link(g, lflen.outputs["Value"], lscale.inputs["Z"])
    # Orient each leaflet PERPENDICULAR to the rib, on the lower/concave side
    # of the rib's own curve plane. The rib is planar in local X-Z, so the
    # in-plane perpendicular is (Tz, 0, -Tx) -- it equals "down" where the rib
    # is horizontal but, unlike projecting world-down, it never degenerates as
    # the rib curls vertical, so leaflets stay on one consistent side as the
    # spine coils. Splay +/- to each side; leaf_droop leans them inward.
    tang = c2p.outputs["Tangent"]
    tsep = _n(g, "ShaderNodeSeparateXYZ", x=x0 + 1340, y=y0 - 600); _link(g, tang, tsep.inputs["Vector"])
    negTx = _n(g, "ShaderNodeMath", x=x0 + 1500, y=y0 - 680, operation="MULTIPLY"); negTx.inputs[1].default_value = -1.0
    _link(g, tsep.outputs["X"], negTx.inputs[0])
    inperp = _n(g, "ShaderNodeCombineXYZ", x=x0 + 1660, y=y0 - 600)
    _link(g, tsep.outputs["Z"], inperp.inputs["X"]); _link(g, negTx.outputs["Value"], inperp.inputs["Z"])
    dperpn = _n(g, "ShaderNodeVectorMath", x=x0 + 1820, y=y0 - 600, operation="NORMALIZE")
    _link(g, inperp.outputs["Vector"], dperpn.inputs[0])
    # inward lean = -leaf_droop * tangent (tangent points toward the tip)
    inward = _n(g, "ShaderNodeVectorMath", x=x0 + 1660, y=y0 - 460, operation="SCALE")
    _link(g, tang, inward.inputs[0]); inward.inputs["Scale"].default_value = -leaf_droop
    base = _n(g, "ShaderNodeVectorMath", x=x0 + 1980, y=y0 - 540, operation="ADD")
    _link(g, dperpn.outputs["Vector"], base.inputs[0]); _link(g, inward.outputs["Vector"], base.inputs[1])
    # side = normalize(cross(tangent, down_perp))
    sidev = _n(g, "ShaderNodeVectorMath", x=x0 + 1660, y=y0 - 820, operation="CROSS_PRODUCT")
    _link(g, tang, sidev.inputs[0]); _link(g, dperpn.outputs["Vector"], sidev.inputs[1])
    siden = _n(g, "ShaderNodeVectorMath", x=x0 + 1820, y=y0 - 820, operation="NORMALIZE")
    _link(g, sidev.outputs["Vector"], siden.inputs[0])
    sideL = _n(g, "ShaderNodeVectorMath", x=x0 + 1980, y=y0 - 700, operation="SCALE")
    _link(g, siden.outputs["Vector"], sideL.inputs[0]); sideL.inputs["Scale"].default_value = leaf_splay
    sideR = _n(g, "ShaderNodeVectorMath", x=x0 + 1980, y=y0 - 860, operation="SCALE")
    _link(g, siden.outputs["Vector"], sideR.inputs[0]); sideR.inputs["Scale"].default_value = -leaf_splay
    dirL = _n(g, "ShaderNodeVectorMath", x=x0 + 2140, y=y0 - 600, operation="ADD")
    _link(g, base.outputs["Vector"], dirL.inputs[0]); _link(g, sideL.outputs["Vector"], dirL.inputs[1])
    dirR = _n(g, "ShaderNodeVectorMath", x=x0 + 2140, y=y0 - 860, operation="ADD")
    _link(g, base.outputs["Vector"], dirR.inputs[0]); _link(g, sideR.outputs["Vector"], dirR.inputs[1])
    # 1) point the blade length (X) down the leaflet direction; 2) roll about
    # that length until the blade normal (Z) faces the frond-plane side, so the
    # broad face shows instead of the thin edge.
    aL1 = _n(g, "FunctionNodeAlignEulerToVector", x=x0 + 2300, y=y0 - 600); aL1.axis = "X"; aL1.pivot_axis = "AUTO"
    _link(g, dirL.outputs["Vector"], aL1.inputs["Vector"])
    addL = _n(g, "FunctionNodeAlignEulerToVector", x=x0 + 2460, y=y0 - 600); addL.axis = "Y"; addL.pivot_axis = "X"
    _link(g, aL1.outputs["Rotation"], addL.inputs["Rotation"]); _link(g, siden.outputs["Vector"], addL.inputs["Vector"])
    aR1 = _n(g, "FunctionNodeAlignEulerToVector", x=x0 + 2300, y=y0 - 860); aR1.axis = "X"; aR1.pivot_axis = "AUTO"
    _link(g, dirR.outputs["Vector"], aR1.inputs["Vector"])
    addR = _n(g, "FunctionNodeAlignEulerToVector", x=x0 + 2460, y=y0 - 860); addR.axis = "Y"; addR.pivot_axis = "X"
    _link(g, aR1.outputs["Rotation"], addR.inputs["Rotation"]); _link(g, siden.outputs["Vector"], addR.inputs["Vector"])
    blade = _leaflet_blade(g, x0 + 1280, y0 + 560)
    iL = _n(g, "GeometryNodeInstanceOnPoints", x=x0 + 2240, y=y0 - 120)
    _link(g, c2p.outputs["Points"], iL.inputs["Points"]); _link(g, blade, iL.inputs["Instance"])
    _link(g, addL.outputs["Rotation"], iL.inputs["Rotation"]); _link(g, lscale.outputs["Vector"], iL.inputs["Scale"])
    iR = _n(g, "GeometryNodeInstanceOnPoints", x=x0 + 2240, y=y0 - 260)
    _link(g, c2p.outputs["Points"], iR.inputs["Points"]); _link(g, blade, iR.inputs["Instance"])
    _link(g, addR.outputs["Rotation"], iR.inputs["Rotation"]); _link(g, lscale.outputs["Vector"], iR.inputs["Scale"])
    join = _n(g, "GeometryNodeJoinGeometry", x=x0 + 2440, y=y0)
    _link(g, ribmesh.outputs["Mesh"], join.inputs["Geometry"])
    _link(g, iL.outputs["Instances"], join.inputs["Geometry"])
    _link(g, iR.outputs["Instances"], join.inputs["Geometry"])
    sm = _n(g, "GeometryNodeSetShadeSmooth", x=x0 + 2600, y=y0)
    _link(g, join.outputs["Geometry"], sm.inputs["Geometry"])
    return sm.outputs["Geometry"]


def _crown_ring(g, count_sock, frond_geo, pitch_sock, pitch_sign, mat, seed_off, x0, yb, spread=1.4):
    """Instance *frond_geo* radially with per-frond yaw + pitch. Returns
    instances socket (material assigned). *spread* = radians of random
    pitch variation so fronds fan into a fountain rather than a dome."""
    pts = _n(g, "GeometryNodePoints", x=x0, y=yb); _link(g, count_sock, pts.inputs["Count"])
    idx = _n(g, "GeometryNodeInputIndex", x=x0, y=yb - 160)
    step = _n(g, "ShaderNodeMath", x=x0 + 160, y=yb - 120, operation="DIVIDE"); step.inputs[0].default_value = 6.28319
    _link(g, count_sock, step.inputs[1])
    yaw = _n(g, "ShaderNodeMath", x=x0 + 320, y=yb - 120, operation="MULTIPLY")
    _link(g, idx.outputs["Index"], yaw.inputs[0]); _link(g, step.outputs["Value"], yaw.inputs[1])
    # golden offset for nicer stagger
    gold = _n(g, "ShaderNodeMath", x=x0 + 480, y=yb - 120, operation="MULTIPLY_ADD")
    _link(g, idx.outputs["Index"], gold.inputs[0]); gold.inputs[1].default_value = 2.4
    _link(g, yaw.outputs["Value"], gold.inputs[2])
    # per-frond jitter
    pos = _n(g, "GeometryNodeInputPosition", x=x0, y=yb - 320)
    wn = _n(g, "ShaderNodeTexWhiteNoise", x=x0 + 160, y=yb - 320); wn.noise_dimensions = "4D"
    wid = _n(g, "ShaderNodeMath", x=x0, y=yb - 460, operation="ADD"); wid.inputs[1].default_value = float(seed_off)
    _link(g, idx.outputs["Index"], wid.inputs[0]); _link(g, wid.outputs["Value"], wn.inputs["W"])
    _link(g, pos.outputs["Position"], wn.inputs["Vector"])
    wc = _n(g, "ShaderNodeSeparateXYZ", x=x0 + 320, y=yb - 360); _link(g, wn.outputs["Color"], wc.inputs["Vector"])
    pjit = _n(g, "ShaderNodeMath", x=x0 + 480, y=yb - 360, operation="MULTIPLY_ADD")
    pjit.inputs[1].default_value = spread; pjit.inputs[2].default_value = -0.5 * spread
    _link(g, wc.outputs["X"], pjit.inputs[0])
    # pitch (signed) + jitter
    psign = _n(g, "ShaderNodeMath", x=x0 + 480, y=yb - 220, operation="MULTIPLY"); psign.inputs[1].default_value = float(pitch_sign)
    _link(g, pitch_sock, psign.inputs[0])
    pitch = _n(g, "ShaderNodeMath", x=x0 + 640, y=yb - 260, operation="ADD")
    _link(g, psign.outputs["Value"], pitch.inputs[0]); _link(g, pjit.outputs["Value"], pitch.inputs[1])
    euler = _n(g, "ShaderNodeCombineXYZ", x=x0 + 800, y=yb - 160)
    _link(g, pitch.outputs["Value"], euler.inputs["Y"])
    _link(g, gold.outputs["Value"], euler.inputs["Z"])
    # scale jitter
    sj = _n(g, "ShaderNodeMath", x=x0 + 640, y=yb - 460, operation="MULTIPLY_ADD"); sj.inputs[1].default_value = 0.3; sj.inputs[2].default_value = 0.85
    _link(g, wc.outputs["Y"], sj.inputs[0])
    iop = _n(g, "GeometryNodeInstanceOnPoints", x=x0 + 980, y=yb)
    _link(g, pts.outputs["Points"], iop.inputs["Points"])
    _link(g, frond_geo, iop.inputs["Instance"])
    _link(g, euler.outputs["Vector"], iop.inputs["Rotation"])
    _link(g, sj.outputs["Value"], iop.inputs["Scale"])
    setmat = _n(g, "GeometryNodeSetMaterial", x=x0 + 1160, y=yb)
    setmat.inputs["Material"].default_value = mat
    _link(g, iop.outputs["Instances"], setmat.inputs["Geometry"])
    return setmat.outputs["Geometry"]


def build_palm() -> bpy.types.GeometryNodeTree:
    g = _new_tree("HV_Palm")
    _out(g, "Geometry", "NodeSocketGeometry")
    _in(g, "Geometry", "NodeSocketGeometry")  # ignored (generator)
    _in(g, "Height", "NodeSocketFloat", 8.0, mn=2.0, mx=28.0, subtype="DISTANCE")
    _in(g, "Lean", "NodeSocketFloat", 0.20, mn=0.0, mx=1.2)
    _in(g, "Wobble", "NodeSocketFloat", 0.16, mn=0.0, mx=1.0)
    _in(g, "Base Radius", "NodeSocketFloat", 0.27, mn=0.05, mx=1.5, subtype="DISTANCE")
    _in(g, "Top Radius", "NodeSocketFloat", 0.15, mn=0.03, mx=1.0, subtype="DISTANCE")
    _in(g, "Green Fronds", "NodeSocketInt", 12, mn=3, mx=40)
    _in(g, "Dead Fronds", "NodeSocketInt", 6, mn=0, mx=24)
    _in(g, "Frond Length", "NodeSocketFloat", 4.35, mn=0.5, mx=12.0, subtype="DISTANCE")
    _in(g, "Frond Width", "NodeSocketFloat", 0.42, mn=0.05, mx=2.0, subtype="DISTANCE")
    _in(g, "Green Pitch", "NodeSocketFloat", math.radians(-35.7), mn=-1.4, mx=1.4, subtype="ANGLE")
    _in(g, "Dead Droop", "NodeSocketFloat", math.radians(18.2), mn=0.0, mx=2.0, subtype="ANGLE")
    _in(g, "Dead Length", "NodeSocketFloat", 1.02, mn=0.1, mx=1.5)  # fraction of Frond Length
    _in(g, "Seed", "NodeSocketFloat", 0.0)

    gin = _n(g, "NodeGroupInput", x=-2000, y=0)
    gout = _n(g, "NodeGroupOutput", x=2400, y=0)
    trunk_mat = _mat("mat_foliage_palm_trunk", PALM_TRUNK_RGBA, roughness=0.9)
    green_mat = _mat("mat_foliage_palm_frond", PALM_FROND_RGBA, roughness=0.7)
    dead_mat = _mat("mat_foliage_palm_dead", PALM_DEAD_RGBA, roughness=0.85)

    # --- Trunk spine ---
    end_v = _n(g, "ShaderNodeCombineXYZ", x=-1820, y=-60)
    _link(g, gin.outputs["Height"], end_v.inputs["Z"])
    line = _n(g, "GeometryNodeCurvePrimitiveLine", x=-1660, y=80)
    _link(g, end_v.outputs["Vector"], line.inputs["End"])
    resample = _n(g, "GeometryNodeResampleCurve", x=-1500, y=80); resample.inputs["Count"].default_value = 32
    _link(g, line.outputs["Curve"], resample.inputs["Curve"])
    sp = _n(g, "GeometryNodeSplineParameter", x=-1500, y=-220)
    # ease = smoothstep(t) = t^2(3-2t)
    t2 = _n(g, "ShaderNodeMath", x=-1340, y=-160, operation="MULTIPLY")
    _link(g, sp.outputs["Factor"], t2.inputs[0]); _link(g, sp.outputs["Factor"], t2.inputs[1])
    tt = _n(g, "ShaderNodeMath", x=-1340, y=-300, operation="MULTIPLY_ADD"); tt.inputs[1].default_value = -2.0; tt.inputs[2].default_value = 3.0
    _link(g, sp.outputs["Factor"], tt.inputs[0])
    ease = _n(g, "ShaderNodeMath", x=-1180, y=-200, operation="MULTIPLY")
    _link(g, t2.outputs["Value"], ease.inputs[0]); _link(g, tt.outputs["Value"], ease.inputs[1])
    lean_amt = _n(g, "ShaderNodeMath", x=-1180, y=-360, operation="MULTIPLY")
    _link(g, gin.outputs["Lean"], lean_amt.inputs[0]); _link(g, gin.outputs["Height"], lean_amt.inputs[1])
    offx = _n(g, "ShaderNodeMath", x=-1020, y=-280, operation="MULTIPLY")
    _link(g, ease.outputs["Value"], offx.inputs[0]); _link(g, lean_amt.outputs["Value"], offx.inputs[1])
    # drunken S + wobble: add sin(t*pi*1.6)*Height*Wobble*0.3 to X, noise to Y
    sarg = _n(g, "ShaderNodeMath", x=-1340, y=-480, operation="MULTIPLY"); sarg.inputs[1].default_value = math.pi * 1.7
    _link(g, sp.outputs["Factor"], sarg.inputs[0])
    ssin = _n(g, "ShaderNodeMath", x=-1180, y=-480, operation="SINE")
    _link(g, sarg.outputs["Value"], ssin.inputs[0])
    wob_amt = _n(g, "ShaderNodeMath", x=-1340, y=-620, operation="MULTIPLY")
    _link(g, gin.outputs["Wobble"], wob_amt.inputs[0]); _link(g, gin.outputs["Height"], wob_amt.inputs[1])
    wob_amt2 = _n(g, "ShaderNodeMath", x=-1180, y=-620, operation="MULTIPLY"); wob_amt2.inputs[1].default_value = 0.32
    _link(g, wob_amt.outputs["Value"], wob_amt2.inputs[0])
    sx = _n(g, "ShaderNodeMath", x=-1020, y=-480, operation="MULTIPLY")
    _link(g, ssin.outputs["Value"], sx.inputs[0]); _link(g, wob_amt2.outputs["Value"], sx.inputs[1])
    totx = _n(g, "ShaderNodeMath", x=-860, y=-360, operation="ADD")
    _link(g, offx.outputs["Value"], totx.inputs[0]); _link(g, sx.outputs["Value"], totx.inputs[1])
    # Y wobble via cosine of different phase
    yarg = _n(g, "ShaderNodeMath", x=-1180, y=-760, operation="MULTIPLY_ADD"); yarg.inputs[1].default_value = math.pi * 1.3
    _link(g, sp.outputs["Factor"], yarg.inputs[0]); _link(g, gin.outputs["Seed"], yarg.inputs[2])
    ycos = _n(g, "ShaderNodeMath", x=-1020, y=-760, operation="COSINE")
    _link(g, yarg.outputs["Value"], ycos.inputs[0])
    sy = _n(g, "ShaderNodeMath", x=-860, y=-700, operation="MULTIPLY")
    _link(g, ycos.outputs["Value"], sy.inputs[0]); _link(g, wob_amt2.outputs["Value"], sy.inputs[1])
    spine_off = _n(g, "ShaderNodeCombineXYZ", x=-700, y=-360)
    _link(g, totx.outputs["Value"], spine_off.inputs["X"]); _link(g, sy.outputs["Value"], spine_off.inputs["Y"])
    setpos_spine = _n(g, "GeometryNodeSetPosition", x=-540, y=80)
    _link(g, resample.outputs["Curve"], setpos_spine.inputs["Geometry"])
    _link(g, spine_off.outputs["Vector"], setpos_spine.inputs["Offset"])

    # trunk radius: base->top taper with slight ringing
    rad = _n(g, "ShaderNodeMath", x=-700, y=200, operation="SUBTRACT")  # base - top
    _link(g, gin.outputs["Base Radius"], rad.inputs[0]); _link(g, gin.outputs["Top Radius"], rad.inputs[1])
    radt = _n(g, "ShaderNodeMath", x=-540, y=240, operation="MULTIPLY")  # *(1-t)
    omt = _n(g, "ShaderNodeMath", x=-700, y=340, operation="SUBTRACT"); omt.inputs[0].default_value = 1.0
    _link(g, sp.outputs["Factor"], omt.inputs[1])
    _link(g, rad.outputs["Value"], radt.inputs[0]); _link(g, omt.outputs["Value"], radt.inputs[1])
    radf = _n(g, "ShaderNodeMath", x=-380, y=240, operation="ADD")
    _link(g, radt.outputs["Value"], radf.inputs[0]); _link(g, gin.outputs["Top Radius"], radf.inputs[1])
    # ring ripple
    rarg = _n(g, "ShaderNodeMath", x=-540, y=400, operation="MULTIPLY"); rarg.inputs[1].default_value = 26.0
    _link(g, sp.outputs["Factor"], rarg.inputs[0])
    rsin = _n(g, "ShaderNodeMath", x=-380, y=400, operation="SINE")
    _link(g, rarg.outputs["Value"], rsin.inputs[0])
    rring = _n(g, "ShaderNodeMath", x=-220, y=380, operation="MULTIPLY_ADD"); rring.inputs[1].default_value = 0.05; rring.inputs[2].default_value = 1.0
    _link(g, rsin.outputs["Value"], rring.inputs[0])
    radring = _n(g, "ShaderNodeMath", x=-60, y=300, operation="MULTIPLY")
    _link(g, radf.outputs["Value"], radring.inputs[0]); _link(g, rring.outputs["Value"], radring.inputs[1])
    setrad = _n(g, "GeometryNodeSetCurveRadius", x=100, y=120)
    _link(g, setpos_spine.outputs["Geometry"], setrad.inputs["Curve"]); _link(g, radring.outputs["Value"], setrad.inputs["Radius"])
    circ = _n(g, "GeometryNodeCurvePrimitiveCircle", x=100, y=-120); circ.mode = "RADIUS"; circ.inputs["Resolution"].default_value = 10
    circ.inputs["Radius"].default_value = 1.0
    trunk_mesh = _n(g, "GeometryNodeCurveToMesh", x=280, y=60)
    _link(g, setrad.outputs["Curve"], trunk_mesh.inputs["Curve"]); _link(g, circ.outputs["Curve"], trunk_mesh.inputs["Profile Curve"])
    _radius_to_scale(g, trunk_mesh, x=100, y=-260)
    trunk_smooth = _n(g, "GeometryNodeSetShadeSmooth", x=440, y=60)
    _link(g, trunk_mesh.outputs["Mesh"], trunk_smooth.inputs["Geometry"])
    trunk_setmat = _n(g, "GeometryNodeSetMaterial", x=600, y=60)
    trunk_setmat.inputs["Material"].default_value = trunk_mat
    _link(g, trunk_smooth.outputs["Geometry"], trunk_setmat.inputs["Geometry"])

    # --- Crown: tip transform from spine ---
    samp = _n(g, "GeometryNodeSampleCurve", x=-540, y=-560); samp.mode = "FACTOR"
    _link(g, setpos_spine.outputs["Geometry"], samp.inputs[0])
    samp.inputs["Factor"].default_value = 1.0
    crown_align = _n(g, "FunctionNodeAlignEulerToVector", x=-360, y=-560); crown_align.axis = "Z"; crown_align.pivot_axis = "AUTO"
    _link(g, samp.outputs["Tangent"], crown_align.inputs["Vector"])

    # green + dead fronds (pinnate). Long, gently arching then drooping.
    green_frond = _build_frond(g, gin.outputs["Frond Length"], gin.outputs["Frond Width"],
                               arch=0.22, droop=0.80, leaf_splay=0.55, leaf_droop=0.15, x0=600)
    dead_len = _n(g, "ShaderNodeMath", x=600, y=900, operation="MULTIPLY")
    _link(g, gin.outputs["Frond Length"], dead_len.inputs[0]); _link(g, gin.outputs["Dead Length"], dead_len.inputs[1])
    dead_frond = _build_frond(g, dead_len.outputs["Value"], gin.outputs["Frond Width"],
                              arch=0.0, droop=0.0, leaf_splay=0.42, leaf_droop=0.5, curl=3.0, x0=4200)
    green_ring = _crown_ring(g, gin.outputs["Green Fronds"], green_frond, gin.outputs["Green Pitch"], +1.0, green_mat, 3.0, x0=6000, yb=300, spread=1.1)
    dead_ring = _crown_ring(g, gin.outputs["Dead Fronds"], dead_frond, gin.outputs["Dead Droop"], -1.0, dead_mat, 91.0, x0=6000, yb=-700, spread=0.35)

    crown_join = _n(g, "GeometryNodeJoinGeometry", x=3760, y=0)
    _link(g, green_ring, crown_join.inputs["Geometry"])
    _link(g, dead_ring, crown_join.inputs["Geometry"])
    crown_real = _n(g, "GeometryNodeRealizeInstances", x=3920, y=0)
    _link(g, crown_join.outputs["Geometry"], crown_real.inputs["Geometry"])
    crown_xf = _n(g, "GeometryNodeTransform", x=4080, y=0)
    _link(g, crown_real.outputs["Geometry"], crown_xf.inputs["Geometry"])
    _link(g, samp.outputs["Position"], crown_xf.inputs["Translation"])
    _link(g, crown_align.outputs["Rotation"], crown_xf.inputs["Rotation"])

    # --- Join trunk + crown, COLOR_0 sway by height, output ---
    final_join = _n(g, "GeometryNodeJoinGeometry", x=4240, y=40)
    _link(g, trunk_setmat.outputs["Geometry"], final_join.inputs["Geometry"])
    _link(g, crown_xf.outputs["Geometry"], final_join.inputs["Geometry"])
    # COLOR_0: R = sway = smoothstep(z/Height), G=1 ao, B=0, A=1
    vpos = _n(g, "GeometryNodeInputPosition", x=4240, y=-220)
    vsep = _n(g, "ShaderNodeSeparateXYZ", x=4400, y=-220); _link(g, vpos.outputs["Position"], vsep.inputs["Vector"])
    sway = _n(g, "ShaderNodeMapRange", x=4560, y=-220)
    sway.inputs["From Min"].default_value = 0.0
    _link(g, gin.outputs["Height"], sway.inputs["From Max"])
    sway.inputs["To Min"].default_value = 0.0; sway.inputs["To Max"].default_value = 1.0
    _link(g, vsep.outputs["Z"], sway.inputs["Value"])
    swcol = _n(g, "FunctionNodeCombineColor", x=4720, y=-220)
    _link(g, sway.outputs["Result"], swcol.inputs[0]); swcol.inputs[1].default_value = 1.0; swcol.inputs[2].default_value = 0.0; swcol.inputs[3].default_value = 1.0
    store = _n(g, "GeometryNodeStoreNamedAttribute", x=4900, y=40); store.data_type = "FLOAT_COLOR"; store.domain = "POINT"
    store.inputs["Name"].default_value = "COLOR_0"
    _link(g, final_join.outputs["Geometry"], store.inputs["Geometry"])
    _link(g, swcol.outputs[0], store.inputs["Value"])
    gout.location = (5100, 0)
    _link(g, store.outputs["Geometry"], gout.inputs["Geometry"])
    return g


# --------------------------------------------------------------------------
# Tool 4: Long Ramp — sheet-metal panels along a curve, pitch-controlled
# --------------------------------------------------------------------------
def build_ramp() -> bpy.types.GeometryNodeTree:
    g = _new_tree("HV_Ramp")
    _out(g, "Geometry", "NodeSocketGeometry")
    _in(g, "Geometry", "NodeSocketGeometry")  # the path curve
    _in(g, "Panel Length", "NodeSocketFloat", 1.5, mn=0.3, mx=12.0, subtype="DISTANCE")
    _in(g, "Panel Width", "NodeSocketFloat", 3.4, mn=0.3, mx=14.0, subtype="DISTANCE")
    _in(g, "Overlap", "NodeSocketFloat", 0.16, mn=-0.4, mx=0.7)
    _in(g, "Pitch", "NodeSocketFloat", 0.0, mn=-1.2, mx=1.2, subtype="ANGLE")
    _in(g, "Bank", "NodeSocketFloat", 0.0, mn=-1.2, mx=1.2, subtype="ANGLE")
    _in(g, "Rise", "NodeSocketFloat", 0.04, mn=-1.0, mx=1.0, subtype="DISTANCE")
    _in(g, "Corrugation", "NodeSocketFloat", 0.5, mn=0.0, mx=1.0)
    _in(g, "Dent", "NodeSocketFloat", 0.4, mn=0.0, mx=1.0)
    _in(g, "Seed", "NodeSocketFloat", 0.0)

    gin = _n(g, "NodeGroupInput", x=-1600, y=0)
    gout = _n(g, "NodeGroupOutput", x=1500, y=0)
    metal_mat = _mat("mat_prop_ramp_metal", METAL_RGBA, roughness=0.62, metallic=0.65)

    # Capture the curve's per-point tilt into a generic attribute ("ramp_tilt")
    # BEFORE Curve-to-Points: the built-in "tilt" is NOT carried to resampled
    # points, but a generic float attribute is. Drives per-section banking.
    tilt_in = _n(g, "GeometryNodeInputCurveTilt", x=-1580, y=380)
    tiltcap = _n(g, "GeometryNodeStoreNamedAttribute", x=-1420, y=200)
    tiltcap.data_type = "FLOAT"; tiltcap.domain = "POINT"
    tiltcap.inputs["Name"].default_value = "ramp_tilt"
    _link(g, gin.outputs["Geometry"], tiltcap.inputs["Geometry"])
    _link(g, tilt_in.outputs["Tilt"], tiltcap.inputs["Value"])

    # panel spacing = length * (1 - overlap)
    omov = _n(g, "ShaderNodeMath", x=-1420, y=40, operation="SUBTRACT"); omov.inputs[0].default_value = 1.0
    _link(g, gin.outputs["Overlap"], omov.inputs[1])
    spacing = _n(g, "ShaderNodeMath", x=-1260, y=40, operation="MULTIPLY")
    _link(g, gin.outputs["Panel Length"], spacing.inputs[0]); _link(g, omov.outputs["Value"], spacing.inputs[1])
    spacing_c = _n(g, "ShaderNodeMath", x=-1100, y=40, operation="MAXIMUM"); spacing_c.inputs[1].default_value = 0.12
    _link(g, spacing.outputs["Value"], spacing_c.inputs[0])
    c2p = _n(g, "GeometryNodeCurveToPoints", x=-940, y=200); c2p.mode = "LENGTH"
    _link(g, tiltcap.outputs["Geometry"], c2p.inputs["Curve"]); _link(g, spacing_c.outputs["Value"], c2p.inputs["Length"])

    # ---- panel base mesh ----
    grid = _n(g, "GeometryNodeMeshGrid", x=-1420, y=-360)
    _link(g, gin.outputs["Panel Length"], grid.inputs["Size X"]); _link(g, gin.outputs["Panel Width"], grid.inputs["Size Y"])
    grid.inputs["Vertices X"].default_value = 8; grid.inputs["Vertices Y"].default_value = 14
    gpos = _n(g, "GeometryNodeInputPosition", x=-1420, y=-560)
    gsep = _n(g, "ShaderNodeSeparateXYZ", x=-1260, y=-560); _link(g, gpos.outputs["Position"], gsep.inputs["Vector"])
    # corrugation ribs running along length: z = sin(y*freq)*amp ; freq = 2pi*ribs/width
    ribf = _n(g, "ShaderNodeMath", x=-1260, y=-700, operation="DIVIDE"); ribf.inputs[0].default_value = 6.28319 * 7.0
    _link(g, gin.outputs["Panel Width"], ribf.inputs[1])
    yarg = _n(g, "ShaderNodeMath", x=-1100, y=-640, operation="MULTIPLY")
    _link(g, gsep.outputs["Y"], yarg.inputs[0]); _link(g, ribf.outputs["Value"], yarg.inputs[1])
    ysin = _n(g, "ShaderNodeMath", x=-940, y=-640, operation="SINE")
    _link(g, yarg.outputs["Value"], ysin.inputs[0])
    ramp_amp = _n(g, "ShaderNodeMath", x=-940, y=-780, operation="MULTIPLY"); ramp_amp.inputs[1].default_value = 0.07
    _link(g, gin.outputs["Corrugation"], ramp_amp.inputs[0])
    corr = _n(g, "ShaderNodeMath", x=-780, y=-680, operation="MULTIPLY")
    _link(g, ysin.outputs["Value"], corr.inputs[0]); _link(g, ramp_amp.outputs["Value"], corr.inputs[1])
    dnoise = _n(g, "ShaderNodeTexNoise", x=-940, y=-900); dnoise.inputs["Scale"].default_value = 0.9
    _link(g, gpos.outputs["Position"], dnoise.inputs["Vector"])
    dctr = _n(g, "ShaderNodeMath", x=-780, y=-900, operation="MULTIPLY_ADD"); dctr.inputs[2].default_value = 0.0
    _link(g, dnoise.outputs["Fac"], dctr.inputs[0])
    damt = _n(g, "ShaderNodeMath", x=-940, y=-1040, operation="MULTIPLY"); damt.inputs[1].default_value = 0.11
    _link(g, gin.outputs["Dent"], damt.inputs[0]); _link(g, damt.outputs["Value"], dctr.inputs[1])
    doff = _n(g, "ShaderNodeMath", x=-620, y=-1020, operation="MULTIPLY"); doff.inputs[1].default_value = -0.5
    _link(g, damt.outputs["Value"], doff.inputs[0])
    # recompute dent centred: (fac-0.5)*amt  -> use MULTIPLY_ADD value*amt + (-0.5*amt)
    _link(g, doff.outputs["Value"], dctr.inputs[2])
    zsum = _n(g, "ShaderNodeMath", x=-620, y=-760, operation="ADD")
    _link(g, corr.outputs["Value"], zsum.inputs[0]); _link(g, dctr.outputs["Value"], zsum.inputs[1])
    zvec = _n(g, "ShaderNodeCombineXYZ", x=-460, y=-760); _link(g, zsum.outputs["Value"], zvec.inputs["Z"])
    gsetpos = _n(g, "GeometryNodeSetPosition", x=-460, y=-360)
    _link(g, grid.outputs["Mesh"], gsetpos.inputs["Geometry"]); _link(g, zvec.outputs["Vector"], gsetpos.inputs["Offset"])
    gsmooth = _n(g, "GeometryNodeSetShadeSmooth", x=-300, y=-360)
    _link(g, gsetpos.outputs["Geometry"], gsmooth.inputs["Geometry"])
    # pre-rotate panel by (Bank, -Pitch, 0) in local space
    negp = _n(g, "ShaderNodeMath", x=-460, y=-200, operation="MULTIPLY"); negp.inputs[1].default_value = -1.0
    _link(g, gin.outputs["Pitch"], negp.inputs[0])
    protvec = _n(g, "ShaderNodeCombineXYZ", x=-300, y=-200)
    _link(g, gin.outputs["Bank"], protvec.inputs["X"]); _link(g, negp.outputs["Value"], protvec.inputs["Y"])
    pxf = _n(g, "GeometryNodeTransform", x=-140, y=-360)
    _link(g, gsmooth.outputs["Geometry"], pxf.inputs["Geometry"]); _link(g, protvec.outputs["Vector"], pxf.inputs["Rotation"])

    # ---- instance panels along curve ----
    riseoff = _n(g, "ShaderNodeCombineXYZ", x=-940, y=380); _link(g, gin.outputs["Rise"], riseoff.inputs["Z"])
    ptsraise = _n(g, "GeometryNodeSetPosition", x=-780, y=200)
    _link(g, c2p.outputs["Points"], ptsraise.inputs["Geometry"]); _link(g, riseoff.outputs["Vector"], ptsraise.inputs["Offset"])
    # Explicit panel orientation (Blender 5.1's Curve-to-Points Rotation puts
    # +Z on the tangent, which stood the panels up on edge). Instead:
    #   1) align panel +X to the 3-D tangent  -> length runs along the path,
    #      pitching to follow the curve's slope.
    #   2) roll about that X until panel +Z points world-up -> panel lies FLAT
    #      (driving surface up) with no twist, no hand-set Pitch/tilt needed.
    e1 = _n(g, "FunctionNodeAlignEulerToVector", x=-360, y=320); e1.axis = "X"; e1.pivot_axis = "AUTO"
    _link(g, c2p.outputs["Tangent"], e1.inputs["Vector"])
    # roll +Z to WORLD-UP -> panel lies FLAT (driving surface up). Reliable on
    # any curve; the curve-NORMAL "Z Up" mode is unreliable across curve types
    # in 5.1 (it can sit sideways, standing the panels up as a wall).
    worldup = _n(g, "ShaderNodeCombineXYZ", x=-360, y=460); worldup.inputs["Z"].default_value = 1.0
    # Banking: rotate the UP reference around the tangent by the curve point's
    # tilt (captured as "ramp_tilt"), then align panel +Z to that. tilt=0 ->
    # world up (panel FLAT, no wall); editing a point's tilt banks that section.
    tiltattr = _n(g, "GeometryNodeInputNamedAttribute", x=-540, y=560); tiltattr.data_type = "FLOAT"
    tiltattr.inputs["Name"].default_value = "ramp_tilt"
    tiltedup = _n(g, "ShaderNodeVectorRotate", x=-360, y=560); tiltedup.rotation_type = "AXIS_ANGLE"
    _link(g, worldup.outputs["Vector"], tiltedup.inputs["Vector"])
    _link(g, c2p.outputs["Tangent"], tiltedup.inputs["Axis"])
    _link(g, tiltattr.outputs["Attribute"], tiltedup.inputs["Angle"])
    e2 = _n(g, "FunctionNodeAlignEulerToVector", x=-180, y=320); e2.axis = "Z"; e2.pivot_axis = "X"
    _link(g, e1.outputs["Rotation"], e2.inputs["Rotation"]); _link(g, tiltedup.outputs["Vector"], e2.inputs["Vector"])
    iop = _n(g, "GeometryNodeInstanceOnPoints", x=140, y=120)
    _link(g, ptsraise.outputs["Geometry"], iop.inputs["Points"])
    _link(g, pxf.outputs["Geometry"], iop.inputs["Instance"])
    _link(g, e2.outputs["Rotation"], iop.inputs["Rotation"])
    setmat = _n(g, "GeometryNodeSetMaterial", x=320, y=120)
    setmat.inputs["Material"].default_value = metal_mat
    _link(g, iop.outputs["Instances"], setmat.inputs["Geometry"])
    realize = _n(g, "GeometryNodeRealizeInstances", x=700, y=120)
    _link(g, setmat.outputs["Geometry"], realize.inputs["Geometry"])
    store = _store_color0(g, realize.outputs["Geometry"], rgba=(1.0, 1.0, 0.0, 0.0)); store.location = (900, 120)
    _link(g, store.outputs["Geometry"], gout.inputs["Geometry"])
    return g


# --------------------------------------------------------------------------
# Tool 5: Sea Arch — parametric eroded rock arch (generator)
# --------------------------------------------------------------------------
def build_sea_arch() -> bpy.types.GeometryNodeTree:
    g = _new_tree("HV_SeaArch")
    _out(g, "Geometry", "NodeSocketGeometry")
    _in(g, "Geometry", "NodeSocketGeometry")  # ignored (generator)
    _in(g, "Span", "NodeSocketFloat", 16.0, mn=2.0, mx=80.0, subtype="DISTANCE")
    _in(g, "Height", "NodeSocketFloat", 12.0, mn=2.0, mx=70.0, subtype="DISTANCE")
    _in(g, "Thickness", "NodeSocketFloat", 2.6, mn=0.3, mx=18.0, subtype="DISTANCE")
    _in(g, "Leg Spread", "NodeSocketFloat", 0.8, mn=0.0, mx=2.5)
    _in(g, "Lean", "NodeSocketFloat", 0.08, mn=-0.6, mx=0.6)
    _in(g, "Sides", "NodeSocketInt", 8, mn=4, mx=28)
    _in(g, "Jaggedness", "NodeSocketFloat", 0.42, mn=0.0, mx=1.4)
    _in(g, "Thickness Var", "NodeSocketFloat", 0.35, mn=0.0, mx=1.0)
    _in(g, "Facets", "NodeSocketFloat", 0.5, mn=0.0, mx=1.5)
    _in(g, "Boulder Cluster", "NodeSocketBool", True)
    _in(g, "Boulder Size", "NodeSocketFloat", 3.4, mn=0.3, mx=20.0, subtype="DISTANCE")
    _in(g, "Boulder Density", "NodeSocketFloat", 0.9, mn=0.2, mx=3.0)
    _in(g, "Seed", "NodeSocketFloat", 0.0)

    gin = _n(g, "NodeGroupInput", x=-1900, y=0)
    gout = _n(g, "NodeGroupOutput", x=2900, y=0)
    mat = _mat("mat_prop_sea_arch", ROCK_RGBA, roughness=0.9)

    line = _n(g, "GeometryNodeCurvePrimitiveLine", x=-1720, y=200)
    line.inputs["End"].default_value = (0.0, 0.0, 1.0)
    resample = _n(g, "GeometryNodeResampleCurve", x=-1560, y=200); resample.inputs["Count"].default_value = 48
    _link(g, line.outputs["Curve"], resample.inputs["Curve"])
    sp = _n(g, "GeometryNodeSplineParameter", x=-1560, y=-40)
    theta = _n(g, "ShaderNodeMath", x=-1400, y=-40, operation="MULTIPLY"); theta.inputs[1].default_value = math.pi
    _link(g, sp.outputs["Factor"], theta.inputs[0])
    cosT = _n(g, "ShaderNodeMath", x=-1240, y=40, operation="COSINE"); _link(g, theta.outputs["Value"], cosT.inputs[0])
    sinT = _n(g, "ShaderNodeMath", x=-1240, y=-120, operation="SINE"); _link(g, theta.outputs["Value"], sinT.inputs[0])
    # x = -Span/2 * cosT + Lean*Height*sinT
    halfspan = _n(g, "ShaderNodeMath", x=-1400, y=160, operation="MULTIPLY"); halfspan.inputs[1].default_value = -0.5
    _link(g, gin.outputs["Span"], halfspan.inputs[0])
    xlimb = _n(g, "ShaderNodeMath", x=-1080, y=120, operation="MULTIPLY")
    _link(g, halfspan.outputs["Value"], xlimb.inputs[0]); _link(g, cosT.outputs["Value"], xlimb.inputs[1])
    leanh = _n(g, "ShaderNodeMath", x=-1240, y=240, operation="MULTIPLY")
    _link(g, gin.outputs["Lean"], leanh.inputs[0]); _link(g, gin.outputs["Height"], leanh.inputs[1])
    leant = _n(g, "ShaderNodeMath", x=-1080, y=260, operation="MULTIPLY")
    _link(g, leanh.outputs["Value"], leant.inputs[0]); _link(g, sinT.outputs["Value"], leant.inputs[1])
    xpos = _n(g, "ShaderNodeMath", x=-920, y=160, operation="ADD")
    _link(g, xlimb.outputs["Value"], xpos.inputs[0]); _link(g, leant.outputs["Value"], xpos.inputs[1])
    # z = Height * sinT
    zpos = _n(g, "ShaderNodeMath", x=-1080, y=-120, operation="MULTIPLY")
    _link(g, gin.outputs["Height"], zpos.inputs[0]); _link(g, sinT.outputs["Value"], zpos.inputs[1])
    # y wander
    ynoise = _n(g, "ShaderNodeTexNoise", x=-1240, y=-320); ynoise.noise_dimensions = "4D"; ynoise.inputs["Scale"].default_value = 1.4
    _link(g, sp.outputs["Factor"], ynoise.inputs["W"]); _link(g, gin.outputs["Seed"], ynoise.inputs["Vector"])
    yctr = _n(g, "ShaderNodeMath", x=-1080, y=-320, operation="SUBTRACT"); yctr.inputs[1].default_value = 0.5
    _link(g, ynoise.outputs["Fac"], yctr.inputs[0])
    yamt = _n(g, "ShaderNodeMath", x=-920, y=-320, operation="MULTIPLY"); yamt.inputs[1].default_value = 0.5
    _link(g, yctr.outputs["Value"], yamt.inputs[0]); _link(g, gin.outputs["Thickness"], yamt.inputs[1])
    posv = _n(g, "ShaderNodeCombineXYZ", x=-760, y=40)
    _link(g, xpos.outputs["Value"], posv.inputs["X"]); _link(g, yamt.outputs["Value"], posv.inputs["Y"]); _link(g, zpos.outputs["Value"], posv.inputs["Z"])
    setpos = _n(g, "GeometryNodeSetPosition", x=-600, y=200)
    _link(g, resample.outputs["Curve"], setpos.inputs["Geometry"]); _link(g, posv.outputs["Vector"], setpos.inputs["Position"])

    # radius: thinner over the crown, flared feet, noisy
    footF = _n(g, "ShaderNodeMath", x=-1080, y=-460, operation="ABSOLUTE"); _link(g, cosT.outputs["Value"], footF.inputs[0])
    footF2 = _n(g, "ShaderNodeMath", x=-920, y=-460, operation="POWER"); footF2.inputs[1].default_value = 1.6
    _link(g, footF.outputs["Value"], footF2.inputs[0])
    # plant the feet just slightly below ground so legs read as embedded
    sinkb = _n(g, "ShaderNodeMath", x=-760, y=-380, operation="MULTIPLY")
    _link(g, footF2.outputs["Value"], sinkb.inputs[0]); _link(g, gin.outputs["Thickness"], sinkb.inputs[1])
    sinka = _n(g, "ShaderNodeMath", x=-600, y=-380, operation="MULTIPLY"); sinka.inputs[1].default_value = 0.18
    _link(g, sinkb.outputs["Value"], sinka.inputs[0])
    zfin = _n(g, "ShaderNodeMath", x=-600, y=-160, operation="SUBTRACT")
    _link(g, zpos.outputs["Value"], zfin.inputs[0]); _link(g, sinka.outputs["Value"], zfin.inputs[1])
    _link(g, zfin.outputs["Value"], posv.inputs["Z"])
    crown = _n(g, "ShaderNodeMath", x=-920, y=-600, operation="MULTIPLY_ADD"); crown.inputs[1].default_value = -0.16; crown.inputs[2].default_value = 1.0
    _link(g, sinT.outputs["Value"], crown.inputs[0])
    radbase = _n(g, "ShaderNodeMath", x=-760, y=-520, operation="MULTIPLY")
    _link(g, gin.outputs["Thickness"], radbase.inputs[0]); _link(g, crown.outputs["Value"], radbase.inputs[1])
    flare = _n(g, "ShaderNodeMath", x=-760, y=-660, operation="MULTIPLY")
    _link(g, gin.outputs["Leg Spread"], flare.inputs[0]); _link(g, footF2.outputs["Value"], flare.inputs[1])
    flaret = _n(g, "ShaderNodeMath", x=-600, y=-660, operation="MULTIPLY")
    _link(g, flare.outputs["Value"], flaret.inputs[0]); _link(g, gin.outputs["Thickness"], flaret.inputs[1])
    radsum = _n(g, "ShaderNodeMath", x=-440, y=-560, operation="ADD")
    _link(g, radbase.outputs["Value"], radsum.inputs[0]); _link(g, flaret.outputs["Value"], radsum.inputs[1])
    # thickness variation noise
    rnoise = _n(g, "ShaderNodeTexNoise", x=-760, y=-820); rnoise.noise_dimensions = "4D"; rnoise.inputs["Scale"].default_value = 2.2
    _link(g, sp.outputs["Factor"], rnoise.inputs["W"]); _link(g, gin.outputs["Seed"], rnoise.inputs["Vector"])
    rvar = _n(g, "ShaderNodeMath", x=-600, y=-820, operation="MULTIPLY_ADD")
    _link(g, rnoise.outputs["Fac"], rvar.inputs[0]); _link(g, gin.outputs["Thickness Var"], rvar.inputs[1])
    rvneg = _n(g, "ShaderNodeMath", x=-600, y=-960, operation="MULTIPLY"); rvneg.inputs[1].default_value = -0.5
    _link(g, gin.outputs["Thickness Var"], rvneg.inputs[0])
    # rfactor = 1 + Var*(noise-0.5)
    rvar.inputs[2].default_value = 0.0
    _link(g, rvneg.outputs["Value"], rvar.inputs[2])
    rfac = _n(g, "ShaderNodeMath", x=-440, y=-820, operation="ADD"); rfac.inputs[1].default_value = 1.0
    _link(g, rvar.outputs["Value"], rfac.inputs[0])
    rad = _n(g, "ShaderNodeMath", x=-280, y=-620, operation="MULTIPLY")
    _link(g, radsum.outputs["Value"], rad.inputs[0]); _link(g, rfac.outputs["Value"], rad.inputs[1])
    radclamp = _n(g, "ShaderNodeMath", x=-120, y=-620, operation="MAXIMUM"); radclamp.inputs[1].default_value = 0.15
    _link(g, rad.outputs["Value"], radclamp.inputs[0])
    rstore = _n(g, "GeometryNodeStoreNamedAttribute", x=-440, y=200); rstore.data_type = "FLOAT"; rstore.domain = "POINT"
    rstore.inputs["Name"].default_value = "arch_r"
    _link(g, setpos.outputs["Geometry"], rstore.inputs["Geometry"]); _link(g, radclamp.outputs["Value"], rstore.inputs["Value"])
    setrad = _n(g, "GeometryNodeSetCurveRadius", x=-120, y=200)
    _link(g, rstore.outputs["Geometry"], setrad.inputs["Curve"]); _link(g, radclamp.outputs["Value"], setrad.inputs["Radius"])
    circ = _n(g, "GeometryNodeCurvePrimitiveCircle", x=-120, y=-40); circ.mode = "RADIUS"
    _link(g, gin.outputs["Sides"], circ.inputs["Resolution"]); circ.inputs["Radius"].default_value = 1.0
    ctm = _n(g, "GeometryNodeCurveToMesh", x=80, y=160)
    _link(g, setrad.outputs["Curve"], ctm.inputs["Curve"]); _link(g, circ.outputs["Curve"], ctm.inputs["Profile Curve"])
    ctm.inputs["Fill Caps"].default_value = True
    _radius_to_scale(g, ctm, x=-80, y=320)
    sub = _n(g, "GeometryNodeSubdivideMesh", x=240, y=160); sub.inputs["Level"].default_value = 1
    _link(g, ctm.outputs["Mesh"], sub.inputs["Mesh"])

    # rock displacement (thickness-scaled, faceted)
    pos = _n(g, "GeometryNodeInputPosition", x=80, y=-200)
    nrm = _n(g, "GeometryNodeInputNormal", x=80, y=-300)
    rattr = _n(g, "GeometryNodeInputNamedAttribute", x=80, y=-400); rattr.data_type = "FLOAT"; rattr.inputs["Name"].default_value = "arch_r"
    n1 = _n(g, "ShaderNodeTexNoise", x=240, y=-280); n1.noise_dimensions = "4D"; n1.inputs["Scale"].default_value = 0.5
    n1.inputs["Detail"].default_value = 7.0; n1.inputs["Roughness"].default_value = 0.7
    _link(g, pos.outputs["Position"], n1.inputs["Vector"]); _link(g, gin.outputs["Seed"], n1.inputs["W"])
    n2 = _n(g, "ShaderNodeTexNoise", x=240, y=-440); n2.noise_dimensions = "4D"; n2.inputs["Scale"].default_value = 1.4
    _link(g, pos.outputs["Position"], n2.inputs["Vector"]); _link(g, gin.outputs["Seed"], n2.inputs["W"])
    c1 = _n(g, "ShaderNodeMath", x=400, y=-280, operation="MULTIPLY_ADD"); c1.inputs[1].default_value = 0.62; c1.inputs[2].default_value = -0.31
    _link(g, n1.outputs["Fac"], c1.inputs[0])
    c2 = _n(g, "ShaderNodeMath", x=400, y=-440, operation="MULTIPLY_ADD"); c2.inputs[1].default_value = 0.5; c2.inputs[2].default_value = -0.25
    _link(g, n2.outputs["Fac"], c2.inputs[0])
    dsum = _n(g, "ShaderNodeMath", x=560, y=-360, operation="ADD")
    _link(g, c1.outputs["Value"], dsum.inputs[0]); _link(g, c2.outputs["Value"], dsum.inputs[1])
    facet = _facet_term(g, pos.outputs["Position"], gin.outputs["Facets"], scale=0.16, x0=200, y0=-680, gain=3.0)
    dsum2 = _n(g, "ShaderNodeMath", x=700, y=-360, operation="ADD")
    _link(g, dsum.outputs["Value"], dsum2.inputs[0]); _link(g, facet, dsum2.inputs[1])
    dscale = _n(g, "ShaderNodeMath", x=560, y=-520, operation="MULTIPLY")
    _link(g, rattr.outputs["Attribute"], dscale.inputs[0]); _link(g, gin.outputs["Jaggedness"], dscale.inputs[1])
    dmag = _n(g, "ShaderNodeMath", x=860, y=-420, operation="MULTIPLY")
    _link(g, dsum2.outputs["Value"], dmag.inputs[0]); _link(g, dscale.outputs["Value"], dmag.inputs[1])
    dvec = _n(g, "ShaderNodeVectorMath", x=720, y=-260, operation="SCALE")
    _link(g, nrm.outputs["Normal"], dvec.inputs[0]); _link(g, dmag.outputs["Value"], dvec.inputs["Scale"])
    dpos = _n(g, "GeometryNodeSetPosition", x=420, y=160)
    _link(g, sub.outputs["Mesh"], dpos.inputs["Geometry"]); _link(g, dvec.outputs["Vector"], dpos.inputs["Offset"])
    flat = _n(g, "GeometryNodeSetShadeSmooth", x=600, y=160); flat.inputs["Shade Smooth"].default_value = False
    _link(g, dpos.outputs["Geometry"], flat.inputs["Geometry"])
    # optional boulder-cluster pass (toggle, default on): scatter HV_Rock chunks
    # over the arch and boolean-union them into one faceted rock mass.
    bspace = _n(g, "ShaderNodeMath", x=700, y=-1500, operation="DIVIDE")  # spacing = Size / Density
    _link(g, gin.outputs["Boulder Size"], bspace.inputs[0]); _link(g, gin.outputs["Boulder Density"], bspace.inputs[1])
    cluster = _rock_cluster(g, flat.outputs["Geometry"], gin.outputs["Boulder Size"],
                            bspace.outputs["Value"], gin.outputs["Seed"], x0=900, y0=-1500)
    sw = _n(g, "GeometryNodeSwitch", x=2300, y=160); sw.input_type = "GEOMETRY"
    _link(g, gin.outputs["Boulder Cluster"], sw.inputs["Switch"])
    _link(g, flat.outputs["Geometry"], sw.inputs["False"]); _link(g, cluster, sw.inputs["True"])
    store = _store_color0(g, sw.outputs["Output"], rgba=(1.0, 1.0, 0.0, 0.0)); store.location = (2480, 160)
    sm = _set_material(g, store.outputs["Geometry"], mat); sm.location = (2660, 160)
    _link(g, sm.outputs["Geometry"], gout.inputs["Geometry"])
    return g


# --------------------------------------------------------------------------
# Tool 6: Rock — boolean-carved faceted boulder (generator)
#
# In the spirit of Entagma's procedural crystal: a lumpy ico-sphere base is
# whittled down by a swarm of large, randomly-tilted cutter slabs that are
# subtracted ONE AT A TIME inside a Repeat Zone. (Mesh booleans are
# unreliable when many cutters intersect at once, so we loop the cut and
# feed the loop index a single cutter per pass via Separate Geometry on the
# instance domain.) The flat planes left behind read as crystal/rock facets.
# We skip the crystal's internal planes + dispersion glass shading entirely.
#
# (An "edge damage" stage that chipped every facet edge with a noise-driven
# Points-to-Volume boolean was cut for now -- the chips read too small to be
# worth the cost; recover it from git history if you want it back.)
#
# Cost scales with the cut count (one exact boolean per cut). "Cut Spacing"
# is the throttle: small values mean many facets and a slow bake. Iterations
# are hard-capped at 80 so a pathological setting can't hang Blender.
# --------------------------------------------------------------------------
def build_rock() -> bpy.types.GeometryNodeTree:
    g = _new_tree("HV_Rock")
    _out(g, "Geometry", "NodeSocketGeometry")
    _in(g, "Geometry", "NodeSocketGeometry")  # ignored (generator)
    _in(g, "Size", "NodeSocketFloat", 5.0, mn=0.5, mx=60.0, subtype="DISTANCE")
    _in(g, "Flatten", "NodeSocketFloat", 0.82, mn=0.2, mx=1.6)
    _in(g, "Lumpiness", "NodeSocketFloat", 0.4, mn=0.0, mx=1.0)
    _in(g, "Cut Spacing", "NodeSocketFloat", 1.7, mn=0.4, mx=12.0, subtype="DISTANCE")
    _in(g, "Cut Depth", "NodeSocketFloat", 0.15, mn=0.02, mx=0.6)
    _in(g, "Depth Jitter", "NodeSocketFloat", 0.4, mn=0.0, mx=1.0)
    _in(g, "Tilt", "NodeSocketFloat", 0.3, mn=0.0, mx=1.2, subtype="ANGLE")
    _in(g, "Seed", "NodeSocketFloat", 0.0)

    gin = _n(g, "NodeGroupInput", x=-2200, y=0)
    gout = _n(g, "NodeGroupOutput", x=2240, y=0)
    rock_mat = _mat("mat_prop_rock", ROCK_RGBA, roughness=0.92)

    # nominal cut depth d = Cut Depth * Size (world units). Because every cut is
    # a global half-space d below the surface, the carved stone ends up ~2d
    # smaller per axis -- so we GROW the base box by 2d first and the result
    # still measures ~Size (x/y) and ~Size*Flatten (z).
    dnom = _n(g, "ShaderNodeMath", x=-2000, y=360, operation="MULTIPLY")
    _link(g, gin.outputs["Cut Depth"], dnom.inputs[0]); _link(g, gin.outputs["Size"], dnom.inputs[1])
    grow = _n(g, "ShaderNodeMath", x=-1840, y=360, operation="MULTIPLY"); grow.inputs[1].default_value = 1.0
    _link(g, dnom.outputs["Value"], grow.inputs[0])

    # ---- base ellipsoid: an ico-sphere (radius (Size+grow)/2, squashed in Z by
    # Flatten) with low-freq lumps. Unlike a box, a sphere has no corners for the
    # cuts to pile up on, so shallow facet cuts flatten its surface into clean
    # planes WITHOUT collapsing the stone down to a sliver. ----
    zf = _n(g, "ShaderNodeMath", x=-1980, y=200, operation="MULTIPLY")  # Size*Flatten
    _link(g, gin.outputs["Size"], zf.inputs[0]); _link(g, gin.outputs["Flatten"], zf.inputs[1])
    zb = _n(g, "ShaderNodeMath", x=-1820, y=160, operation="ADD")  # + grow
    _link(g, zf.outputs["Value"], zb.inputs[0]); _link(g, grow.outputs["Value"], zb.inputs[1])
    xyb = _n(g, "ShaderNodeMath", x=-1820, y=300, operation="ADD")  # Size + grow
    _link(g, gin.outputs["Size"], xyb.inputs[0]); _link(g, grow.outputs["Value"], xyb.inputs[1])
    rad = _n(g, "ShaderNodeMath", x=-1660, y=320, operation="MULTIPLY"); rad.inputs[1].default_value = 0.5
    _link(g, xyb.outputs["Value"], rad.inputs[0])
    sph = _n(g, "GeometryNodeMeshIcoSphere", x=-1500, y=320)
    # coarse on purpose: a 2-subdiv ico is ALREADY faceted, so any patch the
    # cuts miss reads as a flat plane, not a smooth dome.
    sph.inputs["Subdivisions"].default_value = 2
    _link(g, rad.outputs["Value"], sph.inputs["Radius"])
    zscale = _n(g, "ShaderNodeMath", x=-1660, y=140, operation="DIVIDE")  # zb/xyb
    _link(g, zb.outputs["Value"], zscale.inputs[0]); _link(g, xyb.outputs["Value"], zscale.inputs[1])
    sqz = _n(g, "ShaderNodeCombineXYZ", x=-1500, y=120)
    sqz.inputs["X"].default_value = 1.0; sqz.inputs["Y"].default_value = 1.0
    _link(g, zscale.outputs["Value"], sqz.inputs["Z"])
    ell = _n(g, "GeometryNodeTransform", x=-1320, y=260)
    _link(g, sph.outputs["Mesh"], ell.inputs["Geometry"]); _link(g, sqz.outputs["Vector"], ell.inputs["Scale"])
    bpos = _n(g, "GeometryNodeInputPosition", x=-1580, y=-40)
    bn = _n(g, "ShaderNodeTexNoise", x=-1420, y=-60); bn.noise_dimensions = "4D"; bn.inputs["Scale"].default_value = 1.1
    _link(g, bpos.outputs["Position"], bn.inputs["Vector"]); _link(g, gin.outputs["Seed"], bn.inputs["W"])
    bnc = _n(g, "ShaderNodeMath", x=-1260, y=-60, operation="MULTIPLY_ADD"); bnc.inputs[1].default_value = 1.0; bnc.inputs[2].default_value = -0.5
    _link(g, bn.outputs["Fac"], bnc.inputs[0])
    bamt = _n(g, "ShaderNodeMath", x=-1260, y=-200, operation="MULTIPLY"); bamt.inputs[1].default_value = 0.22
    _link(g, gin.outputs["Lumpiness"], bamt.inputs[0])
    bamt2 = _n(g, "ShaderNodeMath", x=-1100, y=-200, operation="MULTIPLY")
    _link(g, bamt.outputs["Value"], bamt2.inputs[0]); _link(g, gin.outputs["Size"], bamt2.inputs[1])
    bdsp = _n(g, "ShaderNodeMath", x=-1100, y=-60, operation="MULTIPLY")
    _link(g, bnc.outputs["Value"], bdsp.inputs[0]); _link(g, bamt2.outputs["Value"], bdsp.inputs[1])
    bnrm = _n(g, "GeometryNodeInputNormal", x=-1260, y=80)
    bvec = _n(g, "ShaderNodeVectorMath", x=-940, y=20, operation="SCALE")
    _link(g, bnrm.outputs["Normal"], bvec.inputs[0]); _link(g, bdsp.outputs["Value"], bvec.inputs["Scale"])
    base = _n(g, "GeometryNodeSetPosition", x=-780, y=200)
    _link(g, ell.outputs["Geometry"], base.inputs["Geometry"]); _link(g, bvec.outputs["Vector"], base.inputs["Offset"])

    # ---- scatter cut points + build the cutter swarm ----
    dist = _n(g, "GeometryNodeDistributePointsOnFaces", x=-620, y=440, distribute_method="POISSON")
    _link(g, base.outputs["Geometry"], dist.inputs["Mesh"])
    _link(g, gin.outputs["Cut Spacing"], dist.inputs["Distance Min"])
    dist.inputs["Density Max"].default_value = 60.0
    _link(g, gin.outputs["Seed"], dist.inputs["Seed"])
    pidx = _n(g, "GeometryNodeInputIndex", x=-620, y=620)

    # cutter is a BIG cube (4x Size) so only its -Z face touches the rock: it
    # acts as a clean half-space cutting plane (no side-notching). Pre-shift +Z
    # by half its height so that -Z cutting face lands at the instance origin.
    foot = _n(g, "ShaderNodeMath", x=-820, y=-380, operation="MULTIPLY"); foot.inputs[1].default_value = 4.0
    _link(g, gin.outputs["Size"], foot.inputs[0])
    cutsz = _n(g, "ShaderNodeCombineXYZ", x=-660, y=-360)
    _link(g, foot.outputs["Value"], cutsz.inputs["X"]); _link(g, foot.outputs["Value"], cutsz.inputs["Y"]); _link(g, foot.outputs["Value"], cutsz.inputs["Z"])
    cutter = _n(g, "GeometryNodeMeshCube", x=-500, y=-360)
    _link(g, cutsz.outputs["Vector"], cutter.inputs["Size"])
    chalf = _n(g, "ShaderNodeMath", x=-660, y=-520, operation="MULTIPLY"); chalf.inputs[1].default_value = 0.5
    _link(g, foot.outputs["Value"], chalf.inputs[0])
    cup = _n(g, "ShaderNodeCombineXYZ", x=-500, y=-520); _link(g, chalf.outputs["Value"], cup.inputs["Z"])
    cutxf = _n(g, "GeometryNodeTransform", x=-340, y=-360)
    _link(g, cutter.outputs["Mesh"], cutxf.inputs["Geometry"]); _link(g, cup.outputs["Vector"], cutxf.inputs["Translation"])

    # orientation: align cutter +Z to the surface normal, add per-cut random tilt
    al = _n(g, "FunctionNodeAlignEulerToVector", x=-620, y=820); al.axis = "Z"; al.pivot_axis = "AUTO"
    _link(g, dist.outputs["Normal"], al.inputs["Vector"])
    rv = _n(g, "FunctionNodeRandomValue", x=-620, y=1000); rv.data_type = "FLOAT_VECTOR"
    rv.inputs[0].default_value = (-1.0, -1.0, -1.0); rv.inputs[1].default_value = (1.0, 1.0, 1.0)
    _link(g, pidx.outputs["Index"], rv.inputs["ID"]); _link(g, gin.outputs["Seed"], rv.inputs["Seed"])
    rvs = _n(g, "ShaderNodeVectorMath", x=-440, y=1000, operation="SCALE")
    _link(g, rv.outputs[0], rvs.inputs[0]); _link(g, gin.outputs["Tilt"], rvs.inputs["Scale"])
    erot = _n(g, "ShaderNodeVectorMath", x=-280, y=860, operation="ADD")
    _link(g, al.outputs["Rotation"], erot.inputs[0]); _link(g, rvs.outputs["Vector"], erot.inputs[1])

    # push each cut plane inward by a JITTERED depth di = d * (1 - Jitter*rand01):
    # the jitter only makes a cut SHALLOWER (never deeper), so some facets bulge
    # outward -> uneven, rocky planes, while the stone can never erode past its
    # baseline radius and vanish. (rand uses a +37 seed offset to decorrelate
    # depth from tilt.)
    djs = _n(g, "ShaderNodeMath", x=-820, y=-180, operation="ADD"); djs.inputs[1].default_value = 37.0
    _link(g, gin.outputs["Seed"], djs.inputs[0])
    rvd = _n(g, "FunctionNodeRandomValue", x=-660, y=-180); rvd.data_type = "FLOAT"
    rvd.inputs[2].default_value = -1.0; rvd.inputs[3].default_value = 1.0
    _link(g, pidx.outputs["Index"], rvd.inputs["ID"]); _link(g, djs.outputs["Value"], rvd.inputs["Seed"])
    r01 = _n(g, "ShaderNodeMath", x=-560, y=-180, operation="MULTIPLY_ADD"); r01.inputs[1].default_value = 0.5; r01.inputs[2].default_value = 0.5
    _link(g, rvd.outputs[1], r01.inputs[0])
    djm = _n(g, "ShaderNodeMath", x=-420, y=-200, operation="MULTIPLY")
    _link(g, r01.outputs["Value"], djm.inputs[0]); _link(g, gin.outputs["Depth Jitter"], djm.inputs[1])
    djp = _n(g, "ShaderNodeMath", x=-280, y=-200, operation="SUBTRACT"); djp.inputs[0].default_value = 1.0
    _link(g, djm.outputs["Value"], djp.inputs[1])
    di = _n(g, "ShaderNodeMath", x=-140, y=-140, operation="MULTIPLY")
    _link(g, dnom.outputs["Value"], di.inputs[0]); _link(g, djp.outputs["Value"], di.inputs[1])
    dneg = _n(g, "ShaderNodeMath", x=-20, y=-140, operation="MULTIPLY"); dneg.inputs[1].default_value = -1.0
    _link(g, di.outputs["Value"], dneg.inputs[0])
    poff = _n(g, "ShaderNodeVectorMath", x=140, y=-100, operation="SCALE")
    _link(g, dist.outputs["Normal"], poff.inputs[0]); _link(g, dneg.outputs["Value"], poff.inputs["Scale"])
    cpts = _n(g, "GeometryNodeSetPosition", x=300, y=440)
    _link(g, dist.outputs["Points"], cpts.inputs["Geometry"]); _link(g, poff.outputs["Vector"], cpts.inputs["Offset"])

    iop = _n(g, "GeometryNodeInstanceOnPoints", x=460, y=440)
    _link(g, cpts.outputs["Geometry"], iop.inputs["Points"])
    _link(g, cutxf.outputs["Geometry"], iop.inputs["Instance"])
    _link(g, erot.outputs["Vector"], iop.inputs["Rotation"])

    # iterations = min(cut count, 80) so a fine Cut Spacing can't hang the bake
    dsz = _n(g, "GeometryNodeAttributeDomainSize", x=460, y=200); dsz.component = "INSTANCES"
    _link(g, iop.outputs["Instances"], dsz.inputs["Geometry"])
    icap = _n(g, "ShaderNodeMath", x=640, y=200, operation="MINIMUM"); icap.inputs[1].default_value = 80.0
    _link(g, dsz.outputs["Instance Count"], icap.inputs[0])

    # ---- carve: subtract ONE cutter per repeat iteration ----
    rin = _n(g, "GeometryNodeRepeatInput", x=820, y=440)
    rout = _n(g, "GeometryNodeRepeatOutput", x=1560, y=440)
    rin.pair_with_output(rout)
    rout.repeat_items[0].name = "Rock"
    rout.repeat_items.new("GEOMETRY", "Cutters")
    _link(g, icap.outputs["Value"], rin.inputs["Iterations"])
    _link(g, base.outputs["Geometry"], rin.inputs["Rock"])
    _link(g, iop.outputs["Instances"], rin.inputs["Cutters"])
    # pick the instance whose index == current iteration, realise it to a mesh
    li = _n(g, "GeometryNodeInputIndex", x=940, y=640)
    cmp = _n(g, "FunctionNodeCompare", x=1080, y=640); cmp.data_type = "INT"; cmp.operation = "EQUAL"
    _link(g, li.outputs["Index"], cmp.inputs[2]); _link(g, rin.outputs["Iteration"], cmp.inputs[3])
    one = _n(g, "GeometryNodeSeparateGeometry", x=1080, y=500); one.domain = "INSTANCE"
    _link(g, rin.outputs["Cutters"], one.inputs["Geometry"]); _link(g, cmp.outputs[0], one.inputs["Selection"])
    real = _n(g, "GeometryNodeRealizeInstances", x=1240, y=500)
    _link(g, one.outputs["Selection"], real.inputs["Geometry"])
    boo = _n(g, "GeometryNodeMeshBoolean", x=1380, y=440); boo.operation = "DIFFERENCE"
    _link(g, rin.outputs["Rock"], boo.inputs["Mesh 1"]); _link(g, real.outputs["Geometry"], boo.inputs["Mesh 2"])
    _link(g, boo.outputs["Mesh"], rout.inputs["Rock"])
    _link(g, rin.outputs["Cutters"], rout.inputs["Cutters"])
    carved = rout.outputs["Rock"]

    # ---- finish: flat-shade (faceted), tag COLOR_0, set material ----
    flat = _n(g, "GeometryNodeSetShadeSmooth", x=1760, y=440); flat.inputs["Shade Smooth"].default_value = False
    _link(g, carved, flat.inputs["Geometry"])
    store = _store_color0(g, flat.outputs["Geometry"], rgba=(1.0, 1.0, 0.0, 0.0)); store.location = (1920, 440)
    sm = _set_material(g, store.outputs["Geometry"], rock_mat); sm.location = (2080, 440)
    _link(g, sm.outputs["Geometry"], gout.inputs["Geometry"])
    return g


# --------------------------------------------------------------------------
# build_all
# --------------------------------------------------------------------------
def build_all(which=None):
    summary = {"groups": [], "objects": []}
    col = _toolkit_collection()
    # clear prior demo objects in the toolkit collection
    for ob in list(col.objects):
        bpy.data.objects.remove(ob, do_unlink=True)

    builders = {
        # rock FIRST: the sea-stack + sea-arch boulder-cluster pass references
        # the HV_Rock group, so it must exist (and not be purged/rebuilt) after
        # they wire it in.
        "rock": build_rock,
        "sea_stack": build_sea_stack,
        "dock": build_dock,
        "palm": build_palm,
        "ramp": build_ramp,
        "sea_arch": build_sea_arch,
    }
    if which:
        builders = {k: v for k, v in builders.items() if k in which}

    for key, fn in builders.items():
        tree = fn()
        summary["groups"].append(tree.name)

    # Demo objects
    if "sea_stack" in builders:
        tree = bpy.data.node_groups["HV_SeaStack"]
        variants = [
            ("SeaStack_A", dict(Height=16.0, **{"Base Radius": 2.5}, Taper=1.2, Sides=7, Lean=0.1, Jaggedness=0.5, Lumpiness=0.45, Seed=1.0)),
            ("SeaStack_B", dict(Height=19.0, **{"Base Radius": 3.0}, Taper=1.0, Sides=8, Lean=-0.14, Jaggedness=0.5, Lumpiness=0.55, Seed=7.0)),
            ("SeaStack_C", dict(Height=11.0, **{"Base Radius": 3.4}, Taper=1.4, Sides=6, Lean=0.06, Jaggedness=0.45, Lumpiness=0.5, Seed=13.0)),
        ]
        for i, (nm, kw) in enumerate(variants):
            ob = _single_vert_obj(nm)
            _apply(ob, tree, kw)
            # planar decimation collapses the cell interiors into flat n-gon
            # facets -> the crisp, planar boulder-rock read (per the reference).
            dec = ob.modifiers.new("PlanarFacets", "DECIMATE")
            dec.decimate_type = "DISSOLVE"
            dec.angle_limit = math.radians(12)
            _place(ob, (i * 12.0, 0.0, 0.0), col)
            summary["objects"].append(nm)

    if "dock" in builders:
        tree = bpy.data.node_groups["HV_Dock"]
        path = [(-12, 0, 0), (-6, 2.5, 0), (0, -1.5, 0), (6, 1.5, 0), (13, -0.5, 0)]
        ob = _curve_obj("Dock_Demo", path)
        _apply(ob, tree, {})
        _place(ob, (0.0, 22.0, 0.0), col)
        summary["objects"].append("Dock_Demo")

    if "palm" in builders:
        tree = bpy.data.node_groups["HV_Palm"]
        variants = [
            ("Palm_A", dict(Height=11.0, Lean=0.34, Wobble=0.22, Seed=1.0)),
            ("Palm_B", dict(Height=14.0, Lean=0.58, Wobble=0.42, **{"Green Fronds": 15, "Dead Fronds": 7}, Seed=5.0)),
            ("Palm_C", dict(Seed=9.0)),  # all new defaults (Matt's locked-in look) + this seed
        ]
        for i, (nm, kw) in enumerate(variants):
            ob = _single_vert_obj(nm)
            _apply(ob, tree, kw)
            _place(ob, (i * 12.0, 44.0, 0.0), col)
            summary["objects"].append(nm)

    if "ramp" in builders:
        tree = bpy.data.node_groups["HV_Ramp"]
        path = [(-13, 0, 0), (-7, 1.2, 0.9), (0, -0.9, 2.0), (7, 1.1, 3.0), (13, 0, 3.7)]
        ob = _curve_obj("Ramp_Demo", path)
        _apply(ob, tree, {})
        _place(ob, (0.0, 66.0, 0.0), col)
        summary["objects"].append("Ramp_Demo")

    if "sea_arch" in builders:
        tree = bpy.data.node_groups["HV_SeaArch"]
        variants = [
            ("Arch_A", dict(Span=16.0, Height=12.0, Thickness=2.6, Seed=2.0)),
            ("Arch_B", dict(Span=26.0, Height=11.0, Thickness=3.4, **{"Leg Spread": 1.0, "Lean": 0.16}, Seed=6.0)),
            ("Arch_C", dict(Span=11.0, Height=14.0, Thickness=2.1, **{"Jaggedness": 0.5}, Seed=14.0)),
        ]
        for i, (nm, kw) in enumerate(variants):
            ob = _single_vert_obj(nm)
            _apply(ob, tree, kw)
            dec = ob.modifiers.new("PlanarFacets", "DECIMATE")
            dec.decimate_type = "DISSOLVE"
            dec.angle_limit = math.radians(11)
            _place(ob, (i * 30.0, 88.0, 0.0), col)
            summary["objects"].append(nm)

    if "rock" in builders:
        tree = bpy.data.node_groups["HV_Rock"]
        variants = [
            ("Rock_A", dict(Size=5.0, Seed=1.0)),
            ("Rock_B", dict(Size=7.0, Flatten=0.62, **{"Cut Spacing": 1.4, "Tilt": 0.55, "Depth Jitter": 0.5}, Seed=4.0)),
            ("Rock_C", dict(Size=4.0, **{"Cut Depth": 0.28, "Lumpiness": 0.6}, Seed=9.0)),
        ]
        for i, (nm, kw) in enumerate(variants):
            ob = _single_vert_obj(nm)
            _apply(ob, tree, kw)
            # dissolve the boolean's coplanar triangle fans into clean n-gon facets
            dec = ob.modifiers.new("PlanarFacets", "DECIMATE")
            dec.decimate_type = "DISSOLVE"
            dec.angle_limit = math.radians(6)
            _place(ob, (i * 16.0, 116.0, 0.0), col)
            summary["objects"].append(nm)

    bpy.context.view_layer.update()
    return summary
