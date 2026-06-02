# Rendering tech review — are we using the right tools?

Research compiled 2026-06-02. Reviews the current render stack against the
state of Three.js / WebGPU in mid-2026, then proposes a prioritized set of
changes. Companion to [implementation-plan.md](./implementation-plan.md),
[water-deep-dive.md](./water-deep-dive.md), and
[adr/0003-renderer-three-webgpu.md](./adr/0003-renderer-three-webgpu.md).

## TL;DR verdict

**We're on the right foundation and essentially current.** `WebGPURenderer`
\+ TSL + automatic WebGL2 fallback is exactly the architecture the Three.js
project now steers new work toward, and our `three@0.184` pin sits one
monthly release behind head (r185). The headline water decision — **analytic
Gerstner, not FFT** — is the correct arcade choice and is independently
validated by what 2026 ocean kits actually ship (see "Water", below).

The gaps are **not** in *which tools we picked*. They're in **WebGPU
capabilities we've bought into but aren't yet cashing in**: we run a
bloom-only post graph, we have no GPU-time profiler on a stack whose whole
selling point is GPU compute, and our foliage-sway feature is silently a
no-op on the WebGPU path (our *primary* path). None of this is a rewrite.
It's a sports car idling in second gear.

## How rendering works today (orientation)

| Layer | Implementation |
| --- | --- |
| Renderer | `WebGPURenderer` (`three/webgpu`), auto WebGL2 fallback, `?backend=` override, `?aa=off`, pixel-ratio clamped to 2. `src/engine/render/renderer.ts` |
| Shaders | TSL exclusively — no raw GLSL/WGSL. Node materials (`MeshStandard/Basic/SpriteNodeMaterial`). |
| Water | Analytic 6-wave Gerstner, CPU-mirrored for buoyancy, per-bike impacts, two detail-normal cascades, Toksvig specular AA, stateless foam, depth-buffer shoreline foam, planar `reflector()`. `water.ts` (~160 KB) |
| Render systems | ECS → Three.js for bikes, riders, particles, pickups, combat, wave-riders. `render-systems.ts` et al. |
| Perf | `InstancedMesh` (props/particles/foliage scatter), camera-locked water LOD, built-in frustum culling, free-stack particle pool. **No `BatchedMesh`, no compute, no GPU culling.** |
| Post | **Bloom only**, via `RenderPipeline`. `post-pipeline.ts` |
| Lighting | One directional sun (1024² PCF shadow, follows player) + hemisphere + linear fog + PMREM IBL baked once at boot. |

## What we got right (do not touch)

1. **WebGPU-first + WebGL2 fallback via TSL.** Now the recommended
   architecture, not the experimental one — WebGPU went Baseline (all major
   browsers incl. Safari 26) in early 2026. ADR-0003's reasoning ("write the
   water shader once, compile to WGSL *or* GLSL") is precisely the capability
   the ecosystem converged on.
2. **Gerstner over FFT.** For a Wave-Race-lineage racer where waves are a
   *gameplay* mechanic needing a CPU mirror for buoyancy, analytic Gerstner
   is correct. FFT would buy choppy open-ocean micro-detail that fights the
   "clean stylized toy" register and costs RTT ping-pongs. The 2026 reference
   kits (Tidewater, Three.js Water Pro) layer Gerstner swells for exactly the
   readable macro-waves we need; FFT is reserved for deep-ocean detail we
   deliberately don't want. `water-deep-dive.md`'s rationale holds up.
3. **No true SSR for the hero water.** Planar reflection is right for a low
   racing camera; SSR loses off-screen sky/landmarks at grazing angles.
4. **Render-layer purity** (ADR-0002). The "sim never imports Three.js"
   constraint is what keeps deterministic multiplayer + headless testing
   possible. Keep guarding it.

## Opportunities, prioritized

Tagged **[look]** (visual quality) / **[play]** (perf / feel), ranked by
value-to-effort.

### P0 — Foliage sway is a no-op on the WebGPU path *(latent bug)* [look]

`foliage-sway.ts` is wired up and *is* called (`glb-track.ts`), but it works
through **`onBeforeCompile`** — a WebGL2-only GLSL-injection hook that relies
on `#include <begin_vertex>` / `USE_COLOR` chunk markers. Node materials under
`WebGPURenderer` have no such chunks, so the string replaces find nothing and
**palms/banners/foliage sit dead-still for every WebGPU user** — i.e. almost
everyone. The file's own header admits the TSL port is "a follow-up." This is
backwards: the fallback path gets the feature, the primary path doesn't.

**Fix:** branch in `applyFoliageSway` — keep the `onBeforeCompile` path for
WebGL2 standard materials, and for node materials build a TSL `positionNode`
that reproduces the same `COLOR_0.r` (strength) / `COLOR_0.b` (phase) +
per-instance world-XZ phase displacement. Shared `uniform()` nodes updated
once per frame from `updateWind` / `updateSwayTime`. *Highest value-to-effort
item here.* Needs in-browser WebGPU verification (can't be confirmed by the
headless test suite).

### P0 — WebGPU GPU-time profiler [play]

`status.md` lists the **8-bike perf-budget pass as still pending**. WebGL2
effectively *can't* give reliable per-pass GPU timing (the timer-query
extension is disabled in Chrome/Firefox); WebGPU's `timestamp-query` feature
can. A profiler (feature-detected via `adapter.features.has('timestamp-query')`,
degrading to a no-op when absent) tells us whether we're CPU-bound,
water-bound, shadow-bound, or draw-call-bound *before* we optimize anything.
Cheap, self-contained, gated behind a `?gpuprofile=1` dev flag like our other
`?` debug knobs. Pays for itself immediately.

### P1 — Cash in the post-processing node graph [look + play]

We own `RenderPipeline` but run **bloom only**. Two additions are on-brand
and can follow the existing **per-track `sky.bloom` precedent** (engine /
track-authored, no settings-menu UI required):

- **Per-object motion blur** — reuses a velocity buffer; directly serves the
  *speed sensation* of a racer. Keep subtle for the toy register. **[play]**
- **Screen-space cel/ink outline** — `art-direction.md` explicitly wants
  "light ink/edge darkening (cel-adjacent)." A depth+normal edge pass delivers
  the Wind-Waker register more reliably than per-material tricks. **[look]**

More cautiously: **GTAO** would ground props on terrain but can muddy the flat
"clean toy" shading — A/B it. Color grading via a **LUT node** could replace
the current uniform-driven grade presets.

> Implementation note: the exact TSL node names / signatures for motion-blur
> and outline move release-to-release. Verify against the installed
> `three/examples/jsm/tsl/display/` before wiring; not all are present in
> every release. If a node is absent in r184, treat the effect as roadmap.

### P1 — MSAA vs. planar reflections are mutually exclusive on WebGPU [look]

`water.ts` documents it: the scene-depth copy the planar reflector needs is
*forbidden on a multisampled framebuffer*, so today it's MSAA **or**
reflections (`?aa=off` to get both). Moving antialiasing into the post graph
(**TRAA / SMAA**, no MSAA) lets planar water reflections **and** AA run
together — a real visual unlock. Depends on the P1 velocity buffer being
trustworthy first (TRAA ghosts on fast motion without solid motion vectors).

### P2 — `BatchedMesh` + GPU-driven culling [play]

We lean on `InstancedMesh` (good for *repeated* geometry) but have no
`BatchedMesh` (many *distinct* static geometries, one material, one draw call,
built-in per-geometry LOD). Beyond that, compute-shader frustum/occlusion
culling + indirect draw is the marquee WebGPU-only win (reported 2–10× in
draw-heavy scenes).

**Be honest about scale:** at our ~3,273 scattered instances/track, built-in
frustum culling may already be adequate, and `InstancedMesh2` (agargaro —
per-instance BVH culling, LOD, octahedral impostors) is a lower-effort middle
ground than hand-rolled compute culling. **Let the P0 profiler decide** — only
invest here if we're actually draw-bound.

### P2 — Impostors / far-LOD for distant landmarks [look + play]

`status.md` lists impostor/billboard far-LOD as not built. For a drowned-city
silhouette game, **octahedral impostors** (atlas of pre-rendered angles, drawn
as a billboard) give near-free distant skylines and forests. Pairs naturally
with `InstancedMesh2`.

### P3 — GPU compute particles *(probably not worth it yet)* [play]

Compute-shader particles (`instancedArray`, state stays on GPU) scale to
millions, but our per-atlas-cell `InstancedMesh` + free-stack is fine at
current counts. File under "if the profiler says particles are hot."

### P3 — Version hygiene [maintenance]

r184→r185 is a *small* hop. Worth knowing: `PCFSoftShadowMap` (WebGL) was
deprecated in r182 (`PCFShadowMap` is now soft); the `PostProcessing` →
`RenderPipeline` rename (r183) we've already absorbed; r184 brought a ~3× TSL
compile speedup we already benefit from. No urgency to chase r185.

## Recommended sequence

1. **Fix foliage sway in TSL** (P0) — concrete bug, contained.
2. **Add the WebGPU timestamp profiler** (P0) — so everything after is
   data-driven.
3. **Profile an 8-bike wave-heavy track**, then let the numbers pick between
   the P1/P2 items.
4. **Motion blur + cel outline** (P1) — biggest look/feel return for the art
   direction.

## Research caveats

Findings on the very latest Three.js are solid on version numbers, feature
names, and migration content (verbatim migration guide + npm), but several
blog/doc domains were blocked during research, and a few exact TSL node
signatures come from the wiki + search summaries rather than installed source.
Verify any specific node API against `node_modules/three` before building on
it — TSL / `RenderPipeline` are still moving monthly.

## Sources

- Three.js migration guide (verbatim, r180→r185) — `github.com/mrdoob/three.js/wiki/Migration-Guide`
- TSL wiki (compute + post nodes) — `github.com/mrdoob/three.js/wiki/Three.js-Shading-Language`
- r184 release notes; TSL roadmap #30849; drawIndirect #28389; BatchedMesh indirect PR #30645
- Tidewater ocean kit (May 2026); Three.js Water Pro; Barth Paléologue — FFT ocean in WebGPU
- "False Earth: From WebGL Limits to a WebGPU-Driven World" (Codrops, Apr 2026)
- InstancedMesh2 (agargaro); octahedral-impostor forest demo
- SSPR in Ghost Recon Wildlands (Rémi Genin); WebGPU timestamp-query (webgpufundamentals)
</content>
