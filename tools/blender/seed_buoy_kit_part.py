"""Seed (or refresh) the ``buoy`` kit part inside ``prop_kit.blend``.

Run headless::

    "$BLENDER_EXE" --background tools/blender/lib/prop_kit.blend \\
        --python tools/blender/seed_buoy_kit_part.py

Idempotent — wipes any pre-existing ``buoy`` object / mesh before
rebuilding. The mesh is a tapered keel + body + shoulder + cap so the
exported wave-rider prop reads as a marker buoy (cone-keel taper)
rather than the generic ``pylon`` it used to share. Single material
slot — ``build_prop.py`` applies the spec's tint over it.
"""

from __future__ import annotations

import math

import bpy

kit_path = bpy.data.filepath

# Wipe stale buoy datablocks so re-runs don't accumulate duplicates.
for name in list(bpy.data.objects.keys()):
    if name == "buoy" or name.startswith("buoy."):
        bpy.data.objects.remove(bpy.data.objects[name], do_unlink=True)
for name in list(bpy.data.meshes.keys()):
    if name == "buoy" or name.startswith("buoy."):
        bpy.data.meshes.remove(bpy.data.meshes[name])

segs = 14
radius_keel = 0.42
radius_body = 0.38
radius_shoulder = 0.36
radius_top = 0.16
z_keel = -0.22
z_water = 0.00
z_body_lo = 0.05
z_body_hi = 0.80
z_shoulder = 0.92
z_top = 1.05


def ring(r: float, z: float) -> list[tuple[float, float, float]]:
    out: list[tuple[float, float, float]] = []
    for k in range(segs):
        a = (k / segs) * 2.0 * math.pi
        out.append((math.cos(a) * r, math.sin(a) * r, z))
    return out


rings = [
    ring(radius_keel, z_keel),
    ring(radius_body, z_water),
    ring(radius_body, z_body_lo),
    ring(radius_body, z_body_hi),
    ring(radius_shoulder, z_shoulder),
    ring(radius_top, z_top - 0.05),
]

verts: list[tuple[float, float, float]] = [v for r in rings for v in r]
# Single tip vertex at the top, plus a single tip vertex at the bottom
# of the keel so the prop's silhouette closes cleanly instead of
# leaving a hole the runtime's reverse-side cull renders as a void.
top_tip_idx = len(verts)
verts.append((0.0, 0.0, z_top))
bottom_tip_idx = len(verts)
verts.append((0.0, 0.0, z_keel - 0.08))

faces: list[tuple[int, ...]] = []


def strip(a: int, b: int) -> None:
    base_a = a * segs
    base_b = b * segs
    for k in range(segs):
        j = (k + 1) % segs
        faces.append((base_a + k, base_a + j, base_b + j, base_b + k))


for i in range(len(rings) - 1):
    strip(i, i + 1)

# Bottom-keel fan (closes the underside).
base = 0
for k in range(segs):
    j = (k + 1) % segs
    faces.append((bottom_tip_idx, base + j, base + k))

# Top fan (closes the cap).
base = (len(rings) - 1) * segs
for k in range(segs):
    j = (k + 1) % segs
    faces.append((base + k, base + j, top_tip_idx))

mesh = bpy.data.meshes.new("buoy")
mesh.from_pydata(verts, [], faces)
mesh.update()
for poly in mesh.polygons:
    poly.use_smooth = True

obj = bpy.data.objects.new("buoy", mesh)
# Park well clear of the other kit parts (pylon at origin, etc.) so the
# kit blend stays readable when an author opens it.
obj.location = (3.0, 0.0, 0.0)
bpy.context.scene.collection.objects.link(obj)

bpy.ops.wm.save_mainfile(filepath=kit_path)

print(
    f"[seed-buoy] buoy mesh written to {kit_path}: "
    f"{len(verts)} verts, {len(faces)} faces"
)
