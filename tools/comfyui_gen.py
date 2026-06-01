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

# ── Model defaults ───────────────────────────────────────────────────
# The concept feeds Hunyuan image-to-3D, then condition_ai_mesh re-tints/re-
# shades the mesh — so the concept's job is silhouette + chunky stylized *form*,
# not final texture. A stylized fine-tune + a 3D-render LoRA bakes the "clean
# stylized toy" register (docs/prop-art-direction.md) into the weights instead
# of leaning on prompt words alone — vanilla SDXL base reads flat and generic.
# Override via env for experiments; make_level_props.py picks these up unchanged.
DEFAULT_CKPT = os.environ.get("COMFY_CKPT", "DreamShaperXL_Turbo_v2_1.safetensors")
FALLBACK_CKPT = "sd_xl_base_1.0.safetensors"

# LoRA stack: comma-separated "name:strength_model:strength_clip" entries.
# Empty COMFY_LORAS ("") disables the stack (raw checkpoint). Each active LoRA's
# trigger phrase is prepended to the positive prompt so its style actually fires.
# A/B (2026-05-31): the 3d-render LoRA sharpens man-made props (boats, vehicles,
# anchors) but at 0.8 it cluttered amorphous organics (boulders drifted to a
# *cluster* of rocks — bad for single-object image-to-3D). 0.5 keeps the render
# polish without the clutter; drop to "" for the cleanest single-blob rock/coral.
# toy_face_sdxl is character-only — it paints a cartoon face on props; not a default.
DEFAULT_LORAS = os.environ.get("COMFY_LORAS", "3d_render_style_xl.safetensors:0.5:1.0")
LORA_TRIGGERS = {
    "3d_render_style_xl.safetensors": "3d render style",
    "toy_face_sdxl.safetensors": "toy_face",
}


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


def list_loras() -> list[str]:
    try:
        info = _get("/object_info/LoraLoader")
        return info["LoraLoader"]["input"]["required"]["lora_name"][0]
    except Exception:
        return []


def _pick_ckpt(requested: str | None) -> str:
    """Prefer the requested ckpt, then the stylized default, then base SDXL;
    fall back to whatever's installed so a fresh clone still generates."""
    cps = list_checkpoints()
    for cand in (requested, DEFAULT_CKPT, FALLBACK_CKPT):
        if cand and cand in cps:
            return cand
    if not cps:
        raise RuntimeError("ComfyUI has no checkpoints installed")
    return cps[0]


def _parse_loras(spec: str, available: list[str]) -> list[dict]:
    """"name:sm:sc,name:sm:sc" → [{name, sm, sc}]. Drops any LoRA whose file
    isn't installed so a missing LoRA degrades to the plain checkpoint rather
    than erroring the whole batch."""
    out = []
    for part in (s.strip() for s in spec.split(",")):
        if not part:
            continue
        bits = part.split(":")
        name = bits[0]
        sm = float(bits[1]) if len(bits) > 1 else 0.8
        sc = float(bits[2]) if len(bits) > 2 else 1.0
        if available and name not in available:
            print(f"[comfyui] LoRA not installed, skipping: {name}")
            continue
        out.append({"name": name, "sm": sm, "sc": sc})
    return out


def _sampling_for(ckpt: str) -> dict:
    """Turbo / Lightning fine-tunes need few steps + low CFG or they blow out;
    everything else gets the standard SDXL recipe."""
    if "turbo" in ckpt.lower() or "lightning" in ckpt.lower():
        return dict(steps=8, cfg=2.0, sampler="dpmpp_sde", scheduler="karras")
    return dict(steps=28, cfg=7.0, sampler="dpmpp_2m", scheduler="karras")


def build_workflow(ckpt, pos, neg, width, height, steps, cfg, sampler, scheduler, seed,
                   loras=None) -> dict:
    g = {"4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}}}
    # Chain LoRA loaders off the checkpoint; each rewires MODEL + CLIP downstream.
    model_src, clip_src = ["4", 0], ["4", 1]
    for i, lo in enumerate(loras or []):
        nid = str(20 + i)
        g[nid] = {"class_type": "LoraLoader",
                  "inputs": {"lora_name": lo["name"],
                             "strength_model": lo["sm"], "strength_clip": lo["sc"],
                             "model": model_src, "clip": clip_src}}
        model_src, clip_src = [nid, 0], [nid, 1]
    g.update({
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": pos, "clip": clip_src}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": neg, "clip": clip_src}},
        "5": {"class_type": "EmptyLatentImage",
              "inputs": {"width": width, "height": height, "batch_size": 1}},
        "3": {"class_type": "KSampler",
              "inputs": {"seed": seed, "steps": steps, "cfg": cfg, "sampler_name": sampler,
                         "scheduler": scheduler, "denoise": 1.0,
                         "model": model_src, "positive": ["6", 0], "negative": ["7", 0],
                         "latent_image": ["5", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "prop"}},
    })
    return g


def generate(pos, out_path, *, neg=DEFAULT_NEG, ckpt=None, loras=None,
             width=1024, height=1024, steps=None, cfg=None, sampler=None,
             scheduler=None, seed=12345, timeout_s=300) -> str:
    ckpt = _pick_ckpt(ckpt)
    if loras is None:
        loras = _parse_loras(DEFAULT_LORAS, list_loras())
    # Prepend each active LoRA's trigger so the baked-in style actually fires.
    triggers = [LORA_TRIGGERS[lo["name"]] for lo in loras if lo["name"] in LORA_TRIGGERS]
    if triggers:
        pos = ", ".join(triggers) + ", " + pos
    # None = auto: derive the sampler recipe from the checkpoint type (turbo etc).
    rec = _sampling_for(ckpt)
    steps = rec["steps"] if steps is None else steps
    cfg = rec["cfg"] if cfg is None else cfg
    sampler = rec["sampler"] if sampler is None else sampler
    scheduler = rec["scheduler"] if scheduler is None else scheduler
    wf = build_workflow(ckpt, pos, neg, width, height, steps, cfg, sampler, scheduler, seed, loras)
    pid = _post("/prompt", {"prompt": wf})["prompt_id"]
    lora_desc = ", ".join(f"{lo['name']}@{lo['sm']}" for lo in loras) or "none"
    print(f"[comfyui] queued {pid} (ckpt={ckpt}, loras={lora_desc}, steps={steps}, cfg={cfg})")
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
    ap.add_argument("--ckpt", default=None, help="checkpoint filename (default: stylized DreamShaper XL)")
    ap.add_argument("--lora", action="append", default=None,
                    help="name:sm:sc (repeatable). Overrides COMFY_LORAS; pass --lora '' to disable.")
    ap.add_argument("--steps", type=int, default=None, help="default: auto from checkpoint type")
    ap.add_argument("--cfg", type=float, default=None, help="default: auto from checkpoint type")
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--width", type=int, default=1024)
    ap.add_argument("--height", type=int, default=1024)
    a = ap.parse_args()
    loras = _parse_loras(",".join(a.lora), list_loras()) if a.lora is not None else None
    path = generate(a.prompt, a.out, neg=a.negative, ckpt=a.ckpt, loras=loras,
                    steps=a.steps, cfg=a.cfg, seed=a.seed, width=a.width, height=a.height)
    print("SAVED", path)
