"""Condition a raw Hunyuan bike mesh and splice it into bikes-src/<id>.blend.

Unlike the prop conditioner (condition_ai_mesh, which wraps a mesh in a
fresh prop_root + collider and sits it on the ground), a bike must PRESERVE
the authored rig — bike_root, the 5 sockets, collider_body, the
mat_bike_<id>_* materials — and only REPLACE the placeholder *-geo visual
meshes, scaled + positioned to the existing visual envelope so the sockets
(seat / nose_cam / fx_thruster_l|r / fx_exhaust) still land correctly.

Two subcommands (run headless: blender --background --python this -- <cmd> ...):

  inspect  <raw_glb> [rot_deg]
      Import + join + decimate + recenter to origin; print bbox dims and
      render top / +X side / +Y side orthographic views so the nose
      direction can be identified. rot_deg = "rx,ry,rz" applied first.

  integrate <raw_glb> <bike_id> <bike_blend> <rot_deg> [--no-save] [--glow]
      Full splice: orient by rot_deg, scale to the existing envelope length,
      center on the old envelope, assign mat_bike_<id>_livery (+ optional
      rear glow), strip color attrs, delete old *-geo, save the .blend.
      --no-save renders a verification image instead of saving.

ASCII-only output (cp1252 console).
"""
import math
import os
import sys

import bpy
from mathutils import Euler, Matrix, Vector

# args after the "--" separator
ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

# scratch output dir (renders), relative to this script -- gitignored
_RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bike_runs")


# ── scene helpers ────────────────────────────────────────────────────
def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for block in (bpy.data.meshes, bpy.data.materials):
        for b in list(block):
            if b.users == 0:
                block.remove(b)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before and o.type == "MESH"]


def select_only(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def join_meshes(objs):
    if not objs:
        raise SystemExit("[bike] no meshes imported")
    if len(objs) == 1:
        return objs[0]
    select_only(objs[0])
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    return bpy.context.view_layer.objects.active


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def keep_largest_island(obj):
    """Drop floating disconnected islands, keep the largest connected vertex
    component. The hover-moto prompts add thin parts (fin, forks, antenna,
    grab-rails) that image->3D fragments into floating debris -- this strips
    them so only the solid hull survives (thin parts re-added procedurally)."""
    import bmesh
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    comp_of = {}
    sizes = {}
    cid = 0
    for seed in bm.verts:
        if seed.index in comp_of:
            continue
        cid += 1
        stack = [seed]
        comp_of[seed.index] = cid
        n = 0
        while stack:
            v = stack.pop()
            n += 1
            for e in v.link_edges:
                o = e.other_vert(v)
                if o.index not in comp_of:
                    comp_of[o.index] = cid
                    stack.append(o)
        sizes[cid] = n
    if len(sizes) > 1:
        keep = max(sizes, key=lambda c: sizes[c])
        dead = [v for v in bm.verts if comp_of[v.index] != keep]
        bmesh.ops.delete(bm, geom=dead, context="VERTS")
        print(f"[bike] kept largest of {len(sizes)} islands "
              f"({sizes[keep]} verts), dropped {len(dead)} stray verts")
    bm.to_mesh(me)
    bm.free()
    me.update()


def decimate(obj, target_tris):
    for i in range(8):
        tc = tri_count(obj)
        if tc <= target_tris:
            return
        md = obj.modifiers.new(f"HV_Dec_{i}", "DECIMATE")
        md.decimate_type = "COLLAPSE"
        md.ratio = max(0.1, target_tris / float(tc))
        select_only(obj)
        bpy.ops.object.modifier_apply(modifier=md.name)


def bake_world_transform(obj):
    """Bake obj.matrix_world into the mesh verts, reset transform to identity.
    Direct vertex math -- robust in --background where transform_apply can
    silently no-op on rotation."""
    mw = obj.matrix_world.copy()
    for v in obj.data.vertices:
        v.co = mw @ v.co
    obj.data.update()
    obj.matrix_basis = Matrix.Identity(4)


def local_bbox(obj):
    cs = [v.co for v in obj.data.vertices]
    return (Vector((min(c.x for c in cs), min(c.y for c in cs), min(c.z for c in cs))),
            Vector((max(c.x for c in cs), max(c.y for c in cs), max(c.z for c in cs))))


def world_bbox(objs):
    """World-space bbox computed from actual verts (not the cached bound_box,
    which goes stale after direct v.co edits)."""
    pts = []
    for o in objs:
        if o.type != "MESH":
            continue
        mw = o.matrix_world
        for v in o.data.vertices:
            pts.append(mw @ v.co)
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return mn, mx


def apply_rot(obj, rot_deg):
    """Rotate mesh verts in place by an XYZ euler (degrees), direct matrix."""
    rx, ry, rz = (math.radians(float(v)) for v in rot_deg.split(","))
    R = Euler((rx, ry, rz), "XYZ").to_matrix()
    for v in obj.data.vertices:
        v.co = R @ v.co
    obj.data.update()


def hex_to_rgba(s):
    s = s.lstrip("#")
    return (int(s[0:2], 16) / 255.0) ** 2.2, (int(s[2:4], 16) / 255.0) ** 2.2, \
           (int(s[4:6], 16) / 255.0) ** 2.2, 1.0


def strip_color_attrs(mesh):
    while mesh.color_attributes:
        mesh.color_attributes.remove(mesh.color_attributes[0])


# ── render (orientation check) ───────────────────────────────────────
def setup_render():
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.render.resolution_x = 640
    sc.render.resolution_y = 480
    sc.display.shading.light = "STUDIO"
    sc.display.shading.color_type = "SINGLE"
    sc.display.shading.single_color = (0.8, 0.45, 0.2)


def render_view(obj, cam_dir, name, out_dir):
    mn, mx = local_bbox(obj)
    center = (mn + mx) * 0.5
    size = max((mx - mn).x, (mx - mn).y, (mx - mn).z)
    d = Vector(cam_dir).normalized()
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = size * 1.3
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = center + d * size * 3
    # point camera at center
    look = (center - cam.location).normalized()
    cam.rotation_euler = look.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    out = os.path.join(out_dir, f"{name}.png")
    bpy.context.scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    print(f"[bike] rendered {out}")


# ── subcommands ──────────────────────────────────────────────────────
def cmd_inspect():
    raw = ARGV[1]
    rot = ARGV[2] if len(ARGV) > 2 else "0,0,0"
    label = (ARGV[3] + "_") if len(ARGV) > 3 else ""
    out_dir = os.path.join(_RUNS, "inspect")
    os.makedirs(out_dir, exist_ok=True)
    clear_scene()
    obj = join_meshes(import_glb(raw))
    bake_world_transform(obj)
    keep_largest_island(obj)
    decimate(obj, 6000)
    apply_rot(obj, rot)
    mn, mx = local_bbox(obj)
    dx, dy, dz = (mx - mn).x, (mx - mn).y, (mx - mn).z
    # recenter to origin for clean framing
    c = (mn + mx) * 0.5
    for v in obj.data.vertices:
        v.co -= c
    obj.data.update()
    print(f"[bike] tris={tri_count(obj)} dims X(width)={dx:.3f} Y(depth)={dy:.3f} Z(height)={dz:.3f}")
    setup_render()
    render_view(obj, (0, 0, 1), f"{label}top_down_negZ", out_dir)
    render_view(obj, (1, 0.2, 0.3), f"{label}side_posX", out_dir)
    render_view(obj, (0.8, -1, 0.4), f"{label}hero", out_dir)


def cmd_integrate():
    raw = ARGV[1]
    bike_id = ARGV[2]
    bike_blend = ARGV[3]
    rot = ARGV[4]
    no_save = "--no-save" in ARGV
    do_glow = "--glow" in ARGV
    target_tris = 5000

    bpy.ops.wm.open_mainfile(filepath=bike_blend)

    bike_root = bpy.data.objects.get("bike_root")
    if bike_root is None:
        raise SystemExit("[bike] no bike_root in blend")
    root_coll = bike_root.users_collection[0]

    # existing visual envelope from the *-geo placeholder meshes
    old_geo = [o for o in bpy.data.objects
               if o.type == "MESH" and o.parent == bike_root]
    if not old_geo:
        raise SystemExit("[bike] no existing *-geo meshes parented to bike_root")
    env_mn, env_mx = world_bbox(old_geo)
    env_size = env_mx - env_mn
    env_center = (env_mn + env_mx) * 0.5
    print(f"[bike] envelope center={tuple(round(v,3) for v in env_center)} "
          f"size X={env_size.x:.3f} Y={env_size.y:.3f} Z={env_size.z:.3f}")

    # import + condition the raw mesh
    obj = join_meshes(import_glb(raw))
    bake_world_transform(obj)
    keep_largest_island(obj)
    decimate(obj, target_tris)
    apply_rot(obj, rot)

    # scale: match the envelope length (Y, fore-aft) — the socket-critical axis
    mn, mx = local_bbox(obj)
    cur = mx - mn
    s = env_size.y / cur.y if cur.y > 1e-6 else 1.0
    for v in obj.data.vertices:
        v.co *= s
    obj.data.update()

    # position: bbox center -> envelope center, force X symmetry to 0
    mn, mx = local_bbox(obj)
    c = (mn + mx) * 0.5
    for v in obj.data.vertices:
        v.co -= c
    obj.data.update()
    obj.location = Vector((0.0, env_center.y, env_center.z))
    obj.rotation_euler = (0, 0, 0)
    obj.scale = (1, 1, 1)

    # Materials: the LOCKED 3-colour scheme from docs/bike-art-direction.md --
    # livery (body, most of the hull), chassis (near-black metal on the lower
    # structural hull / ski), glow (the rear thruster throats + exhaust; "glow
    # is a privilege"). Keys off the authored mat_bike_<id>_* names so the
    # build_bike spec recolour drives the final ship-locked palette.
    livery = bpy.data.materials.get(f"mat_bike_{bike_id}_livery")
    chassis = bpy.data.materials.get(f"mat_bike_{bike_id}_chassis")
    glow = bpy.data.materials.get(f"mat_bike_{bike_id}_glow") if do_glow else None
    if livery is None:                       # safety; .blends ship with these
        livery = bpy.data.materials.new(f"mat_bike_{bike_id}_livery")
        livery.use_nodes = True

    obj.data.materials.clear()
    slots = {}
    for key, mat in (("livery", livery), ("chassis", chassis), ("glow", glow)):
        if mat is not None:
            obj.data.materials.append(mat)
            slots[key] = len(obj.data.materials) - 1

    mn2, mx2 = local_bbox(obj)
    h = max(mx2.z - mn2.z, 1e-6)
    z_chassis = mn2.z + 0.30 * h              # lower 30% -> dark structural hull / ski
    y_rear = mx2.y - 0.12 * (mx2.y - mn2.y)   # rear 12% -> glow thruster nozzle
    for p in obj.data.polygons:
        vs = [obj.data.vertices[i].co for i in p.vertices]
        pcy = sum(v.y for v in vs) / len(vs)
        pcz = sum(v.z for v in vs) / len(vs)
        if "glow" in slots and pcy >= y_rear:
            p.material_index = slots["glow"]
        elif "chassis" in slots and pcz <= z_chassis:
            p.material_index = slots["chassis"]
        else:
            p.material_index = slots["livery"]

    strip_color_attrs(obj.data)
    for p in obj.data.polygons:
        p.use_smooth = True

    obj.name = "bike_hull-geo"
    obj.data.name = "bike_hull-geo"
    for c2 in list(obj.users_collection):
        c2.objects.unlink(obj)
    root_coll.objects.link(obj)
    obj.parent = bike_root
    obj.matrix_parent_inverse = bike_root.matrix_world.inverted()

    print(f"[bike] hull tris={tri_count(obj)} placed at {tuple(round(v,3) for v in obj.location)}")

    # Reposition the rig empties onto the NEW hull. The bike's forward is -Y,
    # rear is +Y; FX emit from the rear jet nozzle (max Y), so the thruster /
    # exhaust sockets must sit there (they were authored for the placeholder).
    bpy.context.view_layer.update()   # compose matrix_world after reparent/loc
    hb_mn, hb_mx = world_bbox([obj])
    cy = (hb_mn.y + hb_mx.y) * 0.5
    cz = (hb_mn.z + hb_mx.z) * 0.5
    if "--keep-sockets" not in ARGV:
        def _place(name, loc):
            so = bpy.data.objects.get(name)
            if so:
                so.location = Vector(loc)
        rear = hb_mx.y - 0.08          # just inside the tail
        nozzle_z = cz - 0.02
        _place("socket_fx_exhaust", (0.0, rear, nozzle_z))
        _place("socket_fx_thruster_l", (-0.13, rear, nozzle_z))
        _place("socket_fx_thruster_r", (0.13, rear, nozzle_z))
        # seat on the upper hull, a little behind centre
        _place("socket_seat", (0.0, cy + 0.15, hb_mx.z - 0.18))
        # nose camera anchor just ahead of the prow
        _place("socket_nose_cam", (0.0, hb_mn.y - 0.30, cz + 0.12))

    print(f"[bike] hull world bbox min={tuple(round(v,3) for v in hb_mn)} "
          f"max={tuple(round(v,3) for v in hb_mx)}")
    for s_name in ("socket_seat", "socket_nose_cam", "socket_fx_thruster_l",
                   "socket_fx_thruster_r", "socket_fx_exhaust"):
        so = bpy.data.objects.get(s_name)
        if so:
            print(f"[bike]   {s_name} @ {tuple(round(v,3) for v in so.location)}")

    if no_save:
        out_dir = os.path.join(_RUNS, "verify")
        os.makedirs(out_dir, exist_ok=True)
        setup_render()
        render_view(obj, (1, 0.25, 0.3), f"{bike_id}_posX", out_dir)
        render_view(obj, (0, 0, 1), f"{bike_id}_top", out_dir)
        print("[bike] --no-save: rendered verification only, not saved")
        return

    # delete old placeholder geo, keep empties (sockets/collider/root)
    for o in old_geo:
        bpy.data.objects.remove(o, do_unlink=True)

    bpy.ops.wm.save_mainfile(filepath=bike_blend)
    print(f"[bike] saved {bike_blend}")


SOCKET_COLORS = {
    "socket_seat": (0.1, 0.9, 0.2),         # green
    "socket_nose_cam": (0.2, 0.4, 1.0),     # blue
    "socket_fx_thruster_l": (1.0, 0.1, 0.1),  # red
    "socket_fx_thruster_r": (1.0, 0.4, 0.1),  # orange-red
    "socket_fx_exhaust": (1.0, 0.7, 0.0),   # amber
}


def _marker(name, loc, color, r=0.09):
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=r)
    bm.to_mesh(mesh)
    bm.free()
    obj.location = loc
    mat = bpy.data.materials.new(f"mk_{name}")
    mat.use_nodes = True
    b = mat.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Emission Color"].default_value = (*color, 1.0)
    b.inputs["Emission Strength"].default_value = 1.0
    mat.diffuse_color = (*color, 1.0)   # workbench MATERIAL reads this
    mesh.materials.append(mat)
    return obj


def cmd_preview():
    bike_blend = ARGV[1]
    bike_id = ARGV[2] if len(ARGV) > 2 else "bike"
    out_dir = os.path.join(_RUNS, "preview")
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.open_mainfile(filepath=bike_blend)

    # add socket markers
    for name, color in SOCKET_COLORS.items():
        so = bpy.data.objects.get(name)
        if so:
            _marker(name, so.matrix_world.translation, color)

    # Workbench MATERIAL mode reads mat.diffuse_color (viewport), not the BSDF
    # base color -- sync them so the preview shows true livery/glow colors.
    for m in bpy.data.materials:
        if m.use_nodes:
            b = m.node_tree.nodes.get("Principled BSDF")
            if b:
                m.diffuse_color = b.inputs["Base Color"].default_value

    # frame on the hull mesh
    hull = bpy.data.objects.get("bike_hull-geo") or next(
        (o for o in bpy.data.objects if o.type == "MESH"), None)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.render.resolution_x = 800
    sc.render.resolution_y = 600
    sc.display.shading.light = "STUDIO"
    sc.display.shading.color_type = "MATERIAL"
    bpy.context.view_layer.update()
    for cam_dir, nm in [((1.4, -1.0, 0.6), "hero"), ((0, -1, 0.15), "front"),
                        ((1, 0, 0.1), "side"), ((0, 0, 1), "top")]:
        render_view(hull, cam_dir, f"{bike_id}_{nm}", out_dir)


if __name__ == "__main__":
    cmd = ARGV[0] if ARGV else "inspect"
    if cmd == "inspect":
        cmd_inspect()
    elif cmd == "integrate":
        cmd_integrate()
    elif cmd == "preview":
        cmd_preview()
    else:
        raise SystemExit(f"[bike] unknown cmd: {cmd}")
