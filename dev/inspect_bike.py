import bpy, json, sys

objs = []
for o in bpy.data.objects:
    info = {
        "name": o.name, "type": o.type,
        "parent": o.parent.name if o.parent else None,
        "loc": [round(v, 4) for v in o.location],
        "rot_euler": [round(v, 4) for v in o.rotation_euler],
        "scale": [round(v, 4) for v in o.scale],
        "kind": o.get("kind"),
        "props": {k: (o[k] if isinstance(o[k], (int, float, str, bool))
                      else (list(o[k]) if hasattr(o[k], '__iter__') else str(o[k])))
                  for k in o.keys()},
    }
    if o.type == 'MESH':
        info["dims"] = [round(v, 4) for v in o.dimensions]
        info["verts"] = len(o.data.vertices)
        info["polys"] = len(o.data.polygons)
        info["mats"] = [m.name if m else None for m in o.data.materials]
    if o.type == 'EMPTY':
        info["empty_type"] = o.empty_display_type
        info["empty_size"] = round(o.empty_display_size, 4)
    objs.append(info)

mats = []
for m in bpy.data.materials:
    md = {"name": m.name, "use_nodes": m.use_nodes}
    if m.use_nodes:
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            md["base_color"] = [round(v, 4) for v in bsdf.inputs["Base Color"].default_value]
            md["metallic"] = round(bsdf.inputs["Metallic"].default_value, 3)
            md["roughness"] = round(bsdf.inputs["Roughness"].default_value, 3)
    mats.append(md)

out = {"objects": objs, "materials": mats}
print("===BIKEJSON===")
print(json.dumps(out, indent=1))
print("===ENDJSON===")
