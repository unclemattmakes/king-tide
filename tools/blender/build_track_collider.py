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

Because the proxy REPLACES the render geometry as the collision source, what it
omits has no collision at all in a race — the mesh still draws, and the bike
passes through. So the output is two objects, not one:

  - `HV_TrackCollider`      — the bulk collidable meshes, welded + decimated.
  - `HV_TrackColliderExact` — every `collider_mesh` mesh, joined VERBATIM.

Keep them separate. `collider_mesh` is the collide-but-don't-render kind whose
visual twin is tagged `decoration` (HV_Dock: plank deck renders, swept slab
collides), so it is the only collision those objects have — and it is already
hand-authored low-poly, so decimating it would round off a feel-critical ramp
lip for no saving worth having.

Run headless (does not touch an open GUI session):

  & $env:BLENDER_EXE --background --python tools/blender/build_track_collider.py -- ^
      public/assets/tracks/sandbar.glb public/assets/tracks/sandbar-collider.glb [ratio]
"""

import sys

import bpy

KIND_KEY = "kind"
# Mirror of NON_COLLIDING_KINDS in src/engine/render/glb-track.ts: these kinds
# never collide at runtime, so they have no business in the proxy. Keep the two
# in sync — tests/unit/track-collider-proxy.test.ts parses this literal and
# fails if they drift.
#
# `collider_mesh` is NOT here, and must never be added: it is the collide-but-
# don't-render kind (HV_Dock's swept deck slab), i.e. the only collision a
# `decoration`-tagged dock has. It was wrongly listed until 2026-08-20, which
# silently deleted every dock/ramp collider on Mayday Bay — the deck rendered
# and the bike flew straight through it.
NON_COLLIDING_KINDS = {"decoration", "horizon", "decal", "emitter"}
# Collide-but-don't-render authored proxies. Already hand-authored low-poly
# (~1k tris against the terrain's ~200k), and they are the feel-critical
# surfaces — a swept dock ramp whose lip a collapse-decimate would round off.
# They go into the proxy VERBATIM, in their own object, skipping the decimate.
EXACT_KIND = "collider_mesh"


def parse_args() -> tuple[str, str, float]:
    argv = sys.argv
    if "--" not in argv:
        raise SystemExit("usage: ... -- <in.glb> <out.glb> [ratio]")
    rest = argv[argv.index("--") + 1 :]
    if len(rest) < 2:
        raise SystemExit("expected: <in.glb> <out.glb> [ratio]")
    ratio = float(rest[2]) if len(rest) > 2 else 0.5
    return rest[0], rest[1], ratio


def bake_and_join(objs: list, name: str):
    """Apply world transforms then join `objs` into one mesh object called
    `name`, tagged `kind=collider_mesh`. Transforms are baked so the collider
    sits exactly where the visual mesh sits (the runtime root is identity).
    Materials are dropped — a trimesh collider reads positions + indices only.
    """
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(objs) > 1:
        bpy.ops.object.join()
    out = bpy.context.view_layer.objects.active
    out.name = name
    out.data.materials.clear()
    out[KIND_KEY] = EXACT_KIND
    return out


def main() -> None:
    src, dst, ratio = parse_args()

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    collidable = [o for o in meshes if o.get(KIND_KEY) not in NON_COLLIDING_KINDS]
    if not collidable:
        raise SystemExit("[track-collider] no collidable meshes found")
    # Authored collide-only proxies bypass the decimate (see EXACT_KIND).
    exact = [o for o in collidable if o.get(KIND_KEY) == EXACT_KIND]
    bulk = [o for o in collidable if o.get(KIND_KEY) != EXACT_KIND]

    tris_before = sum(len(o.data.polygons) for o in bulk)
    verts_before = sum(len(o.data.vertices) for o in bulk)
    exact_tris = sum(len(o.data.polygons) for o in exact)

    # Drop everything that isn't collidable so only the proxy is exported.
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        if o not in collidable:
            o.select_set(True)
    if bpy.context.selected_objects:
        bpy.ops.object.delete()

    if exact:
        # Verbatim — no weld, no collapse. These ARE the authored proxy.
        bake_and_join(exact, "HV_TrackColliderExact")

    if not bulk:
        # Degenerate but legal: a GLB whose only collision is authored
        # collider_mesh. Nothing to decimate.
        print(
            f"[track-collider] 0 bulk meshes · "
            f"{len(exact)} exact collider_mesh kept verbatim ({exact_tris} tris)"
        )
        export(dst)
        return

    proxy = bake_and_join(bulk, "HV_TrackCollider")

    # Weld coincident verts (GLB splits them per material/primitive) so the
    # collapse can simplify across seams.
    bpy.context.view_layer.objects.active = proxy
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
        f"[track-collider] {len(bulk)} bulk meshes · "
        f"tris {tris_before} -> {tris_after} ({pct:.0f}%) · "
        f"verts {verts_before} -> {verts_after} · collapse ratio {ratio} · "
        f"{len(exact)} exact collider_mesh kept verbatim ({exact_tris} tris)"
    )

    export(dst)


def export(dst: str) -> None:
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
