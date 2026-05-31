"""Mesh several bike concepts in ONE Hunyuan session (phase-batched).

Usage: python dev/mesh_bikes_batch.py id1 id2 ...
Reads <content>/concept-art/hoverbikes/<id>_concept.png -> dev/bike_runs/<id>_raw.glb
"""
import os
import sys

_WT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_WT, "tools"))
import make_level_props as mlp  # noqa: E402

CONTENT = os.environ.get("HOVERBIKE_CONTENT_ROOT", r"C:\project-content\hoverbike")


def main():
    ids = sys.argv[1:]
    runs = os.path.join(_WT, "dev", "bike_runs")
    os.makedirs(runs, exist_ok=True)

    if mlp.comfy_alive():
        print("[batch] stopping ComfyUI for clean VRAM...")
        mlp.comfy_stop()
    mlp.hunyuan_stop()
    print("[batch] starting Hunyuan...")
    mlp.hunyuan_up(timeout_s=360)

    for bid in ids:
        ref = os.path.join(CONTENT, "concept-art", "hoverbikes", f"{bid}_concept.png")
        out = os.path.join(runs, f"{bid}_raw.glb")
        if not os.path.exists(ref):
            print(f"[batch] MISSING ref for {bid}: {ref}")
            continue
        print(f"[batch] meshing {bid}...")
        mlp._hunyuan_mesh(ref, out)
        print(f"[batch] {bid} -> {out} ({os.path.getsize(out)} bytes)")

    mlp.hunyuan_stop()
    print("[batch] done; Hunyuan stopped.")


if __name__ == "__main__":
    main()
