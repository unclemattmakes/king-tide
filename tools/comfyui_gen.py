"""ComfyUI text-to-image client for prop concept art (SDXL txt2img).

Part of the AI prop pipeline (docs/props-production-plan.md): generates a
clean single-object concept image that then feeds Hunyuan3D image-to-3D
and condition_ai_mesh. Talks to a running ComfyUI server over its HTTP
API (default http://127.0.0.1:8188); pure stdlib, runs under any Python.

    python tools/comfyui_gen.py --prompt "a single reef coral, ..." \\
        --out C:/tmp/coral.png

The default negative prompt steers SDXL toward an isolated object on a
plain background (what Hunyuan's rembg + image-to-3D want).
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.parse
import urllib.request

COMFY = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
DEFAULT_NEG = ("background, scene, seabed, ground, floor, multiple objects, "
               "text, watermark, logo, people, clutter, dark, drop shadow, cropped, blurry")


def _get(path: str):
    with urllib.request.urlopen(f"{COMFY}{path}", timeout=30) as r:
        return json.loads(r.read())


def _post(path: str, payload: dict):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(f"{COMFY}{path}", data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def list_checkpoints() -> list[str]:
    info = _get("/object_info/CheckpointLoaderSimple")
    return info["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0]


def build_workflow(ckpt, pos, neg, width, height, steps, cfg, sampler, scheduler, seed) -> dict:
    return {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": pos, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": neg, "clip": ["4", 1]}},
        "5": {"class_type": "EmptyLatentImage",
              "inputs": {"width": width, "height": height, "batch_size": 1}},
        "3": {"class_type": "KSampler",
              "inputs": {"seed": seed, "steps": steps, "cfg": cfg, "sampler_name": sampler,
                         "scheduler": scheduler, "denoise": 1.0,
                         "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0],
                         "latent_image": ["5", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "prop"}},
    }


def generate(pos, out_path, *, neg=DEFAULT_NEG, ckpt=None, width=1024, height=1024,
             steps=28, cfg=7.0, sampler="dpmpp_2m", scheduler="karras", seed=12345,
             timeout_s=300) -> str:
    if ckpt is None:
        cps = list_checkpoints()
        ckpt = "sd_xl_base_1.0.safetensors" if "sd_xl_base_1.0.safetensors" in cps else cps[0]
    wf = build_workflow(ckpt, pos, neg, width, height, steps, cfg, sampler, scheduler, seed)
    pid = _post("/prompt", {"prompt": wf})["prompt_id"]
    print(f"[comfyui] queued {pid} (ckpt={ckpt})")
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        hist = _get(f"/history/{pid}")
        if pid in hist:
            for node in hist[pid].get("outputs", {}).values():
                for img in node.get("images", []):
                    q = urllib.parse.urlencode({"filename": img["filename"],
                                                "subfolder": img.get("subfolder", ""),
                                                "type": img.get("type", "output")})
                    with urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=60) as r:
                        with open(out_path, "wb") as f:
                            f.write(r.read())
                    return out_path
            raise RuntimeError("generation finished but produced no image")
        time.sleep(2)
    raise TimeoutError("ComfyUI generation timed out")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--negative", default=DEFAULT_NEG)
    ap.add_argument("--out", required=True)
    ap.add_argument("--steps", type=int, default=28)
    ap.add_argument("--cfg", type=float, default=7.0)
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--width", type=int, default=1024)
    ap.add_argument("--height", type=int, default=1024)
    a = ap.parse_args()
    path = generate(a.prompt, a.out, neg=a.negative, steps=a.steps, cfg=a.cfg,
                    seed=a.seed, width=a.width, height=a.height)
    print("SAVED", path)
