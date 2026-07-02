"""Track-GLB decoration merge — the Mexico City content diet (perf kit).

The 2026-06 frame ablation (docs/perf-baseline.md) attributed mexico-city's
city-section CPU cost to per-mesh overhead: the shipped GLB carries 455 mesh
nodes, 421 of them `kind=decoration` detail pieces (LMd_* stairs, merlons,
window strips — single-primitive, 41 shared materials). Every one is a
render-list entry, a matrix update, a draw, and (pre-gate) a shadow caster.

This script post-processes a track GLB: JOIN decoration meshes that share a
(landmark-group, material) bucket into one mesh each, leaving everything else
byte-identical in spirit:

  - `kind=track` / collider / socket / horizon / terrain nodes are never
    touched (collision + heightmap + gameplay read those).
  - Vertex data is preserved by Blender's join (COLOR_0 edge-wear/convexity
    rides along; world transforms are applied before joining).
  - extras/kinds survive the round-trip (gltf importer maps extras to custom
    props; exporter writes them back via export_extras).
  - The landmark-group key is the LMd_/LM_ name prefix (LMd_tm_* = templo,
    LMd_f3_* = facade building 3, …), so merged meshes stay spatially
    coherent — frustum culling and the shadow-caster size gate keep working
    per landmark, and the painterly-vinyl per-mesh size cap (6 m) bounds any
    brush-scale change.

Run headless (does NOT touch an open GUI session):

  & $env:BLENDER_EXE --background --python tools/blender/optimize_track_glb.py -- ^
      public/assets/tracks/mexico-city.glb public/assets/tracks/mexico-city.glb

(in-place is fine — keep a .bak copy for the A/B; the perf harness compares
old vs new via two boots.)

Sibling pass — material dedupe (the BOOT-time half of the diet): after the
joins, collapse baseColor-only decoration material families into per-vertex
`_VINYLTINT`-tinted shared materials, so the deferred scenery warm compiles
~one pipeline-group per family instead of one per colour:

  node tools/optimize-track-glb-materials.mjs public/assets/tracks/<id>.glb

That pass lives outside this script on purpose: it's pure glTF JSON+buffer
surgery (no bpy), so the merged geometry bytes round-trip untouched instead
of being re-encoded through another import/export.
"""

import re
import sys

import bpy

KIND_KEY = "kind"
# Only plain decoration merges. Anything gameplay-adjacent stays untouched.
MERGEABLE_KINDS = {"decoration"}


def parse_args() -> tuple[str, str]:
    argv = sys.argv
    if "--" not in argv:
        raise SystemExit("usage: blender --background --python optimize_track_glb.py -- in.glb out.glb")
    rest = argv[argv.index("--") + 1 :]
    if len(rest) != 2:
        raise SystemExit("expected exactly: <in.glb> <out.glb>")
    return rest[0], rest[1]


def landmark_group(name: str) -> str | None:
    """LMd_tm_stair.003 -> 'tm'; LM_facade_2 -> 'facade'; None for non-landmark."""
    m = re.match(r"LMd?_([A-Za-z0-9]+)", name or "")
    return m.group(1) if m else None


def main() -> None:
    src, dst = parse_args()

    # Fresh file: drop the default cube/camera/light.
    bpy.ops.wm.read_factory_settings(use_empty=True)

    bpy.ops.import_scene.gltf(filepath=src)

    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    total_before = len(objs)

    # Bucket: (landmark group, material name) -> [objects]
    buckets: dict[tuple[str, str], list[bpy.types.Object]] = {}
    skipped_kind = 0
    skipped_group = 0
    for o in objs:
        kind = o.get(KIND_KEY)
        if kind not in MERGEABLE_KINDS:
            skipped_kind += 1
            continue
        grp = landmark_group(o.name)
        if not grp:
            skipped_group += 1
            continue
        mat = o.material_slots[0].material.name if o.material_slots and o.material_slots[0].material else "(none)"
        buckets.setdefault((grp, mat), []).append(o)

    merged = 0
    survivors = 0
    for (grp, mat), members in sorted(buckets.items()):
        if len(members) < 2:
            survivors += len(members)
            continue
        # Apply world transforms so join keeps everything in place, then join
        # into the first member (its name becomes the merged mesh's name).
        bpy.ops.object.select_all(action="DESELECT")
        for o in members:
            o.select_set(True)
        bpy.context.view_layer.objects.active = members[0]
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        bpy.ops.object.join()
        joined = bpy.context.view_layer.objects.active
        safe_mat = re.sub(r"[^A-Za-z0-9_]+", "_", mat)
        joined.name = f"LMd_{grp}_merged_{safe_mat}"
        # The bucket key guarantees one material; keep extras (kind) from the
        # surviving object — it was decoration by construction.
        merged += len(members)
        survivors += 1

    after = len([o for o in bpy.context.scene.objects if o.type == "MESH"])
    print(
        f"[optimize-glb] meshes {total_before} -> {after} "
        f"(merged {merged} decoration pieces into {survivors} buckets; "
        f"kept {skipped_kind} non-decoration + {skipped_group} unprefixed as-is)"
    )

    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_extras=True,          # kinds ride on extras
        export_yup=True,
        export_apply=True,           # bake remaining transforms/modifiers
        export_attributes=True,      # COLOR_0 (edge wear / convexity)
        export_skins=False,
        export_animations=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
    )
    print(f"[optimize-glb] wrote {dst}")


main()
