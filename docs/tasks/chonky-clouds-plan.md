# Chonky clouds — implementation plan

**Goal:** replace the flat, hazy, dome-painted cloud band with discrete,
huge, blobby low-poly cumulus masses that sit at finite altitude, parallax
against the landscape, and silhouette against the sky — matching the
concept art ("clean stylized toy" register, soft not faceted).

**Status:** ✅ v1 built + verified 2026-06-02. Chosen direction (from the
user): low-poly **toy cloud meshes** (not soft sprites, not shader-only),
prototyped on a dedicated **cloud-map** test scene, verified with
**static-camera time-lapse** captures so we can watch them drift.

### Update — "make it gigantic" pass (2026-06-07)

The geonode clouds had landed but read **tiny** in-game (small, uniformly-sized
puffs scattered evenly) — nothing like the towering masses in the concept art.
The fix was scale + placement, not new geometry (the geonode silhouettes/shading
are good). Changes in [`clouds.ts`](../../src/engine/render/clouds.ts):

- **Base-seated geometry.** Both blob builders now recentre on the **flat
  bottom (yMin → 0)**, not the vertical midpoint. So `altitude` is a true
  shared **cloudbase**, the towering stretch grows masses **upward** from that
  shelf, and nothing dips toward the water however tall it gets (drops the old
  size-coupled "lift" hack).
- **Size-grading.** The biggest masses skew toward the **horizon** (outer
  radius) so the far edge reads as a towering cumulus skyline; nearer clouds
  stay a mix → depth.
- **Towering (new `sky.clouds.towering` knob, default 0.4).** Per-instance
  vertical stretch on the largest masses (sizeT² gated, capped) → cumulonimbus
  columns while small puffs stay rounded. Wired through `types.ts` +
  `json-loader.ts`.
- **Bigger defaults** — `scaleRange` `[55,130]→[150,380]`, `altitude` `320→340`
  (cloudbase), `spreadRadius` `1100→1500`, `altitudeJitter` `70→100`.

Per-track `sky.clouds` blocks bumped to match (≈3× scale + `towering`):
**cloud-map, the-maw, sandbar, south-beach-sunken, cape-town-drift** and the
five `cloud-stress-*` presets. Tight-fog tracks (sandbar `fogFar:1200`) keep a
smaller spread so clouds stay inside the fog-visible band; generous-fog tracks
(cape-town `fogFar:3200`) push the spread out for horizon towers. Verified in
real WebGPU across all four moods (neutral midday, golden hour, warm daytime,
clear blue) — clouds now dominate the upper sky and frame the action.

**Still open (deferred):** the masses read a touch **smooth/pillowy** at large
scale (the geonode puff detail stretches out) — crisper cauliflower billows
would need a geonode rebuild (more/smaller puffs per blob in
`build_cloud_props.py`). Cosmetic, not blocking.

### What shipped (Phase 1 — procedural geometry)

- [`src/engine/render/clouds.ts`](../../src/engine/render/clouds.ts) — the hero
  cumulus layer: merged-icosphere blob variants, unlit TSL material (cool
  base → warm crown gradient + half-Lambert sun-wrap + white sunlit-top
  highlight + fresnel rim), per-variant `InstancedMesh`, wind-drift +
  camera-locked torus wrap. Constructed / ticked / disposed inside
  [`createSkySystem`](../../src/engine/render/sky.ts) (every boot path gets it).
- [`CloudFieldConfig`](../../src/game/tracks/types.ts) on `SkyConfig.clouds`,
  validated in [`json-loader.ts`](../../src/game/tracks/json-loader.ts)
  (`readOptionalCloudField`). **Off by default** (`count: 0` in `DEFAULT_SKY`)
  → existing tracks unchanged.
- [`public/tracks/cloud-map.json`](../../public/tracks/cloud-map.json) — the
  test scene. Load via `?track=cloud-map&autostart=1`.
- Fixed-camera **time-lapse** capture in
  [`gen-track-shots.spec.ts`](../../tests/e2e/gen-track-shots.spec.ts) via
  `TRACK_SHOTS_POSE_FRAMES`.

**Tuning knobs** (all in `sky.clouds`): `count`, `altitude`,
`altitudeJitter`, `spreadRadius`, `scaleRange [min,max]`, `variants`, `wind
{x,z}`, `coolBase`/`warmTop` (hex), `seed`. The material's lighting constants
(gradient bias, shadow floor, sun-highlight + rim strengths) live at the top of
`buildCloudMaterial` in `clouds.ts`.

> ⚠️ **Capture gotcha:** `gen:track-shots` reuses an existing dev server on
> port 5391 (`reuseExistingServer`). If one is already running (e.g. the live
> game), it serves *that* working tree, not the worktree — so new/edited tracks
> 404. Run with `E2E_PORT=5396` (any free port) so the harness boots its own
> Vite in the worktree.

### Coloration stress test (2026-06-02)

Pressure-tested the procedural clouds against 5 concept plates spanning the
coloration space, each as a `cloud-stress-*` preset (cloud-map geometry + a
per-plate sky/clouds config), captured in real WebGPU and compared to the plate.

| Plate | Preset | Verdict |
|---|---|---|
| Cliffs / bright day | `cloud-stress-day` | ✅ strong — warm-white cumulus, cool underside, blue sky |
| Pink drowned islands | `cloud-stress-pink` | ✅ hit after a saturation pass (pinker `coolBase`/`warmTop`) |
| Desert cumulonimbus | `cloud-stress-dune` | ✅ coloration hit (big soft warm-pastel); the plate's *single colossal tower* is a geometry/composition gap, not colour |
| Fiery dusk tower | `cloud-stress-dusk` | ✅ strongest — orange→purple sky, warm-tan backlit masses with lit rims |
| Teal overcast lighthouse | `cloud-stress-overcast` | ◑ tint hits (desaturated teal-grey); lighting can't go fully *flat* |

**Headline: the system hits all five colorations with config alone — zero code
changes.** Per-track `coolBase`/`warmTop` + `timeOfDay` (which swings the
`sunGlow`/`horizonColor` the clouds sample) cover the range.

**Two real gaps the test surfaced:**
1. ✅ **DONE — overcast "flatten" (`sunPop` dial).** `sky.clouds.sunPop` (0..1,
   default 1) scales the half-Lambert sun-wrap shadow-floor + the warm/white
   sun highlights in `buildCloudMaterial`. 0 = flat ambient (just the vertical
   base→crown gradient) for overcast; 1 = full sunny pop. The teal-overcast
   preset uses `0.15` and now reads as flat diffuse light.
2. **`colorGrade` isn't applied to the cloud meshes** (only the dome). Worked
   around fine with per-track hexes, but auto-deriving the cloud tint from the
   grade / `sunGlow` would cut the per-track hand-tuning. Ergonomic, not a
   visual blocker.

The 5 presets double as reusable **palette starting points** for real tracks
with those moods.

### Open / next

- **Look fine-tune** is the designer's call (playtest-truth): the knobs above +
  the cool/warm hexes. Current defaults match the bright-white-cumulus concept.
- **Roll to real tracks** — add a `sky.clouds` block per track in a content
  pass (dome `cloudiness`/`cloudTowering` likely dialed down so the dome is
  background haze and the mesh clouds are the heroes).
- **Phase 2 (optional)** — graduate to Blender-authored hero blobs (swap the
  geometry source in `clouds.ts`; instancing/material/drift unchanged).
- **Cloud-shadow coherence** with the hero meshes (still FBM-dapple ambient).

---

## Why the current clouds look flat (diagnosis)

The clouds are a 2D FBM noise field **painted onto the inside of the 2 km
sky dome** by the dome fragment shader ([sky.ts:501-553](../../src/engine/render/sky.ts)):

- **Cylindrical projection** (`worldDir.xz / |worldDir.y|`, [sky.ts:507](../../src/engine/render/sky.ts))
  smears detail into a low horizon band — a flat plane at infinity seen
  edge-on.
- **No parallax / no volume** — pinned to the dome surface (~2 km out, keyed
  off world *direction* not position), so they never shift relative to
  islands/gates/each other. The eye reads "painted backdrop."
- **Soft FBM threshold** gives feathered, hazy edges instead of the hard,
  rounded, flat-bottomed cumulus silhouette.

The dome's cloud *lighting* recipe is already right (cool blue-grey base,
warm bright top, rim toward sun — [sky.ts:547-553](../../src/engine/render/sky.ts));
it's the **shape and placement-in-space** that's wrong, and no shader tuning
fixes placement-in-space.

The dome stays — it keeps doing far haze / high cirrus, the sun disc, and the
PMREM env bake. We **add** a separate hero-cumulus layer on top of it.

---

## Architecture

New **render-only** module `src/engine/render/clouds.ts`, mirroring the
shape of [horizon-ring.ts](../../src/engine/render/horizon-ring.ts) (small
system that reads `SkyShared`) + [props-mesh.ts](../../src/engine/render/props-mesh.ts)
(`InstancedMesh` + `setMatrixAt` drift). Sim layer untouched — clouds read
from the sky's shared uniforms and write Three.js objects, never the reverse.

```
createCloudLayer({ scene, shared, config }) -> { group, tick(time, dt, focus), dispose() }
```

- **Constructed inside `createSkySystem`** ([sky.ts:375](../../src/engine/render/sky.ts)),
  ticked from the sky's existing `tick(time, dt, focus)` and disposed in the
  sky's `dispose()`. This gives **all five boot paths** (main, attract,
  calibration, wave-rider, rider-editor) clouds for free with zero
  game-loop wiring — the sky already receives `dt` + camera `focus`.
- Reads `SkyShared` ([sky.ts:302-313](../../src/engine/render/sky.ts)):
  `sunDir`, `sunGlow`, `horizonColor`, `time`, `cloudiness`. Component access
  via the house-style casts (`as unknown as { x: Node<'float'> }`,
  cf. [cloud-shadows.ts:118](../../src/engine/render/cloud-shadows.ts)).

### Geometry — procedural-first, Blender-hero-later

The look the user picked is **low-poly toy meshes**. Two ways to source that
geometry, identical downstream (same instancing / material / drift):

- **Phase 1 (prototype): procedural merged icospheres.** Build each cumulus
  variant in `clouds.ts` from 4–8 `IcosahedronGeometry` spheres at jittered
  offsets, merged with `mergeGeometries` (`three/addons/utils/BufferGeometryUtils.js`,
  same alias as the existing `GLTFLoader` import). **Why first:** zero Blender
  round-trip, zero LFS, fully code-versioned, and re-tunable + re-capturable in
  seconds — which is exactly what the tune loop needs. Same low-poly toy
  register as authored meshes.
- **Phase 2 (optional graduation): Blender-authored hero blobs.** Once the
  look/lighting/scale are locked, author `clouds-src/clouds.blend` with ~4–5
  named blob meshes → `build_clouds.py` (reusing `tools/blender/common.py:export_glb`)
  → `public/assets/sky/clouds.glb` (auto-LFS) → load with `GLTFLoader` + swap
  to our node material (cf. [foliage-sway.ts:251](../../src/engine/render/foliage-sway.ts)).
  Swapping the geometry source is a one-function change. (If we tag the meshes,
  add `CLOUD="cloud"` to both `kingtide_kinds.py` and `asset-kinds.ts` — the
  unit test enforces the mirror.)

> This sequencing respects the "toy mesh" *look* choice while keeping the
> prototype loop tight. Flagging it because the explicit pick was "Blender
> meshes"; the look is the same either way — only the authoring source differs,
> and Phase 2 stays open.

### Material (TSL, unlit stylized — `MeshBasicNodeMaterial`)

Unlit Basic with a hand-authored `colorNode` (matches the dome + horizon ring,
cheaper than PBR, full art control for the toy register). Node graph:

```
hT     = smoothstep(lo, hi, aHeightT | normalWorld.y)   // base→crown height
base   = mix(coolBase, warmTop, hT)        // endpoints derived from shared.horizonColor / sunGlow
ndl    = dot(normalize(normalWorld), sunDir)
wrap   = clamp(ndl*0.5 + 0.5, 0, 1)        // half-Lambert (light wraps the round form)
lit    = base * mix(shadowFloor, 1.0, wrap) (+ warm sun-side push from sunGlow)
NdV    = saturate(dot(normalWorld, normalize(cameraPosition - positionWorld)))
rim    = pow(1 - NdV, k)                    // bright backlit silhouette edge
color  = clamp(mix(lit, rimColor, rim*rimStrength), 0, 1.6)   // clamp guards bloom clip
```

All terms reuse `shared.*` so clouds stay tonally locked to the dome's
time-of-day with **no per-frame CPU uniform pushes**. Keep `fog: true` so far
clouds dissolve into the 500–2200 m sky-tinted fog band, `renderOrder: 0`
(opaque), `depthWrite: true`.

### Instancing + drift

One `InstancedMesh(geom, material, count)` per variant (cf. [props-mesh.ts:141](../../src/engine/render/props-mesh.ts)).
`frustumCulled = false` (field follows the camera). `tick(time, dt, focus)`:

- Advance each cloud's XZ by `wind * dt` (default wind `{x:1, z:0.2}` to match
  the foliage wind set at [game-loop.ts:502](../../src/boot/game-loop.ts) so
  cloud / sea / foliage drift stay coherent).
- **Recycle** any cloud whose along-wind offset from `focus` (camera XZ)
  exceeds ±`spreadRadius` — wrap it to the upwind edge, re-randomize cross-wind
  offset + scale so the field doesn't visibly tile.
- Recompose its `Matrix4` (factory-scope scratch objects, no per-frame alloc),
  `setMatrixAt(i, m)`, then `instanceMatrix.needsUpdate = true` once.
- Drift derived from the passed sim `time` (not wall clock) so replays match.

### Per-track config

Extend `SkyConfig` ([types.ts:448](../../src/game/tracks/types.ts)) with an
optional `clouds?: { count, altitude, spreadRadius, scaleRange, wind?, ... }`
block (defaults sensible so existing tracks are unchanged). The cloud-map sets
it explicitly; real tracks dial it in a later pass.

---

## Test scene — `cloud-map`

JSON-only, no Blender/GLB. Copy [water-test.json](../../public/tracks/water-test.json)
→ `public/tracks/cloud-map.json`:

- `id: "cloud-map"`, `name: "Cloud Map"`, `lapsToFinish: 1`, one `start`, one
  `checkpoint`, one `aiSplines` entry `id:"main"` (≥2 anchors), `pickupSpawns: []`
  (the validator's required set, [json-loader.ts:106-126](../../src/game/tracks/json-loader.ts)).
- Flat calm water as the "ground" (low `seaStateBeaufort`), fog pushed far out
  (`fogNear: 800, fogFar: 3500`) so the sky reads clean.
- `sky.clouds` block dialed for a dramatic field; modest dome `cloudiness` so
  the hero cumulus are the stars.
- Loads via `?track=cloud-map&autostart=1`. No registry/manifest edit needed.

---

## Verification loop — static-camera time-lapse

Capture is the **real-WebGPU headed-Chromium** harness (`pnpm gen:track-shots`),
the only reliable way to see WebGPU output (preview screenshots fail on WebGPU).

- **Harness upgrade (~5 lines, [gen-track-shots.spec.ts:126-142](../../tests/e2e/gen-track-shots.spec.ts)):**
  in the `TRACK_SHOTS_POSES` branch, after `setCameraPose(...)`, loop
  `TRACK_SHOTS_COUNT` shots spaced `TRACK_SHOTS_INTERVAL` ms (naming
  `pose-<label>-NN.jpg`) instead of a single frame. The engine holds the fixed
  pose indefinitely and the sim keeps advancing, so the clouds drift across the
  sequence → true fixed-camera time-lapse. Reuses existing env knobs; no engine
  changes (`setCameraPose` / pose-override already exist end-to-end).
- **Run:**
  ```powershell
  $env:TRACK_SHOTS_POSES = '[{"label":"sky","pos":[0,30,0],"target":[120,90,120]}]'
  $env:TRACK_SHOTS_POSE_FRAMES = '12'; $env:TRACK_SHOTS_INTERVAL = '900'
  pnpm gen:track-shots cloud-map
  # -> test-results/track-shots/cloud-map/pose-sky-00.jpg … 11.jpg
  ```
  Then read the frames, assess silhouette / volume / drift / tonal match to
  the concept, tune, re-capture. Hand the best frames to the user for the
  playtest-truth call.

---

## Build order

1. **Harness time-lapse** — fixed-camera multi-frame capture (verification tool
   ready before the feature).
2. **`cloud-map.json`** — the test scene.
3. **`clouds.ts` + wiring** — procedural geometry, TSL material, instancing,
   drift; constructed/ticked/disposed inside `createSkySystem`; `SkyConfig.clouds`.
4. **Tune loop** — capture → assess → adjust shape/scale/count/lighting/drift →
   re-capture; converge on the concept look; hand frames to the user.
5. **(Deferred)** per-track cloud dialing; optional Blender-hero geometry
   (Phase 2); cloud-shadow coherence with the hero meshes.

## Known seams (deferred, flagged)

- **Ground cloud-shadows** ([cloud-shadows.ts](../../src/engine/render/cloud-shadows.ts))
  stay FBM-dapple ambient; they won't match the hero meshes' silhouettes. The
  dome's painted clouds don't match them either today — acceptable for v1.
- **Unified wind** is still a wishlist item; we default to the foliage wind
  vector for coherence until the per-track `track.weather.wind*` round-trip lands.
- **Dome vs hero clouds** coexisting can read busy — tune dome `cloudiness` /
  `cloudTowering` down per track so the dome is background haze, mesh clouds the
  heroes.
