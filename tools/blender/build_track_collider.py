"""Track collision proxy — a decimated collide-only mesh shipped alongside the
render GLB.

The 2026-06 race-load profile attributed ~0.6-0.9 s of EVERY race boot to Rapier
building trimesh BVHs over the full render geometry (sandbar: 522k verts, and the
runtime doubles every triangle for raycast safety). This builds a low-poly
collision proxy from the collidable meshes so Rapier's BVH builds over a fraction
of the triangles.

A COLLAPSE decimate to `ratio` is used (quadric-error edge collapse): it drops
the least-significant edges first, so the playable surface keeps its shape while
shedding triangles, and — unlike planar dissolve — it emits clean shared-index
triangles that export compactly (planar dissolve makes n-gons the glTF exporter
re-triangulates into duplicated verts, bloating the file). The hover ray rides
the collider, so keep `ratio` conservative (0.5 default) and PLAYTEST feel before
going lower; the bike hovers a gap above the surface, which absorbs gentle
simplification, but ramp lips / jump takeoffs are feel-critical.

The proxy ships as `<track>-collider.glb`, leaving the render GLB byte-identical
(no COLOR_0 / extras round-trip risk). The runtime (track-loader.ts) loads it when
present and colliders IT instead of the render geometry; absent => legacy
(collide the render mesh). Heightmap + water shoaling stay on the high-poly mesh.
Normals/materials are dropped — a trimesh collider reads only positions + indices.

Run headless (does not touch an open GUI session):

  & $env:BLENDER_EXE --background --python tools/blender/build_track_collider.py -- ^
      public/assets/tracks/sandbar.glb public/assets/tracks/sandbar-collider.glb [ratio]
"""

import sys

import bpy

KIND_KEY = "kind"
# Mirror attachTrackColliders' skip set (src/engine/render/glb-track.ts): these
# kinds never collide at runtime, so they have no business in the proxy.
NON_COLLIDING_KINDS = {"decoration", "horizon", "decal", "emitter", "collider_mesh"}


def parse_args() -> tuple[str, str, float]:
    argv = sys.argv
    if "--" not in argv:
        raise SystemExit("usage: ... -- <in.glb> <out.glb> [ratio]")
    rest = argv[argv.index("--") + 1 :]
    if len(rest) < 2:
        raise SystemExit("expected: <in.glb> <out.glb> [ratio]")
    ratio = float(rest[2]) if len(rest) > 2 else 0.5
    return rest[0], rest[1], ratio


def main() -> None:
    src, dst, ratio = parse_args()

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    collidable = [o for o in meshes if o.get(KIND_KEY) not in NON_COLLIDING_KINDS]
    if not collidable:
        raise SystemExit("[track-collider] no collidable meshes found")

    tris_before = sum(len(o.data.polygons) for o in collidable)
    verts_before = sum(len(o.data.vertices) for o in collidable)

    # Drop everything that isn't collidable so only the proxy is exported.
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        if o not in collidable:
            o.select_set(True)
    if bpy.context.selected_objects:
        bpy.ops.object.delete()

    # Join into one mesh, baking world transforms first so the collider sits
    # exactly where the visual mesh sits (runtime root is identity).
    bpy.ops.object.select_all(action="DESELECT")
    for o in collidable:
        o.select_set(True)
    bpy.context.view_layer.objects.active = collidable[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.join()
    proxy = bpy.context.view_layer.objects.active
    proxy.name = "HV_TrackCollider"
    proxy.data.materials.clear()
    proxy["kind"] = "collider_mesh"

    # Weld coincident verts (GLB splits them per material/primitive) so the
    # collapse can simplify across seams.
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.001)
    bpy.ops.object.mode_set(mode="OBJECT")
    dec = proxy.modifiers.new(name="collapse", type="DECIMATE")
    dec.decimate_type = "COLLAPSE"
    dec.ratio = ratio
    bpy.ops.object.modifier_apply(modifier=dec.name)

    tris_after = len(proxy.data.polygons)
    verts_after = len(proxy.data.vertices)
    pct = 100.0 * tris_after / max(1, tris_before)
    print(
        f"[track-collider] {len(collidable)} collidable meshes · "
        f"tris {tris_before} -> {tris_after} ({pct:.0f}%) · "
        f"verts {verts_before} -> {verts_after} · collapse ratio {ratio}"
    )

    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_extras=True,
        export_yup=True,
        export_apply=True,
        export_normals=False,  # a trimesh collider reads positions + indices only
        export_attributes=False,  # collider is invisible — no COLOR_0 needed
        export_skins=False,
        export_animations=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
    )
    print(f"[track-collider] wrote {dst}")


main()
