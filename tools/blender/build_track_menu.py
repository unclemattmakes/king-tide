"""Menu-backdrop variant of a track — a decimated *visual* GLB for the
cold-boot menu's live feed.

The menu backdrop (`src/boot/attract-mode.ts`) shows a real venue behind the
cathedral shell. It is a shop window, not a race: the broadcast camera sits low
over the water, the whole plate is dimmed and vignetted under the menu, and
nobody is reading terrain to drive it. Measured 2026-08-21, that plate cost
**8.0 s to go live and 34 MB of transfer**, of which `sandbar.glb` alone was
20.7 MB — and it is *pure geometry*, zero textures:

    POSITION 5.97 MB · NORMAL 5.97 MB · COLOR_0 3.93 MB · indices 3.85 MB
    430,684 tris / 521,987 verts

So the lever is triangle count, and the backdrop is the one surface that can
give them up without anyone noticing.

This is the visual sibling of `build_track_collider.py`, and the differences
are the whole point:

  - **Materials, COLOR_0, normals and extras all survive.** The collider proxy
    throws them away because a trimesh reads positions + indices; a backdrop
    that lost them would render untextured, unlit and unshaded. COLOR_0 in
    particular is load-bearing — the painterly-vinyl pass and the foliage sway
    both read it (`painterly-vinyl-material.ts`, `foliage-sway.ts`).
  - **Objects are decimated in place, never joined.** The collider proxy joins
    everything into one mesh; doing that here would collapse 18 materials into
    one and destroy the `kind` / `landmark_id` tags that the terrain shader,
    decal pass, emitter system and horizon extraction all key off.
  - **`collider_mesh` objects pass through undecimated.** The runtime colliders
    this variant directly (no separate `-collider.glb` is built for it), so
    these carry the docks' only collision — the same reasoning as hard rule in
    `build_track_collider.py`, plus a ramp lip is feel-critical geometry.

Ratio guidance: this mesh is never driven on and never inspected up close, so
it tolerates far more than the collider's 0.5. The shipped sandbar variant is
0.3. Push lower only while watching the silhouette — the backdrop's read is
almost entirely the horizon line of terrain against sky, and that is the first
thing a collapse decimate starts eating.

Run headless (does not touch an open GUI session):

  & $env:BLENDER_EXE --background --python tools/blender/build_track_menu.py -- ^
      public/assets/tracks/sandbar.glb public/assets/tracks/sandbar-menu.glb [ratio]
"""

import sys

import bpy

KIND_KEY = "kind"
# Authored collide-but-don't-render proxies. The menu variant IS the collision
# source for the backdrop, so these must survive — and verbatim, since they are
# already hand-authored low-poly and a collapse would round off ramp lips.
EXACT_KIND = "collider_mesh"
# Decimate below this face count and a mesh loses its shape faster than it
# saves bytes — a 200-face rock becoming 60 reads as a lumpy blob for ~4 KB.
MIN_FACES_TO_DECIMATE = 400


def parse_args() -> tuple[str, str, float]:
    argv = sys.argv
    if "--" not in argv:
        raise SystemExit("usage: ... -- <in.glb> <out.glb> [ratio]")
    rest = argv[argv.index("--") + 1 :]
    if len(rest) < 2:
        raise SystemExit("expected: <in.glb> <out.glb> [ratio]")
    ratio = float(rest[2]) if len(rest) > 2 else 0.3
    return rest[0], rest[1], ratio


def main() -> None:
    src, dst, ratio = parse_args()

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("[track-menu] no meshes found")

    tris_before = sum(len(o.data.polygons) for o in meshes)
    verts_before = sum(len(o.data.vertices) for o in meshes)

    decimated = 0
    skipped_exact = 0
    skipped_small = 0
    for o in meshes:
        if o.get(KIND_KEY) == EXACT_KIND:
            skipped_exact += 1
            continue
        if len(o.data.polygons) < MIN_FACES_TO_DECIMATE:
            skipped_small += 1
            continue
        # Per-object, in place: keeps each mesh's own materials, its `kind` /
        # `landmark_id` extras, and its place in the hierarchy. COLLAPSE
        # (quadric-error) drops the least significant edges first and emits
        # clean shared-index triangles, so the silhouette survives and the
        # export stays compact.
        dec = o.modifiers.new(name="menu_collapse", type="DECIMATE")
        dec.decimate_type = "COLLAPSE"
        dec.ratio = ratio
        # Vertex colours are interpolated across a collapse, so COLOR_0
        # survives — but the modifier must be applied with the object active.
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=dec.name)
        decimated += 1

    tris_after = sum(len(o.data.polygons) for o in meshes)
    verts_after = sum(len(o.data.vertices) for o in meshes)
    pct = 100.0 * tris_after / max(1, tris_before)
    print(
        f"[track-menu] {decimated} decimated · {skipped_exact} collider_mesh kept · "
        f"{skipped_small} too small · tris {tris_before} -> {tris_after} ({pct:.0f}%) · "
        f"verts {verts_before} -> {verts_after} · collapse ratio {ratio}"
    )

    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_extras=True,  # `kind`, landmark_id, emitter blocks — all load-bearing
        export_yup=True,
        export_apply=True,
        export_normals=True,  # lit surface, unlike the collider proxy
        export_attributes=True,  # COLOR_0 drives vinyl weathering + foliage sway
        export_skins=False,
        export_animations=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
    )
    print(f"[track-menu] wrote {dst}")


main()
