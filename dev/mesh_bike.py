"""Mesh one bike concept image -> raw GLB via the proven Hunyuan handoff.

Usage:
    python dev/mesh_bike.py <ref_png> <out_glb>

Reuses make_level_props' VRAM lifecycle (free ComfyUI -> start Hunyuan ->
image->3D shape-only -> stop Hunyuan). ASCII-only output (cp1252 console).
"""
import os
import sys

_WORKTREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_WORKTREE, "tools"))

import make_level_props as mlp  # noqa: E402


def main() -> None:
    ref_png, out_glb = sys.argv[1], sys.argv[2]
    os.makedirs(os.path.dirname(out_glb), exist_ok=True)
    print(f"[mesh-bike] ref={ref_png}")
    print(f"[mesh-bike] out={out_glb}")

    # On the 8 GB card, /free often leaves SDXL partly resident and Hunyuan
    # then OOMs on load. Fully stop ComfyUI for a clean VRAM slate.
    if mlp.comfy_alive():
        print("[mesh-bike] stopping ComfyUI for a clean VRAM slate...")
        mlp.comfy_stop()
    mlp.hunyuan_stop()  # kill any half-loaded/zombie Hunyuan
    print("[mesh-bike] starting Hunyuan...")
    mlp.hunyuan_up(timeout_s=360)
    print("[mesh-bike] meshing (image->3D, shape-only)...")
    mlp._hunyuan_mesh(ref_png, out_glb)
    print("[mesh-bike] stopping Hunyuan to free VRAM...")
    mlp.hunyuan_stop()
    sz = os.path.getsize(out_glb)
    print(f"[mesh-bike] DONE: {out_glb} ({sz} bytes)")


if __name__ == "__main__":
    main()
