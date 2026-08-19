"""Export smoke test for scatter strokes (HV_StrokeScatter).

Adds a palm stroke + rock stroke, exports the track, asserts both
strokes ship through EXT_mesh_gpu_instancing with non-zero instance
counts.
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
        import kingtide_addon  # type: ignore # noqa: F401
    except ImportError as e:
        print(f"FAIL: kingtide_addon import: {e}", flush=True)
        return False
    if not hasattr(bpy.ops.kingtide, "export_track"):
        try:
            kingtide_addon.register()
        except (RuntimeError, ValueError) as e:
            print(f"FAIL: addon register: {e}", flush=True)
            return False
    return True


def _parse_glb_json(path: str) -> dict | None:
    with open(path, "rb") as fh:
        buf = fh.read()
    if buf[:4] != b"glTF":
        return None
    chunk_len = struct.unpack_from("<I", buf, 12)[0]
    return json.loads(buf[20:20 + chunk_len].decode("utf-8"))


def main() -> int:
    if not _enable_addon():
        return 1

    from kingtide_addon._legacy import derive_asset_id, find_repo_root  # type: ignore

    track_id = derive_asset_id("hoverbike_track_id")
    repo = find_repo_root(bpy.data.filepath)
    glb_path = os.path.join(repo, "public", "assets", "tracks", f"{track_id}.glb")
    json_path = os.path.join(repo, "public", "tracks", f"{track_id}.json")
    snapshots = {}
    for p in (glb_path, json_path):
        if os.path.exists(p):
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=os.path.basename(p))
            tmp.close()
            shutil.copy2(p, tmp.name)
            snapshots[p] = tmp.name

    try:
        # Add a palm stroke and a rock stroke at the cursor.
        bpy.ops.kingtide.add_scatter_stroke(prop="palm")
        print("smoke: added palm stroke", flush=True)
        bpy.ops.kingtide.add_scatter_stroke(prop="rock")
        print("smoke: added rock stroke", flush=True)

        result = bpy.ops.kingtide.export_track()
        print(f"smoke: export_track returned {result}", flush=True)
        if "FINISHED" not in result:
            return 1

        gltf = _parse_glb_json(glb_path)
        if gltf is None:
            print("FAIL: GLB not parseable", flush=True)
            return 1
        used = gltf.get("extensionsUsed") or []
        print(f"smoke: extensionsUsed = {used}", flush=True)
        if "EXT_mesh_gpu_instancing" not in used:
            print("FAIL: no EXT_mesh_gpu_instancing in GLB", flush=True)
            return 1
        nodes = gltf.get("nodes", [])
        instancing_nodes = 0
        total = 0
        for n in nodes:
            ext = (n.get("extensions") or {}).get("EXT_mesh_gpu_instancing")
            if ext is None:
                continue
            instancing_nodes += 1
            acc_idx = (ext.get("attributes") or {}).get("TRANSLATION")
            acc = gltf.get("accessors", [None])[acc_idx] if acc_idx is not None else None
            count = (acc or {}).get("count", 0)
            total += count
            print(f"  {n.get('name', '<unnamed>')!r}: {count} instances", flush=True)
        print(f"smoke: {instancing_nodes} instancing nodes, {total} instances", flush=True)
        if total == 0:
            return 1
        print(flush=True)
        print(f"PASS: stroke export smoke test ({total} instances via EXT_mesh_gpu_instancing)", flush=True)
        return 0
    finally:
        for orig, tmp in snapshots.items():
            shutil.copy2(tmp, orig)
            os.unlink(tmp)


if __name__ == "__main__":
    sys.exit(main())
