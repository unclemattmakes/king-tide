# Cloud-mesh brief — for the Blender instance

You're authoring the hero-cumulus blob meshes for the new sky cloud system.
This is the contract so your GLB drops straight into the runtime with no
surprises. **The runtime owns color, lighting, scale, placement, drift, and
centering — you own silhouette and softness.** Keep your side dumb geometry.

## TL;DR contract

> Deliver **4–6 smooth-shaded, low-poly, upright cumulus blob meshes** named
> `cloud_0…cloud_N` in **`public/assets/sky/clouds.glb`** (Git LFS). No
> materials, UVs, vertex colors, colliders, or custom attributes — the runtime
> replaces the material, derives a base→crown gradient from vertex height, and
> normalizes + recenters each blob on load. Match the chonky cumulus silhouette
> of the concept plates.

## What this is

`src/engine/render/clouds.ts` instances cloud blobs at altitude, lights them
with a custom TSL material (cool shadowed base → warm sun-lit crown + sun-wrap
+ fresnel rim + a `sunPop` flatten dial), and drifts them on the wind. Today
the geometry is **procedural** (merged icospheres built in code —
see `buildCumulusGeometry`). You're producing the **Phase 2** authored
replacement. The instancing / material / drift code does **not** change — only
the geometry source swaps.

Reference the look: the procedural captures in
`test-results/track-shots/cloud-stress-*/` and the concept plates the user has.
Reference the shape recipe: `buildCumulusGeometry` in `clouds.ts` (flat squashed
base lobes + rounded crown bumps).

## Mesh requirements (the important part)

1. **4–6 separate mesh objects**, named `cloud_0`, `cloud_1`, … The loader
   takes every mesh whose name starts with `cloud`.
2. **Low-poly** — a few hundred to ~2 k tris each. They're instanced and viewed
   at 300–1000 m, so spend polys on **silhouette**, not surface micro-detail.
3. **Smooth-shaded** (Shade Smooth / Auto-Smooth). This is the #1 visual
   requirement — soft toy puffs, **not faceted**. Faceted normals read as
   crystals, not clouds.
4. **Cumulus silhouette:** a **flatter, wider base** (the cumulus flat bottom)
   with a **lumpy, rounded cauliflower crown** stacked above. Build each as a
   cluster of merged lumps (metaballs→mesh, or icospheres, or sculpt+decimate —
   whatever gives soft overlapping puffs).
5. **Variety across the set:** a couple of medium puffs, one wide low one, and
   **at least one tall towering blob** (cumulonimbus — the desert-dune plate
   needs it). Aspect ratio is preserved on load (see normalization below), so a
   tall tower stays tall.
6. **Upright, Blender Z-up** (the exporter converts Z-up→Y-up): build with the
   **flat bottom low (−Z) and crown high (+Z)**. The runtime derives the
   base→crown color gradient from vertex height, so up-orientation must be
   correct. (After export, local +Y = crown.)
7. **Size / centering: don't sweat it.** On load the runtime **normalizes each
   blob to unit max-extent (preserving aspect) and recenters it** (XZ centroid
   and vertical midpoint → origin). Build at any sane size, roughly centered.

## Do NOT (and what you don't need to do)

- **No materials / textures / UVs / vertex colors.** The runtime swaps in a TSL
  material and derives the height gradient from geometry. A placeholder material
  is fine — it's ignored. (Don't waste time shading or texturing.)
- **No collider, no physics, not a gameplay prop.** Clouds are sky objects.
  **Do NOT route through the prop spec pipeline** (`build_prop.py` /
  `specs/props/`) — it mandates a collider and a closed-enum `category` with no
  cloud value. This is a **standalone GLB**.
- **No custom `aHeightT` attribute** — the runtime derives it from vertex Y on
  load (stamping it in Blender would just be invalidated by any vert edit; same
  reasoning as the horizon-ring authored-mesh path).
- **No `kind` tag required** (the GLB is clouds-only; the loader takes all
  `cloud*` meshes). *Optional:* if you want it self-describing, tag each
  `kind="cloud"` — but then add `CLOUD = "cloud"` to **both**
  `tools/blender/kingtide_kinds.py` and `src/engine/asset-kinds.ts`
  (`tests/unit/asset-kinds.test.ts` fails if they drift). Not needed.

## Files + export

- **Raw `.blend`:** content-root `clouds-src/clouds.blend` (the Google-Drive
  folder, out of git — sibling of `tracks-src/` / `bikes-src/`). Point the addon
  at the repo clone via its *Project root* pref / `$KINGTIDE_REPO_ROOT`.
- **Compiled GLB:** `public/assets/sky/clouds.glb` — Git LFS covers it
  automatically (`public/assets/**/*.glb`); ensure `git lfs install` has run.
- **Export flags:** `export_yup=True`, `export_apply=True` (bake modifiers — so
  subsurf/mirror/array collapse in), smooth normals preserved, no cameras /
  lights. The headless `tools/blender/common.py:export_glb` already uses these;
  a tiny `tools/blender/build_clouds.py` that opens `clouds.blend` and calls it
  is the cleanest exporter (model it on the `gen:prop-gate` one-off).

## How it gets wired (runtime side — not your job)

When `clouds.glb` lands, the runtime loader (mirroring the proven
`horizon-ring.ts` authored-mesh path) will, per `cloud*` mesh: clone geometry →
**normalize to unit max-extent** → **recenter** → **derive `aHeightT`** from
vertex Y → build one `InstancedMesh` per variant with the existing TSL cloud
material. So the only thing that has to be right on your end is **shape +
smooth normals + up-orientation + naming**. Everything else is derived.

You can't preview in-engine yet (the loader isn't wired until your GLB exists),
so match the silhouette/softness against the concept plates in Blender. Once the
GLB is in, runtime-side wires + verifies it with `pnpm gen:track-shots cloud-map`.
