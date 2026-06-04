"""Batch FBX -> GLB converter (headless Blender).

Imports every .fbx under each named pack folder and writes a matching
<pack>/glb/<name>.glb (binary glTF) next to it. Idempotent: skips a model
whose .glb already exists. Used to make FBX-only external asset packs
(e.g. older Quaternius packs that ship no glTF) loadable by the Three.js
runtime without a hand round-trip through Blender.

Usage:
  blender --background --python tools/blender/fbx_to_glb_batch.py -- \
      --root "C:/path/to/extracted" --packs animated-fish,crops,ships

Each model is imported into a freshly-cleared scene so material/mesh data
does not accumulate across the run. Per-file failures are logged and
skipped rather than aborting the batch.
"""
import bpy
import sys
import os
import glob


def get_args():
    argv = sys.argv
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    root, packs = None, []
    i = 0
    while i < len(argv):
        if argv[i] == '--root':
            root = argv[i + 1]; i += 2
        elif argv[i] == '--packs':
            packs = argv[i + 1].split(','); i += 2
        else:
            i += 1
    return root, [p.strip() for p in packs if p.strip()]


def enable_addons():
    for mod in ('io_scene_fbx', 'io_scene_gltf2'):
        try:
            bpy.ops.preferences.addon_enable(module=mod)
        except Exception as e:
            print(f'  (addon_enable {mod} warn: {e})')


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images,
                 bpy.data.armatures, bpy.data.actions, bpy.data.curves,
                 bpy.data.textures, bpy.data.node_groups):
        for blk in list(coll):
            try:
                coll.remove(blk)
            except Exception:
                pass


def main():
    root, packs = get_args()
    if not root or not packs:
        print('ERROR: need --root and --packs'); return
    enable_addons()
    g_ok = g_fail = g_skip = 0
    for slug in packs:
        indir = os.path.join(root, slug)
        if not os.path.isdir(indir):
            print(f'[{slug}] MISSING dir, skip'); continue
        outdir = os.path.join(indir, 'glb')
        os.makedirs(outdir, exist_ok=True)
        fbxs = sorted(glob.glob(os.path.join(indir, '**', '*.fbx'), recursive=True))
        fbxs = [f for f in fbxs if os.sep + 'glb' + os.sep not in f]
        ok = fail = skip = 0
        for fbx in fbxs:
            base = os.path.splitext(os.path.basename(fbx))[0]
            out = os.path.join(outdir, base + '.glb')
            if os.path.exists(out):
                skip += 1; continue
            clear_scene()
            try:
                bpy.ops.import_scene.fbx(filepath=fbx, automatic_bone_orientation=True)
            except Exception as e:
                print(f'[{slug}] IMPORT FAIL {base}: {e}'); fail += 1; continue
            try:
                bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=False)
            except Exception as e:
                print(f'[{slug}] EXPORT FAIL {base}: {e}'); fail += 1; continue
            ok += 1
        print(f'[{slug}] converted={ok} skipped(existing)={skip} failed={fail} (of {len(fbxs)} fbx)')
        g_ok += ok; g_fail += fail; g_skip += skip
    print(f'=== SUMMARY: converted={g_ok} skipped={g_skip} failed={g_fail} ===')


main()
