# AI prop pipeline — local concept→3D→prop factory

A fully **local, free** pipeline that turns a text prompt into a
pipeline-legal Hoverbike prop, entirely on the dev machine's GPU
(RTX 5050 Laptop, 8 GB):

```
text prompt ──[ComfyUI / SDXL]──▶ concept image ──[Hunyuan3D]──▶ dense mesh
            ──[condition_ai_mesh]──▶ prop_<id>: decimate + mat + COLOR_0 + collider
```

Strategy, archetype list, and the **subject-suitability rule** live in
[props-production-plan.md](props-production-plan.md). This doc is the
*operational* guide: the tools, the servers, and how to run them.

> **Proven end-to-end** (2026-05-30): a carved stone idol head went
> SDXL concept → Hunyuan 493 k-tri mesh → conditioned **2 000-tri** prop
> (`mat_prop_stone_idol` + COLOR_0 + box collider + 4 m), with the whole
> VRAM/server handoff driven autonomously. Compact/solid subjects come
> out crisp; thin/spanning ones (coral fans, arches) fragment — see the
> subject rule below.

## Stage 1 — Concept art (ComfyUI, text→image)

- **Env:** `C:\Users\<user>\miniconda3\envs\comfyui` (Python 3.11, torch **cu128** — Blackwell needs it).
- **Repo:** `C:\Users\<user>\git\ComfyUI`. **Model:** SDXL base 1.0 in `models/checkpoints/sd_xl_base_1.0.safetensors`.
- **Start:** `python main.py --port 8188` → http://127.0.0.1:8188.
- **Client:** [`tools/comfyui_gen.py`](../tools/comfyui_gen.py) — SDXL txt2img over the HTTP API (POST `/prompt` → poll `/history/{id}` → GET `/view`):
  ```
  python tools/comfyui_gen.py --prompt "a single <subject>, ..." --out concept.png
  ```
- **Prompt recipe** (what makes a clean image→3D input): `"a single <subject>, one isolated centered object on a plain solid white background, studio product photography, soft even lighting, full object in frame, sharp focus, game asset reference"` + the client's default negative (no background / scene / multi-object / text). One isolated object on plain bg → Hunyuan's `rembg` cuts it cleanly.

## Stage 2 — Image→3D (Hunyuan3D)

- **Env:** `C:\Users\<user>\miniconda3\envs\hunyuan` (Python 3.11, torch cu128). **Repo:** `C:\Users\<user>\git\ai-gen\Hunyuan3D-2`. **Model:** `Hunyuan3D-2mini` (auto-caches to `~/.cache/huggingface`).
- **Start** (⚠ must `cd` into the repo dir — `gradio_cache` is cwd-relative): `python api_server.py --port 8080`.
- **⚠ IMAGE-TO-3D ONLY.** Text→3D is disabled — `pipeline_t2i` is commented out in `api_server.py`. A text prompt crashes the worker thread *and* `/status` then hangs on `"processing"` forever. Always send an image (that's why ComfyUI is the front of the chain).
- **API:** `POST /send {image:<base64>, octree_resolution:256, num_inference_steps:20, guidance_scale:5.5, texture:false}` → `{uid}`. `GET /status/{uid}` → `{"status":"processing"}` until done, then `{"status":"completed","model_base64":<glb>}`. Run **shape-only** (`texture:false`) — the conditioner strips materials anyway; keeps VRAM ~6 GB. Output ≈ 200–500 k tris.

## Stage 3 — Mesh→prop ([`condition_ai_mesh.py`](../tools/blender/condition_ai_mesh.py))

Run inside Blender on the imported mesh:
```python
import sys; sys.path.insert(0, r"C:\Users\<user>\projects\hoverbike")
from tools.blender.condition_ai_mesh import condition_active
condition_active(prop_id="stone_idol", family="prop", target_tris=2000,
                 target_height=4.0, collider="box", tint="#8a8782", smooth=True)
```
It **iteratively** decimates (≤10× per pass — gentle passes preserve the silhouette far better than one collapse) → orients Z-up → recenters origin to bottom-centre → rescales to `target_height` (larger-than-life) → assigns `mat_<family>_<id>` → stamps `COLOR_0` → wraps in `prop_<id>_root` (kind=prop) + a bbox-derived primitive collider. Output = a pipeline-legal `prop_<id>` collection. (`family="foliage"` opts into the sway shader; `smooth=True` reads better on organic/sculpted meshes, flat for hard-surface.) Headless `main()` (`HOVERBIKE_INPUT/PROP_ID/OUTPUT`) conditions a file straight to a GLB.

## The subject rule (the most important filter)

Image-to-3D excels at **compact, solid, closed** forms and **fragments
thin/spanning** ones into clumpy/floaty messes.

| Verdict | Forms | Examples |
|---|---|---|
| ✅ **AI lane** | compact / solid / closed | rocks, boulders, idols + carved heads, anchors, chests, urns, debris, crates, barrels, statues, chunky sea-life, the bike body |
| ❌ **Procedural** | thin / spindly / spanning | coral *fans*, kelp, branching foliage, arches, towers, bridges, cables, gates, lattice masts |

Prompt *toward* solidity even within a category ("massive solid brain
coral **boulder**" beats "branching coral").

## The 8 GB VRAM constraint + server handoff

ComfyUI's SDXL (~6 GB) and the Hunyuan server (~6 GB resident) **cannot
both be loaded at once.** Hand the VRAM back and forth:

- **Stop Hunyuan** (free its VRAM — no `/free` endpoint, must kill the process):
  ```powershell
  $c = Get-NetTCPConnection -LocalPort 8080 -State Listen -EA SilentlyContinue
  $c.OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
  ```
- **Start Hunyuan** (background; **cd into the repo dir**):
  ```powershell
  Set-Location 'C:\Users\<user>\git\ai-gen\Hunyuan3D-2'
  & 'C:\Users\<user>\miniconda3\envs\hunyuan\python.exe' api_server.py --port 8080
  ```
  Poll `GET /openapi.json` until it returns 200 (~60 s model load).
- **Free ComfyUI** (unload SDXL, keep the server up):
  ```
  POST http://127.0.0.1:8188/free  {"unload_models":true,"free_memory":true}
  ```

**Per asset:** stop Hunyuan → ComfyUI concept → free ComfyUI → start
Hunyuan → mesh → condition. **For a level (batch):** ComfyUI phase (all
concepts) → review contact sheet → Hunyuan phase (all meshes) → condition
phase. Phase-batching loads each model once and matches the review gate.

## Integration

A conditioned `prop_<id>` collection → append/drag into
`props-library.blend` as a scatter source, then set an `hv_locked` custom
prop on the collection so re-seeds preserve it (the props-library seed is
non-destructive — see [asset-pipeline-guide.md](asset-pipeline-guide.md)
§ "Locking a hand-edited prop"). AI output isn't reproducible, so the
**approved GLB/`.blend` (LFS) + the prompt** are the source of truth, not
a regenerate step.

## Setup recap (rebuilding from scratch)

1. `conda create -n <comfyui|hunyuan> python=3.11`.
2. `pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128` (Blackwell), then the repo's `requirements.txt`.
3. ComfyUI: download SDXL base 1.0 to `models/checkpoints/`. Hunyuan: model auto-downloads on first run.

## See also

- [props-production-plan.md](props-production-plan.md) — strategy, archetype list, subject-suitability rule.
- The next step, **`make-level-props`**, orchestrates this whole chain over a level's prop list (route → batch → review → condition → integrate).
