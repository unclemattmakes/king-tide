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
>
> **Proven through the orchestrator** (2026-05-30): the full chain also ran
> via [`make-level-props`](#orchestration--make-level-props) on The Maw's
> `sea_boulder` — concept → Hunyuan mesh → ~2 000-tri conditioned prop
> (single COLOR_0 + box collider) → `hv_locked` library asset, gated at the
> two review points. See the Orchestration section below.
>
> **Proven from external concept art + multiview** (2026-06-01): a **Midjourney**
> concept (cleaned to one isolated solid object) fed Hunyuan single-view
> *directly* — skipping ComfyUI — and conditioned cleanly for Sandbar's
> `drift_buoy` + `cargo_crates` (the first MJ-pipeline props). Separately, the
> **multiview** model (`Hunyuan3D-2mv`) was brought up locally on the 8 GB box.
> See "Alternative front-end" (Stage 1) and "Multiview" (Stage 2) below.

## Stage 1 — Concept art (ComfyUI, text→image)

- **Env:** `C:\Users\<user>\miniconda3\envs\comfyui` (Python 3.11, torch **cu128** — Blackwell needs it).
- **Repo:** `C:\Users\<user>\git\ComfyUI`. **Model:** SDXL base 1.0 in `models/checkpoints/sd_xl_base_1.0.safetensors`.
- **Start:** `python main.py --port 8188` → http://127.0.0.1:8188.
- **Client:** [`tools/comfyui_gen.py`](../tools/comfyui_gen.py) — SDXL txt2img over the HTTP API (POST `/prompt` → poll `/history/{id}` → GET `/view`):
  ```
  python tools/comfyui_gen.py --prompt "a single <subject>, ..." --out concept.png
  ```
- **Prompt recipe** (what makes a clean image→3D input): `"a single <subject>, one isolated centered object on a plain solid white background, studio product photography, soft even lighting, full object in frame, sharp focus, game asset reference"` + the client's default negative (no background / scene / multi-object / text). One isolated object on plain bg → Hunyuan's `rembg` cuts it cleanly.

### Alternative front-end — external concept art (Midjourney, etc.)

ComfyUI/SDXL is the *local* concept source, but Stage 2 only needs **one clean
isolated solid object on a plain background** — so any concept tool works. To use
an external concept (Midjourney v7 is the proven case, 2026-06-01):

1. **Crop to one object.** Image-to-3D fuses everything in frame, so a two-object
   concept (e.g. buoy + sign) must be cropped to the single subject and
   square-padded on the plain studio bg (the conditioner re-tints anyway, so the
   concept is for *form*, not final colour).
2. **Feed Hunyuan single-view** (Stage 2) and **condition** (Stage 3) unchanged.
   Provenance goes in the manifest with `"source": "midjourney"` + the prompt.
3. **Midjourney prompt register** ([prop-art-direction.md](./prop-art-direction.md)):
   our doc name *"clean stylized toy"* makes MJ render literal **vinyl
   figurines** — use **"retro-future / weathered salvaged / matte painted salvage
   metal / painterly concept art"** instead, with
   `--no cute, vinyl toy, chibi, smooth plastic, glossy`. (Hover-craft only read
   wheelless when you describe the *air-gap* — "hovers on a cushion of repulsion,
   clear glowing gap beneath the hull" — never a surface verb like "skimming".)

First MJ-pipeline props: Sandbar `drift_buoy` (retro-future buoy, distinct from
the make-props `marker_buoy`) + `cargo_crates`. Raw MJ concepts + the cropped
single-object inputs live in `<content-root>/concept-art/midjourney/<level>/`.

## Stage 2 — Image→3D (Hunyuan3D)

- **Env:** `C:\Users\<user>\miniconda3\envs\hunyuan` (Python 3.11, torch cu128). **Repo:** `C:\Users\<user>\git\ai-gen\Hunyuan3D-2`. **Model:** `Hunyuan3D-2mini` (auto-caches to `~/.cache/huggingface`).
- **Start** (⚠ must `cd` into the repo dir — `gradio_cache` is cwd-relative): `python api_server.py --port 8080`.
- **⚠ IMAGE-TO-3D ONLY.** Text→3D is disabled — `pipeline_t2i` is commented out in `api_server.py`. A text prompt crashes the worker thread *and* `/status` then hangs on `"processing"` forever. Always send an image (that's why ComfyUI is the front of the chain).
- **API:** `POST /send {image:<base64>, octree_resolution:256, num_inference_steps:20, guidance_scale:5.5, texture:false}` → `{uid}`. `GET /status/{uid}` → `{"status":"processing"}` until done, then `{"status":"completed","model_base64":<glb>}`. Run **shape-only** (`texture:false`) — the conditioner strips materials anyway; keeps VRAM ~6 GB. Output ≈ 200–500 k tris.

### Multiview (Hunyuan3D-2mv) — optional, for hero assets

Single-view invents the unseen back/sides; the **multiview** model rebuilds them
from real views. The repo ships it (`shape_gen_multiview.py`): `from_pretrained(
'tencent/Hunyuan3D-2mv', subfolder='hunyuan3d-dit-v2-mv-turbo')` taking an
`image={'front':…, 'left':…, 'back':…}` dict (5-step FlashVDM turbo). Working
locally as of 2026-06-01, with two gotchas:

- **8 GB / 15 GB-RAM crash + fix.** mv uses a **DINOv2-giant** (~1.1 B params)
  image conditioner built as fp32 random init *on top of* the loaded fp16 ckpt,
  peaking past free system RAM → a Windows access violation in `nn.Linear`. Fix:
  **construct in fp16** — wrap `from_pretrained` in
  `torch.set_default_dtype(torch.float16)` (restore after). Run it in an isolated
  **`hunyuan-mv`** env (`conda create --clone hunyuan`) so it can't disturb the
  working single-view env. Runner pattern saved alongside the props.
- **The real cost is the views.** mv needs **consistent ortho renders**
  (front/left/back, white bg, same scale/light — see the repo's
  `assets/example_mv_images`). Midjourney *video* frames can't meet that bar
  (morphing parallax); the proper source is a multiview-diffusion step
  (Zero123++), not yet installed in our ComfyUI.
- **Verdict.** Single-vs-mv on the bundled example: fronts identical, mv's
  back/sides truer to the inputs — a **modest** gain on symmetric/simple props.
  **Single-view stays the default** for 40 m/s stylized props; reach for mv only
  on a specific hero asset where the back matters *and* you can source consistent
  views.

## Stage 3 — Mesh→prop ([`condition_ai_mesh.py`](../tools/blender/condition_ai_mesh.py))

Run inside Blender on the imported mesh:
```python
import sys; sys.path.insert(0, r"C:\Users\<user>\projects\hoverbike")
from tools.blender.condition_ai_mesh import condition_active
condition_active(prop_id="stone_idol", family="prop", target_tris=2000,
                 target_height=4.0, collider="box", tint="#8a8782", smooth=True)
```
It **iteratively** decimates (≤10× per pass — gentle passes preserve the silhouette far better than one collapse) → orients Z-up → recenters origin to bottom-centre → rescales to `target_height` (larger-than-life) → assigns `mat_<family>_<id>` → stamps `COLOR_0` → wraps in `prop_<id>_root` (kind=prop) + a bbox-derived primitive collider. Output = a pipeline-legal `prop_<id>` collection. (`family="foliage"` opts into the sway shader; `smooth=True` reads better on organic/sculpted meshes, flat for hard-surface.) Headless `main()` (`HOVERBIKE_INPUT/PROP_ID/OUTPUT`) conditions a file straight to a GLB.

## External CC0 packs (condition-only lane — skip generation)

Not every prop needs the GPU. Free **CC0** packs that already fit the "clean
stylized toy" register (Quaternius is the proven source) skip Stages 1–2 and
enter at **Stage 3 (condition)**:

1. **Download** to the content root, out of git: `<content-root>/external/<source>/`
   (catalogue + per-pack status in that folder's `MANIFEST.md` + `manifest.json`).
2. **Convert to glTF if the pack ships only FBX/OBJ:**
   `blender --background --python tools/blender/fbx_to_glb_batch.py -- --root <extracted> --packs <a,b,…>`
   → writes `<pack>/glb/*.glb`. Packs that already ship glTF skip this.
3. **Condition with `keep_material: true`** — give `condition_ai_batch.py` a spec
   list whose `input` is the source `.gltf`/`.glb`, `output` is
   `public/assets/props/cc0/<id>.glb`, and **`keep_material: true`**. Unlike the
   AI-mesh default (which *strips* the generator material and stamps one flat
   `mat_<family>` tint), `keep_material` **preserves** the pack's own material —
   its `baseColorTexture` + UVs, or its flat multi-material slots — and only
   renames the primary material to `mat_<family>_<id>`. It still stamps the rest
   of the contract (`COLOR_0` + primitive collider + larger-than-life scale), so
   the prop renders **multi-tone**, the way the pack looks, with **no engine or
   shader change** (the runtime draws each prop with its own GLB material;
   `COLOR_0` is stamped *neutral* white for static props so it can't tint the
   preserved texture — visible colour comes from the texture/material, per
   [vertex-attribute-spec.md](vertex-attribute-spec.md)). Two source shapes both
   round-trip multi-tone:
   - **palette-texture packs** (e.g. pirate) — one material + a shared palette
     PNG; the image is embedded in the binary GLB.
   - **flat multi-material packs** (e.g. toon-shooter, ships, crops) — colour
     lives in several flat material slots, which glTF exports as one primitive
     per slot.

   The conditioner also **repairs degenerate alpha** (textureless materials that
   import from FBX with `Alpha = 0` / alpha-clip render invisible — a frequent
   FBX gotcha) by forcing them opaque, and **warns** if a pack's colour lives in
   *vertex colours* (which the single-`COLOR_0` contract strips — that pack would
   flatten; bake to a texture or skip it). Run the whole batch in one Blender
   launch (one `--spec` JSON, `keep_material: true` on each entry).
4. **Record provenance** in `specs/props/cc0/<source>.json` (committed; same
   shape as `specs/props/ai/<level>.json`, plus `keep_material`). CC0 needs no
   attribution; we log the source pack + original model name anyway.
5. **Validate** like any prop: add `{ "type": "asset", "assetId": "cc0/<id>", … }`
   to `public/tracks/prop-showcase.json` `props[]` and fly `?track=prop-showcase`
   (assetId → `/assets/props/<assetId>.glb`, manifest-independent). Headed/WebGPU
   only — `pnpm gen:track-shots prop-showcase` captures the real look.

First staged stash: 11 Quaternius packs at `<content-root>/external/quaternius/`
(see its `MANIFEST.md`). Sketchfab is **not** a source here — its CC0 pool is
museum photogrammetry, not toy props.

**Rigged / skinned meshes have their own lane** (see *Animated props* below):
the static conditioner here decimates/recenters/bakes a collider and would
collapse an armature to a blob, so the Quaternius **Animated Fish Pack**
(Shark, Whale, Fish1-3, Dolphin, Manta ray) ships through
[`ship_animated_prop.py`](../tools/blender/ship_animated_prop.py) instead — it
keeps the skin + `Swim` clip and the runtime drives a `THREE.AnimationMixer`
per placement.

**One pack/shape the lane does *not* handle yet** (drop or pre-process):
- **High-res PBR packs** (`downtown-city`, `stylized-nature`) embed multi-MB
  texture sets (base + normal + roughness at 2K) → a single prop GLB blows past
  10 MB, absurd for a 40 m/s prop. They need a texture-budget pass (downsize to
  ≤512 px, drop non-base maps) before they're web-shippable. Palette-texture and
  flat-material packs stay light (≤300 KB) with no extra work.

## Animated props (rigged sea life — skinning-preserving lane)

Some library props *move*. The Quaternius **Animated Fish Pack**
(`<content-root>/external/quaternius/extracted/animated-fish/glb/` — Shark,
Whale, Fish1-3, Dolphin, Manta ray) ships each model with an armature skin + a
single `Swim` clip. These replace bespoke "life" decorations (the Cape Town
great white is the first consumer) with rigged props that actually swim.

The static CC0 conditioner can't ship them — decimate/recenter/rescale/collider
all assume a static mesh and would blob the rig (the shipped `clownfish` came
out with 0 skins / 0 animations). The **skinning-preserving lane** is a separate
tool:

```
blender --background --python tools/blender/ship_animated_prop.py \
    -- --spec <spec>.json
```

Spec entries: `{input, prop_id, output, family?, clip_name?}` (`input` = the raw
rigged GLB; `output` = `public/assets/props/cc0/<id>.glb`). It keeps the armature
+ skin + clip intact, renames the clip to `Swim`, wraps the rig under a
`prop_<id>_root` (`kind=prop`), stamps a **neutral** `COLOR_0` (so multi-tone
materials still render without tinting), and exports with **skins + animations
on**. No decimate, no recenter, no collider — animated props are render-only
decoration. (It also purges `bpy.data.actions` between batch entries, since
`reset_scene` doesn't, or the previous fish's clip leaks into the next export.)

Authoring a placement (per-track JSON `props[]`):

```json
{ "type": "asset", "assetId": "cc0/shark", "animated": true, "clip": "Swim",
  "position": {...}, "rotation": {...}, "size": {"x":1.5,"y":1.5,"z":1.5} }
```

`animated: true` routes the placement to the runtime animated-prop lane
([`src/engine/render/animated-props.ts`](../src/engine/render/animated-props.ts)):
the GLB is `SkeletonUtils.clone`d per instance (plain `clone()` doesn't rebind a
skeleton), given a `THREE.AnimationMixer`, and ticked each render frame. `clip`
defaults to clip 0 if omitted (robust — the one-clip fish). Confirmed rendering +
deforming on the **WebGPU** node-material renderer (no material conversion
needed). Perf: a hard `maxInstances` cap (logged, not silent) + camera-distance
LOD that freezes far mixers; true school density (instanced skinned animation) is
a follow-up. `createPropsMesh` / `createPropColliders` skip these placements, so
each is owned by exactly one path. Validate in `?track=prop-showcase` like any
prop.

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

## Orchestration — `make-level-props`

The three stages above are the per-asset primitives. **`make-level-props`**
([`tools/make_level_props.py`](../tools/make_level_props.py), also the
`/make-props` skill) runs the whole chain over an *entire level's* prop
list: it resolves the level's props from the track docs, auto-routes each
to the AI or procedural lane (the subject rule), phase-batches the GPU
(one ComfyUI pass, one Hunyuan pass — each model loaded once), gates on a
contact sheet, conditions every approved mesh, and locks the results into
the library. It is **phase-gated** — it stops at each human review point;
drive it phase by phase, not in one shot.

```
python tools/make_level_props.py <level> plan        # resolve + route → manifest
python tools/make_level_props.py <level> concepts    # Phase A (ComfyUI) → concept art + contact sheet
#   review <content-root>/concept-art/props/<level>/_contact_sheet.html
python tools/make_level_props.py <level> approve <id> [<id> …]   # (or reject / regen)
python tools/make_level_props.py <level> mesh        # Phase B (Hunyuan)
python tools/make_level_props.py <level> condition   # Phase C (Blender) → public/assets/props/ai/ (repo, Git LFS)
#   review the conditioned GLBs in the prop scene: add to prop-showcase.json props[], fly ?track=prop-showcase (headed/WebGPU)
python tools/make_level_props.py <level> integrate   # one .blend per prop → <content-root>/tracks-src/props/ai/
python tools/make_level_props.py <level> status      # manifest summary, anytime
```

- **Raw vs. compiled split (docs/asset-storage.md).** Everything raw goes to
  the Drive-synced content root (out of git, default `C:\project-content\hoverbike`,
  override `$HOVERBIKE_CONTENT_ROOT`); only the compiled GLB goes to the repo:
  - **concept art** (Phase A PNGs + the contact sheet) →
    `<content-root>/concept-art/props/<level>/` — kept next to the bike/track
    concept art, so iterations aren't thrown away.
  - **raw `.blend`** (Phase 6 integrate) →
    `<content-root>/tracks-src/props/ai/<id>.blend`.
  - **compiled GLB** (Phase C condition) → repo
    `public/assets/props/ai/<id>.glb` (Git LFS).
  - The committed manifest (`specs/props/ai/<level>.json`) records pointers
    *relative* to those roots, so it stays portable (no machine paths). Same
    rule as the track/bike sources.
- **One .blend per prop (folder = library).** Each prop is its own
  asset-marked, `hv_locked` collection rather than a merge into the
  monolithic `props-library.blend`. The content root's `tracks-src/` is
  already a registered Blender asset library, so its recursive scan
  aggregates the AI props next to the procedural ones under the shared
  `Hoverbike/Track Props` catalogue. Smallest blast radius — regenerating
  one prop rewrites one small file and can't corrupt the procedural library
  or its siblings. The committed, reproducible anchor stays the GLB + the
  prompt in the manifest. *(Headless scatter still links by name from
  `props-library.blend`; to scatter an AI prop, point a scatter zone at its
  per-file `.blend` — interactive Asset-Browser placement needs no change.)*

- **Manifest** (`specs/props/ai/<level>.json`, committed): per-prop prompt,
  params, seed, and approval state — the reproducibility anchor alongside
  the GLB, since AI output can't be regenerated deterministically.
- **Routing output:** the AI lane goes through the GPU; the **procedural
  lane** is a deliverable in its own right — the thin/spanning props routed
  away (arches, towers, foliage, cables) that belong to the Blender/GN
  procedural lane, not the AI one.
- **VRAM handoff:** the tool stops Hunyuan / `POST /free`s ComfyUI between
  phases automatically. It waits for ComfyUI to idle before unloading and,
  if `/free` still can't reclaim the VRAM, stops the ComfyUI process
  outright (a guaranteed release matters more than keeping it warm on an
  8 GB box). Server/Blender/env paths are env-overridable at the top of the
  script (Windows defaults match the dev machine).

## Shipping a batch

An AI prop batch ships as **its own PR** — not straight to `main`. Generated
content gets an explicit review gate, lands as a revertible unit, and bundles
the reproducibility anchor with the binaries in one record.

- **Branch:** `props/<level>-ai` (e.g. `props/sandbar-ai`).
- **Bundle (one PR):** the conditioned GLBs (`public/assets/props/ai/*.glb`,
  Git LFS) + the per-level manifest (`specs/props/ai/<level>.json`) + any
  pipeline change the batch motivated (e.g. a `target_height` / scale tweak in
  `AI_FAMILIES`) + the prop-showcase validation stations
  (`public/tracks/prop-showcase.json` `props[]`).
- **Review gate = the prop scene.** The reviewer loads `?track=prop-showcase`
  (headed/WebGPU) and flies past the props at race pace — the real "reads
  correctly at 40 m/s" + scale check. (`?viewer=` is bikes-only; props
  validate in the prop-showcase scene.)
- **Scale:** props read ~3× smaller than real-world size at game scale, so
  `AI_FAMILIES` `target_height` is pre-scaled ~3×. If a prop still looks small
  in the prop scene, bump its `target_height` (manifest + `AI_FAMILIES`) and
  re-run `condition` — the raw Hunyuan meshes persist in
  `tools/ai_prop_runs/<level>/meshes/`, so re-conditioning is cheap (no GPU).
- **NOT in this PR: level placement.** Putting a prop into a content track
  (its `props[]`, scatter, or bespoke geometry) is a **level designer** task,
  shipped separately. The pipeline *creates + validates*; it never edits a
  content level or regenerates a `seed_track_*` script.

## See also

- [props-production-plan.md](props-production-plan.md) — strategy, archetype list, subject-suitability rule.
- **`make-level-props`** (above) — orchestrates this whole chain over a level's prop list (route → batch → review → condition → integrate).
