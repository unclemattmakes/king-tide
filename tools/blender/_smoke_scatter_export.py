"""Export-side smoke test for the scatter pipeline.

End-to-end check that the biome palette's evaluated instances make it
all the way through to ``EXT_mesh_gpu_instancing`` in the exported GLB.
Drives ``hoverbike.export_track`` so the realization pass + glTF flags
are exactly what production export uses.

Pass:
  - Export operator returns FINISHED
  - GLB extensionsUsed includes EXT_mesh_gpu_instancing
  - At least one node carries the extension with a non-zero count

Invocation:
    "$BLENDER_EXE" --background tracks-src/<id>.blend \
        --python tools/blender/_smoke_scatter_export.py
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import sys
import tempfile

import bpy


def _enable_addon() -> bool:
    blend = bpy.data.filepath
    if not blend:
        print("FAIL: no .blend loaded", flush=True)
        return False
    repo = os.path.dirname(os.path.dirname(blend))
    addons_root = os.path.join(repo, "tools", "blender")
    if addons_root not in sys.path:
        sys.path.insert(0, addons_root)
    try:
        import hoverbike_addon  # type: ignore # noqa: F401
    except ImportError as e:
        print(f"FAIL: hoverbike_addon import: {e}", flush=True)
        return False
    if not hasattr(bpy.ops.hoverbike, "export_track"):
        try:
            hoverbike_addon.register()
        except (RuntimeError, ValueError) as e:
            print(f"FAIL: addon register: {e}", flush=True)
            return False
    return True


def _parse_glb_json(path: str) -> dict | None:
    with open(path, "rb") as fh:
        buf = fh.read()
    if buf[:4] != b"glTF":
        print(f"FAIL: not a glTF binary file: {path}", flush=True)
        return None
    chunk_len = struct.unpack_from("<I", buf, 12)[0]
    chunk_type = struct.unpack_from("<I", buf, 16)[0]
    if chunk_type != 0x4e4f534a:  # 'JSON'
        print("FAIL: first chunk not JSON", flush=True)
        return None
    return json.loads(buf[20:20 + chunk_len].decode("utf-8"))


def main() -> int:
    print("smoke: enable addon", flush=True)
    if not _enable_addon():
        return 1

    # Snapshot the current GLB so we can restore on exit (don't clobber
    # the user's working glb).
    from hoverbike_addon._legacy import derive_asset_id, find_repo_root  # type: ignore

    track_id = derive_asset_id("hoverbike_track_id")
    repo = find_repo_root(bpy.data.filepath)
    if not track_id or not repo:
        print(f"FAIL: couldn't derive track id ({track_id!r}) or repo ({repo!r})", flush=True)
        return 1
    glb_path = os.path.join(repo, "public", "assets", "tracks", f"{track_id}.glb")
    json_path = os.path.join(repo, "public", "tracks", f"{track_id}.json")
    snapshots = {}
    for p in (glb_path, json_path):
        if os.path.exists(p):
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=os.path.basename(p))
            tmp.close()
            shutil.copy2(p, tmp.name)
            snapshots[p] = tmp.name
            print(f"smoke: snapshotted {p} → {tmp.name}", flush=True)

    try:
        print("smoke: running hoverbike.export_track", flush=True)
        result = bpy.ops.hoverbike.export_track()
        print(f"smoke: export_track returned {result}", flush=True)
        if "FINISHED" not in result:
            print(f"FAIL: export_track returned {result}", flush=True)
            return 1

        if not os.path.exists(glb_path):
            print(f"FAIL: GLB not written at {glb_path}", flush=True)
            return 1
        gltf = _parse_glb_json(glb_path)
        if gltf is None:
            return 1
        used = gltf.get("extensionsUsed") or []
        print(f"smoke: extensionsUsed = {used}", flush=True)
        if "EXT_mesh_gpu_instancing" not in used:
            print("FAIL: GLB doesn't declare EXT_mesh_gpu_instancing", flush=True)
            return 1
        instancing_nodes = 0
        total_instances = 0
        for n in gltf.get("nodes", []):
            ext = (n.get("extensions") or {}).get("EXT_mesh_gpu_instancing")
            if ext is None:
                continue
            instancing_nodes += 1
            acc_idx = (ext.get("attributes") or {}).get("TRANSLATION")
            acc = gltf.get("accessors", [None])[acc_idx] if acc_idx is not None else None
            count = (acc or {}).get("count", 0)
            total_instances += count
            print(f"  {n.get('name', '<unnamed>')!r}: {count} instances", flush=True)
        print(f"smoke: total {instancing_nodes} instancing nodes, {total_instances} instances", flush=True)
        if total_instances == 0:
            print("FAIL: zero instances declared", flush=True)
            return 1
        print(flush=True)
        print(f"PASS: scatter export smoke test ({total_instances} instances "
              "rode through EXT_mesh_gpu_instancing)", flush=True)
        return 0

    finally:
        # Restore the snapshotted files so the user's working state is
        # untouched.
        for orig_path, tmp_path in snapshots.items():
            shutil.copy2(tmp_path, orig_path)
            os.unlink(tmp_path)
            print(f"smoke: restored {orig_path}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
